/* SPU Annotation Helper - service worker
 *
 * Two jobs:
 *  - "product_memory" ({ "<shopid>.<itemid>": "checked" | "stashed" }) drives the
 *    duplicate highlighting in Shopee search results.
 *  - "recall_stash" (array of stash entries) backs the Recall sidebar.
 * Both live in chrome.storage.local, and every write goes through one queue so
 * events that fire back-to-back cannot clobber each other.
 */

importScripts("/src/product-key.js");

var writeQueue = Promise.resolve();

// mutate(state) gets both stores and returns true when something changed.
function updateStores(mutate) {
  writeQueue = writeQueue
    .then(function () {
      return chrome.storage.local.get({ product_memory: {}, recall_stash: [] });
    })
    .then(function (stored) {
      var state = {
        product_memory: stored.product_memory || {},
        recall_stash: stored.recall_stash || [],
      };
      if (!mutate(state)) return null;
      return chrome.storage.local.set(state);
    })
    .catch(function () {});
  return writeQueue;
}

// ---- duplicate memory ---------------------------------------------------
function markChecked(url) {
  var key = getProductKey(url);
  if (!key) return;
  updateStores(function (state) {
    if (state.product_memory[key]) return false; // never downgrade "stashed"
    state.product_memory[key] = "checked";
    return true;
  });
}

// Shopee routes client-side, so "status: complete" alone misses every product
// page reached by clicking inside the site - those only report a changeInfo.url
// from the pushState.
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (!changeInfo.url && changeInfo.status !== "complete") return;
  markChecked(changeInfo.url || (tab && tab.url));
});

// ---- stash --------------------------------------------------------------
function stashAdd(entry) {
  if (!entry || !entry.modelId) return;
  updateStores(function (state) {
    var list = state.recall_stash;
    for (var i = 0; i < list.length; i++) {
      if (list[i].modelId === entry.modelId) return false; // already stashed
    }
    entry.at = Date.now();
    list.push(entry);
    // Stashing is the strongest signal about a product, so it outranks the
    // "checked" the visit already wrote.
    if (entry.key) state.product_memory[entry.key] = "stashed";
    return true;
  });
}

function stashRemove(modelId) {
  updateStores(function (state) {
    var list = state.recall_stash;
    var kept = list.filter(function (e) { return e.modelId !== modelId; });
    if (kept.length === list.length) return false;
    var gone = list.filter(function (e) { return e.modelId === modelId; });
    state.recall_stash = kept;
    // The product was still visited, so drop it back to "checked" unless
    // another stashed variation of the same item is still on the list.
    gone.forEach(function (e) {
      if (!e.key) return;
      var stillStashed = kept.some(function (k) { return k.key === e.key; });
      if (!stillStashed && state.product_memory[e.key] === "stashed") {
        state.product_memory[e.key] = "checked";
      }
    });
    return true;
  });
}

// "Remove all" empties the stash AND the duplicate memory (this replaced the
// old clear-memory keyboard shortcut).
function stashClear() {
  updateStores(function (state) {
    state.recall_stash = [];
    state.product_memory = {};
    return true;
  }).then(function () {
    chrome.tabs.query({}, function (tabs) {
      tabs.forEach(function (tab) {
        try {
          var p = chrome.tabs.sendMessage(tab.id, { action: "clear_ui" });
          if (p && p.catch) p.catch(function () {});
        } catch (e) {}
      });
    });
  });
}

chrome.runtime.onMessage.addListener(function (request, sender, respond) {
  if (!request) return;
  var url = request.url || (sender && sender.tab && sender.tab.url);
  if (request.action === "mark_as_checked") markChecked(url);
  else if (request.action === "stash_add") stashAdd(request.entry);
  else if (request.action === "stash_remove") stashRemove(request.modelId);
  else if (request.action === "stash_clear") stashClear();
  else if (request.action === "close_tab") closeTab(sender);
  else return;
  respond && respond({ ok: true });
});

// A page cannot close its own tab, so the stash button asks us to. The current
// product goes with it - nothing is being viewed once the tab is gone.
function closeTab(sender) {
  var tabId = sender && sender.tab && sender.tab.id;
  if (tabId == null) return;
  try {
    chrome.storage.local.set({ recall_current: null });
  } catch (e) {}
  try {
    chrome.tabs.remove(tabId);
  } catch (e) {}
}
