import { NextResponse } from "next/server";
/** Stream a bounded UTF-8 object. The proxy must not pre-clone this endpoint. */
export async function boundedJsonObject(request: Request, limit: number): Promise<Record<string, unknown> | Response> {
  const fail = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) return fail("Request body exceeds its byte limit", 413);
  const reader = request.body?.getReader(); if (!reader) return fail("Expected a JSON object");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const result = await reader.read(); if (result.done) break;
      size += result.value.byteLength;
      if (size > limit) { void reader.cancel().catch(() => undefined); return fail("Request body exceeds its byte limit", 413); }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!data || typeof data !== "object" || Array.isArray(data)) return fail("Expected a JSON object");
    return data as Record<string, unknown>;
  } catch { return fail("Expected a valid UTF-8 JSON object"); }
}
