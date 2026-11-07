/**
 * TT142 — CT-01 share send/receive, and DP-07's release-gate aggregation.
 *
 * CT-01's receive side is a trust boundary: a share arrives from an arbitrary
 * app on the device. These tests treat it as hostile input.
 */
import { makeHarness } from "./harness.mts";
import {
  planShare, normaliseShareUrl, interpretShareError, describeSharing, receiveShare, shareDestination,
  SHARE_TEXT_MAX, SHARE_FILES_MAX, SHARE_BYTES_MAX,
} from "../src/lib/share/share-target.ts";

const { test, finish } = makeHarness("tt142-share-gate");

// ── CT-01 send ───────────────────────────────────────────────────────────
await test("CT-01 · only http(s) links leave the app", { "CT-01": "full" }, () => {
  // A share sheet is a trust boundary: handing file: or javascript: to another
  // app is how "share this page" becomes "open a local path on the other side".
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "intent://x", "", "   ", "not a url"]) {
    if (normaliseShareUrl(bad) !== null) throw new Error(`${bad.slice(0, 24)} was accepted as shareable`);
  }
  if (normaliseShareUrl("https://example.com/a?b=1") !== "https://example.com/a?b=1") throw new Error("a plain https URL was altered");
});

await test("CT-01 · credentials in a shared link are stripped, not forwarded", { "CT-01": "full" }, () => {
  // Some share targets log the URL verbatim, so user:pass@ would leak the password.
  const out = normaliseShareUrl("https://user:secret@example.com/x");
  if (!out) throw new Error("a credentialed URL was rejected entirely");
  if (/user|secret/.test(out)) throw new Error(`credentials survived: ${out}`);
  if (out !== "https://example.com/x") throw new Error(`unexpected result ${out}`);
});

await test("CT-01 · oversized fields are trimmed and the trim is reported", { "CT-01": "full" }, () => {
  // navigator.share throws TypeError on data over a limit no browser documents,
  // which leaves the user with a button that does nothing.
  const plan = planShare({ title: "t".repeat(500), text: "x".repeat(SHARE_TEXT_MAX + 100) }, { hasShare: true, canShare: true });
  if (plan.payload.text!.length !== SHARE_TEXT_MAX) throw new Error("text was not trimmed to the limit");
  if (plan.dropped.length < 2) throw new Error("the trims were not reported to the user");
  if (!plan.worthTrying) throw new Error("a trimmed payload was still worth sending");
});

await test("CT-01 · files are dropped when the browser cannot share them", { "CT-01": "full" }, () => {
  const plan = planShare(
    { text: "hello", files: [{ name: "a.txt", size: 10, type: "text/plain" }] },
    { hasShare: true, canShare: true, canShareFiles: false },
  );
  if (plan.payload.files) throw new Error("files were kept on a browser that cannot share files");
  if (!plan.dropped.some((d) => /cannot share files/i.test(d))) throw new Error("the drop was silent");
  // The text still goes, so this is not a total failure.
  if (!plan.worthTrying || plan.payload.text !== "hello") throw new Error("text was lost along with the files");
});

await test("CT-01 · the file count and byte budget are both enforced", { "CT-01": "full" }, () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ name: `${i}.bin`, size: 1, type: "" }));
  const p1 = planShare({ files: many }, { hasShare: true, canShare: true, canShareFiles: true });
  if (p1.payload.files!.length !== SHARE_FILES_MAX) throw new Error(`kept ${p1.payload.files!.length}, want ${SHARE_FILES_MAX}`);
  // One file over the byte cap stops the loop rather than including it.
  const big = planShare(
    { files: [{ name: "a", size: SHARE_BYTES_MAX - 10, type: "" }, { name: "b", size: 100, type: "" }] },
    { hasShare: true, canShare: true, canShareFiles: true },
  );
  if (big.payload.files!.length !== 1) throw new Error(`byte cap not enforced: ${big.payload.files!.length} files`);
  if (!big.dropped.some((d) => /MB/.test(d))) throw new Error("the byte cap was not reported");
});

await test("CT-01 · cancellation is not an error, and refusal is not cancellation", { "CT-01": "full" }, () => {
  // AbortError is the user closing the sheet. Showing that in a red toast
  // teaches the user that the feature is broken.
  const cancel = interpretShareError(Object.assign(new Error("x"), { name: "AbortError" }));
  if (cancel.ok || cancel.reason !== "cancelled") throw new Error(`AbortError classified as ${JSON.stringify(cancel)}`);
  const denied = interpretShareError(Object.assign(new Error("x"), { name: "NotAllowedError" }));
  if (denied.ok || denied.reason !== "refused") throw new Error("NotAllowedError classified as cancellation");
  if (!/gesture/i.test((denied as { detail: string }).detail)) throw new Error("the refusal does not explain the gesture requirement");
  const type = interpretShareError(Object.assign(new Error("Invalid share data"), { name: "TypeError" }));
  if (type.ok || type.reason !== "refused") throw new Error("TypeError was not a refusal");
  // An unknown error still produces a stated refusal, never a throw.
  const odd = interpretShareError(null);
  if (odd.ok) throw new Error("a null error reported success");
});

