// devtools.js — Creates the G-spect panel in Chrome DevTools.

chrome.devtools.panels.create(
  'G-spect',
  '../icons/icon16.svg',
  '../panel/panel.html',
  (panel) => {
    panel.onShown.addListener((win) => {
      // Panel is now visible — no extra setup needed here
    });
  }
);
