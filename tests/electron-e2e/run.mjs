// End-to-end test of the real desktop app: Electron main + sandboxed preload + built
// renderer, driven through the UI with Playwright, against a fake obs-websocket v5
// server and real FFmpeg. Every check verifies both the UI and the real effect.
//
// Linux CI/dev: xvfb-run -a node tests/electron-e2e/run.mjs   (after npm run build && npm run desktop:build)
// This is not a Windows smoke test: see docs/backend-handoff.md for the Windows checklist.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-e2e-'));
const shots = process.env.DRIFT_E2E_SCREENSHOTS ?? path.join(tmp, 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};
const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', f]).toString());
const until = async (fn, ms = 20000, label = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
};
const clip = (file, seconds, size = '1280x720') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-metadata', `comment=${path.basename(file)} ${Date.now()}`, file]); // unique bytes: real replays differ, identical files are (correctly) de-duplicated
  return file;
};

// ---- fixtures: fake OBS (password protected), a "game" executable, media, test hooks
await build({ entryPoints: [path.join(root, 'tests/helpers/fakeObs.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(tmp, 'fakeObs.cjs'), logLevel: 'silent' });
const { FakeObs } = require(path.join(tmp, 'fakeObs.cjs'));
let replayN = 0;
const obs = new FakeObs({ password: 'hunter2', onSaveReplay: () => clip(path.join(tmp, 'obs', `Replay ${++replayN}.mp4`), 6) });
const port = await obs.start();
const game = path.join(tmp, 'games', `e2e-game-${process.pid % 10000}`);
fs.mkdirSync(path.dirname(game), { recursive: true });
fs.writeFileSync(game, `#!/bin/sh\necho launched > "${game}.marker"\nsleep 60\n`);
fs.chmodSync(game, 0o755);
const library = path.join(tmp, 'Drift');
const pickFile = path.join(tmp, 'pick.json');
const openLog = path.join(tmp, 'opened.log');
fs.writeFileSync(pickFile, '[]');

// "Clip that" is spoken into a fake microphone (Chromium switches) when a TTS voice is available.
let voiceWav = null;
try {
  const raw = path.join(tmp, 'clip-that-raw.wav');
  execFileSync('flite', ['-t', 'clip that', '-o', raw]);
  voiceWav = path.join(tmp, 'clip-that.wav');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-i', raw, '-filter_complex', '[0]atrim=duration=1.5[s1];[0]atrim=duration=2.5[s2];[1]aresample=16000[v];[s1][v][s2]concat=n=3:v=0:a=1', '-ac', '1', '-ar', '16000', voiceWav]);
} catch {
  voiceWav = null;
}
const args = [root];
if (voiceWav) args.unshift('--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${voiceWav}`);
if (process.getuid?.() === 0) args.unshift('--no-sandbox'); // Chromium refuses root otherwise; the renderer sandbox flag stays on
const app = await electron.launch({
  args,
  env: { ...process.env, DRIFT_USER_DATA: path.join(tmp, 'userData'), DRIFT_TEST_MODE: '1', DRIFT_TEST_PICK_FILE: pickFile, DRIFT_TEST_OPEN_LOG: openLog },
});
const errors = [];
let page;
try {
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  const nav = async (name) => {
    await page.locator('nav[aria-label="Main navigation"]').getByRole('button', { name: new RegExp('^' + name) }).click();
    await page.getByRole('heading', { name: name + '.', exact: true }).waitFor();
  };
  const dismissToast = async () => {
    if (await page.getByRole('button', { name: 'Dismiss notification' }).isVisible().catch(() => false)) await page.getByRole('button', { name: 'Dismiss notification' }).click();
  };

  // ---- boot: real desktop bridge, never demo
  await page.getByRole('heading', { name: 'Command Center.' }).waitFor({ timeout: 30000 });
  const banner = await page.locator('.demo-banner').innerText();
  check('boots in desktop mode through window.drift (no demo fallback)', banner.includes('DESKTOP MODE') && !banner.includes('DEMO MODE'), banner.replace(/\s+/g, ' ').slice(0, 80));
  check('no demo fixtures in a fresh desktop library', (await page.locator('.highlight-card').count()) === 0);
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([document.fonts.load('600 16px "Plus Jakarta Sans Variable"'), document.fonts.load('16px "JetBrains Mono Variable"')]);
    return { ui: document.fonts.check('600 16px "Plus Jakarta Sans Variable"'), mono: document.fonts.check('16px "JetBrains Mono Variable"'), body: getComputedStyle(document.body).fontFamily.split(',')[0] };
  });
  check('bundled fonts load from the app under the CSP (no network)', fonts.ui && fonts.mono && fonts.body.includes('Plus Jakarta'), JSON.stringify(fonts));
  check('renderer has no Node access', await page.evaluate(() => typeof window.require === 'undefined' && typeof window.process === 'undefined'));

  // ---- Settings: media folder, OBS port + password, connect
  await nav('Settings');
  await page.getByLabel('Media storage folder').fill(library);
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await until(() => fs.existsSync(library), 5000, 'library folder');
  check('Settings → media folder saved and created on disk', fs.existsSync(library));
  await page.getByRole('button', { name: 'Connection', exact: true }).click();
  await page.getByLabel('OBS WebSocket port').fill(String(port));
  await page.getByLabel('OBS WebSocket password').fill('hunter2');
  await page.getByRole('button', { name: 'Save password', exact: true }).click();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('.connection-mini').getByText(/connected/i).waitFor({ timeout: 15000 }).catch(() => {});
  await nav('Command Center');
  await page.getByText('Connected to OBS', { exact: true }).waitFor({ timeout: 15000 });
  check('OBS connects with password stored by the desktop service', true);
  check('readiness shows the real microphone device', await page.getByText('Microphone (Shure MV7)').first().isVisible());

  // ---- First-run setup: profile with a real executable "game"
  await page.getByRole('button', { name: 'Setup checklist' }).click();
  await page.getByLabel('Game shortcut or path').fill(game);
  await page.getByRole('button', { name: 'Save setup', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await dismissToast();
  const summary = await page.locator('.profile-summary strong').innerText().catch(() => '');
  check('first-run setup names the game, not the placeholder', summary === path.basename(game), summary);
  check('profiles are gone: no Profiles page and no profile picker', (await page.locator('nav[aria-label="Main navigation"]').getByRole('button', { name: /^Profiles/ }).count()) === 0 && (await page.getByLabel('Current session profile').count()) === 0);
  check('the drift logo mark is in the sidebar and the hero', (await page.locator('.brand svg.brand-mark path').count()) === 4 && (await page.locator('.session-hero svg.hero-mark path').count()) === 4);

  // ---- Preflight + Start Session
  await page.getByRole('button', { name: 'Check setup', exact: true }).click();
  await page.getByRole('heading', { name: 'Preflight results' }).waitFor({ timeout: 15000 });
  const preflight = await page.locator('.preflight-results').innerText().catch(() => '');
  check('Check setup runs the real preflight (capture source found in OBS)', preflight.includes('Game Capture'), preflight.replace(/\s+/g, ' ').slice(0, 120));
  await page.getByRole('button', { name: 'Start Session', exact: true }).click();
  await page.getByRole('button', { name: 'End Session', exact: true }).waitFor({ timeout: 20000 });
  await until(() => obs.replay, 10000, 'replay buffer');
  check('Start Session starts the OBS replay buffer', obs.replay);
  check('Start Session does not record or go live', !obs.recording && !obs.streaming);
  await until(() => fs.existsSync(`${game}.marker`), 10000, 'game launch');
  check('Start Session launches the configured game executable', fs.existsSync(`${game}.marker`));

  // ---- Save Replay → real clip in Recent highlights
  await page.getByRole('button', { name: 'Save Replay', exact: true }).click();
  await page.locator('.highlight-card').first().waitFor({ timeout: 30000 });
  const cardText = await page.locator('.highlight-card').first().innerText();
  check('Save Replay indexes the real OBS file as a highlight', cardText.includes('Replay 1.mp4'), cardText.replace(/\s+/g, ' ').slice(0, 80));
  check('highlight is tagged with the game from the profile', cardText.includes(path.basename(game)) && !cardText.includes('Choose a game'));
  check('highlight shows a real thumbnail', await page.locator('.highlight-card img').first().evaluate((img) => img.complete && img.naturalWidth > 0).catch(() => false));
  await page.screenshot({ path: path.join(shots, 'desktop-command-center.png') });

  // ---- Voice: say "Clip that" (fake microphone plays a synthesized phrase)
  if (voiceWav) {
    const before = await page.locator('.highlight-card').count();
    await nav('Settings');
    await page.getByRole('button', { name: 'Shortcuts', exact: true }).click();
    await page.getByLabel('Voice command: say “Clip that” to save a replay').check();
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.locator('.voice-status.listening').waitFor({ timeout: 30000 });
    check('voice command starts listening offline (status shows “Say Clip that”)', (await page.locator('.voice-status').innerText()).includes('Clip that'));
    await nav('Command Center');
    await until(async () => (await page.locator('.highlight-card').count()) > before, 45000, 'voice clip').catch(() => null);
    const after = await page.locator('.highlight-card').count();
    check('saying “Clip that” saves a replay into the library', after > before, `${before} → ${after} highlights; OBS saves: ${obs.requests.filter((r) => r.type === 'SaveReplayBuffer').length}`);
    await nav('Settings');
    await page.getByRole('button', { name: 'Shortcuts', exact: true }).click();
    await page.getByLabel('Voice command: say “Clip that” to save a replay').uncheck();
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.locator('.voice-status').waitFor({ state: 'detached', timeout: 10000 });
    check('turning the voice command off stops listening', (await page.locator('.voice-status').count()) === 0);
    await nav('Command Center');
  } else {
    console.log('SKIP  voice command checks (no flite text-to-speech available)');
  }

  // ---- Capture controls
  await page.getByRole('button', { name: 'Start Recording', exact: true }).click();
  await page.getByRole('button', { name: 'Stop Recording', exact: true }).waitFor();
  check('Start Recording starts OBS recording', obs.recording);
  await page.getByRole('button', { name: 'Stop Recording', exact: true }).click();
  await page.getByRole('button', { name: 'Start Recording', exact: true }).waitFor();
  check('Stop Recording stops OBS recording', !obs.recording);

  // ---- ClipForge: real playback, trim, preset, export
  await page.locator('.highlight-card').first().click();
  await page.getByRole('heading', { name: 'ClipForge.' }).waitFor();
  await page.locator('video').waitFor({ timeout: 15000 });
  const vsrc = await page.locator('video').getAttribute('src');
  check('ClipForge previews the real clip via drift-media://', vsrc?.startsWith('drift-media://clip/'), vsrc ?? '');
  await page.getByRole('button', { name: 'Play preview', exact: true }).click();
  const t = await until(() => page.evaluate(() => document.querySelector('video')?.currentTime ?? 0).then((x) => (x > 0.3 ? x : 0)), 10000, 'playback').catch(() => 0);
  check('preview actually plays the media', t > 0.3, `currentTime ${Number(t).toFixed(2)}s`);
  await page.getByRole('button', { name: 'Pause playback' }).click().catch(() => {});
  await page.getByLabel('In (seconds)').fill('1');
  await page.getByLabel('Out (seconds)').fill('4.5');
  await page.getByText('Saved locally', { exact: true }).waitFor({ timeout: 10000 }).catch(() => {});
  await page.screenshot({ path: path.join(shots, 'desktop-clipforge.png') });
  await page.getByRole('button', { name: 'Export clip', exact: true }).click();
  check('export dialog has no demo-only failure toggle', !(await page.getByLabel('Simulate encoder failure for recovery testing').isVisible().catch(() => false)));
  const exportDir = path.join(tmp, 'exports');
  await page.getByLabel('Destination').fill(exportDir);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByText('Completed', { exact: true }).waitFor({ timeout: 90000 });
  const outs = fs.existsSync(exportDir) ? fs.readdirSync(exportDir).filter((f) => f.endsWith('.mp4') && !f.includes('partial')) : [];
  check('export queue reports Completed only when a file exists', outs.length === 1, outs.join(', '));
  check('export file is named after the draft (no doubled extension)', /^Replay \d+\.mp4$/.test(outs[0] ?? ''), outs[0]);
  if (outs[0]) {
    const p = probe(path.join(exportDir, outs[0]));
    const v = p.streams.find((s) => s.codec_type === 'video');
    const a = p.streams.find((s) => s.codec_type === 'audio');
    check('exported file is the 3.5 s trim, 1080p60 H.264 with audio', Math.abs(Number(p.format.duration) - 3.5) < 0.12 && v?.height === 1080 && v?.codec_name === 'h264' && !!a, `${Number(p.format.duration).toFixed(3)}s ${v?.width}x${v?.height} ${v?.codec_name}/${a?.codec_name}`);
    check('exported audio and video lengths match (A/V sync)', Math.abs(Number(v.duration) - Number(a.duration)) < 0.1, `v ${v.duration} a ${a.duration}`);
  }
  await page.getByRole('button', { name: /^Open Output/ }).first().click();
  await until(() => fs.existsSync(openLog), 5000, 'open output').catch(() => {});
  check('Open Output opens the exported file', fs.existsSync(openLog) && fs.readFileSync(openLog, 'utf8').includes(exportDir));
  await page.getByRole('button', { name: 'Close dialog' }).click();

  // ---- Import media (native picker) + relink
  const imported = clip(path.join(tmp, 'media', 'Imported moment.mp4'), 4);
  fs.writeFileSync(pickFile, JSON.stringify([imported]));
  await page.getByRole('button', { name: 'Import media', exact: true }).click();
  await page.locator('.media-select').filter({ hasText: 'Imported moment.mp4' }).waitFor({ timeout: 20000 });
  check('Import media indexes files chosen in the native picker', true);
  fs.writeFileSync(pickFile, '[]');

  // ---- Stream Controls: scenes, preview, Go Live
  await nav('Stream Controls');
  await page.locator('.scene-card').filter({ has: page.locator('strong', { hasText: /^Starting Soon$/ }) }).click();
  check('scene cards are labelled with the real OBS scene names', (await page.locator('.scene-card .scene-art span').allInnerTexts()).map((x) => x.toLowerCase()).join('|') === 'gameplay|brb|starting soon');
  await until(() => obs.currentScene === 'Starting Soon', 5000, 'scene switch');
  check('scene switcher changes the OBS program scene', obs.currentScene === 'Starting Soon');
  const frame = await until(() => page.locator('.program-monitor img.obs-preview').evaluate((img) => (img.complete && img.naturalWidth > 0 ? img.naturalWidth : 0)), 8000, 'preview frame').catch(() => 0);
  check('program monitor shows a decoded OBS preview frame', frame === 960, `naturalWidth ${frame}`);
  await page.getByRole('button', { name: 'Go Live', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByLabel('Destination', { exact: true }).fill('Twitch · drift');
  await page.getByRole('button', { name: 'Confirm Go Live' }).click();
  await page.getByRole('button', { name: 'End stream', exact: true }).waitFor({ timeout: 10000 });
  check('Go Live (after confirmation) starts streaming in OBS', obs.streaming);
  await nav('Sessions');
  await nav('Stream Controls');
  check('changing screens keeps the stream live', obs.streaming);
  await page.getByRole('button', { name: 'End stream', exact: true }).click();
  await page.getByRole('button', { name: 'Go Live', exact: true }).waitFor();
  check('End stream stops streaming in OBS', !obs.streaming);
  await page.waitForTimeout(400);
  check('the live warning disappears once the stream has ended', !(await page.getByText(/You are live/).isVisible().catch(() => false)));

  // ---- Audio
  await nav('Audio');
  const before = obs.inputs['Mic/Aux'].muted;
  await page.locator('.mixer-channel').filter({ hasText: 'Mic/Aux' }).getByRole('button', { name: 'Mute source', exact: true }).click();
  await until(() => obs.inputs['Mic/Aux'].muted !== before, 5000, 'mute');
  check('Mute source mutes the OBS input', obs.inputs['Mic/Aux'].muted === true);
  await page.locator('.mixer-channel').filter({ hasText: 'Mic/Aux' }).getByRole('button', { name: 'Unmute source', exact: true }).click();
  await until(() => !obs.inputs['Mic/Aux'].muted, 5000, 'unmute');
  check('Unmute source unmutes the OBS input', !obs.inputs['Mic/Aux'].muted);

  // ---- Sessions: notes + linked clip
  await nav('Sessions');
  await page.getByPlaceholder('What worked? What is worth remembering?').fill('Ace in round 3');
  await page.getByRole('button', { name: 'Save notes', exact: true }).click();
  await page.waitForTimeout(500);
  const sessionText = await page.locator('.session-clips').innerText().catch(() => '');
  check('session shows its saved replay', sessionText.includes('Replay 1.mp4'));
  await page.reload();
  await page.getByRole('heading', { name: 'Command Center.' }).waitFor();
  await nav('Sessions');
  check('session notes persist across a reload', (await page.getByPlaceholder('What worked? What is worth remembering?').inputValue()) === 'Ace in round 3');

  // ---- End session
  await nav('Command Center');
  await page.getByRole('button', { name: 'End Session', exact: true }).click();
  await page.getByRole('button', { name: 'Start Session', exact: true }).waitFor();
  check('End Session ends the session (OBS outputs left as they are)', obs.replay === true);

  for (const name of ['Stream Controls', 'Audio', 'Sessions', 'Settings']) {
    await nav(name);
    await page.waitForTimeout(600); // let the entrance animation settle
    await page.screenshot({ path: path.join(shots, `desktop-${name.toLowerCase().replace(' ', '-')}.png`) });
  }
  check('no renderer runtime errors', errors.length === 0, errors.join(' | '));
} catch (err) {
  check(`unexpected failure: ${err.message.split('\n')[0]}`, false);
  if (page) await page.screenshot({ path: path.join(shots, 'failure.png') }).catch(() => {});
} finally {
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 10000))]);
  await obs.stop();
  try {
    execFileSync('pkill', ['-f', game]);
  } catch {
    /* not running */
  }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${shots}`);
process.exit(failed.length ? 1 : 0);
