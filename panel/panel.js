// panel.js — Main logic for the GSAP Inspector DevTools panel.
// Loaded as an ES module from panel.html.

import { TimelineView } from './timeline-view.js';
import { runLinter } from '../rules/gsap-linter.js';

// ── Connection setup ──────────────────────────────────────────────────────────
const port = chrome.runtime.connect({ name: 'gsap-inspector-devtools' });
port.postMessage({
  type: 'devtools_connect',
  tabId: chrome.devtools.inspectedWindow.tabId,
});

let lastData = null;
let injectHistory = [];
let timelineView = null;
let currentView = 'list';

port.onMessage.addListener((msg) => {
  switch (msg.type) {
    case 'inspection_data':
      handleInspectionData(msg.payload);
      break;
    case 'gsap_not_found':
      showNotFound();
      break;
    case 'inject_result':
      showInjectResult(msg);
      break;
    case 'reset_complete':
      // Give the kill command a moment to execute, then reload the inspected page
      setTimeout(() => {
        chrome.devtools.inspectedWindow.eval('window.location.reload()');
      }, 300);
      break;
    default:
      break;
  }
});

// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    document.querySelectorAll('.tab-content').forEach((c) =>
      c.classList.remove('active')
    );

    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    const panel = document.getElementById(`tab-${tab.dataset.tab}`);
    if (panel) panel.classList.add('active');

    // Trigger lazy renders
    if (tab.dataset.tab === 'animations' && currentView === 'timeline' && lastData) {
      renderTimelineView(lastData);
    }
    if (tab.dataset.tab === 'linter' && lastData) {
      renderLinter(lastData);
    }
    if (tab.dataset.tab === 'overrides') {
      renderOverrides();
    }
  });
});

// ── View toggle (List / Timeline) ─────────────────────────────────────────────
document.getElementById('btn-list-view').addEventListener('click', () => {
  currentView = 'list';
  document.getElementById('btn-list-view').classList.add('active');
  document.getElementById('btn-timeline-view').classList.remove('active');
  document.getElementById('anim-list-view').style.display = '';
  document.getElementById('anim-timeline-view').style.display = 'none';
});

document.getElementById('btn-timeline-view').addEventListener('click', () => {
  currentView = 'timeline';
  document.getElementById('btn-timeline-view').classList.add('active');
  document.getElementById('btn-list-view').classList.remove('active');
  document.getElementById('anim-list-view').style.display = 'none';
  document.getElementById('anim-timeline-view').style.display = '';
  if (lastData) renderTimelineView(lastData);
});

// ── Data rendering ────────────────────────────────────────────────────────────
function handleInspectionData(data) {
  lastData = data;
  document.getElementById('gsap-not-found').style.display = 'none';
  document.getElementById('overview-content').style.display = '';

  renderOverview(data);
  renderAnimations(data);
  renderScrollTriggers(data);

  // Auto-run linter if on linter tab
  const linterTab = document.querySelector('.tab[data-tab="linter"]');
  if (linterTab && linterTab.classList.contains('active')) {
    renderLinter(data);
  }
}

function showNotFound() {
  document.getElementById('gsap-not-found').style.display = '';
  document.getElementById('overview-content').style.display = 'none';
}

// ── Overview tab ──────────────────────────────────────────────────────────────
function renderOverview(data) {
  // Version badge in header
  const versionBadge = document.getElementById('gsap-version-badge');
  if (data.version) {
    versionBadge.textContent = `GSAP ${data.version}`;
    versionBadge.style.display = '';
    versionBadge.className = `badge ${data.isGSAP3 ? 'badge-gsap3' : 'badge-gsap2'}`;
  } else {
    versionBadge.style.display = 'none';
  }

  document.getElementById('ov-version').textContent = data.version || 'Unknown';

  // Platform
  const platform = data.isWebflow ? 'Webflow' : 'Custom site';
  document.getElementById('ov-platform').textContent = platform;

  const webflowBadge = document.getElementById('webflow-badge');
  webflowBadge.style.display = data.isWebflow ? '' : 'none';

  document.getElementById('ov-anim-count').textContent = data.animations.length;
  document.getElementById('ov-st-count').textContent = data.scrollTriggers.length;

  // Plugins
  const pluginList = document.getElementById('ov-plugins');
  if (!data.plugins || data.plugins.length === 0) {
    pluginList.innerHTML =
      '<span class="text-secondary">No plugins detected (core GSAP only)</span>';
  } else {
    pluginList.innerHTML = data.plugins
      .map((p) => {
        const tip = PLUGIN_TOOLTIPS[p] || `${p} plugin`;
        return `<span class="badge badge-plugin" data-tooltip="${tip}">${p}</span>`;
      })
      .join('');
  }

  // ix2 conflict warning
  document.getElementById('ix2-warning').style.display =
    data.hasIx2 ? '' : 'none';
}

