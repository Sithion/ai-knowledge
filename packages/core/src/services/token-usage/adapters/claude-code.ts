import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, basename } from 'node:path';
import type { ScannedTokenRecord, TokenSourceAdapter } from '../adapter.js';
import type { ScanState, TokenUsageRecord } from '../types.js';

const SOURCE = 'claude-code';

/**
 * Decode Claude Code's project folder name back to a project label.
 *
 * Folders look like `-Users-rxt-Projects-cognistore` (cwd with `/` replaced by
 * `-` and a leading `-`). We strip the leading dash and use the trailing path
 * component — close enough to a project name for grouping in the UI.
 */
function decodeProject(folderName: string): string {
  const trimmed = folderName.replace(/^-+/, '');
  const parts = trimmed.split('-').filter(Boolean);
  return parts[parts.length - 1] ?? folderName;
}

function recordId(sessionId: string | null, messageId: string | null, occurredAt: string): string {
  const key = `${SOURCE}|${sessionId ?? ''}|${messageId ?? ''}|${occurredAt}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

/**
 * Read appended bytes from `filePath` starting at `fromOffset`. Returns the
 * new byte length on disk plus an iterator of complete lines.
 *
 * Streaming-by-chunks avoids loading huge JSONL files into memory.
 */
function* readNewLines(filePath: string, fromOffset: number, fileSize: number): Generator<{ line: string; byteOffsetAfter: number }> {
  if (fromOffset >= fileSize) return;
  const fd = openSync(filePath, 'r');
  try {
    const CHUNK = 64 * 1024;
    const buf = Buffer.alloc(CHUNK);
    let offset = fromOffset;
    let pending = '';
    while (offset < fileSize) {
      const toRead = Math.min(CHUNK, fileSize - offset);
      const bytesRead = readSync(fd, buf, 0, toRead, offset);
      if (bytesRead === 0) break;
      pending += buf.subarray(0, bytesRead).toString('utf8');
      offset += bytesRead;
      let nl: number;
      let pendingStart = 0;
      while ((nl = pending.indexOf('\n', pendingStart)) !== -1) {
        const line = pending.slice(pendingStart, nl);
        pendingStart = nl + 1;
        if (line.length > 0) {
          // byteOffsetAfter is the position right after the consumed '\n'.
          // We track it relative to the original file by counting consumed UTF-8 bytes.
          yield { line, byteOffsetAfter: -1 };
        }
      }
      pending = pending.slice(pendingStart);
    }
    // We can't trivially produce byte offsets while decoding chunks of
    // arbitrary UTF-8. The caller stores `fileSize` as the new offset once a
    // full read completes — which is correct because we always read to EOF.
    void pending; // trailing partial line is dropped until next scan
  } finally {
    closeSync(fd);
  }
}

function parseUsageLine(line: string): Omit<TokenUsageRecord, 'id' | 'project'> | null {
  let obj: any;
  try { obj = JSON.parse(line); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;

  const message = obj.message ?? obj;
  const usage = message?.usage;
  if (!usage || typeof usage !== 'object') return null;

  const occurredAt = (obj.timestamp ?? message?.timestamp) as string | undefined;
  if (!occurredAt) return null;

  const model = (message?.model ?? 'unknown') as string;
  const sessionId = (obj.sessionId ?? message?.sessionId ?? null) as string | null;
  const messageId = (message?.id ?? obj.uuid ?? null) as string | null;

  return {
    source: SOURCE,
    model,
    sessionId,
    messageId,
    occurredAt,
    inputTokens: Number(usage.input_tokens ?? 0) || 0,
    outputTokens: Number(usage.output_tokens ?? 0) || 0,
    cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0) || 0,
    cacheCreationTokens: Number(usage.cache_creation_input_tokens ?? 0) || 0,
  };
}

export interface ClaudeCodeAdapterOptions {
  /** Override the projects root (defaults to `~/.claude/projects`). Used in tests. */
  projectsDir?: string;
}

export class ClaudeCodeAdapter implements TokenSourceAdapter {
  readonly name = SOURCE;
  private readonly projectsDir: string;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.projectsDir = options.projectsDir ?? resolve(homedir(), '.claude', 'projects');
  }

  async *scan(getState: (filePath: string) => ScanState | undefined): AsyncIterable<ScannedTokenRecord> {
    if (!existsSync(this.projectsDir)) return;

    for (const folder of readdirSync(this.projectsDir)) {
      const projectDir = resolve(this.projectsDir, folder);
      let stat;
      try { stat = statSync(projectDir); } catch { continue; }
      if (!stat.isDirectory()) continue;

      const project = decodeProject(basename(folder));
      let files: string[];
      try { files = readdirSync(projectDir); } catch { continue; }

      for (const fileName of files) {
        if (!fileName.endsWith('.jsonl')) continue;
        const filePath = resolve(projectDir, fileName);
        let fstat;
        try { fstat = statSync(filePath); } catch { continue; }
        const fileSize = fstat.size;
        const mtime = fstat.mtime.toISOString();
        const state = getState(filePath);
        const fromOffset = state?.lastOffset ?? 0;
        if (fromOffset >= fileSize) continue;

        for (const { line } of readNewLines(filePath, fromOffset, fileSize)) {
          const parsed = parseUsageLine(line);
          if (!parsed) continue;
          const record: TokenUsageRecord = {
            ...parsed,
            id: recordId(parsed.sessionId, parsed.messageId, parsed.occurredAt),
            project,
          };
          // byteOffset is fileSize for every record yielded from this file;
          // the scanner uses the highest seen offset, so this is safe.
          yield { record, filePath, byteOffset: fileSize, mtime };
        }
      }
    }
  }
}
