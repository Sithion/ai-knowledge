import {
  DEFAULT_OLLAMA_HOST,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_DIMENSIONS,
  OLLAMA_NATIVE_DIMENSIONS,
} from '@cognistore/shared';
import type { EmbeddingRequest, EmbeddingResponse, OllamaTagsResponse } from './types.js';

export interface OllamaClientConfig {
  host?: string;
  model?: string;
  dimensions?: number;
  maxRetries?: number;
  maxInputChars?: number;
  /** Per-request timeout for embed calls (ms). Prevents a stalled Ollama socket
   *  from hanging SDK init and every search. Default 30s. */
  requestTimeoutMs?: number;
  /** Timeout for the lightweight health/model-availability checks (ms). Default 10s. */
  healthTimeoutMs?: number;
}

export class OllamaEmbeddingClient {
  private host: string;
  private model: string;
  private dimensions: number;
  private maxRetries: number;
  private maxInputChars: number;
  private requestTimeoutMs: number;
  private healthTimeoutMs: number;

  constructor(config?: OllamaClientConfig) {
    this.host = config?.host ?? (process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST);
    this.model = config?.model ?? (process.env.OLLAMA_MODEL ?? DEFAULT_EMBEDDING_MODEL);
    this.dimensions = config?.dimensions ?? (Number(process.env.EMBEDDING_DIMENSIONS) || DEFAULT_EMBEDDING_DIMENSIONS);
    this.maxRetries = config?.maxRetries ?? 3;
    this.maxInputChars = config?.maxInputChars ?? 2000;
    this.requestTimeoutMs = config?.requestTimeoutMs ?? 30_000;
    this.healthTimeoutMs = config?.healthTimeoutMs ?? 10_000;
  }

  private truncateText(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const truncated = text.slice(0, maxChars);
    const lastSpace = truncated.lastIndexOf(' ');
    return lastSpace > maxChars * 0.5 ? truncated.slice(0, lastSpace) : truncated;
  }

  async embed(text: string): Promise<number[]> {
    const body: EmbeddingRequest = {
      model: this.model,
      prompt: this.truncateText(text, this.maxInputChars),
      options: { num_ctx: 8192 },
    };

    const response = await this.fetchWithRetry(`${this.host}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama embedding failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as EmbeddingResponse;

    if (!data.embedding || !Array.isArray(data.embedding)) {
      throw new Error('Invalid embedding response from Ollama');
    }

    // nomic-embed-text returns 768 dims natively; we truncate via Matryoshka (MRL)
    if (data.embedding.length < this.dimensions) {
      throw new Error(
        `Embedding dimension mismatch: expected at least ${this.dimensions}, got ${data.embedding.length}. ` +
        `Check that OLLAMA_MODEL and EMBEDDING_DIMENSIONS are compatible.`
      );
    }

    // Matryoshka truncation: first N dims are a valid lower-dimensional embedding
    if (data.embedding.length > this.dimensions) {
      return this.truncateAndNormalize(data.embedding, this.dimensions);
    }

    return data.embedding;
  }

  async embedBatch(texts: string[], concurrency = 3): Promise<number[][]> {
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += concurrency) {
      const batch = texts.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map(text => this.embed(text)));
      results.push(...batchResults);
    }

    return results;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.host}/api/tags`, { signal: AbortSignal.timeout(this.healthTimeoutMs) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async isModelAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.host}/api/tags`, { signal: AbortSignal.timeout(this.healthTimeoutMs) });
      if (!response.ok) return false;

      const data = (await response.json()) as OllamaTagsResponse;
      return data.models.some(m => m.name === this.model || m.name.startsWith(`${this.model}:`));
    } catch {
      return false;
    }
  }

  async pullModel(): Promise<void> {
    // A model pull legitimately streams for minutes (multi-GB download), so we
    // do NOT cap total time — only the initial connect, plus a per-read idle
    // guard so a STALLED stream (no bytes) can't hang setup forever.
    //
    // NOTE: AbortSignal.timeout() can't express "connect-only" — it would abort
    // the whole fetch (body stream included) 30s after the request starts and
    // kill the in-progress download. Use a controller whose connect timer is
    // cleared the moment the response headers arrive, leaving the streaming
    // phase governed solely by the per-read idle guard below.
    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), 30_000);
    let response: Response;
    try {
      response = await fetch(`${this.host}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: this.model }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(connectTimer);
    }

    if (!response.ok) {
      throw new Error(`Failed to pull model ${this.model}: ${response.statusText}`);
    }

    // Consume the stream to completion, aborting if no chunk arrives for 120s.
    const reader = response.body?.getReader();
    if (reader) {
      const IDLE_MS = 120_000;
      try {
        while (true) {
          let timer: ReturnType<typeof setTimeout>;
          const idle = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Model pull stalled (no data for ${IDLE_MS / 1000}s)`)), IDLE_MS);
          });
          try {
            const { done } = await Promise.race([reader.read(), idle]);
            if (done) break;
          } finally {
            clearTimeout(timer!);
          }
        }
      } catch (err) {
        // On a stall (idle timer fired) cancel the reader so the underlying
        // socket is released instead of lingering until GC.
        await reader.cancel().catch(() => {});
        throw err;
      }
    }
  }

  async ensureModel(): Promise<void> {
    const available = await this.isModelAvailable();
    if (!available) {
      await this.pullModel();
    }
  }

  getConfig() {
    return {
      host: this.host,
      model: this.model,
      dimensions: this.dimensions,
    };
  }

  /**
   * Matryoshka truncation: slice to first targetDims dimensions, then L2-normalize.
   * L2 normalization is critical for cosine similarity quality after truncation.
   */
  private truncateAndNormalize(embedding: number[], targetDims: number): number[] {
    const truncated = embedding.slice(0, targetDims);
    const norm = Math.sqrt(truncated.reduce((sum, v) => sum + v * v, 0));
    if (norm === 0) return truncated;
    return truncated.map(v => v / norm);
  }

  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        // Each attempt gets a fresh per-request timeout so a dead socket fails
        // fast instead of hanging (callers: embed() during init + every search).
        return await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(this.requestTimeoutMs) });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.maxRetries - 1) {
          const delay = Math.pow(2, attempt) * 500;
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    throw new Error(`Failed after ${this.maxRetries} retries: ${lastError?.message}`);
  }
}
