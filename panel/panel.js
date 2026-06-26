// ============================================================
// panel/panel.js — Figma Design Reviewer
// Handles auth, Figma API calls, diff engine, token resolver
// ============================================================

'use strict';

// ── State ────────────────────────────────────────────────────
const state = {
  token: null,
  user: null,
  tolerance: 1,
  figmaData: null,    // active node: { id, fileKey, nodeId, node, imageUrl, name }
  savedNodes: [],     // all fetched nodes, persisted across refresh
  diffResults: [],
  treeGroups: [],     // last whole-tree diff (grouped by node)
  lastDom: null,      // last picked element's extracted props (for re-diff)
  pickingRoot: false, // picker is selecting a root for a tree scan
  pickingAlign: false,// picker is selecting a reference element to align overlay
};

// Stable id for a node so we can dedupe and switch between saved nodes.
function nodeKeyOf(fileKey, nodeId) {
  return `${fileKey}:${nodeId}`;
}

// ── DOM refs ─────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const el = {
  authScreen:         $('auth-screen'),
  mainScreen:         $('main-screen'),
  tokenInput:         $('token-input'),
  toggleVisibility:   $('toggle-token-visibility'),
  saveTokenBtn:       $('save-token-btn'),
  userName:           $('user-name'),
  disconnectBtn:      $('disconnect-btn'),
  figmaUrl:           $('figma-url'),
  fetchBtn:           $('fetch-btn'),
  fetchError:         $('fetch-error'),
  savedNodesSection:  $('saved-nodes-section'),
  savedNodesList:     $('saved-nodes-list'),
  clearNodesBtn:      $('clear-nodes-btn'),
  componentSection:   $('component-section'),
  componentName:      $('component-name'),
  figmaPreviewImg:    $('figma-preview-img'),
  previewPlaceholder: $('preview-placeholder'),
  viewportSection:    $('viewport-section'),
  scaleInfo:          $('scale-info'),
  matchWidthBtn:      $('match-width-btn'),
  resetZoomBtn:       $('reset-zoom-btn'),
  overlaySection:     $('overlay-section'),
  overlayToggle:      $('overlay-toggle'),
  opacitySlider:      $('opacity-slider'),
  opacityValue:       $('opacity-value'),
  overlayScaleSlider: $('overlay-scale-slider'),
  overlayScaleValue:  $('overlay-scale-value'),
  alignOverlayBtn:    $('align-overlay-btn'),
  pickerSection:      $('picker-section'),
  pickBtn:            $('pick-btn'),
  selectedBar:        $('selected-element-bar'),
  selectedInfo:       $('selected-info'),
  repickBtn:          $('repick-btn'),
  verifyPageBtn:      $('verify-page-btn'),
  verifyRootBtn:      $('verify-root-btn'),
  diffSection:        $('diff-section'),
  diffSummary:        $('diff-summary'),
  diffList:           $('diff-results-list'),
  exportBtn:          $('export-btn'),
  settingsBtn:        $('settings-btn'),
  settingsOverlay:    $('settings-overlay'),
  closeSettings:      $('close-settings'),
  settingsToken:      $('settings-token'),
  updateTokenBtn:     $('update-token-btn'),
  toleranceInput:     $('tolerance-input'),
  toastContainer:     $('toast-container'),
};

// ── UI Helpers ───────────────────────────────────────────────
function showScreen(screen) {
  el.authScreen.classList.toggle('hidden', screen !== 'auth');
  el.mainScreen.classList.toggle('hidden', screen !== 'main');
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  el.toastContainer.appendChild(toast);
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('show')));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function setLoading(btn, loading, label, loadingLabel) {
  btn.disabled = loading;
  // preserve inner SVG if present
  const svg = btn.querySelector('svg');
  if (svg) {
    btn.childNodes.forEach(n => { if (n.nodeType === 3) n.textContent = loading ? ` ${loadingLabel}` : ` ${label}`; });
  } else {
    btn.textContent = loading ? loadingLabel : label;
  }
}

function showFetchError(msg) {
  el.fetchError.textContent = msg;
  el.fetchError.classList.remove('hidden');
}

function clearFetchError() {
  el.fetchError.classList.add('hidden');
}

// ── Figma URL Parser ─────────────────────────────────────────
function parseFigmaUrl(url) {
  try {
    const u = new URL(url.trim());
    // Supports /file/ and /design/ paths
    const pathMatch = u.pathname.match(/\/(file|design)\/([a-zA-Z0-9_-]+)/);
    if (!pathMatch) return null;

    const fileKey = pathMatch[2];
    let nodeId = u.searchParams.get('node-id');
    if (!nodeId) return null;

    // Normalise: both "123:456" and "123-456" are valid from Figma
    nodeId = nodeId.replace(/-/g, ':');
    return { fileKey, nodeId };
  } catch {
    return null;
  }
}

// ── Figma API ────────────────────────────────────────────────
async function figmaFetch(path) {
  const resp = await fetch(`https://api.figma.com/v1${path}`, {
    headers: { 'X-Figma-Token': state.token },
  });
  if (resp.status === 403) throw new Error('Access denied — check your token has read access to this file.');
  if (resp.status === 404) throw new Error('File or node not found. Make sure the URL includes the correct node-id.');
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.message || `Figma API error (${resp.status})`);
  }
  return resp.json();
}

async function verifyToken(token) {
  const resp = await fetch('https://api.figma.com/v1/me', {
    headers: { 'X-Figma-Token': token },
  });
  if (!resp.ok) throw new Error('Token is invalid or expired.');
  return resp.json();
}

async function loadNode(fileKey, nodeId) {
  return figmaFetch(`/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`);
}

async function loadImage(fileKey, nodeId) {
  return figmaFetch(`/images/${fileKey}?ids=${encodeURIComponent(nodeId)}&format=png&scale=2`);
}

// ── Color Utilities ──────────────────────────────────────────
function figmaColorToHex({ r, g, b }) {
  return '#' + [r, g, b]
    .map(c => Math.round(c * 255).toString(16).padStart(2, '0'))
    .join('');
}

function rgbStringToHex(rgb) {
  if (!rgb || rgb === 'transparent' || rgb === 'rgba(0, 0, 0, 0)') return 'transparent';
  const m = rgb.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return rgb.trim();
  return '#' + [m[1], m[2], m[3]]
    .map(v => parseInt(v, 10).toString(16).padStart(2, '0'))
    .join('');
}

