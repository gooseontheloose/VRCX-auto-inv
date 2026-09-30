# Privacy: anonymous usage stats

Official PAW Inviter releases (from this repo's [Releases](https://github.com/gooseontheloose/VRCX-auto-inv/releases) page, 2.3.1 and newer) send a few anonymous usage stats, so we can see how many people use PAW Inviter, how long it stays open and which features are worth working on. This page lists everything that is sent.

If you build PAW Inviter yourself from this repo, none of this applies: your build uses a no-op stub, has no switch and sends nothing.

## How to turn it off

**Settings → System → Send anonymous usage stats.** Off takes effect at once: a ping in progress is cancelled, counts not sent yet are deleted, and nothing more is sent until you turn it back on.

## When it is sent

- once, a few seconds after PAW Inviter starts
- every 20 minutes while it is open
- once when you close it (best effort; if that one gets lost, it is sent the next time you start PAW Inviter)
- a ping that got no answer (offline, server down) is sent again later, unchanged

Nothing is sent while the switch is off.

## What is sent

Every ping is a small JSON message with exactly these fields, and nothing else:

| Field        | Example             | What it is                                                                                                                                                                                                                                                                                       |
| ------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `installId`  | `1b4e28ba-…`        | A random ID made on your PC the first time a ping is sent. It is not based on your account, hardware or anything else.                                                                                                                                                                           |
| `sessionId`  | `3f2a9c1e-…`        | A random ID for this run of the app, new every time you start it.                                                                                                                                                                                                                                |
| `event`      | `tick`              | `start`, `tick` (every 20 minutes) or `close`.                                                                                                                                                                                                                                                   |
| `seq`        | `3`                 | The ping's number within this run, so a ping that is sent again (no answer the first time) isn't counted twice.                                                                                                                                                                                  |
| `appVersion` | `2.3.1`             | PAW Inviter's version.                                                                                                                                                                                                                                                                           |
| `os`         | `windows`           | `windows`, `linux` or `macos`.                                                                                                                                                                                                                                                                   |
| `runtime`    | `cef`               | `cef` (Windows app) or `electron` (Linux/macOS app).                                                                                                                                                                                                                                             |
| `locale`     | `en`                | The language code of the app's UI language, never the region.                                                                                                                                                                                                                                    |
| `features`   |                     | On/off flags: Auto Inviter on (or turned on since the last ping), Group Monitor background checks, group webhooks, AIRI integration, AIRI actions, whether the Username Checker was ever used, and your update setting (Off / Notify / Auto Download).                                           |
| `counters`   | `"invitesSent": 12` | How many times each of these happened since the last ping: invites sent, Auto Inviter turned on, Group Monitor pages opened, webhook posts delivered, webhook posts failed, audit-log gaps filled, usernames checked, AIRI friend requests sent or accepted, VRChat crash rejoins. Numbers only. |

## What is never sent

- your VRChat account, username, display name or user ID
- anyone else's names or IDs: friends, people you invite, people in your instance
- worlds, instances, locations, groups or group IDs
- bios, notes, messages, invite text, usernames you check or anything else you type
- logs, file paths, your computer name or hardware details

Your IP address is not stored: the server uses it only in memory to limit how many pings one address can send, and never logs it or writes it to the database. Like any website, the hosting provider (Railway) briefly sees it in its own request logs.

## What happens to it

The server keeps:

- per install, one "latest state" row: the first and last day it was seen, and the app version, OS, runtime, language, feature flags and update setting from its latest ping
- per install, one row per day: time open, number of sessions, the counters added up, and the feature flags
- per app run, one row: its install ID, start, last ping, close and time open, plus the `seq` numbers already received (to drop re-sent pings)
- across everyone, a total of time open per hour, with no install ID (for a "busiest hours" chart)

Everything is deleted after **400 days** (or earlier on request, see below): daily rows, app runs and hourly totals 400 days after that day, and an install's "latest state" row 400 days after its last ping. Only Oliver (the PAW Inviter maintainer) can see the dashboard; nothing is sold or shared.

Anyone could send made-up pings to the server, so these numbers are treated as a trend, not as an exact count.

## See or delete your data

Nothing links the stats to your VRChat account, so we can only find them by your install ID:

1. **Settings → System → Copy my install ID** (next to the usage stats switch) copies it. If it says there is no ID yet, nothing has been sent from this PC.
2. If you want sending to stop too, turn the switch off first. Otherwise the next ping starts a new record under the same ID.
3. Send it **privately** through GitHub's private report form: [github.com/gooseontheloose/VRCX-auto-inv/security/advisories/new](https://github.com/gooseontheloose/VRCX-auto-inv/security/advisories/new) (title it "Data request"). Only you and the maintainer can see it. Include your install ID and whether you want a copy of the data, deletion, or both.

**Don't post your install ID in a public issue, Discord or anywhere else public.** It is the only key your stats are stored under: posting it links it to your account there, and anyone who knows it could send pings under it.

We then export everything stored under that ID (its latest-state row, daily rows and app runs) and send it to you if you asked, and delete all of it. The hourly "busiest hours" totals have no install ID in them and are not affected. Requests are handled by hand. The telemetry server's own logs never contain install IDs; the one request that exports or deletes your data carries the ID in its address, so it appears once in the hosting provider's (Railway's) request log, which only the maintainer can see.

The install ID is also the value of the key `config:vrcx_telemetryinstallid` in the `configs` table of `%AppData%\VRCX\VRCX.sqlite3`.
