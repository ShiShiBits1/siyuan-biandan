# Biandan Companion · Third-party SiYuan plugin

English | [简体中文](README.zh-CN.md)

Manage your authorized Biandan cloud tasks in a SiYuan desktop document tab.
Version **0.3.3** packages the existing 0.3.2 features for the community marketplace.
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
While the first submission is under review, download `package.zip` from
[GitHub Releases](https://github.com/ShiShiBits1/siyuan-biandan/releases)
and use SiYuan's local plugin installation.

Authorize access on the Huawei page opened by the plugin. The temporary OAuth
callback listens only on `127.0.0.1:42681` and closes on completion or timeout.
Do not run another authorization process using that callback simultaneously.

Minimum SiYuan: **3.8.9**. Native acceptance was performed on **Windows / 3.8.11**.
macOS and Linux desktop backends are declared but have not received real-device
acceptance in this project. System secure storage is required. Browser frontends,
mobile devices, native HarmonyOS and SiYuan publish pages are not supported.

## Data and limits

Biandan cloud remains the task source; no second SiYuan task database is created.
The plugin uses documented Huawei OAuth/cloud-sync services and Biandan's
renewal service, with no developer-operated task backend. Access tokens stay in
memory. Refresh credentials are encrypted using system secure storage before
being saved in the local plugin's private state.

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
