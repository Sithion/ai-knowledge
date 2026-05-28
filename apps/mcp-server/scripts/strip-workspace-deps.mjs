// Remove the workspace-only devDependencies from package.json so the resulting
// tarball is installable by plain npm. The packages listed here
// (@cognistore/sdk, @cognistore/shared) are bundled into dist/index.js by tsup
// (see tsup.config.ts noExternal), so consumers never need them at runtime;
// they only appear in devDependencies for local IDE/build resolution.
//
// Run this BEFORE `pnpm pack` / `pnpm publish` and then run
// restore-workspace-deps.mjs after to put the working copy back.
//
// Why a standalone script and not `prepack` / `prepublishOnly`: pnpm v9 does
// not run npm package-lifecycle scripts during `pack` or `publish`. The
// publish workflow invokes this script directly.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const STRIPPED = ['@cognistore/sdk', '@cognistore/shared'];
const pkgPath = new URL('../package.json', import.meta.url);
const backupPath = new URL('../package.json.bak', import.meta.url);

copyFileSync(pkgPath, backupPath);
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
for (const name of STRIPPED) {
  delete pkg.devDependencies?.[name];
}
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`stripped ${STRIPPED.join(', ')} from devDependencies for publish`);
