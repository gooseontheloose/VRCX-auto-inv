<div align="center">

# PAW Inviter - VRCX

**A modified fork of VRCX with enhanced auto-invite features**

[![GitHub release](https://img.shields.io/github/release/gooseontheloose/VRCX-auto-inv.svg)](https://github.com/gooseontheloose/VRCX-auto-inv/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/gooseontheloose/VRCX-auto-inv/total?color=6451f1)](https://github.com/gooseontheloose/VRCX-auto-inv/releases/latest)
[![Discord](https://img.shields.io/discord/854071236363550763?color=%237289DA&logo=discord&logoColor=white&label=discord)](https://vrcx.app/discord)

| **English** | [Français](./README/README.fr.md) | [日本語](./README/README.jp.md) | [简体中文](./README/README.zh_CN.md) | [Italiano](./README/README.it.md) | [Русский](./README/README.ru_RU.md) | [Español](./README/README.es.md) | [Polski](./README/README.pl.md) | [ภาษาไทย](./README/README.th.md) | [Magyar](./README/README.hu.md)

This is a **custom fork** of [VRCX](https://github.com/vrcx-team/VRCX) — the VRChat assistant/companion application — with added features focused on automated group instance invite management.

</div>

<div align="center">

<div align="center">

## What's Different in This Fork

<div align="left">

- **Auto-Invite System** — Automatically invite group members to your instance with configurable speed presets (from 5 minutes down to 20 seconds)
- **18+ Only Toggle** — Filter invites to age-verified users only
- **Rate Limiting** — Cooldown increased to 1 hour to avoid rate limits
- **Self-Contained Build** — No .NET runtime required; just download and run the standalone exe
- **Auto-Updates** — Set to notify by default; checks this GitHub repo for new releases
- **Activity Log Shows 250 Entries** — Console log always shows full history (dropdown removed)

</div>

All original VRCX features remain intact. See below for the full feature list.

</div>

# Getting Started

<div align="center">

Download the latest release (`VRCX-2.0-Build-Only-Exe.zip`) from [here](https://github.com/gooseontheloose/VRCX-auto-inv/releases/latest), extract it, and run `VRCX.exe` — no installation or .NET runtime required.

For macOS and Linux check [here](https://github.com/gooseontheloose/VRCX-auto-inv/wiki/Running-VRCX-on-Linux) for more info.


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
