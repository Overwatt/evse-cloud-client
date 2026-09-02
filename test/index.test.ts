// The auth switch: this client speaks to a server that accepts either a flat
// registration token plus per-device proof, or a signed-in user's ID token.
// Which one it sends is the whole of this file, because sending both — or
// sending the device headers alongside a JWT — is how a caller ends up
// authenticated as the wrong thing.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cloudConfigured,
  cloudGet,
  cloudPost,
  configureCloud,
  registerCloudDevice,
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
