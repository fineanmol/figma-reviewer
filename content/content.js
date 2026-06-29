// ============================================================
// content/content.js — DOM Inspector & Overlay
// Injected into every page the extension is active on.
// All message types are prefixed FDR_ to avoid collisions.
// ============================================================

'use strict';

// Guard: only inject once. If already injected, the existing listener
// stays live — we just skip re-defining everything.
if (window.__FDR_INJECTED__) {
  // Already injected — nothing to do.
} else {
  window.__FDR_INJECTED__ = true;

  // ── State ──────────────────────────────────────────────────
  let pickerActive = false;
  let overlayEl    = null;
  let hoveredEl    = null;
  let markerLayer  = null;   // container for on-page diff markers
  let zoomApplied  = false;  // whether we've zoomed the page to match Figma

  // ── PrimeVue Token Map ────────────────────────────────────
  /**
   * Scans all accessible stylesheets for :root { --p-* } declarations
   * and builds a value → token-name reverse map.
   * Works dynamically with any PrimeVue theme configuration.
   */
  function buildTokenMap() {
    const map = {}; // CSS value string → [token names]

    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; } // cross-origin

      for (const rule of rules) {
        if (
          rule.type !== CSSRule.STYLE_RULE ||
          !rule.selectorText?.includes(':root')
        ) continue;

        for (let i = 0; i < rule.style.length; i++) {
          const prop = rule.style[i];
          if (!prop.startsWith('--p-')) continue;

          const raw = rule.style.getPropertyValue(prop).trim();
          if (!raw || raw.startsWith('var(')) continue;

          if (!map[raw]) map[raw] = [];
          if (!map[raw].includes(prop)) map[raw].push(prop);
        }
      }
    }

    return map;
  }

  // ── DOM Path ──────────────────────────────────────────────
  // Build a short, readable CSS-ish path to an element so the panel can
  // tell the developer *where* a value actually lives in the DOM.
  function domPath(el, maxDepth = 4) {
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < maxDepth) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += `#${node.id}`;
        parts.unshift(part);
        break; // id is unique enough — stop here
      }
      const cls = [...node.classList].filter(c => c !== '__fdr_highlight__')[0];
      if (cls) part += `.${cls}`;
      parts.unshift(part);
      node = node.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  // ── Rendered Gap Measurement ──────────────────────────────
  /**
   * Figma's "item spacing" (gap) can be satisfied many ways in code:
   * `gap` on the flex/grid parent, margins on children, or — common with
   * PrimeVue — a gap on an INNER wrapper because the outer component is a
   * library element you don't control. Reading computed `gap` on the picked
   * node alone produces false "gap mismatch" reports.
   *
   * Instead we MEASURE the real distance between adjacent children, which is
   * what the eye (and Figma) actually means. We also look one level into a
   * single wrapper child (the PrimeVue case), and we report which node and
   * which mechanism actually provides the spacing.
   *
   * Returns:
   *  { value, direction, source, sourceMechanism, sourcePath,
   *    childRects: [{left,top,width,height}], gapSpans: [{left,top,width,height}] }
   *  or null if there aren't enough children to measure.
   */
  function measureRenderedGap(target) {
    // Decide which node actually lays out the items.
    let layoutEl = target;
    let stepped = false;

    const flowChildren = (el) =>
      [...el.children].filter((c) => {
        if (isOurs(c)) return false;
        const s = getComputedStyle(c);
        if (s.display === 'none' || s.position === 'absolute' || s.position === 'fixed') return false;
        const r = c.getBoundingClientRect();
        return r.width > 0 || r.height > 0;
      });

    let kids = flowChildren(layoutEl);

    // PrimeVue / nested-wrapper case: the real flex/grid layout that spaces
    // the items can be several levels down inside library wrappers that each
    // have a single child. Descend through chains of single children until
    // we reach the node that actually distributes 2+ items. We bound the
    // descent so a deep single-child chain can't loop forever.
    let depth = 0;
    while (kids.length === 1 && depth < 8) {
      const inner = kids[0];
      const innerKids = flowChildren(inner);
      if (innerKids.length === 0) break;        // dead end
      layoutEl = inner;
      kids = innerKids;
      stepped = true;
      depth++;
      if (innerKids.length >= 2) break;          // found the layout node
    }

    if (kids.length < 2) return null;

    const cs = getComputedStyle(layoutEl);
    const rects = kids.map((c) => c.getBoundingClientRect());

    // Determine primary axis from layout, defaulting to whichever axis the
    // children are actually distributed along.
    const isRow =
      /flex/.test(cs.display)
        ? !/column/.test(cs.flexDirection)
        : rects[1].left >= rects[0].right - 1; // grid/block: infer from positions

    // Measure the gaps between adjacent children along the primary axis.
    const spans = [];
    const gaps = [];
    for (let i = 1; i < kids.length; i++) {
      const a = rects[i - 1];
      const b = rects[i];
      if (isRow) {
        const g = Math.round(b.left - a.right);
        if (g >= 0 && g < 400) {
          gaps.push(g);
          spans.push({ left: a.right, top: Math.min(a.top, b.top), width: Math.max(0, b.left - a.right), height: Math.max(a.height, b.height) });
        }
      } else {
        const g = Math.round(b.top - a.bottom);
        if (g >= 0 && g < 400) {
          gaps.push(g);
          spans.push({ left: Math.min(a.left, b.left), top: a.bottom, width: Math.max(a.width, b.width), height: Math.max(0, b.top - a.bottom) });
        }
      }
    }

    if (!gaps.length) return null;

    // Use the most common measured gap (mode) — robust to one odd child.
    const counts = {};
    for (const g of gaps) counts[g] = (counts[g] || 0) + 1;
    const value = Number(Object.keys(counts).sort((x, y) => counts[y] - counts[x])[0]);

    // Identify the mechanism that produced the spacing.
    let mechanism = 'spacing';
    const layoutGap = parseFloat(isRow ? cs.columnGap : cs.rowGap);
    if (!isNaN(layoutGap) && Math.abs(layoutGap - value) <= 1) {
      mechanism = `${/grid/.test(cs.display) ? 'grid' : 'flex'} gap`;
    } else {
      // Check margins on the children as the source.
      const childCs = getComputedStyle(kids[1]);
      const marginVal = parseFloat(isRow ? childCs.marginLeft : childCs.marginTop);
      if (!isNaN(marginVal) && Math.abs(marginVal - value) <= 1) mechanism = 'child margin';
    }

    return {
      value,
      direction: isRow ? 'row' : 'column',
      source: stepped ? 'inner wrapper' : 'self',
      sourceMechanism: mechanism,
      sourcePath: domPath(layoutEl),
      childRects: rects.map((r) => ({ left: r.left, top: r.top, width: r.width, height: r.height })),
      gapSpans: spans,
    };
  }

  // ── Effective Visual Spacing (content inset) ──────────────
  /**
   * Figma expresses padding as four sides; code might achieve the same
   * VISIBLE result with `padding`, child `margin`, or a wrapper. Comparing
   * computed `paddingLeft` etc. flags false mismatches when the result looks
   * identical.
   *
   * Instead we measure the EFFECTIVE inset: the gap between the element's
   * own border-box edges and the bounding box that encloses all its visible
   * children. That distance is what the eye sees as "padding", no matter how
   * it was coded. Returns { top, right, bottom, left } in px, or null if the
   * element has no measurable children (a leaf — use computed padding then).
   */
  function measureContentInset(target) {
    const kids = [...target.children].filter((c) => {
      if (isOurs(c)) return false;
      const s = getComputedStyle(c);
      if (s.display === 'none' || s.position === 'absolute' || s.position === 'fixed') return false;
      const r = c.getBoundingClientRect();
      return r.width > 0 || r.height > 0;
    });
    if (!kids.length) return null;

    const host = target.getBoundingClientRect();
    // Bounding box enclosing all children.
    let minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
    for (const c of kids) {
      const r = c.getBoundingClientRect();
      minL = Math.min(minL, r.left);
      minT = Math.min(minT, r.top);
      maxR = Math.max(maxR, r.right);
      maxB = Math.max(maxB, r.bottom);
    }

    return {
      top:    Math.max(0, Math.round(minT - host.top)),
      right:  Math.max(0, Math.round(host.right - maxR)),
      bottom: Math.max(0, Math.round(host.bottom - maxB)),
      left:   Math.max(0, Math.round(minL - host.left)),
    };
  }

  // ── CSS Extraction ────────────────────────────────────────
  function extractProps(target) {
    const cs  = getComputedStyle(target);
    const box = target.getBoundingClientRect();

    return {
      // Identity
      tagName:   target.tagName.toLowerCase(),
      classList: [...target.classList].filter(c => c !== '__fdr_highlight__'),
      id:        target.id,

      // Dimensions (from bounding box for accuracy)
      width:  Math.round(box.width),
      height: Math.round(box.height),

      // Padding
      paddingTop:    cs.paddingTop,
      paddingBottom: cs.paddingBottom,
      paddingLeft:   cs.paddingLeft,
      paddingRight:  cs.paddingRight,

      // Margin
      marginTop:    cs.marginTop,
      marginBottom: cs.marginBottom,
      marginLeft:   cs.marginLeft,
      marginRight:  cs.marginRight,

      // Gap (computed on the element itself)
      gap:       cs.gap,
      columnGap: cs.columnGap,
      rowGap:    cs.rowGap,

      // Gap (actually RENDERED between children — handles gap/margin/grid
      // and one-level PrimeVue wrappers). null if not measurable.
      renderedGap: measureRenderedGap(target),

      // Effective VISUAL padding: distance from this element's edges to the
      // box enclosing its children, regardless of padding/margin/wrapper.
      // null for leaf elements (fall back to computed padding then).
      contentInset: measureContentInset(target),

      // Where this element lives in the DOM (for pinpointing issues)
      domPath: domPath(target),

      // Border
      borderRadius:            cs.borderRadius,
      borderTopLeftRadius:     cs.borderTopLeftRadius,
      borderTopRightRadius:    cs.borderTopRightRadius,
      borderBottomRightRadius: cs.borderBottomRightRadius,
      borderBottomLeftRadius:  cs.borderBottomLeftRadius,
      borderColor:  cs.borderColor,
      borderWidth:  cs.borderWidth,
      borderStyle:  cs.borderStyle,

      // Colours
      backgroundColor: cs.backgroundColor,
      color:           cs.color,

      // Typography
      fontSize:      cs.fontSize,
      fontWeight:    cs.fontWeight,
      fontFamily:    cs.fontFamily,
      lineHeight:    cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      textAlign:     cs.textAlign,

      // Effects
      boxShadow: cs.boxShadow,
      opacity:   cs.opacity,

      // PrimeVue token map (scanned from page stylesheets)
      tokenMap: buildTokenMap(),
    };
  }

  // extractProps recomputes the (expensive) token map every call. For a
  // whole-tree scan of hundreds of nodes that's far too slow, so this
  // variant takes a prebuilt token map and reuses it for every node.
  function extractPropsWith(target, tokenMap) {
    const props = extractProps(target);
    props.tokenMap = tokenMap;
    return props;
  }

  // ── Geometry Tree Matching ─────────────────────────────────
  /**
   * Match a flattened Figma node tree to DOM elements by best bounding-box
   * overlap, then extract each matched element's props. This is what powers
   * "diff all children" and "verify whole page" — there is no shared id
   * between Figma and the DOM, so position is the most general signal.
   *
   * @param figmaNodes  flattened list from the panel: {id,name,type,depth,relX,relY,width,height}
   * @param rootSel     how to find the DOM root the figma frame maps to:
   *                    'auto' (whole-page: best match for the frame box) or
   *                    'picked' (use the last picked element as the root).
   */
  function matchTree(figmaNodes, rootSel) {
    if (!figmaNodes?.length) return { ok: false, reason: 'no figma nodes' };

    const tokenMap = buildTokenMap(); // build ONCE, reuse for every node

    // The first flattened node is the frame root.
    const frame = figmaNodes[0];

    // 1. Find the DOM root element the frame corresponds to.
    let rootEl;
    if (rootSel === 'picked') {
      rootEl = lastPicked && document.body.contains(lastPicked) ? lastPicked : null;
      if (!rootEl) return { ok: false, reason: 'no picked element — pick a root first' };
    } else {
      // auto: the element whose box best matches the frame's size, scanning
      // reasonably-sized blocks. Fall back to body.
      rootEl = findBestRoot(frame) || document.body;
    }

    const rootRect = rootEl.getBoundingClientRect();

    // 2. Collect candidate DOM elements once (visible, sized, in flow).
    const candidates = collectCandidates(rootEl);

    // 3. For each figma node, find the DOM candidate whose box (relative to
    //    the root) best overlaps the figma node's relative box.
    const results = [];
    const usedEls = new Set();

    for (const fn of figmaNodes) {
      // Figma rel box → expected DOM box relative to root.
      const target = { x: fn.relX, y: fn.relY, w: fn.width, h: fn.height };
      let best = null, bestScore = 0;

      for (const c of candidates) {
        const r = c.rect;
        const cand = {
          x: r.left - rootRect.left,
          y: r.top - rootRect.top,
          w: r.width,
          h: r.height,
        };
        const score = overlapScore(target, cand);
        // Prefer not reusing the same element for two figma nodes, but allow
        // it if nothing else fits (slightly penalise reuse).
        const adj = usedEls.has(c.el) ? score * 0.6 : score;
        if (adj > bestScore) { bestScore = adj; best = c; }
      }

      if (best && bestScore >= 0.35) {
        usedEls.add(best.el);
        results.push({
          figmaId: fn.id,
          matched: true,
          score: +bestScore.toFixed(2),
          props: extractPropsWith(best.el, tokenMap),
          markerRect: rectToAbs(best.rect),
        });
      } else {
        results.push({ figmaId: fn.id, matched: false, score: +bestScore.toFixed(2) });
      }
    }

    // Remember matched rects so we can (re)draw markers for the tree.
    lastTreeMarkers = results
      .filter(r => r.matched)
      .map(r => ({ figmaId: r.figmaId, rect: r.markerRect }));

    return {
      ok: true,
      rootPath: domPath(rootEl),
      matchedCount: results.filter(r => r.matched).length,
      total: results.length,
      results,
    };
  }

  // Intersection-over-union-ish score, blended with size similarity so a
  // huge container doesn't "win" every small node by enclosing it.
  function overlapScore(a, b) {
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const inter = ix * iy;
    if (inter <= 0) return 0;
    const union = a.w * a.h + b.w * b.h - inter;
    const iou = union > 0 ? inter / union : 0;
    // Size similarity (penalise large mismatch in area).
    const areaA = a.w * a.h, areaB = b.w * b.h;
    const sizeSim = areaA && areaB ? Math.min(areaA, areaB) / Math.max(areaA, areaB) : 0;
    // Center proximity bonus.
    const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
    const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const dist = Math.hypot(ca.x - cb.x, ca.y - cb.y);
    const diag = Math.hypot(a.w, a.h) || 1;
    const centerSim = Math.max(0, 1 - dist / diag);
    return iou * 0.6 + sizeSim * 0.25 + centerSim * 0.15;
  }

  // Find the DOM element that best matches the frame's overall box.
  function findBestRoot(frame) {
    const all = [...document.body.querySelectorAll('*')].filter(el => {
      if (isOurs(el)) return false;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 200 && r.height > 200; // frame-sized blocks only
    });
    let best = null, bestScore = 0;
    for (const el of all) {
      const r = el.getBoundingClientRect();
      // Compare against the frame placed at this element's own origin —
      // we only care about size similarity for the root.
      const score = overlapScore(
        { x: 0, y: 0, w: frame.width, h: frame.height },
        { x: 0, y: 0, w: r.width, h: r.height }
      );
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  // Gather visible, sized DOM elements under root (bounded for performance).
  function collectCandidates(root) {
    const out = [];
    const all = root.querySelectorAll('*');
    let count = 0;
    for (const el of all) {
      if (count > 4000) break; // safety bound on very large pages
      count++;
      if (isOurs(el)) continue;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      out.push({ el, rect });
    }
    return out;
  }

  function rectToAbs(rect) {
    // Store positions/sizes in the marker layer's document space (de-zoomed),
    // so tree markers land correctly when "Match Figma width" zoom is active.
    return {
      left: docX(rect.left),
      top: docY(rect.top),
      width: docSize(rect.width),
      height: docSize(rect.height),
    };
  }

  let lastTreeMarkers = [];

  // Shared floating tooltip for tree-marker hovers.
  let treeTooltip = null;
  function ensureTooltip() {
    if (treeTooltip && document.body.contains(treeTooltip)) return treeTooltip;
    treeTooltip = document.createElement('div');
    treeTooltip.id = '__fdr_tooltip__';
    Object.assign(treeTooltip.style, {
      position:      'fixed',
      zIndex:        '2147483647',
      display:       'none',
      maxWidth:      '340px',
      background:    'rgba(17,17,17,0.96)',
      color:         '#fff',
      fontSize:      '11px',
      fontFamily:    'ui-monospace, monospace',
      lineHeight:    '1.5',
      padding:       '6px 9px',
      borderRadius:  '5px',
      boxShadow:     '0 4px 16px rgba(0,0,0,0.4)',
      pointerEvents: 'none',
    });
    document.body.appendChild(treeTooltip);
    return treeTooltip;
  }

  // Draw markers for a tree diff: one box per node keyed by figma id, with
  // colour from the per-node status. Boxes WITH issues are hoverable and
  // show that node's specific mismatches in a tooltip.
  function drawTreeMarkers(statusById, infoById = {}) {
    ensureMarkerLayer();
    clearMarkers();
    const tip = ensureTooltip();
    tip.style.display = 'none';
    const colors = { mismatch: '#ef4444', warning: '#f59e0b', match: '#10b981', info: '#60a5fa' };

    // Draw problem boxes LAST (on top) so their hover target wins over the
    // big matched containers underneath.
    const ordered = [...lastTreeMarkers].sort((a, b) => {
      const sa = statusById[a.figmaId], sb = statusById[b.figmaId];
      const rank = s => (s === 'mismatch' ? 2 : s === 'warning' ? 1 : 0);
      return rank(sa) - rank(sb);
    });

    for (const m of ordered) {
      const status = statusById[m.figmaId] || 'match';
      const color = colors[status] || '#9b6dff';
      const hasIssue = status === 'mismatch' || status === 'warning';
      const info = infoById[m.figmaId];

      const box = document.createElement('div');
      Object.assign(box.style, {
        position:      'absolute',
        left:          `${m.rect.left}px`,
        top:           `${m.rect.top}px`,
        width:         `${m.rect.width}px`,
        height:        `${m.rect.height}px`,
        border:        `2px solid ${color}`,
        boxShadow:     `0 0 0 2px ${color}22`,
        borderRadius:  '2px',
        // Only problem boxes capture hover; matched ones stay click-through.
        pointerEvents: hasIssue ? 'auto' : 'none',
        boxSizing:     'border-box',
        cursor:        hasIssue ? 'help' : 'default',
      });

      if (hasIssue && info) {
        box.addEventListener('mouseenter', () => {
          tip.innerHTML =
            `<strong style="color:${color}">${info.name}</strong>` +
            (info.lines?.length
              ? '<br>' + info.lines.map(l => `&bull; ${l}`).join('<br>')
              : '<br>(see panel for details)');
          tip.style.display = 'block';
        });
        box.addEventListener('mousemove', (e) => {
          tip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - 350)}px`;
          tip.style.top  = `${Math.min(e.clientY + 14, window.innerHeight - 120)}px`;
        });
        box.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
      }

      markerLayer.appendChild(box);
    }
  }

  // ── Viewport / Scale info ──────────────────────────────────
  /**
   * Returns metrics the panel needs to reason about scale:
   *  - layoutWidth: CSS px width of the page (what Figma frames map to)
   *  - dpr: device pixel ratio (laptop retina → 2, etc.)
   * The "2592px DOM vs 1920px Figma" false mismatch comes from comparing
   * a frame designed at one layout width against a page at another.
   */
  function getViewportInfo() {
    // When we've constrained the page to the Figma width, the meaningful
    // "layout width" is the constrained body width, not the full window —
    // that's what the design now maps onto.
    const layoutWidth = widthConstraint
      ? Math.round(document.body.getBoundingClientRect().width)
      : document.documentElement.clientWidth;
    return {
      layoutWidth,
      layoutHeight: document.documentElement.clientHeight,
      innerWidth:   window.innerWidth,
      dpr:          window.devicePixelRatio || 1,
      zoom:         currentZoom(),
      constrained:  !!widthConstraint,
    };
  }

  // ── Match Figma width (zoom the page) ──────────────────────
  // We can't make the browser window physically wider than it is, but we
  // CAN zoom the page content so its layout width equals the Figma frame
  // width — making absolute-px comparisons meaningful. We use CSS zoom on
  // <html> (Chromium supports it and it reflows layout, unlike transform).
  function currentZoom() {
    const z = parseFloat(document.documentElement.style.zoom || '1');
    return isNaN(z) ? 1 : z;
  }

  // Convert a viewport coordinate (from getBoundingClientRect, which is in
  // UNZOOMED px) into the marker/overlay layer's document space. Those layers
  // live inside <html>, so when CSS zoom is applied for "Match Figma width"
  // their coordinate space is scaled by the zoom — without dividing here the
  // markers land far off (outside the screen). Returns document-space px.
  function docX(viewportLeft) {
    const z = currentZoom() || 1;
    return viewportLeft / z + window.scrollX;
  }
  function docY(viewportTop) {
    const z = currentZoom() || 1;
    return viewportTop / z + window.scrollY;
  }
  // Width/height also need de-zooming to match the de-zoomed positions.
  function docSize(px) {
    const z = currentZoom() || 1;
    return px / z;
  }

  // Saved inline styles so we can cleanly undo the width constraint.
  let widthConstraint = null; // { htmlWidth, htmlMaxWidth, htmlMargin, bodyWidth, bodyMaxWidth, bodyMargin }

  /**
   * Make the PAGE actually render at the Figma frame's width, so a
   * responsive layout reflows exactly as it would at that width — then the
   * overlay can sit 1:1 over the real UI.
   *
   * We do NOT use CSS zoom: zoom scales a 2592px layout down, it does not
   * re-flow it to the 1920px layout (wrong column counts, wrapping, etc.).
   * Instead we constrain <html>/<body> to `figmaWidth` and center it, which
   * forces the browser to lay the app out at that width for real.
   */
  function matchFigmaWidth(figmaWidth) {
    if (!figmaWidth) return getViewportInfo();
    const html = document.documentElement;
    const body = document.body;

    // Save originals once (so repeated calls don't lose them).
    if (!widthConstraint) {
      widthConstraint = {
        htmlWidth:    html.style.width,
        htmlMaxWidth: html.style.maxWidth,
        htmlMargin:   html.style.margin,
        htmlZoom:     html.style.zoom,
        bodyWidth:    body.style.width,
        bodyMaxWidth: body.style.maxWidth,
        bodyMargin:   body.style.margin,
        bodyOverflowX: body.style.overflowX,
      };
    }

    // Clear any old zoom from earlier versions.
    html.style.zoom = '';

    const w = `${Math.round(figmaWidth)}px`;
    // Constrain the body to the frame width and center it. Most apps anchor
    // layout to body/its first container, so this drives the reflow.
    body.style.width    = w;
    body.style.maxWidth = w;
    body.style.margin   = '0 auto';
    // Let the viewport scroll horizontally if the frame is wider than screen.
    html.style.overflowX = 'auto';

    zoomApplied = true;
    return {
      ...getViewportInfo(),
      constrainedWidth: Math.round(figmaWidth),
      effectiveWidth: body.getBoundingClientRect().width,
      figmaWidth,
    };
  }

  function resetZoom() {
    const html = document.documentElement;
    const body = document.body;
    if (widthConstraint) {
      html.style.width    = widthConstraint.htmlWidth;
      html.style.maxWidth = widthConstraint.htmlMaxWidth;
      html.style.margin   = widthConstraint.htmlMargin;
      html.style.zoom     = widthConstraint.htmlZoom;
      body.style.width    = widthConstraint.bodyWidth;
      body.style.maxWidth = widthConstraint.bodyMaxWidth;
      body.style.margin   = widthConstraint.bodyMargin;
      body.style.overflowX = widthConstraint.bodyOverflowX;
      widthConstraint = null;
    } else {
      html.style.zoom = '1';
    }
    html.style.overflowX = '';
    zoomApplied = false;
    return getViewportInfo();
  }

  // ── Overlay ───────────────────────────────────────────────
  // Remember the overlay's native aspect ratio so resizing keeps it.
  let overlayAspect = null; // height / width

  function ensureOverlay() {
    if (overlayEl && document.body.contains(overlayEl)) return;

    overlayEl = document.createElement('div');
    overlayEl.id = '__fdr_overlay__';

    Object.assign(overlayEl.style, {
      position:       'absolute',   // absolute → scrolls with the page content
      top:            '20px',
      left:           '20px',
      zIndex:         '2147483646',
      display:        'none',
      userSelect:     'none',
      pointerEvents:  'none',       // container passes clicks; handles re-enable
    });

    // The Figma image (sized by width; height follows aspect ratio).
    // Kept in normal flow so the container shrink-wraps to the image —
    // that way the corner resizer and handle anchor to the image edges.
    const img = document.createElement('img');
    img.id = '__fdr_overlay_img__';
    Object.assign(img.style, {
      position:  'static',
      opacity:   '0.5',
      maxWidth:  'none',
      display:   'block',
    });
    overlayEl.appendChild(img);

    // Drag handle (top bar)
    const handle = document.createElement('div');
    handle.id = '__fdr_handle__';
    handle.innerHTML = '<span>⠿ Figma overlay — drag to move</span>';
    Object.assign(handle.style, {
      position:      'absolute',
      top:           '0',          // sits INSIDE the top edge so it's never
      left:          '0',          // clipped off-screen and is always grabbable
      display:       'flex',
      alignItems:    'center',
      gap:           '6px',
      background:    'rgba(155, 109, 255, 0.95)',
      color:         '#fff',
      fontSize:      '11px',
      fontFamily:    'ui-monospace, monospace',
      padding:       '4px 8px',
      borderRadius:  '0 0 5px 0',
      cursor:        'move',
      pointerEvents: 'all',
      whiteSpace:    'nowrap',
      userSelect:    'none',
      touchAction:   'none',       // let pointer drag work on touch/trackpad
    });

    // Inline +/- size buttons on the handle bar.
    const mkBtn = (label, title) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      Object.assign(b.style, {
        all:           'unset',
        cursor:        'pointer',
        background:    'rgba(255,255,255,0.18)',
        color:         '#fff',
        width:         '18px',
        height:        '18px',
        lineHeight:    '18px',
        textAlign:     'center',
        borderRadius:  '4px',
        fontWeight:    '700',
        fontSize:      '13px',
        pointerEvents: 'all',
      });
      return b;
    };
    const minusBtn = mkBtn('−', 'Shrink overlay (5%)');
    const plusBtn  = mkBtn('+', 'Grow overlay (5%)');
    minusBtn.addEventListener('click', (e) => { e.stopPropagation(); nudgeOverlaySize(-0.05); });
    plusBtn.addEventListener('click',  (e) => { e.stopPropagation(); nudgeOverlaySize(+0.05); });
    handle.appendChild(minusBtn);
    handle.appendChild(plusBtn);

    overlayEl.appendChild(handle);

    // Resize handle (bottom-right corner) — drag to scale.
    const resizer = document.createElement('div');
    resizer.id = '__fdr_resizer__';
    Object.assign(resizer.style, {
      position:      'absolute',
      right:         '-6px',
      bottom:        '-6px',
      width:         '16px',
      height:        '16px',
      background:    '#9b6dff',
      border:        '2px solid #fff',
      borderRadius:  '3px',
      cursor:        'nwse-resize',
      pointerEvents: 'all',
      touchAction:   'none',
      boxShadow:     '0 1px 4px rgba(0,0,0,0.4)',
    });
    overlayEl.appendChild(resizer);

    document.body.appendChild(overlayEl);
    makeDraggable(overlayEl, handle);
    makeResizable(overlayEl, img, resizer);
  }

  // Robust drag using Pointer Events + pointer capture. Capture guarantees
  // every pointermove/up routes to the handle even when the cursor passes
  // over the page's own elements (which previously stole the mouse events
  // and made the overlay feel un-draggable). We also divide deltas by the
  // page zoom: when "Match Figma width" applies CSS zoom to <html>, pointer
  // coords are in unzoomed px but the overlay's left/top are in zoomed px.
  function makeDraggable(el, handle) {
    handle.addEventListener('pointerdown', (e) => {
      // Ignore the +/- buttons.
      if (e.target.tagName === 'BUTTON') return;
      e.preventDefault();
      e.stopPropagation();

      const z = currentZoom() || 1;
      const sx = e.clientX;
      const sy = e.clientY;
      const sl = parseFloat(el.style.left) || el.offsetLeft || 0;
      const st = parseFloat(el.style.top)  || el.offsetTop  || 0;

      try { handle.setPointerCapture(e.pointerId); } catch {}

      const move = (ev) => {
        el.style.left = `${sl + (ev.clientX - sx) / z}px`;
        el.style.top  = `${st + (ev.clientY - sy) / z}px`;
      };
      const up = (ev) => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup',   up);
        handle.removeEventListener('pointercancel', up);
        try { handle.releasePointerCapture(ev.pointerId); } catch {}
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup',   up);
      handle.addEventListener('pointercancel', up);
    });
  }

  // Drag the corner to resize; width drives, height keeps aspect ratio.
  function makeResizable(el, img, resizer) {
    resizer.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const z = currentZoom() || 1;
      try { resizer.setPointerCapture(e.pointerId); } catch {}
      const sx = e.clientX;
      const startW = parseFloat(img.style.width) || img.offsetWidth || 1;
      const aspect = overlayAspect || (img.offsetHeight / img.offsetWidth) || 1;

      const move = (ev) => {
        const w = Math.max(40, startW + (ev.clientX - sx) / z);
        img.style.width  = `${w}px`;
        img.style.height = `${w * aspect}px`;
        reportOverlaySize();
      };
      const up = (ev) => {
        resizer.removeEventListener('pointermove', move);
        resizer.removeEventListener('pointerup',   up);
        resizer.removeEventListener('pointercancel', up);
        try { resizer.releasePointerCapture(ev.pointerId); } catch {}
      };
      resizer.addEventListener('pointermove', move);
      resizer.addEventListener('pointerup',   up);
      resizer.addEventListener('pointercancel', up);
    });
  }

  // Grow/shrink the overlay by a fraction, keeping aspect ratio.
  function nudgeOverlaySize(delta) {
    if (!overlayEl) return;
    const img = overlayEl.querySelector('#__fdr_overlay_img__');
    const w = parseFloat(img.style.width) || img.offsetWidth || 1;
    const aspect = overlayAspect || (img.offsetHeight / img.offsetWidth) || 1;
    const nw = Math.max(40, w * (1 + delta));
    img.style.width  = `${nw}px`;
    img.style.height = `${nw * aspect}px`;
    reportOverlaySize();
  }

  // Tell the panel the current overlay width (so its Scale slider stays
  // in sync when the user resizes from the page).
  function reportOverlaySize() {
    const img = overlayEl?.querySelector('#__fdr_overlay_img__');
    if (!img) return;
    chrome.runtime.sendMessage({
      type: 'FDR_OVERLAY_RESIZED',
      width: Math.round(parseFloat(img.style.width) || img.offsetWidth || 0),
    });
  }

  /**
   * Size the overlay image. We render the Figma frame at the page's
   * layout width by default so the whole-screen design ghosts over the
   * live page at a comparable scale, rather than at its native 1920px.
   */
  function sizeOverlay(figmaWidth, figmaHeight, fit) {
    const img = overlayEl.querySelector('#__fdr_overlay_img__');
    if (!figmaWidth || !figmaHeight) return;

    overlayAspect = figmaHeight / figmaWidth; // remember for resizing

    if (fit) {
      // Scale the frame so its width matches the page's layout width.
      const pageWidth = document.documentElement.clientWidth;
      const scale = pageWidth / figmaWidth;
      img.style.width  = `${figmaWidth * scale}px`;
      img.style.height = `${figmaHeight * scale}px`;
    } else {
      img.style.width  = `${figmaWidth}px`;
      img.style.height = `${figmaHeight}px`;
    }
    // Report the resulting size so the panel's Scale slider reflects reality.
    reportOverlaySize();
  }

  /**
   * Align the overlay to a reference element on the page. This is the
   * accurate way to scale: the Figma frame's width is mapped onto the
   * reference element's ON-SCREEN width, and the overlay is positioned over
   * that element. So if your implementation is centered or narrower than the
   * viewport, the overlay still matches — it tracks the element, not the page
   * width. `refEl` defaults to the last picked element.
   *
   * @param frameWidth  the Figma frame's native width (px)
   * @param frameHeight the Figma frame's native height (px)
   */
  function alignOverlayToElement(frameWidth, frameHeight, refEl) {
    ensureOverlay();
    const el = refEl || (lastPicked && document.body.contains(lastPicked) ? lastPicked : null);
    if (!el) return { ok: false, reason: 'no reference element' };
    if (!frameWidth || !frameHeight) return { ok: false, reason: 'no frame size' };

    const img = overlayEl.querySelector('#__fdr_overlay_img__');
    const rect = el.getBoundingClientRect();
    const z = currentZoom() || 1;

    // Scale so the overlay's width equals the reference element's width.
    // getBoundingClientRect is in unzoomed px; the overlay lives in the
    // zoomed root, so divide by zoom to express sizes/positions in that space.
    const scale = (rect.width / z) / frameWidth;
    overlayAspect = frameHeight / frameWidth;
    img.style.width  = `${frameWidth * scale}px`;
    img.style.height = `${frameHeight * scale}px`;

    // Position the overlay's top-left over the reference element (document
    // space, so it scrolls with the page).
    overlayEl.style.left = `${docX(rect.left)}px`;
    overlayEl.style.top  = `${docY(rect.top)}px`;
    overlayEl.style.display = 'block';

    reportOverlaySize();
    return {
      ok: true,
      scale: +scale.toFixed(3),
      refWidth: Math.round(rect.width / z),
      frameWidth,
      refPath: domPath(el),
    };
  }

  // ── On-page Diff Markers ───────────────────────────────────
  function ensureMarkerLayer() {
    if (markerLayer && document.documentElement.contains(markerLayer)) return;
    markerLayer = document.createElement('div');
    markerLayer.id = '__fdr_markers__';
    // Anchored to <html> (the initial containing block), NOT <body> — an
    // absolute layer inside body inherits body's margin/offset, which is what
    // threw marker boxes onto the wrong elements. Children are placed in
    // document space (viewport coords + scroll), so markers scroll with the
    // page and land on the right element.
    Object.assign(markerLayer.style, {
      position:      'absolute',
      top:           '0',
      left:          '0',
      width:         '0',
      height:        '0',
      zIndex:        '2147483645',
      pointerEvents: 'none',
    });
    document.documentElement.appendChild(markerLayer);
  }

  function clearMarkers() {
    if (markerLayer) markerLayer.innerHTML = '';
    if (treeTooltip) treeTooltip.style.display = 'none';
  }

  /**
   * Draw a labelled box on the page around the currently-selected element,
   * coloured by the worst diff status, listing the mismatched properties.
   * Called after a diff runs so the developer sees *what* and *where*
   * in context — not just a list in the side panel.
   */
  function drawMarker(rect, status, label, lines) {
    ensureMarkerLayer();
    const colors = {
      mismatch: '#ef4444',
      warning:  '#f59e0b',
      match:    '#10b981',
    };
    const color = colors[status] || '#9b6dff';

    const box = document.createElement('div');
    Object.assign(box.style, {
      position:      'absolute',
      left:          `${docX(rect.left)}px`,
      top:           `${docY(rect.top)}px`,
      width:         `${docSize(rect.width)}px`,
      height:        `${docSize(rect.height)}px`,
      border:        `2px solid ${color}`,
      borderRadius:  '2px',
      boxShadow:     `0 0 0 3px ${color}33`,
      pointerEvents: 'none',
      boxSizing:     'border-box',
    });

    const tag = document.createElement('div');
    tag.textContent = label;
    Object.assign(tag.style, {
      position:    'absolute',
      top:         '-20px',
      left:        '0',
      background:  color,
      color:       '#fff',
      fontSize:    '11px',
      fontFamily:  'ui-monospace, monospace',
      fontWeight:  '600',
      padding:     '1px 6px',
      borderRadius: '3px',
      whiteSpace:  'nowrap',
    });
    box.appendChild(tag);

    if (lines?.length) {
      const detail = document.createElement('div');
      detail.innerHTML = lines.map(l => `&bull; ${l}`).join('<br>');
      Object.assign(detail.style, {
        position:    'absolute',
        top:         '100%',
        left:        '0',
        marginTop:   '2px',
        background:  'rgba(17,17,17,0.92)',
        color:       '#fff',
        fontSize:    '10px',
        fontFamily:  'ui-monospace, monospace',
        lineHeight:  '1.5',
        padding:     '4px 7px',
        borderRadius: '4px',
        whiteSpace:  'nowrap',
        maxWidth:    '320px',
      });
      box.appendChild(detail);
    }

    markerLayer.appendChild(box);
  }

  /**
   * Highlight the actual gap spans between children — the empty strips
   * where the spacing lives — plus a DOM-path label, so the developer sees
   * exactly which spaces are being measured and where they come from.
   */
  function drawGapSpans(spans, value, color, sourcePath) {
    ensureMarkerLayer();
    for (const s of spans) {
      if (s.width < 1 && s.height < 1) continue;
      const strip = document.createElement('div');
      Object.assign(strip.style, {
        position:      'absolute',
        left:          `${docX(s.left)}px`,
        top:           `${docY(s.top)}px`,
        width:         `${Math.max(docSize(s.width), 2)}px`,
        height:        `${Math.max(docSize(s.height), 2)}px`,
        background:    `${color}55`,
        outline:       `1px dashed ${color}`,
        pointerEvents: 'none',
        boxSizing:     'border-box',
      });
      markerLayer.appendChild(strip);
    }
    // Label the first span with the measured value + source path.
    const first = spans.find(s => s.width >= 1 || s.height >= 1);
    if (first) {
      const tag = document.createElement('div');
      tag.textContent = `gap ${value}px · ${sourcePath}`;
      Object.assign(tag.style, {
        position:    'absolute',
        left:        `${docX(first.left)}px`,
        top:         `${docY(first.top) - 18}px`,
        background:  color,
        color:       '#fff',
        fontSize:    '10px',
        fontFamily:  'ui-monospace, monospace',
        fontWeight:  '600',
        padding:     '1px 5px',
        borderRadius: '3px',
        whiteSpace:  'nowrap',
        pointerEvents: 'none',
      });
      markerLayer.appendChild(tag);
    }
  }

  // ── Element Picker ─────────────────────────────────────────
  function isOurs(target) {
    return (
      target?.id?.startsWith('__fdr_') ||
      target?.closest?.('#__fdr_overlay__, #__fdr_markers__')
    );
  }

  // Track the last picked element so we can re-measure it for markers.
  let lastPicked = null;

  function activatePicker() {
    pickerActive = true;
    document.body.style.cursor = 'crosshair';
    document.addEventListener('mouseover', onHover);
    document.addEventListener('click',     onClick, { capture: true });
    document.addEventListener('keydown',   onKeydown);
  }

  function deactivatePicker() {
    pickerActive = false;
    document.body.style.cursor = '';
    document.removeEventListener('mouseover', onHover);
    document.removeEventListener('click',     onClick, { capture: true });
    document.removeEventListener('keydown',   onKeydown);
    if (hoveredEl) {
      hoveredEl.classList.remove('__fdr_highlight__');
      hoveredEl = null;
    }
  }

  // Remember the deepest element the mouse was over, so ArrowDown can walk
  // back down toward it after ArrowUp moved the selection to an ancestor.
  let deepestHover = null;

  function setHover(elm) {
    if (!elm || isOurs(elm)) return;
    if (hoveredEl && hoveredEl !== elm) hoveredEl.classList.remove('__fdr_highlight__');
    elm.classList.add('__fdr_highlight__');
    hoveredEl = elm;
  }

  function onHover(e) {
    if (!pickerActive || isOurs(e.target)) return;
    deepestHover = e.target;
    setHover(e.target);
  }

  function onClick(e) {
    if (!pickerActive) return;
    if (isOurs(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    // Pick the currently-highlighted element — which may be an ancestor the
    // user walked up to with ArrowUp — not just whatever is under the cursor.
    confirmPick(hoveredEl || e.target);
  }

  function confirmPick(elm) {
    if (!elm) return;
    lastPicked = elm;
    deactivatePicker();
    const props = extractProps(elm);
    props.viewport = getViewportInfo();
    chrome.runtime.sendMessage({ type: 'FDR_ELEMENT_SELECTED', props });
  }

  function onKeydown(e) {
    if (!pickerActive) return;
    if (e.key === 'Escape') {
      deactivatePicker();
      chrome.runtime.sendMessage({ type: 'FDR_PICKER_CANCELLED' });
      return;
    }
    // ArrowUp → select the parent (so you can reach containers and <body>);
    // ArrowDown → walk back down toward the element under the cursor.
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const parent = hoveredEl?.parentElement;
      if (parent && !isOurs(parent)) setHover(parent);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      // Find a child of the current selection on the path to the deepest hover.
      if (hoveredEl && deepestHover && hoveredEl.contains(deepestHover) && hoveredEl !== deepestHover) {
        let node = deepestHover;
        while (node.parentElement && node.parentElement !== hoveredEl) node = node.parentElement;
        if (node && !isOurs(node)) setHover(node);
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      confirmPick(hoveredEl);
    }
  }

  // ── Message Listener ───────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {

      case 'FDR_PING':
        sendResponse({ ok: true });
        break;

      case 'FDR_GET_VIEWPORT':
        sendResponse(getViewportInfo());
        break;

      case 'FDR_MATCH_WIDTH':
        sendResponse(matchFigmaWidth(msg.figmaWidth));
        break;

      case 'FDR_RESET_ZOOM':
        sendResponse(resetZoom());
        break;

      case 'FDR_ACTIVATE_PICKER':
        activatePicker();
        sendResponse({ ok: true });
        break;

      case 'FDR_SET_OVERLAY': {
        ensureOverlay();
        const img = overlayEl.querySelector('#__fdr_overlay_img__');
        img.src = msg.imageUrl;
        sizeOverlay(msg.width, msg.height, msg.fit !== false);
        sendResponse({ ok: true });
        break;
      }

      case 'FDR_TOGGLE_OVERLAY':
        ensureOverlay();
        overlayEl.style.display = msg.visible ? 'block' : 'none';
        sendResponse({ ok: true, visible: msg.visible });
        break;

      case 'FDR_ALIGN_OVERLAY':
        sendResponse(alignOverlayToElement(msg.frameWidth, msg.frameHeight));
        break;

      case 'FDR_SET_OPACITY': {
        ensureOverlay();
        const img = overlayEl.querySelector('#__fdr_overlay_img__');
        if (img) img.style.opacity = String(msg.opacity);
        sendResponse({ ok: true });
        break;
      }

      case 'FDR_SET_OVERLAY_SCALE': {
        ensureOverlay();
        const img = overlayEl.querySelector('#__fdr_overlay_img__');
        if (img && msg.figmaWidth && msg.figmaHeight) {
          img.style.width  = `${msg.figmaWidth  * msg.scale}px`;
          img.style.height = `${msg.figmaHeight * msg.scale}px`;
        }
        sendResponse({ ok: true });
        break;
      }

      case 'FDR_DRAW_MARKERS': {
        clearMarkers();
        const el = lastPicked && document.body.contains(lastPicked) ? lastPicked : null;
        if (el) {
          drawMarker(el.getBoundingClientRect(), msg.status, msg.label, msg.lines);
          // If the diff involved a gap, re-measure and highlight the actual
          // gap spans between the children so the spacing is pinpointed.
          if (msg.showGap) {
            const colors = { mismatch: '#ef4444', warning: '#f59e0b', match: '#10b981' };
            const rg = measureRenderedGap(el);
            if (rg?.gapSpans?.length) {
              drawGapSpans(rg.gapSpans, rg.value, colors[msg.gapStatus] || '#9b6dff', rg.sourcePath);
            }
          }
        }
        sendResponse({ ok: true, drawn: !!el });
        break;
      }

      case 'FDR_CLEAR_MARKERS':
        clearMarkers();
        sendResponse({ ok: true });
        break;

      case 'FDR_MATCH_TREE':
        // Match a whole Figma node tree to DOM elements and return props for
        // each match so the panel can diff every node.
        sendResponse(matchTree(msg.figmaNodes, msg.rootSel));
        break;

      case 'FDR_DRAW_TREE_MARKERS':
        // msg.statusById: { figmaId -> 'mismatch'|'warning'|'match'|'info' }
        drawTreeMarkers(msg.statusById || {});
        sendResponse({ ok: true });
        break;

      default:
        // Unknown message — respond so the panel's await doesn't hang.
        sendResponse({ ok: false, unknown: msg.type });
    }
    // All responses above are synchronous; no need to keep the channel open.
  });
}
