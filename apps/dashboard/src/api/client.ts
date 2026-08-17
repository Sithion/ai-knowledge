const API_BASE = import.meta.env.VITE_API_URL || '';

/** Error thrown for non-OK API responses — carries the HTTP status so callers
 *  can distinguish e.g. 403 (disallowed) from 404 (missing). */
export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

// Default per-request timeout. A stalled sidecar (crashed mid-request) used to
// leave the UI spinner forever; AbortSignal.timeout fails the call instead.
// Long-running setup/upgrade calls pass a larger timeoutMs (see api below).
const DEFAULT_TIMEOUT_MS = 30_000;
// Setup/upgrade calls (model pulls, installs, re-embed) legitimately run for
// minutes — bound them generously rather than at the 30s default.
const LONG_TIMEOUT_MS = 30 * 60_000;

/**
 * The sidecar authorization token.
 *
 * Seeded by the Tauri shell through an initialization script, which runs before
 * any page script and is re-injected on every navigation. It is deliberately NOT
 * served in the HTML: the SPA route has to answer unauthenticated, so anything
 * embedded there would be readable by any page on any other local port.
 * In `pnpm dev` the shell is absent, so VITE_SIDECAR_TOKEN stands in.
 */
export const SIDECAR_TOKEN: string =
  (globalThis as any).__COGNISTORE_TOKEN__ || import.meta.env.VITE_SIDECAR_TOKEN || '';

async function request<T>(path: string, options?: RequestInit, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<T> {
  const headers: Record<string, string> = {};
  if (options?.body) {
    headers['Content-Type'] = 'application/json';
  }
  if (SIDECAR_TOKEN) {
    headers['x-cognistore-token'] = SIDECAR_TOKEN;
  }
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      signal: options?.signal ?? AbortSignal.timeout(timeoutMs),
      ...options,
      // AFTER the spread on purpose: a caller passing its own `headers` would
      // otherwise drop the auth token and get a 403.
      headers: { ...headers, ...(options?.headers as Record<string, string> | undefined) },
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'TimeoutError') {
      throw new ApiError('Request timed out — the backend did not respond', 0);
    }
    throw e;
  }
  if (!response.ok) {
    throw new ApiError(`API error: ${response.statusText}`, response.status);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error('Service unavailable — backend is not running');
  }
  return response.json();
}

export interface SetupStatus {
  nodeReady: boolean;
  ollamaInstalled: boolean;
  ollamaRunning: boolean;
  databaseReady: boolean;
  modelAvailable: boolean;
  configsReady: boolean;
  sdkReady: boolean;
  allReady: boolean;
}

export interface SetupResult {
  success: boolean;
  message?: string;
  results?: string[];
  path?: string;
}

/** Status of one upgrade step. Mirrors the sidecar's `DeployStep` — the two
 *  sides are hand-kept in sync (nothing here imports from `server/`). */
export type UpgradeStepStatus = 'success' | 'error' | 'skipped' | 'warning';

export interface UpgradeStepResult {
  step: string;
  status: UpgradeStepStatus;
  message?: string;
}

export interface UpgradeRunResult {
  success: boolean;
  /** True when the app was already up to date and nothing ran. */
  noop?: boolean;
  fromVersion: string | null;
  toVersion: string;
  results: UpgradeStepResult[];
}

/** Live upgrade state. `steps` carries no `message` on purpose — the sidecar
 *  strips it before publishing here; the full text arrives with the POST result. */
export interface UpgradeProgress {
  running: boolean;
  /** Identity of the run being described: latch it to ignore stale snapshots. */
  startedAt: string | null;
  fromVersion: string | null;
  toVersion: string;
  currentStep: string | null;
  steps: { step: string; status: UpgradeStepStatus }[];
}

