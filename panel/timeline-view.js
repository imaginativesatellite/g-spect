// timeline-view.js — SVG Gantt-style timeline renderer for GSAP Inspector panel.
// Exported as an ES module; consumed by panel.js.

export class TimelineView {
  constructor(container) {
    this.container = container;
    this.zoom = 1;
    this.animations = [];
    this.scrollTriggers = [];
  }

  render(animations, scrollTriggers) {
    this.animations = animations;
    this.scrollTriggers = scrollTriggers;
    this.container.innerHTML = '';

    if (!animations.length) {
      this.container.innerHTML =
        '<div class="tl-empty">No animations detected on this page.</div>';
      return;
    }

    // Top-level animations: global timeline children (depth 0 or 1)
    const topLevel = animations.filter((a) => a.depth <= 1);

    if (!topLevel.length) {
      this.container.innerHTML =
        '<div class="tl-empty">No animations detected.</div>';
      return;
    }

    const header = this._renderHeader();
    this.container.appendChild(header);

    topLevel.forEach((anim) => {
      const section = this._renderAnimationSection(
        anim,
        animations,
        scrollTriggers
      );
      this.container.appendChild(section);
    });
  }

  // ── Header row with legend + zoom control ────────────────────────────────────
  _renderHeader() {
    const div = document.createElement('div');
    div.className = 'tl-header';
    div.innerHTML = `
      <span class="tl-legend">
        <span class="tl-swatch transform"></span> Transform
        <span class="tl-swatch opacity"></span> Opacity
        <span class="tl-swatch color"></span> Color
        <span class="tl-swatch layout"></span> Layout
        <span class="tl-swatch other"></span> Other
      </span>
      <label class="tl-zoom-label">
        Zoom:
        <input type="range" class="tl-zoom" min="1" max="4" step="0.5" value="${this.zoom}">
        <span class="tl-zoom-val">${this.zoom}×</span>
      </label>
    `;

    div.querySelector('.tl-zoom').addEventListener('input', (e) => {
      this.zoom = parseFloat(e.target.value);
      div.querySelector('.tl-zoom-val').textContent = this.zoom + '×';
      // Re-render in place (replaces everything including this header)
      this.render(this.animations, this.scrollTriggers);
    });

    return div;
  }

