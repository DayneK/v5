import { describe, it, expect } from 'vitest';
import { asParticleView } from '../../src/render/renderer.js';
import { shouldDrawChaosScanline } from '../../src/render/spriteSync.js';
import { setupTabSwitching } from '../../src/ui/ui.js';
import { installDom } from '../helpers/domStub.js';
import { vi } from 'vitest';

describe('Renderer particle view (zero-copy hot path)', () => {
  it('assigns stable generated tab IDs without consuming ambient random values', () => {
    const doc = installDom();
    const panel = doc.createElement('div');
    panel.id = 'main-panel';
    const tabs = doc.createElement('div');
    tabs.className = 'tabs';
    const content = doc.createElement('section');
    content.className = 'tab-content';
    const button = doc.createElement('button');
    button.className = 'tab-btn';
    button.dataset.tab = 'tab-setup';
    button.classList.add('active');
    const target = doc.createElement('div');
    target.id = 'tab-setup';
    content.appendChild(target);
    tabs.appendChild(button);
    panel.appendChild(tabs);
    panel.appendChild(content);
    doc.body.appendChild(panel);
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('tab initialization used Math.random');
    });

    try {
      setupTabSwitching();
      expect(button.id).toBe('tabbtn-tab-tab-setup');
      expect(button.getAttribute('aria-controls')).toBe('tab-setup');
      expect(target.getAttribute('aria-labelledby')).toBe(button.id);
      expect(random).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
    }
  });

  it('draws a stable chaos scanline pattern without ambient randomness', () => {
    const first = Array.from({ length: 100 }, (_, row) => shouldDrawChaosScanline(row));
    const second = Array.from({ length: 100 }, (_, row) => shouldDrawChaosScanline(row));
    expect(first).toEqual(second);
    expect(first.some(Boolean)).toBe(true);
    expect(first.some((draw) => !draw)).toBe(true);
  });
  it('returns the same instance for an existing Float32Array (no per-frame copy)', () => {
    const view = new Float32Array(16);
    expect(asParticleView(view)).toBe(view);
  });

  it('wraps a raw ArrayBuffer into a live Float32Array view (no data copy)', () => {
    const buf = new ArrayBuffer(16 * 4);
    const view = asParticleView(buf);
    expect(view).toBeInstanceOf(Float32Array);
    expect(view.byteLength).toBe(16 * 4);
    new Float32Array(buf)[0] = 42;
    expect(view[0]).toBe(42);
  });

  it('wraps a SharedArrayBuffer into a Float32Array view', () => {
    if (typeof SharedArrayBuffer === 'undefined') return;
    const sab = new SharedArrayBuffer(16 * 4);
    const view = asParticleView(sab);
    expect(view).toBeInstanceOf(Float32Array);
    expect(view[0]).toBe(0);
  });
});
