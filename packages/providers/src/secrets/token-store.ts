import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OAuthTokens, OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

/** Persisted OAuth state for one remote MCP provider (keyed by provider id). */
export interface OAuthSession {
  tokens?: OAuthTokens;
  /** Dynamic Client Registration result (RFC 7591). */
  clientInformation?: OAuthClientInformationFull;
  codeVerifier?: string;
  state?: string;
}

/**
 * Persistence for OAuth sessions. The sidecar (the always-running process that
 * performs token refresh) is the source of truth; the keychain mirror is optional
 * defense-in-depth handled by the Tauri shell.
 */
export interface ITokenStore {
  get(providerId: string): Promise<OAuthSession>;
  /** Shallow-merge a partial session (undefined fields clear that key). */
  patch(providerId: string, partial: Partial<OAuthSession>): Promise<void>;
  delete(providerId: string): Promise<void>;
}

/** File-backed token store: a single JSON map at `filePath`, atomic writes, mode 0600. */
export class FileTokenStore implements ITokenStore {
  constructor(private readonly filePath: string) {}

  /**
   * Serializes read-modify-write mutations so concurrent refreshes (e.g. two
   * providers' tokens refreshing during overlapping searches) can't clobber the
   * shared JSON map with a last-writer-wins overwrite.
   */
  private writeChain: Promise<void> = Promise.resolve();

  private readAll(): Record<string, OAuthSession> {
    if (!existsSync(this.filePath)) return {};
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf-8')) as Record<string, OAuthSession>;
    } catch {
      return {};
    }
  }

  private writeAll(data: Record<string, OAuthSession>): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.filePath);
  }

  /** Run a mutation after all previously-queued ones (read happens inside the lock). */
  private enqueue(mutate: (all: Record<string, OAuthSession>) => boolean): Promise<void> {
    const next = this.writeChain.then(() => {
      const all = this.readAll();
      if (mutate(all)) this.writeAll(all);
    });
    // Keep the chain alive even if a mutation throws.
    this.writeChain = next.catch(() => {});
    return next;
  }

  async get(providerId: string): Promise<OAuthSession> {
    return this.readAll()[providerId] ?? {};
  }

  async patch(providerId: string, partial: Partial<OAuthSession>): Promise<void> {
    return this.enqueue((all) => {
      all[providerId] = { ...(all[providerId] ?? {}), ...partial };
      return true;
    });
  }

  async delete(providerId: string): Promise<void> {
    return this.enqueue((all) => {
      if (!(providerId in all)) return false;
      delete all[providerId];
      return true;
    });
  }
}

/** In-memory token store (tests / non-persistent contexts). */
export class MemoryTokenStore implements ITokenStore {
  private readonly map = new Map<string, OAuthSession>();
  async get(providerId: string): Promise<OAuthSession> {
    return this.map.get(providerId) ?? {};
  }
  async patch(providerId: string, partial: Partial<OAuthSession>): Promise<void> {
    this.map.set(providerId, { ...(this.map.get(providerId) ?? {}), ...partial });
  }
  async delete(providerId: string): Promise<void> {
    this.map.delete(providerId);
  }
}
