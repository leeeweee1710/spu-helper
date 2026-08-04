/* SPU Annotation Helper - Recall task adapter (MAIN world, shopee.tw storefront)
 *
 * The Recall task sends annotators to a storefront product page to find the
 * matching product. What has to be reported back is
 *
 *   <model id>#|#<variation name>#|#<canonical product url>
 *
 * e.g. 59670259841#|#2盒#|#https://shopee.tw/p-i.189221612.6103161024
 *
 * Everything needed for that is in the PDP's React state: the `item` prop
 * carries item_id / shop_id / models[] / tier_variations[]. It lives on the
 * page's own fiber, which an isolated content script cannot read - hence this
 * runs in the MAIN world, like page-adapter.js does for the SPU portal.
 */
(function () {
  "use strict";

  var MSG = "__spu_helper__";
  var SEP = "#|#";
  var SELECTED = ".selection-box-selected"; // variation button, once picked

  // ---- item data --------------------------------------------------------
  // Walk up the fiber from any variation button (or the page root) until a
  // component prop holds the item.
  function findItem() {
    var starts = Array.prototype.slice
      .call(document.querySelectorAll(SELECTED + ", .selection-box-unselected"))
      .concat([document.querySelector("#main"), document.body]);
    for (var i = 0; i < starts.length; i++) {
      var item = itemFromNode(starts[i]);
      if (item) return item;
    }
    return null;
  }

  function itemFromNode(node) {
    while (node) {
      var fk = null;
      for (var k in node) {
        if (k.indexOf("__reactFiber$") === 0) { fk = k; break; }
      }
      if (fk) {
        var f = node[fk], guard = 40;
        while (f && guard-- > 0) {
          var p = f.memoizedProps;
          if (p && p.item && p.item.item_id && p.item.shop_id) return p.item;
          f = f.return;
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  // ---- selection --------------------------------------------------------
  // Which option is picked in each tier, as option indices. Returns null while
  // any tier is still unchosen (Shopee only knows the model once all are set).
  function pickedTierIndex(item) {
    var tiers = item.tier_variations || [];
    if (!tiers.length) return [];
    var chosen = Array.prototype.slice
      .call(document.querySelectorAll(SELECTED))
      .map(function (b) { return (b.textContent || "").trim(); });
    if (!chosen.length) return null;
    var out = [];
    for (var i = 0; i < tiers.length; i++) {
      var opts = tiers[i].options || [];
      var idx = -1;
      for (var j = 0; j < chosen.length && idx === -1; j++) {
        idx = opts.indexOf(chosen[j]);
      }
      if (idx === -1) return null; // this tier hasn't been picked yet
      out.push(idx);
    }
    return out;
  }

  function sameIndex(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (Number(a[i]) !== Number(b[i])) return false;
    return true;
  }

  // The model behind the current selection: matched on tier_index, falling back
  // to the model name ("2盒", or "紅色,L" when there are several tiers).
  function selectedModel(item) {
    var models = item.models || [];
    if (!models.length) return null;
    var picked = pickedTierIndex(item);
    if (picked === null) return null;
    if (!picked.length && models.length === 1) return models[0]; // no variations
    var i;
    for (i = 0; i < models.length; i++) {
      var ti = models[i].extinfo && models[i].extinfo.tier_index;
      if (sameIndex(ti, picked)) return models[i];
    }
    var tiers = item.tier_variations || [];
    var wanted = picked
      .map(function (idx, t) { return (tiers[t].options || [])[idx]; })
      .join(",");
    for (i = 0; i < models.length; i++) {
      if ((models[i].name || "").trim() === wanted) return models[i];
    }
    return null;
  }

  // https://shopee.tw/p-i.<shop id>.<item id> - the canonical short form, so
  // the reported url doesn't carry the title slug or tracking params.
  function productUrl(item) {
    return "https://" + location.host + "/p-i." + item.shop_id + "." + item.item_id;
  }

  // ---- public shape -----------------------------------------------------
  // { ok, text, modelId, name, url } - `text` is the line to report.
  function selection() {
    var item = findItem();
    if (!item) return { ok: false, reason: "no-item" };
    var model = selectedModel(item);
    if (!model) return { ok: false, reason: "no-selection", url: productUrl(item) };
    var id = model.modelid != null ? model.modelid : model.model_id;
    var name = (model.name || "").trim();
    var url = productUrl(item);
    return {
      ok: true,
      modelId: String(id),
      name: name,
      url: url,
      text: String(id) + SEP + name + SEP + url,
    };
  }

  function selectionText() {
    var s = selection();
    return s.ok ? s.text : "";
  }

  window.SPU_RECALL = { selection: selection, text: selectionText };

  // Same bridge the SPU portal adapter uses, so the (later) isolated-world
  // Recall UI can ask for the selection without touching the page's fiber.
  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__ch !== MSG || d.dir !== "req") return;
    if (d.action !== "recallSelection") return;
    window.postMessage(
      { __ch: MSG, dir: "res", id: d.id, result: selection() },
      "*"
    );
  });
})();
