import { useEffect, useState } from 'react';
import { useStudio } from '../context';
import { Badge, Button, Empty, Field, Modal } from '../components/Primitives';
import { Icon } from '../components/Icon';
import type { YouTubeKit as Kit } from '../../shared/contracts';
import { ThumbnailStudio } from './ThumbnailStudio';

const TITLE_MAX = 100;
const DESCRIPTION_MAX = 5000;
const TAGS_MAX = 500;
const clock = (ms: number) => {
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

export function YouTubeKit({ jobId, onClose }: { jobId: string; onClose: () => void }) {
    const { run, pending, notify } = useStudio();
    const [kit, setKit] = useState<Kit | null>(null);
    const [failed, setFailed] = useState(false);
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [tags, setTags] = useState('');
    useEffect(() => {
        let live = true;
        void run('youtubeKit', { jobId }).then(k => {
            if (!live) return;
            if (!k) { setFailed(true); return; }
            setKit(k);
            setTitle(k.title);
            setDescription(k.description);
            setTags(k.tags.join(', '));
        });
        return () => { live = false; };
    }, [jobId, run]);

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

            <ThumbnailStudio jobId={jobId} kit={kit}/>

            <section aria-label="Upload"><h3>Upload</h3>
                <p className="fine-print">Drift Studio does not sign in to your account or upload for you. Open YouTube Studio, choose Create → Upload videos, and drag in the file.</p>
                <div className="button-row"><Button icon="folder" onClick={() => void run('revealOutput', { id: jobId })}>Show video in folder</Button><Button icon="youtube" variant="primary" disabled={pending.has('openYouTubeStudio')} onClick={() => void run('openYouTubeStudio', undefined)}>Open YouTube Studio</Button></div>
            </section>
        </div>}
    </Modal>;
}
