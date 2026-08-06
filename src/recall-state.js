/* SPU Annotation Helper - is a Recall task actually being worked on?
 * (ISOLATED, shopee.tw - loaded before the other storefront scripts)
 *
 * The storefront features exist to serve a Recall task, so simply opening
 * shopee.tw must not switch them on. They turn on when the portal is opened on
 * a Recall task and off again when it moves to a Pair task or the task list -
 * src/recall-seed.js maintains that flag - and the popup's Recall "Custom UI"
 * toggle still overrides everything.
 *
 * Deliberately no timeout on the flag: a portal tab that Edge puts to sleep in
 * the background would otherwise silently switch the tools off mid-task.
 */
(function () {
  "use strict";

  var MIRROR_KEY = "__spu_recall_active";
  var active = false;
  var listeners = [];

  // Mirrored into localStorage because src/recall-unlock.js runs in the MAIN
  // world at document_start, where chrome.storage does not exist and an async
  // read would come too late to patch the PDP response.
  function mirror(value) {
    try {
      if (value) localStorage.setItem(MIRROR_KEY, "1");
      else localStorage.removeItem(MIRROR_KEY);
    } catch (e) {}
  }

  function set(next) {
    if (next === active) return;
    active = next;
    mirror(next);
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](active); } catch (e) {}
    }
  }

  function load() {
    try {
      chrome.storage.sync.get({ recallEnabled: true }, function (settings) {
        chrome.storage.local.get({ recall_active: null }, function (stored) {
          var enabled = !settings || settings.recallEnabled !== false;
          var inTask = !!(stored && stored.recall_active);
          set(enabled && inTask);
        });
      });
    } catch (e) {}
  }

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if ((area === "sync" && changes.recallEnabled) || (area === "local" && changes.recall_active)) {
        load();
      }
    });
  } catch (e) {}

  // Starts false, so the tools stay out of the way until we know otherwise.
  window.SPU_RECALL_STATE = {
    isActive: function () { return active; },
    onChange: function (fn) {
      if (typeof fn === "function") listeners.push(fn);
    },
  };

  load();
})();
