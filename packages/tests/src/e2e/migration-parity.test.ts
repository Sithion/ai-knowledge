import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMBEDDED_MIGRATIONS } from '@cognistore/core';

/**
 * The same migration exists twice: as a .sql file (run by the dashboard sidecar,
 * which ships the migrations directory) and as an embedded string (run by the
 * bundled MCP server via npx, which does not). A drift between the two means the
 * two processes sharing ~/.cognistore/knowledge.db stamp the same schema_version
 * on two different schemas — and the second one to run skips the migration it
 * actually needed.
 *
 * Comments may differ; statements may not.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '../../../core/src/db/migrations');

/** Mirrors the runner's own parser (migrate.ts step 5), plus whitespace folding. */
function statementsOf(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter((s) => s.length > 0);
}

test.describe('@e2e migration parity (disk .sql vs embedded)', () => {
  test('every embedded migration has a matching .sql file', () => {
    for (const version of Object.keys(EMBEDDED_MIGRATIONS)) {
      expect(existsSync(resolve(MIGRATIONS_DIR, `${version}.sql`)), `missing ${version}.sql`).toBe(true);
    }
  });

  test('the statements are identical in both copies', () => {
    for (const [version, embedded] of Object.entries(EMBEDDED_MIGRATIONS)) {
      const disk = readFileSync(resolve(MIGRATIONS_DIR, `${version}.sql`), 'utf-8');
      expect(statementsOf(embedded), `migration ${version} drifted`).toEqual(statementsOf(disk));
    }
  });

  test('no statement-splitting hazard: a semicolon inside a comment or literal', () => {
    // The runner strips only WHOLE comment lines and then splits on ';'. A
    // semicolon in a trailing comment or a string literal cuts a statement in
    // half and aborts DB open for the sidecar AND every MCP server process.
    for (const [version, embedded] of Object.entries(EMBEDDED_MIGRATIONS)) {
      for (const line of embedded.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('--')) continue;
        const commentAt = trimmed.indexOf('--');
        expect(commentAt === -1 || !trimmed.slice(commentAt).includes(';'),
          `migration ${version}: semicolon inside a trailing comment: ${trimmed}`).toBe(true);
        const literals = trimmed.match(/'[^']*'/g) ?? [];
        for (const literal of literals) {
          expect(literal.includes(';'),
            `migration ${version}: semicolon inside a string literal: ${trimmed}`).toBe(false);
        }
      }
    }
  });
});
