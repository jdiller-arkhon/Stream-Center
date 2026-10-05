/**
 * Thumbnail compositor (1280×720), entirely in the renderer on a canvas:
 * background (+ colour grade, vignette, speed lines, scanlines, grain, glitch),
 * image layers (outline/glow/shadow), graphics (arrow, circle, badge) and a styled title
 * (glow, gradient, slant, 3D extrude, RGB split).
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
    /** Outline colour (white by default); a bright colour reads as a neon glow. */
    outlineColor?: string;
    glow?: boolean;
    /** The image as uploaded, kept so a background removal can be undone. */
    original?: string;
}

export type TextPlace = 'left' | 'right' | 'top' | 'bottom' | 'center';
export const FONTS = {
    anton: { label: 'Anton (condensed, bold)', css: 'Anton, Impact, sans-serif', weight: 400 },
    bebas: { label: 'Bebas Neue', css: '"Bebas Neue", Impact, sans-serif', weight: 400 },
    bangers: { label: 'Bangers (comic)', css: 'Bangers, Impact, sans-serif', weight: 400 },
    blackops: { label: 'Black Ops One (military)', css: '"Black Ops One", Impact, sans-serif', weight: 400 },
    marker: { label: 'Permanent Marker (grunge)', css: '"Permanent Marker", "Comic Sans MS", cursive', weight: 400 },
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
    /** Second colour for a vertical gradient fill; null = solid. */
    gradientTo?: string | null;
    glow?: boolean;
    /** Italic-style slant, 0..0.35. */
    slant?: number;
    extrude?: boolean;
    /** Chromatic red/cyan split behind the letters. */
    split?: boolean;
    /** Show the accent bar beside the text. */
    bar?: boolean;
    /** Text size multiplier, 0.7..1.4. */
    scale?: number;
}

export type Grade = 'none' | 'punch' | 'noir' | 'teal-orange' | 'duotone' | 'blood' | 'toxic';
export interface BackgroundFx {
    grade: Grade;
    /** 0..1 each. */
    vignette: number;
    grain: number;
    glitch: number;
    speedLines: boolean;
    scanlines: boolean;
    /** Darken behind the title for legibility. */
    shade: boolean;
}
export const NO_FX: BackgroundFx = { grade: 'none', vignette: 0, grain: 0, glitch: 0, speedLines: false, scanlines: false, shade: true };

export interface Decal {
    id: string;
    kind: 'arrow' | 'circle' | 'badge' | 'burst';
    cx: number;
    cy: number;
    /** Fraction of the canvas height. */
    size: number;
    /** Degrees. */
    rot: number;
    color: string;
    text: string;
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

/** Small seeded PRNG so grain/glitch do not flicker between redraws. */
function rng(seed: number) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const GRADE_FILTER: Record<Grade, string> = {
    none: 'none',
    punch: 'contrast(1.25) saturate(1.45) brightness(1.03)',
    noir: 'grayscale(1) contrast(1.45) brightness(0.95)',
    'teal-orange': 'contrast(1.18) saturate(1.2)',
    duotone: 'grayscale(1) contrast(1.3)',
    blood: 'grayscale(0.6) contrast(1.35) brightness(0.9)',
    toxic: 'grayscale(0.5) contrast(1.4) brightness(0.92)',
};

function grade(ctx: CanvasRenderingContext2D, g: Grade, accent: string) {
    if (g === 'teal-orange') {
        ctx.globalCompositeOperation = 'soft-light';
        const t = ctx.createLinearGradient(0, H, W, 0);
        t.addColorStop(0, 'rgba(0,128,140,.75)');
        t.addColorStop(1, 'rgba(255,140,40,.75)');
        ctx.fillStyle = t;
        ctx.fillRect(0, 0, W, H);
    } else if (g === 'duotone' || g === 'blood' || g === 'toxic') {
        ctx.globalCompositeOperation = g === 'duotone' ? 'color' : 'multiply';
        ctx.fillStyle = g === 'blood' ? '#c4141c' : g === 'toxic' ? '#7dff2a' : accent;
        ctx.globalAlpha = g === 'duotone' ? 0.85 : 0.55;
        ctx.fillRect(0, 0, W, H);
        if (g !== 'duotone') {
            ctx.globalCompositeOperation = 'screen';
            ctx.globalAlpha = 0.18;
            ctx.fillRect(0, 0, W, H);
        }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
}

function speedLines(ctx: CanvasRenderingContext2D, fx: number, fy: number, color: string) {
    const r = rng(7);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 90; i++) {
        const a = r() * Math.PI * 2, spread = 0.004 + r() * 0.012, inner = 140 + r() * 160;
        ctx.globalAlpha = 0.12 + r() * 0.3;
        ctx.fillStyle = i % 5 === 0 ? color : '#ffffff';
        ctx.beginPath();
        ctx.moveTo(fx + Math.cos(a) * inner, fy + Math.sin(a) * inner);
        ctx.lineTo(fx + Math.cos(a - spread) * 1600, fy + Math.sin(a - spread) * 1600);
        ctx.lineTo(fx + Math.cos(a + spread) * 1600, fy + Math.sin(a + spread) * 1600);
        ctx.fill();
    }
    ctx.restore();
}

function vignette(ctx: CanvasRenderingContext2D, amount: number) {
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, W * 0.72);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${0.92 * amount})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
}

