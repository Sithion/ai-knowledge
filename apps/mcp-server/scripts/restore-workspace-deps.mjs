// Restore package.json from the backup created by strip-workspace-deps.mjs
// so the working copy isn't left mutated. Run AFTER `pnpm pack` / `pnpm
// publish`. Safe to run when no backup exists (no-op).
import { existsSync, renameSync } from 'node:fs';

const pkgPath = new URL('../package.json', import.meta.url);
const backupPath = new URL('../package.json.bak', import.meta.url);

if (existsSync(backupPath)) {
  renameSync(backupPath, pkgPath);
  console.log('restored package.json from backup');
}
