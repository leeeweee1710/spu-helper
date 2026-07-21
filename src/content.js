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
    smartHintsMinLen: 4, // shortest matched run to highlight
    layoutSizes: null, // remembered native splitter sizes { w, h }
    // Each action maps to a LIST of keys (any of them triggers it).
    keybindings: {
      next: ["w"],
      prev: ["s"],
      optionUp: ["a"],
      optionDown: ["d"],
      submitNext: ["\\"],
      enlarge: [" "],
      scrollDown: ["n", "c"],
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
    // Fallback: the "Hints" definitions button card.
    if (!defs.length) {
      var btns = root.querySelectorAll(
        ".ant-card-body button .ant-typography.capitalize, .ant-card-body button .ant-typography"
      );
      btns.forEach(function (sp) {
        var raw = (sp.textContent || "").trim();
        if (!raw || /^all definitions/i.test(raw)) return;
        var name = raw.replace(/\s*\[.*\]\s*$/, "").trim();
        if (name) defs.push(name);
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
      '<div class="spu-hdr">Local Confirm' +
      '<span class="spu-hint">W/S · A/D</span></div>' +
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
    lastRowSig = sig;
    ensureLocalConfirmSelected(); // fix the default selection before reading it
    buildOptions();
    renderList();
    reflectCurrentValue();
    refreshSmartHints();
    refreshCategoryTranslation();
    ensureLayoutObservers();
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
    }
  }

  // A binding is a list of keys; accept the legacy single-string form too.
  function keyIn(binding, k) {
    if (!binding) return false;
    if (typeof binding === "string") return binding === k;
    return binding.indexOf(k) !== -1;
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
