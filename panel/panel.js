// panel.js — GSAP Inspector DevTools panel — two-pane edition.
// ES module loaded from panel.html.

import { TimelineView } from './timeline-view.js';
import { runLinter }    from '../rules/gsap-linter.js';

// ── Connection ────────────────────────────────────────────────────────────────
const port = chrome.runtime.connect({ name: 'gsap-inspector-devtools' });
port.postMessage({ type: 'devtools_connect', tabId: chrome.devtools.inspectedWindow.tabId });

// ── State ─────────────────────────────────────────────────────────────────────
let lastData             = null;
let timelineView         = null;
let stOrderIds           = [];
const animItemMap        = new Map();
const stItemMap          = new Map();
const expandedTimelineIds = new Set();
let lastAnimIds          = '';
let lastStIds            = '';
let animFilter           = 'all';
let stFilter             = 'all';
let elementInspectorActive = false;
let selectedAnimId       = null;
let selectedStId         = null;

// ── Icon helpers ──────────────────────────────────────────────────────────────
const ICONS = {
  play:         `<polygon points="5 3 19 12 5 21 5 3"/>`,
  pause:        `<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>`,
  skipBack:     `<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="4" x2="5" y2="20"/>`,
  rotateCcw:    `<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.08"/>`,
  x:            `<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`,
  chevronRight: `<polyline points="9 18 15 12 9 6"/>`,
  refreshCw:    `<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>`,
  copy:         `<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>`,
  code:         `<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>`,
  link:         `<path d="M15 7h3a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-3m-6 0H6a5 5 0 0 1-5-5 5 5 0 0 1 5-5h3"/><line x1="8" y1="12" x2="16" y2="12"/>`,
};

function icon(name, size = 14) {
  const paths = ICONS[name];
  if (!paths) return '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

// ── Message handling ──────────────────────────────────────────────────────────
port.onMessage.addListener((msg) => {
  switch (msg.type) {
    case 'inspection_data':   handleInspectionData(msg.payload);  break;
    case 'gsap_not_found':    showNotFound();                      break;
    case 'inject_result':     showInjectResult(msg);               break;
    case 'reset_complete':
      setTimeout(() => chrome.devtools.inspectedWindow.eval('window.location.reload()'), 300);
      break;
    case 'reverse_highlight':   highlightPanelRows(msg.animIds || [], msg.stIds || []); break;
    case 'reverse_unhighlight': clearPanelHighlights(); break;
    default: break;
  }
});

// ── JS Tooltip (fixed-position, escapes overflow:hidden) ─────────────────────
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
  if (!host.contains(e.relatedTarget)) tip.style.display = 'none';
});

function positionTip(host) {
  const rect = host.getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  const vw = window.innerWidth,  vh = window.innerHeight;
  const M = 8;
  let top  = rect.top - th - M;
  let left = rect.width > 200 ? rect.left + M : rect.left + rect.width / 2 - tw / 2;
  if (top < M) top = rect.bottom + M;
  if (left < M) left = M;
  if (left + tw > vw - M) left = vw - tw - M;
  if (top < M) top = M;
  if (top + th > vh - M) top = vh - th - M;
  tip.style.top  = top  + 'px';
  tip.style.left = left + 'px';
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchToTab(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === name);
    t.setAttribute('aria-selected', String(t.dataset.tab === name));
  });
  document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
  document.getElementById(`tab-${name}`)?.classList.add('active');
  if (name === 'timeline'  && lastData) renderTimelineView(lastData);
  if (name === 'linter'    && lastData) renderLinter(lastData);
  if (name === 'overrides')             renderOverrides();
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchToTab(tab.dataset.tab));
});

