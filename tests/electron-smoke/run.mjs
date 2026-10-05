// Electron smoke test: launches the real app (main + sandboxed preload + protocols)
// and drives the renderer via Playwright. Requires a display (use xvfb-run on Linux).
// This is NOT a Windows smoke test; see docs/backend-handoff.md for the Windows checklist.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-smoke-'));
const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};

// Fake OBS (same double as the integration tests), bundled on the fly.
await build({ entryPoints: [path.join(root, 'tests/helpers/fakeObs.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(tmp, 'fakeObs.cjs'), logLevel: 'silent' });
const { FakeObs } = require(path.join(tmp, 'fakeObs.cjs'));
const clip = path.join(tmp, 'media', 'smoke.mp4');
fs.mkdirSync(path.dirname(clip), { recursive: true });
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);
const obs = new FakeObs({ onSaveReplay: () => clip });
const port = await obs.start();

const args = [root];
if (process.getuid?.() === 0) args.unshift('--no-sandbox'); // Chromium refuses to run as root otherwise; renderer sandbox flag stays on.
const app = await electron.launch({ args, env: { ...process.env, DRIFT_USER_DATA: path.join(tmp, 'userData'), ELECTRON_ENABLE_LOGGING: '0' } });
try {
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  check('window loads drift-app:// origin', win.url().startsWith('drift-app://renderer/'), win.url());

  const isolation = await win.evaluate(() => ({ require: typeof window.require, process: typeof window.process, bridge: typeof window.driftDesktop, keys: Object.keys(window.driftDesktop ?? {}) }));
  check('renderer has no Node globals', isolation.require === 'undefined' && isolation.process === 'undefined');
  check('bridge exposes only contractVersion/invoke/on', JSON.stringify(isolation.keys.sort()) === JSON.stringify(['contractVersion', 'invoke', 'on']), isolation.keys.join(','));

  const caps = await win.evaluate(() => window.driftDesktop.invoke('system.getCapabilities', {}));
  check('system.getCapabilities over IPC', caps.ok && caps.data.mode === 'desktop' && caps.data.contractVersion === '1.0.0');

  const unknown = await win.evaluate(() => window.driftDesktop.invoke('fs.rm', { path: '/' }));
  check('unknown operations rejected', !unknown.ok && unknown.error.code === 'VALIDATION');
  const invalid = await win.evaluate(() => window.driftDesktop.invoke('obs.setScene', { sceneName: 1, extra: true }));
  check('invalid payloads rejected in main', !invalid.ok && invalid.error.code === 'VALIDATION');

  const upd = await win.evaluate((p) => window.driftDesktop.invoke('settings.update', { obs: { port: p, autoConnect: false }, media: { libraryDirectory: null } }), port);
  check('settings.update persists', upd.ok && upd.data.obs.port === port);

  const events = await win.evaluate(() => {
    window.__events = [];
    for (const e of ['connection.changed', 'clip.added', 'replay.saved']) window.driftDesktop.on(e, (p) => window.__events.push(e));
    return true;
  });
  const conn = await win.evaluate(() => window.driftDesktop.invoke('obs.connect', {}));
  check('obs.connect from renderer', conn.ok && conn.data.state === 'connected', conn.ok ? conn.data.state : conn.error.message);
  await win.evaluate(() => window.driftDesktop.invoke('obs.startReplayBuffer', {}));
  const save = await win.evaluate(() => window.driftDesktop.invoke('obs.saveReplay', {}));
  check('obs.saveReplay accepted', save.ok, save.ok ? save.data.requestId : save.error.message);
  await win.waitForFunction(() => window.__events.includes('clip.added'), null, { timeout: 20000 });
  check('replay.saved and clip.added events reach renderer', true);

  const list = await win.evaluate(() => window.driftDesktop.invoke('clips.list', { search: null, gameTitle: null, sessionId: null, favoritesOnly: false, tags: [], source: null, limit: 10, offset: 0 }));
  const c = list.ok ? list.data.items[0] : null;
  check('clip indexed', !!c && c.source === 'replay');

  const media = await win.evaluate(async (c) => {
    const thumb = await fetch(c.thumbnailUrl);
    const ranged = await fetch(c.mediaUrl, { headers: { Range: 'bytes=0-99' } });
    const missing = await fetch('drift-media://clip/clip_doesnotexist');
    const traversal = await fetch('drift-app://renderer/../../package.json');
    return { thumb: thumb.status, type: thumb.headers.get('content-type'), ranged: ranged.status, len: (await ranged.arrayBuffer()).byteLength, missing: missing.status, traversal: traversal.status };
  }, c);
  check('drift-media thumbnail served', media.thumb === 200 && media.type === 'image/jpeg');
  check('drift-media supports Range (206)', media.ranged === 206 && media.len === 100, `${media.ranged}/${media.len}`);
  check('unknown media ids 404', media.missing === 404);
  check('path traversal blocked', media.traversal === 403 || media.traversal === 404, String(media.traversal));

  const videoPlays = await win.evaluate(async (url) => {
    const v = document.createElement('video');
    v.muted = true;
    v.src = url;
    document.body.appendChild(v);
    return await new Promise((r) => {
      v.onloadedmetadata = () => r(v.duration);
      v.onerror = () => r(-1);
      setTimeout(() => r(-2), 10000);
    });
  }, c.playbackUrl);
  check('<video> plays clip via drift-media://', videoPlays > 2.5, String(videoPlays));

  const before = win.url();
  await win.evaluate(() => { window.location.href = 'https://example.com/'; });
  await win.waitForTimeout(500);
  check('external navigation blocked', win.url() === before, win.url());
  const popup = await win.evaluate(() => window.open('https://example.com') === null);
  check('window.open denied', popup);

  // Inline script injection must be blocked by the CSP served with drift-app:// responses.
  const csp = await win.evaluate(async () => {
    const violations = [];
    document.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective));
    window.__inlineRan = false;
    const s = document.createElement('script');
    s.textContent = 'window.__inlineRan = true';
    document.body.appendChild(s);
    await new Promise((r) => setTimeout(r, 200));
    return { ran: window.__inlineRan, violations };
  });
  check('CSP blocks inline script', !csp.ran && csp.violations.some((v) => v.startsWith('script-src')), JSON.stringify(csp));
} finally {
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 10000))]);
  await obs.stop();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
