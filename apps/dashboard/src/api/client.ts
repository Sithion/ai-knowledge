const API_BASE = import.meta.env.VITE_API_URL || '';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (options?.body) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(`${API_BASE}${path}`, {
    headers,
    ...options,
  });
  if (!response.ok) {
    throw new Error(`API error: ${response.statusText}`);
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

export const api = {
  // Setup
  getSetupStatus: () => request<SetupStatus>('/api/setup/status'),
  setupNode: () => request<SetupResult>('/api/setup/node', { method: 'POST' }),
  setupOllama: () => request<SetupResult>('/api/setup/ollama', { method: 'POST' }),
  setupOllamaStart: () => request<SetupResult>('/api/setup/ollama-start', { method: 'POST' }),
  setupDatabase: () => request<SetupResult>('/api/setup/database', { method: 'POST' }),
  setupModel: () => request<SetupResult>('/api/setup/model', { method: 'POST' }),
  setupConfigure: () => request<SetupResult>('/api/setup/configure', { method: 'POST' }),
  setupComplete: () => request<SetupResult>('/api/setup/complete', { method: 'POST' }),

  // Upgrade
  checkUpgrade: () => request<{ needsUpgrade: boolean; fromVersion: string | null; toVersion: string; isFirstInstall: boolean }>('/api/upgrade/check'),
  runUpgrade: () => request<{ success: boolean; fromVersion: string; toVersion: string; results: { step: string; status: string; message?: string }[] }>('/api/upgrade/run', { method: 'POST' }),

  // Uninstall
  uninstallAll: () => request<SetupResult>('/api/uninstall', { method: 'POST' }),

  // Knowledge CRUD
  search: (query: string, options?: Record<string, unknown>) =>
    request('/api/knowledge/search', { method: 'POST', body: JSON.stringify({ query, ...options }) }),

  listRecent: (limit = 20, filters?: { type?: string; scope?: string; tags?: string[] }, offset = 0) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (offset) params.set('offset', String(offset));
    if (filters?.type) params.set('type', filters.type);
    if (filters?.scope) params.set('scope', filters.scope);
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
    request<{ a: string; b: string; similarity: number }[]>('/api/tags/suggestions'),
  mergeTags: (from: string, to: string) =>
    request<{ merged: number }>('/api/tags/merge', {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    }),

  // Knowledge health
  getStaleEntries: () =>
    request<{ id: string; title: string; type: string; scope: string; confidenceScore: number; updatedAt: string; expiresAt: string | null }[]>('/api/health/stale'),
  getDuplicatePairs: () =>
    request<{ a: { id: string; title: string }; b: { id: string; title: string }; similarity: number }[]>('/api/health/duplicates'),

  getByType: (range?: { from: string; to: string }) => {
    const path = range ? `/api/metrics/by-type?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}` : '/api/metrics/by-type';
    return request<{ type: string; count: number }[]>(path);
  },

  getByScope: (range?: { from: string; to: string }) => {
    const path = range ? `/api/metrics/by-scope?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}` : '/api/metrics/by-scope';
    return request<{ scope: string; count: number }[]>(path);
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
  createPlan: (data: { title: string; content: string; tags?: string[]; scope?: string; source?: string; tasks?: { description: string; priority?: string }[] }) =>
    request('/api/plans', { method: 'POST', body: JSON.stringify(data) }),

  listPlans: (limit = 20, status?: string, offset = 0, scope?: string) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (status) params.set('status', status);
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
    request(`/api/plans/tasks/${taskId}`, { method: 'DELETE' }),

  // Plan Metrics
  getPlanMetrics: () =>
    request<{
      plans: { total: number; draft: number; active: number; completed: number; archived: number };
      tasks: { total: number; pending: number; inProgress: number; completed: number; avgPerPlan: number };
      plansByDay: { date: string; count: number }[];
    }>('/api/metrics/plans'),

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
  dateRangePreset: '1d' | '1w' | '1m' | '1y' | 'custom';
  lastSelectedRange: { from: string; to: string } | null;
  tokenProviderFilter: ProviderFilter;
  alwaysSearchExternalProviders: boolean;
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
  await invoke('set_provider_secret', { id, value });
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
