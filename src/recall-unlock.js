/* SPU Annotation Helper - unlock sold-out variations (MAIN world, shopee.tw)
 *
 * A Recall annotator still has to report a sold-out variation, but Shopee makes
 * that impossible from the page: each model in the PDP response carries
 * is_clickable:false / is_grayout:true / has_stock:false, and the option button
 * is then rendered with `onClick = function ex(){}` - a no-op. No amount of
 * clicking, class juggling or re-enabling the button can select it, which is
 * why the selection never became visible.
 *
 * So the flags are flipped in the API response before React ever sees them: the
 * option then renders as an ordinary one and selecting it works natively -
 * highlight, model image and price all follow. Which models were really sold out
 * is remembered on window.SPU_RECALL_SOLD_OUT so the greyed-out look can be
 * replaced with our own marker (see src/recall-stash.js).
 *
 * Runs at document_start so the hooks are in place before the PDP request.
 */
(function () {
  "use strict";

  var PDP_RE = /\/api\/v\d+\/pdp\//;
  var soldOut = {};
  window.SPU_RECALL_SOLD_OUT = soldOut; // "<modelid>" -> true

  function isModel(o) {
    return (
      o &&
      typeof o === "object" &&
      !Array.isArray(o) &&
      ("is_clickable" in o || "is_grayout" in o || "has_stock" in o) &&
      ("model_id" in o || "modelid" in o)
    );
  }

  // Walk the whole payload (models live several levels down and the shape moves
  // between endpoints) and flip every sold-out model to a normal one.
  function unlock(root) {
    var changed = false, stack = [root], guard = 60000;
    while (stack.length && guard-- > 0) {
      var node = stack.pop();
      if (!node || typeof node !== "object") continue;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) {
          if (node[i] && typeof node[i] === "object") stack.push(node[i]);
        }
        continue;
      }
      if (isModel(node)) {
        if (node.has_stock === false || node.is_clickable === false || node.is_grayout === true) {
          soldOut[String(node.model_id != null ? node.model_id : node.modelid)] = true;
        }
        if (node.is_clickable === false) { node.is_clickable = true; changed = true; }
        if (node.is_grayout === true) { node.is_grayout = false; changed = true; }
        if (node.has_stock === false) { node.has_stock = true; changed = true; }
      }
      for (var k in node) {
        var v = node[k];
        if (v && typeof v === "object") stack.push(v);
      }
    }
    return changed;
  }

  // Returns the rewritten body, or null when there is nothing to do.
  function patch(text) {
    if (!text || text.indexOf("is_grayout") === -1) return null;
    var data;
    try { data = JSON.parse(text); } catch (e) { return null; }
    if (!unlock(data)) return null;
    try { return JSON.stringify(data); } catch (e) { return null; }
  }

  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var pending = origFetch.apply(this, arguments);
      if (!PDP_RE.test(url)) return pending;
      return pending.then(function (res) {
        if (!res || !res.ok) return res;
        return res
          .clone()
          .text()
          .then(function (body) {
            var out = patch(body);
            if (out === null) return res;
            return new Response(out, {
              status: res.status,
              statusText: res.statusText,
              headers: res.headers,
            });
          })
          .catch(function () { return res; });
      });
    };
  }

  // Same for XHR: our readystatechange listener is registered inside open(), so
  // it runs before the handlers the page attaches afterwards, and the patched
  // body shadows the prototype getters.
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (PDP_RE.test(String(url || ""))) {
      var xhr = this;
      xhr.addEventListener("readystatechange", function () {
        if (xhr.readyState !== 4 || xhr.__spuPatched) return;
        xhr.__spuPatched = 1;
        var body = null;
        try { body = xhr.responseText; } catch (e) { return; }
        var out = patch(body);
        if (out === null) return;
        try {
          Object.defineProperty(xhr, "responseText", {
            get: function () { return out; },
            configurable: true,
          });
          Object.defineProperty(xhr, "response", {
            get: function () { return out; },
            configurable: true,
          });
        } catch (e) {}
      });
    }
    return origOpen.apply(this, arguments);
  };
})();
