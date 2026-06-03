import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, '../../../../apps/mcp-server/package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

test.describe('mcp-server package.json validation', () => {
  // npm-canonical bin form is a relative path WITHOUT a leading "./". Newer npm
  // (Node 22/24+) treats "./dist/index.js" as invalid and strips the "./" on
  // publish (emitting a warning the CI dry-run flags). Enforce the canonical form.
  test('bin paths are relative without a leading ./', () => {
    expect(pkg.bin).toBeTruthy();
    for (const [name, filepath] of Object.entries(pkg.bin as Record<string, string>)) {
      expect(filepath, `bin["${name}"] must NOT start with ./ (newer npm strips it)`).not.toMatch(/^\.\//);
      expect(filepath, `bin["${name}"] must be a relative dist path`).toMatch(/^dist\//);
    }
  });

  test('repository.url has correct git+https format', () => {
    expect(pkg.repository?.url).toMatch(/^git\+https:\/\//);
    expect(pkg.repository?.url).toMatch(/\.git$/);
  });

  test('required fields exist and are valid', () => {
    expect(pkg.name).toBeTruthy();
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(pkg.main).toBeTruthy();
    expect(pkg.files).toBeInstanceOf(Array);
    expect(pkg.files.length).toBeGreaterThan(0);
    expect(pkg.private).toBe(false);
    expect(pkg.description).toBeTruthy();
    expect(pkg.license).toBeTruthy();
  });

  test('main field starts with ./', () => {
    expect(pkg.main).toMatch(/^\.\//);
  });

  test('name is a scoped @cognistore package', () => {
    expect(pkg.name).toMatch(/^@cognistore\//);
  });
});
