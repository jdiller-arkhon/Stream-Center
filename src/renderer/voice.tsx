import { useEffect, useRef } from 'react';
import { useSnapshot, useStudio } from './context';
import { Icon } from './components/Icon';

/**
 * Status pill for the offline "Clip that" voice command. Recognition runs in a hidden,
 * sandboxed window owned by the desktop app; this only reflects its state from the snapshot.
 */
export function VoiceClip() {
  const s = useSnapshot();
  const { notify } = useStudio();
  const voice = s.voice;
  const lastHeard = useRef<string | null>(voice?.lastHeardAt ?? null);
  useEffect(() => {
    if (voice?.lastHeardAt && voice.lastHeardAt !== lastHeard.current) {
      lastHeard.current = voice.lastHeardAt;
      notify(s.obs.replayBuffer ? 'Heard “Clip that” · saving replay' : 'Heard “Clip that”, but the replay buffer is not running');
    }
  }, [voice?.lastHeardAt, notify, s.obs.replayBuffer]);
  if (!voice || voice.state === 'off') return null;
  const label =
    voice.state === 'listening' ? `Say “Clip that”${s.obs.replayBuffer ? '' : ' · replay buffer off'}` : voice.state === 'loading' ? 'Starting voice…' : 'Voice unavailable';
  return (
    <span className={`voice-status ${voice.state}`} role="status" title={voice.device ?? voice.detail ?? undefined}>
      <Icon name="mic" size={14} />
      {label}
    </span>
  );
}
