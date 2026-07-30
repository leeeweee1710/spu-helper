/*
 * SPU Annotation Helper - content script (ISOLATED world)
 * ------------------------------------------------------------------
 * - Builds the custom option overlay (right-docked panel).
 * - Remaps keys (default W/S = next/prev product, A/D = move option).
 * - Keeps focus on the native Tabulator table so its own key handling
 *   (arrow navigation, image-panel sync) keeps working.
 * - Auto-selects & keys-in "Y" when moving to an un-annotated product.
 * - Custom-definition textbox: keys are NOT remapped inside it; Enter
 *   commits the text (local_confirm = N + remarks), Escape cancels.
 *
 * Commit is delegated to page-adapter.js (MAIN world) which drives the
 * live Tabulator instance; a DOM-based fallback is used if that fails.
 */
(function () {
  "use strict";
  if (window.__spuContentLoaded) return;
  window.__spuContentLoaded = true;

  var MSG = "__spu_helper__";
  var PAIR_PATH = "/annotation/task/pair";

  // ---- option values (the live column stores STRING labels, e.g. "Y") ---
  var VAL = {
    Y: "Y",
    N: "N",
    WRONG_CATEGORY: "WRONG_CATEGORY",
    LIVE_SELLING: "LIVE_SELLING",
    DELISTED: "DELISTED",
    DASH: "-",
  };

  // ---- settings ---------------------------------------------------------
  var DEFAULTS = {
    enabled: true,
    autoKeyY: true,
    smartHints: true, // replace native hints with our exact-match highlighter
    smartHintsMinLen: 3, // shortest matched run to highlight
    layoutSizes: null, // remembered native splitter sizes { w, h }
    // Each action maps to a LIST of keys (any of them triggers it).
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
      nextImage: ["e", "o"],
    },
  };
  var settings = JSON.parse(JSON.stringify(DEFAULTS));

  // ---- runtime state ----------------------------------------------------
  var active = false; // are we on a pair page with UI mounted
  var options = []; // current option list model
  var selectedIndex = -1;
  var panelEl = null;
  var listEl = null;
  var customInput = null;
  var toastEl = null;
  var pending = {}; // adapter request callbacks
  var reqSeq = 0;

  // ======================================================================
  // Adapter bridge
  // ======================================================================
  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__ch !== MSG || d.dir !== "res") return;
    var cb = pending[d.id];
    if (cb) {
      delete pending[d.id];
      cb(d.result);
    }
  });

  function callAdapter(action, payload) {
    return new Promise(function (resolve) {
      var id = ++reqSeq;
      pending[id] = resolve;
      window.postMessage({ __ch: MSG, dir: "req", id: id, action: action, payload: payload }, "*");
      setTimeout(function () {
        if (pending[id]) {
          delete pending[id];
          resolve({ ok: false, reason: "timeout" });
        }
      }, 1500);
    });
  }

  // ======================================================================
  // DOM helpers for the Tabulator table
  // ======================================================================
  // The SPU app renders inside an (open) shadow root, so document.querySelector
  // cannot see the table. Resolve the shadow root and query inside it.
  var _root = null;
  function getRoot() {
    if (_root && _root.host && _root.host.isConnected) return _root;
    _root = null;
    var known = document.querySelector("div.shadow-root-container-dom");
    if (known && known.shadowRoot) return (_root = known.shadowRoot);
    var els = document.querySelectorAll("*");
    for (var i = 0; i < els.length; i++) {
      var sr = els[i].shadowRoot;
      if (sr && sr.querySelector("[tabulator-field], .tabulator")) {
        return (_root = sr);
      }
    }
    return document; // shadow host not mounted yet; don't cache
  }

  function getActiveCell() {
    var r = getRoot();
    return (
      r.querySelector('.tabulator-cell[tabulator-field="local_confirm"][data-range="0"]') ||
      r.querySelector('.tabulator-cell.tabulator-range-selected[tabulator-field="local_confirm"]') ||
      r.querySelector('.tabulator-cell[data-range="0"]')
    );
  }

  function getTableHolder() {
    return getRoot().querySelector(".tabulator-tableholder");
  }

  function readActiveValue() {
    var cell = getActiveCell();
    if (!cell) return null;
    return (cell.textContent || "").replace(/ /g, "").trim();
  }

  // The remark keyed into the active row (empty when none).
  function readActiveRemarks() {
    var cell = getActiveCell();
    if (!cell) return "";
    var rowEl = cell.closest(".tabulator-row");
    if (!rowEl) return "";
    var rem = rowEl.querySelector('.tabulator-cell[tabulator-field="remarks"]');
    return rem ? (rem.textContent || "").trim() : "";
  }

  function focusTable() {
    var cell = getActiveCell();
    var holder = getTableHolder();
    if (cell) {
      try { cell.focus({ preventScroll: true }); return; } catch (e) {}
    }
    if (holder) {
      try { holder.focus({ preventScroll: true }); } catch (e) {}
    }
  }

  function isEditable(el) {
    if (!el) return false;
    var tag = el.tagName;
    return (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      el.isContentEditable === true
    );
  }

  // document.activeElement stops at the shadow host; the real focused element
  // (e.g. a native search filter) lives inside the shadow root.
  function deepActiveElement() {
    var root = getRoot();
    if (root && root !== document && root.activeElement) return root.activeElement;
    return document.activeElement;
  }

  // Dispatch a native arrow key so Tabulator navigates AND the app syncs
  // the product image panels (same code path as a real key press).
  function dispatchNavKey(code) {
    var keyCode = code === "ArrowDown" ? 40 : 38;
    var target = getActiveCell() || getTableHolder() || document.body;
    var ev = new KeyboardEvent("keydown", {
      key: code,
      code: code,
      bubbles: true,
      cancelable: true,
    });
    // KeyboardEvent ctor ignores keyCode/which; Tabulator reads them.
    Object.defineProperty(ev, "keyCode", { get: function () { return keyCode; } });
    Object.defineProperty(ev, "which", { get: function () { return keyCode; } });
    target.dispatchEvent(ev);
  }

  // ======================================================================
  // Definitions extraction (top row)
  // ======================================================================
  // Buttons in the hints card that are navigation buckets, not definitions.
  var HINT_BUCKETS = { "all definitions": 1, keywords: 1, keyword: 1 };

  function extractDefinitions() {
    var defs = [];
    var root = getRoot();
    // Primary: the inline "Definition:" descriptions block.
    var labels = Array.prototype.slice.call(
      root.querySelectorAll("span, div, label")
    ).filter(function (n) {
      return (n.textContent || "").trim() === "Definition:";
    });
    for (var i = 0; i < labels.length && !defs.length; i++) {
      var container = labels[i].parentElement;
      if (!container) continue;
      var items = container.querySelectorAll(".ant-descriptions-item-content");
      items.forEach(function (it) {
        var t = (it.textContent || "").replace(/;+\s*$/, "").trim();
        if (t) defs.push(t);
      });
    }
    // Fallback: the "Hints" definitions button card. Its generic buckets are
    // NOT definitions - a product with none at all still lists "All Definitions
    // [0]" and "keywords [0]", which would otherwise show up as an option.
    if (!defs.length) {
      var btns = root.querySelectorAll(
        ".ant-card-body button .ant-typography.capitalize, .ant-card-body button .ant-typography"
      );
      btns.forEach(function (sp) {
        var raw = (sp.textContent || "").trim();
        if (!raw) return;
        var name = raw.replace(/\s*\[.*\]\s*$/, "").trim();
        if (!name || HINT_BUCKETS[name.toLowerCase()]) return;
        defs.push(name);
      });
    }
    // de-dupe, cap to keep the panel sane
    var seen = {};
    return defs.filter(function (d) {
      if (seen[d]) return false;
      seen[d] = 1;
      return true;
    });
  }

  // ======================================================================
  // Option model
  // ======================================================================
  function buildOptions() {
    var defs = extractDefinitions();
    var opts = [];
    opts.push({ id: "Y", label: "Y", kind: "simple", commit: { local_confirm: VAL.Y } });
    opts.push({ id: "WRONG_CATEGORY", label: "WRONG_CATEGORY", kind: "simple", commit: { local_confirm: VAL.WRONG_CATEGORY } });
    defs.forEach(function (d) {
      opts.push({
        id: "def:" + d,
        label: d,
        def: d,
        kind: "definition",
        commit: { local_confirm: VAL.N, remarks: d },
      });
    });
    opts.push({ id: "LIVE_SELLING", label: "LIVE_SELLING", kind: "simple", commit: { local_confirm: VAL.LIVE_SELLING } });
    opts.push({ id: "CUSTOM", label: "Custom definition…", kind: "custom" });
    options = opts;
  }

  // The definition options currently on show, as a comparable key.
  function definitionsKey() {
    return options
      .filter(function (o) { return o.kind === "definition"; })
      .map(function (o) { return o.label; })
      .join("");
  }

  // The product panel renders after the table row changes, so a row's
  // definitions can appear a moment later than handleRowChange reads them.
  // Re-extract a couple of times and re-render only when the set really
  // changed, so stale options can't outlive the product they came from.
  var DEF_RECHECKS = [400, 1200];
  var defRecheckTimers = [];
  function scheduleDefinitionsRecheck() {
    defRecheckTimers.forEach(clearTimeout);
    defRecheckTimers = DEF_RECHECKS.map(function (ms) {
      return setTimeout(recheckDefinitions, ms);
    });
  }
  function recheckDefinitions() {
    // Don't yank the list around while a custom reason is being typed.
    if (customInput && document.activeElement === customInput) return;
    var before = definitionsKey();
    buildOptions();
    if (definitionsKey() === before) return;
    renderList();
    // Re-derive the highlight WITHOUT auto-keying: the row was already
    // handled on the first pass, so nothing should be committed again.
    var val = readActiveValue();
    setSelected(isUnset(val) ? indexOfId("Y") : findOptionIndexByValue(val, readActiveRemarks()));
  }

  function findOptionIndexByValue(valueText, remarks) {
    var v = (valueText || "").trim();
    if (v === "Y") return indexOfId("Y");
    if (v === "WRONG_CATEGORY") return indexOfId("WRONG_CATEGORY");
    if (v === "LIVE_SELLING") return indexOfId("LIVE_SELLING");
    if (v === "N") {
      // Map the stored remark back to its definition option, else Custom.
      var rem = (remarks || "").trim();
      for (var i = 0; i < options.length; i++) {
        if (options[i].kind === "definition" && (options[i].def || "").trim() === rem) return i;
      }
      return indexOfId("CUSTOM");
    }
    return -1; // DELISTED / "-" / unknown -> no highlight
  }

  function indexOfId(id) {
    for (var i = 0; i < options.length; i++) if (options[i].id === id) return i;
    return -1;
  }

  function isUnset(valueText) {
    var v = (valueText || "").trim();
    return v === "" || v === "-" || v === "0";
  }

  // ======================================================================
  // UI
  // ======================================================================
  // ---- panel geometry (drag + resize) persistence ----------------------
  var geomSaveTimer = null;
  function savePanelGeom() {
    if (!panelEl) return;
    var g = {
      left: panelEl.style.left || "",
      top: panelEl.style.top || "",
      width: panelEl.style.width || "",
      height: panelEl.style.height || "",
    };
    clearTimeout(geomSaveTimer);
    geomSaveTimer = setTimeout(function () {
      try { chrome.storage.sync.set({ panelGeom: g }); } catch (e) {}
    }, 300);
  }

  function applyPanelGeom(g) {
    if (!panelEl || !g) return;
    if (g.width) panelEl.style.width = g.width;
    if (g.height) panelEl.style.height = g.height;
    if (g.left) {
      var l = parseInt(g.left, 10);
      if (!isNaN(l)) {
        l = Math.max(0, Math.min(window.innerWidth - 60, l));
        panelEl.style.left = l + "px";
        panelEl.style.right = "auto";
      }
    }
    if (g.top) {
      var t = parseInt(g.top, 10);
      if (!isNaN(t)) {
        t = Math.max(0, Math.min(window.innerHeight - 36, t));
        panelEl.style.top = t + "px";
        panelEl.style.bottom = "auto";
      }
    }
  }

  function loadPanelGeom() {
    try {
      chrome.storage.sync.get({ panelGeom: null }, function (r) {
        if (r && r.panelGeom) applyPanelGeom(r.panelGeom);
      });
    } catch (e) {}
  }

  function makeDraggable(handle) {
    var sx, sy, ox, oy, dragging = false;
    handle.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      var rect = panelEl.getBoundingClientRect();
      panelEl.style.left = rect.left + "px";
      panelEl.style.top = rect.top + "px";
      panelEl.style.right = "auto";
      panelEl.style.bottom = "auto";
      sx = e.clientX; sy = e.clientY; ox = rect.left; oy = rect.top;
      dragging = true;
      e.preventDefault();
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onUp, true);
    });
    function onMove(e) {
      if (!dragging) return;
      var nx = Math.max(0, Math.min(window.innerWidth - 60, ox + (e.clientX - sx)));
      var ny = Math.max(0, Math.min(window.innerHeight - 36, oy + (e.clientY - sy)));
      panelEl.style.left = nx + "px";
      panelEl.style.top = ny + "px";
    }
    function onUp() {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
      savePanelGeom();
    }
  }

  function buildPanel() {
    panelEl = document.createElement("div");
    panelEl.id = "spu-helper-panel";
    panelEl.innerHTML =
      '<div class="spu-hdr">Local Confirm</div>' +
      '<div class="spu-list" id="spu-list"></div>' +
      '<div class="spu-custom-wrap">' +
      '  <input id="spu-custom-input" type="text" placeholder="Type custom reason, Enter to key in" />' +
      "</div>";
    document.body.appendChild(panelEl);
    listEl = panelEl.querySelector("#spu-list");
    customInput = panelEl.querySelector("#spu-custom-input");

    // Drag by the header; persist size after the native resize grip is used.
    makeDraggable(panelEl.querySelector(".spu-hdr"));
    panelEl.addEventListener("mouseup", function () { savePanelGeom(); });
    loadPanelGeom();

    // Re-fit button fonts when the panel width changes (grid columns stretch).
    if (window.ResizeObserver) {
      var fitTimer = null;
      var ro = new ResizeObserver(function () {
        clearTimeout(fitTimer);
        fitTimer = setTimeout(fitOptionButtons, 60);
      });
      ro.observe(panelEl);
    }

    // Custom textbox: activate on click, handle Enter/Escape locally.
    customInput.addEventListener("mousedown", function () {
      selectCustom();
    });
    customInput.addEventListener("keydown", function (e) {
      // Also stop native document handlers while typing here.
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        commitCustom();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelCustom();
      } else {
        e.stopPropagation();
      }
    });

    toastEl = document.createElement("div");
    toastEl.id = "spu-helper-toast";
    document.body.appendChild(toastEl);
  }

  function renderList() {
    if (!listEl) return;
    listEl.innerHTML = "";
    options.forEach(function (opt, i) {
      if (opt.kind === "custom") return; // rendered as the textbox
      var b = document.createElement("button");
      b.type = "button";
      b.className = "spu-opt" + (opt.kind === "definition" ? " spu-def" : "");
      b.textContent = opt.label;
      b.dataset.idx = String(i);
      if (i === selectedIndex) b.classList.add("spu-selected");
      // Use mousedown+preventDefault so clicking never steals focus.
      b.addEventListener("mousedown", function (ev) {
        ev.preventDefault();
        chooseOption(i, true);
      });
      listEl.appendChild(b);
    });
    updateCustomHighlight();
    fitOptionButtons();
  }

  // Buttons have a fixed width; shrink the font of any whose label overflows
  // so long definitions still fit on one line.
  function fitOptionButtons() {
    if (!listEl) return;
    var btns = listEl.querySelectorAll(".spu-opt");
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      b.style.fontSize = ""; // reset to the CSS default before measuring
      if (!b.clientWidth) continue; // panel hidden; skip (re-run when visible)
      var size = parseFloat(getComputedStyle(b).fontSize) || 15;
      var guard = 0;
      while (b.scrollWidth > b.clientWidth && size > 9 && guard++ < 30) {
        size -= 1;
        b.style.fontSize = size + "px";
      }
    }
  }

  function updateSelectionStyles() {
    if (!listEl) return;
    var btns = listEl.querySelectorAll(".spu-opt");
    btns.forEach(function (b) {
      b.classList.toggle("spu-selected", Number(b.dataset.idx) === selectedIndex);
    });
    updateCustomHighlight();
  }

  function updateCustomHighlight() {
    var customIdx = indexOfId("CUSTOM");
    if (customInput) {
      customInput.parentElement.classList.toggle(
        "spu-selected",
        selectedIndex === customIdx
      );
    }
  }

  function toast(text, ok) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.className = ok === false ? "spu-err" : "spu-ok";
    toastEl.classList.add("spu-show");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      toastEl.classList.remove("spu-show");
    }, 1400);
  }

  // ======================================================================
  // Selection & commit
  // ======================================================================
  function setSelected(i) {
    selectedIndex = i;
    updateSelectionStyles();
  }

  // Choose an option: highlight it and (unless it's the custom box) key it
  // into the current row immediately.
  function chooseOption(i, fromClick) {
    if (i < 0 || i >= options.length) return;
    var opt = options[i];
    setSelected(i);
    if (opt.kind === "custom") {
      focusCustom();
      return;
    }
    commit(opt.commit, opt.label);
    if (fromClick) focusTable();
  }

  // Cycle through the options, wrapping around (Y <- option-up -> Custom).
  function moveOption(dir) {
    if (!options.length) return;
    var i = selectedIndex;
    if (i < 0) i = dir > 0 ? 0 : options.length - 1;
    else i = (i + dir + options.length) % options.length;
    chooseOption(i, false);
  }

  function commit(payload, label) {
    callAdapter("commit", payload).then(function (res) {
      if (res && res.ok) {
        toast("Keyed in: " + (label || ""), true);
      } else {
        // Fallback: try editing the cell through the DOM.
        var done = domCommitFallback(payload);
        if (done) {
          toast("Keyed in (fallback): " + (label || ""), true);
        } else {
          toast("Commit failed (" + (res && res.reason) + ")", false);
        }
      }
    });
  }

  // Best-effort DOM fallback if the Tabulator instance can't be reached.
  // Handles local_confirm only; opens the cell editor and sets the value.
  function domCommitFallback(payload) {
    try {
      var cell = getActiveCell();
      if (!cell) return false;
      var label = payload.local_confirm;
      cell.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      // Editor mounts synchronously in most Tabulator editors.
      var input = cell.querySelector("input, select");
      if (!input) return false;
      if (input.tagName === "SELECT") {
        var matched = false;
        Array.prototype.forEach.call(input.options, function (o) {
          if (o.text.trim() === label || o.value === label) {
            input.value = o.value;
            matched = true;
          }
        });
        if (!matched) return false;
      } else {
        input.value = label;
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      input.blur();
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---- custom textbox ---------------------------------------------------
  function selectCustom() {
    setSelected(indexOfId("CUSTOM"));
  }
  function focusCustom() {
    selectCustom();
    if (customInput) {
      customInput.focus();
      customInput.select();
    }
  }
  function commitCustom() {
    var text = (customInput.value || "").trim();
    if (!text) {
      toast("Enter a reason first", false);
      return;
    }
    commit({ local_confirm: VAL.N, remarks: text }, "Custom");
    customInput.value = "";
    focusTable();
  }
  function cancelCustom() {
    customInput.value = "";
    focusTable();
  }

  // ======================================================================
  // Navigation between products
  // ======================================================================
  // Navigation is delegated to the MAIN-world adapter: a synthetic arrow key
  // must be dispatched there so its keyCode is visible to the app's handler.
  // (A content-script keyCode override does not cross into the page world.)
  function navigateRow(dir) {
    focusTable(); // in case focus is on an enlarged image / elsewhere
    callAdapter("navigate", { dir: dir }).then(function (res) {
      if (!res || !res.ok) dispatchNavKey(dir === "up" ? "ArrowUp" : "ArrowDown");
      onRowChanged();
    });
  }
  function goNext() {
    navigateRow("down");
  }
  function goPrev() {
    navigateRow("up");
  }

  // A signature that identifies the current pair, so we only react to real
  // row changes (not every unrelated DOM mutation or our own commit).
  function currentRowSignature() {
    var cell = getActiveCell();
    if (!cell) return "";
    var rowEl = cell.closest(".tabulator-row");
    if (!rowEl) return "";
    var a = rowEl.querySelector('.tabulator-cell[tabulator-field="a_model_name"]');
    var b = rowEl.querySelector('.tabulator-cell[tabulator-field="b_model_name"]');
    return ((a ? a.textContent : "") + "||" + (b ? b.textContent : "")).trim();
  }

  var lastRowSig = null;
  // Refresh options/definitions and reflect the row's current value (auto-key
  // Y when it's still un-annotated). `force` bypasses the de-dupe guard.
  function handleRowChange(force) {
    var sig = currentRowSignature();
    if (!sig) return;
    if (!force && sig === lastRowSig) return;
    // A real move to a different pair (not the first read on activation).
    var movedToNewPair = lastRowSig !== null && sig !== lastRowSig;
    lastRowSig = sig;
    ensureLocalConfirmSelected(); // fix the default selection before reading it
    buildOptions();
    renderList();
    reflectCurrentValue();
    refreshSmartHints();
    refreshCategoryTranslation();
    ensureLayoutObservers();
    scheduleDefinitionsRecheck(); // definitions may still be rendering
    // Every new pair starts on its model (first) image.
    if (movedToNewPair) resetImagePair();
  }

  // Ask the MAIN-world adapter to (re)compute our exact-match highlights for
  // the current pair, or to disable them and restore the native hints.
  function refreshSmartHints() {
    if (settings.smartHints) {
      callAdapter("smartHints", { enabled: true, minLen: settings.smartHintsMinLen });
    } else {
      callAdapter("smartHints", { enabled: false });
    }
  }

  // ---- category translation --------------------------------------------
  // The breadcrumb reads e.g. "[L1][100630]Beauty > ... > [L3][100891]...".
  // The leaf code is the LAST [Lx][code]; show its 中文 name below the row.
  function extractLeafCode(text) {
    var re = /\[L\d+\]\[(\d+)\]/g, m, last = null;
    while ((m = re.exec(text)) !== null) last = m[1];
    return last;
  }

  function refreshCategoryTranslation() {
    var root = getRoot();
    var spans = root.querySelectorAll(".ant-descriptions-item-content");
    var target = null, code = null;
    for (var i = 0; i < spans.length; i++) {
      var c = extractLeafCode(spans[i].textContent || "");
      if (c) {
        // Append into the table cell (block flow) so it sits on its own line
        // below the breadcrumb, not inline inside the flex content span.
        target = spans[i].closest(".ant-descriptions-item") || spans[i];
        code = c;
        break;
      }
    }
    var existing = root.querySelector("#spu-cat-translation");
    if (!target || !code) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return;
    }
    var map = (typeof window !== "undefined" && window.SPU_CAT_TRANSLATIONS) || {};
    var name = map[code];
    if (!existing) {
      existing = document.createElement("div");
      existing.id = "spu-cat-translation";
      existing.style.cssText =
        "display:block;margin-top:3px;color:#2975dd;font-size:18px;font-weight:700;line-height:1.3;";
    }
    existing.textContent = name || "(no translation for leaf " + code + ")";
    if (existing.parentElement !== target) target.appendChild(existing);
  }

  // ---- remember native splitter sizes ----------------------------------
  // The site has two drag splitters: a col-resize handle sets the product
  // area width, a row-resize handle sets the category/definition height.
  // We restore the saved sizes on load and save whenever the user drags.
  var layoutObsW = null, layoutObsH = null;
  var observedW = null, observedH = null;
  var layoutSaveTimer = null;
  var layoutDefaults = null; // the site's own sizes, captured before we override

  function getSplitTargets() {
    var root = getRoot();
    var colH = root.querySelector(".z-20.right-\\[-8px\\]");
    var rowH = root.querySelector(".z-20.bottom-\\[-8px\\]");
    return { w: colH ? colH.parentElement : null, h: rowH ? rowH.parentElement : null };
  }

  function applyLayoutSizes() {
    var t = getSplitTargets();
    // Capture the site's own sizes once, before we ever override them.
    if (!layoutDefaults && (t.w || t.h)) {
      layoutDefaults = { w: t.w && t.w.style.width, h: t.h && t.h.style.height };
    }
    var g = settings.layoutSizes;
    if (!g) { ensureLayoutObservers(); return; }
    if (layoutObsW) layoutObsW.disconnect();
    if (layoutObsH) layoutObsH.disconnect();
    try {
      if (t.w && g.w) t.w.style.width = g.w;
      if (t.h && g.h) t.h.style.height = g.h;
    } catch (e) {}
    observedW = null; observedH = null; // re-observe the (possibly new) targets
    ensureLayoutObservers();
  }

  // Restore the site's own splitter sizes and forget the saved ones.
  function resetLayoutSizes() {
    var t = getSplitTargets();
    if (layoutObsW) layoutObsW.disconnect();
    if (layoutObsH) layoutObsH.disconnect();
    try {
      if (t.w) t.w.style.width = (layoutDefaults && layoutDefaults.w) || "";
      if (t.h) t.h.style.height = (layoutDefaults && layoutDefaults.h) || "";
    } catch (e) {}
    observedW = null; observedH = null;
    ensureLayoutObservers();
  }

  function saveLayoutSizes() {
    var t = getSplitTargets();
    var sizes = {};
    if (t.w && t.w.style.width) sizes.w = t.w.style.width;
    if (t.h && t.h.style.height) sizes.h = t.h.style.height;
    if (!sizes.w && !sizes.h) return;
    settings.layoutSizes = sizes;
    clearTimeout(layoutSaveTimer);
    layoutSaveTimer = setTimeout(function () {
      try { chrome.storage.sync.set({ layoutSizes: sizes }); } catch (e) {}
    }, 400);
  }

  function ensureLayoutObservers() {
    var t = getSplitTargets();
    if (t.w && t.w !== observedW) {
      if (layoutObsW) layoutObsW.disconnect();
      observedW = t.w;
      layoutObsW = new MutationObserver(saveLayoutSizes);
      layoutObsW.observe(t.w, { attributes: true, attributeFilter: ["style"] });
    }
    if (t.h && t.h !== observedH) {
      if (layoutObsH) layoutObsH.disconnect();
      observedH = t.h;
      layoutObsH = new MutationObserver(saveLayoutSizes);
      layoutObsH.observe(t.h, { attributes: true, attributeFilter: ["style"] });
    }
  }

  // After OUR navigation keys move the row.
  function onRowChanged() {
    setTimeout(function () {
      handleRowChange(false);
      focusTable();
    }, 60);
  }

  // Watch the table so definitions/options refresh on ANY navigation method
  // (native arrows, row clicks, pagination) - not just our W/S keys.
  var rowObserver = null;
  var rowObsTimer = null;
  function setupRowObserver() {
    if (rowObserver) return;
    var root = getRoot();
    var target = (root.querySelector && root.querySelector(".tabulator-tableholder")) || root;
    if (!target || !target.nodeType) return;
    rowObserver = new MutationObserver(function () {
      clearTimeout(rowObsTimer);
      rowObsTimer = setTimeout(function () {
        handleRowChange(false);
      }, 120);
    });
    try {
      rowObserver.observe(target, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-range"],
      });
    } catch (e) {}
  }

  // Hide the panel while the site's image lightbox (an ant-modal) is open, so
  // it doesn't cover the enlarged image.
  var modalObserver = null;
  function isImageModalOpen() {
    var root = getRoot();
    return !!(root.querySelector && root.querySelector(".ant-modal-root"));
  }
  function updateModalState() {
    if (!panelEl) return;
    panelEl.style.visibility = isImageModalOpen() ? "hidden" : "";
  }
  function setupModalObserver() {
    if (modalObserver) return;
    var root = getRoot();
    if (!root || !root.nodeType) return;
    var t = null;
    modalObserver = new MutationObserver(function () {
      clearTimeout(t);
      t = setTimeout(updateModalState, 30);
    });
    try { modalObserver.observe(root, { childList: true, subtree: true }); } catch (e) {}
  }

  // ======================================================================
  // Submit + go to next page
  // ======================================================================
  function findButtonByText(txt) {
    var root = getRoot();
    var btns = root.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      if ((btns[i].textContent || "").trim() === txt) return btns[i];
    }
    return null;
  }

  function submitAndNext() {
    var submit = findButtonByText("Submit");
    if (submit) {
      submit.click();
      toast("Submitted", true);
    } else {
      toast("Submit button not found", false);
      return;
    }
    // Wait for the submission to upload before advancing the page.
    setTimeout(function () {
      var root = getRoot();
      var nextLi = root.querySelector(".ant-pagination-next");
      if (nextLi && nextLi.getAttribute("aria-disabled") === "true") return;
      var nextBtn = (nextLi && (nextLi.querySelector("button, a") || nextLi)) ||
        root.querySelector('.ant-pagination-next button, [aria-label="Next Page"], [aria-label="next"]');
      if (nextBtn) nextBtn.click();
    }, 1500);
  }

  // ======================================================================
  // Side-by-side image compare (replaces the native single-image lightbox)
  // ======================================================================
  var compareEl = null;
  var compareOpen = false;

  function largestImg(panel) {
    var imgs = panel.querySelectorAll("img");
    var best = null, area = 0;
    for (var i = 0; i < imgs.length; i++) {
      var a = imgs[i].clientWidth * imgs[i].clientHeight;
      if (a > area) { area = a; best = imgs[i]; }
    }
    return best;
  }

  // The currently displayed image of each product (both panels).
  function getProductImages() {
    var root = getRoot();
    var panels = root.querySelectorAll(".relative.h-full.flex-1.overflow-auto.p-4");
    var srcs = [];
    for (var i = 0; i < panels.length && i < 2; i++) {
      var img = panels[i].querySelector(".slide.selected img") || largestImg(panels[i]);
      srcs.push(img ? img.src : null);
    }
    return srcs;
  }

  function buildCompare() {
    compareEl = document.createElement("div");
    compareEl.id = "spu-compare-overlay";
    compareEl.innerHTML =
      '<div class="spu-cmp-inner">' +
      '  <img class="spu-cmp-img" data-side="a" />' +
      '  <img class="spu-cmp-img" data-side="b" />' +
      "</div>";
    // Click anywhere closes it; clicking an image shouldn't re-trigger anything.
    compareEl.addEventListener("click", closeCompare);
    document.body.appendChild(compareEl);
  }

  function openCompare() {
    if (!compareEl) buildCompare();
    var s = getProductImages();
    var imgs = compareEl.querySelectorAll(".spu-cmp-img");
    for (var i = 0; i < imgs.length; i++) {
      if (s[i]) { imgs[i].src = s[i]; imgs[i].style.display = ""; }
      else { imgs[i].removeAttribute("src"); imgs[i].style.display = "none"; }
    }
    compareEl.style.display = "flex";
    compareOpen = true;
  }

  function closeCompare() {
    if (compareEl) compareEl.style.display = "none";
    compareOpen = false;
  }

  function toggleCompare() {
    if (compareOpen) closeCompare();
    else openCompare();
  }

  // Advance both products' image carousels to their next image (wrapping).
  // Delegated to the MAIN-world adapter, which drives the carousel via its
  // moveTo() API so the native enlarger does NOT open. Works whether or not
  // the compare overlay is shown; if it's open, refresh it after the re-render.
  function advanceImagePair() {
    callAdapter("nextImagePair").then(function () {
      if (compareOpen) setTimeout(function () { if (compareOpen) openCompare(); }, 140);
    });
  }

  // Back to each product's first (model) image - used when a new pair opens, so
  // it never starts on the image the previous pair was left at. The adapter
  // retries the reset shortly after (the new panels may still be rendering), so
  // refresh the compare overlay after that settles.
  function resetImagePair() {
    callAdapter("resetImagePair").then(function () {
      if (compareOpen) setTimeout(function () { if (compareOpen) openCompare(); }, 260);
    });
  }

  // Scroll both product-info panels down a chunk (keeps them roughly in step
  // while reading long descriptions).
  function scrollProductsDown() {
    var root = getRoot();
    var panels = root.querySelectorAll(".relative.h-full.flex-1.overflow-auto.p-4");
    for (var i = 0; i < panels.length; i++) {
      var p = panels[i];
      var amt = Math.round(p.clientHeight * 0.6);
      try { p.scrollBy({ top: amt, behavior: "smooth" }); }
      catch (e) { p.scrollTop += amt; }
    }
  }

  // On entering a page the site selects the top-left cell, but work starts on
  // the Local Confirm column. Move the selection there if it isn't already.
  function ensureLocalConfirmSelected() {
    var root = getRoot();
    var active = root.querySelector('.tabulator-cell[data-range="0"]') ||
      root.querySelector(".tabulator-cell.tabulator-range-selected");
    if (!active) return;
    if (active.getAttribute("tabulator-field") === "local_confirm") return;
    var rowEl = active.closest(".tabulator-row");
    var lc = (rowEl && rowEl.querySelector('.tabulator-cell[tabulator-field="local_confirm"]')) ||
      root.querySelector('.tabulator-row .tabulator-cell[tabulator-field="local_confirm"]');
    if (!lc) return;
    lc.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));
    lc.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, composed: true }));
  }

  // Intercept clicks on a product's main image so our side-by-side compare
  // opens instead of the site's single-image modal.
  function onImageClickCapture(e) {
    if (!active || !settings.enabled) return;
    var path = e.composedPath ? e.composedPath() : null;
    var t = (path && path[0]) || e.target;
    if (!t || t.tagName !== "IMG" || (t.clientWidth || 0) < 150) return; // ignore thumbnails
    var root = getRoot();
    var panels = root.querySelectorAll(".relative.h-full.flex-1.overflow-auto.p-4");
    var inPanel = false;
    for (var i = 0; i < panels.length; i++) { if (panels[i].contains(t)) { inPanel = true; break; } }
    if (!inPanel) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    openCompare();
  }

  function reflectCurrentValue() {
    var val = readActiveValue();
    if (isUnset(val)) {
      if (customInput) customInput.value = "";
      var yi = indexOfId("Y");
      if (settings.autoKeyY) {
        chooseOption(yi, false); // highlight + commit Y
      } else {
        setSelected(yi);
      }
      return;
    }
    // Select whatever the row already holds (definition/custom included) so
    // A/D moves relative to it instead of jumping back to Y.
    var rem = readActiveRemarks();
    var idx = findOptionIndexByValue(val, rem);
    if (customInput) {
      customInput.value = idx === indexOfId("CUSTOM") ? rem : "";
    }
    setSelected(idx);
  }

  // ======================================================================
  // Key handling
  // ======================================================================
  function onKeyDown(e) {
    if (!active || !settings.enabled) return;
    // Escape always closes the compare overlay if it's open.
    if (compareOpen && e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeCompare();
      return;
    }
    if (document.activeElement === customInput) return; // handled by the input's own listener
    if (isEditable(deepActiveElement())) return; // don't remap while typing in native fields
    if (e.ctrlKey || e.metaKey || e.altKey) return; // leave Ctrl/Cmd/Alt shortcuts (e.g. Ctrl+C) alone

    var k = e.key && e.key.length === 1 ? e.key.toLowerCase() : e.key;
    var kb = settings.keybindings;

    if (keyIn(kb.next, k)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      goNext();
    } else if (keyIn(kb.prev, k)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      goPrev();
    } else if (keyIn(kb.optionUp, k)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      moveOption(-1);
    } else if (keyIn(kb.optionDown, k)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      moveOption(1);
    } else if (keyIn(kb.submitNext, k)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      submitAndNext();
    } else if (keyIn(kb.enlarge, k)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      toggleCompare();
    } else if (keyIn(kb.scrollDown, k)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      scrollProductsDown();
    } else if (keyIn(kb.gotoFirst, k)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      callAdapter("gotoRow", { which: "first" });
    } else if (keyIn(kb.gotoLast, k)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      callAdapter("gotoRow", { which: "last" });
    } else if (keyIn(kb.nextImage, k)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      advanceImagePair();
    }
  }

  // A binding is a list of keys; accept the legacy single-string form too.
  function keyIn(binding, k) {
    if (!binding) return false;
    if (typeof binding === "string") return binding === k;
    return binding.indexOf(k) !== -1;
  }

  // ======================================================================
  // KPI work-day timer (shown next to "Active Time" in the header)
  // ======================================================================
  var LUNCH_START = 12 * 60 + 30; // 12:30
  var LUNCH_END = 13 * 60 + 30;   // 13:30
  var HARD_END = 18 * 60 + 30;    // 18:30 - latest possible leave time
  var SLACK_DEFAULT = 15;         // minutes of settling in, twice a day
  var kpiEl = null, kpiChipEl = null, kpiPctEl = null, kpiPanelEl = null, kpiTimer = null;
  var kpiOpen = false, kpiDocClickBound = false;
  var kpiSettings = { mode: "full", startMin: 9 * 60, slackMin: SLACK_DEFAULT };

  function kpiTodayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
  }
  function mmToStr(m) {
    m = ((Math.round(m) % 1440) + 1440) % 1440;
    var h = Math.floor(m / 60), mm = m % 60;
    return (h < 10 ? "0" : "") + h + ":" + (mm < 10 ? "0" : "") + mm;
  }
  function strToMm(s) {
    var p = (s || "").split(":");
    var h = parseInt(p[0], 10), m = parseInt(p[1], 10);
    if (isNaN(h) || isNaN(m)) return null;
    return h * 60 + m;
  }
  function kpiOverlap(a, b, c, d) { return Math.max(0, Math.min(b, d) - Math.max(a, c)); }
  // Start/leave times (minutes since midnight) for the selected mode.
  function kpiSchedule() {
    var s, e;
    if (kpiSettings.mode === "morningOff") { s = 14 * 60; e = s + 4 * 60; }        // arrive 2PM, 4h
    else if (kpiSettings.mode === "afternoonOff") { s = kpiSettings.startMin; e = Math.min(s + 4 * 60, HARD_END); }
    else { s = kpiSettings.startMin; e = Math.min(s + 9 * 60, HARD_END); }         // full day: 9h, capped 18:30
    return { s: s, e: e };
  }

  // Slack-off blocks: the first minutes of the morning and the first minutes
  // after getting back from lunch. Clipped to the working window, so they
  // vanish when they don't apply (e.g. arriving at 2PM has no after-lunch one).
  function kpiSlackBlocks() {
    var sm = kpiSettings.slackMin;
    if (!(sm > 0)) return [];
    var sch = kpiSchedule();
    var raw = [[sch.s, sch.s + sm]];
    if (sch.s < LUNCH_END && sch.e > LUNCH_END) raw.push([LUNCH_END, LUNCH_END + sm]);
    var out = [];
    raw.forEach(function (iv) {
      var a = Math.max(iv[0], sch.s), b = Math.min(iv[1], sch.e);
      if (b > a) out.push([a, b]);
    });
    return out;
  }
  // Lunch + slack off, merged so overlapping blocks are never counted twice.
  function kpiBreaks() {
    var iv = [[LUNCH_START, LUNCH_END]].concat(kpiSlackBlocks());
    iv.sort(function (x, y) { return x[0] - y[0]; });
    var out = [];
    iv.forEach(function (cur) {
      var last = out[out.length - 1];
      if (last && cur[0] <= last[1]) last[1] = Math.max(last[1], cur[1]);
      else out.push([cur[0], cur[1]]);
    });
    return out;
  }
  // Time that counts towards the day: everything but the breaks.
  function kpiWorkingMin(a, b) {
    if (b <= a) return 0;
    var off = 0;
    kpiBreaks().forEach(function (iv) { off += kpiOverlap(a, b, iv[0], iv[1]); });
    return (b - a) - off;
  }
  function kpiPercent(nowMin) {
    var sch = kpiSchedule();
    var total = kpiWorkingMin(sch.s, sch.e);
    if (total <= 0) return 0;
    var n = Math.max(sch.s, Math.min(nowMin, sch.e));
    var p = kpiWorkingMin(sch.s, n) / total * 100;
    return p < 0 ? 0 : p > 100 ? 100 : p;
  }
  // What the day is currently doing; null while actually working.
  function kpiStatus(nowMin) {
    var sch = kpiSchedule();
    if (nowMin < sch.s || nowMin >= sch.e) return "not work time";
    if (nowMin >= LUNCH_START && nowMin < LUNCH_END) return "lunch";
    var sl = kpiSlackBlocks();
    for (var i = 0; i < sl.length; i++) {
      if (nowMin >= sl[i][0] && nowMin < sl[i][1]) return "slack off";
    }
    return null;
  }
  function kpiNowMin() {
    var d = new Date();
    return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  }

  function loadKpi(cb) {
    try {
      chrome.storage.sync.get({ kpiSettings: null }, function (r) {
        var s = r && r.kpiSettings;
        if (s && s.date === kpiTodayStr() && typeof s.startMin === "number" && s.mode) {
          kpiSettings = { mode: s.mode, startMin: s.startMin };
        } else {
          kpiSettings = { mode: "full", startMin: 9 * 60 }; // reset each new day
        }
        // The slack-off length is a preference, so it outlives the daily reset.
        kpiSettings.slackMin =
          s && typeof s.slackMin === "number" ? s.slackMin : SLACK_DEFAULT;
        cb && cb();
      });
    } catch (e) { cb && cb(); }
  }
  function saveKpi() {
    try {
      chrome.storage.sync.set({
        kpiSettings: {
          mode: kpiSettings.mode,
          startMin: kpiSettings.startMin,
          slackMin: kpiSettings.slackMin,
          date: kpiTodayStr(),
        },
      });
    } catch (e) {}
  }

  function findActiveTimeBlock() {
    var all = document.querySelectorAll("body *");
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (e.children.length === 0 && /Active Time/.test(e.textContent || "")) {
        var span = e.parentElement;                 // span.ant-typography
        return (span && span.parentElement) || span || e; // the wrapping block
      }
    }
    return null;
  }

  function buildKpi() {
    kpiEl = document.createElement("span");
    kpiEl.id = "spu-kpi";
    kpiEl.style.cssText =
      "position:relative;display:inline-flex;align-items:center;margin-left:16px;vertical-align:middle;" +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;";
    var chip = document.createElement("button");
    chip.type = "button";
    chip.style.cssText =
      "display:inline-flex;align-items:center;gap:5px;padding:2px 10px;border:1px solid #2975dd;" +
      "border-radius:12px;background:#eef5ff;color:#1a4b8f;font-size:13px;font-weight:700;cursor:pointer;line-height:1.4;";
    chip.innerHTML =
      '<span style="font-weight:600;color:#5a7fb0;">Day</span>' +
      '<span id="spu-kpi-pct">--%</span>' +
      '<span style="color:#5a7fb0;font-size:10px;">▾</span>';
    kpiEl.appendChild(chip);
    kpiChipEl = chip;
    kpiPctEl = chip.querySelector("#spu-kpi-pct");

    // The panel lives at the body level (not nested in the site header) so its
    // z-index wins over the Local Confirm panel instead of being trapped in the
    // header's stacking context.
    kpiPanelEl = document.createElement("div");
    kpiPanelEl.style.cssText =
      "display:none;position:fixed;z-index:2147483646;background:#fff;" +
      "border:1px solid #cfd8e3;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.18);padding:12px;" +
      "width:240px;color:#1f2937;font-size:13px;font-weight:500;cursor:default;text-align:left;" +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;";
    kpiPanelEl.innerHTML =
      '<div style="font-weight:700;margin-bottom:8px;">Work day</div>' +
      '<div id="spu-kpi-modes" style="display:flex;gap:4px;margin-bottom:10px;"></div>' +
      '<label style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
      '<span>Start work</span>' +
      '<input type="time" id="spu-kpi-start" style="padding:3px 6px;border:1px solid #cfd8e3;border-radius:6px;font-size:13px;" />' +
      "</label>" +
      '<label style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
      '<span>Slack off (min)</span>' +
      '<input type="number" id="spu-kpi-slack" min="0" max="120" step="5" style="width:64px;padding:3px 6px;border:1px solid #cfd8e3;border-radius:6px;font-size:13px;" />' +
      "</label>" +
      '<div id="spu-kpi-info" style="color:#555;font-size:12px;line-height:1.5;"></div>';
    document.body.appendChild(kpiPanelEl);

    chip.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      kpiOpen = !kpiOpen;
      kpiPanelEl.style.display = kpiOpen ? "block" : "none";
      if (kpiOpen) { renderKpiPanel(); positionKpiPanel(); }
    });

    var modes = [["full", "Full day"], ["morningOff", "Morning off"], ["afternoonOff", "Afternoon off"]];
    var modesWrap = kpiPanelEl.querySelector("#spu-kpi-modes");
    modes.forEach(function (m) {
      var b = document.createElement("button");
      b.type = "button";
      b.dataset.mode = m[0];
      b.textContent = m[1];
      b.style.cssText =
        "flex:1;padding:5px 2px;border:1px solid #cfd8e3;border-radius:6px;background:#f4f6f8;" +
        "font-size:11px;font-weight:600;cursor:pointer;color:#2c3e50;";
      b.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        kpiSettings.mode = m[0];
        saveKpi();
        renderKpiPanel();
        updateKpi();
      });
      modesWrap.appendChild(b);
    });

    var startInput = kpiPanelEl.querySelector("#spu-kpi-start");
    startInput.addEventListener("change", function () {
      var v = strToMm(startInput.value);
      if (v != null) { kpiSettings.startMin = v; saveKpi(); renderKpiPanel(); updateKpi(); }
    });

    var slackInput = kpiPanelEl.querySelector("#spu-kpi-slack");
    slackInput.addEventListener("change", function () {
      var v = parseInt(slackInput.value, 10);
      if (isNaN(v) || v < 0) v = 0;
      if (v > 120) v = 120;
      kpiSettings.slackMin = v; // 0 turns the slack-off blocks off
      saveKpi();
      renderKpiPanel();
      updateKpi();
    });
    kpiPanelEl.addEventListener("click", function (e) { e.stopPropagation(); });
  }

  function renderKpiPanel() {
    if (!kpiPanelEl) return;
    var btns = kpiPanelEl.querySelectorAll("#spu-kpi-modes button");
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].dataset.mode === kpiSettings.mode;
      btns[i].style.background = on ? "#2975dd" : "#f4f6f8";
      btns[i].style.color = on ? "#fff" : "#2c3e50";
      btns[i].style.borderColor = on ? "#2975dd" : "#cfd8e3";
    }
    var startInput = kpiPanelEl.querySelector("#spu-kpi-start");
    var morn = kpiSettings.mode === "morningOff";
    startInput.value = mmToStr(morn ? 14 * 60 : kpiSettings.startMin);
    startInput.disabled = morn;
    startInput.style.opacity = morn ? "0.5" : "1";
    kpiPanelEl.querySelector("#spu-kpi-slack").value = kpiSettings.slackMin;
    var sch = kpiSchedule();
    var slack = kpiSlackBlocks()
      .map(function (iv) { return mmToStr(iv[0]) + "–" + mmToStr(iv[1]); })
      .join(", ");
    kpiPanelEl.querySelector("#spu-kpi-info").innerHTML =
      "Arrive <b>" + mmToStr(sch.s) + "</b> · Leave <b>" + mmToStr(sch.e) + "</b><br>" +
      "Working: <b>" + (kpiWorkingMin(sch.s, sch.e) / 60).toFixed(1) + "h</b> (lunch 12:30–13:30)" +
      (slack ? "<br>Slack off: <b>" + slack + "</b>" : "");
  }

  function ensureKpiInserted() {
    if (!kpiEl) buildKpi();
    if (kpiEl.isConnected) return;
    var block = findActiveTimeBlock();
    if (block && block.parentNode) {
      try { block.parentNode.insertBefore(kpiEl, block.nextSibling); } catch (e) {}
    }
  }

  // Place the (body-level) panel just under the chip.
  function positionKpiPanel() {
    if (!kpiChipEl || !kpiPanelEl) return;
    var rect = kpiChipEl.getBoundingClientRect();
    var pw = kpiPanelEl.offsetWidth || 240;
    var left = Math.max(8, Math.min(rect.left, window.innerWidth - 8 - pw));
    kpiPanelEl.style.left = left + "px";
    kpiPanelEl.style.top = rect.bottom + 6 + "px";
  }

  // Chip tint per status, so the state is readable at a glance.
  var KPI_TINTS = {
    work: ["#eef5ff", "#2975dd", "#1a4b8f"],
    "slack off": ["#fff4e0", "#e0a020", "#8a5300"],
    lunch: ["#eef8f0", "#5aa46e", "#2f6b41"],
    "not work time": ["#f1f3f5", "#b9c2cc", "#4a5561"],
  };
  function updateKpi() {
    ensureKpiInserted();
    var now = kpiNowMin();
    var status = kpiStatus(now);
    var pct = kpiPercent(now).toFixed(1) + "%";
    // Working hours show just the number; anything else is labelled.
    if (kpiPctEl) kpiPctEl.textContent = status ? status + " - " + pct : pct;
    var tint = KPI_TINTS[status || "work"];
    if (kpiChipEl && tint) {
      kpiChipEl.style.background = tint[0];
      kpiChipEl.style.borderColor = tint[1];
      kpiChipEl.style.color = tint[2];
    }
    if (kpiOpen) positionKpiPanel();
  }

  function setupKpi() {
    if (kpiTimer) return;
    loadKpi(function () {
      ensureKpiInserted();
      updateKpi();
      renderKpiPanel();
    });
    kpiTimer = setInterval(updateKpi, 1000);
    if (!kpiDocClickBound) {
      document.addEventListener("click", function () {
        if (kpiOpen) { kpiOpen = false; if (kpiPanelEl) kpiPanelEl.style.display = "none"; }
      });
      kpiDocClickBound = true;
    }
  }

  function teardownKpi() {
    if (kpiTimer) { clearInterval(kpiTimer); kpiTimer = null; }
    if (kpiEl && kpiEl.parentNode) kpiEl.parentNode.removeChild(kpiEl);
    if (kpiPanelEl && kpiPanelEl.parentNode) kpiPanelEl.parentNode.removeChild(kpiPanelEl);
    kpiOpen = false;
  }

  // ======================================================================
  // Activation lifecycle
  // ======================================================================
  function isPairPage() {
    return location.pathname.indexOf(PAIR_PATH) !== -1;
  }

  function waitForTable(cb, tries) {
    tries = tries || 0;
    if (getRoot().querySelector('.tabulator-cell[tabulator-field="local_confirm"]')) {
      cb();
    } else if (tries < 60) {
      setTimeout(function () { waitForTable(cb, tries + 1); }, 250);
    }
  }

  function activate() {
    if (active) return;
    active = true;
    if (!panelEl) buildPanel();
    panelEl.style.display = "flex";
    toastEl.style.display = "block";
    setupKpi();
    waitForTable(function () {
      handleRowChange(true);
      focusTable();
      setupRowObserver();
      setupModalObserver();
      updateModalState();
      applyLayoutSizes();
    });
  }

  function deactivate() {
    if (!active) return;
    active = false;
    if (panelEl) panelEl.style.display = "none";
    if (toastEl) toastEl.style.display = "none";
    teardownKpi();
  }

  function applyActivation() {
    if (!settings.enabled) {
      deactivate();
      return;
    }
    if (isPairPage()) activate();
    else deactivate();
  }

  // ---- SPA URL watching -------------------------------------------------
  var lastHref = location.href;
  setInterval(function () {
    if (location.href !== lastHref) {
      lastHref = location.href;
      applyActivation();
    }
  }, 500);
  window.addEventListener("popstate", applyActivation);

  // ---- settings load + live updates -------------------------------------
  function loadSettings(cb) {
    try {
      chrome.storage.sync.get(DEFAULTS, function (stored) {
        settings = Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), stored || {});
        settings.keybindings = Object.assign(
          {},
          DEFAULTS.keybindings,
          (stored && stored.keybindings) || {}
        );
        cb && cb();
      });
    } catch (e) {
      cb && cb();
    }
  }

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "sync") return;
      loadSettings(function () {
        applyActivation();
        if (active) {
          renderList();
          refreshSmartHints();
          // Popup cleared the saved layout -> restore the site's own sizes.
          if (changes.layoutSizes && !changes.layoutSizes.newValue) resetLayoutSizes();
        }
      });
    });
  } catch (e) {}

  // ---- boot -------------------------------------------------------------
  // The SPU app swallows keydown at window-capture (stopPropagation), so a
  // document-level listener never sees W/S/A/D. Listen on window capture too.
  window.addEventListener("keydown", onKeyDown, true);
  // Intercept product-image clicks (capture) to open our side-by-side compare.
  window.addEventListener("click", onImageClickCapture, true);
  loadSettings(function () {
    applyActivation();
  });
})();
