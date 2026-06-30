# Publishing Guide — Figma Design Reviewer

Copy-paste-ready content for the **Chrome Web Store Developer Dashboard**. Each
section below maps to a specific field in the dashboard. Fields are written to
be both Chrome-Web-Store-compliant and **answer-engine / AI-search friendly**
(clear headings, plain statements, an FAQ block, and explicit keywords).

> ⚠️ **Review before publishing.** The privacy policy and all user-facing
> compliance text below are AI-drafted and must be reviewed and approved by the
> appropriate team, and given a real support email and hosted policy URL,
> before submission.

---

## 0. Pre-submission checklist

- [ ] Build the upload package: `./package-extension.sh` → `figma-design-reviewer.zip` (runtime files only)
- [ ] Host `PRIVACY.md` at a public URL (e.g. GitHub Pages) and have it reviewed
- [ ] Add a real support email (replace placeholder in Privacy + Support fields)
- [ ] Capture ≥1 screenshot at 1280×800 (see §7)
- [ ] Have the Developer Dashboard account verified + 2FA enabled

---

## 1. Product name

```
Figma Design Reviewer
```

## 2. Summary (short description — max 132 chars)

```
Compare your live web UI against Figma designs. Overlay, inspect, and pixel-diff elements right in the browser.
```

_(111 characters — within the 132-char limit.)_

## 3. Detailed description (Store listing "Description" field)

```
Figma Design Reviewer is a developer tool that compares your live, running web UI against your Figma designs — directly in the browser, with no build step.

Open the side panel, paste a Figma frame or component link, and the extension overlays the design on your page, inspects any element, and shows a precise diff of what does not match the spec.

WHAT IT DOES
• Overlay mode — ghost the Figma frame over your live page at the correct scale; adjust opacity, drag to align, and resize on the page.
• Align to element — snap the overlay to a specific page element so the scale is exact even for centered or responsive layouts.
• Element inspector — click any element to compare its computed CSS (size, padding, gap, color, typography, radius, border, opacity) against the Figma node.
• Recursive / whole-tree diff — check an entire component subtree or a full screen at once; every matched node is outlined on the page and listed in a grouped report.
• Visual, not literal, diffing — spacing is compared by what actually renders, so a gap implemented on an inner wrapper or padding done with margins is correctly recognized as a match, not a false error.
• PrimeVue token awareness — reads --p-* CSS variables from your page and tells you which design token a value maps to.
• Match Figma width — constrain the page to the design's width so a responsive layout reflows exactly as the design intends before you compare.
• Saved nodes — fetched designs persist across refreshes, so you can review several screens without re-pasting links.
• Export — download a Markdown report of all mismatches for self-review or a ticket.

HOW IT WORKS
Connect once with a Figma Personal Access Token (read-only scope). The token is stored locally in your browser and sent only to the Figma API to read your files. The pages you inspect are read locally and never uploaded.

WHO IT IS FOR
Front-end developers, design-engineers, and QA who do design-implementation review and want to catch pixel and spacing drift before it ships.

PRIVACY
No analytics, no telemetry, no third-party servers. The only network destination is api.figma.com. See the privacy policy linked on this listing.
```

## 4. Category & language

```
Category: Developer Tools
Language: English
```

## 5. Single-purpose description (dashboard "Single purpose" field)

```
The single purpose of this extension is to let a developer compare a live web page against a Figma design — by overlaying the design on the page and diffing element styles against the Figma file's specification.
```

---

## 6. Permission justifications (dashboard "Privacy practices" tab)

Paste each justification next to its permission.

**`activeTab`**
```
Used to access the current tab only when the user explicitly runs a comparison (opens the side panel and triggers a feature), so the extension can read element styles and draw the overlay on the page the user is reviewing. The extension does not access tabs in the background.
```

**`scripting`**
```
Used to inject the comparison and overlay code into the current tab on demand when the user runs a feature. There is no persistent content script; injection happens only in response to a user action.
```

**`storage`**
```
Used to save the user's Figma access token, connected account name, fetched design nodes, and preferences locally in the browser so the user does not have to reconnect or re-fetch on each use. Nothing is stored remotely.
```

**`sidePanel`**
```
Used to present the extension's user interface in Chrome's side panel.
```

**Host permission `https://api.figma.com/*`**
```
Used to call the Figma REST API to fetch the design data and preview image for the file/node the user chooses to review. This is the only remote host the extension contacts.
```

**"Are you using remote code?"**
```
No. All code is contained in the extension package. No code is fetched or executed from remote sources.
```

---

## 7. Data-use disclosures (dashboard "Data usage" checkboxes)

Set these to match the privacy policy:

```
Data collected: Authentication information (the user's Figma Personal Access Token), and the user's Figma account name/email returned by Figma.

• This data is used only to operate the single purpose of the extension (authenticate to and read the user's Figma files).
• This data is NOT sold to or shared with third parties.
• This data is NOT used or transferred for purposes unrelated to the item's single purpose.
• This data is NOT used to determine creditworthiness or for lending.
• The token and account info are stored locally in the user's browser and transmitted only to api.figma.com.

Privacy policy URL: <PASTE YOUR HOSTED PRIVACY POLICY URL HERE>
```

---

## 8. Store assets

**Icon:** `icons/icon128.png` (128×128) — already in the package.

**Screenshots** (required — at least one; 1280×800 or 640×400 PNG/JPEG). Suggested set, in order:
```
1. Side panel connected to Figma, next to a live page — caption: "Connect with a read-only Figma token."
2. Figma frame overlaid on a live page — caption: "Overlay your design on the running UI."
3. Single-element diff with Figma-vs-DOM values — caption: "Inspect any element against the spec."
4. Whole-tree report with colored on-page markers — caption: "Diff a whole component or screen at once."
```

**Promo tile (optional, recommended):** 440×280 PNG.

**Suggested search keywords / tags** (for the listing and discoverability):
```
figma, design review, pixel perfect, design QA, design to code, css diff, overlay, design tokens, primevue, front-end, design system, visual diff, dev tools
```

---

## 9. Support & contact

```
Support email: <ADD A MONITORED SUPPORT EMAIL>
Support / homepage URL: <ADD REPO OR SITE URL>
```

---

## 10. FAQ (for the listing footer and for answer-engine extraction)

**What is Figma Design Reviewer?**
A Chrome extension that compares your live web page against a Figma design — overlaying the design and diffing element styles — so you can catch pixel and spacing differences before shipping.

**Do I need a Figma account?**
Yes. You connect with a Figma Personal Access Token (read-only). It is stored locally in your browser and sent only to the Figma API.

**Does it send my data anywhere?**
The only network destination is api.figma.com. The pages you inspect are read locally and never uploaded. There is no analytics or telemetry.

**Does it work on any website?**
It runs only on the tab you are actively reviewing, when you trigger it. It cannot run on Chrome system pages (chrome://), the Web Store, or PDF viewer.

**Is it free?**
Yes.

**What frameworks does it support?**
Any web page. It has extra awareness of PrimeVue design tokens (--p-* CSS variables) but works regardless of framework.

---

## 11. Version & release notes (for this submission)

```
Version: 1.0.0

Initial release.
• Figma overlay with align-to-element, opacity, drag, and resize.
• Element inspector and recursive whole-tree diff with on-page markers.
• Visual spacing comparison (gap/padding measured as rendered).
• PrimeVue token resolution and Markdown export.
• Local-only token storage; minimal permissions (activeTab, scripting, storage, sidePanel; api.figma.com only).
```
