// Test-only preload (never loaded by the app itself), used by e2e-tt37 "client resets":
// - FUSION_UNCAUGHT_LOG: record every uncaught exception with its raw stack, before Next formats it;
// - FUSION_REQUEST_LOG: record every request the HTTP server receives (method + path), so a test can prove that a
//   middleware rewrite stayed internal — an external rewrite would arrive here as a second request.
const fs = require("fs");
const file = process.env.FUSION_UNCAUGHT_LOG;
if (file) {
  process.on("uncaughtExceptionMonitor", (e, origin) => {
    try { fs.appendFileSync(file, `[${new Date().toISOString()}] ${origin}: ${e && e.stack}\n  code=${e && e.code}\n`); } catch {}
  });
}
const reqLog = process.env.FUSION_REQUEST_LOG;
if (reqLog) {
  const http = require("http");
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (ev, req, ...rest) {
    if (ev === "request" && req) { try { fs.appendFileSync(reqLog, `${req.method} ${req.url}\n`); } catch {} }
    return emit.call(this, ev, req, ...rest);
  };
}
