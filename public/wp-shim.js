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
 * EventSource through the proxy; Web Workers (TT39) run this runtime too, from a blob bootstrap.
 */
(function (W) {
  "use strict";
  var D = W.document;
  var me = D && D.currentScript;
  // TT39 (WP-11): inside a Web Worker started through this runtime, the configuration comes from the worker's
  // bootstrap (self.__fusionWpCfg) instead of the <script> tag, and only the network patches apply
  var CFG = !D && W.__fusionWpCfg && typeof W.__fusionWpCfg === "object" ? W.__fusionWpCfg : null;
  if (CFG) me = { dataset: { fusionWp: "1", sid: String(CFG.sid), url: String(CFG.url), ua: String(CFG.ua), doc: String(CFG.doc || ""), wst: String(CFG.wst || ""), cookies: "" }, getAttribute: function () { return null; } };
  if (!me || !me.dataset || !me.dataset.fusionWp) return;
  var PREFIX = "/api/wp/s/";
  var SID = me.dataset.sid;
  var TARGET = me.dataset.url;
  var UA_KIND = me.dataset.ua === "mobile" ? "mobile" : "desktop";
  var L = W.location;
  // TT42: inside an iframe srcdoc document location is about:srcdoc — its URLs resolve against document.baseURI (the
  // parent's proxied address, inherited), so that is what this runtime resolves and decodes against
  var SRCDOC = !CFG && L.href === "about:srcdoc", LB = SRCDOC ? new URL(D.baseURI) : L;
  var HERE = CFG ? String(CFG.here) : LB.protocol + "//" + LB.host; // location keeps the URL's origin even in an opaque-origin document
  // a worker's own location is a blob: URL — nothing resolves against it, so worker-side URLs are absolute
  var HOME = new URL(HERE + "/"), HOST = HOME.host, PROTO = HOME.protocol, ABS = CFG ? HERE : "";
  var PASS = /^(data|blob|javascript|mailto|tel|sms|about|ftp|ws|wss|intent|geo|magnet|chrome|file):/i;
  var beacons = 0;

  /** our URL (absolute or path) → the target URL it stands for, or null */
  function decode(u) {
    var x;
    try { x = new URL(String(u), CFG ? HOME.href : LB.href); } catch (e) { return null; }
    if (x.host !== HOST || x.pathname.indexOf(PREFIX) !== 0) return null;
    var p = x.pathname.slice(PREFIX.length).split("/");
    if (p.length < 3 || (p[1] !== "http" && p[1] !== "https")) return null;
    return p[1] + "://" + p[2] + "/" + p.slice(3).join("/") + x.search + x.hash;
  }
  function currentTarget() { return CFG ? TARGET : decode(LB.href) || TARGET; }
  function targetBase() { return CFG ? TARGET : decode(D.baseURI) || currentTarget(); }

  /** any URL a page uses → the proxied path (mirror of encodeTarget / rewriteUrl in src/lib/wp-core.ts) */
  function enc(u) {
    if (u === null || u === undefined) return u;
    var s = String(u), t = s.trim();
    if (!t || t.charAt(0) === "#" || PASS.test(t)) return s;
    if (t.indexOf(PREFIX) === 0) return ABS + s; // already ours
    if (t.indexOf(HERE + PREFIX) === 0) return s;
    var abs;
    try { abs = new URL(t, targetBase()); } catch (e) { return s; }
    if (abs.host === HOST && abs.protocol === PROTO) {
      if (abs.pathname.indexOf(PREFIX) === 0) return ABS + abs.pathname + abs.search + abs.hash;
      // a URL built from location.origin / location.host: it meant the target site's root
      abs = new URL(abs.pathname + abs.search + abs.hash, new URL(currentTarget()).origin);
    }
    if ((abs.protocol !== "http:" && abs.protocol !== "https:") || abs.username || abs.password) return s;
    return ABS + PREFIX + SID + "/" + abs.protocol.slice(0, -1) + "/" + abs.host + abs.pathname + abs.search + abs.hash;
  }
  // TT39 (WP-10): script requests name the document that made them and its credentials mode, in the session segment
  // ("<sid>:<doc>:<i|s|o>") — the server applies the Fetch standard's rules for that document's real origin.
  var DOC = me.dataset.doc || "";
  function tag(p, cred, sameOriginMode, script) {
    if (!DOC || typeof p !== "string") return p;
    // TT41: "m" = the page asked for mode "same-origin" (the server refuses a redirect that leaves the origin)
    // a data: worker's origin is opaque: Origin "null", never same-origin, cross-site, no Referer ("txyn") — the
    // chain flags the server already applies to tainted redirects (wp-cors ChainFlags)
    // TT42: "e" = made by page script through fetch() / XHR (destination "empty") — read by the server only when the
    // browser sends no Fetch Metadata (older Safari), to tell a page's fetch from a module-graph load
    var c = (cred === "include" ? "i" : cred === "omit" ? "o" : "s") + (sameOriginMode ? "m" : "") + (CFG && CFG.opaque ? "txyn" : "") + (script ? "e" : ""), head = PREFIX + SID + "/", seg = PREFIX + SID + ":" + DOC + ":" + c + "/";
    // TT40: a URL that already carries a tag (e.g. an <img>'s "<sid>:<doc>:r" src read back by script) is re-tagged
    // as THIS script request — a fetch() is never treated as a markup subresource
    var at = p.indexOf(HERE) === 0 ? HERE.length : 0;
    if (p.indexOf(PREFIX + SID + ":", at) === at) {
      var slash = p.indexOf("/", at + PREFIX.length);
      if (slash > 0 && /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]{8,32}:(r|f|[iso]m?t?x?y?n?e?)$/.test(p.slice(at + PREFIX.length, slash))) p = p.slice(0, at) + head + p.slice(slash + 1);
    }
    if (p.indexOf(head) === 0) return seg + p.slice(head.length);
    if (p.indexOf(HERE + head) === 0) return HERE + seg + p.slice(HERE.length + head.length);
    return p;
  }
  // TT40 (WP-16): URLs set on elements that LOAD a subresource carry "<sid>:<doc>:r" — the server then sends cookies
  // with SameSite rules for this document, as for markup the server rewrote; navigations (a, form, iframe, object,
  // embed …) stay untagged so a new page never inherits this document's id
  function rtag(p) {
    if (!DOC || typeof p !== "string") return p;
    var head = PREFIX + SID + "/", i = p.indexOf(head);
    if (i < 0 || (i > 0 && p.slice(0, i) !== ABS && p.slice(0, i) !== HERE)) return p;
    return p.slice(0, i) + PREFIX + SID + ":" + DOC + ":r/" + p.slice(i + head.length);
  }
  var RES = { IMG: { src: 1, srcset: 1 }, SCRIPT: { src: 1 }, LINK: { href: 1, imagesrcset: 1 }, SOURCE: { src: 1, srcset: 1 }, TRACK: { src: 1 },
    AUDIO: { src: 1 }, VIDEO: { src: 1, poster: 1 }, INPUT: { src: 1 }, BODY: { background: 1 }, TABLE: { background: 1 }, TD: { background: 1 }, TH: { background: 1 } };
  function isRes(el, k) { var t = RES[el && el.tagName]; return !!(t && t[k]); }
  // TT41 (WP-19): an iframe / frame of this document carries "<sid>:<doc>:f" — the server then judges SameSite for it
  // through this document's own ancestors
  function isFrameSrc(el, k) { return k === "src" && !!el && (el.tagName === "IFRAME" || el.tagName === "FRAME"); }
  function ftag(p) { var r = rtag(p); return typeof r === "string" && r !== p ? r.replace(PREFIX + SID + ":" + DOC + ":r/", PREFIX + SID + ":" + DOC + ":f/") : p; }
  function encFor(el, k, v) { var e = enc(v); return isRes(el, k) ? rtag(e) : isFrameSrc(el, k) ? ftag(e) : e; }
  function encSrcset(v) {
    return String(v).split(/,(?=\s)|,$/).map(function (c) {
      var m = /^(\s*)(\S+)(.*)$/.exec(c);
      return m ? m[1] + rtag(enc(m[2])) + m[3] : c;
    }).join(",");
  }
  W.__fusionWp = { enc: enc, decode: decode, encSrcset: encSrcset, target: currentTarget, tag: tag };
  if (!CFG && typeof W.HTMLElement === "undefined") return; // not a browser (unit tests load this file for the codec)

  function guard(f) { try { f(); } catch (e) { /* one failed patch must not stop the others */ } }

  // ---- network APIs
  guard(function () {
    var _fetch = W.fetch;
    W.fetch = function (input, init) {
      // the page's credentials mode travels in the URL tag; our own request to the proxy never carries credentials
      var cred = (init && init.credentials) || (input && typeof input === "object" && input.credentials) || "same-origin";
      var i = input, o = Object.assign({}, init || {}, { credentials: "omit" });
      var mode = o.mode || (i && typeof i === "object" && i.mode) || "", proxied, som = mode === "same-origin";
      if (typeof i === "string" || (W.URL && i instanceof URL)) i = proxied = tag(enc(String(i)), cred, som, true);
      else if (i && i.url) i = new Request(proxied = tag(enc(i.url), cred, som, true), i); // method, headers and body come along; o.mode overrides below
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
    // TT39: withCredentials is real — "include" vs "same-origin" in the tag. Set after open() (allowed natively until
    // send()), it re-opens the request with the new tag at send() and replays the request headers already set.
    var X = W.XMLHttpRequest.prototype, _open = X.open, _send = X.send, _srh = X.setRequestHeader;
    function st(x) { return x.__fw || (x.__fw = { args: null, hdrs: [], cred: false, sent: false }); }
    X.open = function (m, u) {
      var a = Array.prototype.slice.call(arguments), f = st(this);
      f.args = a.slice(); f.hdrs = []; f.sent = f.cred;
      a[1] = tag(enc(u), f.cred ? "include" : "same-origin", false, true);
      return _open.apply(this, a);
    };
    X.setRequestHeader = function (k, v) { st(this).hdrs.push([k, v]); return _srh.call(this, k, v); };
    X.send = function () {
      var f = st(this), self = this;
      if (f.args && f.sent !== f.cred && this.readyState === 1) {
        var a = f.args.slice(), hdrs = f.hdrs.slice();
        a[1] = tag(enc(a[1]), f.cred ? "include" : "same-origin", false, true); f.sent = f.cred;
        _open.apply(this, a);
        hdrs.forEach(function (h) { _srh.call(self, h[0], h[1]); });
        f.hdrs = hdrs;
      }
      return _send.apply(this, arguments);
    };
    Object.defineProperty(X, "withCredentials", {
      configurable: true,
      get: function () { return !!(this.__fw && this.__fw.cred); },
      set: function (v) {
        if (this.readyState > 1) throw new DOMException("Failed to set the 'withCredentials' property on 'XMLHttpRequest': The value may only be set if the object's state is UNSENT or OPENED.", "InvalidStateError");
        st(this).cred = !!v;
      },
    });
  });
  // TT41: what the page reads back is the REAL address — Response.url (after redirects: the final one),
  // XMLHttpRequest.responseURL and Request.url show the target site's URL, not the proxy's
  guard(function () {
    // (a Request keeps its fragment, a response never has one — as natively)
    [[W.Response, "url", true], [W.XMLHttpRequest, "responseURL", true], [W.Request, "url", false]].forEach(function (p) {
      var C = p[0], d = C && Object.getOwnPropertyDescriptor(C.prototype, p[1]);
      if (!d || !d.get) return;
      Object.defineProperty(C.prototype, p[1], { configurable: true, enumerable: d.enumerable, get: function () { var v = d.get.call(this); var t = v ? decode(v) : null; return t ? (p[2] ? t.replace(/#.*$/, "") : t) : v; } });
    });
    // Response.type: the opaque sandbox makes every proxied response "cors"; a response the server judged
    // same-origin all along (no cross-origin hop) is "basic", as it is natively
    var dt = W.Response && Object.getOwnPropertyDescriptor(W.Response.prototype, "type");
    if (dt && dt.get) Object.defineProperty(W.Response.prototype, "type", { configurable: true, enumerable: dt.enumerable, get: function () { var v = dt.get.call(this); try { if (v === "cors" && this.headers.get("x-fusion-wp-tainting") === "basic") return "basic"; } catch (e) { /* native value */ } return v; } });
  });
  // TT41: new Request("/x") in a DOCUMENT resolves against the page's real base URL (it used to resolve against
  // the proxy origin — fetch(new Request("/api/…")) reached Fusion's own API path); workers do the same in netExtras
  if (!CFG) guard(function () {
    var NR = W.Request;
    if (typeof NR !== "function") return;
    var FR = function Request(input, init) {
      if (typeof input === "string" || (W.URL && input instanceof URL)) { try { var s = String(input); input = decode(new URL(s, D.baseURI).href) ? new URL(s, D.baseURI).href : new URL(s, targetBase()).href; } catch (e) { /* the native error */ } }
      return Reflect.construct(NR, init === undefined ? [input] : [input, init], new.target || FR);
    };
    FR.prototype = NR.prototype; Object.setPrototypeOf(FR, NR);
    W.Request = FR;
  });
  guard(function () { W.navigator.sendBeacon = function () { beacons++; return true; }; }); // tracking beacons go nowhere
  if (!CFG) guard(function () { var _open = W.open; W.open = function (u, n, f) { return _open.call(W, u === undefined ? u : enc(u), n, f); }; });
  guard(function () {
    ["pushState", "replaceState"].forEach(function (k) {
      var f = W.history[k];
      W.history[k] = function (st, title, u) { var r = f.call(this, st, title, u === undefined || u === null ? u : enc(u)); report(); return r; };
    });
  });

  // ---- TT39 (WP-11): Web Workers run this runtime too. A worker is started from a small blob bootstrap that sets the
  // worker's configuration, loads this file, then loads the site's worker script through the proxy — so the worker's
  // fetch / XHR / WebSocket / EventSource / importScripts / nested workers are routed and policed like the page's.
  guard(function () {
    var NW = W.Worker;
    if (typeof NW !== "function" || typeof W.Blob !== "function" || !W.URL || !URL.createObjectURL) return;
    var SHIM = HERE + "/wp-shim.js";
    function domErr3(msg, name) { try { return new DOMException(msg, name); } catch (e) { var x = new Error(msg); x.name = name; return x; } }
    function bootstrap(scriptUrl, isModule, shared, target, shown, doc) {
      // TT41: "loc" = what self.location shows (the worker script's real URL; blob:<site origin>/… for a blob worker;
      // the data: URL itself for a data: worker, whose origin is opaque — "null")
      var cfg = JSON.stringify({ sid: SID, doc: DOC, url: target, ua: UA_KIND, here: HERE, wst: me.dataset.wst || "", module: !!isModule, loc: shown || target, opaque: !!doc });
      var J = JSON.stringify;
      // SharedWorker emulation: the page's MessagePort arrives as a message; after the script has run it is handed to
      // the script as a "connect" event (self.onconnect / addEventListener("connect"))
      var sh = shared ? "var __fwReady=false,__fwQ=[];function __fwConnect(p){var e=new MessageEvent('connect',{data:'',ports:[p]});self.dispatchEvent(e);if(typeof self.onconnect==='function')self.onconnect(e);}" +
        "self.addEventListener('message',function(e){if(e.data&&e.data.__fusionWpConnect===1){e.stopImmediatePropagation();if(__fwReady)__fwConnect(e.ports[0]);else __fwQ.push(e.ports[0]);}});" : "";
      var done = shared ? "__fwReady=true;__fwQ.splice(0).forEach(__fwConnect);" : "";
      // Chromium cannot start a MODULE worker from an opaque-origin page at all (verified: a one-line blob module
      // worker fails before running; a classic one runs). So a module worker runs as a classic worker that loads the
      // module graph with dynamic import() — import.meta.url, static imports and top-level await all work. Messages
      // that arrive before the module has been evaluated are held and re-delivered, so none are lost.
      var src = isModule
        ? "self.__fusionWpCfg=" + cfg + ";" + sh + "importScripts(" + J(SHIM) + ");var __fwHold=true,__fwM=[];" +
          "self.addEventListener('message',function(e){if(__fwHold&&!(e.data&&e.data.__fusionWpConnect===1)){e.stopImmediatePropagation();__fwM.push(e);}});" +
          // released when the module graph starts evaluating (wp-mw-ready.js runs first); delivered in a later task,
          // after the module's synchronous part — as a native module worker does
          "self.__fwRelease=function(){self.__fwRelease=null;setTimeout(function(){__fwHold=false;__fwM.splice(0).forEach(function(e){self.dispatchEvent(new MessageEvent('message',{data:e.data,ports:e.ports}));});" + done + "},0);};" +
          "import('data:text/javascript,'+encodeURIComponent('import '+" + J(J(HERE + "/wp-mw-ready.js")) + "+';import '+" + J(J(scriptUrl)) + "+';'))" +
          ".catch(function(err){setTimeout(function(){throw err;});});"
        : "self.__fusionWpCfg=" + cfg + ";" + sh + "importScripts(" + J(SHIM) + ");importScripts(" + J(scriptUrl) + ");" + done;
      var b = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      setTimeout(function () { URL.revokeObjectURL(b); }, 60000);
      return b;
    }
    /** what a Worker / SharedWorker constructor is given → the bootstrap to start, or null to start it unchanged */
    function plan(url, opts, shared, kind) {
      var s = String(url), t = s.trim(), isModule = !!(opts && typeof opts === "object" && opts.type === "module");
      // TT41: a data: worker runs through the proxy too (it used to run unpatched — straight to the network). Natively
      // its origin is opaque: Origin "null", no same-origin cookies, SameSite=None cookies only with "include" — its
      // requests carry the page's document id plus the opaque-origin flags (see tag())
      if (/^data:/i.test(t)) {
        var body = dataUrlText(t);
        if (body === null) return null;
        var bu = URL.createObjectURL(new Blob([body], { type: "text/javascript" }));
        setTimeout(function () { URL.revokeObjectURL(bu); }, 60000);
        return bootstrap(bu, isModule, shared, t, t, true);
      }
      if (/^blob:/i.test(t)) { // made by the page: same origin as the page; shown as blob:<site origin>/<uuid>
        var uuid = t.slice(t.lastIndexOf("/") + 1);
        return bootstrap(t, isModule, shared, currentTarget(), "blob:" + new URL(currentTarget()).origin + "/" + uuid);
      }
      var abs;
      try { abs = new URL(t, targetBase()); } catch (e) { throw domErr3("Failed to construct '" + kind + "': The URL '" + s + "' is invalid.", "SyntaxError"); }
      var here = new URL(currentTarget());
      // natively a worker script must be same-origin with its creator
      if (abs.origin !== here.origin) throw domErr3("Failed to construct '" + kind + "': Script at '" + abs.href + "' cannot be accessed from origin '" + here.origin + "'.", "SecurityError");
      // TT41: the worker script is a request of this document (credentials "same-origin"), so it is tagged
      var p = tag(enc(abs.href), "same-origin");
      return bootstrap(p.indexOf("/") === 0 ? HERE + p : p, isModule, shared, abs.href);
    }
    /** the text of a data: URL (base64 or percent-encoded, decoded as UTF-8), or null when it is malformed */
    function dataUrlText(u) {
      var comma = u.indexOf(","); if (comma < 0) return null;
      var meta = u.slice(5, comma), data = u.slice(comma + 1), bytes;
      try {
        if (/;base64$/i.test(meta)) { var bin = atob(decodeURIComponent(data).replace(/\s+/g, "")); bytes = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); }
        else { var out = []; for (var j = 0; j < data.length; j++) { var ch = data.charCodeAt(j); if (data[j] === "%" && /^[0-9a-fA-F]{2}$/.test(data.substr(j + 1, 2))) { out.push(parseInt(data.substr(j + 1, 2), 16)); j += 2; } else if (ch < 128) out.push(ch); else { var e = unescape(encodeURIComponent(data[j])); for (var k = 0; k < e.length; k++) out.push(e.charCodeAt(k)); } } bytes = new Uint8Array(out); }
        return new TextDecoder("utf-8").decode(bytes);
      } catch (e) { return null; }
    }
    function FusionWorker(url, opts) {
      if (!new.target) throw new TypeError("Failed to construct 'Worker': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
      if (arguments.length < 1) throw new TypeError("Failed to construct 'Worker': 1 argument required, but only 0 present.");
      var b = plan(url, opts, false, "Worker");
      // the bootstrap itself is always a classic script (see bootstrap())
      return Reflect.construct(NW, b ? [b, Object.assign({}, opts && typeof opts === "object" ? opts : {}, { type: "classic" })] : [url, opts], new.target);
    }
    FusionWorker.prototype = NW.prototype;
    Object.setPrototypeOf(FusionWorker, NW);
    Object.defineProperty(FusionWorker, "name", { value: "Worker" });
    W.Worker = FusionWorker;

    // An opaque-origin page may not use SharedWorker at all (Chromium: "Access to shared workers is denied to origin
    // 'null'"). TT43: inside Fusion the worker is SHARED like a native one — by every document of the same site in the
    // same proxy session (the tabs of one profile, their frames) — through a broker in the Fusion window
    // (src/lib/wp-shared-broker.ts): this page hands one end of a MessageChannel to the window, which verifies with
    // the server which site this document really is (its secret document id), and passes the port to a hidden host
    // document of that site, where the one worker runs under this runtime. Outside Fusion (no broker answers), or for
    // a data: / blob: script, it falls back to one dedicated worker per (script URL, name) in this page.
    if (typeof W.MessageChannel === "function" && typeof W.EventTarget === "function" && D) {
      var pool = {}, conns = {}, mine = [];
      // broker presence: asked once; constructors made before the answer wait (their port buffers the messages)
      var BROKER = W.top !== W && DOC ? 0 : -1, waiting = [];
      function brokerSettled(v) { if (BROKER !== 0) return; BROKER = v; waiting.splice(0).forEach(function (f) { f(); }); }
      if (BROKER === 0) {
        try { W.top.postMessage({ fusionWpShared: "hello" }, "*"); } catch (e) { BROKER = -1; }
        setTimeout(function () { brokerSettled(-1); }, 2000);
      }
      W.addEventListener("message", function (e) {
        var d = e.data;
        if (!d || typeof d.fusionWpShared !== "string" || e.source !== W.top || e.origin !== HOME.origin) return;
        if (d.fusionWpShared === "here") brokerSettled(1);
        else if (d.fusionWpShared === "error" && conns[d.id]) conns[d.id]();
        // TT43: liveness — this document answers with the connections it owns (the broker drops any other of this
        // window: they belonged to a document that has gone)
        else if (d.fusionWpShared === "ping") try { W.top.postMessage({ fusionWpShared: "alive", nonce: String(d.nonce), ids: mine.slice() }, "*"); } catch (x) { /* gone */ }
      });
      // fast path only (a message posted while the document unloads is not always delivered — measured in Chromium);
      // the broker's ping / alive liveness check is what guarantees the release
      W.addEventListener("pagehide", function (e) {
        if (BROKER === 1 && mine.length && !e.persisted) try { W.top.postMessage({ fusionWpShared: "bye", ids: mine.slice() }, "*"); } catch (x) { /* window gone */ }
      });
      /** the script URL a SharedWorker would load — the same checks and errors as natively; null = data: / blob: */
      function sharedScript(url) {
        var t = String(url).trim();
        if (/^(data|blob):/i.test(t)) return null;
        var abs;
        try { abs = new URL(t, targetBase()); } catch (e) { throw domErr3("Failed to construct 'SharedWorker': The URL '" + String(url) + "' is invalid.", "SyntaxError"); }
        var here = new URL(currentTarget());
        if (abs.origin !== here.origin) throw domErr3("Failed to construct 'SharedWorker': Script at '" + abs.href + "' cannot be accessed from origin '" + here.origin + "'.", "SecurityError");
        return abs.href;
      }
      class FusionSharedWorker extends EventTarget {
        constructor(url, opts) {
          super();
          if (arguments.length < 1) throw new TypeError("Failed to construct 'SharedWorker': 1 argument required, but only 0 present.");
          var o = typeof opts === "string" ? { name: opts } : opts || {};
          var name = o.name === undefined ? "" : String(o.name), type = o.type === "module" ? "module" : "classic", self = this;
          var abs = sharedScript(url);
          var mc = new MessageChannel();
          this.port = mc.port1;
          this._onerror = null;
          var fire = function () { var ev = new Event("error"); self.dispatchEvent(ev); if (typeof self._onerror === "function") self._onerror.call(self, ev); };
          var local = function () {
            var key = String(url) + "\u0000" + name + "\u0000" + type, w = pool[key];
            if (!w) { var b = plan(url, o, true, "SharedWorker"); w = pool[key] = new NW(b || url, { name: name, type: b ? "classic" : type }); }
            w.addEventListener("error", function (e) { fire(); e.preventDefault(); });
            w.postMessage({ __fusionWpConnect: 1 }, [mc.port2]);
          };
          var viaBroker = function () {
            var id = Math.random().toString(36).slice(2) + Date.now().toString(36);
            conns[id] = fire; mine.push(id);
            W.top.postMessage({ fusionWpShared: "connect", id: id, sid: SID, doc: DOC, url: abs, name: name, type: type }, "*", [mc.port2]);
          };
          var go = function () { if (abs && BROKER === 1) viaBroker(); else local(); };
          if (abs && BROKER === 0) waiting.push(go); else go();
        }
        get onerror() { return this._onerror; }
        set onerror(f) { this._onerror = typeof f === "function" ? f : null; }
      }
      Object.defineProperty(FusionSharedWorker, "name", { value: "SharedWorker" });
      W.SharedWorker = FusionSharedWorker;
    }
    // TT43: the HOST document of shared workers (served by the server as /api/wp/s/<sid>/__shared-host for one site,
    // framed hidden by the broker). Only the Fusion window that framed it may attach ports; each (script, name, type)
    // runs ONE worker under this runtime, terminated when its last connection is released.
    if (D && me.dataset.sharedHost === "1") {
      var hosted = {};
      W.addEventListener("message", function (e) {
        var d = e.data;
        if (!d || typeof d.fusionWpShared !== "string" || e.source !== W.parent || e.origin !== HOME.origin) return;
        if (d.fusionWpShared === "attach" && e.ports && e.ports[0] && typeof d.key === "string") {
          var h = hosted[d.key];
          if (!h) {
            var b = plan(String(d.url), { name: String(d.name || ""), type: d.type === "module" ? "module" : "classic" }, true, "SharedWorker");
            if (!b) return;
            h = hosted[d.key] = { w: new NW(b, { name: String(d.name || ""), type: "classic" }) };
            (function (key) { h.w.addEventListener("error", function (ev) { ev.preventDefault(); W.parent.postMessage({ fusionWpShared: "error", key: key }, "*"); }); })(d.key);
          }
          h.w.postMessage({ __fusionWpConnect: 1 }, [e.ports[0]]);
        } else if (d.fusionWpShared === "release" && hosted[d.key]) {
          hosted[d.key].w.terminate(); delete hosted[d.key];
        }
      });
      W.parent.postMessage({ fusionWpShared: "host-ready" }, "*");
    }
  });
  if (CFG) guard(function () {
    // worker scope: importScripts and new Request() resolve against the SITE's script URL, not the blob: bootstrap
    var _is = W.importScripts;
    if (CFG.module) W.importScripts = function () { throw new TypeError("Failed to execute 'importScripts' on 'WorkerGlobalScope': Module scripts don't support importScripts()."); };
    // TT41: imported scripts are the worker's SUBRESOURCES (no-cors, SameSite cookies for the page): tagged "r"
    else if (typeof _is === "function") W.importScripts = function () { return _is.apply(W, Array.prototype.map.call(arguments, function (u) { return rtag(enc(String(u))); })); };
    // TT41: self.location is a WorkerLocation for the worker script's REAL URL (it was the blob: bootstrap's), and
    // self.origin the site's origin ("null" for a data: worker) — own properties shadowing the prototype's
    var LOCS = String(CFG.loc || CFG.url), lu = null;
    try { lu = new URL(LOCS); } catch (e) { lu = null; }
    if (lu) {
      var WL = W.WorkerLocation, fake = Object.create(WL ? WL.prototype : Object.prototype);
      var opaque = /^data:/i.test(LOCS);
      var vals = { href: lu.href, origin: opaque ? "null" : lu.protocol === "blob:" ? new URL(lu.pathname).origin : lu.origin, protocol: lu.protocol, host: lu.host, hostname: lu.hostname, port: lu.port, pathname: lu.pathname, search: lu.search, hash: lu.hash };
      Object.keys(vals).forEach(function (k) { Object.defineProperty(fake, k, { configurable: true, enumerable: false, get: function () { return vals[k]; } }); });
      Object.defineProperty(fake, "toString", { configurable: true, enumerable: false, writable: true, value: function toString() { return vals.href; } });
      Object.defineProperty(W, "location", { configurable: true, enumerable: true, get: function () { return fake; } });
      Object.defineProperty(W, "origin", { configurable: true, enumerable: true, writable: true, value: vals.origin });
    }
    var NR = W.Request;
    if (typeof NR === "function") {
      var FR = function Request(input, init) {
        if (typeof input === "string" || (W.URL && input instanceof URL)) { try { input = new URL(String(input), TARGET).href; } catch (e) { /* the native error */ } }
        return Reflect.construct(NR, init === undefined ? [input] : [input, init], new.target || FR);
      };
      FR.prototype = NR.prototype; Object.setPrototypeOf(FR, NR);
      W.Request = FR;
    }
  });
  if (CFG) { netExtras(); return; } // a worker has no DOM: the rest of this file is for documents

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
        set: function (v) { d.set.call(this, encFor(this, p[1].toLowerCase(), v)); },
      });
    });
  });
  [["HTMLImageElement", "srcset"], ["HTMLSourceElement", "srcset"]].forEach(function (p) {
    guard(function () {
      var C = W[p[0]], d = C && Object.getOwnPropertyDescriptor(C.prototype, p[1]); if (!d || !d.set) return;
      Object.defineProperty(C.prototype, p[1], { configurable: true, enumerable: d.enumerable, get: d.get, set: function (v) { d.set.call(this, encSrcset(v)); } });
    });
  });
  guard(function () {
    var C = W.HTMLIFrameElement, d = C && Object.getOwnPropertyDescriptor(C.prototype, "srcdoc"); if (!d || !d.set) return;
    Object.defineProperty(C.prototype, "srcdoc", { configurable: true, enumerable: d.enumerable, get: d.get, set: function (v) { d.set.call(this, rewriteSrcdoc(v, 0)); } });
  });
  var ATTR = { src: 1, href: 1, action: 1, formaction: 1, poster: 1, background: 1 };
  var _setAttr = W.Element.prototype.setAttribute;
  // TT42 (WP-19): a srcdoc set by script is rewritten before the frame sees it — parsed INERT (DOMParser loads
  // nothing), every URL attribute fixed as if it were set on a live element, nested srcdoc too, and this runtime's own
  // tag (data-srcdoc) put first in its <head>. Markup that already carries a srcdoc runtime is ours: unchanged.
  function srcdocTag(doc) {
    var t = doc.createElement("script");
    for (var i = 0; i < me.attributes.length; i++) _setAttr.call(t, me.attributes[i].name, me.attributes[i].value);
    _setAttr.call(t, "data-srcdoc", "1");
    return t;
  }
  function rewriteSrcdoc(v, depth) {
    var s = String(v);
    if (/data-srcdoc="1"/.test(s) && s.indexOf("/wp-shim.js") >= 0) return s;
    if ((depth || 0) > 3 || !W.DOMParser || !me.attributes) return s;
    try {
      var doc = new W.DOMParser().parseFromString(s, "text/html");
      var all = doc.querySelectorAll("[src],[href],[action],[formaction],[poster],[srcset],[background],object[data],iframe[srcdoc]");
      for (var j = 0; j < all.length; j++) {
        var x = all[j];
        for (var a = 0; a < x.attributes.length; a++) {
          var at = x.attributes[a], k = at.name.toLowerCase();
          var nv = k === "srcdoc" ? rewriteSrcdoc(at.value, (depth || 0) + 1) : fixAttr(x, at.name, at.value);
          if (nv !== at.value) _setAttr.call(x, at.name, nv);
        }
      }
      doc.head.insertBefore(srcdocTag(doc), doc.head.firstChild);
      return (doc.doctype ? "<!DOCTYPE " + doc.doctype.name + ">" : "") + doc.documentElement.outerHTML;
    } catch (e) { return s; }
  }
  function fixAttr(el, name, value) {
    var k = String(name).toLowerCase();
    if (k === "srcdoc" && el.tagName === "IFRAME") return rewriteSrcdoc(value, 0);
    if (ATTR[k] || (k === "data" && el.tagName === "OBJECT")) return encFor(el, k, value);
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
    var SEL = "[src],[href],[action],[formaction],[poster],[srcset],[background],object[data],iframe[srcdoc]";
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
    }).observe(D.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "href", "action", "formaction", "poster", "srcset", "background", "data", "srcdoc"] });
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
  var findController = D && W.FusionWpFind && typeof W.FusionWpFind.create === "function"
    ? W.FusionWpFind.create(D, function (r) {
        try { W.parent.postMessage({ fusionWp: "found", q: r.q, n: r.n, i: r.i, truncated: r.truncated }, "*"); } catch (e) { /* detached */ }
      })
    : null;
  // Legacy fallback for an older cached shell whose find runtime is not yet available. The normal path uses the
  // bounded, cross-inline DOM index from /wp-find.js; the fallback intentionally remains usable, not authoritative.
  var hits = [], cur = -1, lastQ = null, dirty = true;
  if (!findController) guard(function () { new MutationObserver(function () { dirty = true; }).observe(D, { subtree: true, childList: true, characterData: true }); });
  function find(q, dir) {
    q = String(q || "");
    if (findController) { findController.find(q, dir); return; }
    if (q !== lastQ || dirty) {
      if (q !== lastQ || dirty) cur = -1;
      lastQ = q; hits = []; dirty = false;
      if (q && D.body) {
        var lq = q.toLowerCase(), w = D.createTreeWalker(D.body, 4 /* SHOW_TEXT */, null), n;
        while ((n = w.nextNode())) {
          var p = n.parentElement;
          if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.nodeName) || (p.checkVisibility && !p.checkVisibility())) continue;
          var t = n.nodeValue.toLowerCase(), i = t.indexOf(lq);
          while (i >= 0) { hits.push([n, i]); i = t.indexOf(lq, i + 1); }
        }
      }
    }
    if (hits.length && cur < 0 && dir === -1) cur = 0;
    if (cur >= hits.length) cur = -1;
    if (hits.length && q) {
      cur = (cur + (dir === -1 ? -1 : 1) + hits.length) % hits.length;
      var h = hits[cur], r = D.createRange();
      r.setStart(h[0], h[1]); r.setEnd(h[0], h[1] + q.length);
      var sel = W.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      if (h[0].parentElement) h[0].parentElement.scrollIntoView({ block: "center" });
    }
    try { W.parent.postMessage({ fusionWp: "found", q: q, n: q ? hits.length : 0, i: q && hits.length ? cur + 1 : 0, truncated: false }, "*"); } catch (e) { /* detached */ }
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
  netExtras();
  // ---- TT38 (WP-08): WebSocket through the same-origin bridge (src/lib/server/wp-ws.ts), EventSource through the proxy.
  // The page's CSP refuses native sockets to the internet; this class keeps the WebSocket API (readyState, events in
  // order, binaryType, bufferedAmount, close codes, the constructor's errors) and carries the frames over fetch.
  // TT39: a function, so Web Workers (which return before the DOM part) install the same classes.
  function netExtras() {
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
        raw.call(W, ABS + PREFIX + SID + "/__ws/open", {
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
        raw.call(W, ABS + PREFIX + SID + "/__ws/" + this._id, { method: "POST", credentials: "omit", cache: "no-store", headers: { "content-type": "text/plain" }, body: concat(bytes, total) })
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
        super(tag(enc(abs), init && init.withCredentials ? "include" : "same-origin"), { withCredentials: false });
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
  }
  D.addEventListener("DOMContentLoaded", report);
  W.addEventListener("load", report);
  W.addEventListener("popstate", report);
  W.addEventListener("hashchange", report);
})(typeof window !== "undefined" ? window : globalThis);
