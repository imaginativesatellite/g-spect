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
let timelineView = null;
let currentView = 'list';

// Stable ordering for ScrollTrigger list (preserves order when markers toggled)
let stOrderIds = [];

// Diff tracking for animation list (prevents flicker on 500ms poll)
const animItemMap = new Map();
let lastAnimIds = '';

// Active filters
let animFilter = 'all';
let stFilter   = 'all';

// Element inspector state
let elementInspectorActive = false;

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
      setTimeout(() => {
        chrome.devtools.inspectedWindow.eval('window.location.reload()');
      }, 300);
      break;
    // Reverse element inspector: page hovered element matched animations/STs
    case 'reverse_highlight': {
      highlightPanelRows(msg.animIds || [], msg.stIds || []);
      break;
    }
    case 'reverse_unhighlight': {
      clearPanelHighlights();
      break;
    }
    default:
      break;
  }
});

// ── JS Tooltip system ─────────────────────────────────────────────────────────
// Fixed-position tooltip that escapes overflow:hidden containers and auto-flips
// at viewport edges.
const tip = document.createElement('div');
tip.id = 'gsap-tip';
document.body.appendChild(tip);

document.addEventListener('mouseover', (e) => {
  const host = e.target.closest('[data-tooltip]');
  if (!host) { tip.style.display = 'none'; return; }
  const text = host.dataset.tooltip;
  if (!text) return;
  tip.textContent = text;
  tip.style.display = 'block';
  positionTip(host);
});

document.addEventListener('mouseout', (e) => {
  const host = e.target.closest('[data-tooltip]');
  if (!host) return;
  if (!host.contains(e.relatedTarget)) {
    tip.style.display = 'none';
  }
});

function positionTip(host) {
  const rect = host.getBoundingClientRect();
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const M = 8;

  let top = rect.top - th - M;

  // For wide elements (flex:1 spans, labels) anchor near the left edge
  // where the text actually starts, not the centre of the empty space.
  let left;
  if (rect.width > 200) {
    left = rect.left + M;
  } else {
    left = rect.left + rect.width / 2 - tw / 2;
  }

  // Flip below if not enough room above
  if (top < M) top = rect.bottom + M;

  // Clamp within viewport
  if (left < M) left = M;
  if (left + tw > vw - M) left = vw - tw - M;
  if (top < M) top = M;
  if (top + th > vh - M) top = vh - th - M;

  tip.style.top = top + 'px';
  tip.style.left = left + 'px';
}

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

    if (tab.dataset.tab === 'animations' && currentView === 'timeline' && lastData)
      renderTimelineView(lastData);
    if (tab.dataset.tab === 'linter' && lastData)
      renderLinter(lastData);
    if (tab.dataset.tab === 'overrides')
      renderOverrides();
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

// ── Animation filter chips ────────────────────────────────────────────────────
document.querySelectorAll('#anim-filter-bar .filter-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#anim-filter-bar .filter-chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    animFilter = chip.dataset.filter;
    if (lastData) renderAnimations(lastData);
  });
});

// ── ScrollTrigger filter chips ────────────────────────────────────────────────
document.querySelectorAll('#st-filter-bar .filter-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#st-filter-bar .filter-chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    stFilter = chip.dataset.filter;
    if (lastData) renderScrollTriggers(lastData);
  });
});

// ── Element inspector toggle ──────────────────────────────────────────────────
const inspectorBtn = document.createElement('button');
inspectorBtn.id = 'btn-element-inspector';
inspectorBtn.className = 'btn btn-icon btn-element-inspector';
inspectorBtn.title = 'Element Inspector';
inspectorBtn.dataset.tooltip =
  'Element Inspector: when active, hover over any animation or ScrollTrigger row to highlight its target element on the page — similar to the DevTools element picker.';
inspectorBtn.textContent = '🎯';
const resetBtn = document.getElementById('btn-reset');
resetBtn.parentNode.insertBefore(inspectorBtn, resetBtn);

inspectorBtn.addEventListener('click', () => {
  elementInspectorActive = !elementInspectorActive;
  inspectorBtn.classList.toggle('active', elementInspectorActive);
  // Tell injected.js to start/stop listening for page mouseover events
  sendCommand({ command: 'set_reverse_inspector', active: elementInspectorActive });
  if (!elementInspectorActive) {
    sendCommand({ command: 'unhighlight_element' });
    clearPanelHighlights();
  }
});

