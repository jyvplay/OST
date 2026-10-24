import { NextResponse, type NextRequest } from "next/server";
import { gazetteer } from "@/lib/server/gazetteer";
import { nearestCities, describeNear, GEONAMES_ATTRIBUTION } from "@/lib/gazetteer-core";

export const dynamic = "force-dynamic";

/** GET /api/places/near?lat=35.78&lng=-78.64&k=3 → nearest cities (exact great-circle nearest, offline). */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const lat = Number(sp.get("lat")), lng = Number(sp.get("lng")), k = Number(sp.get("k") ?? 1);
  if (!sp.get("lat") || !sp.get("lng") || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 540) {
    return NextResponse.json({ ok: false, error: "lat (−90…90) and lng required" }, { status: 400 });
  }
  const units = sp.get("units") === "imperial" ? "imperial" : "metric";
  let g;
  try { g = await gazetteer(); } catch { return NextResponse.json({ ok: false, error: "gazetteer data missing (npm package cities-15000-structured)" }, { status: 503 }); }
  const results = nearestCities(g, lat, lng, Number.isFinite(k) ? k : 1).map((h) => ({
    id: h.city.id, name: h.city.name, label: h.label, lat: h.city.lat, lng: h.city.lng, country: h.city.cc,
    km: h.km, bearing: h.bearing, compass: h.compass, description: describeNear(h, units),
  }));
  return NextResponse.json({ ok: true, results, attribution: GEONAMES_ATTRIBUTION });
}
