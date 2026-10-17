import { NextResponse } from "next/server";

/**
 * Read a request body that must be a JSON object.
 *
 * TT24 repair. Before this, every API handler did `(await req.json()) as T`, which:
 *  - threw on an empty body → unhandled 500 (22/22 handlers measured);
 *  - accepted `null` and then crashed on `b.field` → 500 (19/22);
 *  - accepted `[]` / `42` as if they were objects, and three handlers (alerts, notes, probe) wrote a record.
 *
 * Usage (the guard narrows the type):
 *   const b = (await readJsonObject(req)) as { title?: string } | Response;
 *   if (b instanceof Response) return b;
 *
 * Malformed non-empty JSON is already rejected by src/proxy.ts; this repeats the check so a handler stays safe
 * even if the proxy matcher changes.
 */
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | Response> {
  let text: string;
  try { text = await req.text(); } catch { return bad("could not read the request body"); }
  if (!text.trim()) return bad("empty body: expected a JSON object");
  let value: unknown;
  try { value = JSON.parse(text); } catch { return bad("malformed JSON body"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return bad("expected a JSON object");
  return value as Record<string, unknown>;
}

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });
