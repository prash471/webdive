const sessions = new Map();

const send = (target, method, params = {}) => chrome.debugger.sendCommand(target, method, params);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const base64Bytes=value=>Uint8Array.from(atob(value),character=>character.charCodeAt(0));
async function mapWithConcurrency(items,limit,worker){const results=new Array(items.length);let next=0;await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const index=next++;results[index]=await worker(items[index]);}}));return results;}

const NETWORK_PRESETS = {
  none: { offline:false, latency:0, downloadThroughput:-1, uploadThroughput:-1 },
  fast3g: { offline:false, latency:150, downloadThroughput:1.6 * 1024 * 1024 / 8, uploadThroughput:750 * 1024 / 8 },
  slow3g: { offline:false, latency:400, downloadThroughput:500 * 1024 / 8, uploadThroughput:500 * 1024 / 8 }
};

export async function startRecording(tabId, name, conditions = {}) {
  if (sessions.has(tabId)) throw new Error("A recording is already active for this tab.");
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  const session = { target, name, startedAt: Date.now(), conditions, events: [], traceEvents: [], markers: [], styleSheetIds: new Set(), scriptIds: new Set(), loadFiredAt:0, lastNetworkAt:Date.now() };
  sessions.set(tabId, session);
  try {
    await send(target, "Network.enable");
    await send(target, "Network.emulateNetworkConditions", NETWORK_PRESETS[conditions.network] || NETWORK_PRESETS.none);
    await send(target, "Emulation.setCPUThrottlingRate", { rate: Math.max(1, Number(conditions.cpuRate) || 1) });
    await send(target, "Debugger.enable");
    await send(target, "Profiler.enable");
    await send(target, "DOM.enable");
    await send(target, "Page.enable");
    await send(target, "CSS.enable");
    const detailedCoverage=conditions.coverage==="detailed";
    await send(target, "Profiler.startPreciseCoverage", { callCount: detailedCoverage, detailed: detailedCoverage, allowTriggeredUpdates: false });
    await send(target, "CSS.startRuleUsageTracking");
    await send(target, "Tracing.start", {
      traceConfig: { recordMode:"recordContinuously", traceBufferSizeInKb:65536, enableSampling:true, includedCategories:["devtools.timeline","disabled-by-default-devtools.timeline","disabled-by-default-devtools.timeline.inputs","latencyInfo","blink.user_timing","v8","disabled-by-default-v8.cpu_profiler"] },
      transferMode: "ReportEvents"
    });
    return { startedAt: session.startedAt };
  } catch (error) {
    sessions.delete(tabId);
    await send(target, "Network.emulateNetworkConditions", NETWORK_PRESETS.none).catch(() => {});
    await send(target, "Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
    await chrome.debugger.detach(target).catch(() => {});
    throw error;
  }
}

export function recordingStatus(tabId) {
  const session = sessions.get(tabId);
  return { active: !!session, name: session?.name, startedAt: session?.startedAt, markerCount:session?.markers.length||0 };
}

export function markJourneyPhase(tabId,name) {
  const session=sessions.get(tabId);
  if(!session)throw new Error("Start a recording before adding a journey phase.");
  const label=String(name||"").trim();
  if(!label)throw new Error("Enter a phase name.");
  const marker={name:label,atMs:Math.max(0,Date.now()-session.startedAt),kind:"manual"};
  session.markers.push(marker);
  return marker;
}

export function autoStopStatus(tabId) {
  const session=sessions.get(tabId);if(!session)return {active:false,ready:false};
  return autoStopDecision(session,Date.now());
}

export function autoStopDecision(session,now) {
  const elapsedMs=now-session.startedAt,quietMs=now-session.lastNetworkAt;
  const ready=!!session.loadFiredAt&&quietMs>=1500&&elapsedMs>=2000;
  return {active:true,ready:ready||elapsedMs>=60000,reason:ready?"load-and-network-idle":elapsedMs>=60000?"maximum-wait":"waiting",elapsedMs,quietMs,loadFired:!!session.loadFiredAt};
}

function waitForTrace(session) {
  return new Promise((resolve, reject) => {
    session.traceDone = resolve;
    session.traceFailed = reject;
    setTimeout(() => reject(new Error("Timed out while finishing the performance trace.")), 120000);
  });
}

export async function stopRecording(tabId, onProgress = () => {}) {
  const session = sessions.get(tabId);
  if (!session) throw new Error("No recording is active for this tab.");
  const stoppedAt=Date.now();
  try {
    onProgress(5,"Finalizing performance trace and CPU samples");
    const traceDone = waitForTrace(session);
    await send(session.target, "Tracing.end");
    await traceDone;
    onProgress(32,"Allowing Chrome profiling agents to settle");
    await pause(750);
    onProgress(35,session.conditions.coverage==="detailed"?"Capturing detailed block-level JavaScript coverage":"Capturing stable function-level JavaScript coverage");
    const jsCoverage=await send(session.target,"Profiler.takePreciseCoverage");
    onProgress(43,"Stopping precise coverage");
    await send(session.target,"Profiler.stopPreciseCoverage");
    onProgress(48,"Capturing CSS coverage");
    const cssCoverage=await send(session.target,"CSS.stopRuleUsageTracking");
    const styleIds=[...session.styleSheetIds], scriptIds=[...session.scriptIds], sourceTotal=styleIds.length+scriptIds.length;
    let sourceDone=0,lastPercent=-1;
    const sourceProgress=()=>{sourceDone++;const percent=52+Math.round(sourceDone/Math.max(1,sourceTotal)*36);if(percent!==lastPercent){lastPercent=percent;onProgress(percent,`Reading sources ${sourceDone} / ${sourceTotal}`);}};
    onProgress(52,`Reading sources 0 / ${sourceTotal}`);
    const [styleSheets,scripts]=await Promise.all([
      mapWithConcurrency(styleIds,1,async styleSheetId => {
        const text=await send(session.target,"CSS.getStyleSheetText",{styleSheetId}).then(result=>result.text,()=>"");sourceProgress();return {styleSheetId,text};
      }),
      mapWithConcurrency(scriptIds,1,async scriptId => {
        const source=await send(session.target,"Debugger.getScriptSource",{scriptId}).then(result=>result.scriptSource,()=>"");sourceProgress();return {scriptId,source};
      })
    ]);
    const scriptEvents=session.events.filter(event=>event.method==="Debugger.scriptParsed"&&event.params.sourceMapURL&&event.params.url);
    const mapTargets=new Map();for(const event of scriptEvents){try{const url=new URL(event.params.sourceMapURL,event.params.url).href;mapTargets.set(url,{url,scriptUrl:event.params.url});}catch{}}
    const sourceMaps=[];let mapDone=0;
    if(mapTargets.size){onProgress(89,`Reading source maps 0 / ${mapTargets.size}`);let frameId="";try{frameId=(await send(session.target,"Page.getFrameTree")).frameTree.frame.id;}catch{}
      for(const target of mapTargets.values()){let content="",error="";try{
        if(target.url.startsWith("data:")){const comma=target.url.indexOf(","),meta=target.url.slice(0,comma);content=meta.includes(";base64")?new TextDecoder().decode(base64Bytes(target.url.slice(comma+1))):decodeURIComponent(target.url.slice(comma+1));}
        else if(frameId){const loaded=await Promise.race([send(session.target,"Network.loadNetworkResource",{frameId,url:target.url,options:{disableCache:false,includeCredentials:true}}),pause(15000).then(()=>{throw new Error("Source map request timed out");})]);const stream=loaded.resource?.stream;if(stream){const chunks=[],decoder=new TextDecoder();let size=0;while(true){const part=await send(session.target,"IO.read",{handle:stream,size:1024*1024});const chunk=part.base64Encoded?decoder.decode(base64Bytes(part.data),{stream:!part.eof}):part.data;size+=chunk.length;if(size>50*1024*1024)throw new Error("Source map exceeds 50 MiB safety limit");chunks.push(chunk);if(part.eof)break;}content=chunks.join("");await send(session.target,"IO.close",{handle:stream}).catch(()=>{});}else error=loaded.resource?.netErrorName||"Source map was unavailable";}
      }catch(cause){error=cause.message;}sourceMaps.push({...target,content,error});mapDone++;onProgress(89+Math.round(mapDone/Math.max(1,mapTargets.size)*3),`Reading source maps ${mapDone} / ${mapTargets.size}`);}
    }
    onProgress(93,"Cleaning up CDP session");
    onProgress(94,"Preparing captured data for local correlation");
    return {
      schemaVersion: 1,
      recording: { name: session.name, startedAt: session.startedAt, stoppedAt, tabId, conditions: session.conditions, markers:session.markers },
      cdp: { events: session.events, jsCoverage: jsCoverage.result, scripts, cssCoverage: cssCoverage.ruleUsage, styleSheets, sourceMaps, traceEvents: session.traceEvents }
    };
  } finally {
    sessions.delete(tabId);
    await send(session.target, "Network.emulateNetworkConditions", NETWORK_PRESETS.none).catch(() => {});
    await send(session.target, "Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
    await chrome.debugger.detach(session.target).catch(() => {});
  }
}

export function captureEvent(source, method, params) {
  const session = sessions.get(source.tabId);
  if (!session) return;
  // Avoid Function.prototype.apply/spread argument limits on unusually large
  // trace chunks. Chrome is free to choose the chunk size.
  if (method === "Tracing.dataCollected") {
    for (const event of params.value || []) session.traceEvents.push(event);
  }
  else if (method === "Tracing.tracingComplete") session.traceDone?.();
  else if(method==="Page.loadEventFired")session.loadFiredAt=Date.now();
  else if (method.startsWith("Network.") || method === "Debugger.scriptParsed" || method === "CSS.styleSheetAdded") {
    if(method.startsWith("Network."))session.lastNetworkAt=Date.now();
    session.events.push({ method, params });
    if (method === "CSS.styleSheetAdded") session.styleSheetIds.add(params.header.styleSheetId);
    if (method === "Debugger.scriptParsed") session.scriptIds.add(params.scriptId);
  }
}

export function detached(source, reason) {
  const session = sessions.get(source.tabId);
  if (!session) return;
  session.traceFailed?.(new Error(`Debugger detached: ${reason}`));
  sessions.delete(source.tabId);
}
