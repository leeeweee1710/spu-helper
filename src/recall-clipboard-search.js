/* SPU Annotation Helper - search from the clipboard (ISOLATED, shopee.tw)
 *
 * A Recall annotator copies the seed's title out of the portal and searches for
 * it. This puts a second button beside the storefront's search button that does
 * both steps in one click: read the clipboard, search for it.
 *
 * Navigating straight to /search?keyword=... rather than filling the input and
 * submitting: the input is React-controlled, and driving it is far more fragile
 * than the url the form would have produced anyway.
 */
(function () {
  "use strict";

  var BTN_ID = "spu-clipboard-search";
  var FORM = "form.shopee-searchbar";

  function searchButton() {
    var form = document.querySelector(FORM);
    if (!form) return null;
    var buttons = form.querySelectorAll("button");
    // The submit button is the last one in the bar (the first is the clear "x").
    for (var i = buttons.length - 1; i >= 0; i--) {
      if (buttons[i].id !== BTN_ID) return buttons[i];
    }
    return null;
  }

  function style(btn, state) {
    var background = state === "error" ? "#b3261e" : state === "busy" ? "#7a8794" : "#2673dd";
    btn.style.cssText =
      "display:inline-flex;align-items:center;justify-content:center;gap:4px;" +
      "height:34px;margin-left:6px;padding:0 10px;border:none;border-radius:2px;" +
      "background:" + background + ";color:#fff;font-size:13px;font-weight:600;" +
      "line-height:1;white-space:nowrap;cursor:pointer;flex:0 0 auto;";
  }

  function flash(btn, label, state) {
    btn.textContent = label;
    style(btn, state);
    clearTimeout(flash.timer);
    flash.timer = setTimeout(function () {
      btn.textContent = "📋 Paste & search";
      style(btn, "");
    }, 1500);
  }

  function runSearch(text) {
    var keyword = (text || "").replace(/\s+/g, " ").trim();
    if (!keyword) return false;
    location.href = "https://" + location.host + "/search?keyword=" + encodeURIComponent(keyword);
    return true;
  }

  // execCommand("paste") into a throwaway field, for when the async clipboard is
  // unavailable in this context.
  function legacyPaste() {
    var ta = document.createElement("textarea");
    ta.style.cssText = "position:fixed;left:-9999px;top:0;";
    document.body.appendChild(ta);
    ta.focus();
    var text = "";
    try {
      if (document.execCommand("paste")) text = ta.value;
    } catch (e) {}
    ta.remove();
    return text;
  }

  function pasteAndSearch(btn) {
    flash(btn, "Reading…", "busy");
    var done = function (text) {
      if (runSearch(text)) return;
      flash(btn, "Clipboard empty", "error");
    };
    try {
      navigator.clipboard.readText().then(done, function () {
        done(legacyPaste());
      });
    } catch (e) {
      done(legacyPaste());
    }
  }

  function ensureButton() {
    var search = searchButton();
    if (!search || !search.parentElement) return;
    var existing = document.getElementById(BTN_ID);
    if (existing && existing.parentElement === search.parentElement) return;
    if (existing) existing.remove();
    var btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.textContent = "📋 Paste & search";
    btn.title = "Search for whatever is on the clipboard";
    style(btn, "");
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      pasteAndSearch(btn);
    });
    search.parentElement.insertBefore(btn, search.nextSibling); // right of search
  }

  var GAP = 300;
  var queued = null;
  var lastRun = 0;
  function bump() {
    if (queued) return;
    var wait = Math.max(0, GAP - (Date.now() - lastRun));
    queued = setTimeout(function () {
      queued = null;
      lastRun = Date.now();
      ensureButton();
    }, wait);
  }

  var observer = new MutationObserver(bump);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  ensureButton();
})();
