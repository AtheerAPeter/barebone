/**
 * Drawings an agent puts on a page for the user to see, to teach or explain:
 * boxes, circles, highlights, underlines, arrows, notes and drawings of the
 * agent's own (SVG) with labels, a pointer that glides to what it shows, and
 * a caption card. PageDriver.overlay runs OVERLAY in the page's isolated world,
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
/** One of COLORS, or a hex color such as #1e90ff. */
export type Color = string

/**
 * What a drawing marks: an element by ref, or a point or area of the viewport
 * (the latest screenshot's pixels).
 */
export type Target = { ref: string } | { x: number; y: number; width?: number; height?: number }

/** Where a shape's label goes; by default above it, or below when there is no room above. */
export type LabelSide = 'top' | 'bottom' | 'left' | 'right' | 'inside'

/** How a shape is drawn; whatever is left out has the shape's usual look. */
export interface ShapeStyle {
  color: Color
  /** Line width in pixels. */
  stroke?: number
  dashed?: boolean
  /** How strongly the inside is tinted, 0 to 1. */
  fill?: number
  /** Room between the target and the shape, in pixels. */
  padding?: number
  /** A box's corner radius, in pixels. */
  radius?: number
  labelSide?: LabelSide
  /** CSS declarations for the label, such as "font-size: 18px; border-radius: 0". */
  labelStyle?: string
}

