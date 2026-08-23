const log = document.querySelector("#log");
const tabId = chrome.devtools.inspectedWindow.tabId;
const port = chrome.runtime.connect({ name: `repro:${tabId}` });
port.onMessage.addListener(message => { log.textContent += `${JSON.stringify(message)}\n`; });
document.querySelector("#start").onclick = () => {
  log.textContent = ""; port.postMessage({ type:"start", tabId });
  document.querySelector("#start").disabled = true; document.querySelector("#stop").disabled = false;
};
document.querySelector("#stop").onclick = () => {
  port.postMessage({ type:"stop", tabId }); document.querySelector("#stop").disabled = true;
  document.querySelector("#start").disabled = false;
};
if (chrome.devtools.performance) {
  const status = document.querySelector("#performance");
  status.textContent = "chrome.devtools.performance is available (notification-only).";
  chrome.devtools.performance.onProfilingStarted.addListener(() => { status.textContent = "Built-in Performance recording started."; });
  chrome.devtools.performance.onProfilingStopped.addListener(() => { status.textContent = "Built-in Performance recording stopped."; });
} else document.querySelector("#performance").textContent = "chrome.devtools.performance is unavailable in this Chrome version.";