// ── Data rendering ────────────────────────────────────────────────────────────
function handleInspectionData(data) {
  lastData = data;
  document.getElementById('gsap-not-found').style.display = 'none';
  document.getElementById('overview-content').style.display = '';

  renderOverview(data);
  renderAnimations(data);
  renderScrollTriggers(data);

  const linterTab = document.querySelector('.tab[data-tab="linter"]');
  if (linterTab && linterTab.classList.contains('active')) renderLinter(data);
}

function showNotFound() {
  document.getElementById('gsap-not-found').style.display = '';
  document.getElementById('overview-content').style.display = 'none';
}

// ── Overview tab ──────────────────────────────────────────────────────────────
function renderOverview(data) {
  const versionBadge = document.getElementById('gsap-version-badge');
  if (data.version) {
    versionBadge.textContent = `GSAP ${data.version}`;
    versionBadge.style.display = '';
    versionBadge.className = `badge ${data.isGSAP3 ? 'badge-gsap3' : 'badge-gsap2'}`;
  } else {
    versionBadge.style.display = 'none';
  }

  document.getElementById('ov-version').textContent = data.version || 'Unknown';
  document.getElementById('ov-platform').textContent = data.isWebflow ? 'Webflow' : 'Custom site';
  document.getElementById('webflow-badge').style.display = data.isWebflow ? '' : 'none';
  document.getElementById('ov-anim-count').textContent = data.animations.length;
  document.getElementById('ov-st-count').textContent = data.scrollTriggers.length;

  const pluginList = document.getElementById('ov-plugins');
  if (!data.plugins || !data.plugins.length) {
    pluginList.innerHTML =
      '<span class="text-secondary">No plugins detected (core GSAP only)</span>';
  } else {
    pluginList.innerHTML = data.plugins
      .map((p) => {
        const tip = PLUGIN_TOOLTIPS[p] || `${p} plugin`;
        return `<span class="badge badge-plugin" data-tooltip="${escapeAttr(tip)}">${escapeHtml(p)}</span>`;
      })
      .join('');
  }

  document.getElementById('ix2-warning').style.display = data.hasIx2 ? '' : 'none';
}

const PLUGIN_TOOLTIPS = {
  ScrollTrigger:    'Links GSAP animations to the scroll position. The most widely used GSAP plugin.',
  Draggable:        'Makes any element draggable, spinnable, or throwable with momentum.',
  Flip:             'Animates elements between two layout states (FLIP = First, Last, Invert, Play).',
  SplitText:        'Splits text into individual characters, words, or lines so each can be animated independently. Free since Webflow acquired GSAP.',
  MorphSVGPlugin:   'Morphs one SVG path shape into another. Free since Webflow acquired GSAP.',
  DrawSVGPlugin:    'Animates SVG strokes as if they are being drawn on screen. Free since Webflow acquired GSAP.',
  MotionPathPlugin: 'Animates elements along an SVG path.',
  Observer:         'Unified listener for scroll, touch, pointer, and wheel events.',
  ScrollToPlugin:   'Animates the scroll position of a container or the window.',
  TextPlugin:       'Animates text content character by character.',
  GSDevTools:       'Interactive animation debugger with a visual playback UI. Free since Webflow acquired GSAP.',
  EaselPlugin:      'Integrates with EaselJS / CreateJS for canvas-based animations.',
  PixiPlugin:       'Integrates with PixiJS for WebGL-accelerated animations.',
};

// ── Animations tab — diff-based rendering to prevent flicker ─────────────────
function applyAnimFilter(anims) {
  switch (animFilter) {
    case 'load-in':
      return anims.filter((a) => !a.isScrollLinked && a.repeat !== -1 && a.type === 'tween');
    case 'scroll':
      return anims.filter((a) => a.isScrollLinked);
    case 'looping':
      return anims.filter((a) => a.repeat === -1);
    case 'hover':
      // Standard GSAP hover pattern: created paused, not yet played (progress 0)
      return anims.filter((a) => a.paused && a.progress === 0 && a.repeat !== -1);
    case 'paused':
      return anims.filter((a) => a.paused);
    case 'timelines':
      return anims.filter((a) => a.type === 'timeline');
    default:
      return anims;
  }
}

