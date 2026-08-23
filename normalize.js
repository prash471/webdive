const enc = new TextEncoder();
const byteLength = value => enc.encode(value || "").length;
const cleanUrl = url => {
  try { const value = new URL(url); value.hash = ""; return value.href; } catch { return url || ""; }
};
const basename = url => {
  try { return new URL(url).pathname.split("/").filter(Boolean).pop() || new URL(url).hostname; }
  catch { return url || "(anonymous)"; }
};

function mergeRanges(ranges) {
  const sorted = ranges.filter(r => r.endOffset > r.startOffset).sort((a, b) => a.startOffset - b.startOffset);
  const merged = []; let start = -1, end = -1;
  for (const range of sorted) {
    if (range.startOffset > end) { if (end > start) merged.push({ startOffset:start, endOffset:end }); start = range.startOffset; end = range.endOffset; }
    else end = Math.max(end, range.endOffset);
  }
  if (end > start) merged.push({ startOffset:start, endOffset:end });
  return merged;
}
const unionLength = ranges => mergeRanges(ranges).reduce((n, r) => n + r.endOffset - r.startOffset, 0);
const rangesByteLength = (text, ranges) => mergeRanges(ranges).reduce((n, r) => n + byteLength(text.slice(r.startOffset, r.endOffset)), 0);
function effectiveUsedRanges(ranges){const sorted=ranges.filter(r=>r.endOffset>r.startOffset).map(r=>({...r,children:[]})).sort((a,b)=>a.startOffset-b.startOffset||b.endOffset-a.endOffset);const roots=[],stack=[];for(const range of sorted){while(stack.length&&!(stack.at(-1).startOffset<=range.startOffset&&stack.at(-1).endOffset>=range.endOffset))stack.pop();(stack.length?stack.at(-1).children:roots).push(range);stack.push(range);}const used=[];const visit=node=>{let cursor=node.startOffset;for(const child of node.children){if(node.count>0&&child.startOffset>cursor)used.push({startOffset:cursor,endOffset:child.startOffset});visit(child);cursor=Math.max(cursor,child.endOffset);}if(node.count>0&&cursor<node.endOffset)used.push({startOffset:cursor,endOffset:node.endOffset});};roots.forEach(visit);return mergeRanges(used);}

function normalizeNetwork(events) {
  const requests = new Map();
  for (const { method, params } of events) {
    if (method === "Network.requestWillBeSent") {
      if (params.redirectResponse) requests.set(`${params.requestId}:redirect:${params.timestamp}`, {
        requestId: params.requestId, url: cleanUrl(params.redirectResponse.url), type: params.type,
        mimeType: params.redirectResponse.mimeType, status: params.redirectResponse.status,
        transferBytes: params.redirectResponse.encodedDataLength || 0, decodedBytes: 0
      });
      requests.set(params.requestId, { requestId: params.requestId, url: cleanUrl(params.request.url), type: params.type, transferBytes: 0, decodedBytes: 0, startedAt: params.timestamp });
    } else if (method === "Network.responseReceived") {
      const item = requests.get(params.requestId) || { requestId: params.requestId };
      Object.assign(item, { url: cleanUrl(params.response.url), type: params.type, mimeType: params.response.mimeType,
        status: params.response.status, fromDiskCache: !!params.response.fromDiskCache, fromServiceWorker: !!params.response.fromServiceWorker });
      requests.set(params.requestId, item);
    } else if (method === "Network.loadingFinished") {
      const item = requests.get(params.requestId);
      if (item) { item.transferBytes = params.encodedDataLength || 0; item.finishedAt=params.timestamp; item.downloadMs=item.startedAt==null?null:Math.max(0,(params.timestamp-item.startedAt)*1000); }
    } else if (method === "Network.dataReceived") {
      const item = requests.get(params.requestId);
      if (item) item.decodedBytes = (item.decodedBytes || 0) + (params.dataLength || 0);
    }
  }
  return [...requests.values()].filter(r => r.url && !r.url.startsWith("data:"));
}

function normalizeJs(coverage, sources) {
  const sourceMap = new Map(sources.map(item => [item.scriptId, item.source]));
  return coverage.filter(item => item.url).map(item => {
    const all = item.functions.flatMap(fn => fn.ranges);
    const source = sourceMap.get(item.scriptId) || "";
    const totalBytes = source ? byteLength(source) : all.reduce((maximum,range)=>Math.max(maximum,range.endOffset),0);
    const usedRanges=effectiveUsedRanges(all);
    const usedBytes = source ? rangesByteLength(source,usedRanges) : unionLength(usedRanges);
    return { scriptId: item.scriptId, url: cleanUrl(item.url), totalBytes, usedBytes, unusedBytes: Math.max(0, totalBytes - usedBytes) };
  });
}