export type Shape = ShapeStyle &
  (
    | {
        /**
         * box: a frame around the target. circle: an ellipse around it.
         * highlight: a marker's tint over it. underline: a line under it.
         * note: only its label, at the target.
         */
        kind: 'box' | 'circle' | 'highlight' | 'underline' | 'note'
        target: Target
        label?: string
      }
    /** Points at the target, from `from`, or from a spot up and to the side of it. */
    | { kind: 'arrow'; target: Target; from?: Target; label?: string; head?: boolean }
    /**
     * The agent's own drawing, SVG markup, over the target: stretched to an
     * element or an area, at its own size at a point. Scripts, event
     * attributes and links out of it are taken out before it is drawn.
     */
    | { kind: 'svg'; target: Target; markup: string; label?: string }
  )

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

  /** A color's paint and the ink that reads on it: a named one, or a hex color with dark or white ink. */
  function paint(color) {
    if (COLORS[color]) return COLORS[color];
    const hex = color.slice(1);
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
    return [color, 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#1c1c1c' : '#fff'];
  }

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
      .drawing { position: absolute; left: 0; top: 0; overflow: visible; }
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

  /** A label for a shape, in its color and the agent's style, or null without text. */
  function makeLabel(shape, fill, ink) {
    if (!shape.label) return null;
    const label = element('div', 'text label', shape.label);
    label.style.background = fill;
    label.style.color = ink;
    if (shape.labelStyle) label.style.cssText += ';' + shape.labelStyle;
    overlay.root.append(label);
    return label;
  }

  /** Tags of an agent's SVG that could run code, load something, or hold a page of their own. */
  const UNSAFE = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed', 'image', 'audio', 'video', 'animation', 'handler', 'listener']);

  /**
   * The agent's SVG as nodes of this page, or null when it is not SVG. What
   * could run or load anything goes: unsafe tags, on* attributes, and links
   * other than to the drawing's own parts.
   */
  function drawing(markup) {
    // As HTML, which puts <svg> in SVG's namespace with or without xmlns; nothing in it runs.
    const root = new DOMParser().parseFromString(markup, 'text/html').body.firstElementChild;
    if (root?.localName !== 'svg') return null;
    for (const node of [root, ...root.querySelectorAll('*')]) {
      if (UNSAFE.has(node.localName.toLowerCase())) {
        node.remove();
        continue;
      }
      for (const { name, value } of [...node.attributes]) {
        const lower = name.toLowerCase();
        const link = lower === 'href' || lower.endsWith(':href');
        if (lower.startsWith('on') || (link && !value.trim().startsWith('#')) || /url\\(\\s*['"]?\\s*(?!#)/i.test(value)) {
          node.removeAttribute(name);
        }
      }
    }
    return document.importNode(root, true);
  }

  /** The agent's own drawing over its target, with its label. */
  function makeDrawing(shape) {
    const [fill, ink] = paint(shape.color);
    const place = placed.get(shape.target);
    let art = null;
    try {
      art = drawing(shape.markup);
    } catch {
      // A page whose rules forbid parsing markup: the label alone shows, and the result says so.
    }
    if (art) {
      art.classList.add('drawing');
      overlay.shapes.after(art);
    }
    const label = makeLabel(shape, fill, ink);
    const nodes = [art, label].filter(Boolean);
    const pad = shape.padding ?? 0;
    return {
      nodes,
      place,
      label,
      failed: art ? undefined : 'The SVG of the drawing on ' + place.name + ' could not be read, so only its label shows',
      update() {
        const r = rectOf(place);
        show(nodes, r);
        if (!r) return;
        const box = { left: r.left - pad, top: r.top - pad, width: r.width + 2 * pad, height: r.height + 2 * pad };
        if (art) {
          // Stretched over an element or an area; at a point, at its own size.
          if (box.width && box.height) {
            art.setAttribute('width', box.width);
            art.setAttribute('height', box.height);
          }
          move(art, box.left, box.top);
        }
        if (label) placeLabel(label, art ? art.getBoundingClientRect() : box, shape.labelSide ?? 'top');
      }
    };
  }

  /** Put a label by a box on the side asked for, kept in the window. */
  function placeLabel(label, box, side) {
    const w = label.offsetWidth;
    const h = label.offsetHeight;
    let x = box.left;
    let y = box.top - h - 6;
    if (side === 'bottom' || (side === 'top' && y < 4)) y = box.top + box.height + 6;
    if (side === 'left' || side === 'right') {
      x = side === 'left' ? box.left - w - 6 : box.left + box.width + 6;
      y = box.top + box.height / 2 - h / 2;
    }
    if (side === 'inside') {
      x = box.left + 6;
      y = box.top + 6;
    }
    move(label, clamp(x, 4, innerWidth - w - 4), clamp(y, 4, innerHeight - h - 4));
  }

  /** A shape drawn around or over its target: a box, circle, highlight, underline, or a note alone. */
  function makeOutline(shape) {
    const [fill, ink] = paint(shape.color);
    const place = placed.get(shape.target);
    const kind = shape.kind;
    const stroke = shape.stroke ?? 3;
    const lines = { stroke: fill, 'stroke-width': stroke, 'stroke-linecap': 'round' };
    if (shape.dashed) lines['stroke-dasharray'] = stroke * 3 + ' ' + stroke * 2;
    const tint = (usual) => ({ fill, 'fill-opacity': shape.fill ?? usual });
    const outline =
      kind === 'box' ? svg('rect', { rx: shape.radius ?? 6, ...tint(0.08), ...lines })
      : kind === 'circle' ? svg('ellipse', { ...tint(0.06), ...lines })
      : kind === 'highlight' ? svg('rect', { rx: shape.radius ?? 3, ...tint(0.35) })
      : kind === 'underline' ? svg('line', lines)
      : null;
    if (outline) overlay.shapes.append(outline);
    const label = makeLabel(shape, fill, ink);
    const nodes = [outline, label].filter(Boolean);
    const pad = shape.padding ?? (kind === 'highlight' ? 2 : kind === 'underline' || kind === 'note' ? 0 : 4);
    return {
      nodes,
      place,
      label,
      update() {
        const r = rectOf(place);
        show(nodes, r);
        if (!r) return;
        let box = { left: r.left - pad, top: r.top - pad, width: r.width + 2 * pad, height: r.height + 2 * pad };
        if (kind === 'box' || kind === 'highlight') {
          outline.setAttribute('x', box.left);
          outline.setAttribute('y', box.top);
          outline.setAttribute('width', box.width);
          outline.setAttribute('height', box.height);
        } else if (kind === 'circle') {
          // An ellipse through the box's corners would be too wide: this one rounds the box.
          const c = center(box);
          const rx = box.width * 0.6 + 6;
          const ry = box.height * 0.6 + 6;
          outline.setAttribute('cx', c.x);
          outline.setAttribute('cy', c.y);
          outline.setAttribute('rx', rx);
          outline.setAttribute('ry', ry);
          // Its label goes by the ellipse, which reaches past the box.
          box = { left: c.x - rx, top: c.y - ry, width: 2 * rx, height: 2 * ry };
        } else if (kind === 'underline') {
          const y = box.top + box.height + stroke / 2 + 2;
          outline.setAttribute('x1', box.left);
          outline.setAttribute('x2', box.left + box.width);
          outline.setAttribute('y1', y);
          outline.setAttribute('y2', y);
        }
        if (!label) return;
        // A note sits on its spot; other labels by their shape.
        if (kind === 'note') move(label, clamp(box.left, 4, innerWidth - label.offsetWidth - 4), clamp(box.top, 4, innerHeight - label.offsetHeight - 4));
        else placeLabel(label, box, shape.labelSide ?? 'top');
      }
    };
  }

  function makeArrow(shape) {
    const [fill, ink] = paint(shape.color);
    const place = placed.get(shape.target);
    const from = shape.from ? placed.get(shape.from) : null;
    const stroke = shape.stroke ?? 3;
    const line = svg('line', { stroke: fill, 'stroke-width': stroke, 'stroke-linecap': 'round' });
    if (shape.dashed) line.setAttribute('stroke-dasharray', stroke * 3 + ' ' + stroke * 2);
    const head = svg('polygon', { fill });
    const headed = shape.head !== false;
    overlay.shapes.append(line);
    if (headed) overlay.shapes.append(head);
    const label = makeLabel(shape, fill, ink);
    const nodes = [line, headed ? head : null, label].filter(Boolean);
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
        // The head grows with the line, and a line without one ends at the tip.
        const size = headed ? 11 + stroke : 0;
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
    const [fill, ink] = paint(color);
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
      if (item.failed) found.add(item.failed);
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
  const make = (shape) =>
    shape.kind === 'arrow' ? makeArrow(shape) : shape.kind === 'svg' ? makeDrawing(shape) : makeOutline(shape);
  switch (command.type) {
    case 'draw':
      if (command.clear) removeItems();
      for (const shape of command.shapes) overlay.items.push(make(shape));
      break;
    case 'point':
      if (command.target) point(command.target, command.text, command.color);
      else removePointer();
      break;
    case 'step':
      removeItems();
      for (const shape of command.shapes) overlay.items.push(make(shape));
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
