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

Notification kinds: `started | finished | problem`. Missing keys mean
enabled. (legacy `plug|charge|fault|presence` keys are still accepted)

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
{
  "plan": "paid",
  "chargers": [{
    "name": "openevse-2760",
    "label": "Garage",
    "state": 3,
    "vehicle": 1,
    "sessionWh": 5230,
    "chargingStartedAt": 1787700000000,
    "elapsedS": 1234,
    "online": true,
    "offlineAt": null,
    "updatedAt": 1787700030000,
    "amps": 24.1,
    "volts": 242.0,
    "watts": 5834,
    "pilotA": 32,
    "tempC": 41.2,
    "rssi": -61,
    "fw": "5.1.2",
    "ip": "10.75.1.157",
    "uptimeS": 86400,
    "agent": false,
    "override": { "state": "active", "chargeCurrent": 32, "autoRelease": true },
    "limit": null,
    "schedule": [ { "id": 1, "state": "active", "time": "06:00:00", "days": ["monday"] } ],
    "cfg": { "maxCurrentSoft": 32, "minCurrentHard": 6, "maxCurrentHard": 48, "divertEnabled": false },
    "controlAt": 1787700025000
  }]
}
```

`state` uses the OpenEVSE-style RAPI codes (the reference hardware): 1 ready, 2 connected, 3 charging,
4–11 faults, 254 sleeping, 255 disabled.

`label` is the operator's display name for the charger, set at claim time
(`POST /claim`'s optional `label`, or `PATCH /chargers/{name}` afterwards). It
is `null` — or absent, on an older server — when the charger was claimed
without one. Servers MUST NOT substitute `name`, which is the MQTT client id:
what to show when there is no label is the client's decision.

- `plan` — the caller's tenant plan, `"free"` or `"paid"`. Gates `POST
  /command`, below.
- `amps` / `volts` / `watts` — instantaneous power telemetry.
- `pilotA` — the pilot signal's advertised current limit, distinct from
  `amps` (what is actually flowing).
- `tempC` — the charger's internal temperature.
- `rssi` — Wi-Fi signal strength, dBm.
- `fw` — the charger's firmware version.
- `ip` — the charger's LAN address.
- `uptimeS` — seconds since the charger last booted.
- `agent` — whether the charger runs the evse-cloud-agent firmware
  component; its version is not exposed here.
- `override` — the current manual override mirrored from the charger's
  retained `override` document (`state: "active"|"disabled"|null`,
  `chargeCurrent`, `autoRelease`); `null` = automatic, none set.
- `limit` — the stop-after-this-much limit on the current run
  (`{type, value, autoRelease}`); `null` = none set.
- `schedule` — the charger's weekly schedule, an array of `{id, state, time,
  days}`; `null` while the mirror hasn't seen one.
- `cfg` — the charger's mirrored configuration (`maxCurrentSoft`,
  `minCurrentHard`, `maxCurrentHard`, `divertEnabled`, `chargeMode`,
  `shaperEnabled`, `version`, `firmware`, `hostname`, `timeZone`,
  `pauseUsesDisabled`), each field present only when known.
- `controlAt` — epoch ms of the last mirror write to any of `override`,
  `limit`, `schedule`, `cfg`; use it to tell whether a just-sent command has
  been confirmed yet.

`override`, `limit`, `schedule`, `cfg` and `controlAt` are `null` (or absent)
until the charger's own retained control documents have been mirrored at
least once; a fresh deploy or a charger that has never republished shows them
as unknown, never as a default. `plan` is always `"free"` or `"paid"`, never
null, and the telemetry fields (`amps`/`volts`/`watts`/`pilotA`/`tempC`/
`rssi`/`fw`/`ip`/`uptimeS`) come from the separate telemetry ingest and are
populated independently of the control mirror. Existing fields are
unchanged, and older clients ignore what they do not know.

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

`wh` is the charger's session-energy counter at the end of the run; it
counts from plug-in, so the runs of one visit carry a running total. A row
may carry `"unplugged": true` meaning the car was unplugged after it: the
visit boundary for grouping runs.

## POST /activity

iOS Live Activity (ActivityKit) token registration. Three shapes:

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

```json
{ "startToken": "<hex>", "remove": true }
```

forgets the push-to-start token (the phone turned Live Activities off). The
server answers `200 {"ok":true}` whether or not the row existed.

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

## PATCH /chargers/{name}

Renames a charger. Body `{ "label": "Garage" }`, at most 40 characters
(`400 {"error":"bad label"}` otherwise); an empty string clears it. The route
takes no `tenantId` — the charger must be in the caller's home tenant;
anything else is `404 {"error":"no such charger"}`, the same
anti-enumeration answer as `POST /claim` for a name the caller cannot see —
never `403`, so a guess can't be told apart from a real charger belonging to
someone else. `200 { "ok": true, "name": "openevse-2760", "label": "Garage"
| null }`.

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

## POST /command

Remote charger control: start or pause charging, set a stop limit, edit the
schedule, flip solar-divert mode, change the default max current, or restart.
Requires a signed-in caller, same as `/claim`; the flat registration token
gets `403 {"error":"sign in to control chargers"}`.

```json
{ "charger": "openevse-2760", "action": "charge", "value": 32,
  "tenantId": "optional — another household the caller administers" }
```

`tenantId` defaults to the caller's home tenant, exactly as `/claim`. The
action allowlist:

| action | value | publishes |
| --- | --- | --- |
| `charge` | optional integer amps | `override/set` `{state:"active", charge_current: A or "clear", max_current:"clear", auto_release:true}` |
| `pause` | — | `override/set` `{state:"disabled", charge_current:"clear", max_current:"clear", auto_release:true}` |
| `release` | — | `override/set` `clear` |
| `limit` | `{type:"energy"\|"time", value:int, autoRelease?:bool}` | `limit/set` `{type, value, auto_release}` (default `true`) |
| `limitClear` | — | `limit/set` `clear` |
| `schedule` | `{id?:int, state:"active"\|"disabled", time:"HH:MM:SS", days:string[]}` | `schedule/set` with the same object; a missing `id` is assigned server-side as `max(existing ids)+1` (or `1`) from the mirrored schedule |
| `scheduleClear` | integer id | `schedule/clear` with the id as the payload |
| `divert` | `1` (normal) or `2` (eco) | `divertmode/set` |
| `maxCurrent` | integer amps | `config/set` `{max_current_soft: A}` |
| `restart` | — | `restart` `{"device":"gateway"}` |

Anything else is `400 {"error":"bad action"}` / `{"error":"bad value"}`. Amps
are integers clamped to `[cfg.minCurrentHard ?? 6, cfg.maxCurrentHard ?? 48]`
from the mirrored config — servers MUST clamp rather than reject an
out-of-range value, and the response reports the value actually sent (`200 {
"ok": true, "charger": "openevse-2760", "action": "charge", "value": 32 }`).
`limit.value` must be a positive integer ≤ 100000 (Wh or minutes). Schedule
`days` are lowercase English day names; `time` must match `^\d{2}:\d{2}:\d{2}$`.

Other refusals:

| status | error | meaning |
| --- | --- | --- |
| `400` | `bad JSON` | the request body did not parse as JSON |
| `400` | `bad action` | not one of the actions above |
| `400` | `bad value` | `value` doesn't fit the action's shape |
| `403` | `sign in to control chargers` | caller presented the flat bundle token, not a signed-in identity |
| `404` | `no such charger` | the charger doesn't exist under the resolved tenant, is a tombstone, or the caller may not act on that tenant |
| `402` | `remote control needs the paid plan` | the tenant's plan is `free` — servers MUST refuse remote control on free plans with this status and word |
| `409` | `charger offline` | the charger's item says `online: false`; a QoS-1, non-retained publish to an absent charger is a message lost |
| `502` | `publish failed` | the broker publish itself failed; the command never reached the charger |

The response is not confirmation the charger obeyed — only that the command
was published. The charger confirms by republishing its retained control
documents (`override`, `limit`, `schedule`, `config`), which the server
mirrors; read the result back from `GET /status`'s `override`, `limit`,
`schedule` and `cfg` fields. Clients SHOULD poll `/status` every few seconds
for up to ~20 s after a command and treat "no change yet" as pending, not
failed.

---

# Device agent (charger ↔ cloud, MQTT)

The wire format for a charger-side cloud agent — a firmware component that
publishes structured, versioned documents instead of the stock firmware's
one-topic-per-key surface. Design goals, in order: **atomic state** (one
document = one server ingest, no cross-topic races), **explicit versioning**,
**clean presence** (no reliance on legacy announce topics), and **acknowledged
commands**.

## Live socket

`wss://<live host>?token=<Cognito ID token>` (Overwatt: `wss://live.overwatt.app`).
The server verifies the token on connect; an invalid one refuses the upgrade.

Client → server, JSON objects:

| Message | Meaning |
|---|---|
| `{"subscribe": ["openevse-2760"], "lease": true}` | Watch these chargers. `lease` (default false) asks the cloud to hold a live lease on each while this socket stays subscribed. Re-sending renews. |
| `{"unsubscribe": ["openevse-2760"]}` | Stop watching. |

Server → client:

| Message | Meaning |
|---|---|
| `{"charger": "…", "snapshot": <charger>}` | Once per subscribed name, straight after `subscribe`. |
| `{"charger": "…", "event": <charger>}` | Full replacement after a state, vehicle, presence or control change. |
| `{"charger": "…", "tick": {…}}` | Merge patch (a subset of charger fields plus `updatedAt`) on telemetry. |
| `{"error": "unknown charger", "charger": "…"}` | Name not in the caller's household. |