export const api = {
  // Setup — installs/downloads can take minutes; allow a long (but bounded) timeout.
  getSetupStatus: () => request<SetupStatus>('/api/setup/status'),
  setupNode: () => request<SetupResult>('/api/setup/node', { method: 'POST' }, LONG_TIMEOUT_MS),
  setupOllama: () => request<SetupResult>('/api/setup/ollama', { method: 'POST' }, LONG_TIMEOUT_MS),
  setupOllamaStart: () => request<SetupResult>('/api/setup/ollama-start', { method: 'POST' }, LONG_TIMEOUT_MS),
  setupDatabase: () => request<SetupResult>('/api/setup/database', { method: 'POST' }),
  setupModel: () => request<SetupResult>('/api/setup/model', { method: 'POST' }, LONG_TIMEOUT_MS),
  setupConfigure: () => request<SetupResult>('/api/setup/configure', { method: 'POST' }),
  setupComplete: () => request<SetupResult>('/api/setup/complete', { method: 'POST' }),

  // Upgrade — re-embed + model pull can take minutes.
  checkUpgrade: () => request<{ needsUpgrade: boolean; fromVersion: string | null; toVersion: string; isFirstInstall: boolean }>('/api/upgrade/check'),
  runUpgrade: () => request<UpgradeRunResult>('/api/upgrade/run', { method: 'POST' }, LONG_TIMEOUT_MS),
  /** Live view of the upgrade `runUpgrade()` is performing. Deliberately never
   *  503s, so it answers even while the database step has the SDK torn down. */
  getUpgradeProgress: () => request<UpgradeProgress>('/api/upgrade/progress'),

  // Uninstall
  uninstallAll: () => request<SetupResult>('/api/uninstall', { method: 'POST' }, LONG_TIMEOUT_MS),

  // Knowledge CRUD
  search: (query: string, options?: Record<string, unknown>) =>
    request('/api/knowledge/search', { method: 'POST', body: JSON.stringify({ query, ...options }) }),

  listRecent: (limit = 20, filters?: { type?: string; scope?: string; tags?: string[]; agent?: string; platform?: string }, offset = 0) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (offset) params.set('offset', String(offset));
    if (filters?.type) params.set('type', filters.type);
    if (filters?.scope) params.set('scope', filters.scope);
    if (filters?.agent) params.set('agent', filters.agent);
    if (filters?.platform) params.set('platform', filters.platform);
    if (filters?.tags && filters.tags.length) params.set('tags', filters.tags.join(','));
    return request<any[]>(`/api/knowledge/recent?${params}`);
  },

  getTopTags: (limit = 10, range?: { from: string; to: string }) => {
    const sp = new URLSearchParams({ limit: String(limit) });
    if (range) { sp.set('from', range.from); sp.set('to', range.to); }
    return request<{ tag: string; count: number }[]>(`/api/metrics/top-tags?${sp}`);
  },

  getById: (id: string) => request(`/api/knowledge/${id}`),

  getKnowledgePlans: (id: string) =>
    request<{ planId: string; relationType: string; title: string; status: string }[]>(`/api/knowledge/${id}/plans`),

  create: (data: Record<string, unknown>) =>
    request('/api/knowledge', { method: 'POST', body: JSON.stringify(data) }),

  update: (id: string, data: Record<string, unknown>) =>
    request(`/api/knowledge/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  deleteEntry: (id: string) =>
    request(`/api/knowledge/${id}`, { method: 'DELETE' }),

  listTags: (range?: { from: string; to: string }) => {
    if (!range) return request<string[]>('/api/tags');
    const sp = new URLSearchParams({ from: range.from, to: range.to });
    return request<string[]>(`/api/tags?${sp}`);
  },

  // Tag intelligence
  getTagSuggestions: () =>
    request<{ a: string; b: string; similarity: number; countA: number; countB: number }[]>('/api/tags/suggestions'),
  mergeTags: (from: string, to: string) =>
    request<{ merged: number }>('/api/tags/merge', {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    }),
  mergeTagsBatch: (merges: { from: string; to: string }[]) =>
    request<{ applied: { from: string; to: string; count: number }[]; entriesReembedded: number }>('/api/tags/merge-batch', {
      method: 'POST',
      body: JSON.stringify({ merges }),
    }),

  // Knowledge health
  getStaleEntries: () =>
    request<{ id: string; title: string; type: string; scope: string; confidenceScore: number; updatedAt: string; expiresAt: string | null }[]>('/api/health/stale'),
  getDuplicateGroups: () =>
    request<{ groupId: string; maxSimilarity: number; members: { id: string; title: string; scope: string; type: string; version: number; updatedAt: string }[] }[]>('/api/health/duplicates'),

  // Cleanup cycle
  getCleanupReport: () => request<CleanupReportResponse>('/api/cleanup/report'),
  getCleanupPendingCount: () => request<{ pendingCount: number }>('/api/cleanup/pending-count'),
  runCleanupReport: () =>
    request<{ created: boolean; report: CleanupReport }>('/api/cleanup/report/run', { method: 'POST' }),
  // The first preview may download the merge model, so it gets the long timeout.
  previewCleanupCandidate: (id: string) =>
    request<{ draft: { title: string; content: string }; usedLlm: boolean; tags: string[] }>(
      `/api/cleanup/candidates/${encodeURIComponent(id)}/preview`,
      { method: 'POST' },
      LONG_TIMEOUT_MS,
    ),
  approveCleanupCandidate: (id: string, body?: { draft: { title: string; content: string }; usedLlm: boolean }) =>
    request<{ deleted?: number; skipped?: number; canonicalId?: string; errors?: string[] }>(
      `/api/cleanup/candidates/${encodeURIComponent(id)}/approve`,
      { method: 'POST', body: JSON.stringify(body ?? {}) },
    ),
  dismissCleanupCandidate: (id: string) =>
    request<{ dismissed: boolean }>(`/api/cleanup/candidates/${encodeURIComponent(id)}/dismiss`, { method: 'POST' }),
  closeCleanupReport: (id: string) =>
    request<{ removed: number }>(`/api/cleanup/report/${encodeURIComponent(id)}/close`, { method: 'POST' }),

  getByType: (range?: { from: string; to: string }) => {
    const path = range ? `/api/metrics/by-type?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}` : '/api/metrics/by-type';
    return request<{ type: string; count: number }[]>(path);
  },

  getByScope: (range?: { from: string; to: string }) => {
    const path = range ? `/api/metrics/by-scope?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}` : '/api/metrics/by-scope';
    return request<{ scope: string; count: number }[]>(path);
  },

  getByAgent: (range?: { from: string; to: string }) => {
    const path = range ? `/api/metrics/by-agent?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}` : '/api/metrics/by-agent';
    return request<{ agent: string; count: number }[]>(path);
  },

  getByPlatform: (range?: { from: string; to: string }) => {
    const path = range ? `/api/metrics/by-platform?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}` : '/api/metrics/by-platform';
    return request<{ platform: string; count: number }[]>(path);
  },

  getStats: () => request('/api/stats'),

  getMetrics: () => request<{
    database: { sizeBytes: number; sizeFormatted: string; path: string };
    activity: { last24h: number; last7d: number; last30d: number; total: number };
    activityByDay: { date: string; count: number }[];
    operationsByDay: { date: string; reads: number; writes: number }[];
    typeDistribution: { name: string; value: number }[];
    operations: { readsLastHour: number; readsLastDay: number; writesLastHour: number; writesLastDay: number };
  }>('/api/metrics'),

  getHealth: () => request('/api/health'),

  // Scopes
  listScopes: () => request<string[]>('/api/scopes'),

  // Bulk operations
  bulkDeleteKnowledge: (ids: string[]) =>
    request<{ deleted: number; errors: string[] }>('/api/knowledge/bulk', { method: 'DELETE', body: JSON.stringify({ ids }) }),

  // Export (unified)
  exportUnified: async (include: ('knowledge' | 'plans')[] = ['knowledge', 'plans']) => {
    const response = await fetch(`${API_BASE}/api/export?include=${include.join(',')}`);
    if (!response.ok) throw new Error(`Export failed: ${response.statusText}`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cognistore-export.json';
    a.click();
    URL.revokeObjectURL(url);
  },

  // Parse export file client-side (preview before import)
  parseExportFile: async (file: File): Promise<{
    version?: string;
    knowledgeCount: number;
    plansCount: number;
    knowledge?: any[];
    plans?: any[];
  }> => {
    const text = await file.text();
    const data = JSON.parse(text);
    const knowledge = data.knowledge ?? data.entries;
    const plans = data.plans;
    return {
      version: data.version,
      knowledgeCount: Array.isArray(knowledge) ? knowledge.length : 0,
      plansCount: Array.isArray(plans) ? plans.length : 0,
      knowledge,
      plans,
    };
  },

  // Import (unified)
  importUnified: (data: {
    include: string[];
    knowledge?: any[];
    plans?: any[];
  }) => request<{
    knowledge?: { imported: number; skipped: number; errors: string[] };
    plans?: { imported: number; skipped: number; errors: string[] };
  }>('/api/import', { method: 'POST', body: JSON.stringify(data) }),

  // Plans
  createPlan: (data: { title: string; content: string; tags?: string[]; scope?: string; source?: string; parentPlanId?: string | null; tasks?: { description: string; priority?: string }[] }) =>
    request('/api/plans', { method: 'POST', body: JSON.stringify(data) }),

  listPlans: (limit = 20, status?: string | string[], offset = 0, scope?: string) => {
    const params = new URLSearchParams({ limit: String(limit) });
    const statuses = (Array.isArray(status) ? status : status ? [status] : []).filter(Boolean);
    if (statuses.length) params.set('status', statuses.join(','));
    if (offset) params.set('offset', String(offset));
    if (scope) params.set('scope', scope);
    return request<any[]>(`/api/plans?${params}`);
  },

  getPlan: (id: string) =>
    request<any>(`/api/plans/${id}`),

  // Plan file preview + open in OS editor
  getPlanFile: (id: string) =>
    request<{ exists: boolean; path?: string; content?: string; truncated?: boolean }>(`/api/plans/${id}/file`),
  openPlanFile: (id: string) =>
    request<{ ok: boolean; unsupported?: boolean }>(`/api/plans/${id}/open`, { method: 'POST' }),

  getPlanRelations: (id: string) =>
    request<{ entry: any; relationType: string }[]>(`/api/plans/${id}/relations`),

  // Lineage chain: accepts any member, always answers from the chain's root.
  getPlanChain: (id: string) =>
    request<{
      rootPlanId: string;
      chain: { id: string; title: string; status: string; scope: string; parentPlanId: string | null; depth: number; isCurrent: boolean }[];
      truncated: boolean;
    }>(`/api/plans/${id}/chain`),

  addPlanRelation: (id: string, knowledgeId: string, relationType: 'input' | 'output') =>
    request(`/api/plans/${id}/relations`, { method: 'POST', body: JSON.stringify({ knowledgeId, relationType }) }),

  updatePlan: (id: string, data: Record<string, unknown>) =>
    request(`/api/plans/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  deletePlan: (id: string) =>
    request(`/api/plans/${id}`, { method: 'DELETE' }),

  // Plan Tasks
  listPlanTasks: (planId: string) =>
    request<any[]>(`/api/plans/${planId}/tasks`),

  createPlanTask: (planId: string, data: Record<string, unknown>) =>
    request(`/api/plans/${planId}/tasks`, { method: 'POST', body: JSON.stringify(data) }),

  updatePlanTask: (taskId: string, data: Record<string, unknown>) =>
    request(`/api/plans/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify(data) }),

  deletePlanTask: (taskId: string) =>
    request<{ deleted: boolean }>(`/api/plans/tasks/${taskId}`, { method: 'DELETE' }),

  // Plan Metrics
  getPlanMetrics: (from?: string, to?: string) =>
    request<{
      plans: { total: number; draft: number; active: number; completed: number; archived: number };
      tasks: { total: number; pending: number; inProgress: number; completed: number; avgPerPlan: number };
      plansByDay: { date: string; count: number }[];
    }>(`/api/metrics/plans${from && to ? `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : ''}`),

  // Maintenance
  cleanupDatabase: () => request<{ success: boolean; orphansRemoved: number; vacuumed: boolean; sizeAfter: string }>(
    '/api/maintenance/cleanup', { method: 'POST' }
  ),

  // Re-deploy configurations
  redeploy: () => request<{ success: boolean; results: { step: string; status: string; message?: string }[] }>(
    '/api/redeploy', { method: 'POST' }
  ),

  // Logs
  getLogs: (lines = 100) =>
    request<{ lines: string[]; total: number }>(`/api/logs?lines=${lines}`),

  clearLogs: () =>
    request<{ success: boolean }>('/api/logs', { method: 'DELETE' }),

  // Settings (~/.cognistore/settings.json — survives app upgrades)
  getSettings: () =>
    request<AppSettings>('/api/settings'),

  updateSettings: (patch: Partial<AppSettings>) =>
    request<AppSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),

  // External knowledge providers (~/.cognistore/providers.json)
  listProviders: () => request<ProvidersConfig>('/api/providers'),
  addProvider: (entry: ProviderEntry) =>
    request<ProviderEntry>('/api/providers', { method: 'POST', body: JSON.stringify(entry) }),
  updateProvider: (id: string, entry: Partial<ProviderEntry>) =>
    request<ProviderEntry>(`/api/providers/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(entry) }),
  deleteProvider: (id: string) =>
    request<{ removed: boolean }>(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testProvider: (id: string) =>
    request<{ ok: boolean; message?: string; needsAuth?: boolean }>(`/api/providers/${encodeURIComponent(id)}/test`, { method: 'POST' }),
  oauthStart: (id: string, redirectUri: string) =>
    request<{ ok: boolean; authorizeUrl?: string; alreadyConnected?: boolean; message?: string }>(
      `/api/providers/${encodeURIComponent(id)}/oauth/start`, { method: 'POST', body: JSON.stringify({ redirectUri }) }),
  oauthFinish: (id: string, code: string) =>
    request<{ ok: boolean; message?: string }>(
      `/api/providers/${encodeURIComponent(id)}/oauth/finish`, { method: 'POST', body: JSON.stringify({ code }) }),
  injectProviderSecret: (id: string, value: string) =>
    request<{ ok: boolean }>(`/api/providers/${encodeURIComponent(id)}/secret`, {
      method: 'POST',
      body: JSON.stringify({ value }),
    }),
  searchFederated: (query: string, options?: Record<string, unknown>) =>
    request<FederatedSearchResult>('/api/knowledge/search', {
      method: 'POST',
      body: JSON.stringify({ query, includeExternal: true, ...options }),
    }),

  // Ranged metrics (driven by the global date-range picker)
  getActivity: (from: string, to: string) =>
    request<{ operationsByDay: { date: string; reads: number; writes: number }[] }>(
      `/api/metrics/activity?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),

  // Token usage
  getTokenUsage: (params: { from: string; to: string; source?: string; model?: string; project?: string }) => {
    const sp = new URLSearchParams({ from: params.from, to: params.to });
    if (params.source) sp.set('source', params.source);
    if (params.model) sp.set('model', params.model);
    if (params.project) sp.set('project', params.project);
    return request<TokenUsageAggregates>(`/api/token-usage?${sp}`);
  },

  scanTokenUsage: () =>
    request<{ success: boolean; inserted: number; scanned: number; bySource: Record<string, { inserted: number; scanned: number }> }>(
      '/api/token-usage/scan', { method: 'POST' },
    ),
};