function normalizeCss(raw, events, texts) {
  const headers = new Map(events.filter(e => e.method === "CSS.styleSheetAdded").map(e => [e.params.header.styleSheetId, e.params.header]));
  const textMap = new Map(texts.map(item => [item.styleSheetId, item.text]));
  const usage = new Map();
  for (const rule of raw) {
    if (!usage.has(rule.styleSheetId)) usage.set(rule.styleSheetId, []);
    if (rule.used) usage.get(rule.styleSheetId).push(rule);
  }
  return [...textMap].map(([styleSheetId, text]) => {
    const header = headers.get(styleSheetId) || {};
    const totalBytes = byteLength(text);
    const usedBytes = rangesByteLength(text, usage.get(styleSheetId) || []);
    return { styleSheetId, url: cleanUrl(header.sourceURL || header.ownerNode || `inline:${styleSheetId}`), totalBytes, usedBytes, unusedBytes: totalBytes - usedBytes };
  });
}

function normalizeCpu(profile) {
  const nodes = new Map(profile.nodes.map(n => [n.id, n]));
  const totals = new Map(), samples = new Map();
  (profile.samples || []).forEach((nodeId, index) => {
    const node = nodes.get(nodeId); const url = cleanUrl(node?.callFrame?.url);
    if (url) { totals.set(url, (totals.get(url) || 0) + ((profile.timeDeltas?.[index] || 0) / 1000)); samples.set(url,(samples.get(url)||0)+1); }
  });
  const totalMs=[...totals.values()].reduce((a,b)=>a+b,0);
  return [...totals].map(([url, cpuMs]) => ({ url, cpuMs, cpuSamples:samples.get(url)||0, cpuPercent:totalMs?cpuMs/totalMs*100:0 })).sort((a, b) => b.cpuMs - a.cpuMs);
}

function normalizeTraceCpu(traceEvents){const nodes=new Map(),sampleTimes=new Map(),sampleCounts=new Map();for(const event of traceEvents){if(event.name!=="ProfileChunk")continue;const data=event.args?.data||{},profile=data.cpuProfile||{};(profile.nodes||[]).forEach(node=>nodes.set(node.id,node));const samples=profile.samples||[],deltas=data.timeDeltas||profile.timeDeltas||[];samples.forEach((nodeId,index)=>{sampleTimes.set(nodeId,(sampleTimes.get(nodeId)||0)+(deltas[index]||0)/1000);sampleCounts.set(nodeId,(sampleCounts.get(nodeId)||0)+1);});}const byUrl=new Map();for(const [nodeId,cpuMs] of sampleTimes){const url=cleanUrl(nodes.get(nodeId)?.callFrame?.url);if(!url)continue;const item=byUrl.get(url)||{url,cpuMs:0,cpuSamples:0};item.cpuMs+=cpuMs;item.cpuSamples+=sampleCounts.get(nodeId)||0;byUrl.set(url,item);}const totalMs=[...byUrl.values()].reduce((sum,item)=>sum+item.cpuMs,0);return [...byUrl.values()].map(item=>({...item,cpuPercent:totalMs?item.cpuMs/totalMs*100:0})).sort((a,b)=>b.cpuMs-a.cpuMs);}

function normalizeLongTasks(traceEvents) {
  const complete = [], byThread = new Map();
  const mainThreads = new Set(traceEvents.filter(e => e.ph === "M" && e.name === "thread_name" && e.args?.name === "CrRendererMain").map(e => `${e.pid}:${e.tid}`));
  for (const event of traceEvents) {
    if (event.ph !== "X" || !Number.isFinite(event.ts) || !Number.isFinite(event.dur)) continue;
    complete.push(event);
    const key=`${event.pid}:${event.tid}`;
    if (!byThread.has(key)) byThread.set(key,[]);
    byThread.get(key).push(event);
  }
  for (const events of byThread.values()) events.sort((a,b)=>a.ts-b.ts);
  const lowerBound=(events,time)=>{let low=0,high=events.length;while(low<high){const middle=(low+high)>>>1;if(events[middle].ts<time)low=middle+1;else high=middle;}return low;};
  const tasks = complete.filter(e => e.name === "RunTask" && e.dur >= 50000 && (!mainThreads.size || mainThreads.has(`${e.pid}:${e.tid}`))).map(task => {
    const end = task.ts + task.dur;
    const events=byThread.get(`${task.pid}:${task.tid}`)||[], contributors=new Set();
    for(let index=lowerBound(events,task.ts);index<events.length&&events[index].ts<end;index++){
      const event=events[index];if(event===task)continue;
      const url=cleanUrl(event.args?.data?.url || event.args?.data?.scriptName || event.args?.data?.stackTrace?.[0]?.url);
      if(url)contributors.add(url);
    }
    return { startUs: task.ts, durationMs: task.dur / 1000, contributors: [...contributors] };
  });
  return tasks;
}

