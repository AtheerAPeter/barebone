/**
 * Drawings an agent puts on a page for the user to see, to teach or explain:
 * boxes and arrows with labels, a pointer that glides to what it shows, and a
 * caption card. PageDriver.overlay runs OVERLAY in the page's isolated world,
 * where page scripts cannot reach its state.
 *
 * The drawings sit in the page's top layer (a manual popover), so they show
 * over the page's own dialogs too. They take no clicks, and they are left out
 * of snapshots (aria-hidden, in a closed shadow root). Drawings on elements
 * follow them as the page scrolls or moves them; drawings at points stay with
 * the page's content. A new document starts without them.
 *
 * Text goes in with textContent and styles through a constructed stylesheet,
 * which pages that forbid inline styles or require Trusted Types still allow.
 */

export const COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const
export type Color = (typeof COLORS)[number]

/**
 * What a drawing marks: an element by ref, or a point or area of the viewport
 * (the latest screenshot's pixels).
 */
export type Target = { ref: string } | { x: number; y: number; width?: number; height?: number }

export type Shape =
  | { kind: 'box'; target: Target; label?: string; color: Color }
  /** Points at the target, from `from`, or from a spot up and to the side of it. */
  | { kind: 'arrow'; target: Target; from?: Target; label?: string; color: Color }

/**
 * Where the caption card goes: `auto` is the bottom, or the top when at the
 * bottom it would cover something the drawings mark.
 */
export type CaptionPosition = 'top' | 'bottom' | 'auto'

export type OverlayCommand =
  | { type: 'draw'; shapes: Shape[]; clear: boolean }
  /** No target hides the pointer. */
  | { type: 'point'; target?: Target; text?: string; color: Color }
  /** Empty text hides the caption. */
  | { type: 'caption'; text: string; position: CaptionPosition }
  /**
   * One step of a tutorial, in one go: the shapes drawn before go, these are
   * drawn, the pointer moves (or goes, without `point`), and the caption changes.
   */
  | {
      type: 'step'
      caption: string
      position: CaptionPosition
      point?: { target: Target; text?: string; color: Color }
      shapes: Shape[]
    }
  | { type: 'clear' }

export interface OverlayResult {
  /** A ref no element answers to any more; nothing was drawn. */
  missing?: string
  /** A ref that was out of view and was scrolled to the middle of it. */
  revealed?: string
  /** Shapes on the page after the command. */
  shapes: number
  /**
   * What is in the way, so the agent need not look: something a drawing marks
   * that is hidden or off the page, or that the caption or a label covers.
   */
  problems: string[]
}

/**
 * `function (command)`, run in a frame's isolated world. `injected` is the
 * global that holds Playwright's injected script, which resolves refs.
 */