`<charger>` is one `GET /status` element plus `elapsedS` (seconds since
`chargingStartedAt` while state is 3, else null). Disconnecting releases every
subscription and lease. Clients reconnect with 1 s, 2 s, 5 s, 15 s backoff and
fall back to `GET /status` polling after 15 s without a socket.

## Transport

- A charger's cloud connection is the agent's **own** MQTT(S) client speaking
  this contract and nothing else: no legacy per-key topics, no announce topic,
  no RAPI. (Before 0.5.0 this section said the agent shared the charger's single
  connection. A charger may still run a second, separate client against a local
  broker in the legacy format; the two never mix, and only this one reaches the
  cloud.)
- All topics live under the **device root** `d/<thing>/`, where `<thing>` is the
  charger's thing name. No tenant appears on the wire: the server resolves thing
  → tenant on ingest, so moving a charger between households never touches the
  device.
- The **topic per publish** is the host's choice, not the core's — the device
  agent always publishes by suffix. `agent/control` and `agent/presence` always
  go out on the ordinary retained topic, `d/<thing>/agent/<suffix>`.
  `agent/status` publishes its connect-time document there too, retained; every
  later status, and every `agent/session` document, instead goes out through
  **Basic Ingest** — `$aws/rules/agent_status/d/<thing>/agent/status` or
  `$aws/rules/agent_session/d/<thing>/agent/session` — which never reaches the
  broker: no retention, no MQTT subscriber, rule charge only (see
  `agent/status` and `agent/session` below). `agent/cmd`, `agent/ack` and
  `lease/set` are unaffected by the split.

| Topic (suffix) | Direction | QoS | Retained |
|---|---|---|---|
| `agent/status` | device → cloud | 1 | connect only (see above) |
| `agent/control` | device → cloud | 1 | yes |
| `agent/presence` | device → cloud (+ LWT) | 1 | yes |
| `agent/session` | device → cloud | 1 | no |
| `agent/cmd` | cloud → device | 1 | no |
| `agent/ack` | device → cloud | 1 | no |
| `lease/set` | cloud → device | 1 | no |

- All payloads are JSON objects carrying `"v": 1`. Receivers MUST ignore
  unknown fields (additive evolution); a breaking change bumps `v`, and a
  device advertises the version it speaks in `agent/presence`.

## agent/status — the consolidated state document

Published on three triggers and no others: on connect; immediately (debounced
~1 s) when `state`, `vehicle` or a flag changes; and every `interval_s` — the
heartbeat, default 60, whose timer any status publish resets — or, while a
lease is held (see `lease/set`), every `tick_s` instead.

Only the connect-time publish is retained, on the ordinary topic
`d/<thing>/agent/status` (see Transport): the broker holds that one as a
last-known snapshot, so a reconnecting server needs no baseline seeding. Every
later publish — event, heartbeat or leased tick — goes out through **Basic
Ingest** instead, `$aws/rules/agent_status/d/<thing>/agent/status`, which never
reaches the broker: not retained, no MQTT subscriber, rule charge only. A
server that wants live status subscribes to the ingest side effect (the row
`agent-ingest.ts` writes), not the MQTT topic.

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
  (`manual_override`, `divert_active`, `limit_active`, `local_mqtt_disabled`
  — the chip's heap rule stopped the charger's local publisher — …).

## agent/control — the control mirror

Retained. Published on connect and, debounced ~1 s, whenever the charger's
manual override, limit, schedule or configuration changes — including an
`auto_release` that clears an override on the charger's own initiative.

It is **complete, never a patch**: all four keys are present in every document,
so a consumer replaces its whole control mirror from one message. `null` means
none set; an empty `schedule` array means no events; keys inside `config` are
present only when the charger knows them.

```json
{
  "v": 1, "ts": 1787700030,
  "override": { "state": "active", "charge_current": 24, "auto_release": true },
  "limit": { "type": "energy", "value": 10000, "auto_release": true },
  "schedule": [ { "id": 1, "state": "active", "time": "23:30:00", "days": ["monday", "friday"] } ],
  "config": { "max_current_soft": 32, "min_current_hard": 6, "max_current_hard": 48,
    "divert_enabled": false, "charge_mode": "fast", "current_shaper_enabled": false,
    "version": "5.1.2", "firmware": "8.2.0", "hostname": "garage",
    "time_zone": "America/Vancouver", "pause_uses_disabled": true }
}
```

- `override.state` — `active`, `disabled`, or the whole object `null`.
- `limit.type` — `energy` (Wh), `time` (s), `soc` (%) or `range` (km).
- `schedule[].days` — lower-case day names, Sunday first.
- One retained document replaces the ~40 retained per-key topics a legacy
  charger publishes, which is most of why an agent-equipped charger costs two
  orders of magnitude fewer messages a day.
