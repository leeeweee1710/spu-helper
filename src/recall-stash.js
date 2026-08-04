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

  // "ready" (can stash), "done" (this model is already on the list) or "idle".
  var LOOKS = {
    ready: { border: "#1d8a3f", background: "#eaf7ee", color: "#12772f", cursor: "pointer" },
    done: { border: "#1d8a3f", background: "#1d8a3f", color: "#fff", cursor: "default" },
    idle: { border: "#c9ccd1", background: "#f4f5f6", color: "#9aa0a6", cursor: "not-allowed" },
  };

  function styleButton(btn, look) {
    var s = LOOKS[look] || LOOKS.idle;
    btn.style.cssText =
      "display:inline-flex;align-items:center;justify-content:center;gap:6px;" +
      "min-width:104px;height:48px;margin-right:10px;padding:0 16px;" +
      "border:1px solid " + s.border + ";border-radius:2px;" +
      "background:" + s.background + ";color:" + s.color + ";" +
      "font-size:14px;font-weight:600;line-height:1;white-space:nowrap;" +
      "cursor:" + s.cursor + ";";
  }

  // Model ids already on the stash list, so an annotator can see at a glance
  // that this variation has been reported. Kept in step with the sidebar.
  var stashed = {};
  function loadStashed(cb) {
    try {
      chrome.storage.local.get({ recall_stash: [] }, function (r) {
        stashed = {};
        ((r && r.recall_stash) || []).forEach(function (e) {
          if (e && e.modelId) stashed[String(e.modelId)] = true;
        });
        cb && cb();
      });
    } catch (e) {
      cb && cb();
    }
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
      var already = ok && !!stashed[String(sel.modelId)];
      btn.dataset.ready = ok && !already ? "1" : "";
      btn.dataset.modelId = ok ? String(sel.modelId) : "";
      btn.textContent = already ? "Stashed ✓" : ok ? "Stash" : "Pick a variation";
      btn.title = already
        ? sel.name + " is already on the Recall list"
        : ok
        ? "Stash " + sel.name + " for the Recall list"
        : "Choose every variation first";
      styleButton(btn, already ? "done" : ok ? "ready" : "idle");
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
          if (!chrome.runtime.lastError) stashed[String(sel.modelId)] = true;
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
    styleButton(btn, "idle");
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

  // ---- sold-out variations ---------------------------------------------
  // src/recall-unlock.js makes sold-out options selectable by flipping the
  // model flags in the PDP response, so Shopee renders (and highlights) them
  // like any other option. That also removes its greyed-out look, so mark them
  // ourselves - the annotator still needs to know the variation is sold out.
  var soldOutLabels = null; // null = not asked yet
  var soldOutFor = "";

  function markSoldOut() {
    if (soldOutFor !== location.href) {
      soldOutFor = location.href;
      soldOutLabels = null;
    }
    if (soldOutLabels === null) {
      soldOutLabels = []; // don't ask again while the answer is in flight
      askAdapter("soldOutOptions").then(function (res) {
        soldOutLabels = res && res.ok && res.labels ? res.labels : [];
        applySoldOutCue();
      });
      return;
    }
    applySoldOutCue();
  }

  function applySoldOutCue() {
    if (!soldOutLabels || !soldOutLabels.length) return;
    var btns = document.querySelectorAll(VARIATION_BTN);
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      if (btn.dataset.spuSoldOut) continue;
      var text = (btn.textContent || "").trim();
      for (var j = 0; j < soldOutLabels.length; j++) {
        if (text && text.indexOf(soldOutLabels[j]) !== -1) {
          btn.dataset.spuSoldOut = "1";
          btn.title = "缺貨 / out of stock - selectable for Recall";
          btn.style.outline = "1px dashed #ff4d4f";
          btn.style.outlineOffset = "-3px";
          break;
        }
      }
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
    markSoldOut();
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

  // Picking a variation should update the button without waiting for the next
  // mutation pass.
  document.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest(VARIATION_BTN) : null;
    if (!btn) { bump(); return; }
    setTimeout(function () {
      var stashBtn = document.getElementById(BTN_ID);
      if (stashBtn) refreshButtonState(stashBtn, true);
    }, 260);
  }, true);

  // Deleting from the sidebar (or another tab stashing) has to show up here.
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local" || !changes.recall_stash) return;
    loadStashed(function () {
      var btn = document.getElementById(BTN_ID);
      if (btn) refreshButtonState(btn, true);
    });
  });

  // The buy-button row renders after the first paint, so keep looking for a
  // while instead of waiting on a mutation that may never come.
  var tries = 0;
  var poll = setInterval(function () {
    pass();
    if (document.getElementById(BTN_ID) || ++tries > 60) clearInterval(poll);
  }, 250);

  // Know what is already stashed before the button is first drawn.
  loadStashed(pass);
})();
