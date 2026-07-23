/*
 * SPU Annotation Helper - page adapter (MAIN world)
 * ------------------------------------------------------------------
 * Runs in the page's own JS context so it can reach the live Tabulator
 * table instance. The content script (ISOLATED world) cannot touch page
 * objects, so it talks to this adapter over window.postMessage.
 *
 * Responsibilities:
 *   - locate the Tabulator table instance (several fallback strategies)
 *   - find the currently active row (the pair whose images are shown)
 *   - commit a value: set `local_confirm` (int enum) and optionally
 *     `remarks` (JSON string) on that row, so the app's own Save button
 *     persists it.
 *
 * If the Tabulator instance cannot be found, `commit` fails with a
 * reason and the content script falls back to editing the cell through
 * the DOM. This is the ONE spot to adjust if the live site differs from
 * the reference capture.
 */
(function () {
  "use strict";
  if (window.__spuAdapterLoaded) return;
  window.__spuAdapterLoaded = true;

  var MSG = "__spu_helper__";
  var cachedTable = null;

  // The SPU app renders inside an (open) shadow root; document.querySelector
  // cannot reach the table. Resolve the shadow root and query inside it.
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

  // ---- Tabulator instance discovery -------------------------------------
  function looksLikeTable(v) {
    return (
      v &&
      typeof v === "object" &&
      typeof v.getRows === "function" &&
      typeof v.updateData === "function"
    );
  }

  function fromGlobal(el) {
    var candidates = [window.Tabulator, window.tabulator];
    for (var i = 0; i < candidates.length; i++) {
      var g = candidates[i];
      if (g && typeof g.findTable === "function") {
        try {
          var t = g.findTable(el);
          if (t && t[0]) return t[0];
        } catch (e) {}
      }
    }
    // Scan window for the Tabulator constructor itself.
    try {
      var names = Object.getOwnPropertyNames(window);
      for (var j = 0; j < names.length; j++) {
        var v;
        try {
          v = window[names[j]];
        } catch (e) {
          continue;
        }
        if (
          typeof v === "function" &&
          v.prototype &&
          typeof v.prototype.updateData === "function" &&
          typeof v.findTable === "function"
        ) {
          try {
            var tt = v.findTable(el);
            if (tt && tt[0]) return tt[0];
          } catch (e) {}
        }
      }
    } catch (e) {}
    return null;
  }

  function fromElementProps(el) {
    var keys;
    try {
      keys = Object.getOwnPropertyNames(el);
    } catch (e) {
      keys = [];
    }
    for (var i = 0; i < keys.length; i++) {
      try {
        var v = el[keys[i]];
        if (looksLikeTable(v)) return v;
      } catch (e) {}
    }
    return null;
  }

  function fromReactFiber(el) {
    // Walk the React fiber tree looking for a stored Tabulator ref.
    var start = null;
    var node = el;
    while (node && !start) {
      var fk = Object.keys(node).find(function (k) {
        return (
          k.indexOf("__reactFiber$") === 0 ||
          k.indexOf("__reactInternalInstance$") === 0
        );
      });
      if (fk) start = node[fk];
      node = node.parentElement;
    }
    if (!start) return null;

    var seen = new Set();
    var queue = [start];
    var budget = 20000;
    while (queue.length && budget-- > 0) {
      var f = queue.shift();
      if (!f || seen.has(f)) continue;
      seen.add(f);

      // Walk the hook chain (memoizedState -> .next). react-tabulator stores
      // the live instance in a useRef hook: hookN.memoizedState.current.
      var hook = f.memoizedState;
      var hi = 0;
      while (hook && typeof hook === "object" && hi < 40) {
        var hs = hook.memoizedState;
        if (looksLikeTable(hs)) return hs;
        if (hs && typeof hs === "object" && looksLikeTable(hs.current)) return hs.current;
        hook = hook.next;
        hi++;
      }

      // stateNode / memoizedProps: check directly and one level in (refs).
      var buckets = [f.stateNode, f.memoizedProps];
      for (var b = 0; b < buckets.length; b++) {
        var obj = buckets[b];
        if (looksLikeTable(obj)) return obj;
        if (obj && typeof obj === "object") {
          for (var k in obj) {
            try {
              if (looksLikeTable(obj[k])) return obj[k];
            } catch (e) {}
          }
        }
      }

      if (f.child) queue.push(f.child);
      if (f.sibling) queue.push(f.sibling);
      if (f.return) queue.push(f.return);
    }
    return null;
  }

  function findTable() {
    if (cachedTable && cachedTable.element && cachedTable.element.isConnected) {
      return cachedTable;
    }
    cachedTable = null;
    var el = getRoot().querySelector(".tabulator");
    if (!el) return null;
    cachedTable =
      fromGlobal(el) || fromElementProps(el) || fromReactFiber(el) || null;
    return cachedTable;
  }

  // ---- active row -------------------------------------------------------
  function activeRow(table) {
    // Preferred: Tabulator range selection API.
    try {
      if (typeof table.getRanges === "function") {
        var ranges = table.getRanges();
        if (ranges && ranges.length) {
          var rows = ranges[ranges.length - 1].getRows();
          if (rows && rows.length) return rows[0];
        }
      }
    } catch (e) {}
    // Fallback: map the DOM's active cell back to a row component.
    try {
      var r = getRoot();
      var cell =
        r.querySelector('.tabulator-cell[data-range="0"]') ||
        r.querySelector(".tabulator-cell.tabulator-range-selected");
      if (cell) {
        var rowEl = cell.closest(".tabulator-row");
        var all = table.getRows();
        for (var i = 0; i < all.length; i++) {
          if (all[i].getElement && all[i].getElement() === rowEl) return all[i];
        }
      }
    } catch (e) {}
    return null;
  }

  // Dispatch a native Delete on the active Local Confirm cell. The app clears
  // BOTH local_confirm and remarks on Delete, giving a clean slate before we
  // key the new value. Runs in the MAIN world so keyCode reaches the app.
  function pressDeleteOnConfirm() {
    var root = getRoot();
    var cell =
      root.querySelector('.tabulator-cell[tabulator-field="local_confirm"][data-range="0"]') ||
      root.querySelector('.tabulator-cell.tabulator-range-selected[tabulator-field="local_confirm"]') ||
      root.querySelector('.tabulator-cell[data-range="0"]');
    if (!cell) return;
    var ev = new KeyboardEvent("keydown", { key: "Delete", code: "Delete", bubbles: true, cancelable: true, composed: true });
    Object.defineProperty(ev, "keyCode", { get: function () { return 46; } });
    Object.defineProperty(ev, "which", { get: function () { return 46; } });
    cell.dispatchEvent(ev);
  }

  // ---- commit -----------------------------------------------------------
  function commit(payload) {
    var table = findTable();
    if (!table) return Promise.resolve({ ok: false, reason: "no-table" });
    var row = activeRow(table);
    if (!row) return Promise.resolve({ ok: false, reason: "no-row" });

    // If the row already holds a value/remark, clear it first via Delete so a
    // switch from N(+remark) to a non-N value doesn't leave a stale remark.
    var cur = {};
    try { cur = row.getData() || {}; } catch (e) {}
    if ((cur.local_confirm && cur.local_confirm !== "-") || cur.remarks) {
      pressDeleteOnConfirm();
    }

    var update = {};
    if (typeof payload.local_confirm !== "undefined") {
      update.local_confirm = payload.local_confirm;
    }
    if (typeof payload.remarks !== "undefined") {
      // The Remarks column is a plain text input; store the raw string.
      update.remarks = String(payload.remarks);
    }
    try {
      var res = row.update(update);
      if (res && typeof res.then === "function") {
        return res
          .then(function () {
            return { ok: true };
          })
          .catch(function (err) {
            return { ok: false, reason: "update-threw", detail: String(err) };
          });
      }
      return Promise.resolve({ ok: true });
    } catch (err) {
      return Promise.resolve({ ok: false, reason: "update-threw", detail: String(err) });
    }
  }

  // ---- navigation -------------------------------------------------------
  // Dispatch a native-style arrow keydown FROM THE MAIN WORLD so the app's
  // handler (which reads event.keyCode) sees the right code. A keyCode set
  // via Object.defineProperty in the content script's isolated world does
  // NOT cross into the page, so this must run here.
  function navigate(dir) {
    var code = dir === "up" ? "ArrowUp" : "ArrowDown";
    var keyCode = dir === "up" ? 38 : 40;
    var root = getRoot();
    var target =
      root.querySelector('.tabulator-cell[data-range="0"]') ||
      root.querySelector(".tabulator-cell.tabulator-range-selected") ||
      root.querySelector(".tabulator-tableholder") ||
      document.body;
    if (!target) return { ok: false, reason: "no-target" };
    var ev = new KeyboardEvent("keydown", {
      key: code,
      code: code,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    Object.defineProperty(ev, "keyCode", { get: function () { return keyCode; } });
    Object.defineProperty(ev, "which", { get: function () { return keyCode; } });
    target.dispatchEvent(ev);
    return { ok: true };
  }

  // Jump to the first / last row and select its Local Confirm cell. Scrolls
  // the row into view (Tabulator virtualises rows) then clicks the cell.
  function gotoRow(which) {
    var table = findTable();
    if (!table) return { ok: false, reason: "no-table" };
    var rows;
    try { rows = table.getRows(); } catch (e) { rows = null; }
    if (!rows || !rows.length) return { ok: false, reason: "no-rows" };
    var row = which === "last" ? rows[rows.length - 1] : rows[0];
    try { table.scrollToRow(row, which === "last" ? "bottom" : "top", false); } catch (e) {}
    setTimeout(function () {
      try {
        var el = row.getCell("local_confirm").getElement();
        if (el) {
          el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));
          el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, composed: true }));
        }
      } catch (e) {}
    }, 130);
    return { ok: true };
  }

  // ======================================================================
  // Smart hints: replace the native hint sidebar/highlights with our own
  // exact cross-product substring matcher (painted via the CSS Custom
  // Highlight API, so no DOM mutation and no fight with React).
  // ======================================================================
  var SENT = ""; // segment separator - never matches real text
  var SMART = { styleId: "spu-smart-hint-style", hideId: "spu-hide-native-style", names: [] };

  // Match colours ordered by salience. Matches are assigned these in priority
  // order (model<->model first), so the most important hints stand out; the
  // long tail (usually spec/description noise) falls back to a muted grey.
  var PRIORITY_COLORS = [
    "rgba(255, 205, 51, 0.75)",  // yellow
    "rgba(255, 82, 82, 0.55)",   // red
    "rgba(255, 145, 60, 0.60)",  // orange
    "rgba(66, 165, 245, 0.55)",  // blue
    "rgba(83, 201, 120, 0.55)",  // green
    "rgba(186, 104, 240, 0.55)", // purple
    "rgba(38, 198, 218, 0.55)",  // teal
    "rgba(240, 98, 176, 0.55)",  // pink
    "rgba(122, 173, 60, 0.55)",  // lime
  ];
  var MUTED_COLOR = "rgba(150, 160, 170, 0.40)";
  var DIM_COLOR = "rgba(255, 170, 20, 0.65)"; // matched product dimensions

  // Field labels -> canonical field type (drives match priority).
  var FIELD_LABELS = {
    "title": "title",
    "model name": "model",
    "variations": "variations",
    "product description": "description",
    "specification section": "spec",
  };
  function labelField(trimmed) {
    var key = trimmed.replace(/[:：]\s*$/, "").trim().toLowerCase();
    return FIELD_LABELS[key] || null;
  }

  // Structural UI labels to keep out of the matcher.
  var STOPLIST = {
    "Product Info": 1, "Product Description": 1, "Specification Section": 1,
    "Variations": 1, "Model Name": 1, "Title": 1, "Brand": 1, "Material": 1,
    "Connection Type": 1, "Keywords": 1, "Model Image": 1, "Item Image": 1,
    "Highlights & Hints": 1,
  };

  function styleHost() {
    var root = getRoot();
    return root && root.appendChild ? root : document.head;
  }
  function injectStyle(id, css) {
    var host = styleHost();
    var st = host.getElementById ? host.getElementById(id) : document.getElementById(id);
    if (!st) {
      st = document.createElement("style");
      st.id = id;
      host.appendChild(st);
    }
    st.textContent = css;
  }
  function removeStyle(id) {
    var host = styleHost();
    var st = host.getElementById ? host.getElementById(id) : document.getElementById(id);
    if (st) st.remove();
  }

  function getPanels() {
    var root = getRoot();
    var list = root.querySelectorAll(".relative.h-full.flex-1.overflow-auto.p-4");
    return [list[0], list[1]].filter(Boolean);
  }

  // Fold one char for matching: full-width -> half-width, then lower-case.
  // Always returns a single char so the folded string stays index-aligned
  // with the original (ranges map straight back to the real DOM offsets).
  var CN_MAP = (typeof window !== "undefined" && window.SPU_CN_MAP) || {};
  function foldChar(c) {
    var code = c.charCodeAt(0);
    if (code === 0x3000) return " "; // ideographic space
    if (code >= 0xff01 && code <= 0xff5e) c = String.fromCharCode(code - 0xfee0);
    // Canonicalise traditional Chinese to simplified so the two variants match.
    if (CN_MAP[c]) return CN_MAP[c];
    var lc = c.toLowerCase();
    return lc.length === 1 ? lc : c;
  }

  // Build a side's original text, a case/width-folded copy (same length, for
  // matching), a char-index -> {node, offset} map, AND a per-char field type.
  // Text nodes in the same field are concatenated (so matches can cross the
  // native highlight spans); a sentinel separates different fields. Field
  // labels ("Model Name", "Title", ...) switch the current field, and
  // variation VALUES (text after " : ") are dropped so they don't echo the
  // model name.
  // matching), a char-index -> {node, offset} map, AND a per-char field type.
  // Text nodes in the same field are concatenated (so matches can cross the
  // native highlight spans); a sentinel separates different fields. Field
  // labels ("Model Name", "Title", ...) switch the current field, and
  // variation VALUES (text after " : ") are dropped so they don't echo the
  // model name.
  function extractSide(panel) {
    var chars = [], norm = [], map = [], fields = [];
    var chars = [], norm = [], map = [], fields = [];
    var walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var t = node.nodeValue;
        if (!t || !t.trim()) return NodeFilter.FILTER_REJECT;
        var el = node.parentElement;
        if (el && el.closest(".highlight-tag")) return NodeFilter.FILTER_REJECT;
        if (/^\d+\s*(of|\/)\s*\d+$/i.test(t.trim())) return NodeFilter.FILTER_REJECT; // "1 of 6"
        if (/^\d+\s*(of|\/)\s*\d+$/i.test(t.trim())) return NodeFilter.FILTER_REJECT; // "1 of 6"
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    var prevGroup = null, currentField = "other";
    var prevGroup = null, currentField = "other";
    while (walker.nextNode()) {
      var node = walker.currentNode;
      var trimmed = node.nodeValue.trim();
      var lf = labelField(trimmed);
      if (lf) { currentField = lf; continue; }        // major label -> switch field
      var trimmed = node.nodeValue.trim();
      var lf = labelField(trimmed);
      if (lf) { currentField = lf; continue; }        // major label -> switch field
      var pe = node.parentElement;
      if (pe && pe.closest(".ant-typography-secondary")) continue; // sub-label
      if (STOPLIST[trimmed.replace(/[:：]$/, "")]) continue;        // structural
      if (pe && pe.closest(".ant-typography-secondary")) continue; // sub-label
      if (STOPLIST[trimmed.replace(/[:：]$/, "")]) continue;        // structural
      var group = (pe && pe.closest(".ant-typography")) || pe;
      if (prevGroup !== null && group !== prevGroup) {
        chars.push(SENT); norm.push(SENT); map.push(null); fields.push(null);
        chars.push(SENT); norm.push(SENT); map.push(null); fields.push(null);
      }
      prevGroup = group;
      var s = node.nodeValue;
      if (currentField === "variations") {
        // Keep only the variation label (text before " : "); the value echoes
        // the model name.
        var ci = s.indexOf(" : ");
        if (ci === -1) ci = s.indexOf("：");
        if (ci !== -1) s = s.slice(0, ci);
      }
      if (currentField === "variations") {
        // Keep only the variation label (text before " : "); the value echoes
        // the model name.
        var ci = s.indexOf(" : ");
        if (ci === -1) ci = s.indexOf("：");
        if (ci !== -1) s = s.slice(0, ci);
      }
      for (var i = 0; i < s.length; i++) {
        chars.push(s[i]); norm.push(foldChar(s[i])); map.push({ node: node, offset: i }); fields.push(currentField);
        chars.push(s[i]); norm.push(foldChar(s[i])); map.push({ node: node, offset: i }); fields.push(currentField);
      }
    }
    return { text: chars.join(""), norm: norm.join(""), map: map, fields: fields };
    return { text: chars.join(""), norm: norm.join(""), map: map, fields: fields };
  }

  // Distinct maximal common substrings (length >= minLen) between A and B.
  function computeMatches(A, B, minLen) {
    var n = A.length, m = B.length;
    if (!n || !m) return [];
    var prev = new Int32Array(m + 1), curr = new Int32Array(m + 1);
    var set = {};
    for (var i = 0; i < n; i++) {
      var ai = A[i];
      for (var j = 0; j < m; j++) {
        if (ai === B[j] && ai !== SENT) {
          var L = prev[j] + 1;
          curr[j + 1] = L;
          if (L >= minLen) {
            var extend = i + 1 < n && j + 1 < m && A[i + 1] === B[j + 1] && A[i + 1] !== SENT;
            if (!extend) set[A.substring(i - L + 1, i + 1)] = 1;
          }
        } else {
          curr[j + 1] = 0;
        }
      }
      var tmp = prev; prev = curr; curr = tmp;
    }
    var arr = Object.keys(set).filter(function (s) {
      var t = s.trim();
      return t.length >= minLen && /[\p{L}\p{N}]/u.test(t);
    });
    arr.sort(function (a, b) { return b.length - a.length || (a < b ? -1 : 1); });
    return arr;
  }

  // ASCII alphanumeric (the folded copy is lower-case). CJK is NOT alnum, so
  // the word-boundary rules below never apply to Chinese text.
  function isAlnum(ch) {
    return (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
  }
  function rangeFree(occ, i, L) { for (var k = i; k < i + L; k++) if (occ[k]) return false; return true; }
  function occupy(occ, i, L) { for (var k = i; k < i + L; k++) occ[k] = 1; }
  function addRange(side, start, end, key, buckets) {
    var a = side.map[start], b = side.map[end - 1];
    if (!a || !b) return;
    try {
      var range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset + 1);
      (buckets[key] || (buckets[key] = [])).push(range);
    } catch (e) {}
  }

  // Occurrences of s in text, each trimmed so it doesn't slice an ASCII
  // alphanumeric run at either end. "make" inside "maker" trims to nothing;
  // "0 cm long" from "70 cm long" trims the leading "0" -> " cm long". CJK is
  // never alnum, so Chinese matches are untouched.
  function trimmedOccurrences(text, s, minLen) {
    var L = s.length, out = [], from = 0, idx;
    while ((idx = text.indexOf(s, from)) !== -1) {
      from = idx + 1;
      var start = idx, end = idx + L;
      while (start < end && start > 0 && isAlnum(text.charAt(start)) && isAlnum(text.charAt(start - 1))) start++;
      while (end > start && end < text.length && isAlnum(text.charAt(end - 1)) && isAlnum(text.charAt(end))) end--;
      if (end - start >= minLen) out.push([start, end]);
    }
    return out;
  }

  // Product dimensions like "10x20x30", "30 * 10 * 20", "5×8" - order- and
  // separator/space-insensitive: canonicalise to sorted numbers.
  function findDims(norm) {
    var re = /\d+(?:\.\d+)?(?:\s*[x×*]\s*\d+(?:\.\d+)?)+/g, res = [], m;
    while ((m = re.exec(norm)) !== null) {
      var nums = m[0].match(/\d+(?:\.\d+)?/g);
      if (!nums || nums.length < 2) continue;
      var canon = nums.map(Number).sort(function (a, b) { return a - b; }).join("x");
      res.push({ start: m.index, end: m.index + m[0].length, canon: canon });
    }
    return res;
  }
  function markDims(left, right, buckets, lOcc, rOcc) {
    var dl = findDims(left.norm), dr = findDims(right.norm);
    if (!dl.length || !dr.length) return;
    var setL = {}; dl.forEach(function (d) { setL[d.canon] = 1; });
    var shared = {}; dr.forEach(function (d) { if (setL[d.canon]) shared[d.canon] = 1; });
    dl.forEach(function (d) { if (shared[d.canon]) { addRange(left, d.start, d.end, "dim", buckets); occupy(lOcc, d.start, d.end - d.start); } });
    dr.forEach(function (d) { if (shared[d.canon]) { addRange(right, d.start, d.end, "dim", buckets); occupy(rOcc, d.start, d.end - d.start); } });
  }

  // Importance of a field pairing (lower = more important). model<->model is
  // the strongest signal, then title<->title, then model/title combos, then
  // anything touching model/title, then the rest (spec/description/etc.).
  function pairTier(fa, fb) {
    if (fa === "model" && fb === "model") return 1;
    if (fa === "title" && fb === "title") return 2;
    if ((fa === "model" && fb === "title") || (fa === "title" && fb === "model")) return 3;
    if (fa === "model" || fb === "model" || fa === "title" || fb === "title") return 4;
    return 5;
  }
  function fieldsOf(occs, fieldsArr) {
    var set = {};
    occs.forEach(function (r) { var f = fieldsArr[r[0]]; if (f) set[f] = 1; });
    return Object.keys(set);
  }
  // If a match appears in the model field, drop its variation occurrences (they
  // just echo the model name) so multi-to-multi groups don't mix the two.
  function dropRedundantVariations(occs, fieldsArr) {
    var hasModel = occs.some(function (r) { return fieldsArr[r[0]] === "model"; });
    if (!hasModel) return occs;
    return occs.filter(function (r) { return fieldsArr[r[0]] !== "variations"; });
  }
  function bestTier(lFields, rFields) {
    var best = 99;
    for (var i = 0; i < lFields.length; i++) {
      for (var j = 0; j < rFields.length; j++) {
        var t = pairTier(lFields[i], rFields[j]);
        if (t < best) best = t;
      }
    }
    return best;
  }

  // Gather viable matches (trimmed, present on both sides), rank them by field
  // importance then length, and paint them in that order so the most important
  // hint (model<->model) gets the most salient colour.
  function markMatches(left, right, matches, buckets, lOcc, rOcc, minLen) {
    var viable = [];
    for (var mi = 0; mi < matches.length; mi++) {
      var s = matches[mi];
      var lo = trimmedOccurrences(left.norm, s, minLen);
      var ro = trimmedOccurrences(right.norm, s, minLen);
      if (!lo.length || !ro.length) continue;
      lo = dropRedundantVariations(lo, left.fields);
      ro = dropRedundantVariations(ro, right.fields);
      if (!lo.length || !ro.length) continue;
      var tier = bestTier(fieldsOf(lo, left.fields), fieldsOf(ro, right.fields));
      viable.push({ lo: lo, ro: ro, tier: tier, len: s.length });
    }
    // Colour rank: most important (model<->model, then longer) gets the most
    // salient colour.
    var ranked = viable.slice().sort(function (a, b) { return a.tier - b.tier || b.len - a.len; });
    ranked.forEach(function (v, i) { v.colorIdx = i; });
    // Placement: LONGEST first, so a big block (e.g. an identical title) claims
    // its whole span before short high-priority matches from other fields can
    // fragment it. Colour is independent of this order.
    viable.sort(function (a, b) { return b.len - a.len || a.tier - b.tier; });
    viable.forEach(function (v) {
      var lo = v.lo.filter(function (r) { return rangeFree(lOcc, r[0], r[1] - r[0]); });
      var ro = v.ro.filter(function (r) { return rangeFree(rOcc, r[0], r[1] - r[0]); });
      if (!lo.length || !ro.length) return;
      var key = "p" + v.colorIdx;
      lo.forEach(function (r) { addRange(left, r[0], r[1], key, buckets); occupy(lOcc, r[0], r[1] - r[0]); });
      ro.forEach(function (r) { addRange(right, r[0], r[1], key, buckets); occupy(rOcc, r[0], r[1] - r[0]); });
    });
  }

  function clearSmartHints() {
    SMART.names.forEach(function (n) { try { CSS.highlights.delete(n); } catch (e) {} });
    SMART.names = [];
    removeStyle(SMART.styleId);
  }

  function hideNativeHints(hide) {
    if (hide) {
      injectStyle(
        SMART.hideId,
        ".relative.mr-2{display:none !important;}" +
          "span[data-start][data-end]{background-color:transparent !important;}" +
          ".highlight-tag{display:none !important;}"
      );
    } else {
      removeStyle(SMART.hideId);
    }
  }

  function applySmartHints(minLen) {
    if (typeof Highlight === "undefined" || !(window.CSS && CSS.highlights)) {
      return { ok: false, reason: "no-highlight-api" };
    }
    var panels = getPanels();
    if (panels.length < 2) return { ok: false, reason: "no-panels" };
    minLen = minLen && minLen > 1 ? minLen : 4;
    var left = extractSide(panels[0]);
    var right = extractSide(panels[1]);
    var buckets = {};
    var lOcc = new Uint8Array(left.norm.length);
    var rOcc = new Uint8Array(right.norm.length);

    // Dimensions first (order-independent) so substring matching won't split them.
    markDims(left, right, buckets, lOcc, rOcc);

    // Substring matches, ranked by field importance (model<->model first).
    var matches = computeMatches(left.norm, right.norm, minLen);
    markMatches(left, right, matches, buckets, lOcc, rOcc, minLen);

    clearSmartHints();
    var css = "";
    Object.keys(buckets).forEach(function (key) {
      var color;
      if (key === "dim") {
        color = DIM_COLOR;
      } else {
        var idx = parseInt(key.slice(1), 10); // "p<idx>"
        color = idx < PRIORITY_COLORS.length ? PRIORITY_COLORS[idx] : MUTED_COLOR;
      }
      var name = "spu-hl-" + key;
      var hl = new Highlight();
      buckets[key].forEach(function (rg) { hl.add(rg); });
      CSS.highlights.set(name, hl);
      SMART.names.push(name);
      css += "::highlight(" + name + "){background-color:" + color + ";border-radius:2px;}\n";
    });
    injectStyle(SMART.styleId, css);
    return { ok: true };
  }

  // Locate the native "Highlights & Hints" toggle (label + ant-switch button).
  function nativeToggle() {
    var root = getRoot();
    var all = root.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (e.children.length === 0 && /Highlights & Hints/.test(e.textContent || "")) {
        var container = e.parentElement;
        var sw = container && container.querySelector('button[role="switch"]');
        return { container: container, sw: sw };
      }
    }
    return null;
  }

  // Turn the native highlighter OFF at the source (so it stops splitting the
  // product text into <span data-start> elements) and hide its toggle. The
  // toggle only exists in the first product, so hiding it also re-aligns the
  // two panels. Returns true if we just flipped it off (DOM will re-render).
  function disableNativeHighlights() {
    var t = nativeToggle();
    if (!t) return false;
    var flipped = false;
    if (t.sw && t.sw.getAttribute("aria-checked") === "true") {
      t.sw.click();
      flipped = true;
    }
    if (t.container) t.container.style.display = "none";
    return flipped;
  }

  function restoreNativeHighlights() {
    var t = nativeToggle();
    if (!t) return;
    if (t.container) t.container.style.display = "";
    if (t.sw && t.sw.getAttribute("aria-checked") === "false") t.sw.click();
  }

  function smartHints(payload) {
    if (payload && payload.enabled) {
      var flipped = disableNativeHighlights();
      var res = applySmartHints(payload.minLen);
      hideNativeHints(res.ok); // only hide native if our highlighting worked
      // Flipping the toggle re-renders the text (un-splits it) asynchronously;
      // re-run once the DOM settles so ranges land on the clean nodes.
      if (flipped && res.ok) {
        setTimeout(function () { applySmartHints(payload.minLen); }, 120);
      }
      return res;
    }
    clearSmartHints();
    hideNativeHints(false);
    restoreNativeHighlights();
    return { ok: true, disabled: true };
  }

  function probe() {
    var table = findTable();
    return {
      ok: !!table,
      hasTable: !!table,
      hasRow: !!(table && activeRow(table)),
    };
  }

  // ---- message bridge ---------------------------------------------------
  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__ch !== MSG || d.dir !== "req") return;

    function reply(result) {
      window.postMessage(
        { __ch: MSG, dir: "res", id: d.id, result: result },
        "*"
      );
    }

    try {
      if (d.action === "commit") {
        commit(d.payload || {}).then(reply);
      } else if (d.action === "navigate") {
        reply(navigate((d.payload && d.payload.dir) || "down"));
      } else if (d.action === "gotoRow") {
        reply(gotoRow((d.payload && d.payload.which) || "first"));
      } else if (d.action === "smartHints") {
        reply(smartHints(d.payload || {}));
      } else if (d.action === "probe") {
        reply(probe());
      } else {
        reply({ ok: false, reason: "unknown-action" });
      }
    } catch (err) {
      reply({ ok: false, reason: "adapter-threw", detail: String(err) });
    }
  });
})();
