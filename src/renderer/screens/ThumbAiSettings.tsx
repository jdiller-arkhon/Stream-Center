import { useEffect, useState } from 'react';
import { useStudio } from '../context';
import { Badge, Button, Field } from '../components/Primitives';
import type { ThumbAiEngine, ThumbAiStatus } from '../../shared/contracts';

/** Settings → AI & Privacy: the local thumbnail generator (desktop only). */
export function ThumbAiSettings() {
    const { run, pending } = useStudio();
    const [status, setStatus] = useState<ThumbAiStatus | null>(null);
    const [engine, setEngine] = useState<ThumbAiEngine>('off');
    const [url, setUrl] = useState('http://127.0.0.1:7860');
    const apply = (s: ThumbAiStatus | undefined) => { if (s) { setStatus(s); setEngine(s.engine); setUrl(s.serverUrl); } };
    useEffect(() => { void run('thumbAiStatus', undefined).then(apply); }, [run]);
    const save = async (next: ThumbAiEngine) => { setEngine(next); apply(await run('thumbAiConfigure', { engine: next, serverUrl: url })); };
    return <div className="thumb-ai-settings">
        <h3>AI thumbnail generator {status && <Badge tone={status.ready ? 'cyan' : 'amber'}>{status.ready ? 'Ready' : engine === 'off' ? 'Off' : 'Needs setup'}</Badge>}</h3>
        <p>Creates thumbnail backgrounds from your description, entirely on this PC with your GPU. Nothing is uploaded. The app adds your title text and images on top.</p>
        <Field label="Engine"><select aria-label="Thumbnail engine" value={engine} disabled={pending.has('thumbAiConfigure')} onChange={e => void save(e.target.value as ThumbAiEngine)}>
            <option value="off">Off</option>
            <option value="sdcpp">Built-in · stable-diffusion.cpp</option>
            <option value="webui">Stable Diffusion WebUI on this PC (AUTOMATIC1111 / Forge)</option>
        </select></Field>
        {engine === 'sdcpp' && <>
            <div className="thumb-ai-files">
                <div><small>Program</small><strong>{status?.engineFile ?? 'Not chosen'}</strong><Button variant="ghost" disabled={pending.has('thumbAiPick')} onClick={() => void run('thumbAiPick', { kind: 'engine' }).then(apply)}>Choose sd-cli…</Button></div>
                <div><small>Model</small><strong>{status?.modelFile ?? 'Not chosen'}</strong><Button variant="ghost" disabled={pending.has('thumbAiPick')} onClick={() => void run('thumbAiPick', { kind: 'model' }).then(apply)}>Choose model…</Button></div>
            </div>
            <p className="fine-print">Download stable-diffusion.cpp for Windows (the CUDA build for NVIDIA, Vulkan for AMD/Intel) and a model such as SD-Turbo or SDXL-Turbo (.gguf or .safetensors). Turbo models need only a few steps and are fastest. Check each model's licence before using it commercially.</p>
        </>}
        {engine === 'webui' && <>
            <Field label="WebUI address" hint="Start the WebUI with the --api flag. Only addresses on this PC are allowed."><div className="yt-copy-row"><input aria-label="WebUI address" value={url} onChange={e => setUrl(e.target.value)}/><Button disabled={pending.has('thumbAiConfigure')} onClick={() => void save('webui')}>Connect</Button></div></Field>
        </>}
        {status?.detail && engine !== 'off' && <div className={`callout ${status.ready ? '' : 'error'}`}>{status.detail}</div>}
    </div>;
}
