import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { Page } from "playwright";
import { makeHarness } from "./harness.mts";
import { launchChromium } from "./browser-launch.mts";

const { test, finish } = makeHarness("tt85-find");
const browser = await launchChromium();
const page = await browser.newPage();

async function fixture(html: string): Promise<void> {
  await page.setContent(`<!doctype html><html><head><style>.gone{display:none}</style></head><body>${html}</body></html>`);
  await page.addScriptTag({ path: resolve("public/wp-find.js") });
}

await test("PR-07n: real Chromium DOM index crosses inline nodes, applies block whitespace, excludes hidden/non-text surfaces, wraps next/previous and selects the exact source Range", { "PR-07n": "full" }, async () => {
  await fixture(`
    <p><span>Al</span><strong>PHA</strong> <em>beta</em></p>
    <p>Alpha<span> </span><span>Beta</span></p>
    <p>alpha</p><p>beta</p>
    <div hidden>alpha beta</div><div style="display:none">alpha beta</div>
    <div aria-hidden="true">alpha beta</div><section inert>alpha beta</section>
    <script>alpha beta</script><style>.x{content:"alpha beta"}</style>
    <input value="alpha beta"><textarea>alpha beta</textarea><template>alpha beta</template>
  `);
  const got = await page.evaluate(() => {
    const results: any[] = [];
    const controller = (window as any).FusionWpFind.create(document, (r: any) => results.push(r));
    const first = controller.find("alpha beta", 1);
    const selectedFirst = String(getSelection());
    const second = controller.find("alpha beta", 1);
    const selectedSecond = String(getSelection());
    const prev = controller.find("alpha beta", -1);
    const selectedPrev = String(getSelection());
    controller.destroy();
    return { first, second, prev, selectedFirst, selectedSecond, selectedPrev, results };
  });
  assert.deepEqual([got.first.n, got.first.i], [3, 1], "three visible matches: two across inline nodes and one across block paragraphs");
  assert.equal(got.selectedFirst, "AlPHA beta", "first range spans inline elements and preserves the source text");
  assert.deepEqual([got.second.n, got.second.i], [3, 2]);
  assert.equal(got.selectedSecond, "Alpha Beta");
  assert.deepEqual([got.prev.n, got.prev.i], [3, 1]);
  assert.equal(got.selectedPrev, "AlPHA beta");
  assert.equal(got.results.at(-1).q, "alpha beta");
});

await test("PR-07n: collapsed multi-space source runs keep exact Range boundaries before the following word", { "PR-07n": "full" }, async () => {
  await fixture(`<p id="space">See sponsorship   packages</p>`);
  const got = await page.evaluate(() => {
    const controller = (window as any).FusionWpFind.create(document);
    const whole = controller.find("sponsorship packages", 1);
    const wholeRange = getSelection()!.getRangeAt(0);
    const wholeText = String(getSelection());
    const wholeOffsets = [wholeRange.startOffset, wholeRange.endOffset];
    const following = controller.find("packages", 1);
    const followingRange = getSelection()!.getRangeAt(0);
    const followingText = String(getSelection());
    const followingOffsets = [followingRange.startOffset, followingRange.endOffset];
    const sourceNode = document.querySelector("#space")!.firstChild;
    const whitespace = (window as any).FusionWpFind.buildIndex(document).segments.find((s: any) => s.space && !s.artificial && s.node === sourceNode && s.sourceEnd - s.sourceStart > 1);
    controller.destroy();
    return { whole, wholeText, wholeOffsets, following, followingText, followingOffsets, whitespaceSpan: [whitespace?.sourceStart, whitespace?.sourceEnd] };
  });
  assert.deepEqual([got.whole.n, got.whole.i], [1, 1]);
  assert.equal(got.wholeText, "sponsorship packages", "browser selection exposes the rendered, whitespace-collapsed text");
  assert.deepEqual(got.wholeOffsets, [4, "See sponsorship   packages".length], "the DOM Range still spans the complete original whitespace run");
  assert.deepEqual([got.following.n, got.following.i], [1, 1]);
  assert.equal(got.followingText, "packages", "the following word does not lose its first character");
  assert.deepEqual(got.followingOffsets, [18, 26], "the Range begins at the first source character after the complete whitespace run");
  assert.deepEqual(got.whitespaceSpan, [15, 18], "the normalized-space segment retains the full original run start and end");
});

