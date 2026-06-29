# Figma Design Reviewer — Chrome Extension

Pixel-perfect comparison of your live frontend implementation against Figma designs, with **PrimeVue token awareness**.

---

## What it does

- **Overlay mode** — renders the Figma frame as a semi-transparent overlay on your live page, auto-fitted to your page width. Drag to align, and use the **Scale** slider to size the whole frame for full-screen review.
- **Match Figma width** — zooms the page so its layout width equals the Figma frame width. This makes absolute px comparisons exact even when you're reviewing on a screen with a different size/DPR than the design was made for.
- **Element inspector** — click any DOM element to instantly compare its computed CSS against the Figma spec.
- **Whole-tree / whole-page diff** — recursively match *every* node in the Figma frame to the page (by on-screen position) and diff each one, so you don't just check the outer layer of a component. Two modes: **Verify whole page** (auto-finds the page root) or **Pick a page root, then scan**. Results are grouped per node as a collapsible tree, and every matched node gets a colour-coded box on the page.
- **On-page diff markers** — after a diff, a coloured box is drawn around the picked element on the page, listing the mismatches inline, plus the actual **gap spans** between children are highlighted and the **DOM path** of where the spacing comes from is shown — so you see *what* and *where* in context.
- **Visual, not representational, diffing** — the tool compares what's *rendered*, not how it was coded:
  - **Gap** is checked against the *measured* spacing between children (descending through wrapper elements), so a PrimeVue component that puts the gap on an inner grid is a match, not a false mismatch.
  - **Padding** is checked against the *effective visual inset* (distance from the element's edges to its children's bounding box). Figma's 4-side padding implemented in code as a single `padding`, child `margin`, or a wrapper all read as a match when the visible result is identical — only a genuinely different inset is flagged.
- **Decorative nodes skipped** — Figma `VECTOR` / `GROUP` / icon-path nodes have no DOM equivalent and are skipped during whole-tree scans (counted in the summary) instead of flooding the report with "no DOM match" rows.
- **Saved nodes** — every fetched node is saved and survives a refresh. Switch between multiple components/screens to review them without re-pasting URLs.
- **Diff engine** — compares border-radius, padding, gap, width/height, colors, typography, border, and opacity.
- **PrimeVue token resolver** — dynamically reads `--p-*` CSS variables from your page and maps computed values back to token names, so you know *which token* you used, not just the raw pixel value.
- **Export** — one-click Markdown report of all diffs.

---

## Installation

### 1. Get a Figma Personal Access Token

1. Go to **Figma → Settings → Personal access tokens**
2. Click **Generate new token**, give it a name, and copy it
3. You only need the **File content: Read** scope

### 2. Load the extension in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `figma-reviewer/` folder (this folder)
5. The extension icon will appear in your toolbar

---

## Usage

### Step 1 — Connect Figma
Click the extension icon → the side panel opens → enter your Personal Access Token → **Connect to Figma**

### Step 2 — Get a Figma node URL
In Figma, **right-click any frame or component → Copy link**

The URL looks like:
```
https://www.figma.com/design/ABC123/My-Design?node-id=12-345
```

### Step 3 — Fetch the component
Paste the URL into the panel → **Fetch Component**

The panel loads a preview of the Figma node. Every node you fetch is added to **Saved Nodes** and persists across refreshes — paste several URLs to build up a list, then click any saved node to switch to it (or **✕** to remove it). This is how you review multiple components/screens without re-pasting URLs each time.

> Figma preview image URLs are temporary and can expire after a while. If a saved node's overlay image stops loading, just re-fetch its URL to refresh it.

### Step 4 — Match the viewport (recommended for px-accurate review)
If the panel shows *"Page WIDTHpx vs Figma WIDTHpx — N×"*, your screen isn't the size the design was made for, so raw Width/Height diffs would be misleading (they're shown as **info** instead of errors). Click **Match Figma width** to zoom the page to the frame's width — now comparisons are exact. Click **Reset** to undo.

### Step 5 — Use the overlay
The overlay appears automatically after fetch, auto-fitted to your page width.
- Toggle **Show Figma overlay** on/off
- Adjust **opacity** with the slider
- Adjust **Scale** to size the whole frame (useful for reviewing full screens)
- **Drag the purple bar** at the top-left of the overlay to move it over your implementation
- Use the **− / +** buttons on that bar, or **drag the purple square** at the bottom-right corner, to resize the overlay directly on the page (it keeps its aspect ratio). The panel's Scale slider stays in sync.

> **Scale looks wrong (too big / too small)?** Auto-fit assumes your UI fills the viewport, so it's off for centered or narrower layouts. Click **Align overlay to element** and pick the page element that matches the Figma frame (e.g. your page/app container). The overlay snaps to that element's exact on-screen size and position — 1:1, regardless of viewport width or zoom. It then offers to run a full diff of that region so any mismatches you spot become an exportable issue list.

### Step 5 — Pick an element
Click **Pick Element on Page** → hover over any element (it highlights in purple) → click it.

### Step 5b — Or diff the whole tree
Instead of (or after) picking one element, use the **INSPECT** section:
- **Verify whole page** — the tool flattens the entire Figma frame tree, matches each node to the page element it overlaps best, and diffs every one. Best run *after* **Match Figma width** so the geometry lines up.
- **Pick a page root, then scan** — click the page element that corresponds to the Figma frame root (e.g. your app container), and matching starts from there. Use this when auto-detection picks the wrong root.

