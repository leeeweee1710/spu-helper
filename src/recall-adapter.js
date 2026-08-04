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
  // Anything inside the product page's React tree can reach the item prop by
  // walking up the fiber. Variation buttons are absent when there is nothing to
  // pick, so the title and the buy-button row are the anchors that always
  // exist. (#main is the React *container* - its ancestors hold nothing.)
  var ITEM_ANCHORS =
    ".selection-box-selected, .selection-box-unselected, h1, .high-end-button-group button";

  function findItem() {
    var anchors = document.querySelectorAll(ITEM_ANCHORS);
    for (var i = 0; i < anchors.length && i < 30; i++) {
      var item = itemFromNode(anchors[i]);
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
    var out = [];
    for (var i = 0; i < tiers.length; i++) {
      var opts = tiers[i].options || [];
      var idx = -1;
      for (var j = 0; j < chosen.length && idx === -1; j++) {
        idx = opts.indexOf(chosen[j]);
      }
      // A tier with a single option has no picker to click - Shopee hides it -
      // so there is nothing for the annotator to choose and it counts as set.
      if (idx === -1 && opts.length === 1) idx = 0;
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

  // "數量: 2盒", or "顏色: 紅色, 尺寸: L" when there are several tiers.
  function variationLabel(item, picked) {
    var tiers = item.tier_variations || [];
    return picked
      .map(function (idx, t) {
        return (tiers[t].name || "") + ": " + ((tiers[t].options || [])[idx] || "");
      })
      .join(", ");
  }

  // The model behind the current selection: matched on tier_index, falling back
  // to the model name ("2盒", or "紅色,L" when there are several tiers).
  function selectedModel(item, picked) {
    var models = item.models || [];
    if (!models.length) return null;
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
  // { ok, text, modelId, name, url, title, variation, key } - `text` is the
  // line to report; the rest is what the stash list shows.
  function selection() {
    var item = findItem();
    if (!item) return { ok: false, reason: "no-item" };
    var picked = pickedTierIndex(item);
    var model = selectedModel(item, picked);
    if (!model) {
      // Every tier has to be chosen before Shopee knows which model it is.
      return { ok: false, reason: "no-selection", url: productUrl(item) };
    }
    var id = model.modelid != null ? model.modelid : model.model_id;
    var name = (model.name || "").trim();
    var url = productUrl(item);
    return {
      ok: true,
      modelId: String(id),
      name: name,
      url: url,
      title: (item.title || "").trim(),
      variation: variationLabel(item, picked || []),
      key: item.shop_id + "." + item.item_id,
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
