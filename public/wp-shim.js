/*
 * Fusion web proxy — in-page runtime (TT35). Original code, plain ES2017, no dependencies.
 *
 * Runs first in every proxied document. The document lives in an opaque origin (CSP sandbox) and its CSP only
 * allows loads from the Fusion server, so anything this runtime misses FAILS CLOSED (blocked or 404) instead of
 * leaking a request to a third party. Its job is to make sites work: route the URLs that scripts build at run time
 * back through the proxy, and stand in for the storage APIs an opaque origin is denied.
 *
 * Declared limits: scripts that read window.location see the proxy address (location cannot be redefined);
 * WebSockets are not proxied (the CSP refuses them); storage is per page and in memory only.
 */
(function (W) {
  "use strict";
  var D = W.document;
  var me = D && D.currentScript;
  if (!me || !me.dataset || !me.dataset.fusionWp) return;
  var PREFIX = "/api/wp/s/";
  var SID = me.dataset.sid;
  var TARGET = me.dataset.url;
  var UA_KIND = me.dataset.ua === "mobile" ? "mobile" : "desktop";
  var L = W.location;
  var HERE = L.protocol + "//" + L.host; // location keeps the URL's origin even in an opaque-origin document
  var PASS = /^(data|blob|javascript|mailto|tel|sms|about|ftp|ws|wss|intent|geo|magnet|chrome|file):/i;
  var beacons = 0;

  /** our URL (absolute or path) → the target URL it stands for, or null */
  function decode(u) {
    var x;
    try { x = new URL(String(u), L.href); } catch (e) { return null; }
    if (x.host !== L.host || x.pathname.indexOf(PREFIX) !== 0) return null;
    var p = x.pathname.slice(PREFIX.length).split("/");
    if (p.length < 3 || (p[1] !== "http" && p[1] !== "https")) return null;
    return p[1] + "://" + p[2] + "/" + p.slice(3).join("/") + x.search + x.hash;
  }
  function currentTarget() { return decode(L.href) || TARGET; }
  function targetBase() { return decode(D.baseURI) || currentTarget(); }

  /** any URL a page uses → the proxied path (mirror of encodeTarget / rewriteUrl in src/lib/wp-core.ts) */
  function enc(u) {
    if (u === null || u === undefined) return u;
    var s = String(u), t = s.trim();
    if (!t || t.charAt(0) === "#" || PASS.test(t)) return s;
    if (t.indexOf(PREFIX) === 0 || t.indexOf(HERE + PREFIX) === 0) return s; // already ours
    var abs;
    try { abs = new URL(t, targetBase()); } catch (e) { return s; }
    if (abs.host === L.host && abs.protocol === L.protocol) {
      if (abs.pathname.indexOf(PREFIX) === 0) return abs.pathname + abs.search + abs.hash;
      // a URL built from location.origin / location.host: it meant the target site's root
      abs = new URL(abs.pathname + abs.search + abs.hash, new URL(currentTarget()).origin);
    }
    if ((abs.protocol !== "http:" && abs.protocol !== "https:") || abs.username || abs.password) return s;
    return PREFIX + SID + "/" + abs.protocol.slice(0, -1) + "/" + abs.host + abs.pathname + abs.search + abs.hash;
  }
  function encSrcset(v) {
    return String(v).split(/,(?=\s)|,$/).map(function (c) {
      var m = /^(\s*)(\S+)(.*)$/.exec(c);
      return m ? m[1] + enc(m[2]) + m[3] : c;
    }).join(",");
  }
  W.__fusionWp = { enc: enc, decode: decode, encSrcset: encSrcset, target: currentTarget };
  if (typeof W.HTMLElement === "undefined") return; // not a browser (unit tests load this file for the codec)

  function guard(f) { try { f(); } catch (e) { /* one failed patch must not stop the others */ } }

  // ---- network APIs
  guard(function () {
    var _fetch = W.fetch;
    W.fetch = function (input, init) {
      var i = input, o = Object.assign({}, init || {}, { credentials: "omit" }); // credentials never cross the proxy
      var mode = o.mode || (i && typeof i === "object" && i.mode) || "", proxied;
      if (typeof i === "string" || (W.URL && i instanceof URL)) i = proxied = enc(String(i));
      else if (i && i.url) i = new Request(proxied = enc(i.url), i); // method, headers and body come along; o.mode overrides below
      // "same-origin" can never be met from the page's opaque origin. A request the SITE would have made to ITSELF goes
      // as "cors" (the proxy answers with ACAO *); a request to another site keeps "same-origin" and fails, as natively.
      if (mode === "same-origin") {
        var to = decode(proxied), here = currentTarget();
        try { if (to && new URL(to).origin === new URL(here).origin) o.mode = "cors"; } catch (e) { /* keep the page's mode */ }
      }
      return _fetch.call(this, i, o);
    };
    W.__fusionWp.rawFetch = _fetch;
  });
  guard(function () {
    var X = W.XMLHttpRequest.prototype, _open = X.open;
    X.open = function (m, u) { var a = Array.prototype.slice.call(arguments); a[1] = enc(u); return _open.apply(this, a); };
    Object.defineProperty(X, "withCredentials", { configurable: true, get: function () { return false; }, set: function () {} });
  });
  guard(function () { W.navigator.sendBeacon = function () { beacons++; return true; }; }); // tracking beacons go nowhere
  guard(function () { var _open = W.open; W.open = function (u, n, f) { return _open.call(W, u === undefined ? u : enc(u), n, f); }; });
  guard(function () {
    ["pushState", "replaceState"].forEach(function (k) {
      var f = W.history[k];
      W.history[k] = function (st, title, u) { var r = f.call(this, st, title, u === undefined || u === null ? u : enc(u)); report(); return r; };
    });
  });

  // ---- DOM properties and attributes that load or navigate
  var PROPS = [["HTMLImageElement", "src"], ["HTMLScriptElement", "src"], ["HTMLLinkElement", "href"], ["HTMLIFrameElement", "src"], ["HTMLFrameElement", "src"],
    ["HTMLSourceElement", "src"], ["HTMLMediaElement", "src"], ["HTMLEmbedElement", "src"], ["HTMLTrackElement", "src"], ["HTMLInputElement", "src"],
    ["HTMLFormElement", "action"], ["HTMLAnchorElement", "href"], ["HTMLAreaElement", "href"], ["HTMLObjectElement", "data"], ["HTMLVideoElement", "poster"],
    ["HTMLButtonElement", "formAction"], ["HTMLInputElement", "formAction"]];
  PROPS.forEach(function (p) {
    guard(function () {
      var C = W[p[0]]; if (!C) return;
      var d = Object.getOwnPropertyDescriptor(C.prototype, p[1]); if (!d || !d.set) return;
      Object.defineProperty(C.prototype, p[1], {
        configurable: true, enumerable: d.enumerable,
        get: function () { var v = d.get.call(this); return decode(v) || v; }, // the page reads back the address it set
        set: function (v) { d.set.call(this, enc(v)); },
      });
    });
  });
  [["HTMLImageElement", "srcset"], ["HTMLSourceElement", "srcset"]].forEach(function (p) {
    guard(function () {
      var C = W[p[0]], d = C && Object.getOwnPropertyDescriptor(C.prototype, p[1]); if (!d || !d.set) return;
      Object.defineProperty(C.prototype, p[1], { configurable: true, enumerable: d.enumerable, get: d.get, set: function (v) { d.set.call(this, encSrcset(v)); } });
    });
  });
  var ATTR = { src: 1, href: 1, action: 1, formaction: 1, poster: 1, background: 1 };
  var _setAttr = W.Element.prototype.setAttribute;
  function fixAttr(el, name, value) {
    var k = String(name).toLowerCase();
    if (ATTR[k] || (k === "data" && el.tagName === "OBJECT")) return enc(value);
    if (k === "srcset" || k === "imagesrcset") return encSrcset(value);
    return value;
  }
  guard(function () {
    W.Element.prototype.setAttribute = function (n, v) {
      var k = String(n).toLowerCase();
      if (k === "integrity" || k === "ping") return undefined; // content is re-served by us; pings are tracking
      return _setAttr.call(this, n, fixAttr(this, n, v));
    };
  });
  // markup inserted with innerHTML / insertAdjacentHTML bypasses the setters: fix it as it lands
  guard(function () {
    var SEL = "[src],[href],[action],[formaction],[poster],[srcset],[background],object[data]";
    function fix(el) {
      if (!el || el.nodeType !== 1) return;
      var list = el.matches && el.matches(SEL) ? [el] : [];
      if (el.querySelectorAll) list = list.concat(Array.prototype.slice.call(el.querySelectorAll(SEL)));
      list.forEach(function (x) {
        for (var i = 0; i < x.attributes.length; i++) {
          var a = x.attributes[i], nv = fixAttr(x, a.name, a.value);
          if (nv !== a.value) _setAttr.call(x, a.name, nv);
        }
      });
    }
    new MutationObserver(function (recs) {
      recs.forEach(function (r) {
        if (r.type === "attributes") { var v = r.target.getAttribute(r.attributeName); if (v !== null) { var nv = fixAttr(r.target, r.attributeName, v); if (nv !== v) _setAttr.call(r.target, r.attributeName, nv); } }
        else for (var i = 0; i < r.addedNodes.length; i++) fix(r.addedNodes[i]);
      });
    }).observe(D.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "href", "action", "formaction", "poster", "srcset", "background", "data"] });
  });

  // ---- navigation that slips past the rewriting (location.href = "/x", unrewritten links): catch it in flight
  guard(function () {
    var N = W.navigation;
    if (!N || !N.addEventListener) return;
    N.addEventListener("navigate", function (e) {
      var dst = e.destination && e.destination.url;
      if (!dst || decode(dst) || !e.cancelable) return;
      var fixed = enc(dst);
      if (fixed === dst) return;
      e.preventDefault();
      L.href = fixed;
    });
  });
  guard(function () {
    D.addEventListener("click", function (e) {
      var a = e.target && e.target.closest ? e.target.closest("a[href],area[href]") : null;
      if (a) { var h = a.getAttribute("href"); var nh = enc(h); if (nh !== h) _setAttr.call(a, "href", nh); }
    }, true);
    D.addEventListener("submit", function (e) {
      var f = e.target, act = f && f.getAttribute && f.getAttribute("action");
      if (act !== null && act !== undefined) { var na = enc(act); if (na !== act) _setAttr.call(f, "action", na); }
    }, true);
  });

  // ---- storage an opaque origin is denied: in-memory stand-ins (never persisted — amnesic by design)
  guard(function () {
    var jar = {};
    String(me.dataset.cookies || "").split(/;\s*/).forEach(function (kv) { if (!kv) return; var i = kv.indexOf("="); jar[i < 0 ? "" : kv.slice(0, i)] = i < 0 ? kv : kv.slice(i + 1); });
    var raw = W.__fusionWp.rawFetch;
    Object.defineProperty(W.Document.prototype, "cookie", {
      configurable: true,
      get: function () { return Object.keys(jar).map(function (k) { return k ? k + "=" + jar[k] : jar[k]; }).join("; "); },
      set: function (v) {
        var s = String(v), pair = s.split(";")[0], i = pair.indexOf("=");
        var k = (i < 0 ? "" : pair.slice(0, i)).trim(), val = (i < 0 ? pair : pair.slice(i + 1)).trim();
        var ma = /;\s*max-age\s*=\s*(-?\d+)/i.exec(s), ex = /;\s*expires\s*=\s*([^;]+)/i.exec(s);
        if (/;\s*httponly/i.test(s)) return;
        if ((ma && Number(ma[1]) <= 0) || (!ma && ex && Date.parse(ex[1]) < Date.now())) delete jar[k]; else jar[k] = val;
        if (raw) raw.call(W, PREFIX + SID + "/__cookie", { method: "POST", credentials: "omit", keepalive: true, headers: { "content-type": "text/plain" }, body: JSON.stringify({ url: currentTarget(), cookie: s }) }).catch(function () {});
      },
    });
  });
  function memStorage() {
    var m = {};
    return {
      get length() { return Object.keys(m).length; },
      key: function (i) { var k = Object.keys(m)[i]; return k === undefined ? null : k; },
      getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      setItem: function (k, v) { m[String(k)] = String(v); },
      removeItem: function (k) { delete m[String(k)]; },
      clear: function () { m = {}; },
    };
  }
  ["localStorage", "sessionStorage"].forEach(function (k) {
    guard(function () {
      var ok = false;
      try { ok = !!W[k] && (W[k].getItem("__fwp"), true); } catch (e) { ok = false; }
      if (!ok) { var st = memStorage(); Object.defineProperty(W, k, { configurable: true, get: function () { return st; } }); }
    });
  });

  // ---- one coherent identity: the same user agent the server sends (PR-07h)
  guard(function () {
    var UAS = {
      desktop: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      mobile: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
    };
    var P = W.Navigator.prototype;
    Object.defineProperty(P, "userAgent", { configurable: true, get: function () { return UAS[UA_KIND]; } });
    Object.defineProperty(P, "appVersion", { configurable: true, get: function () { return UAS[UA_KIND].slice(8); } });
    Object.defineProperty(P, "platform", { configurable: true, get: function () { return UA_KIND === "mobile" ? "Linux armv8l" : "Win32"; } });
    Object.defineProperty(P, "maxTouchPoints", { configurable: true, get: function () { return UA_KIND === "mobile" ? 5 : 0; } });
    Object.defineProperty(P, "userAgentData", { configurable: true, get: function () { return undefined; } });
  });

  // ---- talking to Fusion's Browser (the parent frame only)
  function report() {
    if (W.parent === W) return;
    try { W.parent.postMessage({ fusionWp: "nav", url: currentTarget(), title: D.title || "", beacons: beacons, reader: !!(me && me.getAttribute("data-reader") === "1") }, "*"); } catch (e) { /* detached */ }
  }
  var hits = [], cur = -1, lastQ = null, dirty = false;
  // pages keep building after load (and the parent may ask before they finish): any DOM change invalidates the hits
  guard(function () { new MutationObserver(function () { dirty = true; }).observe(D, { subtree: true, childList: true, characterData: true }); });
  function find(q, dir) {
    q = String(q || "");
    if (q !== lastQ || dirty) {
      if (q !== lastQ) cur = -1;
      lastQ = q; hits = []; dirty = false;
      if (q && D.body) {
        var lq = q.toLowerCase(), w = D.createTreeWalker(D.body, 4 /* SHOW_TEXT */, null), n;
        while ((n = w.nextNode())) {
          var p = n.parentElement;
          if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.nodeName) || (p.checkVisibility && !p.checkVisibility())) continue;
          var t = n.nodeValue.toLowerCase(), i = t.indexOf(lq);
          while (i >= 0) { hits.push([n, i]); i = t.indexOf(lq, i + lq.length); }
        }
      }
    }
    if (cur >= hits.length) cur = -1;
    if (hits.length) {
      cur = (cur + (dir === -1 ? -1 : 1) + hits.length) % hits.length;
      var h = hits[cur], r = D.createRange();
      r.setStart(h[0], h[1]); r.setEnd(h[0], h[1] + q.length);
      var sel = W.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      if (h[0].parentElement) h[0].parentElement.scrollIntoView({ block: "center" });
    }
    W.parent.postMessage({ fusionWp: "found", q: q, n: hits.length, i: hits.length ? cur + 1 : 0 }, "*");
  }
  W.addEventListener("message", function (e) {
    if (e.source !== W.parent || e.origin !== HERE || !e.data || typeof e.data.fusionWp !== "string") return;
    var m = e.data;
    if (m.fusionWp === "find") {
      // asked while the page is still being parsed: answer for the whole document, once it exists
      if (D.readyState === "loading") D.addEventListener("DOMContentLoaded", function () { find(m.q, m.dir); }, { once: true });
      else find(m.q, m.dir);
    }
    else if (m.fusionWp === "reload") L.reload();
    else if (m.fusionWp === "ping") report();
    else if (m.fusionWp === "text") W.parent.postMessage({ fusionWp: "text", title: D.title || "", text: D.body ? D.body.innerText.slice(0, 200000) : "" }, "*");
  });
  D.addEventListener("DOMContentLoaded", report);
  W.addEventListener("load", report);
  W.addEventListener("popstate", report);
  W.addEventListener("hashchange", report);
})(typeof window !== "undefined" ? window : globalThis);
