import type { CaptionStyle, EditProject, ExportSettings, NormRect } from '../../shared/contracts';
import { fail } from '../core/errors';

export interface ClipMediaInfo {
  id: string;
  path: string;
  durationMs: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

export type ResolvedEncoder = 'software' | 'nvenc' | 'qsv' | 'amf';

export interface ExportCommand {
  /** ffmpeg arguments, excluding the executable. Output path is the final argument. */
  args: string[];
  expectedDurationMs: number;
  /** ASS subtitle file contents to write as `captions.ass` in the process cwd, if captions are burned in. */
  assFile: string | null;
  encoder: ResolvedEncoder;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const sec = (ms: number) => (ms / 1000).toFixed(3);

/** Timeline duration in ms (items play back-to-back). */
export function projectDurationMs(project: EditProject): number {
  return project.tracks[0]!.items.reduce((sum, it) => sum + Math.max(0, it.sourceOutMs - it.sourceInMs), 0);
}

function cropFilter(rect: NormRect): string {
  return `crop=w='trunc(iw*${rect.w.toFixed(5)}/2)*2':h='trunc(ih*${rect.h.toFixed(5)}/2)*2':x='trunc(iw*${rect.x.toFixed(5)})':y='trunc(ih*${rect.y.toFixed(5)})'`;
}

/** Center crop that fills the target aspect ratio (no letterboxing). */
function autoCropFilter(targetAspect: number): string {
  const a = targetAspect.toFixed(6);
  return `crop=w='trunc(min(iw\\,ih*${a})/2)*2':h='trunc(min(ih\\,iw/${a})/2)*2'`;
}

function videoEncoderArgs(enc: ResolvedEncoder, s: ExportSettings): string[] {
  const q = { draft: 0, standard: 1, high: 2 }[s.quality];
  const hevc = s.codec === 'hevc';
  switch (enc) {
    case 'software':
      return hevc
        ? ['-c:v', 'libx265', '-preset', ['veryfast', 'medium', 'slow'][q]!, '-crf', String([30, 25, 21][q]), '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p']
        : ['-c:v', 'libx264', '-preset', ['veryfast', 'medium', 'slow'][q]!, '-crf', String([26, 21, 18][q]), '-profile:v', 'high', '-pix_fmt', 'yuv420p'];
    case 'nvenc':
      return [
        '-c:v', hevc ? 'hevc_nvenc' : 'h264_nvenc',
        '-preset', ['p3', 'p5', 'p6'][q]!,
        '-rc', 'vbr', '-cq', String([30, 24, 19][q]), '-b:v', '0',
        ...(hevc ? ['-tag:v', 'hvc1'] : []),
        '-pix_fmt', 'yuv420p',
      ];
    case 'qsv':
      return ['-c:v', hevc ? 'hevc_qsv' : 'h264_qsv', '-global_quality', String([30, 24, 19][q]), ...(hevc ? ['-tag:v', 'hvc1'] : []), '-pix_fmt', 'nv12'];
    case 'amf': {
      const qp = String([28, 23, 19][q]);
      return ['-c:v', hevc ? 'hevc_amf' : 'h264_amf', '-rc', 'cqp', '-qp_i', qp, '-qp_p', qp, ...(hevc ? ['-tag:v', 'hvc1'] : []), '-pix_fmt', 'yuv420p'];
    }
  }
}

/**
 * Builds a single ffmpeg invocation implementing the non-destructive edit:
 * per-item trim (video+audio cut on identical boundaries to keep A/V sync),
 * framing (crop → fit → pad), optional webcam overlay, gain/fades, concat,
 * optional captions, project fades and optional user-supplied music.
 */
export function buildExportCommand(
  project: EditProject,
  settings: ExportSettings,
  clips: Map<string, ClipMediaInfo>,
  encoder: ResolvedEncoder,
  outputPath: string,
): ExportCommand {
  const items = project.tracks[0]!.items;
  if (items.length === 0) fail('VALIDATION', 'The timeline is empty. Add a clip before exporting.');
  const W = even(settings.width);
  const H = even(settings.height);
  const F = settings.fps;
  const trackMuted = project.tracks[0]!.muted;

  const inputs: string[] = [];
  const inputIndex = new Map<string, number>();
  for (const it of items) {
    const c = clips.get(it.clipId) ?? fail('MEDIA_MISSING', 'A clip used by this project is no longer in the library', { detail: it.clipId });
    if (!inputIndex.has(c.id)) {
      inputIndex.set(c.id, inputIndex.size);
      inputs.push('-i', c.path);
    }
  }

  const graph: string[] = [];
  const concatPads: string[] = [];
  let total = 0;

  items.forEach((it, i) => {
    const c = clips.get(it.clipId)!;
    const k = inputIndex.get(c.id)!;
    const inMs = Math.min(it.sourceInMs, c.durationMs);
    const outMs = Math.min(it.sourceOutMs, c.durationMs);
    const d = outMs - inMs;
    if (d < 100) fail('VALIDATION', `Segment ${i + 1} is shorter than 0.1 s. Adjust its in/out points.`);
    total += d;

    // ---- video
    const frame = [
      project.crop ? cropFilter(project.crop) : autoCropFilter(W / H),
      `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos`,
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`,
      'setsar=1',
    ].join(',');
    if (!c.hasVideo) {
      graph.push(`color=c=black:s=${W}x${H}:r=${F},trim=duration=${sec(d)},setsar=1,format=yuv420p[v${i}]`);
    } else if (project.webcam?.enabled) {
      const pl = project.webcam.placement;
      const pw = even(pl.w * W);
      const ph = even(pl.h * H);
      graph.push(`[${k}:v:0]trim=start=${sec(inMs)}:end=${sec(outMs)},setpts=PTS-STARTPTS,fps=${F},split=2[vb${i}][vc${i}]`);
      graph.push(`[vb${i}]${frame}[vf${i}]`);
      graph.push(`[vc${i}]${cropFilter(project.webcam.sourceRect)},scale=${pw}:${ph}:force_original_aspect_ratio=decrease[cam${i}]`);
      graph.push(`[vf${i}][cam${i}]overlay=x=${Math.round(pl.x * W)}:y=${Math.round(pl.y * H)},format=yuv420p[v${i}]`);
    } else {
      graph.push(`[${k}:v:0]trim=start=${sec(inMs)}:end=${sec(outMs)},setpts=PTS-STARTPTS,fps=${F},${frame},format=yuv420p[v${i}]`);
    }

    // ---- audio
    if (c.hasAudio && !trackMuted) {
      const af = [
        `atrim=start=${sec(inMs)}:end=${sec(outMs)}`,
        'asetpts=PTS-STARTPTS',
        'aresample=48000',
        'aformat=sample_fmts=fltp:channel_layouts=stereo',
      ];
      if (it.gainDb !== 0) af.push(`volume=${it.gainDb}dB`);
      const fi = Math.min(it.fadeInMs, d / 2);
      const fo = Math.min(it.fadeOutMs, d / 2);
      if (fi > 0) af.push(`afade=t=in:st=0:d=${sec(fi)}`);
      if (fo > 0) af.push(`afade=t=out:st=${sec(d - fo)}:d=${sec(fo)}`);
      // Pad/trim to the exact segment length so every segment's audio matches its video.
      af.push(`apad=whole_dur=${sec(d)}`, `atrim=duration=${sec(d)}`);
      graph.push(`[${k}:a:0]${af.join(',')}[a${i}]`);
    } else {
      graph.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${sec(d)},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    }
    concatPads.push(`[v${i}][a${i}]`);
  });

  graph.push(`${concatPads.join('')}concat=n=${items.length}:v=1:a=1[vcat][acat]`);

  // ---- post video: captions + fades
  const post: string[] = [];
  const captions = project.captions.filter((c) => c.text.trim() && c.endMs > c.startMs && c.startMs < total);
  const assFile = captions.length ? buildAss(captions, project.captionStyle, W, H, total) : null;
  if (assFile) post.push(`subtitles=captions.ass`);
  const vfi = Math.min(project.videoFadeInMs, total / 2);
  const vfo = Math.min(project.videoFadeOutMs, total / 2);
  if (vfi > 0) post.push(`fade=t=in:st=0:d=${sec(vfi)}`);
  if (vfo > 0) post.push(`fade=t=out:st=${sec(total - vfo)}:d=${sec(vfo)}`);
  graph.push(`[vcat]${post.length ? post.join(',') : 'null'}[vout]`);

  // ---- post audio: original gain + optional music
  const orig = project.originalAudioGainDb !== 0 ? `volume=${project.originalAudioGainDb}dB` : 'anull';
  if (project.music) {
    const mu = project.music;
    const mi = inputIndex.size;
    inputs.push('-i', mu.path);
    const start = Math.min(mu.startMs, total);
    const len = total - start;
    if (len > 0) {
      graph.push(`[acat]${orig}[aorig]`);
      const mf = [`atrim=duration=${sec(len)}`, 'asetpts=PTS-STARTPTS', 'aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo', `volume=${mu.gainDb}dB`];
      if (mu.fadeInMs > 0) mf.push(`afade=t=in:st=0:d=${sec(Math.min(mu.fadeInMs, len))}`);
      if (mu.fadeOutMs > 0) mf.push(`afade=t=out:st=${sec(Math.max(0, len - mu.fadeOutMs))}:d=${sec(Math.min(mu.fadeOutMs, len))}`);
      if (start > 0) mf.push(`adelay=${start}|${start}`);
      graph.push(`[${mi}:a:0]${mf.join(',')}[mus]`);
      graph.push(`[aorig][mus]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,atrim=duration=${sec(total)}[aout]`);
    } else {
      graph.push(`[acat]${orig}[aout]`);
    }
  } else {
    graph.push(`[acat]${orig}[aout]`);
  }

  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    ...inputs,
    '-filter_complex',
    graph.join(';'),
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-r',
    String(F),
    ...videoEncoderArgs(encoder, settings),
    '-c:a',
    'aac',
    '-b:a',
    `${settings.audioBitrateKbps}k`,
    '-ar',
    '48000',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    '-loglevel',
    'error',
    '-f',
    'mp4',
    outputPath,
  ];
  return { args, expectedDurationMs: total, assFile, encoder };
}

// ---------------------------------------------------------------------------
// ASS captions
// ---------------------------------------------------------------------------

function assColor(hex: string, alpha = 0): string {
  const r = hex.slice(1, 3);
  const g = hex.slice(3, 5);
  const b = hex.slice(5, 7);
  return `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${b}${g}${r}`.toUpperCase();
}

function assTime(ms: number): string {
  const cs = Math.round(ms / 10);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

export function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '⧵')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/\r?\n/g, '\\N');
}

export function buildAss(captions: EditProject['captions'], style: CaptionStyle, W: number, H: number, totalMs: number): string {
  const size = Math.round((style.sizePx * H) / 1080);
  const alignment = { bottom: 2, middle: 5, top: 8 }[style.position];
  // Safe areas: vertical shorts keep captions clear of platform UI at the bottom.
  const marginV = style.position === 'middle' ? 0 : Math.round(H * (H > W && style.position === 'bottom' ? 0.18 : 0.07));
  const marginH = Math.round(W * 0.06);
  const borderStyle = style.background ? 3 : 1;
  const outline = style.background ? Math.max(4, Math.round(size * 0.18)) : Math.max(2, Math.round(size * 0.06));
  const back = style.background ? assColor('#000000', 0x60) : assColor('#000000', 0x80);
  const font = style.fontFamily.replace(/[,\r\n]/g, ' ');
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Drift,${font},${size},${assColor(style.color)},${assColor(style.color)},${style.background ? back : assColor(style.outlineColor)},${back},${style.bold ? -1 : 0},0,0,0,100,100,0,0,${borderStyle},${outline},0,${alignment},${marginH},${marginH},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  for (const c of [...captions].sort((a, b) => a.startMs - b.startMs)) {
    lines.push(`Dialogue: 0,${assTime(c.startMs)},${assTime(Math.min(c.endMs, totalMs))},Drift,,0,0,0,,${escapeAssText(c.text.trim())}`);
  }
  return lines.join('\n') + '\n';
}
