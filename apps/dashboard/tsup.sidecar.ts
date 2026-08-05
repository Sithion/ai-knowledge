import { defineConfig } from 'tsup';
import pkg from './package.json';

export default defineConfig({
  entry: ['server/index.ts'],
  // Inline the version at build time. Resolving it at runtime from a package.json
  // next to __dirname is unreliable: the packaged sidecar runs from
  // <app>/Resources/dist-server/ where no package.json exists, which silently
  // pinned the app at "0.0.0" and disabled the whole upgrade system.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
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