- Always the ordinary retained topic, `d/<thing>/agent/control` — never Basic
  Ingest (see Transport).

## agent/presence — birth and last will

Retained. Published on connect; the connection's LWT is the same topic with
`online: false`, so ungraceful death flips presence without any server-side
lifecycle integration (servers on brokers WITH lifecycle events, e.g. AWS
IoT, MAY use those instead and treat this topic as corroboration).

```json
{ "v": 1, "online": true,  "ts": 1787700000,
  "fw": "5.1.2", "agent": "0.2.0", "proto": 1, "ip": "10.75.1.157" }
{ "v": 1, "online": false }
```

Always the ordinary retained topic, `d/<thing>/agent/presence` — never Basic
Ingest (see Transport).

## agent/session — completed charging runs

Published (not retained) once per run, when the charger leaves the charging
state, through Basic Ingest — `$aws/rules/agent_session/d/<thing>/agent/session`
(see Transport), which never reaches the broker. Device-side session records
beat server-reconstructed ones: they survive server downtime and carry exact
boundaries.

```json
{ "v": 1, "start_ts": 1787695000, "end_ts": 1787702200,
  "wh": 8500, "reason": "vehicle", "unplugged": false }
```

`reason`: `vehicle` (EV stopped), `unplugged`, `fault`, `sleep`, `command`.
`unplugged` (added in 0.5.0) is true when the vehicle was disconnected at the
moment the run ended; it is independent of `reason`, since a command may stop a
run whose car had already gone. Servers SHOULD dedupe on `start_ts`, and where
the device said `unplugged` they SHOULD prefer it to any unplug debounce of
their own.

## lease/set — the cloud raises the status cadence

Not retained. The cloud publishes a lease while somebody is watching a charger
— a phone with a live subscription, or a Live Activity on a lock screen — and
renews it while under 60 s remain.

```json
{ "v": 1, "until": 1787700150, "tick_s": 3 }
```

- `until` — epoch seconds; `tick_s` — the status cadence while it is valid
  (3 for a phone watching, 15 for a Live Activity alone). `tick_s` MUST be
  1..60; a device ignores a lease outside that range outright — the document
  is dropped and any lease already running is left untouched.
- The device **never renews, never acknowledges and never publishes anything
  about a lease.** When `until` passes unrenewed it falls back to the
  `interval_s` heartbeat. A lease arriving while one runs replaces it, `tick_s`
  included.
- A device MUST cap any lease at **120 s of its own monotonic time**, measured
  from receipt: a cold-booted charger may have no clock at all, in which case
  `until` is unusable and that cap is the whole lease. A lease whose `until` has
  already passed by the device's own clock ends any lease running.

## agent/cmd and agent/ack — acknowledged commands

On an agent connection every remote command travels here; the legacy command
topics (`override/set`, `limit/set`, `schedule/set`, `schedule/clear`,
`divertmode/set`, `config/set`, `restart` under a legacy base topic) remain the
path for chargers without an agent.

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
- `op` — namespaced verbs. Unknown ops are acked with `ok: false, code:
  "unsupported"`.

| `op` | `args` | Effect |
|---|---|---|
| `override.set` | `{state: "active"\|"disabled", charge_current?}` | Force the EVSE on or off, optionally at a given current |
| `override.clear` | – | Drop the manual override |
| `limit.set` | `{type: "energy"\|"time"\|"soc"\|"range", value, auto_release?}` | Stop the run after this much; `auto_release` defaults to true |
| `limit.clear` | – | Drop the limit |
| `schedule.set` | `{id, state, time: "HH:MM:SS", days: [...]}` | Add or replace one weekly event |
| `schedule.clear` | `{id}` | Remove one weekly event |
| `divert.set` | `{mode: 1\|2}` | Solar divert mode |
| `config.set` | a config object, e.g. `{max_current_soft: 32}` | Write configuration keys |
| `restart` | – | Reboot the charger (acked first) |
| `ping` | – | Liveness check |

An accepted command that moves control state is followed by a fresh
`agent/control` document, so a consumer never has to guess whether a command
landed.

`config.set`'s `args` face a device-side size ceiling: the reference
implementation re-serialises them into a 256-byte buffer (254 usable) before
writing configuration, and acks `bad_args` for anything larger without
touching the firmware. This spec's own eleven-key `agent/control.config`
example above already serialises to 257 bytes, so a full echo-back does not
fit through that ceiling — send only the keys you mean to change.

Device answers on `agent/ack`, **one per command received** — except a whole
command payload too large for the device to parse at all, which is dropped
silently: there is no `id` yet to acknowledge with, so a sender MUST NOT
assume a missing ack means the command failed cleanly.

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

