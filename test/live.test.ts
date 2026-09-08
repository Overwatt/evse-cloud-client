import { describe, expect, it, vi } from 'vitest';
import { LiveClient, backoffDelay, type LiveServerMessage, type LiveSocketState } from '../src/live';

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

function harness(token: string | null = 'tok') {
  FakeSocket.instances = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const messages: LiveServerMessage[] = [];
  const states: LiveSocketState[] = [];
  const client = new LiveClient({
    url: 'wss://live.example',
    getToken: () => Promise.resolve(token),
    onMessage: (m) => messages.push(m),
    onState: (s) => states.push(s),
    WebSocketImpl: FakeSocket as never,
    setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutImpl: (h) => { const i = (h as number) - 1; if (timers[i]) timers[i].fn = () => {}; },
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { client, timers, messages, states, flush };
}

describe('backoffDelay', () => {
  it('is 1, 2, 5, 15 s then 15 s', () => {
    expect([0, 1, 2, 3, 4, 9].map(backoffDelay)).toEqual([1000, 2000, 5000, 15000, 15000, 15000]);
  });
});

describe('LiveClient', () => {
  it('connects with the token in the query string and reports state', async () => {
    const h = harness();
    h.client.start();
    await h.flush();
    expect(FakeSocket.instances[0].url).toBe('wss://live.example?token=tok');
    expect(h.states).toEqual(['connecting']);
    FakeSocket.instances[0].open();
    expect(h.states).toEqual(['connecting', 'open']);
  });

  it('does not connect without a token, and retries later', async () => {
    const h = harness(null);
    h.client.start();
    await h.flush();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(h.timers[0].ms).toBe(1000);
  });

  it('sends subscriptions on open and diffs later changes', async () => {
    const h = harness();
    h.client.setSubscriptions({ a: false, b: true });
    h.client.start();
    await h.flush();
    const s = FakeSocket.instances[0];
    s.open();
    expect(s.sent.map((x) => JSON.parse(x))).toEqual([
      { subscribe: ['a'] },
      { subscribe: ['b'], lease: true },
    ]);
    h.client.setSubscriptions({ b: false, c: true });
    expect(s.sent.slice(2).map((x) => JSON.parse(x))).toEqual([
      { unsubscribe: ['a'] },
      { subscribe: ['b'] },
      { subscribe: ['c'], lease: true },
    ]);
  });

  it('parses messages and drops garbage', async () => {
    const h = harness();
    h.client.start();
    await h.flush();
    const s = FakeSocket.instances[0];
    s.open();
    s.receive({ charger: 'a', tick: { amps: 6 } });
    s.onmessage?.({ data: '{nope' });
    s.receive({ what: 1 });
    expect(h.messages).toEqual([{ charger: 'a', tick: { amps: 6 } }]);
  });

  it('reconnects with backoff and resubscribes', async () => {
    const h = harness();
    h.client.setSubscriptions({ a: true });
    h.client.start();
    await h.flush();
    FakeSocket.instances[0].open();
    FakeSocket.instances[0].close();
    expect(h.states.at(-1)).toBe('closed');
    expect(h.timers.at(-1)?.ms).toBe(1000);
    h.timers.at(-1)!.fn();
    await h.flush();
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1].close();
    expect(h.timers.at(-1)?.ms).toBe(2000);
    h.timers.at(-1)!.fn();
    await h.flush();
    FakeSocket.instances[2].open();
    expect(JSON.parse(FakeSocket.instances[2].sent[0])).toEqual({ subscribe: ['a'], lease: true });
  });

  it('a clean open resets the backoff', async () => {
    const h = harness();
    h.client.start();
    await h.flush();
    FakeSocket.instances[0].close();
    h.timers.at(-1)!.fn();
    await h.flush();
    FakeSocket.instances[1].open();
    FakeSocket.instances[1].close();
    expect(h.timers.at(-1)?.ms).toBe(1000);
  });

  it('keepalive resends lease subscriptions while open', async () => {
    const h = harness();
    h.client.setSubscriptions({ a: true, b: false });
    h.client.start();
    await h.flush();
    const s = FakeSocket.instances[0];
    s.open();
    const keep = h.timers.find((t) => t.ms === 60_000)!;
    keep.fn();
    expect(JSON.parse(s.sent.at(-1)!)).toEqual({ subscribe: ['a'], lease: true });
  });

  it('stop closes and never reconnects', async () => {
    const h = harness();
    h.client.start();
    await h.flush();
    FakeSocket.instances[0].open();
    const before = h.timers.length;
    h.client.stop();
    expect(FakeSocket.instances[0].readyState).toBe(3);
    expect(h.states.at(-1)).toBe('closed');
    expect(h.timers.slice(before).filter((t) => t.ms !== 60_000)).toEqual([]);
  });
});
