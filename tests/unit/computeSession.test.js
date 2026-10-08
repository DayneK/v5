/**
 * Provider-neutral ComputeSession contract (RB decision D3).
 *
 * Proves: local adapters are the offline default; ticks are serialized and
 * ordered (one in flight); the queue back-pressures instead of unbounded
 * buffering; state transitions are guarded; the remote adapter is a port that
 * only talks to an injected transport (no network is touched by the app).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  COMPUTE_SESSION_CONTRACT,
  ComputeBackpressureError,
  ComputeStateError,
  createMainAdapter,
  createWorkerAdapter,
  createRemoteAdapter,
  createComputeSession,
} from '../../src/compute/computeSession.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Flush pending microtasks (the tick pipeline is all promises). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ComputeSession — contract + local adapters', () => {
  it('advertises the versioned contract token', () => {
    expect(COMPUTE_SESSION_CONTRACT).toBe('vepa-compute-session/1.0.0');
    const session = createComputeSession({ adapter: createMainAdapter({ runTick: () => 1 }) });
    expect(session.contract).toBe('vepa-compute-session/1.0.0');
  });

  it('main-thread adapter is local, offline and network-free', async () => {
    const adapter = createMainAdapter({ runTick: ({ seq }) => seq * 10 });
    expect(adapter.kind).toBe('local');
    expect(adapter.capabilities).toMatchObject({
      remote: false, requiresNetwork: false, authoritative: true, ordered: true, offline: true,
    });
    const session = createComputeSession({ adapter });
    await session.start();
    // Prove no network is involved: any fetch attempt throws the test.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('local compute must never fetch'); };
    try {
      const a = await session.step(0.1);
      const b = await session.step(0.1);
      expect([a.seq, b.seq]).toEqual([1, 2]);
      expect([a.result, b.result]).toEqual([10, 20]);
    } finally {
      globalThis.fetch = originalFetch;
      await session.dispose();
    }
  });

  it('serializes ticks: exactly one in flight, resolved in call order', async () => {
    const gate = [];
    const adapter = createMainAdapter({
      runTick: async ({ seq }) => {
        const d = deferred();
        gate.push(d);
        await d.promise;
        return seq;
      },
    });
    const session = createComputeSession({ adapter });
    await session.start();
    const p1 = session.step();
    const p2 = session.step();
    const p3 = session.step();
    await flush();
    expect(gate.length, 'only one tick may be in flight').toBe(1);
    gate[0].resolve();
    await flush();
    expect(gate.length).toBe(2);
    gate[1].resolve();
    await flush();
    expect(gate.length).toBe(3);
    gate[2].resolve();
    const results = await Promise.all([p1, p2, p3]);
    expect(results.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(results.map((r) => r.result)).toEqual([1, 2, 3]);
    await session.dispose();
  });

  it('applies backpressure past the queue limit', async () => {
    const d = deferred();
    const adapter = createMainAdapter({ runTick: () => d.promise });
    const session = createComputeSession({ adapter, queueLimit: 2 });
    await session.start();
    const first = session.step(); // in flight (holds the gate)
    const second = session.step(); // queued 1
    const third = session.step(); // queued 2
    await expect(session.step()).rejects.toBeInstanceOf(ComputeBackpressureError);
    expect(session.queued).toBe(2);
    d.resolve('ok');
    await first; await second; await third;
    // Capacity returns once the backlog drains.
    const next = session.step();
    d.resolve('ok2');
    await next;
    await session.dispose();
  });

  it('guards the state machine and rejects after dispose', async () => {
    const session = createComputeSession({ adapter: createMainAdapter({ runTick: () => 1 }) });
    expect(() => session.pause()).toThrow(ComputeStateError);
    await session.start();
    expect(session.status).toBe('running');
    expect(() => session.resume()).toThrow(ComputeStateError);
    session.pause();
    expect(session.status).toBe('paused');
    const pausedStep = session.step(); // queued while paused
    session.resume();
    await expect(pausedStep).resolves.toBeTruthy();
    expect(() => session.pause()).not.toThrow();
    await session.dispose();
    expect(session.status).toBe('disposed');
    await expect(session.step()).rejects.toBeInstanceOf(ComputeStateError);
    await expect(session.start()).rejects.toBeInstanceOf(ComputeStateError);
  });

  it('emits tick / state events and isolates listener failures', async () => {
    const session = createComputeSession({ adapter: createMainAdapter({ runTick: () => 'x' }) });
    const ticks = [];
    const off = session.on('tick', (e) => ticks.push(e.seq));
    session.on('tick', () => { throw new Error('bad listener'); });
    const states = [];
    session.on('state', (s) => states.push(s));
    await session.start();
    await session.step();
    expect(ticks).toEqual([1]);
    expect(states).toEqual(['running']);
    off();
    await session.step();
    expect(ticks).toEqual([1]);
    expect(() => session.on('nope', () => {})).toThrow(TypeError);
    await session.dispose();
  });

  it('worker adapter resolves on TICK_COMPLETE and rejects on ERROR, ignoring stale seqs', async () => {
    const subscribers = new Set();
    const sent = [];
    const adapter = createWorkerAdapter({
      send: (msg) => sent.push(msg),
      subscribe: (cb) => { subscribers.add(cb); return () => subscribers.delete(cb); },
    });
    const reply = (message) => { for (const cb of [...subscribers]) cb(message); };
    const session = createComputeSession({ adapter });
    await session.start();
    const p = session.step(0.1);
    await flush();
    expect(sent[0]).toMatchObject({ type: 'TICK', seq: 1, dt: 0.1 });
    reply({ type: 'TICK_COMPLETE', seq: 99, result: 'stale' }); // ignored
    reply({ type: 'TICK_COMPLETE', seq: 1, result: { tick: 5 } });
    await expect(p).resolves.toMatchObject({ seq: 1, result: { tick: 5 } });

    const failing = session.step();
    await flush();
    reply({ type: 'ERROR', seq: 2, message: 'solver exploded' });
    await expect(failing).rejects.toThrow('solver exploded');
    await session.dispose();
  });
});

describe('ComputeSession — remote port stays provider-neutral (D3)', () => {
  it('requires an explicit endpoint and reports remote capabilities', () => {
    expect(() => createRemoteAdapter({})).toThrow(/endpoint/);
    expect(() => createRemoteAdapter({ endpoint: 'ftp://x' })).toThrow(/endpoint/);
    const adapter = createRemoteAdapter({ endpoint: 'https://compute.example/v1' });
    expect(adapter.kind).toBe('remote');
    expect(adapter.capabilities).toMatchObject({
      remote: true, requiresNetwork: true, authoritative: false, offline: false,
    });
  });

  it('sends contract-tagged jobs through the injected transport only', async () => {
    const transport = vi.fn(async () => ({ ok: true, seq: 1 }));
    const adapter = createRemoteAdapter({ endpoint: 'https://compute.example/v1', transport });
    const session = createComputeSession({ adapter });
    await session.start();
    const result = await session.step(0.05, { wave: 2 });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, body] = transport.mock.calls[0];
    expect(url).toBe('https://compute.example/v1');
    expect(body).toMatchObject({
      contract: COMPUTE_SESSION_CONTRACT,
      seq: 1,
      dt: 0.05,
      meta: { wave: 2 },
    });
    expect(result.result).toEqual({ ok: true, seq: 1 });
    await session.dispose();
  });

  it('default transport posts JSON with the contract header via injected fetch', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ seq: 1 }) }));
    const adapter = createRemoteAdapter({ endpoint: 'https://compute.example/v1', fetchImpl });
    await adapter.tick({ seq: 1, dt: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://compute.example/v1');
    expect(init.method).toBe('POST');
    expect(init.headers['x-vepa-compute-contract']).toBe(COMPUTE_SESSION_CONTRACT);
    expect(JSON.parse(init.body)).toMatchObject({ contract: COMPUTE_SESSION_CONTRACT, seq: 1 });
  });

  it('local sessions never construct or require the remote port', () => {
    // The app's default path has no endpoint and no fetch: creating and using
    // a local session must succeed with fetch missing entirely.
    const originalFetch = globalThis.fetch;
    // eslint-disable-next-line no-global-assign
    globalThis.fetch = undefined;
    try {
      const session = createComputeSession({ adapter: createMainAdapter({ runTick: () => 7 }) });
      expect(session.capabilities.remote).toBe(false);
      expect(session.capabilities.requiresNetwork).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
