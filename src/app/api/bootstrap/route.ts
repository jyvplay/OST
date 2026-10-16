import { NextResponse } from "next/server";
import { bootstrap } from "@/lib/server/bootstrap";

export const dynamic = "force-dynamic";

export async function GET() {
  const result = await bootstrap();
  return NextResponse.json({ ok: true, ...result });
}
export const POST = GET;