function analyzeTrace(traceEvents) {
  const complete=traceEvents.filter(e=>e.ph==="X"&&Number.isFinite(e.ts)&&Number.isFinite(e.dur));
  const namedMain=traceEvents.find(e=>e.ph==="M"&&e.name==="thread_name"&&e.args?.name==="CrRendererMain");
  const runCounts=new Map(); complete.filter(e=>e.name==="RunTask").forEach(e=>runCounts.set(`${e.pid}:${e.tid}`,(runCounts.get(`${e.pid}:${e.tid}`)||0)+1));
  const mainKey=namedMain?`${namedMain.pid}:${namedMain.tid}`:[...runCounts].sort((a,b)=>b[1]-a[1])[0]?.[0];
  const main=complete.filter(e=>`${e.pid}:${e.tid}`===mainKey);
  const durationEvents=main.length?main:complete;
  const minTs=durationEvents.reduce((minimum,event)=>Math.min(minimum,event.ts),Infinity);
  const maxTs=durationEvents.reduce((maximum,event)=>Math.max(maximum,event.ts+event.dur),-Infinity);
  const durationUs=Number.isFinite(minTs)&&Number.isFinite(maxTs)?Math.max(0,maxTs-minTs):0;
  const busyUs=main.filter(e=>e.name==="RunTask").reduce((n,e)=>n+e.dur,0);
  const target=["RunTask","UpdateLayoutTree","Layout","Paint","FunctionCall","FireAnimationFrame","Layerize","Commit","HitTest","IntersectionObserverController::computeIntersections","MajorGC","MinorGC","EvaluateScript"];
  const eventMap=new Map();
  for(const event of main.filter(e=>target.includes(e.name))){const stat=eventMap.get(event.name)||{name:event.name,totalMs:0,count:0,averageMs:0};stat.totalMs+=event.dur/1000;stat.count++;eventMap.set(event.name,stat);}
  const eventStats=[...eventMap.values()].map(s=>({...s,averageMs:s.totalMs/s.count,tracePercent:durationUs?s.totalMs*1000/durationUs*100:0})).sort((a,b)=>b.totalMs-a.totalMs);
  const styles=main.filter(e=>e.name==="UpdateLayoutTree").map(e=>Number(e.args?.elementCount??e.args?.data?.elementCount??0)).filter(Boolean);
  const layouts=main.filter(e=>e.name==="Layout").map(e=>e.args?.beginData||e.args?.data?.beginData).filter(Boolean);
  let forcedReflows=0, forcedReflowMs=0;
  const tasks=main.filter(e=>e.name==="RunTask"), orderedMain=[...main].sort((a,b)=>a.ts-b.ts);
  const lowerBound=time=>{let low=0,high=orderedMain.length;while(low<high){const middle=(low+high)>>>1;if(orderedMain[middle].ts<time)low=middle+1;else high=middle;}return low;};
  const scrollTasks=[];
  for(const task of tasks){const end=task.ts+task.dur,children=[];for(let index=lowerBound(task.ts);index<orderedMain.length&&orderedMain[index].ts<end;index++){const event=orderedMain[index];if(event!==task&&event.ts+event.dur<=end)children.push(event);}let lastJs=false,reflows=0,reflowUs=0;
    for(const child of children.filter(e=>["FunctionCall","Layout","UpdateLayoutTree"].includes(e.name)).sort((a,b)=>a.ts-b.ts)){if(child.name==="FunctionCall")lastJs=true;else{if(lastJs){reflows++;reflowUs+=child.dur;}lastJs=false;}}
    if(reflows>=2){forcedReflows+=reflows;forcedReflowMs+=reflowUs/1000;}
    if(children.some(e=>(e.name==="UpdateLayoutTree"||e.name==="FunctionCall")&&e.dur>50000)){const sum=names=>children.filter(e=>names.includes(e.name)).reduce((n,e)=>n+e.dur/1000,0);scrollTasks.push({durationMs:task.dur/1000,jsMs:sum(["FunctionCall"]),styleMs:sum(["UpdateLayoutTree"]),layoutMs:sum(["Layout"]),paintMs:sum(["Paint"]),compositeMs:sum(["Layerize","Commit"]),hitTestMs:sum(["HitTest"])});}
  }
  const percentile=(values,p)=>{if(!values.length)return 0;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.round((p/100)*(sorted.length-1))];};
  const avg=key=>scrollTasks.length?scrollTasks.reduce((n,t)=>n+t[key],0)/scrollTasks.length:0;
  const breakdown={jsMs:avg("jsMs"),styleMs:avg("styleMs"),layoutMs:avg("layoutMs"),paintMs:avg("paintMs"),compositeMs:avg("compositeMs"),hitTestMs:avg("hitTestMs")};
  const bottleneck=Object.entries(breakdown).sort((a,b)=>b[1]-a[1])[0];
  return {durationMs:durationUs/1000,mainThreadBusyMs:busyUs/1000,mainThreadBusyPercent:durationUs?busyUs/durationUs*100:0,eventStats,
    styleRecalc:{count:styles.length,averageElements:styles.length?styles.reduce((a,b)=>a+b,0)/styles.length:0,maxElements:styles.reduce((maximum,value)=>Math.max(maximum,value),0)},
    layoutDirty:{count:layouts.length,averageDirty:layouts.length?layouts.reduce((n,x)=>n+Number(x.dirtyObjects||0),0)/layouts.length:0,maxDirty:layouts.reduce((maximum,value)=>Math.max(maximum,Number(value.dirtyObjects||0)),0),averageRatio:layouts.length?layouts.reduce((n,x)=>n+(x.totalObjects?Number(x.dirtyObjects||0)/Number(x.totalObjects)*100:0),0)/layouts.length:0},
    forcedReflow:{count:forcedReflows,layoutMs:forcedReflowMs},gc:{majorMs:eventMap.get("MajorGC")?.totalMs||0,minorMs:eventMap.get("MinorGC")?.totalMs||0},
    scroll:{count:scrollTasks.length,p50Ms:percentile(scrollTasks.map(x=>x.durationMs),50),p90Ms:percentile(scrollTasks.map(x=>x.durationMs),90),p99Ms:percentile(scrollTasks.map(x=>x.durationMs),99),bottleneck:bottleneck?.[1]?bottleneck[0].replace("Ms",""):"none",breakdown} };
}