function colorsMatch(a, b) {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

// ── Diff Engine ──────────────────────────────────────────────
function parsePx(val) {
  if (val === null || val === undefined) return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

function pxDiffStatus(figmaVal, domVal, tolerance) {
  if (figmaVal === null || domVal === null) return 'unknown';
  const diff = Math.abs(figmaVal - domVal);
  if (diff === 0) return 'match';
  if (diff <= tolerance) return 'warning';
  return 'mismatch';
}

function getFigmaFill(node) {
  if (!node.fills?.length) return null;
  const fill = node.fills.find(f => f.type === 'SOLID' && f.visible !== false);
  return fill ? figmaColorToHex(fill.color) : null;
}

function getFigmaStroke(node) {
  if (!node.strokes?.length) return null;
  const stroke = node.strokes.find(s => s.type === 'SOLID' && s.visible !== false);
  return stroke ? figmaColorToHex(stroke.color) : null;
}

function tokenHint(domRaw, tokenMap) {
  if (!tokenMap || !domRaw) return null;
  const matches = tokenMap[domRaw];
  return matches?.length ? matches[0] : null;
}

/**
 * Flatten a Figma node tree into a list of nodes, each with its bounding
 * box expressed RELATIVE to the root frame's top-left. That relative space
 * is what we can match against DOM elements (whose positions we read
 * relative to the matched root element on the page).
 *
 * Each entry: { id, name, type, depth, relX, relY, width, height, node }
 * where `node` is the raw Figma node (so buildDiff can read its full spec).
 */
// Figma node types that almost never map to a single DOM element — they're
// drawing primitives or pure layout groupings. We still recurse THROUGH a
// GROUP (its children may be real), but we don't emit a diff row for the
// group/vector itself, which is what was flooding the report with noise.
const DECORATIVE_TYPES = new Set([
  'VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'LINE', 'ELLIPSE',
  'REGULAR_POLYGON', 'GROUP', 'SLICE',
]);

function flattenFigmaTree(root, opts = {}) {
  const { includeDecorative = false } = opts;
  const rootBox = root.absoluteBoundingBox;
  if (!rootBox) return [];
  const out = [];
  let skipped = 0;

  function walk(node, depth) {
    const box = node.absoluteBoundingBox;
    if (node.visible === false) return;

    const decorative = DECORATIVE_TYPES.has(node.type);
    // The root itself is always emitted (it's our matching anchor).
    const isRoot = node === root;

    if (box && (isRoot || includeDecorative || !decorative)) {
      out.push({
        id: node.id,
        name: node.name ?? node.type,
        type: node.type,
        depth,
        relX: Math.round(box.x - rootBox.x),
        relY: Math.round(box.y - rootBox.y),
        width:  Math.round(box.width),
        height: Math.round(box.height),
        node,
      });
    } else if (decorative) {
      skipped++;
    }

    if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child, depth + 1);
    }
  }

  walk(root, 0);
  out.skippedDecorative = skipped; // attached for the summary line
  return out;
}

/**
 * Compare a Figma node document against extracted DOM properties.
 * Returns array of diff result objects.
 *
 * When the page's layout width differs from the Figma frame width (and the
 * user hasn't matched widths), absolute Width/Height comparisons are
 * meaningless — a 1920px frame on a 2592px page is not a "1px tolerance"
 * problem. In that case we mark dimensions as informational rather than
 * flagging a false mismatch.
 */
