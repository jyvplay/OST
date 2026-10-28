// TT107 fixture origin: a page that refuses framing, plus a permissive one, so the
// proxy / reader / embed-probe paths can be tested against a real HTTP server.
import { createServer } from 'node:http';
const port = Number(process.argv[2] ?? 4003);
const ARTICLE = `<!doctype html><html><head><title>Fixture &amp; "Article"</title>
<style>.ad{display:none}</style><script>window.tracked=1;document.title='hijacked'</script></head>
<body><nav><a href="/nav-link">Navigation we drop</a></nav><header>Site header we drop</header>
<article><h1>Readable heading</h1><p>First paragraph of real article text.</p>
<p>Second paragraph with a <a href="/relative/next">relative link</a> and an <img src="/pic.png" alt="a picture">.</p>
<p onclick="steal()">Paragraph carrying an inline handler.</p>
<a href="javascript:steal()">Script link</a><script>steal()</script></article>
<footer>Footer we drop</footer></body></html>`;
createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/pic.png') { res.setHeader('content-type', 'image/png'); res.end(Buffer.from('89504e470d0a1a0a', 'hex')); return; }
  if (path === '/plain.txt') { res.setHeader('content-type', 'text/plain'); res.end('not html'); return; }
  if (path === '/inject') {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>&lt;img src=x onerror=&quot;window.pwned=1&quot;&gt;</title>
<article><p>Body text.</p><a href="jajavascript:vascript:window.pwned=1">evasion</a>
<a href="JaVaScRiPt:window.pwned=1">mixed case</a><a href="data:text/html,<b>x</b>">data url</a>
<img src="javascript:window.pwned=1" alt="bad"></article>`);
    return;
  }
  if (path === '/open') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(ARTICLE); return; }
  if (path === '/csp') {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('content-security-policy', "frame-ancestors 'none'; default-src 'self'");
    res.end(ARTICLE); return;
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('content-security-policy', "frame-ancestors 'none'");
  res.end(ARTICLE);
}).listen(port, '127.0.0.1', () => console.log('tt107 fixture on ' + port));
