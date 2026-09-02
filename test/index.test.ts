// The auth switch: this client speaks to a server that accepts either a flat
// registration token plus per-device proof, or a signed-in user's ID token.
// Which one it sends is the whole of this file, because sending both — or
// sending the device headers alongside a JWT — is how a caller ends up
// authenticated as the wrong thing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CloudError,
  claimCharger,
  cloudConfigured,
  cloudGet,
  cloudPost,
  configureCloud,
  createInvite,
  redeemInvite,
  registerCloudDevice,
  unclaimCharger,
} from '../src/index';

const store = new Map<string, string>();
const storage = {
  getItem: (k: string) => Promise.resolve(store.get(k) ?? null),
  setItem: (k: string, v: string) => {
    store.set(k, v);
    return Promise.resolve();
  },
};

let calls: { url: string; init: RequestInit }[] = [];

const respond = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
});

const headers = (i = 0): Record<string, string> =>
  (calls[i]?.init.headers ?? {}) as Record<string, string>;

beforeEach(() => {
  store.clear();
  store.set('openevse.cloudDeviceSecret', 'secret-1');
  calls = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(respond(200, { chargers: [] }));
  });
  configureCloud({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cloudConfigured', () => {
  it('needs a base URL and something to authenticate with', () => {
    configureCloud({});
    expect(cloudConfigured()).toBe(false);
    configureCloud({ baseUrl: 'https://api.example.com' });
    expect(cloudConfigured()).toBe(false);
    configureCloud({ baseUrl: 'https://api.example.com', token: 'flat' });
    expect(cloudConfigured()).toBe(true);
    configureCloud({
      baseUrl: 'https://api.example.com',
      getAuthToken: () => Promise.resolve('jwt'),
    });
    expect(cloudConfigured()).toBe(true);
  });
});

describe('the flat token path', () => {
  beforeEach(() => {
    configureCloud({
      baseUrl: 'https://api.example.com/',
      token: 'flat',
      storage,
      getPushToken: () => Promise.resolve('ExponentPushToken[abc]'),
    });
  });

  it('sends the token and the per-device proof on a data read', async () => {
    await cloudGet('/status');
    expect(calls[0].url).toBe('https://api.example.com/status');
    expect(headers()).toEqual({
      Authorization: 'Bearer flat',
      'X-Device-Token': 'ExponentPushToken[abc]',
      'X-Device-Secret': 'secret-1',
    });
  });

  it('does not send device proof on registration — that is how it is earned', async () => {
    await registerCloudDevice({ token: 'ExponentPushToken[abc]', platform: 'ios', devices: [] });
    expect(headers()).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer flat',
    });
  });
});

describe('the signed-in path', () => {
  beforeEach(() => {
    configureCloud({
      baseUrl: 'https://api.example.com',
      token: 'flat',
      storage,
      getPushToken: () => Promise.resolve('ExponentPushToken[abc]'),
      getAuthToken: () => Promise.resolve('jwt-value'),
    });
  });

  it('sends the ID token INSTEAD of the flat token, with no device headers', async () => {
    await cloudGet('/status');
    expect(headers()).toEqual({ Authorization: 'Bearer jwt-value' });
  });

  it('does the same on a post', async () => {
    await cloudPost('/activity', { charger: 'openevse-2760' });
    expect(headers()).toEqual({
      Authorization: 'Bearer jwt-value',
      'Content-Type': 'application/json',
    });
  });

  it('registers as the signed-in user too', async () => {
    await registerCloudDevice({ token: 'ExponentPushToken[abc]', platform: 'ios', devices: [] });
    expect(headers()).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer jwt-value',
    });
  });
});