export interface TokenUsageAggregates {
  totals: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
  byDay: { date: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }[];
  byModel: { model: string; totalTokens: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }[];
  byProject: { project: string; totalTokens: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; sources: string }[];
  byHourDay: { dayOfWeek: number; hour: number; totalTokens: number }[];
  topSessions: { sessionId: string; project: string | null; model: string; startedAt: string; endedAt: string; messageCount: number; totalTokens: number; source: string }[];
  cacheEfficiency: number;
}

export interface AppSettings {
  autoUpdate: boolean;
  dateRangePreset: '1d' | '1w' | '1m' | '1y' | '2y' | 'custom';
  lastSelectedRange: { from: string; to: string } | null;
  tokenProviderFilter: ProviderFilter;
  alwaysSearchExternalProviders: boolean;
  cleanupEnabled: boolean;
  cleanupIntervalDays: number;
  cleanupUnreadDays: number;
  cleanupDupThreshold: number;
  cleanupLlmModel: string;
  lastCleanupReportAt: string | null;
}

// ── Cleanup cycle ──

export interface CleanupReport {
  id: string;
  createdAt: string;
  status: 'open' | 'closed' | string;
  stats: {
    unreadDays?: number;
    dupThreshold?: number;
    generatedAt?: string;
    /** Present when unread detection was suppressed; explains why. */
    unreadGate?: string;
    counts?: { deprecated: number; unread: number; duplicateGroups: number; removableEntries: number };
    removed?: number;
    autoClosed?: boolean;
  };
}