function resourceExecution(traceEvents, protocolEvents, longTasks) {
  const scriptUrls=new Map(protocolEvents.filter(e=>e.method==="Debugger.scriptParsed").map(e=>[String(e.params.scriptId),cleanUrl(e.params.url)]));
  const result=new Map();
  const urlFor=event=>cleanUrl(event.args?.data?.url||event.args?.data?.scriptName||event.args?.url||event.args?.data?.stackTrace?.[0]?.url||scriptUrls.get(String(event.args?.data?.scriptId??""))||"");
  const get=url=>{if(!result.has(url))result.set(url,{jsInvocations:0,jsExecutionMs:0,v8Events:0,v8Ms:0,blockingMs:0,longTaskExposureMs:0});return result.get(url);};
  for(const event of traceEvents){if(event.ph!=="X"||!Number.isFinite(event.dur))continue;const url=urlFor(event);if(!url)continue;const item=get(url);
    if(event.name==="FunctionCall"||event.name==="EvaluateScript"){item.jsInvocations++;item.jsExecutionMs+=event.dur/1000;}
    if(/(^v8[.:]|^V8[.:]|Compile|ParseScript|ParseFunction)/.test(event.name)){item.v8Events++;item.v8Ms+=event.dur/1000;}
  }
  for(const task of longTasks){if(!task.contributors.length)continue;const share=Math.max(0,task.durationMs-50)/task.contributors.length;
    for(const url of task.contributors){const item=get(url);item.blockingMs+=share;item.longTaskExposureMs+=task.durationMs;}
  }
  return result;
}

