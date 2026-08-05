/* SPU Annotation Helper - Recall stash sidebar
 *
 * Lists what has been stashed on the storefront. A row opens the product it
 * came from; the trash column drops it; the footer copies every output line
 * (newline separated) or clears everything, duplicate memory included.
 *
 * All mutations go through the service worker so its write queue stays the only
 * writer of the stash and the duplicate memory.
 */
(function () {
  "use strict";

  var listEl = document.getElementById("list");
  var emptyEl = document.getElementById("empty");
  var exportEl = document.getElementById("export");
  var removeAllEl = document.getElementById("removeAll");
  var entries = [];
  var lastCount = 0;

  function send(msg, cb) {
    try {
      chrome.runtime.sendMessage(msg, function (res) {
        void chrome.runtime.lastError; // nothing listening is not worth a throw
        cb && cb(res);
      });
    } catch (e) {
      cb && cb(null);
    }
  }

  function render() {
    listEl.innerHTML = "";
    if (!entries.length) {
      listEl.appendChild(emptyEl);
    } else {
      entries.forEach(function (entry) {
        listEl.appendChild(cardFor(entry));
      });
    }
    exportEl.textContent = "Export to clipboard(" + entries.length + ")";
    exportEl.disabled = !entries.length;
    // New entries land at the bottom, so follow them down.
    if (entries.length > lastCount) scrollToNewest();
    lastCount = entries.length;
  }

  function scrollToNewest() {
    var newest = listEl.lastElementChild;
    if (!newest || !newest.scrollIntoView) {
      listEl.scrollTop = listEl.scrollHeight;
      return;
    }
    try {
      newest.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (e) {
      listEl.scrollTop = listEl.scrollHeight;
    }
  }

  function cardFor(entry) {
    var card = document.createElement("div");
    card.className = "card";

    var del = document.createElement("button");
    del.type = "button";
    del.className = "card-del";
    del.textContent = "🗑";
    del.title = "Remove from the list";
    del.addEventListener("click", function () {
      send({ action: "stash_remove", modelId: entry.modelId });
    });

    // Everything but the trash column opens the product page - the url is the
    // last field of the output line.
    var body = document.createElement("button");
    body.type = "button";
    body.className = "card-body";
    body.title = entry.title || entry.text || entry.url;

    var title = document.createElement("span");
    title.className = "card-title";
    title.textContent = entry.title || entry.url;

    var variation = document.createElement("span");
    variation.className = "card-variation";
    variation.textContent = entry.variation || entry.name || "";
    variation.title = variation.textContent;

    body.appendChild(title);
    body.appendChild(variation);
    body.addEventListener("click", function () {
      var url = urlFromText(entry.text) || entry.url;
      if (url) chrome.tabs.create({ url: url });
    });

    card.appendChild(del);
    card.appendChild(body);
    return card;
  }

  // "<modelid>#|#<name>#|#<url>" -> the url.
  function urlFromText(text) {
    if (!text) return "";
    var parts = String(text).split("#|#");
    return parts.length ? parts[parts.length - 1].trim() : "";
  }

  function outputText() {
    return entries
      .map(function (e) { return e.text; })
      .filter(Boolean)
      .join("\n");
  }

  function flash(btn, label, restore) {
    btn.textContent = label;
    setTimeout(function () { btn.textContent = restore; }, 1200);
  }

  exportEl.addEventListener("click", function () {
    if (!entries.length) return;
    var text = outputText();
    var restore = "Export to clipboard(" + entries.length + ")";
    var done = function () { flash(exportEl, "Copied ✓", restore); };
    var failed = function () { flash(exportEl, "Copy failed", restore); };
    try {
      navigator.clipboard.writeText(text).then(done, function () {
        if (!legacyCopy(text)) failed();
        else done();
      });
    } catch (e) {
      if (legacyCopy(text)) done();
      else failed();
    }
  });

  // Fallback for when the async clipboard is unavailable in this context.
  function legacyCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:0;";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  // Also clears the visited/stashed memory behind the duplicate highlighting -
  // this replaced the old keyboard shortcut. Confirmed by clicking twice rather
  // than with a dialog, which a side panel may never show.
  var armed = false;
  var armedTimer = null;
  function disarm() {
    armed = false;
    clearTimeout(armedTimer);
    removeAllEl.textContent = "Remove all";
  }
  removeAllEl.addEventListener("click", function () {
    if (!armed) {
      armed = true;
      removeAllEl.textContent = "Sure? Click again";
      clearTimeout(armedTimer);
      armedTimer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    send({ action: "stash_clear" });
  });

  function load() {
    chrome.storage.local.get({ recall_stash: [] }, function (r) {
      entries = (r && r.recall_stash) || [];
      render();
    });
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === "local" && changes.recall_stash) {
      entries = changes.recall_stash.newValue || [];
      render();
    }
  });

  load();
})();
