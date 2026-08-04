/* SPU Annotation Helper - duplicate search results (ISOLATED world, shopee.tw)
 *
 * The Recall task means searching the storefront for a matching product, and the
 * same product keeps coming back across searches. Every product page visited is
 * remembered (see src/background.js), and its card is marked in the search
 * results so an already-checked item is obvious at a glance.
 *
 * Ported from the standalone "Better SPU Recall Duplicated Search Results
 * Helper" by huimin.lau. The original also guessed at "stashed" by watching for
 * clicks on stash/add/submit buttons; that guess is left out - the status itself
 * is still painted, so our own stash detection can set it later.
 */
(function () {
  "use strict";

  var ITEM_SELECTOR = '.shopee-search-item-result__item, [data-sqe="item"]';

  var BADGE_STYLE =
    "position:absolute; top:0; left:0; color:white; padding:4px 8px;" +
    "font-weight:bold; z-index:9999; font-size:12px; pointer-events:none;";

  var STATUS_STYLES = {
    stashed: { border: "6px solid #ff4d4f", opacity: "0.4", label: "STASHED", color: "#ff4d4f" },
    checked: { border: "4px solid #52c41a", opacity: "1", label: "CHECKED", color: "#52c41a" },
  };

  // Strip our styling instead of writing "none"/"1" over it, so the card keeps
  // whatever border and opacity Shopee gave it.
  function resetItem(item) {
    var badge = item.querySelector(".status-badge");
    if (badge) badge.remove();
    item.style.removeProperty("border");
    item.style.removeProperty("opacity");
    item.style.removeProperty("position");
    delete item.dataset.appliedStatus;
  }

  // First anchor in the card that actually points at a product.
  function findProductKey(item) {
    var anchors = item.querySelectorAll("a[href]");
    for (var i = 0; i < anchors.length; i++) {
      var key = getProductKey(anchors[i].href);
      if (key) return key;
    }
    return null;
  }

  function syncUI() {
    if (!chrome.runtime || !chrome.runtime.id) return;
    chrome.storage.local.get(["product_memory"], function (res) {
      if (chrome.runtime.lastError) return;
      var memory = res.product_memory || {};
      var items = document.querySelectorAll(ITEM_SELECTOR);
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var key = findProductKey(item);
        var status = key && STATUS_STYLES[memory[key]] ? memory[key] : "";

        // Skip cards already in the right state - this runs on every scroll.
        // Comparing against "" also un-marks items dropped from memory one at a
        // time, not just on a full clear.
        if ((item.dataset.appliedStatus || "") === status) continue;

        if (!status) {
          resetItem(item);
          continue;
        }

        var style = STATUS_STYLES[status];
        item.style.position = "relative";
        var badge = item.querySelector(".status-badge");
        if (!badge) {
          badge = document.createElement("div");
          badge.className = "status-badge";
          item.appendChild(badge);
        }
        item.style.border = style.border;
        item.style.opacity = style.opacity;
        badge.innerText = style.label;
        badge.style.cssText = BADGE_STYLE + "background:" + style.color + ";";
        item.dataset.appliedStatus = status;
      }
    });
  }

  // Report our own location: same-document navigations are visible here even
  // when the tab never reports a load, and this also covers the first page view.
  var lastReportedUrl = "";
  function reportLocation() {
    if (!chrome.runtime || !chrome.runtime.id) return;
    if (location.href === lastReportedUrl) return;
    lastReportedUrl = location.href;
    if (!getProductKey(location.href)) return;
    try {
      var p = chrome.runtime.sendMessage({ action: "mark_as_checked", url: location.href });
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.action === "clear_ui") syncUI();
  });

  // Repaint as soon as memory changes, including marks made in other tabs.
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === "local" && changes.product_memory) syncUI();
  });

  // Watch for scrolling / newly rendered cards, throttled to keep it cheap.
  var timer = null;
  var observer = new MutationObserver(function () {
    clearTimeout(timer);
    timer = setTimeout(function () {
      reportLocation();
      syncUI();
    }, 150);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("popstate", reportLocation);

  reportLocation();
  syncUI();
})();
