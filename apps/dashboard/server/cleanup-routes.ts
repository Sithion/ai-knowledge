import type { FastifyInstance } from 'fastify';
import { MergeDraftError } from '@cognistore/core';
import { buildMergeDraft } from './llm-merge.js';
import { readSettings, writeSettings, type AppSettings } from './settings.js';

/**
 * HTTP surface + scheduling for the cleanup cycle.
 *
 * Kept out of index.ts (2400+ lines, everything inside one `start()` closure) so
 * these handlers and the scheduling predicate can be reasoned about — and so the
 * predicate can be exercised without booting a server.
 */

export interface CleanupRouteDeps {
  sdk: any;
  /** Returns a 503 payload when the SDK is not ready yet, or null to proceed. */
  ensureReady: (reply: any) => unknown;
  /** CSRF guard: true when the request came from a foreign origin (already replied 403). */
  sendError: (reply: any, code: number, error: string, extra?: Record<string, unknown>) => unknown;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Ollama host resolved by the sidecar, so the model client does not re-derive it from env. */
  ollamaHost?: string;
}

/**
 * Generate a report when one is due, and retire one that has been ignored.
 *
 * Returns what it did, for logging and tests. Never throws: it runs from a timer.
 *
 * The settings accessors are injectable and default to the real
 * `~/.cognistore/settings.json`. Tests MUST pass their own: this function
 * persists `lastCleanupReportAt`, and the suite runs against the developer's
 * actual HOME, so calling it with the defaults rewrites their live settings.
 */
export async function maybeGenerateReport(
  deps: Pick<CleanupRouteDeps, 'sdk' | 'log'> & {
    readSettings?: () => AppSettings;
    writeSettings?: (patch: Partial<AppSettings>) => AppSettings;
  },
): Promise<{ action: 'disabled' | 'not-due' | 'open-report' | 'generated' | 'error'; reportId?: string }> {
  const read = deps.readSettings ?? readSettings;
  const write = deps.writeSettings ?? writeSettings;
  const settings = read();
  if (!settings.cleanupEnabled) return { action: 'disabled' };

  try {
    // An ignored report would otherwise block the cycle forever: only one report
    // may be open at a time, and the timestamp only advances when one is created.
    const latest = deps.sdk.getLatestCleanupReport();
    if (latest?.report?.status === 'open') {
      const ageDays = (Date.now() - Date.parse(latest.report.createdAt)) / 86_400_000;
      if (Number.isFinite(ageDays) && ageDays > settings.cleanupIntervalDays * 2) {
        deps.sdk.closeCleanupReport(latest.report.id, { autoClosed: true });
        deps.log('info', `Cleanup: auto-closed report ${latest.report.id} after ${Math.floor(ageDays)}d`);
      } else {
        return { action: 'open-report', reportId: latest.report.id };
      }
    }

    const last = settings.lastCleanupReportAt ? Date.parse(settings.lastCleanupReportAt) : NaN;
    const dueMs = settings.cleanupIntervalDays * 86_400_000;
    if (Number.isFinite(last) && Date.now() - last < dueMs) return { action: 'not-due' };

    const result = await deps.sdk.generateCleanupReport({
      unreadDays: settings.cleanupUnreadDays,
      dupThreshold: settings.cleanupDupThreshold,
    });
    // Only advance on an actual generation. Advancing when we merely found an
    // existing open report would let a never-reviewed report starve the cycle.
    if (result.created) {
      write({ lastCleanupReportAt: new Date().toISOString() });
      const counts = result.report?.stats?.counts ?? {};
      deps.log('info', `Cleanup report ${result.report.id}: ${JSON.stringify(counts)}`);
      return { action: 'generated', reportId: result.report.id };
    }
    return { action: 'open-report', reportId: result.report?.id };
  } catch (err: any) {
    deps.log('warn', `Cleanup report generation failed: ${err?.message ?? err}`);
    return { action: 'error' };
  }
}