// ── Resize handles ────────────────────────────────────────────────────────────
function initResize(handleId) {
  const handle = document.getElementById(handleId);
  if (!handle) return;
  const leftPane = handle.previousElementSibling;
  let startX, startW;
  handle.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startW = leftPane.offsetWidth;
    handle.classList.add('dragging');
    const onMove = (e) => {
      const w = Math.max(140, Math.min(520, startW + e.clientX - startX));
      leftPane.style.width = w + 'px';
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
}
initResize('anim-resize');
initResize('st-resize');

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

// ── Element inspector ─────────────────────────────────────────────────────────
const inspectorBtn = document.getElementById('btn-element-inspector');
inspectorBtn.addEventListener('click', () => {
  elementInspectorActive = !elementInspectorActive;
  inspectorBtn.classList.toggle('active', elementInspectorActive);
  sendCommand({ command: 'set_reverse_inspector', active: elementInspectorActive });
  if (!elementInspectorActive) {
    sendCommand({ command: 'unhighlight_element' });
    clearPanelHighlights();
  }
});

// ── Selection ─────────────────────────────────────────────────────────────────
function selectAnim(id) {
  selectedAnimId = id;
  document.querySelectorAll('#anim-list .list-item').forEach((el) => {
    el.classList.toggle('selected', el.dataset.id === id);
  });
  if (id && lastData) renderAnimDetail(id);
}

function selectSt(id) {
  selectedStId = id;
  document.querySelectorAll('#st-list .list-item').forEach((el) => {
    el.classList.toggle('selected', el.dataset.id === id);
  });
  if (id && lastData) renderStDetail(id);
}

// ── Main data entry point ─────────────────────────────────────────────────────
function handleInspectionData(data) {
  lastData = data;
  document.getElementById('gsap-not-found').style.display = 'none';
  document.getElementById('overview-content').style.display = '';
  renderOverview(data);
  renderAnimations(data);
  renderScrollTriggers(data);
  const linterTab = document.querySelector('.tab[data-tab="linter"]');
  if (linterTab?.classList.contains('active')) renderLinter(data);
}

function showNotFound() {
  document.getElementById('gsap-not-found').style.display = '';
  document.getElementById('overview-content').style.display = 'none';
}

// ── Overview tab ──────────────────────────────────────────────────────────────
function renderOverview(data) {
  const vBadge = document.getElementById('gsap-version-badge');
  if (data.version) {
    vBadge.textContent = `GSAP ${data.version}`;
    vBadge.style.display = '';
    vBadge.className = `badge ${data.isGSAP3 ? 'badge-gsap3' : 'badge-gsap2'}`;
  } else {
    vBadge.style.display = 'none';
  }
  document.getElementById('ov-version').textContent   = data.version || 'Unknown';
  document.getElementById('ov-platform').textContent  = data.isWebflow ? 'Webflow' : 'Custom site';
  document.getElementById('webflow-badge').style.display = data.isWebflow ? '' : 'none';
  document.getElementById('ov-anim-count').textContent = data.animations.length;
  document.getElementById('ov-st-count').textContent   = data.scrollTriggers.length;

  const pluginList = document.getElementById('ov-plugins');
  if (!data.plugins?.length) {
    pluginList.innerHTML = '<span class="text-secondary">No plugins detected (core GSAP only)</span>';
  } else {
    pluginList.innerHTML = data.plugins.map((p) => {
      const t = PLUGIN_TOOLTIPS[p] || `${p} plugin`;
      return `<span class="badge badge-plugin" data-tooltip="${escapeAttr(t)}">${escapeHtml(p)}</span>`;
    }).join('');
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

// ── Filter helpers ────────────────────────────────────────────────────────────
function applyAnimFilter(anims) {
  switch (animFilter) {
    case 'load-in':   return anims.filter((a) => !a.isScrollLinked && a.repeat !== -1 && a.type === 'tween');
    case 'scroll':    return anims.filter((a) => a.isScrollLinked);
    case 'looping':   return anims.filter((a) => a.repeat === -1);
    case 'hover':     return anims.filter((a) => a.paused && a.progress === 0 && a.repeat !== -1);
    case 'paused':    return anims.filter((a) => a.paused);
    case 'timelines': return anims.filter((a) => a.type === 'timeline');
    default:          return anims;
  }
}

function applyStFilter(sts) {
  switch (stFilter) {
    case 'scrub':    return sts.filter((st) => st.scrub !== false);
    case 'one-shot': return sts.filter((st) => st.scrub === false);
    case 'pinned':   return sts.filter((st) => st.pin);
    case 'active':   return sts.filter((st) => st.isActive);
    default:         return sts;
  }
}

// ── Animation left pane ───────────────────────────────────────────────────────
function renderAnimations(data) {
  const list     = document.getElementById('anim-list');
  const topLevel = data.animations.filter((a) => a.depth <= 1);
  const filtered = applyAnimFilter(topLevel);

  if (!filtered.length) {
    const msg = topLevel.length
      ? `No animations match the "${animFilter}" filter.`
      : 'No animations detected. GSAP animations appear here once created.';
    if (list.querySelector('.empty-state')?.textContent !== msg) {
      list.innerHTML = `<div class="empty-state">${msg}</div>`;
      animItemMap.clear();
      lastAnimIds = '';
    }
    return;
  }

  const newIds = filtered.map((a) => a.id).join(',');
  if (newIds !== lastAnimIds) {
    lastAnimIds = newIds;
    list.innerHTML = '';
    animItemMap.clear();
    filtered.forEach((anim) => {
      const { group, row } = buildListGroup(anim, data.animations);
      animItemMap.set(anim.id, row);
      list.appendChild(group);
    });
    if (selectedAnimId) {
      animItemMap.get(selectedAnimId)?.classList.add('selected');
    }
  } else {
    filtered.forEach((anim) => patchListItem(anim, animItemMap.get(anim.id)));
  }

  if (selectedAnimId) patchAnimDetail();
}

function buildListGroup(anim, allAnimations) {
  const children = anim.type === 'timeline'
    ? allAnimations.filter((a) => a.parentId === anim.id)
    : [];

  const group = document.createElement('div');
  group.className = 'list-item-group';

  // Main row
  const row = document.createElement('div');
  row.className  = 'list-item';
  row.dataset.id = anim.id;

  const cls   = anim.paused ? 'dot-paused' : anim.progress >= 1 ? 'dot-complete' : 'dot-active';
  const label = anim.paused ? 'Paused'     : anim.progress >= 1 ? 'Complete'     : 'Playing';
  const scroll = anim.isScrollLinked
    ? `<span class="badge badge-scroll" style="font-size:9px;padding:0 5px" data-tooltip="Progress is controlled by scroll position.">scroll</span>`
    : '';

  const chevronHtml = children.length
    ? `<button class="list-item-chevron${expandedTimelineIds.has(anim.id) ? ' open' : ''}"
        data-tooltip="Toggle child tweens" aria-label="Toggle children">
        ${icon('chevronRight', 12)}
      </button>`
    : `<span style="width:16px;flex-shrink:0"></span>`;

  row.innerHTML = `
    ${chevronHtml}
    <span class="dot ${cls}" data-tooltip="State: ${label}"></span>
    <span class="anim-type-tag ${anim.type}"
      data-tooltip="${anim.type === 'timeline'
        ? 'Timeline: groups multiple tweens together, controlled as one unit.'
        : 'Tween: single animation instruction moving element(s) from one state to another.'
      }">${anim.type}</span>
    <span class="list-item-target" data-tooltip="${escapeAttr(
        anim.targetSelector
          ? 'CSS selector of the element(s) being animated.'
          : 'Anonymous — element has no id/class, or this targets a plain JS object.'
      )}">${escapeHtml(anim.targetSelector || 'anonymous')}</span>
    ${scroll}
    <span class="list-item-meta">${anim.duration.toFixed(1)}s</span>
  `;

  row.addEventListener('click', (e) => {
    // Don't select if chevron was clicked
    if (!e.target.closest('.list-item-chevron')) selectAnim(anim.id);
  });
  row.addEventListener('mouseenter', () => {
    if (!elementInspectorActive) return;
    sendCommand({ command: 'highlight_element', id: anim.id, label: anim.targetSelector || 'animation' });
  });
  row.addEventListener('mouseleave', () => {
    if (!elementInspectorActive) return;
    sendCommand({ command: 'unhighlight_element' });
  });

  group.appendChild(row);

  // Children container (timelines only)
  if (children.length) {
    const childrenContainer = document.createElement('div');
    childrenContainer.className = 'list-item-children';
    childrenContainer.style.display = expandedTimelineIds.has(anim.id) ? '' : 'none';

    children.forEach((child) => {
      const childRow = document.createElement('div');
      childRow.className  = 'list-item list-item-child';
      childRow.dataset.id = child.id;

      const childCls   = child.paused ? 'dot-paused' : child.progress >= 1 ? 'dot-complete' : 'dot-active';
      const childLabel = child.paused ? 'Paused'     : child.progress >= 1 ? 'Complete'     : 'Playing';
      const childProps = Object.keys(child.vars || {})
        .filter((k) => !['ease','duration','delay','repeat','yoyo','stagger'].includes(k));

      childRow.innerHTML = `
        <span style="width:16px;flex-shrink:0"></span>
        <span class="dot ${childCls}" data-tooltip="State: ${childLabel}"></span>
        <span class="anim-type-tag tween" style="font-size:8px">tween</span>
        <span class="list-item-target">${escapeHtml(child.targetSelector || 'anonymous')}</span>
        <span class="list-item-meta">${child.duration.toFixed(1)}s</span>
      `;

      childRow.addEventListener('click', () => selectAnim(child.id));
      childrenContainer.appendChild(childRow);
    });

    group.appendChild(childrenContainer);

    // Chevron toggle
    const chevronBtn = row.querySelector('.list-item-chevron');
    if (chevronBtn) {
      chevronBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = chevronBtn.classList.toggle('open');
        childrenContainer.style.display = isOpen ? '' : 'none';
        if (isOpen) {
          expandedTimelineIds.add(anim.id);
        } else {
          expandedTimelineIds.delete(anim.id);
        }
      });
    }
  }

  return { group, row };
}

function patchListItem(anim, item) {
  if (!item) return;
  const dot = item.querySelector('.dot');
  if (dot) {
    const cls   = anim.paused ? 'dot-paused' : anim.progress >= 1 ? 'dot-complete' : 'dot-active';
    const label = anim.paused ? 'Paused'     : anim.progress >= 1 ? 'Complete'     : 'Playing';
    if (dot.className !== `dot ${cls}`) dot.className = `dot ${cls}`;
    dot.dataset.tooltip = `State: ${label}`;
  }
}

// ── Generate GSAP code snippet ────────────────────────────────────────────────
function generateAnimCode(anim, allAnimations) {
  const fmt = (v) => typeof v === 'string' ? `'${v}'` : String(v);
  const fmtVars = (entries, indent = '  ') =>
    entries.map(([k, v]) => `${indent}${k}: ${fmt(v)}`).join(',\n');

  if (anim.type === 'tween') {
    const target = anim.targetSelector ? `'${anim.targetSelector}'` : '/* element */';
    const entries = Object.entries(anim.vars || {});
    if (!entries.length) return `gsap.to(${target}, { duration: ${anim.duration.toFixed(2)} });`;
    return `gsap.to(${target}, {\n${fmtVars(entries)}\n});`;
  }

  if (anim.type === 'timeline') {
    const children = allAnimations.filter((a) => a.parentId === anim.id);
    const tlOptions = [];
    if (typeof anim.repeat === 'number' && anim.repeat !== 0) tlOptions.push(`  repeat: ${anim.repeat}`);
    if (anim.vars?.ease) tlOptions.push(`  defaults: { ease: '${anim.vars.ease}' }`);
    let code = `const tl = gsap.timeline(${tlOptions.length ? `{\n${tlOptions.join(',\n')}\n}` : ''});\n`;
    children.forEach((child) => {
      const target = child.targetSelector ? `'${child.targetSelector}'` : '/* element */';
      const entries = Object.entries(child.vars || {});
      if (!entries.length) {
        code += `\ntl.to(${target}, { duration: ${child.duration.toFixed(2)} });`;
      } else {
        code += `\ntl.to(${target}, {\n${fmtVars(entries)}\n});`;
      }
    });
    return code;
  }
  return '';
}

// ── Animation detail pane ─────────────────────────────────────────────────────
function renderAnimDetail(id) {
  const container = document.getElementById('anim-detail');
  const anim = lastData?.animations.find((a) => a.id === id);
  if (!anim) { container.innerHTML = ''; return; }

  const linkedSt = lastData?.scrollTriggers.find((st) => st.linkedAnimId === id);
  const children = anim.type === 'timeline'
    ? lastData.animations.filter((a) => a.parentId === id)
    : [];

  const cls         = anim.paused ? 'dot-paused' : anim.progress >= 1 ? 'dot-complete' : 'dot-active';
  const stateLabel  = anim.paused ? 'Paused'     : anim.progress >= 1 ? 'Complete'     : 'Playing';
  const progressPct = Math.round(anim.progress * 100);
  const typeTooltip = anim.type === 'timeline'
    ? 'Timeline: a container that groups multiple tweens. Control all of them with one play/pause/scrub.'
    : 'Tween: a single animation instruction — moves element(s) from one state to another over a duration.';
  const animatedProps = Object.entries(anim.vars || {})
    .filter(([k]) => !['ease','duration','delay','repeat','yoyo','stagger'].includes(k));

  let html = `
    <div class="detail-header">
      <span class="anim-type-tag ${anim.type}" data-tooltip="${escapeAttr(typeTooltip)}">${anim.type}</span>
      <span class="detail-target" data-tooltip="${escapeAttr(
          anim.targetSelector
            ? 'The CSS selector of the element(s) this animation targets.'
            : 'Anonymous — no identifiable selector. The element may have no id or class, or this animation targets a plain JS object.'
        )}">${escapeHtml(anim.targetSelector || 'anonymous')}</span>
      <button class="btn btn-sm" id="detail-edit-btn" data-id="${escapeAttr(anim.id)}"
        data-tooltip="Open the property editor to change this animation's values and re-apply them live.">Edit Props</button>
    </div>

    <div class="detail-stats">
      <div class="stat">
        <span class="stat-label">State</span>
        <span class="stat-value"><span class="dot ${cls}" id="detail-state-dot"></span>&nbsp;<span id="detail-state-label" style="font-size:13px;font-family:system-ui">${stateLabel}</span></span>
      </div>
      <div class="stat">
        <span class="stat-label" data-tooltip="How far through the animation. 0% = start, 100% = end.">Progress</span>
        <span class="stat-value" id="detail-progress-val">${progressPct}%</span>
      </div>
      <div class="stat">
        <span class="stat-label" data-tooltip="Total playback time of this animation in seconds.">Duration</span>
        <span class="stat-value">${anim.duration.toFixed(2)}s</span>
      </div>
      <div class="stat">
        <span class="stat-label" data-tooltip="Easing function controlling acceleration. power2.out = decelerates, elastic = bounces, none = linear.">Ease</span>
        <span class="stat-value stat-sm">${escapeHtml(anim.vars?.ease || 'default')}</span>
      </div>
      ${typeof anim.repeat === 'number' && anim.repeat !== 0 ? `
      <div class="stat">
        <span class="stat-label" data-tooltip="Number of times this animation repeats. -1 means infinite loop.">Repeat</span>
        <span class="stat-value">${anim.repeat === -1 ? '∞' : anim.repeat}</span>
      </div>` : ''}
      ${typeof anim.delay === 'number' && anim.delay > 0 ? `
      <div class="stat">
        <span class="stat-label" data-tooltip="Delay before this animation starts, in seconds.">Delay</span>
        <span class="stat-value">${anim.delay.toFixed(2)}s</span>
      </div>` : ''}
    </div>

    <div class="detail-playback">
      <div class="detail-playback-btns">
        <button class="btn btn-icon anim-btn" data-cmd="anim_restart" data-id="${escapeAttr(anim.id)}" data-tooltip="Restart from the beginning.">${icon('skipBack')}</button>
        <button class="btn btn-icon anim-btn" data-cmd="anim_play"    data-id="${escapeAttr(anim.id)}" data-tooltip="Play / resume.">${icon('play')}</button>
        <button class="btn btn-icon anim-btn" data-cmd="anim_pause"   data-id="${escapeAttr(anim.id)}" data-tooltip="Pause at current position.">${icon('pause')}</button>
        <button class="btn btn-icon anim-btn" data-cmd="anim_reverse" data-id="${escapeAttr(anim.id)}" data-tooltip="Reverse from current position.">${icon('rotateCcw')}</button>
        <span class="detail-progress-pct" id="detail-scrub-pct">${progressPct}%</span>
      </div>
      <input type="range" class="scrub-lg" id="detail-anim-scrub"
        min="0" max="1" step="0.01" value="${anim.progress}" data-id="${escapeAttr(anim.id)}"
        data-tooltip="Drag to scrub this animation from start (0%) to end (100%).">
    </div>
  `;

  if (linkedSt) {
    html += `
    <div class="detail-section">
      <div class="detail-section-header">Linked ScrollTrigger</div>
      <button class="detail-link" id="detail-st-link" data-stid="${escapeAttr(linkedSt.id)}"
        data-tooltip="This animation's progress is controlled by a ScrollTrigger. Click to jump to it in the ScrollTrigger tab.">
        ⟳ ${escapeHtml(linkedSt.triggerSelector || 'ScrollTrigger')}
      </button>
    </div>`;
  }

  if (animatedProps.length) {
    html += `
    <div class="detail-section">
      <div class="detail-section-header">Animated Properties
        <span data-tooltip="The CSS and transform values this animation is changing. GSAP animates these from their current value to the target value (or from 'from' to current for gsap.from())." style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:var(--border);color:var(--text-secondary);font-size:9px;cursor:help;font-weight:700">?</span>
      </div>
      <div class="detail-props-grid">
        ${animatedProps.map(([k, v]) => `
          <div class="detail-prop-row">
            <span class="detail-prop-name" data-tooltip="${escapeAttr(PROP_TOOLTIPS[k] || k)}">${escapeHtml(k)}</span>
            <span class="detail-prop-value">${escapeHtml(String(v))}</span>
          </div>
        `).join('')}
      </div>
    </div>`;
  } else if (anim.type !== 'timeline') {
    html += `
    <div class="detail-section">
      <div class="detail-section-header">Animated Properties</div>
      <span class="text-secondary" style="font-size:12px" data-tooltip="No standard CSS/transform properties found. This tween may animate plugin-specific values (DrawSVG, MotionPath), CSS custom properties, or object values not tracked by the standard list.">No standard properties detected</span>
    </div>`;
  }

  if (children.length) {
    html += `
    <div class="detail-section">
      <div class="detail-section-header">${children.length} Child Tween${children.length > 1 ? 's' : ''}
        <span data-tooltip="This timeline contains these tweens as children. The timeline's playhead controls them all together." style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:var(--border);color:var(--text-secondary);font-size:9px;cursor:help;font-weight:700">?</span>
      </div>
      <div class="detail-children">
        ${children.map((child) => {
          const childProps = Object.keys(child.vars || {})
            .filter((k) => !['ease','duration','delay','repeat','yoyo','stagger'].includes(k));
          return `
          <div class="detail-child-row" data-childid="${escapeAttr(child.id)}">
            <span class="anim-type-tag tween" style="font-size:8px">tween</span>
            <span class="detail-child-target"
              data-tooltip="${escapeAttr(child.targetSelector ? 'CSS selector of this child tween\'s target element.' : 'Anonymous target.')}"
              >${escapeHtml(child.targetSelector || 'anonymous')}</span>
            <span class="list-item-meta">${child.duration.toFixed(1)}s</span>
            ${childProps.length
              ? `<span style="font-size:10px;color:var(--text-secondary);font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:80px" data-tooltip="Animated properties: ${escapeAttr(childProps.join(', '))}">${escapeHtml(childProps.join(', '))}</span>`
              : ''}
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  const code = generateAnimCode(anim, lastData.animations);
  if (code) {
    html += `
    <div class="detail-section">
      <div class="detail-section-header">${icon('code', 12)} Generated Code</div>
      <div class="detail-code-block">
        <div class="detail-code-toolbar">
          <span class="detail-code-lang">JavaScript</span>
          <button class="btn btn-sm" id="detail-copy-code" data-tooltip="Copy this code to clipboard.">${icon('copy', 12)} Copy</button>
        </div>
        <pre class="detail-code-pre">${escapeHtml(code)}</pre>
      </div>
    </div>`;
  }

  container.innerHTML = html;

  container.querySelector('#detail-edit-btn')?.addEventListener('click', () => {
    if (lastData) {
      const a = lastData.animations.find((x) => x.id === anim.id);
      if (a) openPropEditor(a);
    }
  });

  container.querySelectorAll('.anim-btn').forEach((btn) => {
    btn.addEventListener('click', () => sendCommand({ command: btn.dataset.cmd, id: btn.dataset.id }));
  });

  const scrub = container.querySelector('#detail-anim-scrub');
  if (scrub) {
    scrub.addEventListener('input', (e) => {
      const pct = Math.round(parseFloat(e.target.value) * 100);
      const pctEl = container.querySelector('#detail-scrub-pct');
      if (pctEl) pctEl.textContent = pct + '%';
      sendCommand({ command: 'anim_set_progress', id: e.target.dataset.id, value: parseFloat(e.target.value) });
    });
  }

  container.querySelector('#detail-st-link')?.addEventListener('click', (e) => {
    const stId = e.currentTarget.dataset.stid;
    switchToTab('scrolltrigger');
    setTimeout(() => selectSt(stId), 60);
  });

  // Child row clicks jump to that animation in the list
  container.querySelectorAll('.detail-child-row').forEach((row) => {
    row.addEventListener('click', () => {
      const childId = row.dataset.childid;
      if (childId && animItemMap.has(childId)) {
        // Child not in filtered list; just select and show detail directly
        selectedAnimId = childId;
        renderAnimDetail(childId);
      }
    });
  });

  if (code) {
    container.querySelector('#detail-copy-code')?.addEventListener('click', () => {
      navigator.clipboard.writeText(code);
    });
  }
}

function patchAnimDetail() {
  if (!selectedAnimId || !lastData) return;
  const anim = lastData.animations.find((a) => a.id === selectedAnimId);
  if (!anim) return;

  const container   = document.getElementById('anim-detail');
  const cls         = anim.paused ? 'dot-paused' : anim.progress >= 1 ? 'dot-complete' : 'dot-active';
  const stateLabel  = anim.paused ? 'Paused'     : anim.progress >= 1 ? 'Complete'     : 'Playing';
  const progressPct = Math.round(anim.progress * 100);

  const dot = container.querySelector('#detail-state-dot');
  if (dot && dot.className !== `dot ${cls}`) dot.className = `dot ${cls}`;
  const lbl = container.querySelector('#detail-state-label');
  if (lbl) lbl.textContent = stateLabel;
  const prog = container.querySelector('#detail-progress-val');
  if (prog) prog.textContent = progressPct + '%';
  const scrubPct = container.querySelector('#detail-scrub-pct');
  if (scrubPct) scrubPct.textContent = progressPct + '%';

  const scrub = container.querySelector('#detail-anim-scrub');
  if (scrub && document.activeElement !== scrub) {
    if (Math.abs(parseFloat(scrub.value) - anim.progress) > 0.005) scrub.value = anim.progress;
  }
}

// ── ScrollTrigger left pane ───────────────────────────────────────────────────
function renderScrollTriggers(data) {
  const list = document.getElementById('st-list');

  if (!data.scrollTriggers.length) {
    list.innerHTML =
      '<div class="empty-state">No ScrollTrigger instances detected. ScrollTrigger must be loaded, registered, and have instances created to appear here.</div>';
    stOrderIds = [];
    stItemMap.clear();
    lastStIds = '';
    return;
  }

  const incomingIds = data.scrollTriggers.map((st) => st.id);
  stOrderIds = stOrderIds.filter((id) => incomingIds.includes(id));
  incomingIds.forEach((id) => { if (!stOrderIds.includes(id)) stOrderIds.push(id); });

  const orderedAll = stOrderIds
    .map((id) => data.scrollTriggers.find((st) => st.id === id))
    .filter(Boolean);
  const ordered = applyStFilter(orderedAll);

  if (!ordered.length) {
    list.innerHTML = `<div class="empty-state">No ScrollTriggers match the "${stFilter}" filter.</div>`;
    stItemMap.clear();
    lastStIds = '';
    return;
  }

  const newIds = ordered.map((s) => s.id).join(',');
  if (newIds !== lastStIds) {
    lastStIds = newIds;
    list.innerHTML = '';
    stItemMap.clear();
    ordered.forEach((st) => {
      const item = buildStListItem(st);
      stItemMap.set(st.id, item);
      list.appendChild(item);
    });
    if (selectedStId) {
      stItemMap.get(selectedStId)?.classList.add('selected');
    }
  } else {
    ordered.forEach((st) => patchStListItem(st, stItemMap.get(st.id)));
  }

  if (selectedStId) patchStDetail();
}

function buildStListItem(st) {
  const item = document.createElement('div');
  item.className  = 'list-item';
  item.dataset.id = st.id;

  const scrubLabel = st.scrub !== false ? 'scrub' : 'trigger';
  const pct        = Math.round(st.progress * 100);

  item.innerHTML = `
    <span class="dot ${st.isActive ? 'dot-active' : 'dot-paused'}"
      data-tooltip="Active means scroll is currently inside this trigger's start/end range."></span>
    <span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;flex-shrink:0;
      background:#0ea5e922;color:#0ea5e9;border:1px solid #0ea5e944">${escapeHtml(scrubLabel)}</span>
    <span class="list-item-target"
      data-tooltip="${escapeAttr(st.triggerSelector
        ? 'The CSS selector of the element that triggers this ScrollTrigger.'
        : 'Anonymous trigger — no identifiable selector.'
      )}">${escapeHtml(st.triggerSelector || 'anonymous')}</span>
    <span class="list-item-meta" id="st-list-pct-${escapeAttr(st.id)}">${pct}%</span>
  `;

  item.addEventListener('click', () => selectSt(st.id));
  item.addEventListener('mouseenter', () => {
    if (!elementInspectorActive) return;
    sendCommand({ command: 'highlight_st', id: st.id, label: st.triggerSelector || 'ScrollTrigger' });
  });
  item.addEventListener('mouseleave', () => {
    if (!elementInspectorActive) return;
    sendCommand({ command: 'unhighlight_element' });
  });
  return item;
}

function patchStListItem(st, item) {
  if (!item) return;
  const dot = item.querySelector('.dot');
  if (dot) {
    const cls = st.isActive ? 'dot-active' : 'dot-paused';
    if (dot.className !== `dot ${cls}`) dot.className = `dot ${cls}`;
  }
  const pctEl = item.querySelector(`#st-list-pct-${CSS.escape(st.id)}`);
  if (pctEl) pctEl.textContent = Math.round(st.progress * 100) + '%';
}

// ── ScrollTrigger detail pane ─────────────────────────────────────────────────
function renderStDetail(id) {
  const container = document.getElementById('st-detail');
  const st = lastData?.scrollTriggers.find((s) => s.id === id);
  if (!st) { container.innerHTML = ''; return; }

  const linkedAnim   = st.linkedAnimId
    ? lastData.animations.find((a) => a.id === st.linkedAnimId)
    : null;
  const progressPct  = Math.round(st.progress * 100);
  const scrubLabel   = st.scrub === true ? 'yes' : st.scrub === false ? 'no' : `${st.scrub}s lag`;

  let html = `
    <div class="detail-header">
      <span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;flex-shrink:0;
        background:#0ea5e922;color:#0ea5e9;border:1px solid #0ea5e944"
        data-tooltip="A ScrollTrigger links animation playback or actions to the page scroll position.">scrolltrigger</span>
      <span class="detail-target"
        data-tooltip="${escapeAttr(st.triggerSelector
          ? 'The CSS selector of the element that triggers this ScrollTrigger.'
          : 'Anonymous — no identifiable CSS selector.'
        )}">${escapeHtml(st.triggerSelector || 'anonymous')}</span>
    </div>

    <div class="detail-stats">
      <div class="stat">
        <span class="stat-label">State</span>
        <span class="stat-value"><span class="dot ${st.isActive ? 'dot-active' : 'dot-paused'}" id="detail-st-dot"></span>&nbsp;<span id="detail-st-state" style="font-size:13px;font-family:system-ui">${st.isActive ? 'Active' : 'Inactive'}</span></span>
      </div>
      <div class="stat">
        <span class="stat-label" data-tooltip="0% = scroll at the start position, 100% = scroll at the end position.">Progress</span>
        <span class="stat-value" id="detail-st-progress">${progressPct}%</span>
      </div>
      <div class="stat">
        <span class="stat-label" data-tooltip="Where this trigger activates. Format: 'elementEdge viewportEdge'. e.g. 'top center' = when the element top hits the viewport centre.">Start</span>
        <span class="stat-value stat-sm">${escapeHtml(st.start)}</span>
      </div>
      <div class="stat">
        <span class="stat-label" data-tooltip="Where this trigger deactivates. Same format as start.">End</span>
        <span class="stat-value stat-sm">${escapeHtml(st.end)}</span>
      </div>
      <div class="stat">
        <span class="stat-label" data-tooltip="Scrub ties animation progress directly to scroll position so dragging the scrollbar drags the animation. Without scrub, the animation plays when the trigger fires.">Scrub</span>
        <span class="stat-value stat-sm">${escapeHtml(scrubLabel)}</span>
      </div>
      ${st.pin ? `<div class="stat">
        <span class="stat-label" data-tooltip="Pin fixes the trigger element in place while the scroll continues, creating a sticky scroll effect.">Pin</span>
        <span class="stat-value">yes</span>
      </div>` : ''}
    </div>

    <div class="detail-section">
      <div class="detail-section-header">Debug Markers</div>
      <label class="toggle-row"
        data-tooltip="Show visual marker lines on the page for this trigger's start and end scroll positions. Very useful for debugging why a trigger fires at the wrong scroll point.">
        Show markers on page
        <span class="toggle-switch">
          <input type="checkbox" id="detail-st-markers" ${st.markers ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </span>
      </label>
    </div>
  `;

  if (linkedAnim) {
    html += `
    <div class="detail-section">
      <div class="detail-section-header">Linked Animation</div>
      <button class="detail-link" id="detail-anim-link" data-animid="${escapeAttr(linkedAnim.id)}"
        data-tooltip="This ScrollTrigger controls the playback of this animation. Click to jump to it in the Animations tab.">
        ▶ ${escapeHtml(linkedAnim.targetSelector || 'anonymous')}
      </button>
    </div>`;
  }

  if (st.invalidateOnRefresh === false && st.scrub !== false) {
    html += `
    <div class="lint-item lint-warning" style="margin:0">
      <div class="lint-item-header">
        <span class="lint-icon">⚠</span>
        <strong>Missing invalidateOnRefresh</strong>
      </div>
      <p class="lint-desc">Without <code>invalidateOnRefresh: true</code>, animation values are baked in at page load and won't update when the window is resized.</p>
      <div class="lint-fix"><strong>Fix:</strong> Add <code>invalidateOnRefresh: true</code> to this ScrollTrigger config.</div>
    </div>`;
  }

  html += `
    <div class="detail-section">
      <div class="detail-section-header">Actions</div>
      <button class="btn" id="detail-st-refresh"
        data-tooltip="Recalculate all ScrollTrigger positions — run this after layout changes, image loads, or font changes that affect page height.">Refresh All Triggers</button>
    </div>
  `;

  container.innerHTML = html;

  container.querySelector('#detail-st-markers')?.addEventListener('change', (e) => {
    sendCommand({ command: 'toggle_markers_one', id: st.id, value: e.target.checked });
  });

  container.querySelector('#detail-anim-link')?.addEventListener('click', (e) => {
    const animId = e.currentTarget.dataset.animid;
    switchToTab('animations');
    setTimeout(() => selectAnim(animId), 60);
  });

  container.querySelector('#detail-st-refresh')?.addEventListener('click', () => {
    sendCommand({ command: 'inject_js', code: 'if (window.ScrollTrigger) ScrollTrigger.refresh();' });
  });
}

function patchStDetail() {
  if (!selectedStId || !lastData) return;
  const st = lastData.scrollTriggers.find((s) => s.id === selectedStId);
  if (!st) return;

  const container  = document.getElementById('st-detail');
  const cls        = st.isActive ? 'dot-active' : 'dot-paused';
  const dot        = container.querySelector('#detail-st-dot');
  if (dot && dot.className !== `dot ${cls}`) dot.className = `dot ${cls}`;
  const stateEl = container.querySelector('#detail-st-state');
  if (stateEl) stateEl.textContent = st.isActive ? 'Active' : 'Inactive';
  const prog = container.querySelector('#detail-st-progress');
  if (prog) prog.textContent = Math.round(st.progress * 100) + '%';
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
    const item = stItemMap.get(id);
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

// ── Timeline Gantt view ───────────────────────────────────────────────────────
function renderTimelineView(data) {
  const container = document.getElementById('timeline-container');
  if (!timelineView) timelineView = new TimelineView(container);
  timelineView.render(data.animations, data.scrollTriggers);
}

// ── Linter tab ────────────────────────────────────────────────────────────────
function renderLinter(data) {
  const container = document.getElementById('lint-results');
  const results   = runLinter(data);

  if (!results.length) {
    container.innerHTML = '<div class="empty-state lint-pass">✓ No issues found. Looks good!</div>';
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
    const lintIcon = r.severity === 'error' ? '✕' : r.severity === 'warning' ? '⚠' : '💡';
    item.innerHTML = `
      <div class="lint-item-header">
        <span class="lint-icon">${lintIcon}</span>
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
    const list      = document.getElementById('overrides-list');

    if (!overrides.length) {
      list.innerHTML =
        '<div class="empty-state">No saved overrides yet. Use the Code tab to inject and save JavaScript for any URL.</div>';
      return;
    }

    list.innerHTML = '';
    overrides.forEach(([key, data]) => {
      const url     = key.replace('override_', '');
      const item    = document.createElement('div');
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

// ── Collapse / Expand all timeline groups ─────────────────────────────────────
document.getElementById('btn-collapse-all').addEventListener('click', () => {
  document.querySelectorAll('#anim-list .list-item-children').forEach((el) => { el.style.display = 'none'; });
  document.querySelectorAll('#anim-list .list-item-chevron').forEach((el) => { el.classList.remove('open'); });
  expandedTimelineIds.clear();
});

document.getElementById('btn-expand-all').addEventListener('click', () => {
  document.querySelectorAll('#anim-list .list-item-children').forEach((el) => { el.style.display = ''; });
  document.querySelectorAll('#anim-list .list-item-chevron').forEach((el) => { el.classList.add('open'); });
  lastData?.animations.filter((a) => a.type === 'timeline').forEach((a) => expandedTimelineIds.add(a.id));
});

// ── Global playback controls ──────────────────────────────────────────────────
document.getElementById('btn-play-all').addEventListener('click',    () => sendCommand({ command: 'play_all' }));
document.getElementById('btn-pause-all').addEventListener('click',   () => sendCommand({ command: 'pause_all' }));
document.getElementById('btn-reverse-all').addEventListener('click', () => sendCommand({ command: 'reverse_all' }));
document.getElementById('btn-restart-all').addEventListener('click', () => sendCommand({ command: 'restart_all' }));

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
        setTimeout(() => chrome.devtools.inspectedWindow.eval('window.location.reload()'), 800);
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
  const el = document.getElementById('css-inject-result');
  el.style.display = '';
  el.className     = 'inject-result success';
  el.textContent   = '✓ CSS injected into page';
  setTimeout(() => { el.style.display = 'none'; }, 4000);
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
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
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
  const modal  = document.getElementById('prop-editor-modal');
  const editor = document.getElementById('prop-editor');
  document.getElementById('modal-title').textContent = `Edit: ${anim.targetSelector || 'anonymous'}`;

  const editableProps = [
    'x','y','xPercent','yPercent','rotation','scale','scaleX','scaleY',
    'opacity','autoAlpha','duration','ease','delay',
  ];

  editor.innerHTML = editableProps.map((prop) => {
    const val     = anim.vars[prop] !== undefined ? anim.vars[prop] : '';
    const tooltip = PROP_TOOLTIPS[prop] || prop;
    return `
      <div class="prop-row">
        <label class="prop-label" data-tooltip="${escapeAttr(tooltip)}">${prop}</label>
        <input class="prop-input" type="text" name="${prop}" value="${escapeAttr(String(val))}" placeholder="unchanged">
      </div>
    `;
  }).join('');

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
  x:          'Horizontal movement in pixels (CSS transform translateX — GPU-accelerated). Preferred over left/margin-left.',
  y:          'Vertical movement in pixels (CSS transform translateY — GPU-accelerated). Preferred over top.',
  xPercent:   "Horizontal movement as a percentage of the element's own width. Useful for centring tricks.",
  yPercent:   "Vertical movement as a percentage of the element's own height.",
  rotation:   'Rotation in degrees. 360 = full rotation. Negative values rotate counter-clockwise.',
  scale:      '1 = original size, 0.5 = half size, 2 = double size. Uniform scale on both axes.',
  scaleX:     'Horizontal scale only.',
  scaleY:     'Vertical scale only.',
  opacity:    'CSS opacity from 0 (invisible) to 1 (fully visible). Element remains in tab order even at 0.',
  autoAlpha:  'GSAP combined opacity + CSS visibility. At 0, sets visibility:hidden (removes from tab order). Above 0, restores visibility:visible.',
  duration:   'How long the animation takes in seconds. Default is 0.5s in GSAP 3.',
  ease:       'Easing function. Examples: "power2.out" (decelerates), "elastic.out(1,0.3)" (bounces), "none" (linear).',
  delay:      'Seconds to wait before starting. For sequencing inside timelines, prefer the position parameter instead.',
  overwrite:  'Controls what happens when a new tween targets the same property on the same element. true = kill all existing tweens. "auto" = only kill conflicting properties (recommended).',
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
  const el       = document.getElementById('js-inject-result');
  el.style.display = '';
  el.className   = `inject-result ${msg.success ? 'success' : 'error'}`;
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
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Apply saved overrides on panel load ───────────────────────────────────────
chrome.devtools.inspectedWindow.eval('window.location.href', (pageUrl) => {
  if (!pageUrl) return;
  chrome.storage.local.get(`override_${pageUrl}`, (items) => {
    const override = items[`override_${pageUrl}`];
    if (override?.active && override.code) {
      sendCommand({ command: 'inject_js', code: override.code });
    }
  });
});
