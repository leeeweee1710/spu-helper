/* SPU Annotation Helper - quiet down the storefront (ISOLATED, shopee.tw)
 *
 * Recall means comparing a product against search results, so everything the
 * storefront puts on screen to sell things - top nav, cart, keyword rail,
 * filters, sort bar, discount chips, ratings, sold counts, delivery estimates,
 * seller location, the chat widget - is noise, and on a product page the buy
 * and add-to-cart buttons are a hazard. All of it is hidden while the Recall
 * UI is switched on (the "Custom UI" toggle under Recall in the popup).
 *
 * Hidden, never removed: the page is React-managed, and taking nodes out of the
 * tree can break its next render. One stylesheet does the work, so switching the
 * toggle off puts everything back.
 */
(function () {
  "use strict";

  var STYLE_ID = "spu-recall-declutter";
  var HIDE_ATTR = "data-spu-hide";

  // Stable, semantic hooks - these survive Shopee's hashed-class churn.
  var ALWAYS_HIDDEN = [
    ".navbar-wrapper", // 賣家中心 / 下載 / 追蹤我們 / 通知總覽 / 幫助中心 / language / account
    ".cart-drawer-container", // cart
    ".shopee-filter-panel", // left filter sidebar
    ".shopee-sort-bar", // 篩選 / 綜合排名 / 最新 / 月銷熱賣 / 價格
    "#shopee-mini-chat-embedded", // 聊聊
  ];

  // Buy buttons on a product page. Matched on their own text so only the buttons
  // go - their row also holds our Stash button.
  var BUY_TEXT = /加入購物車|立即購買|直接購買|立即前往購買/;
  // Chips like "1.8折" or "5 件 9.8折" sitting beside the price.
  var DISCOUNT_TEXT = /^\d+(\.\d+)?折$|^\d+\s*件\s*\d+(\.\d+)?折$/;
  var SOLD_TEXT = /已售出/;
  // Delivery estimates. Deliberately no bare-number "rating" pattern: the price
  // digits sit next to the "$" as their own element, and a rating pattern eats
  // them. The rating always shares its row with the sold count anyway.
  var DELIVERY_TEXT = /天到|小時到|明天|後天|免運/;

  var on = false;

  function styleSheet() {
    var el = document.getElementById(STYLE_ID);
    if (el) return el;
    el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent =
      ALWAYS_HIDDEN.join(",") + "{display:none !important}" +
      "[" + HIDE_ATTR + "]{display:none !important}";
    (document.head || document.documentElement).appendChild(el);
    return el;
  }

  function hide(el) {
    if (el && !el.hasAttribute(HIDE_ATTR)) el.setAttribute(HIDE_ATTR, "1");
  }

  function leaves(root) {
    var all = root.querySelectorAll("*");
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].children.length === 0) out.push(all[i]);
    }
    return out;
  }

  // ---- the keyword rail under the search bar ----------------------------
  function hideKeywordRail() {
    var header = document.querySelector("header");
    if (!header) return;
    var links = header.querySelectorAll('a[href*="/search?keyword="]');
    if (links.length < 3) return; // a rail, not a stray link
    hide(links[0].parentElement || links[0]);
  }

  // ---- search-result cards ---------------------------------------------
  // Keep the picture, the title and the price; drop the sales furniture.
  function trimCards() {
    var cards = document.querySelectorAll(
      '.shopee-search-item-result__item, [data-sqe="item"], [data-spu-card]'
    );
    for (var i = 0; i < cards.length; i++) trimCard(cards[i]);
  }

  function trimCard(card) {
    if (card.dataset.spuTrimmed) return;
    var priceLeaf = null;
    var cardLeaves = leaves(card);
    var j;
    for (j = 0; j < cardLeaves.length && !priceLeaf; j++) {
      if (/^\$/.test((cardLeaves[j].textContent || "").trim())) priceLeaf = cardLeaves[j];
    }
    if (!priceLeaf) return; // not rendered yet
    card.dataset.spuTrimmed = "1";

    // Everything that follows the price, at every level from the price up to the
    // card: the discount chip beside it, then the rating, sold count, delivery
    // estimate and seller location rows. A group is only dropped when it looks
    // like sales furniture, so the price's own digits are never touched.
    var node = priceLeaf;
    while (node && node !== card && node.parentElement) {
      var after = [], sib = node.nextElementSibling;
      while (sib) { after.push(sib); sib = sib.nextElementSibling; }
      if (after.length && looksLikeNoise(after)) {
        for (j = 0; j < after.length; j++) hide(after[j]);
      }
      node = node.parentElement;
    }

    // The discount chip beside the price.
    cardLeaves = leaves(card);
    for (j = 0; j < cardLeaves.length; j++) {
      var text = (cardLeaves[j].textContent || "").trim();
      if (DISCOUNT_TEXT.test(text)) hide(chipRoot(cardLeaves[j], text));
    }
  }

  function looksLikeNoise(rows) {
    for (var i = 0; i < rows.length; i++) {
      var text = (rows[i].innerText || rows[i].textContent || "").trim();
      if (SOLD_TEXT.test(text) || DISCOUNT_TEXT.test(text) || DELIVERY_TEXT.test(text)) {
        return true;
      }
    }
    return false;
  }

  // Climb out of the text node to the chip itself (its padding and border),
  // stopping before anything that holds more than the chip.
  function chipRoot(el, text) {
    var node = el;
    while (
      node.parentElement &&
      (node.parentElement.textContent || "").trim() === text
    ) {
      node = node.parentElement;
    }
    return node;
  }

  // ---- product page ----------------------------------------------------
  function hideBuyButtons() {
    var buttons = document.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      if (btn.id === "spu-stash-btn") continue;
      if (BUY_TEXT.test((btn.textContent || "").trim())) hide(btn);
    }
  }

  // ---- apply / undo ----------------------------------------------------
  function apply() {
    styleSheet();
    hideKeywordRail();
    trimCards();
    hideBuyButtons();
  }

  function undo() {
    var style = document.getElementById(STYLE_ID);
    if (style) style.remove();
    var hidden = document.querySelectorAll("[" + HIDE_ATTR + "]");
    for (var i = 0; i < hidden.length; i++) hidden[i].removeAttribute(HIDE_ATTR);
    var trimmed = document.querySelectorAll("[data-spu-trimmed]");
    for (var j = 0; j < trimmed.length; j++) delete trimmed[j].dataset.spuTrimmed;
  }

  // Throttled, like the other passes: these pages mutate constantly.
  var GAP = 250;
  var queued = null;
  var lastRun = 0;
  function bump() {
    if (!on || queued) return;
    var wait = Math.max(0, GAP - (Date.now() - lastRun));
    queued = setTimeout(function () {
      queued = null;
      lastRun = Date.now();
      apply();
    }, wait);
  }

  var observer = new MutationObserver(bump);

  function setEnabled(enabled) {
    if (enabled === on) return;
    on = enabled;
    if (on) {
      apply();
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } else {
      observer.disconnect();
      undo();
    }
  }

  try {
    chrome.storage.sync.get({ recallEnabled: true }, function (r) {
      setEnabled(!r || r.recallEnabled !== false);
    });
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === "sync" && changes.recallEnabled) {
        setEnabled(changes.recallEnabled.newValue !== false);
      }
    });
  } catch (e) {}

  window.SPU_RECALL_DECLUTTER = { apply: apply, undo: undo };
})();
