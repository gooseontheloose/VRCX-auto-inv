# Changelog

All notable changes to PAW Inviter - VRCX, newest first. Each release lists the fork's own changes (Added / Changed / Fixed) and, separately, what came in from [upstream VRCX](https://github.com/vrcx-team/VRCX).

Downloads: [GitHub Releases](https://github.com/gooseontheloose/VRCX-auto-inv/releases)

---

## [2.3.0](https://github.com/gooseontheloose/VRCX-auto-inv/releases/tag/v2.3.0) - 2026-09-29

A big one. It pulls in about three months of VRCX updates, Group Monitor and its webhooks now run in the background, and PAW Inviter updates itself from now on.

### Heads up
- **Updates now install automatically.** The first time you open 2.3.0, your update setting is switched to **Auto install** once, whatever it was before. New versions download in the background and install the next time you start PAW Inviter.
- **You can switch it back.** Go to **Settings → System → VRCX Updater → Update Action** and pick Off, Notify or Auto install. It only gets switched once, so whatever you pick after that stays.
- **2.3.0 itself still arrives the old way.** Your old setting decides how you get this version: Notify shows a message, and Off means you download it yourself.
- **Group Monitor webhooks moved to your account.** They now start when you log in. The first account that logs in to 2.3.0 takes over your old webhooks, which stops them posting twice. Each webhook now belongs to one group, and you can change that group on its card in the Webhooks page.
- **Missing audit-log history gets filled in slowly.** On first start, Group Monitor looks for gaps in your saved audit logs and fetches them in the background, a few requests a minute. VRChat doesn't keep audit logs forever, so very old gaps may not be recoverable.

### Added
- **Group Monitor runs in the background.** Webhooks, crash alerts and audit-log checks start when you log in. You no longer need the Group Monitor tab open, and opening several of its pages no longer starts extra copies.
- **Live audit events webhook:** posts each new kick, ban, warning, join/leave or role change to Discord as it happens, with filters for which kinds to post. After PAW Inviter has been closed for a while it posts at most 20 catch-up events plus a "+N more" summary.
- **Reliable webhook delivery:**
  - Every post goes through one saved queue, so the same event is never posted twice, even across restarts.
  - Discord rate limits are respected.
  - Failed posts retry later. After a network drop or sleep they go out once you're back online.
  - Posts for one webhook always arrive in order.
- **Webhooks page status:** service status and last check, plus per webhook the last success, last error and queued posts. There's a **Test** button and a delivery log.
- **Per-group settings:** "watch audit log" and crash-alert settings for each group are saved.
- **AIRI actions (opt-in, off by default).** If you use the AIRI companion, a second switch lets it send and accept VRChat friend requests for you. It is limited to:
  - 10 sent requests an hour and 30 a day, and 1 per person a day.
  - An accepts-per-hour limit you choose (30/60/90/120, default 60).
  - Local programs that have the token stored in `%AppData%\VRCX\paw-airi-token.txt`.
- **AIRI lookups without the per-session caps.** Bios and groups for people in your instance are looked up through a paced queue. Results are saved in a cache that lasts across restarts. The old 100/150-per-session limits are gone.
- **New AIRI endpoints:** `/paw/player` looks up one player right away, and `/paw/friend-requests` lists your incoming friend requests.

### Changed
- Auto-update is the default. See **Heads up** above.
- Updates now use PAW Inviter's own file names (`PAWInviter_update.exe`), so this version won't run a VRCX update file, or one from a copy running from another folder, by mistake.
- Background audit-log checks no longer show error pop-ups every minute when VRChat or your network is down. Problems show on the Webhooks page instead.
- Scheduled leaderboard posts use the webhook's own group and full history. They are no longer affected by which page is open or how its table is sorted. A missed slot posts once, not several times.
- Group Monitor is now set up separately for each account. Groups you have history for are checked for every account that can see their audit log, and each account remembers its last viewed group.
- Any VRChat rate limit anywhere in the app now makes AIRI lookups, AIRI friend actions and the auto-inviter all back off together.

### Fixed
- **Group Monitor missed days of audit log.** Each restart only fetched the newest 100 entries and then treated the history as complete, which left permanent holes (whole days with no join requests, kicks or leaves). It now fills gaps back to the last saved entry, and a one-time repair also fills holes left by older versions.
- Groups stuck at "fully loaded" with far fewer entries than VRChat has now carry on loading their history.
- Top Worlds showed times 1000× too long.
- Vote-kicks were sometimes counted against the wrong instance.
- The Crash Detection page stayed empty until you clicked refresh.
- Crash alerts:
  - Re-alerted every minute.
  - Used the wrong time window.
  - Counted you leaving an instance yourself as a crash.
  - Sent one copy per open page.
- The Members chart and day-of-week breakdown were shifted by a day in US time zones.
- More audit event types now have proper labels. Group removals now count as kicks unless the person left themselves or was banned.
- Wrong "No audit-log permission" error right after login.
- AIRI bios came through empty after VRChat changed its API. They're read from the public profile now.
- AIRI background lookups no longer pop up an error for private or deleted profiles.
- AIRI no longer loses friend state when VRChat is slow to confirm an accept.
- **Updating keeps your data.** The browser engine upgrade in this release (CEF 148 → 150) hit a bug in upstream VRCX's version check, which treated it as a downgrade and would have wiped logins, local storage and the Group Monitor cache. This was caught and fixed before release.

### From upstream VRCX
Merged 213 upstream commits, up to VRCX 2026.09.16 (28 Sep 2026):
- **Profiles:**
  - New user profile design, and you can edit your own profile.
  - Profile themes and backgrounds, icon frames, profile effects and nameplate effects, each with its own on/off switch.
- **Groups:**
  - Create, edit and transfer groups.
  - Create and edit group events, including repeating events.
  - Group instance announcements.
  - Group dialog timers and join count.
- **Social:**
  - Option to auto-decline spam friend requests (off by default).
  - Bulk unmoderate.
  - Favourite prints.
  - Search in local favourites.
  - Ctrl+C copies external links, and there's a copy-ID button.
- **UI:**
  - "Image Manager" is now "Inventory", with a filter.
  - A current instance card.
  - Redesigned world and avatar dialogs.
  - Scrolling tabs.
  - Search page size.
- VRC credits update automatically, and profiles load faster from a cache.
- About 60 fixes, including the avatar feed, game log deletes and slow session search, friend search, the VRC+ badge, bio links in the player list and notification fetching.
- Updated for VRChat API changes. Search by bio is gone because VRChat removed it.
- Browser engine updated (CefSharp 148 → 150).
- Translation updates (Chinese, Japanese, Thai, Hungarian and more).

---

## [2.2.0](https://github.com/gooseontheloose/VRCX-auto-inv/releases/tag/v2.2.0) - 2026-09-28

### Added
- **AIRI Integration page (opt-in, off by default).** It lets an AI companion running on your own PC (AIRI) see who is in your current instance.
  - It works through a small local API: `/paw/players` and `/paw/status` on `127.0.0.1:34582`.
  - Only programs on your own PC can use it. Web pages and other devices are refused.
  - **Share bios** switch: bios are cleaned first. Links, social handles, Discord tags, emails and phone numbers are removed, and each bio is cut to 200 characters.
  - **Groups** switch: shares the group each player is representing. These lookups are slow and limited.
  - The page shows a live preview of exactly what is shared, plus request stats.

### Fixed
- The AIRI API also checks the Host header, so a website can't sneak in by pointing its own domain at your PC.
- AIRI now loads the full profile for players whose bio wasn't loaded yet (paced, and limited per session).

### From upstream VRCX
- No upstream changes in this release.

---

## [2.1.4](https://github.com/gooseontheloose/VRCX-auto-inv/releases/tag/v2.1.4) - 2026-07-01

### Added
- **Username Checker:** taken names are now clickable when the account is known. Clicking opens that VRChat profile in your browser, which is handy if you want to ask VRChat to free up an inactive name.
- **Username Checker:** an **"old visitor"** badge on taken names held by an old Visitor-rank account with no trust rank. These names may be claimable.

### From upstream VRCX
- No upstream changes in this release.

---

## [2.1.3](https://github.com/gooseontheloose/VRCX-auto-inv/releases/tag/v2.1.3) - 2026-07-01

### Fixed
- **Username Checker** missed names held by old or visitor accounts, because VRChat ranks those low in search. It now checks the top 10 search results instead of only the first.

### From upstream VRCX
- No upstream changes in this release.

---

## [2.1.2](https://github.com/gooseontheloose/VRCX-auto-inv/releases/tag/v2.1.2) - 2026-07-01

### Changed
- **Username Checker double-check** now also verifies names that look **available**. It checks VRCX's own list of known users and looks up the profile directly, which catches banned or hidden accounts that don't show in search but still hold the name.
- **Username Checker:** removed the faster "Normal" speed. Only "Careful" (about 55 checks a minute) is left, to avoid rate limits.

### From upstream VRCX
- No upstream changes in this release.

---

## [2.1.1](https://github.com/gooseontheloose/VRCX-auto-inv/releases/tag/v2.1.1) - 2026-07-01

### Added
- **Debug Logs page:** open a VRChat log file (`.log` / `.txt`) and read through it with search and a session summary. You can also save a copy before VRChat deletes it.
- **Group Monitor:** Top Warners / Most Warned leaderboards on the Crash Detection page.
- **Webhooks:** new "Top Warners" and "Most Warned" webhook types.

### Changed
- The Group Monitor group list only shows groups whose audit log you can view. Groups you've lost access to are marked **(cached – no access)**.

### Fixed
- Webhook settings were lost when the app restarted. They're saved in the app's database now.

### From upstream VRCX
- No upstream changes in this release.

---

## [2.1.0](https://github.com/gooseontheloose/VRCX-auto-inv/releases/tag/v2.1.0) - 2026-06-30

### Added
- **Group Monitor**, a new sidebar section for groups where you can view the audit log. It has five pages:
  - **Overview:** instance kicks, ban board, instance warns, vote-to-kick history and your group's top worlds, as leaderboards (who kicks or bans the most, who gets kicked or banned the most).
  - **Audit Log:** the full group audit log with search, a type filter and date range. Names are filled in for actors and targets, and it's saved locally so it loads fast next time.
  - **Group Members:**
    - Live member stats.
    - A members-over-time chart (30 days up to all time).
    - Retention and churn, and a day-of-week breakdown.
    - "Best time to invite" heatmaps.
    - An invite leaderboard with conversion rates.
  - **Crash Detection:** spots likely instance crashes when lots of people leave at once.
  - **Webhooks:** posts to Discord on a schedule. Types:
    - Top Kickers, Most Kicked, Top Banners, Most Banned.
    - Top Snitches, Most Vote-Kicked, Top Inviters.
    - Crash Alerts.

### From upstream VRCX
- No upstream changes in this release.

---

## [2.0.1](https://github.com/gooseontheloose/VRCX-auto-inv/releases/tag/v2.0.1) - 2026-06-29

### Added
- **Username Checker page:** check whether VRChat display names are free. It has three tabs:
  - **Generate:** makes random names, with an optional prefix and suffix, including word-like patterns.
  - **Dictionary:** load any `.txt` word list, filter by length and pick a random sample.
  - **List:** paste your own names.
- **Username Checker:** stops by itself and shows a banner if VRChat rate-limits you.
- **Username Checker double-check:** "taken" results are verified with a profile lookup to avoid false positives. Verified results get a shield icon.
- **Username Checker log:** a full log with filters and sorting, CSV export and copy-all. It's kept between sessions.
- **Installer:** `PAWInviter_X.Y.Z_Setup.exe` installs PAW Inviter with its own name, Start Menu shortcuts and uninstall entry. A portable zip is still offered.

### Fixed
- **Auto-update now works.**
  - Versions are compared properly (2.0.10 counts as newer than 2.0.9).
  - Updates published on GitHub are recognised.
  - The "What's new" dialog shows after an update.
- The installer and uninstaller are fully branded "PAW Inviter - VRCX".

### From upstream VRCX
Merged upstream fixes up to 28 June 2026:
- Discord Rich Presence can show custom instance names.
- VRC+ world favourite groups show in the user dialog.
- Fixed:
  - Updating saved memos.
  - The group member moderation dialog, and group moderation actions.
  - Group notification titles.
  - Long dialog names.
  - Scrolling in the set avatar tags dialog.
  - The OnPlayerJoining wrist feed filter.
  - The VR overlay border, and an SQLite error.
  - A database migration race condition.
  - Game log search not coming back after switching tabs.
  - Doubled delete-log buttons.
  - Some table issues.

---

## [2.0.0](https://github.com/gooseontheloose/VRCX-auto-inv/releases/tag/v2.0.0) - 2026-06-06

The first release under the PAW Inviter name, and the first one that updates from this GitHub repo.

### Added
- **18+ Only switch for the Auto-Inviter:** only auto-invite players who are age-verified.
- **Slower speed presets** for mass invites: Very Slow (20s), Glacial (30s), Painful (45s) and Absurd (60s).

### Changed
- Renamed the app to **PAW Inviter - VRCX**, with new app icons.
- **Updates come from this repo's GitHub releases**, not VRCX's servers. The default update setting is **Notify**.
- **Self-contained build:** no separate .NET runtime install needed.
- The rate-limit cooldown went from 10 minutes to **1 hour**, to stay clear of VRChat limits.
- The invite activity log always shows the last 250 entries. The size dropdown was removed.

### Fixed
- Black screen when joining an instance.

### From upstream VRCX
Merged upstream VRCX up to 30 May 2026, which includes VRCX 2026.05.03:
- A more compact Friends card and a reworked location action bar.
- Drag & drop upload for prints, stickers, emojis, photos and icons.
- Hot worlds and the notifications tab are back.
- A better activity tab, and group event "starting" notifications, including repeating events.
- Fixed:
  - Auto-login spam.
  - Auto invite.
  - Dashboard editing.
  - Game/friend log panel loading.
  - Favourite counters and refresh.
  - Pasting into quick search.
- Japanese and Hungarian translation updates.

---

## [1.0.0](https://github.com/gooseontheloose/VRCX-auto-inv/releases/tag/v1.0.0) - 2026-04-12 (build date; published 2026-06-06)

The first build of the fork, from April 2026, when it was still called "VRCX custom". It added the Group Invite Toolkit to the Player List page.

### Added
- **Group Invite Toolkit** on the Player List page:
  - Pick one of your groups that you're allowed to invite to.
  - **Mass invite everyone in your instance** to that group, with an **All** button and an **18+ Only** button.
  - **Invite friends to your instance:** Online friends only, or Online + Active.
- **Auto-Inviter:** automatically sends a group invite to each new player who joins your instance.
  - You choose a pickup delay (Instant, 5s, 10s, 15s or 30s).
  - The status shows Running / Offline / Paused.
- **Speed presets** for mass invites: Normal (4s), Relaxed (6s), Cautious (8s), Slow (10s) and Stealth (15s).
- **Invite cache:** people you already invited aren't invited again. **Clear Cache** resets it.
- **Blacklist:** people on it are never invited.
- **Rate-limit protection:** a batch stops after 3 rate-limit strikes, and the auto-inviter pauses for a 10-minute cooldown.
- **Recent Activity log** for every invite: sent, skipped or failed.
- **Sidebar:** a Switch Account menu and a light/dark theme button.

### From upstream VRCX
- Built on VRCX 2026.02.11 plus upstream changes up to 12 April 2026.
