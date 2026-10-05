import { useEffect, useRef, useState } from 'react';
import { useStudio } from '../context';
import { Badge, Button, Empty, Field, Modal } from '../components/Primitives';
import { Icon } from '../components/Icon';
import type { YouTubeKit as Kit } from '../../shared/contracts';

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

/** Draws the thumbnail: chosen frame, soft shade for legibility, accent bar and the title. */
async function drawThumbnail(canvas: HTMLCanvasElement, frame: string, text: string, accent: string, place: 'left' | 'bottom') {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = new Image();
    img.src = frame;
    await img.decode();
    try { await document.fonts.load(`800 120px ${THUMB_FONT}`); } catch { /* system fallback */ }
    ctx.clearRect(0, 0, 1280, 720);
    ctx.drawImage(img, 0, 0, 1280, 720);
    if (!text.trim()) return;
    const shade = place === 'left' ? ctx.createLinearGradient(0, 0, 820, 0) : ctx.createLinearGradient(0, 720, 0, 300);
    shade.addColorStop(0, 'rgba(10,8,24,.82)');
    shade.addColorStop(1, 'rgba(10,8,24,0)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, 1280, 720);
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
    const [frame, setFrame] = useState(0);
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
            setTitle(k.title);
            setDescription(k.description);
            setTags(k.tags.join(', '));
            setText(k.title.replace(/\s*#shorts/i, '').slice(0, 40));
        });
        return () => { live = false; };
    }, [jobId, run]);

    useEffect(() => {
        const c = canvas.current;
        const f = kit?.frames[frame];
        if (c && f) void drawThumbnail(c, f, text, accent, place).catch(() => notify('Could not draw the thumbnail preview'));
    }, [kit, frame, text, accent, place, notify]);

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

            {kit.frames.length > 0 && <section aria-label="Thumbnail"><h3>Thumbnail</h3>
                <div className="yt-thumb"><canvas ref={canvas} width={1280} height={720} aria-label="Thumbnail preview"/></div>
                <div className="yt-frames" role="radiogroup" aria-label="Thumbnail frame">{kit.frames.map((f, i) => <button key={i} role="radio" aria-checked={frame === i} aria-label={`Frame ${i + 1}`} className={frame === i ? 'selected' : ''} onClick={() => setFrame(i)}><img src={f} alt=""/></button>)}</div>
                <div className="form-grid"><Field label="Thumbnail text"><input aria-label="Thumbnail text" maxLength={60} value={text} onChange={e => setText(e.target.value)} placeholder="Leave empty for a clean frame"/></Field><Field label="Text placement"><select value={place} onChange={e => setPlace(e.target.value as 'left' | 'bottom')}><option value="left">Left side</option><option value="bottom">Bottom</option></select></Field></div>
                <div className="yt-accents" role="radiogroup" aria-label="Accent colour">{ACCENTS.map(([name, c]) => <button key={c} role="radio" aria-checked={accent === c} aria-label={name} className={accent === c ? 'selected' : ''} style={{ background: c }} onClick={() => setAccent(c)}/>)}</div>
                <div className="button-row"><Button icon="image" disabled={pending.has('saveThumbnail')} onClick={async () => { const c = canvas.current; if (!c) return; const r = await run('saveThumbnail', { jobId, dataUrl: exportJpeg(c) }); if (r) notify(`Saved ${r.fileName} next to the video`); }}>Save thumbnail (1280×720)</Button></div>
            </section>}

            <section aria-label="Upload"><h3>Upload</h3>
                <p className="fine-print">Drift Studio does not sign in to your account or upload for you. Open YouTube Studio, choose Create → Upload videos, and drag in the file.</p>
                <div className="button-row"><Button icon="folder" onClick={() => void run('revealOutput', { id: jobId })}>Show video in folder</Button><Button icon="youtube" variant="primary" disabled={pending.has('openYouTubeStudio')} onClick={() => void run('openYouTubeStudio', undefined)}>Open YouTube Studio</Button></div>
            </section>
        </div>}
    </Modal>;
}
