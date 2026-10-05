import type { CaptionStyle, ExportPreset, Settings } from './dto';

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontFamily: 'Segoe UI',
  sizePx: 64,
  color: '#FFFFFF',
  outlineColor: '#000000',
  background: false,
  position: 'bottom',
  bold: true,
};

export function defaultSettings(): Settings {
  return {
    firstRunComplete: false,
    media: {
      libraryDirectory: null,
      exportDirectory: null,
      autoImportReplays: true,
      autoImportRecordings: true,
    },
    obs: {
      host: '127.0.0.1',
      port: 4455,
      passwordStored: false,
      autoConnect: true,
      microphoneInputName: null,
    },
    tools: { ffmpegPath: null, ffprobePath: null },
    performance: { maxConcurrentJobs: 1, lowerPriorityWhileGaming: true, preferHardwareEncoding: true },
    transcription: { enabled: false, whisperPath: null, modelPath: null },
    shortcuts: [
      { action: 'saveReplay', accelerator: 'CommandOrControl+Alt+R', enabled: true, scope: 'global' },
      { action: 'toggleRecording', accelerator: 'CommandOrControl+Alt+F9', enabled: false, scope: 'global' },
      { action: 'toggleReplayBuffer', accelerator: 'CommandOrControl+Alt+F10', enabled: false, scope: 'global' },
      { action: 'toggleMicMute', accelerator: 'CommandOrControl+Alt+M', enabled: false, scope: 'global' },
      { action: 'openCommandPalette', accelerator: 'CommandOrControl+K', enabled: true, scope: 'local' },
    ],
    privacy: { includePathsInDiagnostics: false },
  };
}

/**
 * The four built-in presets. Each only changes inspectable export settings and
 * project fields; nothing hidden is applied at export time.
 */
export const EXPORT_PRESETS: ExportPreset[] = [
  {
    id: 'clean-highlight',
    name: 'Clean Highlight',
    description: '1080p60 widescreen, straight cuts, original audio untouched.',
    settings: { aspect: '16:9', width: 1920, height: 1080, fps: 60, quality: 'high', codec: 'h264', encoder: 'auto', audioBitrateKbps: 192 },
    projectDefaults: { videoFadeInMs: 0, videoFadeOutMs: 0, originalAudioGainDb: 0, captionStyle: null },
  },
  {
    id: 'cinematic',
    name: 'Cinematic',
    description: '1080p24 widescreen with a 600 ms fade from and to black.',
    settings: { aspect: '16:9', width: 1920, height: 1080, fps: 24, quality: 'high', codec: 'h264', encoder: 'auto', audioBitrateKbps: 256 },
    projectDefaults: { videoFadeInMs: 600, videoFadeOutMs: 600, originalAudioGainDb: 0, captionStyle: null },
  },
  {
    id: 'vertical-short',
    name: 'Vertical Short',
    description: '1080×1920 at 60 fps, center crop, large bottom-safe captions.',
    settings: { aspect: '9:16', width: 1080, height: 1920, fps: 60, quality: 'standard', codec: 'h264', encoder: 'auto', audioBitrateKbps: 192 },
    projectDefaults: {
      videoFadeInMs: 0,
      videoFadeOutMs: 200,
      originalAudioGainDb: 0,
      captionStyle: { ...DEFAULT_CAPTION_STYLE, sizePx: 72, position: 'middle' },
    },
  },
  {
    id: 'squad-recap',
    name: 'Squad Recap',
    description: '1080p30 widescreen montage, short audio fades between clips.',
    settings: { aspect: '16:9', width: 1920, height: 1080, fps: 30, quality: 'standard', codec: 'h264', encoder: 'auto', audioBitrateKbps: 192 },
    projectDefaults: { videoFadeInMs: 300, videoFadeOutMs: 500, originalAudioGainDb: -1, captionStyle: null },
  },
];

export const ASPECT_DIMENSIONS: Record<'16:9' | '9:16' | '1:1', { w: number; h: number }> = {
  '16:9': { w: 16, h: 9 },
  '9:16': { w: 9, h: 16 },
  '1:1': { w: 1, h: 1 },
};
