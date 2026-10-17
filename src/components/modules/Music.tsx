"use client";
import type { ModuleProps } from "../shell-context";
import { StreamApp } from "./Streams";

/** TT27 SM-02: music streaming from Spotify and SoundCloud (official embed players) and direct audio links. */
export default function MusicModule(props: ModuleProps) { return <StreamApp {...props} kind="audio" />; }
