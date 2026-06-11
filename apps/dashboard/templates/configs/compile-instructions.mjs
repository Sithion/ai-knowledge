#!/usr/bin/env node
/**
 * Compile platform-specific instruction files from a single source of truth.
 *
 * Reads _base-instructions.md and generates:
 *   claude-code-instructions.md
 *   copilot-instructions.md
 *   opencode-instructions.md
 *
 * Conditional blocks use: <!-- IF:platform1,platform2 --> ... <!-- ENDIF -->
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const basePath = resolve(__dirname, '_base-instructions.md');
const base = readFileSync(basePath, 'utf-8');

const platforms = ['claude-code', 'copilot', 'opencode'];

// Each platform exposes MCP tools under its own naming convention. The base
// template uses the Claude Code form (mcp__cognistore__<tool>) as canonical;
// it is rewritten per platform here. Empirically verified from real session
// logs: Copilot CLI = cognistore-<tool>, OpenCode = cognistore_<tool>.
const TOOL_PREFIX = {
  'claude-code': 'mcp__cognistore__', // identity — no-op
  copilot: 'cognistore-',
  opencode: 'cognistore_',
};

for (const platform of platforms) {
  let output = '';
  let include = true;
  const stack = []; // nested IF support

  for (const line of base.split('\n')) {
    const ifMatch = line.match(/^<!-- IF:([\w,-]+) -->$/);
    const endifMatch = line.match(/^<!-- ENDIF -->$/);

    if (ifMatch) {
      const allowed = ifMatch[1].split(',').map(s => s.trim());
      stack.push(include); // save parent state
      include = include && allowed.includes(platform);
    } else if (endifMatch) {
      include = stack.pop() ?? true;
    } else if (include) {
      output += line + '\n';
    }
  }

  // Remove trailing blank lines but keep final newline
  output = output.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

  // Rewrite tool names to the platform's MCP naming convention (no-op for claude-code).
  output = output.replaceAll('mcp__cognistore__', TOOL_PREFIX[platform]);

  const outPath = resolve(__dirname, `${platform}-instructions.md`);
  writeFileSync(outPath, output);
  console.log(`  ✓ ${platform}-instructions.md (${output.split('\n').length} lines)`);
}