// ── Collapse / Expand all ─────────────────────────────────────────────────────
document.getElementById('btn-collapse-all').addEventListener('click', () => {
  document.querySelectorAll('#anim-list .anim-item, #anim-list .anim-child-item').forEach((el) =>
    el.classList.add('collapsed')
  );
});

document.getElementById('btn-expand-all').addEventListener('click', () => {
  document.querySelectorAll('#anim-list .anim-item, #anim-list .anim-child-item').forEach((el) =>
    el.classList.remove('collapsed')
  );
});

function renderAnimations(data) {
  const list = document.getElementById('anim-list');
  const topLevel = data.animations.filter((a) => a.depth <= 1);
  const filtered = applyAnimFilter(topLevel);

  if (!filtered.length) {
    const msg = topLevel.length
      ? `No animations match the "${animFilter}" filter.`
      : 'No animations detected. GSAP animations will appear here once they are created.';
    if (list.querySelector('.empty-state')?.textContent !== msg) {
      list.innerHTML = `<div class="empty-state">${msg}</div>`;
      animItemMap.clear();
      lastAnimIds = '';
    }
    if (currentView === 'timeline') renderTimelineView(data);
    return;
  }

  const newIds = filtered.map((a) => a.id).join(',');

  if (newIds !== lastAnimIds) {
    lastAnimIds = newIds;
    list.innerHTML = '';
    animItemMap.clear();
    filtered.forEach((anim) => {
      const item = buildAnimItem(anim, data.animations);
      animItemMap.set(anim.id, item);
      list.appendChild(item);
    });
  } else {
    // Patch top-level items and any visible child items
    data.animations.forEach((anim) => patchAnimItem(anim, animItemMap.get(anim.id)));
  }

  if (currentView === 'timeline') renderTimelineView(data);
}

