// ============================================================
// background.js — Service worker
// Opens the side panel when the toolbar icon is clicked.
// The content script is injected on demand (activeTab + scripting)
// from the panel's sendToPage(), so there is NO static content script
// and NO <all_urls> host permission — the reviewer only touches a page
// when the user explicitly acts on it.
// ============================================================

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

// Seed default settings on install/update so first run is well-defined.
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const cur = await chrome.storage.local.get(['reviewTolerance']);
    if (cur.reviewTolerance === undefined) {
      await chrome.storage.local.set({ reviewTolerance: 1 });
    }
  } catch {
    // Storage unavailable — non-fatal; the panel falls back to defaults.
  }
});