function buildDiff(figmaDoc, dom, tokenMap, tolerance, frameWidth) {
  const results = [];

  // Determine if the PAGE is scaled relative to the top-level Figma FRAME
  // (the originally fetched design), not the picked element. A small button
  // picked on a correctly-zoomed page must still compare 1:1 — the scale
  // signal is about the viewport, not the element.
  const designFrameWidth = frameWidth ?? null;
  const pageLayoutWidth = dom.viewport?.layoutWidth ?? null;
  // Ratio of how the page is scaled vs the Figma frame. ~1 means matched.
  const scaleRatio =
    designFrameWidth && pageLayoutWidth
      ? pageLayoutWidth / designFrameWidth
      : 1;
  const widthsMatched = Math.abs(scaleRatio - 1) <= 0.02; // within 2%

  function addPx(label, figmaPx, domRaw) {
    if (figmaPx === undefined || figmaPx === null) return;
    const domPx = parsePx(domRaw);
    const status = pxDiffStatus(figmaPx, domPx, tolerance);
    results.push({
      label,
      figmaVal: `${figmaPx}px`,
      domVal: domRaw ?? '—',
      status,
      token: tokenHint(domRaw, tokenMap),
    });
  }

  function addColor(label, figmaHex, domRaw) {
    if (!figmaHex) return;
    const domHex = rgbStringToHex(domRaw);
    const status = colorsMatch(figmaHex, domHex) ? 'match' : 'mismatch';
    results.push({ label, figmaVal: figmaHex, domVal: domHex, status, token: null, isColor: true });
  }

  // ── Border radius ───────────────────────────────────────
  if (figmaDoc.cornerRadius !== undefined && figmaDoc.cornerRadius !== null) {
    addPx('Border Radius', figmaDoc.cornerRadius, dom.borderRadius);
  } else if (Array.isArray(figmaDoc.rectangleCornerRadii)) {
    const [tl, tr, br, bl] = figmaDoc.rectangleCornerRadii;
    addPx('Border Radius ↖', tl, dom.borderTopLeftRadius);
    addPx('Border Radius ↗', tr, dom.borderTopRightRadius);
    addPx('Border Radius ↘', br, dom.borderBottomRightRadius);
    addPx('Border Radius ↙', bl, dom.borderBottomLeftRadius);
  }

  // ── Padding (compared as EFFECTIVE VISUAL spacing) ───────
  // Figma stores padding per side. Code may produce the same visible inset
  // via padding, child margins, or a wrapper — so when we can measure the
  // rendered inset (distance from the element's edges to its children's
  // bounding box), we compare against THAT, not the raw computed padding.
  // This stops "Figma 4-side padding vs DOM single padding/margin" from
  // being flagged when the result looks identical.
  const hasFigmaPadding = ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight']
    .some(k => figmaDoc[k] !== undefined);

  if (hasFigmaPadding) {
    const inset = dom.contentInset; // measured {top,right,bottom,left} | null
    const sides = [
      ['Padding Top',    'paddingTop',    'top'],
      ['Padding Bottom', 'paddingBottom', 'bottom'],
      ['Padding Left',   'paddingLeft',   'left'],
      ['Padding Right',  'paddingRight',  'right'],
    ];

    if (inset) {
      for (const [label, fKey, side] of sides) {
        if (figmaDoc[fKey] === undefined) continue;
        const figmaPx = figmaDoc[fKey];
        const visualPx = inset[side];
        const computedPx = parsePx(dom[fKey]) ?? 0;
        const status = pxDiffStatus(figmaPx, visualPx, tolerance);
        // Note when the visible inset matches but the code used a different
        // mechanism than padding (so the developer knows it's intentional).
        const mechNote =
          status === 'match' && Math.abs(computedPx - visualPx) > 1
            ? `visual inset ${visualPx}px (element’s own padding is ${computedPx}px — rest from margin/wrapper)`
            : null;
        results.push({
          label,
          figmaVal: `${figmaPx}px`,
          domVal: `${visualPx}px`,
          status,
          token: tokenHint(`${visualPx}px`, tokenMap),
          note: mechNote,
        });
      }
    } else {
      // Leaf element — no children to measure; fall back to computed padding.
      for (const [label, fKey] of sides) {
        if (figmaDoc[fKey] !== undefined) addPx(label, figmaDoc[fKey], dom[fKey]);
      }
    }
  }

  // ── Gap (flex/grid spacing) ──────────────────────────────
  // Figma's itemSpacing maps to "the visible space between children". That
  // spacing may come from `gap`, child margins, or a gap on an inner
  // PrimeVue wrapper — so we trust the MEASURED rendered gap over the
  // computed `gap` of the picked element, which is often 0 for valid code.
  if (figmaDoc.itemSpacing !== undefined) {
    const figmaGap = figmaDoc.itemSpacing;
    const computedGap = dom.gap && dom.gap !== 'normal' ? parsePx(dom.gap) : 0;
    const measured = dom.renderedGap; // {value, source, sourceMechanism, sourcePath} | null

    if (measured && measured.value !== null && measured.value !== undefined) {
      const status = pxDiffStatus(figmaGap, measured.value, tolerance);
      const via =
        measured.source === 'inner wrapper'
          ? `${measured.sourceMechanism} on inner ${measured.sourcePath}`
          : `${measured.sourceMechanism}`;
      results.push({
        label: 'Gap / Item Spacing',
        figmaVal: `${figmaGap}px`,
        domVal: `${measured.value}px`,
        status,
        token: tokenHint(`${measured.value}px`, tokenMap),
        // Explain where the spacing actually comes from so a valid
        // grid-on-child implementation doesn't look "wrong".
        note:
          status === 'match'
            ? `measured between children (via ${via}) — not on this element’s own \`gap\``
            : `measured between children (via ${via}); element’s own \`gap\` is ${computedGap}px`,
      });
    } else {
      // No measurable children — fall back to computed gap with a caveat.
      const status = pxDiffStatus(figmaGap, computedGap, tolerance);
      results.push({
        label: 'Gap / Item Spacing',
        figmaVal: `${figmaGap}px`,
        domVal: `${computedGap}px`,
        status,
        token: tokenHint(`${computedGap}px`, tokenMap),
        note: 'no measurable child spacing — compared computed `gap` only',
      });
    }
  }

  // ── Dimensions ──────────────────────────────────────────
  if (figmaDoc.absoluteBoundingBox) {
    const fw = Math.round(figmaDoc.absoluteBoundingBox.width);
    const fh = Math.round(figmaDoc.absoluteBoundingBox.height);

    if (widthsMatched) {
      // Page is at (or matched to) Figma's layout width — compare directly.
      addPx('Width',  fw, dom.width  !== undefined ? `${dom.width}px`  : null);
      addPx('Height', fh, dom.height !== undefined ? `${dom.height}px` : null);
    } else {
      // Page is scaled vs the frame. Compare the DOM value scaled back to
      // Figma's coordinate space, and surface the scale factor so the
      // mismatch isn't a false alarm caused by viewport/DPR differences.
      const note = `page is ${scaleRatio.toFixed(2)}× the Figma frame — use “Match Figma width” for an exact check`;
      const scaledW = dom.width  !== undefined ? Math.round(dom.width  / scaleRatio) : null;
      const scaledH = dom.height !== undefined ? Math.round(dom.height / scaleRatio) : null;
      results.push({
        label: 'Width', figmaVal: `${fw}px`,
        domVal: dom.width !== undefined ? `${dom.width}px (≈${scaledW}px @1×)` : '—',
        status: 'info', token: null, note,
      });
      results.push({
        label: 'Height', figmaVal: `${fh}px`,
        domVal: dom.height !== undefined ? `${dom.height}px (≈${scaledH}px @1×)` : '—',
        status: 'info', token: null, note,
      });
    }
  }

  // ── Colours ──────────────────────────────────────────────
  const fillColor = getFigmaFill(figmaDoc);
  if (fillColor) {
    const prop = figmaDoc.type === 'TEXT' ? 'Text Color' : 'Background Color';
    const domColor = figmaDoc.type === 'TEXT' ? dom.color : dom.backgroundColor;
    addColor(prop, fillColor, domColor);
  }

  const strokeColor = getFigmaStroke(figmaDoc);
  if (strokeColor) {
    addColor('Border Color', strokeColor, dom.borderColor);
    if (figmaDoc.strokeWeight !== undefined) {
      addPx('Border Width', figmaDoc.strokeWeight, dom.borderWidth);
    }
  }

  // ── Typography ───────────────────────────────────────────
  const style = figmaDoc.style;
  if (style) {
    if (style.fontSize   !== undefined) addPx('Font Size',   style.fontSize,   dom.fontSize);
    if (style.fontWeight !== undefined) {
      const figmaFW = style.fontWeight;
      const domFW = parsePx(dom.fontWeight);
      const status = pxDiffStatus(figmaFW, domFW, 0); // font-weight: exact match
      results.push({ label: 'Font Weight', figmaVal: String(figmaFW), domVal: dom.fontWeight ?? '—', status, token: null });
    }
    if (style.lineHeightPx !== undefined) {
      addPx('Line Height', Math.round(style.lineHeightPx), dom.lineHeight);
    }
    if (style.letterSpacing !== undefined && style.letterSpacing !== 0) {
      addPx('Letter Spacing', style.letterSpacing, dom.letterSpacing);
    }
  }

  // ── Opacity ──────────────────────────────────────────────
  if (figmaDoc.opacity !== undefined && figmaDoc.opacity < 1) {
    const figmaOp = figmaDoc.opacity;
    const domOp = parseFloat(dom.opacity ?? '1');
    const diff = Math.abs(figmaOp - domOp);
    const status = diff === 0 ? 'match' : diff <= 0.02 ? 'warning' : 'mismatch';
    results.push({ label: 'Opacity', figmaVal: figmaOp.toFixed(2), domVal: String(domOp), status, token: null });
  }

  return results;
}

// ── On-page marker ───────────────────────────────────────────
/**
 * Send the diff summary to the content script so it can draw a coloured
 * box around the picked element with the top mismatches listed inline.
 */
function drawPageMarker(results) {
  const mismatches = results.filter(r => r.status === 'mismatch');
  const warnings   = results.filter(r => r.status === 'warning');
  const status = mismatches.length ? 'mismatch' : warnings.length ? 'warning' : 'match';

  const label = mismatches.length
    ? `${mismatches.length} mismatch${mismatches.length !== 1 ? 'es' : ''}`
    : warnings.length
      ? `${warnings.length} warning${warnings.length !== 1 ? 's' : ''}`
      : 'matches design';

  const lines = [...mismatches, ...warnings]
    .slice(0, 5)
    .map(r => `${r.label}: Figma ${r.figmaVal} vs DOM ${r.domVal}`);

  // If a gap row exists, ask the page to also highlight the gap spans.
  const gapRow = results.find(r => r.label === 'Gap / Item Spacing');

  sendToPage({
    type: 'FDR_DRAW_MARKERS',
    status, label, lines,
    showGap: !!gapRow,
    gapStatus: gapRow?.status,
  });
}

