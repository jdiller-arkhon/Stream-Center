/**
 * Dependency-free allowlists used by the preload script (kept separate from api.ts
 * so the sandboxed preload bundle stays tiny). tests/contract.test.ts asserts these
 * match the registry in api.ts exactly.
 */
export const CONTRACT_VERSION_FOR_PRELOAD = '1.0.0';

export const IPC_CHANNELS = { invoke: 'drift:invoke', event: 'drift:event' } as const;

export const METHOD_ALLOWLIST = [
  'system.getCapabilities', 'system.getStatusStrip', 'system.getTelemetry', 'system.getDisk', 'system.pickPath', 'system.reveal',
  'system.openOutput', 'system.exportDiagnostics', 'system.listNotices',
  'settings.get', 'settings.update', 'settings.setObsPassword', 'settings.getShortcutStatus',
  'obs.connect', 'obs.disconnect', 'obs.getState', 'obs.setScene', 'obs.startRecording', 'obs.stopRecording', 'obs.startReplayBuffer',
  'obs.stopReplayBuffer', 'obs.saveReplay', 'obs.startStream', 'obs.stopStream', 'obs.getPreview',
  'audio.list', 'audio.setMute', 'audio.setVolume', 'audio.setMeterSubscription',
  'profiles.list', 'profiles.get', 'profiles.validate', 'profiles.save', 'profiles.duplicate', 'profiles.delete',
  'sessions.preflight', 'sessions.plan', 'sessions.start', 'sessions.cancel', 'sessions.end', 'sessions.list', 'sessions.get',
  'sessions.getActive', 'sessions.updateNotes',
  'clips.list', 'clips.get', 'clips.import', 'clips.update', 'clips.relink', 'clips.verify', 'clips.remove', 'clips.getWaveform', 'clips.listGames',
  'projects.list', 'projects.get', 'projects.createFromClip', 'projects.save', 'projects.delete', 'projects.applyPreset',
  'presets.list', 'exports.enqueue', 'jobs.list', 'jobs.cancel', 'jobs.retry', 'jobs.clearFinished',
  'transcription.transcribeProject',
] as const;

export const EVENT_ALLOWLIST = [
  'obs.state', 'connection.changed', 'audio.meters', 'audio.changed', 'replay.saved', 'clip.added', 'clip.updated', 'job.updated',
  'session.updated', 'notice', 'shortcut.triggered',
] as const;
