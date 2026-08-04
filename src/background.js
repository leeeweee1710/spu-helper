/* SPU Annotation Helper - service worker
 *
 * Remembers which Shopee products have been opened, so the Recall duplicate
 * highlighting (src/recall-duplicates.js) can mark them in search results.
 * Memory lives in chrome.storage.local under "product_memory" as
 * { "<shopid>.<itemid>": "checked" | "stashed" }.
 */

importScripts("/src/product-key.js");

// All writes go through one promise chain. Marking is triggered by tab events
// that can fire back-to-back, and a bare get()/set() pair would let the second
// write clobber the first one's entry.
var writeQueue = Promise.resolve();

function updateMemory(mutate) {
  writeQueue = writeQueue
    .then(function () {
      return chrome.storage.local.get("product_memory");
    })
    .then(function (stored) {
      var memory = (stored && stored.product_memory) || {};
      if (!mutate(memory)) return null;
      return chrome.storage.local.set({ product_memory: memory });
    })
    .catch(function () {});
  return writeQueue;
}

function markChecked(url) {
  var key = getProductKey(url);
  if (!key) return;
  updateMemory(function (memory) {
    if (memory[key]) return false; // already known - never downgrade "stashed"
    memory[key] = "checked";
    return true;
  });
}

// Kept for our own stash detection, which lands later; nothing sends this yet.
function markStashed(url) {
  var key = getProductKey(url);
  if (!key) return;
  updateMemory(function (memory) {
    if (memory[key] === "stashed") return false;
    memory[key] = "stashed";
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

// The content script reports its own location too: it sees same-document
// navigations directly, covering anything the tab events miss.
chrome.runtime.onMessage.addListener(function (request, sender) {
  if (!request) return;
  var url = request.url || (sender && sender.tab && sender.tab.url);
  if (request.action === "mark_as_checked") markChecked(url);
  else if (request.action === "mark_as_stashed") markStashed(url);
});

// Alt+Shift+X - forget everything and clear the marks in every open tab.
chrome.commands.onCommand.addListener(function (command) {
  if (command !== "clear-memory") return;
  updateMemory(function (memory) {
    Object.keys(memory).forEach(function (key) {
      delete memory[key];
    });
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
});
