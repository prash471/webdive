import test from "node:test";
import assert from "node:assert/strict";
import { compactRecording, coverageDetails, normalizeRecording } from "../normalize.js";
const pick=(object,keys)=>Object.fromEntries(keys.map(key=>[key,object[key]]));

test("correlates requests, precise coverage, CPU samples, and trace attribution", () => {
  const url = "https://app.test/main.js";
  const raw = { recording:{name:"dashboard workflow"}, cdp:{
    events:[
      {method:"Network.requestWillBeSent",params:{requestId:"1",timestamp:1,type:"Script",request:{url}}},
      {method:"Network.responseReceived",params:{requestId:"1",type:"Script",response:{url,mimeType:"text/javascript",status:200}}},
      {method:"Network.dataReceived",params:{requestId:"1",dataLength:10000}},
      {method:"Network.loadingFinished",params:{requestId:"1",timestamp:1.25,encodedDataLength:8400}}
    ],
    scripts:[{scriptId:"7",source:"abcdefghij"}],
    jsCoverage:[{scriptId:"7",url,functions:[
      {ranges:[{startOffset:0,endOffset:10,count:1}]},
      {ranges:[{startOffset:2,endOffset:5,count:1},{startOffset:7,endOffset:10,count:0}]}
    ]}],
    cssCoverage:[],styleSheets:[],
    cpuProfile:{profile:{nodes:[{id:2,callFrame:{url}}],samples:[2,2],timeDeltas:[100000,30000]}},
    traceEvents:[
      {name:"RunTask",ph:"X",pid:1,tid:2,ts:1000,dur:61000,args:{}},
      {name:"EvaluateScript",ph:"X",pid:1,tid:2,ts:2000,dur:20000,args:{data:{url}}}
    ]
  }};
  const result = normalizeRecording(raw);
  assert.equal(result.summary.totalResources,1);
  assert.equal(result.summary.jsTransferBytes,8400);
  assert.equal(result.summary.jsUsedBytes,7,"nested unused function ranges override an executed parent script range");
  assert.equal(result.cpu[0].cpuMs,130);
  assert.equal(result.summary.longTasks,1);
  assert.equal(result.summary.scriptsContributing,1);
  assert.equal(result.problems[0].longTasks,1);
  assert.equal(result.traceAnalysis.mainThreadBusyMs,61);
  assert.equal(result.traceAnalysis.eventStats.find(x=>x.name==="RunTask").count,1);
  const expected={url,type:"Script",transferBytes:8400,decodedBytes:10000,downloadMs:250,totalBytes:10,usedBytes:7,unusedBytes:3,unusedPercent:30,cpuMs:130,cpuSamples:2,cpuPercent:100,jsInvocations:1,jsExecutionMs:20,blockingMs:11,longTasks:1,coverage:"measured"};
  assert.deepEqual(pick(result.files[0],Object.keys(expected)),expected);
});

test("keeps non-code resources in the file inventory with coverage marked not applicable",()=>{
  const url="https://x/hero.webp";
  const raw={recording:{name:"assets"},cdp:{events:[
    {method:"Network.requestWillBeSent",params:{requestId:"i",timestamp:1,type:"Image",request:{url}}},
    {method:"Network.responseReceived",params:{requestId:"i",type:"Image",response:{url,mimeType:"image/webp",status:200}}},
    {method:"Network.dataReceived",params:{requestId:"i",dataLength:2000}},
    {method:"Network.loadingFinished",params:{requestId:"i",timestamp:1.5,encodedDataLength:1200}}
  ],scripts:[],jsCoverage:[],cssCoverage:[],styleSheets:[],cpuProfile:{profile:{nodes:[]}},traceEvents:[]}};
  const result=normalizeRecording(raw);
  const expected={type:"Image",transferBytes:1200,totalBytes:2000,usedBytes:null,unusedPercent:null,coverage:"not-applicable"};
  assert.deepEqual(pick(result.files[0],Object.keys(expected)),expected);
});

test("counts unicode source in bytes and detects completely unused resources", () => {
  const raw={recording:{name:"unicode"},cdp:{events:[],scripts:[{scriptId:"1",source:"éé"}],jsCoverage:[{scriptId:"1",url:"https://x/u.js",functions:[{ranges:[{startOffset:0,endOffset:2,count:0}]}]}],cssCoverage:[],styleSheets:[],cpuProfile:{profile:{nodes:[]}},traceEvents:[]}};
  const result=normalizeRecording(raw);
  assert.equal(result.summary.jsTotalBytes,4);
  assert.equal(result.summary.jsUnusedBytes,4);
  assert.equal(result.summary.completelyUnusedJs,1);
});

test("includes pre-existing scripts from coverage when no network request occurs",()=>{
  const url="https://app.test/already-loaded.js",raw={recording:{name:"warm journey"},cdp:{events:[],scripts:[{scriptId:"old",source:"function action(){return 1} action();"}],jsCoverage:[{scriptId:"old",url,functions:[{ranges:[{startOffset:0,endOffset:37,count:1}]}]}],cssCoverage:[],styleSheets:[],traceEvents:[]}};
  const result=normalizeRecording(raw),file=result.files.find(item=>item.url===url);
  assert.ok(file);
  assert.equal(file.loadContext,"Loaded before recording");
  assert.equal(file.networkObserved,false);
  assert.equal(file.transferBytes,0);
  assert.equal(file.usedBytes,file.totalBytes);
  assert.equal(result.summary.networkResources,0);
  assert.equal(result.summary.preExistingResources,1);
});

