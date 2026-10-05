import { useCallback, useEffect, useRef, useState } from 'react';
import { useStudio } from '../context';
import { Badge, Button, Empty, Field } from '../components/Primitives';
import { Icon } from '../components/Icon';
import { THUMB_STYLE_OPTIONS, type ThumbAiStatus, type YouTubeKit } from '../../shared/contracts';
import { suggestDescription } from '../thumbPrompts';
import { cutOut, drawThumbnail, exportJpeg, FONTS, H, readImageFile, W, type FontKey, type Layer, type Rect, type TextPlace } from '../thumbCanvas';

const ACCENTS = [['Mist', '#7c5cff'], ['Gold', '#ffc83d'], ['Ice', '#2fd3f0'], ['Ember', '#ff5a4e'], ['Lime', '#9be22d']] as const;
const RECENT_KEY = 'drift.thumbPrompts';
const QUALITY = [['fast', 'Fast'], ['balanced', 'Balanced'], ['best', 'Best']] as const;
type Quality = typeof QUALITY[number][0];

interface Background { id: string; src: string; label: string; ai?: { description: string; style: string; avoid: string; seed: number } }

const readRecent = (): string[] => { try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 8) : []; } catch { return []; } };
const saveRecent = (list: string[]) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8))); } catch { /* per-viewer convenience only */ } };

