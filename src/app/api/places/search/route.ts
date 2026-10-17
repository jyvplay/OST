import { NextResponse, type NextRequest } from "next/server";
import { gazetteer } from "@/lib/server/gazetteer";
import { searchCities, GEONAMES_ATTRIBUTION } from "@/lib/gazetteer-core";

export const dynamic = "force-dynamic";

/** GET /api/places/search?q=Paris,%20TX&limit=10 → offline city search (GeoNames cities ≥ 15k people). */
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").slice(0, 200);
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 10);
  let g;
  try { g = await gazetteer(); } catch { return NextResponse.json({ ok: false, error: "gazetteer data missing (npm package cities-15000-structured)" }, { status: 503 }); }
  const results = searchCities(g, q, Number.isFinite(limit) ? limit : 10).map(({ city: c, label, score }) => ({
    id: c.id, name: c.name, label, lat: c.lat, lng: c.lng, country: c.cc, admin1: c.a1, population: c.pop, timezone: c.tz, score,
  }));
  return NextResponse.json({ ok: true, q, results, attribution: GEONAMES_ATTRIBUTION, scope: "cities with population ≥ 15,000 (no street addresses)" });
}
