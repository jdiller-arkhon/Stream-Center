// Generates src/renderer/theme-mist-base.css from src/renderer/styles.css.
//
// styles.css (frontend) hard-codes a dark palette in ~300 places. This script re-emits
// every colour-bearing declaration with the colour remapped onto the light "purple mist"
// tokens defined in theme-mist.css, so no dark leftovers survive the light theme.
// Layout/sizing declarations are never emitted. Media surfaces (video frames, thumbnails,
// illustrative scenes and the overlays drawn on them) keep their original dark styling.
//
// Usage: node scripts/gen-light-theme.mjs   (re-run whenever styles.css changes)
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'src/renderer/styles.css';
const OUT = 'src/renderer/theme-mist-base.css';

const COLOR_PROPS = /^(color|background|background-color|border|border-(top|right|bottom|left)|border-color|border-(top|right|bottom|left)-color|outline|box-shadow|text-shadow|accent-color|fill|stroke|caret-color)$/;
const MEDIA_SELECTORS = /arena|preview-frame|capture-preview|editor-preview|program-monitor|scene-art|scene-[123]|thumbnail|duration|play-float|illustration-label|preview-overlay|preview-game-label|safe-area|webcam-placeholder|preview-caption|caption-(top|middle|bottom)|segment-thumbs|media-thumbnail|highlight-art|small-art|monitor-offline|obs-preview|boot-error/;

// ---------------------------------------------------------------- CSS parsing
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Minimal parser: returns [{ media: string|null, selector, decls: [[prop, value]] }]. */
function parse(css) {
  const rules = [];
  let i = 0;
  const readBlock = (media) => {
    while (i < css.length) {
      while (i < css.length && /\s/.test(css[i])) i++;
      if (css[i] === '}') {
        i++;
        return;
      }
      const start = i;
      while (i < css.length && css[i] !== '{' && css[i] !== '}') i++;
      if (css[i] !== '{') return;
      const head = css.slice(start, i).trim();
      i++;
      if (head.startsWith('@media') || head.startsWith('@supports')) {
        readBlock(head);
        continue;
      }
      if (head.startsWith('@')) {
        // @keyframes etc.: skip nested block entirely
        let depth = 1;
        while (i < css.length && depth) {
          if (css[i] === '{') depth++;
          else if (css[i] === '}') depth--;
          i++;
        }
        continue;
      }
      const bodyStart = i;
      while (i < css.length && css[i] !== '}') i++;
      const body = css.slice(bodyStart, i);
      i++;
      const decls = [];
      for (const part of body.split(/;(?![^(]*\))/)) {
        const c = part.indexOf(':');
        if (c < 0) continue;
        decls.push([part.slice(0, c).trim().toLowerCase(), part.slice(c + 1).trim()]);
      }
      rules.push({ media, selector: head, decls });
    }
  };
  readBlock(null);
  return rules;
}

// ---------------------------------------------------------------- colours
function parseColor(tok) {
  let m = /^#([0-9a-f]{3,8})$/i.exec(tok);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    const n = (o) => parseInt(h.slice(o, o + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(tok);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
  }
  return null;
}

function hsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s, l };
}

function family(c) {
  const { h } = hsl(c);
  // Chroma (not HSL saturation, which inflates near black/white) decides "neutral".
  const chroma = (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / 255;
  if (chroma < 0.1) return 'neutral';
  if (h >= 160 && h < 300) return 'accent'; // cyan, blue, violet → purple accent
  if (h >= 300 || h < 15) return 'red';
  if (h < 70) return 'orange';
  return 'green';
}

/** Maps one colour for a given role (text | bg | line | shadow). */
function mapColor(c, role) {
  const { l } = hsl(c);
  const fam = family(c);
  if (role === 'shadow') return c.a < 0.3 && fam === 'neutral' ? 'rgba(76, 52, 160, 0.06)' : 'transparent';
  if (role === 'text') {
    if (fam === 'neutral') return l < 0.3 ? '#ffffff' : l > 0.8 ? 'var(--label)' : l > 0.55 ? 'var(--muted)' : 'var(--tertiary)';
    // Blue-grey secondary text (low saturation) is not an accent: keep it neutral.
    if (fam === 'accent') return l < 0.3 ? '#ffffff' : hsl(c).s < 0.4 ? (l > 0.8 ? 'var(--label)' : 'var(--muted)') : 'var(--accent-text)';
    return `var(--${fam}-text)`;
  }
  if (role === 'line') {
    if (fam === 'neutral') return c.a < 0.2 ? 'var(--line-faint)' : 'var(--line)';
    return `var(--${fam}-line)`;
  }
  // background
  if (c.a < 0.9 && fam === 'neutral' && l < 0.2) return 'var(--veil)'; // dark translucent panels
  if (c.a < 0.12) return 'transparent';
  if (fam === 'neutral') return l < 0.075 ? 'var(--surface)' : l < 0.2 ? 'var(--raised)' : l < 0.6 ? 'var(--fill-strong)' : 'var(--surface)';
  if (fam === 'accent') return l > 0.5 ? 'var(--accent)' : 'var(--accent-tint)';
  return l > 0.5 ? `var(--${fam})` : `var(--${fam}-tint)`;
}

const COLOR_TOKEN = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;

function transform(prop, value) {
  if (prop === 'accent-color' || prop === 'caret-color') return 'var(--accent)';
  if (prop === 'text-shadow') return 'none';
  if (prop === 'box-shadow') {
    if (/inset/.test(value) && !/#|rgb/.test(value)) return null;
    return value.replace(COLOR_TOKEN, (t) => { const c = parseColor(t); return c ? mapColor(c, 'shadow') : t; });
  }
  const role = prop === 'color' || prop === 'fill' ? 'text' : prop.startsWith('background') ? 'bg' : 'line';
  if (!COLOR_TOKEN.test(value)) return null;
  COLOR_TOKEN.lastIndex = 0;
  return value.replace(COLOR_TOKEN, (t) => {
    const c = parseColor(t);
    return c ? mapColor(c, role) : t;
  });
}

// ---------------------------------------------------------------- emit
const rules = parse(stripComments(readFileSync(SRC, 'utf8')));
const blocks = new Map(); // media -> lines
let count = 0;
for (const r of rules) {
  if (MEDIA_SELECTORS.test(r.selector)) continue;
  const out = [];
  for (const [prop, value] of r.decls) {
    if (!COLOR_PROPS.test(prop)) continue;
    const v = transform(prop, value);
    if (v !== null && v !== value) out.push(`  ${prop}: ${v};`);
  }
  if (!out.length) continue;
  count += out.length;
  const key = r.media ?? '';
  if (!blocks.has(key)) blocks.set(key, []);
  blocks.get(key).push(`${r.selector} {\n${out.join('\n')}\n}`);
}

let css = `/* GENERATED by scripts/gen-light-theme.mjs from styles.css — do not edit by hand.\n * Remaps ${count} hard-coded dark-palette colours onto the light purple-mist tokens\n * (defined in theme-mist.css). Re-run the script after styles.css changes. */\n\n`;
for (const [media, list] of blocks) {
  css += media ? `${media} {\n${list.map((b) => b.replace(/^/gm, '  ')).join('\n')}\n}\n\n` : `${list.join('\n')}\n\n`;
}
writeFileSync(OUT, css);
console.log(`Wrote ${OUT}: ${count} declarations in ${rules.length} source rules.`);
