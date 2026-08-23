# WebDive Journey Analyzer — CDP pipeline milestone

WebDive is a local-only Chrome DevTools extension. It correlates network requests, precise JavaScript/CSS coverage, a CPU profile, and Chrome performance trace events.

## Try it

For Chrome Web Store distribution, upload [`dist/webdive-0.5.0.zip`](./dist/webdive-0.5.0.zip) in the Chrome Web Store Developer Dashboard. Store copy and the permission justification are in [`store/listing.md`](./store/listing.md); the remaining account and review steps are in [`store/submission-checklist.md`](./store/submission-checklist.md). The public privacy policy is [`privacy.html`](./privacy.html).

For local development:

1. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
2. Select this directory.
3. Open DevTools on a page and select the **WebDive** panel.
4. Press **Start**, perform the journey, then press **Stop**.

For a page-load measurement, use **Reload & auto-record**. WebDive starts every profiling domain before reloading, then automatically stops after the load event and 1.5 seconds of Network-domain quiet (minimum 2 seconds, maximum 60 seconds). **Reload without cache** repeats the workflow with DevTools cache bypass enabled. Manual Stop remains available throughout.

While recording, enter a label such as **Open checkout** or **Submit payment** and press **Mark phase**. A marker starts a new named phase without pausing capture. The report correlates each phase with requests, transfer, renderer main-thread time, attributed JavaScript event time, long tasks, and top scripts. WebDive also recovers supported click, pointer, keyboard, input, change, submit, touch, and wheel dispatch events from the CDP trace. Automatic interaction summaries use a bounded temporal window and are labeled as correlation rather than proof of causation.

After pressing **Start**, manually reload the inspected page when the report should include the initial document, scripts, stylesheets, images, fonts, and other page-load resources. CDP cannot retroactively report network transfers that completed before recording began. WebDive deliberately does not invoke `Page.reload` while all profiling domains are starting, because that combination has caused renderer crashes in some Chrome builds.

Scripts and stylesheets loaded before Start are still recovered when Chrome reports them through precise JS or CSS coverage. They appear in the table as **Loaded before recording**, with source coverage, CPU, and findings where available. Their journey transfer is `0 B` and download time is unavailable because WebDive does not invent historical Network events.

Before Start, CPU can be left at native speed or slowed by 4×/6×. Network can be left unthrottled or set to Fast 3G/Slow 3G. WebDive restores native CPU and network conditions when recording stops or startup fails. Per-resource download time is measured from CDP request start through `Network.loadingFinished` and is sortable in the report.

JavaScript coverage defaults to **Stable**, which records precise executed/unused functions without asking Chrome to materialize every block and call count. **Detailed** preserves block-level and call-count coverage for smaller pages, but Chrome's non-streaming `Profiler.takePreciseCoverage` can crash a renderer with a very large isolate. The selected fidelity is stored in `recording.conditions.coverage`.

Chrome shows a debugger infobar while recording because WebDive uses the Chrome DevTools Protocol. Modern Chrome supports multiple CDP clients, so an idle DevTools frontend and WebDive can attach concurrently. Do not simultaneously record in Chrome's built-in Performance panel: both it and WebDive use the shared Tracing controller, and the second `Tracing.start` may be rejected.

Completed runs and their per-file source details are stored in extension-local IndexedDB and remain available from **Run history** after DevTools or Chrome restarts. **Export backup** includes both the compact report and locally captured source details; **Import backup** restores them. Extension removal or browser-profile deletion also removes IndexedDB, so keep backups for important baselines.

When a script declares a source map, WebDive asks Chrome to load that map with the inspected page's credentials, parses it locally, and attributes generated used/unused ranges to original source modules. No source-map contents leave the device. Missing, inaccessible, invalid, indexed, or incomplete maps are reported as unavailable rather than silently inferred.

## Data and correctness

- No backend, analytics, remote code, or extension host permission exists. Application data stays in the extension; the only additional request WebDive may make is to a source-map URL already declared by an inspected script.
- Transfer size uses `Network.loadingFinished.encodedDataLength` and includes protocol/header overhead as reported by CDP.
- Precise coverage ranges are merged before measuring, preventing nested function ranges from being double-counted.
- Source offsets are converted to UTF-8 bytes using the locally retrieved script/stylesheet source.
- CPU is self time derived from CPU-profile samples and their `timeDeltas`.
- Long tasks are main-thread `RunTask` trace events lasting at least 50 ms; script URLs in enclosed trace events provide attribution.

Run the deterministic correlation tests with `npm test`.

## Static website and brand guide

- [`index.html`](./index.html) is the public WebDive product page.
- [`brand.html`](./brand.html) is the company and product brand system, including downloadable SVG marks, positioning, colors, typography, voice, and approved privacy language.
- [`methodology.html`](./methodology.html) is the complete technical computation guide.

All website assets are relative and self-contained: there are no external fonts, analytics scripts, build tools, or backend calls. To host on GitHub Pages, publish the repository root from a branch in **Repository settings → Pages**. The root `index.html` becomes the site homepage.

## Multi-client reproduction

The [`repro`](./repro) directory is a separate minimal extension for testing DevTools and `chrome.debugger` coexistence. It attaches while its own DevTools panel remains visible, runs `Network.enable`, precise Coverage, CPU Profiler, and Tracing commands one at a time, then prints every command result, detach event, and collected event count. Load that directory separately as an unpacked extension when diagnosing a Chrome-version-specific conflict.
