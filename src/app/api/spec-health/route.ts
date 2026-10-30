import { NextResponse } from "next/server";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { db } from "@/db";
import { features } from "@/db/schema";
import { bootstrap } from "@/lib/server/bootstrap";
import { MODULES } from "@/lib/registry";
import { checkRegister } from "@/lib/spec-health";

export const dynamic = "force-dynamic";

/** TT117 SP-01: the register audits itself. Suite existence is read from disk on
 * the server (the only place that can see it); module claims come from the one
 * registry every surface reads. */
export async function GET() {
  await bootstrap();
  const rows = await db.select().from(features);
  const files = await readdir(path.join(process.cwd(), "scripts"), { recursive: true }).catch(() => [] as string[]);
  const suites = new Set(files.filter((f) => f.endsWith(".mts")).map((f) => path.basename(f)));
  const issues = checkRegister(rows, MODULES, suites);
  return NextResponse.json({ ok: true, total: rows.length, issues, checkedAt: new Date().toISOString() });
}