function scanlines(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = 'rgba(0,0,0,.18)';
    for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 1.5);
}

function grain(ctx: CanvasRenderingContext2D, amount: number) {
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data, r = rng(11), k = 70 * amount;
    for (let i = 0; i < d.length; i += 4) {
        const n = (r() - 0.5) * k;
        d[i] = d[i]! + n; d[i + 1] = d[i + 1]! + n; d[i + 2] = d[i + 2]! + n;
    }
    ctx.putImageData(img, 0, 0);
}

/** Horizontal slice displacement with a red/cyan fringe: a digital glitch. */
function glitch(ctx: CanvasRenderingContext2D, amount: number) {
    const r = rng(23);
    const snap = document.createElement('canvas');
    snap.width = W; snap.height = H;
    snap.getContext('2d')!.drawImage(ctx.canvas, 0, 0);
    const slices = Math.round(6 + amount * 16);
    for (let i = 0; i < slices; i++) {
        const y = Math.floor(r() * H), h = Math.max(4, Math.floor(r() * 40 * amount + 4)), dx = (r() - 0.5) * 120 * amount;
        ctx.drawImage(snap, 0, y, W, h, dx, y, W, h);
        if (r() < 0.5) {
            ctx.save();
            ctx.globalCompositeOperation = 'screen';
            ctx.globalAlpha = 0.5;
            ctx.fillStyle = r() < 0.5 ? '#ff0040' : '#00e5ff';
            ctx.fillRect(0, y, W, Math.max(2, h / 4));
            ctx.restore();
        }
    }
}

