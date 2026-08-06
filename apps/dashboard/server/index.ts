import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import { execSync, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync, readdirSync, unlinkSync, rmdirSync, readFileSync, writeFileSync, statSync, chmodSync, copyFileSync, appendFileSync, renameSync, realpathSync, openSync, readSync, closeSync, fstatSync, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { KnowledgeSDK } from '@cognistore/sdk';
import { ConfigManager } from '@cognistore/config';
import { providersConfigSchema, providerEntrySchema, buildProvider, migrateProvidersConfig, EnvSecretStore, FileTokenStore, InteractiveOAuthFlow, secretRefToEnvKey } from '@cognistore/providers';
import type {
  CreateKnowledgeInput,
  UpdateKnowledgeInput,
  SearchOptions,
} from '@cognistore/shared';
import {
  mergeTagsBatchSchema,
  importSchema,
  updatePlanSchema,
  createPlanTaskSchema,
  updatePlanTaskSchema,
  isPlanStatus,
} from '@cognistore/shared';
import {
  UNKNOWN_VERSION,
  buildMcpEntry as buildMcpEntryPure,
  detectGlobalMcpShadow,
  getDeployedVersion as readDeployedVersion,
  resolveMcpSpec,
  saveDeployedVersion as persistDeployedVersion,
} from './mcp-entry.js';
import {
  readSettings,
  writeSettings,
  sanitizeSettings,
  isValidOllamaModelName,
  SETTINGS_DEFAULTS,
  type AppSettings,
} from './settings.js';
import { registerCleanupRoutes, maybeGenerateReport } from './cleanup-routes.js';
import {
  createUpgradeProgress,
  deployWentWell,
  type DeployStep as UpgradeDeployStep,
} from './upgrade-progress.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


const PORT = Number(process.env.DASHBOARD_PORT) || 3210;
const TEMPLATES_PATH = process.env.TEMPLATES_PATH || join(__dirname, '..', 'templates');
// NOTE: ./settings.ts has its own INSTALL_DIR that honours COGNISTORE_HOME. That
// override is deliberately scoped to settings.json — everything below (logs,
// providers.json, the database fallback, and the uninstall `rmSync`) still
// resolves from the real home directory, so a test that sets COGNISTORE_HOME
// sandboxes its settings only. Production never sets it, and the two agree.
const INSTALL_DIR = resolve(homedir(), '.cognistore');
const VERSION_FILE = resolve(INSTALL_DIR, '.version');

/** Injected by tsup (`define`) in the bundled sidecar. Absent in the tsc output
 *  (`dist-server/`) and under tsx, hence the `typeof` guard. */
declare const __APP_VERSION__: string;

// Prefer the build-time constant; fall back to a package.json next to the bundle
// for dev runs. NOTE: in the packaged app neither the constant nor the file used
// to exist, which silently yielded UNKNOWN_VERSION forever — see VERSION_RESOLVED.
const APP_VERSION = (() => {
  if (typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__) return __APP_VERSION__;
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'));
    if (pkg.version) return pkg.version as string;
  } catch { /* not packaged next to a package.json */ }
  return UNKNOWN_VERSION;
})();

/** False when the running build could not determine its own version. Everything
 *  that persists or compares versions must check this first — a persisted
 *  UNKNOWN_VERSION makes `needsUpgrade` false forever and freezes every deployed
 *  artifact (hooks, skills, MCP configs) at whatever shipped first. */
const VERSION_RESOLVED = APP_VERSION !== UNKNOWN_VERSION;

/** One entry in a setup/upgrade/redeploy result list. Declared in
 *  ./upgrade-progress.ts, where `DeployStepName` is the source of truth for the
 *  step vocabulary the upgrade emits. */
type DeployStep = UpgradeDeployStep;

/** Skills deployed to ~/.claude/skills and ~/.copilot/skills. */
const COGNISTORE_SKILLS = ['cognistore-query', 'cognistore-capture', 'cognistore-plan'] as const;

/** Get the last deployed version from ~/.cognistore/.version */
function getDeployedVersion(): string | null {
  return readDeployedVersion(INSTALL_DIR);
}

/**
 * Persist the current version as deployed. No-op when the version is unknown or
 * when any deploy step failed — see {@link persistDeployedVersion}.
 */
function saveDeployedVersion(steps: { status: string }[] = []): boolean {
  return persistDeployedVersion(INSTALL_DIR, APP_VERSION, steps);
}

/**
 * Marker for artifacts (hooks, skills, instructions, MCP configs) deployed by the
 * startup self-heal. Kept SEPARATE from .version: /api/upgrade/run owns .version
 * and is the only path that runs the embedding re-embed and integrity resync, and
 * the UI only calls it while /api/upgrade/check still reports needsUpgrade. If the
 * startup path wrote .version it would silently cancel those two steps.
 */
const ARTIFACTS_VERSION_FILE = resolve(INSTALL_DIR, '.artifacts-version');

function getDeployedArtifactsVersion(): string | null {
  try { return readFileSync(ARTIFACTS_VERSION_FILE, 'utf-8').trim(); } catch { return null; }
}

function saveDeployedArtifactsVersion(): void {
  mkdirSync(INSTALL_DIR, { recursive: true });
  writeFileSync(ARTIFACTS_VERSION_FILE, APP_VERSION);
}

// ─── Application Logging ──────────────────────────────────────
const LOG_FILE = resolve(INSTALL_DIR, 'cognistore.log');
const LOG_MAX_LINES = 500;

function rotateLog(): void {
  try {
    if (!existsSync(LOG_FILE)) return;
    const content = readFileSync(LOG_FILE, 'utf-8');
    const lines = content.split('\n');
    if (lines.length > LOG_MAX_LINES) {
      writeFileSync(LOG_FILE, lines.slice(-LOG_MAX_LINES).join('\n'));
    }
  } catch { /* ignore rotation errors */ }
}

