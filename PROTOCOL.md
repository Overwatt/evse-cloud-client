# EVSE cloud relay protocol

The protocol has two edges, both documented here:

- **Phone ↔ cloud** (§ HTTPS API): push registration, away-from-home status,
  charging history, Live Activity tokens. This package is the client.
- **Charger ↔ cloud** (§ Device agent, MQTT): the wire format a charger's
  cloud-agent firmware component speaks — consolidated status documents,
  presence, and acknowledged commands.

Any server can implement it. The reference server implementation (AWS CDK:
IoT Core MQTT ingest → Lambda → DynamoDB → Expo push/APNs) lives in the
Overwatt repository and is self-hostable. Servers also accept unmodified
OpenEVSE firmware (per-key topics — see *Legacy device compatibility*), so
the agent is an upgrade, never a requirement.

All endpoints require `Authorization: Bearer <token>` — a server-issued
registration token identifying the household (stage-1 auth; servers may layer
stronger schemes). Data endpoints additionally require per-device proof (see
*Device pairing*). Servers that have accounts accept a signed-in user's ID
token in the same header instead; the per-device headers are then not sent,
and the claim and invite endpoints below accept nothing else.

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
  "label": "Garage",
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

`label` is the operator's display name for the charger, set at claim time
(`POST /claim`'s optional `label`). It is `null` — or absent, on an older
server — when the charger was claimed without one. Servers MUST NOT
substitute `name`, which is the MQTT client id: what to show when there is
no label is the client's decision.

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

## POST /claim

Binds a charger to the caller's household and provisions it. Requires a
signed-in caller: servers answer `403 {"error":"sign in to claim"}` to a
registration-token caller.

```json
{ "name": "openevse-2760", "serial": "optional", "label": "Garage",
  "tenantId": "optional — another household the caller administers" }
```

`name` is the charger's hostname, which is also its MQTT client id
(`^[a-z0-9][a-z0-9-]{0,39}$`). Response:

```json
{ "name": "openevse-2760", "tenant": "01j...",
  "certificatePem": "...", "privateKey": "...", "rootCa": "...",
  "config": { "mqtt_server": "...", "mqtt_port": 8883, "...": "..." } }
```

The private key is returned exactly once and is never retrievable again; the
client hands it to the charger over the LAN and does not store it. `config` is
the payload for the charger's own `/config` endpoint.

A name already held by another household may be claimed only while it is
offline there — `409 {"error":"claimed elsewhere"}` otherwise; that household
is notified when it succeeds. Servers MAY cap chargers per household
(`409 {"error":"charger limit"}`). A household the caller cannot administer is
`404 {"error":"no such tenant"}`, never 403.

## DELETE /chargers/{name}

Gives the charger up: the server revokes its certificate, so it stops
publishing within the keepalive. Charging history stays with the household.
`200 {"ok": true}`; `404 {"error":"no such charger"}` for a name the caller
cannot see. The name becomes claimable again by anyone.

## POST /invite

Mints a single-use code letting one more person join the caller's household.
`200 { "code": "ABCD2345", "expiresAt": <epoch ms> }`. Servers MAY make this a
paid feature: `402 {"error":"household sharing needs the paid plan"}`.

## POST /invite/redeem

Body `{ "code": "ABCD2345" }` — matched case-insensitively. Joins the caller to
the code's household and consumes the code. `200 { "joined": "<household>",
"home": "<household the caller's reads now come from>" }`. Redeeming is never
paywalled: the inviter paid. Invalid or expired codes are
`404 {"error":"no such invite"}`.

**Reads lag a redeem by up to a minute.** A server is expected to cache the
caller's identity per handler — the reference server does, for 60 s — and
`/invite/redeem` runs in a different handler from `/status`, so evicting the
cache there does not evict the one that answers the next read. After a
successful redeem, `GET /status` MAY not yet list the joined household's
chargers. Clients SHOULD poll every 5 s for up to 60 s rather than treating
the first response as final.

## POST /command (reserved)

Remote charger control. Shape not yet frozen; servers may 404 it.
When frozen, servers SHOULD deliver it to agent-equipped chargers via the
`cmd`/`ack` topics below, gaining delivery confirmation.

---

# Device agent (charger ↔ cloud, MQTT)

The wire format for a charger-side cloud agent — a firmware component that
publishes structured, versioned documents instead of the stock firmware's
one-topic-per-key surface. Design goals, in order: **atomic state** (one
document = one server ingest, no cross-topic races), **explicit versioning**,
**clean presence** (no reliance on legacy announce topics), and **acknowledged
commands**.

## Transport

- The agent shares the charger's single MQTT(S) connection — it is a
  publisher/subscriber layer, never a second socket.
- All topics live under the charger's base topic `t/<tenant>/<thing>`:

| Topic (suffix) | Direction | QoS | Retained |
|---|---|---|---|
| `agent/status` | device → cloud | 1 | yes |
| `agent/presence` | device → cloud (+ LWT) | 1 | yes |
| `agent/session` | device → cloud | 1 | no |
| `agent/cmd` | cloud → device | 1 | no |
| `agent/ack` | device → cloud | 1 | no |

- All payloads are JSON objects carrying `"v": 1`. Receivers MUST ignore
  unknown fields (additive evolution); a breaking change bumps `v`, and a
  device advertises the version it speaks in `agent/presence`.

## agent/status — the consolidated state document

Published retained: on connect, every `interval_s` (default 30), and
immediately (debounced ~1 s) when `state` or `vehicle` changes. Retention
means the broker itself holds the last state — servers need no baseline
seeding and a reconnecting server reads current truth instantly.

```json
{
  "v": 1,
  "ts": 1787700030,
  "uptime_s": 86400,
  "state": 3,
  "vehicle": 1,
  "session_wh": 5230,
  "session_start_ts": 1787695000,
  "amp": 24.1,
  "volt": 242.0,
  "pilot_a": 32,
  "temp_c": 41.2,
  "wifi_rssi": -61,
  "free_heap": 98304,
  "flags": ["manual_override"]
}
```

- `ts` — device epoch seconds (servers should still stamp receipt time and
  treat `ts` as advisory: RTCs drift).
- `state` — the EVSE state code (OpenEVSE-style RAPI on the reference
  hardware): 1 ready, 2 connected, 3 charging, 4–11 fault, 254 sleeping,
  255 disabled.
- `session_start_ts` — present while charging; lets any consumer render
  elapsed time without reconstructing it from transitions.
- Everything after `session_wh` is optional. `flags` is an open string set
  (`manual_override`, `divert_active`, `limit_active`, …).

## agent/presence — birth and last will

Retained. Published on connect; the connection's LWT is the same topic with
`online: false`, so ungraceful death flips presence without any server-side
lifecycle integration (servers on brokers WITH lifecycle events, e.g. AWS
IoT, MAY use those instead and treat this topic as corroboration).

```json
{ "v": 1, "online": true,  "ts": 1787700000,
  "fw": "5.1.2", "agent": "0.1.0", "proto": 1, "ip": "10.75.1.157" }
{ "v": 1, "online": false }
```

## agent/session — completed charging runs

Published (not retained) once per run, when the charger leaves the charging
state. Device-side session records beat server-reconstructed ones: they
survive server downtime and carry exact boundaries.

```json
{ "v": 1, "start_ts": 1787695000, "end_ts": 1787702200,
  "wh": 8500, "reason": "vehicle" }
