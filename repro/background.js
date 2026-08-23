const runs = new Map();
const emit = (run, value) => { try { run.port.postMessage(value); } catch {} };
async function command(run, method, params = {}) {
  try {
    const result = await chrome.debugger.sendCommand(run.target, method, params);
    emit(run, { event:"command", method, ok:true }); return result;
  } catch (error) {
    emit(run, { event:"command", method, ok:false, error:error.message }); throw error;
  }
}
async function start(run) {
  try {
    await chrome.debugger.attach(run.target, "1.3");
    run.attached = true; emit(run, { event:"attach", ok:true });
    await command(run, "Network.enable");
    await command(run, "Profiler.enable");
    await command(run, "Profiler.startPreciseCoverage", { callCount:true, detailed:true });
    await command(run, "Profiler.start");
    await command(run, "Tracing.start", {
      categories:"devtools.timeline,v8",
      transferMode:"ReportEvents",
      options:"record-as-much-as-possible"
    });
    emit(run, { event:"ready", note:"DevTools remained open if you can still see this message." });
  } catch (error) { emit(run, { event:"start-failed", error:error.message }); }
}
async function stop(run) {
  try {
    const coverage = await command(run, "Profiler.takePreciseCoverage");
    const profile = await command(run, "Profiler.stop");
    run.traceDone = new Promise(resolve => { run.resolveTrace = resolve; });
    await command(run, "Tracing.end");
    await Promise.race([run.traceDone, new Promise((_, reject) => setTimeout(() => reject(new Error("trace timeout")), 10000))]);
    await command(run, "Profiler.stopPreciseCoverage");
    emit(run, { event:"summary", networkEvents:run.networkEvents, coverageScripts:coverage.result.length,
      cpuSamples:profile.profile.samples?.length || 0, traceEvents:run.traceEvents });
  } catch (error) { emit(run, { event:"stop-failed", error:error.message }); }
  finally { if (run.attached) await chrome.debugger.detach(run.target).catch(()=>{}); runs.delete(run.target.tabId); }
}
chrome.runtime.onConnect.addListener(port => {
  port.onMessage.addListener(message => {
    if (message.type === "start") {
      const run = { port, target:{tabId:message.tabId}, networkEvents:0, traceEvents:0 };
      runs.set(message.tabId, run); start(run);
    } else if (message.type === "stop") { const run=runs.get(message.tabId); if (run) stop(run); }
  });
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  const run=runs.get(source.tabId); if (!run) return;
  if (method.startsWith("Network.")) run.networkEvents++;
  if (method === "Tracing.dataCollected") run.traceEvents += params.value.length;
  if (method === "Tracing.tracingComplete") run.resolveTrace?.();
});
chrome.debugger.onDetach.addListener((source, reason) => {
  const run=runs.get(source.tabId); if (!run) return;
  emit(run, { event:"detach", reason }); run.resolveTrace?.(); run.attached=false;
});
