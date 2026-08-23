# DevTools multi-client reproduction

Load this directory as an unpacked extension in Chrome 129 or newer, open DevTools on any ordinary page, choose **CDP Repro**, and press **Start all domains** without closing DevTools. Cause a request or execute some JavaScript, then press **Stop and summarize**.

The log records `attach`, every command result, `detach` events, and final counts for Network events, precise Coverage scripts, CPU samples, and Tracing events. To isolate a conflict, comment out commands from the bottom of the start sequence or use the command-by-command results.

Expected outcomes:

- With the built-in Performance panel idle, `Network.enable`, `Profiler.startPreciseCoverage`, `Profiler.start`, and `Tracing.start` should coexist with the open DevTools frontend.
- If the built-in Performance panel is already recording, WebDive `Tracing.start` may fail because tracing is process/browser-wide. This is a command failure; the log distinguishes it from `chrome.debugger.onDetach`.
- `chrome.devtools.performance` only notifies the panel when built-in Performance recording starts/stops. It cannot start, stop, or retrieve that recording.