test("normalizes traces larger than the JavaScript function argument limit",()=>{
  const traceEvents=Array.from({length:150000},(_,index)=>({name:"Synthetic",ph:"X",pid:1,tid:1,ts:index*10,dur:5,args:{}}));
  const raw={recording:{name:"large trace"},cdp:{events:[],scripts:[],jsCoverage:[],cssCoverage:[],styleSheets:[],cpuProfile:{profile:{nodes:[]}},traceEvents}};
  const result=normalizeRecording(raw);
  assert.equal(result.traceAnalysis.durationMs,(149999*10+5)/1000);
  const compact=compactRecording(result);
  assert.deepEqual(Object.keys(compact),["schemaVersion","recording","summary","traceAnalysis","journey","files"]);
  assert.equal("longTasks" in compact,false);
});

test("derives per-resource CPU samples from trace ProfileChunk events",()=>{
  const url="https://x/app.js";
  const raw={recording:{name:"trace cpu"},cdp:{events:[],scripts:[],jsCoverage:[],cssCoverage:[],styleSheets:[],traceEvents:[{name:"ProfileChunk",ph:"I",ts:1,pid:1,tid:1,args:{data:{cpuProfile:{nodes:[{id:7,callFrame:{url}}],samples:[7,7]},timeDeltas:[10000,20000]}}}]}};
  const result=normalizeRecording(raw);
  assert.deepEqual(result.cpu,[{url,cpuMs:30,cpuSamples:2,cpuPercent:100}]);
});

test("correlates manual journey phases and automatic interaction markers",()=>{
  const script="https://app.test/checkout.js",raw={recording:{name:"checkout",startedAt:1000,stoppedAt:4000,markers:[{name:"Checkout",atMs:1000,kind:"manual"}]},cdp:{events:[
    {method:"Network.requestWillBeSent",params:{requestId:"1",timestamp:11.2,type:"Script",request:{url:script}}},
    {method:"Network.loadingFinished",params:{requestId:"1",timestamp:11.3,encodedDataLength:2048}}
  ],scripts:[],jsCoverage:[],cssCoverage:[],styleSheets:[],traceEvents:[
    {name:"RunTask",ph:"X",pid:1,tid:1,ts:10000000,dur:20000,args:{}},
    {name:"EventDispatch",ph:"X",pid:1,tid:1,ts:11000000,dur:5000,args:{data:{type:"click"}}},
    {name:"RunTask",ph:"X",pid:1,tid:1,ts:11000000,dur:80000,args:{}},
    {name:"FunctionCall",ph:"X",pid:1,tid:1,ts:11010000,dur:30000,args:{data:{url:script}}}
  ]}};
  const journey=normalizeRecording(raw).journey;
  assert.deepEqual(journey.phases.map(phase=>phase.name),["Initial","Checkout"]);
  assert.equal(journey.phases[1].requestCount,1);
  assert.equal(journey.phases[1].longTasks,1);
  assert.equal(journey.interactions[0].type,"click");
  assert.equal(journey.interactions[0].jsExecutionMs,30);
  assert.equal(journey.interactions[0].topScripts[0].url,script);
});

test("preserves per-file source and used ranges outside the compact report",()=>{
  const raw={cdp:{scripts:[{scriptId:"1",source:"function used(){} function idle(){}"}],jsCoverage:[{scriptId:"1",url:"https://example.test/app.js",functions:[{ranges:[{startOffset:0,endOffset:17,count:1}]}]}],styleSheets:[],cssCoverage:[],events:[]}};
  const [detail]=coverageDetails(raw);
  assert.equal(detail.source,"function used(){} function idle(){}");
  assert.deepEqual(detail.usedRanges,[{startOffset:0,endOffset:17}]);
});

test("attributes generated coverage to original source-map modules",()=>{
  const url="https://example.test/app.js",raw={cdp:{scripts:[{scriptId:"1",source:"abcdef"}],jsCoverage:[{scriptId:"1",url,functions:[{ranges:[{startOffset:0,endOffset:3,count:1}]}]}],sourceMaps:[{scriptUrl:url,url:`${url}.map`,content:JSON.stringify({version:3,sources:["src/app.ts"],names:[],mappings:"AAAA"})}],styleSheets:[],cssCoverage:[],events:[{method:"Debugger.scriptParsed",params:{scriptId:"1",url,sourceMapURL:"app.js.map"}}]}};
  const [detail]=coverageDetails(raw);
  assert.equal(detail.sourceMapStatus,"mapped");
  assert.deepEqual(detail.originalModules,[{source:"src/app.ts",generatedBytes:6,usedGeneratedBytes:3,unusedGeneratedBytes:3,unusedPercent:50}]);
});
