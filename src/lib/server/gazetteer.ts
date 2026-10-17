/**
 * TT28: server-side loader for the offline gazetteer. The GeoNames TSV (≈ 26k cities, CC BY 4.0) is read from the
 * installed npm package once, on first use, and parsed by our own gazetteer-core (≈ 0.5 s, kept in memory).
 * Nothing is fetched from the network: lookups never leave this machine.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseGeoNames, type Gazetteer } from "@/lib/gazetteer-core";

const FILE = path.join(process.cwd(), "node_modules", "cities-15000-structured", "dist", "cities15000.txt");
let loading: Promise<Gazetteer> | null = null;

export function gazetteer(): Promise<Gazetteer> {
  loading ??= readFile(FILE, "utf8").then(parseGeoNames).catch((e) => { loading = null; throw e; });
  return loading;
}
