/**
 * Thumbnail compositor (1280×720): background, legibility shade, image layers (with optional
 * outline/shadow), accent bar and title. Runs entirely in the renderer on a canvas.
 */
export const W = 1280;
export const H = 720;

export interface Layer {
    id: string;
    src: string;
    name: string;
    /** Centre of the layer, 0..1 of the canvas. */
    cx: number;
    cy: number;
    /** Height as a fraction of the canvas height. */
    size: number;
    outline: boolean;
    shadow: boolean;
    /** The image as uploaded, kept so a background removal can be undone. */
    original?: string;
}

export type TextPlace = 'left' | 'right' | 'top' | 'bottom';
export const FONTS = {
    jakarta: { label: 'Plus Jakarta Sans', css: '"Plus Jakarta Sans Variable", "Segoe UI", sans-serif', weight: 800 },
    impact: { label: 'Impact', css: 'Impact, Haettenschweiler, "Arial Black", sans-serif', weight: 400 },
    mono: { label: 'JetBrains Mono', css: '"JetBrains Mono Variable", Consolas, monospace', weight: 800 },
    serif: { label: 'Georgia', css: 'Georgia, "Times New Roman", serif', weight: 700 },
} as const;
export type FontKey = keyof typeof FONTS;

export interface TextStyle {
    text: string;
    place: TextPlace;
    font: FontKey;
    color: string;
    accent: string;
    upper: boolean;
}

export interface Rect { x: number; y: number; w: number; h: number }

const cache = new Map<string, Promise<HTMLImageElement>>();
export function loadImage(src: string): Promise<HTMLImageElement> {
    let p = cache.get(src);
    if (!p) {
        p = (async () => { const img = new Image(); img.src = src; await img.decode(); return img; })();
        p.catch(() => cache.delete(src));
        cache.set(src, p);
        if (cache.size > 40) cache.delete(cache.keys().next().value!);
    }
    return p;
}

/** Fills the canvas with an image (centre crop), whatever its aspect ratio. */
function cover(ctx: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }) {
    const scale = Math.max(W / img.width, H / img.height);
    const dw = img.width * scale, dh = img.height * scale;
    ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

export function layerRect(l: Layer, img: { naturalWidth: number; naturalHeight: number }): Rect {
    const h = H * l.size, w = h * img.naturalWidth / img.naturalHeight;
    return { x: l.cx * W - w / 2, y: l.cy * H - h / 2, w, h };
}

/** Classic thumbnail cut-out: the image with a solid outline traced around its opaque pixels. */
function outlined(img: HTMLImageElement, w: number, h: number, px: number, color: string): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = Math.ceil(w + px * 2);
    c.height = Math.ceil(h + px * 2);
    const ctx = c.getContext('2d')!;
    for (let a = 0; a < 360; a += 15) {
        const r = (a * Math.PI) / 180;
        ctx.drawImage(img, px + Math.cos(r) * px, px + Math.sin(r) * px, w, h);
    }
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(img, px, px, w, h);
    return c;
}

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