function buildAnimItem(anim, allAnimations) {
  const item = document.createElement('div');
  item.className = 'anim-item';
  item.dataset.id = anim.id;

  const stateClass = anim.paused ? 'dot-paused' : anim.progress >= 1 ? 'dot-complete' : 'dot-active';
  const stateLabel = anim.paused ? 'Paused' : anim.progress >= 1 ? 'Complete' : 'Playing';
  const scrollTag = anim.isScrollLinked
    ? `<span class="badge badge-scroll" data-tooltip="This animation's progress is controlled by scroll position, not clock time.">scroll</span>`
    : '';
  const typeTag = `<span class="anim-type-tag ${anim.type}"
    data-tooltip="${anim.type === 'timeline'
      ? 'A timeline is a container that groups multiple tweens together. You can control all of them at once — play, pause, reverse, or scrub the whole sequence with a single handle.'
      : 'A tween is a single animation instruction — it moves one or more elements from one state to another over a set duration.'
    }">${anim.type}</span>`;

  const animatedProps = Object.keys(anim.vars)
    .filter((k) => !['ease', 'duration', 'delay', 'repeat', 'yoyo', 'stagger'].includes(k));
  const propSummary = animatedProps.join(', ');
  const propDisplay = propSummary || 'no props';
  const propTooltip = propSummary
    ? `Animated CSS/transform properties: ${propSummary}. These are the values GSAP is changing on this element.`
    : (anim.type === 'timeline'
        ? 'This is a timeline container — it groups tweens but does not animate properties directly.'
        : 'No standard animated properties detected. This tween may be animating plugin-specific values (e.g. DrawSVG, MotionPath) or CSS custom properties not in the standard list.');

  const targetTooltip = anim.targetSelector
    ? `The CSS selector of the element(s) being animated.`
    : `Anonymous target — either the element has no id or class to identify it by, or this animation targets a plain JavaScript object rather than a DOM element.`;

  item.innerHTML = `
    <div class="anim-row-top">
      <span class="dot ${stateClass}" data-tooltip="Animation state: ${stateLabel}"></span>
      ${typeTag}
      <span class="anim-target" data-tooltip="${escapeAttr(targetTooltip)}">${escapeHtml(anim.targetSelector || 'anonymous')}</span>
      ${scrollTag}
      <span class="anim-props text-secondary" data-tooltip="${escapeAttr(propTooltip)}">${escapeHtml(propDisplay)}</span>
      <span class="anim-duration text-secondary"
        data-tooltip="Total duration of this animation in seconds. Does not apply to scroll-linked animations."
        >${anim.duration.toFixed(2)}s</span>
      <span class="anim-ease text-secondary"
        data-tooltip="The easing function controlling acceleration/deceleration. power2.out starts fast and decelerates. none is linear. elastic overshoots and bounces back."
        >${escapeHtml(anim.vars.ease || 'default')}</span>
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

  // Playback button handlers
  item.querySelectorAll('.anim-btn').forEach((btn) => {
    btn.addEventListener('click', () =>
      sendCommand({ command: btn.dataset.cmd, id: btn.dataset.id })
    );
  });

  // Scrub handler
  item.querySelector('.anim-scrub').addEventListener('input', (e) => {
    sendCommand({ command: 'anim_set_progress', id: e.target.dataset.id, value: parseFloat(e.target.value) });
  });

  // Edit handler
  item.querySelector('.edit-btn').addEventListener('click', () => {
    if (lastData) {
      const a = lastData.animations.find((x) => x.id === anim.id);
      if (a) openPropEditor(a);
    }
  });

  // Click the top row to toggle collapse on that item individually
  item.querySelector('.anim-row-top').addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target.closest('input')) return;
    item.classList.toggle('collapsed');
  });

  // Timeline children (nested tweens)
  if (anim.type === 'timeline' && allAnimations) {
    const children = allAnimations.filter((a) => a.parentId === anim.id);
    if (children.length) {
      // Add chevron to the top row
      const rowTop = item.querySelector('.anim-row-top');
      const chevron = document.createElement('button');
      chevron.className = 'tl-chevron';
      chevron.textContent = '▶';
      chevron.dataset.tooltip = `Expand to see ${children.length} tween${children.length > 1 ? 's' : ''} inside this timeline.`;
      rowTop.insertBefore(chevron, rowTop.firstChild);

      // Build children container
      const childrenEl = document.createElement('div');
      childrenEl.className = 'anim-children';

      children.forEach((child) => {
        const childItem = buildChildItem(child);
        animItemMap.set(child.id, childItem);
        childrenEl.appendChild(childItem);
      });

      item.appendChild(childrenEl);

      chevron.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = childrenEl.classList.toggle('open');
        chevron.classList.toggle('open', open);
        chevron.dataset.tooltip = open
          ? `Collapse — hide the ${children.length} tween${children.length > 1 ? 's' : ''} inside this timeline.`
          : `Expand to see ${children.length} tween${children.length > 1 ? 's' : ''} inside this timeline.`;
      });
    }
  }

  // Element inspector hover
  item.addEventListener('mouseenter', () => {
    if (!elementInspectorActive) return;
    sendCommand({ command: 'highlight_element', id: anim.id, label: anim.targetSelector || 'animation' });
  });
  item.addEventListener('mouseleave', () => {
    if (!elementInspectorActive) return;
    sendCommand({ command: 'unhighlight_element' });
  });

  return item;
}

function buildChildItem(anim) {
  const item = document.createElement('div');
  item.className = 'anim-child-item';
  item.dataset.id = anim.id;

  const stateClass = anim.paused ? 'dot-paused' : anim.progress >= 1 ? 'dot-complete' : 'dot-active';
  const stateLabel = anim.paused ? 'Paused' : anim.progress >= 1 ? 'Complete' : 'Playing';
  const animatedProps = Object.keys(anim.vars)
    .filter((k) => !['ease', 'duration', 'delay', 'repeat', 'yoyo', 'stagger'].includes(k));
  const propDisplay = animatedProps.join(', ') || 'no props';
  const propTooltip = animatedProps.length
    ? `Animated properties: ${propDisplay}`
    : 'No standard animated properties detected. May target plugin-specific values.';
  const targetTooltip = anim.targetSelector
    ? 'The CSS selector of the element being animated.'
    : 'Anonymous target — element has no id or class, or this targets a JS object.';

  item.innerHTML = `
    <div class="anim-row-top">
      <span class="dot ${stateClass}" data-tooltip="Animation state: ${stateLabel}"></span>
      <span class="anim-type-tag tween" data-tooltip="A tween is a single animation instruction.">tween</span>
      <span class="anim-target" data-tooltip="${escapeAttr(targetTooltip)}">${escapeHtml(anim.targetSelector || 'anonymous')}</span>
      <span class="anim-props text-secondary" data-tooltip="${escapeAttr(propTooltip)}">${escapeHtml(propDisplay)}</span>
      <span class="anim-duration text-secondary"
        data-tooltip="Duration of this tween in seconds.">${anim.duration.toFixed(2)}s</span>
      <span class="anim-ease text-secondary"
        data-tooltip="Easing function for this tween.">${escapeHtml(anim.vars.ease || 'default')}</span>
    </div>
    <div class="anim-controls">
      <button class="btn btn-icon anim-btn" data-cmd="anim_restart" data-id="${anim.id}"
        data-tooltip="Restart this tween.">⏮</button>
      <button class="btn btn-icon anim-btn" data-cmd="anim_play" data-id="${anim.id}"
        data-tooltip="Play this tween.">▶</button>
      <button class="btn btn-icon anim-btn" data-cmd="anim_pause" data-id="${anim.id}"
        data-tooltip="Pause this tween.">⏸</button>
      <button class="btn btn-icon anim-btn" data-cmd="anim_reverse" data-id="${anim.id}"
        data-tooltip="Reverse this tween.">◀</button>
      <input type="range" class="scrub-range anim-scrub" min="0" max="1" step="0.01"
        value="${anim.progress}" data-id="${anim.id}"
        data-tooltip="Scrub this tween's progress.">
      <button class="btn btn-sm edit-btn" data-id="${anim.id}"
        data-tooltip="Edit this tween's properties.">Edit</button>
    </div>
  `;

  // Click top row to individually expand/collapse this child
  item.querySelector('.anim-row-top').addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target.closest('input')) return;
    item.classList.toggle('collapsed');
  });

  item.querySelectorAll('.anim-btn').forEach((btn) => {
    btn.addEventListener('click', () =>
      sendCommand({ command: btn.dataset.cmd, id: btn.dataset.id })
    );
  });
  item.querySelector('.anim-scrub').addEventListener('input', (e) => {
    sendCommand({ command: 'anim_set_progress', id: e.target.dataset.id, value: parseFloat(e.target.value) });
  });
  item.querySelector('.edit-btn').addEventListener('click', () => {
    if (lastData) {
      const a = lastData.animations.find((x) => x.id === anim.id);
      if (a) openPropEditor(a);
    }
  });
  item.addEventListener('mouseenter', () => {
    if (!elementInspectorActive) return;
    sendCommand({ command: 'highlight_element', id: anim.id, label: anim.targetSelector || 'tween' });
  });
  item.addEventListener('mouseleave', () => {
    if (!elementInspectorActive) return;
    sendCommand({ command: 'unhighlight_element' });
  });

  return item;
}

function patchAnimItem(anim, item) {
  if (!item) return;

  // Patch state dot
  const dot = item.querySelector('.dot');
  if (dot) {
    const cls = anim.paused ? 'dot-paused' : anim.progress >= 1 ? 'dot-complete' : 'dot-active';
    const lbl = anim.paused ? 'Paused' : anim.progress >= 1 ? 'Complete' : 'Playing';
    if (dot.className !== `dot ${cls}`) dot.className = `dot ${cls}`;
    dot.dataset.tooltip = `Animation state: ${lbl}`;
  }

  // Patch scrub range (only if not being dragged by user)
  const scrub = item.querySelector('.anim-scrub');
  if (scrub && document.activeElement !== scrub) {
    const val = parseFloat(scrub.value);
    if (Math.abs(val - anim.progress) > 0.005) scrub.value = anim.progress;
  }
}

function renderTimelineView(data) {
  const container = document.getElementById('timeline-container');
  if (!timelineView) timelineView = new TimelineView(container);
  timelineView.render(data.animations, data.scrollTriggers);
}

// ── Panel row highlight (reverse element inspector) ───────────────────────────
function highlightPanelRows(animIds, stIds) {
  clearPanelHighlights();
  animIds.forEach((id) => {
    const item = animItemMap.get(id);
    if (item) {
      item.classList.add('inspector-highlight');
      item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });
  stIds.forEach((id) => {
    const item = document.querySelector(`.st-item [data-id="${id}"]`)?.closest('.st-item');
    if (item) {
      item.classList.add('inspector-highlight');
      item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });
}

function clearPanelHighlights() {
  document.querySelectorAll('.inspector-highlight').forEach((el) =>
    el.classList.remove('inspector-highlight')
  );
}

// ── ScrollTrigger tab — stable ordering ───────────────────────────────────────
function applyStFilter(sts) {
  switch (stFilter) {
    case 'scrub':    return sts.filter((st) => st.scrub !== false);
    case 'one-shot': return sts.filter((st) => st.scrub === false);
    case 'pinned':   return sts.filter((st) => st.pin);
    case 'active':   return sts.filter((st) => st.isActive);
    default:         return sts;
  }
}

function renderScrollTriggers(data) {
  const list = document.getElementById('st-list');

  if (!data.scrollTriggers.length) {
    list.innerHTML =
      '<div class="empty-state">No ScrollTrigger instances detected. ScrollTrigger must be loaded, registered, and have instances created to appear here.</div>';
    stOrderIds = [];
    return;
  }

  // Maintain stable insertion order — new instances go to the end,
  // existing ones stay in their original position.
  const incomingIds = data.scrollTriggers.map((st) => st.id);
  stOrderIds = stOrderIds.filter((id) => incomingIds.includes(id));
  incomingIds.forEach((id) => { if (!stOrderIds.includes(id)) stOrderIds.push(id); });

  const orderedAll = stOrderIds
    .map((id) => data.scrollTriggers.find((st) => st.id === id))
    .filter(Boolean);

  const ordered = applyStFilter(orderedAll);

  if (!ordered.length) {
    list.innerHTML = `<div class="empty-state">No ScrollTrigger instances match the "${stFilter}" filter.</div>`;
    return;
  }

  list.innerHTML = '';
  ordered.forEach((st) => {
    const item = document.createElement('div');
    item.className = 'st-item';

    const scrubLabel =
      st.scrub === true ? 'yes' : st.scrub === false ? 'no' : `${st.scrub}s lag`;
    const progressPct = Math.round(st.progress * 100);

    const pinDetail = st.pin
      ? `<span class="st-detail" data-tooltip="Pin fixes the trigger element in place while the scroll continues, creating a sticky scroll effect.">pin: <code>yes</code></span>`
      : '';
    const invalidateWarn =
      !st.invalidateOnRefresh && st.scrub !== false
        ? `<span class="st-detail lint-warn-inline" data-tooltip="Without invalidateOnRefresh: true, animation values bake in at page load and won't update when the window resizes. Add invalidateOnRefresh: true to your ScrollTrigger config.">⚠ no invalidateOnRefresh</span>`
        : '';

    item.innerHTML = `
      <div class="st-row-top">
        <span class="dot ${st.isActive ? 'dot-active' : 'dot-paused'}"
          data-tooltip="Active means the scroll position is currently inside this trigger's start/end range."></span>
        <span class="st-trigger">${escapeHtml(st.triggerSelector || 'anonymous')}</span>
        <span class="badge ${st.scrub ? 'badge-scroll' : ''}"
          data-tooltip="Scrub connects animation progress to scroll position. Without scrub, the animation plays when the trigger is hit. With scrub, dragging the scrollbar drags the animation."
          >${st.scrub ? 'scrub' : 'trigger'}</span>
        <span class="st-progress text-secondary"
          data-tooltip="How far through this trigger the current scroll position is. 0% = at the start position, 100% = at the end position."
          >${progressPct}%</span>
      </div>
      <div class="st-details">
        <span class="st-detail"
          data-tooltip="Where this trigger activates. Format: 'elementEdge viewportEdge'. e.g. 'top center' means when the top of the trigger element reaches the centre of the viewport."
          >start: <code>${escapeHtml(st.start)}</code></span>
        <span class="st-detail"
          data-tooltip="Where this trigger deactivates. Same format as start."
          >end: <code>${escapeHtml(st.end)}</code></span>
        <span class="st-detail"
          data-tooltip="Scrub connects animation progress to scroll position. Without scrub, the animation plays when the trigger is hit. With scrub, dragging the scrollbar drags the animation."
          >scrub: <code>${escapeHtml(scrubLabel)}</code></span>
        ${pinDetail}
        ${invalidateWarn}
      </div>
      <div class="st-controls">
        <label class="toggle-row"
          data-tooltip="Show visual marker lines on the page for this trigger's start and end scroll positions. Very useful for debugging why a trigger fires at the wrong point.">
          Markers
          <span class="toggle-switch">
            <input type="checkbox" class="st-markers-toggle" data-id="${st.id}" ${st.markers ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </span>
        </label>
      </div>
    `;

    // Markers toggle
    item.querySelector('.st-markers-toggle').addEventListener('change', (e) => {
      sendCommand({ command: 'toggle_markers_one', id: e.target.dataset.id, value: e.target.checked });
    });

    // Element inspector hover
    item.addEventListener('mouseenter', () => {
      if (!elementInspectorActive) return;
      sendCommand({ command: 'highlight_st', id: st.id, label: st.triggerSelector || 'ScrollTrigger' });
    });
    item.addEventListener('mouseleave', () => {
      if (!elementInspectorActive) return;
      sendCommand({ command: 'unhighlight_element' });
    });

    list.appendChild(item);
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

  let html = '<div class="lint-summary">';
  if (errors.length)   html += `<span class="lint-count error">${errors.length} error${errors.length > 1 ? 's' : ''}</span>`;
  if (warnings.length) html += `<span class="lint-count warning">${warnings.length} warning${warnings.length > 1 ? 's' : ''}</span>`;
  if (tips.length)     html += `<span class="lint-count tip">${tips.length} tip${tips.length > 1 ? 's' : ''}</span>`;
  html += '</div>';
  container.innerHTML = html;

  results.forEach((r) => {
    const item = document.createElement('div');
    item.className = `lint-item lint-${r.severity}`;
    const icon = r.severity === 'error' ? '✕' : r.severity === 'warning' ? '⚠' : '💡';
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
    const overrides = Object.entries(items).filter(([k]) => k.startsWith('override_'));
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
      const preview = data.code.length > 200 ? data.code.slice(0, 200) + '…' : data.code;

      item.innerHTML = `
        <div class="override-url">${escapeHtml(url)}</div>
        <pre class="override-code">${escapeHtml(preview)}</pre>
        <div class="override-actions">
          <label data-tooltip="When enabled, this code runs automatically every time you visit this URL, after GSAP loads.">
            <input type="checkbox" class="override-active" data-key="${escapeAttr(key)}" ${data.active ? 'checked' : ''}>
            Auto-apply
          </label>
          <button class="btn btn-danger override-delete" data-key="${escapeAttr(key)}">Delete</button>
        </div>
      `;

      item.querySelector('.override-active').addEventListener('change', (e) => {
        chrome.storage.local.get(key, (stored) => {
          if (stored[key]) chrome.storage.local.set({ [key]: { ...stored[key], active: e.target.checked } });
        });
      });
      item.querySelector('.override-delete').addEventListener('click', () => {
        chrome.storage.local.remove(key, () => renderOverrides());
      });

      list.appendChild(item);
    });
  });
}

// ── Global playback controls ──────────────────────────────────────────────────
document.getElementById('btn-play-all').addEventListener('click', () => sendCommand({ command: 'play_all' }));
document.getElementById('btn-pause-all').addEventListener('click', () => sendCommand({ command: 'pause_all' }));
document.getElementById('btn-reverse-all').addEventListener('click', () => sendCommand({ command: 'reverse_all' }));
document.getElementById('btn-restart-all').addEventListener('click', () => sendCommand({ command: 'restart_all' }));

document.getElementById('global-scrub').addEventListener('input', (e) => {
  sendCommand({ command: 'set_progress', value: parseFloat(e.target.value) });
});

document.querySelectorAll('.speed-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.speed-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    sendCommand({ command: 'set_timescale', value: parseFloat(btn.dataset.speed) });
  });
});

// ── ScrollTrigger global controls ─────────────────────────────────────────────
document.getElementById('markers-all').addEventListener('change', (e) => {
  sendCommand({ command: 'toggle_markers_all', value: e.target.checked });
});

document.getElementById('btn-st-refresh').addEventListener('click', () => {
  sendCommand({ command: 'inject_js', code: 'if (window.ScrollTrigger) ScrollTrigger.refresh();' });
});

// ── Reset button ──────────────────────────────────────────────────────────────
document.getElementById('btn-reset').addEventListener('click', () => {
  if (confirm('Kill all GSAP animations, clear saved overrides for this URL, and reload the page?')) {
    chrome.devtools.inspectedWindow.eval('window.location.href', (pageUrl) => {
      chrome.storage.local.remove(`override_${pageUrl}`, () => {
        sendCommand({ command: 'reset_all' });
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
      { [`override_${pageUrl}`]: { code, active: true, savedAt: Date.now() } },
      () => showInjectResult({ success: true, message: `Saved for ${pageUrl}` })
    );
  });
});

document.getElementById('btn-copy-webflow').addEventListener('click', () => {
  const code = document.getElementById('js-editor').value.trim();
  if (!code) return;
  navigator.clipboard
    .writeText(`<script>\n${code}\n<\/script>`)
    .then(() => showInjectResult({ success: true, message: 'Copied! Paste into Webflow → Page Settings → Before </body>' }))
    .catch((err) => showInjectResult({ success: false, error: `Clipboard error: ${err.message}` }));
});

document.getElementById('btn-export-overrides').addEventListener('click', () => {
  chrome.storage.local.get(null, (items) => {
    const overrides = Object.fromEntries(Object.entries(items).filter(([k]) => k.startsWith('override_')));
    const blob = new Blob([JSON.stringify(overrides, null, 2)], { type: 'application/json' });
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
  document.getElementById('modal-title').textContent = `Edit: ${anim.targetSelector || 'anonymous'}`;

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
          <label class="prop-label" data-tooltip="${escapeAttr(tooltip)}">${prop}</label>
          <input class="prop-input" type="text" name="${prop}" value="${escapeAttr(String(val))}" placeholder="unchanged">
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
    sendCommand({
      command: 'inject_js',
      code: `gsap.to(${JSON.stringify(anim.targetSelector || 'body')}, ${JSON.stringify(newVars)});`,
    });
    modal.style.display = 'none';
  };
}

const PROP_TOOLTIPS = {
  x: 'Horizontal movement in pixels (uses CSS transform translateX, GPU-accelerated). Preferred over left/margin-left.',
  y: 'Vertical movement in pixels (uses CSS transform translateY, GPU-accelerated). Preferred over top.',
  xPercent: "Horizontal movement as a percentage of the element's own width. Useful for centering tricks.",
  yPercent: "Vertical movement as a percentage of the element's own height.",
  rotation: 'Rotation in degrees. 360 = full rotation. Negative values rotate counter-clockwise.',
  scale: '1 = original size, 0.5 = half size, 2 = double size. Uniform scale on both axes.',
  scaleX: 'Horizontal scale only.',
  scaleY: 'Vertical scale only.',
  opacity: 'CSS opacity from 0 (invisible) to 1 (fully visible). Element stays in tab order even at 0.',
  autoAlpha: 'GSAP combined opacity + CSS visibility. At 0, sets visibility:hidden (removes from tab order). Above 0, restores visibility:visible.',
  duration: 'How long the animation takes in seconds. Default is 0.5s in GSAP 3.',
  ease: 'Easing function. Examples: "power2.out" (decelerates), "elastic.out(1,0.3)" (bounces), "none" (linear).',
  delay: 'Seconds to wait before starting. For sequencing inside timelines, prefer the position parameter instead.',
  overwrite: 'Controls what happens when a new tween targets the same property on the same element as an existing tween. true = kill all existing tweens on that target immediately. "auto" = only kill tweens that conflict on the specific property being animated (safer, recommended).',
};

document.getElementById('modal-close').addEventListener('click', () => {
  document.getElementById('prop-editor-modal').style.display = 'none';
});
document.getElementById('btn-cancel-props').addEventListener('click', () => {
  document.getElementById('prop-editor-modal').style.display = 'none';
});
document.getElementById('prop-editor-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
});

// ── Utilities ─────────────────────────────────────────────────────────────────
function sendCommand(cmd) {
  port.postMessage(cmd);
}

function showInjectResult(msg) {
  const el = document.getElementById('js-inject-result');
  el.style.display = '';
  el.className = `inject-result ${msg.success ? 'success' : 'error'}`;
  el.textContent = msg.success ? msg.message || '✓ Executed successfully' : `✕ Error: ${msg.error}`;
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

function addToHistory(type, code) {
  const hist = document.getElementById('inject-history');
  if (hist.querySelector('.empty-state')) hist.innerHTML = '';
  const item = document.createElement('div');
  item.className = 'history-item';
  const preview = code.length > 100 ? code.slice(0, 100) + '…' : code;
  item.innerHTML = `
    <span class="history-meta">${type.toUpperCase()} · ${new Date().toLocaleTimeString()}</span>
    <pre class="history-code">${escapeHtml(preview)}</pre>
  `;
  hist.insertBefore(item, hist.firstChild);
  while (hist.children.length > 10) hist.removeChild(hist.lastChild);
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

// escapeAttr: for values placed inside HTML attribute quotes
function escapeAttr(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
