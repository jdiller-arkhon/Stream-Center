/**
 * Stand-ins for local image engines: a fake AUTOMATIC1111/Forge WebUI API server and a fake
 * stable-diffusion.cpp CLI. Both produce real PNGs (via ffmpeg) at the requested size and
 * record what they were asked to do.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

export function pngOf(width: number, height: number, color = 'purple'): Buffer {
  return execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${width}x${height}`, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1']);
}

export interface FakeWebUi {
  url: string;
  requests: Array<{ path: string; body: Record<string, unknown> }>;
  model: string;
  noApi: boolean;
  close(): Promise<void>;
}

export async function startFakeWebUi(model = 'sd_xl_turbo_1.0_fp16.safetensors [e869ac7d69]'): Promise<FakeWebUi> {
  const state: FakeWebUi = { url: '', requests: [], model, noApi: false, close: async () => {} };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (state.noApi) return void res.writeHead(404).end('Not Found');
      if (req.method === 'GET' && req.url === '/sdapi/v1/options') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sd_model_checkpoint: state.model }));
        return;
      }
      if (req.method === 'POST' && (req.url === '/sdapi/v1/txt2img' || req.url === '/sdapi/v1/img2img')) {
        const body = JSON.parse(raw) as Record<string, unknown>;
        state.requests.push({ path: req.url, body });
        const n = Number(body.batch_size ?? 1);
        const imgs = Array.from({ length: n }, (_, i) => pngOf(Number(body.width), Number(body.height), i % 2 ? 'teal' : 'orange').toString('base64'));
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ images: imgs, parameters: {}, info: '{}' }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((r) => server.close(() => r()));
  return state;
}

/**
 * Writes an executable fake `sd-cli`. Each run appends its argv (JSON) to `<dir>/sd-calls.log`
 * and writes a PNG of -W×-H to -o. `mode` lets tests force a failure or a long run.
 */
export function makeFakeSdCli(dir: string, mode: 'ok' | 'oom' | 'slow' = 'ok', legacyHelp = false): string {
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, 'sd-cli');
  const log = path.join(dir, 'sd-calls.log');
  fs.writeFileSync(
    exe,
    `#!/usr/bin/env node
const fs = require('fs');
const { execFileSync } = require('child_process');
const a = process.argv.slice(2);
if (a[0] === '--help') { console.log(${JSON.stringify(legacyHelp ? '-M, --mode [MODE]  run mode (txt2img or img2img or convert, default: txt2img)' : '-M, --mode  run mode, one of [img_gen, vid_gen, upscale, convert], default: img_gen')}); process.exit(0); }
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
const get = (f) => a[a.indexOf(f) + 1];
${mode === 'oom' ? "console.error('ggml_cuda: out of memory while allocating 4.2 GB'); process.exit(1);" : ''}
${mode === 'slow' ? 'setTimeout(() => {}, 60000); return;' : ''}
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=navy:s=' + get('-W') + 'x' + get('-H'), '-frames:v', '1', get('-o')]);
console.log('save result image 0 to ' + get('-o') + ' (success)');
`,
  );
  fs.chmodSync(exe, 0o755);
  return exe;
}
