#!/usr/bin/env node
// Asserts that every release-driving version source is in sync.
//
// The desktop publish (publish.yml) derives the release tag from
// apps/dashboard/package.json and builds the binary from Cargo.toml, while the
// PR `version-check` job compares the root package.json. If these drift, the
// publish rebuilds an already-released version and fails uploading its assets
// ("ReleaseAsset already_exists"). This check catches that drift at PR time.
//
// The internal workspace packages (packages/*) are intentionally NOT checked —
// they are private and versioned independently of the app/release.
//
// Run locally: `pnpm check:version` (or `node scripts/check-release-version.mjs`).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const jsonVersion = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8')).version;

// Mirror bump-version.sh: the `[package]` version is the first line-anchored
// `version = "..."` in Cargo.toml. Dependency tables may carry their own
// `version =` keys, so take the FIRST match only — never a global scan.
const cargoVersion = (rel) => {
  const match = readFileSync(join(root, rel), 'utf8').match(/^version = "(.+)"$/m);
  return match ? match[1] : undefined;
};

const sources = {
  'package.json': jsonVersion('package.json'),
  'apps/dashboard/package.json': jsonVersion('apps/dashboard/package.json'),
  'apps/mcp-server/package.json': jsonVersion('apps/mcp-server/package.json'),
  'apps/dashboard/src-tauri/Cargo.toml': cargoVersion('apps/dashboard/src-tauri/Cargo.toml'),
};

const unique = [...new Set(Object.values(sources))];

if (unique.length !== 1) {
  console.error('Release version sources are OUT OF SYNC:\n');
  for (const [file, version] of Object.entries(sources)) {
    console.error(`  ${version ?? '(unreadable)'}\t${file}`);
  }
  console.error('\nAll release-driving versions must match. Run: pnpm bump <version>');
  process.exit(1);
}

console.log(`✓ Release version sources are in sync at ${unique[0]}`);