export function ThumbnailStudio({ jobId, kit }: { jobId: string; kit: YouTubeKit }) {
    const { run, pending, notify } = useStudio();
    const [backgrounds, setBackgrounds] = useState<Background[]>(() => kit.frames.map((src, i) => ({ id: `frame-${i}`, src, label: `Frame ${i + 1}` })));
    const [selectedId, setSelectedId] = useState('frame-0');
    const [layers, setLayers] = useState<Layer[]>([]);
    const [activeLayer, setActiveLayer] = useState<string | null>(null);
    const [text, setText] = useState(kit.title.replace(/\s*#shorts/i, '').slice(0, 40));
    const [place, setPlace] = useState<TextPlace>('left');
    const [font, setFont] = useState<FontKey>('jakarta');
    const [color, setColor] = useState('#ffffff');
    const [accent, setAccent] = useState<string>(ACCENTS[0][1]);
    const [upper, setUpper] = useState(true);
    // AI
    const [ai, setAi] = useState<ThumbAiStatus | null>(null);
    const [prompt, setPrompt] = useState('');
    const [style, setStyle] = useState('cinematic');
    const [avoid, setAvoid] = useState('');
    const [quality, setQuality] = useState<Quality>('balanced');
    const [fromSelected, setFromSelected] = useState(false);
    const [strength, setStrength] = useState(0.6);
    const [count, setCount] = useState(2);
    const [genNote, setGenNote] = useState<string | null>(null);
    const [recent, setRecent] = useState<string[]>(readRecent);
    const [suggestN, setSuggestN] = useState(0);
    const [tolerance, setTolerance] = useState(0.18);

    const canvas = useRef<HTMLCanvasElement>(null);
    const homePreview = useRef<HTMLCanvasElement>(null);
    const phonePreview = useRef<HTMLCanvasElement>(null);
    const rects = useRef(new Map<string, Rect>());
    const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
    const bgInput = useRef<HTMLInputElement>(null);
    const layerInput = useRef<HTMLInputElement>(null);

    useEffect(() => { void run('thumbAiStatus', undefined).then(s => s && setAi(s)); }, [run]);
    const selected = backgrounds.find(b => b.id === selectedId) ?? backgrounds[0];

    useEffect(() => {
        const c = canvas.current;
        if (!c || !selected) return;
        let live = true;
        void drawThumbnail(c, selected.src, { text, place, font, color, accent, upper }, layers).then(r => {
            if (!live) return;
            rects.current = r;
            for (const p of [homePreview.current, phonePreview.current]) p?.getContext('2d')?.drawImage(c, 0, 0, p.width, p.height);
        }).catch(() => notify('Could not draw the thumbnail preview'));
        return () => { live = false; };
    }, [selected, text, place, font, color, accent, upper, layers, notify]);

    const updateLayer = useCallback((id: string, change: Partial<Layer>) => setLayers(x => x.map(l => l.id === id ? { ...l, ...change } : l)), []);

    // Drag layers directly on the preview.
    const toCanvas = (e: React.PointerEvent<HTMLCanvasElement>) => { const r = e.currentTarget.getBoundingClientRect(); return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height }; };
    const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const p = toCanvas(e);
        const hit = [...layers].reverse().find(l => { const r = rects.current.get(l.id); return r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h; });
        if (!hit) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { id: hit.id, dx: p.x - hit.cx * W, dy: p.y - hit.cy * H };
        setActiveLayer(hit.id);
    };
    const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const d = drag.current;
        if (!d) return;
        const p = toCanvas(e);
        updateLayer(d.id, { cx: Math.min(1.2, Math.max(-0.2, (p.x - d.dx) / W)), cy: Math.min(1.3, Math.max(-0.3, (p.y - d.dy) / H)) });
    };
    const onUp = () => { drag.current = null; };

    const upload = async (files: FileList | null, as: 'background' | 'layer') => {
        let added = 0;
        for (const f of Array.from(files ?? [])) {
            if (as === 'layer' && layers.length + added >= 3) { notify('Up to three images on top'); break; }
            try {
                const src = await readImageFile(f);
                if (as === 'background') { const b = { id: `up-${Date.now()}-${f.name}`, src, label: f.name }; setBackgrounds(x => [b, ...x]); setSelectedId(b.id); }
                else {
                    const n = layers.length + added++;
                    const id = `layer-${Date.now()}-${f.name}`;
                    setLayers(x => [...x, { id, src, name: f.name, cx: n % 2 ? 0.25 : 0.75, cy: 0.6, size: 0.8, outline: true, shadow: true }]);
                    setActiveLayer(id);
                }
            } catch (e) { notify(e instanceof Error ? e.message : 'Could not read that image'); }
        }
        if (bgInput.current) bgInput.current.value = '';
        if (layerInput.current) layerInput.current.value = '';
    };

    const removeBackgroundOf = async (l: Layer) => {
        try {
            const r = await cutOut(l.src, tolerance);
            if (r.removedShare < 0.02) { notify('No plain background found around the edges. Try a higher tolerance, or use a PNG cut-out.'); return; }
            updateLayer(l.id, { src: r.src, original: l.original ?? l.src });
            notify(`Removed ${Math.round(r.removedShare * 100)}% of ${l.name} (plain background).`);
        } catch { notify('Could not process that image'); }
    };

    const generate = async (opts?: { from?: Background; variation?: boolean }) => {
        setGenNote(null);
        const base = opts?.from?.ai;
        const description = base && opts?.variation ? base.description : prompt;
        const input = {
            description,
            initImage: opts?.variation && opts.from ? opts.from.src : fromSelected && selected ? selected.src : null,
            strength: opts?.variation ? 0.35 : strength,
            count,
            style: base && opts?.variation ? base.style : style,
            avoid: base && opts?.variation ? base.avoid : avoid,
            quality,
            seed: base && opts?.variation ? (base.seed + 1) % 2 ** 31 : null,
        };
        const r = await run('generateThumbnail', input);
        if (!r) return;
        if (!opts?.variation) { const next = [description.trim(), ...recent.filter(x => x !== description.trim())].slice(0, 8); setRecent(next); saveRecent(next); }
        const stamp = Date.now();
        const made: Background[] = r.images.map((src, i) => ({ id: `ai-${stamp}-${i}`, src, label: `AI ${i + 1}`, ai: { description: input.description, style: input.style, avoid: input.avoid, seed: r.seed + i } }));
        setBackgrounds(x => [...made, ...x]);
        if (made[0]) setSelectedId(made[0].id);
        setGenNote(`${made.length} ${opts?.variation ? 'variation' : 'background'}${made.length === 1 ? '' : 's'} in ${(r.ms / 1000).toFixed(1)} s with ${r.engine} · seed ${r.seed}`);
    };

    const save = async () => { const c = canvas.current; if (!c) return; const r = await run('saveThumbnail', { jobId, dataUrl: exportJpeg(c) }); if (r) notify(`Saved ${r.fileName} next to the video`); };
    const generating = pending.has('generateThumbnail');
    const active = layers.find(l => l.id === activeLayer);

    return <section aria-label="Thumbnail"><h3>Thumbnail</h3>
        <input hidden type="file" accept="image/png,image/jpeg,image/webp" ref={bgInput} onChange={e => void upload(e.target.files, 'background')}/>
        <input hidden type="file" accept="image/png,image/jpeg,image/webp" multiple ref={layerInput} onChange={e => void upload(e.target.files, 'layer')}/>
        <div className="yt-thumb">{selected ? <canvas ref={canvas} width={W} height={H} aria-label="Thumbnail preview" className={layers.length ? 'draggable' : ''} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}/> : <Empty icon="image" title="Choose a background" detail="Upload an image or describe one below."/>}</div>
        {selected && <div className="yt-size-previews" aria-label="Small-size previews"><figure><canvas ref={homePreview} width={320} height={180} aria-label="Preview at YouTube home size"/><figcaption>Home feed · 320×180</figcaption></figure><figure><canvas ref={phonePreview} width={168} height={94} aria-label="Preview at search and suggested size"/><figcaption>Search / up next · 168×94</figcaption></figure><p className="fine-print">Most viewers see your thumbnail this small. If the text is hard to read here, shorten it.</p></div>}
        {layers.length > 0 && <p className="fine-print">Drag images on the preview to move them.</p>}
        <div className="yt-frames" role="radiogroup" aria-label="Thumbnail background">{backgrounds.map(b => <button key={b.id} role="radio" aria-checked={selected?.id === b.id} aria-label={b.label} title={b.ai ? `${b.ai.description} · seed ${b.ai.seed}` : b.label} className={selected?.id === b.id ? 'selected' : ''} onClick={() => setSelectedId(b.id)}><img src={b.src} alt=""/>{b.ai && <span className="yt-frame-tag">AI</span>}</button>)}</div>
        <div className="button-row"><Button icon="upload" variant="ghost" onClick={() => bgInput.current?.click()}>Upload background</Button><Button icon="plus" variant="ghost" onClick={() => layerInput.current?.click()}>Add image on top</Button>{selected?.ai && <Button icon="spark" variant="ghost" disabled={!ai?.ready || generating} onClick={() => void generate({ from: selected, variation: true })}>More like this</Button>}</div>

        <div className="yt-ai" aria-label="Describe a background">
            <div className="yt-ai-head"><Icon name="spark"/><strong>Describe a background</strong><Badge tone={ai?.ready ? 'cyan' : 'amber'}>{ai?.ready ? 'Local AI ready' : 'Set up in Settings'}</Badge></div>
            <textarea aria-label="Thumbnail description" rows={3} maxLength={600} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="e.g. a lone soldier on a burning rooftop at night, neon city behind"/>
            <div className="yt-prompt-tools"><Button icon="spark" variant="ghost" onClick={() => { setPrompt(suggestDescription(kit, suggestN)); setSuggestN(n => n + 1); }}>Suggest from my video</Button>{recent.length > 0 && <select aria-label="Recent descriptions" value="" onChange={e => e.target.value && setPrompt(e.target.value)}><option value="">Recent…</option>{recent.map(r => <option key={r} value={r}>{r.length > 70 ? r.slice(0, 70) + '…' : r}</option>)}</select>}</div>
            <div className="yt-style-chips" role="radiogroup" aria-label="Style">{THUMB_STYLE_OPTIONS.map(o => <button key={o.key} role="radio" aria-checked={style === o.key} className={`chip ${style === o.key ? 'selected' : ''}`} onClick={() => setStyle(o.key)}>{o.label}</button>)}</div>
            <div className="form-grid">
                <Field label="Start from"><select aria-label="Start from" value={fromSelected ? 'selected' : 'nothing'} onChange={e => setFromSelected(e.target.value === 'selected')}><option value="nothing">Description only</option><option value="selected" disabled={!selected}>The selected background</option></select></Field>
                <Field label="Options"><select aria-label="Number of options" value={count} onChange={e => setCount(Number(e.target.value))}>{[1, 2, 4].map(n => <option key={n} value={n}>{n} image{n > 1 ? 's' : ''}</option>)}</select></Field>
                <Field label="Quality"><select aria-label="Quality" value={quality} onChange={e => setQuality(e.target.value as Quality)}>{QUALITY.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
                <Field label="Avoid (optional)"><input aria-label="Avoid" maxLength={300} value={avoid} onChange={e => setAvoid(e.target.value)} placeholder="e.g. people, gore, red"/></Field>
            </div>
            {fromSelected && <Field label={`Change from the original · ${Math.round(strength * 100)}%`}><input type="range" aria-label="Change strength" min="0.2" max="0.95" step="0.05" value={strength} onChange={e => setStrength(Number(e.target.value))}/></Field>}
            <div className="button-row">{generating ? <><span className="yt-loading-inline" role="status"><span className="status-dot"/>Generating on this PC…</span><Button onClick={() => void run('cancelThumbnail', undefined)}>Cancel</Button></> : <Button icon="spark" variant="primary" disabled={!ai?.ready || !prompt.trim()} onClick={() => void generate()}>Generate</Button>}</div>
            <p className="fine-print">{ai?.ready ? (genNote ?? `Runs on your GPU with ${ai.engine === 'sdcpp' ? 'stable-diffusion.cpp' : 'your Stable Diffusion WebUI'}. Nothing is uploaded. Text is added by Drift Studio, not the AI. Best quality takes about 1.5× longer.`) : (ai?.detail ?? 'Turn on the local generator in Settings → AI & Privacy.')}</p>
        </div>

        {layers.length > 0 && <div className="yt-layers" aria-label="Images on top">{layers.map(l => <div className={`yt-layer ${l.id === activeLayer ? 'active' : ''}`} key={l.id} onClick={() => setActiveLayer(l.id)}>
            <img src={l.src} alt=""/><strong title={l.name}>{l.name}</strong>
            <input type="range" aria-label={`Size of ${l.name}`} min="0.15" max="1.2" step="0.05" value={l.size} onChange={e => updateLayer(l.id, { size: Number(e.target.value) })}/>
            <label className="compact-toggle"><input type="checkbox" aria-label={`Outline ${l.name}`} checked={l.outline} onChange={e => updateLayer(l.id, { outline: e.target.checked })}/>Outline</label>
            <label className="compact-toggle"><input type="checkbox" aria-label={`Shadow ${l.name}`} checked={l.shadow} onChange={e => updateLayer(l.id, { shadow: e.target.checked })}/>Shadow</label>
            <button className="icon-button" aria-label={`Remove ${l.name}`} onClick={() => setLayers(x => x.filter(y => y.id !== l.id))}><Icon name="close" size={14}/></button>
        </div>)}
            {active && <div className="yt-layer-tools"><span>{active.name}</span><div className="button-row">{(['left', 'center', 'right'] as const).map(p => <Button key={p} variant="ghost" onClick={() => updateLayer(active.id, { cx: p === 'left' ? 0.22 : p === 'right' ? 0.78 : 0.5, cy: 1 - active.size / 2 })}>{p === 'center' ? 'Centre' : p[0]!.toUpperCase() + p.slice(1)}</Button>)}<Button variant="ghost" disabled={layers[layers.length - 1]?.id === active.id} onClick={() => setLayers(x => [...x.filter(y => y.id !== active.id), active])}>Bring to front</Button></div>
                <div className="yt-cutout"><Field label={`Remove plain background · tolerance ${Math.round(tolerance * 100)}%`}><input type="range" aria-label="Background tolerance" min="0.05" max="0.45" step="0.01" value={tolerance} onChange={e => setTolerance(Number(e.target.value))}/></Field><Button variant="ghost" onClick={() => void removeBackgroundOf(active)}>Remove background</Button>{active.original && <Button variant="ghost" onClick={() => updateLayer(active.id, { src: active.original!, original: undefined })}>Restore original</Button>}</div>
                <p className="fine-print">Removes a plain wall or green screen around the edges. For busy photos, use an image that is already cut out (transparent PNG).</p></div>}
        </div>}

        <div className="form-grid">
            <Field label="Thumbnail text"><input aria-label="Thumbnail text" maxLength={60} value={text} onChange={e => setText(e.target.value)} placeholder="Leave empty for a clean image"/></Field>
            <Field label="Text placement"><select aria-label="Text placement" value={place} onChange={e => setPlace(e.target.value as TextPlace)}><option value="left">Left side</option><option value="right">Right side</option><option value="top">Top</option><option value="bottom">Bottom</option></select></Field>
            <Field label="Font"><select aria-label="Font" value={font} onChange={e => setFont(e.target.value as FontKey)}>{(Object.keys(FONTS) as FontKey[]).map(k => <option key={k} value={k}>{FONTS[k].label}</option>)}</select></Field>
            <Field label="Text colour"><input type="color" aria-label="Text colour" value={color} onChange={e => setColor(e.target.value)}/></Field>
        </div>
        <label className="toggle"><input type="checkbox" checked={upper} onChange={e => setUpper(e.target.checked)}/>All capitals</label>
        <div className="yt-accents" role="radiogroup" aria-label="Accent colour">{ACCENTS.map(([name, c]) => <button key={c} role="radio" aria-checked={accent === c} aria-label={name} className={accent === c ? 'selected' : ''} style={{ background: c }} onClick={() => setAccent(c)}/>)}</div>
        <div className="button-row"><Button icon="image" disabled={!selected || pending.has('saveThumbnail')} onClick={() => void save()}>Save thumbnail (1280×720)</Button></div>
        <p className="fine-print">Save several versions to compare them with YouTube Studio's thumbnail test.</p>
    </section>;
}