const PLUGIN_TOOLTIPS = {
  ScrollTrigger:
    'Links GSAP animations to the scroll position. The most widely used GSAP plugin.',
  Draggable:
    'Makes any element draggable, spinnable, or throwable with momentum.',
  Flip: 'Animates elements between two layout states (FLIP = First, Last, Invert, Play).',
  SplitText:
    'Splits text into individual chars/words/lines so each can be animated independently. Club GSAP.',
  MorphSVGPlugin: 'Morphs one SVG path into another. Club GSAP.',
  DrawSVGPlugin:
    'Animates SVG strokes as if they are being drawn. Club GSAP.',
  MotionPathPlugin: 'Animates elements along an SVG path.',
  Observer:
    'Unified listener for scroll, touch, pointer, and wheel events.',
  ScrollToPlugin: 'Animates the scroll position of a container or window.',
  TextPlugin: 'Animates text character by character.',
  GSDevTools:
    'Interactive animation debugger (a separate UI tool). Club GSAP.',
  EaselPlugin:
    'Integrates with EaselJS / CreateJS for canvas-based animations.',
  PixiPlugin: 'Integrates with PixiJS for WebGL-accelerated animations.',
};

// ── Animations tab ────────────────────────────────────────────────────────────
function renderAnimations(data) {
  const list = document.getElementById('anim-list');

  if (!data.animations.length) {
    list.innerHTML =
      '<div class="empty-state">No animations detected. GSAP animations will appear here once they are created.</div>';
    if (currentView === 'timeline') renderTimelineView(data);
    return;
  }

  list.innerHTML = '';

  data.animations
    .filter((a) => a.depth <= 1)
    .forEach((anim) => {
      const item = document.createElement('div');
      item.className = 'anim-item';
      item.dataset.id = anim.id;

      const stateClass = anim.paused
        ? 'dot-paused'
        : anim.progress >= 1
        ? 'dot-complete'
        : 'dot-active';
      const stateLabel = anim.paused
        ? 'Paused'
        : anim.progress >= 1
        ? 'Complete'
        : 'Playing';

      const scrollTag = anim.isScrollLinked
        ? '<span class="badge badge-scroll" data-tooltip="This animation\'s progress is controlled by scroll position, not clock time.">scroll</span>'
        : '';

      const typeIcon = anim.type === 'timeline' ? '⏱' : '▶';

      const propSummary =
        Object.keys(anim.vars)
          .filter(
            (k) =>
              !['ease', 'duration', 'delay', 'repeat', 'yoyo', 'stagger'].includes(k)
          )
          .join(', ') || 'no props';

      const durTooltip =
        'Total duration of this animation in seconds. Does not apply to scroll-linked animations.';
      const easeTooltip =
        'The easing function controlling acceleration/deceleration. &quot;power2.out&quot; starts fast and decelerates. &quot;none&quot; is linear. &quot;elastic&quot; overshoots and bounces back.';

      item.innerHTML = `
        <div class="anim-row-top">
          <span class="dot ${stateClass}" data-tooltip="Animation state: ${stateLabel}"></span>
          <span class="anim-type">${typeIcon}</span>
          <span class="anim-target">${escapeHtml(anim.targetSelector || 'anonymous')}</span>
          ${scrollTag}
          <span class="anim-props text-secondary">${escapeHtml(propSummary)}</span>
          <span class="anim-duration text-secondary" data-tooltip="${durTooltip}">${anim.duration.toFixed(2)}s</span>
          <span class="anim-ease text-secondary" data-tooltip="${easeTooltip}">${escapeHtml(anim.vars.ease || 'default')}</span>
        </div>
        <div class="anim-controls">
          <button class="btn btn-icon anim-btn" data-cmd="anim_restart" data-id="${anim.id}"
            data-tooltip="Restart this animation from the beginning.">⏮</button>
          <button class="btn btn-icon anim-btn" data-cmd="anim_play" data-id="${anim.id}"
            data-tooltip="Play / resume this animation.">▶</button>
          <button class="btn btn-icon anim-btn" data-cmd="anim_pause" data-id="${anim.id}"
            data-tooltip="Pause this animation at its current position.">⏸</button>
          <button class="btn btn-icon anim-btn" data-cmd="anim_reverse" data-id="${anim.id}"
            data-tooltip="Play this animation in reverse from its current position.">◀</button>
          <input type="range" class="scrub-range anim-scrub" min="0" max="1" step="0.01"
            value="${anim.progress}" data-id="${anim.id}"
            data-tooltip="Drag to scrub this animation's progress from 0 (start) to 1 (end).">
          <button class="btn btn-sm edit-btn" data-id="${anim.id}"
            data-tooltip="Open the property editor to change this tween's animation values live.">Edit</button>
        </div>
      `;

      list.appendChild(item);
    });

  // Attach event handlers for animation controls
  list.querySelectorAll('.anim-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      sendCommand({ command: btn.dataset.cmd, id: btn.dataset.id });
    });
  });

  list.querySelectorAll('.anim-scrub').forEach((input) => {
    input.addEventListener('input', () => {
      sendCommand({
        command: 'anim_set_progress',
        id: input.dataset.id,
        value: parseFloat(input.value),
      });
    });
  });

  list.querySelectorAll('.edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const anim = data.animations.find((a) => a.id === btn.dataset.id);
      if (anim) openPropEditor(anim);
    });
  });

  if (currentView === 'timeline') {
    renderTimelineView(data);
  }
}

