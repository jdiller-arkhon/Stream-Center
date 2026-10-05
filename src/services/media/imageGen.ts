/**
 * Local thumbnail-background generation. Two engines, both on this PC:
 *  - stable-diffusion.cpp (`sd-cli` / older `sd`), run as a child process with a model file
 *    the user chose;
 *  - a Stable Diffusion WebUI the user already runs (AUTOMATIC1111 / Forge API), loopback only.
 * Nothing is sent off the machine. Models draw text badly, so prompts ask for no text and the
 * app composites the title itself.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fail } from '../core/errors';
import { isFile } from '../core/paths';
import { run } from '../core/proc';

export interface GenRequest {
  description: string;
  /** PNG or JPEG bytes to start from (image-to-image), or null. */
  init: Buffer | null;
  /** 0..1: how far the result may move away from the starting image. */
  strength: number;
  count: number;
  seed: number;
  /** One of THUMB_STYLES (keys), or 'none'. */
  style?: string;
  /** Extra things to keep out of the image. */
  avoid?: string;
  quality?: GenQuality;
}

export type GenQuality = 'fast' | 'balanced' | 'best';

/** Style presets: prompt fragments that steer the look without the user writing them. */
export const THUMB_STYLES: Record<string, { label: string; prompt: string; negative?: string }> = {
  cinematic: { label: 'Cinematic', prompt: 'cinematic film still, dramatic rim lighting, volumetric light, shallow depth of field, color graded' },
  neon: { label: 'Neon', prompt: 'synthwave, neon glow, magenta and cyan lighting, night, reflections, retro futuristic' },
  anime: { label: 'Anime', prompt: 'anime key visual, cel shading, vivid colors, clean line art, studio quality', negative: 'photo, photorealistic' },
  comic: { label: 'Comic', prompt: 'comic book art, bold ink outlines, halftone shading, dynamic action, pop art colors', negative: 'photo, photorealistic' },
  photo: { label: 'Photoreal', prompt: 'photorealistic, 35mm photo, natural lighting, ultra detailed, high dynamic range', negative: 'cartoon, illustration, painting' },
  fantasy: { label: 'Fantasy', prompt: 'epic fantasy concept art, magical atmosphere, glowing particles, painterly, grand scale' },
  horror: { label: 'Horror', prompt: 'dark horror atmosphere, eerie fog, low key lighting, ominous, desaturated with red accents' },
  minimal: { label: 'Minimal', prompt: 'minimalist flat illustration, simple shapes, clean gradient background, lots of empty space', negative: 'cluttered, busy, detailed background' },
  cyberpunk: { label: 'Cyberpunk', prompt: 'cyberpunk, rain-soaked neon streets, holograms, chrome and leather, moody blue and magenta light' },
  dark: { label: 'Dark & gritty', prompt: 'dark gritty atmosphere, harsh shadows, smoke and embers, desaturated, menacing, high contrast' },
  grunge: { label: 'Grunge', prompt: 'grunge aesthetic, distressed textures, scratched film, gritty, raw, dramatic shadows' },
  glitch: { label: 'Glitch', prompt: 'glitch art, digital distortion, chromatic aberration, datamosh, corrupted pixels, cyber' },
  '3d': { label: '3D render', prompt: '3d render, octane render, soft studio lighting, glossy materials, stylized' },
};

export interface GenResult {
  /** PNG images. */
  images: Buffer[];
  width: number;
  height: number;
}

export interface ImageEngine {
  readonly label: string;
  generate(req: GenRequest, signal: AbortSignal): Promise<GenResult>;
}

const STYLE = 'youtube thumbnail background, bold composition, vibrant colors, high contrast, dramatic lighting, sharp focus, highly detailed';
const NEGATIVE = 'text, letters, words, caption, watermark, logo, signature, blurry, lowres, jpeg artifacts, deformed, extra fingers, bad anatomy';

const clean = (s: string | undefined, max: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function buildPrompt(description: string, style = 'none', avoid = ''): { prompt: string; negative: string } {
  const d = clean(description, 600);
  if (!d) fail('VALIDATION', 'Describe the thumbnail you want');
  const st = THUMB_STYLES[style];
  const extra = clean(avoid, 300);
  return {
    prompt: [d, st?.prompt, STYLE].filter(Boolean).join(', '),
    negative: [NEGATIVE, st?.negative, extra].filter(Boolean).join(', '),
  };
}

/** Few-step distilled models (Turbo, Lightning, LCM, Hyper, Schnell) need very different settings. */
export function profileFor(modelName: string, quality: GenQuality = 'balanced'): { steps: number; cfg: number; width: number; height: number } {
  const n = modelName.toLowerCase();
  const fast = /turbo|lightning|lcm|hyper|schnell/.test(n);
  const xl = /xl|sd3|flux|pony|illustrious/.test(n);
  // 16:9-ish sizes in multiples of 64 near each family's native resolution; the app crops to 1280×720.
  const [width, height] = xl ? [1344, 768] : [768, 448];
  const steps = fast ? { fast: 2, balanced: 4, best: 6 }[quality] : { fast: 14, balanced: 24, best: 36 }[quality];
  return { steps, cfg: fast ? 1 : 6.5, width, height };
}

/** Only loopback WebUI servers are accepted, so "local" stays true. */
export function validateLocalServer(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'Enter a full address such as http://127.0.0.1:7860';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'The address must start with http://';
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return 'Only a server on this PC is allowed (127.0.0.1 or localhost)';
  if (u.username || u.password || u.search || u.hash) return 'Enter just the address, e.g. http://127.0.0.1:7860';
  return null;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const isPng = (b: Buffer) => b.length > 24 && b.subarray(0, 8).equals(PNG_SIG);
export const isJpeg = (b: Buffer) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8;

// ---------------------------------------------------------------------------
// stable-diffusion.cpp
// ---------------------------------------------------------------------------

export class SdCppEngine implements ImageEngine {
  readonly label = 'stable-diffusion.cpp';
  private static helpCache = new Map<string, string>();

  constructor(
    private readonly exe: string,
    private readonly model: string,
    /** Scales/crops the starting image to exactly width×height (PNG), e.g. with FFmpeg. */
    private readonly fitImage: (input: string, output: string, width: number, height: number) => Promise<void>,
  ) {}

  static problem(exe: string | null, model: string | null): string | null {
    if (!exe) return 'Choose the stable-diffusion.cpp program (sd-cli.exe)';
    if (!isFile(exe)) return 'The stable-diffusion.cpp program was moved or deleted';
    if (!model) return 'Choose a Stable Diffusion model file (.safetensors or .gguf)';
    if (!isFile(model)) return 'The model file was moved or deleted';
    return null;
  }

  /** Older builds need `-M img2img` for image-to-image; newer ones infer it from --init-img. */
  private async needsImg2ImgMode(): Promise<boolean> {
    let help = SdCppEngine.helpCache.get(this.exe);
    if (help === undefined) {
      const r = await run(this.exe, ['--help'], { timeoutMs: 15_000 }).catch(() => null);
      help = r ? r.stdout + r.stderr : '';
      SdCppEngine.helpCache.set(this.exe, help);
    }
    return /\bimg2img\b/.test(help);
  }

  async generate(req: GenRequest, signal: AbortSignal): Promise<GenResult> {
    const problem = SdCppEngine.problem(this.exe, this.model);
    if (problem) fail('VALIDATION', problem);
    const { prompt, negative } = buildPrompt(req.description, req.style, req.avoid);
    const prof = profileFor(path.basename(this.model), req.quality);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-gen-'));
    try {
      const base = ['-m', this.model, '-p', prompt, '-n', negative, '-W', String(prof.width), '-H', String(prof.height), '--steps', String(prof.steps), '--cfg-scale', String(prof.cfg)];
      if (req.init) {
        const raw = path.join(tmp, isPng(req.init) ? 'upload.png' : 'upload.jpg');
        fs.writeFileSync(raw, req.init);
        const init = path.join(tmp, 'init.png');
        await this.fitImage(raw, init, prof.width, prof.height);
        if (await this.needsImg2ImgMode()) base.push('-M', 'img2img');
        base.push('--init-img', init, '--strength', req.strength.toFixed(2));
      }
      const images: Buffer[] = [];
      for (let i = 0; i < req.count; i++) {
        const out = path.join(tmp, `out-${i}.png`);
        const r = await run(this.exe, [...base, '-s', String(req.seed + i), '-o', out], { signal, timeoutMs: 15 * 60_000, maxStderrBytes: 16 * 1024 });
        if (r.code !== 0 || !isFile(out)) {
          const tail = (r.stderr + r.stdout).trim().split('\n').slice(-4).join('\n');
          fail('IO', /out of memory|alloc/i.test(tail) ? 'Not enough GPU memory for this model. Try a smaller or quantized (.gguf) model.' : 'stable-diffusion.cpp could not generate an image', { detail: tail.slice(-2000) });
        }
        const png = fs.readFileSync(out);
        if (!isPng(png)) fail('IO', 'stable-diffusion.cpp did not write a PNG image');
        images.push(png);
      }
      return { images, width: prof.width, height: prof.height };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// AUTOMATIC1111 / Forge WebUI API (started with --api)
// ---------------------------------------------------------------------------

export class WebUiEngine implements ImageEngine {
  readonly label = 'Stable Diffusion WebUI';

  constructor(private readonly url: string) {}

  private endpoint(p: string): string {
    return new URL(p, this.url.endsWith('/') ? this.url : this.url + '/').toString();
  }

  /** The loaded checkpoint's name, or a reason the server cannot be used. */
  async check(signal?: AbortSignal): Promise<{ ok: true; model: string } | { ok: false; reason: string }> {
    const bad = validateLocalServer(this.url);
    if (bad) return { ok: false, reason: bad };
    try {
      const r = await fetch(this.endpoint('sdapi/v1/options'), { signal: signal ?? AbortSignal.timeout(5000) });
      if (r.status === 404) return { ok: false, reason: 'The WebUI is running without its API. Start it with the --api flag.' };
      if (!r.ok) return { ok: false, reason: `The WebUI answered ${r.status}` };
      const o = (await r.json()) as { sd_model_checkpoint?: unknown };
      return { ok: true, model: typeof o.sd_model_checkpoint === 'string' ? o.sd_model_checkpoint : '' };
    } catch {
      return { ok: false, reason: `No Stable Diffusion WebUI is answering at ${this.url}. Start it with --api.` };
    }
  }

  async generate(req: GenRequest, signal: AbortSignal): Promise<GenResult> {
    const status = await this.check();
    if (!status.ok) fail('VALIDATION', status.reason);
    const { prompt, negative } = buildPrompt(req.description, req.style, req.avoid);
    const prof = profileFor(status.model, req.quality);
    const body: Record<string, unknown> = {
      prompt,
      negative_prompt: negative,
      width: prof.width,
      height: prof.height,
      steps: prof.steps,
      cfg_scale: prof.cfg,
      seed: req.seed,
      batch_size: req.count,
      n_iter: 1,
      send_images: true,
      save_images: false,
    };
    if (req.init) {
      body.init_images = [`data:image/${isPng(req.init) ? 'png' : 'jpeg'};base64,${req.init.toString('base64')}`];
      body.denoising_strength = req.strength;
      body.resize_mode = 1; // crop and resize to the target size
    }
    let res: Response;
    try {
      res = await fetch(this.endpoint(req.init ? 'sdapi/v1/img2img' : 'sdapi/v1/txt2img'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]),
      });
    } catch (err) {
      if (signal.aborted) fail('CANCELLED', 'Cancelled');
      fail('IO', 'Lost the connection to the Stable Diffusion WebUI', { detail: String(err) });
    }
    if (!res.ok) fail('IO', `The Stable Diffusion WebUI could not generate (${res.status})`, { detail: (await res.text().catch(() => '')).slice(0, 2000) });
    const json = (await res.json()) as { images?: unknown };
    const images = (Array.isArray(json.images) ? json.images : [])
      .filter((x): x is string => typeof x === 'string')
      .map((x) => Buffer.from(x.replace(/^data:image\/\w+;base64,/, ''), 'base64'))
      .filter(isPng)
      .slice(0, req.count); // some WebUI builds append a grid or control images
    if (!images.length) fail('IO', 'The Stable Diffusion WebUI returned no images');
    return { images, width: prof.width, height: prof.height };
  }
}