export interface CleanupCandidate {
  id: string;
  reportId: string;
  category: 'deprecated' | 'unread' | 'duplicate_group' | string;
  entryIds: string[];
  payload: {
    title?: string;
    scope?: string;
    type?: string;
    updatedAt?: string;
    lastReadAt?: string | null;
    maxSimilarity?: number;
    canonicalUpdatedAt?: string;
    members?: { id: string; title: string; scope: string; updatedAt: string }[];
  };
  status: 'pending' | 'applying' | 'dismissed' | 'applied' | 'failed' | string;
  resolution: Record<string, unknown> | null;
  updatedAt: string;
}

export interface CleanupReportResponse {
  report: CleanupReport | null;
  candidates: CleanupCandidate[];
  settings: Pick<
    AppSettings,
    'cleanupEnabled' | 'cleanupIntervalDays' | 'cleanupUnreadDays' | 'cleanupDupThreshold' | 'cleanupLlmModel' | 'lastCleanupReportAt'
  >;
}

// ── External knowledge providers (MCP-only, config v2) ──
export interface ProviderAuth {
  type: 'none' | 'header' | 'oauth';
  headerName?: string;
  secretRef?: string;
  scopes?: string[];
  clientId?: string;
  allowInsecure?: boolean;
}
export interface ProviderEntry {
  id: string;
  name: string;
  enabled: boolean;
  transport: 'stdio' | 'http';
  // stdio
  command?: string; args?: string[]; env?: Record<string, string>;
  // http (remote, Streamable HTTP)
  url?: string;
  auth?: ProviderAuth;
  // query mapping
  mode?: 'tool' | 'resources';
  toolName?: string; argMapping?: Record<string, string>; resultPath?: string;
}
export interface ProvidersConfig { version: 2; providers: ProviderEntry[]; }
export interface ExternalResult { title: string; content: string; url?: string; score?: number; metadata?: Record<string, unknown>; }
export interface ExternalSection { providerId: string; providerName: string; results: ExternalResult[]; error?: string; tookMs: number; }
export interface KnowledgeSearchResult { entry: Record<string, unknown>; similarity: number; }
export interface FederatedSearchResult { local: KnowledgeSearchResult[]; external: ExternalSection[]; }

/** Store a provider credential in the OS keychain (Tauri only; no-op outside Tauri). */
export async function setProviderSecret(id: string, value: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('set_provider_secret', { token: SIDECAR_TOKEN, id, value });
}

/** UI-level token provider filter. Maps to the backend `token_usage.source` column. */
export type ProviderFilter = 'all' | 'claude' | 'copilot';

/** Map a UI provider choice to the `source` filter passed to `getTokenUsage`. `all` → no filter. */
export const PROVIDER_SOURCE: Record<ProviderFilter, string | undefined> = {
  all: undefined,
  claude: 'claude-code',
  copilot: 'copilot-cli',
};

/** Reverse of PROVIDER_SOURCE: a backend `source` value → its UI provider key. */
export const SOURCE_TO_PROVIDER: Record<string, Exclude<ProviderFilter, 'all'>> = {
  'claude-code': 'claude',
  'copilot-cli': 'copilot',
};