// ── Diff Renderer ────────────────────────────────────────────
function renderDiff(results) {
  const issues   = results.filter(r => r.status === 'mismatch').length;
  const warnings = results.filter(r => r.status === 'warning').length;
  const infos    = results.filter(r => r.status === 'info').length;
  const passes   = results.filter(r => r.status === 'match').length;

  // Summary badges
  el.diffSummary.innerHTML = '';
  if (issues)   el.diffSummary.insertAdjacentHTML('beforeend', `<span class="badge badge-error">${issues} issue${issues !== 1 ? 's' : ''}</span>`);
  if (warnings) el.diffSummary.insertAdjacentHTML('beforeend', `<span class="badge badge-warning">${warnings} warning${warnings !== 1 ? 's' : ''}</span>`);
  if (infos)    el.diffSummary.insertAdjacentHTML('beforeend', `<span class="badge badge-info">${infos} info</span>`);
  if (passes)   el.diffSummary.insertAdjacentHTML('beforeend', `<span class="badge badge-success">${passes} passed</span>`);

  // Mirror the result onto the page as an on-page marker around the
  // picked element, so the developer sees what & where in context.
  drawPageMarker(results);

  // Sort: mismatches → warnings → info → matches → unknown
  const order = { mismatch: 0, warning: 1, info: 2, match: 3, unknown: 4 };
  const sorted = [...results].sort((a, b) => order[a.status] - order[b.status]);

  el.diffList.innerHTML = '';

  for (const r of sorted) {
    const iconMap  = { match: '✓', mismatch: '✕', warning: '~', info: 'ⓘ', unknown: '?' };
    const classMap = { match: 'text-success', mismatch: 'text-error', warning: 'text-warning', info: 'text-info', unknown: 'text-muted' };
    const icon     = iconMap[r.status];
    const cls      = classMap[r.status];

    // Colour swatches
    const renderVal = (val, isColor) => {
      if (isColor && val?.startsWith('#')) {
        return `<span class="color-swatch" style="background:${val}"></span>${val}`;
      }
      return val ?? '—';
    };

    const tokenHtml = r.token
      ? `<div class="token-info">Token in use: <code>${r.token}</code></div>`
      : '';

    const noteHtml = r.note
      ? `<div class="diff-note">${r.note}</div>`
      : '';

    const valuesHtml = r.status === 'match'
      ? `<div class="diff-values match-val">${renderVal(r.figmaVal, r.isColor)}</div>`
      : `<div class="diff-values">
           <div class="diff-value">
             <span class="diff-source figma-source">Figma</span>
             <span class="diff-val">${renderVal(r.figmaVal, r.isColor)}</span>
           </div>
           <div class="diff-value">
             <span class="diff-source dom-source">DOM</span>
             <span class="diff-val">${renderVal(r.domVal, r.isColor)}</span>
           </div>
         </div>
         ${tokenHtml}
         ${noteHtml}`;

    const row = document.createElement('div');
    row.className = `diff-row diff-${r.status}`;
    row.innerHTML = `
      <div class="diff-row-header">
        <span class="diff-icon ${cls}">${icon}</span>
        <span class="diff-label">${r.label}</span>
        <span class="diff-status ${cls}">${r.status}</span>
      </div>
      ${valuesHtml}
    `;
    el.diffList.appendChild(row);
  }

  el.diffSection.classList.remove('hidden');
}

// ── Tree / Whole-page Diff ───────────────────────────────────
// Recursively diff every node in the active Figma frame against the page.
// rootSel: 'auto' (whole page) or 'picked' (use the picked element as root).
async function runTreeDiff(rootSel) {
  const root = state.figmaData?.node?.document ?? state.figmaData?.node;
  if (!root) { showToast('Fetch a Figma node first.', 'warning'); return; }

  const flat = flattenFigmaTree(root);
  if (!flat.length) { showToast('This node has no geometry to diff.', 'warning'); return; }

  // Warn if the page isn't matched to the frame — geometry matching needs it.
  const fw = figmaFrameWidth();
  const vp = await sendToPage({ type: 'FDR_GET_VIEWPORT' });
  if (vp && fw && Math.abs(vp.layoutWidth / fw - 1) > 0.05) {
    showToast('Tip: click “Match Figma width” first for accurate matching.', 'info');
  }

  const btn = rootSel === 'auto' ? el.verifyPageBtn : el.verifyRootBtn;
  const origHtml = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Scanning…';

  try {
    // Send only what the matcher needs (not the full raw node) to the page.
    const figmaNodes = flat.map(n => ({
      id: n.id, name: n.name, type: n.type, depth: n.depth,
      relX: n.relX, relY: n.relY, width: n.width, height: n.height,
    }));

    const res = await sendToPage({ type: 'FDR_MATCH_TREE', figmaNodes, rootSel });
    if (!res?.ok) {
      showToast(res?.reason ? `Scan failed: ${res.reason}` : 'Scan failed.', 'error');
      return;
    }

    // Map figmaId → flattened node (with raw node) for diffing.
    const byId = new Map(flat.map(n => [n.id, n]));

    // Diff each matched node; build a grouped report.
    const groups = [];
    const statusById = {};
    for (const r of res.results) {
      const fn = byId.get(r.figmaId);
      if (!fn) continue;
      if (!r.matched) {
        groups.push({ name: fn.name, type: fn.type, depth: fn.depth, matched: false, results: [] });
        statusById[r.figmaId] = 'info';
        continue;
      }
      const dom = r.props;
      const results = buildDiff(fn.node, dom, dom.tokenMap, state.tolerance, fw);
      groups.push({
        name: fn.name, type: fn.type, depth: fn.depth, matched: true,
        score: r.score, domPath: dom.domPath, results,
      });
      // Worst status drives the node's marker colour.
      statusById[r.figmaId] = worstStatus(results);
    }

    state.treeGroups = groups;
    renderTreeDiff(groups, res, flat.skippedDecorative || 0);

    // Build hover-tooltip content per node: name + its specific issues.
    const infoById = {};
    for (const r of res.results) {
      const fn = byId.get(r.figmaId);
      if (!fn || !r.matched) continue;
      const g = groups.find(x => x.name === fn.name && x.type === fn.type && x.depth === fn.depth);
      const probs = (g?.results || []).filter(x => x.status === 'mismatch' || x.status === 'warning');
      infoById[r.figmaId] = {
        name: fn.name,
        lines: probs.slice(0, 8).map(x => `${x.label}: Figma ${x.figmaVal} vs DOM ${x.domVal}`),
      };
    }

    // Draw per-node markers on the page (with hover info).
    await sendToPage({ type: 'FDR_DRAW_TREE_MARKERS', statusById, infoById });
  } finally {
    btn.disabled = false;
    btn.innerHTML = origHtml;
  }
}

