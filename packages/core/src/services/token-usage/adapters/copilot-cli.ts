import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, basename } from 'node:path';
import type { ScannedTokenRecord, TokenSourceAdapter } from '../adapter.js';
import type { ScanState, TokenUsageRecord } from '../types.js';

const SOURCE = 'copilot-cli';

/**
 * Deterministic id per (session, model, occurredAt) so re-scanning is idempotent
 * but two models inside the same shutdown still produce distinct rows.
 */
function recordId(sessionId: string | null, model: string, occurredAt: string): string {
  const key = `${SOURCE}|${sessionId ?? ''}|${model}|${occurredAt}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

interface ParsedShutdown {
  occurredAt: string;
  sessionId: string | null;
  cwd: string | null;
  perModel: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  }[];
}

/**
 * Walk a Copilot CLI events.jsonl looking for one `session.start` (to extract
 * cwd + sessionId) and one terminal `session.shutdown` (to extract
 * per-model usage). Returns null when no shutdown is present — the session is
 * still active (or crashed) and will be picked up on a later scan.
 */
function parseEventsFile(filePath: string): ParsedShutdown | null {
  let raw: string;
  try { raw = readFileSync(filePath, 'utf8'); } catch { return null; }

  let cwd: string | null = null;
  let sessionId: string | null = null;
  let shutdown: ParsedShutdown | null = null;

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let evt: any;
    try { evt = JSON.parse(line); } catch { continue; }
    if (!evt || typeof evt !== 'object') continue;

    if (evt.type === 'session.start') {
      const data = evt.data ?? {};
      sessionId = (data.sessionId as string | undefined) ?? sessionId;
      const ctx = data.context ?? {};
      cwd = (ctx.cwd as string | undefined) ?? cwd;
    } else if (evt.type === 'session.shutdown') {
      const data = evt.data ?? {};
      const modelMetrics = data.modelMetrics;
      if (!modelMetrics || typeof modelMetrics !== 'object') continue;
      const perModel: ParsedShutdown['perModel'] = [];
      for (const [model, payload] of Object.entries(modelMetrics)) {
        const usage = (payload as any)?.usage;
        if (!usage || typeof usage !== 'object') continue;
        perModel.push({
          model,
          inputTokens: Number(usage.inputTokens ?? 0) || 0,
          outputTokens: Number(usage.outputTokens ?? 0) || 0,
          cacheReadTokens: Number(usage.cacheReadTokens ?? 0) || 0,
          cacheCreationTokens: Number(usage.cacheWriteTokens ?? 0) || 0,
        });
      }
      if (perModel.length === 0) continue;
      shutdown = {
        occurredAt: (evt.timestamp as string | undefined) ?? new Date().toISOString(),
        sessionId,
        cwd,
        perModel,
      };
      // Keep walking in the unlikely case a later shutdown overrides this one
      // (in practice only one shutdown per file).
    }
  }
  return shutdown;
}

export interface CopilotCliAdapterOptions {
  /** Override the session-state root (defaults to `~/.copilot/session-state`). Used in tests. */
  sessionStateDir?: string;
}

export class CopilotCliAdapter implements TokenSourceAdapter {
  readonly name = SOURCE;
  private readonly sessionStateDir: string;

  constructor(options: CopilotCliAdapterOptions = {}) {
    this.sessionStateDir = options.sessionStateDir ?? resolve(homedir(), '.copilot', 'session-state');
  }

  async *scan(getState: (filePath: string) => ScanState | undefined): AsyncIterable<ScannedTokenRecord> {
    if (!existsSync(this.sessionStateDir)) return;

    let entries: string[];
    try { entries = readdirSync(this.sessionStateDir); } catch { return; }

    for (const entry of entries) {
      const sessionDir = resolve(this.sessionStateDir, entry);
      let stat;
      try { stat = statSync(sessionDir); } catch { continue; }
      // Only the newer v1.x format: <sessionId>/events.jsonl. The top-level
      // <sessionId>.jsonl files (older v0.0.x agent) do not carry per-model
      // usage; we skip them on purpose.
      if (!stat.isDirectory()) continue;

      const filePath = resolve(sessionDir, 'events.jsonl');
      let fstat;
      try { fstat = statSync(filePath); } catch { continue; }
      const fileSize = fstat.size;
      const mtime = fstat.mtime.toISOString();
      const state = getState(filePath);
      // Re-read only when the file has grown since the last scan (sessions
      // append-only). lastOffset is just a tripwire for "anything new?"
      if (state && state.lastOffset >= fileSize) continue;

      const parsed = parseEventsFile(filePath);
      if (!parsed) {
        // No shutdown yet — mark as "seen at this size" so we don't re-read
        // until more bytes arrive.
        yield { record: null, filePath, byteOffset: fileSize, mtime };
        continue;
      }

      const project = parsed.cwd ? basename(parsed.cwd) : null;

      for (const m of parsed.perModel) {
        const record: TokenUsageRecord = {
          id: recordId(parsed.sessionId, m.model, parsed.occurredAt),
          source: SOURCE,
          model: m.model,
          project,
          sessionId: parsed.sessionId,
          messageId: null,
          occurredAt: parsed.occurredAt,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
          cacheReadTokens: m.cacheReadTokens,
          cacheCreationTokens: m.cacheCreationTokens,
        };
        yield { record, filePath, byteOffset: fileSize, mtime };
      }
    }
  }
}