Results appear as a collapsible tree grouped by node (nodes with issues are expanded by default), and each matched node is outlined on the page in green/amber/red. **Hover a red/amber box on the page** to see that node's specific problems in a tooltip. Nodes Figma has but the page doesn't are flagged as **no DOM match**; decorative Figma nodes (vectors, groups, icon paths) are skipped and counted in the summary.

### Step 6 — Review the diff
The panel shows every property side-by-side: Figma value vs DOM computed value.

| Icon | Meaning |
|------|---------|
| ✓ | Match |
| ✕ | Mismatch |
| ~ | Close (within tolerance) |
| ⓘ | Informational — comparison can't be exact at the current zoom (use **Match Figma width**) |

**Token info** is shown below each mismatch — you'll see which `--p-*` token your DOM is currently resolving to.

### Step 7 — Fix and recheck
Fix the issue in your code, hot-reload the page, then click **Pick Element** again to recheck.

### Export
Click **Export as Markdown** to download a report — useful for sending a self-review summary to your designer.

---

## Settings

| Setting | Description |
|---------|-------------|
| **Figma Token** | Update your PAT without re-entering the auth screen |
| **Tolerance (px)** | Diffs within ±N px show as warnings (yellow) instead of errors (red). Default: 1px |

---

## PrimeVue Token Resolution

The extension scans your page's stylesheets at runtime for all `--p-*` CSS custom properties and builds a reverse map. This means:

- It works with **any PrimeVue theme** — Aura, Lara, Nora, or custom
- Token names are read from your **actual deployed CSS**, not a hardcoded list
- If your project overrides tokens, those overrides are captured automatically

Example output:
```
⚠️  Border Radius
    Figma:  8px
    DOM:    6px
    Token:  --p-border-radius-sm  (resolves to 6px)
```
→ You'd fix this by using `--p-border-radius-lg` or `border-radius: 8px` directly.

---

## Properties checked

| Property | Figma field |
|----------|-------------|
| Border radius | `cornerRadius` / `rectangleCornerRadii` |
| Padding (all sides) | `paddingTop/Bottom/Left/Right` |
| Gap | `itemSpacing` (compared against *measured* spacing between children, descending through wrapper elements) |
| Width / Height | `absoluteBoundingBox` |
| Background color | `fills[*].color` (SOLID) |
| Border color | `strokes[*].color` (SOLID) |
| Border width | `strokeWeight` |
| Font size | `style.fontSize` |
| Font weight | `style.fontWeight` |
| Line height | `style.lineHeightPx` |
| Letter spacing | `style.letterSpacing` |
| Opacity | `opacity` |
| Text color | `fills` on TEXT nodes |

---

## Limitations

- Full-page overlay works best on fixed/known viewport sizes. For responsive layouts, use **Align overlay to element** or component-by-component comparison.
- Cross-origin stylesheets (CDN fonts, external CSS) cannot be scanned for tokens — the extension scans only same-origin sheets.
- Figma components inside locked/private team libraries require the user to have explicit file access.
- **Figma API rate limits are enforced by Figma, not the extension, and cannot be disabled.** The REST API returns HTTP 429 when a per-token limit is exceeded (the image-render endpoint is limited more tightly than file reads). The extension mitigates this: fetched node data is **cached** (re-fetching the same URL or switching between Saved Nodes makes no API call), 429s are **retried with backoff** (honouring `Retry-After`), and a node's overlay image is only re-fetched when its temporary URL has expired. If you do hit a limit, wait the indicated time — your already-fetched nodes still diff offline from cache.

---

## Troubleshooting

**"Access denied"** — Your token doesn't have read access to this file. Check that you have been shared the Figma file.

**"Node not found"** — The URL must include a `node-id` parameter. Right-click a specific frame or component in Figma (not just the file).

**"Figma rate limit reached"** — You've made too many API calls in a short window (Figma enforces this; it can't be turned off). Wait the indicated time. To avoid it: re-use **Saved Nodes** (cached, no API call) instead of re-fetching, and avoid repeatedly fetching new image-heavy nodes in quick succession.

**Red boxes/markers appear off-screen or misaligned** — This was a zoom bug; fixed. If you still see it, make sure you've reloaded the extension and the tab so the latest content script is loaded. Markers now de-zoom correctly when **Match Figma width** is active.

**Overlay doesn't appear** — Make sure the **Show Figma overlay** toggle is on and you're on a normal `http(s)` page (not `chrome://`, the Web Store, or a PDF). If you just installed the extension, reload the tab once so the content script is present. Some pages with strict CSP headers may still block the overlay image — use element inspector mode instead.

**Width / Height always shows ⓘ info** — Your screen isn't at the design's width. Click **Match Figma width**, then re-pick the element for an exact comparison.

**Gap shows a mismatch but it looks right** — The tool measures the *rendered* distance between the element's children and descends through wrapper elements to find where the spacing comes from. If it still misreads, check that the children are real flow elements (not absolutely positioned) and that the spacing is consistent between them — the reported value is the most common measured gap. The note under the row tells you which node/mechanism it measured.

**Token map is empty** — PrimeVue may not be loaded on this page, or the stylesheet is cross-origin. The diff still works; you just won't see token names.
