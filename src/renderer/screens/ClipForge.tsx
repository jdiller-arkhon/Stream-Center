import {readLocalVideo, resolveMediaUrl} from '../media';
import {MediaArt} from '../components/MediaArt';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useSnapshot, useStudio } from '../context';
import { Button, Badge, Empty, Field, Modal, time } from '../components/Primitives';
import { Icon } from '../components/Icon';
import { Arena } from '../components/Artwork';
import { PageHeading } from './Supporting';
import { YouTubeKit } from './YouTubeKit';
import { makeProject, uid, now } from '../../services/fixtures';
import type { ClipAsset, EditProject, ExportPreset, Moment, TimelineSegment } from '../../shared/contracts';
const presets = ['Clean Highlight', 'Cinematic', 'Vertical Short', 'Squad Recap'];
const isText = (target: EventTarget | null) => target instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName) || target.isContentEditable);
export function ClipForge() {
    const s = useSnapshot();
    const { service, selectedClip, openClip, run, pending, notify, registerMedia, media } = useStudio();
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState('All media');
    const [favorite, setFavorite] = useState(false);
    const [current, setCurrent] = useState(selectedClip ?? s.clips[0]?.id ?? null);
    const clip = s.clips.find(c => c.id === current);
    const [draft, setDraft] = useState<EditProject | null>(null);
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const [undo, setUndo] = useState<EditProject[]>([]);
    const [redo, setRedo] = useState<EditProject[]>([]);
    const [inspector, setInspector] = useState('Edit');
    const [workflow, setWorkflow] = useState('Editor');
    const [exporting, setExporting] = useState(false);
    const [queue, setQueue] = useState(false);
    const [position, setPosition] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [zoom, setZoom] = useState(1);
    const [snap, setSnap] = useState(true);
    const [selectedSegment, setSelectedSegment] = useState<string | null>(null);
    const [saveStatus, setSaveStatus] = useState('Draft');
    const [importing, setImporting] = useState(false);
    const [waveform, setWaveform] = useState<number[] | null>(null);
    const [mediaError, setMediaError] = useState(false);
    const [preset, setPreset] = useState<ExportPreset>({ destination: s.settings.mediaFolder, aspect: '16:9', resolution: 1080, fps: 60, quality: 'high', codec: 'h264' });
    const [simulateFailure, setSimulateFailure] = useState(false);
    const [musicName, setMusicName] = useState('');
    const [kitJob, setKitJob] = useState<string | null>(null);
    const [moments, setMoments] = useState<Moment[] | null>(null);
    const desktop = s.mode === 'desktop';
    const input = useRef<HTMLInputElement>(null);
    const musicInput = useRef<HTMLInputElement>(null);
    const recover = useRef<ClipAsset | null>(null);
    const video = useRef<HTMLVideoElement>(null);
    const frameRef = useRef<HTMLDivElement>(null);
    const [previewWidth, setPreviewWidth] = useState(600);
    useEffect(() => { const frame = frameRef.current; if (!frame)
        return; const resize = new ResizeObserver(entries => setPreviewWidth(entries[0].contentRect.width)); resize.observe(frame); return () => resize.disconnect(); }, [current, draft?.aspect,clip?.status]);
    const music = useRef<HTMLAudioElement>(null);
    const mediaUrl = resolveMediaUrl(clip?.mediaHandle ?? null, media);
    const segments = draft?.tracks.find(t => t.kind === 'video')?.segments ?? [];
    const segment = segments.find(x => x.id === selectedSegment) ?? segments[0];
    const duration = segments.reduce((max, x) => Math.max(max, x.offsetMs + x.outMs - x.inMs), 0);
    const currentSegment = segments.find(x => position >= x.offsetMs && position < x.offsetMs + x.outMs - x.inMs) ?? segments[segments.length - 1];
    useEffect(() => { if (selectedClip)
        setCurrent(selectedClip); }, [selectedClip]);
    useEffect(() => { if (!clip) {
        setDraft(null);
        return;
    } const saved = service.getSnapshot().projects.find(p => p.assetId === clip.id); setDraft(saved ?? makeProject(clip)); setUndo([]); setRedo([]); setPosition(0); setPlaying(false); setSelectedSegment(null); setMediaError(false); setMoments(null); }, [current, service, clip?.id]);
    useEffect(() => { if (!draft)
        return; setSaveStatus('Saving…'); const timeout = setTimeout(async () => { try {
        await service.invoke('saveProject', { ...draft, updatedAt: now() });
        setSaveStatus('Saved locally');
    }
    catch (e) {
        setSaveStatus('Save failed');
        notify(e instanceof Error ? e.message : 'Save failed');
    } }, 450); return () => clearTimeout(timeout); }, [draft, service, notify]);
    useEffect(() => () => { const project = draftRef.current; if (project)
        void service.invoke('saveProject', { ...project, updatedAt: now() }).catch(e => notify(e instanceof Error ? e.message : 'Draft save failed')); }, [service, notify]);
    const edit = useCallback((change: (p: EditProject) => EditProject) => { const previous = draftRef.current; if (!previous)
        return; const next = change(structuredClone(previous)); setUndo(u => [...u.slice(-49), previous]); setRedo([]); setDraft(next); setPlaying(false); }, []);
    const undoEdit = useCallback(() => { if (!undo.length || !draft)
        return; setRedo(r => [...r, draft]); setDraft(undo[undo.length - 1]); setUndo(u => u.slice(0, -1)); setPlaying(false); }, [undo, draft]);
    const redoEdit = useCallback(() => { if (!redo.length || !draft)
        return; setUndo(u => [...u, draft]); setDraft(redo[redo.length - 1]); setRedo(r => r.slice(0, -1)); setPlaying(false); }, [redo, draft]);
    useEffect(() => { const handler = (e: KeyboardEvent) => { if (!s.settings.shortcuts || isText(e.target))
        return; if (e.code === 'Space') {
        e.preventDefault();
        setPlaying(x => !x);
    } if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? redoEdit() : undoEdit();
    } }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler); }, [undoEdit, redoEdit, s.settings.shortcuts]);
    // Project-clock transport. Source in/out and segment order drive video seeking.
    useEffect(() => { if (!playing || !duration)
        return; let frame = 0; let previous = performance.now(); const tick = (at: number) => { const delta = at - previous; previous = at; setPosition(p => { const next = p + delta; if (next >= duration) {
        setPlaying(false);
        return duration;
    } return next; }); frame = requestAnimationFrame(tick); }; frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame); }, [playing, duration]);
    useEffect(() => { if (position > duration)
        setPosition(duration); }, [duration, position]);
    useEffect(() => { const v = video.current; if (!v || !currentSegment)
        return; const target = (currentSegment.inMs + Math.max(0, position - currentSegment.offsetMs)) / 1000; if (Math.abs(v.currentTime - target) > .15)
        v.currentTime = target; const local = position - currentSegment.offsetMs; const fadeIn = currentSegment.fadeInMs ? Math.min(1, local / currentSegment.fadeInMs) : 1; const remaining = currentSegment.outMs - currentSegment.inMs - local; const fadeOut = currentSegment.fadeOutMs ? Math.min(1, remaining / currentSegment.fadeOutMs) : 1; v.volume = Math.max(0, Math.min(1, (draft?.originalGain ?? 1) * currentSegment.gain * fadeIn * fadeOut)); if (playing) {
        void v.play().catch(() => { setPlaying(false); setMediaError(true); });
    }
    else
        v.pause(); }, [position, playing, currentSegment, draft?.originalGain]);
    const musicUrl = resolveMediaUrl(draft?.musicHandle ?? null, media);
    useEffect(() => { const a = music.current; if (!a)
        return; a.volume = draft?.musicGain ?? 0.3; if (Math.abs(a.currentTime - position / 1000) > .2)
        a.currentTime = Math.min(position / 1000, Number.isFinite(a.duration) ? a.duration : position / 1000); if (playing)
        void a.play().catch(() => notify('Music playback is unavailable. Reimport the audio file.'));
    else
        a.pause(); }, [position, playing, draft?.musicGain, musicUrl, notify]);
    useEffect(() => { let cancel = false; setWaveform(null); if (!mediaUrl || !clip || clip.durationMs > 300000)
        return; const ctx = new AudioContext(); void fetch(mediaUrl).then(r => { if (Number(r.headers.get('content-length') ?? 0) > 134217728)
        throw new Error('Waveform analysis exceeds browser memory budget'); return r.arrayBuffer(); }).then(b => ctx.decodeAudioData(b)).then(buffer => { if (cancel)
        return; const samples = buffer.getChannelData(0); const bars = Array.from({ length: 128 }, (_, i) => { const from = Math.floor(i * samples.length / 128), to = Math.floor((i + 1) * samples.length / 128); let peak = 0; for (let n = from; n < to; n += Math.max(1, Math.floor((to - from) / 300)))
        peak = Math.max(peak, Math.abs(samples[n])); return peak; }); setWaveform(bars); }).catch(() => { if (!cancel)
        setWaveform(null); }).finally(() => void ctx.close()); return () => { cancel = true; }; }, [mediaUrl]);
    const choose = (c: ClipAsset) => { setCurrent(c.id); openClip(c); };
    /** Desktop: native picker in main; files are probed and indexed there (no browser handles). */
    const importDesktop = async () => { setImporting(true); try { const clips = await run('importNative', undefined); if (clips?.[0]) choose(clips[0]); else if (clips) notify('No new clips imported.'); } finally { setImporting(false); } };
    const importFiles = async (files: FileList | null) => { if (!files?.length)
        return; setImporting(true); for (const file of Array.from(files)) {
        if (!file.type.startsWith('video/') && !/\.(mp4|webm|mov|mkv)$/i.test(file.name)) {
            notify('Choose a supported video recording.');
            continue;
        }
        if (!recover.current && s.clips.some(c => c.name === file.name && !c.fixture)) {
            notify(`${file.name} is already indexed. Duplicate skipped.`);
            continue;
        }
        const url = URL.createObjectURL(file);
        try {
            const {durationMs,thumbnailUrl} = await readLocalVideo(url);
            const handle = uid();
            registerMedia(handle, url);
            if (recover.current) {
                const target = recover.current;
                await service.invoke('updateClip', { ...target, fixture: false, mediaHandle: handle, name: file.name, durationMs, thumbnailUrl, status: 'ready' });
                setCurrent(target.id);
                recover.current = null;
                setMediaError(false);
            }
            else {
                const clips = await run('importClips', { files: [{ name: file.name, durationMs, mediaHandle: handle }] });
                if (clips?.[0]) {const updated={...clips[0],thumbnailUrl};await service.invoke('updateClip',updated);choose(updated);}
            }
        }
        catch (e) {
            URL.revokeObjectURL(url);
            notify(e instanceof Error ? e.message : 'Import failed');
        }
    } setImporting(false); if (input.current)
        input.current.value = ''; };
    const changeSegment = (change: Partial<TimelineSegment>) => { if (!segment)
        return; edit(p => ({ ...p, tracks: p.tracks.map(t => ({ ...t, segments: reflow(t.segments.map(x => x.id === segment.id ? { ...x, ...change } : x)) })) })); };
    const reflow = (items: TimelineSegment[]) => { let offset = 0; return items.map(x => { const n = { ...x, offsetMs: offset }; offset += x.outMs - x.inMs; return n; }); };
    const split = () => { if (!currentSegment)
        return; const source = currentSegment.inMs + position - currentSegment.offsetMs; if (source <= currentSegment.inMs + 100 || source >= currentSegment.outMs - 100) {
        notify('Place the playhead inside a clip to split.');
        return;
    } edit(p => ({ ...p, tracks: p.tracks.map(t => t.kind !== 'video' ? t : { ...t, segments: reflow(t.segments.flatMap(x => x.id === currentSegment.id ? [{ ...x, outMs: Math.round(source) }, { ...x, id: uid(), inMs: Math.round(source) }] : [x])) }) })); notify('Clip split. Select a segment to trim or reorder it.'); };
    const applyPreset = (name: string) => edit(p => ({ ...p, preset: name, aspect: name === 'Vertical Short' ? '9:16' : '16:9', musicGain: name === 'Cinematic' ? .25 : .3, captionStyle: { ...p.captionStyle, size: name === 'Vertical Short' ? 42 : 32 }, tracks: p.tracks.map(t => ({ ...t, segments: t.segments.map(x => ({ ...x, fadeInMs: name === 'Cinematic' ? 400 : 0, fadeOutMs: name === 'Cinematic' ? 600 : 0 })) })) }));
    const scrub = (value: number) => { setPosition(Math.max(0, Math.min(duration, snap ? Math.round(value / 100) * 100 : value))); setPlaying(false); };
    const downloadDraft = () => { if (!draft)
        return; const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'drift-edit-project.json'; a.click(); URL.revokeObjectURL(url); };
    /** Desktop: find the loudest passages with FFmpeg (EBU R128), loudest first. */
    const findMoments = async () => { if (!clip) return null; const m = await run('suggestMoments', { clipId: clip.id }); if (m) { setMoments(m); if (!m.length) notify('No clear loud moments found in this clip.'); } return m ?? null; };
    /** Vertical 9:16 cut of up to 30 s around the loudest moment (most of it leading up to the moment). */
    const makeShort = async () => { if (!clip || !draft) return; const m = moments ?? await findMoments(); const at = m?.[0]?.atMs ?? Math.round(clip.durationMs / 2); const len = Math.min(30000, clip.durationMs); const inMs = Math.max(0, Math.min(Math.round(at - len * 0.7), clip.durationMs - len)); edit(p => ({ ...p, name: p.name.endsWith(' (Short)') ? p.name : `${p.name.replace(/\.(mp4|mkv|mov|webm)$/i, '')} (Short)`, preset: 'Vertical Short', aspect: '9:16', safeAreas: true, captionStyle: { ...p.captionStyle, size: 42 }, tracks: p.tracks.map(t => t.kind !== 'video' ? t : { ...t, segments: reflow([{ ...(t.segments[0] ?? { id: uid(), assetId: clip.id, offsetMs: 0, gain: 1, fadeInMs: 0, fadeOutMs: 0 }), inMs, outMs: inMs + len }]) }) })); setPreset(x => ({ ...x, aspect: '9:16', resolution: 1080, fps: 60, loudness: true })); setPosition(0); notify(m?.length ? `Short cut around the loudest moment at ${time(at)}. Fine-tune in/out, then export.` : 'Short cut from the middle of the clip. Fine-tune in/out, then export.'); };
    const youtubePreset = (kind: 'video' | 'short') => setPreset(x => ({ ...x, resolution: kind === 'short' ? 1080 : 1440, fps: 60, quality: 'high', codec: 'h264', loudness: true }));
    const visible = s.clips.filter(c => `${c.name} ${c.tags.join(' ')} ${c.game}`.toLowerCase().includes(query.toLowerCase()) && (!favorite || c.favorite) && (filter === 'All media' || c.game === filter));
    return <><PageHeading eyebrow="TURN GOOD PLAYS INTO GREAT STORIES" title="ClipForge" sub="Your footage. Your timing. Your finishing touch."><div className="button-row"><Button icon="upload" onClick={() => service.mode === 'desktop' ? void importDesktop() : input.current?.click()} disabled={importing}>{importing ? 'Indexing…' : 'Import media'}</Button><Button icon="download" variant="primary" disabled={!draft} onClick={() => { setPreset(p => ({ ...p, aspect: draft?.aspect ?? '16:9' })); setExporting(true); }}>Export clip</Button></div></PageHeading><input hidden type="file" accept="video/*,.mkv,.mov" multiple ref={input} onChange={e => void importFiles(e.target.files)}/><input hidden type="file" accept="audio/*" ref={musicInput} onChange={e => { const f = e.target.files?.[0]; if (f) {
        const handle = uid();
        registerMedia(handle, URL.createObjectURL(f));
        setMusicName(f.name);
        edit(p => ({ ...p, musicHandle: handle }));
    } }}/>
 <div className="forge-toolbar"><div className="segmented">{['Editor', 'Quick Clip'].map(x => <button className={workflow === x ? 'selected' : ''} key={x} onClick={() => setWorkflow(x)}>{x}</button>)}</div><span className="autosave"><span className="status-dot"/>{saveStatus}</span><Button icon="folder" variant="ghost" onClick={() => setQueue(true)}>Export queue ({s.jobs.length})</Button></div>
 <div className={`forge-workspace ${workflow === 'Quick Clip' ? 'quick' : ''}`}><aside className="media-browser"><div className="browser-title"><h2>Media library</h2><Badge>{s.clips.length}</Badge></div><div className="input-icon"><Icon name="search"/><input aria-label="Search media" value={query} onChange={e => setQuery(e.target.value)} placeholder="Find a moment…"/></div><div className="browser-filters"><select aria-label="Filter media by game" value={filter} onChange={e => setFilter(e.target.value)}><option>All media</option>{Array.from(new Set(s.clips.map(c => c.game))).map(x => <option key={x}>{x}</option>)}</select><button className={`icon-button ${favorite ? 'active' : ''}`} aria-label="Show favorites" aria-pressed={favorite} onClick={() => setFavorite(x => !x)}><Icon name="star"/></button></div><div className="media-list">{visible.map((c, i) => <div key={c.id} className={`media-item ${c.id === current ? 'selected' : ''}`}><button className="media-select" onClick={() => choose(c)}><div className="media-thumbnail"><MediaArt clip={c} variant={i}/><span className="duration">{time(c.durationMs)}</span></div><strong>{c.name}</strong><small>{c.game}</small><div className="media-meta"><Badge tone={c.status === 'missing' ? 'amber' : i % 2 ? 'violet' : 'cyan'}>{c.status === 'missing' ? 'Missing' : c.tags[0] ?? 'Clip'}</Badge><span>{c.fixture ? 'Fixture' : 'Local'}</span></div></button><button className={`favorite-button ${c.favorite ? 'active' : ''}`} aria-label={`${c.favorite ? 'Unfavorite' : 'Favorite'} ${c.name}`} onClick={() => void run('updateClip', { ...c, favorite: !c.favorite })}><Icon name="star" size={14}/></button></div>)}{!visible.length && <Empty title="No media found" detail="Try another search or import a recording."/>}</div><div className="library-footer"><Icon name="folder"/><span>Local library · originals preserved</span></div></aside>
 <div className="editor-center"><div className="preview-heading"><div><h2>{draft?.name ?? 'Choose a moment'}</h2><span>{draft ? `${draft.aspect} · ${draft.preset}` : 'Start with a replay or recording'}</span></div><Badge tone="violet">{mediaUrl ? 'Local preview' : 'Illustrative preview'}</Badge></div><div className={`editor-preview ${draft?.aspect === '9:16' ? 'vertical' : ''}`}>
 {clip?.status === 'missing' || mediaError ? <Empty icon="alert" title={mediaError ? 'Preview could not play' : 'Media file is missing'} detail="Browser file handles expire after restart. Relink the original recording to recover this draft."><Button icon="link" onClick={() => { if (service.mode === 'desktop') { if (clip) void run('relinkNative', { id: clip.id }).then(c => { if (c) setMediaError(false); }); return; } recover.current = clip ?? null; input.current?.click(); }}>Locate recording</Button></Empty> : clip ? <div className="preview-frame" ref={frameRef} style={{ aspectRatio: draft?.aspect === '9:16' ? '9 / 16' : '16 / 9' }}>{mediaUrl ? <video ref={video} src={mediaUrl} playsInline preload="metadata" onError={() => setMediaError(true)} style={{ objectPosition: `${draft?.cropX}% ${draft?.cropY}%` }}/> : <Arena />}{draft?.safeAreas && <div className="safe-area"><span>SAFE AREA</span></div>}{draft?.webcam && <div className="webcam-placeholder">Webcam layout<br />No source connected</div>}{draft?.captions.filter(c => position >= c.startMs && position <= c.endMs).map(c => <div key={c.id} className={`preview-caption caption-${draft.captionStyle.position}`} style={{ fontFamily: draft.captionStyle.font, fontSize: draft.captionStyle.size * previewWidth / (draft.aspect === '9:16' ? 1080 : 1920), color: draft.captionStyle.color }}>{c.text}</div>)}<div className="preview-game-label">{clip.game} <span>{clip.fixture ? 'DEMO FIXTURE' : 'LOCAL VIDEO'}</span></div></div> : <Empty title="Your next edit starts here" detail="Import a recording or choose a saved replay."/>}</div>
 {musicUrl && <audio src={musicUrl} ref={music} preload="metadata"/>}<div className="transport"><div className="button-row"><button className="icon-button" aria-label="Jump to start" onClick={() => scrub(0)}><Icon name="undo"/></button><button className="play-button" disabled={!draft} aria-label={playing ? 'Pause playback' : 'Play preview'} onClick={() => { if (position >= duration)
        setPosition(0); setPlaying(x => !x); }}><Icon name={playing ? 'pause' : 'play'}/></button><button className="icon-button" aria-label="Jump to end" onClick={() => scrub(duration)}><Icon name="redo"/></button></div><span className="timecode">{time(position)} <span>/ {time(duration)}</span></span><div className="button-row"><Button variant="ghost" disabled={!undo.length} icon="undo" onClick={undoEdit}>Undo</Button><Button variant="ghost" disabled={!redo.length} icon="redo" onClick={redoEdit}>Redo</Button></div></div>
 <div className="preset-strip">{presets.map((p, i) => <button key={p} disabled={!draft} className={draft?.preset === p ? 'selected' : ''} onClick={() => applyPreset(p)}><span className={`preset-dot preset-${i}`}/>{p}</button>)}</div>{desktop && <div className="yt-tools"><Button icon="youtube" disabled={!draft || !clip || clip.status !== 'ready' || pending.has('suggestMoments')} onClick={() => void makeShort()}>{pending.has('suggestMoments') ? 'Listening for highlights…' : 'Make a Short'}</Button><Button icon="spark" variant="ghost" disabled={!clip || clip.status !== 'ready' || pending.has('suggestMoments')} onClick={() => void findMoments()}>Find loud moments</Button>{moments && moments.length > 0 && <div className="moment-chips" aria-label="Loud moments">{moments.map(m => <button key={m.atMs} className="moment-chip" title={`${m.excessLu > 0 ? '+' : ''}${m.excessLu} LU above this clip's typical level`} onClick={() => { const seg = segments.find(x => m.atMs >= x.inMs && m.atMs < x.outMs); if (seg) scrub(seg.offsetMs + m.atMs - seg.inMs); else notify(`${time(m.atMs)} is outside the current cut. Widen the in/out points to include it.`); }}>{time(m.atMs)}<small>+{Math.max(0, Math.round(m.excessLu))} LU</small></button>)}</div>}</div>}<p className="preview-note">{mediaUrl ? 'Preview uses the draft’s trim, crop, captions and audio mix.' : (s.mode === 'demo' ? 'Fixtures animate the timeline only. Import footage for real picture and sound.' : 'Preparing playback… the original is untouched.')}</p></div>
 <aside className="edit-inspector"><div className="inspector-tabs">{['Edit', 'Layout', 'Captions', 'Audio'].map(x => <button key={x} className={inspector === x ? 'selected' : ''} onClick={() => setInspector(x)}>{x}</button>)}</div>{draft && clip ? <div className="inspector-body">{inspector === 'Edit' && <><span className="eyebrow">THE CUT</span><h3>{workflow === 'Quick Clip' ? 'Quick trim' : 'Selected segment'}</h3><Field label="Draft name"><input value={draft.name} onChange={e => edit(p => ({ ...p, name: e.target.value }))}/></Field>{segment && <><div className="form-grid"><Field label="In (seconds)"><input type="number" step="0.1" min="0" max={(segment.outMs - 100) / 1000} value={segment.inMs / 1000} onChange={e => { const v = Math.round(Number(e.target.value) * 1000); if (v >= 0 && v < segment.outMs)
            changeSegment({ inMs: v }); }}/></Field><Field label="Out (seconds)"><input type="number" step="0.1" min={(segment.inMs + 100) / 1000} max={clip.durationMs / 1000} value={segment.outMs / 1000} onChange={e => { const v = Math.round(Number(e.target.value) * 1000); if (v > segment.inMs && v <= clip.durationMs)
            changeSegment({ outMs: v }); }}/></Field></div><div className="button-row"><Button disabled={position >= duration} onClick={() => { const v = segment.inMs + position - segment.offsetMs; if (v >= 0 && v < segment.outMs)
            changeSegment({ inMs: Math.round(v) }); }}>Set in</Button><Button onClick={() => { const v = segment.inMs + position - segment.offsetMs; if (v > segment.inMs && v <= clip.durationMs)
            changeSegment({ outMs: Math.round(v) }); }}>Set out</Button></div><hr /><Field label={`Fade in · ${segment.fadeInMs}ms`}><input type="range" min="0" max="2000" step="100" value={segment.fadeInMs} onChange={e => changeSegment({ fadeInMs: Number(e.target.value) })}/></Field><Field label={`Fade out · ${segment.fadeOutMs}ms`}><input type="range" min="0" max="2000" step="100" value={segment.fadeOutMs} onChange={e => changeSegment({ fadeOutMs: Number(e.target.value) })}/></Field></>}<div className="callout">{draft.preset === 'Cinematic' ? 'Cinematic: 400ms audio fade in, 600ms out, reduced music gain.' : 'Clean cuts. No flashing transitions or hidden effects.'}</div><Field label="Tags (comma separated)"><input defaultValue={clip.tags.join(', ')} key={clip.id} onBlur={e => void run('updateClip', { ...clip, tags: e.target.value.split(',').map(x => x.trim()).filter(Boolean) })}/></Field><Button icon="download" variant="ghost" onClick={downloadDraft}>Download draft JSON</Button></>}
 {inspector === 'Layout' && <><span className="eyebrow">FRAME THE MOMENT</span><h3>Canvas & crop</h3><Field label="Aspect ratio"><select value={draft.aspect} onChange={e => edit(p => ({ ...p, aspect: e.target.value as '16:9' | '9:16' }))}><option value="16:9">16:9 · Widescreen</option><option value="9:16">9:16 · Vertical short</option></select></Field><Field label={`Horizontal crop · ${draft.cropX}%`}><input type="range" min="0" max="100" value={draft.cropX} onChange={e => edit(p => ({ ...p, cropX: Number(e.target.value) }))}/></Field><Field label={`Vertical crop · ${draft.cropY}%`}><input type="range" min="0" max="100" value={draft.cropY} onChange={e => edit(p => ({ ...p, cropY: Number(e.target.value) }))}/></Field><label className="toggle"><input type="checkbox" checked={draft.safeAreas} onChange={e => edit(p => ({ ...p, safeAreas: e.target.checked }))}/>Show safe-area guides</label><label className="toggle"><input type="checkbox" checked={draft.webcam} onChange={e => edit(p => ({ ...p, webcam: e.target.checked }))}/>Webcam placement guide</label><p className="fine-print">Webcam is a placement placeholder until a source is configured. Crop controls affect imported video.</p></>}
 {inspector === 'Captions' && <><span className="eyebrow">LET THE MOMENT SPEAK</span><h3>Editable captions</h3><Button icon="plus" onClick={() => edit(p => ({ ...p, captions: [...p.captions, { id: uid(), text: 'What a finish.', startMs: Math.min(Math.round(position), Math.max(0, duration - 1000)), endMs: Math.min(duration, Math.max(1000, Math.round(position) + 3000)) }] }))}>Add caption</Button>{draft.captions.map(c => <div className="caption-edit" key={c.id}><textarea aria-label="Caption text" value={c.text} onChange={e => edit(p => ({ ...p, captions: p.captions.map(x => x.id === c.id ? { ...x, text: e.target.value } : x) }))}/><div className="form-grid"><Field label="Start (s)"><input type="number" min="0" max={c.endMs / 1000 - 0.1} step="0.1" value={c.startMs / 1000} onChange={e => { const v = Number(e.target.value) * 1000; if (v >= 0 && v < c.endMs)
            edit(p => ({ ...p, captions: p.captions.map(x => x.id === c.id ? { ...x, startMs: v } : x) })); }}/></Field><Field label="End (s)"><input type="number" min={c.startMs / 1000 + 0.1} max={duration / 1000} step="0.1" value={c.endMs / 1000} onChange={e => { const v = Number(e.target.value) * 1000; if (v > c.startMs && v <= duration)
            edit(p => ({ ...p, captions: p.captions.map(x => x.id === c.id ? { ...x, endMs: v } : x) })); }}/></Field></div><Button variant="ghost" onClick={() => edit(p => ({ ...p, captions: p.captions.filter(x => x.id !== c.id) }))}>Remove caption</Button></div>)}<hr /><Field label="Font"><select value={draft.captionStyle.font} onChange={e => edit(p => ({ ...p, captionStyle: { ...p.captionStyle, font: e.target.value } }))}><option>Arial</option><option>Georgia</option><option>Verdana</option></select></Field><Field label={`Size · ${draft.captionStyle.size}px`}><input type="range" min="12" max="96" value={draft.captionStyle.size} onChange={e => edit(p => ({ ...p, captionStyle: { ...p.captionStyle, size: Number(e.target.value) } }))}/></Field><Field label="Color"><input type="color" value={draft.captionStyle.color} onChange={e => edit(p => ({ ...p, captionStyle: { ...p.captionStyle, color: e.target.value } }))}/></Field><Field label="Placement"><select value={draft.captionStyle.position} onChange={e => edit(p => ({ ...p, captionStyle: { ...p.captionStyle, position: e.target.value as 'top' | 'middle' | 'bottom' } }))}><option>top</option><option>middle</option><option>bottom</option></select></Field><Button onClick={() => notify(s.capabilities.transcription.reason ?? 'Transcription integration pending.')}>Transcription capability</Button></>}
 {inspector === 'Audio' && <><span className="eyebrow">GIVE IT ROOM TO BREATHE</span><h3>Sound & music</h3><Field label={`Original audio · ${Math.round(draft.originalGain * 100)}%`}><input type="range" min="0" max="1" step="0.01" value={draft.originalGain} onChange={e => edit(p => ({ ...p, originalGain: Number(e.target.value) }))}/></Field><Button icon="upload" onClick={() => (service.mode === 'desktop' ? void run('pickMusic', undefined).then(m => { if (m) { setMusicName(m.name); edit(p => ({ ...p, musicHandle: m.handle })); } }) : musicInput.current?.click())}>Import your music</Button><p className="fine-print">Use music you have permission to use. No song downloads.</p>{draft.musicHandle && <><strong>{musicName || 'Imported music · relink after restart'}</strong><Field label={`Music gain · ${Math.round(draft.musicGain * 100)}%`}><input type="range" min="0" max="1" step="0.01" value={draft.musicGain} onChange={e => edit(p => ({ ...p, musicGain: Number(e.target.value) }))}/></Field><Button onClick={() => edit(p => ({ ...p, musicHandle: null }))}>Remove music</Button></>}<p>Audio fades are per segment in the Edit tab. Multitrack audio export will be implemented by Claude.</p></>}
 </div> : <Empty title="Select a clip" detail="Your editing tools appear here."/>}</aside>
 <section className="timeline-panel"><div className="timeline-toolbar"><div className="button-row"><Icon name="forge"/><strong>Timeline</strong><Badge>{segments.length} segment{segments.length === 1 ? '' : 's'}</Badge><Button icon="clip" variant="ghost" disabled={!draft} onClick={split}>Split at playhead</Button></div><div className="button-row"><label className="compact-toggle"><input type="checkbox" checked={snap} onChange={e => setSnap(e.target.checked)}/>Snap 100ms</label><label className="zoom-label">Zoom<input aria-label="Timeline zoom" type="range" min="1" max="4" step="0.5" value={zoom} onChange={e => setZoom(Number(e.target.value))}/></label></div></div><div className="timeline-scroll"><div className="timeline-inner" style={{ minWidth: `${zoom * 100}%` }}><div className="time-ruler">{Array.from({ length: 9 }, (_, i) => <span key={i}>{time(i * duration / 8)}</span>)}</div><input className="timeline-scrubber" aria-label="Timeline playhead" type="range" min="0" max={duration || 1} step="50" value={position} onChange={e => scrub(Number(e.target.value))}/><div className="timeline-track"><span className="track-name"><Icon name="forge"/>Video</span><div className="segment-lane">{segments.map((x, i) => <button key={x.id} className={`timeline-segment ${x.id === segment?.id ? 'selected' : ''}`} style={{ width: `${duration ? ((x.outMs - x.inMs) / duration) * 100 : 100}%` }} onClick={() => { setSelectedSegment(x.id); scrub(x.offsetMs); }}><div className="segment-thumbs">{Array.from({ length: 6 }, (_, n) => <Arena key={n} variant={i} label={false}/>)}</div><span>{clip?.name} · {time(x.outMs - x.inMs)}</span></button>)}<div className="playhead" style={{ left: `${duration ? position / duration * 100 : 0}%` }}/></div></div><div className="timeline-track audio-track"><span className="track-name"><Icon name="audio"/>Audio</span><div className="waveform">{(waveform ?? Array.from({ length: 128 }, (_, i) => .15 + Math.abs(Math.sin(i * 1.3) * Math.cos(i * .21)) * .7)).map((v, i) => <span key={i} style={{ height: `${Math.max(4, v * 80)}%` }}/>)}<small>{waveform ? 'Decoded source waveform' : 'Illustrative waveform · import audio for analysis'}</small></div></div>{draft?.musicHandle && <div className="music-track"><Icon name="volume"/> {musicName || 'Imported music'} · gain {Math.round(draft.musicGain * 100)}%</div>}</div></div>{segments.length > 1 && <div className="button-row segment-actions"><span>Selected segment {segments.findIndex(x => x.id === segment?.id) + 1}</span><Button disabled={segments[0]?.id === segment?.id} onClick={() => edit(p => ({ ...p, tracks: p.tracks.map(t => { if (t.kind !== 'video')
            return t; const a = [...t.segments], i = a.findIndex(x => x.id === segment?.id); if (i > 0)
            [a[i - 1], a[i]] = [a[i], a[i - 1]]; return { ...t, segments: reflow(a) }; }) }))}>Move earlier</Button><Button disabled={segments[segments.length - 1]?.id === segment?.id} onClick={() => edit(p => ({ ...p, tracks: p.tracks.map(t => { if (t.kind !== 'video')
            return t; const a = [...t.segments], i = a.findIndex(x => x.id === segment?.id); if (i < a.length - 1)
            [a[i + 1], a[i]] = [a[i], a[i + 1]]; return { ...t, segments: reflow(a) }; }) }))}>Move later</Button><Button onClick={() => edit(p => ({ ...p, tracks: p.tracks.map(t => t.kind !== 'video' ? t : { ...t, segments: reflow(t.segments.filter(x => x.id !== segment?.id)) }) }))}>Remove segment</Button></div>}</section></div>
 {exporting && draft && <Modal title="Export your moment" onClose={() => setExporting(false)}><p>{s.mode === 'demo' ? 'Demo simulates queue progress. It does not render or create a media file.' : 'Renders with FFmpeg in the background. The file is marked done only after it is checked.'}</p><div className="form-grid"><Field label="Destination"><input value={preset.destination} onChange={e => setPreset({ ...preset, destination: e.target.value })}/></Field><Field label="Aspect"><input readOnly value={draft.aspect}/></Field><Field label="Resolution"><select value={preset.resolution} onChange={e => setPreset({ ...preset, resolution: Number(e.target.value) as 720 | 1080 | 1440 })}><option value={720}>720p</option><option value={1080}>1080p</option><option value={1440}>1440p</option></select></Field><Field label="Frame rate"><select value={preset.fps} onChange={e => setPreset({ ...preset, fps: Number(e.target.value) as 30 | 60 })}><option value={30}>30 fps</option><option value={60}>60 fps</option></select></Field><Field label="Quality"><select value={preset.quality} onChange={e => setPreset({ ...preset, quality: e.target.value as 'balanced' | 'high' })}><option value="balanced">Balanced</option><option value="high">High</option></select></Field><Field label="Codec"><select value={preset.codec} onChange={e => setPreset({ ...preset, codec: e.target.value as 'h264' | 'hevc' })}><option value="h264">H.264 · wider compatibility</option><option value="hevc">HEVC · capability check pending</option></select></Field></div>{desktop && <div className="yt-presets"><span>YouTube</span><Button icon="youtube" variant="ghost" onClick={() => youtubePreset(draft.aspect === '9:16' ? 'short' : 'video')}>{draft.aspect === '9:16' ? 'Shorts preset · 1080×1920' : 'Upload preset · 1440p60'}</Button></div>}{desktop && <label className="toggle"><input type="checkbox" checked={!!preset.loudness} onChange={e => setPreset({ ...preset, loudness: e.target.checked })}/>Normalize loudness to −14 LUFS (YouTube's playback level)</label>}<p className="fine-print">{desktop ? 'Higher resolution does not add source detail; 1440p uploads usually get a cleaner YouTube encode. The file is checked with ffprobe before it is marked done.' : 'Higher resolution does not add source detail. Desktop must probe encoder support and validate A/V sync and output.'}</p>{s.mode === 'demo' && <label className="toggle"><input type="checkbox" checked={simulateFailure} onChange={e => setSimulateFailure(e.target.checked)}/>Simulate encoder failure for recovery testing</label>}<div className="modal-actions"><Button onClick={() => setExporting(false)}>Cancel</Button><Button icon="download" variant="primary" disabled={pending.has('export') || !preset.destination.trim()} onClick={async () => { const job = await run('export', { project: draft, preset: { ...preset, aspect: draft.aspect }, simulateFailure }); if (job) {
        setExporting(false);
        setQueue(true);
    } }}>{s.mode === 'demo' ? 'Queue simulated export' : 'Export'}</Button></div></Modal>}
 {queue && <Modal title="Export queue" onClose={() => setQueue(false)}>{s.jobs.length ? s.jobs.map(j => <div className="job-card" key={j.id}><div className="row"><strong>{j.name}</strong><Badge tone={j.status === 'failed' ? 'amber' : j.status === 'completed' ? 'cyan' : ''}>{j.status === 'completed' ? (j.simulated ? 'Simulation finished' : 'Completed') : j.status}</Badge></div><div className="progress" role="progressbar" aria-label={`${j.name} simulated export`} aria-valuenow={j.progress} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${j.progress}%` }}/></div><small>{j.progress}% · {j.simulated ? 'Simulated · no output file' : 'Desktop job'}</small>{j.error && <div className="callout error">{j.error.message}<small>{j.error.details}</small></div>}<div className="button-row">{['accepted', 'processing'].includes(j.status) && <Button disabled={pending.has('cancelJob')} onClick={() => void run('cancelJob', { id: j.id })}>Cancel job</Button>}{['failed', 'canceled'].includes(j.status) && <Button disabled={pending.has('retryJob')} onClick={() => void run('retryJob', { id: j.id })}>Retry</Button>}{j.status === 'completed' && <Button onClick={() => void run('openOutput', { id: j.id })}>{desktop ? 'Open video' : 'Open Output capability'}</Button>}{desktop && j.status === 'completed' && !j.simulated && <><Button icon="folder" variant="ghost" onClick={() => void run('revealOutput', { id: j.id })}>Show in folder</Button><Button icon="youtube" variant="primary" onClick={() => { setQueue(false); setKitJob(j.id); }}>YouTube kit</Button></>}</div></div>) : <Empty title="Nothing in the queue" detail="Export a draft when you are happy with the cut."/>}</Modal>}
 {kitJob && <YouTubeKit jobId={kitJob} onClose={() => setKitJob(null)}/>}
 </>;
}