function worstStatus(results) {
  if (results.some(r => r.status === 'mismatch')) return 'mismatch';
  if (results.some(r => r.status === 'warning'))  return 'warning';
  if (results.some(r => r.status === 'info'))     return 'info';
  return 'match';
}

// Render the grouped tree report into the diff section.
function renderTreeDiff(groups, meta, skippedDecorative = 0) {
  const totalMismatch = groups.reduce((a, g) => a + g.results.filter(r => r.status === 'mismatch').length, 0);
  const totalWarning  = groups.reduce((a, g) => a + g.results.filter(r => r.status === 'warning').length, 0);
  const unmatched     = groups.filter(g => !g.matched).length;

  el.diffSummary.innerHTML = '';
  el.diffSummary.insertAdjacentHTML('beforeend', `<span class="badge badge-info">${meta.matchedCount}/${meta.total} nodes matched</span>`);
  if (totalMismatch) el.diffSummary.insertAdjacentHTML('beforeend', `<span class="badge badge-error">${totalMismatch} issues</span>`);
  if (totalWarning)  el.diffSummary.insertAdjacentHTML('beforeend', `<span class="badge badge-warning">${totalWarning} warnings</span>`);
  if (unmatched)     el.diffSummary.insertAdjacentHTML('beforeend', `<span class="badge badge-muted">${unmatched} unmatched</span>`);
  if (skippedDecorative) el.diffSummary.insertAdjacentHTML('beforeend', `<span class="badge badge-muted" title="VECTOR / GROUP / icon nodes have no DOM equivalent">${skippedDecorative} decorative skipped</span>`);

  el.diffList.innerHTML = '';

  const iconMap  = { match: '✓', mismatch: '✕', warning: '~', info: 'ⓘ', unknown: '?' };
  const classMap = { match: 'text-success', mismatch: 'text-error', warning: 'text-warning', info: 'text-info', unknown: 'text-muted' };

  for (const g of groups) {
    const node = document.createElement('div');
    node.className = 'tree-node';
    node.style.marginLeft = `${Math.min(g.depth, 6) * 10}px`;

    if (!g.matched) {
      node.innerHTML = `
        <div class="tree-node-header unmatched">
          <span class="tree-node-name">${escapeHtml(g.name)}</span>
          <span class="tree-node-type">${g.type}</span>
          <span class="badge badge-muted">no DOM match</span>
        </div>`;
      el.diffList.appendChild(node);
      continue;
    }

    const ws = worstStatus(g.results);
    const issues = g.results.filter(r => r.status === 'mismatch' || r.status === 'warning').length;

    const rowsHtml = g.results.map(r => {
      const icon = iconMap[r.status], cls = classMap[r.status];
      const valHtml = r.status === 'match'
        ? `<span class="tree-val">${escapeHtml(String(r.figmaVal))}</span>`
        : `<span class="tree-val"><span class="figma-source">F</span> ${escapeHtml(String(r.figmaVal))} <span class="dom-source">D</span> ${escapeHtml(String(r.domVal))}</span>`;
      return `<div class="tree-row diff-${r.status}">
        <span class="diff-icon ${cls}">${icon}</span>
        <span class="tree-row-label">${escapeHtml(r.label)}</span>
        ${valHtml}
      </div>`;
    }).join('');

    node.innerHTML = `
      <details ${ws === 'mismatch' ? 'open' : ''}>
        <summary class="tree-node-header status-${ws}">
          <span class="diff-icon ${classMap[ws]}">${iconMap[ws]}</span>
          <span class="tree-node-name" title="${escapeHtml(g.domPath || '')}">${escapeHtml(g.name)}</span>
          <span class="tree-node-type">${g.type}</span>
          ${issues ? `<span class="badge badge-${ws === 'mismatch' ? 'error' : 'warning'}">${issues}</span>` : '<span class="badge badge-success">ok</span>'}
        </summary>
        <div class="tree-rows">${rowsHtml}</div>
      </details>`;
    el.diffList.appendChild(node);
  }

  el.diffSection.classList.remove('hidden');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ── Export ───────────────────────────────────────────────────
function downloadMarkdown(lines, name) {
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `figma-review-${name.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportTreeMarkdown() {
  const icons = { match: '✅', mismatch: '❌', warning: '⚠️', info: 'ℹ️', unknown: '❓' };
  const name = state.figmaData?.name ?? 'Frame';
  const groups = state.treeGroups;
  const issues   = groups.reduce((a, g) => a + g.results.filter(r => r.status === 'mismatch').length, 0);
  const warnings = groups.reduce((a, g) => a + g.results.filter(r => r.status === 'warning').length, 0);
  const unmatched = groups.filter(g => !g.matched).length;

  const lines = [
    `# Figma Design Review (whole tree) — ${name}`,
    ``,
    `Generated: ${new Date().toLocaleString()}`,
    `Tolerance: ±${state.tolerance}px`,
    ``,
    `## Summary`,
    ``,
    `- Nodes: ${groups.length} (${unmatched} unmatched)`,
    `- ❌ Issues: ${issues}`,
    `- ⚠️ Warnings: ${warnings}`,
    ``,
    `## Nodes`,
    ``,
  ];

  for (const g of groups) {
    const indent = '  '.repeat(Math.min(g.depth, 6));
    if (!g.matched) {
      lines.push(`${indent}- **${g.name}** \`${g.type}\` — _no DOM match_`);
      continue;
    }
    const problems = g.results.filter(r => r.status === 'mismatch' || r.status === 'warning');
    const head = problems.length ? `${problems.length} issue(s)` : 'ok';
    lines.push(`${indent}- **${g.name}** \`${g.type}\` — ${head}${g.domPath ? `  \`${g.domPath}\`` : ''}`);
    for (const r of problems) {
      lines.push(`${indent}  - ${icons[r.status]} ${r.label}: Figma \`${r.figmaVal}\` vs DOM \`${r.domVal}\`${r.token ? ` (token \`${r.token}\`)` : ''}`);
    }
  }

  downloadMarkdown(lines, `${name}-tree`);
}

function exportMarkdown() {
  // Prefer the tree report if a whole-tree diff was the last thing run.
  if (state.treeGroups?.length) { exportTreeMarkdown(); return; }

  const results = state.diffResults;
  if (!results.length) return;

  const componentName = state.figmaData?.name ?? 'Unknown Component';
  const icons = { match: '✅', mismatch: '❌', warning: '⚠️', info: 'ℹ️', unknown: '❓' };
  const issues   = results.filter(r => r.status === 'mismatch').length;
  const warnings = results.filter(r => r.status === 'warning').length;
  const passes   = results.filter(r => r.status === 'match').length;

  const lines = [
    `# Figma Design Review — ${componentName}`,
    ``,
    `Generated: ${new Date().toLocaleString()}`,
    `Tolerance: ±${state.tolerance}px`,
    ``,
    `## Summary`,
    ``,
    `| Status | Count |`,
    `|--------|-------|`,
    `| ❌ Issues   | ${issues} |`,
    `| ⚠️ Warnings | ${warnings} |`,
    `| ✅ Passed   | ${passes} |`,
    ``,
    `## Details`,
    ``,
  ];

  for (const r of results) {
    const icon = icons[r.status] ?? '❓';
    lines.push(`### ${icon} ${r.label}`);
    lines.push(`- **Figma:** \`${r.figmaVal}\``);
    lines.push(`- **DOM:** \`${r.domVal}\``);
    if (r.token) lines.push(`- **Token in use:** \`${r.token}\``);
    lines.push('');
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `figma-review-${componentName.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Saved Nodes (test multiple components) ───────────────────
// Persist fetched nodes so they survive a panel/page refresh and let the
// user switch between several components instead of re-pasting URLs.

async function persistNodes() {
  await chrome.storage.local.set({
    savedNodes: state.savedNodes,
    activeNodeId: state.figmaData?.id ?? null,
  });
}

function upsertSavedNode(node) {
  const i = state.savedNodes.findIndex(n => n.id === node.id);
  if (i >= 0) state.savedNodes[i] = node;       // refresh existing
  else state.savedNodes.unshift(node);          // newest first
  // Keep the list bounded so storage doesn't grow without limit.
  if (state.savedNodes.length > 20) state.savedNodes.length = 20;
}

async function removeNode(id) {
  state.savedNodes = state.savedNodes.filter(n => n.id !== id);
  if (state.figmaData?.id === id) {
    state.figmaData = null;
    // Hide the per-node sections since nothing is active.
    [el.componentSection, el.viewportSection, el.overlaySection, el.pickerSection, el.diffSection]
      .forEach(s => s.classList.add('hidden'));
    await sendToPage({ type: 'FDR_TOGGLE_OVERLAY', visible: false });
    await sendToPage({ type: 'FDR_CLEAR_MARKERS' });
  }
  await persistNodes();
  renderSavedNodes();
}

function renderSavedNodes() {
  el.savedNodesSection.classList.toggle('hidden', state.savedNodes.length === 0);
  el.savedNodesList.innerHTML = '';

  for (const n of state.savedNodes) {
    const isActive = state.figmaData?.id === n.id;
    const row = document.createElement('div');
    row.className = `saved-node${isActive ? ' active' : ''}`;
    row.innerHTML = `
      <div class="saved-node-thumb">${n.imageUrl ? `<img src="${n.imageUrl}" alt="" />` : '<span>—</span>'}</div>
      <span class="saved-node-name" title="${n.name}">${n.name}</span>
      ${isActive ? '<span class="saved-node-badge">active</span>' : ''}
      <button class="saved-node-del text-btn small" title="Remove">✕</button>
    `;
    row.querySelector('.saved-node-del').addEventListener('click', (e) => {
      e.stopPropagation();
      removeNode(n.id);
    });
    row.addEventListener('click', () => {
      if (!isActive) activateNode(n);
    });
    el.savedNodesList.appendChild(row);
  }
}

/**
 * Make a node the active one: show its preview, push the overlay, refresh
 * the scale info, and reset any prior diff. Used by both fetch and the
 * saved-node switcher so behaviour is identical either way.
 */
async function activateNode(node) {
  state.figmaData = node;
  state.lastDom = null;
  state.diffResults = [];
  state.treeGroups = [];

  // Preview
  el.componentName.textContent = node.name;
  if (node.imageUrl) {
    el.figmaPreviewImg.src = node.imageUrl;
    el.figmaPreviewImg.classList.remove('hidden');
    el.previewPlaceholder.classList.add('hidden');
  } else {
    el.figmaPreviewImg.classList.add('hidden');
    el.previewPlaceholder.classList.remove('hidden');
  }

  el.componentSection.classList.remove('hidden');
  el.viewportSection.classList.remove('hidden');
  el.overlaySection.classList.remove('hidden');
  el.pickerSection.classList.remove('hidden');
  el.diffSection.classList.add('hidden');   // diff is per-pick; reset it
  el.selectedBar.classList.add('hidden');

  // Push overlay + clear any old markers from the previous node.
  await sendToPage({ type: 'FDR_CLEAR_MARKERS' });
  if (node.imageUrl) {
    const bbox = node.node.document?.absoluteBoundingBox;
    const ok = await sendToPage({
      type: 'FDR_SET_OVERLAY',
      imageUrl: node.imageUrl,
      width:  bbox?.width  ?? null,
      height: bbox?.height ?? null,
      fit: true,
    });
    if (ok) {
      await sendToPage({ type: 'FDR_TOGGLE_OVERLAY', visible: el.overlayToggle.checked });
      await sendToPage({ type: 'FDR_SET_OPACITY', opacity: parseInt(el.opacitySlider.value, 10) / 100 });
    }
  }

  await refreshScaleInfo();
  await persistNodes();
  renderSavedNodes();
}

// ── Content Script Messaging ─────────────────────────────────
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

/**
 * Send a message to the page's content script.
 * If the content script isn't loaded yet (race after page load, or
 * extension installed mid-session), inject it and RE-SEND the message —
 * the previous implementation injected but dropped the message, which is
 * why the overlay silently never appeared on a fresh page.
 * Returns the content script's response (or null on a restricted page).
 */
async function sendToPage(message) {
  const tab = await getActiveTab();
  if (!tab?.id) return null;

  if (tab.url && !/^https?:|^file:/.test(tab.url)) {
    showToast('This page can’t run the reviewer (chrome:// or store page).', 'warning');
    return null;
  }

  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    // Content script not present — inject, then retry once.
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content/content.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/content.js'] });
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (err) {
      showToast('Couldn’t reach the page. Try reloading the tab.', 'error');
      return null;
    }
  }
}

// ── Scale / viewport ─────────────────────────────────────────
function figmaFrameWidth() {
  const doc = state.figmaData?.node?.document ?? state.figmaData?.node;
  const w = doc?.absoluteBoundingBox?.width;
  return w ? Math.round(w) : null;
}

/**
 * Query the page's layout width and report how it compares to the Figma
 * frame, so the user knows whether absolute px diffs will be meaningful.
 */
async function refreshScaleInfo() {
  const fw = figmaFrameWidth();
  if (!fw) { el.scaleInfo.textContent = 'No frame dimensions in this node.'; return; }

  const vp = await sendToPage({ type: 'FDR_GET_VIEWPORT' });
  if (!vp) { el.scaleInfo.textContent = 'Open a normal web page to compare.'; return; }

  const ratio = vp.layoutWidth / fw;
  const matched = Math.abs(ratio - 1) <= 0.02;
  const zoomed = vp.zoom && Math.abs(vp.zoom - 1) > 0.01;

  if (matched) {
    el.scaleInfo.innerHTML = `<span class="scale-ok">✓ Page width ${vp.layoutWidth}px matches Figma frame ${fw}px${zoomed ? ` (zoomed ${vp.zoom.toFixed(2)}×)` : ''}</span>`;
    el.resetZoomBtn.classList.toggle('hidden', !zoomed);
  } else {
    el.scaleInfo.innerHTML = `<span class="scale-warn">Page ${vp.layoutWidth}px vs Figma ${fw}px — <strong>${ratio.toFixed(2)}×</strong>. Width/Height shown as info until matched.</span>`;
    el.resetZoomBtn.classList.add('hidden');
  }
}

// ── Event Handlers ───────────────────────────────────────────

// Auth: toggle token visibility
el.toggleVisibility.addEventListener('click', () => {
  el.tokenInput.type = el.tokenInput.type === 'password' ? 'text' : 'password';
});

// Auth: save token
async function handleSaveToken() {
  const token = el.tokenInput.value.trim();
  if (!token) { showToast('Please enter your Figma token', 'error'); return; }

  el.saveTokenBtn.disabled = true;
  el.saveTokenBtn.textContent = 'Verifying…';

  try {
    const user = await verifyToken(token);
    state.token = token;
    state.user  = user;
    await chrome.storage.local.set({ figmaToken: token, figmaUser: { name: user.name, email: user.email } });
    el.userName.textContent = user.name || 'Connected';
    showScreen('main');
    // Restore any previously saved nodes for this session.
    const saved = await chrome.storage.local.get(['savedNodes']);
    state.savedNodes = Array.isArray(saved.savedNodes) ? saved.savedNodes : [];
    renderSavedNodes();
    showToast(`Welcome, ${user.name}!`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    el.saveTokenBtn.disabled = false;
    el.saveTokenBtn.textContent = 'Connect to Figma';
  }
}

el.saveTokenBtn.addEventListener('click', handleSaveToken);
el.tokenInput.addEventListener('keydown', e => e.key === 'Enter' && handleSaveToken());

// Disconnect
el.disconnectBtn.addEventListener('click', async () => {
  await chrome.storage.local.remove(['figmaToken', 'figmaUser']);
  state.token = null;
  state.user  = null;
  state.figmaData = null;
  el.tokenInput.value = '';
  showScreen('auth');
  showToast('Signed out', 'info');
});

// Fetch component
async function handleFetch() {
  clearFetchError();
  const url = el.figmaUrl.value.trim();
  const parsed = parseFigmaUrl(url);

  if (!parsed) {
    showFetchError('Invalid Figma URL. Right-click a frame or component in Figma → "Copy link".');
    return;
  }

  el.fetchBtn.disabled = true;
  el.fetchBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Fetching…`;

  try {
    const { fileKey, nodeId } = parsed;

    const [nodeData, imageData] = await Promise.all([
      loadNode(fileKey, nodeId),
      loadImage(fileKey, nodeId).catch(() => ({ images: {} })),
    ]);

    // Figma returns nodes keyed by ID (colon format)
    const nodeKey = Object.keys(nodeData.nodes)[0];
    const nodeWrapper = nodeData.nodes[nodeKey];
    if (!nodeWrapper) throw new Error('Node not found in response.');

    const imageUrl = Object.values(imageData.images)[0] ?? null;
    const name     = nodeWrapper.document?.name ?? 'Component';

    const node = {
      id: nodeKeyOf(fileKey, nodeKey),
      fileKey, nodeId: nodeKey, node: nodeWrapper, imageUrl, name,
    };

    upsertSavedNode(node);   // add/update in the saved list + persist
    await activateNode(node);
    el.figmaUrl.value = '';  // ready for the next node

    showToast(`Loaded: ${name}`, 'success');
  } catch (err) {
    showFetchError(err.message);
  } finally {
    el.fetchBtn.disabled = false;
    el.fetchBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Fetch Component`;
  }
}

el.fetchBtn.addEventListener('click', handleFetch);
el.figmaUrl.addEventListener('keydown', e => e.key === 'Enter' && handleFetch());

// Clear all saved nodes
el.clearNodesBtn.addEventListener('click', async () => {
  state.savedNodes = [];
  state.figmaData = null;
  [el.componentSection, el.viewportSection, el.overlaySection, el.pickerSection, el.diffSection, el.selectedBar]
    .forEach(s => s.classList.add('hidden'));
  await sendToPage({ type: 'FDR_TOGGLE_OVERLAY', visible: false });
  await sendToPage({ type: 'FDR_CLEAR_MARKERS' });
  await persistNodes();
  renderSavedNodes();
  showToast('Cleared all saved nodes', 'info');
});

// Overlay toggle
el.overlayToggle.addEventListener('change', () => {
  sendToPage({ type: 'FDR_TOGGLE_OVERLAY', visible: el.overlayToggle.checked });
});

// Opacity slider
el.opacitySlider.addEventListener('input', () => {
  const val = el.opacitySlider.value;
  el.opacityValue.textContent = `${val}%`;
  sendToPage({ type: 'FDR_SET_OPACITY', opacity: parseInt(val, 10) / 100 });
});

// Overlay scale slider — resize the whole ghosted frame on the page.
el.overlayScaleSlider.addEventListener('input', () => {
  const pct = parseInt(el.overlayScaleSlider.value, 10);
  el.overlayScaleValue.textContent = `${pct}%`;
  const doc = state.figmaData?.node?.document ?? state.figmaData?.node;
  const bbox = doc?.absoluteBoundingBox;
  if (!bbox) return;
  // 100% = the frame's native pixel size; on a wide monitor the default
  // page-fitted overlay will report >100%, which the page-side resize sync
  // already reflects in this slider's position.
  sendToPage({
    type: 'FDR_SET_OVERLAY_SCALE',
    figmaWidth:  bbox.width,
    figmaHeight: bbox.height,
    scale: pct / 100,
  });
});

// Match Figma width — zoom the page so its layout width == the frame width.
el.matchWidthBtn.addEventListener('click', async () => {
  const fw = figmaFrameWidth();
  if (!fw) { showToast('No frame dimensions to match.', 'warning'); return; }
  const res = await sendToPage({ type: 'FDR_MATCH_WIDTH', figmaWidth: fw });
  if (res?.appliedZoom) {
    showToast(`Page zoomed to ${res.appliedZoom.toFixed(2)}× to match ${fw}px`, 'success');
    // Re-fit the overlay to the new layout width.
    const bbox = (state.figmaData?.node?.document ?? state.figmaData?.node)?.absoluteBoundingBox;
    if (bbox && state.figmaData?.imageUrl) {
      await sendToPage({ type: 'FDR_SET_OVERLAY', imageUrl: state.figmaData.imageUrl, width: bbox.width, height: bbox.height, fit: true });
    }
  }
  await refreshScaleInfo();
});

// Reset zoom back to 1×.
el.resetZoomBtn.addEventListener('click', async () => {
  await sendToPage({ type: 'FDR_RESET_ZOOM' });
  const bbox = (state.figmaData?.node?.document ?? state.figmaData?.node)?.absoluteBoundingBox;
  if (bbox && state.figmaData?.imageUrl) {
    await sendToPage({ type: 'FDR_SET_OVERLAY', imageUrl: state.figmaData.imageUrl, width: bbox.width, height: bbox.height, fit: true });
  }
  await refreshScaleInfo();
  showToast('Zoom reset to 100%', 'info');
});

// Element picker
function startPicker() {
  el.pickBtn.classList.add('active');
  el.pickBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Hover + click · ↑ parent ↓ child · Esc`;
  sendToPage({ type: 'FDR_ACTIVATE_PICKER' });
}

function resetPicker() {
  el.pickBtn.classList.remove('active');
  el.pickBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg> Pick Element on Page`;
}

el.pickBtn.addEventListener('click', () => { state.pickingRoot = false; startPicker(); });
el.repickBtn.addEventListener('click', () => { state.pickingRoot = false; startPicker(); });

// Whole-page tree diff (auto root)
el.verifyPageBtn.addEventListener('click', () => runTreeDiff('auto'));

// Pick a root element, then run the tree diff under it.
el.verifyRootBtn.addEventListener('click', () => {
  state.pickingRoot = true;
  startPicker();
  showToast('Click the page element that maps to the Figma frame root.', 'info');
});

// Align overlay to a reference element (accurate scale & position).
el.alignOverlayBtn.addEventListener('click', () => {
  if (!state.figmaData?.node) { showToast('Fetch a Figma node first.', 'warning'); return; }
  state.pickingAlign = true;
  startPicker();
  showToast('Click the page element that matches the Figma frame.', 'info');
});

// Settings
el.settingsBtn.addEventListener('click', () => {
  el.settingsOverlay.classList.toggle('hidden');
  if (state.token) el.settingsToken.value = '';
  el.toleranceInput.value = state.tolerance;
});

el.closeSettings.addEventListener('click', () => el.settingsOverlay.classList.add('hidden'));

el.updateTokenBtn.addEventListener('click', async () => {
  const newToken = el.settingsToken.value.trim();
  if (!newToken) { showToast('Token cannot be empty', 'error'); return; }
  try {
    const user = await verifyToken(newToken);
    state.token = newToken;
    await chrome.storage.local.set({ figmaToken: newToken, figmaUser: { name: user.name } });
    el.userName.textContent = user.name;
    showToast('Token updated', 'success');
    el.settingsToken.value = '';
  } catch {
    showToast('Invalid token', 'error');
  }
});

el.toleranceInput.addEventListener('change', () => {
  state.tolerance = Math.max(0, parseInt(el.toleranceInput.value, 10) || 1);
  chrome.storage.local.set({ reviewTolerance: state.tolerance });
  // Re-COMPUTE the diff (not just re-render) so status reclassifies.
  rerunDiff();
  showToast(`Tolerance set to ±${state.tolerance}px`, 'info');
});

// Recompute the diff from the last picked element + current Figma node.
function rerunDiff() {
  if (!state.lastDom || !state.figmaData?.node) return;
  state.treeGroups = []; // a single-element diff supersedes any tree report
  const results = buildDiff(
    state.figmaData.node.document ?? state.figmaData.node,
    state.lastDom,
    state.lastDom.tokenMap,
    state.tolerance,
    figmaFrameWidth()
  );
  state.diffResults = results;
  renderDiff(results);
}

// Export
el.exportBtn.addEventListener('click', exportMarkdown);

// ── Receive messages from content script ─────────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'FDR_ELEMENT_SELECTED') {
    const dom = message.props;
    resetPicker();

    if (!state.figmaData?.node) {
      showToast('Fetch a Figma component first, then pick an element.', 'warning');
      state.pickingRoot = false;
      return;
    }

    // If this pick was to choose a tree-scan root, run the whole-tree diff
    // under it instead of a single-element diff. The content script has
    // already stored this element as `lastPicked`.
    if (state.pickingRoot) {
      state.pickingRoot = false;
      runTreeDiff('picked');
      return;
    }

    // Build element label
    const label = dom.id
      ? `#${dom.id}`
      : `${dom.tagName}${dom.classList[0] ? `.${dom.classList[0]}` : ''}`;

    el.selectedInfo.textContent = label;
    el.selectedBar.classList.remove('hidden');

    // Remember the picked element so tolerance changes can recompute.
    state.lastDom = dom;
    rerunDiff();
  }

  if (message.type === 'FDR_PICKER_CANCELLED') {
    resetPicker();
  }

  // Keep the panel's Scale slider in sync when the user resizes the
  // overlay directly on the page (corner drag or +/- buttons).
  if (message.type === 'FDR_OVERLAY_RESIZED') {
    const bbox = (state.figmaData?.node?.document ?? state.figmaData?.node)?.absoluteBoundingBox;
    if (!bbox?.width || !message.width) return;
    // The slider is relative to native frame width: 100% = frame width.
    const pct = Math.round((message.width / bbox.width) * 100);
    el.overlayScaleSlider.value = Math.min(200, Math.max(25, pct));
    el.overlayScaleValue.textContent = `${el.overlayScaleSlider.value}%`;
  }
});

// ── Initialise ───────────────────────────────────────────────
async function init() {
  const data = await chrome.storage.local.get([
    'figmaToken', 'figmaUser', 'reviewTolerance', 'savedNodes', 'activeNodeId',
  ]);

  if (!data.figmaToken) {
    showScreen('auth');
    return;
  }

  state.token     = data.figmaToken;
  state.user      = data.figmaUser ?? {};
  state.tolerance = data.reviewTolerance ?? 1;
  el.userName.textContent = state.user.name ?? 'Connected';
  el.toleranceInput.value = state.tolerance;
  showScreen('main');

  // Restore saved nodes across refresh, and re-activate the last one used.
  state.savedNodes = Array.isArray(data.savedNodes) ? data.savedNodes : [];
  renderSavedNodes();

  const last = state.savedNodes.find(n => n.id === data.activeNodeId) ?? state.savedNodes[0];
  if (last) {
    // Note: Figma image URLs can expire; if the overlay image fails to load
    // the user can re-fetch that node's URL to refresh it.
    await activateNode(last);
  }
}

init();
