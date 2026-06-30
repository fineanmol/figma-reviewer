<!--
  ⚠️ AI-DRAFTED — REVIEW BEFORE PUBLISHING
  This privacy policy was drafted with AI assistance. It must be reviewed and
  approved by your legal/compliance team, and hosted at a public URL, before it
  is linked in the Chrome Web Store Developer Dashboard. Replace the placeholder
  contact and hosting URL below.
-->

# Privacy Policy — Figma Design Reviewer

_Last updated: 2026-06-30_

Figma Design Reviewer ("the extension") is a developer tool that compares a live
web page against Figma designs. This policy explains exactly what data the
extension handles and where it goes.

## What the extension stores

The extension stores the following **locally in your browser only**, using
Chrome's `chrome.storage.local`:

- **Your Figma Personal Access Token (PAT)** — used to authenticate requests to
  the Figma API.
- **Your Figma account name and email** — returned by Figma when the token is
  verified, shown in the UI to confirm who is connected.
- **Saved Figma nodes** — the design data (layout, styles, and a preview image
  URL) for components/frames you have fetched, so you can switch between them
  without re-fetching.
- **Your tolerance/preference settings.**

This data never leaves your browser except as described below.

## What the extension sends, and where

- **To `api.figma.com` only:** your Personal Access Token (in the
  `X-Figma-Token` request header) and the file/node IDs you ask to review, so
  Figma can return that design's data and a preview image. This is the only
  network destination the extension contacts.
- **Nothing else.** The extension contains no analytics, no telemetry, no
  advertising, and no third-party SDKs. We do not operate any server and never
  receive your data.

## The web pages you inspect

When you use the overlay, element picker, or diff features, the extension reads
the structure and computed styles of the page **locally, in your browser**, to
compare them against the Figma design. This page data is **never transmitted**
anywhere — it is used only to render the comparison in the side panel and on the
page, and is discarded when you close the panel or navigate away.

## Permissions and why they are needed

- **`storage`** — to save your token, connected account, saved nodes, and
  settings locally (above).
- **`activeTab` + `scripting`** — to inject the comparison/overlay code into the
  current tab **only when you explicitly act** (open the panel and run a
  feature). The extension does not run on pages in the background.
- **`sidePanel`** — to show the extension UI in Chrome's side panel.
- **Host access to `https://api.figma.com/*`** — to call the Figma API.

The extension requests **no broad host permissions** and does **not** run a
content script on every site.

## Data retention and deletion

All stored data lives in your browser. You can delete it at any time:

- **Disconnect / Sign out** in the extension removes your token and account info.
- **Clear all** removes your saved nodes.
- Removing the extension from Chrome deletes all of its local storage.

To revoke API access entirely, delete the Personal Access Token in your
[Figma account settings](https://www.figma.com/settings).

## Children

The extension is a developer tool and is not directed at children.

## Changes

If this policy changes, the "Last updated" date above will change and the new
version will be posted at the policy URL linked from the Chrome Web Store
listing.

## Contact

Questions about this policy: **<add a contact email before publishing>**.
