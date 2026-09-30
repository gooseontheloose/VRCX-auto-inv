<div align="center">

# PAW Inviter - VRCX

**A modified fork of VRCX with group auto-invites, a Group Monitor with Discord webhooks, and more**

[![GitHub release](https://img.shields.io/github/release/gooseontheloose/VRCX-auto-inv.svg)](https://github.com/gooseontheloose/VRCX-auto-inv/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/gooseontheloose/VRCX-auto-inv/total?color=6451f1)](https://github.com/gooseontheloose/VRCX-auto-inv/releases/latest)
[![Discord](https://img.shields.io/discord/854071236363550763?color=%237289DA&logo=discord&logoColor=white&label=discord)](https://vrcx.app/discord)

| **English** | [Français](./README/README.fr.md) | [日本語](./README/README.jp.md) | [简体中文](./README/README.zh_CN.md) | [Italiano](./README/README.it.md) | [Русский](./README/README.ru_RU.md) | [Español](./README/README.es.md) | [Polski](./README/README.pl.md) | [ภาษาไทย](./README/README.th.md) | [Magyar](./README/README.hu.md)

This is a **custom fork** of [VRCX](https://github.com/vrcx-team/VRCX) — the VRChat assistant/companion application — with added features for running VRChat groups: automated invites, audit-log monitoring and Discord webhooks. It stays in sync with upstream VRCX (currently based on VRCX 2026.09.16).

</div>

<div align="center">

<div align="center">

## What's Different in This Fork

<div align="left">

- **Group Invite Toolkit & Auto-Inviter** (Player List page)
  - Mass invite everyone in your instance to one of your groups: everyone, or 18+ verified players only.
  - Invite your online (or online + active) friends to your current instance.
  - The Auto-Inviter sends a group invite to each new player who joins your instance, with a pickup delay and an optional **18+ Only** switch.
  - Speed presets run from Normal (4s) to Absurd (60s) between invites.
  - An invite cache means nobody is invited twice, and a blacklist covers people you never want to invite.
  - Rate-limit protection pauses the Auto-Inviter for a 1 hour cooldown.
  - An activity log shows the last 250 invites.
- **Group Monitor** (for groups where you can view the audit log)
  - **Overview:** kick, ban, warn and vote-to-kick leaderboards, plus your group's top worlds.
  - **Audit Log:** the full audit log with search and filters, saved locally, with missing days filled in automatically.
  - **Group Members:** a members-over-time chart, retention and churn, "best time to invite" heatmaps and an invite leaderboard.
  - **Crash Detection:** spots mass leaves that look like instance crashes.
- **Discord Webhooks** run in the background from login, whether or not the Group Monitor tab is open.
  - Scheduled leaderboards: top kickers, bans, warns, inviters, vote-kicks and more.
  - Crash alerts.
  - A live feed of audit events: kicks, bans, warnings, joins and leaves, role changes.
  - One delivery queue with retries, Discord rate-limit handling and no duplicate posts.
  - Per-webhook status, a Test button and a delivery log.
- **Username Checker:** check whether VRChat display names are free, from generated names, a dictionary `.txt` file or your own list.
  - A double-check catches hidden or banned accounts.
  - An "old visitor" badge marks names held by old, unused accounts.
  - Results can be exported to CSV.
- **Debug Logs:** open and search VRChat log files, and save a copy before VRChat deletes them.
- **AIRI Integration** (opt-in, off by default): a local-only API that lets an AI companion on your PC (AIRI) see who is in your instance.
  - Bios are shared cleaned. Group lookups are paced.
  - A second opt-in switch lets AIRI send and accept friend requests, within hourly and daily limits.
  - A third opt-in switch lets AIRI boop friends back, send and answer invites, set your status and write private notes. Each action has its own switch (all off by default), a dry-run mode and its own limits.
- **Switch Account** menu and a theme button in the sidebar.
- **Auto-Updates:** updates come from this GitHub repo. By default they download in the background and install the next time you start the app. You can change this under **Settings → System → VRCX Updater**.
- **Self-Contained Build:** no .NET runtime to install. Use the installer or the portable zip.

</div>

All original VRCX features remain intact. See below for the full feature list, and [CHANGELOG.md](./CHANGELOG.md) for what changed in each release.

</div>

# Getting Started

<div align="center">

Download the latest release from [here](https://github.com/gooseontheloose/VRCX-auto-inv/releases/latest):

**Installer:** run `PAWInviter_X.Y.Z_Setup.exe`. It sets everything up, and when you upgrade it replaces the old version and relaunches.

**Portable:** extract `PAWInviter_X.Y.Z.zip` anywhere and run `VRCX.exe`. No installation or .NET runtime is required.

Releases are built for Windows only. See [CHANGELOG.md](./CHANGELOG.md) for release notes.


</div>

# Features

<div align="left">

- :family: Friend, world, and avatar list management
  - Manage your friends list, world/group/avatar lists outside of VRChat.
  - Monitor the activity of your friends and track their online status, locations, and avatars.
  - Track friendship history including add dates, time spent together, and name changes.
  - Save notes and memos to help remember how you met.
- :bar_chart: Customizable Dashboard with widgets
  - Build personalized multi-panel layouts with Feed, GameLog, and Instance widgets.
  - Create multiple dashboards, each with configurable event filters and column visibility.
- :mag: Powerful search across all entities
  - Search for users, worlds, avatars, and groups, or paste IDs and URLs for direct access.
  - Quick Search provides instant client-side fuzzy search across your friends, avatars, worlds, and groups.
- :chart_with_upwards_trend: Activity Heatmap
  - Visualize a user's online activity patterns with a day-of-week × hour-of-day heatmap, including peak stats.
- :camera: Store world data in the pictures you take in-game, so you can remember that one world you took those cool pictures in like... 6 months ago!
- :bell: Monitor/respond to notifications
  - You can send/receive invites and friend requests from VRCX as well as see the instance info of invites that you receive.
- :scroll: See stats/players for your current instance
- :tv: See the links to videos that are playing in the world you're in, as well as various other logged data.
- :performing_arts: Social Status Presets
  - Save and quickly apply status + status description combinations from the sidebar or user dialog.
- :rotating_light: VRChat Server Status
  - A status bar indicator and login page alert inform you of VRChat server issues and outages in real time.
- :bar_chart: Improved Discord Rich Presence
  - Display detailed instance information in Discord, including world thumbnail, name, player count, and a join button for public lobbies.
- :crystal_ball: VR Overlay with configurable live feed of all supported events/notifications
- :outbox_tray: Upload and manage avatar/world images and details without Unity
- :electric_plug: Automatically launch apps when you start VRChat
- :skull: Automatically restart and join last instance when VRC crashes
- :left_right_arrow: Export/import data
  - Export friends list, avatar list, Discord names, notes, and favorite groups. Import favorite groups and group moderation bans.

## Miscellaneous

- Want a new look? Check out [Themes](https://github.com/gooseontheloose/VRCX-auto-inv/wiki/Themes)
- See [Building from source](https://github.com/gooseontheloose/VRCX-auto-inv/wiki/Building-from-source) for instructions on how to build from source.
- For a guide on how to run on Linux, see [here](https://github.com/gooseontheloose/VRCX-auto-inv/wiki/Running-VRCX-on-Linux)
- Interested in contributing? See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for guidelines.

## Telemetry

Official PAW Inviter releases send anonymous usage stats so we can see how many installs are active, how long the app stays open and which features get used. It's on by default; turn it off in **Settings → System → Send anonymous usage stats** and nothing more is sent. A one-line note on the login screen and under that switch links to [PRIVACY.md](./PRIVACY.md), which lists exactly what is sent.

- **When:** at start, every 20 minutes while the app is open, and once when you close it.
- **Sent:** a random install ID (a UUID made on your PC, not based on anything), a random ID for this app run, the app version, OS, CEF or Electron, your UI language code (e.g. `en`), on/off flags for PAW features, your update setting, and counts of how often a few features were used since the last ping (invites sent, Auto Inviter turned on, Group Monitor pages opened, webhook posts delivered / failed, audit-log gaps filled, usernames checked, AIRI friend actions, VRChat crash rejoins). Numbers only.
- **Never sent:** your VRChat account, user IDs, display names, friends, worlds, instances, groups, bios, logs, file paths, computer name or anything you type. Your IP address isn't stored (the hosting provider sees it briefly, like with any website).
- **Kept:** 400 days, then deleted (an install's latest-state row 400 days after its last ping).

The telemetry code lives in a private module that only official release builds include. If you build PAW Inviter yourself (`npm run prod`), you get a no-op stub: no switch, no note, nothing is sent.

# Screenshots

<div align="center">

<h3>Login</h3>

<table>
  <tr>
    <td align="center"><img src="https://github-production-user-asset-6210df.s3.amazonaws.com/82102170/251994190-5e6a961e-b2fe-4d3b-bf66-455d8626b8bf.png" alt="login"></td>
    <td align="center"><img src="https://github-production-user-asset-6210df.s3.amazonaws.com/82102170/251994414-a21faf59-6199-45de-94e7-a093a6b8c0ac.png" alt="2fa"></td>
  </tr>
</table>

<h3>Feed</h3>

<img src="https://github-production-user-asset-6210df.s3.amazonaws.com/82102170/251987020-9839a2c9-47db-4271-b1bf-8e07669a7056.png" alt="feed">

<h3>GameLog</h3>

<img src="https://github-production-user-asset-6210df.s3.amazonaws.com/82102170/251987498-b82266ed-131d-42ad-be2f-b167f24acf9f.png" alt="gamelog">

<h3>UserInfo</h3>

<h4>Me</h4>

<img src="https://github-production-user-asset-6210df.s3.amazonaws.com/82102170/251990237-0c863d27-141c-4447-82de-4279ab8973ea.png" alt="me">

<h4>Friend</h4>

<img src="https://github-production-user-asset-6210df.s3.amazonaws.com/82102170/251989666-8f918786-e632-451d-be29-f92d2c681b80.png" alt="friend">

<h3>World</h3>

<table>
  <tr>
    <td align="center"><img src="https://github-production-user-asset-6210df.s3.amazonaws.com/82102170/251991003-37a986bb-470c-442b-8ada-31918f7b2017.png" alt="instance"></td>
    <td align="center"><img src="https://github-production-user-asset-6210df.s3.amazonaws.com/82102170/251991217-0d40846f-ac08-48c0-8e4d-18c35fe0999b.png" alt="info"></td>
  </tr>
</table>

<h3>Favorite</h3>

<h4>Friend</h4>

<img src="https://github-production-user-asset-6210df.s3.amazonaws.com/82102170/251992424-ba406d0f-787e-4e2d-89bd-4caa0a05d31f.png" alt="friend">

<h4>World</h4>

<img src="https://github-production-user-asset-6210df.s3.amazonaws.com/82102170/251992950-8f2c6cdc-dc9a-4a60-b59f-9fa80d071359.png" alt="world">

<h4>Avatar</h4>

<img src="https://github-production-user-asset-6210df.s3.amazonaws.com/82102170/251993408-66d11100-15a8-484f-b9fd-82be1516c9be.png" alt="avatar">

<h3>Friend Log</h3>

<img src="https://github-production-user-asset-6210df.s3.amazonaws.com/82102170/251993741-e2033095-4ceb-4552-8b79-9285325c1e49.png" alt="friendlog">

<h3>Discord Rich Presence</h3>

<img src="https://github-production-user-asset-6210df.s3.amazonaws.com/82102170/251997318-5a71249c-59fc-4ad6-9194-d6b1d4165600.png" alt="discord">

</div>

## Is this against VRChat's TOS?

**No.**

This fork (like the original VRCX) is an external tool that uses the VRChat API to provide its features. It does not modify the game in any way, only using the API responsibly. It is not a mod, cheat, or any other form of modification to the game.

To see VRChat's stance on API usage, see the #faq channel in the VRChat Discord.

---

PAW Inviter - VRCX is not endorsed by VRChat and does not reflect the views or opinions of VRChat or anyone officially involved in producing or managing VRChat properties. VRChat and all associated properties are trademarks or registered trademarks of VRChat Inc. VRChat © VRChat Inc.