function renderTimelineView(data) {
  const container = document.getElementById('timeline-container');
  if (!timelineView) {
    timelineView = new TimelineView(container);
  }
  timelineView.render(data.animations, data.scrollTriggers);
}

// ── ScrollTrigger tab ─────────────────────────────────────────────────────────
function renderScrollTriggers(data) {
  const list = document.getElementById('st-list');

  if (!data.scrollTriggers.length) {
    list.innerHTML =
      '<div class="empty-state">No ScrollTrigger instances detected. ScrollTrigger must be loaded, registered, and have instances created to appear here.</div>';
    return;
  }

  list.innerHTML = '';

  data.scrollTriggers.forEach((st) => {
    const item = document.createElement('div');
    item.className = 'st-item';

    const scrubLabel =
      st.scrub === true
        ? 'yes'
        : st.scrub === false
        ? 'no'
        : `${st.scrub}s lag`;
    const progressPct = Math.round(st.progress * 100);

    const activeTooltip =
      'Active means the scroll position is currently inside this trigger\'s start/end range.';
    const progressTooltip =
      'How far through this trigger the current scroll position is. 0% = at start position, 100% = at end position.';
    const startTooltip =
      'The scroll position where this trigger activates. Format: \'elementEdge viewportEdge\', e.g. \'top center\' = when the top of the trigger element reaches the center of the viewport.';
    const endTooltip =
      'The scroll position where this trigger deactivates. Same format as start.';
    const scrubTooltip =
      'Scrub connects animation progress to scroll position. Without scrub, the animation plays when the trigger is hit. With scrub, dragging the scroll bar drags the animation.';
    const pinTooltip =
      'Pin fixes the trigger element in place while the scroll continues, creating a sticky scroll effect.';
    const invalidateTooltip =
      'Warning: without invalidateOnRefresh, animation values bake in at page load and won\'t update on resize. Add invalidateOnRefresh: true.';
    const markerTooltip =
      'Show/hide scroll marker lines for this specific trigger. Markers show the start and end scroll positions on the page.';

    const pinDetail = st.pin
      ? `<span class="st-detail" data-tooltip="${pinTooltip}">pin: <code>yes</code></span>`
      : '';
    const invalidateWarn =
      !st.invalidateOnRefresh && st.scrub !== false
        ? `<span class="st-detail lint-warn-inline" data-tooltip="${invalidateTooltip}">⚠ no invalidateOnRefresh</span>`
        : '';

    item.innerHTML = `
      <div class="st-row-top">
        <span class="dot ${st.isActive ? 'dot-active' : 'dot-paused'}"
          data-tooltip="${activeTooltip}"></span>
        <span class="st-trigger">${escapeHtml(st.triggerSelector || 'anonymous')}</span>
        <span class="badge ${st.scrub ? 'badge-scroll' : ''}"
          data-tooltip="${scrubTooltip}">${st.scrub ? 'scrub' : 'trigger'}</span>
        <span class="st-progress text-secondary"
          data-tooltip="${progressTooltip}">${progressPct}%</span>
      </div>
      <div class="st-details">
        <span class="st-detail" data-tooltip="${startTooltip}">start: <code>${escapeHtml(st.start)}</code></span>
        <span class="st-detail" data-tooltip="${endTooltip}">end: <code>${escapeHtml(st.end)}</code></span>
        <span class="st-detail" data-tooltip="${scrubTooltip}">scrub: <code>${scrubLabel}</code></span>
        ${pinDetail}
        ${invalidateWarn}
      </div>
      <div class="st-controls">
        <label class="toggle-row" data-tooltip="${markerTooltip}">
          Markers
          <span class="toggle-switch">
            <input type="checkbox" class="st-markers-toggle" data-id="${st.id}" ${st.markers ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </span>
        </label>
      </div>
    `;

    list.appendChild(item);
  });

  list.querySelectorAll('.st-markers-toggle').forEach((toggle) => {
    toggle.addEventListener('change', () => {
      sendCommand({
        command: 'toggle_markers_one',
        id: toggle.dataset.id,
        value: toggle.checked,
      });
    });
  });
}