const interactionTypes=new Set(["click","dblclick","mousedown","mouseup","pointerdown","pointerup","touchstart","touchend","keydown","keyup","input","change","submit","wheel"]);
function journeyAnalysis(raw,resources,longTasks){
  const trace=raw.cdp.traceEvents||[],complete=trace.filter(event=>event.ph==="X"&&Number.isFinite(event.ts)&&Number.isFinite(event.dur));
  const mainThreads=new Set(trace.filter(event=>event.ph==="M"&&event.name==="thread_name"&&event.args?.name==="CrRendererMain").map(event=>`${event.pid}:${event.tid}`));
  const timed=trace.filter(event=>Number.isFinite(event.ts)&&(["RunTask","EventDispatch","FunctionCall","EvaluateScript"].includes(event.name)));
  const traceStartUs=timed.reduce((minimum,event)=>Math.min(minimum,event.ts),Infinity);
  const recordingDuration=Math.max(0,(raw.recording?.stoppedAt||0)-(raw.recording?.startedAt||0));
  const durationMs=recordingDuration||((Number.isFinite(traceStartUs)?trace.reduce((maximum,event)=>Math.max(maximum,Number(event.ts||0)+Number(event.dur||0)),traceStartUs)-traceStartUs:0)/1000);
  const offsetForUs=value=>Number.isFinite(traceStartUs)?Math.max(0,(value-traceStartUs)/1000):0;
  const urlFor=event=>cleanUrl(event.args?.data?.url||event.args?.data?.scriptName||event.args?.data?.stackTrace?.[0]?.url||"");
  const summarizeWindow=(startMs,endMs)=>{
    const startUs=Number.isFinite(traceStartUs)?traceStartUs+startMs*1000:-Infinity,endUs=Number.isFinite(traceStartUs)?traceStartUs+endMs*1000:Infinity;
    const windowEvents=complete.filter(event=>event.ts>=startUs&&event.ts<endUs&&(mainThreads.size===0||mainThreads.has(`${event.pid}:${event.tid}`))),tasks=windowEvents.filter(event=>event.name==="RunTask");
    const scripts=new Map();let jsExecutionMs=0;
    for(const event of windowEvents){if(event.name!=="FunctionCall"&&event.name!=="EvaluateScript")continue;const ms=event.dur/1000,url=urlFor(event);jsExecutionMs+=ms;if(url)scripts.set(url,(scripts.get(url)||0)+ms);}
    const phaseResources=resources.filter(resource=>Number.isFinite(resource.startedAt)&&resource.startedAt*1e6>=startUs&&resource.startedAt*1e6<endUs);
    const phaseTasks=longTasks.filter(task=>task.startUs>=startUs&&task.startUs<endUs);
    return {requestCount:phaseResources.length,transferBytes:phaseResources.reduce((sum,item)=>sum+(item.transferBytes||0),0),mainThreadBusyMs:tasks.reduce((sum,event)=>sum+event.dur/1000,0),jsExecutionMs,longTasks:phaseTasks.length,topScripts:[...scripts].map(([url,cpuMs])=>({url,cpuMs})).sort((a,b)=>b.cpuMs-a.cpuMs).slice(0,3)};
  };
  const markers=(raw.recording?.markers||[]).filter(marker=>Number.isFinite(marker.atMs)).map(marker=>({...marker,atMs:Math.min(durationMs,Math.max(0,marker.atMs))})).sort((a,b)=>a.atMs-b.atMs);
  const boundaries=[{name:"Initial",atMs:0,kind:"automatic"},...markers.filter((marker,index)=>marker.atMs>0&&(index===0||marker.atMs!==markers[index-1].atMs))];
  const phases=boundaries.map((marker,index)=>{const endMs=boundaries[index+1]?.atMs??durationMs;return {name:marker.name,startMs:marker.atMs,endMs,durationMs:Math.max(0,endMs-marker.atMs),kind:marker.kind,...summarizeWindow(marker.atMs,endMs)};}).filter(phase=>phase.durationMs>0);
  const interactions=[];
  for(const event of complete){if(event.name!=="EventDispatch")continue;const type=String(event.args?.data?.type||event.args?.data?.eventType||"").toLowerCase();if(!interactionTypes.has(type))continue;const atMs=offsetForUs(event.ts),previous=interactions.at(-1);if(previous&&previous.type===type&&atMs-previous.atMs<80)continue;interactions.push({type,atMs,durationMs:event.dur/1000});}
  for(let index=0;index<interactions.length;index++){const interaction=interactions[index],endMs=Math.min(durationMs,interactions[index+1]?.atMs??interaction.atMs+500,interaction.atMs+1000);Object.assign(interaction,{windowEndMs:endMs,...summarizeWindow(interaction.atMs,endMs)});}
  return {durationMs,phases,interactions};
}

