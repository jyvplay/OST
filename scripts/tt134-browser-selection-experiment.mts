/** Native browser-primitive experiment, NOT application acceptance or an OS
 * simulator. Four real DOM textarea/event conditions, no app-state mutation.
 * The receipt is observational for the installed browser/platform: do not make
 * read-only arrow behavior a universal HTML assertion. */
import { writeFileSync } from "node:fs";
import { launchChromium } from "./browser-launch.mts";
const browser = await launchChromium();
const cases: { readonly: boolean; stop: boolean; start: number; end: number; selection: string }[] = [];
try {
  for (const readonly of [false, true]) for (const stop of [false, true]) {
    const page = await browser.newPage();
    await page.setContent(`<div id="box"><textarea ${readonly ? "readonly" : ""}>head🧭tail\nsecond line</textarea></div>`);
    if (stop) await page.evaluate(() => document.querySelector("#box")!.addEventListener("keydown", event => event.stopPropagation()));
    const field = page.locator("textarea"); await field.click(); await field.press("Control+Home");
    for (let i = 0; i < 4; i++) await field.press("ArrowRight"); await field.press("Shift+ArrowRight");
    cases.push({ readonly, stop, ...await field.evaluate((node: HTMLTextAreaElement) => ({ start: node.selectionStart, end: node.selectionEnd, selection: node.value.slice(node.selectionStart, node.selectionEnd) })) });
    await page.close();
  }
  const result = { kind: "native-browser-primitive-experiment-not-app-acceptance", browser: browser.version(), cases };
  writeFileSync("docs/evidence/tt134-native-selection-experiment-replay.json", JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
