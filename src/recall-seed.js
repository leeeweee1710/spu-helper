/* SPU Annotation Helper - remember the Recall seed (ISOLATED, SPU portal)
 *
 * The Recall task hands the annotator one "seed" product to go and find on the
 * storefront. Which product that is only exists in the portal, so it is picked
 * up here and stored for the Shopee-side scripts to mark in search results
 * (see src/recall-duplicates.js).
 *
 * Identity comes from the "Open in Shopee" link - /product/<shopid>/<itemid> -
 * which is the same shop/item pair the search results key off, so matching is
 * exact. Title and shop name are kept too, both as a label for the marker and
 * as a fallback for a task that ships without a link.
 *
 * The portal renders inside an open shadow root, and mutations in there do NOT
 * reach an observer on the light DOM - so, exactly like the Pair side does, the
 * observer is attached INSIDE the shadow root and backed up by a poll.
 */
(function () {
  "use strict";

  var RECALL_PATH = "/annotation/task/recall";
  var LABELS = { title: "Title:", shop: "Shop Name:", model: "Model Name:" };
  var POLL_MS = 700;

  function isRecallPage() {
    return location.pathname.indexOf(RECALL_PATH) !== -1;
  }

  // Resolve (and re-resolve) the portal's shadow root. Null until it mounts -
  // never cache `document`, or the seed would be read from the wrong tree.
  var _root = null;
  function getRoot() {
    if (_root && _root.host && _root.host.isConnected) return _root;
    _root = null;
    var known = document.querySelector("div.shadow-root-container-dom");
    if (known && known.shadowRoot) return (_root = known.shadowRoot);
    var all = document.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var sr = all[i].shadowRoot;
      if (sr && sr.querySelector('a[href*="shopee.tw"]')) return (_root = sr);
    }
    return null;
  }

  // Cheap "has anything changed" probe, so the full field scan only runs when
  // the portal actually moved to another product.
  function signature(root) {
    var link = root.querySelector('a[href*="shopee.tw"]');
    return location.href + "|" + (link ? link.href : "");
  }

  // Fields read as "<label>:" followed by the value in the next element.
  function labelValue(root, label) {
    var all = root.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.children.length !== 0) continue;
      if ((el.textContent || "").trim() !== label) continue;
      var value = el.nextElementSibling;
      if (value) return (value.textContent || "").replace(/\s+/g, " ").trim();
    }
    return "";
  }

  // Self-contained on purpose: relying on getProductKey() from a sibling file
  // means one load-order or injection slip turns every pass into a silent
  // ReferenceError, and the seed would just never appear.
  var KEY_PATTERNS = [/(?:^|[/\-])i\.(\d+)\.(\d+)/, /\/product\/(\d+)\/(\d+)/];
  function productKey(rawUrl) {
    if (!rawUrl) return null;
    var path;
    try {
      var parsed = new URL(rawUrl);
      if (!/(^|\.)shopee\./.test(parsed.hostname)) return null;
      path = parsed.pathname;
      try { path = decodeURIComponent(path); } catch (e) {}
    } catch (e) {
      return null;
    }
    for (var i = 0; i < KEY_PATTERNS.length; i++) {
      var m = path.match(KEY_PATTERNS[i]);
      if (m) return m[1] + "." + m[2];
    }
    return null;
  }

  function seedFromPage(root) {
    var key = null;
    var links = root.querySelectorAll('a[href*="shopee.tw"]');
    for (var i = 0; i < links.length && !key; i++) {
      key = productKey(links[i].href); // /you_may_also_like/... yields null
    }
    var title = labelValue(root, LABELS.title);
    var shop = labelValue(root, LABELS.shop);
    if (!key && !title) return null; // seed panel not rendered yet
    return { key: key || "", title: title, shop: shop, model: labelValue(root, LABELS.model) };
  }

  function sameSeed(a, b) {
    if (!a || !b) return false;
    return a.key === b.key && a.title === b.title && a.shop === b.shop && a.model === b.model;
  }

  var lastSig = "";
  var lastStored = null;

  // Mirrored onto <html> so the seed the extension is actually working with can
  // be seen from the page itself - a content script's storage is otherwise
  // invisible from anywhere but the extension.
  function footprint(state, seed) {
    try {
      var el = document.documentElement;
      el.setAttribute("data-spu-seed", state);
      if (seed) {
        el.setAttribute("data-spu-seed-key", seed.key || "");
        el.setAttribute("data-spu-seed-title", (seed.title || "").slice(0, 80));
      }
    } catch (e) {}
  }

  function check() {
    if (!isRecallPage()) return;
    try {
      var root = getRoot();
      if (!root) { footprint("no-root"); return; }
      var sig = signature(root);
      // A settled seed at a signature we have already handled: nothing to do.
      if (sig === lastSig && lastStored && lastStored.title) return;
      var seed = seedFromPage(root);
      if (!seed) { footprint("rendering"); return; }
      // Only treat the signature as handled once the panel is fully there.
      if (seed.title) lastSig = sig;
      if (sameSeed(seed, lastStored)) return;
      lastStored = seed;
      seed.at = Date.now();
      chrome.storage.local.set({ recall_seed: seed }, function () {
        var err = chrome.runtime.lastError;
        footprint(err ? "write-failed: " + err.message : "stored", seed);
      });
    } catch (e) {
      // Never let one bad frame kill the loop - and say so out loud.
      footprint("error: " + (e && e.message ? e.message : String(e)));
    }
  }

  // Throttled: the portal mutates continuously while it renders.
  var GAP = 300;
  var queued = null;
  var lastRun = 0;
  function bump() {
    if (queued) return;
    var wait = Math.max(0, GAP - (Date.now() - lastRun));
    queued = setTimeout(function () {
      queued = null;
      lastRun = Date.now();
      check();
    }, wait);
  }

  // Watch inside the shadow root, re-attaching if the portal swaps it out.
  var observer = null;
  var observed = null;
  function ensureObserver() {
    var root = getRoot();
    if (!root || observed === root) return;
    if (observer) observer.disconnect();
    observed = root;
    observer = new MutationObserver(bump);
    observer.observe(root, { childList: true, subtree: true });
    bump();
  }

  window.addEventListener("popstate", bump);
  setInterval(function () {
    ensureObserver();
    bump();
  }, POLL_MS);
  ensureObserver();
  bump();
})();