/** Draws everything; returns each layer's rectangle (for dragging on the preview). */
export async function drawThumbnail(canvas: HTMLCanvasElement, background: string, style: TextStyle, layers: Layer[]): Promise<Map<string, Rect>> {
    const ctx = canvas.getContext('2d')!;
    const font = FONTS[style.font];
    const [bg, ...imgs] = await Promise.all([loadImage(background), ...layers.map(l => loadImage(l.src))]);
    try { await document.fonts.load(`${font.weight} 120px ${font.css}`); } catch { /* system fallback */ }
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    cover(ctx, bg);
    const text = style.text.trim();
    if (text) {
        const g = {
            left: () => ctx.createLinearGradient(0, 0, 820, 0),
            right: () => ctx.createLinearGradient(W, 0, W - 820, 0),
            top: () => ctx.createLinearGradient(0, 0, 0, 420),
            bottom: () => ctx.createLinearGradient(0, H, 0, 300),
        }[style.place]();
        g.addColorStop(0, 'rgba(10,8,24,.82)');
        g.addColorStop(1, 'rgba(10,8,24,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
    }
    const rects = new Map<string, Rect>();
    layers.forEach((l, i) => {
        const img = imgs[i]!;
        const r = layerRect(l, img);
        rects.set(l.id, r);
        ctx.save();
        if (l.shadow) { ctx.shadowColor = 'rgba(0,0,0,.65)'; ctx.shadowBlur = 36; ctx.shadowOffsetY = 12; }
        if (l.outline) {
            const px = Math.max(6, Math.round(r.h * 0.018));
            ctx.drawImage(outlined(img, r.w, r.h, px, '#ffffff'), r.x - px, r.y - px);
        } else ctx.drawImage(img, r.x, r.y, r.w, r.h);
        ctx.restore();
    });
    if (text) {
        const side = style.place === 'left' || style.place === 'right';
        const width = side ? 700 : 1140;
        let size = 112;
        let lines: string[] = [];
        const content = style.upper ? text.toUpperCase() : text;
        for (; size >= 52; size -= 8) {
            ctx.font = `${font.weight} ${size}px ${font.css}`;
            lines = wrap(ctx, content, width, 3);
            if (lines.join(' ').length >= content.split(/\s+/).join(' ').length && lines.every(l => ctx.measureText(l).width <= width)) break;
        }
        const lh = size * 1.04;
        const block = lines.length * lh;
        const top = side ? (H - block) / 2 : style.place === 'top' ? 56 : H - 64 - block;
        const right = style.place === 'right';
        const barX = right ? W - 70 : 56;
        const textX = right ? W - 92 : 92;
        ctx.fillStyle = style.accent;
        ctx.fillRect(barX, top - 6, 14, block);
        ctx.textBaseline = 'top';
        ctx.textAlign = right ? 'right' : 'left';
        ctx.lineJoin = 'round';
        lines.forEach((l, i) => {
            const y = top + i * lh;
            ctx.lineWidth = Math.round(size / 7);
            ctx.strokeStyle = 'rgba(8,6,20,.9)';
            ctx.strokeText(l, textX, y);
            ctx.fillStyle = i === lines.length - 1 && lines.length > 1 ? style.accent : style.color;
            ctx.fillText(l, textX, y);
        });
    }
    ctx.restore();
    return rects;
}

/** JPEG under YouTube's 2 MB thumbnail limit. */
export function exportJpeg(canvas: HTMLCanvasElement): string {
    for (const q of [0.92, 0.85, 0.75, 0.6]) {
        const url = canvas.toDataURL('image/jpeg', q);
        if ((url.length - 23) * 0.75 < 2 * 1024 * 1024) return url;
    }
    return canvas.toDataURL('image/jpeg', 0.5);
}

/** Reads an uploaded image file into a PNG data URL (longest side ≤ 1920, transparency kept). */
export async function readImageFile(file: File): Promise<string> {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Choose a PNG, JPEG or WebP image');
    if (file.size > 25 * 1024 * 1024) throw new Error('That image is larger than 25 MB');
    const url = URL.createObjectURL(file);
    try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const k = Math.min(1, 1920 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * k));
        c.height = Math.max(1, Math.round(img.naturalHeight * k));
        c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
        return c.toDataURL('image/png');
    } finally { URL.revokeObjectURL(url); }
}

/**
 * Removes a plain or green-screen background: flood-fills from the image border over pixels
 * close to the border's colour, with a soft edge. Works for plain walls and chroma screens,
 * not busy scenes (that needs a segmentation model).
 */
export function removePlainBackground(data: ImageData, tolerance: number): { removed: number } {
    const { width: w, height: h, data: px } = data;
    // Reference colour: median of border samples.
    const samples: number[][] = [];
    const step = Math.max(1, Math.floor((w + h) / 200));
    for (let x = 0; x < w; x += step) samples.push(rgb(px, x, 0, w), rgb(px, x, h - 1, w));
    for (let y = 0; y < h; y += step) samples.push(rgb(px, 0, y, w), rgb(px, w - 1, y, w));
    const ref = [0, 1, 2].map(k => samples.map(s => s[k]!).sort((a, b) => a - b)[samples.length >> 1]!);
    const tol = tolerance * 441; // max RGB distance
    const soft = tol * 1.35;
    const dist = (i: number) => Math.hypot(px[i]! - ref[0]!, px[i + 1]! - ref[1]!, px[i + 2]! - ref[2]!);
    const seen = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let head = 0, tail = 0, removed = 0;
    const push = (x: number, y: number) => { const p = y * w + x; if (!seen[p]) { seen[p] = 1; queue[tail++] = p; } };
    for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
    for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
    while (head < tail) {
        const p = queue[head++]!;
        const i = p * 4;
        const d = dist(i);
        if (d > soft) continue;
        if (d <= tol) { px[i + 3] = 0; removed++; }
        else { px[i + 3] = Math.min(px[i + 3]!, Math.round(255 * (d - tol) / (soft - tol))); continue; } // soft edge: stop here
        const x = p % w, y = (p - x) / w;
        if (x > 0) push(x - 1, y);
        if (x < w - 1) push(x + 1, y);
        if (y > 0) push(x, y - 1);
        if (y < h - 1) push(x, y + 1);
    }
    return { removed };
}
const rgb = (px: Uint8ClampedArray, x: number, y: number, w: number) => { const i = (y * w + x) * 4; return [px[i]!, px[i + 1]!, px[i + 2]!]; };

export async function cutOut(src: string, tolerance: number): Promise<{ src: string; removedShare: number }> {
    const img = await loadImage(src);
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height);
    const { removed } = removePlainBackground(data, tolerance);
    ctx.putImageData(data, 0, 0);
    return { src: c.toDataURL('image/png'), removedShare: removed / (c.width * c.height) };
}