// ── Linter tab ────────────────────────────────────────────────────────────────
function renderLinter(data) {
  const container = document.getElementById('lint-results');
  const results = runLinter(data);

  if (!results.length) {
    container.innerHTML =
      '<div class="empty-state lint-pass">✓ No issues found. Looks good!</div>';
    return;
  }

  const errors   = results.filter((r) => r.severity === 'error');
  const warnings = results.filter((r) => r.severity === 'warning');
  const tips     = results.filter((r) => r.severity === 'tip');

  // Build summary bar
  let summaryHtml = '<div class="lint-summary">';
  if (errors.length) {
    summaryHtml += `<span class="lint-count error">${errors.length} error${errors.length > 1 ? 's' : ''}</span>`;
  }
  if (warnings.length) {
    summaryHtml += `<span class="lint-count warning">${warnings.length} warning${warnings.length > 1 ? 's' : ''}</span>`;
  }
  if (tips.length) {
    summaryHtml += `<span class="lint-count tip">${tips.length} tip${tips.length > 1 ? 's' : ''}</span>`;
  }
  summaryHtml += '</div>';

  container.innerHTML = summaryHtml;

  results.forEach((r) => {
    const item = document.createElement('div');
    item.className = `lint-item lint-${r.severity}`;
    const icon =
      r.severity === 'error'
        ? '✕'
        : r.severity === 'warning'
        ? '⚠'
        : '💡';
    item.innerHTML = `
      <div class="lint-item-header">
        <span class="lint-icon">${icon}</span>
        <strong>${escapeHtml(r.title)}</strong>
      </div>
      <p class="lint-desc">${escapeHtml(r.description)}</p>
      ${r.fix ? `<div class="lint-fix"><strong>Fix:</strong> ${escapeHtml(r.fix)}</div>` : ''}
    `;
    container.appendChild(item);
  });
}

