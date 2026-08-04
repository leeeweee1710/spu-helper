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

  // Known card containers on the classic search results. Other listings ("you
  // may also like", recommendation rails) use hashed class names and wrap the
  // link in display:contents elements, so cards are derived from the product
  // links instead - see cardFor().
  var ITEM_SELECTOR = '.shopee-search-item-result__item, [data-sqe="item"]';
  var MAX_CARD_HOPS = 8;
  // A card is never most of the screen. Without this, a page holding one product
  // above a not-yet-loaded grid (find_similar_products) would climb to the page
  // wrapper and mark everything.
  var MAX_CARD_AREA = 0.55;
  var cardCache = new WeakMap(); // product link -> the box we mark

  var BADGE_STYLE =
    "position:absolute; top:0; left:0; color:white; padding:4px 8px;" +
    "font-weight:bold; z-index:9999; font-size:12px; pointer-events:none;";

  var STATUS_STYLES = {
    stashed: { border: "6px solid #ff4d4f", opacity: "0.4", label: "STASHED", color: "#ff4d4f" },
    checked: { border: "4px solid #52c41a", opacity: "1", label: "CHECKED", color: "#52c41a" },
    // The product the task asked us to find. Outranks the other two: knowing a
    // result IS the seed matters more than whether it has been looked at.
    seed: { border: "5px solid #1e88e5", opacity: "1", label: "SEED", color: "#1e88e5" },
  };

  // The badge is always a direct child. A plain querySelector would reach into
  // a card nested inside this box and delete ITS badge instead - which is how a
  // marked card ended up with no badge and a stray one sat at the page corner.
  function ownBadge(item) {
    var kids = item.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].classList && kids[i].classList.contains("status-badge")) return kids[i];
    }
    return null;
  }

  // Strip our styling instead of writing "none"/"1" over it, so the card keeps
  // whatever border and opacity Shopee gave it.
  function resetItem(item) {
    var badge = ownBadge(item);
    if (badge) badge.remove();
    item.style.removeProperty("border");
    item.style.removeProperty("opacity");
    item.style.removeProperty("position");
    delete item.dataset.appliedStatus;
  }

  // ---- sponsored blocks --------------------------------------------------
  // Shopee slots a sponsored shop block into the results, carrying a small "Ad"
  // marker and a few of that shop's products. Those are not search results, and
  // marking one of them (the seed tile in particular) is misleading - so the
  // block is hidden and its tiles are kept out of the marking entirely.
  var AD_SECTION = ".shopee-header-section, [data-sqe='ad']";
  var AD_LABEL = /^(ad|ads|廣告)$/i;

  function isAdSection(section) {
    var nodes = section.querySelectorAll("*");
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].children.length !== 0) continue;
      if (AD_LABEL.test((nodes[i].textContent || "").trim())) return true;
    }
    return false;
  }

  // Hidden rather than removed: the block is React-managed, and pulling it out
  // of the tree can break the next render.
  function hideAdSections() {
    var sections = document.querySelectorAll(AD_SECTION);
    for (var i = 0; i < sections.length; i++) {
      var section = sections[i];
      if (section.dataset.spuAd) continue;
      if (!isAdSection(section)) continue;
      section.dataset.spuAd = "1";
      section.style.display = "none";
    }
  }

  function insideAd(el) {
    return !!(el.closest && el.closest("[data-spu-ad]"));
  }

  // Does el hold a product other than `key`? (bails out on the first one)
  function holdsOtherProducts(el, key) {
    var anchors = el.querySelectorAll("a[href]");
    for (var i = 0; i < anchors.length; i++) {
      var k = getProductKey(anchors[i].href);
      if (k && k !== key) return true;
    }
    return false;
  }

  // display:contents wrappers have no box of their own, so a border on them
  // draws nothing.
  function hasBox(el) {
    return el.offsetWidth > 0 || el.offsetHeight > 0;
  }

  // Too big to be one product's card.
  function oversized(el) {
    var rect = el.getBoundingClientRect();
    var viewport = (window.innerWidth || 1) * (window.innerHeight || 1);
    return rect.width * rect.height > viewport * MAX_CARD_AREA;
  }

  // The card is the largest box that still belongs to this one product: climb
  // from its link until the parent starts holding other products. A known card
  // container wins outright.
  function cardFor(anchor, key) {
    var node = anchor, best = null, hops = 0;
    while (node && hops++ < MAX_CARD_HOPS) {
      if (node.matches && node.matches(ITEM_SELECTOR)) return node;
      if (hasBox(node)) {
        if (oversized(node)) break; // ancestors are only bigger
        best = node;
      }
      var parent = node.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      if (holdsOtherProducts(parent, key)) break;
      node = parent;
    }
    return best;
  }

  // One entry per card on the page, whatever the listing looks like.
  function cardsOnPage() {
    hideAdSections(); // before deriving cards, so ad tiles never become one
    var anchors = document.querySelectorAll("a[href]");
    var cards = [], seen = [];
    for (var i = 0; i < anchors.length; i++) {
      var key = getProductKey(anchors[i].href);
      if (!key || insideAd(anchors[i])) continue;
      var card = cardCache.get(anchors[i]);
      // Re-derive when the cached box stopped being this product's own: these
      // pages fill in lazily, so a box that held one product at first can end
      // up holding a whole grid - or simply grow far too big to be a card.
      if (
        !card ||
        !card.isConnected ||
        !card.contains(anchors[i]) ||
        holdsOtherProducts(card, key) ||
        oversized(card)
      ) {
        card = cardFor(anchors[i], key);
        if (card) cardCache.set(anchors[i], card);
      }
      if (!card || seen.indexOf(card) !== -1) continue; // image + title link to the same product
      seen.push(card);
      cards.push({ el: card, key: key });
    }
    return cards;
  }

  // Which card is the task's seed, if it is on the page at all. Matched on the
  // shop/item id from the task's item url and nothing else: titles are not
  // unique (several shops list the very same one) and a search card carries no
  // shop name to tell them apart. No item url on the task, no marking.
  function seedCard(seed, cards) {
    if (!seed || !seed.key) return null;
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].key === seed.key) return cards[i].el;
    }
    return null;
  }

  function syncUI() {
    if (!chrome.runtime || !chrome.runtime.id) return;
    chrome.storage.local.get(["product_memory", "recall_seed"], function (res) {
      if (chrome.runtime.lastError) return;
      var memory = res.product_memory || {};
      var seed = res.recall_seed || null;
      var cards = cardsOnPage();
      var seedEl = seedCard(seed, cards);
      var live = [];
      for (var i = 0; i < cards.length; i++) {
        var item = cards[i].el;
        var key = cards[i].key;
        live.push(item);
        var status = key && STATUS_STYLES[memory[key]] ? memory[key] : "";
        if (item === seedEl) status = "seed";

        // Skip cards already in the right state - this runs on every scroll.
        // Comparing against "" also un-marks items dropped from memory one at a
        // time, not just on a full clear. A marked card that somehow lost its
        // badge is repainted rather than skipped.
        if ((item.dataset.appliedStatus || "") === status && (!status || ownBadge(item))) continue;

        if (!status) {
          resetItem(item);
          continue;
        }

        var style = STATUS_STYLES[status];
        item.style.position = "relative";
        var badge = ownBadge(item);
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

      // A re-render can leave a marked box that is no longer a card (or whose
      // link changed), so strip anything we marked that is not a card now.
      var marked = document.querySelectorAll("[data-applied-status]");
      for (var j = 0; j < marked.length; j++) {
        if (live.indexOf(marked[j]) === -1) resetItem(marked[j]);
      }
      // Badges are absolutely positioned against their card, so one left on a
      // box that is no longer a card drifts to the page corner. Drop any whose
      // host we are not marking.
      var strays = document.querySelectorAll(".status-badge");
      for (var s = 0; s < strays.length; s++) {
        var host = strays[s].parentElement;
        if (!host || live.indexOf(host) === -1) strays[s].remove();
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
    if (area === "local" && (changes.product_memory || changes.recall_seed)) syncUI();
  });

  // Watch for scrolling / newly rendered cards. Throttled rather than debounced:
  // these pages mutate continuously, and a debounce kept getting pushed back so
  // the marks only appeared once the page went quiet.
  var GAP = 150;
  var queued = null;
  var lastRun = 0;
  var observer = new MutationObserver(function () {
    if (queued) return;
    var wait = Math.max(0, GAP - (Date.now() - lastRun));
    queued = setTimeout(function () {
      queued = null;
      lastRun = Date.now();
      reportLocation();
      syncUI();
    }, wait);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("popstate", reportLocation);

  reportLocation();
  syncUI();
})();
