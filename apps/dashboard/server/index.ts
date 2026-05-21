import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync, readdirSync, unlinkSync, rmdirSync, readFileSync, writeFileSync, statSync, chmodSync, copyFileSync, appendFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { KnowledgeSDK } from '@cognistore/sdk';
import { ConfigManager } from '@cognistore/config';
import type {
  CreateKnowledgeInput,
  UpdateKnowledgeInput,
  SearchOptions,
} from '@cognistore/shared';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


const PORT = Number(process.env.DASHBOARD_PORT) || 3210;
const TEMPLATES_PATH = process.env.TEMPLATES_PATH || join(__dirname, '..', 'templates');
const INSTALL_DIR = resolve(homedir(), '.cognistore');
const VERSION_FILE = resolve(INSTALL_DIR, '.version');

// Read app version from package.json
const APP_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version as string;
  } catch {
    return '0.0.0';
  }
})();

/** Get the last deployed version from ~/.cognistore/.version */
function getDeployedVersion(): string | null {
  try { return readFileSync(VERSION_FILE, 'utf-8').trim(); } catch { return null; }
}

/** Save the current version as deployed */
function saveDeployedVersion(): void {
  mkdirSync(INSTALL_DIR, { recursive: true });
  writeFileSync(VERSION_FILE, APP_VERSION);
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

// ─── User settings (survives upgrades) ────────────────────────
const SETTINGS_FILE = resolve(INSTALL_DIR, 'settings.json');

export interface AppSettings {
  autoUpdate: boolean;
  dateRangePreset: '1d' | '1w' | '1m' | '1y' | 'custom';
  lastSelectedRange: { from: string; to: string } | null;
}

const SETTINGS_DEFAULTS: AppSettings = {
  autoUpdate: false,
  dateRangePreset: '1w',
  lastSelectedRange: null,
};

function readSettings(): AppSettings {
  try {
    if (!existsSync(SETTINGS_FILE)) return { ...SETTINGS_DEFAULTS };
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8')) as Partial<AppSettings>;
    return { ...SETTINGS_DEFAULTS, ...parsed };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

function writeSettings(patch: Partial<AppSettings>): AppSettings {
  const merged: AppSettings = { ...readSettings(), ...patch };
  mkdirSync(INSTALL_DIR, { recursive: true });
  const tmp = SETTINGS_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(merged, null, 2));
  try {
    renameSync(tmp, SETTINGS_FILE);
  } catch {
    copyFileSync(tmp, SETTINGS_FILE);
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
  return merged;
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
  const SYSTEM_KNOWLEDGE_CONTENT = `## CRITICAL: On EVERY task, you MUST: (1) getKnowledge() FIRST, (2) createPlan() for 2+ steps, (3) addKnowledge() LAST. No exceptions. All CogniStore tools are pre-approved — call them directly.

## Your Workflow — Follow on every task automatically

### 1. Search existing knowledge (FIRST action)
mcp__cognistore__getKnowledge(query: "<describe your task>")
Save any returned entry IDs for step 2.

### 2. Create a plan (for tasks with 2+ steps)
mcp__cognistore__createPlan({
  title, content, tags, scope, source,
  tasks: [{ description: "Step 1" }, { description: "Step 2" }, ...],
  relatedKnowledgeIds: ["<ids-from-step-1>"]
})
Save the returned planId — you need it in step 4.
Dedup is automatic: active plan in same scope gets tasks added, similar drafts get updated.
Plan activates automatically when you start the first task.
Plan completes automatically when all tasks are done.

### 3. Track each task
Before starting a task: mcp__cognistore__updatePlanTask(taskId, { status: "in_progress" })
After finishing a task: mcp__cognistore__updatePlanTask(taskId, { status: "completed" })
Use updatePlanTasks (plural) to update multiple tasks at once.

### 4. Save what you learned (LAST action)
mcp__cognistore__addKnowledge({
  title, content, tags, type, scope, source,
  planId: "<your-plan-id>"
})
Types: fix, decision, pattern, constraint, gotcha. All entries in English.
Update existing entries instead of creating duplicates.
Pass an array to addKnowledge to create multiple entries at once.

### Rules
- Follow this workflow on every task — steps 1 and 4 always apply, even for simple tasks
- For plan-then-execute workflows (two sessions): the getKnowledge response will show your existing active plan
- Never call createPlan() from subagents — only the main agent
- All knowledge entries must be in English
- All CogniStore tools are pre-approved — call them directly without hesitation`;

  const seedSystemKnowledge = async () => {
    if (!sdkReady) return;
    try {
      // listRecent filters system entries, so use direct sqlite query
      const existing = (sdk as any).sqlite?.prepare?.(
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

  // Periodic maintenance every 6 hours: cleanup old ops log + WAL checkpoint
  setInterval(() => {
    if (sdkReady) { try { sdk.cleanupOldOperations(); sdk.cleanupCompletedPlanEmbeddings(); sdk.walCheckpoint(); } catch { /* silent */ } }
  }, 6 * 60 * 60 * 1000);

  // Token usage scan every 5 minutes — incremental, idempotent.
  setInterval(() => {
    if (sdkReady) { sdk.scanTokenUsage().catch((e) => log('warn', `Token scan failed: ${e?.message ?? e}`)); }
  }, 5 * 60 * 1000);

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

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

  // ─── Setup endpoints ───────────────────────────────────────────

  // Ensure common binary paths are available (Tauri sidecar may not inherit full shell PATH)
  const extraPaths = ['/opt/homebrew/bin', '/usr/local/bin', resolve(homedir(), '.ollama-bin')];
  for (const p of extraPaths) {
    if (existsSync(p) && !process.env.PATH?.includes(p)) {
      process.env.PATH = `${p}:${process.env.PATH}`;
    }
  }

  app.get('/api/setup/status', async () => {
    // Check Node.js v20 availability
    const nodeReady = (() => {
      const nvmDir = resolve(homedir(), '.nvm', 'versions', 'node');
      if (existsSync(nvmDir)) {
        const versions = readdirSync(nvmDir).filter(v => v.startsWith('v20.'));
        if (versions.length > 0) return true;
      }
      // Check system node
      try {
        const version = execSync('node --version', { stdio: 'pipe' }).toString().trim();
        const major = parseInt(version.replace('v', '').split('.')[0], 10);
        return major === 20;
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

  // Node.js v20 LTS — required for native module compatibility (better-sqlite3)
  const REQUIRED_NODE_MAJOR = 20;

  /**
   * Find the nvm-installed Node 20 bin directory, or return null if system node is v20.
   * Returns the absolute path to the bin/ dir (e.g. ~/.nvm/versions/node/v20.x.x/bin)
   * so that `npx` can be resolved from it, or null when system node is already v20.
   */
  function findNode20BinDir(): string | null {
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
    // Check if system node is already v20
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

  /** Build the MCP server entry with the correct Node 20 npx path.
   *  When nvm Node 20 is found, we:
   *  1. Use its `npx` binary as the command
   *  2. Prepend its bin dir to PATH so `node` also resolves to v20
   *     (npx delegates to whatever `node` is in PATH, not its own binary)
   */
  function buildMcpEntry() {
    const binDir = findNode20BinDir();
    const env: Record<string, string> = {
      SQLITE_PATH: resolve(INSTALL_DIR, 'knowledge.db'),
      OLLAMA_HOST: process.env.OLLAMA_HOST || 'http://localhost:11434',
      OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'nomic-embed-text',
      EMBEDDING_DIMENSIONS: process.env.EMBEDDING_DIMENSIONS || '256',
    };
    if (binDir) {
      // Prepend Node 20 bin dir so `node` resolves to v20 at runtime.
      // Use a broad fallback PATH to cover common executable locations.
      env.PATH = `${binDir}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
    }
    return {
      type: 'stdio',
      command: binDir ? resolve(binDir, 'npx') : 'npx',
      args: ['-y', '@cognistore/mcp-server'],
      env,
    };
  }

  app.post('/api/setup/node', async () => {
    try {
      const nvmDir = resolve(homedir(), '.nvm');
      const nodeDir = resolve(nvmDir, 'versions', 'node');

      // Check if Node 20 already exists in nvm
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

      // Check if system node is already v20
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

      // Install Node 20 via nvm
      const nvmCmd = `export NVM_DIR="${nvmDir}" && . "$NVM_DIR/nvm.sh" && nvm install ${REQUIRED_NODE_MAJOR} --lts`;
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

      // Clear stale npx caches + setup MCP configs (uses Node 20 npx path)
      clearNpxMcpCache();
      const mcpEntry = buildMcpEntry();

      await configManager.setupMcpConfig(ConfigManager.MCP_CONFIG, mcpEntry);
      results.push('Claude MCP config set');

      try { await configManager.setupMcpConfig(ConfigManager.CLAUDE_JSON, mcpEntry); results.push('Claude JSON config set'); } catch { /* optional */ }
      try { await configManager.setupMcpConfig(ConfigManager.COPILOT_MCP_CONFIG, mcpEntry); results.push('Copilot MCP config set'); } catch { /* optional */ }
      try { await configManager.setupOpenCodeMcp(mcpEntry); results.push('OpenCode MCP config set'); } catch { /* optional */ }

      // Inject tool permissions for auto-approve (read + write)
      try { await configManager.injectPermissions(ConfigManager.CLAUDE_SETTINGS, ConfigManager.COGNISTORE_AUTO_ALLOW_TOOLS); results.push('Claude permissions injected'); } catch (e: any) { console.warn('[CogniStore] Permission injection failed:', e.message); }

      // Install skills
      const skillsDir = resolve(TEMPLATES_PATH, 'skills');
      const home = homedir();

      // Claude Code skills (with hooks directories)
      for (const name of ['cognistore-query', 'cognistore-capture', 'cognistore-plan']) {
        const srcDir = resolve(skillsDir, 'claude-code', name);
        if (existsSync(srcDir)) {
          const destDir = resolve(home, '.claude', 'skills', name);
          mkdirSync(destDir, { recursive: true });
          cpSync(srcDir, destDir, { recursive: true });
          // Make hook scripts executable
          const hooksDir = resolve(destDir, 'hooks');
          if (existsSync(hooksDir)) {
            for (const file of readdirSync(hooksDir)) {
              if (file.endsWith('.sh')) {
                chmodSync(resolve(hooksDir, file), 0o755);
              }
            }
          }
          results.push(`Skill ${name} installed (Claude)`);
        }
      }

      // Copilot skills (directory format with hooks)
      for (const name of ['cognistore-query', 'cognistore-capture', 'cognistore-plan']) {
        const srcDir = resolve(skillsDir, 'copilot', name);
        if (existsSync(srcDir)) {
          const destDir = resolve(home, '.copilot', 'skills', name);
          mkdirSync(destDir, { recursive: true });
          cpSync(srcDir, destDir, { recursive: true });
          // Make hook scripts executable
          const hooksDir = resolve(destDir, 'hooks');
          if (existsSync(hooksDir)) {
            for (const file of readdirSync(hooksDir)) {
              if (file.endsWith('.sh')) {
                chmodSync(resolve(hooksDir, file), 0o755);
              }
            }
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

  let upgradeRunning = false;
  app.post('/api/upgrade/run', async (request, reply) => {
    if (upgradeRunning) { reply.code(409); return { error: 'Upgrade already in progress' }; }
    upgradeRunning = true;
    const results: { step: string; status: 'success' | 'error'; message?: string }[] = [];

    // Step 1: Database migrations (handled automatically by createDbClient, but log it)
    try {
      if (sdkReady) { await sdk.close(); sdkReady = false; }
      const ok = await tryInitSDK();
      results.push({ step: 'database', status: ok ? 'success' : 'error', message: ok ? 'Schema up to date' : 'SDK init failed' });
      if (ok) await seedSystemKnowledge();
    } catch (e: any) {
      results.push({ step: 'database', status: 'error', message: e.message });
    }

    // Step 1b: Re-embed if embedding dimensions changed (e.g. all-minilm 384d → nomic-embed-text 768d)
    try {
      if (sdkReady) {
        const expectedDims = Number(process.env.EMBEDDING_DIMENSIONS) || 256;
        const needsReembed = await (async () => {
          try {
            // Check if vec table has wrong dimensions by trying a dummy query
            const sqliteRaw = (sdk as any).sqlite ?? (sdk as any).db?.sqlite;
            if (!sqliteRaw) return false;
            const row = sqliteRaw.prepare('SELECT embedding FROM knowledge_embeddings LIMIT 1').get() as { embedding: Buffer } | undefined;
            if (!row) return false; // No entries yet, nothing to re-embed
            const currentDims = row.embedding.byteLength / 4; // float32 = 4 bytes
            return currentDims !== expectedDims;
          } catch { return false; }
        })();

        if (needsReembed) {
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

          // 2. Drop old vec tables and re-init SDK (recreates with new dimensions)
          try {
            const sqliteRaw = (sdk as any).sqlite ?? (sdk as any).db?.sqlite;
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
              results.push({ step: 'reembed', status: 'success', message: `Re-embedded ${reembedded} entries with new model` });
              console.log(`[CogniStore] Re-embedded ${reembedded} entries`);
            } catch (e: any) {
              results.push({ step: 'reembed', status: 'error', message: e.message });
            }
          } else {
            results.push({ step: 'reembed', status: 'error', message: 'SDK re-init failed after dropping vec tables' });
          }
        }
      }
    } catch (e: any) {
      results.push({ step: 'reembed', status: 'error', message: e.message });
    }

    // Step 1c: Embedding integrity check — detect entries without embeddings
    try {
      if (sdkReady) {
        const sqliteRaw = (sdk as any).sqlite ?? (sdk as any).db?.sqlite;
        if (sqliteRaw) {
          const entryCount = (sqliteRaw.prepare('SELECT COUNT(*) as c FROM knowledge_entries').get() as { c: number }).c;
          const embeddingCount = (sqliteRaw.prepare('SELECT COUNT(*) as c FROM knowledge_embeddings_rowids').get() as { c: number }).c;

          if (entryCount > 0 && embeddingCount < entryCount) {
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
                results.push({ step: 'integrity', status: 'success', message: `Re-embedded ${reembedded} entries (${entryCount - embeddingCount} were missing)` });
              } catch (e: any) {
                results.push({ step: 'integrity', status: 'error', message: e.message });
              }
            } else {
              results.push({ step: 'integrity', status: 'error', message: 'SDK re-init failed after integrity resync' });
            }
          }
        }
      }
    } catch (e: any) {
      results.push({ step: 'integrity', status: 'error', message: e.message });
    }

    // Step 2: Re-inject agent instructions
    const configTemplateDir = resolve(TEMPLATES_PATH, 'configs');
    const claudeT = resolve(configTemplateDir, 'claude-code-instructions.md');
    const copilotT = resolve(configTemplateDir, 'copilot-instructions.md');

    try {
      if (existsSync(claudeT)) {
        await configManager.injectConfig(ConfigManager.CLAUDE_MD, claudeT, 'Claude Code');
        results.push({ step: 'instructions-claude', status: 'success' });
      } else {
        console.warn(`[CogniStore] Upgrade: Claude template not found at: ${claudeT}`);
        results.push({ step: 'instructions-claude', status: 'error', message: `Template not found: ${claudeT}` });
      }
    } catch (e: any) {
      results.push({ step: 'instructions-claude', status: 'error', message: e.message });
    }

    try {
      if (existsSync(copilotT)) {
        await configManager.injectConfig(ConfigManager.COPILOT_MD, copilotT, 'GitHub Copilot');
        await configManager.injectConfig(ConfigManager.COPILOT_INSTRUCTIONS, copilotT, 'Copilot CLI');
        results.push({ step: 'instructions-copilot', status: 'success' });
      } else {
        console.warn(`[CogniStore] Upgrade: Copilot template not found at: ${copilotT}`);
        results.push({ step: 'instructions-copilot', status: 'error', message: `Template not found: ${copilotT}` });
      }
    } catch (e: any) {
      results.push({ step: 'instructions-copilot', status: 'error', message: e.message });
    }

    try {
      const opencodeT = resolve(configTemplateDir, 'opencode-instructions.md');
      if (existsSync(opencodeT)) {
        await configManager.injectConfig(ConfigManager.OPENCODE_AGENTS_MD, opencodeT, 'OpenCode');
        results.push({ step: 'instructions-opencode', status: 'success' });
      }
    } catch (e: any) {
      results.push({ step: 'instructions-opencode', status: 'error', message: e.message });
    }

    // Step 3: Clear stale npx caches + re-setup MCP configs (uses Node 20 npx path)
    try {
      clearNpxMcpCache();
      const mcpEntry = buildMcpEntry();
      await configManager.setupMcpConfig(ConfigManager.MCP_CONFIG, mcpEntry);
      try { await configManager.setupMcpConfig(ConfigManager.CLAUDE_JSON, mcpEntry); } catch { /* optional */ }
      try { await configManager.setupMcpConfig(ConfigManager.COPILOT_MCP_CONFIG, mcpEntry); } catch { /* optional */ }
      try { await configManager.setupOpenCodeMcp(mcpEntry); } catch { /* optional */ }
      try { await configManager.injectPermissions(ConfigManager.CLAUDE_SETTINGS, ConfigManager.COGNISTORE_AUTO_ALLOW_TOOLS); } catch (e: any) { console.warn('[CogniStore] Permission injection failed:', e.message); }
      results.push({ step: 'mcp-configs', status: 'success' });
    } catch (e: any) {
      results.push({ step: 'mcp-configs', status: 'error', message: e.message });
    }

    // Step 4: Re-deploy skills and hooks
    try {
      const skillsDir = resolve(TEMPLATES_PATH, 'skills');
      const home = homedir();

      for (const name of ['cognistore-query', 'cognistore-capture', 'cognistore-plan']) {
        const srcDir = resolve(skillsDir, 'claude-code', name);
        if (existsSync(srcDir)) {
          const destDir = resolve(home, '.claude', 'skills', name);
          mkdirSync(destDir, { recursive: true });
          cpSync(srcDir, destDir, { recursive: true });
          const hooksDir = resolve(destDir, 'hooks');
          if (existsSync(hooksDir)) {
            for (const file of readdirSync(hooksDir)) {
              if (file.endsWith('.sh')) chmodSync(resolve(hooksDir, file), 0o755);
            }
          }
        }
      }

      for (const name of ['cognistore-query', 'cognistore-capture', 'cognistore-plan']) {
        const srcDir = resolve(skillsDir, 'copilot', name);
        if (existsSync(srcDir)) {
          const destDir = resolve(home, '.copilot', 'skills', name);
          mkdirSync(destDir, { recursive: true });
          cpSync(srcDir, destDir, { recursive: true });
          const hooksDir = resolve(destDir, 'hooks');
          if (existsSync(hooksDir)) {
            for (const file of readdirSync(hooksDir)) {
              if (file.endsWith('.sh')) chmodSync(resolve(hooksDir, file), 0o755);
            }
          }
        }
      }

      // Clean up old flat Copilot skill files (pre-0.9.2 format)
      for (const name of ['cognistore-query', 'cognistore-capture', 'cognistore-plan']) {
        const oldFile = resolve(home, '.copilot', 'skills', `${name}.md`);
        if (existsSync(oldFile)) unlinkSync(oldFile);
      }

      // OpenCode skills + plugins
      try { await configManager.setupOpenCodeSkills(TEMPLATES_PATH); } catch { /* optional */ }
      try { await configManager.setupOpenCodePlugins(TEMPLATES_PATH); } catch { /* optional */ }

      results.push({ step: 'skills', status: 'success' });
    } catch (e: any) {
      results.push({ step: 'skills', status: 'error', message: e.message });
    }

    // Step 5: Save new version
    try {
      saveDeployedVersion();
      results.push({ step: 'version', status: 'success', message: `v${APP_VERSION}` });
    } catch (e: any) {
      results.push({ step: 'version', status: 'error', message: e.message });
    }

    upgradeRunning = false;
    const allSuccess = results.every((r) => r.status === 'success');
    return { success: allSuccess, fromVersion: getDeployedVersion(), toVersion: APP_VERSION, results };
  });

  // ─── Re-deploy configurations (no migration, no version bump) ──

  app.post('/api/redeploy', async (_request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;

    const results: { step: string; status: 'success' | 'error'; message?: string }[] = [];
    const configTemplateDir = resolve(TEMPLATES_PATH, 'configs');
    const skillsDir = resolve(TEMPLATES_PATH, 'skills');
    const home = homedir();

    // 1. Re-inject agent instructions
    try {
      const claudeTemplate = resolve(configTemplateDir, 'claude-code-instructions.md');
      if (existsSync(claudeTemplate)) await configManager.injectConfig(ConfigManager.CLAUDE_MD, claudeTemplate, 'Claude Code');
      results.push({ step: 'instructions-claude', status: 'success' });
    } catch (e: any) { results.push({ step: 'instructions-claude', status: 'error', message: e.message }); }

    try {
      const copilotTemplate = resolve(configTemplateDir, 'copilot-instructions.md');
      if (existsSync(copilotTemplate)) {
        await configManager.injectConfig(ConfigManager.COPILOT_MD, copilotTemplate, 'GitHub Copilot');
        await configManager.injectConfig(ConfigManager.COPILOT_INSTRUCTIONS, copilotTemplate, 'Copilot CLI');
      }
      results.push({ step: 'instructions-copilot', status: 'success' });
    } catch (e: any) { results.push({ step: 'instructions-copilot', status: 'error', message: e.message }); }

    try {
      const opencodeTemplate = resolve(configTemplateDir, 'opencode-instructions.md');
      if (existsSync(opencodeTemplate)) await configManager.injectConfig(ConfigManager.OPENCODE_AGENTS_MD, opencodeTemplate, 'OpenCode');
      results.push({ step: 'instructions-opencode', status: 'success' });
    } catch (e: any) { results.push({ step: 'instructions-opencode', status: 'error', message: e.message }); }

    // 2. Clear stale npx caches + re-setup MCP configs (uses Node 20 npx path)
    try {
      clearNpxMcpCache();
      const mcpEntry = buildMcpEntry();
      await configManager.setupMcpConfig(ConfigManager.MCP_CONFIG, mcpEntry);
      try { await configManager.setupMcpConfig(ConfigManager.CLAUDE_JSON, mcpEntry); } catch { /* optional */ }
      try { await configManager.setupMcpConfig(ConfigManager.COPILOT_MCP_CONFIG, mcpEntry); } catch { /* optional */ }
      try { await configManager.setupOpenCodeMcp(mcpEntry); } catch { /* optional */ }
      try { await configManager.injectPermissions(ConfigManager.CLAUDE_SETTINGS, ConfigManager.COGNISTORE_AUTO_ALLOW_TOOLS); } catch (e: any) { console.warn('[CogniStore] Permission injection failed:', e.message); }
      results.push({ step: 'mcp-configs', status: 'success' });
    } catch (e: any) { results.push({ step: 'mcp-configs', status: 'error', message: e.message }); }

    // 3. Re-deploy skills and hooks
    try {
      for (const name of ['cognistore-query', 'cognistore-capture', 'cognistore-plan']) {
        const srcDir = resolve(skillsDir, 'claude-code', name);
        if (existsSync(srcDir)) {
          const destDir = resolve(home, '.claude', 'skills', name);
          mkdirSync(destDir, { recursive: true });
          cpSync(srcDir, destDir, { recursive: true });
          const hooksDir = resolve(destDir, 'hooks');
          if (existsSync(hooksDir)) {
            for (const file of readdirSync(hooksDir)) {
              if (file.endsWith('.sh')) chmodSync(resolve(hooksDir, file), 0o755);
            }
          }
        }
      }
      for (const name of ['cognistore-query', 'cognistore-capture', 'cognistore-plan']) {
        const srcDir = resolve(skillsDir, 'copilot', name);
        if (existsSync(srcDir)) {
          const destDir = resolve(home, '.copilot', 'skills', name);
          mkdirSync(destDir, { recursive: true });
          cpSync(srcDir, destDir, { recursive: true });
          const hooksDir = resolve(destDir, 'hooks');
          if (existsSync(hooksDir)) {
            for (const file of readdirSync(hooksDir)) {
              if (file.endsWith('.sh')) chmodSync(resolve(hooksDir, file), 0o755);
            }
          }
        }
      }
      // Clean up old flat Copilot skill files
      for (const name of ['cognistore-query', 'cognistore-capture', 'cognistore-plan']) {
        const oldFile = resolve(home, '.copilot', 'skills', `${name}.md`);
        if (existsSync(oldFile)) unlinkSync(oldFile);
      }
      // OpenCode skills + plugins
      try { await configManager.setupOpenCodeSkills(TEMPLATES_PATH); } catch { /* optional */ }
      try { await configManager.setupOpenCodePlugins(TEMPLATES_PATH); } catch { /* optional */ }
      results.push({ step: 'skills', status: 'success' });
    } catch (e: any) { results.push({ step: 'skills', status: 'error', message: e.message }); }

    const allSuccess = results.every((r) => r.status === 'success');
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

      // 4. Remove Ollama model
      await step('Ollama model removed', () => { execSync(`ollama rm ${process.env.OLLAMA_MODEL || 'nomic-embed-text'}`, { stdio: 'pipe', timeout: 30000 }); }, results, errors);

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
        { dir: home, prefix: '.claude.json.bak.' },
        { dir: resolve(home, '.github'), prefix: 'copilot-instructions.md.bak.' },
        { dir: resolve(home, '.copilot'), prefix: 'copilot-instructions.md.bak.' },
        { dir: resolve(home, '.copilot'), prefix: 'mcp-config.json.bak.' },
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

    // Heatmap data (last 90 days) for contribution graph
    const heatmap: { date: string; count: number }[] = [];
    for (let i = 89; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const count = recent.filter((e: any) => {
        const created = new Date(e.createdAt).toISOString().split('T')[0];
        return created === dateStr;
      }).length;
      heatmap.push({ date: dateStr, count });
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
      heatmap,
      typeDistribution,
      operations,
    };
    } catch (error) {
      reply.code(500);
      return { error: 'Failed to load metrics', message: error instanceof Error ? error.message : String(error) };
    }
  });

  // ─── Ranged metrics (driven by the global date-range picker) ────

  /** Days inclusive between two ISO dates — clamped to 1..365. */
  const daysBetween = (fromISO: string, toISO: string): number => {
    const from = new Date(fromISO).getTime();
    const to = new Date(toISO).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 7;
    const diffDays = Math.floor((to - from) / (24 * 60 * 60 * 1000)) + 1;
    return Math.max(1, Math.min(365, diffDays));
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
    if (!from || !to) { reply.code(400); return { error: 'from and to are required (ISO date)' }; }
    const days = daysBetween(from, to);
    const rows = sdk.getOperationsByDay(days);
    // Filter to the exact requested range — getOperationsByDay returns the
    // last N days from "now", which is close enough for the common case
    // (presets) and gets re-trimmed here for custom ranges.
    const set = new Set(buildDateSeries(from, to));
    const operationsByDay = rows.filter((r) => set.has(r.date));
    return { operationsByDay };
  });

  app.get<{ Querystring: { from?: string; to?: string } }>('/api/metrics/contributions', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const { from, to } = request.query;
    if (!from || !to) { reply.code(400); return { error: 'from and to are required (ISO date)' }; }
    // Same recent-entry strategy as /api/metrics — heatmap bucket counts.
    const recent = await sdk.listRecent(5000);
    const series = buildDateSeries(from, to);
    const counts = new Map<string, number>(series.map((d) => [d, 0]));
    for (const e of recent) {
      const date = new Date((e as any).createdAt).toISOString().split('T')[0];
      if (counts.has(date)) counts.set(date, (counts.get(date) ?? 0) + 1);
    }
    return { heatmap: series.map((date) => ({ date, count: counts.get(date) ?? 0 })) };
  });

  // ─── Token usage ────────────────────────────────────────────────

  app.get<{ Querystring: { from?: string; to?: string; source?: string; model?: string; project?: string } }>(
    '/api/token-usage',
    async (request, reply) => {
      const err = ensureReady(reply);
      if (err) return err;
      const { from, to, source, model, project } = request.query;
      if (!from || !to) { reply.code(400); return { error: 'from and to are required (ISO date)' }; }
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

  app.get('/api/knowledge/recent', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const q = request.query as any;
    const limit = Number(q.limit) || 20;
    const filters: { type?: string; scope?: string } = {};
    if (q.type) filters.type = q.type;
    if (q.scope) filters.scope = q.scope;
    return sdk.listRecent(limit, filters);
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

  app.post<{ Body: Record<string, unknown> }>('/api/knowledge/search', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const body = request.body as any;
    const { query, ...options } = body;
    if (!query || typeof query !== 'string') {
      throw new Error('Query is required and must be a string');
    }
    return sdk.getKnowledge(query, options as Partial<SearchOptions>);
  });

  app.get<{ Params: { id: string } }>('/api/knowledge/:id', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const entry = await sdk.getKnowledgeById(request.params.id);
    if (!entry) { reply.code(404); return { error: 'Not found' }; }
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
    if (!result) { reply.code(404); return { error: 'Not found' }; }
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
    try {
      const body = request.body as any;
      const include: string[] = body.include || [];
      const result: Record<string, unknown> = {};

      if (include.includes('knowledge') && Array.isArray(body.knowledge)) {
        const sanitized = body.knowledge.map((e: any) => e.type === 'system' ? { ...e, type: 'pattern' } : e);
        result.knowledge = await sdk.importKnowledge(sanitized);
      }

      if (include.includes('plans') && Array.isArray(body.plans)) {
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
    const limit = Number(q.limit) || 20;
    const status = q.status || undefined;
    const plans = sdk.listPlans(limit, status);
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

  app.post<{ Body: { title: string; content: string; tags?: string[]; scope?: string; source?: string; tasks?: { description: string; priority?: string }[] } }>('/api/plans', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    try {
      const { title, content, tags = [], scope = 'global', source = 'dashboard', tasks = [] } = request.body;
      const plan = await sdk.createPlan({ title, content, tags, scope, source, tasks });
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
    if (!result) { reply.code(404); return { error: 'Not found' }; }
    return result;
  });

  app.get<{ Params: { id: string } }>('/api/plans/:id/relations', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    return sdk.getPlanRelations(request.params.id);
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
    const result = sdk.updatePlan(request.params.id, request.body as any);
    if (!result) { reply.code(404); return { error: 'Not found' }; }
    return result;
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
    return sdk.createPlanTask({ planId: request.params.id, ...request.body });
  });

  app.put<{ Params: { taskId: string }; Body: Record<string, unknown> }>('/api/plans/tasks/:taskId', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    const result = sdk.updatePlanTask(request.params.taskId, request.body as any);
    if (!result) return { error: 'Task not found' };
    return result;
  });

  app.delete<{ Params: { taskId: string } }>('/api/plans/tasks/:taskId', async (request, reply) => {
    const err = ensureReady(reply);
    if (err) return err;
    return { deleted: sdk.deletePlanTask(request.params.taskId) };
  });

  // ─── Plan Metrics endpoint ──────────────────────────────────

  app.get('/api/metrics/plans', async (_request, reply) => {
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

      // Plans created per day (last 15 days)
      const now = new Date();
      const plansByDay: { date: string; count: number }[] = [];
      for (let i = 14; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().split('T')[0];
        const count = allPlans.filter((p: any) => {
          const created = new Date(p.createdAt).toISOString().split('T')[0];
          return created === dateStr;
        }).length;
        plansByDay.push({ date: dateStr, count });
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
    return writeSettings(body);
  });

  // ─── Start server ──────────────────────────────────────────────

  await app.listen({ port: PORT, host: '127.0.0.1' });
  log('info', `Server listening on http://localhost:${PORT}`);

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