// ── Overrides tab ─────────────────────────────────────────────────────────────
function renderOverrides() {
  chrome.storage.local.get(null, (items) => {
    const overrides = Object.entries(items).filter(([k]) =>
      k.startsWith('override_')
    );
    const list = document.getElementById('overrides-list');

    if (!overrides.length) {
      list.innerHTML =
        '<div class="empty-state">No saved overrides yet. Use the Code tab to inject and save JavaScript for any URL.</div>';
      return;
    }

    list.innerHTML = '';
    overrides.forEach(([key, data]) => {
      const url = key.replace('override_', '');
      const item = document.createElement('div');
      item.className = 'override-item';

      const preview =
        data.code.length > 200
          ? data.code.slice(0, 200) + '…'
          : data.code;

      item.innerHTML = `
        <div class="override-url">${escapeHtml(url)}</div>
        <pre class="override-code">${escapeHtml(preview)}</pre>
        <div class="override-actions">
          <label data-tooltip="When enabled, this code runs automatically every time you visit this URL, after GSAP loads.">
            <input type="checkbox" class="override-active" data-key="${escapeHtml(key)}" ${data.active ? 'checked' : ''}>
            Auto-apply
          </label>
          <button class="btn btn-danger override-delete" data-key="${escapeHtml(key)}">Delete</button>
        </div>
      `;

      list.appendChild(item);
    });

    list.querySelectorAll('.override-active').forEach((cb) => {
      cb.addEventListener('change', () => {
        const storageKey = cb.dataset.key;
        chrome.storage.local.get(storageKey, (stored) => {
          const d = stored[storageKey];
          if (d) {
            chrome.storage.local.set({ [storageKey]: { ...d, active: cb.checked } });
          }
        });
      });
    });

    list.querySelectorAll('.override-delete').forEach((btn) => {
      btn.addEventListener('click', () => {
        chrome.storage.local.remove(btn.dataset.key, () => renderOverrides());
      });
    });
  });
}

// ── Global playback controls ──────────────────────────────────────────────────
document.getElementById('btn-play-all').addEventListener('click', () =>
  sendCommand({ command: 'play_all' })
);
document.getElementById('btn-pause-all').addEventListener('click', () =>
  sendCommand({ command: 'pause_all' })
);
document.getElementById('btn-reverse-all').addEventListener('click', () =>
  sendCommand({ command: 'reverse_all' })
);
document.getElementById('btn-restart-all').addEventListener('click', () =>
  sendCommand({ command: 'restart_all' })
);

document.getElementById('global-scrub').addEventListener('input', (e) => {
  sendCommand({ command: 'set_progress', value: parseFloat(e.target.value) });
});

document.querySelectorAll('.speed-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.speed-btn').forEach((b) =>
      b.classList.remove('active')
    );
    btn.classList.add('active');
    sendCommand({ command: 'set_timescale', value: parseFloat(btn.dataset.speed) });
  });
});

// ── ScrollTrigger global controls ─────────────────────────────────────────────
document.getElementById('markers-all').addEventListener('change', (e) => {
  sendCommand({ command: 'toggle_markers_all', value: e.target.checked });
});

document.getElementById('btn-st-refresh').addEventListener('click', () => {
  sendCommand({
    command: 'inject_js',
    code: 'if (window.ScrollTrigger) ScrollTrigger.refresh();',
  });
});

// ── Reset button ──────────────────────────────────────────────────────────────
document.getElementById('btn-reset').addEventListener('click', () => {
  if (
    confirm(
      'Kill all GSAP animations, clear saved overrides for this URL, and reload the page?'
    )
  ) {
    chrome.devtools.inspectedWindow.eval('window.location.href', (pageUrl) => {
      chrome.storage.local.remove(`override_${pageUrl}`, () => {
        sendCommand({ command: 'reset_all' });
        // Panel message handler will reload after reset_complete arrives
        // Fallback reload in case reset_complete never fires
        setTimeout(() => {
          chrome.devtools.inspectedWindow.eval('window.location.reload()');
        }, 800);
      });
    });
  }
});

