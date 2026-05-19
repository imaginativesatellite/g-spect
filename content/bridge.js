// bridge.js — Content script running in the isolated world.
// Bridges communication between injected.js (MAIN world) and the background service worker.

'use strict';

// ── A. Inject injected.js into the MAIN world ─────────────────────────────────
(function injectScript() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('content/injected.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
})();

// ── B. Forward postMessages from injected.js to the background ────────────────
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data || !event.data.__gsap_inspector__) return;
  chrome.runtime.sendMessage(event.data);
});

// ── C. Forward commands from the background to injected.js ───────────────────
chrome.runtime.onMessage.addListener((msg) => {
  window.postMessage({ ...msg, __gsap_inspector_cmd__: true }, '*');
});
