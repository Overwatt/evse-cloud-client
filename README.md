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

A reference server (AWS CDK, self-hostable) lives in the Overwatt repository.
