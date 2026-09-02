# evse-cloud-client

Client library for the [OpenEVSE cloud relay protocol](./PROTOCOL.md):
push registration, away-from-home charger status, charging history, and iOS
Live Activity tokens — for React Native / Expo apps. Built for and battle-tested with OpenEVSE chargers; nothing in the protocol is hardware-specific.

Vendor-neutral: the host app supplies the server URL and token. Unconfigured,
every call is an inert no-op, so a LAN-only app can ship with this installed
and nothing changes.

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { configureCloud } from 'evse-cloud-client';

configureCloud({
  baseUrl: process.env.EXPO_PUBLIC_CLOUD_RELAY_URL,
  token: process.env.EXPO_PUBLIC_CLOUD_RELAY_TOKEN,
  storage: AsyncStorage,
  getPushToken: async () => /* your Expo push token */ null,
});
```

Then: `registerCloudDevice()`, `useCloudGlances()`, `useCloudKnownChargers()`,
`fetchSessions()`, `registerActivityToken()` / `registerStartToken()`,
and raw `cloudGet()` / `cloudPost()`.

## Signed-in callers

Servers with accounts want the person, not the app-wide token. Supply
`getAuthToken` and every request sends `Authorization: Bearer <id token>`
instead of the flat token, with no per-device headers — the identity is the
proof. Returning `null` (signed out, refresh failed) falls back to the flat
token, so one build serves both.

```ts
configureCloud({
  baseUrl: process.env.EXPO_PUBLIC_CLOUD_RELAY_URL,
  token: process.env.EXPO_PUBLIC_CLOUD_RELAY_TOKEN,
  storage: AsyncStorage,
  getPushToken: async () => /* your Expo push token */ null,
  getAuthToken: async () => /* your ID token, or null */ null,
});
```

## Owning chargers

Four calls need a signed-in caller, and — unlike everything else here — they
**throw** `CloudError { status, error }` rather than degrading. A claim either
issued a certificate or did not, and the app has to say which.

```ts
// On the charger's Wi-Fi: claim it, then hand it its credentials over the LAN.
const c = await claimCharger('openevse-2760', { serial, label: 'Garage' });
// c.certificatePem, c.privateKey (returned exactly once — never stored),
// c.rootCa, and c.config: the payload for the charger's own /config.

await unclaimCharger('openevse-2760');       // sold it; history stays

const { code, expiresAt } = await createInvite();   // paid plans only (402)
const { joined, home } = await redeemInvite(code);  // partner joins
```

`CloudError.error` is the server's own word for the refusal — `charger limit`,
`claimed elsewhere`, `no such tenant`, `no such invite`,
`household sharing needs the paid plan` — so the app can say something true
rather than "something went wrong".

A reference server (AWS CDK, self-hostable) lives in the Overwatt repository.
