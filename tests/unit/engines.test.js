import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { EventBus } from '../../src/core/eventBus.js';
import { PARTICLE_STRIDE, STRIDE_INDEXES } from '../../src/constants.js';
import { createInsightEngine, updateInsight, clusterTrend } from '../../src/engines/insightEngine.js';
import { createLineageTracker, trackBirth, trackDeath, getStats } from '../../src/engines/lineageTracker.js';
import { createTimelineEngine, snapshot as timelineSnapshot, scrub as timelineScrub, getTimeline, getLatest, clearTimeline } from '../../src/engines/timelineEngine.js';
import { createGoalEngine, updateGoal, setGoalValue } from '../../src/engines/goalEngine.js';
import { createNarrativeEngine, updateNarrative, resetNarrativeEngine } from '../../src/engines/narrativeEngine.js';

describe('VEPA4 Narrative Engine', () => {
    it('does not use ambient Math.random for narrative choices', () => {
        const source = readFileSync(new URL('../../src/engines/narrativeEngine.js', import.meta.url), 'utf8');
        expect(source.includes('Math.random(')).toBe(false);
    });

    function narrativeEntries(seed, rng) {
        const bus = new EventBus();
        const engine = createNarrativeEngine(bus, { seed, rng, globalCooldown: 0, cooldown: 0 });
        const entries = [];
        bus.on('narrative:entry', (entry) => entries.push(entry));
        bus.emit('law:toggled', { name: 'GRAV', value: true });
        updateNarrative(engine);
        return entries;
    }

    it('replays the same voice and template sequence from a seed', () => {
        const first = narrativeEntries(0xC0FFEE);
        const second = narrativeEntries(0xC0FFEE);
        expect(first).toEqual(second);
        expect(first).toHaveLength(1);
    });

    it('uses an explicitly supplied random source in preference to its seed', () => {
        const rng = vi.fn(() => 0);
        const entries = narrativeEntries(0xC0FFEE, rng);
        expect(entries[0].voice).toBe('Stabilizer');
        expect(rng).toHaveBeenCalledTimes(2);
    });

    it('resets seeded randomness, cooldowns, queued events and frame for the next world', () => {
        const bus = new EventBus();
        const engine = createNarrativeEngine(bus, { seed: 0xC0FFEE, globalCooldown: 0, cooldown: 0 });
        const entries = [];
        bus.on('narrative:entry', (entry) => entries.push(entry));
        const emitOne = () => {
            bus.emit('law:toggled', { name: 'GRAV', value: true });
            updateNarrative(engine);
            return entries.at(-1);
        };

        const first = emitOne();
        engine.recentEvents.push({ type: 'law', data: { name: 'stale' }, frame: engine.frame });
        resetNarrativeEngine(engine, 0xC0FFEE);
        expect(engine.frame).toBe(0);
        expect(engine.recentEvents).toEqual([]);
        expect(emitOne()).toEqual(first);
    });
});

describe('VEPA4 Insight Engine', () => {
    it('detects clusters of nearby particles', () => {
        const bus = new EventBus();
        const engine = createInsightEngine(bus, { scanInterval: 1, minClusterSize: 3, clusterRadius: 50 });
        const events = [];
        bus.on('cluster:detected', (data) => events.push(data));

        // 5 clustered particles + 1 isolated particle
        const view = new Float32Array(6 * PARTICLE_STRIDE);
        for (let i = 0; i < 5; i++) {
            const base = i * PARTICLE_STRIDE;
            view[base + STRIDE_INDEXES.POS_X] = 100 + i;
            view[base + STRIDE_INDEXES.POS_Y] = 100 + i;
            view[base + STRIDE_INDEXES.POS_Z] = 100;
            view[base + STRIDE_INDEXES.DEAD] = 0;
        }
        view[5 * PARTICLE_STRIDE + STRIDE_INDEXES.POS_X] = 500;
        view[5 * PARTICLE_STRIDE + STRIDE_INDEXES.POS_Y] = 500;
        view[5 * PARTICLE_STRIDE + STRIDE_INDEXES.POS_Z] = 500;

        updateInsight(engine, view, 6, PARTICLE_STRIDE, 1000);

        expect(events.length).toBe(1);
        const cluster = events[0].clusters[0];
        expect(cluster.count).toBeGreaterThanOrEqual(3);
        expect(cluster.center).toBeDefined();
    });

    it('tracks cluster growth trend', () => {
        const bus = new EventBus();
        const engine = createInsightEngine(bus, { scanInterval: 1, minClusterSize: 3, clusterRadius: 50 });
        const view = new Float32Array(6 * PARTICLE_STRIDE);
        for (let i = 0; i < 5; i++) {
            const base = i * PARTICLE_STRIDE;
            view[base + STRIDE_INDEXES.POS_X] = 100 + i;
            view[base + STRIDE_INDEXES.POS_Y] = 100 + i;
            view[base + STRIDE_INDEXES.POS_Z] = 100;
        }
        updateInsight(engine, view, 6, PARTICLE_STRIDE, 1000);
        updateInsight(engine, view, 6, PARTICLE_STRIDE, 1000);
        expect(clusterTrend(engine)).toBe(1);
    });
});

describe('VEPA4 Lineage Tracker', () => {
    it('records births, deaths, and lineage depth', () => {
        const bus = new EventBus();
        const engine = createLineageTracker(bus);
        const branches = [];
        bus.on('lineage:branch', (d) => branches.push(d));

        trackBirth(engine, -1, 0, 0, 0);   // seed
        trackBirth(engine, 0, 1, 0, 0);    // child of 0
        trackDeath(engine, 1, 'starvation');

        const stats = getStats(engine);
        expect(stats.totalBirths).toBe(2);
        expect(stats.totalDeaths).toBe(1);
        expect(stats.longestLineage).toBe(1);
        expect(branches.length).toBe(2);
    });
});

describe('VEPA4 Timeline Engine', () => {
    it('snapshots, lists, and scrubs state', () => {
        const bus = new EventBus();
        const engine = createTimelineEngine(bus, { maxSnapshots: 4 });
        const data = new Float32Array([1, 2, 3, 4]);

        timelineSnapshot(engine, data, { tick: 5, particleCount: 1 });
        timelineSnapshot(engine, new Float32Array([9, 9, 9, 9]), { tick: 10, particleCount: 1 });

        expect(getTimeline(engine)).toHaveLength(2);
        const entry = timelineScrub(engine, 0);
        expect(entry.data[0]).toBe(1);
        expect(getLatest(engine).metadata.tick).toBe(10);

        clearTimeline(engine);
        expect(getTimeline(engine)).toHaveLength(0);
    });
});

describe('VEPA4 Goal Engine', () => {
    it('emits adjustments toward complexity targets', () => {
        const bus = new EventBus();
        const engine = createGoalEngine(bus, { evaluationInterval: 1 });
        const adjustments = [];
        bus.on('goal:adjusted', (a) => adjustments.push(a));

        setGoalValue(engine, 'maxForce', 50);
        updateGoal(engine, {
            populationAlive: 100,
            speciesAlive: 10,
            clusterCount: 2,
            avgEnergy: 50,
            frameDelta: 0,
            lawActiveCount: 10,
        });

        const maxForceAdj = adjustments.find((a) => a.parameter === 'maxForce');
        expect(maxForceAdj).toBeDefined();
        expect(maxForceAdj.newValue).toBeLessThan(maxForceAdj.oldValue);
    });
});
