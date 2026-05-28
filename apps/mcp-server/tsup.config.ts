import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
  // Bundle all workspace packages (sdk, core, embeddings, shared) inline
  // Keep npm packages and native modules as external dependencies
  noExternal: [
    '@cognistore/sdk',
    '@cognistore/shared',
    '@cognistore/core',
    '@cognistore/embeddings',
    '@cognistore/providers',
  ],
  external: [
    'better-sqlite3',
    'sqlite-vec',
    'drizzle-orm',
    '@modelcontextprotocol/sdk',
    'zod',
  ],
});
