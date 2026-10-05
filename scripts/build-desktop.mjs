// Bundles the Electron main process and preload script with esbuild.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', sourcemap: true, logLevel: 'info', legalComments: 'none' };

rmSync('dist-electron', { recursive: true, force: true });

mkdirSync('dist-electron/main', { recursive: true });

await build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist-electron/main/main.cjs', external: ['electron'] });
// Sandboxed preload: must be a single self-contained CJS file that only requires 'electron'.
await build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist-electron/preload/preload.cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/preload/voice-preload.ts'], outfile: 'dist-electron/preload/voice-preload.cjs', external: ['electron'] });
// Hidden voice host page (offline speech recognition), served from drift-app://voice/.
await build({ ...common, platform: 'browser', target: 'chrome130', format: 'iife', entryPoints: ['src/voice/voice.ts'], outfile: 'dist-electron/voice/voice.js', sourcemap: false });
cpSync('src/voice/index.html', 'dist-electron/voice/index.html');
cpSync('src/main/fallback', 'dist-electron/main/fallback', { recursive: true });
if (watch) console.log('watch mode is not implemented; re-run the build');