export function normalizeRecording(raw) {
  const resources = normalizeNetwork(raw.cdp.events || []);
  const js = normalizeJs(raw.cdp.jsCoverage || [], raw.cdp.scripts || []);
  const css = normalizeCss(raw.cdp.cssCoverage || [], raw.cdp.events || [], raw.cdp.styleSheets || []);
  const traceCpu=normalizeTraceCpu(raw.cdp.traceEvents||[]);
  const cpu = traceCpu.length?traceCpu:normalizeCpu(raw.cdp.cpuProfile?.profile || raw.cdp.cpuProfile || { nodes: [] });
  const longTasks = normalizeLongTasks(raw.cdp.traceEvents || []);
  const traceAnalysis = analyzeTrace(raw.cdp.traceEvents || []);
  const executionByUrl=resourceExecution(raw.cdp.traceEvents || [],raw.cdp.events || [],longTasks);
  const journey=journeyAnalysis(raw,resources,longTasks);
  const resourceByUrl = new Map(resources.map(r => [r.url, r]));
  for (const script of js) script.transferBytes = resourceByUrl.get(script.url)?.transferBytes || 0;
  for (const sheet of css) sheet.transferBytes = resourceByUrl.get(sheet.url)?.transferBytes || 0;
  const networkJs = resources.filter(r => r.type === "Script" || /javascript|ecmascript/.test(r.mimeType || ""));
  const jsTransferBytes = networkJs.reduce((n, r) => n + r.transferBytes, 0);
  const jsTotalBytes = js.reduce((n, r) => n + r.totalBytes, 0), jsUsedBytes = js.reduce((n, r) => n + r.usedBytes, 0);
  const cssTotalBytes = css.reduce((n, r) => n + r.totalBytes, 0), cssUsedBytes = css.reduce((n, r) => n + r.usedBytes, 0);
  const contributorUrls = new Set(longTasks.flatMap(t => t.contributors));
  const aggregateCoverage = entries => {
    const result = new Map();
    for (const entry of entries) {
      const item = result.get(entry.url) || { totalBytes:0, usedBytes:0, unusedBytes:0 };
      item.totalBytes += entry.totalBytes; item.usedBytes += entry.usedBytes; item.unusedBytes += entry.unusedBytes;
      result.set(entry.url, item);
    }
    return result;
  };
  const jsByUrl=aggregateCoverage(js), cssByUrl=aggregateCoverage(css), cpuByUrl=new Map(cpu.map(item=>[item.url,item]));
  // Network events only describe requests that happen after Start. Coverage can
  // still include scripts/stylesheets parsed before the journey, so union both
  // sources into the report inventory and mark synthetic rows explicitly.
  const networkUrls=new Set(resources.map(resource=>resource.url)),inventory=resources.map(resource=>({...resource,networkObserved:true,loadContext:"Requested during recording"}));
  for(const [url,coverage] of jsByUrl){if(!networkUrls.has(url))inventory.push({requestId:null,url,type:"Script",mimeType:"application/javascript",transferBytes:0,decodedBytes:coverage.totalBytes,downloadMs:null,networkObserved:false,loadContext:"Loaded before recording"});}
  for(const [url,coverage] of cssByUrl){if(!networkUrls.has(url))inventory.push({requestId:null,url,type:"Stylesheet",mimeType:"text/css",transferBytes:0,decodedBytes:coverage.totalBytes,downloadMs:null,networkObserved:false,loadContext:"Loaded before recording"});}
  const files=inventory.map(resource=>{
    const coverage=jsByUrl.get(resource.url)||cssByUrl.get(resource.url);
    const totalBytes=coverage?.totalBytes ?? (resource.decodedBytes || null);
    const usedBytes=coverage?.usedBytes ?? null, unusedBytes=coverage?.unusedBytes ?? null;
    let host=""; try { host=new URL(resource.url).host; } catch {}
    const cpuStat=cpuByUrl.get(resource.url), execution=executionByUrl.get(resource.url)||{};
    const findings=[]; if((cpuStat?.cpuPercent||0)>=20)findings.push("CPU-heavy");if((execution.blockingMs||0)>0)findings.push("blocks main thread");if(coverage&&coverage.totalBytes&&coverage.unusedBytes/coverage.totalBytes>=.5)findings.push("mostly unused");if((execution.v8Ms||0)>=50)findings.push("high V8 compile/parse");
    return { requestId:resource.requestId, url:resource.url, host, type:resource.type||resource.mimeType||"Other", mimeType:resource.mimeType,networkObserved:resource.networkObserved,loadContext:resource.loadContext,
      status:resource.status, transferBytes:resource.transferBytes||0, decodedBytes:resource.decodedBytes||0, downloadMs:resource.downloadMs??null, totalBytes, usedBytes, unusedBytes,
      unusedPercent:coverage&&coverage.totalBytes?Math.round(coverage.unusedBytes/coverage.totalBytes*100):coverage?0:null,
      cpuMs:cpuStat?.cpuMs||0,cpuSamples:cpuStat?.cpuSamples||0,cpuPercent:cpuStat?.cpuPercent||0,jsInvocations:execution.jsInvocations||0,jsExecutionMs:execution.jsExecutionMs||0,
      v8Events:execution.v8Events||0,v8Ms:execution.v8Ms||0,blockingMs:execution.blockingMs||0,longTaskExposureMs:execution.longTaskExposureMs||0,
      longTasks:longTasks.filter(task=>task.contributors.includes(resource.url)).length,findings,
      coverage:coverage?(coverage.usedBytes===0?"completely-unused":"measured"):"not-applicable" };
  });
  for(const file of files){
    if(file.type!=="Script"&&!/javascript|ecmascript/.test(file.mimeType||"")){file.priorityScore=0;file.priority="—";file.priorityReason="Not a JavaScript resource";continue;}
    const factors=[
      ["main-thread blocking",file.blockingMs*4],
      ["sampled CPU",file.cpuMs],
      ["V8 compile/parse",file.v8Ms*2],
      ["unused JavaScript",(file.unusedBytes||0)/2048]
    ].sort((a,b)=>b[1]-a[1]);
    file.priorityScore=Math.round(factors.reduce((sum,factor)=>sum+factor[1],0));
    file.priority=file.priorityScore>=500?"High":file.priorityScore>=100?"Medium":"Low";
    file.priorityReason=factors[0][1]>0?`${factors[0][0]} is the largest measured cost`:"No significant measured cost";
  }
  files.sort((a,b)=>b.transferBytes-a.transferBytes);
  const problems = js.map(s => ({ kind: "JavaScript", url: s.url, unusedBytes: s.unusedBytes, cpuMs: cpu.find(c => c.url === s.url)?.cpuMs || 0,
    longTasks: longTasks.filter(t => t.contributors.includes(s.url)).length }))
    .concat(css.map(s => ({ kind: "CSS", url: s.url, unusedBytes: s.unusedBytes, cpuMs: 0, longTasks: 0 })))
    .sort((a, b) => (b.unusedBytes + b.cpuMs * 1000 + b.longTasks * 50000) - (a.unusedBytes + a.cpuMs * 1000 + a.longTasks * 50000)).slice(0, 10);
  return { schemaVersion: 1, recording: raw.recording, summary: {
    totalResources: inventory.length, networkResources:resources.length, preExistingResources:inventory.length-resources.length, transferBytes: resources.reduce((n, r) => n + r.transferBytes, 0),
    jsResources: new Set([...networkJs.map(resource=>resource.url),...jsByUrl.keys()]).size, jsTransferBytes, jsTotalBytes, jsUsedBytes, jsUnusedBytes: jsTotalBytes - jsUsedBytes,
    completelyUnusedJs: [...jsByUrl.values()].filter(resource=>resource.totalBytes > 0 && resource.usedBytes === 0).length,
    cssResources: new Set([...resources.filter(resource=>resource.type==="Stylesheet"||/css/.test(resource.mimeType||"")).map(resource=>resource.url),...cssByUrl.keys()]).size, cssTotalBytes, cssUsedBytes, cssUnusedBytes: cssTotalBytes - cssUsedBytes,
    completelyUnusedCss: [...cssByUrl.values()].filter(resource=>resource.totalBytes > 0 && resource.usedBytes === 0).length,
    longTasks: longTasks.length, scriptsContributing: contributorUrls.size
  }, resources, files, js, css, cpu, longTasks, traceAnalysis, journey, problems };
}

