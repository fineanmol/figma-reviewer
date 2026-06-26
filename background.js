// ============================================================
// background.js — Service worker
// Opens the side panel when the toolbar icon is clicked
// ============================================================

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);

// Ensure content script is injected when a tab updates
// (handles cases where extension was installed after page load)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url?.startsWith('http')) {
    chrome.scripting
      .executeScript({
        target: { tabId },
        files: ['content/content.js'],
      })
      .catch(() => {}); // Ignore errors for restricted pages

    chrome.scripting
      .insertCSS({
        target: { tabId },
        files: ['content/content.css'],
      })
      .catch(() => {});
  }
});
