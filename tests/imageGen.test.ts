/** Local thumbnail engines against stand-ins: fake stable-diffusion.cpp CLI and fake WebUI API. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPrompt, isPng, profileFor, SdCppEngine, validateLocalServer, WebUiEngine } from '../src/services/media/imageGen';
import { makeFakeSdCli, pngOf, startFakeWebUi, type FakeWebUi } from './helpers/fakeImageEngines';
import { tempDir } from './helpers/env';

const posixOnly = process.platform === 'win32' ? it.skip : it;
const pngSize = (b: Buffer) => ({ width: b.readUInt32BE(16), height: b.readUInt32BE(20) });
const fit = async (input: string, output: string, w: number, h: number) => {
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', input, '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`, output]);
};

describe('prompt and settings helpers', () => {
  it('asks for no text (the app adds the title) and needs a description', () => {
    const p = buildPrompt('  a dragon   over a castle ');
    expect(p.prompt.startsWith('a dragon over a castle, youtube thumbnail')).toBe(true);
    expect(p.negative).toMatch(/\btext\b/);
    expect(() => buildPrompt('   ')).toThrow(/Describe/);
  });

  it('picks steps and size from the model family', () => {
    expect(profileFor('sd_turbo-f16-q8_0.gguf')).toEqual({ steps: 4, cfg: 1, width: 768, height: 448 });
    expect(profileFor('sdxl_lightning_4step.safetensors')).toEqual({ steps: 4, cfg: 1, width: 1344, height: 768 });
    expect(profileFor('juggernautXL_v9.safetensors')).toMatchObject({ steps: 24, width: 1344 });
    expect(profileFor('v1-5-pruned-emaonly.safetensors')).toMatchObject({ steps: 24, width: 768, height: 448 });
  });

  it('only accepts a WebUI on this PC', () => {
    expect(validateLocalServer('http://127.0.0.1:7860')).toBeNull();
    expect(validateLocalServer('http://localhost:7860/')).toBeNull();
    expect(validateLocalServer('http://192.168.1.20:7860')).toMatch(/this PC/);
    expect(validateLocalServer('https://example.com')).toMatch(/this PC/);
    expect(validateLocalServer('file:///etc/passwd')).toMatch(/http/);
    expect(validateLocalServer('http://user:pw@127.0.0.1:7860')).toMatch(/just the address/);
  });
});

describe('stable-diffusion.cpp engine', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const model = () => {
    const m = path.join(dir, 'sd_turbo-q8.gguf');
    fs.writeFileSync(m, 'model');
    return m;
  };
  const calls = () => fs.readFileSync(path.join(dir, 'bin', 'sd-calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);

  posixOnly('text-to-image: one run per image with consecutive seeds, PNG at the model size', async () => {
    dir = tempDir();
    const eng = new SdCppEngine(makeFakeSdCli(path.join(dir, 'bin')), model(), fit);
    const r = await eng.generate({ description: 'neon city', init: null, strength: 0.6, count: 2, seed: 100 }, new AbortController().signal);
    expect(r.images).toHaveLength(2);
    expect(r.images.every(isPng)).toBe(true);
    expect(pngSize(r.images[0]!)).toEqual({ width: 768, height: 448 });
    const c = calls();
    expect(c).toHaveLength(2);
    const arg = (a: string[], f: string) => a[a.indexOf(f) + 1];
    expect(arg(c[0]!, '-p')).toMatch(/^neon city, youtube thumbnail/);
    expect([arg(c[0]!, '-s'), arg(c[1]!, '-s')]).toEqual(['100', '101']);
    expect([arg(c[0]!, '--steps'), arg(c[0]!, '--cfg-scale')]).toEqual(['4', '1']);
    expect(c[0]).not.toContain('--init-img');
  });

  posixOnly('image-to-image: the upload is fitted to the model size; legacy builds get -M img2img', async () => {
    dir = tempDir();
    const eng = new SdCppEngine(makeFakeSdCli(path.join(dir, 'bin'), 'ok', true), model(), async (i, o, w, h) => {
      await fit(i, o, w, h);
      expect(pngSize(fs.readFileSync(o))).toEqual({ width: w, height: h });
    });
    await eng.generate({ description: 'castle', init: pngOf(1920, 1080), strength: 0.45, count: 1, seed: 1 }, new AbortController().signal);
    const a = calls()[0]!;
    expect(a[a.indexOf('--strength') + 1]).toBe('0.45');
    expect(a[a.indexOf('-M') + 1]).toBe('img2img');
    expect(path.basename(a[a.indexOf('--init-img') + 1]!)).toBe('init.png');
  });

  posixOnly('explains out-of-memory failures and cancels a running engine', async () => {
    dir = tempDir();
    const oom = new SdCppEngine(makeFakeSdCli(path.join(dir, 'bin'), 'oom'), model(), fit);
    await expect(oom.generate({ description: 'x', init: null, strength: 0.5, count: 1, seed: 1 }, new AbortController().signal)).rejects.toThrow(/GPU memory/);
    const slow = new SdCppEngine(makeFakeSdCli(path.join(dir, 'slow'), 'slow'), model(), fit);
    const ctrl = new AbortController();
    const p = slow.generate({ description: 'x', init: null, strength: 0.5, count: 1, seed: 1 }, ctrl.signal);
    setTimeout(() => ctrl.abort(), 300);
    const t = Date.now();
    await expect(p).rejects.toThrow(/Cancelled/);
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('reports what is missing before running', () => {
    expect(SdCppEngine.problem(null, null)).toMatch(/program/);
    expect(SdCppEngine.problem('/nope/sd-cli', '/nope/m.gguf')).toMatch(/moved or deleted/);
  });
});

describe('Stable Diffusion WebUI engine', () => {
  let ui: FakeWebUi;
  afterEach(async () => ui?.close());

  it('checks the server and generates with the model-appropriate settings', async () => {
    ui = await startFakeWebUi();
    const eng = new WebUiEngine(ui.url);
    expect(await eng.check()).toEqual({ ok: true, model: 'sd_xl_turbo_1.0_fp16.safetensors [e869ac7d69]' });
    const r = await eng.generate({ description: 'jungle temple', init: null, strength: 0.6, count: 2, seed: 9 }, new AbortController().signal);
    expect(r.images).toHaveLength(2);
    expect(pngSize(r.images[1]!)).toEqual({ width: 1344, height: 768 });
    const body = ui.requests[0]!.body;
    expect(ui.requests[0]!.path).toBe('/sdapi/v1/txt2img');
    expect(body).toMatchObject({ steps: 4, cfg_scale: 1, seed: 9, batch_size: 2, save_images: false });
    expect(String(body.negative_prompt)).toMatch(/text/);
  });

  it('uses img2img with the starting image and strength', async () => {
    ui = await startFakeWebUi('v1-5-pruned-emaonly.safetensors');
    await new WebUiEngine(ui.url).generate({ description: 'x', init: pngOf(640, 360), strength: 0.3, count: 1, seed: 1 }, new AbortController().signal);
    const req = ui.requests[0]!;
    expect(req.path).toBe('/sdapi/v1/img2img');
    expect(req.body.denoising_strength).toBe(0.3);
    expect(String((req.body.init_images as string[])[0])).toMatch(/^data:image\/png;base64,/);
    expect(req.body).toMatchObject({ steps: 24, width: 768, height: 448 });
  });

  it('explains a missing API, a stopped server and a non-local address', async () => {
    ui = await startFakeWebUi();
    ui.noApi = true;
    expect(await new WebUiEngine(ui.url).check()).toMatchObject({ ok: false, reason: expect.stringMatching(/--api/) });
    const url = ui.url;
    await ui.close();
    expect(await new WebUiEngine(url).check()).toMatchObject({ ok: false, reason: expect.stringMatching(/No Stable Diffusion WebUI/) });
    await expect(new WebUiEngine('http://10.0.0.5:7860').generate({ description: 'x', init: null, strength: 0.5, count: 1, seed: 1 }, new AbortController().signal)).rejects.toThrow(/this PC/);
    ui = await startFakeWebUi();
  });
});