export function compactRecording(report) {
  return { schemaVersion:report.schemaVersion,recording:report.recording,summary:report.summary,traceAnalysis:report.traceAnalysis,journey:report.journey,files:report.files };
}

const BASE64="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function decodeVlq(value,index){let result=0,shift=0,digit;do{digit=BASE64.indexOf(value[index++]);if(digit<0)return [0,index];result+=(digit&31)<<shift;shift+=5;}while(digit&32);const negative=result&1;return [negative?-(result>>1):result>>1,index];}
function sourceMapModules(map,generatedSource,usedRanges){
  if(!map?.mappings||!Array.isArray(map.sources))return [];
  const lineStarts=[0];for(let index=0;index<generatedSource.length;index++)if(generatedSource.charCodeAt(index)===10)lineStarts.push(index+1);
  let sourceIndex=0,originalLine=0,originalColumn=0,nameIndex=0;const segments=[];
  for(const [line,lineValue] of map.mappings.split(";").entries()){let generatedColumn=0;for(const encoded of lineValue.split(",")){if(!encoded)continue;let cursor=0,value;[value,cursor]=decodeVlq(encoded,cursor);generatedColumn+=value;if(cursor>=encoded.length)continue;[value,cursor]=decodeVlq(encoded,cursor);sourceIndex+=value;[value,cursor]=decodeVlq(encoded,cursor);originalLine+=value;[value,cursor]=decodeVlq(encoded,cursor);originalColumn+=value;if(cursor<encoded.length){[value,cursor]=decodeVlq(encoded,cursor);nameIndex+=value;}if(sourceIndex>=0&&sourceIndex<map.sources.length)segments.push({line,column:generatedColumn,sourceIndex});}}
  const overlapBytes=(start,end)=>{let total=0;for(const range of usedRanges){if(range.endOffset<=start)continue;if(range.startOffset>=end)break;const overlapStart=Math.max(start,range.startOffset),overlapEnd=Math.min(end,range.endOffset);if(overlapEnd>overlapStart)total+=byteLength(generatedSource.slice(overlapStart,overlapEnd));}return total;};
  const modules=new Map();for(let index=0;index<segments.length;index++){const segment=segments[index],start=(lineStarts[segment.line]??generatedSource.length)+segment.column,next=segments[index+1],lineEnd=segment.line+1<lineStarts.length?lineStarts[segment.line+1]:generatedSource.length,end=next&&next.line===segment.line?Math.min(lineEnd,lineStarts[segment.line]+next.column):lineEnd;if(end<=start)continue;const source=map.sources[segment.sourceIndex],item=modules.get(source)||{source,generatedBytes:0,usedGeneratedBytes:0,unusedGeneratedBytes:0,unusedPercent:0};item.generatedBytes+=byteLength(generatedSource.slice(start,end));item.usedGeneratedBytes+=overlapBytes(start,end);modules.set(source,item);}
  return [...modules.values()].map(item=>({...item,unusedGeneratedBytes:item.generatedBytes-item.usedGeneratedBytes,unusedPercent:item.generatedBytes?Math.round((item.generatedBytes-item.usedGeneratedBytes)/item.generatedBytes*100):0})).sort((a,b)=>b.unusedGeneratedBytes-a.unusedGeneratedBytes);
}

