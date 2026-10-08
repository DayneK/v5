import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { LAW_INDEXES, PARTICLE_STRIDE, STRIDE_INDEXES as S } from '../../src/constants.js';
import { createLawState, toggle, set, clear, isSet, getActiveCount, getStateVector, serialize, deserialize } from '../../src/state/lawState.js';
import { applyBoil, applyPredation, setBuffer } from '../../src/physics/laws.js';

describe('Simulation law randomness', () => {
    it('keeps unseeded Math.random calls out of the physics law and worker boundary', () => {
        const paths = [
            new URL('../../src/physics/laws.js', import.meta.url),
            new URL('../../src/worker/physics.worker.js', import.meta.url),
        ];
        for (const path of paths) {
            expect(readFileSync(path, 'utf8')).not.toMatch(/\bMath\.random\s*\(/);
        }
    });

    it('uses deterministic fallback rolls for predation when no PRNG is supplied', () => {
        const random = vi.spyOn(Math, 'random').mockImplementation(() => {
            throw new Error('simulation law used Math.random');
        });
        const run = () => {
            const view = new Float32Array(PARTICLE_STRIDE * 2);
            view[S.MASS] = 2;
            view[S.SPECIES_ID] = 0;
            view[S.RADIUS] = 1;
            view[S.DNA_CACHE_START + 36] = 1;
            view[PARTICLE_STRIDE + S.MASS] = 1;
            view[PARTICLE_STRIDE + S.SPECIES_ID] = 1;
            view[PARTICLE_STRIDE + S.RADIUS] = 1;
            view[PARTICLE_STRIDE + S.DNA_CACHE_START + 21] = 1;
            setBuffer(view);
            applyPredation(0, PARTICLE_STRIDE, PARTICLE_STRIDE, 1, 0, 0, 1, undefined);
            return Array.from(view);
        };

        try {
            const result = run();
            expect(result).toEqual(run());
            expect(result[S.DNA_CACHE_START + 21]).toBeCloseTo(0.2262190625, 6);
            expect(result[S.DNA_CACHE_START + 7]).toBe(0);
            expect(random).not.toHaveBeenCalled();
        } finally {
            random.mockRestore();
        }
    });

    it('uses a deterministic fallback for boil when no PRNG is supplied', () => {
        const random = vi.spyOn(Math, 'random').mockImplementation(() => {
            throw new Error('simulation law used Math.random');
        });
        const run = () => {
            const view = new Float32Array(PARTICLE_STRIDE);
            view[S.MASS] = 10;
            view[S.ENERGY] = 100;
            view[S.TEMPERATURE] = 1;
            const laws = createLawState();
            set(laws, LAW_INDEXES.BOIL);
            applyBoil(laws, view, 0, 1, 1, undefined);
            return Array.from(view);
        };

        try {
            expect(run()).toEqual(run());
            expect(random).not.toHaveBeenCalled();
        } finally {
            random.mockRestore();
        }
    });
});

describe('LawState', () => {
    it('starts with all laws off', () => {
        const state = createLawState();
        expect(getActiveCount(state)).toBe(0);
    });

    it('set and isSet work for low-range laws (0-31)', () => {
        const state = createLawState();
        set(state, 0);
        expect(isSet(state, 0)).toBe(true);
        set(state, 15);
        expect(isSet(state, 15)).toBe(true);
        expect(getActiveCount(state)).toBe(2);
    });

    it('set and isSet work for high-range laws (32-63)', () => {
        const state = createLawState();
        set(state, 35);
        expect(isSet(state, 35)).toBe(true);
        set(state, 63);
        expect(isSet(state, 63)).toBe(true);
        expect(getActiveCount(state)).toBe(2);
    });

    it('set and isSet work for extended-range laws (64-95) without collisions', () => {
        const state = createLawState();
        set(state, 64);
        set(state, 78);
        expect(isSet(state, 64)).toBe(true);
        expect(isSet(state, 78)).toBe(true);
        expect(isSet(state, 32)).toBe(false); // no overlap with the old high word
        expect(isSet(state, 46)).toBe(false);
        expect(getActiveCount(state)).toBe(2);
        clear(state, 64);
        expect(isSet(state, 64)).toBe(false);
        expect(isSet(state, 78)).toBe(true);
    });

    it('toggle flips state', () => {
        const state = createLawState();
        toggle(state, 5);
        expect(isSet(state, 5)).toBe(true);
        toggle(state, 5);
        expect(isSet(state, 5)).toBe(false);
    });

    it('clear removes a law', () => {
        const state = createLawState();
        set(state, 10);
        expect(isSet(state, 10)).toBe(true);
        clear(state, 10);
        expect(isSet(state, 10)).toBe(false);
    });

    it('getStateVector returns correct boolean array', () => {
        const state = createLawState();
        set(state, 0);
        set(state, 35);
        const vec = getStateVector(state);
        expect(vec).toHaveLength(136);
        expect(vec[0]).toBe(true);
        expect(vec[35]).toBe(true);
        expect(vec[1]).toBe(false);
        set(state, 78);
        const vec2 = getStateVector(state);
        expect(vec2[78]).toBe(true);
    });

    it('serialize/deserialize round-trip', () => {
        const state = createLawState();
        set(state, 0);
        set(state, 35);
        set(state, 63);
        set(state, 78);
        const data = serialize(state);
        expect(data.ext).toBeGreaterThan(0);
        const restored = deserialize(data);
        expect(isSet(restored, 0)).toBe(true);
        expect(isSet(restored, 35)).toBe(true);
        expect(isSet(restored, 63)).toBe(true);
        expect(isSet(restored, 78)).toBe(true);
        expect(isSet(restored, 1)).toBe(false);

        // legacy {low, high} payloads (saved before the third word) still load
        const legacy = deserialize({ low: data.low, high: data.high });
        expect(isSet(legacy, 0)).toBe(true);
        expect(isSet(legacy, 78)).toBe(false);
    });
});
