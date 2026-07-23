/* SPU Annotation Helper - popup settings */

var DEFAULTS = {
  enabled: true,
  autoKeyY: true,
  smartHints: true,
  smartHintsMinLen: 3,
  keybindings: {
    next: ["w", "i"],
    prev: ["s", "k"],
    optionUp: ["a", "j"],
    optionDown: ["d", "l"],
    submitNext: ["\\"],
    enlarge: [" "],
    scrollDown: ["n", "c"],
    gotoFirst: ["Home"],
    gotoLast: ["End"],
  },
};

var ACTIONS = [
  "next", "prev", "optionUp", "optionDown",
  "submitNext", "enlarge", "scrollDown", "gotoFirst", "gotoLast",
];

var current = JSON.parse(JSON.stringify(DEFAULTS));
var listeningAction = null; // which action is waiting for a keypress

var els = {
  enabled: document.getElementById("enabled"),
  autoKeyY: document.getElementById("autoKeyY"),
  smartHints: document.getElementById("smartHints"),
  smartHintsMinLen: document.getElementById("smartHintsMinLen"),
  status: document.getElementById("status"),
};

// ---- helpers ----------------------------------------------------------
// Save immediately on any change and briefly flash "Saved".
function persist() {
  chrome.storage.sync.set(current, function () {
    if (!els.status) return;
    els.status.textContent = "Saved";
    clearTimeout(persist._t);
    persist._t = setTimeout(function () { els.status.textContent = ""; }, 900);
  });
}

function displayKey(k) {
  if (!k) return "";
  if (k === " ") return "Space";
  return k.length === 1 ? k.toUpperCase() : k;
}

// Accept the legacy single-string form and always return an array.
function asList(v) {
  if (!v) return [];
  return Array.isArray(v) ? v.slice() : [v];
}

// Remove a key from every action (a key maps to one action only).
function removeKeyEverywhere(k) {
  ACTIONS.forEach(function (a) {
    current.keybindings[a] = asList(current.keybindings[a]).filter(function (x) {
      return x !== k;
    });
  });
}

// ---- render -----------------------------------------------------------
function render() {
  els.enabled.checked = !!current.enabled;
  els.autoKeyY.checked = !!current.autoKeyY;
  els.smartHints.checked = !!current.smartHints;
  els.smartHintsMinLen.value = current.smartHintsMinLen;
  renderKeys();
}

function renderKeys() {
  ACTIONS.forEach(function (action) {
    var box = document.getElementById("keys-" + action);
    box.innerHTML = "";
    asList(current.keybindings[action]).forEach(function (k) {
      var chip = document.createElement("span");
      chip.className = "kb-chip";
      chip.textContent = displayKey(k);
      var x = document.createElement("button");
      x.type = "button";
      x.className = "kb-x";
      x.textContent = "×";
      x.title = "Remove";
      x.addEventListener("click", function () {
        current.keybindings[action] = asList(current.keybindings[action]).filter(function (y) {
          return y !== k;
        });
        renderKeys();
        persist();
      });
      chip.appendChild(x);
      box.appendChild(chip);
    });

    var add = document.createElement("button");
    add.type = "button";
    add.className = "kb-add" + (listeningAction === action ? " listening" : "");
    add.textContent = listeningAction === action ? "Press a key…" : "+ key";
    add.addEventListener("click", function () {
      listeningAction = listeningAction === action ? null : action;
      renderKeys();
    });
    box.appendChild(add);
  });
}

// Capture the next keypress when an "+ key" button is armed.
document.addEventListener("keydown", function (e) {
  if (!listeningAction) return;
  e.preventDefault();
  if (e.key === "Escape") {
    listeningAction = null;
    renderKeys();
    return;
  }
  if (e.key === "Tab") return;
  var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  removeKeyEverywhere(k); // one key -> one action
  var list = asList(current.keybindings[listeningAction]);
  if (list.indexOf(k) === -1) list.push(k);
  current.keybindings[listeningAction] = list;
  listeningAction = null;
  renderKeys();
  persist();
});

// ---- persistence ------------------------------------------------------
function load() {
  chrome.storage.sync.get(DEFAULTS, function (stored) {
    current = Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), stored || {});
    var kb = (stored && stored.keybindings) || {};
    current.keybindings = {};
    ACTIONS.forEach(function (a) {
      current.keybindings[a] = asList(
        kb[a] !== undefined ? kb[a] : DEFAULTS.keybindings[a]
      );
    });
    render();
  });
}

els.enabled.addEventListener("change", function () {
  current.enabled = els.enabled.checked;
  persist();
});
els.autoKeyY.addEventListener("change", function () {
  current.autoKeyY = els.autoKeyY.checked;
  persist();
});
els.smartHints.addEventListener("change", function () {
  current.smartHints = els.smartHints.checked;
  persist();
});
els.smartHintsMinLen.addEventListener("change", function () {
  var v = parseInt(els.smartHintsMinLen.value, 10);
  if (isNaN(v) || v < 2) v = 2;
  if (v > 20) v = 20;
  current.smartHintsMinLen = v;
  els.smartHintsMinLen.value = v;
  persist();
});

document.getElementById("reset").addEventListener("click", function () {
  current = JSON.parse(JSON.stringify(DEFAULTS));
  listeningAction = null;
  render();
  persist();
});

// Forget the remembered website splitter sizes (applies immediately).
document.getElementById("resetLayout").addEventListener("click", function () {
  chrome.storage.sync.set({ layoutSizes: null }, function () {
    els.status.textContent = "Layout sizes reset.";
    setTimeout(function () {
      els.status.textContent = "";
    }, 1200);
  });
});

load();
