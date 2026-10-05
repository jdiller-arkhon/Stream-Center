import { useCallback, useEffect, useRef, useState } from 'react';
import { useStudio } from '../context';
import { Badge, Button, Empty, Field } from '../components/Primitives';
import { Icon } from '../components/Icon';
import { THUMB_STYLE_OPTIONS, type ThumbAiStatus, type YouTubeKit } from '../../shared/contracts';
import { suggestDescription } from '../thumbPrompts';
import { cutOut, drawThumbnail, exportJpeg, FONTS, H, NO_FX, readImageFile, VIBES, W, type BackgroundFx, type Decal, type FontKey, type Grade, type Layer, type Rect, type TextPlace } from '../thumbCanvas';

const ACCENTS = [['Mist', '#7c5cff'], ['Gold', '#ffc83d'], ['Ice', '#2fd3f0'], ['Ember', '#ff5a4e'], ['Lime', '#9be22d'], ['Blood', '#ff1a1a'], ['Magenta', '#ff2bd6']] as const;
const GRADES: Array<[Grade, string]> = [['none', 'None'], ['punch', 'Punchy'], ['noir', 'Noir'], ['teal-orange', 'Teal & orange'], ['duotone', 'Duotone (accent)'], ['blood', 'Blood red'], ['toxic', 'Toxic green']];
const DECALS: Array<[Decal['kind'], string]> = [['arrow', 'Arrow'], ['circle', 'Circle'], ['badge', 'Badge'], ['burst', 'Burst']];
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
    const [gradientTo, setGradientTo] = useState<string | null>(null);
    const [glow, setGlow] = useState(false);
    const [slant, setSlant] = useState(0);
    const [extrude, setExtrude] = useState(false);
    const [split, setSplit] = useState(false);
    const [bar, setBar] = useState(true);
    const [scale, setScale] = useState(1);
    const [fx, setFx] = useState<BackgroundFx>(NO_FX);
    const [vibe, setVibe] = useState('clean');
    const [decals, setDecals] = useState<Decal[]>([]);
    const [activeDecal, setActiveDecal] = useState<string | null>(null);
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
    const drag = useRef<{ id: string; dx: number; dy: number; kind: 'decal' | 'layer' } | null>(null);
    const bgInput = useRef<HTMLInputElement>(null);
    const layerInput = useRef<HTMLInputElement>(null);

    useEffect(() => { void run('thumbAiStatus', undefined).then(s => s && setAi(s)); }, [run]);
    const selected = backgrounds.find(b => b.id === selectedId) ?? backgrounds[0];

    useEffect(() => {
        const c = canvas.current;
        if (!c || !selected) return;
        let live = true;
        void drawThumbnail(c, { background: selected.src, text: { text, place, font, color, accent, upper, gradientTo, glow, slant, extrude, split, bar, scale }, layers, fx, decals }).then(r => {
            if (!live) return;
            rects.current = r;
            for (const p of [homePreview.current, phonePreview.current]) p?.getContext('2d')?.drawImage(c, 0, 0, p.width, p.height);
        }).catch(() => notify('Could not draw the thumbnail preview'));
        return () => { live = false; };
    }, [selected, text, place, font, color, accent, upper, gradientTo, glow, slant, extrude, split, bar, scale, layers, fx, decals, notify]);

    const updateLayer = useCallback((id: string, change: Partial<Layer>) => setLayers(x => x.map(l => l.id === id ? { ...l, ...change } : l)), []);
    const updateDecal = useCallback((id: string, change: Partial<Decal>) => setDecals(x => x.map(d => d.id === id ? { ...d, ...change } : d)), []);
    const setFxPart = (change: Partial<BackgroundFx>) => { setFx(f => ({ ...f, ...change })); setVibe('custom'); };
    const applyVibe = (key: string) => {
        const v = VIBES.find(x => x.key === key);
        if (!v) return;
        setVibe(key);
        const t = v.text;
        if (t.font) setFont(t.font);
        if (t.color) setColor(t.color);
        if (t.accent) setAccent(t.accent);
        setGradientTo(t.gradientTo ?? null);
        setGlow(!!t.glow); setSlant(t.slant ?? 0); setExtrude(!!t.extrude); setSplit(!!t.split); setBar(t.bar !== false);
        setFx({ ...NO_FX, ...v.fx });
        // Cut-outs follow the look: neon looks glow in the accent colour.
        setLayers(x => x.map(l => ({ ...l, outlineColor: key === 'neon' || key === 'glitch' || key === 'toxic' ? t.accent : '#ffffff', glow: key === 'neon' || key === 'glitch' || key === 'toxic' })));
    };
    const addDecal = (kind: Decal['kind']) => {
        const id = `decal-${Date.now()}`;
        const d: Decal = { id, kind, cx: kind === 'badge' ? 0.8 : 0.62, cy: kind === 'badge' ? 0.16 : 0.5, size: kind === 'arrow' ? 0.22 : kind === 'badge' ? 0.2 : 0.4, rot: kind === 'arrow' ? 200 : kind === 'badge' ? -6 : 0, color: kind === 'circle' || kind === 'arrow' ? '#ff1a1a' : kind === 'burst' ? '#ffe11a' : accent, text: kind === 'badge' ? 'INSANE' : kind === 'burst' ? 'WOW' : '' };
        setDecals(x => [...x, d]);
        setActiveDecal(id);
        setActiveLayer(null);
    };

    // Drag layers directly on the preview.
    const toCanvas = (e: React.PointerEvent<HTMLCanvasElement>) => { const r = e.currentTarget.getBoundingClientRect(); return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height }; };
    const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const p = toCanvas(e);
        const inside = (id: string) => { const r = rects.current.get(id); return !!r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h; };
        // Graphics sit on top of images, so they win the hit test.
        const d = [...decals].reverse().find(x => inside(x.id));
        const l = d ? undefined : [...layers].reverse().find(x => inside(x.id));
        const hit = d ? { id: d.id, cx: d.cx, cy: d.cy, kind: 'decal' as const } : l ? { id: l.id, cx: l.cx, cy: l.cy, kind: 'layer' as const } : undefined;
        if (!hit) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { id: hit.id, dx: p.x - hit.cx * W, dy: p.y - hit.cy * H, kind: hit.kind };
        if (hit.kind === 'decal') { setActiveDecal(hit.id); setActiveLayer(null); } else { setActiveLayer(hit.id); setActiveDecal(null); }
    };
    const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const d = drag.current;
        if (!d) return;
        const p = toCanvas(e);
        const pos = { cx: Math.min(1.2, Math.max(-0.2, (p.x - d.dx) / W)), cy: Math.min(1.3, Math.max(-0.3, (p.y - d.dy) / H)) };
        if (d.kind === 'decal') updateDecal(d.id, pos); else updateLayer(d.id, pos);
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
        {selected && <div className="yt-vibes"><span>Look</span><div className="yt-style-chips" role="radiogroup" aria-label="Look">{VIBES.map(v => <button key={v.key} role="radio" aria-checked={vibe === v.key} className={`chip vibe-${v.key} ${vibe === v.key ? 'selected' : ''}`} onClick={() => applyVibe(v.key)}>{v.label}</button>)}{vibe === 'custom' && <span className="chip selected" aria-hidden="true">Custom</span>}</div></div>}
        {(layers.length > 0 || decals.length > 0) && <p className="fine-print">Drag images and graphics on the preview to move them.</p>}
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
                <div className="button-row"><label className="compact-toggle">Outline colour <input type="color" aria-label={`Outline colour of ${active.name}`} value={active.outlineColor ?? '#ffffff'} onChange={e => updateLayer(active.id, { outlineColor: e.target.value })}/></label><label className="compact-toggle"><input type="checkbox" aria-label={`Glow ${active.name}`} checked={!!active.glow} onChange={e => updateLayer(active.id, { glow: e.target.checked })}/>Neon glow</label></div>
                <div className="yt-cutout"><Field label={`Remove plain background · tolerance ${Math.round(tolerance * 100)}%`}><input type="range" aria-label="Background tolerance" min="0.05" max="0.45" step="0.01" value={tolerance} onChange={e => setTolerance(Number(e.target.value))}/></Field><Button variant="ghost" onClick={() => void removeBackgroundOf(active)}>Remove background</Button>{active.original && <Button variant="ghost" onClick={() => updateLayer(active.id, { src: active.original!, original: undefined })}>Restore original</Button>}</div>
                <p className="fine-print">Removes a plain wall or green screen around the edges. For busy photos, use an image that is already cut out (transparent PNG).</p></div>}
        </div>}

        <div className="yt-panel" aria-label="Graphics"><div className="yt-panel-head"><strong>Graphics</strong><div className="button-row">{DECALS.map(([k, label]) => <Button key={k} icon="plus" variant="ghost" onClick={() => addDecal(k)}>{label}</Button>)}</div></div>
            {decals.map(d => <div key={d.id} className={`yt-decal ${d.id === activeDecal ? 'active' : ''}`} onClick={() => { setActiveDecal(d.id); setActiveLayer(null); }}>
                <strong>{DECALS.find(x => x[0] === d.kind)![1]}</strong>
                {(d.kind === 'badge' || d.kind === 'burst') && <input aria-label={`${d.kind} text`} maxLength={14} value={d.text} onChange={e => updateDecal(d.id, { text: e.target.value })}/>}
                <input type="color" aria-label={`${d.kind} colour`} value={d.color} onChange={e => updateDecal(d.id, { color: e.target.value })}/>
                <input type="range" aria-label={`${d.kind} size`} min="0.08" max="0.7" step="0.01" value={d.size} onChange={e => updateDecal(d.id, { size: Number(e.target.value) })}/>
                <input type="range" aria-label={`${d.kind} rotation`} min="-180" max="360" step="5" value={d.rot} onChange={e => updateDecal(d.id, { rot: Number(e.target.value) })}/>
                <button className="icon-button" aria-label={`Remove ${d.kind}`} onClick={() => setDecals(x => x.filter(y => y.id !== d.id))}><Icon name="close" size={14}/></button>
            </div>)}
        </div>

        <div className="yt-panel" aria-label="Effects"><div className="yt-panel-head"><strong>Effects</strong></div>
            <div className="form-grid">
                <Field label="Colour grade"><select aria-label="Colour grade" value={fx.grade} onChange={e => setFxPart({ grade: e.target.value as Grade })}>{GRADES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
                <Field label={`Vignette · ${Math.round(fx.vignette * 100)}%`}><input type="range" aria-label="Vignette" min="0" max="1" step="0.05" value={fx.vignette} onChange={e => setFxPart({ vignette: Number(e.target.value) })}/></Field>
                <Field label={`Grain · ${Math.round(fx.grain * 100)}%`}><input type="range" aria-label="Grain" min="0" max="1" step="0.05" value={fx.grain} onChange={e => setFxPart({ grain: Number(e.target.value) })}/></Field>
                <Field label={`Glitch · ${Math.round(fx.glitch * 100)}%`}><input type="range" aria-label="Glitch" min="0" max="1" step="0.05" value={fx.glitch} onChange={e => setFxPart({ glitch: Number(e.target.value) })}/></Field>
            </div>
            <div className="button-row"><label className="compact-toggle"><input type="checkbox" checked={fx.speedLines} onChange={e => setFxPart({ speedLines: e.target.checked })}/>Speed lines</label><label className="compact-toggle"><input type="checkbox" checked={fx.scanlines} onChange={e => setFxPart({ scanlines: e.target.checked })}/>Scanlines</label><label className="compact-toggle"><input type="checkbox" checked={fx.shade} onChange={e => setFxPart({ shade: e.target.checked })}/>Darken behind text</label></div>
        </div>

        <div className="form-grid">
            <Field label="Thumbnail text"><input aria-label="Thumbnail text" maxLength={60} value={text} onChange={e => setText(e.target.value)} placeholder="Leave empty for a clean image"/></Field>
            <Field label="Text placement"><select aria-label="Text placement" value={place} onChange={e => setPlace(e.target.value as TextPlace)}><option value="left">Left side</option><option value="right">Right side</option><option value="top">Top</option><option value="bottom">Bottom</option><option value="center">Centre</option></select></Field>
            <Field label="Font"><select aria-label="Font" value={font} onChange={e => setFont(e.target.value as FontKey)}>{(Object.keys(FONTS) as FontKey[]).map(k => <option key={k} value={k}>{FONTS[k].label}</option>)}</select></Field>
            <Field label="Text colour"><input type="color" aria-label="Text colour" value={color} onChange={e => setColor(e.target.value)}/></Field>
        </div>
        <div className="yt-text-fx" aria-label="Text effects">
            <label className="compact-toggle"><input type="checkbox" checked={upper} onChange={e => setUpper(e.target.checked)}/>All capitals</label>
            <label className="compact-toggle"><input type="checkbox" checked={glow} onChange={e => { setGlow(e.target.checked); setVibe('custom'); }}/>Glow</label>
            <label className="compact-toggle"><input type="checkbox" checked={extrude} onChange={e => { setExtrude(e.target.checked); setVibe('custom'); }}/>3D</label>
            <label className="compact-toggle"><input type="checkbox" checked={split} onChange={e => { setSplit(e.target.checked); setVibe('custom'); }}/>RGB split</label>
            <label className="compact-toggle"><input type="checkbox" checked={bar} onChange={e => setBar(e.target.checked)}/>Accent bar</label>
            <label className="compact-toggle"><input type="checkbox" checked={gradientTo !== null} onChange={e => { setGradientTo(e.target.checked ? '#ff8a00' : null); setVibe('custom'); }}/>Gradient</label>
            {gradientTo !== null && <input type="color" aria-label="Gradient colour" value={gradientTo} onChange={e => setGradientTo(e.target.value)}/>}
        </div>
        <div className="form-grid">
            <Field label={`Slant · ${Math.round(slant * 100)}%`}><input type="range" aria-label="Slant" min="0" max="0.35" step="0.01" value={slant} onChange={e => setSlant(Number(e.target.value))}/></Field>
            <Field label={`Text size · ${Math.round(scale * 100)}%`}><input type="range" aria-label="Text size" min="0.7" max="1.4" step="0.05" value={scale} onChange={e => setScale(Number(e.target.value))}/></Field>
        </div>
        <div className="yt-accents" role="radiogroup" aria-label="Accent colour">{ACCENTS.map(([name, c]) => <button key={c} role="radio" aria-checked={accent === c} aria-label={name} className={accent === c ? 'selected' : ''} style={{ background: c }} onClick={() => setAccent(c)}/>)}</div>
        <div className="button-row"><Button icon="image" disabled={!selected || pending.has('saveThumbnail')} onClick={() => void save()}>Save thumbnail (1280×720)</Button></div>
        <p className="fine-print">Save several versions to compare them with YouTube Studio's thumbnail test.</p>
    </section>;
}
