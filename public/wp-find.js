/*
 * Fusion Private Browser — bounded, live in-page find (TT85 / PR-07n).
 * Original dependency-free code. Runs only inside a proxied document and never
 * observes outside that document. The UI owns the query; this module owns a
 * transient text index and the current DOM Range.
 *
 * Contract: case-insensitive Unicode default lower-casing; runs of Unicode
 * whitespace collapse to one space; matches can cross inline and block text
 * boundaries; hidden/inert/aria-hidden content and script/style/template text
 * are excluded. The scan is bounded to 512 Ki UTF-16 code units and 50,000 DOM
 * nodes; the result explicitly says when that prefix was truncated. Shadow DOM,
 * nested frames, form-control values, image alt text, and canvas pixels are not
 * searched. No document text or query leaves this frame.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.FusionWpFind = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var MAX_TEXT = 512 * 1024;
  var MAX_NODES = 50000;
  var SKIP = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, TITLE: 1,
    IFRAME: 1, FRAME: 1, OBJECT: 1, EMBED: 1, NOEMBED: 1, NOFRAMES: 1,
    PLAINTEXT: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1,
  };

  function normalizeQuery(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim().toLowerCase();
  }

  function isVisible(el, view) {
    if (el.hidden || el.inert || (el.getAttribute && String(el.getAttribute("aria-hidden")).toLowerCase() === "true")) return false;
    if (typeof el.checkVisibility === "function") {
      try {
        return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true });
      } catch (_) {
        try { return el.checkVisibility(); } catch (_) { /* use computed style below */ }
      }
    }
    try {
      var s = view.getComputedStyle(el);
      return !!s && s.display !== "none" && s.visibility !== "hidden" && s.visibility !== "collapse" && Number(s.opacity) !== 0;
    } catch (_) { return true; }
  }

  function isBlock(el, view) {
    var tag = String(el.nodeName || "").toUpperCase();
    if (tag === "BR" || tag === "HR") return true;
    try {
      var d = view.getComputedStyle(el).display;
      return /^(block|flow-root|flex|grid|table|table-row|table-cell|table-caption|table-row-group|table-header-group|table-footer-group|list-item)$/.test(d);
    } catch (_) {
      return /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BODY|CAPTION|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TBODY|TD|TFOOT|TH|THEAD|TR|UL)$/.test(tag);
    }
  }

  function buildIndex(doc, limits) {
    var view = doc.defaultView;
    var maxText = limits && Number.isFinite(limits.maxText) ? Math.max(1, Math.min(MAX_TEXT, Math.floor(limits.maxText))) : MAX_TEXT;
    var maxNodes = limits && Number.isFinite(limits.maxNodes) ? Math.max(1, Math.min(MAX_NODES, Math.floor(limits.maxNodes))) : MAX_NODES;
    var text = "";
    var segments = [];
    var truncated = false;
    var visited = 0;
    var lastSource = null;
    var rootNode = doc.body || doc.documentElement;
    if (!rootNode) return { text: "", segments: segments, truncated: false, visited: 0 };

    function addPiece(piece, node, start, end, artificial, linearOverride) {
      if (!piece) return true;
      var folded = piece.toLowerCase();
      if (text.length + folded.length > maxText) { truncated = true; return false; }
      var from = text.length;
      text += folded;
      var to = text.length;
      var linear = typeof linearOverride === "boolean" ? linearOverride : !artificial && folded.length === piece.length && end - start === folded.length;
      var prev = segments.length ? segments[segments.length - 1] : null;
      if (linear && prev && prev.linear && !prev.artificial && prev.node === node && prev.to === from && prev.sourceEnd === start) {
        prev.to = to;
        prev.sourceEnd = end;
      } else {
        segments.push({ from: from, to: to, node: node, sourceStart: start, sourceEnd: end, linear: linear, artificial: !!artificial, space: piece === " " });
      }
      return true;
    }

    function addSpace(node, start, end, artificial) {
      if (!text.length) return true;
      if (text.charAt(text.length - 1) === " ") {
        var prev = segments.length ? segments[segments.length - 1] : null;
        if (prev && prev.space && !prev.artificial && prev.node === node && prev.to === text.length) {
          prev.sourceEnd = end;
          prev.linear = false;
        }
        return true;
      }
      // A collapsed whitespace run is a non-linear segment: its one indexed space may span one or many source units.
      // Keep it separate from neighboring text so each match boundary maps to the full original whitespace run.
      return addPiece(" ", node, start, end, !!artificial, false);
    }

    function appendText(node) {
      var s = String(node.nodeValue || "");
      var i = 0;
      while (i < s.length) {
        var cp = s.codePointAt(i);
        var ch = String.fromCodePoint(cp);
        var next = i + ch.length;
        if (/^\s+$/.test(ch)) {
          if (text.length) {
            if (!addSpace(node, i, next, false)) return false;
          }
        } else if (!addPiece(ch, node, i, next, false)) return false;
        lastSource = { node: node, end: next };
        i = next;
      }
      return true;
    }

    function separator() {
      return lastSource ? addSpace(lastSource.node, lastSource.end, lastSource.end, true) : true;
    }

    var stack = [{ node: rootNode, exit: false, block: false }];
    while (stack.length && !truncated) {
      var item = stack.pop();
      var n = item.node;
      visited++;
      if (visited > maxNodes) { truncated = true; break; }
      if (item.exit) {
        if (item.block) separator();
        continue;
      }
      if (n.nodeType === 3) {
        appendText(n);
        continue;
      }
      if (n.nodeType !== 1) continue;
      var tag = String(n.nodeName || "").toUpperCase();
      if (SKIP[tag] || !isVisible(n, view)) continue;
      if (tag === "BR" || tag === "HR") { separator(); continue; }
      var block = isBlock(n, view);
      if (block) separator();
      stack.push({ node: n, exit: true, block: block });
      for (var child = n.lastChild; child; child = child.previousSibling) stack.push({ node: child, exit: false, block: false });
    }
    // A trailing separator is not reader-visible text and can create a bogus hit.
    if (text.charAt(text.length - 1) === " ") {
      text = text.slice(0, -1);
      var last = segments[segments.length - 1];
      if (last && last.to > text.length) {
        last.to = text.length;
        if (last.from >= last.to) segments.pop();
      }
    }
    return { text: text, segments: segments, truncated: truncated, visited: visited };
  }

  function pointAt(index, isEnd, text, segments) {
    var lo = 0, hi = segments.length;
    while (lo < hi) {
      var mid = (lo + hi) >>> 1;
      if (segments[mid].to <= index) lo = mid + 1;
      else hi = mid;
    }
    var s = segments[lo];
    if (!s || index < s.from) return null;
    if (!s.linear) return { node: s.node, offset: isEnd ? s.sourceEnd : s.sourceStart };
    var offset = s.sourceStart + (index - s.from) + (isEnd ? 1 : 0);
    // Keep a match boundary outside a UTF-16 surrogate pair.
    if (!isEnd && index > 0 && index < text.length) {
      var here = text.charCodeAt(index), before = text.charCodeAt(index - 1);
      if (here >= 0xdc00 && here <= 0xdfff && before >= 0xd800 && before <= 0xdbff) offset--;
    } else if (isEnd && index + 1 < text.length) {
      var endHere = text.charCodeAt(index), after = text.charCodeAt(index + 1);
      if (endHere >= 0xd800 && endHere <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) offset++;
    }
    return { node: s.node, offset: offset };
  }

  function collectHits(index, query) {
    var hits = [];
    if (!query) return hits;
    var from = 0, at;
    while ((at = index.text.indexOf(query, from)) >= 0) {
      var start = pointAt(at, false, index.text, index.segments);
      var end = pointAt(at + query.length - 1, true, index.text, index.segments);
      if (start && end) hits.push({ start: start, end: end });
      var cp = index.text.codePointAt(at);
      from = at + (cp > 0xffff ? 2 : 1); // overlapping matches are real matches ("ana" occurs twice in "banana")
    }
    return hits;
  }

  function create(doc, onResult, limits) {
    var hits = [];
    var current = -1;
    var lastQuery = null;
    var lastValue = "";
    var dirty = true;
    var truncated = false;
    var owned = null;
    var timer = 0;
    var closed = false;
    var observer = null;
    var view = doc.defaultView;

    function sameRange(a, b) {
      return a && b && a.startContainer === b.startContainer && a.startOffset === b.startOffset && a.endContainer === b.endContainer && a.endOffset === b.endOffset;
    }
    function selectionIsOwned() {
      if (!owned || !view || !view.getSelection) return false;
      var sel = view.getSelection();
      if (!sel || sel.rangeCount !== 1) return false;
      try { return sameRange(sel.getRangeAt(0), owned); } catch (_) { return false; }
    }
    function clearOwned() {
      if (!owned) return;
      var wasOwned = selectionIsOwned();
      owned = null;
      if (wasOwned) {
        try { view.getSelection().removeAllRanges(); } catch (_) { /* document detached */ }
      }
    }
    function notify() {
      if (typeof onResult === "function") onResult({ q: lastValue, n: hits.length, i: hits.length && current >= 0 ? current + 1 : 0, truncated: truncated });
    }
    function rebuild(query) {
      var index = buildIndex(doc, limits);
      hits = collectHits(index, query);
      truncated = index.truncated;
      dirty = false;
    }
    function select(hit, shouldScroll) {
      if (!hit || !doc.createRange || !view || !view.getSelection) return false;
      try {
        var range = doc.createRange();
        range.setStart(hit.start.node, hit.start.offset);
        range.setEnd(hit.end.node, hit.end.offset);
        var selection = view.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        owned = range.cloneRange();
        if (shouldScroll && hit.start.node.parentElement && typeof hit.start.node.parentElement.scrollIntoView === "function") {
          hit.start.node.parentElement.scrollIntoView({ block: "center", inline: "nearest" });
        }
        return true;
      } catch (_) { owned = null; return false; }
    }
    function refreshAfterMutation() {
      timer = 0;
      if (closed || !dirty || !lastQuery) return;
      var ownedBefore = selectionIsOwned();
      var previous = current;
      rebuild(lastQuery);
      current = hits.length && previous >= 0 ? Math.min(previous, hits.length - 1) : -1;
      if (!hits.length || !ownedBefore) clearOwned();
      else select(hits[current], false);
      notify();
    }
    function changed() {
      dirty = true;
      if (!lastQuery || timer || closed || !view || typeof view.setTimeout !== "function") return;
      timer = view.setTimeout(refreshAfterMutation, 50);
    }

    if (typeof MutationObserver !== "undefined" && doc.documentElement) {
      try {
        observer = new MutationObserver(changed);
        observer.observe(doc.documentElement, {
          subtree: true, childList: true, characterData: true, attributes: true,
          attributeFilter: ["class", "style", "hidden", "aria-hidden", "inert"],
        });
      } catch (_) { observer = null; }
    }

    return {
      find: function (value, direction) {
        if (closed) return { n: 0, i: 0, truncated: false };
        var rawQuery = String(value == null ? "" : value);
        var query = normalizeQuery(rawQuery);
        lastValue = rawQuery;
        var isNew = query !== lastQuery;
        var dir = Number(direction) < 0 ? -1 : 1;
        var previous = current;
        if (isNew || dirty) {
          lastQuery = query;
          rebuild(query);
          // A live document mutation changes the hit list, not the user's place in it. Preserve the current
          // ordinal (clamped to the new list) unless this is a genuinely new query.
          current = isNew ? -1 : hits.length && previous >= 0 ? Math.min(previous, hits.length - 1) : -1;
          if (isNew && query && dir < 0) current = 0;
        }
        if (!query) {
          current = -1;
          clearOwned();
          notify();
          return { n: 0, i: 0, truncated: truncated };
        }
        if (!hits.length) {
          current = -1;
          clearOwned();
          notify();
          return { n: 0, i: 0, truncated: truncated };
        }
        current = (current + dir + hits.length) % hits.length;
        select(hits[current], true);
        notify();
        return { n: hits.length, i: current + 1, truncated: truncated };
      },
      destroy: function () {
        closed = true;
        if (observer) observer.disconnect();
        if (timer && view) view.clearTimeout(timer);
        timer = 0;
        clearOwned();
      },
    };
  }

  return { create: create, buildIndex: buildIndex, normalizeQuery: normalizeQuery, _collectHits: collectHits, MAX_TEXT: MAX_TEXT, MAX_NODES: MAX_NODES };
});