await test("PR-07n: overlapping hits, query-reset reverse start, empty/no-match behavior, Unicode combining marks, and live mutation recount", { "PR-07n": "full" }, async () => {
  await fixture(`<p id="t">banana</p><p id="accent">Re\u0301sume\u0301</p>`);
  const got = await page.evaluate(async () => {
    const results: any[] = [];
    const controller = (window as any).FusionWpFind.create(document, (r: any) => results.push(r));
    const reverseStart = controller.find("ana", -1);
    const backwards = String(getSelection());
    const forwardWrap = controller.find("ana", 1);
    const forwardAgain = controller.find("ana", 1);
    (document.getElementById("t") as HTMLElement).textContent = "banana banana";
    // Observer marks the index dirty in a microtask; search again before its 50 ms rebuild timer fires.
    await Promise.resolve();
    const whileMutationPending = controller.find("ana", 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterMutation = results.at(-1);
    const resume = controller.find("re\u0301sume\u0301", 1);
    const resumeText = String(getSelection());
    const missing = controller.find("not present", 1);
    const clear = controller.find("", 1);
    controller.destroy();
    return { reverseStart, backwards, forwardWrap, forwardAgain, whileMutationPending, afterMutation, resume, resumeText, missing, clear };
  });
  assert.deepEqual([got.reverseStart.n, got.reverseStart.i], [2, 2], "Shift+Enter starts at the last overlapping match");
  assert.equal(got.backwards, "ana");
  assert.deepEqual([got.forwardWrap.n, got.forwardWrap.i], [2, 1]);
  assert.deepEqual([got.forwardAgain.n, got.forwardAgain.i], [2, 2]);
  assert.deepEqual([got.whileMutationPending.n, got.whileMutationPending.i], [4, 3], "a search during pending mutation re-index advances from the preserved previous ordinal");
  assert.deepEqual([got.afterMutation.n, got.afterMutation.i], [4, 3], "mutation observer result stays on the newly selected match");
  assert.deepEqual([got.resume.n, got.resume.i], [1, 1]);
  assert.equal(got.resumeText, "Re\u0301sume\u0301", "decomposed accents remain searchable without Unicode normalization changing source offsets");
  assert.deepEqual([got.missing.n, got.missing.i], [0, 0]);
  assert.deepEqual([got.clear.n, got.clear.i], [0, 0]);
});

await test("PR-07n: scanning stops at configured text/node limits and explicitly marks incomplete counts; class visibility changes re-count", { "PR-07n": "full" }, async () => {
  await fixture(`<p id="long">${"x".repeat(100)} needle</p><p id="toggle">needle</p>`);
  const got = await page.evaluate(async () => {
    const results: any[] = [];
    const controller = (window as any).FusionWpFind.create(document, (r: any) => results.push(r), { maxText: 64, maxNodes: 200 });
    const clipped = controller.find("needle", 1);
    (document.getElementById("toggle") as HTMLElement).classList.add("gone");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterHide = results.at(-1);
    controller.destroy();

    const byNodes = (window as any).FusionWpFind.create(document, undefined, { maxText: 64, maxNodes: 3 });
    const nodeCapped = byNodes.find("needle", 1);
    byNodes.destroy();

    const container = document.createElement("div");
    container.innerHTML = "<span>x</span>".repeat(24) + "<span>needle</span>";
    document.body.replaceChildren(container);
    const nodeOnly = (window as any).FusionWpFind.create(document, undefined, { maxText: 4096, maxNodes: 5 });
    const nodeOnlyCapped = nodeOnly.find("needle", 1);
    nodeOnly.destroy();
    return { clipped, afterHide, nodeCapped, nodeOnlyCapped };
  });
  assert.deepEqual([got.clipped.n, got.clipped.i, got.clipped.truncated], [0, 0, true], "match outside the scanned text prefix is not presented as a complete negative");
  assert.equal(got.afterHide.truncated, true);
  assert.deepEqual([got.nodeCapped.n, got.nodeCapped.truncated], [0, true], "combined text/node caps remain explicit");
  assert.deepEqual([got.nodeOnlyCapped.n, got.nodeOnlyCapped.truncated], [0, true], "a pure DOM-node cap stops before a later hit and declares partial coverage");
});

await page.close();
await browser.close();
finish();
