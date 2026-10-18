/*
 * Fusion web proxy — in-page runtime (TT35). Original code, plain ES2017, no dependencies.
 *
 * Runs first in every proxied document. The document lives in an opaque origin (CSP sandbox) and its CSP only
 * allows loads from the Fusion server, so anything this runtime misses FAILS CLOSED (blocked or 404) instead of
 * leaking a request to a third party. Its job is to make sites work: route the URLs that scripts build at run time
 * back through the proxy, and stand in for the storage APIs an opaque origin is denied.
 *
 * Declared limits: scripts that read window.location see the proxy address (location cannot be redefined);
 * storage is per page and in memory only. WebSockets (TT38) go through a same-origin bridge (fetch streams) and
 * EventSource through the proxy; Web Workers' own sockets are not covered (workers do not run this runtime).
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
  // ---- TT38 (WP-08): WebSocket through the same-origin bridge (src/lib/server/wp-ws.ts), EventSource through the proxy.
  // The page's CSP refuses native sockets to the internet; this class keeps the WebSocket API (readyState, events in
  // order, binaryType, bufferedAmount, close codes, the constructor's errors) and carries the frames over fetch.
  guard(function () {
    var raw = W.__fusionWp.rawFetch;
    if (!raw || typeof W.EventTarget !== "function" || typeof W.ReadableStream !== "function" || typeof W.TextEncoder !== "function") return;
    var TE = new TextEncoder(), TDEC = new TextDecoder();
    var TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
    function domErr(msg, name) { try { return new DOMException(msg, name); } catch (e) { var x = new Error(msg); x.name = name; return x; } }
    function pack(type, bytes) {
      var out = new Uint8Array(5 + bytes.length);
      out[0] = type; new DataView(out.buffer).setUint32(1, bytes.length); out.set(bytes, 5);
      return out;
    }
    function concat(list, total) { var o = new Uint8Array(total), i = 0; list.forEach(function (b) { o.set(b, i); i += b.length; }); return o; }
    function pageOrigin() { try { return new URL(currentTarget()).origin; } catch (e) { return ""; } }
    function fire(t, type, init) {
      var ev;
      try { ev = type === "message" ? new MessageEvent(type, init) : type === "close" ? new CloseEvent(type, init) : new Event(type); }
      catch (e) { ev = new Event(type); for (var k in init) try { Object.defineProperty(ev, k, { value: init[k] }); } catch (e2) { /* read-only */ } }
      t.dispatchEvent(ev);
    }

    class FusionWebSocket extends W.EventTarget {
      constructor(url, protocols) {
        super();
        if (arguments.length < 1) throw new TypeError("Failed to construct 'WebSocket': 1 argument required, but only 0 present.");
        var u;
        try { u = new URL(String(url), targetBase()); } catch (e) { throw domErr("Failed to construct 'WebSocket': The URL '" + url + "' is invalid.", "SyntaxError"); }
        if (u.protocol === "http:") u.protocol = "ws:"; else if (u.protocol === "https:") u.protocol = "wss:";
        if (u.protocol !== "ws:" && u.protocol !== "wss:") throw domErr("Failed to construct 'WebSocket': The URL's scheme must be either 'http', 'https', 'ws', or 'wss'. '" + u.protocol.slice(0, -1) + "' is not allowed.", "SyntaxError");
        if (u.hash) throw domErr("Failed to construct 'WebSocket': The URL contains a fragment identifier ('" + u.hash + "'). Fragment identifiers are not allowed in WebSocket URLs.", "SyntaxError");
        var list = protocols === undefined ? [] : typeof protocols === "string" ? [protocols] : Array.prototype.slice.call(protocols).map(String);
        var seen = {};
        list.forEach(function (p) {
          if (!TOKEN.test(p) || seen[p]) throw domErr("Failed to construct 'WebSocket': The subprotocol '" + p + "' is invalid or duplicated.", "SyntaxError");
          seen[p] = 1;
        });
        this._url = u.href; this._state = 0; this._protocol = ""; this._extensions = ""; this._binaryType = "blob";
        this._buffered = 0; this._queue = []; this._sending = false; this._id = null; this._ended = false;
        this._abort = typeof AbortController === "function" ? new AbortController() : null;
        this._handlers = {};
        var self = this;
        raw.call(W, PREFIX + SID + "/__ws/open", {
          method: "POST", credentials: "omit", cache: "no-store", headers: { "content-type": "text/plain" },
          body: JSON.stringify({ url: this._url, protocols: list, origin: pageOrigin(), token: me.dataset.wst || "" }), signal: this._abort ? this._abort.signal : undefined,
        }).then(function (res) {
          if (!res.ok || !res.body) throw new Error("bridge " + res.status);
          return self._read(res.body.getReader());
        }).catch(function () { self._finish(1006, "", false, true); });
      }
      get url() { return this._url; }
      get readyState() { return this._state; }
      get protocol() { return this._protocol; }
      get extensions() { return this._extensions; }
      get bufferedAmount() { return this._buffered; }
      get binaryType() { return this._binaryType; }
      set binaryType(v) { if (v === "blob" || v === "arraybuffer") this._binaryType = v; }

      _read(reader) {
        var self = this, buf = new Uint8Array(0);
        function step() {
          return reader.read().then(function (r) {
            if (r.done) { self._streamDone = true; self._finish(1006, "", false, true); return; } // the bridge ended without a close frame
            var b = new Uint8Array(buf.length + r.value.length); b.set(buf); b.set(r.value, buf.length); buf = b;
            while (buf.length >= 5) {
              var len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(1);
              if (buf.length < 5 + len) break;
              var type = buf[0], payload = buf.slice(5, 5 + len);
              buf = buf.slice(5 + len);
              self._frame(type, payload);
              if (self._ended) { try { reader.cancel().catch(function () { /* already closed */ }); } catch (e) { /* done */ } return; }
            }
            return step();
          });
        }
        return step();
      }
      _frame(type, payload) {
        if (type === 1) {
          var o = JSON.parse(TDEC.decode(payload));
          if (this._state !== 0) return; // close() was called while connecting: already failed
          this._id = o.id; this._protocol = o.protocol || ""; this._extensions = o.extensions || ""; this._state = 1;
          fire(this, "open", {});
          this._pump();
        } else if (type === 2 || type === 3) {
          if (this._state !== 1) return; // after close() no more messages are delivered
          var origin = new URL(this._url).origin;
          var data = type === 2 ? TDEC.decode(payload) : this._binaryType === "arraybuffer" ? payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) : new Blob([payload]);
          fire(this, "message", { data: data, origin: origin });
        } else if (type === 4) {
          var c = {};
          try { c = JSON.parse(TDEC.decode(payload)); } catch (e) { /* malformed: abnormal */ }
          this._finish(typeof c.code === "number" ? c.code : 1006, String(c.reason || ""), !!c.wasClean, !c.wasClean);
        }
      }
      _finish(code, reason, wasClean, error) {
        if (this._ended) return;
        this._ended = true; this._state = 3;
        // stop the bridge stream (a no-op when it already ended); the pending read settles inside the handled chain
        if (this._abort && !this._streamDone) try { this._abort.abort(); } catch (e) { /* done */ }
        if (error) fire(this, "error", {});
        fire(this, "close", { code: code, reason: reason, wasClean: wasClean });
      }
      send(data) {
        if (this._state === 0) throw domErr("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", "InvalidStateError");
        var item;
        if (typeof data === "string") item = { t: 2, b: TE.encode(data) };
        else if (data instanceof ArrayBuffer) item = { t: 3, b: new Uint8Array(data.slice(0)) };
        else if (ArrayBuffer.isView(data)) item = { t: 3, b: new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) };
        else if (typeof Blob === "function" && data instanceof Blob) item = { t: 3, blob: data, n: data.size };
        else item = { t: 2, b: TE.encode(String(data)) };
        var n = item.b ? item.b.length : item.n;
        this._buffered += n; // per spec it also grows after close, when nothing is sent any more
        if (this._state !== 1) return;
        item.n = n;
        this._queue.push(item);
        this._pump();
      }
      close(code, reason) {
        if (code !== undefined && (code !== 1000 && (code < 3000 || code > 4999) || code !== Math.floor(code))) throw domErr("Failed to execute 'close' on 'WebSocket': The close code must be either 1000, or between 3000 and 4999. " + code + " is neither.", "InvalidAccessError");
        var r = reason === undefined ? "" : String(reason);
        if (TE.encode(r).length > 123) throw domErr("Failed to execute 'close' on 'WebSocket': The close reason must not be greater than 123 UTF-8 bytes.", "SyntaxError");
        if (this._state >= 2) return;
        if (this._state === 0) { // spec: fail the connection — error, then close 1006, asynchronously
          this._state = 2;
          var self = this;
          setTimeout(function () { self._finish(1006, "", false, true); }, 0);
          return;
        }
        this._state = 2;
        this._queue.push({ t: 4, b: TE.encode(JSON.stringify(code === undefined ? {} : { code: code, reason: r })), n: 0 });
        this._pump();
      }
      // one POST in flight at a time, in order; Blobs are read in place so a later string never overtakes an earlier Blob
      _pump() {
        if (this._sending || !this._queue.length || this._id === null || this._ended) return;
        var self = this, head = this._queue[0];
        if (head.blob) {
          this._sending = true;
          head.blob.arrayBuffer().then(function (ab) { head.b = new Uint8Array(ab); delete head.blob; self._sending = false; self._pump(); },
            function () { self._sending = false; self._queue.shift(); self._buffered -= head.n; self._pump(); });
          return;
        }
        var batch = [], bytes = [], total = 0, sent = 0;
        while (this._queue.length && !this._queue[0].blob && (total === 0 || total + this._queue[0].b.length < 1048576)) {
          var it = this._queue.shift(); batch.push(it); var f = pack(it.t, it.b); bytes.push(f); total += f.length; sent += it.n;
        }
        this._sending = true;
        raw.call(W, PREFIX + SID + "/__ws/" + this._id, { method: "POST", credentials: "omit", cache: "no-store", headers: { "content-type": "text/plain" }, body: concat(bytes, total) })
          .then(function () { /* a 410 means the socket is gone: its close frame arrives on the stream */ }, function () { /* network: same */ })
          .then(function () { self._buffered -= sent; self._sending = false; self._pump(); });
      }
      get onopen() { return this._handlers.open || null; } set onopen(f) { this._handler("open", f); }
      get onmessage() { return this._handlers.message || null; } set onmessage(f) { this._handler("message", f); }
      get onerror() { return this._handlers.error || null; } set onerror(f) { this._handler("error", f); }
      get onclose() { return this._handlers.close || null; } set onclose(f) { this._handler("close", f); }
      _handler(type, f) {
        // an event handler attribute: one listener, registered where it was first set, calling the current value
        if (!this._wrap) this._wrap = {};
        if (!this._wrap[type]) {
          var self = this;
          this._wrap[type] = function (e) { var h = self._handlers[type]; if (typeof h === "function") return h.call(self, e); };
          this.addEventListener(type, this._wrap[type]);
        }
        this._handlers[type] = typeof f === "function" ? f : null;
      }
    }
    ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k, i) {
      Object.defineProperty(FusionWebSocket, k, { value: i, enumerable: true });
      Object.defineProperty(FusionWebSocket.prototype, k, { value: i, enumerable: true });
    });
    Object.defineProperty(FusionWebSocket, "name", { value: "WebSocket" });
    W.WebSocket = FusionWebSocket;
  });
  guard(function () {
    var NativeES = W.EventSource;
    if (typeof NativeES !== "function") return;
    // EventSource is a plain GET stream: the proxy carries it (no buffering — see the event-stream branch in the route).
    // Cookies come from the session jar on the server; the page's withCredentials has nothing to send.
    class FusionEventSource extends NativeES {
      constructor(url, init) {
        if (arguments.length < 1) throw new TypeError("Failed to construct 'EventSource': 1 argument required, but only 0 present.");
        var abs;
        try { abs = new URL(String(url), targetBase()).href; } catch (e) { throw domErr2("Failed to construct 'EventSource': Cannot open an EventSource to '" + url + "'. The URL is invalid.", "SyntaxError"); }
        super(enc(abs), { withCredentials: false });
        this._fusionUrl = abs;
        this._fusionCred = !!(init && init.withCredentials);
      }
      get url() { return this._fusionUrl; }
      get withCredentials() { return this._fusionCred; }
    }
    function domErr2(msg, name) { try { return new DOMException(msg, name); } catch (e) { var x = new Error(msg); x.name = name; return x; } }
    Object.defineProperty(FusionEventSource, "name", { value: "EventSource" });
    W.EventSource = FusionEventSource;
  });
  D.addEventListener("DOMContentLoaded", report);
  W.addEventListener("load", report);
  W.addEventListener("popstate", report);
  W.addEventListener("hashchange", report);
})(typeof window !== "undefined" ? window : globalThis);
