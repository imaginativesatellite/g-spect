// devtools.js — Creates the GSAP Inspector panel in Chrome DevTools.

chrome.devtools.panels.create(
  'GSAP Inspector',
  '../icons/icon16.svg',
  '../panel/panel.html',
  (panel) => {
    panel.onShown.addListener((win) => {
      // Panel is now visible — no extra setup needed here
    });
  }
);
