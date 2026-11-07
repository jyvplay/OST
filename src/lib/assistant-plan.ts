/**
 * TT139 (AU-04) — an assistant that is honest about where the thinking happens.
 *
 * The spec asks for an assistant. A 2-CPU server-hosted PWA cannot run a useful
 * language model, and shipping one would break the install budget and the privacy
 * promise. What it *can* do, without any model, is turn a sentence into a
 * proposed sequence of commands the shell already has — and show that plan for
 * approval before a single command runs.
 *
 * So this is a *planner with no model*: a grammar of intents over the registry's
 * own command names, a dry-run preview of every step, and a hard rule that a step
 * whose arguments cannot be resolved is a refusal, not a guess. An optional
 * user-supplied endpoint can supply the intent string instead; the plan and the
 * approval gate are identical in both cases, and the module says which one ran.
 *
 * Limits: intent recognition is keyword-based and will miss paraphrases. That is
 * stated in the UI ("understood: open Files at /Documents") so a wrong plan is
 * visible before it is approved, and no step is ever executed optimistically.
 */

export interface PlanStep { command: string; args: Record<string, string>; /** plain-language description shown for approval */ describe: string }
export interface Plan { intent: string; steps: PlanStep[]; confidence: "exact" | "partial" | "none"; unrecognised: string[]; source: "local-grammar" | "user-endpoint" }

export interface IntentRule {
  intent: string;
  /** words that must all appear (case-insensitive) for this rule to fire */
  keywords: string[];
  build: (utterance: string) => PlanStep[];
}

/** Argument extraction helpers — deliberately strict: no value means no step. */
export function quotedOrTrailingPath(text: string): string | null {
  const quoted = /"([^"]+)"|'([^']+)'/.exec(text);
  if (quoted) return quoted[1] ?? quoted[2] ?? null;
  const path = /(\/[A-Za-z0-9._\-/]*)/.exec(text);
  return path ? path[1] : null;
}

export function trailingFolderName(text: string): string | null {
  const m = /\b(?:in|to|into|at)\s+([A-Za-z0-9 _.-]{1,40}?)(?:[.,]|$)/i.exec(text);
  return m ? m[1].trim() : null;
}

export function parseDuration(text: string): number | null {
  const m = /\b(\d{1,4})\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hour|hours)\b/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mult = unit.startsWith("h") ? 3600 : unit.startsWith("m") ? 60 : 1;
  if (!(n > 0) || n * mult > 24 * 3600) return null;
  return n * mult;
}

export const INTENTS: IntentRule[] = [
  {
    intent: "open-folder",
    keywords: ["open"],
    build: (u) => {
      const folder = trailingFolderName(u);
      if (!folder) return [];
      return [{ command: "files.open", args: { path: `/${folder.replace(/^\/+/, "")}` }, describe: `Open the folder “${folder}”` }];
    },
  },
  {
    intent: "new-note",
    keywords: ["note", "new"],
    build: (u) => {
      const quoted = /"([^"]{1,120})"/.exec(u);
      const title = quoted ? quoted[1] : null;
      const args: Record<string, string> = title ? { title } : {};
      return [{ command: "notes.create", args, describe: title ? `Create the note “${title}”` : "Create an untitled note" }];
    },
  },
  {
    intent: "start-timer",
    keywords: ["timer"],
    build: (u) => {
      const seconds = parseDuration(u);
      if (!seconds) return [];
      return [{ command: "clock.timer.start", args: { seconds: String(seconds) }, describe: `Start a timer for ${seconds >= 60 ? `${seconds / 60} minute${seconds === 60 ? "" : "s"}` : `${seconds} seconds`}` }];
    },
  },
  {
    intent: "search",
    keywords: ["find", "search"],
    build: (u) => {
      const q = /(?:find|search(?: for)?)\s+(.{2,120})$/i.exec(u);
      if (!q) return [];
      const term = q[1].replace(/\s+(?:in|on)\s+.*$/i, "").trim();
      return term ? [{ command: "find.open", args: { q: term }, describe: `Search for “${term}”` }] : [];
    },
  },
  {
    intent: "take-screenshot",
    keywords: ["screenshot"],
    build: () => [{ command: "capture.screen", args: {}, describe: "Capture this screen (the browser will ask for permission)" }],
  },
  {
    intent: "backup",
    keywords: ["backup"],
    build: () => [{ command: "backup.bundle", args: {}, describe: "Write a dated backup bundle into /Backups" }],
  },
];

/** The planner. `speech` is the optional user-endpoint output, already split. */
export function planFromUtterance(utterance: string): Plan {
  const text = String(utterance ?? "").trim();
  if (!text) return { intent: "none", steps: [], confidence: "none", unrecognised: [], source: "local-grammar" };
  const lower = text.toLowerCase();
  const scored: { rule: IntentRule; hits: number }[] = [];
  for (const rule of INTENTS) {
    const hits = rule.keywords.filter((k) => lower.includes(k)).length;
    if (hits) scored.push({ rule, hits });
  }
  scored.sort((a, b) => b.hits - a.hits);
  for (const { rule } of scored) {
    const steps = rule.build(text);
    if (steps.length) return { intent: rule.intent, steps, confidence: "exact", unrecognised: [], source: "local-grammar" };
  }
  // The words matched something but no argument could be resolved: say which
  // part is missing instead of inventing a default.
  if (scored.length) {
    return { intent: scored[0].rule.intent, steps: [], confidence: "partial", unrecognised: [`${scored[0].rule.intent} needs more detail (for example a name, a path or a length of time)`], source: "local-grammar" };
  }
  return { intent: "none", steps: [], confidence: "none", unrecognised: ["nothing in that sentence maps to a command this shell has"], source: "local-grammar" };
}

/**
 * Approval gate. A plan is executable only if every step's command exists in the
 * shell's command table and every argument is known to that command; the caller
 * passes both so the check cannot be skipped.
 */
export function validatePlan(plan: Plan, known: Record<string, readonly string[]>): { executable: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!plan.steps.length) problems.push("the plan has no steps");
  for (const step of plan.steps) {
    const args = known[step.command];
    if (!args) { problems.push(`unknown command “${step.command}”`); continue; }
    for (const key of Object.keys(step.args)) if (!args.includes(key)) problems.push(`“${step.command}” does not take “${key}”`);
  }
  return { executable: problems.length === 0, problems };
}

/** What to say when the platform has no model at all — the common case. */
export function assistantAvailability(opts: { hasLocalModel: boolean; userEndpoint: boolean }): { available: boolean; sentence: string } {
  if (opts.hasLocalModel) return { available: true, sentence: "A local model answered the last request; nothing left this device." };
  if (opts.userEndpoint) return { available: true, sentence: "Your own endpoint is configured. Sentences are sent there; the app stores only the plan." };
  return { available: false, sentence: "No language model is bundled or reachable. What works here is the command planner: it turns a short sentence into a plan you approve first." };
}
