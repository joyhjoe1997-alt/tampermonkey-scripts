# Changelog — Sideline (Multi-Tote Deletion Automation)

Automated tote processing for AFT Poirot V3 with multi-item price lookup.

Install / update: https://github.com/joyhjoe1997-alt/tampermonkey-scripts/raw/main/sideline-6.0.user.js

This project adheres to [Semantic Versioning](https://semver.org/) and the format is based on [Keep a Changelog](https://keepachangelog.com/).

## [6.3] — 2026-09-09

### Added
- **Background-tab safe polling.** All polling loops now run off a Web Worker
  "ticker" instead of `setInterval`, so the automation keeps progressing when the
  browser tab is unfocused or in the background (browsers throttle main-thread
  timers to ~1/sec in background tabs, which previously stalled the run).
- CSP/error watchdog: if a Web Worker cannot run (e.g. strict page
  Content-Security-Policy), the ticker falls back to a main-thread interval so the
  script still functions.

### Changed
- Replaced throttled `setTimeout` waits in the run loop with a non-throttled
  `bgSleep`.

### Notes
- If the browser fully suspends/discards the tab (aggressive tab-sleeping, e.g.
  Edge sleeping tabs or Chrome Memory Saver), no userscript can keep running.
  Exclude the Poirot site from tab-sleeping if you hit this.

## [6.2] — 2026-09-09

### Added
- **In-script update checker.** On startup the script fetches its own raw file
  from GitHub, compares the remote `@version` to the running version, and shows an
  "Install update" banner in the panel when a newer version is published.
- Added `github.com` and `raw.githubusercontent.com` to `@connect` for the
  version check.

## [6.1] — 2026-09-09

### Added
- **Silent duplicate removal on Load List.** Duplicate tote IDs are removed
  (first occurrence kept, case-insensitive, order preserved) and the deduped list
  is persisted, so skip-reloads and auto-resume no longer reintroduce duplicates.
  A count of removed duplicates is shown in the status line.
- **Blocking scan-error handling.** Any `.alert--error` banner on the scan page
  (e.g. "container cannot be used because it contains a Reverse Logistics item")
  is detected and shows a "Cannot Process" dialog with Skip / Stop options.

### Changed
- Blocking errors are now caught instantly by racing the Change Container button
  against the error banner, removing the previous ~12s page-transition wait.

### Fixed
- Tampermonkey auto-update wired up via `@updateURL` / `@downloadURL` pointing to
  the GitHub raw file.

## [6.0] — earlier

### Added
- Paste tote IDs and auto-process them sequentially.
- Reads all items (FNSKU/ASIN + qty) from the Change Container page.
- Resolves X0 FNSKUs to ASINs via FC Research `/results/product`.
- Fetches live Amazon.co.uk prices in parallel batches.
- Confirmation dialog with item table, prices, and grand total.
- Skips vt/pa/numeric totes with a warning.
- High-quantity (>100) warning before emptying.
- Persists progress across page reloads (skip = refresh + auto-resume).
- Draggable, collapsible floating panel.
- Item load timeout raised to 60s with a live progress counter.
- Empty-tote detection and removal of unnecessary delays.

[6.3]: https://github.com/joyhjoe1997-alt/tampermonkey-scripts/commit/0664432
[6.2]: https://github.com/joyhjoe1997-alt/tampermonkey-scripts/commit/de91620
[6.1]: https://github.com/joyhjoe1997-alt/tampermonkey-scripts/commit/0b761ad
