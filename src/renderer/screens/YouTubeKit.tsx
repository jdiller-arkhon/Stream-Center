import { useEffect, useRef, useState } from 'react';
import { useStudio } from '../context';
import { Badge, Button, Empty, Field, Modal } from '../components/Primitives';
import { Icon } from '../components/Icon';
import type { ThumbAiStatus, YouTubeKit as Kit } from '../../shared/contracts';

const TITLE_MAX = 100;
const DESCRIPTION_MAX = 5000;
const TAGS_MAX = 500;
const ACCENTS = [['Mist', '#7c5cff'], ['Gold', '#ffc83d'], ['Ice', '#2fd3f0'], ['Ember', '#ff5a4e']] as const;
const THUMB_FONT = '"Plus Jakarta Sans Variable", "Segoe UI", sans-serif';

const clock = (ms: number) => {
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, maxLines: number): string[] {
    const words = text.trim().split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
        const next = line ? `${line} ${w}` : w;
        if (ctx.measureText(next).width <= width || !line) line = next;
        else { lines.push(line); line = w; }
        if (lines.length === maxLines) break;
    }
    if (line && lines.length < maxLines) lines.push(line);
    return lines;
}

export interface Layer { id: string; src: string; name: string; pos: 'left' | 'center' | 'right'; size: number }
interface Background { id: string; src: string; label: string }

const load = async (src: string) => { const img = new Image(); img.src = src; await img.decode(); return img; };

/** Draws an image to fill the canvas (centre crop), whatever its aspect ratio. */
function cover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, w: number, h: number) {
    const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/** Reads an uploaded image file into a PNG data URL (longest side ≤ 1920, transparency kept). */
async function readImage(file: File): Promise<string> {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Choose a PNG, JPEG or WebP image');
    if (file.size > 25 * 1024 * 1024) throw new Error('That image is larger than 25 MB');
    const url = URL.createObjectURL(file);
    try {
        const img = await load(url);
        const k = Math.min(1, 1920 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * k));
        c.height = Math.max(1, Math.round(img.naturalHeight * k));
        c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
        return c.toDataURL('image/png');
    } finally { URL.revokeObjectURL(url); }
}

/** Draws the thumbnail: background, soft shade for legibility, your images, accent bar and the title. */
async function drawThumbnail(canvas: HTMLCanvasElement, frame: string, text: string, accent: string, place: 'left' | 'bottom', layers: Layer[] = []) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const [img, ...over] = await Promise.all([load(frame), ...layers.map(l => load(l.src))]);
    try { await document.fonts.load(`800 120px ${THUMB_FONT}`); } catch { /* system fallback */ }
    ctx.clearRect(0, 0, 1280, 720);
    cover(ctx, img, 1280, 720);
    const drawLayers = () => layers.forEach((l, i) => {
        const im = over[i]!;
        const h = 720 * l.size, w = h * im.naturalWidth / im.naturalHeight;
        const x = l.pos === 'left' ? 40 : l.pos === 'right' ? 1280 - w - 40 : (1280 - w) / 2;
        ctx.drawImage(im, x, 720 - h, w, h); // anchored to the bottom edge, like a cut-out
    });
    if (!text.trim()) { drawLayers(); return; }
    const shade = place === 'left' ? ctx.createLinearGradient(0, 0, 820, 0) : ctx.createLinearGradient(0, 720, 0, 300);
    shade.addColorStop(0, 'rgba(10,8,24,.82)');
    shade.addColorStop(1, 'rgba(10,8,24,0)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, 1280, 720);
    drawLayers();
    let size = 112;
    let lines: string[] = [];
    const width = place === 'left' ? 700 : 1140;
    for (; size >= 56; size -= 8) {
        ctx.font = `800 ${size}px ${THUMB_FONT}`;
        lines = wrap(ctx, text.toUpperCase(), width, 3);
        if (lines.join(' ').length >= text.trim().split(/\s+/).join(' ').length && lines.every(l => ctx.measureText(l).width <= width)) break;
    }
    const lh = size * 1.02;
    const top = place === 'left' ? (720 - lines.length * lh) / 2 : 720 - 64 - lines.length * lh;
    ctx.fillStyle = accent;
    ctx.fillRect(56, top - 6, 14, lines.length * lh);
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    lines.forEach((l, i) => {
        const y = top + i * lh;
        ctx.lineWidth = Math.round(size / 7);
        ctx.strokeStyle = 'rgba(8,6,20,.9)';
        ctx.strokeText(l, 92, y);
        ctx.fillStyle = i === lines.length - 1 ? accent : '#ffffff';
        ctx.fillText(l, 92, y);
    });
}

