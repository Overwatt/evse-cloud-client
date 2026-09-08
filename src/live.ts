// The phone-facing live feed. A thin reconnecting wrapper over WebSocket:
// the token rides the query string, subscriptions are a name → lease map
// the caller replaces wholesale, and the class diffs and sends the change.
// Everything with a clock or a socket is injectable so the tests need
// neither.

import type { CloudCharger } from './index';

export type LiveServerMessage =
  | { charger: string; snapshot: CloudCharger }
  | { charger: string; event: CloudCharger }
  | { charger: string; tick: Partial<CloudCharger> }
  | { error: string; charger?: string };

export type LiveSocketState = 'closed' | 'connecting' | 'open';

export interface WebSocketLike {
  new (url: string): {
    readyState: number;
    onopen: (() => void) | null;
    onclose: (() => void) | null;
    onerror: (() => void) | null;
    onmessage: ((ev: { data: unknown }) => void) | null;
    send(data: string): void;
    close(): void;
  };
}

export interface LiveClientOptions {
  url: string;
  getToken: () => Promise<string | null>;
  onMessage: (message: LiveServerMessage) => void;
  onState: (state: LiveSocketState) => void;
  /** Test seams; default to the globals. */
  WebSocketImpl?: WebSocketLike;
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
  keepaliveMs?: number;
}

const BACKOFF_MS = [1000, 2000, 5000, 15000];

/** 1 s, 2 s, 5 s, 15 s, then 15 s for every later attempt. */
export function backoffDelay(attempt: number): number {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
}

type Socket = InstanceType<WebSocketLike>;

export class LiveClient {
  private socket: Socket | null = null;
  private subs: Record<string, boolean> = {};
  private sentSubs: Record<string, boolean> = {};
  private attempt = 0;
  private wanted = false;
  private retryHandle: unknown = null;
  private keepaliveHandle: unknown = null;
  private stateValue: LiveSocketState = 'closed';
  private readonly WS: WebSocketLike;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly keepaliveMs: number;

  constructor(private readonly opts: LiveClientOptions) {
    this.WS = opts.WebSocketImpl ?? ((globalThis as { WebSocket?: WebSocketLike }).WebSocket as WebSocketLike);
    this.setTimer = opts.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimeoutImpl ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.keepaliveMs = opts.keepaliveMs ?? 60_000;
  }

  get state(): LiveSocketState {
    return this.stateValue;
  }

  start(): void {
    if (this.wanted) {
      return;
    }
    this.wanted = true;
    this.attempt = 0;
    void this.connect();
  }

  stop(): void {
    this.wanted = false;
    this.clearRetry();
    this.clearKeepalive();
    const s = this.socket;
    this.socket = null;
    this.sentSubs = {};
    if (s) {
      s.onclose = null;
      s.close();
    }
    this.setState('closed');
  }

  setSubscriptions(next: Record<string, boolean>): void {
    this.subs = { ...next };
    if (this.stateValue === 'open') {
      this.sendDiff();
    }
  }

  private setState(next: LiveSocketState): void {
    if (this.stateValue === next) {
      return;
    }
    this.stateValue = next;
    this.opts.onState(next);
  }

  private async connect(): Promise<void> {
    if (!this.wanted || this.socket || !this.WS) {
      return;
    }
    const token = await this.opts.getToken().catch(() => null);
    if (!this.wanted || this.socket) {
      return;
    }
    if (!token) {
      this.scheduleRetry();
      return;
    }
    this.setState('connecting');
    const s = new this.WS(`${this.opts.url}?token=${encodeURIComponent(token)}`);
    this.socket = s;
    s.onopen = () => {
      if (this.socket !== s) {
        return;
      }
      this.attempt = 0;
      this.sentSubs = {};
      this.setState('open');
      this.sendDiff();
      this.armKeepalive();
    };
    s.onmessage = (ev) => {
      if (this.socket !== s) {
        return;
      }
      const parsed = parseMessage(ev.data);
      if (parsed) {
        this.opts.onMessage(parsed);
      }
    };
    s.onerror = () => {
      // onclose follows; nothing to do here.
    };
    s.onclose = () => {
      if (this.socket !== s) {
        return;
      }
      this.socket = null;
      this.sentSubs = {};
      this.clearKeepalive();
      this.setState('closed');
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (!this.wanted || this.retryHandle !== null) {
      return;
    }
    const delay = backoffDelay(this.attempt);
    this.attempt += 1;
    this.retryHandle = this.setTimer(() => {
      this.retryHandle = null;
      void this.connect();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryHandle !== null) {
      this.clearTimer(this.retryHandle);
      this.retryHandle = null;
    }
  }

  private armKeepalive(): void {
    this.clearKeepalive();
    this.keepaliveHandle = this.setTimer(() => {
      this.keepaliveHandle = null;
      if (this.stateValue !== 'open' || !this.socket) {
        return;
      }
      // Re-sending the lease subscriptions is the renewal (cloud plan).
      const leased = Object.keys(this.subs).filter((n) => this.subs[n]);
      if (leased.length > 0) {
        this.send({ subscribe: leased, lease: true });
      }
      this.armKeepalive();
    }, this.keepaliveMs);
  }

  private clearKeepalive(): void {
    if (this.keepaliveHandle !== null) {
      this.clearTimer(this.keepaliveHandle);
      this.keepaliveHandle = null;
    }
  }

  private send(body: unknown): void {
    try {
      this.socket?.send(JSON.stringify(body));
    } catch {
      // A send on a closing socket; onclose will follow.
    }
  }

  /** Send only what changed since the last send on this socket. */
  private sendDiff(): void {
    const gone = Object.keys(this.sentSubs).filter((n) => !(n in this.subs));
    if (gone.length > 0) {
      this.send({ unsubscribe: gone });
    }
    const plain: string[] = [];
    const leased: string[] = [];
    for (const [name, lease] of Object.entries(this.subs)) {
      if (this.sentSubs[name] === lease) {
        continue;
      }
      (lease ? leased : plain).push(name);
    }
    if (plain.length > 0) {
      this.send({ subscribe: plain });
    }
    if (leased.length > 0) {
      this.send({ subscribe: leased, lease: true });
    }
    this.sentSubs = { ...this.subs };
  }
}

function parseMessage(data: unknown): LiveServerMessage | null {
  if (typeof data !== 'string') {
    return null;
  }
  let body: unknown;
  try {
    body = JSON.parse(data);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') {
    return null;
  }
  const b = body as Record<string, unknown>;
  if (typeof b.error === 'string') {
    return { error: b.error, ...(typeof b.charger === 'string' ? { charger: b.charger } : {}) };
  }
  if (typeof b.charger !== 'string') {
    return null;
  }
  if (b.snapshot && typeof b.snapshot === 'object') {
    return { charger: b.charger, snapshot: b.snapshot as CloudCharger };
  }
  if (b.event && typeof b.event === 'object') {
    return { charger: b.charger, event: b.event as CloudCharger };
  }
  if (b.tick && typeof b.tick === 'object') {
    return { charger: b.charger, tick: b.tick as Partial<CloudCharger> };
  }
  return null;
}