```

`reason`: `vehicle` (EV stopped), `unplugged`, `fault`, `sleep`, `command`.
Servers SHOULD dedupe on `start_ts`.

## agent/cmd and agent/ack — acknowledged commands

Cloud publishes to `agent/cmd`:

```json
{ "v": 1, "id": "01J8QZ3M9PXW", "op": "override.set",
  "args": { "state": "disabled", "charge_current": 16 },
  "exp_ts": 1787700120 }
```

- `id` — unique per command; the device remembers recent ids and re-acks
  duplicates without re-executing (QoS 1 redelivery safety).
- `exp_ts` — the device MUST discard commands received after this time
  (a broker replaying a stale command must not toggle a charger at 3 AM).
- `op` — namespaced verbs. Initial set: `override.set`, `override.clear`,
  `config.get`, `ping`. Extensible; unknown ops are acked with `ok: false,
  code: "unsupported"`.

Device answers on `agent/ack`:

```json
{ "v": 1, "id": "01J8QZ3M9PXW", "ok": true, "ts": 1787700061,
  "result": { "state": "disabled" } }
{ "v": 1, "id": "01J8QZ3M9PXW", "ok": false, "code": "expired" }
```

## Provisioning (draft)

Out of scope for the MQTT wire format — chargers are provisioned over the
LAN (the claim flow: an authenticated phone obtains credentials from the
server and hands them to the charger via its local HTTP API). A future
revision specifies the agent's local endpoint for accepting
`{endpoint, cert, key|csr, tenant, thing}` as one transaction, and
device-generated CSRs so private keys never leave the charger.

## Legacy device compatibility

Servers implementing this protocol SHOULD also ingest unmodified OpenEVSE
firmware: retained per-key publishes (`<base>/state`, `<base>/vehicle`,
`<base>/session_energy`, …) and the firmware's hardcoded
`openevse/announce/<id>` topic for presence. A device is agent-equipped iff
it has published `agent/presence`; servers prefer the agent surface and MAY
ignore the per-key topics from such devices to avoid double-processing.