// ── Code injection ────────────────────────────────────────────────────────────
document.getElementById('btn-inject-js').addEventListener('click', () => {
  const code = document.getElementById('js-editor').value.trim();
  if (!code) return;
  sendCommand({ command: 'inject_js', code });
  addToHistory('js', code);
});

document.getElementById('btn-inject-css').addEventListener('click', () => {
  const code = document.getElementById('css-editor').value.trim();
  if (!code) return;
  sendCommand({ command: 'inject_css', code });
  addToHistory('css', code);
  // Show result in CSS result area
  const cssResult = document.getElementById('css-inject-result');
  cssResult.style.display = '';
  cssResult.className = 'inject-result success';
  cssResult.textContent = '✓ CSS injected into page';
  setTimeout(() => { cssResult.style.display = 'none'; }, 4000);
});

document.getElementById('btn-save-js').addEventListener('click', () => {
  const code = document.getElementById('js-editor').value.trim();
  if (!code) return;
  chrome.devtools.inspectedWindow.eval('window.location.href', (pageUrl) => {
    chrome.storage.local.set(
      {
        [`override_${pageUrl}`]: {
          code,
          active: true,
          savedAt: Date.now(),
        },
      },
      () => {
        showInjectResult({
          success: true,
          message: `Saved for ${pageUrl}`,
        });
      }
    );
  });
});

document.getElementById('btn-copy-webflow').addEventListener('click', () => {
  const code = document.getElementById('js-editor').value.trim();
  if (!code) return;
  const snippet = `<script>\n${code}\n<\/script>`;
  navigator.clipboard
    .writeText(snippet)
    .then(() => {
      showInjectResult({
        success: true,
        message: 'Copied! Paste into Webflow → Page Settings → Before </body>',
      });
    })
    .catch((err) => {
      showInjectResult({ success: false, error: `Clipboard error: ${err.message}` });
    });
});