export function registerCleanupRoutes(app: FastifyInstance, deps: CleanupRouteDeps): void {
  const { sdk, ensureReady, sendError } = deps;

  /** Members of a duplicate-group candidate, canonical first, for merging. */
  const membersOf = (candidate: any): any[] => {
    const rows = sdk.getEntriesForCleanupCandidate(candidate.id);
    const byId = new Map<string, any>(rows.map((r: any) => [r.id, r]));
    return candidate.entryIds
      .map((id: string) => byId.get(id))
      .filter(Boolean)
      .map((r: any) => ({
        id: r.id,
        title: r.title,
        content: r.content,
        tags: Array.isArray(r.tags) ? r.tags : JSON.parse(r.tags ?? '[]'),
        updatedAt: r.updatedAt,
      }));
  };

  app.get('/api/cleanup/report', async (_request, reply) => {
    const err = ensureReady(reply); if (err) return err;
    const latest = sdk.getLatestCleanupReport();
    if (!latest) return { report: null, candidates: [], settings: cleanupSettings() };
    return { ...latest, settings: cleanupSettings() };
  });

  // Deliberately separate from the full report: the dashboard banner polls this,
  // and shipping the entire candidate list on a poll would be wasteful.
  app.get('/api/cleanup/pending-count', async (_request, reply) => {
    const err = ensureReady(reply); if (err) return err;
    return { pendingCount: sdk.countPendingCleanupCandidates() };
  });

  app.post('/api/cleanup/report/run', async (request, reply) => {
    const err = ensureReady(reply); if (err) return err;
    const settings = readSettings();
    const result = await sdk.generateCleanupReport({
      unreadDays: settings.cleanupUnreadDays,
      dupThreshold: settings.cleanupDupThreshold,
    });
    if (result.created) writeSettings({ lastCleanupReportAt: new Date().toISOString() });
    return { created: result.created, report: result.report };
  });

  /**
   * Draft the merge for a duplicate group so the user can read it before
   * approving. The first call may download the model, hence the long timeout on
   * the client side.
   */
  app.post<{ Params: { id: string } }>('/api/cleanup/candidates/:id/preview', async (request, reply) => {
    const err = ensureReady(reply); if (err) return err;
    const candidate = sdk.getCleanupCandidate(request.params.id);
    if (!candidate) return sendError(reply, 404, 'Cleanup candidate not found');
    if (candidate.category !== 'duplicate_group') {
      return sendError(reply, 400, 'Only duplicate groups can be previewed');
    }
    const members = membersOf(candidate);
    if (members.length < 2) return sendError(reply, 409, 'Fewer than two members still exist');
    // membersOf preserves entryIds order and drops what no longer exists, so a
    // deleted canonical silently promotes another member to members[0] — and the
    // draft would be built around an entry apply will never keep. Apply aborts on
    // exactly this, so refuse here rather than draft a merge that cannot land.
    if (members[0].id !== candidate.entryIds[0]) {
      return sendError(reply, 409, 'Canonical entry no longer exists');
    }

    const settings = readSettings();
    const { draft, usedLlm } = await buildMergeDraft(members, {
      host: deps.ollamaHost,
      model: settings.cleanupLlmModel,
    });
    return { draft, usedLlm, tags: sdk.previewMergedTags(members) };
  });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/cleanup/candidates/:id/approve',
    async (request, reply) => {
      const err = ensureReady(reply); if (err) return err;
      const candidate = sdk.getCleanupCandidate(request.params.id);
      if (!candidate) return sendError(reply, 404, 'Cleanup candidate not found');

      try {
        if (candidate.category === 'duplicate_group') {
          // The draft must come from a preview the user actually saw. Generating
          // one here would let an unreviewed merge delete the other members.
          const draft = (request.body as any)?.draft;
          if (!draft || typeof draft !== 'object') {
            return sendError(reply, 400, 'A reviewed draft is required to approve a consolidation');
          }
          const usedLlm = (request.body as any)?.usedLlm === true;
          return await sdk.applyConsolidationCandidate(candidate.id, draft, usedLlm);
        }
        return await sdk.applyRemovalCandidate(candidate.id);
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        // A malformed draft is the caller's fault, not the server's: apply
        // re-validates it, and an unmapped MergeDraftError would surface as 500.
        // (The message test is a fallback: `instanceof` would fail if core were
        // ever resolved as two module instances by the bundler.)
        if (e instanceof MergeDraftError || /^Draft /.test(msg)) return sendError(reply, 400, msg);
        // Lost the claim race, or the world moved under the report.
        if (/not pending|aborted/i.test(msg)) return sendError(reply, 409, msg);
        throw e;
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/cleanup/candidates/:id/dismiss', async (request, reply) => {
    const err = ensureReady(reply); if (err) return err;
    try {
      sdk.dismissCleanupCandidate(request.params.id);
      return { dismissed: true };
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (/not found/i.test(msg)) return sendError(reply, 404, msg);
      if (/not pending/i.test(msg)) return sendError(reply, 409, msg);
      throw e;
    }
  });

  app.post<{ Params: { id: string } }>('/api/cleanup/report/:id/close', async (request, reply) => {
    const err = ensureReady(reply); if (err) return err;
    try {
      return sdk.closeCleanupReport(request.params.id);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (/not found/i.test(msg)) return sendError(reply, 404, msg);
      throw e;
    }
  });
}

/** The cleanup-relevant slice of settings, for the UI. */
function cleanupSettings(): Pick<
  AppSettings,
  'cleanupEnabled' | 'cleanupIntervalDays' | 'cleanupUnreadDays' | 'cleanupDupThreshold' | 'cleanupLlmModel' | 'lastCleanupReportAt'
> {
  const s = readSettings();
  return {
    cleanupEnabled: s.cleanupEnabled,
    cleanupIntervalDays: s.cleanupIntervalDays,
    cleanupUnreadDays: s.cleanupUnreadDays,
    cleanupDupThreshold: s.cleanupDupThreshold,
    cleanupLlmModel: s.cleanupLlmModel,
    lastCleanupReportAt: s.lastCleanupReportAt,
  };
}