// Source bodies deliberately stay out of the compact report. They are persisted
// locally and requested only when the user opens a file, avoiding Chrome's 64 MiB
// extension-message ceiling on large applications.
export function coverageDetails(raw) {
  const scriptSources=new Map((raw.cdp.scripts||[]).map(item=>[item.scriptId,item.source||""]));
  const styleSources=new Map((raw.cdp.styleSheets||[]).map(item=>[item.styleSheetId,item.text||""]));
  const styleHeaders=new Map((raw.cdp.events||[]).filter(event=>event.method==="CSS.styleSheetAdded").map(event=>[event.params.header.styleSheetId,event.params.header]));
  const declaredMaps=new Map((raw.cdp.events||[]).filter(event=>event.method==="Debugger.scriptParsed"&&event.params.url&&event.params.sourceMapURL).map(event=>[cleanUrl(event.params.url),event.params.sourceMapURL]));
  const mapsByScript=new Map();for(const item of raw.cdp.sourceMaps||[]){if(!item.content)continue;try{const clean=item.content.replace(/^\)\]\}'[^\n]*\n/,"");mapsByScript.set(cleanUrl(item.scriptUrl),{url:item.url,map:JSON.parse(clean)});}catch{}}
  const details=[];
  for(const item of raw.cdp.jsCoverage||[]){
    if(!item.url)continue;const source=scriptSources.get(item.scriptId)||"";if(!source)continue;
    const ranges=effectiveUsedRanges((item.functions||[]).flatMap(fn=>fn.ranges||[]));
    const sourceMap=mapsByScript.get(cleanUrl(item.url)),modules=sourceMap?sourceMapModules(sourceMap.map,source,ranges):[];
    details.push({url:cleanUrl(item.url),kind:"JavaScript",source,usedRanges:ranges,sourceMapUrl:sourceMap?.url||declaredMaps.get(cleanUrl(item.url))||null,sourceMapStatus:sourceMap?(modules.length?"mapped":"map contained no usable module segments"):(declaredMaps.has(cleanUrl(item.url))?"declared but unavailable":"not declared"),originalModules:modules});
  }
  const cssUsed=new Map();
  for(const range of raw.cdp.cssCoverage||[]){if(!range.used)continue;if(!cssUsed.has(range.styleSheetId))cssUsed.set(range.styleSheetId,[]);cssUsed.get(range.styleSheetId).push({startOffset:range.startOffset,endOffset:range.endOffset});}
  for(const [styleSheetId,source] of styleSources){
    if(!source)continue;const header=styleHeaders.get(styleSheetId)||{},url=cleanUrl(header.sourceURL||header.ownerNode||`inline:${styleSheetId}`);
    details.push({url,kind:"CSS",source,usedRanges:mergeRanges(cssUsed.get(styleSheetId)||[])});
  }
  // Prefer the largest source if Chrome reported the same URL more than once.
  const byUrl=new Map();for(const detail of details){const current=byUrl.get(detail.url);if(!current||detail.source.length>current.source.length)byUrl.set(detail.url,detail);}
  return [...byUrl.values()];
}

export { basename };
