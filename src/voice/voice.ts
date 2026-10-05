/**
 * Hidden, sandboxed voice host. Captures the default microphone and runs the offline Vosk
 * recogniser with a closed grammar ("clip that" | unknown). It has no access to the app
 * bridge: it can only report status and "heard" events through window.driftVoice.
 * Loaded from drift-app://voice/ with its own CSP (the WASM build needs 'unsafe-eval').
 */
import { createModel } from 'vosk-browser';

declare global {
  interface Window {
    driftVoice: { status(state: string, detail: string | null, device: string | null): void; heard(text: string, confidence: number): void };
  }
}

const MODEL_URL = 'drift-media://model/vosk-small-en';
const PHRASES = ['clip that', 'clip it'];
const MIN_CONFIDENCE = 0.55;

async function main(): Promise<void> {
  window.driftVoice.status('loading', null, null);
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }, video: false });
  const device = stream.getAudioTracks()[0]?.label || 'Default microphone';
  window.driftVoice.status('loading', 'Loading the offline speech model…', device);
  const model = await createModel(MODEL_URL);
  const ctx = new AudioContext();
  const recognizer = new model.KaldiRecognizer(ctx.sampleRate, JSON.stringify([...PHRASES, '[unk]']));
  recognizer.on('result', (message) => {
    const result = (message as { result?: { text?: string; result?: Array<{ conf: number }> } }).result;
    const text = (result?.text ?? '').trim();
    if (!PHRASES.includes(text)) return;
    const words = result?.result ?? [];
    const confidence = words.length ? words.reduce((a, w) => a + w.conf, 0) / words.length : 1;
    if (confidence < MIN_CONFIDENCE) return;
    window.driftVoice.heard(text, confidence);
  });
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (e) => {
    try {
      recognizer.acceptWaveform(e.inputBuffer);
    } catch {
      /* recognizer busy */
    }
  };
  source.connect(processor);
  processor.connect(ctx.destination); // silent output; keeps the graph processing
  window.driftVoice.status('listening', null, device);
}

main().catch((err) => window.driftVoice.status('error', err instanceof Error ? err.message : String(err), null));
