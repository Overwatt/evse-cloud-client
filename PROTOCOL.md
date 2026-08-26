# EVSE cloud relay protocol

A small HTTPS API that gives an EV-charger phone app cloud superpowers: push
notifications from anywhere, away-from-home charger status, charging history,
and iOS Live Activities. Any server can implement it; this package is the
client. The reference server implementation (AWS CDK: IoT Core MQTT ingest →
Lambda → DynamoDB → Expo push/APNs) lives in the Overwatt repository and is
self-hostable.

All endpoints require `Authorization: Bearer <token>` — a server-issued
registration token identifying the household (stage-1 auth; servers may layer
stronger schemes). Data endpoints additionally require per-device proof (see
*Device pairing*).

## POST /register

The app registers its push token, charger nicknames, and notification
preferences. Safe to call repeatedly; servers throttle-friendly.

```json
{
  "token": "ExponentPushToken[...]",
  "platform": "ios",
  "devices": [{ "name": "openevse-2760", "nickname": "Garage" }],
  "prefs": { "plug": true, "charge": true, "fault": true, "presence": false }
}
```

Response: `{ "ok": true, "approved": true, "secret": "..." }`.

- `approved` — servers may require a human to approve each new device before
  it receives pushes or data. `false` = registered but pending; the app
  should re-register on next launch to pick up approval.
- `secret` — a server-minted per-device credential, present only once
  approved. The client stores it and presents it on data reads.

Notification kinds: `plug` (plugged/unplugged), `charge` (started/finished),
`fault`, `presence` (charger offline/online). Missing keys mean enabled.

## Device pairing

Data endpoints require two extra headers, proving the caller is an approved
registered device rather than merely a holder of the (extractable) app token:

```
X-Device-Token:  <the push token used at /register>
X-Device-Secret: <the secret from the /register response>
```

Servers answer `403` otherwise. Clients treat 403 as "not paired" and
degrade to LAN-only behavior.

## GET /status

Charger states as the server's ingest pipeline last saw them.

```json
{ "chargers": [{
  "name": "openevse-2760",
  "state": 3,
  "vehicle": 1,
  "sessionWh": 5230,
  "chargingStartedAt": 1787700000000,
  "online": true,
  "offlineAt": null,
  "updatedAt": 1787700030000
}] }
```

`state` uses the OpenEVSE-style RAPI codes (the reference hardware): 1 ready, 2 connected, 3 charging,
4–11 faults, 254 sleeping, 255 disabled.

## GET /sessions?charger=<name>&limit=<n>

Completed charging runs, newest first.

```json
{ "sessions": [{
  "charger": "openevse-2760",
  "startedAt": 1787700000000,
  "endedAt": 1787707200000,
  "wh": 8500
}] }
```

## POST /activity

iOS Live Activity (ActivityKit) token registration. Two shapes:

```json
{ "startToken": "<hex>", "nicknames": { "openevse-2760": "Garage" },
  "expoToken": "ExponentPushToken[...]" }
```

the phone's push-to-start token (iOS 17.2+) with a label snapshot, and

```json
{ "charger": "openevse-2760", "token": "<hex>",
  "expoToken": "ExponentPushToken[...]" }
```

the update token for one live activity. `expoToken` links the device so
servers can skip banner notifications that duplicate a live card.

## POST /command (reserved)

Remote charger control. Shape not yet frozen; servers may 404 it.
