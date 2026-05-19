// gsap-linter.js — Static analysis rules for GSAP usage patterns.
// Exported as an ES module; consumed by panel.js.

/**
 * Run all linting rules against a snapshot of GSAP inspection data.
 * @param {object} data - The payload from injected.js inspection_data message.
 * @returns {Array<{severity: string, rule: string, title: string, description: string, fix: string}>}
 */
export function runLinter(data) {
  const results = [];
  const { version, isGSAP3, animations = [], scrollTriggers = [], plugins = [] } = data;

  function add(severity, rule, title, description, fix) {
    results.push({ severity, rule, title, description, fix });
  }

  // ── Rule 1: Null / missing target ─────────────────────────────────────────
  const nullTargets = animations.filter(
    (a) => a.type === 'tween' && a.targetSelector === ''
  );
  if (nullTargets.length > 0) {
    add(
      'error',
      'null-target',
      'Tween has no target',
      `${nullTargets.length} tween(s) have no target element. This usually means the element doesn't exist in the DOM when the tween was created. GSAP 3 silently skips null targets instead of throwing an error, so this can be easy to miss.`,
      'Make sure the element exists before creating the tween, or use gsap.context() to scope your animations.'
    );
  }

  // ── Rule 2: Plugin referenced but not detected as registered ──────────────
  const scrollLinkedExists =
    animations.some((a) => a.isScrollLinked) || scrollTriggers.length > 0;
  if (scrollLinkedExists && !plugins.includes('ScrollTrigger')) {
    add(
      'error',
      'plugin-not-registered',
      'ScrollTrigger used but may not be registered',
      'ScrollTrigger instances were detected, but ScrollTrigger does not appear in the loaded plugins list. In GSAP 3, all plugins must be registered with gsap.registerPlugin() before use.',
      'Add gsap.registerPlugin(ScrollTrigger) before creating any ScrollTrigger instances.'
    );
  }

  // ── Rule 3: GSAP 2 legacy API mixed with GSAP 3 ───────────────────────────
  if (isGSAP3) {
    const hasLegacy =
      typeof window !== 'undefined' &&
      (window.TweenMax ||
        window.TweenLite ||
        window.TimelineMax ||
        window.TimelineLite);
    if (hasLegacy) {
      add(
        'error',
        'gsap2-api-on-gsap3',
        'GSAP 2 API (TweenMax/TweenLite) detected on a GSAP 3 site',
        'TweenMax, TweenLite, TimelineMax, and TimelineLite are GSAP 2 classes. While GSAP 3 includes a compatibility layer, mixing APIs causes unpredictable behavior and performance issues.',
        'Replace all TweenMax.to() with gsap.to(), TweenMax.fromTo() with gsap.fromTo(), etc.'
      );
    }
  }

  // ── Rule 4: Scrubbed ScrollTrigger without invalidateOnRefresh ────────────
  const stWithoutInvalidate = scrollTriggers.filter(
    (st) => !st.invalidateOnRefresh && st.scrub !== false
  );
  if (stWithoutInvalidate.length > 0) {
    add(
      'warning',
      'missing-invalidate-on-refresh',
      'Scrubbed ScrollTriggers missing invalidateOnRefresh',
      `${stWithoutInvalidate.length} scroll-linked animation(s) don't use invalidateOnRefresh: true. When the viewport resizes, GSAP recalculates scroll positions but keeps the original animation values baked in — causing misalignment on mobile or after resize.`,
      'Add invalidateOnRefresh: true to your ScrollTrigger config for any animation that uses transforms or layout-dependent values.'
    );
  }

  // ── Rule 5: Many standalone tweens without a timeline ────────────────────
  const standaloneTweens = animations.filter(
    (a) => a.type === 'tween' && a.depth === 1
  );
  if (standaloneTweens.length > 5) {
    add(
      'tip',
      'prefer-timeline',
      `${standaloneTweens.length} standalone tweens — consider a timeline`,
      'Having many independent tweens is harder to control, sequence, and debug. A GSAP timeline lets you group, pause, reverse, and scrub all of them together with a single handle.',
      'Group related tweens into gsap.timeline() and use position parameters (">", "+=0.2", etc.) for sequencing.'
    );
  }

  // ── Rule 6: repeat: -1 on a scroll-linked animation ──────────────────────
  const infiniteScrollLinked = animations.filter(
    (a) => a.isScrollLinked && a.repeat === -1
  );
  if (infiniteScrollLinked.length > 0) {
    add(
      'warning',
      'infinite-repeat-scroll-linked',
      'repeat: -1 on a scroll-linked animation',
      "Using repeat: -1 (infinite loop) on an animation controlled by ScrollTrigger scrub doesn't work as expected. ScrollTrigger drives the progress from 0 to 1 — infinite repeats never complete a cycle correctly.",
      'Remove repeat: -1 from scroll-linked animations. For looping scroll effects, use yoyo: true instead, or structure the animation to go from start state to end state across the scroll range.'
    );
  }

  // ── Rule 7: Non-scrubbed ScrollTrigger still using default toggleActions ──
  const stMissingToggle = scrollTriggers.filter(
    (st) => !st.scrub && st.toggleActions === 'play none none none'
  );
  if (stMissingToggle.length > 0) {
    add(
      'tip',
      'default-toggle-actions',
      'ScrollTrigger using default toggleActions',
      `${stMissingToggle.length} ScrollTrigger(s) use the default toggleActions ("play none none none"), which means the animation only plays when scrolled into view and never reverses or resets. This is often unintentional on elements that scroll in and out.`,
      'Consider toggleActions: "play none none reverse" to reverse when scrolling back up, or "play pause resume reset" for a more interactive feel.'
    );
  }

  // ── Rule 8: Unusually large stagger value ─────────────────────────────────
  const heavyStagger = animations.filter(
    (a) => a.vars && a.vars.stagger && a.targetSelector
  );
  heavyStagger.forEach((a) => {
    if (typeof a.vars.stagger === 'number' && a.vars.stagger > 0.3) {
      add(
        'tip',
        'large-stagger',
        'Large stagger value detected',
        `A stagger of ${a.vars.stagger}s on "${a.targetSelector}" means elements animate far apart. For long lists, total animation time = stagger × count. On 20 elements with 0.5s stagger, the last element starts at 10s.`,
        'Consider reducing stagger or using stagger: { each: 0.1, from: "start" } with a from option for more control.'
      );
    }
  });

  // ── Rule 9: Mixing opacity and autoAlpha ──────────────────────────────────
  const opacityTweens = animations.filter(
    (a) => a.vars && a.vars.opacity !== undefined && a.vars.autoAlpha === undefined
  );
  const autoAlphaTweens = animations.filter(
    (a) => a.vars && a.vars.autoAlpha !== undefined
  );
  if (opacityTweens.length > 0 && autoAlphaTweens.length > 0) {
    add(
      'tip',
      'autoalpha-vs-opacity',
      'Mixing opacity and autoAlpha',
      "Some animations use opacity while others use autoAlpha. autoAlpha is GSAP's combined opacity + visibility property — when opacity reaches 0, it also sets visibility: hidden (removing the element from tab order and accessibility). Mixing both can cause elements to appear/disappear unexpectedly.",
      'Pick one approach. autoAlpha is generally preferred for show/hide animations. Use plain opacity only when you want the element to remain interactive at opacity 0.'
    );
  }

  // ── Rule 10: No gsap.context() with many animations ──────────────────────
  if (animations.length > 10 && !data.usesContext) {
    add(
      'tip',
      'use-gsap-context',
      'Consider using gsap.context() for cleanup',
      'With many animations on the page, using gsap.context() makes it easy to kill all animations within a specific container with a single .revert() call. This is especially important in React, Vue, or any component-based framework where components unmount.',
      'Wrap your animations: const ctx = gsap.context(() => { /* all your gsap code */ }, containerRef); then call ctx.revert() on cleanup.'
    );
  }

  return results;
}
