/** Preload for the hidden voice host: two one-way messages, nothing else. */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('driftVoice', {
  status(state: string, detail: string | null, device: string | null) {
    ipcRenderer.send('voice:event', { type: 'status', state: String(state), detail: detail === null ? null : String(detail).slice(0, 300), device: device === null ? null : String(device).slice(0, 200) });
  },
  heard(text: string, confidence: number) {
    ipcRenderer.send('voice:event', { type: 'heard', text: String(text).slice(0, 40), confidence: Number(confidence) });
  },
});
