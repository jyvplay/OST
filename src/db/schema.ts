/**
 * Fusion Shell Web — persistence schema (Drizzle / PostgreSQL)
 *
 * Design notes that differ from the "usual" Next.js+Drizzle app:
 *  - The VFS is path-addressed, not id-addressed. The Android spec's FileOps
 *    engine is a journaled state machine over paths; an id-tree would make the
 *    COPY->VERIFY->PUBLISH->RETIRE transitions untestable against a real path.
 *  - Every mutation that the spec calls "reversible" has a durable artifact:
 *    vfs_versions (Timeline backup), file_ops (journal), audit_log (DP-14).
 *  - The feature register itself is data, not prose. §7 of the spec becomes
 *    rows so the running app can show its own completion state honestly (DP-10).
 */
import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  bigint,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ spec */

export const features = pgTable(
  "features",
  {
    id: serial("id").primaryKey(),
    code: text("code").notNull(),
    family: text("family").notNull(),
    name: text("name").notNull(),
    /** A | A/B | B | C | X  — re-derived for the browser platform */
    tier: text("tier").notNull(),
    /** P1 | P2 | P3 | P4 | S */
    phase: text("phase").notNull(),
    /** The concrete web mechanism (API / construction) used here. */
    route: text("route").notNull(),
    /** Why this implementation differs from the common/obvious one. */
    nuance: text("nuance").notNull().default(""),
    /** built | partial | skeleton | probe | blocked */
    status: text("status").notNull().default("skeleton"),
    /** falsification test for this row */
    test: text("test").notNull().default(""),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [uniqueIndex("features_code_uidx").on(t.code)],
);

export const spikes = pgTable(
  "spikes",
  {
    id: serial("id").primaryKey(),
    code: text("code").notNull(),
    question: text("question").notNull(),
    pass: text("pass").notNull(),
    fallback: text("fallback").notNull(),
    /** open | running | passed | failed | n/a */
    status: text("status").notNull().default("open"),
    result: text("result").notNull().default(""),
  },
  (t) => [uniqueIndex("spikes_code_uidx").on(t.code)],
);

/* ------------------------------------------------------------- filesystem */

export const vfsNodes = pgTable(
  "vfs_nodes",
  {
    id: serial("id").primaryKey(),
    path: text("path").notNull(),
    parent: text("parent").notNull().default("/"),
    name: text("name").notNull(),
    /** dir | file */
    kind: text("kind").notNull(),
    mime: text("mime").notNull().default("application/octet-stream"),
    /** utf8 | base64 */
    encoding: text("encoding").notNull().default("utf8"),
    content: text("content").notNull().default(""),
    size: integer("size").notNull().default(0),
    sha256: text("sha256").notNull().default(""),
    tags: text("tags").notNull().default(""),
    trashed: boolean("trashed").notNull().default(false),
    trashedFrom: text("trashed_from"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("vfs_path_uidx").on(t.path),
    index("vfs_parent_idx").on(t.parent),
    index("vfs_trashed_idx").on(t.trashed),
  ],
);

export const vfsVersions = pgTable(
  "vfs_versions",
  {
    id: serial("id").primaryKey(),
    path: text("path").notNull(),
    version: integer("version").notNull(),
    encoding: text("encoding").notNull().default("utf8"),
    content: text("content").notNull().default(""),
    size: integer("size").notNull().default(0),
    sha256: text("sha256").notNull().default(""),
    reason: text("reason").notNull().default("write"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("vfs_versions_path_idx").on(t.path)],
);

/** Journaled file-operation state machine (spec §5.7). */
export const fileOps = pgTable(
  "file_ops",
  {
    id: serial("id").primaryKey(),
    op: text("op").notNull(),
    src: text("src").notNull().default(""),
    dst: text("dst").notNull().default(""),
    /** REQUESTED|COPYING_TO_TEMP|DEST_VERIFIED|DEST_PUBLISHED|SOURCE_RETIRE|COMPLETE|FAILED|ROLLED_BACK */
    state: text("state").notNull().default("REQUESTED"),
    bytes: integer("bytes").notNull().default(0),
    sha256: text("sha256").notNull().default(""),
    error: text("error").notNull().default(""),
    steps: jsonb("steps").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("file_ops_state_idx").on(t.state)],
);

/* ------------------------------------------------------------ shell state */

export const desktopState = pgTable("desktop_state", {
  id: text("id").primaryKey(),
  state: jsonb("state").notNull(),
  revision: integer("revision").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  category: text("category").notNull().default("general"),
  label: text("label").notNull().default(""),
  aliases: text("aliases").notNull().default(""),
  lockReason: text("lock_reason").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const settingsHistory = pgTable("settings_history", {
  id: serial("id").primaryKey(),
  key: text("key").notNull(),
  oldValue: text("old_value").notNull().default(""),
  newValue: text("new_value").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ----------------------------------------------------------- productivity */

export const notes = pgTable("notes", {
  id: serial("id").primaryKey(),
  title: text("title").notNull().default("Untitled"),
  body: text("body").notNull().default(""),
  tags: text("tags").notNull().default(""),
  pinned: boolean("pinned").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const alerts = pgTable(
  "alerts",
  {
    id: serial("id").primaryKey(),
    app: text("app").notNull().default("Fusion"),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    /** low | normal | high */
    priority: text("priority").notNull().default("normal"),
    groupKey: text("group_key").notNull().default(""),
    read: boolean("read").notNull().default(false),
    pinned: boolean("pinned").notNull().default(false),
    snoozeUntil: timestamp("snooze_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("alerts_created_idx").on(t.createdAt)],
);

/* ------------------------------------------------------------------ index */

export const indexDocs = pgTable(
  "index_docs",
  {
    id: serial("id").primaryKey(),
    source: text("source").notNull(),
    ref: text("ref").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("index_docs_src_ref_uidx").on(t.source, t.ref)],
);

/* ------------------------------------------------------------------- beam */

export const castTargets = pgTable("cast_targets", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  /** remote-playback | presentation | webrtc-together | documentpip | window | unreachable */
  kind: text("kind").notNull(),
  host: text("host").notNull().default(""),
  capability: jsonb("capability").notNull().default({}),
  trusted: boolean("trusted").notNull().default(false),
  lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
});

export const beamSessions = pgTable("beam_sessions", {
  id: serial("id").primaryKey(),
  targetName: text("target_name").notNull(),
  transport: text("transport").notNull(),
  source: text("source").notNull(),
  state: text("state").notNull().default("starting"),
  stats: jsonb("stats").notNull().default({}),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  stoppedAt: timestamp("stopped_at", { withTimezone: true }),
});

/* --------------------------------------------------------------- together */

export const togetherRooms = pgTable(
  "together_rooms",
  {
    id: serial("id").primaryKey(),
    code: text("code").notNull(),
    name: text("name").notNull().default("Room"),
    mediaRef: text("media_ref").notNull().default(""),
    /** leader-reported transport clock */
    leaderClient: text("leader_client").notNull().default(""),
    positionMs: integer("position_ms").notNull().default(0),
    playing: boolean("playing").notNull().default(false),
    /** server epoch ms at which positionMs was true */
    anchorMs: bigint("anchor_ms", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("together_code_uidx").on(t.code)],
);

export const togetherEvents = pgTable(
  "together_events",
  {
    id: serial("id").primaryKey(),
    room: text("room").notNull(),
    clientId: text("client_id").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull().default({}),
    serverTs: bigint("server_ts", { mode: "number" }).notNull(),
  },
  (t) => [index("together_room_idx").on(t.room, t.id)],
);

/* ------------------------------------------------------- capability/audit */

export const capabilityReports = pgTable("capability_reports", {
  id: serial("id").primaryKey(),
  clientId: text("client_id").notNull(),
  ua: text("ua").notNull().default(""),
  report: jsonb("report").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    actor: text("actor").notNull().default("user"),
    action: text("action").notNull(),
    detail: text("detail").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_created_idx").on(t.createdAt)],
);

/* ------------------------------------------------------------- commerce */

export const licenseAuthority = pgTable("license_authority", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const entitlements = pgTable(
  "entitlements",
  {
    id: serial("id").primaryKey(),
    clientId: text("client_id").notNull(),
    /** trial | pro | propack */
    kind: text("kind").notNull(),
    licenseKey: text("license_key").notNull().default(""),
    status: text("status").notNull().default("active"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [index("entitlements_client_idx").on(t.clientId)],
);

/* ------------------------------------------------------------ planner */

export const tasks = pgTable("tasks", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  notes: text("notes").notNull().default(""),
  done: boolean("done").notNull().default(false),
  /** due time; reminders fire only while the app is open (stated in UI) */
  dueAt: timestamp("due_at", { withTimezone: true }),
  reminded: boolean("reminded").notNull().default(false),
  /** task | event (events come from ICS import) */
  kind: text("kind").notNull().default("task"),
  uid: text("uid").notNull().default(""),
  endAt: timestamp("end_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* -------------------------------------------------------- rtc signalling */

/** CA-09 / CT-02: SDP + ICE exchange over Postgres (polling), no third-party broker. */
export const rtcSignals = pgTable(
  "rtc_signals",
  {
    id: serial("id").primaryKey(),
    room: text("room").notNull(),
    fromClient: text("from_client").notNull(),
    toClient: text("to_client").notNull().default("*"),
    /** hello | offer | answer | ice | bye */
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("rtc_room_idx").on(t.room, t.id)],
);

/* ------------------------------------------------------------ routines */

export const routines = pgTable("routines", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  /** manual | interval | display-connected | time-of-day */
  trigger: text("trigger").notNull().default("manual"),
  triggerArg: text("trigger_arg").notNull().default(""),
  /** ordered list of registry commands: [{cmd:"open",arg:"files"}, ...] */
  actions: jsonb("actions").notNull().default([]),
  enabled: boolean("enabled").notNull().default(true),
  lastRun: timestamp("last_run", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type FeatureRow = typeof features.$inferSelect;
export type VfsNode = typeof vfsNodes.$inferSelect;
export type FileOpRow = typeof fileOps.$inferSelect;
export type AlertRow = typeof alerts.$inferSelect;
export type NoteRow = typeof notes.$inferSelect;
