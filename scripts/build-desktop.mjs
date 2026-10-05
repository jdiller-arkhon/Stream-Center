// Bundles the Electron main process and preload script with esbuild.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', sourcemap: true, logLevel: 'info', legalComments: 'none' };

rmSync('dist/main', { recursive: true, force: true });
rmSync('dist/preload', { recursive: true, force: true });
mkdirSync('dist/main', { recursive: true });

await build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.cjs', external: ['electron'] });
// Sandboxed preload: must be a single self-contained CJS file that only requires 'electron'.
await build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.cjs', external: ['electron'] });
cpSync('src/main/fallback', 'dist/main/fallback', { recursive: true });
if (watch) console.log('watch mode is not implemented; re-run the build');
