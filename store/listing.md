# WebDive Chrome Web Store listing

## Name

WebDive — Journey Performance Analyzer

## Short description

Record a web journey and analyze resources, code coverage, CPU, and long tasks locally in Chrome DevTools.

## Category

Developer Tools

## Single purpose

WebDive records a developer-initiated journey in the inspected tab and turns Chrome DevTools Protocol network, coverage, source, and performance data into a local performance report.

## Detailed description

See what your web app really costs.

WebDive adds a dedicated Chrome DevTools panel for recording a real application journey. Press Start and interact normally, or use Reload & auto-record for a page-load capture. WebDive correlates every observable resource with Chrome coverage and performance telemetry.

The report includes:

- All journey requests plus pre-existing JS and CSS recovered from coverage
- Transfer, decoded/source size, host, and request duration
- Used and unused JavaScript and CSS percentages
- Highlighted per-file used and unused source ranges
- URL-attributed sampled CPU and V8 parse/compile activity
- Long tasks, blocking correlation, layout, style, and garbage collection
- Original-module attribution from accessible source maps
- Transparent priority scores and evidence-based findings
- Persistent local history and restorable JSON backups
- Named journey phases and automatic interaction markers with per-phase costs
- CPU and network throttling plus automatic reload recording

Privacy is part of the architecture. Captured application data is processed and stored locally in the extension. WebDive has no backend, analytics, advertising, login, or developer-operated data collection service. A declared source map may be requested directly from the inspected application’s source-map host.

WebDive is intended for developers and authorized performance testing. Results describe the recorded journey and should not be treated as proof that unobserved code is globally removable.

## Permission justification: debugger

WebDive’s single purpose requires the `debugger` permission to attach—only after an explicit Start or reload-record action—to the user’s inspected tab and invoke Chrome DevTools Protocol domains for Network events, precise JS/CSS coverage, source retrieval, emulation, and performance Tracing. The extension detaches during Stop or cleanup. No host permissions are requested.

## Prominent user-data disclosure

When the user starts a recording, WebDive reads page and resource URLs, source text, network metadata, code-coverage ranges, source maps, and performance trace events from the inspected tab. This data is used only to generate the visible local report and optional local history. It is not sent to WebDive or third parties. See `privacy.html` for the full policy and Limited Use disclosure.

## Suggested screenshot captions

1. Record a journey directly inside Chrome DevTools.
2. Rank every resource by measurable optimization opportunity.
3. Inspect used and unused code at source-range level.
4. Attribute bundle coverage to original source-map modules.
5. Compare warm and cold page-load behavior with quick actions.
