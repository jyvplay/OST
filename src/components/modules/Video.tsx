"use client";
import type { ModuleProps } from "../shell-context";
import { StreamApp } from "./Streams";

/** TT27 SM-01: video player for YouTube, Vimeo, Dailymotion, Twitch, PeerTube and direct video links. */
export default function VideoModule(props: ModuleProps) { return <StreamApp {...props} kind="video" />; }