/** JPEG under YouTube's 2 MB thumbnail limit. */
function exportJpeg(canvas: HTMLCanvasElement): string {
    for (const q of [0.92, 0.85, 0.75, 0.6]) {
        const url = canvas.toDataURL('image/jpeg', q);
        if ((url.length - 23) * 0.75 < 2 * 1024 * 1024) return url;
    }
    return canvas.toDataURL('image/jpeg', 0.5);
}

export function YouTubeKit({ jobId, onClose }: { jobId: string; onClose: () => void }) {
    const { run, pending, notify } = useStudio();
    const [kit, setKit] = useState<Kit | null>(null);
    const [failed, setFailed] = useState(false);
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [tags, setTags] = useState('');
    const [frame, setFrame] = useState('frame-0');
    const [backgrounds, setBackgrounds] = useState<Background[]>([]);
    const [layers, setLayers] = useState<Layer[]>([]);
    const [ai, setAi] = useState<ThumbAiStatus | null>(null);
    const [prompt, setPrompt] = useState('');
    const [fromSelected, setFromSelected] = useState(false);
    const [strength, setStrength] = useState(0.6);
    const [count, setCount] = useState(2);
    const [genNote, setGenNote] = useState<string | null>(null);
    const bgInput = useRef<HTMLInputElement>(null);
    const layerInput = useRef<HTMLInputElement>(null);
    const [text, setText] = useState('');
    const [accent, setAccent] = useState<string>(ACCENTS[0][1]);
    const [place, setPlace] = useState<'left' | 'bottom'>('left');
    const canvas = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        let live = true;
        void run('youtubeKit', { jobId }).then(k => {
            if (!live) return;
            if (!k) { setFailed(true); return; }
            setKit(k);
            setBackgrounds(k.frames.map((src, i) => ({ id: `frame-${i}`, src, label: `Frame ${i + 1}` })));
            setTitle(k.title);
            setDescription(k.description);
            setTags(k.tags.join(', '));
            setText(k.title.replace(/\s*#shorts/i, '').slice(0, 40));
        });
        return () => { live = false; };
    }, [jobId, run]);

    useEffect(() => { void run('thumbAiStatus', undefined).then(s => s && setAi(s)); }, [run]);
    const selected = backgrounds.find(b => b.id === frame) ?? backgrounds[0];
    useEffect(() => {
        const c = canvas.current;
        if (c && selected) void drawThumbnail(c, selected.src, text, accent, place, layers).catch(() => notify('Could not draw the thumbnail preview'));
    }, [selected, text, accent, place, layers, notify]);

    const addBackground = (b: Background) => { setBackgrounds(x => [b, ...x]); setFrame(b.id); };
    const upload = async (files: FileList | null, as: 'background' | 'layer') => {
        let room = 3 - layers.length;
        for (const f of Array.from(files ?? [])) {
            if (as === 'layer' && room <= 0) { notify('Up to three images on top'); break; }
            try {
                const src = await readImage(f);
                if (as === 'background') addBackground({ id: `up-${Date.now()}-${f.name}`, src, label: f.name });
                else { room--; setLayers(x => [...x, { id: `layer-${Date.now()}-${f.name}`, src, name: f.name, pos: x.length % 2 ? 'left' : 'right', size: 0.8 }]); }
            } catch (e) { notify(e instanceof Error ? e.message : 'Could not read that image'); }
        }
        if (bgInput.current) bgInput.current.value = '';
        if (layerInput.current) layerInput.current.value = '';
    };
    const generate = async () => {
        setGenNote(null);
        const r = await run('generateThumbnail', { description: prompt, initImage: fromSelected && selected ? selected.src : null, strength, count });
        if (!r) return;
        const stamp = Date.now();
        const made = r.images.map((src, i) => ({ id: `ai-${stamp}-${i}`, src, label: `AI ${i + 1}` }));
        setBackgrounds(x => [...made, ...x]);
        if (made[0]) setFrame(made[0].id);
        setGenNote(`${made.length} background${made.length === 1 ? '' : 's'} in ${(r.ms / 1000).toFixed(1)} s with ${r.engine} · seed ${r.seed}`);
    };

    const copy = async (label: string, value: string) => {
        try { await navigator.clipboard.writeText(value); notify(`${label} copied`); }
        catch { notify(`Could not copy the ${label.toLowerCase()}. Select the text and copy it manually.`); }
    };
    const tagText = tags.split(',').map(t => t.trim()).filter(Boolean).join(', ');
    const problems = kit?.checks.filter(c => c.status !== 'pass').length ?? 0;

    return <Modal title="YouTube kit" onClose={onClose}>
        {!kit ? (failed ? <Empty icon="alert" title="Could not prepare the kit" detail="The export may have been moved or deleted. Export it again and retry."/> : <div className="yt-loading" role="status"><span className="status-dot"/>Checking the video and measuring loudness…</div>) : <div className="yt-kit">
            <div className="yt-summary"><Icon name="youtube" size={22}/><div><strong>{kit.fileName}</strong><small>{kit.width}×{kit.height} · {clock(kit.durationMs)}{kit.loudnessLufs !== null ? ` · ${kit.loudnessLufs.toFixed(1)} LUFS` : ''}</small></div><Badge tone={kit.isShort ? 'violet' : 'cyan'}>{kit.isShort ? 'Short' : 'Video'}</Badge></div>

            <section aria-label="Upload checks"><h3>Before you upload {problems ? <Badge tone="amber">{problems} to review</Badge> : <Badge tone="cyan">Ready</Badge>}</h3>
                <ul className="yt-checks">{kit.checks.map(c => <li key={c.id} className={`yt-check ${c.status}`}><span className="yt-check-mark" aria-hidden="true">{c.status === 'pass' ? '✓' : c.status === 'warn' ? '!' : '×'}</span><div><strong>{c.label}</strong><small>{c.detail}</small></div></li>)}</ul>
            </section>

            <section aria-label="Title and description"><h3>Title, description & tags</h3>
                <p className="fine-print">A starting point drafted on this PC. Edit it, copy it, paste it into YouTube Studio.</p>
                <Field label={`Title · ${title.length}/${TITLE_MAX}`}><div className="yt-copy-row"><input aria-label="Video title" maxLength={TITLE_MAX} value={title} onChange={e => setTitle(e.target.value)}/><Button icon="copy" variant="ghost" onClick={() => void copy('Title', title)}>Copy</Button></div></Field>
                <Field label={`Description · ${description.length}/${DESCRIPTION_MAX}`}><textarea aria-label="Video description" rows={7} maxLength={DESCRIPTION_MAX} value={description} onChange={e => setDescription(e.target.value)}/></Field>
                <div className="button-row"><Button icon="copy" variant="ghost" onClick={() => void copy('Description', description)}>Copy description</Button></div>
                <Field label={`Tags · ${tagText.length}/${TAGS_MAX}`} hint="Comma separated. YouTube allows 500 characters."><div className="yt-copy-row"><input aria-label="Video tags" value={tags} onChange={e => setTags(e.target.value)}/><Button icon="copy" variant="ghost" disabled={tagText.length > TAGS_MAX} onClick={() => void copy('Tags', tagText)}>Copy</Button></div></Field>
                {kit.chapters.length ? <div className="callout"><strong>Chapters included</strong> · {kit.chapters.length} from your timeline segments (already in the description).</div> : kit.chapterNote && <p className="fine-print">{kit.chapterNote}</p>}
            </section>

            <section aria-label="Thumbnail"><h3>Thumbnail</h3>
                <input hidden type="file" accept="image/png,image/jpeg,image/webp" ref={bgInput} onChange={e => void upload(e.target.files, 'background')}/>
                <input hidden type="file" accept="image/png,image/jpeg,image/webp" multiple ref={layerInput} onChange={e => void upload(e.target.files, 'layer')}/>
                <div className="yt-thumb">{selected ? <canvas ref={canvas} width={1280} height={720} aria-label="Thumbnail preview"/> : <Empty icon="image" title="Choose a background" detail="Upload an image or describe one below."/>}</div>
                <div className="yt-frames" role="radiogroup" aria-label="Thumbnail background">{backgrounds.map(b => <button key={b.id} role="radio" aria-checked={selected?.id === b.id} aria-label={b.label} title={b.label} className={selected?.id === b.id ? 'selected' : ''} onClick={() => setFrame(b.id)}><img src={b.src} alt=""/>{b.id.startsWith('ai-') && <span className="yt-frame-tag">AI</span>}</button>)}</div>
                <div className="button-row"><Button icon="upload" variant="ghost" onClick={() => bgInput.current?.click()}>Upload background</Button><Button icon="plus" variant="ghost" onClick={() => layerInput.current?.click()}>Add image on top</Button></div>

                <div className="yt-ai" aria-label="Describe a background">
                    <div className="yt-ai-head"><Icon name="spark"/><strong>Describe a background</strong><Badge tone={ai?.ready ? 'cyan' : 'amber'}>{ai?.ready ? 'Local AI ready' : 'Set up in Settings'}</Badge></div>
                    <textarea aria-label="Thumbnail description" rows={3} maxLength={600} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="e.g. a lone soldier on a burning rooftop at night, neon city behind, cinematic"/>
                    <div className="form-grid">
                        <Field label="Start from"><select aria-label="Start from" value={fromSelected ? 'selected' : 'nothing'} onChange={e => setFromSelected(e.target.value === 'selected')}><option value="nothing">Description only</option><option value="selected" disabled={!selected}>The selected background</option></select></Field>
                        <Field label="Options"><select aria-label="Number of options" value={count} onChange={e => setCount(Number(e.target.value))}>{[1, 2, 4].map(n => <option key={n} value={n}>{n} image{n > 1 ? 's' : ''}</option>)}</select></Field>
                    </div>
                    {fromSelected && <Field label={`Change from the original · ${Math.round(strength * 100)}%`}><input type="range" aria-label="Change strength" min="0.2" max="0.95" step="0.05" value={strength} onChange={e => setStrength(Number(e.target.value))}/></Field>}
                    <div className="button-row">{pending.has('generateThumbnail') ? <><span className="yt-loading-inline" role="status"><span className="status-dot"/>Generating on this PC…</span><Button onClick={() => void run('cancelThumbnail', undefined)}>Cancel</Button></> : <Button icon="spark" variant="primary" disabled={!ai?.ready || !prompt.trim()} onClick={() => void generate()}>Generate</Button>}</div>
                    <p className="fine-print">{ai?.ready ? (genNote ?? `Runs on your GPU with ${ai.engine === 'sdcpp' ? 'stable-diffusion.cpp' : 'your Stable Diffusion WebUI'}. Nothing is uploaded. Text is added by Drift Studio, not the AI.`) : (ai?.detail ?? 'Turn on the local generator in Settings → AI & Privacy.')}</p>
                </div>

                {layers.length > 0 && <div className="yt-layers" aria-label="Images on top">{layers.map(l => <div className="yt-layer" key={l.id}><img src={l.src} alt=""/><strong title={l.name}>{l.name}</strong><select aria-label={`Position of ${l.name}`} value={l.pos} onChange={e => setLayers(x => x.map(y => y.id === l.id ? { ...y, pos: e.target.value as Layer['pos'] } : y))}><option value="left">Left</option><option value="center">Centre</option><option value="right">Right</option></select><input type="range" aria-label={`Size of ${l.name}`} min="0.2" max="1" step="0.05" value={l.size} onChange={e => setLayers(x => x.map(y => y.id === l.id ? { ...y, size: Number(e.target.value) } : y))}/><button className="icon-button" aria-label={`Remove ${l.name}`} onClick={() => setLayers(x => x.filter(y => y.id !== l.id))}><Icon name="close" size={14}/></button></div>)}<p className="fine-print">PNG images with transparent backgrounds (a cut-out of you, a logo) look best.</p></div>}
                <div className="form-grid"><Field label="Thumbnail text"><input aria-label="Thumbnail text" maxLength={60} value={text} onChange={e => setText(e.target.value)} placeholder="Leave empty for a clean frame"/></Field><Field label="Text placement"><select value={place} onChange={e => setPlace(e.target.value as 'left' | 'bottom')}><option value="left">Left side</option><option value="bottom">Bottom</option></select></Field></div>
                <div className="yt-accents" role="radiogroup" aria-label="Accent colour">{ACCENTS.map(([name, c]) => <button key={c} role="radio" aria-checked={accent === c} aria-label={name} className={accent === c ? 'selected' : ''} style={{ background: c }} onClick={() => setAccent(c)}/>)}</div>
                <div className="button-row"><Button icon="image" disabled={!selected || pending.has('saveThumbnail')} onClick={async () => { const c = canvas.current; if (!c) return; const r = await run('saveThumbnail', { jobId, dataUrl: exportJpeg(c) }); if (r) notify(`Saved ${r.fileName} next to the video`); }}>Save thumbnail (1280×720)</Button></div>
            </section>

            <section aria-label="Upload"><h3>Upload</h3>
                <p className="fine-print">Drift Studio does not sign in to your account or upload for you. Open YouTube Studio, choose Create → Upload videos, and drag in the file.</p>
                <div className="button-row"><Button icon="folder" onClick={() => void run('revealOutput', { id: jobId })}>Show video in folder</Button><Button icon="youtube" variant="primary" disabled={pending.has('openYouTubeStudio')} onClick={() => void run('openYouTubeStudio', undefined)}>Open YouTube Studio</Button></div>
            </section>
        </div>}
    </Modal>;
}
