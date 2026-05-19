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

  // ── Wait for GSAP to be available ──────────────────────────────────────────
  let attempts = 0;
  const waitForGSAP = setInterval(() => {
    attempts++;
    if (window.gsap) {
      clearInterval(waitForGSAP);
      init();
    } else if (attempts > 100) {
      // ~5 seconds elapsed with no GSAP
      clearInterval(waitForGSAP);
      send({ type: 'gsap_not_found' });
    }
  }, 50);

  // ── Initialise once GSAP is present ────────────────────────────────────────
  function init() {
    sendInspectionData();
    // Poll for changes every 500ms so the panel stays in sync
    setInterval(sendInspectionData, 500);
  }

  // ── Helper: GSAP version ───────────────────────────────────────────────────
  function getGSAPVersion() {
    return window.gsap ? window.gsap.version || null : null;
  }

  // ── Helper: Webflow detection ──────────────────────────────────────────────
  function isWebflow() {
    return !!(
      window.Webflow ||
      document.documentElement.dataset.wfPage ||
      document.querySelector('[data-wf-page]')
    );
  }

  // ── Helper: Webflow Interactions 2 detection ───────────────────────────────
  function hasIx2() {
    return !!(
      (window.Webflow && window.Webflow.ix2) ||
      (window.Webflow &&
        window.Webflow.find &&
        window.Webflow.find('[data-wf-ix-interact]') &&
        window.Webflow.find('[data-wf-ix-interact]').length)
    );
  }

  // ── Helper: loaded GSAP plugins ───────────────────────────────────────────
  function getLoadedPlugins() {
    const plugins = [];
    const checks = [
      { name: 'ScrollTrigger', global: 'ScrollTrigger' },
      { name: 'ScrollToPlugin', global: 'ScrollToPlugin' },
      { name: 'Draggable', global: 'Draggable' },
      { name: 'Flip', global: 'Flip' },
      { name: 'MotionPathPlugin', global: 'MotionPathPlugin' },
      { name: 'MorphSVGPlugin', global: 'MorphSVGPlugin' },
      { name: 'DrawSVGPlugin', global: 'DrawSVGPlugin' },
      { name: 'SplitText', global: 'SplitText' },
      { name: 'GSDevTools', global: 'GSDevTools' },
      { name: 'Observer', global: 'Observer' },
      { name: 'TextPlugin', global: 'TextPlugin' },
      { name: 'EaselPlugin', global: 'EaselPlugin' },
      { name: 'PixiPlugin', global: 'PixiPlugin' },
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

  // ── Helper: sanitize tween vars for serialisation ──────────────────────────
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

  // ── Helper: build a CSS selector from a DOM element ───────────────────────
  function selectorFromElement(el) {
    if (!(el instanceof Element)) return '';
    if (el.id) return '#' + el.id;
    const className = String(el.className || '').trim();
    if (className) return '.' + className.split(/\s+/)[0];
    return el.tagName ? el.tagName.toLowerCase() : 'element';
  }

  // ── Walk gsap.globalTimeline and collect animation data ────────────────────
  function getAnimations() {
    if (!window.gsap || !window.gsap.globalTimeline) return [];

    const results = [];
    const seen = new Set();

    function walkTimeline(tl, depth) {
      if (!tl || seen.has(tl)) return;
      seen.add(tl);

      let children = [];
      if (typeof tl.getChildren === 'function') {
        try { children = tl.getChildren(false, true, true) || []; } catch (e) {}
      } else if (Array.isArray(tl._children)) {
        children = tl._children;
      }

      children.forEach((child) => {
        // Stamp a stable inspector ID
        if (!child._gsapInspectorId) {
          child._gsapInspectorId = Math.random().toString(36).slice(2);
        }

        const isTimeline =
          typeof child.getChildren === 'function' || Array.isArray(child._children);

        // Derive a human-readable target selector
        const target = child._targets && child._targets[0];
        let targetSelector = '';
        if (target instanceof Element) {
          targetSelector = selectorFromElement(target);
        } else if (typeof target === 'object' && target !== null) {
          targetSelector = 'object';
        }

        let progress = 0;
        try { progress = typeof child.progress === 'function' ? child.progress() : 0; } catch (e) {}
        let paused = false;
        try { paused = typeof child.paused === 'function' ? child.paused() : false; } catch (e) {}
        let reversed = false;
        try { reversed = typeof child.reversed === 'function' ? child.reversed() : false; } catch (e) {}
        let duration = 0;
        try { duration = typeof child.duration === 'function' ? child.duration() : 0; } catch (e) {}

        results.push({
          id: child._gsapInspectorId,
          type: isTimeline ? 'timeline' : 'tween',
          depth,
          targetSelector,
          duration,
          delay: child._delay || 0,
          startTime: child._start || 0,
          progress,
          paused,
          vars: sanitizeVars(child.vars || {}),
          timeScale: child._ts !== undefined ? child._ts : 1,
          repeat: child._repeat || 0,
          yoyo: child._yoyo || false,
          isScrollLinked: !!(child.scrollTrigger),
          reversed,
        });

        if (isTimeline) walkTimeline(child, depth + 1);
      });
    }

    walkTimeline(window.gsap.globalTimeline, 0);
    return results;
  }

  // ── Collect ScrollTrigger instances ───────────────────────────────────────
  function getScrollTriggers() {
    if (!window.ScrollTrigger || typeof window.ScrollTrigger.getAll !== 'function') return [];
    const all = window.ScrollTrigger.getAll();
    return all.map((st) => {
      if (!st._gsapInspectorId) {
        st._gsapInspectorId = Math.random().toString(36).slice(2);
      }
      let triggerSelector = '';
      if (st.trigger instanceof Element) {
        triggerSelector = selectorFromElement(st.trigger);
      }
      return {
        id: st._gsapInspectorId,
        triggerSelector,
        start: (st.vars && st.vars.start) || 'top bottom',
        end: (st.vars && st.vars.end) || 'bottom top',
        scrub: (st.vars && st.vars.scrub !== undefined) ? st.vars.scrub : false,
        pin: (st.vars && st.vars.pin) ? true : false,
        markers: (st.vars && st.vars.markers) ? true : false,
        progress: st.progress || 0,
        isActive: st.isActive || false,
        snap: (st.vars && st.vars.snap) ? st.vars.snap : false,
        toggleActions: (st.vars && st.vars.toggleActions) || 'play none none none',
        invalidateOnRefresh: (st.vars && st.vars.invalidateOnRefresh) ? true : false,
      };
    });
  }

  // ── Build and send full inspection payload ─────────────────────────────────
  function sendInspectionData() {
    const gsap = window.gsap;
    if (!gsap) return;

    let globalPaused = false;
    let globalTimeScale = 1;
    try {
      if (gsap.globalTimeline) {
        globalPaused =
          typeof gsap.globalTimeline.paused === 'function'
            ? gsap.globalTimeline.paused()
            : false;
        globalTimeScale =
          gsap.globalTimeline._ts !== undefined ? gsap.globalTimeline._ts : 1;
      }
    } catch (e) {}

    send({
      type: 'inspection_data',
      payload: {
        version: getGSAPVersion(),
        isGSAP3: !!(gsap.version && parseInt(gsap.version, 10) >= 3),
        isWebflow: isWebflow(),
        hasIx2: hasIx2(),
        plugins: getLoadedPlugins(),
        animations: getAnimations(),
        scrollTriggers: getScrollTriggers(),
        globalPaused,
        globalTimeScale,
        usesContext: false, // heuristic; can't reliably detect from outside
      },
    });
  }

  // ── Find a specific animation by inspector ID ──────────────────────────────
  function findAnim(id) {
    if (!window.gsap || !window.gsap.globalTimeline) return null;
    let all = [];
    try {
      all = window.gsap.globalTimeline.getChildren(true, true, true) || [];
    } catch (e) {}
    return all.find((a) => a._gsapInspectorId === id) || null;
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
        if (window.gsap && window.gsap.globalTimeline) {
          window.gsap.globalTimeline.timeScale(cmd.value);
        }
        break;

      case 'set_progress':
        if (window.gsap && window.gsap.globalTimeline) {
          window.gsap.globalTimeline.progress(cmd.value);
        }
        break;

      case 'toggle_markers_all':
        if (window.ScrollTrigger) {
          const all = window.ScrollTrigger.getAll ? window.ScrollTrigger.getAll() : [];
          all.forEach((st) => {
            st.vars.markers = cmd.value;
            const animation = st.animation;
            const vars = Object.assign({}, st.vars);
            st.kill();
            if (animation) {
              window.ScrollTrigger.create(Object.assign({}, vars, { animation }));
            } else {
              window.ScrollTrigger.create(vars);
            }
          });
          window.ScrollTrigger.refresh && window.ScrollTrigger.refresh();
        }
        break;

      case 'toggle_markers_one':
        if (window.ScrollTrigger) {
          const all = window.ScrollTrigger.getAll ? window.ScrollTrigger.getAll() : [];
          const st = all.find((s) => s._gsapInspectorId === cmd.id);
          if (st) {
            st.vars.markers = cmd.value;
            const animation = st.animation;
            const vars = Object.assign({}, st.vars);
            st.kill();
            if (animation) {
              window.ScrollTrigger.create(Object.assign({}, vars, { animation }));
            } else {
              window.ScrollTrigger.create(vars);
            }
          }
        }
        break;

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
        if (a && typeof a.progress === 'function') a.progress(cmd.value);
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
          const fn = new Function(cmd.code);
          fn();
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
        document.querySelectorAll('style[data-gsap-inspector]').forEach((s) => s.remove());
        send({ type: 'reset_complete' });
        break;
      }

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
          console.warn('[GSAP Inspector] Override error:', err);
        }
      }
    }
  });
})();
