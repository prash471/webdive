import { autoStopStatus, captureEvent, detached, markJourneyPhase, recordingStatus, startRecording, stopRecording } from "./protocol.js";
import { compactRecording, coverageDetails, normalizeRecording } from "./normalize.js";

chrome.debugger.onEvent.addListener(captureEvent);
chrome.debugger.onDetach.addListener(detached);

const openDetailsDb=()=>new Promise((resolve,reject)=>{const request=indexedDB.open("weblens-reports",2);request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains("coverage"))db.createObjectStore("coverage",{keyPath:"id"});if(!db.objectStoreNames.contains("recordings"))db.createObjectStore("recordings",{keyPath:"id"});};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
async function persistCoverage(recordingId,details){const db=await openDetailsDb();await new Promise((resolve,reject)=>{const transaction=db.transaction("coverage","readwrite"),store=transaction.objectStore("coverage");for(const detail of details)store.put({...detail,id:`${recordingId}:${detail.url}`,recordingId});transaction.oncomplete=resolve;transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error||new Error("Coverage storage was aborted"));});db.close();return new Set(details.map(detail=>detail.url));}
async function readCoverage(recordingId,url){const db=await openDetailsDb();const result=await new Promise((resolve,reject)=>{const request=db.transaction("coverage").objectStore("coverage").get(`${recordingId}:${url}`);request.onsuccess=()=>resolve(request.result||null);request.onerror=()=>reject(request.error);});db.close();if(result)delete result.id;return result;}
async function saveRecording(report){const db=await openDetailsDb();await new Promise((resolve,reject)=>{const transaction=db.transaction("recordings","readwrite");transaction.objectStore("recordings").put({id:report.recording.startedAt,report});transaction.oncomplete=resolve;transaction.onerror=()=>reject(transaction.error);});db.close();}
async function listRecordings(){const db=await openDetailsDb();const rows=await new Promise((resolve,reject)=>{const request=db.transaction("recordings").objectStore("recordings").getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});db.close();return rows.map(({id,report})=>({id,name:report.recording.name,startedAt:report.recording.startedAt,stoppedAt:report.recording.stoppedAt,resources:report.summary.totalResources})).sort((a,b)=>b.startedAt-a.startedAt);}
async function loadRecording(id){const db=await openDetailsDb();const row=await new Promise((resolve,reject)=>{const request=db.transaction("recordings").objectStore("recordings").get(id);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});db.close();return row?.report||null;}
async function deleteRecording(id){const db=await openDetailsDb();await new Promise((resolve,reject)=>{const transaction=db.transaction(["recordings","coverage"],"readwrite");transaction.objectStore("recordings").delete(id);const request=transaction.objectStore("coverage").openCursor();request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;if(cursor.value.recordingId===id)cursor.delete();cursor.continue();};transaction.oncomplete=resolve;transaction.onerror=()=>reject(transaction.error);});db.close();return true;}

const operationFor=(message,progress)=>message.type === "START" ? startRecording(message.tabId, message.name, message.conditions) :
  message.type === "MARK_PHASE" ? Promise.resolve(markJourneyPhase(message.tabId,message.name)) :
  message.type === "STOP" ? (async()=>{const raw=await stopRecording(message.tabId,progress);progress(94,"Saving per-file coverage details locally");let detailUrls=new Set(),details=[];try{details=coverageDetails(raw);detailUrls=await persistCoverage(raw.recording.startedAt,details);}catch(error){console.warn("Could not persist coverage details",error);}progress(96,"Correlating resources, coverage, CPU, and trace events");await new Promise(resolve=>setTimeout(resolve,0));const report=compactRecording(normalizeRecording(raw)),detailByUrl=new Map(details.map(detail=>[detail.url,detail]));for(const file of report.files){const detail=detailByUrl.get(file.url);file.detailAvailable=detailUrls.has(file.url);file.sourceMapStatus=detail?.sourceMapStatus||"not applicable";file.originalModuleCount=detail?.originalModules?.length||0;}progress(98,"Saving recording to local history");await saveRecording(report);progress(99,"Sending compact report to the panel");return report;})() :
  message.type === "GET_FILE_DETAIL" ? readCoverage(message.recordingId,message.url) :
  message.type === "LIST_RECORDINGS" ? listRecordings() :
  message.type === "LOAD_RECORDING" ? loadRecording(message.recordingId) :
  message.type === "DELETE_RECORDING" ? deleteRecording(message.recordingId) :
  message.type === "IMPORT_RECORDING" ? saveRecording(message.report).then(()=>true) :
  message.type === "IMPORT_FILE_DETAIL" ? persistCoverage(message.recordingId,[message.detail]).then(()=>true) :
  message.type === "AUTO_STATUS" ? Promise.resolve(autoStopStatus(message.tabId)) :
  message.type === "STATUS" ? Promise.resolve(recordingStatus(message.tabId)) : null;

// A DevTools Port is intentionally used for long STOP operations. A one-shot
// sendMessage response channel can be closed while Chrome is draining a large
// trace or coverage result, producing the misleading "returned true" error.
chrome.runtime.onConnect.addListener(port=>{
  if(port.name!=="weblens-panel")return;
  port.onMessage.addListener(message=>{
    if(message.type==="KEEPALIVE")return;
    const progress=(percent,label)=>{try{port.postMessage({type:"PROGRESS",tabId:message.tabId,percent,label});}catch{}};
    const operation=operationFor(message,progress);
    if(!operation){port.postMessage({type:"RESPONSE",id:message.id,ok:false,error:"Unknown command"});return;}
    operation.then(data=>{try{port.postMessage({type:"RESPONSE",id:message.id,ok:true,data});}catch{}},error=>{try{port.postMessage({type:"RESPONSE",id:message.id,ok:false,error:error?.message||String(error)});}catch{}});
  });
});
