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

  // A whole field identical on both sides (e.g. same model name) -> yellow,
  // echoing the native "these are the same" cue. Partial matches cycle
  // through distinct colours, longest first (so the title run tends to red).
  var YELLOW = "rgba(255, 205, 51, 0.7)";
  var COLORS = [
    "rgba(255, 82, 82, 0.50)",   // red
    "rgba(83, 201, 120, 0.50)",  // green
    "rgba(66, 165, 245, 0.50)",  // blue
    "rgba(255, 145, 60, 0.55)",  // orange
    "rgba(186, 104, 240, 0.50)", // purple
    "rgba(38, 198, 218, 0.50)",  // teal
    "rgba(240, 98, 176, 0.50)",  // pink
    "rgba(122, 173, 60, 0.50)",  // lime
    "rgba(120, 144, 156, 0.50)", // blue-grey
  ];
  var DIM_COLOR = "rgba(255, 170, 20, 0.6)"; // matched product dimensions

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
  // matching), and a char-index -> {node, offset} map. Text nodes in the same
  // field are concatenated (so matches can cross the native highlight spans);
  // a sentinel separates different fields.
  function extractSide(panel) {
    var chars = [], norm = [], map = [];
    var walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var t = node.nodeValue;
        if (!t || !t.trim()) return NodeFilter.FILTER_REJECT;
        var el = node.parentElement;
        if (el && el.closest(".ant-typography-secondary")) return NodeFilter.FILTER_REJECT;
        if (el && el.closest(".highlight-tag")) return NodeFilter.FILTER_REJECT;
        var trimmed = t.trim();
        if (STOPLIST[trimmed.replace(/[:：]$/, "")]) return NodeFilter.FILTER_REJECT;
        if (/^\d+\s*(of|\/)\s*\d+$/i.test(trimmed)) return NodeFilter.FILTER_REJECT; // "1 of 6" image counter
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    var prevGroup = null;
    while (walker.nextNode()) {
      var node = walker.currentNode;
      var pe = node.parentElement;
      var group = (pe && pe.closest(".ant-typography")) || pe;
      if (prevGroup !== null && group !== prevGroup) {
        chars.push(SENT); norm.push(SENT); map.push(null);
      }
      prevGroup = group;
      var s = node.nodeValue;
      for (var i = 0; i < s.length; i++) {
        chars.push(s[i]); norm.push(foldChar(s[i])); map.push({ node: node, offset: i });
      }
    }
    return { text: chars.join(""), norm: norm.join(""), map: map };
  }

  // Set of whole-field strings on a side (segments between sentinels).
  function fieldSet(text) {
    var set = Object.create(null);
    text.split(SENT).forEach(function (seg) {
      var t = seg.trim();
      if (t.length >= 2) set[t] = 1;
    });
    return set;
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

  // Mark substring matches longest-first. A match is only highlighted if it has
  // a trimmed, free occurrence on BOTH sides (so half-word matches are dropped).
  function markMatches(left, right, matches, colorOf, buckets, lOcc, rOcc, minLen) {
    for (var mi = 0; mi < matches.length; mi++) {
      var s = matches[mi];
      var lo = trimmedOccurrences(left.norm, s, minLen).filter(function (r) { return rangeFree(lOcc, r[0], r[1] - r[0]); });
      var ro = trimmedOccurrences(right.norm, s, minLen).filter(function (r) { return rangeFree(rOcc, r[0], r[1] - r[0]); });
      if (!lo.length || !ro.length) continue;
      var key = colorOf[s];
      lo.forEach(function (r) { addRange(left, r[0], r[1], key, buckets); occupy(lOcc, r[0], r[1] - r[0]); });
      ro.forEach(function (r) { addRange(right, r[0], r[1], key, buckets); occupy(rOcc, r[0], r[1] - r[0]); });
    }
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

    // Substring matches: full-field-identical -> yellow; others cycle COLORS.
    var matches = computeMatches(left.norm, right.norm, minLen);
    var lf = fieldSet(left.norm), rf = fieldSet(right.norm);
    var colorOf = {}, other = 0;
    matches.forEach(function (s) {
      var t = s.trim();
      colorOf[s] = lf[t] && rf[t] ? "y" : "c" + (other++ % COLORS.length);
    });
    markMatches(left, right, matches, colorOf, buckets, lOcc, rOcc, minLen);

    clearSmartHints();
    var css = "";
    Object.keys(buckets).forEach(function (key) {
      var name = "spu-hl-" + key;
      var color = key === "dim" ? DIM_COLOR : key === "y" ? YELLOW : COLORS[parseInt(key.slice(1), 10) % COLORS.length];
      var hl = new Highlight();
      buckets[key].forEach(function (rg) { hl.add(rg); });
      CSS.highlights.set(name, hl);
      SMART.names.push(name);
      css += "::highlight(" + name + "){background-color:" + color + ";border-radius:2px;}\n";
    });
    injectStyle(SMART.styleId, css);
    return { ok: true };
  }

  function smartHints(payload) {
    if (payload && payload.enabled) {
      var res = applySmartHints(payload.minLen);
      hideNativeHints(res.ok); // only hide native if our highlighting worked
      return res;
    }
    clearSmartHints();
    hideNativeHints(false);
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
