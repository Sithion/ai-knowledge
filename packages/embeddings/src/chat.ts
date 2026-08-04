import { DEFAULT_OLLAMA_HOST } from '@cognistore/shared';
import { OllamaEmbeddingClient } from './client.js';

/**
 * Chat-completion client for the local Ollama instance.
 *
 * Lives in @cognistore/embeddings because this package is the product's single
 * Ollama boundary: host resolution, model availability and the (surprisingly
 * subtle) streaming pull all already live here. A second HTTP client in the
 * sidecar would drift from this one and would also be unreachable from the MCP
 * server, which only ever sees the SDK.
 *
 * This client is generation-only. It knows nothing about knowledge entries or
 * merge policy — prompt construction lives with the caller, and the rules a
 * merged entry must satisfy live in @cognistore/core.
 */

/** Small, widely available default. Cheap enough to pull on demand. */
export const DEFAULT_CHAT_MODEL = 'llama3.2:3b';

export interface OllamaChatConfig {
  host?: string;
  model?: string;
  /** Per-request timeout for a generation (ms). Default 120s. */
  requestTimeoutMs?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class OllamaChatClient {
  private host: string;
  private model: string;
  private requestTimeoutMs: number;

  constructor(config?: OllamaChatConfig) {
    this.host = config?.host ?? (process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST);
    this.model = config?.model ?? DEFAULT_CHAT_MODEL;
    this.requestTimeoutMs = config?.requestTimeoutMs ?? 120_000;
  }

  getModel(): string {
    return this.model;
  }

  /**
   * Download the chat model if it is not present yet.
   *
   * Delegates to the embedding client because `isModelAvailable`/`pullModel`
   * only depend on host + model name — they are not embedding-specific — and
   * that implementation already handles the connect-vs-stream timeout split and
   * the stalled-download guard that a multi-GB pull needs.
   */
  async ensureModel(): Promise<void> {
    await new OllamaEmbeddingClient({ host: this.host, model: this.model }).ensureModel();
  }

  async isAvailable(): Promise<boolean> {
    return new OllamaEmbeddingClient({ host: this.host, model: this.model }).isModelAvailable();
  }

  /**
   * Run a chat completion constrained to JSON and return the parsed object.
   *
   * Ollama's `format: 'json'` makes the model emit JSON, but does not guarantee
   * it matches any particular shape — the caller must validate what comes back.
   * Returns null on transport failure or unparseable output rather than
   * throwing: every caller here has a non-LLM fallback, and a model being down
   * must never break the feature.
   */
  async chatJson(
    messages: ChatMessage[],
    opts: { temperature?: number } = {},
  ): Promise<Record<string, unknown> | null> {
    let response: Response;
    try {
      response = await fetch(`${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          format: 'json',
          options: { temperature: opts.temperature ?? 0.2 },
        }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;

    try {
      const data = (await response.json()) as { message?: { content?: string } };
      const content = data?.message?.content;
      if (typeof content !== 'string' || content.trim().length === 0) return null;
      const parsed = JSON.parse(content);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}
