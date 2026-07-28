import {
  readFile,
  writeFile,
  mkdir,
  copyFile,
  unlink,
  access,
  chmod,
  readdir,
} from 'node:fs/promises';
import {
  existsSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const MARKER_BEGIN = '<!-- COGNISTORE:BEGIN -->';
const MARKER_END = '<!-- COGNISTORE:END -->';
// Also match old markers for migration
const OLD_MARKER_BEGIN = '<!-- AI-KNOWLEDGE:BEGIN -->';
const OLD_MARKER_END = '<!-- AI-KNOWLEDGE:END -->';

export interface InjectResult {
  action: 'created' | 'appended' | 'updated';
  path: string;
}

export interface RemoveResult {
  removed: boolean;
  hadMarkers: boolean;
  path: string;
}

export interface McpSetupResult {
  action: 'created' | 'updated' | 'skipped';
  path: string;
}

export interface McpRemoveResult {
  removed: boolean;
  path: string;
}

export class ConfigManager {
  // Well-known paths
  static readonly CLAUDE_MD = join(homedir(), '.claude', 'CLAUDE.md');
  static readonly COPILOT_MD = join(
    homedir(),
    '.github',
    'copilot-instructions.md'
  );
  static readonly MCP_CONFIG = join(homedir(), '.claude', 'mcp-config.json');
  static readonly CLAUDE_JSON = join(homedir(), '.claude.json');
  static readonly COPILOT_MCP_CONFIG = join(
    homedir(),
    '.copilot',
    'mcp-config.json'
  );
  static readonly COPILOT_INSTRUCTIONS = join(
    homedir(),
    '.copilot',
    'copilot-instructions.md'
  );
  static readonly OPENCODE_CONFIG = join(
    homedir(),
    '.config',
    'opencode',
    'opencode.json'
  );
  static readonly OPENCODE_AGENTS_MD = join(
    homedir(),
    '.config',
    'opencode',
    'AGENTS.md'
  );
  static readonly OPENCODE_SKILLS_DIR = join(homedir(), '.config', 'opencode', 'skills');
  static readonly OPENCODE_PLUGINS_DIR = join(homedir(), '.config', 'opencode', 'plugins');

  /**
   * Inject template content into a target file using markers.
   * - If target doesn't exist: create with template content
   * - If target exists but no markers: backup and append template
   * - If target exists with markers: replace content between markers
   */
  async injectConfig(
    targetPath: string,
    templatePath: string,
    label: string
  ): Promise<InjectResult> {
    await mkdir(dirname(targetPath), { recursive: true });

    const template = await readFile(templatePath, 'utf-8');

    if (!(await this.fileExists(targetPath))) {
      await writeFile(targetPath, template, 'utf-8');
      return { action: 'created', path: targetPath };
    }

    const content = await readFile(targetPath, 'utf-8');

    // Check for new or old markers (migration support)
    const hasNewMarkers = content.includes(MARKER_BEGIN);
    const hasOldMarkers = !hasNewMarkers && content.includes(OLD_MARKER_BEGIN);
    const activeBegin = hasOldMarkers ? OLD_MARKER_BEGIN : MARKER_BEGIN;
    const activeEnd = hasOldMarkers ? OLD_MARKER_END : MARKER_END;

    if (!hasNewMarkers && !hasOldMarkers) {
      // No markers found — backup and append
      await copyFile(
        targetPath,
        `${targetPath}.bak.${Date.now()}`
      );
      await writeFile(targetPath, content + '\n' + template, 'utf-8');
      return { action: 'appended', path: targetPath };
    }

    // Replace between markers (new template uses new markers automatically)
    await copyFile(
      targetPath,
      `${targetPath}.bak.${Date.now()}`
    );
    const beginIdx = content.indexOf(activeBegin);
    const endIdx = content.indexOf(activeEnd);
    if (beginIdx === -1 || endIdx === -1) {
      // Fallback: append
      await writeFile(targetPath, content + '\n' + template, 'utf-8');
      return { action: 'appended', path: targetPath };
    }
    const newContent =
      content.substring(0, beginIdx) +
      template +
      content.substring(endIdx + MARKER_END.length);
    await writeFile(targetPath, newContent, 'utf-8');
    return { action: 'updated', path: targetPath };
  }

  /**
   * Remove content between COGNISTORE markers from a file.
   * Also handles old AI-KNOWLEDGE markers for migration.
   * If the file only contains the marked section (plus whitespace), delete the file.
   */
  async removeConfig(targetPath: string): Promise<RemoveResult> {
    if (!(await this.fileExists(targetPath))) {
      return { removed: false, hadMarkers: false, path: targetPath };
    }

    const content = await readFile(targetPath, 'utf-8');

    const hasNewMarkers = content.includes(MARKER_BEGIN);
    const hasOldMarkers = !hasNewMarkers && content.includes(OLD_MARKER_BEGIN);

    if (!hasNewMarkers && !hasOldMarkers) {
      return { removed: false, hadMarkers: false, path: targetPath };
    }

    const activeBegin = hasOldMarkers ? OLD_MARKER_BEGIN : MARKER_BEGIN;
    const activeEnd = hasOldMarkers ? OLD_MARKER_END : MARKER_END;

    await copyFile(
      targetPath,
      `${targetPath}.bak.${Date.now()}`
    );

    const beginIdx = content.indexOf(activeBegin);
    const endIdx = content.indexOf(activeEnd);

    if (beginIdx === -1 || endIdx === -1) {
      return { removed: false, hadMarkers: false, path: targetPath };
    }

    const before = content.substring(0, beginIdx);
    const after = content.substring(endIdx + activeEnd.length);
    const remaining = (before + after).trim();

    if (remaining.length === 0) {
      await unlink(targetPath);
      return { removed: true, hadMarkers: true, path: targetPath };
    }

    await writeFile(targetPath, remaining + '\n', 'utf-8');
    return { removed: true, hadMarkers: true, path: targetPath };
  }

  /**
   * Add or update the cognistore MCP server entry in an MCP JSON config file.
   */
  async setupMcpConfig(
    configPath: string,
    mcpEntry: Record<string, unknown>
  ): Promise<McpSetupResult> {
    await mkdir(dirname(configPath), { recursive: true });

    if (!(await this.fileExists(configPath))) {
      const config = { mcpServers: { 'cognistore': mcpEntry } };
      await writeFile(
        configPath,
        JSON.stringify(config, null, 2) + '\n',
        'utf-8'
      );
      return { action: 'created', path: configPath };
    }

    const content = await readFile(configPath, 'utf-8');
    const config = JSON.parse(content);

    if (config.mcpServers?.['cognistore']) {
      // Check if already identical
      if (
        JSON.stringify(config.mcpServers['cognistore']) ===
        JSON.stringify(mcpEntry)
      ) {
        return { action: 'skipped', path: configPath };
      }
    }

    await copyFile(
      configPath,
      `${configPath}.bak.${Date.now()}`
    );

    if (!config.mcpServers) {
      config.mcpServers = {};
    }
    config.mcpServers['cognistore'] = mcpEntry;
    await writeFile(
      configPath,
      JSON.stringify(config, null, 2) + '\n',
      'utf-8'
    );
    return { action: 'updated', path: configPath };
  }

  /**
   * Remove a named MCP server entry from a JSON config file.
   */
  async removeMcpEntry(
    configPath: string,
    entryName: string
  ): Promise<McpRemoveResult> {
    if (!(await this.fileExists(configPath))) {
      return { removed: false, path: configPath };
    }

    const content = await readFile(configPath, 'utf-8');
    const config = JSON.parse(content);

    if (!config.mcpServers?.[entryName]) {
      return { removed: false, path: configPath };
    }

    await copyFile(
      configPath,
      `${configPath}.bak.${Date.now()}`
    );
    delete config.mcpServers[entryName];

    // If mcpServers is now empty and it's a standalone mcp-config file, remove the file
    if (
      Object.keys(config.mcpServers).length === 0 &&
      Object.keys(config).length === 1
    ) {
      await unlink(configPath);
    } else {
      await writeFile(
        configPath,
        JSON.stringify(config, null, 2) + '\n',
        'utf-8'
      );
    }

    return { removed: true, path: configPath };
  }

  /**
   * Add or update the cognistore MCP server entry in OpenCode config.
   * OpenCode uses `mcp` (not `mcpServers`) and a different entry format.
   */
  async setupOpenCodeMcp(
    mcpEntry: Record<string, unknown>
  ): Promise<McpSetupResult> {
    const configPath = ConfigManager.OPENCODE_CONFIG;
    await mkdir(dirname(configPath), { recursive: true });

    // Derive the command from the caller's entry rather than hardcoding it: the
    // caller resolves both the pinned npx path (so the MCP child runs on the same
    // Node major as the sidecar) and the pinned package spec (so a stale global
    // install cannot shadow it). Hardcoding silently discarded both.
    const command =
      typeof mcpEntry.command === 'string' && Array.isArray(mcpEntry.args)
        ? [mcpEntry.command, ...(mcpEntry.args as string[])]
        : ['npx', '-y', '@cognistore/mcp-server@latest'];

    const openCodeEntry = {
      type: 'local',
      command,
      enabled: true,
      environment: mcpEntry.env || {},
    };

    if (!(await this.fileExists(configPath))) {
      const config = {
        $schema: 'https://opencode.ai/config.json',
        mcp: { 'cognistore': openCodeEntry },
      };
      await writeFile(
        configPath,
        JSON.stringify(config, null, 2) + '\n',
        'utf-8'
      );
      return { action: 'created', path: configPath };
    }

    const content = await readFile(configPath, 'utf-8');
    const config = JSON.parse(content);

    if (config.mcp?.['cognistore']) {
      if (
        JSON.stringify(config.mcp['cognistore']) ===
        JSON.stringify(openCodeEntry)
      ) {
        return { action: 'skipped', path: configPath };
      }
    }

    await copyFile(configPath, `${configPath}.bak.${Date.now()}`);

    if (!config.mcp) {
      config.mcp = {};
    }
    config.mcp['cognistore'] = openCodeEntry;
    await writeFile(
      configPath,
      JSON.stringify(config, null, 2) + '\n',
      'utf-8'
    );
    return { action: 'updated', path: configPath };
  }

  /**
   * Remove the cognistore MCP server entry from OpenCode config.
   */
  async removeOpenCodeMcp(): Promise<McpRemoveResult> {
    const configPath = ConfigManager.OPENCODE_CONFIG;
    if (!(await this.fileExists(configPath))) {
      return { removed: false, path: configPath };
    }

    const content = await readFile(configPath, 'utf-8');
    const config = JSON.parse(content);

    if (!config.mcp?.['cognistore']) {
      return { removed: false, path: configPath };
    }

    await copyFile(configPath, `${configPath}.bak.${Date.now()}`);
    delete config.mcp['cognistore'];

    await writeFile(
      configPath,
      JSON.stringify(config, null, 2) + '\n',
      'utf-8'
    );
    return { removed: true, path: configPath };
  }

  // Well-known path for Claude settings
  static readonly CLAUDE_SETTINGS = join(homedir(), '.claude', 'settings.json');

  // Single server-scope allow rule that pre-approves EVERY CogniStore MCP tool
  // (current and future) so users don't get a per-tool permission prompt. This is
  // Claude Code's whole-server syntax — the bare `mcp__<server>` form. NOT a glob:
  // `mcp__cognistore__*` is not accepted and would silently re-introduce prompts.
  static readonly COGNISTORE_AUTO_ALLOW_TOOLS = ['mcp__cognistore'];

  // Prefix that identifies the superseded per-tool allow rules (e.g.
  // `mcp__cognistore__getKnowledge`). Note the trailing `__`: it matches every
  // granular cognistore tool rule while sparing the bare server-scope rule
  // `mcp__cognistore` and any non-cognistore or hyphenated-lookalike rule
  // (`mcp__cognistore-plus__x`). Used to migrate legacy installs on re-inject.
  static readonly COGNISTORE_LEGACY_ALLOW_PREFIX = 'mcp__cognistore__';

  // Global enforcement hooks. Script files live under ~/.cognistore/hooks/ (removed
  // on uninstall with the install dir); only JSON entries are injected into the
  // agent settings files.
  static readonly COGNISTORE_HOOKS_DIR = join(homedir(), '.cognistore', 'hooks');
  static readonly CLAUDE_HOOKS_DIR = join(homedir(), '.cognistore', 'hooks', 'claude-code');
  static readonly COPILOT_SCRIPTS_DIR = join(homedir(), '.cognistore', 'hooks', 'copilot');
  // GitHub Copilot CLI reads hook config from ~/.copilot/hooks/.
  static readonly COPILOT_HOOKS_CONFIG = join(homedir(), '.copilot', 'hooks', 'hooks.json');

  /**
   * Inject permission allow rules for CogniStore tools into a settings.json file.
   * Merge-only: never overwrites user rules and touches ONLY `permissions.allow`
   * (a user's `permissions.deny`/`permissions.ask` are never read or modified —
   * deny/ask take precedence over allow in Claude Code, preserving user limits).
   *
   * Also migrates legacy installs: any superseded per-tool rule
   * (`mcp__cognistore__*`) is stripped so the single server-scope rule replaces
   * the old explicit list. Idempotent — returns `skipped` (no backup written)
   * when there is nothing to add AND nothing to strip, so repeated
   * upgrade/redeploy runs don't accumulate `.bak` copies of settings.json.
   *
   * If the file doesn't exist, creates a minimal { permissions: { allow: [...] } } — Claude Code
   * will extend this with its own keys on next run. The format is compatible.
   */
  async injectPermissions(
    settingsPath: string,
    allowRules: string[]
  ): Promise<{ action: 'created' | 'updated' | 'skipped'; path: string }> {
    await mkdir(dirname(settingsPath), { recursive: true });

    if (!(await this.fileExists(settingsPath))) {
      const config = { permissions: { allow: allowRules } };
      await writeFile(settingsPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
      return { action: 'created', path: settingsPath };
    }

    const content = await readFile(settingsPath, 'utf-8');
    const config = JSON.parse(content);

    if (!config.permissions) {
      config.permissions = {};
    }
    if (!Array.isArray(config.permissions.allow)) {
      config.permissions.allow = [];
    }

    const prefix = ConfigManager.COGNISTORE_LEGACY_ALLOW_PREFIX;
    const legacy = config.permissions.allow.filter(
      (rule: string) => typeof rule === 'string' && rule.startsWith(prefix)
    );
    const existing = new Set(config.permissions.allow);
    const toAdd = allowRules.filter(rule => !existing.has(rule));

    if (toAdd.length === 0 && legacy.length === 0) {
      return { action: 'skipped', path: settingsPath };
    }

    await copyFile(settingsPath, `${settingsPath}.bak.${Date.now()}`);
    if (legacy.length > 0) {
      config.permissions.allow = config.permissions.allow.filter(
        (rule: string) => !(typeof rule === 'string' && rule.startsWith(prefix))
      );
    }
    config.permissions.allow.push(...toAdd);
    await writeFile(settingsPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return { action: 'updated', path: settingsPath };
  }

  /**
   * Remove CogniStore permission allow rules from a settings.json file.
   * Removes exact matches for the given rules AND every legacy per-tool rule
   * (`mcp__cognistore__*`), so uninstall clears both the current server-scope
   * rule and any leftover granular rules from older installs. User rules and
   * `permissions.deny`/`permissions.ask` are left untouched. No-op (no backup)
   * when nothing matches.
   */
  async removePermissions(
    settingsPath: string,
    rulesToRemove: string[]
  ): Promise<{ removed: boolean; path: string }> {
    if (!(await this.fileExists(settingsPath))) {
      return { removed: false, path: settingsPath };
    }

    const content = await readFile(settingsPath, 'utf-8');
    const config = JSON.parse(content);

    if (!Array.isArray(config.permissions?.allow)) {
      return { removed: false, path: settingsPath };
    }

    const removeSet = new Set(rulesToRemove);
    const prefix = ConfigManager.COGNISTORE_LEGACY_ALLOW_PREFIX;
    const before = config.permissions.allow.length;
    config.permissions.allow = config.permissions.allow.filter(
      (rule: string) =>
        !(removeSet.has(rule) || (typeof rule === 'string' && rule.startsWith(prefix)))
    );

    if (config.permissions.allow.length === before) {
      return { removed: false, path: settingsPath };
    }

    await copyFile(settingsPath, `${settingsPath}.bak.${Date.now()}`);
    await writeFile(settingsPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return { removed: true, path: settingsPath };
  }

  // ─── Global enforcement hooks ──────────────────────────────────────────

  /**
   * Copy a directory of *.sh hook scripts into a destination dir and make them
   * executable. Returns the destination dir, or null if the source is missing.
   */
  private async copyHookScripts(srcDir: string, destDir: string): Promise<string | null> {
    try {
      await access(srcDir);
    } catch {
      return null;
    }
    await mkdir(destDir, { recursive: true });
    const files = await readdir(srcDir);
    for (const file of files) {
      if (!file.endsWith('.sh')) continue;
      const dest = join(destDir, file);
      await copyFile(join(srcDir, file), dest);
      await chmod(dest, 0o755);
    }
    return destDir;
  }

  /**
   * Install Claude Code hook scripts into ~/.cognistore/hooks/claude-code/.
   * Returns the absolute scripts dir (or null if templates are missing).
   */
  async setupHooks(templatesDir: string): Promise<string | null> {
    return this.copyHookScripts(
      join(templatesDir, 'hooks', 'claude-code'),
      ConfigManager.CLAUDE_HOOKS_DIR
    );
  }

  /**
   * Build the Claude Code settings.json `hooks` object pointing at the scripts in
   * `hooksDir`. Event → array of matcher-groups, each running one cognistore script.
   */
  static buildClaudeHookConfig(hooksDir: string): Record<string, unknown[]> {
    const cmd = (name: string, timeout = 5) => ({
      type: 'command',
      command: join(hooksDir, name),
      timeout,
    });
    const group = (matcher: string | undefined, name: string, timeout?: number) =>
      matcher ? { matcher, hooks: [cmd(name, timeout)] } : { hooks: [cmd(name, timeout)] };

    const EDIT = 'Edit|Write|MultiEdit|Bash|NotebookEdit';
    return {
      UserPromptSubmit: [group(undefined, 'user-prompt-check.sh')],
      PreToolUse: [
        group('Edit|Write|Bash|MultiEdit|Agent|NotebookEdit|EnterPlanMode', 'pre-tool-check.sh'),
        group('Write|Edit|MultiEdit|NotebookEdit', 'pre-plan-file-check.sh'),
        group('EnterPlanMode', 'pre-enter-plan-check.sh'),
        group('mcp__cognistore__createPlan', 'pre-create-plan-check.sh'),
        group('ExitPlanMode', 'pre-exit-plan-check.sh'),
      ],
      PostToolUse: [
        group('mcp__cognistore__getKnowledge', 'post-query-marker.sh'),
        group('mcp__cognistore__createPlan', 'post-create-plan-marker.sh'),
        group('ExitPlanMode', 'post-plan-check.sh'),
        group(EDIT, 'post-edit-task-sync.sh'),
        group('mcp__cognistore__updatePlanTask|mcp__cognistore__updatePlanTasks', 'post-task-update-marker.sh'),
        group('mcp__cognistore__updatePlan', 'post-update-plan-cleanup.sh'),
        group(EDIT, 'post-capture-nudge.sh'),
      ],
      // Stop hook queries SQLite — 15s to survive cold-start / slow disk.
      Stop: [group(undefined, 'stop-reminder.sh', 15)],
    };
  }

  /** A settings.json hook matcher-group is "ours" if any of its commands live under our hooks dir. */
  private isCognistoreHookGroup(group: unknown): boolean {
    const hooks = (group as { hooks?: { command?: unknown }[] })?.hooks;
    if (!Array.isArray(hooks)) return false;
    return hooks.some(
      (h) => typeof h?.command === 'string' && h.command.startsWith(ConfigManager.COGNISTORE_HOOKS_DIR)
    );
  }

  /**
   * Inject CogniStore hooks into a Claude settings.json `hooks` key. Merge-only and
   * idempotent: strips any prior CogniStore matcher-groups (identified by command
   * path) before appending the current set, so re-runs and upgrades stay clean and
   * user-defined hooks are preserved.
   */
  async injectHooks(
    settingsPath: string,
    hookConfig: Record<string, unknown[]>
  ): Promise<{ action: 'created' | 'updated' | 'skipped'; path: string }> {
    await mkdir(dirname(settingsPath), { recursive: true });

    if (!(await this.fileExists(settingsPath))) {
      await writeFile(settingsPath, JSON.stringify({ hooks: hookConfig }, null, 2) + '\n', 'utf-8');
      return { action: 'created', path: settingsPath };
    }

    const config = JSON.parse(await readFile(settingsPath, 'utf-8'));
    const before = JSON.stringify(config.hooks ?? {});
    const hooks: Record<string, unknown[]> = { ...(config.hooks ?? {}) };

    for (const [event, groups] of Object.entries(hookConfig)) {
      const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
      const userGroups = existing.filter((g) => !this.isCognistoreHookGroup(g));
      hooks[event] = [...userGroups, ...groups];
    }
    // Strip CogniStore groups from events that existed in a prior install but are
    // no longer emitted by buildClaudeHookConfig (e.g. a hook event was renamed or
    // removed in an upgrade). Without this, stale groups accumulate across upgrades
    // and reference scripts that no longer exist at their old paths.
    for (const event of Object.keys(hooks)) {
      if (event in hookConfig) continue;
      const filtered = (hooks[event] as unknown[]).filter((g) => !this.isCognistoreHookGroup(g));
      if (filtered.length === 0) {
        delete hooks[event];
      } else {
        hooks[event] = filtered;
      }
    }

    if (JSON.stringify(hooks) === before) {
      return { action: 'skipped', path: settingsPath };
    }

    await copyFile(settingsPath, `${settingsPath}.bak.${Date.now()}`);
    config.hooks = hooks;
    await writeFile(settingsPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return { action: 'updated', path: settingsPath };
  }

  /**
   * Remove only CogniStore hook entries from a Claude settings.json. User-defined
   * hooks (different command paths) are left untouched.
   */
  async removeHooks(settingsPath: string): Promise<{ removed: boolean; path: string }> {
    if (!(await this.fileExists(settingsPath))) {
      return { removed: false, path: settingsPath };
    }
    const config = JSON.parse(await readFile(settingsPath, 'utf-8'));
    if (!config.hooks || typeof config.hooks !== 'object') {
      return { removed: false, path: settingsPath };
    }

    const before = JSON.stringify(config.hooks);
    for (const event of Object.keys(config.hooks)) {
      if (!Array.isArray(config.hooks[event])) continue;
      config.hooks[event] = config.hooks[event].filter(
        (g: unknown) => !this.isCognistoreHookGroup(g)
      );
      if (config.hooks[event].length === 0) delete config.hooks[event];
    }
    if (Object.keys(config.hooks).length === 0) delete config.hooks;

    if (JSON.stringify(config.hooks ?? {}) === before) {
      return { removed: false, path: settingsPath };
    }

    await copyFile(settingsPath, `${settingsPath}.bak.${Date.now()}`);
    await writeFile(settingsPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return { removed: true, path: settingsPath };
  }

  /**
   * Install GitHub Copilot CLI reminder hooks: copy scripts into
   * ~/.cognistore/hooks/copilot/ and merge a hooks config into ~/.copilot/hooks/hooks.json.
   * Reminder-only (Copilot cannot block). Idempotent and preserves user hooks.
   */
  async setupCopilotHooks(templatesDir: string): Promise<{ action: 'created' | 'updated' | 'skipped'; path: string } | null> {
    const scriptsDir = await this.copyHookScripts(
      join(templatesDir, 'hooks', 'copilot'),
      ConfigManager.COPILOT_SCRIPTS_DIR
    );
    if (!scriptsDir) return null;

    const entry = (name: string) => ({
      type: 'command',
      bash: join(scriptsDir, name),
      timeoutSec: 5,
    });
    const cognistoreHooks: Record<string, unknown[]> = {
      userPromptSubmitted: [entry('user-prompt-check.sh')],
      preToolUse: [entry('pre-tool-check.sh')],
      postToolUse: [entry('post-tool-marker.sh')],
      sessionEnd: [entry('session-end-reminder.sh')],
    };

    const configPath = ConfigManager.COPILOT_HOOKS_CONFIG;
    await mkdir(dirname(configPath), { recursive: true });

    if (!(await this.fileExists(configPath))) {
      await writeFile(configPath, JSON.stringify({ version: 1, hooks: cognistoreHooks }, null, 2) + '\n', 'utf-8');
      return { action: 'created', path: configPath };
    }

    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    if (typeof config.version !== 'number') config.version = 1;
    const before = JSON.stringify(config.hooks ?? {});
    const hooks: Record<string, unknown[]> = { ...(config.hooks ?? {}) };
    for (const [event, entries] of Object.entries(cognistoreHooks)) {
      const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
      const userEntries = existing.filter((e) => !this.isCopilotCognistoreEntry(e));
      hooks[event] = [...userEntries, ...entries];
    }
    if (JSON.stringify(hooks) === before) {
      return { action: 'skipped', path: configPath };
    }
    await copyFile(configPath, `${configPath}.bak.${Date.now()}`);
    config.hooks = hooks;
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return { action: 'updated', path: configPath };
  }

  /** A Copilot hook entry is "ours" if its bash path lives under our hooks dir. */
  private isCopilotCognistoreEntry(entry: unknown): boolean {
    const bash = (entry as { bash?: unknown })?.bash;
    return typeof bash === 'string' && bash.startsWith(ConfigManager.COGNISTORE_HOOKS_DIR);
  }

  /**
   * Remove CogniStore reminder hooks from ~/.copilot/hooks/hooks.json. Script files
   * live under the install dir and are removed with it. User hooks are preserved.
   */
  async removeCopilotHooks(): Promise<{ removed: boolean; path: string }> {
    const configPath = ConfigManager.COPILOT_HOOKS_CONFIG;
    if (!(await this.fileExists(configPath))) {
      return { removed: false, path: configPath };
    }
    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    if (!config.hooks || typeof config.hooks !== 'object') {
      return { removed: false, path: configPath };
    }
    const before = JSON.stringify(config.hooks);
    for (const event of Object.keys(config.hooks)) {
      if (!Array.isArray(config.hooks[event])) continue;
      config.hooks[event] = config.hooks[event].filter(
        (e: unknown) => !this.isCopilotCognistoreEntry(e)
      );
      if (config.hooks[event].length === 0) delete config.hooks[event];
    }
    if (JSON.stringify(config.hooks) === before) {
      return { removed: false, path: configPath };
    }
    // If only the version key remains and no hooks, remove the file entirely.
    // Create a backup first — consistent with every other write path in this class.
    if (Object.keys(config.hooks).length === 0) {
      await copyFile(configPath, `${configPath}.bak.${Date.now()}`);
      await unlink(configPath);
      return { removed: true, path: configPath };
    }
    await copyFile(configPath, `${configPath}.bak.${Date.now()}`);
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return { removed: true, path: configPath };
  }

  /**
   * Find and remove old 'knowledge' (not 'cognistore') MCP entries from known config files.
   */
  async removeOldKnowledgeMcp(): Promise<{ cleaned: string[] }> {
    const cleaned: string[] = [];
    const targets = [ConfigManager.MCP_CONFIG, ConfigManager.CLAUDE_JSON];

    for (const configPath of targets) {
      try {
        const result = await this.removeMcpEntry(configPath, 'knowledge');
        if (result.removed) {
          cleaned.push(configPath);
        }
      } catch {
        // File doesn't exist or isn't valid JSON - skip
      }
    }

    return { cleaned };
  }

  /**
   * Install OpenCode skills from templates.
   * Copies SKILL.md files for cognistore-query, cognistore-plan, cognistore-capture
   * into ~/.config/opencode/skills/ (no hooks subdirectories).
   */
  async setupOpenCodeSkills(templatesDir: string): Promise<void> {
    const skillNames = ['cognistore-query', 'cognistore-capture', 'cognistore-plan'];
    for (const name of skillNames) {
      const srcDir = join(templatesDir, 'skills', 'opencode', name);
      const destDir = join(ConfigManager.OPENCODE_SKILLS_DIR, name);
      try {
        await access(srcDir);
      } catch {
        continue; // source doesn't exist, skip
      }
      await mkdir(destDir, { recursive: true });
      const skillFile = join(srcDir, 'SKILL.md');
      try {
        await access(skillFile);
        await copyFile(skillFile, join(destDir, 'SKILL.md'));
      } catch {
        // SKILL.md not found, skip
      }
    }
  }

  /**
   * Install OpenCode plugins from templates.
   * Copies cognistore-plan-enforcement.ts into ~/.config/opencode/plugins/
   */
  async setupOpenCodePlugins(templatesDir: string): Promise<void> {
    const srcFile = join(templatesDir, 'plugins', 'opencode', 'cognistore-plan-enforcement.ts');
    try {
      await access(srcFile);
    } catch {
      return; // source doesn't exist, skip
    }
    await mkdir(ConfigManager.OPENCODE_PLUGINS_DIR, { recursive: true });
    await copyFile(srcFile, join(ConfigManager.OPENCODE_PLUGINS_DIR, 'cognistore-plan-enforcement.ts'));
  }

  /**
   * Remove OpenCode skill directories from ~/.config/opencode/skills/
   */
  removeOpenCodeSkills(): void {
    for (const name of ['cognistore-query', 'cognistore-capture', 'cognistore-plan']) {
      const dir = join(ConfigManager.OPENCODE_SKILLS_DIR, name);
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  /**
   * Remove cognistore-plan-enforcement.ts from ~/.config/opencode/plugins/
   */
  removeOpenCodePlugins(): void {
    const pluginFile = join(ConfigManager.OPENCODE_PLUGINS_DIR, 'cognistore-plan-enforcement.ts');
    if (existsSync(pluginFile)) {
      unlinkSync(pluginFile);
    }
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }
}
