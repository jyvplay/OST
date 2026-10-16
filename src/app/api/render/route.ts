import { NextResponse, type NextRequest } from "next/server";
import { renderCapable, renderSnapshot } from "@/lib/server/render";
import { isPrivateHostGuard } from "@/lib/server/netguard";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (req.nextUrl.searchParams.get("probe") === "1") {
    return NextResponse.json({ ok: true, capable: await renderCapable() });
  }
  if (!url) return NextResponse.json({ ok: false, error: "url required" }, { status: 400 });
  const guardErr = await isPrivateHostGuard(url);
  if (guardErr) return NextResponse.json({ ok: false, error: guardErr }, { status: 400 });
  try {
    const { png, title, finalUrl } = await renderSnapshot(url);
    return new NextResponse(new Uint8Array(png), {
      headers: { "content-type": "image/png", "x-fusion-render-title": encodeURIComponent(title), "x-fusion-render-url": finalUrl },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message ?? e) }, { status: 502 });
  }
}