// ── Overrides management ──────────────────────────────────────────────────────
document.getElementById('btn-export-overrides').addEventListener('click', () => {
  chrome.storage.local.get(null, (items) => {
    const overrides = Object.fromEntries(
      Object.entries(items).filter(([k]) => k.startsWith('override_'))
    );
    const blob = new Blob([JSON.stringify(overrides, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'gsap-inspector-overrides.json';
    a.click();
    URL.revokeObjectURL(url);
  });
});

document.getElementById('btn-clear-all-overrides').addEventListener('click', () => {
  if (confirm('Delete ALL saved overrides for ALL URLs?')) {
    chrome.storage.local.get(null, (items) => {
      const keys = Object.keys(items).filter((k) => k.startsWith('override_'));
      chrome.storage.local.remove(keys, () => renderOverrides());
    });
  }
});

document.getElementById('btn-lint-run').addEventListener('click', () => {
  if (lastData) renderLinter(lastData);
});

// ── Property editor modal ──────────────────────────────────────────────────────
function openPropEditor(anim) {
  const modal = document.getElementById('prop-editor-modal');
  const editor = document.getElementById('prop-editor');
  document.getElementById('modal-title').textContent = `Edit: ${
    anim.targetSelector || 'anonymous'
  }`;

  const editableProps = [
    'x', 'y', 'xPercent', 'yPercent', 'rotation', 'scale', 'scaleX', 'scaleY',
    'opacity', 'autoAlpha', 'duration', 'ease', 'delay',
  ];

  editor.innerHTML = editableProps
    .map((prop) => {
      const val = anim.vars[prop] !== undefined ? anim.vars[prop] : '';
      const tooltip = PROP_TOOLTIPS[prop] || prop;
      return `
      <div class="prop-row">
        <label class="prop-label" data-tooltip="${escapeHtml(tooltip)}">${prop}</label>
        <input class="prop-input" type="text" name="${prop}" value="${escapeHtml(String(val))}" placeholder="unchanged">
      </div>
    `;
    })
    .join('');

  modal.style.display = 'flex';

  document.getElementById('btn-apply-props').onclick = () => {
    const newVars = {};
    editor.querySelectorAll('.prop-input').forEach((input) => {
      if (input.value !== '') {
        const n = parseFloat(input.value);
        newVars[input.name] = isNaN(n) ? input.value : n;
      }
    });
    const selector = anim.targetSelector || 'body';
    const varsStr = JSON.stringify(newVars);
    sendCommand({
      command: 'inject_js',
      code: `gsap.to(${JSON.stringify(selector)}, ${varsStr});`,
    });
    modal.style.display = 'none';
  };
}

const PROP_TOOLTIPS = {
  x: 'Horizontal movement in pixels (uses CSS transform translateX, GPU-accelerated). Preferred over left/margin-left.',
  y: 'Vertical movement in pixels (uses CSS transform translateY, GPU-accelerated). Preferred over top.',
  xPercent:
    "Horizontal movement as a percentage of the element's own width. Useful for centering tricks.",
  yPercent:
    "Vertical movement as a percentage of the element's own height.",
  rotation:
    'Rotation in degrees. 360 = full rotation. Negative values rotate counter-clockwise.',
  scale:
    '1 = original size, 0.5 = half size, 2 = double size. Uniform scale on both axes.',
  scaleX: 'Horizontal scale only.',
  scaleY: 'Vertical scale only.',
  opacity:
    'CSS opacity from 0 (invisible) to 1 (fully visible). Element remains in the DOM and tab order even at 0.',
  autoAlpha:
    'GSAP combined opacity + CSS visibility. When opacity reaches 0, also sets visibility:hidden. When above 0, restores visibility:visible.',
  duration:
    'How long the animation takes in seconds. Default is 0.5s in GSAP 3.',
  ease: 'Easing function. Examples: "power2.out" (decelerates), "elastic.out(1,0.3)" (bounces), "none" (linear). See greensock.com/ease-visualizer.',
  delay:
    'How many seconds to wait before starting. For sequencing in timelines, prefer the position parameter instead.',
};

document.getElementById('modal-close').addEventListener('click', () => {
  document.getElementById('prop-editor-modal').style.display = 'none';
});
document.getElementById('btn-cancel-props').addEventListener('click', () => {
  document.getElementById('prop-editor-modal').style.display = 'none';
});

// Close modal on backdrop click
document.getElementById('prop-editor-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.style.display = 'none';
  }
});

// ── Utilities ─────────────────────────────────────────────────────────────────
function sendCommand(cmd) {
  port.postMessage(cmd);
}

function showInjectResult(msg) {
  const el = document.getElementById('js-inject-result');
  el.style.display = '';
  el.className = `inject-result ${msg.success ? 'success' : 'error'}`;
  el.textContent = msg.success
    ? msg.message || '✓ Executed successfully'
    : `✕ Error: ${msg.error}`;
  setTimeout(() => {
    el.style.display = 'none';
  }, 4000);
}

function addToHistory(type, code) {
  const hist = document.getElementById('inject-history');
  // Clear placeholder
  if (hist.querySelector('.empty-state')) hist.innerHTML = '';

  injectHistory.unshift({ type, code, at: new Date().toLocaleTimeString() });

  const item = document.createElement('div');
  item.className = 'history-item';
  const preview = code.length > 100 ? code.slice(0, 100) + '…' : code;
  item.innerHTML = `
    <span class="history-meta">${type.toUpperCase()} · ${new Date().toLocaleTimeString()}</span>
    <pre class="history-code">${escapeHtml(preview)}</pre>
  `;
  hist.insertBefore(item, hist.firstChild);

  // Keep max 10 entries
  while (hist.children.length > 10) {
    hist.removeChild(hist.lastChild);
  }
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Apply saved overrides on panel load ───────────────────────────────────────
chrome.devtools.inspectedWindow.eval('window.location.href', (pageUrl) => {
  if (!pageUrl) return;
  chrome.storage.local.get(`override_${pageUrl}`, (items) => {
    const override = items[`override_${pageUrl}`];
    if (override && override.active && override.code) {
      sendCommand({ command: 'inject_js', code: override.code });
    }
  });
});
