/**
 * TT28: in-app "ask" dialogs that replace window.prompt(). Original code.
 *
 * Why not prompt(): it can't mask a passphrase (the text shows in clear on screen), can't validate before it closes,
 * ignores the Shell's theme and text size, blocks the whole page's event loop, and browsers may suppress it
 * entirely (sandboxed iframes, "prevent this page from creating additional dialogs").
 *
 * This module is the framework-free half: a FIFO queue of requests, each settled exactly once. <AskHost/> (rendered
 * by the Shell) shows the head of the queue as a modal dialog. Callers simply `await askText(...)`, which resolves
 * to the text, or null when the user cancels. That's the same contract as prompt(), so call sites keep their logic.
 */

export interface AskField {
  name: string;
  label: string;
  def?: string;
  /** Rendered as a password field (masked, autocomplete off), with an explicit "Show" toggle. */
  secret?: boolean;
  placeholder?: string;
}
export interface AskOptions {
  title: string;
  detail?: string;
  fields: AskField[];
  okLabel?: string;
  /** Return an error message to keep the dialog open, or null/"" to accept. */
  validate?: (values: Record<string, string>) => string | null | undefined;
}
export interface AskRequest extends Required<Pick<AskOptions, "title" | "fields" | "okLabel">> {
  id: number;
  detail: string;
  validate?: AskOptions["validate"];
}

type Settle = (v: Record<string, string> | null) => void;
let queue: { req: AskRequest; settle: Settle }[] = [];
const subs = new Set<() => void>();
let seq = 0;
const emit = () => { for (const f of [...subs]) f(); };

export const MAX_QUEUE = 8;
export const MAX_VALUE = 4096;

/** Ask for several values in one dialog. Resolves null on cancel. */
export function askForm(opts: AskOptions): Promise<Record<string, string> | null> {
  const fields = (opts.fields ?? []).filter((f) => f && f.name).slice(0, 6);
  if (!fields.length) return Promise.resolve(null);
  // A runaway caller can't stack an unbounded pile of modals: extra requests are refused (as if cancelled).
  if (queue.length >= MAX_QUEUE) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req: AskRequest = {
      id: ++seq, title: String(opts.title || fields[0].label).slice(0, 200), detail: String(opts.detail ?? "").slice(0, 600),
      fields: fields.map((f) => ({ ...f, def: String(f.def ?? "").slice(0, MAX_VALUE) })), okLabel: opts.okLabel || "OK", validate: opts.validate,
    };
    queue = [...queue, { req, settle: resolve }];
    emit();
  });
}

/** Drop-in replacement for prompt(label, def): resolves to the entered text ("" allowed) or null on cancel. */
export async function askText(label: string, def = "", opts: { secret?: boolean; validate?: (v: string) => string | null | undefined; okLabel?: string; detail?: string; title?: string; placeholder?: string } = {}): Promise<string | null> {
  const v = opts.validate;
  const r = await askForm({
    title: opts.title ?? label, detail: opts.detail, okLabel: opts.okLabel,
    fields: [{ name: "value", label, def, secret: opts.secret, placeholder: opts.placeholder }],
    validate: v ? (vals) => v(vals.value ?? "") : undefined,
  });
  return r ? r.value ?? "" : null;
}

export const currentAsk = (): AskRequest | null => queue[0]?.req ?? null;
export const isAskOpen = (): boolean => queue.length > 0;
export const askQueueLength = (): number => queue.length;
export function subscribeAsk(f: () => void): () => void { subs.add(f); return () => { subs.delete(f); }; }

/**
 * Validate and settle request `id`. Returns the validation error (dialog stays open), or "" once settled. Settling
 * an unknown or already-settled id is a no-op, so a double click or a late Enter can't resolve twice.
 */
export function answerAsk(id: number, values: Record<string, string> | null): string {
  const i = queue.findIndex((q) => q.req.id === id); if (i < 0) return "";
  const { req, settle } = queue[i];
  let clean: Record<string, string> | null = null;
  if (values) {
    clean = {};
    for (const f of req.fields) clean[f.name] = String(values[f.name] ?? "").slice(0, MAX_VALUE);
    let err: string | null | undefined = null;
    try { err = req.validate?.(clean); } catch (e) { err = (e as Error).message || "invalid"; }
    if (err) return String(err);
  }
  queue = queue.filter((_, j) => j !== i);
  emit();
  settle(clean);
  return "";
}

/** Cancel everything (e.g. the Shell unmounts or the session locks). */
export function cancelAllAsks(): void {
  const q = queue; queue = []; emit();
  for (const { settle } of q) settle(null);
}