function drawDecal(ctx: CanvasRenderingContext2D, d: Decal, font: string): Rect {
    const s = H * d.size;
    ctx.save();
    ctx.translate(d.cx * W, d.cy * H);
    ctx.rotate((d.rot * Math.PI) / 180);
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(0,0,0,.55)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    let w = s, h = s;
    if (d.kind === 'arrow') {
        // Chunky arrow pointing right, centred on the origin.
        w = s * 1.6; h = s * 0.9;
        const p = new Path2D();
        p.moveTo(-w / 2, -h * 0.18); p.lineTo(w * 0.12, -h * 0.18); p.lineTo(w * 0.12, -h / 2);
        p.lineTo(w / 2, 0); p.lineTo(w * 0.12, h / 2); p.lineTo(w * 0.12, h * 0.18); p.lineTo(-w / 2, h * 0.18); p.closePath();
        ctx.lineWidth = s * 0.07; ctx.strokeStyle = '#ffffff'; ctx.stroke(p);
        ctx.shadowColor = 'transparent'; ctx.fillStyle = d.color; ctx.fill(p);
    } else if (d.kind === 'circle') {
        ctx.lineWidth = s * 0.075;
        ctx.strokeStyle = '#ffffff';
        ctx.beginPath(); ctx.ellipse(0, 0, s / 2, s / 2.6, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.shadowColor = 'transparent';
        ctx.lineWidth = s * 0.045; ctx.strokeStyle = d.color; ctx.stroke();
        h = s / 1.3;
    } else if (d.kind === 'burst') {
        const spikes = 14, p = new Path2D();
        for (let i = 0; i <= spikes * 2; i++) { const a = (i / (spikes * 2)) * Math.PI * 2, rr = i % 2 ? s * 0.36 : s / 2; p[i ? 'lineTo' : 'moveTo'](Math.cos(a) * rr, Math.sin(a) * rr); }
        ctx.fillStyle = d.color; ctx.fill(p);
        ctx.shadowColor = 'transparent'; ctx.lineWidth = s * 0.03; ctx.strokeStyle = '#000'; ctx.stroke(p);
        textIn(ctx, d.text, s * 0.62, s * 0.5, font);
    } else {
        // Badge: slanted label (e.g. "INSANE", "1v5", "NEW").
        const label = d.text.trim().toUpperCase() || 'NEW';
        ctx.font = `400 ${s * 0.42}px ${font}`;
        w = Math.max(s, ctx.measureText(label).width + s * 0.5); h = s * 0.6;
        ctx.transform(1, 0, -0.18, 1, 0, 0);
        ctx.fillStyle = d.color; ctx.fillRect(-w / 2, -h / 2, w, h);
        ctx.shadowColor = 'transparent'; ctx.lineWidth = s * 0.04; ctx.strokeStyle = '#000'; ctx.strokeRect(-w / 2, -h / 2, w, h);
        textIn(ctx, label, w * 0.9, s * 0.42, font);
    }
    ctx.restore();
    const big = Math.max(w, h) * 0.6;
    return { x: d.cx * W - big, y: d.cy * H - big, w: big * 2, h: big * 2 };
}

function textIn(ctx: CanvasRenderingContext2D, text: string, maxW: number, size: number, font: string) {
    if (!text.trim()) return;
    let sz = size;
    ctx.font = `400 ${sz}px ${font}`;
    while (ctx.measureText(text).width > maxW && sz > 8) { sz -= 2; ctx.font = `400 ${sz}px ${font}`; }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = sz * 0.16; ctx.strokeStyle = '#000'; ctx.strokeText(text, 0, sz * 0.04);
    ctx.fillStyle = '#ffffff'; ctx.fillText(text, 0, sz * 0.04);
}

export interface Scene {
    background: string;
    text: TextStyle;
    layers: Layer[];
    fx?: BackgroundFx;
    decals?: Decal[];
}

/** Draws everything; returns each layer's and graphic's rectangle (for dragging on the preview). */
export async function drawThumbnail(canvas: HTMLCanvasElement, scene: Scene): Promise<Map<string, Rect>> {
    const { text: style, layers } = scene;
    const fx = scene.fx ?? NO_FX;
    const decals = scene.decals ?? [];
    const ctx = canvas.getContext('2d', { willReadFrequently: fx.grain > 0 })!;
    const font = FONTS[style.font];
    const [bg, ...imgs] = await Promise.all([loadImage(scene.background), ...layers.map(l => loadImage(l.src))]);
    try { await Promise.all([document.fonts.load(`${font.weight} 120px ${font.css}`), document.fonts.load(`400 60px ${FONTS.anton.css}`)]); } catch { /* system fallback */ }
    ctx.save();
    ctx.clearRect(0, 0, W, H);

    // ---- background + look
    ctx.filter = GRADE_FILTER[fx.grade];
    cover(ctx, bg);
    ctx.filter = 'none';
    grade(ctx, fx.grade, style.accent);
    const focus = layers[0] ? { x: layers[0].cx * W, y: layers[0].cy * H } : { x: W / 2, y: H / 2 };
    if (fx.speedLines) speedLines(ctx, focus.x, focus.y, style.accent);
    if (fx.vignette > 0) vignette(ctx, fx.vignette);
    const text = style.text.trim();
    if (text && fx.shade) {
        const g = {
            left: () => ctx.createLinearGradient(0, 0, 820, 0),
            right: () => ctx.createLinearGradient(W, 0, W - 820, 0),
            top: () => ctx.createLinearGradient(0, 0, 0, 420),
            bottom: () => ctx.createLinearGradient(0, H, 0, 300),
            center: () => ctx.createLinearGradient(0, H, 0, 0),
        }[style.place]();
        g.addColorStop(0, style.place === 'center' ? 'rgba(10,8,24,.35)' : 'rgba(10,8,24,.82)');
        g.addColorStop(1, 'rgba(10,8,24,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
    }
    if (fx.scanlines) scanlines(ctx);

    // ---- layers
    const rects = new Map<string, Rect>();
    layers.forEach((l, i) => {
        const img = imgs[i]!;
        const r = layerRect(l, img);
        rects.set(l.id, r);
        ctx.save();
        const color = l.outlineColor ?? '#ffffff';
        if (l.glow) { ctx.shadowColor = color; ctx.shadowBlur = 48; }
        else if (l.shadow) { ctx.shadowColor = 'rgba(0,0,0,.65)'; ctx.shadowBlur = 36; ctx.shadowOffsetY = 12; }
        if (l.outline) {
            const px = Math.max(6, Math.round(r.h * 0.018));
            const o = outlined(img, r.w, r.h, px, color);
            ctx.drawImage(o, r.x - px, r.y - px);
            if (l.glow) ctx.drawImage(o, r.x - px, r.y - px); // second pass intensifies the glow
        } else ctx.drawImage(img, r.x, r.y, r.w, r.h);
        ctx.restore();
    });

    // ---- title
    if (text) drawTitle(ctx, style, text);

    // ---- graphics on top
    for (const d of decals) rects.set(d.id, drawDecal(ctx, d, FONTS.anton.css));

    // ---- finishing passes over everything
    if (fx.glitch > 0) glitch(ctx, fx.glitch);
    if (fx.grain > 0) grain(ctx, fx.grain);
    ctx.restore();
    return rects;
}

function drawTitle(ctx: CanvasRenderingContext2D, style: TextStyle, text: string) {
    const font = FONTS[style.font];
    const side = style.place === 'left' || style.place === 'right';
    const width = side ? 700 : 1140;
    const scale = style.scale ?? 1;
    let size = Math.round(118 * scale);
    let lines: string[] = [];
    const content = style.upper ? text.toUpperCase() : text;
    const min = Math.round(48 * scale);
    for (; size >= min; size -= 6) {
        ctx.font = `${font.weight} ${size}px ${font.css}`;
        lines = wrap(ctx, content, width, 3);
        if (lines.join(' ').length >= content.split(/\s+/).join(' ').length && lines.every(l => ctx.measureText(l).width <= width)) break;
    }
    const lh = size * (font.weight === 400 ? 0.98 : 1.04);
    const block = lines.length * lh;
    const top = side || style.place === 'center' ? (H - block) / 2 : style.place === 'top' ? 52 : H - 60 - block;
    const align: CanvasTextAlign = style.place === 'right' ? 'right' : style.place === 'center' || style.place === 'top' || style.place === 'bottom' ? (style.bar === false ? 'center' : 'left') : 'left';
    const bar = style.bar !== false;
    const x = align === 'center' ? W / 2 : align === 'right' ? W - 92 : 92;
    ctx.save();
    if (bar) {
        ctx.fillStyle = style.accent;
        ctx.fillRect(align === 'right' ? W - 70 : 56, top - 6, 14, block);
    }
    // Slant around the block's anchor so text stays in place.
    const slant = Math.min(0.35, Math.max(0, style.slant ?? 0));
    if (slant) { ctx.translate(x, top + block / 2); ctx.transform(1, 0, -slant, 1, 0, 0); ctx.translate(-x, -(top + block / 2)); }
    ctx.textBaseline = 'top';
    ctx.textAlign = align;
    ctx.lineJoin = 'round';
    lines.forEach((l, i) => {
        const y = top + i * lh;
        const last = i === lines.length - 1 && lines.length > 1;
        const stroke = Math.round(size / 6.5);
        if (style.extrude) {
            ctx.fillStyle = '#0a0612';
            for (let d = Math.round(size / 9); d > 0; d--) ctx.fillText(l, x + d, y + d);
        }
        ctx.lineWidth = stroke;
        ctx.strokeStyle = 'rgba(8,6,20,.95)';
        ctx.strokeText(l, x, y);
        if (style.split) {
            const off = Math.max(3, Math.round(size / 28));
            ctx.save();
            ctx.globalCompositeOperation = 'screen';
            ctx.fillStyle = '#ff0040'; ctx.fillText(l, x - off, y);
            ctx.fillStyle = '#00e5ff'; ctx.fillText(l, x + off, y);
            ctx.restore();
        }
        const base = last ? style.accent : style.color;
        let fill: string | CanvasGradient = base;
        if (style.gradientTo) {
            const g = ctx.createLinearGradient(0, y, 0, y + size);
            g.addColorStop(0, base);
            g.addColorStop(1, style.gradientTo);
            fill = g;
        }
        if (style.glow) {
            ctx.save();
            ctx.shadowColor = style.accent;
            ctx.shadowBlur = size * 0.45;
            ctx.fillStyle = fill;
            ctx.fillText(l, x, y);
            ctx.restore();
        }
        ctx.fillStyle = fill;
        ctx.fillText(l, x, y);
    });
    ctx.restore();
}

/** One-click looks: font, colours, text effects and background treatment together. */
export interface Vibe { key: string; label: string; text: Partial<TextStyle>; fx: Partial<BackgroundFx> }
export const VIBES: Vibe[] = [
    { key: 'clean', label: 'Clean', text: { font: 'jakarta', color: '#ffffff', accent: '#7c5cff', gradientTo: null, glow: false, slant: 0, extrude: false, split: false, bar: true }, fx: { grade: 'none', vignette: 0, grain: 0, glitch: 0, speedLines: false, scanlines: false, shade: true } },
    { key: 'rage', label: 'Rage', text: { font: 'anton', color: '#ffffff', accent: '#ff1a1a', gradientTo: null, glow: true, slant: 0.12, extrude: true, split: false, bar: false }, fx: { grade: 'blood', vignette: 0.85, grain: 0.35, glitch: 0, speedLines: true, scanlines: false, shade: true } },
    { key: 'neon', label: 'Neon rift', text: { font: 'bebas', color: '#ffffff', accent: '#ff2bd6', gradientTo: '#2fe6ff', glow: true, slant: 0, extrude: false, split: true, bar: false }, fx: { grade: 'teal-orange', vignette: 0.6, grain: 0.15, glitch: 0.35, speedLines: false, scanlines: true, shade: true } },
    { key: 'toxic', label: 'Toxic', text: { font: 'blackops', color: '#e9ffd1', accent: '#8cff1a', gradientTo: null, glow: true, slant: 0.08, extrude: true, split: false, bar: false }, fx: { grade: 'toxic', vignette: 0.8, grain: 0.45, glitch: 0.15, speedLines: false, scanlines: false, shade: true } },
    { key: 'blackout', label: 'Blackout', text: { font: 'anton', color: '#ffffff', accent: '#ff2d2d', gradientTo: null, glow: false, slant: 0, extrude: true, split: false, bar: true }, fx: { grade: 'noir', vignette: 0.9, grain: 0.5, glitch: 0, speedLines: false, scanlines: false, shade: true } },
    { key: 'hype', label: 'Hype', text: { font: 'bangers', color: '#ffe11a', accent: '#ffffff', gradientTo: '#ff8a00', glow: false, slant: 0.1, extrude: true, split: false, bar: false }, fx: { grade: 'punch', vignette: 0.45, grain: 0, glitch: 0, speedLines: true, scanlines: false, shade: false } },
    { key: 'glitch', label: 'Glitch', text: { font: 'mono', color: '#ffffff', accent: '#00e5ff', gradientTo: null, glow: true, slant: 0, extrude: false, split: true, bar: false }, fx: { grade: 'duotone', vignette: 0.5, grain: 0.3, glitch: 0.75, speedLines: false, scanlines: true, shade: true } },
    { key: 'grunge', label: 'Grunge', text: { font: 'marker', color: '#f4f0e6', accent: '#ffb000', gradientTo: null, glow: false, slant: 0.05, extrude: true, split: false, bar: false }, fx: { grade: 'noir', vignette: 0.75, grain: 0.7, glitch: 0.1, speedLines: false, scanlines: false, shade: true } },
];

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