function log(level: 'info' | 'warn' | 'error', message: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${message}\n`;
  console.log(line.trimEnd());
  try {
    mkdirSync(INSTALL_DIR, { recursive: true });
    appendFileSync(LOG_FILE, line);
  } catch { /* ignore write errors */ }
}

// Rotate on startup
rotateLog();
log('info', `CogniStore server starting (v${APP_VERSION})`);
if (!VERSION_RESOLVED) {
  log(
    'error',
    'Could not determine the app version (no build-time __APP_VERSION__ and no readable package.json). ' +
      'Upgrades are disabled until this build is fixed: deployed artifacts (hooks, skills, MCP configs) will NOT be refreshed.'
  );
}

// ─── User settings (survives upgrades) ────────────────────────
// Lifted to ./settings.ts so the validation can be unit-tested: the cleanup
// values are load-bearing (a schedule, a deletion predicate, an `ollama rm`
// argument), unlike the display preferences that lived here before.

// ─── External knowledge providers (~/.cognistore/providers.json) ─────
/** Fallback when settings are unreadable at uninstall time. */
const DEFAULT_CLEANUP_MODEL = SETTINGS_DEFAULTS.cleanupLlmModel;

const PROVIDERS_FILE = resolve(INSTALL_DIR, 'providers.json');
type ProvidersConfig = ReturnType<typeof providersConfigSchema.parse>;

const OAUTH_TOKENS_FILE = resolve(INSTALL_DIR, 'oauth-tokens.json');
const providerTokenStore = new FileTokenStore(OAUTH_TOKENS_FILE);

function readProvidersConfig(): ProvidersConfig {
  try {
    if (!existsSync(PROVIDERS_FILE)) return { version: 2, providers: [] };
    // migrateProvidersConfig handles both v2 (validate) and v1→v2 (migrate).
    return migrateProvidersConfig(JSON.parse(readFileSync(PROVIDERS_FILE, 'utf-8'))).config;
  } catch {
    return { version: 2, providers: [] };
  }
}

function writeProvidersConfig(config: ProvidersConfig): void {
  const validated = providersConfigSchema.parse(config);
  mkdirSync(INSTALL_DIR, { recursive: true });
  const tmp = PROVIDERS_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(validated, null, 2));
  try {
    renameSync(tmp, PROVIDERS_FILE);
  } catch {
    copyFileSync(tmp, PROVIDERS_FILE);
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/** Compare two semver strings. Returns positive if a > b, negative if a < b, zero if equal. */
function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

async function start() {
  const sdk = new KnowledgeSDK();
  const configManager = new ConfigManager();

  let sdkReady = false;
  let sdkError: string | null = null;
  let retryInterval: ReturnType<typeof setInterval> | null = null;

  const tryInitSDK = async () => {
    try {
      await sdk.initialize();
      sdkReady = true;
      sdkError = null;
      if (retryInterval) {
        clearInterval(retryInterval);
        retryInterval = null;
      }
      return true;
    } catch (error) {
      sdkError = error instanceof Error ? error.message : String(error);
      return false;
    }
  };

  const SYSTEM_KNOWLEDGE_TITLE = 'CogniStore Agent Workflow';
  // This seed is ONE DB entry injected into EVERY session of EVERY platform
  // (Claude Code, Copilot CLI, OpenCode) via UserPromptSubmit hooks — so tool
  // references must be platform-neutral. Each platform exposes the cognistore
  // MCP tools under its own name (see the prefix note in the text below);
  // hardcoding one platform's full names here caused "Tool does not exist"
  // errors on the others.
  const SYSTEM_KNOWLEDGE_CONTENT = `## CRITICAL: On EVERY task, you MUST: (1) getKnowledge() FIRST, (2) createPlan() for 2+ steps, (3) addKnowledge() LAST. No exceptions. All CogniStore tools are pre-approved — call them directly.

## Tool naming — use the form shown in YOUR tool list
CogniStore tools carry a platform prefix: mcp__cognistore__<tool> in Claude Code, cognistore-<tool> in Copilot CLI, cognistore_<tool> in OpenCode. The steps below use the bare tool name — call it with the prefix your platform shows. If NO cognistore tool exists in your tool list, skip this protocol entirely — never substitute other tools (e.g. raw SQL) to simulate it.

## Your Workflow — Follow on every task automatically

### 1. Search existing knowledge (FIRST action)
getKnowledge(query: "<describe your task>")
Save any returned entry IDs for step 2.

### 2. Create a plan (for tasks with 2+ steps)
createPlan({
  title, content, tags, scope, source,
  parentPlanId: "<id of the plan this work continues, if any>",
  tasks: [{ description: "Step 1" }, { description: "Step 2" }, ...],
  relatedKnowledgeIds: ["<ids-from-step-1>"]
})
Save the returned planId — you need it in step 4.
Plan chains: a plan created WITHOUT parentPlanId is the ORIGINAL of a new effort. Every follow-up plan for the same effort must pass parentPlanId so the chain stays linked and the original stays identifiable. Call getPlanChain(planId) to see the whole chain.
Dedup is automatic: active plan in same scope gets tasks added, similar drafts get updated.
Plan activates automatically when you start the first task.
Plan completes automatically when all tasks are done.
MANDATORY: if you wrote the plan to a local file (e.g. plan mode writes ~/.claude/plans/<name>.md), you MUST pass its ABSOLUTE path as planFilePath so the CogniStore plan links back to the on-disk file. Always.

### 3. Track each task
Before starting a task: updatePlanTask(taskId, { status: "in_progress" })
After finishing a task: updatePlanTask(taskId, { status: "completed" })
Use updatePlanTasks (plural) to update multiple tasks at once.

### 4. Save what you learned (LAST action)
addKnowledge({
  title, content, tags, type, scope, source,
  planId: "<your-plan-id>"
})
Types: fix, decision, pattern, constraint, gotcha. All entries in English.
Update existing entries instead of creating duplicates.
Pass an array to addKnowledge to create multiple entries at once.

### Rules
- Follow this workflow on every task — steps 1 and 4 always apply, even for simple tasks
- For plan-then-execute workflows (two sessions): the getKnowledge response will show your existing active plan
- Subagents that own an implementation slice MAY call createPlan(), but MUST pass parentPlanId = the main effort's plan id (the main agent includes that id in the subagent's prompt). Review-only and read-only subagents must not create plans
- All knowledge entries must be in English
- All CogniStore tools are pre-approved — call them directly without hesitation`;

  const seedSystemKnowledge = async () => {
    if (!sdkReady) return;
    try {
      // listRecent filters system entries, so use direct sqlite query
      const existing = getRawSqlite()?.prepare?.(
        "SELECT id FROM knowledge_entries WHERE type = 'system' AND title = ?"
      )?.get(SYSTEM_KNOWLEDGE_TITLE) as { id: string } | undefined;

      if (existing) {
        // Update content in case it changed between versions
        await sdk.updateKnowledge(existing.id, { content: SYSTEM_KNOWLEDGE_CONTENT });
      } else {
        await sdk.addKnowledge({
          title: SYSTEM_KNOWLEDGE_TITLE,
          content: SYSTEM_KNOWLEDGE_CONTENT,
          tags: ['system', 'workflow', 'mandatory'],
          type: 'system' as any,
          scope: 'global',
          source: 'setup',
        });
      }
    } catch (err) {
      console.warn('Failed to seed system knowledge:', err instanceof Error ? err.message : String(err));
    }
  };

  // SDK initialization moved after app.listen() — see bottom of start()

  // Periodic maintenance every 6 hours: self-heal the operations_daily rollup
  // from the still-retained raw window (MAX-merge, catches any stale/other-process
  // writer) BEFORE pruning the raw log, then cleanup + WAL checkpoint.
  setInterval(() => {
    if (!sdkReady) return;
    try { sdk.reconcileOperationsDaily(); sdk.cleanupOldOperations(); sdk.cleanupCompletedPlanEmbeddings(730); sdk.walCheckpoint(); } catch { /* silent */ }
    // Cleanup report. Awaited inside its own async IIFE with a catch: an
    // unhandled rejection escaping a setInterval callback would crash the
    // sidecar, and this path talks to the DB and (on preview) to Ollama.
    void (async () => { await maybeGenerateReport({ sdk, log }); })().catch(() => { /* logged inside */ });
  }, 6 * 60 * 60 * 1000);

  // Token usage scan every 5 minutes — incremental, idempotent.
  setInterval(() => {
    if (sdkReady) { sdk.scanTokenUsage().catch((e) => log('warn', `Token scan failed: ${e?.message ?? e}`)); }
  }, 5 * 60 * 1000);

  const app = Fastify({ logger: true });
  // Restrict CORS to local origins only (the webview loads same-origin from
  // http://localhost:PORT; Vite dev runs on :5173). Reject external websites so
  // they can't reach local endpoints (esp. the plan-file read/open ones).
  await app.register(cors, {
    origin: (origin, cb) => {
      // Same-origin / non-browser requests omit Origin → allow.
      if (!origin) return cb(null, true);
      try {
        const { hostname, protocol } = new URL(origin);
        const ok = protocol === 'tauri:' || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
        return cb(null, ok);
      } catch {
        return cb(null, false);
      }
    },
  });

  const distPath = resolve(process.env.DASHBOARD_DIST_PATH || join(__dirname, '..', 'dist'));
  await app.register(fastifyStatic, {
    root: distPath,
    prefix: '/',
    wildcard: false,
  });

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.sendFile('index.html');
  });

  const ensureReady = (reply: any) => {
    if (!sdkReady) {
      reply.code(503);
      return { error: 'Service unavailable', message: sdkError || 'Run setup first' };
    }
    return null;
  };

  /** Set the status code and return a uniform error body. Centralizes the
   *  reply.code(n); return { error } pattern repeated across handlers. */
  const sendError = (reply: any, code: number, error: string, extra?: Record<string, unknown>) => {
    reply.code(code);
    return { error, ...extra };
  };

  /** The SDK keeps its better-sqlite3 handle private; a few maintenance/integrity
   *  paths need raw access. Centralize the one unavoidable cast here. */
  type RawSqlite = { prepare: (sql: string) => any; exec: (sql: string) => unknown; transaction?: (fn: any) => any };
  const getRawSqlite = (): RawSqlite | undefined =>
    ((sdk as any).sqlite ?? (sdk as any).db?.sqlite) as RawSqlite | undefined;

  // ─── Setup endpoints ───────────────────────────────────────────

  // Ensure common binary paths are available (Tauri sidecar may not inherit full shell PATH)
  const extraPaths = ['/opt/homebrew/bin', '/usr/local/bin', resolve(homedir(), '.ollama-bin')];
  for (const p of extraPaths) {
    if (existsSync(p) && !process.env.PATH?.includes(p)) {
      process.env.PATH = `${p}:${process.env.PATH}`;
    }
  }

  app.get('/api/setup/status', async () => {
    // Check Node.js (required major) availability
    const nodeReady = (() => {
      const nvmDir = resolve(homedir(), '.nvm', 'versions', 'node');
      if (existsSync(nvmDir)) {
        const versions = readdirSync(nvmDir).filter(v => v.startsWith(`v${REQUIRED_NODE_MAJOR}.`));
        if (versions.length > 0) return true;
      }
      // Check system node
      try {
        const version = execSync('node --version', { stdio: 'pipe' }).toString().trim();
        const major = parseInt(version.replace('v', '').split('.')[0], 10);
        return major === REQUIRED_NODE_MAJOR;
      } catch { return false; }
    })();

    const ollamaInstalled = (() => {
      try { execSync('which ollama', { stdio: 'pipe' }); return true; } catch { return false; }
    })();

    let ollamaRunning = false;
    try {
      const res = await fetch('http://localhost:11434/api/tags');
      ollamaRunning = res.ok;
    } catch { /* not running */ }

    const databaseReady = existsSync(resolve(INSTALL_DIR, 'knowledge.db'));

    let modelAvailable = false;
    if (ollamaRunning) {
      try {
        const res = await fetch('http://localhost:11434/api/tags');
        if (res.ok) {
          const data = (await res.json()) as { models: { name: string }[] };
          const model = process.env.OLLAMA_MODEL || 'nomic-embed-text';
          modelAvailable = data.models.some(m => m.name === model || m.name.startsWith(`${model}:`));
        }
      } catch { /* ignore */ }
    }

    // Check if MCP config and agent instructions exist
    const configsReady = existsSync(ConfigManager.MCP_CONFIG) &&
      (() => {
        try {
          const content = readFileSync(ConfigManager.MCP_CONFIG, 'utf-8');
          if (!content.includes('cognistore')) return false;
          // Also check CLAUDE.md has content (not empty)
          if (!existsSync(ConfigManager.CLAUDE_MD)) return false;
          const claudeMd = readFileSync(ConfigManager.CLAUDE_MD, 'utf-8');
          if (claudeMd.trim().length < 10) return false; // Empty or near-empty
          return true;
        } catch { return false; }
      })();

    const allReady = nodeReady && ollamaInstalled && ollamaRunning && databaseReady && modelAvailable && configsReady && sdkReady;

    return {
      nodeReady,
      ollamaInstalled,
      ollamaRunning,
      databaseReady,
      modelAvailable,
      configsReady,
      sdkReady,
      allReady,
    };
  });

  // Node.js LTS major — required for native module (better-sqlite3) ABI compatibility.
  const REQUIRED_NODE_MAJOR = 24;

  /**
   * Find the nvm-installed Node {REQUIRED_NODE_MAJOR} bin directory, or return null
   * if system node already matches. Returns the absolute path to the bin/ dir
   * (e.g. ~/.nvm/versions/node/v24.x.x/bin) so `npx` can be resolved from it.
   */
  function findNodeBinDir(): string | null {
    const nvmNodeDir = resolve(homedir(), '.nvm', 'versions', 'node');
    if (existsSync(nvmNodeDir)) {
      const versions = readdirSync(nvmNodeDir)
        .filter(v => v.startsWith(`v${REQUIRED_NODE_MAJOR}.`))
        .sort();
      if (versions.length > 0) {
        const binDir = resolve(nvmNodeDir, versions[versions.length - 1], 'bin');
        if (existsSync(resolve(binDir, 'node'))) return binDir;
      }
    }
    // Check if system node already matches the required major
    try {
      const version = execSync('node --version', { stdio: 'pipe' }).toString().trim();
      const major = parseInt(version.replace('v', '').split('.')[0], 10);
      if (major === REQUIRED_NODE_MAJOR) return null; // system npx is fine
    } catch { /* no system node */ }
    return null;
  }

  /** Clear npx caches containing @cognistore/mcp-server so better-sqlite3
   *  gets recompiled for the correct Node version on next npx run. */
  function clearNpxMcpCache() {
    try {
      const npxCacheDir = resolve(homedir(), '.npm', '_npx');
      if (!existsSync(npxCacheDir)) return;
      for (const entry of readdirSync(npxCacheDir)) {
        const pkgJson = resolve(npxCacheDir, entry, 'node_modules', '@cognistore', 'mcp-server', 'package.json');
        if (existsSync(pkgJson)) {
          rmSync(resolve(npxCacheDir, entry), { recursive: true, force: true });
        }
      }
    } catch { /* best effort */ }
  }

  /** Build the MCP server entry. See ./mcp-entry.ts — kept there so it stays
   *  unit-testable (importing this module boots the server). */
  function buildMcpEntry(platform: 'claude-code' | 'copilot' | 'opencode') {
    return buildMcpEntryPure({
      platform,
      installDir: INSTALL_DIR,
      binDir: findNodeBinDir(),
      spec: resolveMcpSpec(APP_VERSION),
    });
  }

  /** Warn (never mutate) when a global install of the MCP server shadows the
   *  pinned spec by putting `cognistore-mcp` on PATH ahead of the registry. */
  function checkGlobalMcpShadow(): DeployStep {
    const shadowed = detectGlobalMcpShadow(APP_VERSION);
    if (!shadowed) return { step: 'mcp-shadow-check', status: 'success' };
    const message =
      `A global ${'@cognistore/mcp-server'}@${shadowed} is installed and can shadow the app's ` +
      `pinned v${APP_VERSION}. Remove it with: npm uninstall -g @cognistore/mcp-server`;
    log('warn', message);
    return { step: 'mcp-shadow-check', status: 'warning', message };
  }

  /**
   * Deploy the global enforcement hooks: copy scripts into ~/.cognistore/hooks/ and
   * inject the hook config into ~/.claude/settings.json (Claude Code) and
   * ~/.copilot/hooks/hooks.json (Copilot, reminder-only). Idempotent — safe to re-run
   * on setup, upgrade, and redeploy. Copilot failures are non-fatal.
   */
  async function deployGlobalHooks(): Promise<void> {
    const hooksDir = await configManager.setupHooks(TEMPLATES_PATH);
    if (hooksDir) {
      await configManager.injectHooks(
        ConfigManager.CLAUDE_SETTINGS,
        ConfigManager.buildClaudeHookConfig(hooksDir)
      );
    }
    try {
      await configManager.setupCopilotHooks(TEMPLATES_PATH);
    } catch (e) {
      console.warn('[CogniStore] Copilot hooks setup failed (non-fatal):', e);
    }
  }

  /**
   * Re-deploy every on-disk artifact the app owns: agent instructions, MCP configs
   * + permissions, skills, and the global enforcement hooks.
   *
   * Scope is deliberately narrow. This is NOT the whole upgrade: DB re-init,
   * seeding, the embedding-dimension re-embed and the integrity resync stay with
   * /api/upgrade/run, which also owns the .version write. Callers differ in what
   * they wrap around this, so they keep those steps themselves.
   *
   * `clearNpxCache` is opt-in: wiping the npx cache forces a full MCP re-download,
   * which is right on an explicit upgrade but must never happen on every launch.
   */
  async function redeployArtifacts(
    opts: { clearNpxCache?: boolean; onStep?: (step: DeployStep) => void } = {},
  ): Promise<DeployStep[]> {
    const results: DeployStep[] = [];
    /** Records a step and publishes it. The callback is never allowed to affect
     *  the deploy: a throw here would escape into the surrounding per-step
     *  `catch`, which would push a *second*, contradictory entry for the same
     *  step — `saveDeployedVersion` would then refuse to write `.version` and
     *  the app would re-upgrade on every launch, forever. */
    const push = (step: DeployStep) => {
      results.push(step);
      try { opts.onStep?.(step); } catch { /* progress is best-effort */ }
    };
    const configTemplateDir = resolve(TEMPLATES_PATH, 'configs');
    const claudeT = resolve(configTemplateDir, 'claude-code-instructions.md');
    const copilotT = resolve(configTemplateDir, 'copilot-instructions.md');
    const opencodeT = resolve(configTemplateDir, 'opencode-instructions.md');

    // 1. Agent instructions
    try {
      if (existsSync(claudeT)) {
        await configManager.injectConfig(ConfigManager.CLAUDE_MD, claudeT, 'Claude Code');
        push({ step: 'instructions-claude', status: 'success' });
      } else {
        console.warn(`[CogniStore] Redeploy: Claude template not found at: ${claudeT}`);
        push({ step: 'instructions-claude', status: 'error', message: `Template not found: ${claudeT}` });
      }
    } catch (e: any) {
      push({ step: 'instructions-claude', status: 'error', message: e.message });
    }

    try {
      if (existsSync(copilotT)) {
        await configManager.injectConfig(ConfigManager.COPILOT_MD, copilotT, 'GitHub Copilot');
        await configManager.injectConfig(ConfigManager.COPILOT_INSTRUCTIONS, copilotT, 'Copilot CLI');
        push({ step: 'instructions-copilot', status: 'success' });
      } else {
        console.warn(`[CogniStore] Redeploy: Copilot template not found at: ${copilotT}`);
        push({ step: 'instructions-copilot', status: 'error', message: `Template not found: ${copilotT}` });
      }
    } catch (e: any) {
      push({ step: 'instructions-copilot', status: 'error', message: e.message });
    }

    try {
      if (existsSync(opencodeT)) {
        await configManager.injectConfig(ConfigManager.OPENCODE_AGENTS_MD, opencodeT, 'OpenCode');
      }
      push({ step: 'instructions-opencode', status: 'success' });
    } catch (e: any) {
      push({ step: 'instructions-opencode', status: 'error', message: e.message });
    }

    // 2. MCP configs (one entry per platform so each stamps its own COGNISTORE_PLATFORM)
    try {
      if (opts.clearNpxCache) clearNpxMcpCache();
      const claudeEntry = buildMcpEntry('claude-code');
      const copilotEntry = buildMcpEntry('copilot');
      const opencodeEntry = buildMcpEntry('opencode');
      await configManager.setupMcpConfig(ConfigManager.MCP_CONFIG, claudeEntry);
      try { await configManager.setupMcpConfig(ConfigManager.CLAUDE_JSON, claudeEntry); } catch { /* optional */ }
      try { await configManager.setupMcpConfig(ConfigManager.COPILOT_MCP_CONFIG, copilotEntry); } catch { /* optional */ }
      try { await configManager.setupOpenCodeMcp(opencodeEntry); } catch { /* optional */ }
      try { await configManager.injectPermissions(ConfigManager.CLAUDE_SETTINGS, ConfigManager.COGNISTORE_AUTO_ALLOW_TOOLS); } catch (e: any) { console.warn('[CogniStore] Permission injection failed:', e.message); }
      push({ step: 'mcp-configs', status: 'success' });
    } catch (e: any) {
      push({ step: 'mcp-configs', status: 'error', message: e.message });
    }

    push(checkGlobalMcpShadow());

    // 3. Skills
    try {
      const skillsDir = resolve(TEMPLATES_PATH, 'skills');
      const home = homedir();

      for (const platform of ['claude-code', 'copilot'] as const) {
        const destRoot = platform === 'claude-code' ? '.claude' : '.copilot';
        for (const name of COGNISTORE_SKILLS) {
          const srcDir = resolve(skillsDir, platform, name);
          if (!existsSync(srcDir)) continue;
          const destDir = resolve(home, destRoot, 'skills', name);
          mkdirSync(destDir, { recursive: true });
          cpSync(srcDir, destDir, { recursive: true });
          const destHooks = resolve(destDir, 'hooks');
          if (existsSync(resolve(srcDir, 'hooks'))) {
            for (const file of readdirSync(destHooks)) {
              if (file.endsWith('.sh')) chmodSync(resolve(destHooks, file), 0o755);
            }
          } else if (existsSync(destHooks)) {
            // Stale hooks/ from an older template version (current skills ship
            // SKILL.md only) — they embed outdated tool names; remove so agents
            // stop receiving stale instructions after upgrade.
            rmSync(destHooks, { recursive: true, force: true });
          }
        }
      }

      // Clean up old flat Copilot skill files (pre-0.9.2 format)
      for (const name of COGNISTORE_SKILLS) {
        const oldFile = resolve(home, '.copilot', 'skills', `${name}.md`);
        if (existsSync(oldFile)) unlinkSync(oldFile);
      }

      // OpenCode skills + plugins
      try { await configManager.setupOpenCodeSkills(TEMPLATES_PATH); } catch { /* optional */ }
      try { await configManager.setupOpenCodePlugins(TEMPLATES_PATH); } catch { /* optional */ }

      push({ step: 'skills', status: 'success' });
    } catch (e: any) {
      push({ step: 'skills', status: 'error', message: e.message });
    }

    // 4. Global enforcement hooks (settings.json + ~/.copilot/hooks)
    try {
      await deployGlobalHooks();
      push({ step: 'hooks', status: 'success' });
    } catch (e: any) {
      push({ step: 'hooks', status: 'error', message: e.message });
    }

    return results;
  }

  app.post('/api/setup/node', async () => {
    try {
      const nvmDir = resolve(homedir(), '.nvm');
      const nodeDir = resolve(nvmDir, 'versions', 'node');

      // Check if the required Node major already exists in nvm
      if (existsSync(nodeDir)) {
        const versions = readdirSync(nodeDir).filter(v => v.startsWith(`v${REQUIRED_NODE_MAJOR}.`));
        if (versions.length > 0) {
          const latest = versions.sort().pop()!;
          const nodeBin = resolve(nodeDir, latest, 'bin', 'node');
          if (existsSync(nodeBin)) {
            return { success: true, message: `Node.js ${latest} already installed`, path: nodeBin };
          }
        }
      }

      // Check if system node already matches the required major
      try {
        const version = execSync('node --version', { stdio: 'pipe' }).toString().trim();
        const major = parseInt(version.replace('v', '').split('.')[0], 10);
        if (major === REQUIRED_NODE_MAJOR) {
          return { success: true, message: `System Node.js ${version} matches`, path: 'node' };
        }
      } catch { /* no system node */ }

      // Install nvm if not present
      if (!existsSync(resolve(nvmDir, 'nvm.sh'))) {
        execSync('curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash', {
          stdio: 'pipe', timeout: 60000,
          env: { ...process.env, NVM_DIR: nvmDir },
        });
      }

      // Install the required Node major via nvm (no --lts: explicit major already
      // resolves the latest matching release; --lts with a number is ambiguous)
      const nvmCmd = `export NVM_DIR="${nvmDir}" && . "$NVM_DIR/nvm.sh" && nvm install ${REQUIRED_NODE_MAJOR}`;
      execSync(nvmCmd, { stdio: 'pipe', timeout: 120000, shell: '/bin/bash' });

      // Verify installation
      const versions = readdirSync(nodeDir).filter(v => v.startsWith(`v${REQUIRED_NODE_MAJOR}.`));
      if (versions.length > 0) {
        const latest = versions.sort().pop()!;
        const nodeBin = resolve(nodeDir, latest, 'bin', 'node');
        return { success: true, message: `Installed Node.js ${latest} via nvm`, path: nodeBin };
      }

      return { success: false, message: 'Node.js installation completed but version not found' };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post('/api/setup/ollama', async () => {
    try {
      // Check if already installed
      try { execSync('which ollama', { stdio: 'pipe' }); log('info', 'Ollama already installed'); return { success: true, message: 'Already installed' }; } catch { /* not installed */ }
      log('info', `Installing Ollama on ${process.platform}...`);

      const platform = process.platform;
      if (platform === 'darwin') {
        // macOS: use brew (no sudo needed). Curl installer requires sudo which doesn't work in app context.
        // Ensure brew paths are in PATH (Tauri sidecar may not inherit full shell PATH)
        const brewPaths = ['/opt/homebrew/bin', '/usr/local/bin'];
        for (const p of brewPaths) {
          if (existsSync(resolve(p, 'brew')) && !process.env.PATH?.includes(p)) {
            process.env.PATH = `${p}:${process.env.PATH}`;
          }
        }
        let hasBrew = false;
        try { execSync('brew --version', { stdio: 'pipe' }); hasBrew = true; } catch { /* no brew */ }

        if (hasBrew) {
          execSync('brew install ollama', { stdio: 'pipe', timeout: 180000 });
          return { success: true, message: 'Installed via Homebrew' };
        }

        // No brew: try install script (may need sudo but worth trying)
        try {
          execSync('curl -fsSL https://ollama.com/install.sh | sh', { stdio: 'pipe', timeout: 180000 });
          return { success: true, message: 'Installed via install script' };
        } catch {
          return { success: false, message: 'Could not install Ollama automatically. Please install Homebrew (brew.sh) and retry, or download Ollama manually from ollama.com/download' };
        }
      } else if (platform === 'linux') {
        // Linux: install script needs sudo. Try pkexec (graphical sudo prompt) first.
        const installScript = '/tmp/cognistore-ollama-install.sh';
        writeFileSync(installScript, '#!/bin/sh\ncurl -fsSL https://ollama.com/install.sh | sh\n');
        execSync(`chmod +x "${installScript}"`, { stdio: 'pipe' });

        // 1. Try pkexec (graphical sudo — works on GNOME, KDE, XFCE)
        let hasPkexec = false;
        try { execSync('which pkexec', { stdio: 'pipe' }); hasPkexec = true; } catch { /* no pkexec */ }
        if (hasPkexec) {
          try {
            log('info', 'Installing Ollama via pkexec (graphical sudo prompt)...');
            execSync(`pkexec "${installScript}"`, { stdio: 'pipe', timeout: 300000 });
            return { success: true, message: 'Installed via install script (pkexec)' };
          } catch (e) {
            log('warn', `pkexec install failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // 2. Try without sudo (works on some distros)
        try {
          log('info', 'Trying Ollama install without sudo...');
          execSync(`"${installScript}"`, { stdio: 'pipe', timeout: 180000 });
          return { success: true, message: 'Installed via install script' };
        } catch {
          return { success: false, message: 'Could not install Ollama automatically. Please run this command in your terminal:\n\ncurl -fsSL https://ollama.com/install.sh | sudo sh\n\nThen click "Retry" to continue setup.' };
        }
      }
      return { success: false, message: 'Unsupported platform. Download Ollama from ollama.com/download' };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post('/api/setup/ollama-start', async () => {
    try {
      // Check if already running
      try {
        const res = await fetch('http://localhost:11434/api/tags');
        if (res.ok) return { success: true, message: 'Already running' };
      } catch { /* not running */ }

      // Find ollama binary
      let ollamaBin = 'ollama';
      const ollamaLocalBin = resolve(homedir(), '.ollama-bin', 'ollama');
      if (existsSync(ollamaLocalBin)) ollamaBin = ollamaLocalBin;

      // Start ollama serve in background
      const child = spawn(ollamaBin, ['serve'], { detached: true, stdio: 'ignore' });
      child.unref();

      // Wait up to 15s for it to be ready
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500));
        try {
          const res = await fetch('http://localhost:11434/api/tags');
          if (res.ok) return { success: true, message: 'Started' };
        } catch { /* keep waiting */ }
      }
      return { success: false, message: 'Timeout waiting for Ollama to start' };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post('/api/setup/database', async () => {
    try {
      const { createDbClient } = await import('@cognistore/core');
      const dbPath = resolve(INSTALL_DIR, 'knowledge.db');
      mkdirSync(INSTALL_DIR, { recursive: true });

      // Migration: copy DB from old ~/.ai-knowledge/ if it exists
      const oldInstallDir = resolve(homedir(), '.ai-knowledge');
      const oldDbPath = resolve(oldInstallDir, 'knowledge.db');
      if (existsSync(oldDbPath) && !existsSync(dbPath)) {
        console.log('[CogniStore] Migrating database from ~/.ai-knowledge/ to ~/.cognistore/');
        copyFileSync(oldDbPath, dbPath);
        // Also copy WAL/SHM if they exist
        if (existsSync(oldDbPath + '-wal')) copyFileSync(oldDbPath + '-wal', dbPath + '-wal');
        if (existsSync(oldDbPath + '-shm')) copyFileSync(oldDbPath + '-shm', dbPath + '-shm');
      }

      const { sqlite } = createDbClient(dbPath);
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_entries (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '[]',
          type TEXT NOT NULL,
          scope TEXT NOT NULL,
          source TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          expires_at TEXT,
          confidence_score REAL NOT NULL DEFAULT 1.0,
          related_ids TEXT,
          agent_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      sqlite.exec('CREATE INDEX IF NOT EXISTS idx_type ON knowledge_entries(type)');
      sqlite.exec('CREATE INDEX IF NOT EXISTS idx_scope ON knowledge_entries(scope)');
      sqlite.close();

      return { success: true, path: dbPath };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post('/api/setup/model', async () => {
    try {
      const model = process.env.OLLAMA_MODEL || 'nomic-embed-text';
      const host = process.env.OLLAMA_HOST || 'http://localhost:11434';

      // Check if already available
      const tagsRes = await fetch(`${host}/api/tags`);
      if (tagsRes.ok) {
        const data = (await tagsRes.json()) as { models: { name: string }[] };
        if (data.models.some(m => m.name === model || m.name.startsWith(`${model}:`))) {
          return { success: true, message: 'Model already available' };
        }
      }

      // Pull model
      const pullRes = await fetch(`${host}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model }),
      });

      if (!pullRes.ok) {
        return { success: false, message: `Pull failed: ${pullRes.statusText}` };
      }

      // Consume stream to completion
      const reader = pullRes.body?.getReader();
      if (reader) {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }

      return { success: true, message: `Model ${model} pulled` };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post('/api/setup/configure', async () => {
    try {
      const results: string[] = [];

      // Inject agent instructions
      const configTemplateDir = resolve(TEMPLATES_PATH, 'configs');

      const claudeTemplatePath = resolve(configTemplateDir, 'claude-code-instructions.md');
      const copilotTemplatePath = resolve(configTemplateDir, 'copilot-instructions.md');

      try {
        if (!existsSync(claudeTemplatePath)) {
          console.warn(`[CogniStore] Claude template not found at: ${claudeTemplatePath}`);
          results.push(`Claude Code config skipped (template not found: ${claudeTemplatePath})`);
        } else {
          await configManager.injectConfig(ConfigManager.CLAUDE_MD, claudeTemplatePath, 'Claude Code');
          results.push('Claude Code config injected');
        }
      } catch (e) { console.warn('[CogniStore] Claude inject error:', e); results.push('Claude Code config error'); }

      try {
        if (!existsSync(copilotTemplatePath)) {
          console.warn(`[CogniStore] Copilot template not found at: ${copilotTemplatePath}`);
          results.push(`Copilot config skipped (template not found: ${copilotTemplatePath})`);
        } else {
          await configManager.injectConfig(ConfigManager.COPILOT_MD, copilotTemplatePath, 'GitHub Copilot');
          results.push('Copilot config injected');
          // Also inject into Copilot CLI path
          await configManager.injectConfig(ConfigManager.COPILOT_INSTRUCTIONS, copilotTemplatePath, 'Copilot CLI');
          results.push('Copilot CLI config injected');
        }
      } catch (e) { console.warn('[CogniStore] Copilot inject error:', e); results.push('Copilot config error'); }

      try {
        const opencodeTemplatePath = resolve(configTemplateDir, 'opencode-instructions.md');
        if (existsSync(opencodeTemplatePath)) {
          await configManager.injectConfig(ConfigManager.OPENCODE_AGENTS_MD, opencodeTemplatePath, 'OpenCode');
          results.push('OpenCode AGENTS.md injected');
        }
      } catch (e) { console.warn('[CogniStore] OpenCode inject error:', e); results.push('OpenCode config error'); }

      // Clear stale npx caches + setup MCP configs (uses the pinned Node npx path)
      clearNpxMcpCache();
      // One entry per platform so each config stamps its own COGNISTORE_PLATFORM.
      const claudeEntry = buildMcpEntry('claude-code');
      const copilotEntry = buildMcpEntry('copilot');
      const opencodeEntry = buildMcpEntry('opencode');

      await configManager.setupMcpConfig(ConfigManager.MCP_CONFIG, claudeEntry);
      results.push('Claude MCP config set');

      try { await configManager.setupMcpConfig(ConfigManager.CLAUDE_JSON, claudeEntry); results.push('Claude JSON config set'); } catch { /* optional */ }
      try { await configManager.setupMcpConfig(ConfigManager.COPILOT_MCP_CONFIG, copilotEntry); results.push('Copilot MCP config set'); } catch { /* optional */ }
      try { await configManager.setupOpenCodeMcp(opencodeEntry); results.push('OpenCode MCP config set'); } catch { /* optional */ }

      // Inject tool permissions for auto-approve (read + write)
      try { await configManager.injectPermissions(ConfigManager.CLAUDE_SETTINGS, ConfigManager.COGNISTORE_AUTO_ALLOW_TOOLS); results.push('Claude permissions injected'); } catch (e: any) { console.warn('[CogniStore] Permission injection failed:', e.message); }

      // Global enforcement hooks. Skill-dir hooks never registered with Claude Code;
      // real global hooks must live in ~/.claude/settings.json (and ~/.copilot/hooks/).
      try { await deployGlobalHooks(); results.push('Global hooks injected (Claude + Copilot)'); }
      catch (e: any) { console.warn('[CogniStore] Hook injection failed:', e?.message); results.push('Hooks injection error'); }

      // Install skills (SKILL.md instructions; hooks are deployed separately above)
      const skillsDir = resolve(TEMPLATES_PATH, 'skills');
      const home = homedir();

      for (const name of ['cognistore-query', 'cognistore-capture', 'cognistore-plan']) {
        const srcDir = resolve(skillsDir, 'claude-code', name);
        if (existsSync(srcDir)) {
          const destDir = resolve(home, '.claude', 'skills', name);
          mkdirSync(destDir, { recursive: true });
          cpSync(srcDir, destDir, { recursive: true });
          const destHooks = resolve(destDir, 'hooks');
          if (existsSync(resolve(srcDir, 'hooks'))) {
            for (const file of readdirSync(destHooks)) {
              if (file.endsWith('.sh')) chmodSync(resolve(destHooks, file), 0o755);
            }
          } else if (existsSync(destHooks)) {
            // Stale hooks/ from an older template version (current skills ship
            // SKILL.md only) — they embed outdated tool names; remove so agents
            // stop receiving stale instructions after upgrade.
            rmSync(destHooks, { recursive: true, force: true });
          }
          results.push(`Skill ${name} installed (Claude)`);
        }
      }

      for (const name of ['cognistore-query', 'cognistore-capture', 'cognistore-plan']) {
        const srcDir = resolve(skillsDir, 'copilot', name);
        if (existsSync(srcDir)) {
          const destDir = resolve(home, '.copilot', 'skills', name);
          mkdirSync(destDir, { recursive: true });
          cpSync(srcDir, destDir, { recursive: true });
          const destHooks = resolve(destDir, 'hooks');
          if (existsSync(resolve(srcDir, 'hooks'))) {
            for (const file of readdirSync(destHooks)) {
              if (file.endsWith('.sh')) chmodSync(resolve(destHooks, file), 0o755);
            }
          } else if (existsSync(destHooks)) {
            // Stale hooks/ from an older template version (current skills ship
            // SKILL.md only) — they embed outdated tool names; remove so agents
            // stop receiving stale instructions after upgrade.
            rmSync(destHooks, { recursive: true, force: true });
          }
          results.push(`Skill ${name} installed (Copilot)`);
        }
      }

      // OpenCode skills (SKILL.md only, no hooks)
      try { await configManager.setupOpenCodeSkills(TEMPLATES_PATH); results.push('OpenCode skills installed'); } catch { /* optional */ }

      // OpenCode plugins
      try { await configManager.setupOpenCodePlugins(TEMPLATES_PATH); results.push('OpenCode plugins installed'); } catch { /* optional */ }

      return { success: true, results };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post('/api/setup/complete', async () => {
    try {
      if (sdkReady) {
        await sdk.close();
        sdkReady = false;
      }
      const ok = await tryInitSDK();
      if (ok) {
        saveDeployedVersion();
        await seedSystemKnowledge();
      }
      return { success: ok, sdkReady };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : String(error) };
    }
  });

  // ─── Upgrade endpoints ────────────────────────────────────────

  app.get('/api/upgrade/check', async () => {
    const deployed = getDeployedVersion();
    const current = APP_VERSION;
    const needsUpgrade = deployed !== null && compareSemver(current, deployed) > 0;
    return {
      needsUpgrade,
      fromVersion: deployed,
      toVersion: current,
      isFirstInstall: deployed === null,
    };
  });

  /** Guards every path that writes deployed artifacts, so the startup self-heal,
   *  /api/upgrade/run and /api/redeploy can never interleave on the same files. */
  let upgradeRunning = false;
  /** Resolves when the in-flight deploy finishes; lets callers wait instead of 409. */
  let inFlightDeploy: Promise<unknown> | null = null;
  /** Live view of the running upgrade, polled by the upgrade screen. */
  const upgradeProgress = createUpgradeProgress(APP_VERSION);
  app.get('/api/upgrade/progress', async () => upgradeProgress.snapshot());

  app.post('/api/upgrade/run', async (request, reply) => {
    // The UI auto-POSTs this on window load, which can land while the startup
    // self-heal is still running. Wait it out rather than 409-ing, which the
    // client would surface as a failed upgrade.
    if (inFlightDeploy) { await inFlightDeploy.catch(() => {}); }
    if (upgradeRunning) { return sendError(reply, 409, 'Upgrade already in progress'); }
    // Whatever we were waiting for may have been the very upgrade this request
    // wanted. Without this check the flags are already cleared by the time we
    // get here, so a second window (or a StrictMode remount) would run the whole
    // thing again — re-embed probe, npx cache wipe and all.
    if (VERSION_RESOLVED && getDeployedVersion() === APP_VERSION) {
      const last = upgradeProgress.lastRun();
      if (last === null) {
        // Nothing ran this boot: already current. Say so explicitly rather than
        // returning an empty list, which reads as a completed upgrade with no steps.
        return { success: true, noop: true, fromVersion: getDeployedVersion(), toVersion: APP_VERSION, results: [] as DeployStep[] };
      }
      if (deployWentWell(last.steps)) {
        // `last.fromVersion` is the version that run started from — re-reading
        // the marker here would report `fromVersion === toVersion`, since the
        // run itself overwrote it.
        return { success: true, fromVersion: last.fromVersion, toVersion: APP_VERSION, results: last.steps };
      }
      // A degraded run is NOT replayable (see deployWentWell): the upgrade
      // screen's Retry button would be permanently dead for the rest of the
      // boot. Fall through and genuinely run it again, which is what Retry means.
    }
    upgradeRunning = true;
    // Captured before Step 5 overwrites the marker.
    const fromVersion = getDeployedVersion();
    // Only now that this request owns the upgrade: a reset before the guard
    // above would wipe a live run's steps out from under a polling client.
    upgradeProgress.begin(fromVersion);
    /** The single append path for this run's results — the store owns the list,
     *  and the response is read back from it at the end. `redeployArtifacts`
     *  feeds the same function through its `onStep` callback, so there is no
     *  second list to keep in sync. */
    const record = (step: DeployStep) => upgradeProgress.record(step);
    const run = (async () => {

      // Step 1: Database migrations (handled automatically by createDbClient, but log it)
      upgradeProgress.setStep('database');
      try {
        if (sdkReady) { await sdk.close(); sdkReady = false; }
        const ok = await tryInitSDK();
        record({ step: 'database', status: ok ? 'success' : 'error', message: ok ? 'Schema up to date' : 'SDK init failed' });
        if (ok) await seedSystemKnowledge();
      } catch (e: any) {
        record({ step: 'database', status: 'error', message: e.message });
      }

      // Step 1b: Re-embed if embedding dimensions changed (e.g. all-minilm 384d → nomic-embed-text 768d)
      try {
        if (sdkReady) {
          const expectedDims = Number(process.env.EMBEDDING_DIMENSIONS) || 256;
          const needsReembed = await (async () => {
            try {
              // Check if vec table has wrong dimensions by trying a dummy query
              const sqliteRaw = getRawSqlite();
              if (!sqliteRaw) return false;
              const row = sqliteRaw.prepare('SELECT embedding FROM knowledge_embeddings LIMIT 1').get() as { embedding: Buffer } | undefined;
              if (!row) return false; // No entries yet, nothing to re-embed
              const currentDims = row.embedding.byteLength / 4; // float32 = 4 bytes
              return currentDims !== expectedDims;
            } catch { return false; }
          })();

          if (needsReembed) {
            upgradeProgress.setStep('reembed');
            console.log(`[CogniStore] Upgrade: embedding dimension mismatch detected, re-embedding all entries...`);

            // 1. Pull new model first
            const model = process.env.OLLAMA_MODEL || 'nomic-embed-text';
            const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
            try {
              const tagsRes = await fetch(`${host}/api/tags`);
              let modelAvailable = false;
              if (tagsRes.ok) {
                const data = (await tagsRes.json()) as { models: { name: string }[] };
                modelAvailable = data.models.some(m => m.name === model || m.name.startsWith(`${model}:`));
              }
              if (!modelAvailable) {
                console.log(`[CogniStore] Pulling model ${model}...`);
                const pullRes = await fetch(`${host}/api/pull`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ name: model }),
                });
                if (pullRes.ok) {
                  const reader = pullRes.body?.getReader();
                  if (reader) { while (!(await reader.read()).done) {} }
                }
              }
            } catch (e) {
              console.warn('[CogniStore] Model pull failed during upgrade:', e);
            }

            // Pre-flight: only drop the vec tables if Ollama can actually produce
            // an embedding NOW. Dropping first and re-embedding second means a
            // failed re-embed (Ollama down) would leave the DB with NO embeddings
            // and degraded search until a later upgrade. The dimension mismatch is
            // harmless — search keeps working with the existing embeddings — so if
            // the probe fails we keep them and retry on the next upgrade.
            let canEmbed = false;
            try {
              const probe = await fetch(`${host}/api/embeddings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, prompt: 'probe' }),
                signal: AbortSignal.timeout(15000),
              });
              if (probe.ok) {
                const pj = (await probe.json()) as { embedding?: number[] };
                canEmbed = Array.isArray(pj.embedding) && pj.embedding.length > 0;
              }
            } catch { canEmbed = false; }

            if (!canEmbed) {
              record({ step: 'reembed', status: 'skipped', message: 'Ollama unavailable — kept existing embeddings, will re-embed on next upgrade' });
              console.warn('[CogniStore] Upgrade: skipping re-embed (Ollama cannot embed); existing embeddings preserved');
            } else {
              // 2. Drop old vec tables and re-init SDK (recreates with new dimensions)
              try {
                const sqliteRaw = getRawSqlite();
                if (sqliteRaw) {
                  sqliteRaw.exec('DROP TABLE IF EXISTS knowledge_embeddings');
                  sqliteRaw.exec('DROP TABLE IF EXISTS plans_embeddings');
                }
              } catch (e) { console.warn('[CogniStore] Drop vec tables failed:', e); }

              await sdk.close();
              sdkReady = false;
              const reinitOk = await tryInitSDK();

              // 3. Re-embed all knowledge entries
              if (reinitOk) {
                try {
                  const reembedded = await sdk.reembedAll();
                  record({ step: 'reembed', status: 'success', message: `Re-embedded ${reembedded} entries with new model` });
                  console.log(`[CogniStore] Re-embedded ${reembedded} entries`);
                } catch (e: any) {
                  record({ step: 'reembed', status: 'error', message: e.message });
                }
              } else {
                record({ step: 'reembed', status: 'error', message: 'SDK re-init failed after dropping vec tables' });
              }
            }
          }
        }
      } catch (e: any) {
        record({ step: 'reembed', status: 'error', message: e.message });
      }

      // Step 1c: Embedding integrity check — detect entries without embeddings
      try {
        if (sdkReady) {
          const sqliteRaw = getRawSqlite();
          if (sqliteRaw) {
            const entryCount = (sqliteRaw.prepare('SELECT COUNT(*) as c FROM knowledge_entries').get() as { c: number }).c;
            const embeddingCount = (sqliteRaw.prepare('SELECT COUNT(*) as c FROM knowledge_embeddings_rowids').get() as { c: number }).c;

            if (entryCount > 0 && embeddingCount < entryCount) {
              upgradeProgress.setStep('integrity');
              console.log(`[CogniStore] Upgrade: embedding integrity mismatch — ${entryCount} entries but only ${embeddingCount} embeddings. Resyncing...`);

              try {
                sqliteRaw.exec('DROP TABLE IF EXISTS knowledge_embeddings');
                sqliteRaw.exec('DROP TABLE IF EXISTS plans_embeddings');
              } catch (e) { console.warn('[CogniStore] Drop vec tables failed:', e); }

              await sdk.close();
              sdkReady = false;
              const reinitOk = await tryInitSDK();

              if (reinitOk) {
                try {
                  const reembedded = await sdk.reembedAll();
                  record({ step: 'integrity', status: 'success', message: `Re-embedded ${reembedded} entries (${entryCount - embeddingCount} were missing)` });
                } catch (e: any) {
                  record({ step: 'integrity', status: 'error', message: e.message });
                }
              } else {
                record({ step: 'integrity', status: 'error', message: 'SDK re-init failed after integrity resync' });
              }
            }
          }
        }
      } catch (e: any) {
        record({ step: 'integrity', status: 'error', message: e.message });
      }

      // Steps 2-4b: re-deploy every on-disk artifact (shared with /api/redeploy).
      // Its steps are recorded through `onStep` as they complete — the returned
      // array is the same list and is deliberately discarded here, so this run
      // has exactly one append path. There is no single phase name to show while
      // it runs.
      upgradeProgress.setStep(null);
      await redeployArtifacts({ clearNpxCache: true, onStep: record });

      // Step 5: Save new version. saveDeployedVersion() refuses to record a
      // version when any step above errored, so a partial upgrade re-runs.
      upgradeProgress.setStep('version');
      try {
        const wrote = saveDeployedVersion(upgradeProgress.steps());
        record({
          step: 'version',
          status: wrote ? 'success' : 'skipped',
          message: wrote ? `v${APP_VERSION}` : 'Not recorded (unknown version or a step failed)',
        });
      } catch (e: any) {
        record({ step: 'version', status: 'error', message: e.message });
      }
    })();

    inFlightDeploy = run;
    try {
      await run;
    } finally {
      upgradeRunning = false;
      inFlightDeploy = null;
      upgradeProgress.finish();
    }

    // Read the results back from the single list that collected them.
    const completed = upgradeProgress.lastRun();
    const results = completed?.steps ?? [];
    return { success: deployWentWell(results), fromVersion, toVersion: APP_VERSION, results };
  });

  // ─── Re-deploy configurations (no migration, no version bump) ──

  app.post('/api/redeploy', async (_request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    if (upgradeRunning) return sendError(reply, 409, 'A deploy is already in progress');

    upgradeRunning = true;
    let results: DeployStep[];
    try {
      results = await redeployArtifacts();
    } finally {
      upgradeRunning = false;
    }

    const allSuccess = deployWentWell(results);
    return { success: allSuccess, results };
  });

  // ─── Uninstall endpoint ────────────────────────────────────────

  app.post('/api/uninstall', async (_request, reply) => {
    const step = async (label: string, fn: () => unknown, results: string[], errors: string[]) => {
      try { await fn(); results.push(label); }
      catch (e) { errors.push(`${label}: ${e}`); }
    };

    try {
      const results: string[] = [];
      const errors: string[] = [];
      const home = homedir();

      // 1. Remove config markers
      await step('CLAUDE.md cleaned', () => configManager.removeConfig(ConfigManager.CLAUDE_MD), results, errors);
      await step('Copilot config cleaned', () => configManager.removeConfig(ConfigManager.COPILOT_MD), results, errors);
      await step('Copilot CLI cleaned', () => configManager.removeConfig(ConfigManager.COPILOT_INSTRUCTIONS), results, errors);
      await step('OpenCode AGENTS.md cleaned', () => configManager.removeConfig(ConfigManager.OPENCODE_AGENTS_MD), results, errors);

      // 2. Remove MCP entries
      await step('MCP config cleaned', () => configManager.removeMcpEntry(ConfigManager.MCP_CONFIG, 'cognistore'), results, errors);
      await step('Claude JSON cleaned', () => configManager.removeMcpEntry(ConfigManager.CLAUDE_JSON, 'cognistore'), results, errors);
      await step('Copilot MCP cleaned', () => configManager.removeMcpEntry(ConfigManager.COPILOT_MCP_CONFIG, 'cognistore'), results, errors);
      await step('OpenCode MCP cleaned', () => configManager.removeOpenCodeMcp(), results, errors);
      await step('Claude permissions cleaned', () => configManager.removePermissions(ConfigManager.CLAUDE_SETTINGS, ConfigManager.COGNISTORE_AUTO_ALLOW_TOOLS), results, errors);
      await step('Claude hooks cleaned', () => configManager.removeHooks(ConfigManager.CLAUDE_SETTINGS), results, errors);
      await step('Copilot hooks cleaned', () => configManager.removeCopilotHooks(), results, errors);

      // 3. Remove skills
      for (const name of ['cognistore-query', 'cognistore-capture', 'cognistore-plan']) {
        const claudeDir = resolve(home, '.claude', 'skills', name);
        if (existsSync(claudeDir)) { rmSync(claudeDir, { recursive: true, force: true }); results.push(`Skill ${name} removed (Claude)`); }
        // Remove new directory format
        const copilotDir = resolve(home, '.copilot', 'skills', name);
        if (existsSync(copilotDir)) { rmSync(copilotDir, { recursive: true, force: true }); results.push(`Skill ${name} removed (Copilot)`); }
        // Clean up old flat file format (pre-0.9.2)
        const copilotFile = resolve(home, '.copilot', 'skills', `${name}.md`);
        if (existsSync(copilotFile)) { unlinkSync(copilotFile); }
      }
      // Remove OpenCode skills + plugins
      configManager.removeOpenCodeSkills(); results.push('OpenCode skills removed');
      configManager.removeOpenCodePlugins(); results.push('OpenCode plugins removed');

      // 4. Remove the Ollama models this app pulled: the embedding model, and
      //    the merge model if a consolidation preview ever downloaded it.
      //
      //    execFileSync with an argument array, never a shell string: the
      //    cleanup model name comes from settings.json, which the user can edit
      //    and PUT /api/settings can write. The name is re-validated here too,
      //    because reading it and trusting it are different things.
      //
      //    Settings are read BEFORE the ~/.cognistore removal below, or the file
      //    would already be gone by the time we needed the model name.
      const cleanupModel = (() => {
        try {
          const configured = readSettings().cleanupLlmModel;
          return isValidOllamaModelName(configured) ? configured : DEFAULT_CLEANUP_MODEL;
        } catch { return DEFAULT_CLEANUP_MODEL; }
      })();
      const embeddingModel = process.env.OLLAMA_MODEL || 'nomic-embed-text';
      if (isValidOllamaModelName(embeddingModel)) {
        // Setup always pulls this one, so a failure here is worth reporting.
        await step(`Ollama model removed (${embeddingModel})`, () => {
          execFileSync('ollama', ['rm', embeddingModel], { stdio: 'pipe', timeout: 30000 });
        }, results, errors);
      }
      // The merge model is pulled lazily, on the first consolidation preview, so
      // most uninstalls never had it. `ollama rm` on a model that was never
      // pulled is the normal case, not an error — reporting it would tell the
      // user their uninstall partly failed when nothing did.
      if (isValidOllamaModelName(cleanupModel) && cleanupModel !== embeddingModel) {
        try {
          execFileSync('ollama', ['rm', cleanupModel], { stdio: 'pipe', timeout: 30000 });
          results.push(`Ollama model removed (${cleanupModel})`);
        } catch { /* never pulled, or Ollama already gone */ }
      }

      // 5. Uninstall Ollama
      try { execSync('pkill -f "ollama serve"', { stdio: 'pipe' }); } catch { /* may not be running */ }

      const ollamaBinDir = resolve(home, '.ollama-bin');
      const ollamaDataDir = resolve(home, '.ollama');

      if (process.platform === 'darwin') {
        try { execSync('brew list ollama', { stdio: 'pipe' }); execSync('brew uninstall ollama', { stdio: 'pipe', timeout: 60000 }); results.push('Ollama uninstalled (brew)'); } catch { /* not brew */ }
        for (const p of ['/usr/local/bin/ollama', '/opt/homebrew/bin/ollama', ollamaDataDir, ollamaBinDir]) {
          if (existsSync(p)) { rmSync(p, { recursive: true, force: true }); }
        }
        results.push('Ollama paths cleaned');
      } else if (process.platform === 'linux') {
        try { execSync('systemctl stop ollama', { stdio: 'pipe', timeout: 10000 }); } catch { /* ignore */ }
        try { execSync('systemctl disable ollama', { stdio: 'pipe', timeout: 10000 }); } catch { /* ignore */ }
        for (const p of ['/usr/local/bin/ollama', '/usr/bin/ollama', ollamaDataDir, ollamaBinDir]) {
          if (existsSync(p)) { rmSync(p, { recursive: true, force: true }); }
        }
        results.push('Ollama removed');
      }

      // 6. Clear npx cache for @cognistore/mcp-server
      await step('npx cache cleaned', () => clearNpxMcpCache(), results, errors);

      // 7. Close SDK and remove database
      if (sdkReady) { await sdk.close(); sdkReady = false; }
      if (existsSync(INSTALL_DIR)) { rmSync(INSTALL_DIR, { recursive: true, force: true }); results.push('Install dir removed'); }

      // 8. Clean backup files
      const backupTargets = [
        { dir: resolve(home, '.claude'), prefix: 'CLAUDE.md.bak.' },
        { dir: resolve(home, '.claude'), prefix: 'mcp-config.json.bak.' },
        { dir: resolve(home, '.claude'), prefix: 'settings.json.bak.' },
        { dir: home, prefix: '.claude.json.bak.' },
        { dir: resolve(home, '.github'), prefix: 'copilot-instructions.md.bak.' },
        { dir: resolve(home, '.copilot'), prefix: 'copilot-instructions.md.bak.' },
        { dir: resolve(home, '.copilot'), prefix: 'mcp-config.json.bak.' },
        { dir: resolve(home, '.copilot', 'hooks'), prefix: 'hooks.json.bak.' },
      ];
      for (const target of backupTargets) {
        try {
          if (!existsSync(target.dir)) continue;
          for (const file of readdirSync(target.dir)) {
            if (file.startsWith(target.prefix)) { unlinkSync(resolve(target.dir, file)); }
          }
        } catch { /* skip */ }
      }
      results.push('Backup files cleaned');

      // 9. Self-delete app (increased timeout for response flush)
      reply.send({ success: true, results, errors: errors.length > 0 ? errors : undefined });

      setTimeout(() => {
        if (process.platform === 'darwin') {
          // Use shell command for reliable self-delete on macOS
          const appPaths = ['/Applications/CogniStore.app', resolve(home, 'Applications', 'CogniStore.app')];
          for (const p of appPaths) {
            if (existsSync(p)) {
              try { execSync(`rm -rf "${p}"`, { stdio: 'pipe' }); } catch { /* best effort */ }
            }
          }
        }
        if (process.platform === 'linux') {
          const linuxPaths = [resolve(home, '.local', 'bin', 'cognistore-dashboard')];
          for (const p of linuxPaths) {
            if (existsSync(p)) { rmSync(p, { force: true }); }
          }
        }
        process.exit(0);
      }, 3000);
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : String(error) };
    }
  });

  // ─── Database maintenance ─────────────────────────────────────

  app.post('/api/maintenance/cleanup', async (_request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    try {
      const result = await sdk.cleanupDatabase();
      const dbPath = resolve(INSTALL_DIR, 'knowledge.db');
      const sizeBytes = statSync(dbPath).size;
      return {
        success: true,
        ...result,
        sizeAfter: sizeBytes < 1024 * 1024
          ? `${(sizeBytes / 1024).toFixed(1)} KB`
          : `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`,
      };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : String(error) };
    }
  });

  // ─── Health ────────────────────────────────────────────────────

  const SIDECAR_TOKEN = process.env.SIDECAR_TOKEN || '';

  app.get('/api/health', async () => {
    const health = sdkReady
      ? await sdk.healthCheck()
      : {
          database: { connected: false, error: sdkError || 'Not initialized' },
          ollama: { connected: false, model: null, error: sdkError || 'Not initialized' },
        };
    return { ...health, token: SIDECAR_TOKEN };
  });

  // ─── Knowledge CRUD ────────────────────────────────────────────

  app.get('/api/stats', async (_request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    return sdk.getStats();
  });

  app.get('/api/metrics', async (_request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;

    try {
    const dbPath = resolve(INSTALL_DIR, 'knowledge.db');
    let dbSizeBytes = 0;
    try { dbSizeBytes += statSync(dbPath).size; } catch { /* ignore */ }
    // SQLite in WAL mode writes new pages to knowledge.db-wal until a checkpoint
    // flushes them into knowledge.db. Include sidecars so the reported size
    // reflects real on-disk usage and updates between checkpoints.
    try { dbSizeBytes += statSync(dbPath + '-wal').size; } catch { /* ignore */ }
    try { dbSizeBytes += statSync(dbPath + '-shm').size; } catch { /* ignore */ }

    const stats = await sdk.getStats();

    // Query recent entries for activity data
    const recent = await sdk.listRecent(1000);
    const now = new Date();
    const last24h = recent.filter((e: any) => {
      const created = new Date(e.createdAt);
      return (now.getTime() - created.getTime()) < 24 * 60 * 60 * 1000;
    }).length;
    const last7d = recent.filter((e: any) => {
      const created = new Date(e.createdAt);
      return (now.getTime() - created.getTime()) < 7 * 24 * 60 * 60 * 1000;
    }).length;
    const last30d = recent.filter((e: any) => {
      const created = new Date(e.createdAt);
      return (now.getTime() - created.getTime()) < 30 * 24 * 60 * 60 * 1000;
    }).length;

    // Activity by day (last 15 days) for area chart
    const activityByDay: { date: string; count: number }[] = [];
    for (let i = 14; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const count = recent.filter((e: any) => {
        const created = new Date(e.createdAt).toISOString().split('T')[0];
        return created === dateStr;
      }).length;
      activityByDay.push({ date: dateStr, count });
    }

    // Type distribution for pie chart
    const typeDistribution = stats.byType.map((t: any) => ({
      name: t.type.charAt(0).toUpperCase() + t.type.slice(1),
      value: t.count,
    }));

    // Operation counters (reads/writes last hour + last day)
    let operations = { readsLastHour: 0, readsLastDay: 0, writesLastHour: 0, writesLastDay: 0 };
    try { operations = sdk.getOperationCounts(); } catch { /* silent */ }

    // Operations by day (reads/writes per day for chart)
    let operationsByDay: { date: string; reads: number; writes: number }[] = [];
    try { operationsByDay = sdk.getOperationsByDay(15); } catch { /* silent */ }

    return {
      database: {
        sizeBytes: dbSizeBytes,
        sizeFormatted: dbSizeBytes < 1024 * 1024
          ? `${(dbSizeBytes / 1024).toFixed(1)} KB`
          : `${(dbSizeBytes / (1024 * 1024)).toFixed(1)} MB`,
        path: dbPath,
      },
      activity: {
        last24h,
        last7d,
        last30d,
        total: stats.total,
      },
      activityByDay,
      operationsByDay,
      typeDistribution,
      operations,
    };
    } catch (error) {
      reply.code(500);
      return { error: 'Failed to load metrics', message: error instanceof Error ? error.message : String(error) };
    }
  });

  // ─── Ranged metrics (driven by the global date-range picker) ────

  /** Days inclusive between two ISO dates — clamped to 1..730 (the '2y' preset).
   *  Keep <= OPERATIONS_RETENTION_DAYS (800) in packages/core knowledge.repository.ts. */
  const daysBetween = (fromISO: string, toISO: string): number => {
    const from = new Date(fromISO).getTime();
    const to = new Date(toISO).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 7;
    const diffDays = Math.floor((to - from) / (24 * 60 * 60 * 1000)) + 1;
    return Math.max(1, Math.min(730, diffDays));
  };

  /** Build a contiguous day series of zeros for the requested range. */
  const buildDateSeries = (fromISO: string, toISO: string): string[] => {
    const out: string[] = [];
    const start = new Date(fromISO);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(toISO);
    end.setUTCHours(0, 0, 0, 0);
    for (let d = start; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      out.push(d.toISOString().split('T')[0]);
    }
    return out;
  };

  app.get<{ Querystring: { from?: string; to?: string } }>('/api/metrics/activity', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const { from, to } = request.query;
    if (!from || !to) { return sendError(reply, 400, 'from and to are required (ISO date)'); }
    const days = daysBetween(from, to);
    const rows = sdk.getOperationsByDay(days);
    // Filter to the exact requested range — getOperationsByDay returns the
    // last N days from "now", which is close enough for the common case
    // (presets) and gets re-trimmed here for custom ranges.
    const set = new Set(buildDateSeries(from, to));
    const operationsByDay = rows.filter((r) => set.has(r.date));
    return { operationsByDay };
  });

  // ─── Token usage ────────────────────────────────────────────────

  app.get<{ Querystring: { from?: string; to?: string; source?: string; model?: string; project?: string } }>(
    '/api/token-usage',
    async (request, reply) => {
      const err = ensureReady(reply);
      if (err) return err;
      const { from, to, source, model, project } = request.query;
      if (!from || !to) { return sendError(reply, 400, 'from and to are required (ISO date)'); }
      return sdk.getTokenUsage({ from, to, source, model, project });
    },
  );

  app.post('/api/token-usage/scan', async (_request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    try {
      const result = await sdk.scanTokenUsage();
      return { success: true, ...result };
    } catch (e: any) {
      reply.code(500);
      return { success: false, error: e?.message ?? String(e) };
    }
  });

  app.get('/api/tags', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const q = request.query as any;
    const opts = q.from && q.to ? { from: String(q.from), to: String(q.to) } : {};
    return sdk.listTags(opts);
  });

  // ─── Tag intelligence ────────────────────────────────────────────
  app.get('/api/tags/suggestions', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const q = request.query as any;
    const threshold = q.threshold ? Number(q.threshold) : 0.82;
    return sdk.suggestTagMerges(threshold);
  });

  app.post<{ Body: { from?: string; to?: string } }>('/api/tags/merge', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const { from, to } = request.body ?? {};
    if (!from || !to || !String(from).trim() || !String(to).trim()) {
      reply.code(400);
      return { error: 'from and to are required' };
    }
    return sdk.mergeTags(String(from), String(to));
  });

  app.post('/api/tags/merge-batch', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const parsed = mergeTagsBatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.issues[0]?.message ?? 'Invalid batch' };
    }
    try {
      return await sdk.mergeTagsBatch(parsed.data.merges);
    } catch (error) {
      // CONFLICT = user-resolvable selection problem (duplicate-from / cycle).
      if (error instanceof Error && error.message.startsWith('CONFLICT:')) {
        reply.code(400);
        return { error: error.message };
      }
      throw error;
    }
  });

  // ─── Knowledge health (stale + duplicates) ───────────────────────
  app.get('/api/health/stale', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const q = request.query as any;
    const opts: { days?: number; minConfidence?: number; limit?: number } = {};
    if (q.days) opts.days = Number(q.days);
    if (q.minConfidence) opts.minConfidence = Number(q.minConfidence);
    if (q.limit) opts.limit = Number(q.limit);
    return sdk.findStaleEntries(opts);
  });

  // Returns duplicate GROUPS (connected components), not raw pairs — N copies of
  // an entry render as one group. Single consumer: the Settings health panel.
  app.get('/api/health/duplicates', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const q = request.query as any;
    const opts: { threshold?: number; limit?: number } = {};
    if (q.threshold) opts.threshold = Number(q.threshold);
    if (q.limit) opts.limit = Number(q.limit);
    return sdk.findDuplicateGroups(opts);
  });

  app.get('/api/knowledge/recent', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const q = request.query as any;
    const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 200);
    const offset = Math.max(Number(q.offset) || 0, 0);
    const filters: { type?: string; scope?: string; tags?: string[]; agent?: string; platform?: string } = {};
    if (q.type) filters.type = String(q.type);
    if (q.scope) filters.scope = String(q.scope);
    if (q.agent) filters.agent = String(q.agent).slice(0, 64);
    if (q.platform) filters.platform = String(q.platform).slice(0, 64);
    if (q.tags) {
      const tags = String(q.tags).split(',').map((t) => t.trim()).filter(Boolean).slice(0, 20);
      if (tags.length) filters.tags = tags;
    }
    return sdk.listRecent(limit, filters, offset);
  });

  app.get('/api/metrics/top-tags', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const q = request.query as any;
    const limit = Number(q.limit) || 10;
    const opts = q.from && q.to ? { from: String(q.from), to: String(q.to) } : {};
    return sdk.getTopTags(limit, opts);
  });

  app.get('/api/metrics/by-type', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const q = request.query as any;
    const opts = q.from && q.to ? { from: String(q.from), to: String(q.to) } : {};
    return sdk.countByType(opts);
  });

  app.get('/api/metrics/by-scope', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const q = request.query as any;
    const opts = q.from && q.to ? { from: String(q.from), to: String(q.to) } : {};
    return sdk.countByScope(opts);
  });

  app.get('/api/metrics/by-agent', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const q = request.query as any;
    const opts = q.from && q.to ? { from: String(q.from), to: String(q.to) } : {};
    return sdk.countByAgent(opts);
  });

  app.get('/api/metrics/by-platform', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const q = request.query as any;
    const opts = q.from && q.to ? { from: String(q.from), to: String(q.to) } : {};
    return sdk.countByPlatform(opts);
  });

  app.post<{ Body: Record<string, unknown> }>('/api/knowledge/search', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const body = request.body as any;
    const { query, includeExternal, providers, ...options } = body;
    if (!query || typeof query !== 'string') {
      throw new Error('Query is required and must be a string');
    }
    // `providers: []` means "no specific filter" not "enable external search" —
    // only treat a non-empty array as an explicit external-search request.
    const providerFilter = Array.isArray(providers) && providers.length > 0 ? providers : undefined;
    const wantExternal = includeExternal === true || providerFilter != null || readSettings().alwaysSearchExternalProviders;
    // An explicit user search is real usage, so it feeds the cleanup cycle's
    // retention signal. Forced server-side rather than read from the body: the
    // client must not be able to suppress (or forge) read tracking. Browsing
    // routes (/api/knowledge/recent, /api/knowledge/:id) deliberately do not.
    const searchOptions = { ...(options as Partial<SearchOptions>), trackRead: true };
    return wantExternal
      ? sdk.getKnowledgeFederated(query, searchOptions, { providers: providerFilter })
      : sdk.getKnowledge(query, searchOptions);
  });

  app.get<{ Params: { id: string } }>('/api/knowledge/:id', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const entry = await sdk.getKnowledgeById(request.params.id);
    if (!entry) { return sendError(reply, 404, 'Not found'); }
    return entry;
  });

  app.post<{ Body: CreateKnowledgeInput }>('/api/knowledge', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    return sdk.addKnowledge(request.body);
  });

  app.put<{ Params: { id: string }; Body: UpdateKnowledgeInput }>('/api/knowledge/:id', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const result = await sdk.updateKnowledge(request.params.id, request.body);
    if (!result) { return sendError(reply, 404, 'Not found'); }
    return result;
  });

  app.delete<{ Params: { id: string } }>('/api/knowledge/:id', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const deleted = await sdk.deleteKnowledge(request.params.id);
    return { deleted };
  });

  // ─── Scopes endpoint ─────────────────────────────────────────

  app.get('/api/scopes', async (_request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    return sdk.listScopes();
  });

  // ─── Bulk delete endpoint ──────────────────────────────────

  app.delete<{ Body: { ids: string[] } }>('/api/knowledge/bulk', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const { ids } = request.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      reply.code(400);
      return { error: 'ids array is required' };
    }
    return sdk.bulkDeleteKnowledge(ids);
  });

  // ─── Export endpoint ──────────────────────────────────────

  app.get('/api/export', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const includeParam = ((request.query as any).include || 'knowledge,plans') as string;
    const include = includeParam.split(',').map(s => s.trim());

    const exportData: Record<string, unknown> = {
      version: APP_VERSION,
      exportedAt: new Date().toISOString(),
    };

    if (include.includes('knowledge')) {
      const entries = await sdk.listAllKnowledge();
      exportData.knowledge = entries.map(e => ({
        title: e.title, content: e.content, tags: e.tags, type: e.type,
        scope: e.scope, source: e.source, confidenceScore: e.confidenceScore,
        agentId: e.agentId,
        createdAt: e.createdAt instanceof Date ? e.createdAt.toISOString() : e.createdAt,
        updatedAt: e.updatedAt instanceof Date ? e.updatedAt.toISOString() : e.updatedAt,
      }));
    }

    if (include.includes('plans')) {
      const plans = sdk.listAllPlans();
      exportData.plans = plans.map(p => {
        const tasks = sdk.listPlanTasks(p.id);
        return {
          title: p.title, content: p.content, tags: p.tags, scope: p.scope,
          source: p.source, status: p.status,
          createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : p.createdAt,
          tasks: tasks.map(t => ({
            description: t.description, status: t.status, priority: t.priority,
            notes: t.notes, position: t.position,
          })),
        };
      });
    }

    reply.header('Content-Disposition', 'attachment; filename="cognistore-export.json"');
    return exportData;
  });

  // ─── Import endpoint ──────────────────────────────────────

  app.post('/api/import', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const parsed = importSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.issues[0]?.message ?? 'Invalid import payload' };
    }
    try {
      const body = parsed.data;
      const include = body.include;
      const result: Record<string, unknown> = {};

      if (include.includes('knowledge') && body.knowledge) {
        // Second guard (the schema already bounds/strips): never import a
        // privileged system entry — rewrite it to a normal pattern entry.
        const sanitized = body.knowledge.map((e) => e.type === 'system' ? { ...e, type: 'pattern' } : e);
        result.knowledge = await sdk.importKnowledge(sanitized as any);
      }

      if (include.includes('plans') && body.plans) {
        result.plans = await sdk.importPlans(body.plans);
      }

      if (Object.keys(result).length === 0) {
        reply.code(400);
        return { error: 'Request must include at least one data type (knowledge or plans) with matching array' };
      }

      return result;
    } catch (error) {
      reply.code(500);
      return { error: (error as Error).message };
    }
  });

  // ─── Plans endpoints ─────────────────────────────────────────

  app.get('/api/plans', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const q = request.query as any;
    const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 200);
    const offset = Math.max(Number(q.offset) || 0, 0);
    // `status` accepts a comma-separated list (the Plans page sends the set of
    // selected chips; empty selection omits the param entirely = no filter).
    // A single `?status=active` keeps behaving exactly as before.
    const statuses = String(q.status ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
    const unknown = statuses.filter((s: string) => !isPlanStatus(s));
    if (unknown.length) {
      // The offending values are echoed so the caller can see WHICH one is wrong,
      // but bounded: they are raw query input and the message must not become a
      // way to make the server render an arbitrarily large string back.
      const shown = unknown.slice(0, 3).map((s: string) => (s.length > 32 ? `${s.slice(0, 32)}…` : s));
      return sendError(reply, 400, `Unknown plan status: ${shown.join(', ')}${unknown.length > 3 ? ', …' : ''}`);
    }
    const scope = q.scope || undefined;
    const plans = sdk.listPlans(limit, statuses.length ? statuses : undefined, scope, offset);
    return plans.map((plan: any) => {
      const tasks = sdk.listPlanTasks(plan.id);
      return {
        ...plan,
        taskCount: tasks.length,
        completedTasks: tasks.filter((t: any) => t.status === 'completed').length,
        tasks: tasks.map((t: any) => ({ id: t.id, description: t.description, status: t.status })),
      };
    });
  });

  // This route destructures an explicit field list, so a new CreatePlanInput field
  // reaches the SDK only if it is added here too — the shared zod schema alone
  // changes nothing on this path.
  app.post<{ Body: { title: string; content: string; tags?: string[]; scope?: string; source?: string; planFilePath?: string | null; parentPlanId?: string | null; tasks?: { description: string; priority?: string }[] } }>('/api/plans', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    try {
      const { title, content, tags = [], scope = 'global', source = 'dashboard', planFilePath, parentPlanId, tasks = [] } = request.body;
      const plan = await sdk.createPlan({ title, content, tags, scope, source, planFilePath, parentPlanId, tasks });
      reply.code(201);
      return plan;
    } catch (error) {
      reply.code(400);
      return { error: (error as Error).message };
    }
  });

  app.get<{ Params: { id: string } }>('/api/plans/:id', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const result = sdk.getPlanById(request.params.id);
    if (!result) { return sendError(reply, 404, 'Not found'); }
    return result;
  });

  // ── Plan file: preview + open in OS default editor ───────────────
  // Both endpoints operate ONLY on the plan's DB-stored path (never a client path),
  // confined to an allow-list root, and reject foreign origins (defense-in-depth on
  // top of the localhost-only CORS — CORS gates response reads, not execution).
  const PLAN_FILE_MAX_BYTES = 256 * 1024;
  const ALLOWED_PLAN_FILE_ROOTS = [
    resolve(homedir(), '.claude', 'plans'),
    resolve(homedir(), '.cognistore'),
    // Copilot CLI writes plan files under its session dir
    // (~/.copilot/session-state/<sid>/files/<name>.md or .../plan.md).
    resolve(homedir(), '.copilot', 'session-state'),
  ];
  const isUnderAllowedRoot = (abs: string) =>
    ALLOWED_PLAN_FILE_ROOTS.some((root) => abs === root || abs.startsWith(root + sep));
  /** Resolve the plan's stored path under an allow-list root. 'none' = no path stored. */
  const resolvePlanFilePath = (raw: string | null | undefined): { path: string } | { error: 'none' | 'disallowed' } => {
    if (!raw) return { error: 'none' };
    const abs = resolve(raw);
    if (!isUnderAllowedRoot(abs)) return { error: 'disallowed' };
    // If it exists, also resolve symlinks and re-check (block symlink escape).
    try { if (existsSync(abs) && !isUnderAllowedRoot(realpathSync(abs))) return { error: 'disallowed' }; } catch { /* ignore */ }
    return { path: abs };
  };
  const rejectForeignOrigin = (request: any, reply: any): boolean => {
    const origin = request.headers?.origin;
    if (!origin) return false; // same-origin / non-browser
    try {
      const { hostname, protocol } = new URL(origin);
      if (protocol === 'tauri:' || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') return false;
    } catch { /* fallthrough */ }
    reply.code(403); return true;
  };

  // Registered here rather than beside the other health routes: these handlers
  // need rejectForeignOrigin, which is declared just above.
  registerCleanupRoutes(app, {
    sdk,
    ensureReady,
    rejectForeignOrigin,
    sendError,
    log,
    ollamaHost: process.env.OLLAMA_HOST,
  });


  app.get<{ Params: { id: string } }>('/api/plans/:id/file', async (request, reply) => {
    const err = ensureReady(reply); if (err) return err;
    if (rejectForeignOrigin(request, reply)) return { error: 'Forbidden' };
    const plan = sdk.getPlanById(request.params.id);
    if (!plan) { return sendError(reply, 404, 'Not found'); }
    const r = resolvePlanFilePath(plan.planFilePath);
    if ('error' in r) {
      if (r.error === 'disallowed') { return sendError(reply, 403, 'Forbidden'); }
      return { exists: false };
    }
    // Open the fd ONCE, then fstat + read from THAT fd — never re-resolve the
    // path. This closes the TOCTOU between the allow-list/symlink check above and
    // the read: a local race that swaps r.path to a symlink can't redirect us.
    // O_NOFOLLOW refuses a symlink at the final path component.
    let fd: number;
    try {
      fd = openSync(r.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch {
      // ENOENT (missing) or ELOOP (symlink at final component) → not found.
      return { exists: false };
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return { exists: false };
      const cap = Math.min(st.size, PLAN_FILE_MAX_BYTES);
      const buf = Buffer.alloc(cap);
      const read = readSync(fd, buf, 0, cap, 0);
      return {
        exists: true,
        path: r.path,
        content: buf.subarray(0, read).toString('utf-8'),
        truncated: st.size > PLAN_FILE_MAX_BYTES,
      };
    } finally {
      closeSync(fd);
    }
  });

  app.post<{ Params: { id: string } }>('/api/plans/:id/open', async (request, reply) => {
    const err = ensureReady(reply); if (err) return err;
    if (rejectForeignOrigin(request, reply)) return { error: 'Forbidden' };
    const plan = sdk.getPlanById(request.params.id);
    if (!plan) { return sendError(reply, 404, 'Not found'); }
    const r = resolvePlanFilePath(plan.planFilePath);
    if ('error' in r) { reply.code(r.error === 'disallowed' ? 403 : 404); return { ok: false }; }
    if (!existsSync(r.path)) { reply.code(404); return { ok: false }; }
    // Open in the OS default TEXT editor. No shell, arg-array only → no injection.
    let cmd: string; let args: string[];
    if (process.platform === 'darwin') { cmd = 'open'; args = ['-t', r.path]; }
    else if (process.platform === 'linux') { cmd = 'xdg-open'; args = [r.path]; }
    else { return { ok: false, unsupported: true }; } // app ships mac + linux only
    return await new Promise((resolve_) => {
      try {
        const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
        child.on('error', () => resolve_({ ok: false }));
        // Give spawn a tick to surface ENOENT before resolving success.
        child.unref();
        setTimeout(() => resolve_({ ok: true }), 50);
      } catch {
        resolve_({ ok: false });
      }
    });
  });

  app.get<{ Params: { id: string } }>('/api/plans/:id/relations', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    return sdk.getPlanRelations(request.params.id);
  });

  // Lineage chain: accepts any member and always answers from the chain's root.
  app.get<{ Params: { id: string } }>('/api/plans/:id/chain', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const result = sdk.getPlanChain(request.params.id);
    if (!result) { return sendError(reply, 404, 'Not found'); }
    return result;
  });

  app.get<{ Params: { id: string } }>('/api/knowledge/:id/plans', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    return sdk.getPlansForKnowledge(request.params.id);
  });

  app.post<{ Params: { id: string }; Body: { knowledgeId: string; relationType: 'input' | 'output' } }>('/api/plans/:id/relations', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const { knowledgeId, relationType } = request.body;
    sdk.addPlanRelation(request.params.id, knowledgeId, relationType);
    return { success: true };
  });

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/plans/:id', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const parsed = updatePlanSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.issues[0]?.message ?? 'Invalid plan update' };
    }
    try {
      const result = sdk.updatePlan(request.params.id, parsed.data);
      if (!result) { return sendError(reply, 404, 'Not found'); }
      return result;
    } catch (error) {
      // Lineage rejections (self-parenting, cycles, missing parent) land here.
      reply.code(400);
      return { error: (error as Error).message };
    }
  });

  app.delete<{ Params: { id: string } }>('/api/plans/:id', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    return { deleted: sdk.deletePlan(request.params.id) };
  });

  // ─── Plan Tasks endpoints ───────────────────────────────────

  app.get<{ Params: { id: string } }>('/api/plans/:id/tasks', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    return sdk.listPlanTasks(request.params.id);
  });

  app.post<{ Params: { id: string }; Body: { description: string; priority?: string; notes?: string } }>('/api/plans/:id/tasks', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const parsed = createPlanTaskSchema.omit({ planId: true }).safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.issues[0]?.message ?? 'Invalid task' };
    }
    return sdk.createPlanTask({ planId: request.params.id, ...parsed.data });
  });

  app.put<{ Params: { taskId: string }; Body: Record<string, unknown> }>('/api/plans/tasks/:taskId', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const parsed = updatePlanTaskSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.issues[0]?.message ?? 'Invalid task update' };
    }
    const result = sdk.updatePlanTask(request.params.taskId, parsed.data);
    if (!result) return { error: 'Task not found' };
    return result;
  });

  app.delete<{ Params: { taskId: string } }>('/api/plans/tasks/:taskId', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    return { deleted: sdk.deletePlanTask(request.params.taskId).deleted };
  });

  // ─── Plan Metrics endpoint ──────────────────────────────────

  app.get<{ Querystring: { from?: string; to?: string } }>('/api/metrics/plans', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;

    try {
      const allPlans = sdk.listPlans(1000);
      const taskStats = sdk.getPlanTaskStats();

      const plansByStatus = { total: 0, draft: 0, active: 0, completed: 0, archived: 0 };
      for (const p of allPlans) {
        plansByStatus.total++;
        const s = (p as any).status as string;
        if (s in plansByStatus) (plansByStatus as any)[s]++;
      }

      // Plans created per day — follows the global date-range picker when
      // from/to are given; falls back to the legacy 15-day window otherwise.
      const { from, to } = request.query;
      let plansByDay: { date: string; count: number }[];
      if (from && to) {
        const days = daysBetween(from, to);
        const set = new Set(buildDateSeries(from, to));
        plansByDay = sdk.getPlansByDay(days).filter((r) => set.has(r.date));
      } else {
        plansByDay = sdk.getPlansByDay(15);
      }

      return {
        plans: plansByStatus,
        tasks: {
          ...taskStats,
          avgPerPlan: plansByStatus.total > 0 ? Math.round((taskStats.total / plansByStatus.total) * 10) / 10 : 0,
        },
        plansByDay,
      };
    } catch (error) {
      reply.code(500);
      return { error: 'Failed to load plan metrics', message: error instanceof Error ? error.message : String(error) };
    }
  });

  // ─── Logs endpoints ─────────────────────────────────────────────

  app.get('/api/logs', async (request) => {
    const q = request.query as any;
    const lines = Number(q.lines) || 100;
    try {
      if (!existsSync(LOG_FILE)) return { lines: [], total: 0 };
      const content = readFileSync(LOG_FILE, 'utf-8');
      const allLines = content.split('\n').filter(Boolean);
      return { lines: allLines.slice(-lines), total: allLines.length };
    } catch {
      return { lines: [], total: 0 };
    }
  });

  app.delete('/api/logs', async () => {
    try {
      writeFileSync(LOG_FILE, '');
      log('info', 'Log file cleared by user');
      return { success: true };
    } catch {
      return { success: false };
    }
  });

  // ─── Settings (~/.cognistore/settings.json) ─────────────────────

  app.get('/api/settings', async () => readSettings());

  app.put<{ Body: Partial<AppSettings> }>('/api/settings', async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object') {
      reply.code(400);
      return { error: 'Body must be an object' };
    }
    // sanitizeSettings also runs inside writeSettings; calling it here keeps the
    // response honest about what was actually stored.
    const merged = writeSettings(sanitizeSettings(body));
    // The always-on flag is read by the SDK for federated search.
    sdk.reloadProviders();
    return merged;
  });

  // ─── External knowledge providers (federated search) ────────────
  app.get('/api/providers', async () => readProvidersConfig());

  app.post<{ Body: unknown }>('/api/providers', async (request, reply) => {
    try {
      const entry = providerEntrySchema.parse(request.body);
      const cfg = readProvidersConfig();
      if (cfg.providers.some((p) => p.id === entry.id)) {
        reply.code(409);
        return { error: `Provider id '${entry.id}' already exists` };
      }
      cfg.providers.push(entry);
      writeProvidersConfig(cfg);
      sdk.reloadProviders();
      return entry;
    } catch (e: any) {
      reply.code(400);
      return { error: e?.message ?? 'Invalid provider' };
    }
  });

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/providers/:id', async (request, reply) => {
    try {
      const cfg = readProvidersConfig();
      const idx = cfg.providers.findIndex((p) => p.id === request.params.id);
      if (idx === -1) { return sendError(reply, 404, 'Not found'); }
      const entry = providerEntrySchema.parse({ ...request.body, id: request.params.id });
      cfg.providers[idx] = entry;
      writeProvidersConfig(cfg);
      sdk.reloadProviders();
      return entry;
    } catch (e: any) {
      reply.code(400);
      return { error: e?.message ?? 'Invalid provider' };
    }
  });

  app.delete<{ Params: { id: string } }>('/api/providers/:id', async (request) => {
    const cfg = readProvidersConfig();
    cfg.providers = cfg.providers.filter((p) => p.id !== request.params.id);
    writeProvidersConfig(cfg);
    // Drop any persisted OAuth session for this provider (keychain teardown is the
    // Tauri shell's job on uninstall; this clears the sidecar file store).
    try { await providerTokenStore.delete(request.params.id); } catch { /* ignore */ }
    sdk.reloadProviders();
    return { removed: true };
  });

  // Inject a provider secret into process.env so EnvSecretStore can resolve it
  // for providers added after the sidecar started (env was frozen at spawn time).
  // The secret value comes from the UI (user typed it); this is loopback-only.
  app.post<{ Params: { id: string }; Body: { value: string } }>('/api/providers/:id/secret', async (request, reply) => {
    const { value } = request.body ?? {};
    if (typeof value !== 'string' || !value) {
      reply.code(400);
      return { error: 'value is required' };
    }
    process.env[secretRefToEnvKey(request.params.id)] = value;
    return { ok: true };
  });

  // Interactive OAuth 2.1 (PKCE) for a remote MCP provider, in two phases held by
  // `pendingOauth`. The desktop shell reserves a loopback redirect_uri (Tauri
  // `oauth_reserve`), POSTs it to /oauth/start to get the authorization URL, opens
  // the browser (`oauth_await`), then POSTs the captured code to /oauth/finish.
  const pendingOauth = new Map<string, InteractiveOAuthFlow>();

  app.post<{ Params: { id: string }; Body: { redirectUri?: string } }>('/api/providers/:id/oauth/start', async (request, reply) => {
    const entry = readProvidersConfig().providers.find((p) => p.id === request.params.id);
    if (!entry) { return sendError(reply, 404, 'Not found'); }
    if (entry.transport !== 'http' || entry.auth?.type !== 'oauth' || !entry.url) {
      reply.code(400); return { ok: false, message: 'not an OAuth provider' };
    }
    const redirectUri = request.body?.redirectUri;
    if (!redirectUri) { reply.code(400); return { ok: false, message: 'redirectUri is required' }; }
    // Validate that the redirectUri is a loopback address (RFC 8252 §7.3).
    // An arbitrary redirectUri would let the authorization server send the
    // authorization code to a third-party host instead of our local listener.
    try {
      const rHost = new URL(redirectUri).hostname;
      if (rHost !== '127.0.0.1' && rHost !== 'localhost' && rHost !== '::1') {
        reply.code(400); return { ok: false, message: 'redirectUri must be a loopback address (127.0.0.1 or localhost)' };
      }
    } catch {
      reply.code(400); return { ok: false, message: 'redirectUri is not a valid URL' };
    }
    try {
      const flow = new InteractiveOAuthFlow({
        providerId: entry.id, url: entry.url, redirectUrl: redirectUri,
        scopes: entry.auth.scopes, clientId: entry.auth.clientId, allowInsecure: entry.auth.allowInsecure,
        tokenStore: providerTokenStore,
      });
      const authUrl = await flow.begin();
      if (authUrl === null) { await flow.dispose(); return { ok: true, alreadyConnected: true }; }
      // Hold the flow (with its PKCE verifier + transport) until /finish.
      await pendingOauth.get(entry.id)?.dispose();
      pendingOauth.set(entry.id, flow);
      return { ok: true, authorizeUrl: authUrl };
    } catch (e: any) {
      reply.code(502); return { ok: false, message: e?.message ?? String(e) };
    }
  });

  app.post<{ Params: { id: string }; Body: { code?: string } }>('/api/providers/:id/oauth/finish', async (request, reply) => {
    const flow = pendingOauth.get(request.params.id);
    if (!flow) { reply.code(409); return { ok: false, message: 'no pending OAuth flow — start again' }; }
    const code = request.body?.code;
    if (!code) { reply.code(400); return { ok: false, message: 'code is required' }; }
    try {
      await flow.finish(code);
      pendingOauth.delete(request.params.id);
      sdk.reloadProviders(); // pick up the freshly-saved tokens
      return { ok: true };
    } catch (e: any) {
      pendingOauth.delete(request.params.id);
      reply.code(502); return { ok: false, message: e?.message ?? String(e) };
    }
  });

  app.post<{ Params: { id: string } }>('/api/providers/:id/test', async (request, reply) => {
    const entry = readProvidersConfig().providers.find((p) => p.id === request.params.id);
    if (!entry) { return sendError(reply, 404, 'Not found'); }
    // OAuth providers can't authorize from a headless route (no browser). If no
    // tokens are stored yet, tell the UI to run the interactive Connect flow.
    if (entry.transport === 'http' && entry.auth?.type === 'oauth') {
      const session = await providerTokenStore.get(entry.id);
      if (!session.tokens) return { ok: false, needsAuth: true, message: 'OAuth not connected — click Connect' };
    }
    const provider = buildProvider(entry, new EnvSecretStore(), providerTokenStore);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      return provider.testConnection ? await provider.testConnection(ctrl.signal) : { ok: true };
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) };
    } finally {
      clearTimeout(timer);
      await provider.dispose?.();
    }
  });

  // ─── Start server ──────────────────────────────────────────────

  await app.listen({ port: PORT, host: '127.0.0.1' });
  log('info', `Server listening on http://localhost:${PORT}`);

  /**
   * Catch up on the cleanup report shortly after boot, so a machine that is never
   * up for a full 6-hour tick still gets one.
   *
   * Deferred by a minute and gated on COGNISTORE_MANAGED for two independent
   * reasons: duplicate detection runs a synchronous per-entry KNN scan that would
   * block the event loop during startup, and the e2e suite spawns this server
   * against the developer's real HOME — an ungated run would rewrite their
   * ~/.cognistore/settings.json on every test run.
   */
  if (process.env.COGNISTORE_MANAGED === '1') {
    setTimeout(() => {
      if (!sdkReady) return;
      void (async () => { await maybeGenerateReport({ sdk, log }); })().catch(() => { /* logged inside */ });
    }, 60_000).unref();
  }

  /**
   * Self-heal deployed artifacts when this build is newer than what is on disk.
   *
   * Until now the redeploy only ran when the user opened the dashboard and the UI
   * called /api/upgrade/run, so an app that never got opened kept running hooks and
   * skills from an older release — which is how a hook and an MCP server from two
   * different versions ended up deadlocking agents.
   *
   * Deliberately NOT gated on sdkReady: this only touches the filesystem, and a
   * machine with a broken Ollama/DB is exactly the one stuck with stale artifacts.
   */
  void (async () => {
    // Only when launched by the Tauri shell. The e2e suite spawns this same server
    // with the developer's real HOME, so an unguarded redeploy would rewrite their
    // ~/.claude.json, ~/.claude/settings.json and ~/.claude/skills on every test run.
    if (process.env.COGNISTORE_MANAGED !== '1') return;
    if (!VERSION_RESOLVED) return;

    // A first install (no marker) belongs to the setup wizard: Node may not be
    // installed yet, and /api/setup/complete owns the first .version write.
    const deployedArtifacts = getDeployedArtifactsVersion();
    if (deployedArtifacts === null && getDeployedVersion() === null) return;
    if (deployedArtifacts === APP_VERSION) return;
    if (upgradeRunning) return;

    upgradeRunning = true;
    const run = redeployArtifacts();
    inFlightDeploy = run;
    try {
      const results = await run;
      const failed = results.filter((r) => r.status === 'error');
      for (const r of failed) log('error', `Startup redeploy step "${r.step}" failed: ${r.message}`);
      if (failed.length === 0) {
        // Marker is separate from .version on purpose: /api/upgrade/run owns that
        // one and is the only path that re-embeds and resyncs embedding integrity.
        saveDeployedArtifactsVersion();
        log('info', `Artifacts re-deployed for v${APP_VERSION} (was ${deployedArtifacts ?? 'unknown'})`);
      }
    } catch (e: any) {
      log('error', `Startup redeploy failed: ${e?.message ?? e}`);
    } finally {
      upgradeRunning = false;
      inFlightDeploy = null;
    }
  })();

  // Initialize SDK in background — don't block server startup.
  // On fresh installs, ensureModel() pulls the Ollama model (streaming download)
  // which can take minutes. The health endpoint returns 200+token regardless of
  // SDK state, and all data routes guard with ensureReady() (503).
  const initialTokenScan = async () => {
    try {
      const res = await sdk.scanTokenUsage();
      if (res.inserted > 0) log('info', `Token scan: inserted ${res.inserted} rows`);
    } catch (e: any) {
      log('warn', `Initial token scan failed: ${e?.message ?? e}`);
    }
  };

  (async () => {
    const initOk = await tryInitSDK();
    if (initOk) {
      log('info', 'SDK initialized successfully');
      await seedSystemKnowledge();
      void initialTokenScan();
    } else {
      log('warn', `SDK initialization failed (degraded mode): ${sdkError}`);
      retryInterval = setInterval(async () => {
        const ok = await tryInitSDK();
        if (ok) {
          log('info', 'SDK initialized (recovered from degraded mode)');
          await seedSystemKnowledge();
          void initialTokenScan();
        }
      }, 10000);
    }
  })();

  const shutdown = async () => {
    if (sdkReady) await sdk.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((error) => {
  console.error('Failed to start dashboard server:', error);
  process.exit(1);
});
