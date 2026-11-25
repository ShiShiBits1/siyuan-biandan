# Biandan Companion · Third-party SiYuan plugin

English | [简体中文](README.zh-CN.md)

Manage your authorized Biandan cloud tasks in SiYuan.
Version **0.4.0-rc.2** is a mobile candidate for Android, iOS and the HarmonyOS
edition of SiYuan, pending real-device functional acceptance.
The previous stable release is 0.3.3; this version retains its candidate status.
No separate MCP server is required. This is an independent third-party client,
not an official Biandan or Huawei product, and not a native HarmonyOS application.

![Biandan Companion demo](preview.png)

## Features

- Today, colored task lists, calendar date selection and draggable priority quadrants.
- Create/edit one-off tasks, complete an occurrence, and render Markdown notes.
- Up to 20 subplans per task. Preview and confirm whole repeating or habit series
  edits while preserving each occurrence's corresponding checked steps.
- Stop further series updates, inspect confirmed results and explicitly resume.
  Interrupted series display unverified progress until reconciliation.
- Choose files, paste/drop images, preview and save to the SiYuan workspace.
- Focus timer, habit occurrence statistics and explicit focus-record saving.
- Immediate verified writes, shared page updates, and merged idle cloud reads.

## Install and connect

Search for **Biandan Companion** / **便单伴侣** in SiYuan's desktop marketplace,
install and enable it, then open the top-bar entry and choose Connect.
For local installation, download the selected version's `package.zip` from
[GitHub Releases](https://github.com/ShiShiBits1/siyuan-biandan/releases)
and use SiYuan's local plugin installation.

On desktop, authorize access on the Huawei page opened by the plugin. The temporary OAuth
callback listens only on `127.0.0.1:42681` and closes on completion or timeout.
Do not run another authorization process using that callback simultaneously.

Minimum SiYuan for this candidate: **3.8.11**. Prior native acceptance was performed on **Windows / 3.8.11**.
macOS and Linux desktop backends are declared but have not received real-device
acceptance in this project. Desktop authorization requires system secure storage.
Android, iOS and HarmonyOS SiYuan support is implemented as a candidate and still
requires real-device functional acceptance. The publisher has confirmed additional
authorization to adapt and distribute this plugin for HarmonyOS SiYuan; see the
third-party notices. It runs as web code inside SiYuan, rather than a separate
HarmonyOS native application or HAP. Browser frontends and SiYuan publish pages
are outside this release scope.

### Mobile candidate

Open Biandan Companion from SiYuan's plugin toolbar/menu to use its full-screen
mobile page. Navigation and lists use drawers; editors fit narrow screens and
the on-screen keyboard. Priority quadrants offer an explicit Move action for
touch devices. Native Back/Close protects an open editor or active operation;
save or cancel that operation first.

Each mobile device connects separately. Choose Connect, complete Huawei login
in the system browser, and copy the browser's final local callback address back
into the plugin. The official relay targets `127.0.0.1:42681`; a phone may display
a connection error at that final address. Paste the full address locally into
the authorization form within five minutes. Do not send that address to anyone.
There is no automatic app return or mobile loopback server. Whether the final
address remains accessible in the device's system browser is pending real-device
acceptance; cancel and start again if the browser cannot provide it.

Mobile requests use SiYuan's kernel proxy, with fixed HTTPS destinations and no
redirect following. Refresh credentials and the pending authorization attempt
are encrypted in device-local IndexedDB with a non-extractable WebCrypto key.
They do not use or replace the desktop authorization file and do not sync with
the workspace. This is WebView storage, not a hardware-backed OS keychain.
Missing crypto/storage support stops authorization; there is no plaintext fallback.
Clearing application/site data or changing the WebView origin requires a fresh
connection. Attachment preview/opening uses the native mobile link handler;
file picking and external viewers still need real-device acceptance on each mobile platform.

This revision fixes local package compatibility on HarmonyOS SiYuan. The previous
candidate omitted the `harmony` backend. SiYuan 3.8.12 can display a minimum-version
message for a platform incompatibility, even when its version is already newer.
The minimum stays at 3.8.11; this change does not bypass that requirement.

## Data and limits

Biandan cloud remains the task source; no second SiYuan task database is created.
The plugin uses documented Huawei OAuth/cloud-sync services and Biandan's
renewal service, with no developer-operated task backend. Access tokens stay in
memory. On desktop, refresh credentials are encrypted using system secure storage
before being saved in the local plugin's private state. Mobile uses the separate
device-local encrypted storage and manual callback flow described above.

Choose an **attachment notebook** in settings before uploading. Files are saved
to your SiYuan workspace and indexed by a native document; task notes contain
explicitly labeled SiYuan resource links. Other Biandan clients do not receive
the file bytes and are not guaranteed to open those links. Maximum **5 files per
task**, **20 MiB per file**. Removing links, canceling editing or deleting tasks
does not automatically delete already uploaded source files.

Whole-series editing handles at most **500 existing occurrences**, with no silent
truncation. New subplans start unchecked and may reopen completed historical
occurrences; the preview shows that impact before confirmation. Removing all
subplans preserves each occurrence's overall completion state. Original dates,
reminders, recurrence rules, progress timestamps, notes, native attachment
references and unrecognized fields are preserved.

Updates across cloud records are not atomic. A durable local intent records
confirmed progress; startup never automatically sends pending changes. Explicit
resume checks original versions and full records, skips verified targets, and
stops on later manual changes or changed series membership. Unsupported counting
targets or ambiguous progress are not silently converted. Advanced recurrence
rules, habit scheduling and native reminder delivery remain with the original
Biandan client and its device permissions. The preview contains demo data only.

## Build

With Node.js 20 or newer, run in the source directory:

```sh
npm ci
npm run build
npm run validate:marketplace
```

Output is in `dist/`. The marketplace asset is named `package.zip`, with runtime
files at its root. The public repository includes source, build resources and
validation; maintainer tests, private acceptance workspaces, business records
and credentials are excluded.

## License and attribution

Independently authored code and documentation use [MIT](LICENSE). The supplied
artwork is redistributed under authorization confirmed by the publisher and is
only resized for marketplace requirements. Third-party trademarks and artwork
are not relicensed under MIT. See [third-party notices](THIRD-PARTY-NOTICES.md).

Implemented from the public [Biandan developer documentation](https://gitcode.com/biandangroup/biandan_MCP/tree/main/docs/developers).
The native client and MCP server implementation are not distributed.

[Report issues](https://github.com/ShiShiBits1/siyuan-biandan/issues).
