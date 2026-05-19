// background.js — MV3 service worker
// Routes messages between DevTools panel and content scripts.

'use strict';

const devtoolsPorts = new Map();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'gsap-inspector-devtools') return;

  let tabId = null;

  port.onMessage.addListener((msg) => {
    if (msg.type === 'devtools_connect') {
      tabId = msg.tabId;
      devtoolsPorts.set(tabId, port);
    } else if (tabId) {
      // Forward command from DevTools panel to the content script (bridge.js)
      chrome.tabs.sendMessage(tabId, msg).catch(() => {});
    }
  });

  port.onDisconnect.addListener(() => {
    if (tabId) devtoolsPorts.delete(tabId);
  });
});

// Forward messages from content scripts to the DevTools panel
chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab?.id;
  if (!tabId) return;
  const port = devtoolsPorts.get(tabId);
  if (port) {
    try {
      port.postMessage(msg);
    } catch (e) {
      // Panel may have closed; ignore
    }
  }
});
