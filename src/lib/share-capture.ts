import { displayMedia } from "./access-log";

/** Owns a native screen-capture grant independently of React rendering. A
 * permission picker may settle after Leave/unmount: that late grant is stopped
 * before it can become a hidden capture. No device or stream is fabricated. */
export class ShareCapture {
  private generation = 0;
  private active = true;
  private stream: MediaStream | null = null;
  activate(): void { this.active = true; }
  async start(): Promise<{ stream: MediaStream; startedAt: number }> {
    this.stop();
    const generation = this.generation;
    const stream = await displayMedia("Share", { video: { frameRate: 30 }, audio: false });
    if (!this.active || generation !== this.generation) {
      for (const track of stream.getTracks()) track.stop();
      throw new DOMException("Screen capture was cancelled", "AbortError");
    }
    this.stream = stream;
    return { stream, startedAt: Date.now() };
  }
  stop(): void {
    this.generation++;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }
  dispose(): void { this.active = false; this.stop(); }
}
