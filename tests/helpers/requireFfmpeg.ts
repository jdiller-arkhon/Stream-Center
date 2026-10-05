import { execFileSync } from 'node:child_process';

/** Vitest global setup: fail fast with a clear message when FFmpeg is missing. */
export default function setup(): void {
  for (const tool of ['ffmpeg', 'ffprobe']) {
    try {
      execFileSync(tool, ['-version'], { stdio: 'ignore' });
    } catch {
      throw new Error(`${tool} is required for the desktop service tests. Install FFmpeg (e.g. sudo apt-get install ffmpeg, or winget install Gyan.FFmpeg) and re-run.`);
    }
  }
}
