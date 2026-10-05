/** Thumbnail helpers: prompt building with styles/quality, background removal, suggestions. */
import { describe, expect, it } from 'vitest';
import { buildPrompt, profileFor, THUMB_STYLES } from '../src/services/media/imageGen';
import { THUMB_STYLE_OPTIONS } from '../src/shared/contracts';
import { removePlainBackground } from '../src/renderer/thumbCanvas';
import { suggestDescription } from '../src/renderer/thumbPrompts';

describe('styles, avoid and quality', () => {
  it('every UI style has a prompt in the service', () => {
    expect(THUMB_STYLE_OPTIONS.map((o) => o.key).filter((k) => k !== 'none').sort()).toEqual(Object.keys(THUMB_STYLES).sort());
  });

  it('adds the style and the things to avoid', () => {
    const p = buildPrompt('castle on a hill', 'anime', 'dragons, fog');
    expect(p.prompt).toMatch(/^castle on a hill, anime key visual/);
    expect(p.negative).toMatch(/text.*photo, photorealistic, dragons, fog$/);
    expect(buildPrompt('castle', 'unknown-style').prompt).toMatch(/^castle, youtube thumbnail/);
  });

  it('scales steps with quality', () => {
    expect(['fast', 'balanced', 'best'].map((q) => profileFor('sd_turbo.gguf', q as 'fast').steps)).toEqual([2, 4, 6]);
    expect(['fast', 'balanced', 'best'].map((q) => profileFor('dreamshaper_8.safetensors', q as 'fast').steps)).toEqual([14, 24, 36]);
  });
});

describe('removePlainBackground', () => {
  /** 40×40 green screen with a 10×10 red square in the middle. */
  function greenScreen() {
    const w = 40, h = 40;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inside = x >= 15 && x < 25 && y >= 15 && y < 25;
      data.set(inside ? [220, 30, 30, 255] : [20 + (x % 3), 200 + (y % 4), 40, 255], i);
    }
    return { width: w, height: h, data, colorSpace: 'srgb' } as unknown as ImageData;
  }

  it('clears the green around the subject and keeps the subject', () => {
    const img = greenScreen();
    const { removed } = removePlainBackground(img, 0.15);
    expect(removed).toBe(40 * 40 - 100);
    expect(img.data[3]).toBe(0); // corner gone
    expect(img.data[(20 * 40 + 20) * 4 + 3]).toBe(255); // subject kept
  });

  it('does nothing when the border is not a plain colour close to the reference', () => {
    const img = greenScreen();
    const r = removePlainBackground(img, 0.0);
    expect(r.removed).toBeLessThan(40 * 40 * 0.2);
  });
});

describe('suggestDescription', () => {
  it('uses the game when known and rotates ideas', () => {
    const a = suggestDescription({ game: 'Apex Legends', isShort: false, title: 'x' }, 0);
    const b = suggestDescription({ game: 'Apex Legends', isShort: false, title: 'x' }, 1);
    expect(a).toContain('Apex Legends');
    expect(a).not.toBe(b);
    expect(suggestDescription({ game: null, isShort: true, title: 'x' }, 0)).toContain('video game');
  });
});