describe('when there is no signed-in user', () => {
  it('falls back to the flat token when getAuthToken returns null', async () => {
    configureCloud({
      baseUrl: 'https://api.example.com',
      token: 'flat',
      storage,
      getPushToken: () => Promise.resolve('ExponentPushToken[abc]'),
      getAuthToken: () => Promise.resolve(null),
    });
    await cloudGet('/status');
    expect(headers().Authorization).toBe('Bearer flat');
  });

  it('falls back when getAuthToken throws rather than failing the request', async () => {
    configureCloud({
      baseUrl: 'https://api.example.com',
      token: 'flat',
      storage,
      getAuthToken: () => Promise.reject(new Error('token refresh failed')),
    });
    await cloudGet('/status');
    expect(headers().Authorization).toBe('Bearer flat');
  });

  it('makes no request at all when there is nothing to authenticate with', async () => {
    configureCloud({
      baseUrl: 'https://api.example.com',
      getAuthToken: () => Promise.resolve(null),
    });
    expect(await cloudGet('/status')).toBeNull();
    expect(await cloudPost('/activity', {})).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('claiming a charger', () => {
  beforeEach(() => {
    configureCloud({
      baseUrl: 'https://api.example.com',
      getAuthToken: () => Promise.resolve('jwt-value'),
    });
  });

  const claimed = {
    name: 'openevse-2760',
    tenant: '01j9c4wq',
    certificatePem: 'PEM',
    privateKey: 'KEY',
    rootCa: 'ROOT',
    config: { mqtt_server: 'mqtt.overwatt.app', mqtt_port: 8883 },
  };

  it('posts the name and returns the credentials', async () => {
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(respond(200, claimed));
    });
    const out = await claimCharger('openevse-2760', { serial: 'SN-1', label: 'Garage' });
    expect(out).toEqual(claimed);
    expect(calls[0].url).toBe('https://api.example.com/claim');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      name: 'openevse-2760',
      serial: 'SN-1',
      label: 'Garage',
    });
    expect(headers()).toEqual({
      Authorization: 'Bearer jwt-value',
      'Content-Type': 'application/json',
    });
  });

  it('sends only the name when there is nothing else to say', async () => {
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(respond(200, claimed));
    });
    await claimCharger('openevse-2760');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ name: 'openevse-2760' });
  });

  it('throws the server refusal, status and all', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(respond(409, { error: 'claimed elsewhere' })));
    await expect(claimCharger('openevse-2760')).rejects.toMatchObject({
      name: 'CloudError',
      status: 409,
      error: 'claimed elsewhere',
    });
  });

  it('throws with the status even when the body is not JSON', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: false,
        status: 502,
        json: () => Promise.reject(new Error('not json')),
      }),
    );
    await expect(claimCharger('openevse-2760')).rejects.toMatchObject({
      status: 502,
      error: 'request failed',
    });
  });

  it('throws rather than silently doing nothing when unconfigured', async () => {
    configureCloud({});
    await expect(claimCharger('openevse-2760')).rejects.toBeInstanceOf(CloudError);
    expect(calls).toHaveLength(0);
  });

  it('sends no per-device headers even on the flat-token path', async () => {
    configureCloud({
      baseUrl: 'https://api.example.com',
      token: 'flat',
      storage,
      getPushToken: () => Promise.resolve('ExponentPushToken[abc]'),
    });
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(respond(200, claimed));
    });
    await claimCharger('openevse-2760');
    expect(headers()).toEqual({
      Authorization: 'Bearer flat',
      'Content-Type': 'application/json',
    });
  });

  it('throws bad response for a 200 whose body is not a usable object', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error('not json')),
      }),
    );
    await expect(claimCharger('openevse-2760')).rejects.toMatchObject({
      status: 200,
      error: 'bad response',
    });
  });

  it('unclaims by name, with no body', async () => {
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(respond(200, { ok: true }));
    });
    await expect(unclaimCharger('openevse-2760')).resolves.toBeUndefined();
    expect(calls[0].url).toBe('https://api.example.com/chargers/openevse-2760');
    expect(calls[0].init.method).toBe('DELETE');
    expect(calls[0].init.body).toBeUndefined();
    expect(headers()).toEqual({ Authorization: 'Bearer jwt-value' });
  });

  it('tolerates an empty 200 body on unclaim', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error('no body')),
      }),
    );
    await expect(unclaimCharger('openevse-2760')).resolves.toBeUndefined();
  });

  it('throws when the charger is not the caller to give away', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(respond(404, { error: 'no such charger' })));
    await expect(unclaimCharger('openevse-2760')).rejects.toMatchObject({
      status: 404,
      error: 'no such charger',
    });
  });
});

describe('invites', () => {
  beforeEach(() => {
    configureCloud({
      baseUrl: 'https://api.example.com',
      getAuthToken: () => Promise.resolve('jwt-value'),
    });
  });

  it('mints a code', async () => {
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(respond(200, { code: 'ABCD2345', expiresAt: 1787700000000 }));
    });
    expect(await createInvite()).toEqual({ code: 'ABCD2345', expiresAt: 1787700000000 });
    expect(calls[0].url).toBe('https://api.example.com/invite');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({});
  });

  it('surfaces the paywall as a CloudError the app can read', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(respond(402, { error: 'household sharing needs the paid plan' })),
    );
    await expect(createInvite()).rejects.toMatchObject({
      status: 402,
      error: 'household sharing needs the paid plan',
    });
  });

  it('redeems a code and says where the caller ended up', async () => {
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(respond(200, { joined: 'inviter', home: 'inviter' }));
    });
    expect(await redeemInvite('abcd2345')).toEqual({ joined: 'inviter', home: 'inviter' });
    expect(calls[0].url).toBe('https://api.example.com/invite/redeem');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ code: 'abcd2345' });
  });
});
