"use client";
import type { ModuleProps } from "../shell-context";
import { StreamApp } from "./Streams";

import { AmazonMusicPanel } from "../tt145-panels";

/**
 * TT27 SM-02: music streaming from Spotify and SoundCloud (official embed players) and direct audio links.
 *
 * TT145 added the Amazon Music link summary (SM-07) beside the player: pasting an
 * album/track/playlist address from any of the twelve storefronts shows which
 * storefront it belongs to, which marketplace id it resolves to, and what was
 * stripped — without contacting Amazon, because the sandbox cannot.
 */
export default function MusicModule(props: ModuleProps) {
  return (
    <div className="fs-scroll" style={{ height: "100%", display: "grid", gridTemplateRows: "minmax(0, 1fr) auto" }}>
      <StreamApp {...props} kind="audio" />
      <div style={{ padding: "0 12px 12px" }}>
        <AmazonMusicPanel />
      </div>
    </div>
  );
}