export function overlayFunction(injected: string): string {
  return `function (command) {
  const injected = globalThis.${injected};
  const SVG = 'http://www.w3.org/2000/svg';
  const COLORS = {
    red: ['#e5484d', '#fff'],
    orange: ['#f76b15', '#fff'],
    yellow: ['#ffc53d', '#1c1c1c'],
    green: ['#30a46c', '#fff'],
    blue: ['#0090ff', '#fff'],
    purple: ['#8e4ec6', '#fff']
  };

  // Every ref is resolved before anything changes, so a stale one draws nothing.
  const targets = [];
  if (command.type === 'draw' || command.type === 'step') {
    for (const shape of command.shapes) targets.push(shape.target, shape.from);
  }
  if (command.type === 'point') targets.push(command.target);
  if (command.type === 'step' && command.point) targets.push(command.point.target);
  const placed = new Map();
  for (const target of targets) {
    if (!target) continue;
    if (target.ref) {
      const element = injected.querySelectorAll(injected.parseSelector('aria-ref=' + target.ref), document)[0];
      if (!element) return { missing: target.ref, shapes: 0, problems: [] };
      placed.set(target, { element, ref: target.ref, name: target.ref });
    } else {
      // Points are in the viewport now; kept in the document, they scroll with the content.
      placed.set(target, {
        x: target.x + scrollX,
        y: target.y + scrollY,
        width: target.width || 0,
        height: target.height || 0,
        name: 'the point at ' + Math.round(target.x) + ', ' + Math.round(target.y)
      });
    }
  }

  const overlay = globalThis.${injected}Overlay || (globalThis.${injected}Overlay = setup());

  /** Where a placed target is in the viewport now; null while its element is gone or hidden. */
  function rectOf(place) {
    if (place.element) {
      if (!place.element.isConnected) return null;
      const rect = place.element.getBoundingClientRect();
      if (!rect.width && !rect.height) return null;
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    }
    return { left: place.x - scrollX, top: place.y - scrollY, width: place.width, height: place.height };
  }

  const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

  /** Where the line from the rect's centre towards a point leaves the rect, \`gap\` outside it. */
  function edge(r, toward, gap) {
    const c = center(r);
    if (!r.width && !r.height) return c;
    const dx = toward.x - c.x;
    const dy = toward.y - c.y;
    const t = Math.min(
      dx ? (r.width / 2 + gap) / Math.abs(dx) : Infinity,
      dy ? (r.height / 2 + gap) / Math.abs(dy) : Infinity
    );
    // The point is inside the rect: start from the centre.
    if (t >= 1) return c;
    return { x: c.x + dx * t, y: c.y + dy * t };
  }

  /** Put an element's top left corner at x, y. */
  function move(node, x, y) {
    node.style.transform = 'translate(' + Math.round(x) + 'px, ' + Math.round(y) + 'px)';
  }

  function show(nodes, visible) {
    for (const node of nodes) node.style.display = visible ? '' : 'none';
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svg(tag, attributes) {
    const node = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    return node;
  }

  function setup() {
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.popover = 'manual';
    const style = {
      all: 'initial',
      display: 'block',
      position: 'fixed',
      inset: '0',
      width: 'auto',
      height: 'auto',
      margin: '0',
      padding: '0',
      border: '0',
      background: 'transparent',
      overflow: 'hidden',
      'pointer-events': 'none',
      'z-index': '2147483647'
    };
    for (const [name, value] of Object.entries(style)) host.style.setProperty(name, value, 'important');
    const root = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(\`
      * { box-sizing: border-box; }
      .shapes { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
      .text {
        position: absolute; left: 0; top: 0;
        font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        letter-spacing: normal; text-align: left;
        white-space: pre-wrap; overflow-wrap: anywhere;
      }
      .label { max-width: 260px; padding: 3px 8px; border-radius: 6px; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3); }
      .bubble { max-width: 260px; padding: 6px 10px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3); }
      .caption {
        left: 50%; top: auto; bottom: 24px; transform: translateX(-50%);
        width: max-content; max-width: min(640px, calc(100% - 32px));
        padding: 12px 16px; border-radius: 12px;
        background: rgba(24, 24, 24, 0.92); color: #fff; font-size: 15px; line-height: 1.5;
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.3);
      }
      .caption.top { top: 24px; bottom: auto; }
      .pointer { position: absolute; left: 0; top: 0; z-index: 2; width: 24px; height: 24px; overflow: visible; }
      .bubble { z-index: 2; }
      .pointer path { filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.4)); }
      .ring { transform-box: fill-box; transform-origin: center; animation: ring 0.9s ease-out 2; }
      @keyframes ring { from { opacity: 0.9; transform: scale(0.2); } to { opacity: 0; transform: scale(1); } }
    \`);
    root.adoptedStyleSheets = [sheet];
    const shapes = svg('svg', { class: 'shapes' });
    root.append(shapes);
    return { host, root, shapes, items: [], pointer: null, caption: null, frame: 0 };
  }

  function makeBox(shape) {
    const [fill, ink] = COLORS[shape.color];
    const place = placed.get(shape.target);
    const rect = svg('rect', { rx: 6, fill, 'fill-opacity': 0.08, stroke: fill, 'stroke-width': 3 });
    overlay.shapes.append(rect);
    const label = shape.label ? element('div', 'text label', shape.label) : null;
    if (label) {
      label.style.background = fill;
      label.style.color = ink;
      overlay.root.append(label);
    }
    const nodes = label ? [rect, label] : [rect];
    return {
      nodes,
      place,
      label,
      update() {
        const r = rectOf(place);
        show(nodes, r);
        if (!r) return;
        const pad = 4;
        const box = { left: r.left - pad, top: r.top - pad, width: r.width + 2 * pad, height: r.height + 2 * pad };
        rect.setAttribute('x', box.left);
        rect.setAttribute('y', box.top);
        rect.setAttribute('width', box.width);
        rect.setAttribute('height', box.height);
        if (!label) return;
        // Above the box, or below it when there is no room above.
        let top = box.top - label.offsetHeight - 6;
        if (top < 4) top = box.top + box.height + 6;
        move(label, clamp(box.left, 4, innerWidth - label.offsetWidth - 4), top);
      }
    };
  }

  function makeArrow(shape) {
    const [fill, ink] = COLORS[shape.color];
    const place = placed.get(shape.target);
    const from = shape.from ? placed.get(shape.from) : null;
    const line = svg('line', { stroke: fill, 'stroke-width': 3, 'stroke-linecap': 'round' });
    const head = svg('polygon', { fill });
    overlay.shapes.append(line, head);
    const label = shape.label ? element('div', 'text label', shape.label) : null;
    if (label) {
      label.style.background = fill;
      label.style.color = ink;
      overlay.root.append(label);
    }
    const nodes = label ? [line, head, label] : [line, head];
    return {
      nodes,
      place,
      label,
      update() {
        const r = rectOf(place);
        const f = from ? rectOf(from) : r && tail(r);
        show(nodes, r && f);
        if (!r || !f) return;
        const start = edge(f, center(r), 4);
        const end = edge(r, center(f), 6);
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        const size = 14;
        const corner = (turn) => (end.x - size * Math.cos(angle + turn)) + ',' + (end.y - size * Math.sin(angle + turn));
        head.setAttribute('points', end.x + ',' + end.y + ' ' + corner(0.45) + ' ' + corner(-0.45));
        line.setAttribute('x1', start.x);
        line.setAttribute('y1', start.y);
        // The line stops inside the head, so its round cap does not poke out of the tip.
        line.setAttribute('x2', end.x - size * 0.7 * Math.cos(angle));
        line.setAttribute('y2', end.y - size * 0.7 * Math.sin(angle));
        if (!label) return;
        // Behind the tail, along the arrow's line.
        const w = label.offsetWidth;
        const h = label.offsetHeight;
        const reach = Math.hypot(w / 2, h / 2) + 6;
        const x = start.x - reach * Math.cos(angle) - w / 2;
        const y = start.y - reach * Math.sin(angle) - h / 2;
        move(label, clamp(x, 4, innerWidth - w - 4), clamp(y, 4, innerHeight - h - 4));
      }
    };
  }

  /** Where an arrow without \`from\` starts: up and to the left of the target, or wherever there is room. */
  function tail(r) {
    const x = r.left - 90 >= 8 ? r.left - 90 : r.left + r.width + 90;
    const y = r.top - 70 >= 8 ? r.top - 70 : r.top + r.height + 70;
    return { left: x, top: y, width: 0, height: 0 };
  }

  function removeItems() {
    for (const item of overlay.items) for (const node of item.nodes) node.remove();
    overlay.items = [];
  }

  function removePointer() {
    if (!overlay.pointer) return;
    overlay.pointer.cursor.remove();
    overlay.pointer.bubble?.remove();
    overlay.pointer = null;
  }

  function removeCaption() {
    overlay.caption?.remove();
    overlay.caption = null;
  }

  /** The pointer glides from where it is to the target, then stays on it. */
  function point(target, text, color) {
    const [fill, ink] = COLORS[color];
    const place = placed.get(target);
    const r = rectOf(place);
    const previous = overlay.pointer;
    const at = previous?.at ?? (r ? center(r) : { x: innerWidth / 2, y: innerHeight / 2 });
    removePointer();
    const cursor = svg('svg', { class: 'pointer', viewBox: '0 0 24 24' });
    cursor.append(
      svg('circle', { class: 'ring', cx: 2, cy: 2, r: 22, fill: 'none', stroke: fill, 'stroke-width': 3 }),
      svg('path', { d: 'M2 2 L2 20 L7 15.5 L10.5 23 L13.8 21.5 L10.4 14.2 L17 14.2 Z', fill, stroke: '#fff', 'stroke-width': 1.5, 'stroke-linejoin': 'round' })
    );
    overlay.root.append(cursor);
    const bubble = text ? element('div', 'text bubble', text) : null;
    if (bubble) {
      bubble.style.background = fill;
      bubble.style.color = ink;
      overlay.root.append(bubble);
    }
    const distance = r ? Math.hypot(center(r).x - at.x, center(r).y - at.y) : 0;
    overlay.pointer = {
      place, cursor, bubble, at,
      from: at,
      start: performance.now(),
      duration: previous ? clamp(250 + distance * 0.6, 250, 900) : 0
    };
  }

  function updatePointer(now) {
    const pointer = overlay.pointer;
    const r = rectOf(pointer.place);
    const nodes = pointer.bubble ? [pointer.cursor, pointer.bubble] : [pointer.cursor];
    show(nodes, r);
    if (!r) return;
    const to = center(r);
    const t = pointer.duration ? clamp((now - pointer.start) / pointer.duration, 0, 1) : 1;
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const at = { x: pointer.from.x + (to.x - pointer.from.x) * eased, y: pointer.from.y + (to.y - pointer.from.y) * eased };
    pointer.at = at;
    // The arrow's tip is at (2, 2) of its box.
    move(pointer.cursor, at.x - 2, at.y - 2);
    if (!pointer.bubble) return;
    const w = pointer.bubble.offsetWidth;
    const h = pointer.bubble.offsetHeight;
    const x = at.x + 20 + w <= innerWidth - 8 ? at.x + 20 : at.x - w - 12;
    const y = at.y + 26 + h <= innerHeight - 8 ? at.y + 26 : at.y - h - 12;
    move(pointer.bubble, clamp(x, 8, innerWidth - w - 8), clamp(y, 8, innerHeight - h - 8));
  }

  /** Redraw every frame while there is something to follow. */
  function frame() {
    overlay.frame = 0;
    // A page that rewrites <html> takes the drawings out; put them back on top.
    if (!overlay.host.isConnected) raise();
    for (const item of overlay.items) item.update();
    if (overlay.pointer) updatePointer(performance.now());
    if (overlay.items.length || overlay.pointer) overlay.frame = requestAnimationFrame(frame);
  }

  /**
   * Over everything, the page's own dialogs and popovers included. Showing it
   * again puts it back on top of ones opened after it; that restarts its
   * animations, so it is done only when there are others.
   */
  function raise() {
    const host = overlay.host;
    if (!host.isConnected) document.documentElement.append(host);
    if (host.matches(':popover-open')) {
      const others = [...document.querySelectorAll(':modal, :popover-open')].some((node) => node !== host);
      if (!others) return;
      host.hidePopover();
    }
    host.showPopover();
  }

  /** Show the caption, or remove it when \`text\` is empty; \`auto\` keeps it off what is marked. */
  function setCaption(text, position) {
    removeCaption();
    if (!text) return;
    overlay.caption = element('div', 'text caption' + (position === 'top' ? ' top' : ''), text);
    overlay.root.append(overlay.caption);
    if (position === 'auto' && covered(overlay.caption.getBoundingClientRect()).length) {
      overlay.caption.classList.add('top');
    }
  }

  /** What the drawings and the pointer mark, by name. */
  function marked() {
    const marks = overlay.items.map((item) => ({ place: item.place, item }));
    if (overlay.pointer) marks.push({ place: overlay.pointer.place });
    return marks;
  }

  /** Whether a box hides much of a marked rect, or the point a rect without size is. */
  function hides(box, r) {
    if (!r.width || !r.height) {
      const c = center(r);
      return c.x >= box.left && c.x <= box.right && c.y >= box.top && c.y <= box.bottom;
    }
    const w = Math.min(r.left + r.width, box.right) - Math.max(r.left, box.left);
    const h = Math.min(r.top + r.height, box.bottom) - Math.max(r.top, box.top);
    return w > 0 && h > 0 && w * h >= 0.3 * r.width * r.height;
  }

  /** The names of what a box covers, but the mark of \`except\`, the item it belongs to. */
  function covered(box, except) {
    const names = [];
    for (const { place, item } of marked()) {
      if (item && item === except) continue;
      const r = rectOf(place);
      if (r && hides(box, r)) names.push(place.name);
    }
    return names;
  }

  function problems() {
    const found = new Set();
    for (const { place } of marked()) {
      const r = rectOf(place);
      if (!r) found.add(place.name + ' is hidden or has no size, so nothing shows on it');
      else if (r.top + r.height < 0 || r.top > innerHeight || r.left + r.width < 0 || r.left > innerWidth) {
        found.add(place.name + ' is outside the visible part of the page');
      }
    }
    if (overlay.caption) {
      for (const name of covered(overlay.caption.getBoundingClientRect())) found.add('The caption covers ' + name);
    }
    for (const item of overlay.items) {
      if (!item.label || item.label.style.display === 'none') continue;
      for (const name of covered(item.label.getBoundingClientRect(), item)) {
        found.add('The label on ' + item.place.name + ' covers ' + name);
      }
    }
    return [...found];
  }

  /** Scroll the first element the command names into view when it is out of it. */
  function reveal() {
    for (const target of targets) {
      const place = target && placed.get(target);
      if (!place?.element) continue;
      const r = place.element.getBoundingClientRect();
      const outside = r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth;
      if (!outside) return undefined;
      place.element.scrollIntoView({ block: 'center', inline: 'center' });
      return place.ref;
    }
    return undefined;
  }

  const revealed = reveal();
  const makers = { box: makeBox, arrow: makeArrow };
  switch (command.type) {
    case 'draw':
      if (command.clear) removeItems();
      for (const shape of command.shapes) overlay.items.push(makers[shape.kind](shape));
      break;
    case 'point':
      if (command.target) point(command.target, command.text, command.color);
      else removePointer();
      break;
    case 'step':
      removeItems();
      for (const shape of command.shapes) overlay.items.push(makers[shape.kind](shape));
      if (command.point) point(command.point.target, command.point.text, command.point.color);
      else removePointer();
      break;
    case 'clear':
      removeItems();
      removePointer();
      removeCaption();
      break;
  }
  raise();
  if (overlay.frame) cancelAnimationFrame(overlay.frame);
  // Placed now, so what is checked below, and a screenshot right after, find them where they belong.
  frame();
  // The caption last: where it goes depends on where the rest is.
  if (command.type === 'caption') setCaption(command.text, command.position);
  if (command.type === 'step') setCaption(command.caption, command.position);
  return { revealed, shapes: overlay.items.length, problems: problems() };
}`
}