await test("CT-01 · the pre-share text does not promise what is missing", { "CT-01": "full" }, () => {
  if (!/no share sheet/i.test(describeSharing({}))) throw new Error("a missing share sheet is not admitted");
  if (!/files cannot/i.test(describeSharing({ hasShare: true, canShare: true, canShareFiles: false }))) throw new Error("the file gap is not stated");
  if (!/Shares text/i.test(describeSharing({ hasShare: true, canShare: true, canShareFiles: true }))) throw new Error("the working case is not described");
});

// ── CT-01 receive ────────────────────────────────────────────────────────
const form = (map: Record<string, unknown>) => ({ get: (n: string) => map[n] });

await test("CT-01 · a shared filename cannot traverse into the VFS", { "CT-01": "full" }, () => {
  // The receive side is attacker-adjacent: a hostile app chooses the name.
  for (const name of ["../../etc/passwd", "/etc/shadow", "..\\..\\win.ini", "....//x", "\u0000evil"]) {
    const intent = receiveShare(form({ files: [{ name, size: 5, type: "" }] }));
    const got = intent.files[0].name;
    if (/[/\\]/.test(got)) throw new Error(`"${name}" kept a path separator: ${got}`);
    if (got.startsWith(".")) throw new Error(`"${name}" kept leading dots: ${got}`);
    if (/[\u0000-\u001f]/.test(got)) throw new Error(`"${name}" kept control characters`);
  }
  // A name that is entirely dots still produces something usable.
  if (receiveShare(form({ files: [{ name: "..", size: 1, type: "" }] })).files[0].name !== "shared-file") {
    throw new Error("a degenerate name did not fall back");
  }
});

await test("CT-01 · received text is bounded and stripped of controls", { "CT-01": "full" }, () => {
  const intent = receiveShare(form({
    text: "a\u0000b\u001fc" + "x".repeat(SHARE_TEXT_MAX),
    title: "t".repeat(500),
  }));
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(intent.text)) throw new Error("control characters survived");
  if (intent.text.length > SHARE_TEXT_MAX) throw new Error("text was not bounded");
  if (intent.title.length > 200) throw new Error("title was not bounded");
  if (!intent.notes.length) throw new Error("the trimming was not reported");
  // Interior newlines and tabs are legitimate text and must survive.
  const multi = receiveShare(form({ text: "line one\nline two\tend" }));
  if (!multi.text.includes("\n")) throw new Error("a legitimate newline was stripped");
});

await test("CT-01 · a hostile link is dropped from a received share", { "CT-01": "full" }, () => {
  const intent = receiveShare(form({ url: "javascript:fetch('/x')", text: "hi" }));
  if (intent.url) throw new Error("a javascript: URL survived the receive path");
  if (!intent.notes.some((n) => /not an http/i.test(n))) throw new Error("the dropped link was not reported");
  // The rest of the share still arrives.
  if (intent.text !== "hi") throw new Error("the whole share was discarded for one bad field");
});

await test("CT-01 · an oversized received file is refused by name", { "CT-01": "full" }, () => {
  const intent = receiveShare(form({ files: [{ name: "huge.iso", size: SHARE_BYTES_MAX + 1, type: "" }] }));
  if (intent.files.length !== 0) throw new Error("an oversized file was accepted");
  if (!intent.notes.some((n) => /huge\.iso/.test(n))) throw new Error("the refusal did not name the file");
});

await test("CT-01 · a share lands somewhere sensible or nowhere", { "CT-01": "full" }, () => {
  if (shareDestination(receiveShare(form({}))).module !== "none") throw new Error("an empty share wrote something");
  if (shareDestination(receiveShare(form({ text: "note" }))).module !== "notes") throw new Error("text did not become a note");
  if (shareDestination(receiveShare(form({ url: "https://e.com" }))).module !== "browser") throw new Error("a link did not open in the browser");
  if (shareDestination(receiveShare(form({ files: [{ name: "a.txt", size: 1, type: "" }] }))).module !== "files") {
    throw new Error("a file did not land in Files");
  }
  // Files win over a link when both arrive, because the file is the payload.
  const both = receiveShare(form({ url: "https://e.com", files: [{ name: "a.txt", size: 1, type: "" }] }));
  if (shareDestination(both).module !== "files") throw new Error("a link outranked an attached file");
});

await test("CT-01 · receive is total: no malformed form can throw", { "CT-01": "full" }, () => {
  // This runs in a page load. A throw here is a white screen from a share.
  const odd: unknown[] = [null, undefined, 42, "x", [], { get: 5 }];
  for (const v of odd) {
    const intent = receiveShare(v as never);
    if (typeof intent.text !== "string") throw new Error(`form ${String(v)} produced no text`);
    if (!Array.isArray(intent.files)) throw new Error("form produced no files array");
  }
  // A getter that throws would otherwise take the page with it.
  const hostile = { get: () => { throw new Error("kaboom"); } };
  const intent = receiveShare(hostile as never);
  if (intent.text !== "" || intent.files.length !== 0) throw new Error("a throwing getter produced data");
});

finish();
