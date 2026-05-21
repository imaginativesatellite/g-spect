// injected.js — Runs in the MAIN world (same scope as the page).
// Has direct access to window.gsap, window.ScrollTrigger, etc.

(function () {
  'use strict';

  // ── Messaging helpers ───────────────────────────────────────────────────────
  const send = (data) =>
    window.postMessage({ __gsap_inspector__: true, ...data }, '*');

  // ── Listen for commands forwarded from bridge.js ────────────────────────────
  window.addEventListener('message', (e) => {
    if (!e.data || !e.data.__gsap_inspector_cmd__) return;
    handleCommand(e.data);
  });

  // ── Monotonic ID counter — no collision risk ───────────────────────────────
  let _idCounter = 0;
  function nextId() { return String(++_idCounter); }

  // ── Poll interval ref for cleanup on panel close ───────────────────────────
  let _pollInterval = null;

  // ── Wait for GSAP to be available ──────────────────────────────────────────
  let attempts = 0;
  const waitInterval = setInterval(() => {
    attempts++;
    if (window.gsap) {
      clearInterval(waitInterval);
      init();
    } else if (attempts > 100) {
      clearInterval(waitInterval);
      send({ type: 'gsap_not_found' });
    }
  }, 50);

  // ── Initialise once GSAP is present ────────────────────────────────────────
  function init() {
    sendInspectionData();
    _pollInterval = setInterval(sendInspectionData, 500);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function getGSAPVersion() {
    return window.gsap ? window.gsap.version || null : null;
  }

  function isWebflow() {
    return !!(
      window.Webflow ||
      document.documentElement.dataset.wfPage ||
      document.querySelector('[data-wf-page]')
    );
  }

  function hasIx2() {
    return !!(
      (window.Webflow && window.Webflow.ix2) ||
      (window.Webflow &&
        window.Webflow.find &&
        window.Webflow.find('[data-wf-ix-interact]') &&
        window.Webflow.find('[data-wf-ix-interact]').length)
    );
  }

  function hasLegacyGSAP() {
    return !!(window.TweenMax || window.TweenLite || window.TimelineMax || window.TimelineLite);
  }

  function detectUsesContext() {
    if (!window.gsap || !window.gsap.globalTimeline) return false;
    try {
      const all = window.gsap.globalTimeline.getChildren(true, true, true) || [];
      return all.some((a) => a._ctx != null);
    } catch (e) {}
    return false;
  }

  function getLoadedPlugins() {
    const plugins = [];
    const checks = [
      { name: 'ScrollTrigger',    global: 'ScrollTrigger' },
      { name: 'ScrollToPlugin',   global: 'ScrollToPlugin' },
      { name: 'Draggable',        global: 'Draggable' },
      { name: 'Flip',             global: 'Flip' },
      { name: 'MotionPathPlugin', global: 'MotionPathPlugin' },
      { name: 'MorphSVGPlugin',   global: 'MorphSVGPlugin' },
      { name: 'DrawSVGPlugin',    global: 'DrawSVGPlugin' },
      { name: 'SplitText',        global: 'SplitText' },
      { name: 'GSDevTools',       global: 'GSDevTools' },
      { name: 'Observer',         global: 'Observer' },
      { name: 'TextPlugin',       global: 'TextPlugin' },
      { name: 'EaselPlugin',      global: 'EaselPlugin' },
      { name: 'PixiPlugin',       global: 'PixiPlugin' },
    ];
    checks.forEach(({ name, global: g }) => {
      if (
        window[g] ||
        (window.gsap && window.gsap.plugins && window.gsap.plugins[g.toLowerCase()]) ||
        (window.gsap && window.gsap.core && window.gsap.core.globals && window.gsap.core.globals()[g])
      ) {
        plugins.push(name);
      }
    });
    return plugins;
  }

  function sanitizeVars(vars) {
    const safe = {};
    const animProps = [
      'x', 'y', 'xPercent', 'yPercent', 'rotation', 'rotationX', 'rotationY',
      'scale', 'scaleX', 'scaleY', 'opacity', 'autoAlpha', 'width', 'height',
      'left', 'top', 'right', 'bottom', 'backgroundColor', 'color',
      'borderRadius', 'duration', 'ease', 'delay', 'repeat', 'yoyo',
      'stagger', 'transformOrigin', 'skewX', 'skewY', 'force3D',
      'overwrite', 'clearProps',
    ];
    animProps.forEach((p) => {
      if (vars[p] !== undefined) {
        const v = vars[p];
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          safe[p] = v;
        }
      }
    });
    return safe;
  }

  // Build a human-readable CSS selector by walking up the DOM (max 4 levels).
  function selectorFromElement(el) {
    if (!(el instanceof Element)) return '';
    if (el.id) return '#' + el.id;
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node !== document.body && depth < 4) {
      if (node.id) {
        parts.unshift('#' + node.id);
        break;
      }
      let part = node.tagName.toLowerCase();
      const cls = String(node.className || '').trim().split(/\s+/).filter(Boolean)[0];
      if (cls) {
        part += '.' + cls;
      } else {
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
      }
      parts.unshift(part);
      node = node.parentElement;
      depth++;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }

  // ── Walk globalTimeline and collect animations ─────────────────────────────
  function getAnimations() {
    if (!window.gsap || !window.gsap.globalTimeline) return [];
    const results = [];
    const seen = new Set();

    function walkTimeline(tl, depth, parentId) {
      if (!tl || seen.has(tl)) return;
      seen.add(tl);

      let children = [];
      if (typeof tl.getChildren === 'function') {
        try { children = tl.getChildren(false, true, true) || []; } catch (e) {}
      } else if (Array.isArray(tl._children)) {
        children = tl._children;
      }

      children.forEach((child) => {
        if (!child._gsapInspectorId) {
          child._gsapInspectorId = nextId();
        }

        const isTimeline =
          typeof child.getChildren === 'function' || Array.isArray(child._children);

        // Collect ALL element targets, not just the first.
        const targets = child._targets || [];
        const elementTargets = targets.filter((t) => t instanceof Element);
        let targetSelector = '';
        if (elementTargets.length === 1) {
          targetSelector = selectorFromElement(elementTargets[0]);
        } else if (elementTargets.length > 1) {
          const first = selectorFromElement(elementTargets[0]);
          targetSelector = first
            ? `${first} +${elementTargets.length - 1}`
            : `${elementTargets.length} elements`;
        } else if (targets.length > 0) {
          targetSelector = 'object';
        }

        let progress = 0, paused = false, reversed = false, duration = 0;
        try { progress = typeof child.progress  === 'function' ? child.progress()  : 0;    } catch (e) {}
        try { paused   = typeof child.paused    === 'function' ? child.paused()    : false; } catch (e) {}
        try { reversed = typeof child.reversed  === 'function' ? child.reversed()  : false; } catch (e) {}
        try { duration = typeof child.duration  === 'function' ? child.duration()  : 0;    } catch (e) {}

        results.push({
          id:             child._gsapInspectorId,
          parentId:       parentId || null,
          type:           isTimeline ? 'timeline' : 'tween',
          depth,
          targetSelector,
          targetCount:    elementTargets.length || targets.length,
          duration,
          delay:          child._delay || 0,
          startTime:      child._start || 0,
          progress,
          paused,
          vars:           sanitizeVars(child.vars || {}),
          timeScale:      child._ts !== undefined ? child._ts : 1,
          repeat:         child._repeat || 0,
          yoyo:           child._yoyo || false,
          isScrollLinked: !!(child.scrollTrigger),
          reversed,
        });

        if (isTimeline) walkTimeline(child, depth + 1, child._gsapInspectorId);
      });
    }

    walkTimeline(window.gsap.globalTimeline, 0, null);
    return results;
  }

  // ── Collect ScrollTrigger instances ───────────────────────────────────────
  function getScrollTriggers() {
    if (!window.ScrollTrigger || typeof window.ScrollTrigger.getAll !== 'function') return [];
    return window.ScrollTrigger.getAll().map((st) => {
      if (!st._gsapInspectorId) {
        st._gsapInspectorId = nextId();
      }
      return {
        id:                 st._gsapInspectorId,
        triggerSelector:    st.trigger instanceof Element ? selectorFromElement(st.trigger) : '',
        start:              (st.vars && st.vars.start)          || 'top bottom',
        end:                (st.vars && st.vars.end)            || 'bottom top',
        scrub:              st.vars && st.vars.scrub !== undefined ? st.vars.scrub : false,
        pin:                !!(st.vars && st.vars.pin),
        markers:            !!(st.vars && st.vars.markers),
        progress:           st.progress || 0,
        isActive:           st.isActive || false,
        snap:               st.vars && st.vars.snap ? st.vars.snap : false,
        toggleActions:      (st.vars && st.vars.toggleActions) || 'play none none none',
        invalidateOnRefresh: !!(st.vars && st.vars.invalidateOnRefresh),
        linkedAnimId:       (st.animation && st.animation._gsapInspectorId)
          ? st.animation._gsapInspectorId : null,
      };
    });
  }

  // ── Build and send full inspection payload ─────────────────────────────────
  function sendInspectionData() {
    const gsap = window.gsap;
    if (!gsap) return;

    let globalPaused = false, globalTimeScale = 1;
    try {
      if (gsap.globalTimeline) {
        globalPaused    = typeof gsap.globalTimeline.paused    === 'function' ? gsap.globalTimeline.paused()    : false;
        globalTimeScale = gsap.globalTimeline._ts !== undefined ? gsap.globalTimeline._ts : 1;
      }
    } catch (e) {}

    send({
      type: 'inspection_data',
      payload: {
        version:        getGSAPVersion(),
        isGSAP3:        !!(gsap.version && parseInt(gsap.version, 10) >= 3),
        isWebflow:      isWebflow(),
        hasIx2:         hasIx2(),
        hasLegacyGSAP:  hasLegacyGSAP(),
        plugins:        getLoadedPlugins(),
        animations:     getAnimations(),
        scrollTriggers: getScrollTriggers(),
        globalPaused,
        globalTimeScale,
        usesContext:    detectUsesContext(),
      },
    });
  }

  // ── Find animation by inspector ID ─────────────────────────────────────────
  function findAnim(id) {
    if (!window.gsap || !window.gsap.globalTimeline) return null;
    let all = [];
    try { all = window.gsap.globalTimeline.getChildren(true, true, true) || []; } catch (e) {}
    return all.find((a) => a._gsapInspectorId === id) || null;
  }

  // ── Reverse element inspector ──────────────────────────────────────────────
  let reverseInspectorActive = false;
  let reverseDebounce = null;

  function onPageMouseover(e) {
    if (!reverseInspectorActive) return;
    clearTimeout(reverseDebounce);
    reverseDebounce = setTimeout(() => {
      const el = e.target;
      if (!(el instanceof Element)) return;

      const animIds = [];
      const stIds   = [];

      if (window.gsap && window.gsap.globalTimeline) {
        let all = [];
        try { all = window.gsap.globalTimeline.getChildren(true, true, true) || []; } catch (_) {}
        all.forEach((anim) => {
          if (anim._targets && anim._targets.includes(el) && anim._gsapInspectorId) {
            animIds.push(anim._gsapInspectorId);
          }
        });
      }

      if (window.ScrollTrigger && typeof window.ScrollTrigger.getAll === 'function') {
        window.ScrollTrigger.getAll().forEach((st) => {
          if (st.trigger === el && st._gsapInspectorId) {
            stIds.push(st._gsapInspectorId);
          }
        });
      }

      if (animIds.length || stIds.length) {
        send({ type: 'reverse_highlight', animIds, stIds });
      } else {
        send({ type: 'reverse_unhighlight' });
      }
    }, 80);
  }

  // Cancel any pending highlight when the mouse leaves the document.
  function onPageMouseleave() {
    if (!reverseInspectorActive) return;
    clearTimeout(reverseDebounce);
  }

  document.addEventListener('mouseover',  onPageMouseover,  { passive: true });
  document.addEventListener('mouseleave', onPageMouseleave, { passive: true });

  // ── Element highlight overlay ──────────────────────────────────────────────
  function highlightEl(el, label) {
    clearHighlight();
    if (!(el instanceof Element)) return;

    const rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) return;

    const overlay = document.createElement('div');
    overlay.setAttribute('data-gsap-inspector-highlight', 'true');
    Object.assign(overlay.style, {
      position:      'fixed',
      top:           rect.top    + 'px',
      left:          rect.left   + 'px',
      width:         rect.width  + 'px',
      height:        rect.height + 'px',
      outline:       '2px solid #10B981',
      outlineOffset: '1px',
      background:    'rgba(16,185,129,0.08)',
      pointerEvents: 'none',
      zIndex:        '2147483647',
      boxSizing:     'border-box',
    });

    if (label) {
      const badge = document.createElement('div');
      Object.assign(badge.style, {
        position:      'absolute',
        top:           '-22px',
        left:          '0',
        background:    '#10B981',
        color:         '#fff',
        fontSize:      '10px',
        fontFamily:    'system-ui, sans-serif',
        padding:       '2px 6px',
        borderRadius:  '3px',
        whiteSpace:    'nowrap',
        pointerEvents: 'none',
        lineHeight:    '1.5',
      });
      badge.textContent = label;
      overlay.appendChild(badge);
    }

    document.body.appendChild(overlay);
  }

  function clearHighlight() {
    document.querySelectorAll('[data-gsap-inspector-highlight]').forEach((el) => el.remove());
  }

  // ── Command handler ────────────────────────────────────────────────────────
  function handleCommand(cmd) {
    switch (cmd.command) {
      case 'play_all':
        if (window.gsap && window.gsap.globalTimeline) window.gsap.globalTimeline.play();
        break;

      case 'pause_all':
        if (window.gsap && window.gsap.globalTimeline) window.gsap.globalTimeline.pause();
        break;

      case 'reverse_all':
        if (window.gsap && window.gsap.globalTimeline) window.gsap.globalTimeline.reverse();
        break;

      case 'restart_all':
        if (window.gsap && window.gsap.globalTimeline) window.gsap.globalTimeline.restart();
        break;

      case 'set_timescale':
        if (window.gsap && window.gsap.globalTimeline) window.gsap.globalTimeline.timeScale(cmd.value);
        break;

      case 'set_progress':
        if (window.gsap && window.gsap.globalTimeline) window.gsap.globalTimeline.progress(cmd.value);
        break;

      // Panel closed: stop polling to avoid orphan intervals.
      case 'stop_inspection':
        clearInterval(_pollInterval);
        _pollInterval = null;
        break;

      // Manual rescan from panel when GSAP was not detected on initial load.
      case 'rescan': {
        if (window.gsap) {
          // GSAP is now available — start inspection if not already running.
          if (!_pollInterval) init();
          else sendInspectionData();
        } else {
          let scanAttempts = 0;
          const scanInterval = setInterval(() => {
            scanAttempts++;
            if (window.gsap) {
              clearInterval(scanInterval);
              if (!_pollInterval) init();
              else sendInspectionData();
            } else if (scanAttempts > 100) {
              clearInterval(scanInterval);
              send({ type: 'gsap_not_found' });
            }
          }, 50);
        }
        break;
      }

      case 'toggle_markers_all': {
        if (!window.ScrollTrigger) break;
        const all = window.ScrollTrigger.getAll ? window.ScrollTrigger.getAll() : [];
        const snapshots = all.map((st) => ({
          savedId:   st._gsapInspectorId,
          animation: st.animation,
          vars:      Object.assign({}, st.vars, { markers: cmd.value }),
        }));
        all.forEach((st) => st.kill());
        snapshots.forEach(({ savedId, animation, vars }) => {
          const newSt = animation
            ? window.ScrollTrigger.create(Object.assign({}, vars, { animation }))
            : window.ScrollTrigger.create(vars);
          if (newSt && savedId) newSt._gsapInspectorId = savedId;
        });
        if (window.ScrollTrigger.refresh) window.ScrollTrigger.refresh();
        break;
      }

      case 'toggle_markers_one': {
        if (!window.ScrollTrigger) break;
        const all = window.ScrollTrigger.getAll ? window.ScrollTrigger.getAll() : [];
        const st = all.find((s) => s._gsapInspectorId === cmd.id);
        if (st) {
          const savedId   = st._gsapInspectorId;
          const animation = st.animation;
          const vars      = Object.assign({}, st.vars, { markers: cmd.value });
          st.kill();
          const newSt = animation
            ? window.ScrollTrigger.create(Object.assign({}, vars, { animation }))
            : window.ScrollTrigger.create(vars);
          if (newSt && savedId) newSt._gsapInspectorId = savedId;
        }
        break;
      }

      case 'anim_play': {
        const a = findAnim(cmd.id);
        if (a && typeof a.play === 'function') a.play();
        break;
      }
      case 'anim_pause': {
        const a = findAnim(cmd.id);
        if (a && typeof a.pause === 'function') a.pause();
        break;
      }
      case 'anim_reverse': {
        const a = findAnim(cmd.id);
        if (a && typeof a.reverse === 'function') a.reverse();
        break;
      }
      case 'anim_restart': {
        const a = findAnim(cmd.id);
        if (a && typeof a.restart === 'function') a.restart();
        break;
      }
      case 'anim_set_progress': {
        const a = findAnim(cmd.id);
        // Clamp to 0–1 — GSAP accepts out-of-range values but the scrub slider shouldn't send them.
        if (a && typeof a.progress === 'function') a.progress(Math.max(0, Math.min(1, cmd.value)));
        break;
      }
      case 'anim_set_timescale': {
        const a = findAnim(cmd.id);
        if (a && typeof a.timeScale === 'function') a.timeScale(cmd.value);
        break;
      }

      case 'inject_js': {
        try {
          // eslint-disable-next-line no-new-func
          new Function(cmd.code)();
          send({ type: 'inject_result', success: true });
        } catch (e) {
          send({ type: 'inject_result', success: false, error: e.message });
        }
        break;
      }

      case 'inject_css': {
        try {
          const style = document.createElement('style');
          style.setAttribute('data-gsap-inspector', 'true');
          style.textContent = cmd.code;
          document.head.appendChild(style);
          send({ type: 'inject_result', success: true });
        } catch (e) {
          send({ type: 'inject_result', success: false, error: e.message });
        }
        break;
      }

      case 'reset_all': {
        if (window.gsap) {
          try { window.gsap.globalTimeline.clear(); } catch (e) {}
          try { window.gsap.killAll(); } catch (e) {}
        }
        if (window.ScrollTrigger) {
          try { window.ScrollTrigger.killAll(); } catch (e) {}
        }
        clearHighlight();
        document.querySelectorAll('style[data-gsap-inspector]').forEach((s) => s.remove());
        send({ type: 'reset_complete' });
        break;
      }

      case 'highlight_element': {
        clearHighlight();
        const anim = findAnim(cmd.id);
        if (anim && anim._targets) {
          anim._targets.forEach((target) => {
            if (target instanceof Element) highlightEl(target, cmd.label || '');
          });
        }
        break;
      }

      case 'highlight_st': {
        clearHighlight();
        if (window.ScrollTrigger) {
          const all = window.ScrollTrigger.getAll ? window.ScrollTrigger.getAll() : [];
          const st = all.find((s) => s._gsapInspectorId === cmd.id);
          if (st && st.trigger instanceof Element) {
            highlightEl(st.trigger, cmd.label || 'ScrollTrigger');
          }
        }
        break;
      }

      case 'unhighlight_element':
        clearHighlight();
        break;

      case 'set_reverse_inspector':
        reverseInspectorActive = !!cmd.active;
        if (!reverseInspectorActive) clearHighlight();
        break;

      default:
        break;
    }
  }

  // ── Receive saved override code forwarded from bridge ─────────────────────
  window.addEventListener('message', (e) => {
    if (e.data && e.data.__gsap_inspector_overrides__) {
      const { code } = e.data;
      if (code) {
        try {
          // eslint-disable-next-line no-new-func
          new Function(code)();
        } catch (err) {
          console.warn('[G-spect] Override error:', err);
        }
      }
    }
  });
})();
