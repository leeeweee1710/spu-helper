/* SPU Annotation Helper - stash button (ISOLATED world, shopee.tw)
 *
 * Puts a "Stash" button to the left of 加入購物車 on a product page. Stashing
 * records the selected model as one output line for the Recall sidebar
 * (sidebar.html) and marks the product as stashed for the duplicate
 * highlighting.
 *
 * The selection itself lives in the page's React state, which only the MAIN
 * world can read - so it is fetched from src/recall-adapter.js over the
 * __spu_helper__ bridge.
 */
(function () {
  "use strict";

  var MSG = "__spu_helper__";
  var BTN_ID = "spu-stash-btn";
  var CART_TEXT = /加入購物車/;
  var VARIATION_BTN = '[class*="selection-box-"]';
  var SEL_CLASS = "selection-box-selected";
  var UNSEL_CLASS = "selection-box-unselected";

  // ---- bridge to the MAIN-world adapter ---------------------------------
  var pending = {};
  var reqSeq = 0;

  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__ch !== MSG || d.dir !== "res") return;
    var cb = pending[d.id];
    if (cb) {
      delete pending[d.id];
      cb(d.result);
    }
  });

  function askAdapter(action) {
    return new Promise(function (resolve) {
      var id = ++reqSeq;
      pending[id] = resolve;
      window.postMessage({ __ch: MSG, dir: "req", id: id, action: action }, "*");
      setTimeout(function () {
        if (pending[id]) {
          delete pending[id];
          resolve({ ok: false, reason: "timeout" });
        }
      }, 1500);
    });
  }

  // ---- button -----------------------------------------------------------
  function cartButton() {
    var btns = document.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      if (CART_TEXT.test((btns[i].textContent || "").trim())) return btns[i];
    }
    return null;
  }

  function styleButton(btn, enabled) {
    btn.style.cssText =
      "display:inline-flex;align-items:center;justify-content:center;gap:6px;" +
      "min-width:104px;height:48px;margin-right:10px;padding:0 16px;" +
      "border:1px solid " + (enabled ? "#1d8a3f" : "#c9ccd1") + ";border-radius:2px;" +
      "background:" + (enabled ? "#eaf7ee" : "#f4f5f6") + ";" +
      "color:" + (enabled ? "#12772f" : "#9aa0a6") + ";" +
      "font-size:14px;font-weight:600;line-height:1;white-space:nowrap;" +
      "cursor:" + (enabled ? "pointer" : "not-allowed") + ";";
  }

  // What the page currently shows, so a busy page (lazy loading fires the
  // observer constantly) doesn't cost a bridge round-trip per mutation.
  function selectionSignature() {
    var chosen = document.querySelectorAll(".selection-box-selected");
    var sig = location.href;
    for (var i = 0; i < chosen.length; i++) sig += "|" + (chosen[i].textContent || "").trim();
    return sig;
  }

  // Only a full variation combination identifies a model, so the button stays
  // disabled until one is picked.
  function refreshButtonState(btn, force) {
    var sig = selectionSignature();
    if (!force && btn.dataset.sig === sig) return;
    btn.dataset.sig = sig;
    askAdapter("recallSelection").then(function (sel) {
      // A timed-out bridge call (the MAIN-world adapter may not be listening
      // yet) must not leave the signature cached, or nothing would retry.
      if (sel && sel.reason === "timeout") {
        btn.dataset.sig = "";
        return;
      }
      var ok = !!(sel && sel.ok);
      btn.dataset.ready = ok ? "1" : "";
      btn.textContent = ok ? "Stash" : "Pick a variation";
      btn.title = ok
        ? "Stash " + sel.name + " for the Recall list"
        : "Choose every variation first";
      styleButton(btn, ok);
    });
  }

  function stash(btn) {
    askAdapter("recallSelection").then(function (sel) {
      if (!sel || !sel.ok) {
        refreshButtonState(btn, true);
        return;
      }
      chrome.runtime.sendMessage(
        {
          action: "stash_add",
          entry: {
            modelId: sel.modelId,
            name: sel.name,
            url: sel.url,
            title: sel.title,
            variation: sel.variation,
            key: sel.key,
            text: sel.text,
          },
        },
        function () {
          flash(btn, chrome.runtime.lastError ? "Failed" : "Stashed ✓");
        }
      );
    });
  }

  function flash(btn, label) {
    btn.textContent = label;
    clearTimeout(flash.timer);
    flash.timer = setTimeout(function () { refreshButtonState(btn, true); }, 1200);
  }

  function ensureButton() {
    var cart = cartButton();
    if (!cart || !cart.parentElement) return;
    var existing = document.getElementById(BTN_ID);
    if (existing && existing.parentElement === cart.parentElement) {
      // Shopee re-renders on every variation click; keep the label in step.
      refreshButtonState(existing);
      return;
    }
    if (existing) existing.remove();
    var btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    styleButton(btn, false);
    btn.textContent = "Pick a variation";
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (!btn.dataset.ready) return;
      stash(btn);
    });
    cart.parentElement.insertBefore(btn, cart); // to the left of 加入購物車
    refreshButtonState(btn);
  }

  // ---- out-of-stock variations -----------------------------------------
  // A Recall annotator still has to report a sold-out variation, but Shopee
  // disables those buttons. Re-enable them, and if the click doesn't take
  // (React ignores a sold-out model) mark the choice ourselves - the selected
  // class is what identifies the model, which is all the stash needs.
  function variationButtons(root) {
    return (root || document).querySelectorAll(VARIATION_BTN);
  }

  function enableVariationButtons() {
    var btns = variationButtons();
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (b.disabled) b.disabled = false;
      if (b.getAttribute("aria-disabled") === "true") b.setAttribute("aria-disabled", "false");
      if (b.style.pointerEvents === "none") b.style.removeProperty("pointer-events");
      var computed = window.getComputedStyle(b);
      if (computed && computed.pointerEvents === "none") b.style.pointerEvents = "auto";
      if (computed && computed.cursor === "not-allowed") b.style.cursor = "pointer";
    }
  }

  // Options of the same tier sit side by side, so the clicked button's siblings
  // are the ones to clear.
  function forceSelect(btn) {
    var group = btn.parentElement;
    if (group) {
      var siblings = variationButtons(group);
      for (var i = 0; i < siblings.length; i++) {
        if (siblings[i] === btn || siblings[i].parentElement !== group) continue;
        siblings[i].classList.remove(SEL_CLASS);
        siblings[i].classList.add(UNSEL_CLASS);
        delete siblings[i].dataset.spuForced;
      }
    }
    btn.classList.remove(UNSEL_CLASS);
    btn.classList.add(SEL_CLASS);
    btn.dataset.spuForced = "1";
  }

  // React re-renders can strip the class back off, so put it back.
  function reapplyForced() {
    var forced = document.querySelectorAll("[data-spu-forced]");
    for (var i = 0; i < forced.length; i++) {
      if (!forced[i].classList.contains(SEL_CLASS)) forceSelect(forced[i]);
    }
  }

  // ---- keeping up with the page ----------------------------------------
  // Runs at most every GAP ms, and - unlike a debounce - always runs: a product
  // page mutates continuously (lazy images, carousels, chat widget), which used
  // to push a debounced pass back indefinitely and delay the button.
  var GAP = 200;
  var queued = null;
  var lastRun = 0;

  function pass() {
    enableVariationButtons();
    reapplyForced();
    ensureButton();
  }

  function bump() {
    if (queued) return;
    var wait = Math.max(0, GAP - (Date.now() - lastRun));
    queued = setTimeout(function () {
      queued = null;
      lastRun = Date.now();
      pass();
    }, wait);
  }

  var observer = new MutationObserver(bump);
  observer.observe(document.body, { childList: true, subtree: true });

  // A click on a variation may be ignored by the page (sold out) - take it over.
  document.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest(VARIATION_BTN) : null;
    if (!btn) { bump(); return; }
    setTimeout(function () {
      if (!btn.classList.contains(SEL_CLASS)) forceSelect(btn);
      var stashBtn = document.getElementById(BTN_ID);
      if (stashBtn) refreshButtonState(stashBtn, true);
    }, 220);
  }, true);

  // The buy-button row renders after the first paint, so keep looking for a
  // while instead of waiting on a mutation that may never come.
  var tries = 0;
  var poll = setInterval(function () {
    pass();
    if (document.getElementById(BTN_ID) || ++tries > 60) clearInterval(poll);
  }, 250);

  pass();
})();
