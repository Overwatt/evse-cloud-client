// Client for the EVSE cloud relay protocol (see PROTOCOL.md).
//
// Vendor-neutral by construction: the host app supplies the server URL and
// bearer token via configure() — nothing here names any particular operator.
// Every call degrades to null/false on failure; an unconfigured client is a
// set of no-ops, so a LAN-only app can ship with this installed and inert.

import { useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Configuration

/** AsyncStorage-compatible slice — injected so this package has no hard
 *  native dependencies. */
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface CloudConfig {
  /** Server base URL, e.g. https://api.example.com — absent = client inert. */
  baseUrl?: string;
  /** The server's registration bearer token. */
  token?: string;
  /** Persistent storage for the device secret and sticky caches. */
  storage?: KeyValueStorage;
  /** This phone's push token (identifies the device to the server). */
  getPushToken?: () => Promise<string | null>;
  /**
   * The signed-in user's ID token, if there is one. When this returns a token
   * it is what authenticates the request — the flat token and the per-device
   * headers are not sent, because the identity is stronger proof than either.
   * Returning null (signed out, refresh failed) falls back to the flat token.
   */
  getAuthToken?: () => Promise<string | null>;
}

let config: CloudConfig = {};

export function configureCloud(next: CloudConfig): void {
  config = { ...next };
}

/** Whether a server was configured at all. */
export function cloudConfigured(): boolean {
  return !!(config.baseUrl && (config.token || config.getAuthToken));
}

const memoryStore = new Map<string, string>();

function storage(): KeyValueStorage {
  return (
    config.storage ?? {
      getItem: async (k) => memoryStore.get(k) ?? null,
      setItem: async (k, v) => {
        memoryStore.set(k, v);
      },
    }
  );
}

// ---------------------------------------------------------------------------
// Device pairing state

const SECRET_KEY = 'openevse.cloudDeviceSecret';

/** The server-minted secret for this (approved) device, or null. */
export async function getDeviceSecret(): Promise<string | null> {
  try {
    return await storage().getItem(SECRET_KEY);
  } catch {
    return null;
  }
}

async function setDeviceSecret(secret: string): Promise<void> {
  try {
    await storage().setItem(SECRET_KEY, secret);
  } catch {
    // Re-learned on the next registration.
  }
}

// The data endpoints require per-device proof on top of the (public) bundle
// bearer: this phone's push token plus the server-minted secret it received
// at registration once approved. Absent, they're omitted and the server
// answers 403 — callers degrade as usual.
async function deviceHeaders(): Promise<Record<string, string>> {
  const [token, secret] = await Promise.all([
    config.getPushToken?.() ?? Promise.resolve(null),
    getDeviceSecret(),
  ]);
  return token && secret
    ? { 'X-Device-Token': token, 'X-Device-Secret': secret }
    : {};
}

function base(): string {
  return (config.baseUrl ?? '').replace(/\/$/, '');
}

/**
 * What authenticates one request, or null when nothing does.
 *
 * `withDevice` is false for registration: the per-device secret is what
 * registration RETURNS, so presenting it there would be circular, and the
 * server does not look for it on that route.
 */
async function authHeaders(
  withDevice = true,
): Promise<Record<string, string> | null> {
  if (config.getAuthToken) {
    let jwt: string | null = null;
    try {
      jwt = await config.getAuthToken();
    } catch {
      jwt = null;
    }
    if (jwt) {
      return { Authorization: `Bearer ${jwt}` };
    }
  }
  if (config.token) {
    return {
      Authorization: `Bearer ${config.token}`,
      ...(withDevice ? await deviceHeaders() : {}),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Transport

/** Authenticated GET; null on any failure — callers degrade, never throw. */
export async function cloudGet<T>(path: string, timeoutMs = 8000): Promise<T | null> {
  if (!config.baseUrl) {
    return null;
  }
  const auth = await authHeaders();
  if (!auth) {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base()}${path}`, {
      signal: controller.signal,
      headers: auth,
    });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Authenticated POST; false on any failure. Same degrade-only contract. */
export async function cloudPost(
  path: string,
  body: unknown,
  timeoutMs = 8000,
): Promise<boolean> {
  if (!config.baseUrl) {
    return false;
  }
  const auth = await authHeaders();
  if (!auth) {
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base()}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// POST /register

export interface RegisterResult {
  ok: boolean;
  /** false = registered but pending approval; undefined = legacy server. */
  approved?: boolean;
}

/**
 * Register this phone for pushes. On an approving server the response carries
 * the per-device secret, which is stored for the data endpoints.
 */
export async function registerCloudDevice(body: {
  token: string;
  platform: string;
  devices: { name: string; nickname?: string }[];
  prefs?: Record<string, boolean>;
}): Promise<RegisterResult> {
  if (!config.baseUrl) {
    return { ok: false };
  }
  const auth = await authHeaders(false);
  if (!auth) {
    return { ok: false };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${base()}/register`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...auth,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { ok: false };
    }
    try {
      const parsed = (await res.json()) as { approved?: boolean; secret?: string };
      if (typeof parsed.secret === 'string' && parsed.secret) {
        await setDeviceSecret(parsed.secret);
      }
      return { ok: true, approved: parsed.approved };
    } catch {
      // Legacy server response — plain success.
      return { ok: true };
    }
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Charger glances (GET /status)

export type GlanceTone = 'charging' | 'connected' | 'ready' | 'off' | 'error';

export interface ChargerGlance {
  tone: GlanceTone;
  text: string;
}

export interface CloudCharger {
  name?: string;
  state?: number | null;
  sessionWh?: number | null;
  chargingStartedAt?: number | null;
  online?: boolean | null;
  updatedAt?: number | null;
}

/** Minimal shape of a charger entry as the host app models it. */
export interface NamedDevice {
  id: string;
  name: string;
}

// Chargers publish every ~30s; polling faster only re-reads the same row.
const POLL_MS = 30_000;

// A charger that hasn't written anything for this long is effectively
// unreachable even if no explicit offline marker has landed yet.
const STALE_MS = 5 * 60_000;

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) {
    return '';
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function summarizeCloudCharger(
  c: CloudCharger,
  now: number,
): ChargerGlance | null {
  if (c.online === false || (c.updatedAt && now - c.updatedAt > STALE_MS)) {
    return { tone: 'off', text: 'Offline' };
  }
  const state = typeof c.state === 'number' ? c.state : null;
  if (state === null) {
    return null;
  }
  const kwh = (c.sessionWh ?? 0) / 1000;
  if (state === 3) {
    const parts = ['Charging'];
    if (c.chargingStartedAt) {
      const elapsed = formatDuration(now - c.chargingStartedAt);
      if (elapsed) {
        parts.push(elapsed);
      }
    }
    if (kwh > 0) {
      parts.push(`${kwh.toFixed(1)} kWh`);
    }
    return { tone: 'charging', text: parts.join(' · ') };
  }
  if (state === 2) {
    return {
      tone: 'connected',
      text: kwh > 0 ? `Vehicle connected · ${kwh.toFixed(1)} kWh` : 'Vehicle connected',
    };
  }
  if (state === 1) {
    return { tone: 'ready', text: 'Ready' };
  }
  if (state === 254) {
    return { tone: 'off', text: 'Sleeping' };
  }
  if (state === 255) {
    return { tone: 'off', text: 'Disabled' };
  }
  if (state >= 4 && state <= 11) {
    return { tone: 'error', text: 'Fault — check charger' };
  }
  return null;
}

async function fetchCloudGlances(): Promise<Map<string, ChargerGlance>> {
  const out = new Map<string, ChargerGlance>();
  const body = await cloudGet<{ chargers?: CloudCharger[] }>('/status');
  const now = Date.now();
  for (const c of body?.chargers ?? []) {
    if (typeof c.name !== 'string') {
      continue;
    }
    const glance = summarizeCloudCharger(c, now);
    if (glance) {
      out.set(c.name, glance);
    }
  }
  return out;
}

/**
 * Poll the cloud for glances while `active`, returning a map of device id →
 * glance for the given devices (matched by charger name). Devices the cloud
 * doesn't know about simply have no entry.
 */
export function useCloudGlances(
  devices: NamedDevice[],
  active: boolean,
): Record<string, ChargerGlance> {
  const [glances, setGlances] = useState<Record<string, ChargerGlance>>({});
  const devicesRef = useRef(devices);
  devicesRef.current = devices;

  useEffect(() => {
    if (!active || !cloudConfigured()) {
      setGlances({});
      return;
    }
    let cancelled = false;

    const poll = async () => {
      const byName = await fetchCloudGlances();
      if (cancelled) {
        return;
      }
      const next: Record<string, ChargerGlance> = {};
      for (const d of devicesRef.current) {
        const glance = byName.get(d.name);
        if (glance) {
          next[d.id] = glance;
        }
      }
      setGlances(next);
    };

    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active]);

  return glances;
}

// ---------------------------------------------------------------------------
// Which chargers the cloud actually knows (the gate for cloud-dependent UI)

const KNOWN_KEY = 'openevse.cloudKnownChargers';

async function loadKnown(): Promise<Set<string>> {
  try {
    const raw = await storage().getItem(KNOWN_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * The set of charger names the cloud has state for. Fetches once per mount
 * and merges into a sticky stored set, so gated UI doesn't flicker away
 * when the phone is briefly offline.
 */
export function useCloudKnownChargers(): Set<string> {
  const [known, setKnown] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await loadKnown();
      if (!cancelled && stored.size > 0) {
        setKnown(new Set(stored));
      }
      if (!cloudConfigured()) {
        return;
      }
      const body = await cloudGet<{ chargers?: CloudCharger[] }>('/status');
      if (cancelled || !body?.chargers) {
        return;
      }
      const merged = new Set(stored);
      for (const c of body.chargers) {
        if (typeof c.name === 'string' && c.name) {
          merged.add(c.name);
        }
      }
      setKnown(merged);
      storage()
        .setItem(KNOWN_KEY, JSON.stringify([...merged]))
        .catch(() => {});
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return known;
}

// ---------------------------------------------------------------------------
// Sessions (GET /sessions) and Live Activity tokens (POST /activity)

export interface CloudSession {
  charger: string;
  startedAt: number | null;
  endedAt: number;
  wh: number | null;
}

export async function fetchSessions(
  charger: string,
  limit = 100,
): Promise<CloudSession[] | null> {
  const body = await cloudGet<{ sessions?: CloudSession[] }>(
    `/sessions?charger=${encodeURIComponent(charger)}&limit=${limit}`,
  );
  return body?.sessions ?? (body ? [] : null);
}

/** Register an ActivityKit update token for one charger's live activity. */
export async function registerActivityToken(
  charger: string,
  token: string,
): Promise<boolean> {
  const pushToken = await (config.getPushToken?.() ?? Promise.resolve(null));
  return cloudPost('/activity', { charger, token, expoToken: pushToken ?? undefined });
}

/** Register the phone's push-to-start token with its charger labels. */
export async function registerStartToken(
  startToken: string,
  nicknames: Record<string, string>,
): Promise<boolean> {
  const pushToken = await (config.getPushToken?.() ?? Promise.resolve(null));
  return cloudPost('/activity', {
    startToken,
    nicknames,
    expoToken: pushToken ?? undefined,
  });
}

// ---------------------------------------------------------------------------
// Claim, unclaim and invites
//
// These four THROW, unlike everything above. The rest of this package degrades
// to null/false because a missed glance is a cosmetic failure; a claim is not.
// The server issued a certificate, or it did not, and the app has to know
// which — and has to be able to tell "no such tenant" from "charger limit"
// from "the network is down", because it says different things to the person.

export class CloudError extends Error {
  constructor(
    public readonly status: number,
    public readonly error: string,
  ) {
    super(`${status} ${error}`);
    this.name = 'CloudError';
  }
}

/** Certificate issuing is not instant; 8 s is tight for it. */
const CLAIM_TIMEOUT_MS = 15_000;

async function request<T>(
  method: 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  opts: { allowEmptyOk?: boolean } = {},
): Promise<T> {
  if (!config.baseUrl) {
    throw new CloudError(0, 'not configured');
  }
  // No per-device headers here: these are user-identified calls (a JWT, or
  // the flat token alone), never a paired-device data read, and the server
  // does not look for X-Device-* on them.
  const auth = await authHeaders(false);
  if (!auth) {
    throw new CloudError(0, 'not configured');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAIM_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, {
      method,
      signal: controller.signal,
      headers: body === undefined
        ? auth
        : { ...auth, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new CloudError(0, 'network');
  } finally {
    clearTimeout(timer);
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const named = (parsed as { error?: unknown } | null)?.error;
    throw new CloudError(res.status, typeof named === 'string' ? named : 'request failed');
  }
  if (!opts.allowEmptyOk && (parsed === null || typeof parsed !== 'object')) {
    throw new CloudError(res.status, 'bad response');
  }
  return parsed as T;
}

export interface ClaimedCharger {
  name: string;
  tenant: string;
  certificatePem: string;
  /** Returned exactly once, by the server, and never again. Hand it straight
   *  to the charger; do not persist it. */
  privateKey: string;
  rootCa: string;
  /** The payload to POST to the charger's own `/config`. */
  config: Record<string, string | number | boolean>;
}

/**
 * Claim a charger for the signed-in user's household.
 *
 * The name is the charger's hostname, which is also its MQTT client id. The
 * response carries credentials the app uploads to the charger over the LAN.
 */
export async function claimCharger(
  name: string,
  opts: { serial?: string; label?: string; tenantId?: string } = {},
): Promise<ClaimedCharger> {
  return request<ClaimedCharger>('POST', '/claim', {
    name,
    ...(opts.serial ? { serial: opts.serial } : {}),
    ...(opts.label ? { label: opts.label } : {}),
    ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
  });
}

/** Give a charger up: its certificate is revoked, so it stops publishing.
 *  Charging history stays with the household that ran it. */
export async function unclaimCharger(name: string): Promise<void> {
  await request<{ ok: boolean }>(
    'DELETE',
    `/chargers/${encodeURIComponent(name)}`,
    undefined,
    { allowEmptyOk: true },
  );
}

/** Mint a single-use code that lets one more person join the household. */
export async function createInvite(): Promise<{ code: string; expiresAt: number }> {
  return request<{ code: string; expiresAt: number }>('POST', '/invite', {});
}

/** Redeem an invite code. `home` is where the caller's phone endpoints will
 *  read from afterwards — the server moves it when their own household is
 *  empty, which is the usual case for a partner who just signed up. */
export async function redeemInvite(
  code: string,
): Promise<{ joined: string; home: string }> {
  return request<{ joined: string; home: string }>('POST', '/invite/redeem', { code });
}
