import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['server/index.ts'],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  outDir: 'sidecar-bundle/dist-server',
  clean: true,
  splitting: false,
  // Mark native modules as external (won't be bundled)
  external: [
    'better-sqlite3',
    'sqlite-vec',
    // Node builtins are auto-external with platform: 'node'
  ],
  // Bundle everything EXCEPT externals — this regex excludes the externals
  noExternal: [/^(?!better-sqlite3|sqlite-vec).*/],
  banner: {
    js: `import { createRequire as __bundleRequire } from 'module'; const require = __bundleRequire(import.meta.url);`,
  },
});
