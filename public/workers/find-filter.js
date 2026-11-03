/** Original bounded, disposable worker: full JavaScript regex without running
 * untrusted backtracking on React's main thread. The caller enforces wall time. */
self.onmessage = event => {
  try {
    const data = event.data;
    if (!data || typeof data.pattern !== "string" || data.pattern.length > 512 || !Array.isArray(data.texts) || data.texts.length > 50) throw new Error("Invalid filter request");
    const regex = new RegExp(data.pattern, data.caseSensitive ? "u" : "iu");
    const indices = [];
    for (let i = 0; i < data.texts.length; i++) {
      if (typeof data.texts[i] !== "string" || data.texts[i].length > 16384) throw new Error("Result exceeds the filter budget");
      if (regex.test(data.texts[i])) indices.push(i);
    }
    self.postMessage({ indices });
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