  // ── One section per top-level animation/timeline ─────────────────────────────
  _renderAnimationSection(anim, allAnimations, scrollTriggers) {
    const isScrollLinked =
      anim.isScrollLinked ||
      scrollTriggers.some((st) => st.progress !== undefined && st.scrub !== false);
    const isTimeline = anim.type === 'timeline';

    // Children to render as rows: for a timeline, its direct children; for a tween, itself
    const children = isTimeline
      ? allAnimations.filter((a) => a.depth === anim.depth + 1)
      : [anim];

    const totalDuration = isScrollLinked ? 1 : Math.max(anim.duration || 1, 0.001);
    const WIDTH = 500 * this.zoom;
    const ROW_HEIGHT = 28;
    const LABEL_WIDTH = 140;
    const svgHeight = Math.max(children.length * ROW_HEIGHT + 40, 60);

    const section = document.createElement('div');
    section.className = 'tl-section';

    // Title bar
    const titleBar = document.createElement('div');
    titleBar.className = 'tl-title';
    const typeLabel = isScrollLinked
      ? '<span class="tl-badge scroll">Scroll-linked</span>'
      : '<span class="tl-badge time">Time-based</span>';
    const axisNote = isScrollLinked
      ? '<span class="tl-axis-note">X axis = scroll progress (0% → 100%)</span>'
      : `<span class="tl-axis-note">X axis = time (0s → ${totalDuration.toFixed(2)}s)</span>`;

    titleBar.innerHTML = `
      <span class="tl-name">${isTimeline ? '⏱ Timeline' : '▶ Tween'}: ${
      anim.targetSelector || 'anonymous'
    }</span>
      ${typeLabel}
      ${axisNote}
    `;
    section.appendChild(titleBar);

    // SVG
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', String(LABEL_WIDTH + WIDTH + 20));
    svg.setAttribute('height', String(svgHeight));
    svg.setAttribute('class', 'tl-svg');

    // ── Axis ────────────────────────────────────────────────────────────────────
    const axisY = svgHeight - 16;

    const axisLine = document.createElementNS(svgNS, 'line');
    axisLine.setAttribute('x1', String(LABEL_WIDTH));
    axisLine.setAttribute('y1', String(axisY));
    axisLine.setAttribute('x2', String(LABEL_WIDTH + WIDTH));
    axisLine.setAttribute('y2', String(axisY));
    axisLine.setAttribute('class', 'tl-axis-line');
    svg.appendChild(axisLine);

    // Axis ticks (5 marks: 0%, 25%, 50%, 75%, 100%)
    for (let i = 0; i <= 4; i++) {
      const x = LABEL_WIDTH + (WIDTH * i) / 4;

      const tick = document.createElementNS(svgNS, 'line');
      tick.setAttribute('x1', String(x));
      tick.setAttribute('y1', String(axisY - 3));
      tick.setAttribute('x2', String(x));
      tick.setAttribute('y2', String(axisY + 3));
      tick.setAttribute('class', 'tl-tick');
      svg.appendChild(tick);

      const label = document.createElementNS(svgNS, 'text');
      label.setAttribute('x', String(x));
      label.setAttribute('y', String(axisY + 12));
      label.setAttribute('class', 'tl-tick-label');
      label.textContent = isScrollLinked
        ? `${i * 25}%`
        : `${((totalDuration * i) / 4).toFixed(1)}s`;
      svg.appendChild(label);
    }

    // ── Rows ────────────────────────────────────────────────────────────────────
    children.forEach((child, i) => {
      const y = i * ROW_HEIGHT + 8;

      // Row label (truncated via SVG text)
      const labelText = document.createElementNS(svgNS, 'text');
      labelText.setAttribute('x', String(LABEL_WIDTH - 6));
      labelText.setAttribute('y', String(y + ROW_HEIGHT / 2 + 4));
      labelText.setAttribute('class', 'tl-row-label');
      const labelStr = child.targetSelector || 'anonymous';
      labelText.textContent =
        labelStr.length > 16 ? labelStr.slice(0, 15) + '…' : labelStr;
      svg.appendChild(labelText);

      // Track background
      const track = document.createElementNS(svgNS, 'rect');
      track.setAttribute('x', String(LABEL_WIDTH));
      track.setAttribute('y', String(y + 4));
      track.setAttribute('width', String(WIDTH));
      track.setAttribute('height', String(ROW_HEIGHT - 8));
      track.setAttribute('class', 'tl-track');
      svg.appendChild(track);

      // Bar position
      const startFrac = isScrollLinked
        ? 0
        : totalDuration > 0
        ? Math.min(child.startTime / totalDuration, 1)
        : 0;
      const durFrac = isScrollLinked
        ? 1
        : totalDuration > 0
        ? Math.min(child.duration / totalDuration, 1 - startFrac)
        : 1;
      const barX = LABEL_WIDTH + startFrac * WIDTH;
      const barW = Math.max(durFrac * WIDTH, 4);

      // Colour class based on animated properties
      const props = Object.keys(child.vars || {});
      let colorClass = 'other';
      if (
        props.some((p) =>
          [
            'x','y','xPercent','yPercent','rotation','scale',
            'scaleX','scaleY','skewX','skewY','rotationX','rotationY',
          ].includes(p)
        )
      ) {
        colorClass = 'transform';
      } else if (props.some((p) => ['opacity', 'autoAlpha'].includes(p))) {
        colorClass = 'opacity';
      } else if (
        props.some((p) =>
          ['color', 'backgroundColor', 'fill', 'stroke', 'borderColor'].includes(p)
        )
      ) {
        colorClass = 'color';
      } else if (
        props.some((p) =>
          ['width', 'height', 'padding', 'margin', 'top', 'left', 'right', 'bottom'].includes(p)
        )
      ) {
        colorClass = 'layout';
      }

      const bar = document.createElementNS(svgNS, 'rect');
      bar.setAttribute('x', String(barX));
      bar.setAttribute('y', String(y + 4));
      bar.setAttribute('width', String(barW));
      bar.setAttribute('height', String(ROW_HEIGHT - 8));
      bar.setAttribute('class', `tl-bar ${colorClass}`);
      bar.setAttribute('data-id', child.id);
      bar.setAttribute('rx', '3');

      // Native SVG tooltip
      const titleEl = document.createElementNS(svgNS, 'title');
      const propList =
        Object.entries(child.vars || {})
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ') || 'no props';
      const durationStr = isScrollLinked
        ? `${(child.duration * 100).toFixed(0)}% of scroll`
        : `${child.duration.toFixed(2)}s`;
      titleEl.textContent = [
        child.targetSelector || 'anonymous',
        propList,
        `Duration: ${durationStr}`,
        `Ease: ${child.vars?.ease || 'default'}`,
      ].join('\n');
      bar.appendChild(titleEl);

      svg.appendChild(bar);

      // Progress indicator line
      if (child.progress > 0 && child.progress < 1) {
        const progX = barX + child.progress * barW;
        const progLine = document.createElementNS(svgNS, 'line');
        progLine.setAttribute('x1', String(progX));
        progLine.setAttribute('y1', String(y + 2));
        progLine.setAttribute('x2', String(progX));
        progLine.setAttribute('y2', String(y + ROW_HEIGHT - 2));
        progLine.setAttribute('class', 'tl-progress-line');
        svg.appendChild(progLine);
      }
    });

    section.appendChild(svg);
    return section;
  }
}
