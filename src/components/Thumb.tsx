"use client";
/** TT54 (FF-13) — lazy thumbnail: renders the file-type icon until the thumbnail service delivers (or explains why not). */
import { useEffect, useRef, useState } from "react";
import { getThumbnail, isPrivateThumbnailPath, type ThumbNode } from "@/lib/thumbs/service";
import { privacy } from "@/lib/privacy/session";
import type { PhotoRecipe } from "@/lib/photos/recipe";
import { FileIcon } from "./AppIcon";

export default function Thumb({ node, size, iconSize, max = 256, recipe, hasSidecar, fit = "contain", radius = 6, label }: {
  node: ThumbNode; size: number | string; iconSize?: number; max?: number; recipe?: PhotoRecipe | null; hasSidecar?: boolean; fit?: "contain" | "cover"; radius?: number; label?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [got, setGot] = useState<{ key: string; url: string | null; reason?: string } | null>(null);
  const key = `${node.path}|${node.sha256 ?? ""}|${node.size}|${max}|${recipe === undefined ? (hasSidecar ? "s" : "-") : JSON.stringify(recipe)}`;
  useEffect(() => {
    const el = box.current; if (!el) return;
    let live = true, visible = false, request = 0, lastStorage: string | undefined;
    const sensitive = isPrivateThumbnailPath(node.path);
    const load = () => {
      if (!visible) return;
      const id = ++request;
      if (sensitive && privacy.status().storage !== "unlocked") {
        queueMicrotask(() => { if (live && id === request) setGot({ key, url: null, reason: "Persistent Storage locked" }); });
        return;
      }
      getThumbnail(node, { max, recipe, hasSidecar }).then((t) => { if (live && id === request) setGot({ key, url: t.url, reason: t.reason }); }).catch(() => {});
    };
    const off = sensitive ? privacy.subscribe((s) => {
      const state = s.storage === "unlocked" ? `unlocked:${s.fingerprint ?? ""}` : "locked";
      if (state !== lastStorage) { lastStorage = state; load(); }
    }) : () => {};
    const io = new IntersectionObserver((ents) => {
      if (!ents.some((e) => e.isIntersecting)) return;
      io.disconnect(); visible = true; load();
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => { live = false; request++; off(); io.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures every input
  }, [key]);
  const cur = got && got.key === key ? got : null;
  return (
    <div ref={box} data-thumb={cur?.url ? "ready" : cur ? "none" : "pending"} title={cur && !cur.url ? cur.reason : undefined}
      style={{ width: size, height: size, display: "grid", placeItems: "center", flex: "none", overflow: "hidden", borderRadius: radius }}>
      {cur?.url
        // eslint-disable-next-line @next/next/no-img-element -- blob: URL of a locally rendered thumbnail
        ? <img src={cur.url} alt={label ?? `Preview of ${node.name}`} draggable={false}
            style={{ width: "100%", height: "100%", objectFit: fit, borderRadius: radius }} />
        : <FileIcon name={node.name} kind="file" size={iconSize ?? (typeof size === "number" ? Math.round(size * 0.62) : 34)} />}
    </div>
  );
}
