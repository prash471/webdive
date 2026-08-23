import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { compactRecording, normalizeRecording } from "../normalize.js";

const path=process.argv[2];
if(!path)throw new Error("Usage: node scripts/benchmark-trace.mjs trace.json[.gz]");
const started=performance.now();
const compressed=readFileSync(path);
const json=path.endsWith(".gz")?gunzipSync(compressed):compressed;
const parsed=JSON.parse(json.toString("utf8"));
const traceEvents=parsed.traceEvents||parsed;
if(!Array.isArray(traceEvents))throw new Error("Trace does not contain a traceEvents array.");
const parsedAt=performance.now();
const raw={recording:{name:"trace benchmark"},cdp:{events:[],scripts:[],jsCoverage:[],cssCoverage:[],styleSheets:[],traceEvents}};
const full=normalizeRecording(raw);
const compact=compactRecording(full);
const finished=performance.now();
const memory=process.memoryUsage();
const output={
  compressedBytes:compressed.length,uncompressedBytes:json.length,traceEvents:traceEvents.length,
  profileChunks:traceEvents.filter(event=>event.name==="ProfileChunk").length,
  parseMs:Math.round(parsedAt-started),normalizeMs:Math.round(finished-parsedAt),
  heapUsedMB:Math.round(memory.heapUsed/1048576),rssMB:Math.round(memory.rss/1048576),
  compactReportBytes:Buffer.byteLength(JSON.stringify(compact)),
  longTasks:compact.summary.longTasks,cpuAttributedResources:full.cpu.length,
  traceDurationMs:Math.round(compact.traceAnalysis.durationMs),eventStatTypes:compact.traceAnalysis.eventStats.length
};
process.stdout.write(`${JSON.stringify(output,null,2)}\n`);
