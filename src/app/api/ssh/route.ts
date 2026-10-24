import { NextResponse, type NextRequest } from "next/server";
import { readJsonObject } from "@/lib/http-json";
import { createSession, fusionCaller, parseInit, readKnownHosts, sessions } from "@/lib/server/ssh/bridge";
import { KNOWN_HOSTS_PATH, forgetHost, parseKnownHosts } from "@/lib/server/ssh/known-hosts";
import { fingerprint } from "@/lib/server/ssh/crypto";
import { generateEd25519 } from "@/lib/server/ssh/keys";
import { writeFile } from "@/lib/server/vfs";
import { getRoute } from "@/lib/server/wp-route";
import { describeRoute } from "@/lib/server/wp-tunnel";

/**
 * TT44 (TD-03) SSH sessions (see src/lib/server/ssh/bridge.ts).
 *   GET                         → open sessions, the network route SSH will use, known_hosts entries (fingerprints)
 *   POST {host, port, username, cols, rows, term?, privateKey?, passphrase?, direct?, lang?}
 *                               → {id}; the connection starts when GET /api/ssh/<id> attaches
 *   POST {op:"keygen", comment, passphrase?} → a new ed25519 key pair (OpenSSH format); nothing is stored here —
 *                               the browser saves it (in /Private it is encrypted in the tab)
 *   POST {op:"forget", host, port} → removes that host's plain lines from known_hosts
 * Fusion window only (same-origin); amnesic sessions (x-fusion-amnesic, set by the privacy layer) never write.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const json = (j: unknown, status = 200) => NextResponse.json(j, { status, headers: { "cache-control": "no-store" } });

export async function GET(req: NextRequest) {
  if (!fusionCaller(req)) return json({ error: "forbidden" }, 403);
  const kh = await readKnownHosts();
  const { entries, bad } = parseKnownHosts(kh);
  return json({
    sessions: [...sessions().values()].filter((s) => s.state !== "closed").map((s) => s.summary()),
    route: describeRoute(getRoute()),
    knownHosts: { path: KNOWN_HOSTS_PATH, badLines: bad, entries: entries.map((e) => ({ line: e.line, marker: e.marker, hosts: e.hosts.startsWith("|1|") ? "(hashed)" : e.hosts, type: e.type, fingerprint: fingerprint(e.blob), comment: e.comment })) },
  });
}

export async function POST(req: NextRequest) {
  if (!fusionCaller(req)) return json({ error: "forbidden" }, 403);
  const b = await readJsonObject(req);
  if (b instanceof Response) return b;
  const amnesic = req.headers.get("x-fusion-amnesic") === "1";
  if (b.op === "keygen") {
    const comment = String(b.comment ?? "fusion").slice(0, 200).replace(/[\r\n]/g, " ");
    const pass = typeof b.passphrase === "string" && b.passphrase ? b.passphrase : undefined;
    return json({ ok: true, ...generateEd25519(comment, pass), encrypted: !!pass });
  }
  if (b.op === "forget") {
    if (amnesic) return json({ ok: false, error: "amnesic session: known_hosts is not written" }, 423);
    const port = Number(b.port ?? 22);
    const r = forgetHost(await readKnownHosts(), String(b.host ?? ""), Number.isInteger(port) ? port : 22);
    if (r.removed) await writeFile({ path: KNOWN_HOSTS_PATH, content: r.text, mime: "text/plain", reason: `ssh: forgot ${b.host}:${port}` });
    return json({ ok: true, removed: r.removed });
  }
  const init = parseInit(b, amnesic);
  if (typeof init === "string") return json({ ok: false, error: init }, 400);
  try {
    const s = createSession(init);
    return json({ ok: true, id: s.id });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 429);
  }
}
