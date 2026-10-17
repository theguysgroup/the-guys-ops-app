// Tests for automations/index.ts. Run: bash supabase/functions/automations/run_tests.sh
// (the runner swaps the esm.sh and npm imports for stubs, gives a pretend Deno.env, appends this file and runs it with tsx).
// deno-lint-ignore-file no-explicit-any

const ENV = (globalThis as any).__AUTO_ENV__ as Record<string, string>;
let pass = 0, fail = 0;
let TAG = "";   // " [v2]" while the phase-4 suite runs through upgradeV1 + advanceV2
function eq(got: any, want: any, name: string) { const g = JSON.stringify(got), w = JSON.stringify(want); if (g === w) pass++; else { fail++; console.log(`FAIL ${name}${TAG}\n  got  ${g}\n  want ${w}`); } }
function ok(cond: any, name: string, extra?: any) { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${TAG}`, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : ""); } }

// the executor the deployed function runs claimed runs with (the compat switch, G1.4); the phase-4 suite swaps it
const PROD_ADVANCE = io.advance;

// ── no network at all: any fetch (Twilio, anything) fails the test run ──
let fetchCalls = 0;
(globalThis as any).fetch = (..._a: any[]) => { fetchCalls++; throw new Error("network is not allowed in the automations tests"); };

// ── a small in-memory stand-in for the Supabase client ──
const isoMs = (ms: number) => new Date(ms).toISOString();
function cmp(a: any, b: any): number {
  const ds = /^\d{4}-\d{2}-\d{2}/;
  if (typeof a === "string" && typeof b === "string" && ds.test(a) && ds.test(b)) { const x = Date.parse(a), y = Date.parse(b); return x < y ? -1 : x > y ? 1 : 0; }
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}
function splitOr(s: string): string[] { const out: string[] = []; let cur = "", q = false; for (const ch of s) { if (ch === '"') { q = !q; cur += ch; continue; } if (ch === "," && !q) { out.push(cur); cur = ""; continue; } cur += ch; } if (cur) out.push(cur); return out; }
function parseCond(p: string) {
  const m = /^([a-z_]+(?:->>[A-Za-z_]+)?)\.(eq|gte|lte|lt|is)\.(.*)$/.exec(p);
  if (!m) throw new Error("fake or(): " + p);
  let v = m[3]; if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  const op = m[2], [k, key] = m[1].split("->>");
  // options->>key: a jsonb key as text (null when missing)
  const val = (r: any) => key === undefined ? r[k] : r[k] && typeof r[k] === "object" && r[k][key] != null ? String(r[k][key]) : null;
  return (r: any) => { const x = val(r); return op === "eq" ? x != null && String(x) === v : op === "is" ? (v === "null" && x == null)
    : x != null && (op === "gte" ? cmp(x, v) >= 0 : op === "lte" ? cmp(x, v) <= 0 : cmp(x, v) < 0); };
}
// The unique keys of .claude/sql/stage2-automations.sql Part 1 (+ phase 4), by their SQL names (a test reads the SQL file
// and checks each name is there). where = a partial index; key = an expression index; a null in a key column never
// collides (as in SQL). automation_log: one ACTION row per (run, step, loop) — Part 1 swaps automation_log_once (run_id,
// step_id) for automation_log_action_once (run_id, step_id, loop) where row_kind = 'action'.
type Uniq = { name: string; keys: string[]; where?: (r: any) => boolean; key?: (r: any) => string };
const UNIQUE: Record<string, Uniq[]> = {
  automation_runs: [{ name: "automation_runs_once", keys: ["automation_id", "event_key"] },
    { name: "automation_runs_active_lock", keys: ["automation_id", "active_lock"], where: (r) => r.active_lock != null }],
  automation_log: [{ name: "automation_log_action_once", keys: ["run_id", "step_id", "loop"], where: (r) => r.row_kind === "action" }],
  automation_events: [{ name: "automation_events_once", keys: ["business_id", "type", "event_key"] }],
  automation_trigger_log: [{ name: "automation_trigger_log_once", keys: ["automation_id", "trigger_id", "event_key"] }],
  automation_trigger_daily: [{ name: "automation_trigger_daily_pkey", keys: ["automation_id", "trigger_id", "day"] }],
  automation_enrollment_keys: [{ name: "automation_enrollment_keys_pkey", keys: ["automation_id", "enrollment_key"] }],
  automation_wanted: [{ name: "automation_wanted_pkey", keys: ["business_id", "event_type"] }],
  automation_versions: [{ name: "automation_versions_no_once", keys: ["automation_id", "version_no"] }],
  automation_hook_secrets: [{ name: "automation_hook_secrets_pkey", keys: ["hook_id"] }, { name: "automation_hook_secrets_token_hash_key", keys: ["token_hash"] }],
  automation_custom_values: [{ name: "automation_custom_values_pkey", keys: ["business_id", "key"] }],
  automation_reviews: [{ name: "automation_reviews_pkey", keys: ["automation_id"] }],
  automation_system_meta: [{ name: "automation_system_meta_pkey", keys: ["business_id", "base"] }],
  system_claims: [{ name: "system_claims_pkey", keys: ["business_id", "key"] }],
  automation_templates: [{ name: "automation_templates_key_once", keys: ["business_id", "key"], where: (r) => r.deleted_at == null }],
  automation_folders: [{ name: "automation_folders_name_once", keys: ["business_id", "name"],
    key: (r) => [r.business_id, r.parent_id ?? "-", String(r.name ?? "").trim().toLowerCase()].join("|") }],
  automations: [{ name: "automations_system_key_once", keys: ["business_id", "system_key"], where: (r) => r.system_key != null && r.deleted_at == null }],
  app_keys: [{ name: "app_keys_pkey", keys: ["name"] }],
};
// Column defaults the SQL gives (every phase-4 log row is an 'action' row of loop 0; runs and events per Part 1).
const DEFAULTS: Record<string, Record<string, any>> = {
  automation_log: { row_kind: "action", loop: 0 },
  automation_runs: { loop: 0, steps_done: 0, steps_today: 0, chain_depth: 0, source: "trigger", recheck: false, stop_on_reply: false, remove_requested: false },
  automation_events: { business_id: "default", status: "new", attempts: 0, chain_depth: 0, ctx: {} },
};
const withDefaults = (table: string, r: any) => ({ ...(DEFAULTS[table] || {}), ...r });
// BEFORE INSERT/UPDATE triggers of Part 1 the engine relies on: a run that is no longer waiting / running gives its
// re-entry lock back (automation_runs_lock_clear).
const BEFORE: Record<string, (r: any) => void> = {
  automation_runs: (r) => { if (r.active_lock != null && !["waiting", "running"].includes(r.status)) r.active_lock = null; },
};
const before = (table: string, r: any) => { if (BEFORE[table]) BEFORE[table](r); return r; };
// The SQL signatures of every public function in .claude/sql/*.sql (the last definition wins, files in name order, the
// stage-2 file last): name → parameters (required = no default). Filled from the files before the tests run; the fake
// rpc refuses a call whose argument names do not fit, as PostgREST does.
const SQL_SIGS: Record<string, { params: string[]; required: string[] }> = {};
function sqlSigs(text: string): Record<string, { params: string[]; required: string[] }> {
  const out: Record<string, { params: string[]; required: string[] }> = {};
  for (const m of text.matchAll(/^create or replace function public\.([a-z0-9_]+)\(([^)]*)\)/gm)) {
    const parts: string[] = [];
    let depth = 0, cur = "";
    for (const ch of m[2]) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch; }
    if (cur.trim()) parts.push(cur);
    const ps = parts.map((x) => x.trim().replace(/\s+/g, " ")).filter(Boolean);
    out[m[1]] = { params: ps.map((x) => x.split(" ")[0]), required: ps.filter((x) => !/ default /i.test(x)).map((x) => x.split(" ")[0]) };
  }
  return out;
}
function sqlArgsProblem(name: string, a: any): string | null {
  const sig = SQL_SIGS[name];
  if (!sig) return null;
  const got = Object.keys(a || {});
  const extra = got.filter((k) => !sig.params.includes(k)), missing = sig.required.filter((k) => !got.includes(k));
  return extra.length || missing.length ? `fake: ${name} called with ${extra.length ? "unknown " + extra.join(",") : ""}${missing.length ? " missing " + missing.join(",") : ""}` : null;
}
// contact_tags_merge (SQL, Part 2 · G2.3): removed in any case, then the added ones not there yet (any case), order kept.
function fakeTagsMerge(tags: any, add: string[], remove: string[]): string[] {
  const rem = new Set(remove.map((x) => String(x).trim().toLowerCase()));
  const kept = (Array.isArray(tags) ? tags : []).filter((x: any) => x && !rem.has(String(x).toLowerCase()));
  for (const raw of add) { const x = String(raw).trim().slice(0, 60); if (x && !kept.some((k: string) => k.toLowerCase() === x.toLowerCase())) kept.push(x); }
  return kept;
}
const uniqKey = (u: Uniq, r: any): string | null => u.key ? u.key(r) : u.keys.some((k) => r[k] == null) ? null : JSON.stringify(u.keys.map((k) => r[k]));
// ── the Part-2 guard of public.automations as the function's writes meet it (automation.via = 'fn'; the same rules as
// automations_guard v2 in .claude/sql/stage2-automations.sql PART 2 · G2.4) and its AFTER trigger ──
// v1 steps → the guarded types they stand for (= SQL automation_guarded_channels_v1)
const fakeGuardedV1 = (steps: any) => [...new Set((Array.isArray(steps) ? steps : []).filter((s: any) => s && s.kind === "action" && ["email", "text"].includes(s.type)).map((s: any) => s.type === "email" ? "send_email" : "send_sms"))].sort();
function fakeGuarded(def: any, steps: any): string[] { return def ? wfGuardedChannels(def) : fakeGuardedV1(steps); }
function fakeAutoGuard(old: any, n: any, now: string, migrating: boolean) {
  const content = ["name", "definition", "settings", "layout", "builder"].some((k) => JSON.stringify(old[k] ?? null) !== JSON.stringify(n[k] ?? null));
  n.revision = (Number(old.revision) || 1) + (content ? 1 : 0);
  if (migrating) { n.version = old.version; n.armed_at = old.armed_at; n.enabled = old.enabled; n.audience = old.audience; n.updated_at = old.updated_at; n.switched_on_at = old.switched_on_at ?? null; return n; }
  const gOld = fakeGuarded(old.definition, old.steps), gNew = fakeGuarded(n.definition, n.steps);
  if (n.enabled && gNew.some((x) => !gOld.includes(x))) n.enabled = false;
  if (n.deleted_at && !old.deleted_at) n.enabled = false;
  const shape = (x: any) => x.definition ? defShape(x.definition) : JSON.stringify([x.trigger ?? null, (Array.isArray(x.steps) ? x.steps : []).map((s: any) => [s.id, s.kind, s.type])]);
  const arm = (x: any) => x.definition ? armKey(x.definition, x.settings) : "";
  // (an upgraded workflow, re-entry legacy_always: a trigger change is a new version too, as phase 4's guard made it)
  const changed = old.definition && n.definition ? versionChanged(old.definition, old.settings, n.definition) : shape(n) !== shape(old);
  n.version = (Number(old.version) || 1) + (changed ? 1 : 0);
  // armed_at: the enrolment gate (switch-on, new version, re-arm); switched_on_at: switch-on or new version only
  if (!n.enabled) { n.armed_at = null; n.switched_on_at = null; }
  else if (!old.enabled || n.version !== old.version) { n.armed_at = now; n.switched_on_at = now; }
  else if (arm(n) !== arm(old)) { n.armed_at = now; n.switched_on_at = old.switched_on_at ?? old.armed_at ?? null; }
  else { n.armed_at = old.armed_at; n.switched_on_at = old.switched_on_at ?? old.armed_at ?? null; }
  n.audience = gNew.length ? "customer" : "team";
  if (content || n.enabled !== old.enabled || n.deleted_at !== old.deleted_at) n.updated_at = now;
  return n;
}
// automations_after: a new version, a switch-off or a delete stops what waits (exit rows; the ledger keys only those runs used)
let fakeAfterN = 0;
function fakeAutoAfterIn(T: any, old: any, r: any, now: string) {
  const why = r.version !== old.version ? ["automation_changed", "automation changed"] : !old.deleted_at && r.deleted_at ? ["deleted", "automation deleted"] : old.enabled && !r.enabled ? ["switched_off", "switched off"] : null;
  if (!why) return;
  const runs = (T.automation_runs || []).filter((x: any) => x.automation_id === r.id && x.status === "waiting");
  for (const x of runs) {
    Object.assign(x, { status: "cancelled", exit_reason: why[0], reason: why[1], active_lock: null, lease_until: null, finished_at: now, updated_at: now });
    (T.automation_log = T.automation_log || []).push({ id: `automation_log-after-${++fakeAfterN}`, business_id: x.business_id, run_id: x.id, step_id: x.cursor_step ?? "end", row_kind: "exit", status: "removed", reason: why[1],
      automation_id: r.id, automation_name: r.name, record_kind: x.record_kind, record_id: x.record_id, contact_id: x.contact_id ?? null, trigger_id: x.trigger_id ?? null,
      version: x.automation_version, revision: x.revision ?? null, seq: x.steps_done ?? 0, loop: x.loop ?? 0, detail: { exit_reason: why[0] }, at: now });
  }
  const gone = new Set(runs.map((x: any) => x.enrollment_key).filter((k: any) => k != null));
  const others = new Set((T.automation_runs || []).filter((x: any) => x.automation_id === r.id && !runs.includes(x)).map((x: any) => x.enrollment_key));
  T.automation_enrollment_keys = (T.automation_enrollment_keys || []).filter((k: any) => !(k.automation_id === r.id && gone.has(k.enrollment_key) && !others.has(k.enrollment_key)));
}
function fakeDb(seed: Record<string, any[]> = {}) {
  const T: Record<string, any[]> = {};
  for (const [k, v] of Object.entries(seed)) T[k] = v.map((r) => withDefaults(k, r));
  const calls: string[] = [];
  let n = 0;
  // the name of the unique key r breaks against `among` (the table's rows, minus the row being updated), else null
  const dupOf = (table: string, r: any, among: any[] = T[table] || []): string | null => {
    for (const u of UNIQUE[table] || []) {
      if (u.where && !u.where(r)) continue;
      const k = uniqKey(u, r);
      if (k !== null && among.some((x) => x !== r && (!u.where || u.where(x)) && uniqKey(u, x) === k)) return u.name;
    }
    return null;
  };
  const dup = (table: string, r: any) => dupOf(table, r) !== null;
  const dupErr = (name: string) => ({ data: null, error: { code: "23505", message: `duplicate key value violates unique constraint "${name}"` } });
  const fakeAutoAfter = (old: any, r: any, now: string) => fakeAutoAfterIn(T, old, r, now);
  // ── the capture triggers of .claude/sql/stage2-automations.sql (contacts: Lead changed, Lead tag, Note added, Lead
  // status; customer_opt_outs: Lead DND), only for the wanted types, with the cause automation_apply sets (G2.3) ──
  let cause: string | null = null, tx = 0;
  const wantedT = () => new Set((T.automation_wanted || []).map((w: any) => w.event_type));
  const capPut = (type: string, key: string, id: string, contact: string | null, ctx: any, kind = "contact") => {
    T.automation_events = T.automation_events || [];
    if (T.automation_events.some((e: any) => e.type === type && e.event_key === key)) return;
    const m = cause ? /^([^:]+):(\d{1,3}):([^:]+)$/.exec(cause) : null;
    T.automation_events.push(withDefaults("automation_events", { id: `automation_events-${++n}`, business_id: "default", type, event_key: key.slice(0, 200), record_kind: kind, record_id: id,
      contact_id: contact, at: isoMs(clock), available_at: isoMs(clock), ctx, source: "capture", cause_run_id: m ? m[1] : null, cause_automation_id: m ? m[3] : null,
      chain_depth: m ? Math.min(Number(m[2]) + 1, 100) : 0 }));
  };
  const lowerSet = (l: any) => new Set((Array.isArray(l) ? l : []).map((x: any) => String(x)));
  // import_quiet (G3.5): a quiet row's INSERT and the import's own update (the one that marks it quiet; the fake has no
  // "this transaction is the import" switch) write nothing; a later change of a quiet row counts
  const quietWrite = (op: string, o: any, c: any) => c.import_quiet === true && (op === "insert" || o.import_quiet !== true);
  const captureContact = (op: string, o: any, c: any) => {
    const w = wantedT(); if (!w.size) return;
    if (quietWrite(op, o, c)) return;
    const t = String(++tx), id = String(c.id);
    if (op === "update" && w.has("contact_changed")) {
      for (const f of CONTACT_CHANGED_FIELDS) { const col = CONTACT_FIELD_COLUMN[f] || f; if (JSON.stringify(o[col] ?? null) !== JSON.stringify(c[col] ?? null)) capPut("contact_changed", `${id}:chg:${f}:${t}`, id, id, { field: f, old: o[col] ?? null, new: c[col] ?? null }); }
    }
    if (w.has("contact_tag")) {
      const was = lowerSet(op === "update" ? o.tags : []), now = lowerSet(c.tags);
      for (const g of now) if (g && !was.has(g)) capPut("contact_tag", `${id}:tag:+:${g}:${t}`, id, id, { tag: g, action: "added" });
      if (op === "update") for (const g of was) if (g && !now.has(g)) capPut("contact_tag", `${id}:tag:-:${g}:${t}`, id, id, { tag: g, action: "removed" });
    }
    if (w.has("note_added")) {
      const had = new Set((op === "update" && Array.isArray(o.customer_notes) ? o.customer_notes : []).map((x: any) => x && x.id));
      for (const x of Array.isArray(c.customer_notes) ? c.customer_notes : []) if (x && x.id && !had.has(x.id)) capPut("note_added", `${id}:note:${x.id}`, id, id, { note_id: x.id, text: String(x.text || "").slice(0, 200), by: x.by || "" });
    }
    if (op === "update" && w.has("lead_status") && o.status !== c.status) {
      const st = c.status === "Won" ? "won" : c.status === "Lost" ? "lost" : "open";
      capPut("lead_status", `${id}:st:${c.status}:${t}`, id, id, { stage: c.status, from: o.status, status: st });
    }
  };
  const captureOptOut = (op: string, r: any) => {
    if (!wantedT().has("contact_dnd") || !r.contact_id) return;
    capPut("contact_dnd", `${r.id}:${op === "delete" ? "off" : "on"}`, String(r.contact_id), String(r.contact_id), { action: op === "delete" ? "off" : "on", channel: r.channel });
  };
  // tasks: Task added (G3.5: not for a quiet import)
  const captureTask = (op: string, o: any, r: any) => {
    if (op !== "insert" || !wantedT().has("task_added") || quietWrite(op, o, r)) return;
    capPut("task_added", `${r.id}:added`, String(r.id), r.contact_id ? String(r.contact_id) : null, { title: String(r.title || "").slice(0, 200), due: r.due ?? null }, "task");
  };
  const after = (table: string, op: string, o: any, r: any) => { if (table === "contacts") captureContact(op, o || {}, r); if (table === "customer_opt_outs") captureOptOut(op, r); if (table === "tasks") captureTask(op, o || {}, r); };
  function q(table: string) {
    const rows = () => (T[table] = T[table] || []);
    const filters: ((r: any) => boolean)[] = [];
    let op = "select", payload: any = null, opts: any = {}, single = false, maybe = false, lim = Infinity, rng: [number, number] | null = null, wantRows = false, counted = false, headOnly = false;
    const orders: [string, boolean][] = [];
    const b: any = {
      select(_c?: string, o?: any) { if (op !== "select") wantRows = true; if (o && o.count) { counted = true; headOnly = !!o.head; } return b; },
      insert(p: any) { op = "insert"; payload = p; return b; }, update(p: any) { op = "update"; payload = p; return b; },
      upsert(p: any, o?: any) { op = "upsert"; payload = p; opts = o || {}; return b; }, delete() { op = "delete"; return b; },
      eq(k: string, v: any) { filters.push((r) => r[k] === v); return b; },
      neq(k: string, v: any) { filters.push((r) => r[k] != null && r[k] !== v); return b; },   // SQL: a null is never "not equal"
      gte(k: string, v: any) { filters.push((r) => r[k] != null && cmp(r[k], v) >= 0); return b; },
      lte(k: string, v: any) { filters.push((r) => r[k] != null && cmp(r[k], v) <= 0); return b; },
      lt(k: string, v: any) { filters.push((r) => r[k] != null && cmp(r[k], v) < 0); return b; },
      gt(k: string, v: any) { filters.push((r) => r[k] != null && cmp(r[k], v) > 0); return b; },
      in(k: string, l: any[]) { filters.push((r) => l.includes(r[k])); return b; },
      is(k: string, v: any) { filters.push((r) => (r[k] ?? null) === v); return b; },
      ilike(k: string, pat: string) {
        const re = new RegExp("^" + String(pat).replace(/\\(.)|([%_])|([.*+?^${}()|[\]\\])/g, (_m, esc, w, sp) => esc !== undefined ? esc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : w ? (w === "%" ? ".*" : ".") : "\\" + sp) + "$", "i");
        filters.push((r) => r[k] != null && re.test(String(r[k]))); return b;
      },
      or(expr: string) { const parts = splitOr(expr).map(parseCond); filters.push((r) => parts.some((p) => p(r))); return b; },
      order(k: string, o?: any) { orders.push([k, !(o && o.ascending === false)]); return b; },
      limit(x: number) { lim = x; return b; }, range(a: number, z: number) { rng = [a, z]; return b; },
      single() { single = true; return b; }, maybeSingle() { maybe = true; return b; },
      then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej); },
    };
    const out = (list: any[]) => single ? (list[0] ? { data: list[0], error: null } : { data: null, error: { message: "no rows" } }) : maybe ? { data: list[0] || null, error: null } : { data: list, error: null };
    function run() {
      calls.push(`${table}.${op}`);
      const match = () => (T[table] || []).filter((r) => filters.every((f) => f(r)));   // a read never creates the table
      if (op === "insert") {
        const list = (Array.isArray(payload) ? payload : [payload]).map((r: any) => before(table, withDefaults(table, r)));
        for (let i = 0; i < list.length; i++) { const d = dupOf(table, list[i], [...rows(), ...list.slice(0, i)]); if (d) return dupErr(d); }   // one statement: all or nothing
        const added = list.map((r) => ({ id: r.id ?? `${table}-${++n}`, ...r }));
        rows().push(...added);
        added.forEach((r) => after(table, "insert", null, r));
        return wantRows || single || maybe ? out(added.map((x) => ({ ...x }))) : { data: null, error: null };
      }
      if (op === "upsert") {
        // PostgREST sends ON CONFLICT (cols) without a predicate: Postgres can't use a PARTIAL unique index for it (42P10)
        const cols = String(opts.onConflict || "").split(",").map((x) => x.trim()).filter(Boolean).sort().join(",");
        const named = (UNIQUE[table] || []).filter((u) => !u.key && [...u.keys].sort().join(",") === cols);
        if (cols && named.length && named.every((u) => u.where)) return { data: null, error: { code: "42P10", message: "there is no unique or exclusion constraint matching the ON CONFLICT specification" } };
        const list = (Array.isArray(payload) ? payload : [payload]).map((r: any) => before(table, withDefaults(table, r))), added: any[] = [];
        for (const r of list) { if (dup(table, r)) { if (!opts.ignoreDuplicates) throw new Error("fake upsert: only ignoreDuplicates"); continue; } const x = { id: r.id ?? `${table}-${++n}`, ...r }; rows().push(x); added.push(x); }
        return wantRows ? out(added.map((x) => ({ ...x }))) : { data: null, error: null };
      }
      if (op === "update") {
        // all matched rows change or none (a unique key broken by the new values fails the statement, as in SQL)
        const m = match(), next = m.map((r) => before(table, { ...r, ...payload }));
        for (let i = 0; i < m.length; i++) { const d = dupOf(table, next[i], rows().map((x) => (m.includes(x) ? next[m.indexOf(x)] : x))); if (d) return dupErr(d); }
        const olds = m.map((r) => ({ ...r }));
        m.forEach((r, i) => Object.assign(r, next[i]));
        m.forEach((r, i) => after(table, "update", olds[i], r));
        return wantRows ? out(m.map((x) => ({ ...x }))) : { data: null, error: null };
      }
      if (op === "delete") { const gone = match(); T[table] = rows().filter((r) => !gone.includes(r)); gone.forEach((r) => after(table, "delete", r, r)); return { data: gone, error: null }; }
      let list = match();
      const total = list.length;   // { count: "exact" }: every matching row, before range / limit (PostgREST)
      for (const [k, asc] of [...orders].reverse()) list = [...list].sort((x, y) => (asc ? 1 : -1) * cmp(x[k], y[k]));
      if (rng) list = list.slice(rng[0], rng[1] + 1);
      if (counted) return { data: headOnly ? null : list.slice(0, lim).map((x) => ({ ...x })), error: null, count: total };
      return out(list.slice(0, lim).map((x) => ({ ...x })));
    }
    return b;
  }
  async function rpc(name: string, a: any) {
    calls.push("rpc:" + name);
    const bad = sqlArgsProblem(name, a);
    if (bad) return { data: null, error: { message: bad } };
    if (name === "automation_tick_lock") {
      T.automation_state = T.automation_state || [];
      let s = T.automation_state.find((x) => x.business_id === a.p_business);
      if (!s) { s = { business_id: a.p_business, tick_lease_until: null }; T.automation_state.push(s); }
      if (s.tick_lease_until && cmp(s.tick_lease_until, a.p_now) >= 0) return { data: false, error: null };
      s.tick_lease_until = isoMs(Date.parse(a.p_now) + Math.max(a.p_seconds, 10) * 1000); s.last_tick_at = a.p_now;
      return { data: true, error: null };
    }
    if (name === "set_catalog_holidays") {
      const st = (T.settings || [])[0]; if (!st) return { data: null, error: null };
      st.catalog = { ...(st.catalog || {}), holidays: a.p_holidays };
      return { data: null, error: null };
    }
    if (name === "automation_claim_due") {
      const due = (T.automation_runs || []).filter((x) => x.business_id === a.p_business && ((x.status === "waiting" && cmp(x.due_at, a.p_now) <= 0) || (x.status === "running" && x.lease_until && cmp(x.lease_until, a.p_now) < 0)))
        // ties: Postgres leaves their order open; the fake takes (workflow, event key), so producers that start the same
        // runs in another order (enqueue: workflow by workflow; the event store: event by event) are compared fairly
        .sort((x, y) => cmp(x.due_at, y.due_at) || cmp(x.automation_id, y.automation_id) || cmp(x.event_key, y.event_key)).slice(0, Math.min(Math.max(a.p_limit, 1), 50));
      due.forEach((x) => { x.status = "running"; x.lease_until = isoMs(Date.parse(a.p_now) + Math.max(a.p_lease_seconds, 30) * 1000); x.attempts = (x.attempts || 0) + 1; x.updated_at = a.p_now; });
      return { data: due.map((x) => ({ ...x })), error: null };
    }
    if (name === "automation_claim_customer" || name === "automation_claim_customer_v2") {
      // the same rule as the SQL function: count this engine's customer messages of the last 24 h to the card or any of
      // its addresses (including ones being sent), then claim the row only under the cap; a second claim does nothing.
      // Only ACTION rows count and block (step rows never do); the old signature is the v2 one with loop 0 (Part 1 wrapper).
      T.automation_log = T.automation_log || [];
      const recips: string[] = a.p_recipients || [], loop = name === "automation_claim_customer_v2" ? Number(a.p_loop) || 0 : 0;
      if (T.automation_log.some((l) => l.row_kind === "action" && l.run_id === a.p_run && l.step_id === a.p_step && (Number(l.loop) || 0) === loop)) return { data: "done", error: null };
      const k = T.automation_log.filter((l) => l.row_kind === "action" && l.business_id === a.p_business && l.audience === "customer" && ["sending", "sent", "queued"].includes(l.status) && cmp(l.at, a.p_since) >= 0
        && ((a.p_contact && l.contact_id === a.p_contact) || recips.includes(l.recipient))).length;
      if (k >= Math.max(a.p_cap, 1)) return { data: "capped", error: null };
      const id = `automation_log-${++n}`;
      T.automation_log.push({ id, business_id: a.p_business, run_id: a.p_run, step_id: a.p_step, row_kind: "action", loop, status: "sending", channel: a.p_channel, audience: "customer", automation_id: a.p_automation,
        automation_name: a.p_name, record_kind: a.p_record_kind, record_id: a.p_record_id, contact_id: a.p_contact, recipient: recips[0] || null, at: a.p_now });
      return { data: "claimed:" + id, error: null };
    }
    // ── stage-2 Part 1 RPCs: the same rules as the SQL functions (.claude/sql/stage2-automations.sql) ──
    if (name === "automation_enroll") {
      const auto = (T.automations || []).find((x) => x.id === a.p_automation && (x.business_id ?? "default") === a.p_business && !x.deleted_at);
      if (!auto) return { data: "not_found", error: null };
      T.automation_runs = T.automation_runs || []; T.automation_enrollment_keys = T.automation_enrollment_keys || []; T.automation_log = T.automation_log || [];
      if (a.p_lock_key != null && T.automation_runs.some((r) => r.automation_id === a.p_automation && r.active_lock === a.p_lock_key)) return { data: "already_enrolled", error: null };
      const led = a.p_enroll_key != null ? T.automation_enrollment_keys.find((k) => k.automation_id === a.p_automation && k.enrollment_key === a.p_enroll_key) : null;
      if (a.p_reentry === "off" && led) return { data: "reentry_off", error: null };
      const due = a.p_due ?? a.p_event_at;
      const run = before("automation_runs", withDefaults("automation_runs", {
        id: `automation_runs-${++n}`, business_id: a.p_business, automation_id: a.p_automation, automation_version: a.p_version, revision: a.p_revision, trigger_id: a.p_trigger,
        event_key: a.p_event_key, event_type: a.p_event_type, event_at: a.p_event_at, record_kind: a.p_record_kind, record_id: a.p_record_id, contact_id: a.p_contact ?? null,
        status: "waiting", step_index: 0, anchor_at: due, due_at: due, attempts: 0, context: a.p_context ?? {}, cursor_step: a.p_start ?? null, enrollment_key: a.p_enroll_key ?? null,
        active_lock: a.p_lock_key ?? null, chain_depth: Math.min(Math.max(Number(a.p_chain) || 0, 0), 100), cause_run_id: a.p_cause ?? null, parent_run_id: a.p_parent ?? null,
        source: a.p_source ?? "trigger", stop_on_reply: !!a.p_stop_on_reply, created_at: a.p_now }));
      const d = dupOf("automation_runs", run);
      if (d) return { data: d === "automation_runs_once" ? "duplicate_event" : "already_enrolled", error: null };
      T.automation_runs.push(run);
      if (a.p_enroll_key != null) {
        if (led) { led.last_at = a.p_now; led.runs++; }
        else T.automation_enrollment_keys.push({ business_id: a.p_business, automation_id: a.p_automation, enrollment_key: a.p_enroll_key, first_at: a.p_now, last_at: a.p_now, runs: 1, splits: {} });
      }
      auto.enrolled_total = (Number(auto.enrolled_total) || 0) + 1;
      T.automation_log.push({ id: `automation_log-${++n}`, business_id: a.p_business, run_id: run.id, step_id: a.p_trigger ?? a.p_source ?? "trigger", row_kind: "enroll", status: "added",
        automation_id: a.p_automation, automation_name: auto.name, record_kind: a.p_record_kind, record_id: a.p_record_id, contact_id: a.p_contact ?? null, trigger_id: a.p_trigger ?? null,
        version: a.p_version, revision: a.p_revision, seq: 0, loop: 0, at: a.p_now,
        detail: { source: a.p_source ?? "trigger", event_type: a.p_event_type, event_key: String(a.p_event_key).slice(0, 200), start: a.p_start ?? null, parent_run_id: a.p_parent ?? null } });
      return { data: `enrolled:${run.id}`, error: null };
    }
    if (name === "automation_claim_events") {
      const lease = isoMs(Date.parse(a.p_now) + Math.max(Number(a.p_lease_s) || 0, 30) * 1000);
      const got = (T.automation_events || []).filter((e) => e.business_id === a.p_business && cmp(e.available_at, a.p_now) <= 0
          && (e.status === "new" || (e.status === "processing" && e.lease_until && cmp(e.lease_until, a.p_now) < 0))
          && (a.p_id == null || e.id === a.p_id) && (a.p_record_kind == null || (e.record_kind === a.p_record_kind && e.record_id === a.p_record_id)))
        .sort((x, y) => cmp(x.available_at, y.available_at) || cmp(x.at, y.at) || cmp(x.id, y.id)).slice(0, Math.min(Math.max(Number(a.p_limit) || 1, 1), 500));
      got.forEach((e) => { e.status = "processing"; e.lease_until = lease; e.attempts = (Number(e.attempts) || 0) + 1; });
      return { data: got.map((e) => ({ ...e })), error: null };
    }
    if (name === "automation_wake") {
      const types: string[] = a.p_types || [];
      const hit = (T.automation_runs || []).filter((r) => r.business_id === a.p_business && r.contact_id === a.p_contact && r.status === "waiting" && cmp(r.due_at, a.p_now) > 0
        && Array.isArray(r.watch) && r.watch.some((w: string) => types.includes(w)));
      hit.forEach((r) => { r.due_at = a.p_now; r.updated_at = a.p_now; });
      return { data: hit.length, error: null };
    }
    if (name === "automation_stop_on_reply") {
      const hit = (T.automation_runs || []).filter((r) => r.business_id === a.p_business && r.contact_id === a.p_contact && r.status === "waiting" && r.stop_on_reply === true
        && r.first_sent_at && cmp(r.first_sent_at, a.p_reply_at) < 0);
      T.automation_log = T.automation_log || [];
      for (const r of hit) {
        Object.assign(r, before("automation_runs", { ...r, status: "stopped", exit_reason: "replied", reason: "Stopped: the lead replied", finished_at: a.p_now, updated_at: a.p_now, lease_until: null, watch: null, recheck: false }));
        const au = (T.automations || []).find((x) => x.id === r.automation_id);
        T.automation_log.push({ id: `automation_log-${++n}`, business_id: a.p_business, run_id: r.id, step_id: r.cursor_step ?? "end", row_kind: "exit", status: "stopped", reason: "Stopped: the lead replied",
          automation_id: r.automation_id, automation_name: au ? au.name : "automation", record_kind: r.record_kind, record_id: r.record_id, contact_id: r.contact_id, trigger_id: r.trigger_id ?? null,
          version: r.automation_version, revision: r.revision ?? null, seq: r.steps_done ?? 0, loop: r.loop ?? 0, detail: { exit_reason: "replied", reply_at: a.p_reply_at }, at: a.p_now });
      }
      return { data: hit.length, error: null };
    }
    if (name === "automation_apply") {
      // the SQL function (Part 2 · G2.3 version): ops in order, each on its own; the cause set for the whole call, so the
      // capture layer above stamps it on every event; the stage op writes the scanner's 'stage' event itself. Every call
      // is kept in T.automation_apply_calls. → { ok, applied: [{i, op}], skipped: [{i, op, reason}] }
      T.automation_apply_calls = T.automation_apply_calls || [];
      T.automation_apply_calls.push({ ...a });
      const m = /^([^:]+):(\d{1,3}):([^:]+)$/.exec(String(a.p_cause || ""));
      if (!m) return { data: null, error: { message: "automation_apply needs p_cause = <run>:<depth>:<automation>" } };
      if (!Array.isArray(a.p_ops) || a.p_ops.length > 20) return { data: { ok: false, reason: "ops must be a list of at most 20" }, error: null };
      const auto = (T.automations || []).find((x) => x.id === m[3] && (x.business_id ?? "default") === a.p_business);
      if (!auto) return { data: { ok: false, reason: "automation not found" }, error: null };
      const actor = `Automation: ${auto.name}`.slice(0, 120);
      const c = a.p_kind === "contact" ? (T.contacts || []).find((x) => x.id === a.p_id) : null;
      if (a.p_kind === "contact" && !c) return { data: { ok: false, reason: "record deleted" }, error: null };
      const applied: any[] = [], skipped: any[] = [], line = (text: string) => { if (["contact", "job"].includes(a.p_kind)) (T.activity_log = T.activity_log || []).push({ record_kind: a.p_kind, record_id: a.p_id, actor, text, manual: false }); };
      const upd = async (patch: any) => { await q("contacts").update(patch).eq("id", c.id); };
      cause = a.p_cause;
      try {
        for (let i = 0; i < a.p_ops.length; i++) {
          const op = a.p_ops[i], o = String(op.op || ""), skip = (reason: string) => skipped.push({ i: i + 1, op: o, reason });
          if (["set", "tags", "note", "optout", "read", "stage", "assign"].includes(o) && !c) { skip("wrong_kind"); continue; }
          if (o === "set") {
            if (!UPDATE_FIELD_COLUMNS.includes(op.field)) { skip("field not allowed"); continue; }
            await upd({ [op.field === "quote_amount" ? "estimated_value" : op.field]: op.value === "" || op.value == null ? null : String(op.value).slice(0, 500) }); line(`Changed ${op.field}`);
          } else if (o === "tags") {
            const next = fakeTagsMerge(c.tags, op.add || [], op.remove || []);
            await upd({ tags: next }); line("Tags");
          } else if (o === "note") {
            const v = String(op.text || "").trim().slice(0, 2000); if (!v) { skip("empty note"); continue; }
            if (c.customer_notes != null && !Array.isArray(c.customer_notes)) { skip("the notes on this card are not a list"); continue; }
            await upd({ customer_notes: [...(Array.isArray(c.customer_notes) ? c.customer_notes : []), { id: `wf${++n}`, text: v, by: actor, at: isoMs(clock) }] }); line("Note added: " + v.slice(0, 200));
          } else if (o === "optout") {
            const ch = op.channel || "all";
            if (!(T.customer_opt_outs || []).some((x) => x.contact_id === c.id && x.channel === ch)) await q("customer_opt_outs").insert({ business_id: a.p_business, contact_id: c.id, channel: ch, reason: actor });
            line(`Automatic messages stopped (${ch})`);
          } else if (o === "read") { c.last_read_at = isoMs(clock); line("Conversation marked as read"); }
          else if (o === "stage") {
            const to = String(op.to || "").trim(); if (!to) { skip("no stage"); continue; }
            if (to === "Won") { skip("A lead is won when its job is entered"); continue; }
            if (c.status === to) { skip("already in that stage"); continue; }
            const at = isoMs(clock);
            await upd({ status: to, stage_changed_at: at, ...(to === "Lost" && op.lost_reason ? { lost_reason: op.lost_reason } : {}) });
            if (wantedT().has("stage")) {
              T.automation_events = T.automation_events || [];
              const key = `${c.id}:${to}:${at}`;
              if (!T.automation_events.some((e: any) => e.type === "stage" && e.event_key === key)) T.automation_events.push(withDefaults("automation_events", { id: `automation_events-${++n}`, business_id: a.p_business, type: "stage",
                event_key: key, record_kind: "contact", record_id: c.id, contact_id: c.id, at, available_at: isoMs(clock + 30e3), ctx: { stage: to }, source: "engine",
                cause_run_id: m[1], cause_automation_id: m[3], chain_depth: Math.min(Number(m[2]) + 1, 100) }));
            }
            line("Moved to " + to);
          } else if (o === "assign") {
            // G3.5: the lead's "Assigned to" (a person of the team, or nobody)
            const to = op.user == null || op.user === "" ? null : String(op.user), who = to ? (T.profiles || []).find((x) => x.id === to) : null;
            if (to && !who) { skip("that person is not in the team"); continue; }
            if ((c.assigned_user_id ?? null) === to) { skip(to ? "already assigned to that person" : "nobody is assigned"); continue; }
            await upd({ assigned_user_id: to }); line(to ? "Assigned to " + (String(who.full_name || "").trim() || "a team member") : "Assigned user removed");
          } else if (o === "task") {
            if (!String(op.title || "").trim() || !op.board) { skip("missing details"); continue; }
            await q("tasks").insert({ board: op.board, title: String(op.title).slice(0, 200), status: op.status || "Not Started", due: op.due || null, notes: op.notes || null, client: c ? c.full_name : null,
              contact_id: c ? c.id : null, assignees: op.assignees || [], assigned_to: op.assigned_to || null, category: op.category || null, priority: op.priority || null, created_by: actor });
            line("Task added: " + String(op.title).slice(0, 120));
          } else if (o === "comment") {
            if (!["contact", "job"].includes(a.p_kind)) { skip("wrong_kind"); continue; }
            const v = String(op.text || "").trim(); if (!v) { skip("empty comment"); continue; }
            line(v.slice(0, 1000));
          } else if (o === "custom") {
            if (!/^[a-z][a-z0-9_]{0,39}$/.test(String(op.key))) { skip("bad key"); continue; }
            T.automation_custom_values = T.automation_custom_values || [];
            const cv = T.automation_custom_values.find((x) => x.business_id === a.p_business && x.key === op.key);
            if (cv) cv.value = String(op.value ?? ""); else T.automation_custom_values.push({ business_id: a.p_business, key: op.key, value: String(op.value ?? "") });
          } else { skip("unknown op"); continue; }
          applied.push({ i: i + 1, op: o });
        }
      } finally { cause = null; }
      return { data: { ok: true, applied, skipped }, error: null };
    }
    // ── stage-2 Part 2 · G2.3: the lead card's atomic tag / note edits and the inbound link's rate ──
    if (name === "contact_tags_edit" || name === "contact_note_add" || name === "contact_note_remove") {
      const c = (T.contacts || []).find((x) => x.id === a.p_id);
      if (!c) return { data: null, error: { message: "lead not found" } };
      if (name === "contact_tags_edit") { await q("contacts").update({ tags: fakeTagsMerge(c.tags, a.p_add || [], a.p_remove || []) }).eq("id", c.id); return { data: [...c.tags], error: null }; }
      const list = Array.isArray(c.customer_notes) ? c.customer_notes : [];
      const note = a.p_note || {};
      // any non-empty id up to 128 characters without control characters (Postgres [[:cntrl:]]), as contact_note_add
      const nid = note.id == null ? "" : String(note.id);
      if (name === "contact_note_add" && (!nid || [...nid].length > 128 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(nid) || !String(note.text || "").trim())) return { data: null, error: { message: "a note needs an id and some text" } };
      // notes that are not a list (an old string or object) are never touched
      if (c.customer_notes != null && !Array.isArray(c.customer_notes)) return { data: null, error: { message: "this lead's notes are not a list: they were left as they are" } };
      if (name === "contact_note_remove") { await q("contacts").update({ customer_notes: list.filter((x: any) => x.id !== a.p_note_id) }).eq("id", c.id); return { data: c.customer_notes, error: null }; }
      if (!list.some((x: any) => x.id === note.id)) await q("contacts").update({ customer_notes: [...list, { id: note.id, text: String(note.text).trim(), by: String(note.by || "").slice(0, 120), at: typeof note.at === "string" ? note.at : isoMs(clock) }] }).eq("id", c.id);
      return { data: c.customer_notes, error: null };
    }
    if (name === "automation_hook_hit") {
      const h = (T.automation_hooks || []).find((x) => x.id === a.p_hook && (x.business_id ?? "default") === a.p_business && !x.revoked_at);
      if (!h) return { data: -1, error: null };
      const fresh = !h.window_start || Date.parse(h.window_start) <= Date.parse(a.p_now) - 60e3;
      h.window_count = fresh ? 1 : (Number(h.window_count) || 0) + 1; if (fresh) h.window_start = a.p_now; h.last_used_at = a.p_now;
      return { data: h.window_count, error: null };
    }
    // ── stage-2 Part 2 · G2.4: the content write paths (automation_save / automation_publish / automation_migrate_row)
    // with the guard v2 (automations_guard) and its AFTER trigger (automations_after) as the SQL runs them for the
    // function (automation.via = 'fn'); automation_prune (Part 1) for the housekeeping ──
    if (name === "automation_save" || name === "automation_publish" || name === "automation_migrate_row") {
      T.automations = T.automations || [];
      // the tests' clock (the differential's fake module has none: then the real time, never compared)
      const now = isoMs(typeof clock !== "undefined" ? clock : Date.now()), list = T.automations;
      if (name === "automation_save" && a.p_id == null) {
        const row = { id: `a${String(++n).padStart(3, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`, business_id: a.p_business, name: a.p_name, description: null, template_key: null, enabled: false, armed_at: null, switched_on_at: null,
          trigger: {}, steps: [], audience: fakeGuarded(a.p_definition, null).length ? "customer" : "team", version: 1, revision: 1, definition: a.p_definition, settings: a.p_settings ?? {},
          layout: a.p_layout ?? { v: 1 }, builder: a.p_builder ?? "standard", origin: ["user", "copy", "template", "ai"].includes(a.p_origin) ? a.p_origin : "user", list_summary: a.p_summary ?? {},
          created_by: a.p_actor ?? null, created_by_name: a.p_actor_name ?? null, created_at: now, updated_at: now, updated_by: a.p_actor ?? null, updated_by_name: a.p_actor_name ?? null,
          enrolled_total: 0, deleted_at: null, published_at: null, published_by: null, system_key: null };
        list.push(row);
        return { data: { ok: true, id: row.id, revision: 1, version: 1, enabled: false, armed_at: null, created: true, shape_changed: false, arm_changed: false }, error: null };
      }
      const r = list.find((x) => x.id === a.p_id && (x.business_id ?? "default") === a.p_business && !x.deleted_at);
      if (!r) return { data: name === "automation_migrate_row" ? { migrated: false } : { ok: false, reason: "not_found" }, error: null };
      const old = { ...r };
      if (name === "automation_migrate_row") {
        // compare-and-set: the trigger / steps the doc was made from must still be there
        if (r.definition != null || JSON.stringify(r.trigger ?? null) !== JSON.stringify(a.p_trigger ?? null) || JSON.stringify(r.steps ?? null) !== JSON.stringify(a.p_steps ?? null)) return { data: { migrated: false, revision: Number(r.revision ?? 1) }, error: null };
        Object.assign(r, fakeAutoGuard(old, { ...r, definition: a.p_definition, settings: a.p_settings ?? {}, list_summary: a.p_summary ?? {} }, now, true));
        return { data: { migrated: true, revision: r.revision, version: r.version, enabled: r.enabled }, error: null };
      }
      if (name === "automation_publish" && a.p_expected != null && Number(r.revision ?? 1) !== a.p_expected) return { data: { ok: false, reason: "conflict", revision: Number(r.revision ?? 1), updated_by_name: r.updated_by_name ?? null, updated_at: r.updated_at ?? null }, error: null };
      if (name === "automation_save" && Number(r.revision ?? 1) !== a.p_expected) return { data: { ok: false, reason: "conflict", revision: Number(r.revision ?? 1), updated_by_name: r.updated_by_name ?? null, updated_at: r.updated_at ?? null }, error: null };
      const next = name === "automation_save"
        ? { ...r, name: a.p_name, definition: a.p_definition, settings: a.p_settings ?? {}, layout: a.p_layout ?? { v: 1 }, builder: a.p_builder ?? "standard", list_summary: a.p_summary ?? {},
          updated_by: a.p_actor ?? null, updated_by_name: a.p_actor_name ?? null, enabled: a.p_draft ? false : r.enabled }
        : { ...r, enabled: !!a.p_on, ...(a.p_on ? { published_at: now, published_by: a.p_actor ?? null } : {}) };
      Object.assign(r, fakeAutoGuard(old, next, now, false));
      fakeAutoAfter(old, r, now);
      const armed = (x: any) => x.definition ? armKey(x.definition, x.settings) : JSON.stringify(x.trigger ?? null);
      return { data: { ok: true, id: r.id, revision: r.revision, version: r.version, enabled: r.enabled, armed_at: r.armed_at, published_at: r.published_at ?? null, created: false,
        shape_changed: r.version !== old.version, arm_changed: armed(r) !== armed(old) }, error: null };
    }
    if (name === "automation_prune") {
      const b = Math.min(Math.max(Number(a.p_budget) || 1000, 1), 1000), now = Date.parse(a.p_now), D = 86400e3, res: Record<string, number> = {};
      const cut = (table: string, key: string, pred: (r: any) => boolean, lim = b) => {
        const rowsT = T[table] || [], gone = new Set(rowsT.filter((r) => (r.business_id ?? "default") === a.p_business && pred(r)).slice(0, lim));
        T[table] = rowsT.filter((r) => !gone.has(r)); res[key] = gone.size;
      };
      const older = (v: any, days: number) => v != null && Date.parse(v) < now - days * D;
      cut("automation_events", "events", (e) => (e.status === "done" && older(e.processed_at ?? e.created_at ?? e.at, 7)) || (e.status === "error" && older(e.created_at ?? e.at, 30)));
      cut("automation_trigger_log", "trigger_log", (x) => older(x.at, 30));
      cut("automation_trigger_daily", "trigger_daily", (x) => older(x.day + "T00:00:00Z", 35));
      cut("automation_runs", "runs", (x) => !["waiting", "running"].includes(x.status) && older(x.finished_at, 180));
      cut("automation_log", "log", (x) => older(x.at, 180));
      const vs = (T.automation_versions || []).filter((v) => (v.business_id ?? "default") === a.p_business), drop = new Set<any>();
      const byA: Record<string, any[]> = {}; for (const v of vs) (byA[v.automation_id] = byA[v.automation_id] || []).push(v);
      for (const l of Object.values(byA)) l.sort((x, y) => y.version_no - x.version_no).forEach((v, i) => { if (i >= 50 || (i >= 10 && older(v.created_at, 30))) drop.add(v); });
      const dl = [...drop].slice(0, b); T.automation_versions = (T.automation_versions || []).filter((v) => !dl.includes(v)); res.versions = dl.length;
      cut("automation_hooks", "hooks", (h) => older(h.revoked_at, 30));
      cut("automations", "automations", (x) => older(x.deleted_at, 30) && x.system_key == null, Math.min(b, 50));
      return { data: res, error: null };
    }
    if (name === "automation_trigger_daily_add") {
      T.automation_trigger_daily = T.automation_trigger_daily || [];
      for (const r of a.p_rows || []) {
        let d = T.automation_trigger_daily.find((x) => x.automation_id === r.automation_id && x.trigger_id === r.trigger_id && x.day === r.day);
        if (!d) { d = { business_id: a.p_business, automation_id: r.automation_id, trigger_id: r.trigger_id, day: r.day, attempted: 0, matched: 0, enrolled: 0, reasons: {} }; T.automation_trigger_daily.push(d); }
        d.attempted += Number(r.attempted) || 0; d.matched += Number(r.matched) || 0; d.enrolled += Number(r.enrolled) || 0;
        for (const [k, v] of Object.entries(r.reasons || {})) d.reasons[k] = (Number(d.reasons[k]) || 0) + Number(v);
      }
      return { data: (a.p_rows || []).length, error: null };
    }
    return { data: null, error: { message: "unknown rpc " + name } };
  }
  return { T, from: q, rpc, calls };
}

// ── the outside world ──
const sent: { to: string; msg: any }[] = [];
let gone = new Set<string>();
io.generate = () => ({ publicKey: "PUB", privateKey: "PRIV" });
io.send = async (sub: any, payload: string) => { if (gone.has(sub.endpoint)) { const e: any = new Error("gone"); e.statusCode = 410; throw e; } sent.push({ to: sub.endpoint, msg: JSON.parse(payload) }); return { statusCode: 201 }; };
io.build = () => ({ method: "POST", headers: { Authorization: "vapid" }, body: new Uint8Array(1) });
let clock = Date.parse("2026-10-14T03:00:00Z");   // Wednesday 14 Oct, 14:00 Sydney (AEDT)
io.now = () => clock;
const pending: Promise<unknown>[] = [];
io.waitUntil = (p: Promise<unknown>) => { pending.push(p); };
const MIN = 60e3, HR = 3600e3, DAYMS = 24 * HR;
const NOW = clock;
const FOOT = "\n\nRather not get these emails? Just reply \"stop\" and we'll take you off the list.";

const OWNER = { id: "u-owner", full_name: "Olivia Owner", role: "owner", permissions: {}, technician_name: null };
const MANAGER = { id: "u-mgr", full_name: "Max Manager", role: "manager", permissions: {}, technician_name: null };
const VA = { id: "u-va", full_name: "Vicky Va", role: "va", permissions: { crm: true }, technician_name: null };
const VA_NOCRM = { id: "u-va2", full_name: "Vera Va", role: "va", permissions: {}, technician_name: null };
const TECH = { id: "u-tech", full_name: "Guy Tech", role: "technician", permissions: { jobs: true }, technician_name: "Guy Tech" };
const CATALOG = {
  services: [{ key: "Aircon", label: "Aircon cleaning" }, { key: "s9q", label: "Gutter cleaning" }],
  sources: [{ key: "Google Ads", label: "Google Ads" }, { key: "Referral", label: "A friend" }],
  stages: [{ key: "New", label: "New" }, { key: "Quoted", label: "Quote sent" }, { key: "sxy1", label: "Site visit" }, { key: "Booked", label: "Booked" }, { key: "Won", label: "Won" }, { key: "Lost", label: "Lost" }],
  tags: [{ tag: "VIP" }, { tag: "test" }],
  brands: { Aircon: "Fresh Air Co" },
  templates: { welcomeEmail: "{hi}, thanks for asking {business_name} about {service}." },
  hours: { nsw: true, extra: [{ date: "2026-10-20" }] },
  // the stored public holidays of the region (settings.catalog.holidays, worked out by the app; nothing chosen = AU-NSW)
  holidays: { region: "AU-NSW", days: { "2026-10-05": "Labour Day" } },
};
function lead(id: string, o: any = {}) {
  return { id, full_name: "Sam Smith", phone: "0412 345 678", email: "sam@example.com", postcode: "2000", division: "Aircon", source: "Google Ads", status: "New", tags: [],
    created_at: "2026-10-14", contacted_at: null, last_read_at: null, reopened_at: null, messages: [{ at: isoMs(NOW - 2 * MIN) }], stage_changed_at: null, linked_job_id: null, ...o };
}
let autoN = 0;
function auto(o: any = {}) {
  autoN++;
  return { id: `a${autoN}-0000-0000`, business_id: "default", name: `Automation ${autoN}`, enabled: true, armed_at: "2026-10-01T00:00:00.000Z", version: 1, created_by_name: "Olivia Owner",
    trigger: { type: "newLead", params: {} }, steps: [{ id: "p1", kind: "action", type: "push", to: { roles: ["owner"] }, title: "New lead: {name}", body: "{service} from {source}" }], ...o };
}
const emailStep = (o: any = {}) => ({ id: "e1", kind: "action", type: "email", subject: "Your {service} enquiry", body: "{hi}, thanks for contacting {business_name}.", ...o });
function world(over: Record<string, any[]> = {}) {
  return fakeDb({
    automation_settings: [{ business_id: "default" }], automation_state: [{ business_id: "default", tick_lease_until: null, pruned_on: null }],
    settings: [{ id: 1, company_name: "Acme Home Services", catalog: CATALOG }],
    profiles: [OWNER, MANAGER, VA, VA_NOCRM, TECH],
    push_subscriptions: [
      { id: "d1", user_id: "u-owner", endpoint: "https://push/owner", p256dh: "k", auth: "a" },
      { id: "d2", user_id: "u-mgr", endpoint: "https://push/mgr", p256dh: "k", auth: "a" },
      { id: "d3", user_id: "u-va", endpoint: "https://push/va", p256dh: "k", auth: "a" },
    ],
    employees: [{ id: "e-va", name: "Vicky Va", status: "Active" }, { id: "e-guy", name: "Guy Tech", status: "Active" }, { id: "e-old", name: "Old Hand", status: "Inactive" }],
    app_keys: [{ name: "vapid", value: { publicKey: "PUB", privateKey: "PRIV" } }],
    contacts: [], jobs: [], calls: [], chat_sessions: [], lead_messages: [], tasks: [], automations: [], automation_runs: [], automation_log: [],
    customer_opt_outs: [], sms_opt_outs: [], review_requests: [], employee_vacations: [],
    ...over,
  });
}
async function tickAt(db: any, ms: number) { clock = ms; return await tick(db, ms); }
// the action rows (phase 4 writes only those; the v2 executor adds step / exit rows, which the differential ignores)
const acts = (db: any) => db.T.automation_log.filter((l: any) => (l.row_kind ?? "action") === "action");
const logOf = (db: any) => acts(db).map((l: any) => `${l.step_id}:${l.status}${l.reason ? ":" + l.reason : ""}`);
let CLAIM_RPC = "automation_claim_customer";   // the claim the engine of this pass calls
const runOf = (db: any) => db.T.automation_runs.map((r: any) => `${r.status}${r.reason ? ":" + r.reason : ""}`);
const ctxOf = (db: any) => ({ S: normSettings(db.T.automation_settings[0]), cat: CATALOG, company: "Acme Home Services", autos: new Map(), counts: { events: 0, enqueued: 0, processed: 0, sent: 0, queued: 0, skipped: 0, deferred: 0 } });
// Syd wall clock → UTC ms
const syd = (day: string, h: number, m = 0) => zoneToUtc(day, h, m, "Australia/Sydney");

// The phase-4 engine suite (sections 6–26): the same inputs and the same expectations for both executors.
async function phase4Suite() {
  // ── 6. the main flow: a new lead → a push, once ──
  {
    const db = world({ contacts: [lead("c1")], automations: [auto({ id: "a-push-0001" })] });
    sent.length = 0;
    const ev = await handle(db, { step: "event", type: "newLead", id: "c1", status: "Won", full_name: "Hacker" }, OWNER, false);
    eq([ev.status, ev.body.runs, ev.body.statuses], [200, 1, ["done"]], "event: the app's 'look now' starts and runs the automation");
    eq(sent.map((s) => s.to), ["https://push/owner"], "event: the owner's phone got it");
    eq([sent[0].msg.title, sent[0].msg.body, sent[0].msg.url, sent[0].msg.tag], ["New lead: Sam Smith", "Aircon cleaning from Google Ads", "https://theguysgroup.github.io/the-guys-ops-app/?tab=crm", "auto-a-push-0-c1"], "push: filled from the server's own row (the client's fields are ignored), deep link and tag");
    await tickAt(db, NOW + MIN); await tickAt(db, NOW + 2 * MIN);
    eq([db.T.automation_runs.length, sent.length, logOf(db)], [1, 1, ["p1:sent"]], "the same lead seen again by 2 ticks: still one run and one push");
    // a crash after the push: the run is claimed again after its lease, and doesn't push again
    Object.assign(db.T.automation_runs[0], { status: "running", step_index: 0, lease_until: isoMs(NOW + 2 * MIN), finished_at: null });
    await tickAt(db, NOW + 5 * MIN);
    eq([sent.length, runOf(db), acts(db).length], [1, ["done"], 1], "re-claimed after an expired lease: no second push");
    // a second automation on the same event fires once too
    db.T.automations.push(auto({ id: "a-push-0002", armed_at: "2026-10-01T00:00:00.000Z" }));
    await tickAt(db, NOW + 6 * MIN); await tickAt(db, NOW + 7 * MIN);
    eq([db.T.automation_runs.length, sent.length], [2, 2], "2 automations on the same event: each fires once");
  }

  // ── 7. tick lock ──
  {
    const db = world({ contacts: [lead("c1")], automations: [auto()] });
    db.T.automation_state[0].tick_lease_until = isoMs(NOW + 30e3);
    sent.length = 0;
    const r = await tickAt(db, NOW);
    eq([r.busy, db.T.automation_runs.length, sent.length], [true, 0, 0], "a second tick while the lease is held does nothing");
    db.T.automation_state[0].tick_lease_until = null;
    const r2 = await tickAt(db, NOW);
    eq([r2.ok, r2.events, r2.enqueued, r2.sent, db.T.automation_state[0].tick_lease_until], [true, 1, 1, 1, null], "a tick runs and releases its lock");
  }

  // ── 8. OFF never acts; armed_at ──
  {
    const off = auto({ enabled: false, armed_at: null, steps: [emailStep(), { id: "p1", kind: "action", type: "push", to: { roles: ["owner"] }, title: "x" }, { id: "t1", kind: "action", type: "task", title: "Call {name}" }] });
    const db = world({ contacts: [lead("c1")], automations: [off] });
    sent.length = 0;
    await tickAt(db, NOW);
    const ev = await handle(db, { step: "event", type: "newLead", id: "c1" }, OWNER, false);
    eq([db.T.automation_runs.length, ev.body.runs, sent.length, db.T.tasks.length, db.T.lead_messages.length, db.T.automation_log.length], [0, 0, 0, 0, 0, 0], "an OFF automation gets no run from the tick or an event, and does nothing");
    // switched on: a waiting run; switched off before it is due → cancelled, nothing done
    const on = auto({ steps: [{ id: "w1", kind: "wait", unit: "minutes", n: 10 }, ...off.steps] });
    const db2 = world({ contacts: [lead("c1")], automations: [on] });
    await tickAt(db2, NOW);
    eq(runOf(db2), ["waiting"], "switched on: the run waits 10 minutes");
    db2.T.automations[0].enabled = false; db2.T.automations[0].armed_at = null;
    await tickAt(db2, NOW + 15 * MIN);
    eq([runOf(db2), sent.length, db2.T.tasks.length, db2.T.lead_messages.length, db2.T.automation_log.filter((l: any) => ["sent", "queued"].includes(l.status)).length], [["cancelled:switched off"], 0, 0, 0, 0], "switched off while waiting: cancelled, nothing sent");
    // armed_at: the lead came before the automation was switched on
    const late = auto({ armed_at: isoMs(NOW - MIN) });
    const db3 = world({ contacts: [lead("c1")], automations: [late] });
    await tickAt(db3, NOW);
    eq(db3.T.automation_runs.length, 0, "an event before the automation was switched on never fires it");
    // off then on again: armed_at moves (the SQL trigger); events in the OFF time don't fire
    const db4 = world({ contacts: [lead("c1", { messages: [{ at: isoMs(NOW - 20 * MIN) }] })], automations: [auto({ armed_at: isoMs(NOW - 10 * MIN) })] });
    await tickAt(db4, NOW);
    eq(db4.T.automation_runs.length, 0, "switched OFF then ON: a lead from the OFF time doesn't fire it");
  }

  // ── 9. quiet hours for customers, checked again; across daylight saving ──
  {
    const at = syd("2026-10-03", 21, 30);   // Saturday 21:30 AEST, the night before daylight saving
    const a = auto({ trigger: { type: "stage", params: { stage: "Quoted" } }, steps: [{ id: "i1", kind: "if", match: "all", conds: [{ field: "stage_unchanged", op: "true" }] }, emailStep()] });
    const db = world({ automations: [a], contacts: [lead("m1", { status: "Quoted", stage_changed_at: isoMs(at) }), lead("m2", { status: "Quoted", stage_changed_at: isoMs(at), email: "other@example.com", phone: "0400 111 222" })] });
    await tickAt(db, at);
    eq(db.T.automation_runs.length, 0, "a stage move younger than the app's Undo is not acted on yet");
    await tickAt(db, at + MIN);
    eq(db.T.automation_runs.map((r: any) => [r.status, r.due_at, r.step_index]), [["waiting", "2026-10-03T21:00:00.000Z", 0], ["waiting", "2026-10-03T21:00:00.000Z", 0]], "an email due at 21:30 waits for 08:00 the next morning (08:00 AEDT, the first day of daylight saving), back at the condition");
    db.T.contacts[0].status = "Booked";   // m1 moved on overnight
    await tickAt(db, Date.parse("2026-10-03T21:00:00.000Z"));
    eq([runOf(db), db.T.lead_messages.map((m: any) => m.email)], [["skipped:condition: stage_unchanged", "done"], ["other@example.com"]], "at 08:00 the condition is checked again: the lead that moved on is skipped, the other gets its email");
    // a team notification ignores the customer hours
    const t = auto({ steps: [{ id: "p1", kind: "action", type: "push", to: { roles: ["owner"] }, title: "Late lead" }] });
    const night = syd("2026-10-14", 23);
    const db2 = world({ automations: [t], contacts: [lead("c1", { created_at: "2026-10-14", messages: [{ at: isoMs(night - MIN) }] })] });
    sent.length = 0;
    await tickAt(db2, night);
    eq([sent.length, runOf(db2)], [1, ["done"]], "a team notification at 23:00 goes at 23:00");
  }

  // ── 10. window steps and waits ──
  {
    const push = { id: "p1", kind: "action", type: "push", to: { roles: ["owner"] }, title: "x" };
    const sat = syd("2026-10-17", 10);
    const mk = (win: any, when: number) => world({ automations: [auto({ steps: [{ id: "w", kind: "window", ...win }, push] })], contacts: [lead("c1", { created_at: "2026-10-17", messages: [{ at: isoMs(when) }] })] });
    let db = mk({ days: [1, 2, 3, 4, 5], from: "09:00", until: "17:00", outside: "skip" }, sat);
    await tickAt(db, sat);
    eq(runOf(db), ["skipped:outside the allowed days and hours"], "window 'skip' outside the hours");
    db = mk({ days: [1, 2, 3, 4, 5], from: "09:00", until: "17:00", outside: "next" }, sat);
    sent.length = 0;
    await tickAt(db, sat);
    eq([runOf(db), db.T.automation_runs[0].due_at], [["waiting"], isoMs(syd("2026-10-19", 9))], "window 'next': Saturday 10:00 → Monday 09:00");
    await tickAt(db, syd("2026-10-19", 9));
    eq([runOf(db), sent.length], [["done"], 1], "…and on Monday 09:00 it goes");
    const night = syd("2026-10-14", 21);
    db = world({ automations: [auto({ steps: [{ id: "w", kind: "window", days: [0, 1, 2, 3, 4, 5, 6], from: "08:00", until: "20:00", outside: "at", at: "10:00" }, push] })], contacts: [lead("c1", { messages: [{ at: isoMs(night) }] })] });
    await tickAt(db, night);
    eq(db.T.automation_runs[0].due_at, isoMs(syd("2026-10-15", 10)), "window 'at' 10:00 after 20:00 → the next day 10:00");
    await tickAt(db, syd("2026-10-15", 10));
    eq(runOf(db), ["done"], "…and then passes the window");
    db = world({ automations: [auto({ steps: [{ id: "w", kind: "window", mode: "office", outside: "next" }, push] })], contacts: [lead("c1", { created_at: "2026-10-05", messages: [{ at: isoMs(syd("2026-10-05", 10)) }] })] });
    await tickAt(db, syd("2026-10-05", 10));
    eq(db.T.automation_runs[0].due_at, isoMs(syd("2026-10-06", 8)), "window 'office' follows the office hours and the NSW holiday");
    // the first wait counts from the event, not from when the tick saw it
    const ev0 = NOW - 3 * MIN;
    db = world({ automations: [auto({ steps: [{ id: "w", kind: "wait", unit: "minutes", n: 5 }, push] })], contacts: [lead("c1", { messages: [{ at: isoMs(ev0) }] })] });
    sent.length = 0;
    await tickAt(db, NOW);
    eq(db.T.automation_runs[0].due_at, isoMs(ev0 + 5 * MIN), "a tick 3 minutes late: the 5-minute wait still ends at event + 5");
    await tickAt(db, ev0 + 5 * MIN);
    eq(sent.length, 1, "…and fires then");
    // too late
    db = world({ automations: [auto({ id: "a-late-001" })], contacts: [lead("c1")],
      automation_runs: [{ id: "r-late", business_id: "default", automation_id: "a-late-001", automation_version: 1, event_key: "c1:new", event_type: "newLead", event_at: isoMs(NOW - 30 * HR), record_kind: "contact", record_id: "c1", contact_id: "c1", status: "waiting", step_index: 0, anchor_at: isoMs(NOW - 30 * HR), due_at: isoMs(NOW - 30 * HR), attempts: 0, context: {} }] });
    sent.length = 0;
    await tickAt(db, NOW);
    eq([logOf(db), sent.length, runOf(db)], [["p1:skipped:too late"], 0, ["done"]], "more than max_late_hours late: 'too late', nothing sent");
  }

  // ── 11. customer email guard ──
  {
    const emailAuto = (o: any = {}) => auto({ steps: [emailStep()], ...o });
    async function emailFor(contact: any, over: Record<string, any[]> = {}, settings: any = {}) {
      const db = world({ automations: [emailAuto()], contacts: [contact], automation_settings: [{ business_id: "default", ...settings }], ...over });
      await tickAt(db, NOW);
      return db;
    }
    let db = await emailFor(lead("c1"));
    const m = db.T.lead_messages[0];
    eq([db.T.lead_messages.length, m.channel, m.direction, m.status, m.auto, m.author, m.email, m.subject, m.body, m.contact_id], [1, "email", "out", "queued", true, "Olivia", "sam@example.com", "Your Aircon cleaning enquiry", "Hi Sam, thanks for contacting Acme Home Services." + FOOT, "c1"], "the happy path: one queued email, plain text, the way out at the bottom, signed by the maker's first name (no signer set)");
    eq([logOf(db), db.T.automation_log[0].ref_id, db.T.automation_log[0].audience], [["e1:queued"], m.id, "customer"], "the log points at the queued email");
    const skipReason = async (c: any, over: Record<string, any[]> = {}, settings: any = {}) => { const d = await emailFor(c, over, settings); return [d.T.lead_messages.length, logOf(d)[0]]; };
    eq(await skipReason(lead("c1", { tags: ["test"] })), [0, undefined], "a test lead never even starts a run");
    const dbt = world({ automations: [auto({ trigger: { type: "jobClosed", params: {} }, steps: [emailStep()] })], contacts: [lead("c1", { tags: ["Test"] })], jobs: [{ id: "j1", contact_id: "c1", date: "2026-10-14", created_at: isoMs(NOW - MIN) }] });
    await tickAt(dbt, NOW);
    eq([dbt.T.lead_messages.length, logOf(dbt)], [0, ["e1:skipped:test record"]], "a job of a test customer: the email is skipped");
    eq(await skipReason(lead("c1", { tags: ["Unhappy"] }), {}, { dont_contact_tags: ["unhappy"] }), [0, "e1:skipped:do not contact"], "a 'do not contact' tag (a setting)");
    eq(await skipReason(lead("c1"), { jobs: [{ id: "j1", contact_id: "c1", review_do_not_ask: true }] }), [0, "e1:skipped:marked don't ask"], "a customer with a job marked don't ask");
    eq((await skipReason(lead("c1"), { jobs: [{ id: "j1", contact_id: "c1", review_do_not_ask: true }] }, { respect_dont_ask: false }))[0], 1, "respect_dont_ask off: the setting lets them through");
    eq(await skipReason(lead("c1", { email: "not-an-email" })), [0, "e1:skipped:no email"], "no valid email");
    eq(await skipReason(lead("c1", { email: 'x"),value_key.eq.y@example.com' })), [0, "e1:skipped:no email"], "an address that would break the opt-out filter is refused");
    eq([cleanEmail(" Sam@Example.com "), cleanEmail("a,b@x.com"), cleanEmail("a(b)@x.com")], ["sam@example.com", "", ""], "cleanEmail: lower case; quotes, commas and brackets refused");
    eq(await skipReason(lead("c1"), { customer_opt_outs: [{ id: "o1", business_id: "default", channel: "email", value_key: "sam@example.com", contact_id: null }] }), [0, "e1:skipped:opted out"], "opted out by email address");
    eq(await skipReason(lead("c1"), { customer_opt_outs: [{ id: "o1", business_id: "default", channel: "all", value_key: null, contact_id: "c1" }] }), [0, "e1:skipped:opted out"], "opted out by card (all channels)");
    eq((await skipReason(lead("c1"), { customer_opt_outs: [{ id: "o1", business_id: "other", channel: "all", value_key: null, contact_id: "c1" }] }))[0], 1, "another business's opt-out list is not this one's");
    // no card: a missed call from an unknown number
    const dbc = world({ automations: [auto({ trigger: { type: "missedCall", params: {} }, steps: [emailStep()] })], calls: [{ id: "k1", missed: true, started_at: isoMs(NOW - MIN), from_number: "+61412000000", contact_id: null }] });
    await tickAt(dbc, NOW);
    eq([dbc.T.lead_messages.length, logOf(dbc), runOf(dbc), dbc.T.automation_runs[0].due_at], [0, [], ["waiting"], isoMs(NOW + 2 * MIN)], "no customer card yet: it looks again in 2 minutes (a card may be linked a moment later)");
    await tickAt(dbc, NOW + 11 * MIN);
    eq([dbc.T.lead_messages.length, logOf(dbc)], [0, ["e1:skipped:no customer card"]], "no customer card after 10 minutes: skipped");
    const dbl = world({ automations: [auto({ trigger: { type: "jobClosed", params: {} }, steps: [emailStep()] })], contacts: [lead("c1")], jobs: [{ id: "j1", contact_id: null, date: "2026-10-14", created_at: isoMs(NOW - MIN) }] });
    await tickAt(dbl, NOW);
    dbl.T.jobs[0].contact_id = "c1";   // the app links the card right after the job is saved
    await tickAt(dbl, NOW + 2 * MIN);
    eq([logOf(dbl), dbl.T.lead_messages.map((m: any) => m.email)], [["e1:queued"], ["sam@example.com"]], "a job linked to its card a moment later: the email goes (not skipped for good)");
    // the daily cap across automations
    db = world({ automations: [emailAuto({ id: "a-cap-1" }), emailAuto({ id: "a-cap-2" })], contacts: [lead("c1")] });
    await tickAt(db, NOW);
    eq([db.T.lead_messages.length, logOf(db).sort()], [1, ["e1:queued", "e1:skipped:already contacted today"]], "a second email to the same customer within 24 hours (another automation) is skipped");
    // blanks
    db = world({ automations: [emailAuto({ steps: [emailStep({ body: "{hi}, your {service} booking {suburb}." })] })], contacts: [lead("c1", { postcode: "" })] });
    await tickAt(db, NOW);
    eq(db.T.lead_messages[0].body, "Hi Sam, your Aircon cleaning booking." + FOOT, "a blank with nothing to fill goes cleanly");
    db = world({ automations: [emailAuto({ steps: [emailStep({ body: "Use {coupon} today" })] })], contacts: [lead("c1")] });
    await tickAt(db, NOW);
    eq([db.T.lead_messages.length, logOf(db)], [0, ["e1:skipped:missing details: coupon"]], "an unknown blank stops the email");
    db = world({ automations: [emailAuto({ steps: [emailStep({ body: "", templateKey: "welcomeEmail" })] })], contacts: [lead("c1")] });
    await tickAt(db, NOW);
    eq(db.T.lead_messages[0].body, "Hi Sam, thanks for asking Acme Home Services about Aircon cleaning." + FOOT, "a saved template with merge fields");
    db = world({ automations: [emailAuto({ steps: [emailStep({ body: "", templateKey: "gone" })] })], contacts: [lead("c1")] });
    await tickAt(db, NOW);
    eq(logOf(db), ["e1:skipped:missing details: template"], "a template that no longer exists stops the email");
    db = world({ automations: [emailAuto()], contacts: [lead("c1")], automation_settings: [{ business_id: "default", email_signer: "Ron" }] });
    await tickAt(db, NOW);
    eq(db.T.lead_messages[0].author, "Ron", "the signer's name is a setting");
  }

  // ── 12. texts wait for the business phone ──
  {
    Object.assign(ENV, { TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "tok", TWILIO_NUMBER: "+61400000000" });
    const textAuto = auto({ steps: [{ id: "x1", kind: "action", type: "text", body: "{hi}, we got your enquiry." }] });
    const before = fetchCalls;
    let db = world({ automations: [textAuto], contacts: [lead("c1")] });
    await tickAt(db, NOW);
    eq([logOf(db), db.T.lead_messages.length, fetchCalls - before], [["x1:waiting_phone:waiting for the business phone"], 0, 0], "a text is only logged as waiting for the business phone, even with Twilio settings present; no network call");
    db = world({ automations: [textAuto], contacts: [lead("c1")], sms_opt_outs: [{ phone_key: "412345678" }] });
    await tickAt(db, NOW);
    eq(logOf(db), ["x1:skipped:opted out"], "a text still respects STOP");
    db = world({ automations: [textAuto], contacts: [lead("c1", { phone: "02 9999 0000" })] });
    await tickAt(db, NOW);
    eq(logOf(db), ["x1:skipped:no mobile"], "a text needs a mobile");
    for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_NUMBER"]) delete ENV[k];
  }

  // ── 13. push and task actions ──
  {
    const p = { id: "p1", kind: "action", type: "push", to: { people: ["u-va", "u-owner", "u-deleted"], roles: ["owner", "manager"] }, title: "Call {name} ({number})", body: "{stage} · {automation}" };
    const db = world({ automations: [auto({ name: "Lead alert", steps: [p] })], contacts: [lead("c1")] });
    gone = new Set(["https://push/mgr"]);
    sent.length = 0;
    await tickAt(db, NOW);
    eq(sent.map((s) => s.to).sort(), ["https://push/owner", "https://push/va"], "push: people + roles, once each; a deleted profile ignored");
    eq([sent[0].msg.title, sent[0].msg.body], ["Call Sam Smith (0412 345 678)", "New · Lead alert"], "push: title and text filled");
    eq([db.T.push_subscriptions.some((s: any) => s.id === "d2"), db.T.automation_log[0].status, db.T.automation_log[0].recipient], [false, "sent", "Olivia Owner, Max Manager, Vicky Va"], "push: a device that is gone (410) is removed; recipients logged");
    gone = new Set();
    const db2 = world({ automations: [auto({ steps: [{ ...p, to: { roles: ["technician"] } }] })], contacts: [lead("c1")], calls: [] });
    await tickAt(db2, NOW);
    eq(logOf(db2), ["p1:failed:no device"], "push: nobody's phone → failed 'no device'");
    const db3 = world({ automations: [auto({ trigger: { type: "missedCall", params: {} } })], calls: [{ id: "k1", missed: true, started_at: isoMs(NOW - MIN), from_number: "+61412000000", contact_id: null }] });
    sent.length = 0;
    await tickAt(db3, NOW);
    eq(sent[0] && sent[0].msg.url, "https://theguysgroup.github.io/the-guys-ops-app/?tab=myDay", "push: a missed call opens My Day");
    // tasks
    const task = (o: any) => ({ id: "t1", kind: "action", type: "task", title: "Call {first_name} back", notes: "{service}", due_days: 1, priority: "High", ...o });
    const tdb = world({ automations: [auto({ name: "Follow up", steps: [task({ assignees: ["e-va"] }), task({ id: "t2", assignees: ["e-guy", "e-old"], priority: "Sky high", due_days: null }), task({ id: "t3", assignees: [] })] })], contacts: [lead("c1")] });
    await tickAt(tdb, NOW);
    const [t1, t2, t3] = tdb.T.tasks;
    eq([t1.board, t1.assignees, t1.assigned_to, t1.title, t1.notes, t1.due, t1.priority, t1.contact_id, t1.client, t1.created_by, t1.status, t1.category], ["ron", ["Vicky Va"], "Vicky Va", "Call Sam back", "Aircon cleaning", "2026-10-15", "High", "c1", "Sam Smith", "Automation: Follow up", "Not Started", "Client-related"], "task: a VA's task on the office board, due tomorrow (business time zone), linked to the customer");
    eq([t2.board, t2.assignees, t2.priority, t2.due], ["Guy Tech", ["Guy Tech"], "Medium", null], "task: another person's board; an inactive employee left out; an unknown priority → Medium");
    eq([t3.board, t3.assignees], ["ron", []], "task: nobody chosen → the office board");
    eq(logOf(tdb), ["t1:sent", "t2:sent", "t3:sent"], "task: logged");
  }

  // ── 14. auth ──
  {
    const db = world({ contacts: [lead("c1", { status: "Quoted", stage_changed_at: isoMs(NOW - MIN) }), lead("c-old", { messages: [{ at: isoMs(NOW - 10 * HR) }] })], automations: [auto({ trigger: { type: "stage", params: {} } })] });
    const E = (me: any, type = "stage", id = "c1") => handle(db, { step: "event", type, id }, me, false);
    eq([(await E(null)).status, (await E(TECH)).status, (await E(VA_NOCRM)).status, (await E(OWNER, "rain")).status, (await E(OWNER, "stage", "nope")).status], [401, 403, 403, 400, 404], "event: no session 401, technician 403, office without CRM 403, unknown type 400, unknown record 404");
    eq([(await E(VA)).status, (await E(VA)).body.runs], [200, 0], "event: the office with CRM may say 'look now' (twice = still one run)");
    eq(db.T.automation_runs.length, 1, "event: one run");
    eq((await E(MANAGER, "newLead", "c-old")).body, { ok: true, runs: 0, reason: "old" }, "event: a record older than the lookback starts nothing");
    eq((await handle(db, { step: "event", type: "jobClosed", id: "j1" }, VA)).status, 403, "event: a job event needs Jobs access");
    // tick auth
    eq([sameSecret("", ""), sameSecret("a", ""), sameSecret("abc", "abd"), sameSecret("abc", "abc")], [false, false, false, true], "sameSecret refuses empty values");
    eq([(await handle(db, { step: "tick" }, null, false)).status, (await handle(db, { step: "tick" }, OWNER, false)).status], [401, 401], "tick: without the right secret 401, even for an owner");
    pending.length = 0;
    const t = await handle(db, { step: "tick" }, null, true);
    const res: any = await pending[0];
    eq([t.status, !!res && res.ok], [202, true], "tick: the right secret runs it (in the background)");
    eq((await handle(db, { step: "dance" }, OWNER, false)).status, 400, "unknown step");
  }

  // ── 15. business scoping, attempts, version change, deletion, invalid ──
  {
    const db = world({
      automation_settings: [{ business_id: "other", lookback_hours: 48 }, { business_id: "default", lookback_hours: 6 }],
      automations: [auto({ business_id: "other" })], contacts: [lead("c1"), lead("c2", { messages: [{ at: isoMs(NOW - 10 * HR) }] })],
    });
    sent.length = 0;
    await tickAt(db, NOW);
    eq([db.T.automation_runs.length, sent.length], [0, 0], "another business's automation is never run");
    db.T.automations.push(auto({ id: "a-def-0001" }));
    await tickAt(db, NOW + MIN);
    eq(db.T.automation_runs.map((r: any) => r.record_id), ["c1"], "this business's settings (6-hour lookback) are used, not another's");
    const base = { business_id: "default", automation_version: 1, event_type: "newLead", record_kind: "contact", record_id: "c1", contact_id: "c1", context: {} };
    const r = (id: string, aid: string, o: any = {}) => ({ id, automation_id: aid, event_key: "c1:new", event_at: isoMs(NOW), status: "waiting", step_index: 0, anchor_at: isoMs(NOW), due_at: isoMs(NOW), attempts: 0, ...base, ...o });
    const wait10 = [{ id: "w", kind: "wait", unit: "minutes", n: 10 }, { id: "p1", kind: "action", type: "push", to: { roles: ["owner"] }, title: "x" }];
    const db2 = world({ contacts: [lead("c1")], automations: [auto({ id: "a-try", steps: wait10 }), auto({ id: "a-ver", steps: wait10 }), auto({ id: "a-del", name: "Deleted one", steps: [{ id: "p0", kind: "action", type: "push", to: { roles: ["owner"] }, title: "x" }, ...wait10] }), auto({ id: "a-bad", steps: [{ id: "x", kind: "action", type: "fax" }] })],
      automation_runs: [r("r-try", "a-try", { attempts: 5, step_index: 1, anchor_at: isoMs(NOW - 20 * MIN) }), r("r-ver", "a-ver"), r("r-del", "a-del"), r("r-bad", "a-bad")] });
    sent.length = 0;
    await tickAt(db2, NOW);
    const by = (id: string) => { const x = db2.T.automation_runs.find((q: any) => q.id === id); return `${x.status}${x.reason ? ":" + x.reason : ""}`; };
    eq([by("r-try"), by("r-ver"), by("r-del"), by("r-bad").slice(0, 22)], ["failed:kept failing", "waiting", "waiting", "failed:invalid: step 1"], "a 6th try fails without acting; an invalid automation never runs");
    // the automations' own pushes (the v2 tick also sends the daily error digest about the failed runs: G6.1, once)
    const own = () => sent.filter((x) => x.msg.tag !== "automation-errors").length, digests = () => sent.filter((x) => x.msg.tag === "automation-errors").length;
    eq(own(), 1, "only the deleted one's first notification went before it was deleted");
    db2.T.automations.find((a: any) => a.id === "a-ver").version = 2;
    db2.T.automations = db2.T.automations.filter((a: any) => a.id !== "a-del");
    await tickAt(db2, NOW + 11 * MIN);
    eq([by("r-ver"), by("r-del"), own()], ["cancelled:automation changed", "cancelled:automation deleted", 1], "edited while waiting → cancelled; deleted → cancelled; nothing more sent");
    ok(digests() <= 1, "the error digest at most once a day", digests());
    eq(acts(db2).filter((l: any) => l.automation_id === "a-del").map((l: any) => l.automation_name), ["Deleted one"], "the log keeps the deleted automation's name");
  }

  // ── 16. reconcile and prune ──
  {
    const db = world({
      lead_messages: [{ id: "lm1", status: "sent" }, { id: "lm2", status: "queued" }, { id: "lm3", status: "queued" }],
      automation_log: [
        { id: "l1", business_id: "default", run_id: "x1", step_id: "e1", status: "queued", ref_id: "lm1", at: isoMs(NOW - 5 * MIN), automation_name: "A", channel: "email", audience: "customer" },
        { id: "l2", business_id: "default", run_id: "x2", step_id: "e1", status: "queued", ref_id: "lm2", at: isoMs(NOW - 25 * HR), automation_name: "A", channel: "email", audience: "customer" },
        { id: "l3", business_id: "default", run_id: "x3", step_id: "e1", status: "queued", ref_id: "lm3", at: isoMs(NOW - 5 * MIN), automation_name: "A", channel: "email", audience: "customer" },
        { id: "l4", business_id: "default", run_id: "x4", step_id: "p1", status: "sent", at: isoMs(NOW - 200 * DAYMS), automation_name: "A", channel: "push", audience: "team" },
        { id: "l5", business_id: "default", run_id: "x5", step_id: "p1", status: "sent", at: isoMs(NOW - 170 * DAYMS), automation_name: "A", channel: "push", audience: "team" },
      ],
      automation_runs: [
        { id: "old", business_id: "default", status: "done", finished_at: isoMs(NOW - 100 * DAYMS), due_at: isoMs(NOW - 100 * DAYMS) },
        { id: "keep", business_id: "default", status: "done", finished_at: isoMs(NOW - 80 * DAYMS), due_at: isoMs(NOW - 80 * DAYMS) },
        { id: "other", business_id: "other", status: "done", finished_at: isoMs(NOW - 100 * DAYMS), due_at: isoMs(NOW - 100 * DAYMS) },
        { id: "older", business_id: "default", status: "done", finished_at: isoMs(NOW - 200 * DAYMS), due_at: isoMs(NOW - 200 * DAYMS) },
      ],
    });
    await tickAt(db, NOW);
    const st = (id: string) => (db.T.automation_log.find((l: any) => l.id === id) || {}).status;
    eq([st("l1"), st("l2"), st("l3")], ["sent", "failed", "queued"], "reconcile: sent by the mailbox → sent; still queued after a day → failed; recent ones wait");
    eq(db.T.automation_log.find((l: any) => l.id === "l2").reason, "not picked up by the mailbox", "reconcile: the reason says why");
    // since G2.4 (SQL Part 1 in) the stage-2 housekeeping: finished runs and log rows over 180 days (design §2.9), cursor per day
    eq([db.T.automation_runs.map((r: any) => r.id), db.T.automation_log.some((l: any) => l.id === "l4"), db.T.automation_log.some((l: any) => l.id === "l5"), db.T.automation_state[0].housekeeping.day, db.T.automation_state[0].housekeeping.stage],
      [["old", "keep", "other"], false, true, "2026-10-14", "done"], "housekeeping: finished runs and log rows over 180 days go (this business only), once a day");
    db.T.automation_runs.push({ id: "old2", business_id: "default", status: "done", finished_at: isoMs(NOW - 100 * DAYMS), due_at: isoMs(NOW - 100 * DAYMS) });
    await tickAt(db, NOW + HR);
    eq(db.T.automation_runs.some((r: any) => r.id === "old2"), true, "prune: once a day");
  }

  // ── 17. preview and registry ──
  {
    const a = auto({ id: "a-prev", enabled: false, steps: [{ id: "w", kind: "wait", unit: "hours", n: 1 }, { id: "i", kind: "if", match: "all", conds: [{ field: "service", op: "is", v: "Aircon" }] },
      emailStep(), { id: "x1", kind: "action", type: "text", body: "{hi}!" }, { id: "p1", kind: "action", type: "push", to: { roles: ["owner"] }, title: "Lead {name}" }, { id: "t1", kind: "action", type: "task", title: "Call {first_name}", assignees: ["e-va"], due_days: 2 }] });
    const db = world({ automations: [a], contacts: [lead("c1")] });
    const before = JSON.stringify(db.T);
    sent.length = 0;
    const p = await handle(db, { step: "preview", automation_id: "a-prev", record: { kind: "contact", id: "c1" } }, OWNER, false);
    eq([p.status, p.body.ok, p.body.steps.map((s: any) => s.would)], [200, true, ["wait", "go on", "queue", "wait for the business phone", "send", "add"]], "preview: what each step would do");
    const em = p.body.steps[2];
    eq([em.subject, em.body, em.signature, em.to, em.note], ["Your Aircon cleaning enquiry", "Hi Sam, thanks for contacting Acme Home Services." + FOOT, "\n\nOlivia\nAcme Home Services", "sam@example.com", "this automation is off: nothing is sent"], "preview: the filled email with its way out, the signature the mailbox adds (a real first name), and that it is off");
    eq([p.body.steps[4].to, p.body.steps[5].board, p.body.steps[5].due], [["Olivia Owner"], "ron", "2026-10-16"], "preview: recipients and the task");
    eq([JSON.stringify(db.T) === before, sent.length], [true, 0], "preview: writes nothing and sends nothing");
    const bad = await handle(db, { step: "preview", automation: { name: "x", trigger: { type: "newLead" }, steps: [{ id: "q", kind: "action", type: "fax" }] }, record: { kind: "contact", id: "c1" } }, MANAGER, false);
    ok(bad.body.ok === false && bad.body.problems.some((x: string) => x.includes("unknown action")), "preview: reports the problems");
    const nightDb = world({ automations: [a], contacts: [lead("c1")] });
    clock = syd("2026-10-14", 20, 30);
    const pn = await handle(nightDb, { step: "preview", automation_id: "a-prev", record: { kind: "contact", id: "c1" } }, OWNER, false);
    eq([pn.body.steps[2].would, pn.body.steps[2].until], ["wait", isoMs(syd("2026-10-15", 8))], "preview: an email that would land at night waits for the morning");
    clock = NOW;
    eq((await handle(db, { step: "preview", automation_id: "a-prev", record: { kind: "contact", id: "c1" } }, VA, false)).status, 403, "preview: owners and managers only");
    // the phase-4 lists (since G2.4 the step "registry" answers with the stage-2 DTO: section 34)
    const reg = { status: 200, body: registry() as any };
    const text = JSON.stringify(reg.body);
    eq([reg.status, reg.body.triggers.map((t: any) => t.type), reg.body.actions.find((x: any) => x.type === "text").available], [200, ["newLead", "stage", "jobClosed", "missedCall", "chat"], false], "registry: the lists for the builder (texts not available yet)");
    ok(!/=>|function|PRIV|secret/i.test(text) && JSON.stringify(JSON.parse(text)) === text, "registry: metadata only, no code, no secrets");
    eq(reg.body.triggers.find((t: any) => t.type === "jobClosed").fields.includes("technician"), true, "registry: the merge fields each event knows");
    eq((await handle(db, { step: "registry" }, VA, false)).status, 403, "registry: owners and managers only");
  }

  // ── 18. chat trigger end to end (implicit "not answered") ──
  {
    const a = auto({ trigger: { type: "chat", params: {} }, steps: [{ id: "w", kind: "wait", unit: "minutes", n: 5 }, { id: "p1", kind: "action", type: "push", to: { roles: ["owner"] }, title: "Chat waiting: {name}" }] });
    const db = world({ automations: [a], contacts: [lead("c1")], chat_sessions: [{ id: "s1", contact_id: "c1", phone: "+61412345678", first_name: "Sam", full_name: "Sam Smith", created_at: isoMs(NOW), test: false }, { id: "s2", contact_id: null, phone: "+61400999888", full_name: "Kim", created_at: isoMs(NOW), test: false }] });
    sent.length = 0;
    await tickAt(db, NOW);
    db.T.lead_messages.push({ id: "r1", session_id: "s2", direction: "out", auto: false, status: "sent", at: isoMs(NOW + MIN) });
    await tickAt(db, NOW + 5 * MIN);
    eq([sent.map((s) => s.msg.title), runOf(db)], [["Chat waiting: Sam Smith"], ["done", "skipped:condition: chat_unanswered"]], "chat: only the chat nobody answered");
  }

  // ── 19. switched off and on again, or changed, while a run waited (14 Oct review) ──
  {
    const steps = [{ id: "w", kind: "wait", unit: "days", n: 7 }, emailStep()];
    const db = world({ automations: [auto({ id: "a-rev-0001", trigger: { type: "jobClosed", params: {} }, steps })], contacts: [lead("c1")], jobs: [{ id: "j1", contact_id: "c1", date: "2026-10-14", created_at: isoMs(NOW - MIN) }] });
    await tickAt(db, NOW);
    eq(runOf(db), ["waiting"], "a job closed: the review email waits 7 days");
    // switched off on Monday, on again on Wednesday (the SQL guard moves armed_at to the switch-on)
    Object.assign(db.T.automations[0], { enabled: true, armed_at: isoMs(NOW + 2 * DAYMS) });
    await tickAt(db, NOW + 7 * DAYMS + MIN);
    eq([runOf(db), db.T.lead_messages.length], [["cancelled:switched off and on again since then"], 0], "off then on again before the run was due: the job from before the switch-on never gets its email");
    // a change of what starts it re-arms it (SQL guard): an event from before the edit never fires the new version
    const db2 = world({ automations: [auto({ trigger: { type: "stage", params: { stage: "Won" } }, steps: [emailStep()], armed_at: isoMs(NOW - 10 * MIN) })], contacts: [lead("c1", { status: "Won", stage_changed_at: isoMs(NOW - 30 * MIN), messages: [{ at: isoMs(NOW - 3 * DAYMS) }] })] });
    await tickAt(db2, NOW);
    eq([db2.T.automation_runs.length, db2.T.lead_messages.length], [0, 0], "edited at 13:50 to 'moves to Won': a lead moved to Won at 13:30 is not emailed");
    // wording only (same version, same armed_at): the waiting run goes on, with the new words
    const p1 = { id: "p1", kind: "action", type: "push", to: { roles: ["owner"] }, title: "Old words" };
    const db3 = world({ automations: [auto({ steps: [{ id: "w", kind: "wait", unit: "minutes", n: 10 }, p1] })], contacts: [lead("c1")] });
    await tickAt(db3, NOW);
    db3.T.automations[0].steps = [{ id: "w", kind: "wait", unit: "minutes", n: 10 }, { ...p1, title: "New words" }];
    sent.length = 0;
    await tickAt(db3, NOW + 10 * MIN);
    eq([runOf(db3), sent.map((x) => x.msg.title)], [["done"], ["New words"]], "a wording change (no new version): the waiting run goes on with the new words");
  }

  // ── 20. stage moves: the Undo, a card made in a stage, an "any" group ──
  {
    const T0 = NOW - 10 * MIN;
    const a = auto({ trigger: { type: "stage", params: { stage: "Lost" } }, steps: [{ id: "w", kind: "wait", unit: "hours", n: 1 }, emailStep()] });
    const db = world({ automations: [a], contacts: [lead("c1", { status: "Lost", stage_changed_at: isoMs(T0), messages: [{ at: isoMs(NOW - 3 * DAYMS) }] })] });
    await tickAt(db, NOW);
    eq(runOf(db), ["waiting"], "moved to Lost: the email waits an hour");
    Object.assign(db.T.contacts[0], { status: "Quoted", stage_changed_at: isoMs(NOW - 2 * DAYMS) });   // Undo: the old stage and its old time
    await tickAt(db, T0 + HR + MIN);
    eq([runOf(db), db.T.lead_messages.length], [["skipped:condition: stage_move_stands"], 0], "the move was undone: nothing goes, even without 'Still in the stage'");
    // a misclick undone within seconds never starts a run
    const db2 = world({ automations: [auto({ trigger: { type: "stage", params: { stage: "Lost" } }, steps: [emailStep()] })], contacts: [lead("c1", { status: "Lost", stage_changed_at: isoMs(NOW - 3e3), messages: [{ at: isoMs(NOW - 3 * DAYMS) }] })] });
    await tickAt(db2, NOW);
    const ev2 = await handle(db2, { step: "event", type: "stage", id: "c1" }, OWNER, false);
    eq([db2.T.automation_runs.length, ev2.body.reason], [0, "settling"], "a move 3 seconds old: neither the timer nor the app's 'look now' acts on it yet");
    Object.assign(db2.T.contacts[0], { status: "Quoted", stage_changed_at: isoMs(NOW - 2 * DAYMS) });
    await tickAt(db2, NOW + MIN);
    eq([db2.T.automation_runs.length, db2.T.lead_messages.length], [0, 0], "…and once undone it never fires");
    // a card made by hand in a stage is an arrival, not a move
    const sp = auto({ trigger: { type: "stage", params: {} }, steps: [{ id: "p1", kind: "action", type: "push", to: { roles: ["owner"] }, title: "{name} moved to {stage}" }] });
    const db3 = world({ automations: [sp], contacts: [lead("c1", { status: "New", stage_changed_at: isoMs(NOW - 5 * MIN), messages: [{ kind: "event", at: isoMs(NOW - 5 * MIN + 2e3) }] }), lead("c2", { status: "Quoted", stage_changed_at: isoMs(NOW - 5 * MIN), messages: [{ at: isoMs(NOW - 2 * HR) }] })] });
    sent.length = 0;
    await tickAt(db3, NOW);
    eq(db3.T.automation_runs.map((r: any) => r.record_id), ["c2"], "a lead made in 'New' a moment ago is not 'moved to New'; a real move is");
    // "Cancel it if the lead moves on" is never an OR
    const anyGroup = { id: "i1", kind: "if", match: "any", conds: [{ field: "service", op: "is", v: "Aircon" }, { field: "source", op: "is", v: "Referral" }, { field: "stage_unchanged", op: "true" }] };
    const F = (status: string): any => ({ kind: "contact", type: "stage", contact: lead("c1", { status }), job: null, call: null, chat: null, ctx: { stage: "Quoted" }, eventAt: isoMs(NOW), S: normSettings({}), cat: CATALOG, company: "Acme", nowMs: NOW });
    eq([(await evalConds(db3, F("Lost"), anyGroup.conds, "any")).ok, (await evalConds(db3, F("Quoted"), anyGroup.conds, "any")).ok, (await evalConds(db3, F("Quoted"), [anyGroup.conds[1], anyGroup.conds[2]], "any")).ok],
      [false, true, false], "'Still in the stage' is always an AND, even in an 'any one of these' group");
  }

  // ── 21. new leads that are not new ──
  {
    const db = world({ automations: [auto()], contacts: [lead("j-card", { status: "Booked", linked_job_id: "j1", created_at: "2026-10-14", messages: [{ kind: "event", at: isoMs(NOW - MIN) }] }), lead("back", { linked_job_id: "j0", reopened_at: isoMs(NOW - MIN) })] });
    sent.length = 0;
    await tickAt(db, NOW);
    eq(db.T.automation_runs.map((r: any) => r.record_id), ["back"], "a card the app made for a job is not a new lead; a returning customer who asks again is");
    eq([cleanFirstName("(no name)"), cleanFirstName("Caller 0412 345 678"), cleanFirstName("Text from 0412"), cleanFirstName("O'Brien"), cleanFirstName("mary-jane smith"), cleanFirstName("Smith, Sam"), cleanFirstName("info@x.com")],
      ["", "", "", "O'Brien", "Mary-jane", "Sam", ""], "cleanFirstName: placeholders and punctuation never become a greeting");
    const f0: any = { kind: "contact", type: "newLead", contact: lead("c0", { full_name: "(no name)" }), job: null, call: null, chat: null, ctx: {}, eventAt: isoMs(NOW), S: normSettings({}), cat: CATALOG, company: "Acme", nowMs: NOW };
    eq(mergeVars(f0, { name: "x", steps: [] }).hi, "Hi there", "a '(no name)' card is greeted 'Hi there'");
  }

  // ── 22. the daily cap: one person, every channel, every card, at the same moment ──
  {
    const emailAuto = (o: any = {}) => auto({ steps: [emailStep()], ...o });
    // two cards of the same person (the form sent twice)
    let db = world({ automations: [emailAuto()], contacts: [lead("c1"), lead("c2", { messages: [{ at: isoMs(NOW - MIN) }] })] });
    await tickAt(db, NOW);
    eq([db.T.lead_messages.length, logOf(db).sort()], [1, ["e1:queued", "e1:skipped:already contacted today"]], "two cards with the same email: one email");
    // another function's automatic text to this card today
    db = world({ automations: [emailAuto()], contacts: [lead("c1")], lead_messages: [{ id: "x1", contact_id: "c1", channel: "sms", direction: "out", auto: true, status: "sent", at: isoMs(NOW - HR) }] });
    await tickAt(db, NOW);
    eq(logOf(db), ["e1:skipped:already contacted today"], "an automatic text from the chat or missed-call function today counts");
    db = world({ automations: [emailAuto()], contacts: [lead("c1")], lead_messages: [{ id: "x1", contact_id: "c1", channel: "sms", direction: "out", auto: true, status: "failed", at: isoMs(NOW - HR) }] });
    await tickAt(db, NOW);
    eq(logOf(db), ["e1:queued"], "…one that failed does not");
    db = world({ automations: [emailAuto()], contacts: [lead("c1")], review_requests: [{ id: "r1", phone: "+61412345678", status: "sent", sent_at: isoMs(NOW - 3 * HR), created_at: isoMs(NOW - 3 * HR) }] });
    await tickAt(db, NOW);
    eq(logOf(db), ["e1:skipped:already contacted today"], "a review request sent today to the same phone counts");
    // a message being sent right now by another call (the app's 'look now' and the timer at the same moment)
    db = world({ automations: [emailAuto()], contacts: [lead("c1")], automation_log: [{ id: "l0", business_id: "default", run_id: "other", step_id: "e9", status: "sending", channel: "email", audience: "customer", contact_id: "c1", recipient: "sam@example.com", at: isoMs(NOW - 1e3), automation_name: "Other" }] });
    await tickAt(db, NOW);
    eq([db.T.lead_messages.length, logOf(db).filter((x: string) => x.startsWith("e1"))], [0, ["e1:skipped:already contacted today"]], "one being sent this moment counts: never two");
    db = world({ automations: [emailAuto()], contacts: [lead("c1")] });
    await tickAt(db, NOW);
    ok(db.calls.includes("rpc:" + CLAIM_RPC), "a customer email is claimed through " + CLAIM_RPC);
    // the cap is a setting
    db = world({ automations: [emailAuto({ id: "a-c1" }), emailAuto({ id: "a-c2" })], contacts: [lead("c1")], automation_settings: [{ business_id: "default", customer_daily_cap: 2 }] });
    await tickAt(db, NOW);
    eq(db.T.lead_messages.length, 2, "a cap of 2: two emails");
  }

  // ── 23. review asks by the engine count as asked ──
  {
    const ask = (id: string) => auto({ id, trigger: { type: "jobClosed", params: {} }, steps: [{ id: "i1", kind: "if", match: "all", conds: [{ field: "asked_within_months", op: "true", n: 6 }] }, emailStep()] });
    const db = world({ automations: [ask("a-ask-0001")], contacts: [lead("c1"), lead("c2", { messages: [{ at: isoMs(NOW - 3 * DAYMS) }] })],
      jobs: [{ id: "j1", contact_id: "c1", date: "2026-10-14", created_at: isoMs(NOW - 2 * MIN) }],
      automation_log: [{ id: "old", business_id: "default", run_id: "r-old", step_id: "e1", automation_id: "a-ask-0001", status: "sent", channel: "email", audience: "customer", contact_id: "c9", recipient: "sam@example.com", at: isoMs(NOW - 40 * DAYMS), automation_name: "Ask" }] });
    await tickAt(db, NOW);
    eq([runOf(db), db.T.lead_messages.length], [["skipped:condition: asked_within_months"], 0], "asked by this engine 40 days ago (another card, same email): not asked again within 6 months");
    const db2 = world({ automations: [ask("a-ask-0002")], contacts: [lead("c1")], jobs: [{ id: "j1", contact_id: "c1", date: "2026-10-14", created_at: isoMs(NOW - 2 * MIN) }],
      automation_log: [{ id: "x", business_id: "default", run_id: "r-x", step_id: "e1", automation_id: "a-welcome", status: "sent", channel: "email", audience: "customer", contact_id: "c1", recipient: "sam@example.com", at: isoMs(NOW - 40 * DAYMS), automation_name: "Welcome" }] });
    await tickAt(db2, NOW);
    eq(db2.T.lead_messages.length, 1, "an email of an automation that doesn't ask for reviews is not a review ask");
  }

  // ── 24. the customer hours and an "Only on" window together ──
  {
    const tue21 = syd("2026-10-13", 21);
    const off = auto({ steps: [{ id: "w", kind: "window", mode: "outsideOffice", outside: "skip" }, emailStep()] });
    let db = world({ automations: [off], contacts: [lead("c1", { created_at: "2026-10-13", messages: [{ at: isoMs(tue21) }] })] });
    await tickAt(db, tue21);
    eq([runOf(db), db.T.lead_messages.length, logOf(db)], [["done"], 0, ["e1:skipped:outside the allowed days and hours (customer hours)"]], "'only outside office hours, else stop' at 21:00: the customer hours would make it 08:00 (office hours), so it stops");
    const wknd = auto({ steps: [{ id: "w", kind: "window", days: [0, 6], from: "06:00", until: "23:00", outside: "next" }, emailStep()] });
    const sun21 = syd("2026-10-18", 21);
    db = world({ automations: [wknd], contacts: [lead("c1", { created_at: "2026-10-18", messages: [{ at: isoMs(sun21) }] })] });
    await tickAt(db, sun21);
    eq([runOf(db), db.T.automation_runs[0].due_at, db.T.automation_runs[0].step_index], [["waiting"], isoMs(syd("2026-10-24", 8)), 0], "a weekend-only window at Sunday 21:00: it waits for Saturday 08:00 (inside both), not Monday");
    await tickAt(db, syd("2026-10-24", 8));
    eq([runOf(db), db.T.lead_messages.length], [["done"], 1], "…and goes then");
    // 'at' must lie inside the window's hours
    const wk = { days: [1, 2, 3, 4, 5], from: "09:00", until: "17:00" };
    eq([isoMs(nextAt(syd("2026-10-19", 18), wk, "10:00", "Australia/Sydney", {}) as number), nextAt(syd("2026-10-19", 18), wk, "20:00", "Australia/Sydney", {})], [isoMs(syd("2026-10-20", 10)), null], "'at' inside the hours: the next allowed day; outside them: never");
    ok(validateAutomation(auto({ steps: [{ id: "w", kind: "window", ...wk, outside: "at", at: "20:00" }, { id: "p1", kind: "action", type: "push", to: { roles: ["owner"] }, title: "x" }] })).some((p) => p.includes("inside the window's hours")), "validation: 'at' outside the window's hours is refused");
  }

  // ── 25. the email itself: signer, way out, withdrawn at night ──
  {
    let db = world({ automations: [auto({ created_by_name: "", steps: [emailStep()] })], contacts: [lead("c1")] });
    await tickAt(db, NOW);
    eq([db.T.lead_messages.length, logOf(db)], [0, ["e1:skipped:no email signer set"]], "no signer and no maker's name: the email is not sent (never signed 'The')");
    db = world({ automations: [auto({ created_by_name: "", steps: [emailStep()] })], contacts: [lead("c1")], automation_settings: [{ business_id: "default", email_signer: "Dana Lee", email_footer: "Reply STOP to opt out." }] });
    await tickAt(db, NOW);
    eq([db.T.lead_messages[0].author, signatureOf(db.T.lead_messages[0].author, bizOf("Acme Home Services", CATALOG)).split("\n")[2], db.T.lead_messages[0].body.endsWith("\n\nReply STOP to opt out.")], ["Dana Lee", "Dana", true], "the business's signer and its own way out");
    eq([emailAuthor(normSettings({}), { created_by_name: "The team" }), emailAuthor(normSettings({}), { created_by_name: "Olivia Owner" })], ["", "Olivia"], "emailAuthor: never a phrase");
    // withdrawn when the customer hours close
    const at = syd("2026-10-14", 19, 59);
    db = world({ lead_messages: [{ id: "lm1", status: "queued" }, { id: "lm2", status: "sent" }, { id: "lm3", status: "queued" }],
      automation_log: [{ id: "l1", business_id: "default", run_id: "x1", step_id: "e1", status: "queued", ref_id: "lm1", at: isoMs(at), automation_name: "A", channel: "email", audience: "customer" },
        { id: "l2", business_id: "default", run_id: "x2", step_id: "e1", status: "queued", ref_id: "lm2", at: isoMs(at), automation_name: "A", channel: "email", audience: "customer" },
        { id: "l3", business_id: "default", run_id: "x3", step_id: "e1", status: "queued", ref_id: "lm3", at: isoMs(syd("2026-10-14", 19, 0)), automation_name: "A", channel: "email", audience: "customer" }] });
    await reconcile(db, syd("2026-10-14", 19, 30), normSettings({}), {});
    eq([db.T.lead_messages.map((m: any) => m.status), db.T.automation_log.map((l: any) => l.status)], [["queued", "sent", "queued"], ["queued", "queued", "queued"]], "inside the customer hours a slow mailbox still has time");
    await reconcile(db, syd("2026-10-14", 20, 5), normSettings({}), {});
    eq([db.T.lead_messages.map((m: any) => m.status), db.T.automation_log.map((l: any) => `${l.status}${l.reason ? ":" + l.reason : ""}`)],
      [["failed", "sent", "failed"], ["failed:not sent within the customer hours (withdrawn)", "sent", "failed:not sent within the customer hours (withdrawn)"]], "after the customer hours: still-queued emails are taken back from the mailbox (it can't send them at 2 am); one that went is 'sent'");
  }

  // ── 26. more events than one call takes ──
  {
    const many = Array.from({ length: 300 }, (_, k) => lead("m" + k, { status: "Quoted", stage_changed_at: isoMs(NOW - 5 * MIN - k * 1e3), messages: [{ at: isoMs(NOW - 3 * DAYMS) }], email: `m${k}@example.com`, phone: "" }));
    const db = world({ automations: [auto({ trigger: { type: "stage", params: { stage: "Quoted" } }, steps: [{ id: "w", kind: "wait", unit: "days", n: 2 }, { id: "p1", kind: "action", type: "push", to: { roles: ["owner"] }, title: "x" }] })], contacts: many });
    await tickAt(db, NOW);
    eq(db.T.automation_runs.length, ENQUEUE_MAX, "300 leads moved at once: the first 200 (oldest first) start this minute");
    await tickAt(db, NOW + MIN);
    eq([db.T.automation_runs.length, new Set(db.T.automation_runs.map((r: any) => r.record_id)).size], [300, 300], "…and the other 100 the next minute (not the same 200 again)");
  }

  // ── 26a. (main, stage 5) an MCP import made with automations off (quiet) is not a new lead; a quiet imported job never "closes" ──
  {
    const quietLead = (id: string, o: any = {}) => lead(id, { messages: [{ id: "m1", kind: "event", at: isoMs(NOW - 2 * MIN), text: "Imported from Fake CRM (Leads), automatic messages off", quiet: true }], last_read_at: isoMs(NOW - 2 * MIN), ...o });
    const emailAuto = () => auto({ steps: [emailStep()] });
    let db = world({ contacts: [quietLead("q1")], automations: [emailAuto()] });
    await tickAt(db, NOW); await tickAt(db, NOW + MIN);
    eq([db.T.automation_runs.length, db.T.lead_messages.length], [0, 0], "quiet import: no newLead run, no email queued");
    eq((await handle(db, { step: "event", type: "newLead", id: "q1" }, OWNER, false)).body, { ok: true, runs: 0, reason: "no event" }, "quiet import: the app's 'look now' → no event");
    db = world({ contacts: [quietLead("q2", { reopened_at: isoMs(NOW - MIN) })], automations: [emailAuto()] });
    await tickAt(db, NOW);
    eq([db.T.automation_runs.length, db.T.lead_messages.length], [1, 1], "quiet import reopened by the customer: a real new arrival, it fires");
    db = world({ contacts: [lead("q3", { messages: [{ at: isoMs(NOW - 2 * MIN), quiet: false }] })], automations: [emailAuto()] });
    await tickAt(db, NOW);
    eq([db.T.automation_runs.length, db.T.lead_messages.length], [1, 1], "quiet:false fires as before");
    eq([quietArrival({ first_quiet: "true" }), quietArrival({ first_quiet: null, messages: [{ quiet: true }] }), quietArrival({ first_quiet: "false" }), quietArrival({ first_quiet: null }), quietArrival({ messages: [] }), quietArrival({ messages: [{ quiet: "yes" }] })],
      [true, true, false, false, false, false], "quietArrival: the scan column (first_quiet) or the full thread");
    // the marker column (SQL M5-review): set by the import on every row it makes, read before the thread
    db = world({ contacts: [lead("q4", { import_quiet: true, messages: [{ at: isoMs(NOW - 2 * MIN) }] }), lead("q5", { import_quiet: false, messages: [{ at: isoMs(NOW - 2 * MIN) }] })], automations: [emailAuto()] });
    await tickAt(db, NOW); await tickAt(db, NOW + MIN);
    eq(db.T.automation_runs.map((r: any) => r.record_id || r.contact_id), ["q5"], "import_quiet: a quiet import (column only) is not a new lead; import_quiet false fires as before");
    eq([quietArrival({ import_quiet: true }), quietArrival({ import_quiet: false, first_quiet: null }), quietArrival({ import_quiet: true, first_quiet: "false" })], [true, false, true], "quietArrival: the import_quiet column first");
    const jobAuto = () => auto({ trigger: { type: "jobClosed", params: {} }, steps: [emailStep()] });
    db = world({ automations: [jobAuto()], contacts: [lead("c1")], jobs: [{ id: "jq", contact_id: "c1", date: "2026-10-14", created_at: null, review_do_not_ask: true }] });
    await tickAt(db, NOW);
    eq(db.T.automation_runs.length, 0, "a quiet imported job (created_at null, done today) starts no jobClosed run");
    db = world({ automations: [jobAuto()], contacts: [lead("c1")], jobs: [{ id: "jn", contact_id: "c1", date: "2026-10-14", created_at: isoMs(NOW - MIN) }] });
    await tickAt(db, NOW);
    eq(db.T.automation_runs.map((r: any) => r.event_type), ["jobClosed"], "the same job with created_at = now does");
  }

  // ── 26b. (main) people on vacation (stage 3) ──
  {
    const day = "2026-10-14";   // NOW is 14 Oct, Sydney
    // neutral demo names (the repo is public): the technician login is "Cal Tech" here
    const PROFS = [OWNER, MANAGER, VA, VA_NOCRM, { ...TECH, full_name: "Cal Tech", technician_name: "Cal Tech" }];
    const EMPS = [{ id: "e-own", name: "Olivia Owner", status: "Active" }, { id: "e-mgr", name: "Max Manager", status: "Active" }, { id: "e-va", name: "Vicky Va", status: "Active" }, { id: "e-cal", name: "Cal Tech", status: "Active" }, { id: "e-old", name: "Old Hand", status: "Inactive" }];
    const vac = (o: any = {}) => ({ id: "v1", business_id: "default", employee_id: "e-own", starts_on: "2026-10-13", ends_on: "2026-10-17", stand_in_id: null, options: { noNotify: true }, ended_at: null, cancelled_at: null, reminded_at: null, ...o });
    const pushTo = (roles: string[]) => ({ id: "p1", kind: "action", type: "push", to: { roles }, title: "New lead: {name}" });
    const run = async (vacs: any[], steps: any[]) => { const db = world({ profiles: PROFS, employees: EMPS, employee_vacations: vacs, automations: [auto({ steps })], contacts: [lead("c1")] }); sent.length = 0; await tickAt(db, NOW); return db; };
    let db = await run([vac({ stand_in_id: "e-mgr", options: { noNotify: true, standIn: true } })], [pushTo(["owner", "manager"])]);
    eq([sent.map((s) => s.to), db.T.automation_log[0].recipient], [["https://push/mgr"], "Max Manager"], "push: the owner away (stand-in the manager) → the manager once; logged as Max Manager");
    db = await run([vac()], [pushTo(["owner", "manager"])]);
    eq([sent.map((s) => s.to), db.T.automation_log[0].recipient], [["https://push/mgr"], "Max Manager"], "push: the owner away without a stand-in → the manager only (as a role recipient)");
    db = await run([vac({ stand_in_id: "e-mgr", options: { noNotify: true, standIn: true } })], [pushTo(["owner"])]);
    eq([sent.map((s) => s.to), db.T.automation_log[0].status, db.T.automation_log[0].reason], [[], "skipped", "on vacation"], "push: owners only, the owner away → a manager stand-in never gets an owners-only message; logged 'skipped: on vacation', not 'failed: no device'");
    db = await run([vac({ stand_in_id: "e-cal", options: { noNotify: true, standIn: true } })], [pushTo(["owner", "manager"])]);
    eq([sent.map((s) => s.to), db.T.automation_log[0].recipient], [["https://push/mgr"], "Max Manager"], "push: an owner's technician stand-in isn't a recipient of an owner + manager message");
    db = await run([vac({ stand_in_id: "e-cal", options: { noNotify: true, standIn: true } })], [{ ...pushTo([]), to: { roles: [], people: ["u-owner"] } }]);
    eq([db.T.automation_log[0].recipient || "", db.T.automation_log[0].status], ["", "skipped"], "push: the owner picked by name, away → their technician stand-in isn't added either (skipped: on vacation)");
    db = await run([vac({ stand_in_id: "e-cal", options: { noNotify: true, standIn: true } })], [pushTo(["owner", "technician"])]);
    eq(db.T.automation_log[0].recipient, "Cal Tech", "push: technicians picked too → the technician stand-in gets it (once)");
    db = await run([], [pushTo(["owner", "manager"])]);
    eq(sent.map((s) => s.to).sort(), ["https://push/mgr", "https://push/owner"], "push: no vacations → as before");
    db = await run([vac({ starts_on: "2026-10-10", ends_on: "2026-10-13" })], [pushTo(["owner"])]);
    eq(sent.map((s) => s.to), ["https://push/owner"], "push: a vacation that ended yesterday → the owner gets it");
    // tasks
    const task = (assignees: string[]) => ({ id: "t1", kind: "action", type: "task", title: "Call {first_name}", assignees, due_days: 1 });
    db = await run([vac({ employee_id: "e-cal", stand_in_id: "e-va", options: { notAssignable: true, standIn: true } })], [task(["e-cal"])]);
    eq([db.T.tasks[0].assignees, db.T.tasks[0].assigned_to, db.T.tasks[0].board, db.T.automation_log[0].recipient], [["Vicky Va"], "Vicky Va", "ron", "Vicky Va"], "task: someone not assignable → their stand-in (and the board follows)");
    eq(db.T.tasks[0].notes, "For Cal Tech (on vacation): given to Vicky Va, the stand-in.", "task: a redirected task says who it was for");
    db = await run([vac({ employee_id: "e-cal", stand_in_id: "e-va", options: { notAssignable: true, standIn: true } })], [{ ...task(["e-cal"]), notes: "Ring before 5" }]);
    eq(db.T.tasks[0].notes, "For Cal Tech (on vacation): given to Vicky Va, the stand-in.\n\nRing before 5", "task: the line comes before the automation's own notes");
    db = await run([vac({ employee_id: "e-cal", stand_in_id: "e-va", options: { notAssignable: true, standIn: true } })], [task(["e-cal", "e-va"])]);
    eq(db.T.tasks[0].assignees, ["Vicky Va"], "task: the stand-in already chosen → once");
    db = await run([vac({ employee_id: "e-cal", stand_in_id: "e-va", options: { notAssignable: true } })], [task(["e-cal"])]);
    eq([db.T.tasks[0].assignees, db.T.tasks[0].notes], [["Cal Tech"], ""], "task: no stand-in ticked → the person stays (a warning in the app, never a block), no line in the notes");
    db = await run([vac({ employee_id: "e-cal", stand_in_id: "e-va", options: { notAssignable: true, standIn: true } }), vac({ id: "v2", employee_id: "e-va", options: { notAssignable: true } })], [task(["e-cal"])]);
    eq(db.T.tasks[0].assignees, ["Cal Tech"], "task: the stand-in is away too → the person stays");
    db = await run([vac({ employee_id: "e-cal", stand_in_id: "e-old", options: { notAssignable: true, standIn: true } })], [task(["e-cal"])]);
    eq(db.T.tasks[0].assignees, ["Cal Tech"], "task: an inactive stand-in → the person stays");
    // the due day decides, as in the app (saveTaskModal checks tm-due): away today but back before it → stays; away on it → stand-in
    const taskIn = (d: number) => ({ ...task(["e-cal"]), due_days: d });
    db = await run([vac({ employee_id: "e-cal", stand_in_id: "e-va", options: { notAssignable: true, standIn: true } })], [taskIn(7)]);
    eq([db.T.tasks[0].due, db.T.tasks[0].assignees], ["2026-10-21", ["Cal Tech"]], "task: due after the return day (away 13–17 Oct, due 21 Oct) → the person stays");
    db = await run([vac({ employee_id: "e-cal", starts_on: "2026-10-17", ends_on: "2026-10-23", stand_in_id: "e-va", options: { notAssignable: true, standIn: true } })], [taskIn(7)]);
    eq(db.T.tasks[0].assignees, ["Vicky Va"], "task: a vacation from 17 Oct covers the due day (21 Oct) → the stand-in, though they aren't away today");
    db = await run([vac({ employee_id: "e-cal", starts_on: "2026-10-17", ends_on: "2026-10-23", stand_in_id: "e-va", options: { notAssignable: true, standIn: true } })], [{ ...task(["e-cal"]), due_days: null }]);
    eq(db.T.tasks[0].assignees, ["Cal Tech"], "task: no due day → today counts (not away yet)");
    // pure: names once, in order
    const C = { day, tz: "Australia/Sydney", vacs: [vac({ employee_id: "e-cal", stand_in_id: "e-va", options: { notAssignable: true, standIn: true } })], employees: EMPS, profiles: [] };
    eq(vacTaskPeople([EMPS[3], EMPS[1], EMPS[2]], C), ["Vicky Va", "Max Manager"], "vacTaskPeople: replaced, deduped, order kept");
    eq(vacTaskPeople([EMPS[3]], { ...C, vacs: [] }), ["Cal Tech"], "vacTaskPeople: nobody away → unchanged");
    const moved: VacMove[] = [];
    eq([vacTaskPeople([EMPS[3], EMPS[1]], C, undefined, moved), moved], [["Vicky Va", "Max Manager"], [{ from: "Cal Tech", to: "Vicky Va" }]], "vacTaskPeople: who was swapped for whom");
    eq([vacMovedNote([]), vacMovedNote([{ from: "A", to: "B" }, { from: "C", to: "B" }])], ["", "For A (on vacation): given to B, the stand-in.\nFor C (on vacation): given to B, the stand-in."], "vacMovedNote: one line each, none when nobody moved");
    eq([vacTaskPeople([EMPS[3]], C, "2026-10-18"), vacTaskPeople([EMPS[3]], C, "2026-10-17"), vacTaskPeople([EMPS[3]], C, day)], [["Cal Tech"], ["Vicky Va"], ["Vicky Va"]], "vacTaskPeople: on the day given (the due day)");
    // preview shows the same
    const a = auto({ id: "a-vac", enabled: false, steps: [pushTo(["owner", "manager"]), { ...task(["e-cal"]), id: "t1" }] });
    const pdb = world({ profiles: PROFS, employees: EMPS, employee_vacations: [vac({ stand_in_id: "e-mgr", options: { noNotify: true, standIn: true } }), vac({ id: "v2", employee_id: "e-cal", stand_in_id: "e-va", options: { notAssignable: true, standIn: true } })], automations: [a], contacts: [lead("c1")] });
    const p = await handle(pdb, { step: "preview", automation_id: "a-vac", record: { kind: "contact", id: "c1" } }, OWNER, false);
    eq([p.body.steps[0].to, p.body.steps[1].assignees, p.body.steps[1].board, p.body.steps[1].notes], [["Max Manager"], ["Vicky Va"], "ron", "For Cal Tech (on vacation): given to Vicky Va, the stand-in."], "preview: the redirected push names, task assignees and the line in its notes");
    const sdb = world({ profiles: PROFS, employees: EMPS, employee_vacations: [vac()], automations: [auto({ id: "a-skip", enabled: false, steps: [pushTo(["owner"])] })], contacts: [lead("c1")] });
    const ps = await handle(sdb, { step: "preview", automation_id: "a-skip", record: { kind: "contact", id: "c1" } }, OWNER, false);
    eq([ps.body.steps[0].would, ps.body.steps[0].reason], ["skip", "on vacation"], "preview: everyone picked is away → 'skip: on vacation'");
    // the preview reads the vacations of the day the action would run (after its waits), not today's
    const later = (vacs: any[]) => world({ profiles: PROFS, employees: EMPS, employee_vacations: vacs, contacts: [lead("c1")],
      automations: [auto({ id: "a-later", enabled: false, steps: [{ id: "w", kind: "wait", unit: "days", n: 7 }, pushTo(["owner"])] })] });
    const pl = await handle(later([vac()]), { step: "preview", automation_id: "a-later", record: { kind: "contact", id: "c1" } }, OWNER, false);
    eq([pl.body.steps[1].would, pl.body.steps[1].to], ["send", ["Olivia Owner"]], "preview: the owner away today but back before the action (in 7 days) → sent to them");
    const pf = await handle(later([vac({ starts_on: "2026-10-20", ends_on: "2026-10-23" })]), { step: "preview", automation_id: "a-later", record: { kind: "contact", id: "c1" } }, OWNER, false);
    eq([pf.body.steps[1].would, pf.body.steps[1].reason], ["skip", "on vacation"], "preview: the owner away on the action's day (not today) → 'skip: on vacation'");
    // read once per tick
    const twice = auto({ steps: [pushTo(["owner"]), { ...pushTo(["manager"]), id: "p2" }] });
    const odb = world({ profiles: PROFS, employees: EMPS, employee_vacations: [vac({ starts_on: "2026-10-01", ends_on: "2026-10-02" })], automations: [twice, auto({ steps: [pushTo(["manager"])] })], contacts: [lead("c1")] });
    sent.length = 0;
    await tickAt(odb, NOW);
    eq([odb.calls.filter((c: string) => c === "employee_vacations.select").length, sent.length], [1, 3], "vacations are read once per tick (three push actions, two automations)");
    // the day is the business's (settings.catalog.region.timeZone, review A2): 14 Oct 14:00 Sydney is 13 Oct 22:00 in Chicago
    const only13 = [vac({ starts_on: "2026-10-13", ends_on: "2026-10-13" })];
    db = await run(only13, [pushTo(["owner", "manager"])]);
    eq(sent.map((s) => s.to).sort(), ["https://push/mgr", "https://push/owner"], "zone: Sydney business, away only on 13 Oct → back today, the owner gets it");
    const cdb = world({ profiles: PROFS, employees: EMPS, employee_vacations: only13, automations: [auto({ steps: [pushTo(["owner", "manager"])] })], contacts: [lead("c1")],
      settings: [{ id: 1, company_name: "Acme Home Services", catalog: { ...CATALOG, region: { timeZone: "America/Chicago" } } }] });
    sent.length = 0;
    await tickAt(cdb, NOW);
    eq(sent.map((s) => s.to), ["https://push/mgr"], "zone: a Chicago business, still 13 Oct there → the owner is away, the manager only");
  }
}

(async () => {
  const fs: any = await import("node:fs");
  const src = (p: string) => fs.readFileSync(p, "utf8") as string;
  const SQL_DIR = "../../../.claude/sql/";
  const sqlFiles = (fs.readdirSync(SQL_DIR) as string[]).filter((f) => f.endsWith(".sql") && f !== "stage2-automations.sql").sort().concat(["stage2-automations.sql"]);
  for (const f of sqlFiles) Object.assign(SQL_SIGS, sqlSigs(src(SQL_DIR + f)));
  function fnSource(text: string, head: string): string {
    const at = text.indexOf(head); if (at < 0) return "";
    // the signature may hold braces (types): the body's own brace ends the signature line
    let i = text.indexOf("{\n", at), depth = 1; i++;
    while (depth > 0 && i < text.length) { if (text[i] === "{") depth++; else if (text[i] === "}") depth--; i++; }
    return text.slice(at, i);
  }

  // ── 1. shared code is really shared ──
  {
    const mine = src("index.ts"), push = src("../push/index.ts"), backup = src("../backup/index.ts");
    const sendA = fnSource(mine, "export async function sendTo("), sendB = fnSource(push, "export async function sendTo(");
    const keyA = fnSource(mine, "export async function vapidKeys("), keyB = fnSource(push, "export async function vapidKeys(");
    ok(sendA.length > 200 && sendA === sendB, "sendTo is byte-identical to push/index.ts");
    ok(keyA.length > 200 && keyA === keyB, "vapidKeys is byte-identical to push/index.ts");
    // the vacations block (stage 3): one copy in automations, push and voice
    const vacBlock = (text: string) => { const a = text.indexOf("// ── vacations (stage 3)"), z = text.indexOf("// ── end vacations ──"); return a < 0 || z < a ? "" : text.slice(a, z); };
    const vacA = vacBlock(mine), vacB = vacBlock(push), vacC = vacBlock(src("../voice/index.ts"));
    ok(vacA.length > 1500 && vacA === vacB && vacA === vacC, "the vacations block is byte-identical in automations, push and voice", [vacA.length, vacB.length, vacC.length]);
    ok(fnSource(mine, "export function sameSecret(") === fnSource(backup, "export function sameSecret(") && fnSource(mine, "export function sameSecret(").length > 50, "sameSecret is the backup function's");
    const conv = src("../conversations/index.ts");
    const sigA = fnSource(mine, "export function signatureOf("), sigB = fnSource(conv, "export function signatureOf(");
    ok(sigA.length > 100 && sigA === sigB, "signatureOf is byte-identical to the one conversations' alerts adds (the preview shows it)");
    ok(/m\.email === MAILBOX \? "" : signatureOf\(m\.author \|\| "", bizSig\(\)\)/.test(conv), "conversations' alerts signs with signatureOf and the business details");
    eq(signatureOf("Ron Smith", bizOf("The Guys Service Group", { business: { phone: "1300 380 090" } })), "\n\nRon\nThe Guys Service Group\n1300 380 090", "signatureOf: with today's settings, today's exact signature");
    eq([signatureOf("", bizOf("Acme", {})), signatureOf("", bizOf("Acme", { labels: { office: "Reception" } }))], ["\n\nOffice\nAcme", "\n\nReception\nAcme"], "signatureOf: no author = the office's name; no phone saved = none");
    // fillMerge = review-requests' fillReview for its keys
    const rr = src("../review-requests/index.ts");
    const fr = fnSource(rr, "export function fillReview(").replace(/^export function fillReview\([^)]*\): string \{/, "function (t, v) {");
    const fillReview = new Function("return " + fr)();
    const RK = ["hi", "first_name", "technician", "result", "review_link", "today", "review_button"];
    const cases: [string, Record<string, string>][] = [
      ["Hi {first_name}, thanks!", { first_name: "" }], ["Hi {first_name}, thanks!", { first_name: "Sam" }], ["A quick favour, {first_name}?", { first_name: "" }],
      ["{hi}, {technician} here - thanks for having us{today}! {result} Review: {review_link} Thank you!", { hi: "Hi Sam", technician: "Guy", today: " today", result: "Enjoy!", review_link: "https://x" }],
      ["{hi}, {technician} here - thanks for having us{today}! {result} Review: {review_link} Thank you!", { hi: "Hi", technician: "Guy", today: "", result: "", review_link: "https://x" }],
      ["  {review_button}\nThanks {first_name}.", { review_button: "", first_name: "" }], ["Keep {other} as is", {}],
    ];
    for (const [t, v] of cases) eq(fillMerge(t, v, RK), fillReview(t, v), `fillMerge = fillReview: ${JSON.stringify(t).slice(0, 40)}`);
    const f0: any = { kind: "contact", type: "newLead", contact: lead("c0", { full_name: "" }), job: null, call: null, chat: null, ctx: {}, eventAt: isoMs(NOW), S: normSettings({}), cat: CATALOG, company: "Acme Home Services", nowMs: NOW };
    eq(fillMerge("{hi}, from {business_name}", mergeVars(f0, { name: "x", steps: [] }), fieldsFor("newLead")), "Hi there, from Acme Home Services", "{hi} with no first name = Hi there; the business name comes from settings");
    eq(fillMerge("Your {service} booking {suburb}.", { service: "Aircon cleaning", suburb: "" }, fieldsFor("newLead")), "Your Aircon cleaning booking.", "a known blank with nothing to put in goes cleanly");
    eq([fillMerge("Use {coupon} today", {}, fieldsFor("newLead")), unfilled("Use {coupon} and {x}")], ["Use {coupon} today", ["coupon", "x"]], "an unknown blank stays (and is listed)");
    eq(fillMerge("{technician} did it", { technician: "Guy" }, fieldsFor("newLead")), "{technician} did it", "a field the event doesn't know stays unfilled");
  }

  // ── 2. time ──
  {
    const tz = "Australia/Sydney";
    eq(zoneParts(Date.parse("2026-10-14T03:00:00Z"), tz), { day: "2026-10-14", dow: 3, minutes: 840 }, "zoneParts: Wednesday 14:00 Sydney");
    eq([hm("08:00"), hm("24:00"), hm("8:00"), hm("25:00"), hm("12:60")], [480, 1440, null, null, null], "hm: strict HH:MM, 24:00 = end of day");
    eq(isoMs(syd("2026-10-04", 8)), "2026-10-03T21:00:00.000Z", "zoneToUtc: 08:00 on the first day of daylight saving is 21:00 UTC (+11)");
    eq(isoMs(syd("2026-10-03", 8)), "2026-10-02T22:00:00.000Z", "zoneToUtc: 08:00 the day before is 22:00 UTC (+10)");
    eq(isoMs(planWait(syd("2026-10-03", 9), { unit: "days", n: 2 }, tz)), isoMs(syd("2026-10-05", 9)), "days wait keeps the wall-clock time across daylight saving");
    eq(planWait(NOW, { unit: "minutes", n: 5 }, tz) - NOW, 5 * MIN, "minutes wait by the clock");
    eq(planWait(NOW, { unit: "hours", n: 2 }, tz) - NOW, 2 * HR, "hours wait by the clock");
    const wk = { days: [1, 2, 3, 4, 5], from: "09:00", until: "17:00" };
    eq(isoMs(nextAllowed(syd("2026-10-17", 10), wk, tz, {}) as number), isoMs(syd("2026-10-19", 9)), "window Mon–Fri 9–17: Saturday 10:00 → Monday 09:00");
    eq(nextAllowed(syd("2026-10-14", 10), wk, tz, {}), syd("2026-10-14", 10), "inside the window = now");
    eq(nextAllowed(NOW, { days: [], from: "09:00", until: "17:00" }, tz, {}), null, "no allowed day = null");
    const all = { days: [0, 1, 2, 3, 4, 5, 6], from: "08:00", until: "20:00" };
    eq(isoMs(nextAt(syd("2026-10-14", 21), all, "10:00", tz, {}) as number), isoMs(syd("2026-10-15", 10)), "'at' 10:00 after 20:00 → the next allowed day at 10:00");
    // office hours: catalog.hours (Mon–Fri 8–17 by default), NSW holidays when chosen, extra days off
    eq(isoMs(nextAllowed(syd("2026-10-05", 10), { mode: "office" }, tz, CATALOG) as number), isoMs(syd("2026-10-06", 8)), "office: Labour Day (NSW holiday) → Tuesday 08:00");
    eq(nextAllowed(syd("2026-10-05", 10), { mode: "office" }, tz, {}), syd("2026-10-05", 10), "office: without the NSW holidays chosen, the holiday is a work day");
    eq(isoMs(nextAllowed(syd("2026-10-19", 18), { mode: "office" }, tz, CATALOG) as number), isoMs(syd("2026-10-21", 8)), "office: an extra day off is skipped");
    eq(nextAllowed(syd("2026-10-05", 10), { mode: "office" }, tz, { hours: { nsw: true } }), syd("2026-10-05", 10), "office: the old NSW switch with no stored list = no holidays (the SQL stores the list first)");
    eq(nextAllowed(syd("2026-10-05", 10), { mode: "office" }, tz, { ...CATALOG, hours: { ...CATALOG.hours, holidayOff: ["labour day"] } }), syd("2026-10-05", 10), "office: a public holiday switched off is a work day");
    eq(nextAllowed(syd("2026-10-05", 10), { mode: "office" }, tz, { ...CATALOG, region: { country: "US", state: "TX" } }), syd("2026-10-05", 10), "office: a list stored for another region is not used"); 
    eq(inWindow(syd("2026-10-14", 7), { mode: "outsideOffice" }, tz, CATALOG), true, "outside office: 07:00 on a work day");
    eq(isoMs(nextAllowed(syd("2026-10-14", 10), { mode: "outsideOffice" }, tz, CATALOG) as number), isoMs(syd("2026-10-14", 17)), "outside office: 10:00 → 17:00 the same day");
    eq(inWindow(syd("2026-10-14", 10), { mode: "office" }, tz, { hours: { days: { 3: { on: true, from: "11:00", to: "15:00" } } } }), false, "office: a day's own hours from settings");
  }

  // ── 3. validation ──
  {
    const good = auto();
    eq(validateAutomation(good), [], "a valid automation has no problems");
    const bad = (o: any) => validateAutomation({ ...good, ...o });
    ok(bad({ trigger: { type: "rain" } })[0].includes("unknown trigger"), "unknown trigger");
    ok(bad({ steps: [{ id: "x", kind: "dance" }, good.steps[0]] }).some((p) => p.includes("unknown kind")), "unknown step kind");
    ok(bad({ steps: [{ id: "x", kind: "action", type: "fax" }] }).some((p) => p.includes("unknown action")), "unknown action type");
    ok(bad({ steps: [{ id: "i", kind: "if", match: "all", conds: [{ field: "moon", op: "is", v: "full" }] }, good.steps[0]] }).some((p) => p.includes("unknown condition")), "unknown condition field");
    ok(bad({ steps: [{ id: "i", kind: "if", match: "all", conds: [{ field: "service", op: "sounds_like", v: "x" }] }, good.steps[0]] }).some((p) => p.includes("unknown comparison")), "unknown op");
    ok(bad({ steps: [{ id: "i", kind: "if", match: "all", conds: [{ field: "unpaid", op: "true" }] }, good.steps[0]] }).some((p) => p.includes("does not apply")), "a condition that doesn't fit the trigger");
    ok(bad({ steps: [good.steps[0], { ...good.steps[0] }] }).some((p) => p.includes("used twice")), "duplicate step id");
    ok(bad({ steps: [{ id: "w", kind: "window", days: [1], from: "9:00", until: "17:00", outside: "next" }, good.steps[0]] }).some((p) => p.includes("hours are not valid")), "bad HH:MM");
    ok(bad({ steps: [{ id: "w", kind: "window", days: [], from: "09:00", until: "17:00", outside: "next" }, good.steps[0]] }).some((p) => p.includes("no allowed day")), "a window with no allowed day");
    ok(bad({ steps: [{ id: "w", kind: "wait", unit: "minutes", n: 2000 }, good.steps[0]] }).some((p) => p.includes("wait minutes")), "wait out of range");
    ok(bad({ steps: Array.from({ length: 31 }, (_, k) => ({ ...good.steps[0], id: "p" + k })) }).some((p) => p.includes("more than 30")), "more than 30 steps");
    ok(bad({ steps: [{ id: "w", kind: "wait", unit: "minutes", n: 5 }] }).includes("no action"), "an automation without an action");
    ok(bad({ steps: [{ id: "p", kind: "action", type: "push", to: {}, title: "x" }] }).some((p) => p.includes("person or role")), "a notification without recipients");
    ok(bad({ steps: [emailStep({ subject: "" })] }).some((p) => p.includes("subject")), "an email without a subject");
    ok(bad({ steps: [{ id: "t", kind: "action", type: "text", body: "x".repeat(641) }] }).some((p) => p.includes("longer than 640")), "a text that is too long");
    ok(bad({ trigger: { type: "jobClosed", params: { maxJobAgeDays: 40 } } }).some((p) => p.includes("1 to 30")), "job age out of range");
    eq([audienceOf(good), audienceOf({ steps: [emailStep()] }), audienceOf({ steps: [{ kind: "action", type: "text" }] })], ["team", "customer", "customer"], "audience from the steps");
  }

  // ── 4. conditions (on fresh facts) ──
  {
    const db = world({ jobs: [{ id: "j-na", contact_id: "c2", review_do_not_ask: true, date: "2026-10-01" }],
      review_requests: [{ id: "r1", phone: "+61412345678", email: null, status: "sent", created_at: isoMs(NOW - 45 * DAYMS) }],
      lead_messages: [{ id: "m1", contact_id: "cc", direction: "out", auto: false, status: "failed", at: isoMs(NOW - 5 * MIN) }],
      calls: [{ id: "k1", direction: "outbound", to_number: "+61499000111", created_at: isoMs(NOW - 4 * MIN), duration: 35, status: "completed" }] });
    const F = (o: any = {}): any => ({ kind: "contact", type: "newLead", contact: lead("c1"), job: null, call: null, chat: null, ctx: {}, eventAt: isoMs(NOW - 2 * MIN), S: normSettings({}), cat: CATALOG, company: "Acme", nowMs: NOW, ...o });
    const C = async (f: any, conds: any[], match: any = "all") => (await evalConds(db, f, conds, match)).ok;
    eq([await C(F(), [{ field: "service", op: "is", v: "aircon" }]), await C(F(), [{ field: "service", op: "is_not", v: "Aircon" }]), await C(F(), [{ field: "service", op: "in", v: ["s9q", "Aircon"] }])], [true, false, true], "service is / is_not / in (case-insensitive)");
    eq(await C(F({ contact: lead("c1", { division: "s9q" }) }), [{ field: "service", op: "is", v: "s9q" }]), true, "a custom service key works");
    eq(await C(F({ contact: lead("c1", { division: "Gutter cleaning" }) }), [{ field: "service", op: "is", v: "s9q" }]), true, "a record holding the label matches the key");
    eq([await C(F(), [{ field: "source", op: "is", v: "Google Ads" }]), await C(F(), [{ field: "source", op: "not_in", v: ["Referral"] }])], [true, true], "source");
    eq([await C(F({ contact: lead("c1", { tags: ["VIP"] }) }), [{ field: "tag", op: "has", v: "vip" }]), await C(F(), [{ field: "tag", op: "has_not", v: "VIP" }])], [true, true], "tag has / has_not");
    eq([await C(F({ contact: lead("c1", { status: "Quoted", linked_job_id: "j1" }) }), [{ field: "stage", op: "is", v: "Won" }]), await C(F({ contact: lead("c1", { status: "sxy1" }) }), [{ field: "stage", op: "is", v: "sxy1" }])], [true, true], "stage: a linked job reads as Won; custom stage keys");
    const sf = F({ type: "stage", ctx: { stage: "Quoted" }, contact: lead("c1", { status: "Booked" }) });
    eq([await C(sf, [{ field: "stage_unchanged", op: "true" }]), await C({ ...sf, contact: lead("c1", { status: "Quoted" }) }, [{ field: "stage_unchanged", op: "true" }])], [false, true], "stage_unchanged: false after a move");
    eq([await C(F(), [{ field: "has_email", op: "true" }]), await C(F({ contact: lead("c1", { email: "nope" }) }), [{ field: "has_email", op: "true" }]), await C(F(), [{ field: "has_mobile", op: "true" }]), await C(F({ contact: lead("c1", { phone: "02 9999 0000" }) }), [{ field: "has_mobile", op: "true" }])], [true, false, true, false], "has_email / has_mobile");
    eq([await C(F({ contact: lead("c2") }), [{ field: "dont_ask", op: "true" }]), await C(F(), [{ field: "dont_ask", op: "true" }])], [false, true], "dont_ask: a job of this customer marked don't ask");
    eq([await C(F(), [{ field: "asked_within_months", op: "true", n: 6 }]), await C(F(), [{ field: "asked_within_months", op: "true", n: 1 }]), await C(F({ contact: lead("c1", { phone: "0400 000 000", email: "" }) }), [{ field: "asked_within_months", op: "true", n: 6 }])], [false, true, true], "asked_within_months: asked 45 days ago by the same phone (6 months: asked; 1 month: not)");
    eq([await C(F(), [{ field: "not_picked", op: "true" }]), await C(F({ contact: lead("c1", { status: "Chasing" }) }), [{ field: "not_picked", op: "true" }]), await C(F({ contact: lead("c1", { contacted_at: isoMs(NOW - MIN) }) }), [{ field: "not_picked", op: "true" }]), await C(F({ contact: lead("c1", { last_read_at: isoMs(NOW - MIN) }) }), [{ field: "not_picked", op: "true" }]), await C(F({ contact: lead("c1", { contacted_at: isoMs(NOW - 10 * MIN) }) }), [{ field: "not_picked", op: "true" }])], [true, false, false, false, true], "not_picked: status, contacted_at, last_read_at after the arrival");
    eq([await C(F({ type: "jobClosed", kind: "job", job: { payment_status: "Unpaid" } }), [{ field: "unpaid", op: "true" }]), await C(F({ type: "jobClosed", kind: "job", job: { payment_status: "Paid" } }), [{ field: "unpaid", op: "true" }])], [true, false], "unpaid");
    const chat = (o: any = {}) => F({ type: "chat", kind: "chat", contact: null, chat: { id: "s1", contact_id: "cc", phone: "+61499000222", created_at: isoMs(NOW - 6 * MIN), ...o } });
    eq(await C(chat(), [{ field: "chat_unanswered", op: "true" }]), true, "chat_unanswered: a failed reply doesn't count");
    db.T.lead_messages.push({ id: "m2", contact_id: "cc", direction: "out", auto: false, status: "sent", at: isoMs(NOW - 3 * MIN) });
    eq(await C(chat(), [{ field: "chat_unanswered", op: "true" }]), false, "chat_unanswered: an office reply answers it");
    eq(await C(chat({ contact_id: null, phone: "+61499000111" }), [{ field: "chat_unanswered", op: "true" }]), false, "chat_unanswered: a connected call answers it");
    db.T.lead_messages.push({ id: "m3", contact_id: "cz", direction: "out", auto: true, status: "sent", at: isoMs(NOW - 3 * MIN) });
    eq(await C(chat({ contact_id: "cz", phone: "+61499000333" }), [{ field: "chat_unanswered", op: "true" }]), true, "chat_unanswered: an automatic message is not an answer");
    eq([await C(chat(), [{ field: "chat_age_hours", op: "lte", n: 1 }]), await C(chat(), [{ field: "chat_age_hours", op: "gte", n: 1 }])], [true, false], "chat_age_hours");
    const both = [{ field: "source", op: "is", v: "Referral" }, { field: "service", op: "is", v: "Aircon" }];
    eq([await C(F(), both, "all"), await C(F(), both, "any")], [false, true], "match all vs any");
  }

  // ── 5. scans ──
  {
    const S = normSettings({});
    const db = world({
      contacts: [
        lead("n1"), lead("t1", { tags: ["Test"] }),
        lead("old", { created_at: "2026-09-01", messages: [{ at: "2026-09-01T01:00:00.000Z" }], reopened_at: isoMs(NOW - 10 * MIN) }),
        lead("st1", { status: "sxy1", stage_changed_at: isoMs(NOW - 5 * MIN) }), lead("st2", { status: "Quoted", stage_changed_at: isoMs(NOW - 6 * MIN) }),
      ],
      jobs: [{ id: "j1", date: "2026-10-13", created_at: isoMs(NOW - 10 * MIN), contact_id: "n1" }, { id: "j2", date: "2026-10-13", created_at: null }, { id: "j3", date: "2026-09-20", created_at: isoMs(NOW - 10 * MIN) }],
      calls: [{ id: "k1", missed: true, started_at: isoMs(NOW - 3 * MIN), contact_id: "n1" }, { id: "k2", missed: false, started_at: isoMs(NOW - 3 * MIN) }],
      chat_sessions: [{ id: "s1", created_at: isoMs(NOW - 4 * MIN), test: false, contact_id: "n1" }, { id: "s2", created_at: isoMs(NOW - 4 * MIN), test: true }],
    });
    const since = NOW - 6 * HR;
    const nl = await TRIGGERS.newLead.scan(db, since, NOW, S);
    eq(nl.map((e: any) => e.key).sort(), ["n1:new", `old:${isoMs(NOW - 10 * MIN)}`, "st1:new", "st2:new"], "newLead: first message or reopened (an old lead reopened counts); test leads ignored");
    eq(nl.find((e: any) => e.recordId === "old").at, isoMs(NOW - 10 * MIN), "newLead: a reopened lead arrives when reopened");
    const st = await TRIGGERS.stage.scan(db, since, NOW, S);
    eq(st.map((e: any) => [e.recordId, e.ctx.stage]), [["st1", "sxy1"], ["st2", "Quoted"]], "stage: every stage move in the window, with its stage");
    eq([TRIGGERS.stage.match({ stage: "sxy1" }, st[0], NOW, "Australia/Sydney"), TRIGGERS.stage.match({ stage: "sxy1" }, st[1], NOW, "Australia/Sydney"), TRIGGERS.stage.match({}, st[1], NOW, "Australia/Sydney")], [true, false, true], "stage: params.stage matches only that key (a custom key works)");
    const jc = await TRIGGERS.jobClosed.scan(db, since, NOW, S);
    eq(jc.map((e: any) => e.recordId), ["j1", "j3"], "jobClosed: jobs without created_at never count");
    eq(jc.map((e: any) => TRIGGERS.jobClosed.match({}, e, NOW, "Australia/Sydney")), [true, false], "jobClosed: a job done more than 7 days ago doesn't match");
    eq(TRIGGERS.jobClosed.match({ maxJobAgeDays: 30 }, jc[1], NOW, "Australia/Sydney"), true, "jobClosed: the age is a setting of the automation");
    eq((await TRIGGERS.missedCall.scan(db, since, NOW, S)).map((e: any) => e.key), ["k1"], "missedCall: missed calls only");
    eq((await TRIGGERS.chat.scan(db, since, NOW, S)).map((e: any) => e.key), ["s1"], "chat: test chats ignored");
    eq((await TRIGGERS.newLead.scan(db, since, NOW, normSettings({ ignore_test_records: false }))).some((e: any) => e.recordId === "t1"), true, "test leads count when the business says so");
  }

  // ── 6.–26. the phase-4 suite, run by phase 4's advance and again through upgradeV1 + advanceV2 (design §8.1 #13) ──
  let v2Calls = 0, v1Calls = 0;
  for (const v2 of [false, true]) {
    io.advance = v2 ? (async (...x: [any, any, any, number]) => { v2Calls++; return await advanceV2(...x); }) : (async (...x: [any, any, any, number]) => { v1Calls++; return await advance(...x); });
    TAG = v2 ? " [v2]" : ""; CLAIM_RPC = v2 ? "automation_claim_customer_v2" : "automation_claim_customer";
    await phase4Suite();
  }
  io.advance = PROD_ADVANCE; TAG = ""; CLAIM_RPC = "automation_claim_customer";
  ok(v1Calls > 100 && v2Calls === v1Calls, "the phase-4 suite ran every run through both executors", { v1Calls, v2Calls });

  // ── 27. the region (Settings → Region and format, T1.2/T1.3): one time zone, money, the copied block ──
  {
    let db = world({ automation_settings: [{ business_id: "default", timezone: "Australia/Sydney" }], settings: [{ id: 1, company_name: "Acme", catalog: { ...CATALOG, region: { timeZone: "America/Chicago" } } }] });
    eq((await loadContext(db)).S.timezone, "America/Chicago", "region: the business's time zone wins over automation_settings");
    db = world({ automation_settings: [{ business_id: "default", timezone: "Australia/Perth" }] });
    eq((await loadContext(db)).S.timezone, "Australia/Perth", "region: with no region zone saved, the old automation_settings value stays");
    db = world();
    eq((await loadContext(db)).S.timezone, "Australia/Sydney", "region: nothing saved = Sydney");
    const fj = (amount: unknown, cat: any): any => ({ kind: "job", type: "jobClosed", contact: null, job: { id: "j1", amount, technician: "Guy" }, call: null, chat: null, ctx: {}, eventAt: isoMs(NOW), S: normSettings({}), cat, company: "Acme", nowMs: NOW });
    eq([mergeVars(fj(480, CATALOG), { name: "x", steps: [] }).amount, mergeVars(fj(1234.5, CATALOG), { name: "x", steps: [] }).amount], ["$480", "$1,234.5"], "{amount}: nothing saved = exactly as before");
    eq(mergeVars(fj(1234.5, { ...CATALOG, region: { currency: "EUR", moneyFormat: "1.234,56", symbolAfter: true } }), { name: "x", steps: [] }).amount, "1.234,5 €", "{amount}: the business's currency and format");
    for (const tz of ["Australia/Sydney", "America/Chicago"]) {
      const ms = Date.parse("2026-10-14T03:00:00Z"), z = zoneParts(ms, tz), b = bizParts(ms, tz);
      eq([b.day, b.dow, b.minutes, bizToUtc("2026-10-04", 9, 30, tz)], [z.day, z.dow, z.minutes, zoneToUtc("2026-10-04", 9, 30, tz)], `region block: bizParts / bizToUtc agree with the engine's own (${tz})`);
    }
    eq([taxNameOf({}), taxNameOf({ region: { country: "US" } }), bizTzOf({ region: { timeZone: "Mars/Base" } }), regionKeyOf({}), regionKeyOf({ country: "US", state: "TX" })], ["GST", "Sales tax", "Australia/Sydney", "AU-NSW", "US-TX"], "region block: the defaults and the place key");    // a settings read that fails ({ data: null, error }) stops the run: never "nothing saved" (no names, brands or days off)
    { const bad = world(), from0 = bad.from; let err = "";
      bad.from = (t: string) => t === "settings" ? { select: () => ({ limit: async () => ({ data: null, error: { message: "timeout" } }) }) } : from0(t);
      try { await loadContext(bad); } catch (e) { err = String((e as Error).message); }
      eq(err, "settings not read: timeout", "loadContext: a failed settings read stops the run (the next minute tries again)"); }
  }

  // ── 27b. the stored public holidays, worked out by the timer when no owner opens the app (T1.3) ──
  {
    const keepLib = io.holidayLib; let loads = 0;
    // a fake date-holidays: two holidays a year, one of them moved
    class FakeH { constructor(public c: string, public s: any) {} getHolidays(y: number) { return [{ date: `${y}-01-01 00:00:00`, name: "New Year's Day" }, { date: `${y}-12-28 00:00:00`, name: "Boxing Day (substitute day)" }]; } }
    io.holidayLib = async () => { loads++; return FakeH; };
    const at = Date.parse("2028-02-01T01:00:00Z");   // 1 Feb 2028 in Sydney: the seeded list (to 2028-12-31) has under a year left
    const seeded = { region: "AU-NSW", to: "2028-12-31", days: { "2028-01-26": "Australia Day" } };
    let db = world({ settings: [{ id: 1, company_name: "Acme", catalog: { ...CATALOG, hours: { nsw: true }, holidays: seeded } }] });
    const cat1: any = { ...CATALOG, hours: { nsw: true }, holidays: seeded };
    eq([await refreshHolidays(db, cat1, at), cat1.holidays.from, cat1.holidays.to, cat1.holidays.days["2030-12-28"], db.T.settings[0].catalog.holidays.region, db.T.settings[0].catalog.company_name ?? db.T.settings[0].company_name],
      ["coverage", "2028-01-01", "2030-12-31", "Boxing Day (additional day)", "AU-NSW", "Acme"], "under a year left: worked out for 3 years and saved (only the holidays key), AU wording");
    eq([await refreshHolidays(db, { ...cat1 }, at), loads], ["", 1], "fresh now: nothing to do");
    eq([await refreshHolidays(db, { hours: { publicOn: false }, holidays: seeded }, at), loads], ["off", 1], "the switch off: never loads the library");
    const cat2: any = { hours: { publicOn: true }, holidays: seeded, region: { country: "US", state: "TX" } };
    eq([await refreshHolidays(db, cat2, at), cat2.holidays.region, loads], ["region", "US-TX", 2], "another region: worked out for it");
    io.holidayLib = async () => { loads++; throw new Error("offline"); };
    const cat3: any = { hours: { publicOn: true }, region: { country: "NZ" } }; let e3 = "";
    try { await refreshHolidays(db, cat3, at); } catch (e) { e3 = String((e as Error).message); }
    eq([e3, await refreshHolidays(db, cat3, at), loads], ["offline", "tried", 3], "a failure is not retried every minute (once a day per region)");
    io.holidayLib = keepLib;
    eq([holidaysStale({}, "2026-10-14"), holidaysStale({ holidays: seeded, region: { country: "US" } }, "2026-10-14"), holidaysStale({ holidays: seeded }, "2026-10-14"), holidaysStale({ holidays: seeded }, "2028-01-05")],
      ["missing", "region", "", "coverage"], "holidaysStale: the app's rules");
  }

  // ── the business's names (round 3, T1.7/T1.9): the office's board, {agent}, the brand fallback ──
  {
    eq([boardFor(["Ron"], [{ role: "va", full_name: "Ron Cruz" }]), boardFor(["Kim"], [], [{ name: "Kim", roles: ["VA"] }]), boardFor(["Guy"], []), boardFor([], []), boardFor(["Ron"], [])],
      ["ron", "ron", "Guy", "ron", "Ron"], "boardFor: a VA login (first word too) or a VA employee = the office's board; no built-in name");
    const fa = (o: any = {}): any => ({ kind: "contact", type: "newLead", contact: lead("c1", { division: "Gutters" }), job: null, call: null, chat: null, ctx: {}, eventAt: isoMs(NOW), S: normSettings({}), cat: CATALOG, company: "Acme Home Services", nowMs: NOW, ...o });
    eq([mergeVars(fa({ agent: "Kim" }), { name: "x", steps: [] }).agent, mergeVars(fa(), { name: "x", steps: [] }).agent, mergeVars(fa({ cat: { ...CATALOG, labels: { office: "Dispatch" } } }), { name: "x", steps: [] }).agent], ["Kim", "Office", "Dispatch"], "{agent}: the run's office person, else the office's name");
    eq([mergeVars(fa(), { name: "x", steps: [] }).brand, mergeVars(fa({ cat: { ...CATALOG, business: { shortName: "Acme Group" } } }), { name: "x", steps: [] }).brand], ["Acme Home Services", "Acme Home Services"], "{brand} of a service with none: the business name, even with a short name saved (as before 14 Oct)");
    const db = world({ profiles: [OWNER, { ...VA, full_name: "Adam Va" }, { ...VA, id: "u-va2", full_name: "Kim Va", on_duty: true, on_duty_date: "2026-10-14" }] });
    eq([(await loadContext(db, Date.parse("2026-10-14T01:00:00Z"))).agent, (await loadContext(db, Date.parse("2026-10-15T01:00:00Z"))).agent, (await loadContext(world({ profiles: [OWNER] }))).agent], ["Kim", "Adam", "Office"], "loadContext: {agent} = the VA on shift today, else A–Z, else the office's name");
    const code = src("index.ts").split("\n").filter((l: string) => !/^\s*\/\//.test(l)).join("\n");
    eq(["Ron", "The Guys", "1300 380"].filter((w) => new RegExp("\\b" + w + "\\b").test(code)), [], "no 'Ron', 'The Guys' or '1300 380' in the engine's code");
  }

  // ══ stage 2 (G1.1): doc schema 2, registries, validator, upgradeV1, shape / arm keys, compile, conditions, patches ══
  {
    const fx = (name: string) => JSON.parse(src(`fixtures/${name}`));
    const AV_ALL: any = { phone: true, xero: true, gbp: true, reviews: true, ai: true, teamEmail: true, atomicTags: true };
    const AV_OFF: any = { phone: false, xero: false, gbp: false, reviews: false, ai: false, teamEmail: false, atomicTags: false };
    const C = (x: any) => canonJson(x);

    // ── workflows.json: every case gives exactly its codes; the JSON Schema accepts / rejects as stated ──
    const W = fx("workflows.json").cases;
    ok(W.length >= 60, "workflows.json has at least 60 cases", W.length);
    const seenCodes = new Set<string>();
    for (const k of W) {
      const r = validateDoc(k.doc, { builder: k.builder, avail: k.avail, catalog: k.catalog, stored: k.stored, maxSteps: k.maxSteps });
      eq([issueCodes(r.errors), issueCodes(r.warnings)], [k.errors, k.warnings], `workflows.json: ${k.name}`);
      for (const c of [...k.errors, ...k.warnings]) seenCodes.add(c);
      const docAndSettings = { definition: k.doc, ...(k.settings ? { settings: k.settings } : {}) };
      if (!k.errors.length) eq(schemaCheck(jsonSchema(k.avail, {}, { mode: "accept", builder: k.builder, stored: k.stored }), docAndSettings), [], `schema (accept) takes the valid case: ${k.name}`);
      if (k.schema !== undefined) {
        const errs = schemaCheck(jsonSchema(k.avail, {}, { mode: k.schemaMode || "generate", builder: k.builder, stored: k.stored }), docAndSettings);
        ok((errs.length === 0) === k.schema, `schema ${k.schema ? "accepts" : "rejects"}: ${k.name}`, errs.slice(0, 3));
      }
      // every issue carries the contract shape
      for (const i of [...r.errors, ...r.warnings]) if (!(typeof i.code === "string" && (i.severity === "error" || i.severity === "warning") && typeof i.path === "string" && typeof i.text === "string" && i.text)) { ok(false, `issue shape: ${k.name}`, i); break; }
    }
    // a valid case the generation schema refuses is only a legacy-only or system-only construct (never generated by design)
    eq(W.filter((k: any) => !k.errors.length && k.schema === false && !k.name.includes("legacy") && !k.warnings.includes("W_HIDDEN_TYPE")).map((k: any) => k.name), [], "every valid case is accepted by its generation schema");
    ok(W.filter((k: any) => k.schema === false).length >= 25 && W.filter((k: any) => !k.errors.length).length >= 25, "workflows.json: enough valid and schema-rejected cases");
    // E_TOO_BIG needs a 256 KB doc (built here, not stored in the fixture file)
    {
      const nodes: any = {}; for (let i = 1; i <= 60; i++) nodes[`n${i}`] = { kind: "action", type: "send_email", config: { subject: "S", body: "x".repeat(4990) }, out: { next: i < 60 ? `n${i + 1}` : null } };
      const big = { schema: 2, seq: 60, entry: "n1", triggers: [{ id: "t1", type: "newLead", filters: { match: "all", segments: [{ match: "all", rules: [] }] } }], nodes };
      eq(issueCodes(validateStructure(big)), ["E_TOO_BIG"], "E_TOO_BIG over 256 KB"); seenCodes.add("E_TOO_BIG");
    }
    const DESIGN_CODES = ["E_SCHEMA", "E_DUP_ID", "E_BAD_ID", "E_PORTS", "E_EDGE_TWO_PARENTS", "E_CYCLE", "E_ENTRY_NOT_HEAD", "E_GOTO_TARGET", "E_GOTO_NOT_LAST", "E_SPLIT_PCT",
      "E_MAX_NODES", "E_TOO_BIG", "E_UNKNOWN_TYPE", "E_DISABLED_BRANCHING", "E_LOCKED", "E_UNAVAILABLE", "E_ADVANCED_ONLY", "E_NO_TRIGGER", "E_NO_ACTION", "E_LOOP_NO_WAIT",
      "W_LOOP_CUSTOMER", "E_FIELD_NOT_FOR_ALL_TRIGGERS", "E_MERGE_FIELD", "W_MERGE_FIELD", "E_CUSTOMER_NO_CONTACT", "rule_value_missing", "rule_value_type", "E_TEMPLATE_MISSING",
      "E_WEBHOOK_URL", "E_SECRET_HEADER", "W_REPLY_NO_SEND", "W_DELINKED", "W_LAST_NOT_ACTION", "W_HIDDEN_TYPE", "W_GATE_MOVED", "W_SENDS_OUTSIDE", "W_MONEY_TO_NON_OWNER", "W_CUSTOMER_IN_CONTACTLESS"];
    eq(DESIGN_CODES.filter((c) => !seenCodes.has(c)), [], "every validator code of design §6.2 is produced by a fixture");
    // validateStructure never throws on junk
    let threw = "";
    for (const junk of [null, 1, "x", [], {}, { schema: 2, nodes: [], triggers: {} }, { schema: 2, seq: 0, entry: null, triggers: [null, 3], nodes: { a: null, b: { kind: "if_else", type: "if_else", config: { branches: "x" }, out: [] } } }])
      try {
        validateDoc(junk, { avail: AV_OFF }); compile(junk); defShape(junk); armKey(junk, null); upgradeV1(junk, junk); normWfSettings(junk);
        const r = wfApplyPatch(junk, [{ op: "addNode", node: { kind: "action", type: "add_task", config: { title: "x" } }, slot: { src: "b" } }, { op: "removeNode", id: "b", mode: "one" }]);
        if (!r || !Array.isArray(r.errors)) threw = "wfApplyPatch gave no result";
      } catch (e) { threw = String(e); }
    eq(threw, "", "the validators, compile, the keys, upgradeV1 and wfApplyPatch never throw on junk");

    // ── upgrade.json: every phase-4 shape → exactly the stated doc; ids kept; output valid; shape stable ──
    const U = fx("upgrade.json").cases;
    for (const k of U) {
      const before = C(k.v1), got = upgradeV1(k.v1.trigger, k.v1.steps);
      eq(C(got.doc), C(k.expect.doc), `upgradeV1 doc: ${k.name}`);
      eq([C(got.settings), C(got.idMap)], [C(k.expect.settings), C(k.expect.idMap)], `upgradeV1 settings + idMap: ${k.name}`);
      eq(C(k.v1), before, `upgradeV1 never changes its input: ${k.name}`);
      eq(defShape(upgradeV1(JSON.parse(JSON.stringify(k.v1.trigger)), JSON.parse(JSON.stringify(k.v1.steps))).doc), defShape(got.doc), `defShape(upgradeV1(x)) is stable: ${k.name}`);
      eq(defShape(JSON.parse(C(got.doc))), defShape(got.doc), `defShape survives a key re-sort: ${k.name}`);
      if (!k.name.includes("unknown")) eq(validateStructure(got.doc).map((i: any) => i.code), [], `upgradeV1 output has a valid structure: ${k.name}`);
      // ids of the v1 steps that were valid stay the node ids (in-flight runs point at steps[step_index].id)
      const kept = k.v1.steps.map((s: any) => got.idMap[s.id] || s.id).filter((id: string, i: number, a: string[]) => a.indexOf(id) === i);
      if (!k.name.includes("twice")) ok(kept.every((id: string) => id in got.doc.nodes), `every v1 step is a node: ${k.name}`);
    }
    ok(U.some((k: any) => k.name.includes("12 ifs")) && ["next", "at", "end"].every((o) => U.some((k: any) => C(k.expect.doc).includes(`"outside":"${o}"`)))
      && ["office", "outsideOffice", "custom"].every((m) => U.some((k: any) => C(k.expect.doc).includes(`"use":"${m}"`)))
      && ["internal_notification", "add_task", "send_email", "send_sms"].every((t) => U.some((k: any) => C(k.expect.doc).includes(`"type":"${t}"`))), "upgrade.json covers every phase-4 shape");
    {
      // the 12 ifs are a flat chain (no nesting depth) that validates, and their gate None ends the run
      const k = U.find((x: any) => x.name.includes("12 ifs")), d = upgradeV1(k.v1.trigger, k.v1.steps).doc;
      eq([Object.keys(d.nodes).length, validateDoc(d, { avail: AV_OFF }).errors.length, d.nodes.s12.out.s12_yes, d.nodes.s12.out.none], [13, 0, "s13", null], "12 ifs in a row migrate and validate");
    }

    // ── shape.json: defShape / armKey ──
    const SH = fx("shape.json").cases;
    ok(SH.length >= 14, "shape.json has at least 14 cases", SH.length);
    for (const k of SH) eq([defShape(k.a.doc) === defShape(k.b.doc), armKey(k.a.doc, k.a.settings) === armKey(k.b.doc, k.b.settings)], [k.sameShape, k.sameArm], `shape/arm: ${k.name}`);

    // ── patch.json: wfApplyPatch ──
    const P = fx("patch.json").cases;
    ok(P.length >= 20, "patch.json has at least 20 cases", P.length);
    for (const k of P) {
      const before = C(k.doc), r = wfApplyPatch(k.doc, k.ops, {});
      eq(C(k.doc), before, `wfApplyPatch never changes its input: ${k.name}`);
      if (k.errors) eq([r.errors.map((e: any) => e.code), C(r.doc), r.errors.every((e: any) => e.opIndex === (k.errorOpIndex ?? 0) && e.path.startsWith(`/${e.opIndex}`))], [k.errors, before, true], `wfApplyPatch refuses: ${k.name}`);
      else {
        eq([r.errors, C(r.doc), C(r.idMap)], [[], C(k.result), C(k.idMap)], `wfApplyPatch: ${k.name}`);
        if (k.settings || k.newName) eq([C(r.settings), r.name], [C(k.settings), k.newName], `wfApplyPatch settings + name: ${k.name}`);
        eq(validateStructure(r.doc).filter((i: any) => i.code !== "E_GOTO_TARGET").map((i: any) => i.code), [], `wfApplyPatch result keeps a valid structure: ${k.name}`);
      }
    }
    // ── the registry snapshot the app's tests read (design §5.3, B27): tests/fixtures/wf-registry.json = the export (step
    // "registry") for every business context workflows.json uses, so the app's wfValidate runs the same cases on the
    // engine's own registry. A stale file is written again and this run fails once (run the checks again). ──
    {
      const ctxs: any[] = [AV_ALL, AV_OFF, ...W.map((k: any) => k.avail)].filter((x, i, a) => a.findIndex((y) => C(y) === C(x)) === i);
      const availOf = (e: any) => e.availability;
      const byAvail: Record<string, any> = {};
      for (const ctx of ctxs) {
        const ex = registryExport(ctx), av: Record<string, any> = {};
        for (const t of ex.triggers) av[`t:${t.key}`] = availOf(t);
        for (const list of ["actions", "waits", "goals", "logic"]) for (const n of (ex as any)[list]) av[`n:${n.kind}/${n.key}`] = availOf(n);
        for (const f of ex.fields) av[`f:${f.key}`] = availOf(f);
        for (const m of ex.merge) av[`m:${m.key}`] = availOf(m);
        byAvail[C(ctx)] = { availCtx: ctx, availability: av };
      }
      const snap = JSON.stringify({ about: "Written by supabase/functions/automations/tests.ts (do not edit): the engine's registry export (step \"registry\") for AV_ALL, and per business context the availability of every entry. The app's tests rebuild the export of a context from these.",
        availReasons: AVAIL_REASONS, provides: Object.fromEntries(Object.values(WF_TRIGGERS).map((t) => [t.key, t.provides])), waitMax: WF_WAIT_MAX, holdingWaits: WF_HOLDING_WAITS, limits: WF_LIMITS, settingsDefaults: WF_SETTINGS_DEFAULTS, migratedSettings: WF_MIGRATED_SETTINGS,
        base: registryExport(AV_ALL), byAvail }, null, 1) + "\n";
      const SNAP = "../../../tests/fixtures/wf-registry.json";
      let old = ""; try { old = src(SNAP); } catch { /* not written yet */ }
      if (old !== snap) { fs.mkdirSync("../../../tests/fixtures", { recursive: true }); fs.writeFileSync(SNAP, snap); }
      ok(old === snap, "tests/fixtures/wf-registry.json is the engine's registry (it was stale: written again, run the checks again)");
    }
    // ── registries: GHL words from the account scan; every entry complete; greyed = with a reason ──
    const GH = fx("ghl-labels.json");
    for (const [k, v] of Object.entries(GH.triggers)) eq(triggerEntry(k)?.ghl, v, `GHL label (trigger) ${k}`);
    for (const [k, v] of Object.entries(GH.actions)) eq(WF_ACTIONS[k]?.ghl, v, `GHL label (action) ${k}`);
    for (const [k, v] of Object.entries(GH.logic)) eq(WF_LOGIC[k]?.ghl, v, `GHL label (logic) ${k}`);
    for (const [k, v] of Object.entries(GH.waits)) eq(WF_WAITS[k]?.ghl, v, `GHL label (wait card) ${k}`);
    eq([...Object.values(WF_TRIGGERS), ...Object.values(WF_ACTIONS)].filter((e) => e.ghl && !(e.key in GH.triggers) && !(e.key in GH.actions)).map((e) => e.key), [], "every GHL-named trigger and action is in the scan fixture");
    const entries = [...Object.values(WF_TRIGGERS), ...Object.values(WF_ACTIONS), ...Object.values(WF_WAITS), ...Object.values(WF_GOALS), ...Object.values(WF_LOGIC)];
    const bad: string[] = [];
    for (const e of entries) {
      if (!("ghl" in e) || !e.label || !e.description || !e.category || !e.icon || !e.fields || typeof e.available !== "function") bad.push(`${e.key}: incomplete`);
      for (const ctx of [AV_OFF, AV_ALL]) { const a = e.available(ctx); if (!a.ok && !a.reason) bad.push(`${e.key}: greyed without a reason`); }
      if (!(e.fields.type === "object" || Array.isArray(e.fields.oneOf))) bad.push(`${e.key}: fields is not a schema`);
    }
    for (const t of Object.values(WF_TRIGGERS)) for (const f of t.filters) if (!WF_FIELDS[f]) bad.push(`${t.key}: unknown filter field ${f}`);
    for (const f of Object.values(WF_FIELDS)) { if (!f.ops.every((o) => WF_OPS[o])) bad.push(`${f.key}: unknown op`); if (!WF_VALUE_TYPES.includes(f.valueType)) bad.push(`${f.key}: value type`); }
    const aliasList = entries.flatMap((e) => e.aliases || []);
    if (new Set(aliasList).size !== aliasList.length || aliasList.some((a) => WF_TRIGGERS[a] || WF_ACTIONS[a])) bad.push("aliases collide");
    eq(bad, [], "registry entries are complete, greyed ones say why, aliases never collide");
    eq(Object.values(WF_ACTIONS).filter((a) => !a.available(AV_OFF).ok).map((a) => [a.key, a.available(AV_OFF).reason]).filter(([k]) => ["send_sms", "assign_user", "send_invoice", "math", "ai_agent", "add_tag"].includes(k as string)),
      [["add_tag", "Coming with the new lead card"], ["send_sms", "Needs the phone line (Twilio)"], ["send_invoice", "Needs Xero"], ["math", "Coming later"], ["ai_agent", "Coming later"]], "greyed reasons are the design's words");
    // Q6 (G3.5): the lead's "Assigned to" exists, so nothing about it is greyed, whatever the business has
    eq([WF_ACTIONS.assign_user.available(AV_OFF).ok, WF_ACTIONS.remove_assigned_user.available(AV_OFF).ok, !WF_FIELDS["lead.assigned_user"].available,
      !!WF_MERGE["lead.assigned_to"] && !WF_MERGE["lead.assigned_to"].available && !WF_MERGE["lead.assigned_to_first_name"].available, !!WF_MERGE.assigned_user,
      /"x-greyed":\{[^}]*"assigned"/.test(JSON.stringify(WF_WAITS.user_reply.fields)), Object.keys(AVAIL_REASONS).includes("assignee")],
      [true, true, true, true, false, false, false], "Q6: Assign to user, Remove assigned user, the Assigned to filter, {lead.assigned_to} and 'the assigned user' reply wait are never greyed");
    // Q5 (G3.5): no Quote status trigger at all (removed, not greyed); "quote sent" = Pipeline stage changed to Quoted
    eq([!!WF_TRIGGERS.estimates, Object.values(WF_FIELDS).some((f) => (f.triggers || []).includes("estimates") || f.wakeOn.includes("estimates")), WF_FIELDS["lead.quote_amount"].wakeOn, !!WF_MERGE.quote_amount,
      WF_TEMPLATE_SEEDS.some((t) => t.key === "lead_quote_follow_up" && JSON.stringify(t.definition.triggers).includes('"type":"stage"') && JSON.stringify(t.definition.triggers).includes('"Quoted"'))],
      [false, false, ["contact_changed"], true, true], "Q5: the Quote status trigger is gone; the quote amount stays a field and a blank; the Quote follow-up template starts on the move to Quoted");
    eq([wfAliasOf("trigger", "missedCall"), wfAliasOf("trigger", "googleReview"), wfAliasOf("trigger", "docExpiry"), wfAliasOf("trigger", "bizInsurance"), wfAliasOf("trigger", "newLead"), wfAliasOf("trigger", "invoice"),
      wfAliasOf("action", "push"), wfAliasOf("action", "task"), wfAliasOf("action", "email"), wfAliasOf("action", "text"), wfAliasOf("action", "assign_owner")],
      ["call_details", "review_received", "doc_expiring", "insurance_expiring", "newLead", "invoice", "internal_notification", "add_task", "send_email", "send_sms", "assign_user"], "v1 and mirror keys map to the stored keys");
    eq(WF_ALWAYS_REENTER.filter((k) => !WF_TRIGGERS[k].alwaysReenter), [], "alwaysReenter is set on the GHL appointment / invoice style triggers");
    eq(WF_GUARDED_TYPES, ["send_email", "send_sms", "send_review_request", "send_live_chat", "send_invoice", "send_estimate", "webhook"], "guarded types = customer messages + the outgoing webhook");
    eq(["newLead", "stage", "jobClosed", "chat"].every((k) => !!WF_TRIGGERS[k]) && !WF_TRIGGERS.missedCall, true, "phase-4 trigger keys stay stored keys (missedCall is the alias of call_details)");
    eq(Object.keys(CONDITIONS).filter((k) => !WF_FIELDS[k] || !CONDITIONS[k].ops.every((o) => WF_FIELDS[k].ops.includes(o))), [], "every phase-4 condition is a field with (at least) its phase-4 ops");
    eq(Object.keys(MERGE_FIELDS).filter((k) => !WF_MERGE[k]), [], "every phase-4 blank is a merge field");
    eq(availCtxOf({ phone_enabled: true, review_requests_auto: true }, { connectors: { xero: { connected: true } }, features: { leadAssignee: true } }),
      { phone: true, xero: true, gbp: false, reviews: true, ai: false, teamEmail: false, atomicTags: true }, "availCtxOf reads the settings row and the catalog (atomic tag / note edits: on since G2.3; no assignee switch since G3.5)");

    // narration templates only name config fields their entry has
    eq(entries.flatMap((e) => [...e.narration.matchAll(/\{([a-zA-Z_]+)\}/g)].map((m) => m[1]).filter((k) => !(k in obj(e.fields.properties)) && !(e.fields.oneOf || []).some((b: any) => k in obj(b.properties))).map((k) => `${e.key}.${k}`)), [],
      "narration templates name real config fields");
    eq([WF_FIELDS.constructor, WF_TRIGGERS.toString, nodeEntry("action", "constructor"), triggerEntry("hasOwnProperty"), mergeKnown("constructor"), wfAliasOf("action", "constructor")], [undefined, undefined, null, null, false, "constructor"],
      "registries have no prototype keys");
    eq(issueCodes(validateDoc({ ...W[0].doc, triggers: [{ id: "t1", type: "stage", filters: { match: "all", segments: [{ match: "all", rules: [{ field: "constructor", op: "is", v: "x" }, { field: "stage", op: "valueOf" }] }] } }] }, { avail: AV_ALL }).errors), ["E_SCHEMA", "E_UNKNOWN_TYPE"], "a rule naming a JavaScript built-in is just unknown");

    // ── OPS × value types ──
    {
      const env = { nowMs: Date.parse("2026-10-14T03:00:00Z"), tz: "Australia/Sydney" };   // Wed 14 Oct, 14:00 Sydney
      const T: [string, string, unknown, any, boolean][] = [
        // valueType, op, value, rule, want
        ["text", "is", "Sam", { v: "sam" }, true], ["text", "is_not", "Sam", { v: "Kim" }, true], ["text", "contains", "Sam Smith", { v: "smi" }, true], ["text", "contains", "Sam", { v: "" }, false],
        ["text", "not_contains", "Sam Smith", { v: "kim" }, true], ["text", "contains_any", "Gutter clean", { v: ["roof", "gutter"] }, true], ["text", "contains_none", "Gutter clean", { v: ["roof", "gutter"] }, false],
        ["text", "starts_with", "0412 345", { v: "0412" }, true], ["text", "in", "b", { v: ["a", "b"] }, true], ["text", "not_in", "c", { v: ["a", "b"] }, true],
        ["text", "is_empty", "  ", {}, true], ["text", "is_not_empty", "x", {}, true], ["text", "is_empty", null, {}, true],
        ["enum", "is", "Quoted", { v: "Quoted" }, true], ["enum", "in", "New", { v: ["Quoted", "Booked"] }, false], ["enum", "is_not_empty", "", {}, false],
        ["enum", "is_not", "New", { v: "Quoted" }, true], ["enum", "not_in", "New", { v: ["New"] }, false], ["enum", "is_empty", null, {}, true], ["tags", "is_not_empty", ["a"], {}, true],
        ["number", "is_not_empty", 0, {}, true], ["date", "is_empty", "", {}, true], ["date", "is_not_empty", "2026-10-14", {}, true],
        ["tags", "has", ["VIP", "x"], { v: "vip" }, true], ["tags", "has_not", ["x"], { v: "VIP" }, true], ["tags", "has_any", ["a"], { v: ["a", "b"] }, true], ["tags", "has_none", ["c"], { v: ["a", "b"] }, true],
        ["tags", "is_empty", [], {}, true], ["tags", "has_any", null, { v: ["a"] }, false],
        ["number", "eq", 5, { n: 5 }, true], ["number", "neq", 5, { n: 6 }, true], ["number", "gt", "7", { n: 5 }, true], ["number", "lt", 4, { n: 5 }, true], ["number", "gte", 5, { n: 5 }, true], ["number", "lte", 6, { n: 5 }, false],
        ["number", "between", 50, { n: 100, v2: 10 }, true], ["number", "between", 101, { n: 10, v2: 100 }, false], ["number", "eq", "", { n: 0 }, false], ["number", "gt", null, { n: -1 }, false], ["number", "is_empty", null, {}, true],
        ["money", "gte", 250.5, { n: 250 }, true], ["money", "between", "300", { n: 200, v2: 400 }, true],
        ["date", "before", "2026-10-13", { v: "2026-10-14" }, true], ["date", "after", "2026-10-14T22:00:00Z", { v: "2026-10-14" }, true], ["date", "on", "2026-10-14T13:30:00Z", { v: "2026-10-15" }, true],
        ["date", "within_last", "2026-10-08", { n: 7, unit: "days" }, true], ["date", "within_last", "2026-10-06", { n: 7, unit: "days" }, false], ["date", "within_next", "2026-10-20", { n: 1, unit: "weeks" }, true],
        ["date", "more_than_ago", "2026-08-13", { n: 2, unit: "months" }, true], ["date", "more_than_ago", "2026-08-14", { n: 2, unit: "months" }, false], ["date", "within_last", "2026-10-14T02:30:00Z", { n: 1, unit: "hours" }, true],
        ["date", "within_next", "2026-10-14T05:30:00Z", { n: 2, unit: "hours" }, false], ["date", "more_than_ago", "2026-10-14T02:00:00Z", { n: 30, unit: "minutes" }, true], ["date", "before", "junk", { v: "2026-10-14" }, false],
        ["bool", "true", true, {}, true], ["bool", "false", false, {}, true], ["bool", "true", "true", {}, false],
        ["people", "is", "u-1", { v: "u-1" }, true], ["people", "in", "u-2", { v: ["u-1"] }, false],
      ];
      const wrong = T.filter(([vt, op, value, rule, want]) => !WF_OPS_BY_TYPE[vt].includes(op) || applyOp(op, value, { op, ...rule }, [], env) !== want);
      eq(wrong.map((x) => `${x[0]} ${x[1]} ${JSON.stringify(x[2])}`), [], "applyOp: every op × value type");
      eq(WF_VALUE_TYPES.flatMap((vt) => WF_OPS_BY_TYPE[vt].filter((op) => !T.some((x) => x[0] === vt && x[1] === op)).map((op) => `${vt}.${op}`)).filter((k) => !k.startsWith("money.") && !k.startsWith("people.")), [], "the op table covers every op of every value type");
      eq([applyOp("is", "Gutter cleaning", { v: "s9q" }, [{ key: "s9q", label: "Gutter cleaning" }]), applyOp("lte", Infinity, { n: 4 }), applyOp("gte", Infinity, { n: 4 })], [true, false, true], "phase-4 meanings kept (label = key, Infinity hours)");
      eq([shiftMonth("2026-03-31", -1), shiftMonth("2024-01-31", 1), shiftMonth("2026-12-15", 1), dayOfValue("2026-10-14T13:30:00Z", "Australia/Sydney")], ["2026-02-28", "2024-02-29", "2027-01-15", "2026-10-15"], "shiftMonth / dayOfValue");
    }

    // ── evalCondition: gate pull-out, segments, empty filter, ref, details ──
    {
      const env = { nowMs: NOW, tz: "Australia/Sydney" };
      const facts: any = { stage_unchanged: true, has_email: false, has_mobile: true, service: "Aircon", "job.amount": 500, "lead.quote_amount": 400 };
      const val = (r: any) => facts[r.field];
      const ev = async (cond: any) => { const r = await evalCondition(cond, val, env); return [r.ok, r.failed]; };
      const seg = (match: string, ...rules: any[]) => ({ match, rules });
      eq(await ev({ match: "all", segments: [seg("all")] }), [true, null], "an empty filter is true");
      eq(await ev({ match: "any", segments: [seg("all", { field: "has_email", op: "true" }), seg("all", { field: "has_mobile", op: "true" })] }), [true, null], "segments any: one is enough");
      eq(await ev({ match: "all", segments: [seg("all", { field: "has_email", op: "true" }), seg("all", { field: "has_mobile", op: "true" })] }), [false, "has_email"], "segments all: the first failing field");
      eq(await ev({ match: "any", segments: [seg("any", { field: "has_email", op: "true" }, { field: "service", op: "is", v: "Gutters" })] }), [false, "has_email, service"], "rules any: the failed fields joined (phase-4 reason)");
      facts.stage_unchanged = false;
      eq(await ev({ match: "any", segments: [seg("any", { field: "stage_unchanged", op: "true" }, { field: "has_mobile", op: "true" })] }), [false, "stage_unchanged"], "a gate in an any group is still AND-ed first");
      facts.stage_unchanged = true;
      eq(await ev({ match: "any", segments: [seg("all", { field: "stage_unchanged", op: "true" }), seg("all", { field: "has_email", op: "true" })] }), [false, "has_email"], "a segment of only gates is decided by the gates (the rest still has to hold)");
      eq(await ev({ match: "all", segments: [seg("all", { field: "job.amount", op: "gt", ref: "lead.quote_amount" })] }), [true, null], "a dynamic value compares with the other field");
      eq(await ev({ match: "all", segments: [seg("all", { field: "shoe", op: "is", v: "9" })] }), [false, "shoe"], "an unknown field never passes");
      const r = await evalCondition({ match: "all", segments: [seg("all", { field: "service", op: "is", v: "Gutters" })] }, val, env);
      eq([r.conds[0].received, r.conds[0].expected, filterReasonText(r.conds[0].label, r.conds[0].received, r.conds[0].expected)], ["Aircon", "Gutters", "Filter not matched - Service - Received value: Aircon, Expected value: Gutters"], "details for the log (GHL's filter wording)");
      const f: any = { kind: "contact", type: "stage", contact: lead("c1", { status: "Quoted" }), job: null, call: null, chat: null, ctx: { stage: "Quoted", trigger_id: "t1" }, eventAt: isoMs(NOW), S: normSettings({}), cat: CATALOG, nowMs: NOW };
      eq([await factValue(f, null, { field: "stage" }), await factValue(f, null, { field: "trigger.stage" }), await factValue(f, null, { field: "trigger.id" }), await factValue(f, null, { field: "lead.name" }), await factValue(f, null, { field: "now.day_of_week" }), await factValue(f, null, { field: "trigger.order_no" })],
        ["Quoted", "Quoted", "t1", "Sam Smith", "3", null], "factValue: phase-4 fields, trigger payload, lead card, now");
      // the quote amount is the lead card's estimated_value (what the capture and "Update lead field" use), read by loadFactsV2
      const qdb = world({ contacts: [lead("c1", { estimated_value: 1500 })] });
      const fq = await loadFactsV2(qdb, { record_kind: "contact", record_id: "c1", event_type: "newLead", context: {}, event_at: isoMs(NOW) }, ctxOf(qdb), NOW);
      const qr = await evalCondition({ match: "all", segments: [seg("all", { field: "lead.quote_amount", op: "gt", n: 1000 })] }, (r: any) => factValue(fq, qdb, r), env);
      eq([await factValue(fq, qdb, { field: "lead.quote_amount" }), qr.ok, qr.conds[0].received, CONTACT_COLS_V2.split(", ").includes("estimated_value")], [1500, true, 1500, true],
        "lead.quote_amount reads contacts.estimated_value (loaded by loadFactsV2)");
      // a migrated missed-call workflow's filter matches the event the reused phase-4 missed-call scanner makes (ctx {})
      const mcall = { id: "k1", from_number: "0412345678", to_number: "0290000000", direction: "inbound", missed: true, started_at: isoMs(NOW), created_at: isoMs(NOW), division: "Aircon", contact_id: null, status: "no-answer" };
      const mev: any = TRIGGERS.missedCall.fromRecord(mcall, normSettings({})), mtr = upgradeV1({ type: "missedCall", params: {} }, [{ id: "p1", kind: "action", type: "push", to: { roles: ["owner"] }, title: "x" }]).doc.triggers[0];
      const mf: any = { kind: "call", type: mev.type, contact: null, job: null, call: mcall, chat: null, ctx: obj(mev.ctx), eventAt: mev.event_at, S: normSettings({}), cat: CATALOG, nowMs: NOW };
      const mr = await evalCondition(mtr.filters, (r: any) => factValue(mf, null, r), env);
      eq([mtr.type, mr.ok, mr.conds.map((c: any) => c.received)], ["call_details", true, ["missed"]], "an upgraded missed-call trigger's filter matches a phase-4 missed-call event (reads the call record)");
    }

    // ── compile ──
    {
      const d = W.find((k: any) => k.name === "canonical-1").doc, X = compile(d);
      eq([X.parent.n4, X.kids.n5, X.heads, X.first("t1"), X.downstreamGoals("n1"), X.downstreamGoals("n7"), X.ancestors("n6")], [{ from: "n2", port: "b3" }, ["n6", "n7"], ["n1"], "n1", ["n7"], [], ["n5", "n4", "n2", "n1"]], "compile: parents, children in port order, heads, first, goals ahead, ancestors");
      const adv = W.find((k: any) => k.name === "advanced: trigger Go to").doc, A = compile(adv);
      eq([A.first("t2"), A.first("t1"), A.reachingTriggers.n1, A.reachingTriggers.n2], ["n2", "n1", ["t1"], ["t1", "t2"]], "compile: a trigger's Go to and which triggers reach a step");
      const loop = W.find((k: any) => k.name === "weekly loop with a wait").doc, L = compile(loop);
      eq([L.refs, [...L.reach(["n2"], false)].sort(), [...L.reach(["n2"], true)].sort()], [[{ from: "n3", key: "target", to: "n1" }], ["n2", "n3"], ["n1", "n2", "n3"]], "compile: go-to refs and reach with / without them");
      eq([wfPorts({ kind: "workflow", type: "remove_from_workflow", config: { scope: "all" } }), wfPorts({ kind: "wait", type: "period", config: { timeout: { n: 1, unit: "days" } } }), wfPortLabel(d.nodes.n5, "timeout"), wfPortLabel(d.nodes.n2, "none")],
        [[], ["next"], "Timed out", "None"], "ports: terminal remove, a period never has a timeout port, labels");
      eq(nodeRefs({ kind: "wait", type: "date", config: { gotoStep: "n2", ifPassed: "goto" } }), [{ key: "gotoStep", to: "n2" }], "nodeRefs reads x-ref fields");
    }

    // ── per-workflow settings ──
    eq(normWfSettings({}), WF_SETTINGS_DEFAULTS, "normWfSettings: the GHL defaults");
    eq(normWfSettings({ reentry: "legacy_always", window: { on: true, days: [5, 1, 1, 9], from: "18:00", until: "09:00" }, sender: { fromName: "  Kim  " }, timezone: "mars" }, {}),
      { reentry: "off", perRecord: true, stopOnResponse: false, timezone: "business", window: { on: true, days: [1, 5], from: "08:00", until: "17:00" }, sender: { fromName: "Kim" }, markRead: false }, "normWfSettings clamps");
    eq(normWfSettings({ reentry: "legacy_always" }).reentry, "legacy_always", "legacy_always is kept on a migrated row");
    eq([issueCodes(wfSettingsProblems({ reentry: "legacy_always" }, { reentry: "off" }, AV_OFF)), issueCodes(wfSettingsProblems({ reentry: "legacy_always" }, { reentry: "legacy_always" }, AV_OFF)),
      issueCodes(wfSettingsProblems({ timezone: "contact" }, {}, AV_ALL)), issueCodes(wfSettingsProblems({ window: { on: true, days: [], from: "09:00", until: "08:00" } }, {}, AV_ALL)), issueCodes(wfSettingsProblems(WF_SETTINGS_DEFAULTS, {}, AV_OFF))],
      [["E_SCHEMA"], [], ["E_UNAVAILABLE"], ["E_SCHEMA"], []], "wfSettingsProblems: legacy_always only when already set, no lead time zone, a valid window");

    // ── JSON Schema + export ──
    {
      const biz = bizListsOf(CATALOG, { people: [{ id: "u-owner", full_name: "Olivia Owner" }], workflows: [{ id: "w-1", name: "Quote follow-up" }] });
      const gen = jsonSchema(AV_OFF, biz), acc = jsonSchema(AV_OFF, biz, { mode: "accept" }), all = jsonSchema(AV_ALL, biz);
      const refsOk = (root: any) => { const bad: string[] = []; const walk = (x: any) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === "object") { if (typeof x.$ref === "string" && x.$ref.replace(/^#\//, "").split("/").reduce((a: any, k: string) => a && a[k], root) === undefined) bad.push(x.$ref); Object.values(x).forEach(walk); } }; walk(root); return bad; };
      eq([gen.type, gen.$schema, refsOk(gen), refsOk(acc), C(JSON.parse(JSON.stringify(gen))) === C(gen)], ["object", "https://json-schema.org/draft/2020-12/schema", [], [], true], "the schema is a tool input object, every $ref resolves, it is plain JSON");
      const nodeTypes = (s: any) => s.$defs.node.oneOf.map((v: any) => v.properties.type.const);
      eq([nodeTypes(gen).includes("send_sms"), nodeTypes(all).includes("send_sms"), nodeTypes(acc).includes("send_sms"), nodeTypes(gen).includes("ai_agent"), gen.$defs.trigger.oneOf.some((v: any) => v.properties.type.const === "doc_expiring")],
        [false, true, true, false, false], "generation leaves out what is greyed or built-in; accept keeps it");
      const ifv = (s: any) => s.$defs.node.oneOf.find((v: any) => v.properties.type.const === "if_else").properties.config.properties;
      eq(["gate" in ifv(gen), "gate" in ifv(acc), gen.$defs.settings.properties.reentry.enum, acc.$defs.settings.properties.reentry.enum, gen.$defs.settings.properties.timezone.enum],
        [false, true, ["off", "after_exit"], ["off", "after_exit", "legacy_always"], ["business"]], "legacy-only constructs are not in the generation schema");
      eq([gen.$defs.business.stages.enum, gen.$defs.business.stages["x-enumLabels"][1], gen.$defs.business.people.enum, "goto" in gen.$defs.trigger.oneOf[0].properties, "goto" in jsonSchema(AV_OFF, biz, { builder: "advanced" }).$defs.trigger.oneOf[0].properties],
        [["New", "Quoted", "sxy1", "Booked", "Won", "Lost"], "Quote sent", ["u-owner"], false, true], "business lists become enums in $defs/business; trigger Go to only for Advanced");
      const pn = (s: any) => s.$defs.node.oneOf.find((v: any) => v.properties.type.const === "internal_notification").properties.config.properties.channel.enum;
      eq([pn(gen), pn(all), pn(acc)], [["push"], ["push", "email", "sms"], ["push", "email", "sms"]], "greyed options are dropped from generation enums");
      eq(schemaCheck(gen, { definition: { ...W.find((k: any) => k.name === "base").doc, nodes: { n1: { kind: "action", type: "move_stage", config: { stage: "Nope" }, out: { next: null } } } } }).length > 0, true, "a stage that is not the business's is refused by the generation schema");
      const ex = registryExport(AV_OFF, biz);
      const sms = ex.actions.find((a: any) => a.key === "send_sms"), mv = ex.actions.find((a: any) => a.key === "move_stage");
      eq([sms.availability, sms.ghl, sms.audience, mv.fields.properties.stage.enum.length, mv.fields.properties.stage["x-enumLabels"][2], ex.fields.find((f: any) => f.key === "stage").values[1], ex.ops.find((o: any) => o.op === "contains_any").label, ex.reasons.end_of_workflow, ex.triggers.find((t: any) => t.key === "call_details").aliases],
        [{ ok: false, reason: "Needs the phone line (Twilio)" }, "Send SMS", "customer", 6, "Site visit", { key: "Quoted", label: "Quote sent" }, "Contains any of", "Removed by - End Of Workflow", ["missedCall"]], "registryExport: availability, GHL words, resolved lists, ops, reasons, aliases");
      // the pickers' Apps tab (design §5.5, review block 3 #21): the connectors come from the registry, each entry says its own
      const appOf = (l: string, k: string) => ((ex as any)[l].find((e: any) => e.key === k) || {}).app ?? null;
      eq([ex.apps, appOf("triggers", "invoice"), appOf("triggers", "review_received"), appOf("actions", "send_invoice"), appOf("actions", "send_estimate"), appOf("actions", "send_sms"), appOf("actions", "move_stage")],
        [[{ key: "xero", label: "Xero", icon: "receipt" }, { key: "gbp", label: "Google Business Profile", icon: "star" }], "xero", "gbp", "xero", "xero", null, null],
        "registryExport: the Apps (connectors) and the entries that need each one; the phone line is not an app");
      eq(JSON.stringify(ex).includes("function"), false, "the export is data only");
    }

    // ── stage-2 helpers never type a business's own words (SaaS) ──
    const s2 = src("index.ts"), from = s2.indexOf("// ==== REGISTRY"), to = s2.indexOf("// The engine\n");
    const code2 = s2.slice(from, to).split("\n").filter((l: string) => !/^\s*\/\//.test(l)).join("\n");
    eq(["Aircon", "Gutter", "Sydney", "Ron", "The Guys"].filter((w) => code2.includes(w)), [], "no business words in the stage-2 registry and validator code");
    ok(from > 0 && to > from && ["// ==== REGISTRY", "// ==== CONDITIONS", "// ==== DOC", "// ==== VALIDATE"].every((m) => s2.includes(m)), "stage-2 section markers");
  }

  // ══ stage 2 (G1.2): executor v2, waits, dry-run core ══
  {
    const tz = "Australia/Sydney", S0 = normSettings({});
    const tr1 = [{ id: "t1", type: "newLead", filters: { match: "all", segments: [{ match: "all", rules: [] }] } }];
    const doc = (nodes: any, entry = "n1", seq = 20) => ({ schema: 2, seq, entry, triggers: tr1, nodes });
    const flow = (o: any = {}) => ({ id: "w-v2-0001", business_id: "default", name: "Flow", enabled: true, armed_at: "2026-10-01T00:00:00.000Z", version: 3, revision: 7, created_by_name: "Olivia Owner",
      trigger: {}, steps: [], settings: {}, ...o });
    const runRow = (o: any = {}) => ({ id: "r-v2", business_id: "default", automation_id: "w-v2-0001", automation_version: 3, event_key: "c1:new", event_type: "newLead", event_at: isoMs(NOW),
      record_kind: "contact", record_id: "c1", contact_id: "c1", status: "running", step_index: 0, anchor_at: isoMs(NOW), due_at: isoMs(NOW), attempts: 1, context: {}, trigger_id: "t1", cursor_step: null,
      remove_requested: false, ...o });
    const push = (title: string, next: string | null = null, o: any = {}) => ({ kind: "action", type: "internal_notification", config: { channel: "push", to: { roles: ["owner"] }, title }, out: { next }, ...o });
    const mail = (next: string | null = null, o: any = {}) => ({ kind: "action", type: "send_email", config: { subject: "Your {service} enquiry", body: "{hi}, thanks." }, out: { next }, ...o });
    const period = (n: number, unit: string, next: string | null, o: any = {}) => ({ kind: "wait", type: "period", config: { n, unit, ...o }, out: { next } });
    const thisRun = (db: any, id = "r-v2") => db.T.automation_runs.find((r: any) => r.id === id);
    const rowsOf = (db: any, id = "r-v2") => db.T.automation_log.filter((l: any) => l.run_id === id);
    // one advance, as the timer would (claimed: running, one more try)
    const step = async (db: any, ms: number, id = "r-v2") => { const r = thisRun(db, id); Object.assign(r, { status: "running", attempts: (Number(r.attempts) || 0) + 1 }); clock = ms; return await advanceV2(db, { ...r }, ctxOf(db), ms); };
    // advance at every due time until the run ends
    const drive = async (db: any, ms: number, id = "r-v2", max = 400) => { let t = ms, p: any = null; for (let k = 0; k < max; k++) { p = await step(db, t, id); if (p.status !== "waiting") break; t = Date.parse(p.due_at); } clock = NOW; return p; };

    // ── planDeferTree = planDefer (phase 4) on every action of every phase-4 shape, at night / weekend / holiday times ──
    {
      const W = (o: any) => ({ id: "w", kind: "window", ...o }), IF = (id: string) => ({ id, kind: "if", match: "all", conds: [{ field: "has_email", op: "true" }] });
      const P = (id: string) => ({ id, kind: "action", type: "push", to: { roles: ["owner"] }, title: "x" }), E = (id: string) => ({ ...emailStep(), id });
      const lists: any[][] = [
        [E("e1")], [IF("i1"), E("e1")], [W({ days: [1, 2, 3, 4, 5], from: "09:00", until: "17:00", outside: "next" }), IF("i1"), P("p1"), E("e1")],
        [{ id: "wt", kind: "wait", unit: "minutes", n: 10 }, W({ mode: "office", outside: "next" }), E("e1")], [W({ mode: "outsideOffice", outside: "skip" }), E("e1")],
        [W({ days: [0, 6], from: "06:00", until: "23:00", outside: "next" }), IF("i1"), E("e1")], [{ id: "wt", kind: "wait", unit: "hours", n: 1 }, IF("i1"), IF("i2"), P("p1"), { id: "t1", kind: "action", type: "task", title: "x" }, E("e1")],
        [W({ days: [0, 1, 2, 3, 4, 5, 6], from: "08:00", until: "20:00", outside: "at", at: "10:00" }), E("e1")], [W({ days: [1], from: "06:00", until: "07:00", outside: "next" }), E("e1")],
        [E("e0"), { id: "wt", kind: "wait", unit: "days", n: 1 }, W({ mode: "office", outside: "skip" }), IF("i1"), E("e1")], [IF("i0"), W({ mode: "outsideOffice", outside: "next" }), P("p1"), E("e1")],
        // long runs of If / action steps above the message (phase 4 walks back with no limit; up to 30 steps)
        [W({ days: [1, 2, 3, 4, 5], from: "06:00", until: "23:00", outside: "next" }), ...Array.from({ length: 21 }, (_, k) => P("p" + k)), E("e1")],
        [W({ days: [1, 2, 3, 4, 5], from: "09:00", until: "17:00", outside: "next" }), ...Array.from({ length: 20 }, (_, k) => IF("i" + k)), E("e1")],
        [IF("c1"), ...Array.from({ length: 20 }, (_, k) => P("p" + k)), E("e1")],
        [W({ days: [6], from: "06:00", until: "23:00", outside: "skip" }), ...Array.from({ length: 28 }, (_, k) => k % 3 ? P("p" + k) : IF("i" + k)), E("e1")],
        [IF("c1"), ...Array.from({ length: 28 }, (_, k) => P("p" + k)), E("e1")],
      ];
      const times = [syd("2026-10-03", 21, 30), syd("2026-10-17", 10), syd("2026-10-18", 21), syd("2026-10-13", 7), syd("2026-10-05", 10), syd("2026-10-14", 14), syd("2026-10-19", 18), syd("2026-04-04", 22), syd("2026-10-17", 8)];
      const bad: string[] = []; let n = 0;
      for (const steps of lists) {
        const C = compile(upgradeV1({ type: "newLead", params: {} }, steps).doc);
        steps.forEach((st: any, i: number) => {
          if (st.kind !== "action") return;
          for (const ms of times) {
            n++;
            const want: any = planDefer(steps, i, ms, S0, CATALOG), got: any = planDeferTree(C, st.id, ms, S0, CATALOG);
            const w2 = "skip" in want ? want : { at: want.at, back: steps[want.back].id };
            if (JSON.stringify(w2) !== JSON.stringify(got)) bad.push(`${steps.map((x: any) => x.id).join(">")} @${st.id} ${isoMs(ms)}: ${JSON.stringify(got)} vs ${JSON.stringify(w2)}`);
          }
        });
      }
      eq(bad, [], "planDeferTree gives exactly planDefer's { at, back } (or its skip words)");
      ok(n >= 100, "the planDefer parity table has at least 100 rows", n);
      // on a tree: back over an If / else branch, never over a wait with a timeout, a split or a goal
      const C = compile(doc({ n1: { kind: "wait", type: "reply", config: { channels: ["email"], timeout: { n: 1, unit: "days" } }, out: { next: "n2", timeout: null } },
        n2: { kind: "if_else", type: "if_else", config: { branches: [{ id: "b1", when: { match: "all", segments: [{ match: "all", rules: [] }] } }] }, out: { b1: "n3", none: null } }, n3: mail() }));
      eq(planDeferTree(C, "n3", NOW, S0, CATALOG), { at: NOW, back: "n2" }, "planDeferTree: back over an If / else branch, stops below a wait");
    }

    // ── waits: period + advance window across daylight saving (Sydney April and October) ──
    {
      eq([isoMs(periodUntil(syd("2026-04-04", 9, 30), { n: 1, unit: "days" }, tz, {})), isoMs(periodUntil(syd("2026-04-04", 9, 30), { n: 1, unit: "days", resume: { days: [1, 2, 3, 4, 5], from: "09:00", until: "17:00" } }, tz, {})),
        isoMs(periodUntil(syd("2026-04-04", 9, 30), { n: 24, unit: "hours" }, tz, {}))],
        ["2026-04-04T23:30:00.000Z", "2026-04-05T23:00:00.000Z", "2026-04-04T22:30:00.000Z"], "period across the April change: 1 day keeps 09:30 (now +10), the advance window moves it to Monday 09:00, 24 hours is by the clock");
      eq([isoMs(periodUntil(syd("2026-10-03", 9, 30), { n: 2, unit: "days" }, tz, {})), isoMs(periodUntil(syd("2026-10-03", 9, 30), { n: 2, unit: "days", resume: { days: [1, 2, 3, 4, 5], from: "10:00", until: "17:00" } }, tz, {})),
        isoMs(periodUntil(syd("2026-10-03", 9, 30), { n: 30, unit: "seconds" }, tz, {}))],
        ["2026-10-04T22:30:00.000Z", "2026-10-04T23:00:00.000Z", "2026-10-02T23:30:30.000Z"], "period across the October change: 2 days keep 09:30 (now +11), then the window's 10:00; seconds by the clock");
      // through the executor: the run waits exactly that long, then goes on
      const db = world({ contacts: [lead("c1")], automations: [flow({ armed_at: "2026-01-01T00:00:00.000Z", definition: doc({ n1: period(1, "days", "n2", { resume: { days: [1, 2, 3, 4, 5], from: "09:00", until: "17:00" } }), n2: push("Go") }) })],
        automation_runs: [runRow({ event_at: isoMs(syd("2026-04-04", 9, 30)), anchor_at: isoMs(syd("2026-04-04", 9, 30)), due_at: isoMs(syd("2026-04-04", 9, 30)) })] });
      sent.length = 0;
      const p1: any = await step(db, syd("2026-04-04", 9, 31));
      eq([p1.status, p1.due_at, p1.cursor_step, p1.watch, p1.recheck], ["waiting", "2026-04-05T23:00:00.000Z", "n1", [], false], "advanceV2: a period wait holds until the advance window opens (no heartbeat)");
      const p2: any = await step(db, Date.parse("2026-04-05T23:00:00.000Z"));
      eq([p2.status, p2.reason, p2.exit_reason, sent.length], ["done", null, "end_of_workflow", 1], "…and then goes on to the end");
      clock = NOW;
    }

    // ── recurring "times": the next five occurrences ──
    {
      const five = (cfg: any, from: number) => { const out: string[] = []; let t = from; for (let k = 0; k < 5; k++) { const x = nextRecurrence(t, { mode: "times", ...cfg }, tz); if (x === null) break; out.push(isoMs(x)); t = x + 60e3; } return out; };
      eq(five({ freq: "weekly", days: [2, 4], at: "10:00" }, NOW), ["2026-10-14T23:00:00.000Z", "2026-10-19T23:00:00.000Z", "2026-10-21T23:00:00.000Z", "2026-10-26T23:00:00.000Z", "2026-10-28T23:00:00.000Z"], "recurring weekly Tue + Thu 10:00");
      eq(five({ freq: "monthly", monthDays: [1, 15, -1], at: "09:00" }, NOW), ["2026-10-14T22:00:00.000Z", "2026-10-30T22:00:00.000Z", "2026-10-31T22:00:00.000Z", "2026-11-14T22:00:00.000Z", "2026-11-29T22:00:00.000Z"], "recurring monthly the 1st, 15th and last day");
      eq(five({ freq: "monthly", days: [2], nth: [2, -1], at: "08:00" }, NOW), ["2026-10-26T21:00:00.000Z", "2026-11-09T21:00:00.000Z", "2026-11-23T21:00:00.000Z", "2026-12-07T21:00:00.000Z", "2026-12-28T21:00:00.000Z"], "recurring monthly 2nd and last Tuesday");
      eq(five({ freq: "yearly", date: "02-29", at: "09:00" }, NOW), ["2027-02-27T22:00:00.000Z", "2028-02-28T22:00:00.000Z", "2029-02-27T22:00:00.000Z", "2030-02-27T22:00:00.000Z", "2031-02-27T22:00:00.000Z"], "recurring yearly 29 Feb (28 Feb in other years)");
      eq(five({ freq: "weekly", days: [0], at: "09:00" }, syd("2027-03-25", 12)), ["2027-03-27T22:00:00.000Z", "2027-04-03T23:00:00.000Z", "2027-04-10T23:00:00.000Z", "2027-04-17T23:00:00.000Z", "2027-04-24T23:00:00.000Z"], "recurring weekly across the April change keeps 09:00");
      eq([five({ freq: "monthly", monthDays: [31], months: [2, 4], at: "09:00" }, NOW), nextRecurrence(NOW, { freq: "weekly", days: [1], at: "25:00" }, tz), five({ freq: "monthly", monthDays: [2], months: [1], at: "07:30" }, NOW).length],
        [[], null, 5], "recurring: a day that never comes, a bad time, a month filter");
      const db = world({ contacts: [lead("c1")], automations: [flow({ definition: doc({ n1: { kind: "wait", type: "recurring", config: { mode: "times", freq: "weekly", days: [4], at: "10:00" }, out: { next: "n2" } }, n2: push("Thursday") }) })],
        automation_runs: [runRow()] });
      const p1: any = await step(db, NOW);
      eq([p1.due_at, p1.context._w.until], ["2026-10-14T23:00:00.000Z", "2026-10-14T23:00:00.000Z"], "advanceV2: a recurring wait holds until its next occurrence");
      const p2: any = await step(db, Date.parse("2026-10-14T23:00:00.000Z"));
      eq([p2.status, rowsOf(db).map((l: any) => `${l.step_id}:${l.row_kind}:${l.status}`)], ["done", ["n1:step:waiting", "n1:step:wait_finished", "n2:action:sent", "n2:exit:finished"]], "…and releases then (waiting, wait finished, action, exit)");
      clock = NOW;
    }

    // ── date / scheduled waits: target from fresh facts, heartbeat, the four "if passed" choices ──
    {
      const fj: any = { job: { date: "2026-10-20" }, contact: null, ctx: {}, S: S0, cat: CATALOG, nowMs: NOW };
      const sch = (when: string, offset: any, dayTime = "08:00") => ({ kind: "wait", type: "scheduled", config: { anchor: "job.date", when, ...(offset ? { offset } : {}), dayTime, ifPassed: "continue" } });
      eq([isoMs((await waitTarget(sch("after", { n: 2, unit: "hours" }), fj, null, tz)) as number), isoMs((await waitTarget(sch("before", { n: 1, unit: "days" }), fj, null, tz)) as number),
        isoMs((await waitTarget(sch("at", null, "24:00"), fj, null, tz)) as number), await waitTarget(sch("at", null), { ...fj, job: { date: null } }, null, tz)],
        ["2026-10-19T23:00:00.000Z", "2026-10-18T21:00:00.000Z", "2026-10-20T13:00:00.000Z", null], "scheduled: after / before a date-only job date at the day time; no date = null");
      eq(isoMs((await waitTarget({ kind: "wait", type: "date", config: { at: "2026-12-04T09:00", when: "on", ifPassed: "end" } }, fj, null, tz)) as number), "2026-12-03T22:00:00.000Z", "date: a fixed business wall-clock time");
      const dateWait = (ifPassed: string, extra: any = {}) => ({ kind: "wait", type: "date", config: { ref: "lead.booked_for", when: "before", offset: { n: 1, unit: "days" }, dayTime: "09:00", ifPassed, ...extra }, out: { next: "n2" } });
      const mk = (ifPassed: string, booked: string, nodes: any = {}, extra: any = {}) => world({ contacts: [lead("c1", { booked_for: booked })],
        automations: [flow({ definition: doc({ n1: dateWait(ifPassed, extra), n2: push("A", "n3"), n3: push("B"), ...nodes }) })], automation_runs: [runRow()] });
      // in the future: heartbeat holds, the counters stay put on rechecks, a moved date is followed
      let db = mk("continue", "2026-10-20");
      const h1: any = await step(db, NOW);
      eq([h1.status, h1.due_at, h1.recheck, h1.watch, h1.context._w.until, h1.steps_done], ["waiting", isoMs(NOW + HR), true, ["job_booked", "booking_status"], "2026-10-18T22:00:00.000Z", 1],
        "date wait: an hour's heartbeat (recheck) until the day before at 09:00, watching the events that move the date");
      db.T.contacts[0].booked_for = "2026-10-25";
      const h2: any = await step(db, NOW + HR);
      eq([h2.due_at, h2.steps_done, h2.context._w.until, rowsOf(db).filter((l: any) => l.status === "waiting").length], [isoMs(NOW + 2 * HR), 1, "2026-10-23T22:00:00.000Z", 1], "a recheck: no new step, no second waiting row, the moment follows the moved date");
      sent.length = 0;
      const h3: any = await step(db, Date.parse("2026-10-18T22:00:00.000Z"));
      eq([h3.status, sent.length], ["waiting", 0], "the date moved later: still waiting at the old time");
      const h4: any = await drive(db, Date.parse(h3.due_at));
      eq([h4.status, sent.length, rowsOf(db).find((l: any) => l.status === "wait_finished").at], ["done", 2, "2026-10-23T22:00:00.000Z"], "…and goes on the day before the new date at 09:00");
      // passed: continue / end / go to / skip messages until the next wait
      sent.length = 0;
      db = mk("continue", "2026-10-10"); let p: any = await step(db, NOW);
      eq([p.status, sent.length, rowsOf(db)[0].detail.outcome], ["done", 2, "passed"], "if passed: continue");
      db = mk("end", "2026-10-10"); p = await step(db, NOW);
      eq([p.status, p.reason, p.exit_reason, logOf(db)], ["skipped", "the date has passed", "date_passed", []], "if passed: end");
      sent.length = 0;
      db = mk("goto", "2026-10-10", {}, { gotoStep: "n3" }); p = await step(db, NOW);
      eq([p.status, sent.map((x) => x.msg.title), p.loop, rowsOf(db).filter((l: any) => l.status === "jumped").map((l: any) => l.detail.to)], ["done", ["B"], 1, ["n3"]], "if passed: go to a step (a new pass)");
      sent.length = 0;
      db = mk("skip_comms", "2026-10-10", { n2: mail("n3"), n3: push("B", "n4"), n4: period(5, "minutes", "n5"), n5: mail(null) });
      p = await drive(db, NOW);
      eq([p.status, logOf(db), sent.map((x) => x.msg.title)], ["done", ["n2:skipped:Messages skipped until the next wait", "n3:sent", "n5:queued"], ["B"]], "if passed: skip messages until the next wait (team steps still run)");
      db = mk("continue", "");
      p = await step(db, NOW);
      eq(p.status, "done", "no date at all = passed");
      // the date removed while the run waits (a booking cancelled, booked_for cleared): the run ends, never "passed"
      for (const how of ["continue", "skip_comms", "end"]) {
        sent.length = 0;
        db = mk(how, "2026-10-20");
        p = await step(db, NOW);
        db.T.contacts[0].booked_for = null;
        p = await step(db, NOW + 5 * MIN);
        eq([p.status, p.reason, p.exit_reason, sent.length, rowsOf(db).filter((l: any) => l.status === "wait_finished").map((l: any) => l.detail.outcome)],
          ["skipped", "the date was removed", "date_removed", 0, ["date_removed"]], `a date removed while waiting ends the run (no reminder of a cancelled booking), if passed: ${how}`);
      }
      clock = NOW;
    }

    // ── log rows, counters, legacy cursor, disabled, yield, loop guard, exit rows ──
    {
      const branchy = doc({ n1: period(10, "minutes", "n2"), n2: { kind: "if_else", type: "if_else", name: "Has email?", config: { branches: [{ id: "b1", name: "Yes", when: { match: "all", segments: [{ match: "all", rules: [{ field: "has_email", op: "true" }] }] } }], noneName: "None" }, out: { b1: "n3", none: "n4" } },
        n3: push("Email lead", null, { name: "Tell the owner" }), n4: { kind: "action", type: "add_task", config: { title: "Call {name}" }, out: { next: null } } });
      let db = world({ contacts: [lead("c1")], automations: [flow({ definition: branchy })], automation_runs: [runRow()] });
      await step(db, NOW);
      const p: any = await step(db, NOW + 10 * MIN);
      const L = rowsOf(db);
      eq(L.map((l: any) => [l.step_id, l.row_kind, l.status, l.seq, l.loop, l.step_type, l.step_name, l.version, l.revision, l.trigger_id]), [
        ["n1", "step", "waiting", 1, 0, "period", "For a set period of time", 3, 7, "t1"], ["n1", "step", "wait_finished", 1, 0, "period", "For a set period of time", 3, 7, "t1"],
        ["n2", "step", "branch", 2, 0, "if_else", "Has email?", 3, 7, "t1"], ["n3", "action", "sent", 3, 0, "internal_notification", "Tell the owner", 3, 7, "t1"], ["n3", "exit", "finished", 3, 0, "internal_notification", "Tell the owner", 3, 7, "t1"]],
        "every log row: kind, seq, loop, step type and name, version, revision, trigger");
      eq([L[0].next_at, L[1].detail.outcome, L[2].detail.branch_id, L[2].detail.conds[0], L[3].channel, L[3].audience, L[4].reason, L[4].detail.exit_reason],
        [isoMs(NOW + 10 * MIN), "time", "b1", { label: "Has an email address", received: true, expected: "true", ok: true }, "push", "team", "Removed by - End Of Workflow", "end_of_workflow"], "waiting next_at, outcome, branch details, action channel, exit reason");
      eq([p.status, p.reason, p.cursor_step, p.steps_done, p.steps_today, p.steps_day, p.finished_at, p.watch], ["done", null, null, 3, 3, "2026-10-14", isoMs(NOW + 10 * MIN), null], "the run's counters and end");
      // a run phase 4 left waiting at its wait (no cursor yet; one id upgradeV1 had to replace) goes on from there
      const v1steps = [{ id: "p-0", kind: "action", type: "push", to: { roles: ["owner"] }, title: "First" }, { id: "w-1", kind: "wait", unit: "minutes", n: 10 }, { id: "p-2", kind: "action", type: "push", to: { roles: ["owner"] }, title: "Second" }];
      db = world({ contacts: [lead("c1")], automations: [auto({ id: "a-leg-0001", steps: v1steps })], automation_runs: [runRow({ automation_id: "a-leg-0001", automation_version: 1, trigger_id: null, step_index: 1, anchor_at: isoMs(NOW - 20 * MIN), status: "waiting" })] });
      const ids = upgradeV1({ type: "newLead" }, v1steps).idMap;
      eq(legacyCursor({ step_index: 1 }, runDocOf(db.T.automations[0]).v1Ids), ids["w-1"], "legacyCursor: steps[step_index] through the id map");
      sent.length = 0;
      const q: any = await step(db, NOW);
      // the log and the claims keep the PHASE-4 step id (G1.4 compat: what phase 4 claimed, and a rollback build reads)
      eq([q.status, sent.map((x) => x.msg.title), q.step_index, logOf(db), rowsOf(db).at(-1).trigger_id, ids["p-2"] !== "p-2"], ["done", ["Second"], 3, ["p-2:sent"], "t1", true], "an in-flight phase-4 run continues at its step (the first push is not sent again)");
      // phase 4 claimed p-2 (a crash right after its claim): the v2 executor finds that claim under the phase-4 id
      db = world({ contacts: [lead("c1")], automations: [auto({ id: "a-leg-0001", steps: v1steps })], automation_runs: [runRow({ automation_id: "a-leg-0001", automation_version: 1, trigger_id: null, step_index: 2, anchor_at: isoMs(NOW - 20 * MIN), status: "waiting" })],
        automation_log: [{ id: "l-p4", business_id: "default", run_id: "r-v2", step_id: "p-2", status: "sending", channel: "push", audience: "team", automation_id: "a-leg-0001", at: isoMs(NOW - MIN) }] });
      sent.length = 0;
      const q2: any = await step(db, NOW);
      eq([q2.status, sent.length, logOf(db)], ["done", 0, ["p-2:sending"]], "compat: an action phase 4 claimed under an id upgradeV1 replaced is never done again");
      // phase 4's "Only on" pass mark (ctx._pass = its window id) is honoured, and the v2 executor writes the same mark
      const winSteps = [{ id: "win-1", kind: "window", days: [1, 2, 3, 4, 5], from: "09:00", until: "17:00", outside: "at", at: "09:30" }, { id: "p-2", kind: "action", type: "push", to: { roles: ["owner"] }, title: "Early" }];
      const late = syd("2026-10-14", 18), next930 = syd("2026-10-15", 9, 30);   // Wednesday 18:00 (outside the window) → Thursday 09:30
      db = world({ contacts: [lead("c1")], automations: [auto({ id: "a-leg-0002", steps: winSteps })], automation_runs: [runRow({ automation_id: "a-leg-0002", automation_version: 1, trigger_id: null, step_index: 0, context: { _pass: "win-1" }, due_at: isoMs(late), status: "waiting" })] });
      sent.length = 0;
      const q3: any = await step(db, late);
      eq([q3.status, sent.map((x) => x.msg.title), logOf(db)], ["done", ["Early"], ["p-2:sent"]], "compat: phase 4's window pass (its own step id) lets the run through");
      db = world({ contacts: [lead("c1")], automations: [auto({ id: "a-leg-0002", steps: winSteps })], automation_runs: [runRow({ automation_id: "a-leg-0002", automation_version: 1, trigger_id: null, step_index: 0, due_at: isoMs(late), status: "waiting" })] });
      const q4: any = await step(db, late);
      eq([q4.status, q4.context._pass, q4.due_at, q4.step_index, upgradeV1({ type: "newLead" }, winSteps).idMap["win-1"] !== undefined], ["waiting", "win-1", isoMs(next930), 0, true], "compat: the v2 executor writes the window pass under the phase-4 id (a rollback build honours it)");
      // a cursor that disagrees with step_index (phase 4 released w-1 — anchor moved — and went on after a rollback; then the
      // v2 build came back): from the old cursor the wait would start again from the new anchor
      db = world({ contacts: [lead("c1")], automations: [auto({ id: "a-leg-0001", steps: v1steps })], automation_runs: [runRow({ automation_id: "a-leg-0001", automation_version: 1, trigger_id: null, step_index: 2, cursor_step: ids["w-1"], steps_done: 2, anchor_at: isoMs(NOW), status: "waiting" })] });
      sent.length = 0;
      const q5: any = await step(db, NOW);
      eq([q5.status, sent.map((x) => x.msg.title), logOf(db)], ["done", ["Second"], ["p-2:sent"]], "compat: a stale cursor yields to step_index (no wait again, nothing twice)");
      // a run enrolled at its start step (cursor set, nothing counted yet) counts that step
      db = world({ contacts: [lead("c1")], automations: [flow({ definition: doc({ n1: push("a") }) })], automation_runs: [runRow({ cursor_step: "n1", steps_done: 0 })] });
      const en: any = await step(db, NOW);
      eq([en.status, en.steps_done, rowsOf(db).map((l: any) => l.seq)], ["done", 1, [1, 1]], "a run enrolled at its start step counts it (seq 1)");
      eq([legacyCursor({ step_index: 3 }, ["a", "b", "c"]), legacyCursor({ step_index: 0 }, []), legacyCursor({ step_index: -1 }, ["a"])], [null, undefined, undefined], "legacyCursor: past the end = END; no phase-4 steps = the trigger's first step");
      // a paused step is skipped (logged); 55 of them: the run yields after 50 steps and finishes on the next call
      const many: any = {}; for (let i = 1; i <= 55; i++) many[`n${i}`] = push(`x${i}`, `n${i + 1}`, { disabled: true }); many.n56 = push("Last");
      db = world({ contacts: [lead("c1")], automations: [flow({ definition: doc(many, "n1", 60) })], automation_runs: [runRow()] });
      sent.length = 0;
      const y1: any = await step(db, NOW);
      eq([y1.status, y1.due_at, y1.cursor_step, y1.steps_done, Object.keys(y1.visits).length, rowsOf(db).length], ["waiting", isoMs(NOW), "n51", 51, 51, 50], "50 steps per call, then it yields (due now, the visits kept)");
      const y2: any = await step(db, NOW);
      eq([y2.status, y2.steps_done, sent.map((x) => x.msg.title), rowsOf(db)[0].reason], ["done", 56, ["Last"], "The step is paused"], "…and finishes on the next call; a paused step is logged skipped");
      // at most 200 steps a business day (a new day starts again)
      db = world({ contacts: [lead("c1")], automations: [flow({ definition: doc({ n1: push("a", "n2"), n2: push("b", "n3"), n3: push("c") }) })], automation_runs: [runRow({ steps_today: 199, steps_day: "2026-10-14", steps_done: 199 })] });
      const g1: any = await step(db, NOW);
      eq([g1.status, g1.reason, g1.exit_reason, rowsOf(db).filter((l: any) => l.row_kind === "exit").map((l: any) => l.status)], ["failed", "loop guard", "loop_guard", ["failed"]], "more than 200 steps in a day: failed 'loop guard', exactly one failed exit row");
      db = world({ contacts: [lead("c1")], automations: [flow({ definition: doc({ n1: push("a", "n2"), n2: push("b") }) })], automation_runs: [runRow({ steps_today: 199, steps_day: "2026-10-13" })] });
      eq((await step(db, NOW) as any).status, "done", "…counted per business day");
      // cancelled / failed runs end with one exit row and the phase-4 words
      db = world({ contacts: [lead("c1")], automations: [flow({ definition: doc({ n1: push("a") }), enabled: false })], automation_runs: [runRow()] });
      const c1: any = await step(db, NOW);
      eq([c1.status, c1.reason, c1.exit_reason, rowsOf(db).map((l: any) => `${l.row_kind}:${l.status}:${l.reason}`)], ["cancelled", "switched off", "switched_off", ["exit:removed:The workflow was switched off"]], "switched off: cancelled, one exit row");
      db = world({ contacts: [lead("c1")], automations: [flow({ definition: { ...doc({ n1: push("a") }), entry: "zz" } })], automation_runs: [runRow()] });
      const c2: any = await step(db, NOW);
      eq([c2.status, c2.reason.startsWith("invalid: /entry"), rowsOf(db).length], ["failed", true, 1], "a broken doc fails the run (structure), one exit row");
      db = world({ contacts: [lead("c1")], automations: [flow({ definition: doc({ n1: push("a") }) })], automation_runs: [runRow({ cursor_step: "gone" })] });
      eq((await step(db, NOW) as any).reason, "invalid: the step gone is gone", "a cursor at a step that no longer exists fails (never restarts the workflow)");
      // an unavailable step only skips (the run goes on); a migrated text keeps its phase-4 path
      db = world({ contacts: [lead("c1")], automations: [flow({ definition: doc({ n1: { kind: "action", type: "send_invoice", config: {}, out: { next: "n2" } }, n2: { kind: "action", type: "send_sms", config: { body: "{hi}" }, out: { next: null } } }) })], automation_runs: [runRow()] });
      const u1: any = await step(db, NOW);
      eq([u1.status, logOf(db)], ["done", ["n1:skipped:unavailable: Needs Xero", "n2:waiting_phone:waiting for the business phone"]], "unavailable steps skip with the reason; a text logs waiting_phone");
    }

    // ── watch: goals ahead and Stop on response; a goal met ahead is jumped to ──
    {
      const gdoc = doc({ n1: period(1, "days", "n2"), n2: { kind: "goal", type: "stage_reached", config: { stages: ["Booked"], ifNotMet: "continue" }, out: { next: "n3" } }, n3: push("Booked!") });
      const db = world({ contacts: [lead("c1")], automations: [flow({ definition: gdoc, settings: { stopOnResponse: true } })], automation_runs: [runRow()] });
      const w1: any = await step(db, NOW);
      eq(w1.watch, ["stage", "lead_status", "customer_replied"], "a hold watches the goals ahead and the reply when Stop on response is on");
      db.T.contacts[0].status = "Booked";
      const w2: any = await step(db, NOW + HR);
      eq([rowsOf(db).filter((l: any) => l.status === "jumped").map((l: any) => [l.step_id, l.detail.to, l.detail.goal]), w2.loop, w2.status, rowsOf(db).filter((l: any) => l.step_id === "n2").map((l: any) => l.status)],
        [[["n1", "n2", true]], 0, "done", ["executed"]], "a goal met ahead: the wait is left at once (jumped), the goal step runs (executed) and the run goes on");
    }

    // ── an "Only on" window woken early (automation_wake) looks at the window again: the pass mark waits for its hold ──
    {
      const wdoc = doc({ n1: { kind: "wait", type: "recurring", config: { mode: "window", window: { use: "custom", days: [1, 2, 3, 4, 5], from: "09:00", until: "17:00", outside: "next" } }, out: { next: "n2" } }, n2: push("x") });
      const db = world({ contacts: [lead("c1")], automations: [flow({ definition: wdoc, settings: { stopOnResponse: true } })], automation_runs: [runRow()] });
      const h1: any = await step(db, syd("2026-10-14", 20));
      const h2: any = await step(db, syd("2026-10-14", 21));   // woken early (due_at = now): still Wednesday night
      const h3: any = await step(db, syd("2026-10-15", 9));
      eq([h1.status, h1.due_at, h1.watch, h2.status, h2.due_at, rowsOf(db).filter((l: any) => l.row_kind === "action").length, h3.status],
        ["waiting", isoMs(syd("2026-10-15", 9)), ["customer_replied"], "waiting", isoMs(syd("2026-10-15", 9)), 1, "done"],
        "a window wait woken before its time holds again (nothing sent early); it passes at its time");
      ok(rowsOf(db).filter((l: any) => l.status === "waiting" && l.row_kind === "step").length === 1, "one waiting row for the window wait, not one per wake");
    }

    // ── claims: one action per (run, step, loop); step rows never block a claim ──
    {
      const db = world({ contacts: [lead("c1")] });
      const F = realFx(db), base = { business_id: "default", run_id: "r1", step_id: "s1", automation_name: "A", status: "sending", channel: "push", audience: "team", at: isoMs(NOW) };
      const a0 = await F.log({ ...base, row_kind: "action", loop: 0 }), again = await F.log({ ...base, row_kind: "action", loop: 0 }), a1 = await F.log({ ...base, row_kind: "action", loop: 1 });
      const s0 = await F.log({ ...base, row_kind: "step", loop: 0, status: "waiting" }, false), s1 = await F.log({ ...base, row_kind: "step", loop: 0, status: "wait_finished" }, false);
      eq([!!a0, again, !!a1, s0, s1, await F.priorAction("r1", "s1", 1), await F.priorAction("r1", "s1", 2)], [true, null, true, "", "", true, false], "an action claim per (run, step, loop); step rows repeat freely");
      const args = (run: string, loop: number): any => ({ run: { id: run, record_kind: "contact", record_id: "c1" }, a: { id: "a1", name: "A" }, stepId: "e1", channel: "email", contact: { id: "c1" }, keys: ["sam@example.com"],
        S: normSettings({ customer_daily_cap: 5 }), nowMs: NOW, loop });
      await F.log({ ...base, run_id: "r2", step_id: "e1", row_kind: "step", status: "waiting" }, false);
      const k0: any = await F.claimCustomer(args("r2", 0)), k0b: any = await F.claimCustomer(args("r2", 0)), k1: any = await F.claimCustomer(args("r2", 1));
      eq([typeof k0.id, k0b, typeof k1.id, db.T.automation_log.find((l: any) => l.id === k1.id).loop, (await db.rpc("automation_claim_customer", { p_business: "default", p_run: "r2", p_step: "e1", p_automation: "a1", p_name: "A", p_channel: "email", p_record_kind: "contact", p_record_id: "c1", p_contact: "c1", p_recipients: ["sam@example.com"], p_since: isoMs(NOW - DAYMS), p_cap: 5, p_now: isoMs(NOW) })).data], ["string", { done: true }, "string", 1, "done"],
        "the customer claim: a step row of the same step never blocks it, each loop claims once, the old signature = loop 0");
      ok(db.calls.includes("rpc:automation_claim_customer_v2"), "the v2 executor claims through automation_claim_customer_v2");
      db.T.automation_runs.push({ id: "rx", business_id: "default", contact_id: "c1", automation_id: "a9", status: "waiting" }, { id: "ry", business_id: "default", contact_id: "c1", automation_id: "a8", status: "waiting" }, { id: "rz", business_id: "default", contact_id: "c2", automation_id: "a9", status: "waiting" });
      eq([await F.removeRuns({ contactId: "c1", automationId: "a9" }), db.T.automation_runs.map((r: any) => `${r.id}:${r.status}:${r.exit_reason ?? ""}`)], [1, ["rx:removed:removed_by_external_action", "ry:waiting:", "rz:waiting:"]], "realFx.removeRuns: that lead's waiting runs of that workflow");
    }

    // ── the dry run: simFx = realFx (same path), nothing written, nothing sent, no network ──
    {
      const par = doc({
        n1: period(1, "days", "n2"), n2: { kind: "wait", type: "recurring", config: { mode: "window", window: { use: "custom", days: [0, 1, 2, 3, 4, 5, 6], from: "06:00", until: "23:00", outside: "next" } }, out: { next: "n3" } },
        n3: { kind: "if_else", type: "if_else", config: { branches: [{ id: "b1", name: "Has email", when: { match: "all", segments: [{ match: "all", rules: [{ field: "has_email", op: "true" }] }] } }], noneName: "None" }, out: { b1: "n4", none: null } },
        n4: mail("n5"), n5: push("Emailed {name}", "n8"), n8: mail("n6"),
        n6: { kind: "wait", type: "date", config: { ref: "lead.booked_for", when: "before", offset: { n: 1, unit: "days" }, dayTime: "09:00", ifPassed: "continue" }, out: { next: "n7" } },
        n7: { kind: "action", type: "add_task", config: { title: "Call {first_name} before the visit", due_days: 1 }, out: { next: null } } });
      const ev = syd("2026-10-14", 21);
      const seed = () => world({ contacts: [lead("c1", { booked_for: "2026-10-23", messages: [{ at: isoMs(ev) }] })], automations: [flow({ definition: par })] });
      const realDb = seed();
      realDb.T.automation_runs.push(runRow({ id: "r-par", event_at: isoMs(ev), anchor_at: isoMs(ev), due_at: isoMs(ev) }));
      sent.length = 0;
      const pr: any = await drive(realDb, ev, "r-par");
      const realSent = sent.length;
      const simDb = seed(), before = JSON.stringify(simDb.T), f0 = fetchCalls;
      sent.length = 0;
      const d: any = await dryRunV2(simDb, simDb.T.automations[0], { record_kind: "contact", record_id: "c1", contact_id: "c1", event_type: "newLead", event_at: isoMs(ev), trigger_id: "t1", context: {} }, ctxOf(simDb), ev);
      const norm = (path: any[]) => path.map((x: any) => ({ ...x, status: ["sent", "queued", "executed", "would"].includes(x.status) ? "acted" : x.status, preview: undefined }));
      const realPath = wfPathOfRows(realDb.T.automation_log.filter((l: any) => l.run_id === "r-par"));
      eq([pr.status, d.ok, d.ended], ["done", true, "done"], "the fixture runs to the end, really and dry");
      eq(JSON.stringify(norm(d.path)), JSON.stringify(norm(realPath)), "simFx path = realFx path (every step, status, reason, time and branch)");
      eq(realPath.map((x: any) => `${x.stepId}:${x.rowKind}:${x.status}${x.reason && x.rowKind !== "exit" ? ":" + x.reason : ""}`), ["n1:step:waiting", "n1:step:wait_finished", "n2:step:wait_finished", "n3:step:branch", "n2:step:wait_finished", "n3:step:branch",
        "n4:action:queued", "n5:action:sent", "n8:action:skipped:already contacted today", "n6:step:waiting", "n6:step:wait_finished", "n7:action:executed", "n7:exit:finished"], "the fixture's path: deferred to the morning (back over the If / else to the window), capped second email, date wait (the task: one automation_apply, G2.3)");
      eq([d.path.find((x: any) => x.stepId === "n4").preview.subject, d.path.find((x: any) => x.stepId === "n7").preview.board, d.path.find((x: any) => x.stepId === "n4").at], ["Your Aircon cleaning enquiry", "ron", isoMs(syd("2026-10-16", 8))], "the dry run previews the filled message and the board, at the time it would go");
      eq([JSON.stringify(simDb.T) === before, sent.length, fetchCalls - f0, simDb.calls.filter((c: string) => /\.(insert|update|upsert|delete)$|^rpc:/.test(c))], [true, 0, 0, []], "the dry run: the database byte-identical, nothing sent, no network, no write call");
      ok(realSent === 1 && d.writes.some((w: any) => w.op === "run"), "the real run sent its push; the dry run only recorded its run writes", { realSent });
      // a write attempt inside a dry run is an internal error, never a verdict
      const ro = readOnlySb(simDb);
      let e1 = "", e2 = "";
      try { ro.from("contacts").insert({ id: "x" }); } catch (e) { e1 = (e as Error).name; }
      try { ro.rpc("automation_claim_customer_v2", {}); } catch (e) { e2 = (e as Error).name; }
      eq([e1, e2, (await ro.from("contacts").select("id").eq("id", "c1").maybeSingle()).data], ["SimulationWriteError", "SimulationWriteError", { ...simDb.T.contacts[0] }], "readOnlySb: reads pass, writes and RPCs throw");
      const realGoal = WF_GOAL_MET.stage_reached;
      WF_GOAL_MET.stage_reached = async (_n: any, _f: any, sb: any) => { await sb.from("contacts").update({ status: "x" }).eq("id", "c1"); return false; };
      const gw = await dryRunV2(simDb, flow({ definition: doc({ n1: period(1, "days", "n2"), n2: { kind: "goal", type: "stage_reached", config: { stages: ["Booked"], ifNotMet: "continue" }, out: { next: null } } }) }),
        { record_kind: "contact", record_id: "c1", contact_id: "c1", event_type: "newLead", event_at: isoMs(NOW), context: {} }, ctxOf(simDb), NOW);
      WF_GOAL_MET.stage_reached = realGoal;
      eq([gw, JSON.stringify(simDb.T) === before], [{ ok: false, reason: "internal: write attempted" }, true], "a write attempted in a dry run → ok:false 'internal: write attempted', nothing written");
      const sf = simFx(ro, { id: "a1" });
      eq([await sf.apply({ p_kind: "contact" }), await sf.enroll({ p_automation: "a2" }), await sf.removeRuns({ contactId: "c1" }), sf.writes.map((w: any) => w.op), JSON.stringify(simDb.T) === before], ["would", "would", 0, ["apply", "enroll", "removeRuns"], true], "simFx records apply / enroll / remove instead of writing");
      // a path longer than the limit stops the dry run
      const loopy = await dryRunV2(simDb, flow({ definition: doc({ n1: push("a", "n2"), n2: push("b") }) }), { record_kind: "contact", record_id: "c1", contact_id: "c1", event_type: "newLead", event_at: isoMs(NOW), context: {} }, ctxOf(simDb), NOW, 2);
      eq([loopy.ok, (loopy as any).ended], [true, "step_limit"], "the dry run stops at its path limit");
    }

    // ── section markers; no business words in the stage-2 executor code ──
    const s3 = src("index.ts"), w0 = s3.indexOf("// ==== WAITS"), w1 = s3.indexOf("// Once a day: finished runs");
    ok(w0 > 0 && w1 > w0 && s3.includes("// ==== EXECUTOR"), "stage-2 section markers WAITS and EXECUTOR");
    eq(["Aircon", "Gutter", "Sydney", "Ron", "The Guys"].filter((w) => s3.slice(w0, w1).split("\n").filter((l: string) => !/^\s*\/\//.test(l)).join("\n").includes(w)), [], "no business words in the waits and executor code");
  }

  // ── 28. SQL Part 1 (G1.3): .claude/sql/stage2-automations.sql = what the engine calls and what the fake database does ──
  {
    const sql = src(SQL_DIR + "stage2-automations.sql"), p4sql = src(SQL_DIR + "settings-round2-phase4.sql");
    const p1 = sql.slice(sql.indexOf("-- PART 1"), sql.indexOf("-- END PART 1"));
    const tx = p1.slice(p1.indexOf("\nbegin;\n"), p1.indexOf("\ncommit;\n"));
    const rb = p1.slice(p1.indexOf("-- ── ROLLBACK (Part 1")).split("\n").filter((l: string) => l.startsWith("-- ")).map((l: string) => l.slice(3)).join("\n");
    const ws = (x: string) => x.replace(/\s+/g, " ").trim();
    const fnBody = (text: string, name: string) => { const a = text.indexOf(`function public.${name}(`); return a < 0 ? "" : text.slice(a, text.indexOf("$$;", text.indexOf("$$", a) + 2) + 3); };
    // one transaction holds the swap, _v2 and the wrapper (design §9.2 risk 3)
    eq([(p1.match(/^begin;$/gm) || []).length, (p1.match(/^commit;$/gm) || []).length], [1, 1], "Part 1 is ONE transaction");
    ok(["create unique index if not exists automation_log_action_once", "alter table public.automation_log drop constraint if exists automation_log_once",
      "function public.automation_claim_customer_v2(", "function public.automation_claim_customer(p_business"].every((x) => tx.includes(x)),
      "Part 1: the log key swap, automation_claim_customer_v2 and the wrapper are in the same transaction");
    ok(tx.indexOf("automation_log_action_once on") < tx.indexOf("drop constraint if exists automation_log_once"), "the new action key exists before the old one goes");
    // every RPC the engine calls exists in a SQL file, with the arguments it passes
    const calls0 = [...new Set([...src("index.ts").matchAll(/\.rpc\("([a-z0-9_]+)"/g)].map((m) => m[1]))];
    eq(calls0.filter((n) => !SQL_SIGS[n]), [], "every RPC the engine calls is defined in .claude/sql/*.sql");
    ok(Object.keys(SQL_SIGS).length > 40 && SQL_SIGS.automation_tick_lock && SQL_SIGS.set_catalog_holidays, "the fake reads the SQL signatures (phase 4, round 3, stage 2)");
    const ca = claimArgsOf({ run: { id: "r", record_kind: "contact", record_id: "c" }, a: { id: "a", name: "A" }, stepId: "s", channel: "email", contact: { id: "c" }, keys: [], S: normSettings({}), nowMs: NOW, loop: 0 });
    eq(Object.keys(ca), SQL_SIGS.automation_claim_customer_v2.params, "automation_claim_customer_v2: the engine's arguments = the SQL parameters, in order");
    eq(sqlSigs(p4sql).automation_claim_customer.params, [...SQL_SIGS.automation_claim_customer.params], "the wrapper keeps the phase-4 signature exactly");
    eq(SQL_SIGS.automation_claim_customer_v2.params, [...SQL_SIGS.automation_claim_customer.params, "p_loop"], "_v2 = the phase-4 parameters + p_loop");
    eq(SQL_SIGS.automation_enroll.params, ["p_business", "p_automation", "p_version", "p_revision", "p_trigger", "p_event_key", "p_event_type", "p_event_at", "p_record_kind",
      "p_record_id", "p_contact", "p_enroll_key", "p_lock_key", "p_reentry", "p_start", "p_context", "p_source", "p_chain", "p_cause", "p_parent", "p_stop_on_reply", "p_now", "p_due"],
      "automation_enroll: the design §3.3 parameters (+ an optional p_due for a manual start time)");
    eq([SQL_SIGS.automation_enroll.required.includes("p_due"), SQL_SIGS.automation_claim_events.required], [false, ["p_business", "p_now", "p_limit", "p_lease_s"]], "optional parameters have defaults");
    // the _v2 claim and its wrapper: action rows only, per loop; the wrapper is loop 0
    const v2 = ws(fnBody(tx, "automation_claim_customer_v2")), wr = ws(fnBody(tx, "automation_claim_customer"));
    ok(v2.includes(`l.run_id = p_run and l.step_id = p_step and l.row_kind = 'action' and l."loop" = lp`) && v2.includes("l.business_id = p_business and l.row_kind = 'action' and l.audience = 'customer'")
      && v2.includes(`on conflict (run_id, step_id, "loop") where row_kind = 'action' do nothing`) && v2.includes("pg_advisory_xact_lock"),
      "_v2: 'done' and the cap count read ACTION rows (per loop); the insert hits the partial key");
    ok(/automation_claim_customer_v2\(p_business, p_run, p_step, p_automation, p_name, p_channel, p_record_kind, p_record_id, p_contact, p_recipients, p_since, p_cap, p_now, 0\)/.test(wr), "the phase-4 claim = _v2 with loop 0");
    // the fake's keys, partial keys and defaults are the SQL's
    const tableSql = (t: string) => { const m = new RegExp(`create table if not exists public\\.${t} \\(([\\s\\S]*?)\\n\\);`).exec(tx); return m ? m[1] : ""; };
    const keyProblems: string[] = [];
    for (const [t, list] of Object.entries(UNIQUE)) for (const u of list) {
      if (t === "app_keys") continue;
      const stmtOf = (text: string) => { const a0 = text.search(new RegExp(`\\b${u.name} `)); return a0 < 0 ? "" : text.slice(a0, text.indexOf(";", a0)); };
      const line = stmtOf(tx) || stmtOf(p4sql);
      if (line) { if (!u.keys.every((k) => line.includes(k))) keyProblems.push(u.name + ": columns"); }
      else if (u.name.endsWith("_pkey")) { const b = tableSql(t); if (!(b.includes(`primary key (${u.keys.join(", ")})`) || (u.keys.length === 1 && new RegExp(`\\n  ${u.keys[0]} [^\\n]*primary key`).test(b)))) keyProblems.push(u.name); }
      else if (u.name.endsWith("_key")) { if (!new RegExp(`\\n  ${u.keys[0]} [^\\n]* unique`).test(tableSql(t))) keyProblems.push(u.name); }
      else keyProblems.push(u.name + ": not in the SQL");
    }
    eq(keyProblems, [], "every unique key of the fake database is in Part 1 (by name, with its columns)");
    ok(tx.includes(`automation_log_action_once on public.automation_log (run_id, step_id, "loop") where row_kind = 'action'`) && tx.includes("(automation_id, active_lock) where active_lock is not null")
      && tx.includes("automation_templates (business_id, key) where deleted_at is null") && tx.includes("(business_id, system_key)\n  where system_key is not null and deleted_at is null"),
      "the partial keys have the fake's where-clauses");
    const sqlVal = (v: any) => typeof v === "string" ? `'${v}'` : typeof v === "object" ? `'${JSON.stringify(v)}'::jsonb` : String(v);
    const defProblems: string[] = [];
    for (const [t, cols] of Object.entries(DEFAULTS)) for (const [c, v] of Object.entries(cols)) {
      const re = new RegExp(`"?${c}"? [a-z]+(?: not null)? default ${sqlVal(v).replace(/[{}()[\]*+?.^$|\\]/g, "\\$&")}`);
      if (!re.test(tableSql(t) + tx.slice(tx.indexOf(`alter table public.${t}\n`)))) defProblems.push(`${t}.${c}`);
    }
    eq(defProblems, [], "every default of the fake database is the SQL default");
    // capture whitelist = the engine's "Lead changed" fields; "Update lead field" = the apply whitelist; settle times
    const chg = [...tx.matchAll(/if new\.(\w+) is distinct from old\.\1 then chg := chg \|\| pg_catalog\.jsonb_build_object\('field', '(\w+)'/g)];
    eq(chg.map((m) => m[2]), CONTACT_CHANGED_FIELDS.filter((f) => f !== "assigned_user"), "the contacts capture compares exactly CONTACT_CHANGED_FIELDS (statically, column by column; the assigned user comes with Part 3 · G3.5)");
    eq(chg.filter((m) => m[1] !== m[2]).map((m) => `${m[1]}=${m[2]}`), ["estimated_value=quote_amount"], "…a column is its field, except the quote amount");
    const allowed = /allowed constant text\[\] := array\[([^\]]*)\]/.exec(tx);
    eq(allowed ? allowed[1].split(",").map((x) => x.trim().replace(/'/g, "")) : null, UPDATE_FIELD_COLUMNS, "automation_apply 'set' whitelist = UPDATE_FIELD_COLUMNS");
    const settle = Object.fromEntries([...fnBody(tx, "automation_settle_seconds").matchAll(/when '(\w+)' then (\d+)/g)].map((m) => [m[1], Number(m[2]) * 1000]));
    eq(settle, Object.fromEntries(Object.values(WF_TRIGGERS).filter((t: any) => t.settleMs).map((t: any) => [t.key, t.settleMs])), "SQL settle times = the registry's settleMs");
    ok(!/to_jsonb\(new\)|row_to_json\(new\)/.test(tx.split("\n").filter((l: string) => !/^\s*--/.test(l)).join("\n")), "no capture serialises the whole row");
    const caps = [...tx.matchAll(/create or replace function public\.(automation_capture_[a-z]+)\(\) returns trigger([\s\S]*?)end \$\$;/g)];
    eq([caps.length, caps.filter((m) => /exception when others then\s+begin[\s\S]*capture_errors = capture_errors \+ 1[\s\S]*exception when others then null;/.test(m[2])
      && m[2].includes("current_setting('automation.capture_test_error', true) = 'on'") && /security definer/.test(m[2]) && m[2].includes("from public.automation_wanted wt")).length,
      (tx.match(/create trigger automation_capture after/g) || []).length], [6, 6, 6], "six capture triggers: silent unless wanted, a failure only counted (nested handler), test hook");
    eq(caps.filter((m) => /update public\.automation_state set capture_errors = capture_errors \+ 1[\s\S]*?where business_id = \(select z\.business_id from public\.automation_state z where[^;]*for update skip locked\);/.test(m[2])
      && !/where business_id = coalesce\(b, public\.current_business_id\(\)\);/.test(m[2])).length, 6, "the failure counter never waits for the automation_state row (SKIP LOCKED): a capture failure never holds up or cancels the save");
    // the v2-only columns are out of the app's reach until Part 2 / 3 (a direct write never sets definition & co.)
    const pin = ws(fnBody(tx, "automations_v2_pin")), pinned = ["definition", "settings", "origin", "revision", "published_at", "published_by", "enrolled_total", "system_key", "system_handover_at", "list_summary"];
    ok(tx.includes("create trigger automations_a_v2_pin before insert or update on public.automations") && ["automations_customer_off_guard", "automations_guard"].every((g) => "automations_a_v2_pin" < g)
      && pin.includes("if current_user::text not in ('authenticated', 'anon') then return new; end if;") && pin.includes("new.definition := null;")
      && pinned.every((c) => pin.includes(`new.${c} := old.${c};`)) && pinned.every((c) => new RegExp(`new\\.${c} := (null|'\\{\\}'::jsonb|'user'|1|0);`).test(pin)),
      "automations_a_v2_pin runs first and keeps the app's roles away from the doc and the other v2-only columns (INSERT: defaults; UPDATE: kept)");
    ok(rb.includes("drop trigger if exists automations_a_v2_pin on public.automations;") && rb.indexOf("drop function if exists public.automations_v2_pin();") < rb.indexOf("drop column if exists definition"),
      "ROLLBACK drops the pin before the columns");
    // the check constraints accept every value the engine writes
    const listOf = (name: string) => { const m = new RegExp(`${name}\\s+check \\(\\w+ in \\(([^)]*)\\)\\)`).exec(tx); return m ? m[1].split(",").map((x) => x.trim().replace(/'/g, "")) : []; };
    const chans = [...new Set(Object.keys(WF_ACTIONS).map((k) => wfLogChannel({ type: k })))];
    eq(chans.filter((c) => !listOf("automation_log_channel_v2").includes(c)), [], "every log channel the executor writes is allowed");
    const engineSrc = src("index.ts");
    const stepStatuses = [...new Set([...engineSrc.matchAll(/stepRow\([^;]*?, "([a-z_]+)"/g)].map((m) => m[1]))];
    const written = [...new Set([...stepStatuses, ...Object.values(WF_EXIT_STATUS), "sending", "sent", "queued", "waiting_phone", "skipped", "failed", "added"])];
    ok(stepStatuses.length >= 4, "the step statuses are found in the executor", stepStatuses);
    eq(written.filter((s0) => !listOf("automation_log_status_v2").includes(s0)), [], "every log status the executor (and enroll / stop) writes is allowed");
    eq(["waiting", "running", ...Object.keys(WF_EXIT_STATUS)].filter((s0) => !listOf("automation_runs_status_v2").includes(s0)), [], "every run state is allowed");
    const kinds = [...new Set([...Object.keys(PROVIDES), ...Object.values(WF_TRIGGERS).map((t: any) => t.recordKind)])];
    eq(kinds.filter((k) => !listOf("automation_runs_record_kind_v2").includes(k)), [], "every record kind of a trigger is allowed on runs");
    // RLS on every table Part 1 creates; engine RPCs for the service role only; read RPCs security invoker
    const made = [...tx.matchAll(/create table if not exists public\.(\w+) \(/g)].map((m) => m[1]);
    eq(made.filter((t) => !tx.includes(`alter table public.${t} enable row level security;`)), [], "RLS is enabled on every new table");
    ok(made.length >= 16, "Part 1 makes the design's tables", made);
    const engineRpcs = ["automation_enroll", "automation_claim_events", "automation_wake", "automation_stop_on_reply", "automation_apply", "automation_prune", "automation_trigger_daily_add", "automation_claim_customer_v2"];
    eq(engineRpcs.filter((n0) => !new RegExp(`revoke all on function public\\.${n0}\\([^)]*\\) from public, anon, authenticated;`).test(tx) || !new RegExp(`grant execute on function public\\.${n0}\\([^)]*\\) to service_role;`).test(tx)), [],
      "engine RPCs: revoked from the app, granted to the service role");
    const readRpcs = ["automation_list_stats", "automation_trigger_stats", "automation_trigger_evals", "automation_unmatch_reasons", "automation_step_stats", "automation_enrollments",
      "automation_execution_log", "automation_log_steps", "automation_needs_review", "automation_mark_reviewed"];
    eq(readRpcs.filter((n0) => !/security invoker/.test(fnBody(tx, n0).split("$$")[0]) || !fnBody(tx, n0).includes("public.current_business_id()")), [], "read RPCs: security invoker, this business only");
    // the ROLLBACK: the phase-4 claim verbatim, and everything Part 1 made goes again
    ok(ws(rb).includes(ws(fnBody(p4sql, "automation_claim_customer").replace(/^function/, "create or replace function"))) || ws(rb).includes(ws("create or replace " + fnBody(p4sql, "automation_claim_customer"))),
      "ROLLBACK restores the phase-4 automation_claim_customer byte for byte (whitespace aside)");
    ok(rb.includes("alter table public.automation_log add constraint automation_log_once unique (run_id, step_id);") && rb.includes("drop index if exists public.automation_log_action_once;"), "ROLLBACK swaps the log key back");
    const fns = [...new Set([...tx.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]))].filter((n0) => n0 !== "automation_claim_customer");
    eq(fns.filter((n0) => !rb.includes(`drop function if exists public.${n0}(`)), [], "ROLLBACK drops every function Part 1 made");
    eq(made.filter((t) => !rb.includes(`drop table if exists public.${t};`)), [], "ROLLBACK drops every table Part 1 made");
    const oldTables = ["automations", "automation_runs", "automation_log", "automation_settings", "automation_state", "contacts", "jobs", "tasks"];
    const idx = [...tx.matchAll(/create (?:unique )?index if not exists (\w+) on public\.(\w+)/g)].filter((m) => oldTables.includes(m[2])).map((m) => m[1]);
    eq(idx.filter((i0) => !rb.includes(`drop index if exists public.${i0};`)), [], "ROLLBACK drops every index Part 1 put on an existing table");
    let colsSeen = 0;
    const colProblems: string[] = [], noComments = (x: string) => x.replace(/--[^\n]*/g, "");
    const rbCode = noComments(rb);
    for (const st of noComments(tx).split(";")) {
      const m = /alter table public\.(\w+)\s+add column/.exec(st);
      if (!m) continue;
      for (const c of [...st.matchAll(/add column if not exists ("?\w+"?)/g)].map((x) => x[1])) if (++colsSeen && !new RegExp(`alter table public\\.${m[1]}[^;]*drop column if exists ${c.replace(/"/g, '\\"')}[,;\\s]`).test(rbCode)) colProblems.push(`${m[1]}.${c}`);
    }
    eq(colProblems, [], "ROLLBACK drops every column Part 1 added");
    eq([colsSeen, [...noComments(tx).matchAll(/add column if not exists/g)].length], [59, 59], "…all 59 added columns were checked");
    eq([...tx.matchAll(/add constraint (\w+)/g)].map((m) => m[1]).filter((c) => !rb.includes(`drop constraint if exists ${c};`)), [], "ROLLBACK drops every constraint Part 1 added");
    // the staging check script is there and covers the four checks the plan names
    const chk = src(SQL_DIR + "stage2-part1-staging-checks.sql");
    ok(["automation_claim_customer(", "automation.capture_test_error", "set local role authenticated", "has_column_privilege", "__undo__"].every((x) => chk.includes(x))
      && (chk.match(/raise notice 'PASS \d+/g) || []).length === 27 && chk.includes("automations_a_v2_pin") && chk.includes("for update skip locked")
      && chk.includes("PASS 19 — the guard v2") && chk.includes("PASS 20 — the ROLLBACK list") && chk.includes("PASS 21 — the SQL shape and arm keys") && chk.includes("PASS 22 — the list counts") && chk.includes("PASS 23 — Pause workflow") && chk.includes("PASS 24 — the template library") && chk.includes("PASS 25 — quiet imports") && chk.includes("PASS 26 — the lock: four columns for the app") && chk.includes("PASS 27 — the builder''s notes")
      && chk.includes("PASS 14 — event-store rows fit") && chk.includes("PASS 15 — a captured Lead changed event") && chk.includes("PASS 16 — Add to workflow run")
      && chk.includes("PASS 17 — the card''s atomic tag / note edits") && chk.includes("PASS 18 — the inbound link counter") && chk.includes("contact_tags_edit(c, array['VIP', 'vip']"),
      "the staging checks: phase-4 claim, forced capture failure, RLS as VA/technician, column privileges, the v2 column pin, the non-blocking counter (13 Part-1 checks) + the event store (G2.1: 2) + the logic steps' writes (G2.2: 1) + record writes / atomic edits / the link counter (G2.3: 2) + the guard v2, the ROLLBACK list, the SQL keys (G2.4: 3) + the list counts per channel (G3.1: 1) + the pause guard and its wake (G3.2: 1) + the template library (G3.3: 1) + quiet imports, Assigned to, no Quote status (G3.5: 1) + the lock on direct writes (G3.4: 1) + the builder's notes as owner / manager / VA (G4.4: 1), all undone");
    {
      const block = (n0: number) => { const a0 = chk.indexOf(`\n-- ${n0}. `); return chk.slice(a0, chk.indexOf("\nend $$;", a0)); };
      ok([12, 19].every((n0) => { const b0 = block(n0); const g0 = b0.indexOf("elsif not has_table_privilege('authenticated', 'public.automations', 'INSERT') then"), r0 = b0.indexOf("execute 'set local role authenticated'");
        return g0 > 0 && r0 > g0 && b0.includes(`raise notice 'NOTE ${n0}: PART 3 · G3.4 is applied`); }),
        "staging checks 12 and 19 skip their signed-in insert once PART 3 · G3.4 took the app's INSERT away (else the run stops before PASS 26)");
    }
    // G2.2's staging check 16 calls the Part-1 functions with the engine's own argument lists (Add to workflow's enrolment, mark as read)
    const c16 = chk.slice(chk.indexOf("-- 16. (G2.2)"));
    ok(/automation_enroll\('default', b, 1, 1, null, 'wf:' \|\| r1::text \|\| ':n1:0', 'newLead', now\(\), 'contact', c::text, c, c::text, c::text, 'off', 'n1',\s+'\{"form":"website"\}'::jsonb, 'workflow', 1, r1, r1, false, now\(\), now\(\)\)/.test(c16)
      && c16.includes("status = 'running' and remove_requested = false") && c16.includes(`'[{"op":"read"}]'::jsonb`) && /raise exception '__undo__'/.test(c16),
      "staging check 16 (G2.2): the engine's Add-to-workflow enrolment, the guarded run write and mark as read, all undone");
  }

  // ── 29. the fake database's Part-1 keys and RPCs (the same rules as the SQL functions; staging check 5–7 do the same) ──
  {
    const db = world({ automations: [auto({ id: "wf1", name: "Flow 1", enrolled_total: 0 })] });
    const evRow = (o: any = {}) => ({ type: "newLead", event_key: "k", at: isoMs(NOW), available_at: isoMs(NOW), source: "scan", ...o });
    const e1 = await db.from("automation_events").insert(evRow()), e2 = await db.from("automation_events").insert(evRow());
    const e3 = await db.from("automation_events").upsert([evRow(), evRow({ event_key: "k2" }), evRow({ event_key: "k2" })], { onConflict: "business_id,type,event_key", ignoreDuplicates: true }).select("id");
    eq([e1.error, e2.error && e2.error.code, e2.error && /automation_events_once/.test(e2.error.message), e3.data.length, db.T.automation_events.map((e: any) => [e.event_key, e.status, e.attempts])],
      [null, "23505", true, 1, [["k", "new", 0], ["k2", "new", 0]]], "events: once per (business, type, key); upsert skips duplicates, also inside one batch; defaults");
    const bad = await db.from("automation_events").insert([evRow({ event_key: "k3" }), evRow({ event_key: "k3" })]);
    eq([bad.error && bad.error.code, db.T.automation_events.length], ["23505", 2], "an insert of two equal rows fails whole (one statement)");
    // the re-entry lock: one waiting/running run per (workflow, lock); it clears when the run ends
    const r1 = await db.from("automation_runs").insert({ id: "ra", business_id: "default", automation_id: "wf1", event_key: "e1", active_lock: "L", status: "waiting" });
    const r2 = await db.from("automation_runs").insert({ id: "rb", business_id: "default", automation_id: "wf1", event_key: "e2", active_lock: "L", status: "waiting" });
    const r3 = await db.from("automation_runs").insert({ id: "rc", business_id: "default", automation_id: "wf1", event_key: "e3", active_lock: null, status: "waiting" });
    const u1 = await db.from("automation_runs").update({ active_lock: "L" }).eq("id", "rc");
    await db.from("automation_runs").update({ status: "done" }).eq("id", "ra");
    const r4 = await db.from("automation_runs").insert({ id: "rd", business_id: "default", automation_id: "wf1", event_key: "e4", active_lock: "L", status: "waiting" });
    eq([r1.error, r2.error && /automation_runs_active_lock/.test(r2.error.message), r3.error, u1.error && u1.error.code, db.T.automation_runs.find((r: any) => r.id === "rc").active_lock,
      db.T.automation_runs.find((r: any) => r.id === "ra").active_lock, r4.error, db.T.automation_runs.find((r: any) => r.id === "ra").loop],
      [null, true, null, "23505", null, null, null, 0], "runs: the partial lock key (insert and update), cleared when a run ends, defaults");
    // automation_enroll: the four outcomes + not_found; ledger, total, enroll row
    const en = (o: any = {}) => db.rpc("automation_enroll", { p_business: "default", p_automation: "wf1", p_version: 1, p_revision: 3, p_trigger: "t1", p_event_key: "x1", p_event_type: "newLead",
      p_event_at: isoMs(NOW), p_record_kind: "contact", p_record_id: "c9", p_contact: "c9", p_enroll_key: "c9", p_lock_key: "c9", p_reentry: "off", p_start: "n1", p_context: {}, p_source: "trigger",
      p_chain: 0, p_cause: null, p_parent: null, p_stop_on_reply: true, p_now: isoMs(NOW), ...o });
    const o1: any = await en(), o2: any = await en({ p_event_key: "x2", p_reentry: "after_exit" });
    const run1 = db.T.automation_runs.find((r: any) => o1.data === `enrolled:${r.id}`);
    eq([o1.data.startsWith("enrolled:"), o2.data, run1 && [run1.status, run1.active_lock, run1.cursor_step, run1.due_at, run1.revision, run1.stop_on_reply, run1.loop]],
      [true, "already_enrolled", ["waiting", "c9", "n1", isoMs(NOW), 3, true, 0]], "enroll: enrolled (the run at its start step, due at the event) / already_enrolled while active");
    await db.from("automation_runs").update({ status: "done" }).eq("id", run1.id);
    const o3: any = await en({ p_event_key: "x3" }), o4: any = await en({ p_event_key: "x3", p_reentry: "after_exit" }), o5: any = await en({ p_event_key: "x3", p_lock_key: null, p_reentry: "legacy_always" });
    const o6: any = await en({ p_business: "other" }), o7: any = await en({ p_event_key: "x9", p_due: isoMs(NOW + HR), p_enroll_key: "c10", p_lock_key: "c10" });
    eq([o3.data, o4.data.startsWith("enrolled:"), o5.data, o6.data, db.T.automation_runs.find((r: any) => o7.data === `enrolled:${r.id}`).due_at],
      ["reentry_off", true, "duplicate_event", "not_found", isoMs(NOW + HR)], "enroll: reentry_off / after exit again / duplicate_event / another business / a manual start time");
    eq([db.T.automation_enrollment_keys.map((k: any) => `${k.enrollment_key}:${k.runs}`), db.T.automations[0].enrolled_total, db.T.automation_log.filter((l: any) => l.row_kind === "enroll").map((l: any) => `${l.step_id}:${l.status}`)],
      [["c9:2", "c10:1"], 3, ["t1:added", "t1:added", "t1:added"]], "enroll: the ledger, enrolled_total and one enroll log row per run");
    const wrong: any = await db.rpc("automation_enroll", { p_business: "default", p_automation: "wf1" });
    const extra: any = await db.rpc("automation_claim_events", { p_business: "default", p_now: isoMs(NOW), p_limit: 5, p_lease_s: 60, p_typo: 1 });
    ok(wrong.error && /missing/.test(wrong.error.message) && extra.error && /unknown p_typo/.test(extra.error.message), "the fake refuses arguments that do not fit the SQL signature", [wrong.error, extra.error]);
    // automation_claim_events: settle, leases, one record, done never
    db.T.automation_events = [];
    for (const [k, av, rec, st] of [["s1", NOW + 30e3, "r1", "new"], ["s2", NOW, "r1", "new"], ["s3", NOW, "r2", "new"], ["s4", NOW, "r1", "done"]] as [string, number, string, string][])
      await db.from("automation_events").insert(evRow({ event_key: k, available_at: isoMs(av), record_kind: "contact", record_id: rec, status: st }));
    const ce = async (ms: number, rec?: string) => ((await db.rpc("automation_claim_events", { p_business: "default", p_now: isoMs(ms), p_limit: 50, p_lease_s: 60, ...(rec ? { p_record_kind: "contact", p_record_id: rec } : {}) })).data || []).map((e: any) => e.event_key);
    eq([await ce(NOW, "r1"), await ce(NOW + 10e3, "r1"), await ce(NOW + 31e3, "r1"), await ce(NOW + 120e3, "r1"), await ce(NOW + 120e3)], [["s2"], [], ["s1"], ["s2", "s1"], ["s3"]],
      "claim_events: one record's due events; a lease holds; a settling event waits; expired leases come back; done never");
    // wake and stop on reply
    db.T.automation_runs = [
      { id: "w1", business_id: "default", automation_id: "wf1", contact_id: "c1", status: "waiting", due_at: isoMs(NOW + DAYMS), watch: ["customer_replied"], stop_on_reply: true, first_sent_at: isoMs(NOW - HR), cursor_step: "n2", steps_done: 3, loop: 0 },
      { id: "w2", business_id: "default", automation_id: "wf1", contact_id: "c1", status: "waiting", due_at: isoMs(NOW + DAYMS), watch: ["stage"], stop_on_reply: true, first_sent_at: isoMs(NOW + HR), active_lock: "c1" },
      { id: "w3", business_id: "default", automation_id: "wf1", contact_id: "c1", status: "done", due_at: isoMs(NOW + DAYMS), watch: ["customer_replied"], stop_on_reply: true, first_sent_at: isoMs(NOW - HR) },
      { id: "w4", business_id: "default", automation_id: "wf1", contact_id: "c2", status: "waiting", due_at: isoMs(NOW + DAYMS), watch: ["customer_replied"], stop_on_reply: true, first_sent_at: isoMs(NOW - HR), active_lock: "c2" }];
    const wk: any = await db.rpc("automation_wake", { p_business: "default", p_contact: "c1", p_types: ["customer_replied", "pause"], p_now: isoMs(NOW) });
    const wo: any = await db.rpc("automation_wake", { p_business: "other", p_contact: "c2", p_types: ["customer_replied"], p_now: isoMs(NOW) });
    eq([wk.data, wo.data, db.T.automation_runs.map((r: any) => r.due_at === isoMs(NOW))], [1, 0, [true, false, false, false]], "wake: this lead's waiting runs whose watch matches");
    db.T.automation_log = [];
    const sr: any = await db.rpc("automation_stop_on_reply", { p_business: "default", p_contact: "c1", p_reply_at: isoMs(NOW), p_now: isoMs(NOW) });
    eq([sr.data, db.T.automation_runs.map((r: any) => `${r.id}:${r.status}:${r.exit_reason ?? ""}`), db.T.automation_log.map((l: any) => `${l.run_id}:${l.row_kind}:${l.status}:${l.step_id}:${l.seq}:${l.reason}`)],
      [1, ["w1:stopped:replied", "w2:waiting:", "w3:done:", "w4:waiting:"], ["w1:exit:stopped:n2:3:Stopped: the lead replied"]], "stop on reply: only a run that sent before the reply; one exit row");
    eq(WF_REASONS.replied, "Stopped: the lead replied", "the SQL's exit reason is the engine's REASONS word");
    // the daily totals add up atomically
    await db.rpc("automation_trigger_daily_add", { p_business: "default", p_rows: [{ automation_id: "wf1", trigger_id: "t1", day: "2026-10-14", attempted: 3, matched: 1, enrolled: 1, reasons: { "filter:stage": 2 } }] });
    await db.rpc("automation_trigger_daily_add", { p_business: "default", p_rows: [{ automation_id: "wf1", trigger_id: "t1", day: "2026-10-14", attempted: 2, matched: 0, enrolled: 0, reasons: { "filter:stage": 1, test_record: 1 } }] });
    eq(db.T.automation_trigger_daily.map((d: any) => [d.attempted, d.matched, d.enrolled, d.reasons]), [[5, 1, 1, { "filter:stage": 3, test_record: 1 }]], "trigger_daily_add: counts and reasons add up");
  }

  // ── 30. the compat switch (G1.4, design §3.16): phase-4 scanners + enqueue, runs by advanceV2; phase 4's advance
  //        before SQL Part 1; never a guess on a failed read; a run crosses the switch either way without acting twice ──
  {
    // the database as it is before Part 1: automation_state has no phase4_compat column (or the read fails another way)
    const stateErr = (db: any, code: string, message: string) => ({ ...db, from: (t: string) => {
      const q = db.from(t);
      if (t !== "automation_state") return q;
      const sel = q.select;
      q.select = (cols?: string) => (cols && /phase4_compat/.test(cols) ? { eq: () => ({ maybeSingle: async () => ({ data: null, error: { code, message } }) }) } : sel(cols));
      return q;
    } });
    const noPart1 = (db: any) => stateErr(db, "42703", "column automation_state.phase4_compat does not exist");
    let spy = 0;
    const spyAdvance = async (...x: [any, any, any, number]) => { spy++; return await advanceV2(...x); };
    const kinds = (db: any) => db.T.automation_log.map((l: any) => l.row_kind ?? "action");

    // the deployed default: v2 executes (exit rows), the phase-4 scanners + enqueue started the run
    io.advance = PROD_ADVANCE; sent.length = 0;
    let db = world({ contacts: [lead("c1")], automations: [auto({ id: "a-cmp-0001" })] });
    let r: any = await tickAt(db, NOW);
    eq([r.engine, r.events, r.enqueued, logOf(db), kinds(db).filter((k: string) => k === "exit").length, db.T.automation_runs.map((x: any) => [x.status, x.exit_reason, x.event_key])],
      ["v2-compat", 1, 1, ["p1:sent"], 1, [["done", "end_of_workflow", "c1:new"]]], "compat switch: the deployed function runs the phase-4 event (same key) with advanceV2");
    eq((await engineMode(db)), { v2: true, compat: true, why: "v2 executor in compat mode (phase-4 scanners + enqueue, runs by advanceV2)" }, "engineMode: Part 1 in = v2 executor, compat producer");

    // before Part 1: phase 4's own advance, the io seam is never called, no v2 rows
    io.advance = spyAdvance; spy = 0; sent.length = 0;
    const raw = world({ contacts: [lead("c1")], automations: [auto({ id: "a-cmp-0002" })] });
    db = noPart1(raw);
    r = await tickAt(db, NOW);
    eq([r.engine, spy, logOf(raw), kinds(raw), sent.length, runOf(raw)], ["phase4", 0, ["p1:sent"], ["action"], 1, ["done"]], "compat switch: before Part 1 the tick runs phase 4's advance (no v2 rows anywhere)");
    const raw2 = world({ contacts: [lead("c1")], automations: [auto({ id: "a-cmp-0003" })] });
    const ev: any = await handle(noPart1(raw2), { step: "event", type: "newLead", id: "c1" }, OWNER, false);
    eq([ev.body.statuses, spy, kinds(raw2)], [["done"], 0, ["action"]], "compat switch: the app's 'look now' takes the same switch");
    const raw3 = world({ contacts: [lead("c1")], automations: [auto({ id: "a-cmp-0004" })] });
    const ev3: any = await handle(raw3, { step: "event", type: "newLead", id: "c1" }, OWNER, false);
    eq([ev3.body.statuses, spy, kinds(raw3)], [["done"], 1, ["action", "exit"]], "compat switch: 'look now' after Part 1 runs advanceV2");

    // any other failure of the read: the tick stops (the lock is given back), nothing is guessed or started
    const raw4 = world({ contacts: [lead("c1")], automations: [auto({ id: "a-cmp-0005" })] });
    let err = "";
    try { await tickAt(stateErr(raw4, "57014", "canceling statement due to statement timeout"), NOW); } catch (e) { err = String((e as Error).message); }
    eq([/^automation_state not read: canceling statement/.test(err), raw4.T.automation_runs.length, raw4.T.automation_state[0].tick_lease_until, spy], [true, 0, null, 1], "compat switch: a failed read (not a missing column) stops the tick and frees the lock");
    const modeOf = async (code: string, message: string) => { try { return (await engineMode(stateErr(raw4, code, message))).v2 ? "v2" : "phase4"; } catch { return "stop"; } };
    eq([await modeOf("PGRST204", "Could not find the 'phase4_compat' column of 'automation_state' in the schema cache"), await modeOf("", "column automation_state.phase4_compat does not exist"),
      await modeOf("42501", "permission denied for column phase4_compat"), await modeOf("PGRST301", "JWT expired")], ["phase4", "phase4", "stop", "stop"],
      "engineMode: only 'the column is not there' means phase 4; any other error stops (never a guess)");

    // phase4_compat off (Part 2 step E): the event store starts the run (G2.1, section 31), still advanceV2
    const raw5 = world({ contacts: [lead("c1")], automations: [auto({ id: "a-cmp-0006" })], automation_state: [{ business_id: "default", tick_lease_until: null, pruned_on: null, phase4_compat: false }] });
    r = await tickAt(raw5, NOW);
    eq([r.engine, r.enqueued, logOf(raw5), spy, raw5.T.automation_events.map((e: any) => e.event_key)], ["v2-events", 1, ["p1:sent"], 2, ["c1:new"]], "compat switch: phase4_compat = false = the event store (same key), runs by advanceV2");

    // the function's log says which engine runs, once per change
    const said: string[] = [], log0 = console.log;
    console.log = (...x: any[]) => { said.push(x.join(" ")); };
    try { await engineMode(noPart1(raw)); await engineMode(noPart1(raw)); await engineMode(raw); await engineMode(raw); }
    finally { console.log = log0; }
    eq(said, ["automations engine: phase-4 executor (stage 2 SQL Part 1 not applied yet)", "automations engine: v2 executor in compat mode (phase-4 scanners + enqueue, runs by advanceV2)"], "engineMode: one log line per change of engine");

    // a run crosses the switch both ways (deploy: phase 4 → v2; rollback: v2 → phase 4) and ends exactly as phase 4 alone
    const steps = [{ id: "w1", kind: "wait", unit: "minutes", n: 10 }, { id: "p1", kind: "action", type: "push", to: { roles: ["owner"] }, title: "Lead {name}" },
      { id: "w2", kind: "wait", unit: "minutes", n: 10 }, { id: "t1", kind: "action", type: "task", title: "Call {name}" }, emailStep({ id: "e1" })];
    const trace = async (switchAt: ("p4" | "v2")[]) => {
      const w = world({ contacts: [lead("c1")], automations: [auto({ id: "a-cmp-0007", steps })] });
      sent.length = 0;
      const out: any[] = [];
      for (let k = 0; k < switchAt.length; k++) {
        await tickAt(switchAt[k] === "p4" ? noPart1(w) : w, NOW + k * 11 * MIN);
        const x = w.T.automation_runs[0];
        out.push([x.status, x.due_at, x.step_index]);
      }
      return { out, log: acts(w).map((l: any) => [l.step_id, l.channel, l.status, l.reason ?? null, l.recipient ?? null]), sent: sent.map((m) => m.msg.title), tasks: w.T.tasks.map((t: any) => t.title),
        mail: w.T.lead_messages.map((m: any) => [m.subject, m.body, m.email]) };
    };
    const p4only = await trace(["p4", "p4", "p4"]), there = await trace(["p4", "v2", "v2"]), back = await trace(["p4", "v2", "p4"]), v2only = await trace(["v2", "v2", "v2"]);
    eq([p4only.out.map((x: any) => x[0]), p4only.log.map((l: any) => `${l[0]}:${l[2]}`), p4only.sent.length, p4only.tasks.length, p4only.mail.length],
      [["waiting", "waiting", "done"], ["p1:sent", "t1:sent", "e1:queued"], 1, 1, 1], "cutover: the phase-4 reference run waits twice, pushes, adds a task, queues an email and ends");
    eq([there, back, v2only], [p4only, p4only, p4only], "cutover: phase 4 → v2 (deploy), v2 → phase 4 (rollback) and v2 alone give phase 4's runs, due times, log rows, pushes, tasks and emails");
    io.advance = PROD_ADVANCE;
  }

  // ── 31. the event store (G2.1, design §3.2–§3.3, §3.10, §8.1 #11): producers with watermarks and narrow time windows,
  //        the scheduler's catch-up, the capture list (automation_wanted), settle, the matcher (reasons, one trigger-log
  //        row per workflow × trigger × event, the 200 cap, the daily totals), enrolment through automation_enroll, the
  //        app's "look now", wake, Stop on response, the time guard ──
  {
    io.advance = PROD_ADVANCE;
    const ARMED = "2026-10-01T00:00:00.000Z";
    const NONE = { match: "all", segments: [{ match: "all", rules: [] }] };
    const F1 = (rules: any[]) => ({ match: "all", segments: [{ match: "all", rules }] });
    const pushN = (next: string | null = null, title = "Hi {name}") => ({ kind: "action", type: "internal_notification", config: { channel: "push", to: { roles: ["owner"] }, title }, out: { next } });
    let wfN = 0;
    const wf = (triggers: any[], nodes: any = { n1: pushN() }, settings: any = {}, o: any = {}) => {
      wfN++;
      return { id: `w${String(wfN).padStart(3, "0")}-0000-0000`, business_id: "default", name: `Workflow ${wfN}`, enabled: true, armed_at: ARMED, version: 1, revision: 1,
        created_by_name: "Olivia Owner", trigger: {}, steps: [], definition: { schema: 2, seq: 50, entry: Object.keys(nodes)[0] ?? null, triggers, nodes },
        settings: { reentry: "off", perRecord: true, ...settings }, deleted_at: null, ...o };
    };
    const evState = (o: any = {}) => [{ business_id: "default", tick_lease_until: null, pruned_on: null, phase4_compat: false, ...o }];
    const evWorld = (over: Record<string, any[]> = {}) => world({ automation_state: evState(), automation_events: [], automation_trigger_log: [], automation_trigger_daily: [],
      automation_enrollment_keys: [], automation_wanted: [], ...over });
    const capEv = (type: string, key: string, o: any = {}) => ({ id: `ev-${key}`, business_id: "default", type, event_key: key, record_kind: "contact", record_id: o.contact_id ?? "c1",
      contact_id: "c1", at: isoMs(NOW - MIN), available_at: isoMs(NOW - MIN), ctx: {}, source: "capture", chain_depth: 0, status: "new", attempts: 0, ...o });
    const tlog = (db: any) => db.T.automation_trigger_log.map((r: any) => `${r.event_key}:${r.matched ? "match" : "miss"}${r.reason ? ":" + r.reason : ""}`).sort();
    const daily = (db: any) => db.T.automation_trigger_daily.map((d: any) => ({ a: d.attempted, m: d.matched, e: d.enrolled, r: Object.fromEntries(Object.entries(d.reasons).sort()) }));
    const evStatus = (db: any) => db.T.automation_events.map((e: any) => `${e.event_key}:${e.status}`).sort();

    // pure helpers
    eq([evTriggerType("missedCall"), evTriggerType("stage"), evTriggerType("googleReview"), evSettleMs("stage"), evSettleMs("contact_changed")], ["call_details", "stage", "review_received", 30e3, 0],
      "event types: a phase-4 type fires its v2 trigger (missedCall → Call details); stage settles 30 s");
    {
      const AW = (t: any, ctx: any, id = "A") => triggerAddressedAway({ id: "t1", filters: NONE, ...t }, { ctx }, { id });
      const cd = { field: "lead.booked_for", when: "before", offset: { n: 1, unit: "days" }, at: "09:00" };
      eq([AW({ type: "scheduler" }, { wf_id: "A", trigger_id: "t1" }), AW({ type: "scheduler" }, { wf_id: "B", trigger_id: "t1" }), AW({ type: "scheduler", id: "t2" }, { wf_id: "A", trigger_id: "t1" }),
        AW({ type: "inbound_webhook" }, { _wf: "B", _trigger: "t1" }), AW({ type: "stale", config: { days: 7 } }, { days: 7 }), AW({ type: "stale", config: { days: 7 } }, { days: 3 }),
        AW({ type: "custom_date", config: cd }, { field: "lead.booked_for", offset_key: customDateKey(cd) }), AW({ type: "custom_date", config: cd }, { field: "lead.booked_for", offset_key: "x" }),
        AW({ type: "task_reminder", config: { before: { n: 30, unit: "minutes" } } }, { before: offPart({ n: 30, unit: "minutes" }) }), AW({ type: "task_reminder", config: { before: { n: 30, unit: "minutes" } } }, { before: "1h" }),
        AW({ type: "newLead" }, {})],
        [false, true, true, true, false, true, false, true, false, true, false],
        "an event made for one trigger (a slot, a webhook link) or one setting (stale days, date and offset, reminder offset) is never looked at by the others (no unmatched row, no daily count)");
    }
    const S0 = normWfSettings({ reentry: "off", perRecord: true });
    eq([enrollKeyOf(S0, { type: "jobClosed", record_kind: "job", record_id: "j1", contact_id: "c1", event_key: "j1" }), enrollKeyOf({ ...S0, perRecord: false }, { type: "jobClosed", record_kind: "job", record_id: "j1", contact_id: "c1", event_key: "j1" }),
      enrollKeyOf(S0, { type: "contact_changed", record_kind: "contact", record_id: "c1", contact_id: "c1", event_key: "k" }), enrollKeyOf(S0, { type: "scheduler", record_kind: "none", record_id: null, contact_id: null, event_key: "sched:w:t1:2026-10-14T09:00" }),
      enrollKeyOf(normWfSettings({ reentry: "legacy_always" }, { reentry: "legacy_always" }), { type: "newLead", record_kind: "contact", record_id: "c1", contact_id: "c1", event_key: "c1:new" })],
      [{ key: "job:j1", lock: "job:j1" }, { key: "c1", lock: "c1" }, { key: "c1", lock: "c1" }, { key: "sched:w:t1:2026-10-14T09:00", lock: "sched:w:t1:2026-10-14T09:00" }, { key: "c1", lock: null }],
      "enrolment key: per job / call / chat (Allow multiple jobs), else per lead, contactless = the event key; upgraded rows hold no lock");
    eq([reentryFor(S0, "stale"), reentryFor(S0, "newLead"), reentryFor({ ...S0, reentry: "after_exit" }, "newLead"), reentryFor({ ...S0, reentry: "legacy_always" }, "stale")],
      ["after_exit", "off", "after_exit", "legacy_always"], "re-entry: an alwaysReenter trigger enters again even with re-entry off");
    eq([customDateKey({ when: "before", offset: { n: 1, unit: "days" }, at: "08:30" }), customDateKey({ when: "on" }), customDateKey({ when: "after", offset: { n: 0, unit: "days" } })],
      ["before:1days@08:30", "on:0@09:00", "after:0@09:00"], "custom date key: when, offset, time (09:00 when not set)");
    eq([schedulerSlots({ freq: "daily", at: "09:00" }, syd("2026-10-13", 8), syd("2026-10-14", 9), "Australia/Sydney"),
      schedulerSlots({ freq: "weekly", days: [1, 3], at: "07:15" }, syd("2026-10-11", 0), syd("2026-10-18", 0), "Australia/Sydney"),
      schedulerSlots({ freq: "monthly", monthDays: [-1, 15], at: "10:00" }, syd("2026-10-14", 12), syd("2026-11-16", 0), "Australia/Sydney"),
      schedulerSlots({ freq: "daily", at: "09:00" }, syd("2026-10-14", 9), syd("2026-10-14", 9, 30), "Australia/Sydney")],
      [["2026-10-13T09:00", "2026-10-14T09:00"], ["2026-10-12T07:15", "2026-10-14T07:15"], ["2026-10-15T10:00", "2026-10-31T10:00", "2026-11-15T10:00"], []],
      "scheduler slots in (since, now]: daily, weekly days, monthly days (−1 = the last), a slot at since already went");
    eq(evRow({ key: "c1:new", type: "stage", recordKind: "contact", recordId: "c1", at: isoMs(NOW), contactId: "c1", ctx: { stage: "Quoted" } }, "scan"),
      { business_id: "default", type: "stage", event_key: "c1:new", record_kind: "contact", record_id: "c1", contact_id: "c1", at: isoMs(NOW), available_at: isoMs(NOW + 30e3), ctx: { stage: "Quoted" }, source: "scan" },
      "an event row: available_at = at + the type's settle time");
    eq([canEmitV2(OWNER, "payment_received"), canEmitV2(VA, "contact_changed"), canEmitV2(VA_NOCRM, "contact_changed"), canEmitV2(VA, "payment_received"), canEmitV2(TECH, "task_added"),
      canEmitV2(OWNER, "inbound_webhook"), canEmitV2(VA, "newLead"), canEmitV2(VA_NOCRM, "newLead"), canEmitV2(OWNER, "doc_expiring")],
      [true, true, false, false, false, false, true, false, false], "'look now' with the event store: owners and managers; the office by the record's kind; never a hook or a built-in-only type");
    eq(wfCatalogKey({ keys: { taskDone: "Finished" } }, "taskDone", "Done") + "|" + wfCatalogKey({}, "taskDone", "Done"), "Finished|Done", "renamed record values come from catalog.keys (= SQL automation_catalog_key)");

    // what is wanted: triggers, the events held runs listen for, a reply when Stop on response is on
    {
      const pubs = [wf([{ id: "t1", type: "contact_changed", filters: NONE }], { n1: { kind: "wait", type: "period", config: { n: 1, unit: "days" }, out: { next: "n2" } },
        n2: { kind: "goal", type: "tag_added", config: { tags: ["VIP"], ifNotMet: "continue" }, out: { next: "n3" } }, n3: pushN() }),
        wf([{ id: "t1", type: "newLead", filters: NONE }, { id: "t2", type: "stage", filters: NONE, disabled: true }], { n1: { kind: "wait", type: "conditions", config: { when: F1([{ field: "lead.email", op: "is_not_empty" }]) }, out: { next: "n2" } }, n2: pushN() }, { stopOnResponse: true }),
        auto({ id: "a-ev-legacy", trigger: { type: "missedCall", params: {} } })].map((a) => ({ a, R: runDocOf(a) }));
      eq([wfWatchTypes(pubs), wfWantedTypes(pubs)], [["contact_changed", "contact_tag", "customer_replied"], ["call_details", "contact_changed", "contact_tag", "customer_replied", "newLead"]],
        "wanted = enabled trigger types (a disabled trigger not) ∪ goal / condition-field wake events ∪ a reply when Stop on response is on");
      eq([callsBeyondMissed(pubs.slice(2)), callsBeyondMissed([...pubs, { a: null as any, R: runDocOf(wf([{ id: "t1", type: "call_details", filters: F1([{ field: "trigger.call_status", op: "is", v: "answered" }]) }])) }])],
        [false, true], "answered / outgoing calls are scanned only when a Call details trigger takes them (an upgraded missed-call trigger pins Missed)");
    }

    // a reused phase-4 scanner looks back the whole lookback every minute (as phase 4): a stage move whose time is 40
    // minutes old when it reaches the database (a retried save) is still caught though the watermark says a minute ago;
    // a time source goes on from its watermark
    {
      const A = wf([{ id: "t1", type: "stage", filters: NONE }]);
      const db = evWorld({ contacts: [lead("c1", { status: "Quoted", stage_changed_at: isoMs(NOW - 40 * MIN), created_at: "2026-10-01", messages: [{ at: "2026-10-01T00:00:00.000Z" }] })], automations: [A],
        automation_state: evState({ scan_marks: { stage: isoMs(NOW - MIN) } }) });
      await tickAt(db, NOW);
      eq(db.T.automation_events.filter((e: any) => e.type === "stage").map((e: any) => e.event_key), [`c1:Quoted:${isoMs(NOW - 40 * MIN)}`], "scan sources: the whole lookback each minute (a late stage move is not lost)");
    }

    // the switch: phase4_compat = false → the event store starts the run (same key), executed by advanceV2 in the same tick
    {
      const db = evWorld({ contacts: [lead("c1")], automations: [auto({ id: "a-ev-0001" })] });
      sent.length = 0;
      const r: any = await tickAt(db, NOW);
      eq([r.engine, r.events, r.inserted, r.matched, r.enqueued, logOf(db), db.T.automation_runs.map((x: any) => [x.status, x.event_key, x.trigger_id, x.cursor_step === null ? "end" : x.cursor_step])],
        ["v2-events", 1, 1, 1, 1, ["p1:sent"], [["done", "c1:new", "t1", "end"]]], "event store: a phase-4 row is started by the matcher (same event key) and runs in the same tick");
      eq([evStatus(db), db.T.automation_events[0].source, tlog(db), daily(db), db.T.automation_wanted.map((w: any) => w.event_type), db.T.automation_state[0].wanted_hash, Object.keys(db.T.automation_state[0].scan_marks)],
        [["c1:new:done"], "scan", ["c1:new:match"], [{ a: 1, m: 1, e: 1, r: {} }], ["newLead"], "newLead", ["arrivals"]], "…the event is done, logged once, counted; the capture list and the watermark are written");
      const calls0 = db.calls.length;
      const r2: any = await tickAt(db, NOW + 20e3);
      eq([r2.inserted, r2.claimed, db.T.automation_runs.length, db.calls.slice(calls0).filter((c: string) => c.startsWith("automation_wanted")).length], [0, 0, 1, 0],
        "second scan of the same minute inserts 0, claims 0; an unchanged capture list is not written again");
    }

    // matcher reasons (design §3.3): before_published (counted only), test_record, loop_guard, own_change, filter (GHL words),
    // enrolled, already_enrolled, reentry_off, duplicate_event — one trigger-log row each, the daily totals
    {
      const A = wf([{ id: "t1", type: "contact_changed", filters: F1([{ field: "service", op: "is", v: "Aircon" }]) }], { n1: { kind: "wait", type: "period", config: { n: 1, unit: "days" }, out: { next: "n2" } }, n2: pushN() });
      const B = auto({ id: "a-ev-0002", trigger: { type: "jobClosed", params: {} } });
      const db = evWorld({
        contacts: [lead("c1"), lead("c2", { tags: ["test"] }), lead("c3", { division: "s9q" })], automations: [A, B],
        automation_runs: [{ id: "r-old", business_id: "default", automation_id: B.id, automation_version: 1, event_key: "j9", event_type: "jobClosed", event_at: isoMs(NOW - 5 * MIN),
          record_kind: "job", record_id: "j9", contact_id: null, status: "done", step_index: 1, anchor_at: isoMs(NOW - 5 * MIN), due_at: isoMs(NOW - 5 * MIN), attempts: 1, context: {} }],
        automation_events: [
          capEv("contact_changed", "c1:chg:email:1", { at: isoMs(NOW - 3 * MIN), available_at: isoMs(NOW - 3 * MIN) }), capEv("contact_changed", "c1:chg:phone:2", { at: isoMs(NOW - 2 * MIN), available_at: isoMs(NOW - 2 * MIN) }),
          capEv("contact_changed", "c2:chg:email:3", { contact_id: "c2", record_id: "c2" }), capEv("contact_changed", "c1:chg:email:4", { chain_depth: 4 }),
          capEv("contact_changed", "c1:chg:email:5", { cause_automation_id: A.id, cause_run_id: "r-x", chain_depth: 1 }), capEv("contact_changed", "c1:chg:email:6", { at: "2026-09-30T23:00:00.000Z" }),
          capEv("contact_changed", "c3:chg:email:7", { contact_id: "c3", record_id: "c3" }),
          capEv("jobClosed", "j9", { contact_id: null, record_kind: "job", record_id: "j9", source: "scan", ctx: { jobDate: "2026-10-14" } }),
        ] });
      await tickAt(db, NOW);
      eq(tlog(db), ["c1:chg:email:1:match", "c1:chg:email:4:miss:loop_guard", "c1:chg:email:5:miss:own_change", "c1:chg:phone:2:match:already_enrolled", "c2:chg:email:3:miss:test_record",
        "c3:chg:email:7:miss:filter:service", "j9:match:duplicate_event"], "matcher: every reason, one row each; an event before publishing has no row");
      const f7 = db.T.automation_trigger_log.find((r: any) => r.event_key === "c3:chg:email:7");
      eq([f7.detail.text, f7.detail.received, f7.detail.expected], ["Filter not matched - Service - Received value: s9q, Expected value: Aircon", "s9q", "Aircon"], "filter reason in GHL's words, with the received and expected values");
      eq(daily(db).sort((x: any, y: any) => y.a - x.a), [{ a: 7, m: 2, e: 1, r: { already_enrolled: 1, before_published: 1, "filter:service": 1, loop_guard: 1, own_change: 1, test_record: 1 } },
        { a: 1, m: 1, e: 0, r: { duplicate_event: 1 } }], "daily totals: attempted 7, matched 2, enrolled 1, every reason counted (before_published only here)");
      eq([db.T.automation_runs.length, db.T.automation_enrollment_keys.map((k: any) => k.enrollment_key), evStatus(db).every((s: string) => s.endsWith(":done"))], [2, ["c1"], true], "one run enrolled (lead c1, ledger key c1); every event done");
      // the run ends; the same lead changes again: re-entry off → reentry_off (the ledger), never a second run
      db.T.automation_runs.find((r: any) => r.automation_id === A.id).status = "done"; db.T.automation_runs.find((r: any) => r.automation_id === A.id).active_lock = null;
      db.T.automation_events.push(capEv("contact_changed", "c1:chg:email:8"));
      await tickAt(db, NOW + MIN);
      eq([tlog(db).filter((x: string) => x.startsWith("c1:chg:email:8")), db.T.automation_runs.length], [["c1:chg:email:8:match:reentry_off"], 2], "re-entry off: a lead that went through never enters again");
      // a retried event (its lease ran out) never writes a second trigger-log row
      const e1 = db.T.automation_events.find((e: any) => e.event_key === "c1:chg:email:1"); e1.status = "new";
      await tickAt(db, NOW + 2 * MIN);
      eq([db.T.automation_trigger_log.filter((r: any) => r.event_key === "c1:chg:email:1").length, db.T.automation_runs.length], [1, 2], "one trigger-log row per (workflow, trigger, event), also after a retry");
    }

    // the unmatched cap: 250 unmatched events → 200 rows, all 250 counted
    {
      const A = wf([{ id: "t1", type: "contact_changed", filters: F1([{ field: "service", op: "is", v: "Nope" }]) }]);
      const cs = Array.from({ length: 250 }, (_, i) => lead(`u${i}`));
      const db = evWorld({ contacts: cs, automations: [A], automation_events: cs.map((c, i) => capEv("contact_changed", `${c.id}:chg:email:${i}`, { contact_id: c.id, record_id: c.id })) });
      await tickAt(db, NOW);
      eq([db.T.automation_trigger_log.length, daily(db)[0].a, daily(db)[0].r["filter:service"], db.T.automation_runs.length], [200, 250, 250, 0], "unmatched cap: 200 detail rows a trigger a day, every one counted");
      db.T.automation_events.push(capEv("contact_changed", "u0:chg:email:x", { contact_id: "u0", record_id: "u0" }));
      await tickAt(db, NOW + MIN);
      eq([db.T.automation_trigger_log.length, daily(db)[0].a], [200, 251], "…the cap holds across ticks (read from the daily totals)");
    }

    // settle: a stage move at t is not matched at t+10 s, matched at t+31 s (the app's Undo)
    {
      const T0 = NOW;
      const A = wf([{ id: "t1", type: "stage", filters: F1([{ field: "trigger.stage", op: "is", v: "Quoted" }]) }]);
      const db = evWorld({ contacts: [lead("c1", { status: "Quoted", stage_changed_at: isoMs(T0) })], automations: [A] });
      sent.length = 0;
      await tickAt(db, T0 + 10e3);
      eq([db.T.automation_events.length, db.T.automation_events[0].status, db.T.automation_runs.length], [1, "new", 0], "settle: produced at t+10 s, not matched yet");
      await tickAt(db, T0 + 31e3);
      eq([db.T.automation_runs.length, db.T.automation_runs[0].status, sent.length > 0, db.T.automation_runs[0].context], [1, "done", true, { stage: "Quoted" }], "settle: matched and run at t+31 s");
    }

    // settle + Undo: a stage move undone within its settle time ("the move stands" checked at match time) is dropped by
    // the matcher with its reason, never enrolled and then skipped; phase 4 never saw it either. A later real move does
    // not bring it back (a run enrolled anyway would have pushed after its 2-hour wait). The same world in compat mode
    // (phase 4's scanners): the same nothing.
    {
      const T0 = NOW, key = `c1:Quoted:${isoMs(T0)}`;
      const P4 = () => auto({ id: "a-undo-0001", trigger: { type: "stage", params: { stage: "Quoted" } },
        steps: [{ id: "w1", kind: "wait", unit: "hours", n: 2 }, { id: "p1", kind: "action", type: "push", to: { roles: ["owner"] }, title: "Quoted: {name}" }] });
      const play = async (ev: boolean) => {
        const cs = [lead("c1", { status: "Quoted", stage_changed_at: isoMs(T0) })];
        const db = ev ? evWorld({ contacts: cs, automations: [P4()] }) : world({ contacts: cs, automations: [P4()] });
        sent.length = 0;
        await tickAt(db, T0 + 10e3);
        Object.assign(db.T.contacts[0], { status: "New", stage_changed_at: isoMs(T0 - 3 * DAYMS) });   // the app's Undo: the old stage and its time
        await tickAt(db, T0 + 31e3);
        const mid = [db.T.automation_runs.length, ev ? evStatus(db) : null, ev ? tlog(db) : null, ev ? daily(db) : null];
        Object.assign(db.T.contacts[0], { status: "Booked", stage_changed_at: isoMs(T0 + HR) });   // a real move later: its time is past the undone move
        for (const t of [T0 + HR + 31e3, T0 + 2 * HR + MIN, T0 + 3 * HR]) await tickAt(db, t);
        return { mid, runs: db.T.automation_runs.length, sent: sent.length };
      };
      const ev = await play(true), p4 = await play(false);
      eq(ev.mid, [0, [`${key}:done`], [`${key}:miss:move_undone`], [{ a: 1, m: 0, e: 0, r: { move_undone: 1 } }]],
        "a stage move undone within its settle time: no run (the matcher drops it with its reason), the event done, counted");
      eq([ev.runs, ev.sent, p4.runs, p4.sent], [0, 0, 0, 0], "…a later real move never brings it back; phase 4 (compat) made no run and sent nothing either");
      eq(WF_REASONS.move_undone, "The stage move was undone", "the reason in words");
    }

    // two real moves within the settle time (Quoted, then Booked 5 s later; the first one seen by a tick while fresh): an
    // UPGRADED workflow keeps phase 4's view — only the lead's current move starts it, the first is dropped ("moved_on"),
    // as phase 4 (compat) never saw it; a native v2 doc fires on every move (GHL). Quoted → Booked → Quoted again within
    // the settle time: one run, for the last move (phase 4's own key).
    {
      const T0 = NOW, at = (ms: number) => isoMs(T0 + ms);
      const P4 = () => auto({ id: "a-mv-0001", trigger: { type: "stage", params: { stage: "Quoted" } }, steps: [{ id: "p1", kind: "action", type: "push", to: { roles: ["owner"] }, title: "Quoted: {name}" }] });
      const V2 = () => wf([{ id: "t1", type: "stage", filters: F1([{ field: "trigger.stage", op: "is", v: "Quoted" }]) }]);
      const play = async (ev: boolean, A: any, back: boolean) => {
        const cs = [lead("c1", { status: "Quoted", stage_changed_at: at(0) })];
        const db = ev ? evWorld({ contacts: cs, automations: [A] }) : world({ contacts: cs, automations: [A] });
        const move = (status: string, ms: number) => Object.assign(db.T.contacts[0], { status, stage_changed_at: at(ms) });
        sent.length = 0;
        await tickAt(db, T0 + 3e3);   // the first move, seen while fresh (the event store keeps it as an event)
        move("Booked", 5e3);
        await tickAt(db, T0 + 8e3);
        if (back) move("Quoted", 10e3);
        for (const t of [T0 + 31e3, T0 + 41e3, T0 + 2 * MIN, T0 + 3 * MIN]) await tickAt(db, t);
        LAST = db;
        return [db.T.automation_runs.map((r: any) => `${r.event_key}:${r.status}`), sent.length];
      };
      let LAST: any = null;
      const evUp = await play(true, P4(), false), upLog = tlog(LAST);
      eq([evUp, await play(false, P4(), false)], [[[], 0], [[], 0]], "upgraded: two moves within 30 s → no run in the event store, none in phase 4 (compat)");
      eq(upLog, [`c1:Booked:${at(5e3)}:miss:filter:trigger.stage`, `c1:Quoted:${at(0)}:miss:moved_on`], "…the first move dropped as 'moved_on' (the lead had already left it), the second does not match the trigger");
      eq(await play(true, V2(), false), [[`c1:Quoted:${at(0)}:done`], 1], "a native v2 doc: the same two moves → one run (every move fires, as GHL)");
      eq([await play(true, P4(), true), await play(false, P4(), true)], [[[`c1:Quoted:${at(10e3)}:done`], 1], [[`c1:Quoted:${at(10e3)}:done`], 1]],
        "upgraded: Quoted → Booked → Quoted within 30 s → one run, for the last move, in both engines");
      eq([WF_REASONS.moved_on, stageMoveCurrent({ status: "Quoted", stage_changed_at: at(0) }, { at: at(0), ctx: { stage: "Quoted" } }), stageMoveCurrent({ status: "Quoted", stage_changed_at: at(10e3) }, { at: at(0), ctx: { stage: "Quoted" } }),
        stageMoveCurrent({ status: "Booked", stage_changed_at: at(0) }, { at: at(0), ctx: { stage: "Quoted" } }), stageMoveCurrent(null, { at: at(0), ctx: { stage: "Quoted" } })],
        ["The lead had already moved to another stage", true, false, false, false], "the current move: the lead's stage now, moved there at the event's time");
    }

    // a slow minute (design §3.2): the 8-second produce budget counts from the start of produce (not of the tick); at least
    // one producer runs every tick and their order turns (scan_marks._next), so no source starves; the matcher looks at
    // at least one event a tick. A very slow database: every look at the clock costs 9 seconds.
    {
      const A = wf([{ id: "t1", type: "newLead", filters: NONE }, { id: "t2", type: "stage", filters: NONE }, { id: "t3", type: "jobClosed", filters: NONE }, { id: "t4", type: "chat", filters: NONE }]);
      const db = evWorld({ contacts: [lead("c1", { status: "Quoted", stage_changed_at: isoMs(NOW - 5 * MIN) })], automations: [A] });
      const T0: any = ctxOf(db), pubs = await publishedWorkflows(db, T0), wanted = new Set(wfWantedTypes(pubs));
      let n = 0;
      const ran = async (slow: boolean, at: number) => {
        const before = { ...db.T.automation_state[0].scan_marks };
        clock = at; n = 0;
        if (slow) io.now = () => clock + (++n) * 9e3;
        try { await produceEvents(db, T0, pubs, wanted, at, before); } finally { io.now = () => clock; }
        const marks = db.T.automation_state[0].scan_marks;
        return [Object.keys(marks).filter((k) => k !== "_next" && marks[k] !== before[k]).join(","), marks._next ?? null];
      };
      const slow: any[] = [];
      for (let k = 0; k < 5; k++) slow.push(await ran(true, NOW + k * MIN));
      eq(slow, [["arrivals", "stage"], ["stage", "jobClosed"], ["jobClosed", "chat"], ["chat", "arrivals"], ["arrivals", "stage"]],
        "slow minutes: one producer a tick at least, the next tick starting with the first one that did not run (round robin: none starves)");
      eq(db.T.automation_events.map((e: any) => e.type).sort(), ["newLead", "stage"], "…and their events are produced");
      const fast: any[] = [];
      for (let k = 0; k < 3; k++) fast.push(await ran(false, NOW + (10 + k) * MIN));
      eq(fast, [["arrivals,stage,jobClosed,chat", "jobClosed"], ["arrivals,stage,jobClosed,chat", "chat"], ["arrivals,stage,jobClosed,chat", "arrivals"]],
        "in time: every producer runs, and the first one turns by one each tick");
      // the whole tick: the load phase alone is over 8 s; the event is still produced, matched and run
      const db2 = evWorld({ contacts: [lead("c1")], automations: [auto({ id: "a-slow-0001" })] });
      sent.length = 0; clock = NOW; n = 0;
      io.now = () => clock + (++n) * 9e3;
      let r: any;
      try { r = await tick(db2, NOW); } finally { io.now = () => clock; }
      eq([r.events, r.matched, r.enqueued, logOf(db2), Object.keys(db2.T.automation_state[0].scan_marks || {})], [1, 1, 1, ["p1:sent"], ["arrivals"]],
        "a slow tick still produces its event, matches it and runs it (one producer wanted: no turn kept)");
    }

    // the app's "look now": a capture type claims that record's pending events; then the timer finds nothing more (one run)
    {
      const A = wf([{ id: "t1", type: "contact_changed", filters: NONE }]);
      const db = evWorld({ contacts: [lead("c1")], automations: [A], automation_events: [capEv("contact_changed", "c1:chg:email:1")] });
      sent.length = 0;
      const r: any = await handle(db, { step: "event", type: "contact_changed", id: "c1" }, VA, false);
      eq([r.status, r.body.runs, r.body.statuses], [200, 1, ["done"]], "look now (capture type): the record's pending event matched and its run moved at once");
      await tickAt(db, NOW);
      eq([db.T.automation_runs.length, sent.length, evStatus(db)], [1, 1, ["c1:chg:email:1:done"]], "…the timer then starts nothing more: app poke + capture = one run");
      const r403: any = await handle(db, { step: "event", type: "contact_changed", id: "c1" }, VA_NOCRM, false);
      eq(r403.status, 403, "look now: the office without CRM access may not");
      db.T.automation_events.push(capEv("contact_changed", "c1:chg:email:9", { available_at: isoMs(NOW + 20e3) }));
      const rs: any = await handle(db, { step: "event", type: "contact_changed", id: "c1" }, OWNER, false);
      eq([rs.body.reason, db.T.automation_runs.length], ["settling", 1], "look now: an event not due yet is 'settling' (the timer takes it)");
      // a scan type: built from the record, stored (source app), the scanner's later insert of the same key is nothing
      const B = auto({ id: "a-ev-0003", trigger: { type: "newLead", params: {} } });
      const db2 = evWorld({ contacts: [lead("c1")], automations: [B] });
      sent.length = 0;
      const r2: any = await handle(db2, { step: "event", type: "newLead", id: "c1" }, OWNER, false);
      await tickAt(db2, NOW + 30e3);
      eq([r2.body.runs, r2.body.statuses, db2.T.automation_events.map((e: any) => [e.event_key, e.source, e.status]), db2.T.automation_runs.length, sent.length], [1, ["done"], [["c1:new", "app", "done"]], 1, 1],
        "look now (scan type): stored as an app event, matched at once; the timer's scan of the same key adds nothing");
      const rc: any = await handle(world({ contacts: [lead("c1")], automations: [] }), { step: "event", type: "contact_changed", id: "c1" }, OWNER, false);
      eq([rc.status, rc.body.reason], [400, "unknown event"], "look now: a stage-2 type before the event store is unknown (compat mode keeps phase 4's five)");
    }

    // concurrent enrolment (design §8.1 #12): two enrolments at the same moment give one run; tick + look now give one run
    {
      const A = wf([{ id: "t1", type: "contact_changed", filters: NONE }], { n1: { kind: "wait", type: "period", config: { n: 1, unit: "days" }, out: { next: "n2" } }, n2: pushN() });
      const db = evWorld({ contacts: [lead("c1")], automations: [A] });
      const p = (key: string) => ({ p_business: "default", p_automation: A.id, p_version: 1, p_revision: 1, p_trigger: "t1", p_event_key: key, p_event_type: "contact_changed", p_event_at: isoMs(NOW),
        p_record_kind: "contact", p_record_id: "c1", p_contact: "c1", p_enroll_key: "c1", p_lock_key: "c1", p_reentry: "off", p_start: "n1", p_context: {}, p_source: "trigger", p_chain: 0,
        p_cause: null, p_parent: null, p_stop_on_reply: false, p_now: isoMs(NOW) });
      const got = await Promise.all([db.rpc("automation_enroll", p("k1")), db.rpc("automation_enroll", p("k2")), db.rpc("automation_enroll", p("k1"))]);
      eq([got.map((x: any) => String(x.data).replace(/:.*/, "")), db.T.automation_runs.length], [["enrolled", "already_enrolled", "already_enrolled"], 1], "concurrent enrolment: one run, the others already enrolled");
      const db2 = evWorld({ contacts: [lead("c1")], automations: [wf([{ id: "t1", type: "contact_changed", filters: NONE }])], automation_events: [capEv("contact_changed", "c1:chg:email:1")] });
      await Promise.all([tickAt(db2, NOW), handle(db2, { step: "event", type: "contact_changed", id: "c1" }, OWNER, false)]);
      eq([db2.T.automation_runs.length, db2.T.automation_trigger_log.length], [1, 1], "the timer and 'look now' at the same moment: one claim, one run, one log row");
    }

    // wake (a held run that listens for this kind of event looks again now) and Stop on response
    {
      const G = wf([{ id: "t1", type: "newLead", filters: NONE }], { n1: { kind: "wait", type: "period", config: { n: 2, unit: "days" }, out: { next: "n2" } },
        n2: { kind: "goal", type: "tag_added", config: { tags: ["VIP"], ifNotMet: "continue" }, out: { next: "n3" } }, n3: pushN() }, { stopOnResponse: true });
      const run = (id: string, o: any) => ({ id, business_id: "default", automation_id: G.id, automation_version: 1, revision: 1, trigger_id: "t1", event_key: id, event_type: "newLead",
        event_at: isoMs(NOW - DAYMS), record_kind: "contact", record_id: "c1", contact_id: "c1", status: "waiting", step_index: 0, anchor_at: isoMs(NOW - DAYMS), due_at: isoMs(NOW + DAYMS),
        attempts: 0, context: {}, cursor_step: "n1", steps_done: 1, ...o });
      const db = evWorld({ contacts: [lead("c1"), lead("c2")], automations: [G], automation_runs: [run("r-watch", { watch: ["contact_tag"] }), run("r-other", { watch: ["stage"] }),
        run("r-c2", { contact_id: "c2", record_id: "c2", watch: ["contact_tag"] }), run("r-sent", { watch: ["customer_replied"], stop_on_reply: true, first_sent_at: isoMs(NOW - HR) }),
        run("r-late", { watch: ["customer_replied"], stop_on_reply: true, first_sent_at: isoMs(NOW + MIN) })],
        automation_events: [capEv("contact_tag", "c1:tag:+:VIP:1", { ctx: { tag: "VIP", action: "added" } }), capEv("customer_replied", "msg:m1", { ctx: { channel: "email", at: isoMs(NOW - MIN) } })] });
      clock = NOW;
      const pubs = await publishedWorkflows(db, ctxOf(db) as any);
      const m = await matchEvents(db, ctxOf(db) as any, pubs, NOW, { started: NOW });
      const st = (id: string) => { const r = db.T.automation_runs.find((x: any) => x.id === id); return `${r.status}@${r.due_at === isoMs(NOW) ? "now" : "later"}`; };
      eq([m.done, st("r-watch"), st("r-other"), st("r-c2"), st("r-sent"), st("r-late")], [2, "waiting@now", "waiting@later", "waiting@later", "stopped@now", "waiting@now"],
        "wake: only this lead's held runs that watch the event; Stop on response: only a run that sent before the reply");
      eq(db.T.automation_log.filter((l: any) => l.row_kind === "exit").map((l: any) => [l.run_id, l.status, l.reason]), [["r-sent", "stopped", "Stopped: the lead replied"]], "…one exit row for the stopped run");
    }

    // the time guard: out of time, the claimed events go back as they were (this claim not counted) — all but the first:
    // the matcher looks at at least one event a tick, so a slow tick never starves it
    {
      const db = evWorld({ contacts: [lead("c1")], automations: [wf([{ id: "t1", type: "contact_changed", filters: NONE }])],
        automation_events: [capEv("contact_changed", "c1:chg:email:1", { attempts: 2 }), capEv("contact_changed", "c1:chg:email:2"), capEv("contact_changed", "c1:chg:email:3", { attempts: 1 })] });
      const T0: any = ctxOf(db), pubs = await publishedWorkflows(db, T0);
      clock = NOW;
      const m = await matchEvents(db, T0, pubs, NOW, { started: NOW - 21e3 });
      eq([m.claimed, m.done, m.returned, db.T.automation_events.map((e: any) => [e.event_key.slice(-1), e.status, e.attempts, e.lease_until ?? null]), db.T.automation_runs.length],
        [3, 1, 2, [["1", "done", 3, null], ["2", "new", 0, null], ["3", "new", 1, null]], 1],
        "time guard (20 s): already out of time, the first event is still matched (one a tick at least); the rest are handed back unchanged");
      // a failing event is retried, then given up after 5 attempts
      const db2 = evWorld({ contacts: [lead("c1")], automations: [wf([{ id: "t1", type: "contact_changed", filters: NONE }])],
        automation_events: [capEv("contact_changed", "c1:chg:email:1", { attempts: 4 }), capEv("contact_changed", "c1:chg:email:2")] });
      const bad = { ...db2, rpc: async (n: string, a: any) => (n === "automation_enroll" ? { data: null, error: { message: "boom" } } : await db2.rpc(n, a)) };
      const log0 = console.error; console.error = () => {};
      try { await matchEvents(bad, T0, await publishedWorkflows(db2, T0), NOW, { started: NOW }); } finally { console.error = log0; }
      eq(db2.T.automation_events.map((e: any) => [e.status, e.attempts, e.error]), [["error", 5, "boom"], ["new", 1, "boom"]], "a failing event: tried again next time, an error after 5 attempts");
    }

    // before SQL G3.5 (no contacts.assigned_user_id, or its ROLLBACK ran): the matcher's lead reads go again without it
    // and still enrol (never a batch that fails as a whole)
    {
      const db = evWorld({ contacts: [lead("c1")], automations: [wf([{ id: "t1", type: "contact_changed", filters: NONE }])], automation_events: [capEv("contact_changed", "c1:chg:email:1")] });
      const T0: any = ctxOf(db), pubs = await publishedWorkflows(db, T0);
      let refused = 0;
      const old = { ...db, from: (t: string) => { const q0: any = db.from(t); if (t !== "contacts") return q0; const sel = q0.select;
        q0.select = (c?: string, o?: any) => {
          if (!c || !c.includes("assigned_user_id")) return sel(c, o);
          refused++;
          const e: any = { in: () => e, eq: () => e, maybeSingle: () => e, then: (res: any, rej: any) => Promise.resolve({ data: null, error: { code: "42703", message: "column contacts.assigned_user_id does not exist" } }).then(res, rej) };
          return e;
        }; return q0; } };
      clock = NOW;
      const m = await matchEvents(old, T0, pubs, NOW, { started: NOW });
      eq([m.done, db.T.automation_runs.length, refused > 0, db.T.automation_events[0].status], [1, 1, true, "done"],
        "before SQL G3.5 the matcher reads the lead cards again without assigned_user_id and still enrols");
      const r1 = await readContactsV2(old, (q: any) => q.eq("id", "c1").maybeSingle());
      eq([r1.error, r1.data && r1.data.id], [null, "c1"], "readContactsV2: one card, read again without the G3.5 column");
    }

    // producers: watermarks narrow the window; 2,500 stale leads give each event once (paged); a second scan inserts 0
    {
      const N = 7;
      const cs = Array.from({ length: 2500 }, (_, i) => lead(`s${i}`, { status: "Quoted", stage_changed_at: isoMs(NOW - N * DAYMS - (i % 300) * MIN) }));
      const A = wf([{ id: "t1", type: "stale", config: { days: N }, filters: NONE }]);
      const db = evWorld({ contacts: [...cs, lead("s-new", { status: "Quoted", stage_changed_at: isoMs(NOW - 2 * DAYMS) }), lead("s-test", { tags: ["test"], status: "Quoted", stage_changed_at: isoMs(NOW - N * DAYMS) })], automations: [A] });
      const T0: any = ctxOf(db), pubs = await publishedWorkflows(db, T0), c0 = db.calls.length;
      clock = NOW;
      const p1 = await produceEvents(db, T0, pubs, new Set(["stale"]), NOW, {});
      const keys = db.T.automation_events.map((e: any) => e.event_key);
      eq([p1.produced, p1.inserted, new Set(keys).size, db.calls.slice(c0).filter((c: string) => c === "contacts.select").length, keys.includes(`s0:stale:${cs[0].stage_changed_at}:7`), db.T.automation_events.find((e: any) => e.record_id === "s0").at],
        [2500, 2500, 2500, 4, true, isoMs(Date.parse(cs[0].stage_changed_at) + 7 * DAYMS)], "stale: 2,500 leads in their stage for 7 days → 2,500 events, once each (3 pages + one look for imported leads, G3.5; a test lead and a fresh move not)");
      const p2 = await produceEvents(db, T0, pubs, new Set(["stale"]), NOW, db.T.automation_state[0].scan_marks);
      eq([p2.inserted, db.T.automation_events.length, db.T.automation_state[0].scan_marks.stale], [0, 2500, isoMs(NOW)], "a second scan of the same minute inserts 0 (the watermark: now)");
      const c1 = db.calls.length;
      await produceEvents(db, T0, pubs, new Set(["stale"]), NOW, db.T.automation_state[0].scan_marks);
      eq(db.calls.slice(c1).filter((c: string) => c === "automation_state.update").length, 0, "watermarks that did not move are not written again");
      // the watermark narrows the next scan to (mark − overlap, now]
      const seen: string[] = [];
      const spy = { ...db, from: (t: string) => { const q = db.from(t); const g = q.gte; q.gte = (k: string, v: any) => { if (t === "contacts") seen.push(`${k}>=${v}`); return g(k, v); }; return q; } };
      await produceEvents(spy, T0, pubs, new Set(["stale"]), NOW + 5 * MIN, { stale: isoMs(NOW) });
      eq(seen, [`stage_changed_at>=${isoMs(NOW - 30 * MIN - N * DAYMS)}`], "watermark: the next minute reads only (mark − 30 min overlap − 7 days, …]");
    }

    // the time producers: custom date, task reminder, scheduler (+ catch-up and the outage rule), website form, answered calls
    {
      const CD = wf([{ id: "t1", type: "custom_date", config: { field: "lead.booked_for", when: "before", offset: { n: 1, unit: "days" }, at: "09:00" }, filters: NONE }]);
      const TR = wf([{ id: "t1", type: "task_reminder", config: { before: { n: 30, unit: "minutes" } }, filters: NONE }]);
      const SC = wf([{ id: "t1", type: "scheduler", config: { freq: "daily", at: "09:00" }, filters: NONE }]);
      const FM = wf([{ id: "t1", type: "form_submitted", filters: NONE }]);
      const CL = wf([{ id: "t1", type: "call_details", filters: F1([{ field: "trigger.call_status", op: "is", v: "answered" }]) }]);
      const db = evWorld({
        contacts: [lead("c1", { booked_for: "2026-10-15" }), lead("c2", { booked_for: "2026-10-16" }), lead("c3", { messages: [{ at: isoMs(NOW - 2 * MIN), text: "Lead created automatically from the website form (Google Ads) — 2 units" }] })],
        tasks: [{ id: "k1", title: "Call back", status: "Open", due: "2026-10-14", contact_id: "c1" }, { id: "k2", title: "Done one", status: "Done", due: "2026-10-14", contact_id: "c1" }],
        calls: [{ id: "q1", from_number: "+61412345678", direction: "inbound", missed: false, status: "completed", started_at: isoMs(NOW - 3 * MIN), created_at: isoMs(NOW - 3 * MIN), contact_id: "c1" },
          { id: "q2", from_number: "+61412345678", direction: "inbound", missed: false, status: "ringing", started_at: isoMs(NOW - MIN), created_at: isoMs(NOW - MIN), contact_id: "c1" }],
        automations: [CD, TR, SC, FM, CL] });
      sent.length = 0;
      await tickAt(db, NOW);
      const byType = (t: string) => db.T.automation_events.filter((e: any) => e.type === t).map((e: any) => [e.event_key, e.at, e.source]);
      eq(byType("custom_date"), [["lead.booked_for:c1:2026-10-15:before:1days@09:00", isoMs(syd("2026-10-14", 9)), "time"]], "custom date: booked for tomorrow, 1 day before at 09:00 = today 09:00 (in the window); the day after not yet");
      eq(byType("task_reminder"), [["k1:due:2026-10-14:30minutes", isoMs(syd("2026-10-14", 8, 30)), "time"]], "task reminder: due today (09:00) − 30 minutes; a done task never");
      eq(byType("scheduler"), [[`sched:${SC.id}:t1:2026-10-14T09:00`, isoMs(syd("2026-10-14", 9)), "time"]], "scheduler: today's 09:00 slot (the first scan looks back lookback_hours)");
      eq(byType("form_submitted"), [["c3:form:new", isoMs(NOW - 2 * MIN), "scan"]], "website form: a new lead whose first entry is the website form's");
      eq(byType("call_details"), [["q1:answered", isoMs(NOW - 3 * MIN), "scan"]], "Call details: an answered call (a ringing one is not over yet)");
      eq(db.T.automation_runs.map((r: any) => `${r.event_type}:${r.record_kind}:${r.status}`).sort(), ["call_details:call:done", "custom_date:contact:done", "form_submitted:contact:done", "scheduler:none:done", "task_reminder:task:done"],
        "each produced event started its workflow's run (the scheduler's has no record)");
      // the scheduler catches up the slots it missed while the timer was down for a while, never beyond lookback_hours
      const said: string[] = [], log0 = console.log;
      console.log = (...x: any[]) => { said.push(x.join(" ")); };
      try {
        const db2 = evWorld({ automations: [SC], automation_state: evState({ scan_marks: { scheduler: isoMs(syd("2026-10-14", 8, 50)) } }) });
        await tickAt(db2, syd("2026-10-14", 11));
        const db3 = evWorld({ automations: [SC], automation_state: evState({ scan_marks: { scheduler: isoMs(syd("2026-10-12", 8)) } }) });
        await tickAt(db3, syd("2026-10-14", 18));
        eq([db2.T.automation_events.map((e: any) => e.ctx.slot), db3.T.automation_events.map((e: any) => e.ctx.slot)], [["2026-10-14T09:00"], []], "scheduler catch-up: a slot within lookback_hours is caught up; older ones (an outage) are not");
      } finally { console.log = log0; }
      eq(said.filter((x) => /scheduler: slots between/.test(x)).length, 1, "…and that is said once in the function's log");
    }

    // SQL pins: Part 2 step E is exactly the switch engineMode reads; every on-conflict target of the event store is a
    // unique key of Part 1; the step-E rollback closes what nobody will claim
    {
      const sqlAll = src(SQL_DIR + "stage2-automations.sql"), stepE = sqlAll.slice(sqlAll.indexOf("-- PART 2 · STEP E"), sqlAll.indexOf("-- END PART 2 · STEP E"));
      const live = stepE.split("\n").filter((l: string) => !/^\s*--/.test(l)).join("\n");
      eq([/^begin;$/m.test(live), /^update public\.automation_state set phase4_compat = false where business_id = public\.current_business_id\(\);$/m.test(live), /^commit;$/m.test(live),
        (live.match(/^(update|insert|delete|create|alter|drop|grant|revoke)\b/gm) || []).length],
        [true, true, true, 1], "Part 2 step E: one transaction, one statement (phase4_compat = false), nothing else changes");
      ok(/-- update public\.automation_state set phase4_compat = true, wanted_hash = null/.test(stepE) && /-- delete from public\.automation_wanted/.test(stepE)
        && /-- update public\.automation_events set status = 'done'[^\n]*\n-- +where business_id = public\.current_business_id\(\) and status in \('new', 'processing'\);/.test(stepE), "step E has its exact ROLLBACK (compat on, capture list emptied, open events closed)");
      const ev = src("index.ts"), sec = ev.slice(ev.indexOf("// ==== EVENTS"), ev.indexOf("// ==== COMPAT"));
      const targets = [...new Set([...sec.matchAll(/from\("(\w+)"\)\.upsert\([^;]*?onConflict: "([\w,]+)"/g)].map((m) => `${m[1]}(${m[2]})`))].sort();
      const sqlKey = (table: string, cols: string) => new RegExp(`create table if not exists public\\.${table} \\([\\s\\S]*?(unique|primary key) \\(${cols.split(",").join(", ")}\\)`).test(sqlAll);
      eq([targets, targets.filter((x) => { const m = /^(\w+)\(([\w,]+)\)$/.exec(x) as RegExpExecArray; return !sqlKey(m[1], m[2]); })],
        [["automation_events(business_id,type,event_key)", "automation_trigger_log(automation_id,trigger_id,event_key)", "automation_wanted(business_id,event_type)"], []],
        "every on-conflict target of the event store is a unique key / primary key of Part 1");
    }

    // the capture list follows what is published; compat mode (step E rolled back) empties it; a cached row is read again only when it changed
    {
      const A = wf([{ id: "t1", type: "contact_tag", filters: NONE }], undefined, {}, { updated_at: "2026-10-10T00:00:00.000Z" });
      const db = evWorld({ automations: [A] });
      await tickAt(db, NOW);
      const full0 = db.calls.filter((c: string) => c === "automations.select").length;
      await tickAt(db, NOW + MIN);
      const full1 = db.calls.filter((c: string) => c === "automations.select").length;
      eq([db.T.automation_wanted.map((w: any) => w.event_type), full1 - full0], [["contact_tag"], 1], "capture list = the published trigger types; an unchanged row is not read again (only the cheap list)");
      Object.assign(db.T.automations[0], { definition: { ...A.definition, triggers: [{ id: "t1", type: "note_added", filters: NONE }] }, updated_at: "2026-10-14T03:00:30.000Z" });
      await tickAt(db, NOW + 2 * MIN);
      eq([db.T.automation_wanted.map((w: any) => w.event_type), db.T.automation_state[0].wanted_hash], [["note_added"], "note_added"], "a changed row is read again: the capture list follows it (added and removed)");
      db.T.automations[0].enabled = false; db.T.automations[0].updated_at = "2026-10-14T03:01:30.000Z";
      await tickAt(db, NOW + 3 * MIN);
      eq([db.T.automation_wanted.length, db.T.automation_state[0].wanted_hash], [0, ""], "nothing published: nothing captured");
      db.T.automations[0].enabled = true; db.T.automations[0].updated_at = "2026-10-14T03:02:30.000Z";
      await tickAt(db, NOW + 4 * MIN);
      db.T.automation_state[0].phase4_compat = true;
      await tickAt(db, NOW + 5 * MIN);
      eq([db.T.automation_wanted.length, db.T.automation_state[0].wanted_hash], [0, null], "back in compat mode: the capture list is emptied (nobody claims captured events then)");
    }
  }

  // ── 32. logic nodes + settings (G2.2, design §3.5–§3.8, §3.10, §8.1 #5, #7, #12, #14–17, #19): If / else, Split (the
  //        sticky ledger), Goal (+ wake), Go to (visit caps), Add to / Remove from workflow, the reply / user-reply /
  //        conditions waits with their timeout branch, Stop on response, the time window, pauses, the re-entry ledger +
  //        per-record lock, Mark as read ──
  {
    io.advance = PROD_ADVANCE;
    const tz = "Australia/Sydney";
    const NONE = { match: "all", segments: [{ match: "all", rules: [] }] };
    const F1 = (rules: any[], match = "all") => ({ match: "all", segments: [{ match, rules }] });
    const tr1 = [{ id: "t1", type: "newLead", filters: NONE }];
    const quiet = [{ id: "t1", type: "task_added", filters: NONE }];   // a trigger nothing in these tests fires
    let wfK = 0;
    const flow = (nodes: any, settings: any = {}, o: any = {}) => {
      wfK++;
      return { id: `wf32-${String(wfK).padStart(4, "0")}`, business_id: "default", name: `Flow ${wfK}`, enabled: true, armed_at: "2026-10-01T00:00:00.000Z", version: 1, revision: 1,
        created_by_name: "Olivia Owner", trigger: {}, steps: [], definition: { schema: 2, seq: 60, entry: o.entry ?? Object.keys(nodes)[0], triggers: o.triggers ?? tr1, nodes },
        settings: { reentry: "off", perRecord: true, ...settings }, deleted_at: null, ...(o.row || {}) };
    };
    const runRow = (a: any, o: any = {}) => ({ id: "r32", business_id: "default", automation_id: a.id, automation_version: a.version, event_key: "c1:new", event_type: "newLead", event_at: isoMs(NOW),
      record_kind: "contact", record_id: "c1", contact_id: "c1", status: "waiting", step_index: 0, anchor_at: isoMs(NOW), due_at: isoMs(NOW), attempts: 0, context: {}, trigger_id: "t1",
      cursor_step: null, remove_requested: false, ...o });
    const push = (title: string, next: string | null = null) => ({ kind: "action", type: "internal_notification", config: { channel: "push", to: { roles: ["owner"] }, title }, out: { next } });
    const mail = (next: string | null = null) => ({ kind: "action", type: "send_email", config: { subject: "Hello {first_name}", body: "{hi}, thanks." }, out: { next } });
    const period = (n: number, unit: string, next: string | null) => ({ kind: "wait", type: "period", config: { n, unit }, out: { next } });
    const goal = (type: string, config: any, next: string | null) => ({ kind: "goal", type, config, out: { next } });
    const gotoN = (target: string) => ({ kind: "goto", type: "goto", config: { target }, out: {} });
    const br = (id: string, name: string, rules: any[]) => ({ id, name, when: F1(rules) });
    const ifn = (branches: any[], out: any, o: any = {}) => ({ kind: "if_else", type: "if_else", config: { branches, noneName: "Other", ...o }, out });
    const thisRun = (db: any, id = "r32") => db.T.automation_runs.find((r: any) => r.id === id);
    const rowsOf = (db: any, id = "r32") => db.T.automation_log.filter((l: any) => l.run_id === id);
    const trail = (db: any, id = "r32") => rowsOf(db, id).map((l: any) => `${l.step_id}:${l.row_kind}:${l.status}`);
    const titles = () => sent.map((x) => x.msg.title);
    const mails = (db: any) => db.T.lead_messages.filter((m: any) => m.direction === "out" && m.auto === true);
    // one advance, as the timer would (claimed: running, one more try); sb = a spy over db when given
    const step = async (db: any, ms: number, id = "r32", sb: any = db) => {
      const r = thisRun(db, id); Object.assign(r, { status: "running", attempts: (Number(r.attempts) || 0) + 1 });
      clock = ms; const p: any = await advanceV2(sb, { ...r }, ctxOf(db), ms); clock = NOW; return p;
    };
    const drive = async (db: any, ms: number, id = "r32", max = 400) => { let t = ms, p: any = null; for (let k = 0; k < max; k++) { p = await step(db, t, id); if (p.status !== "waiting") break; t = Date.parse(p.due_at); } return p; };
    const evWorld = (over: Record<string, any[]> = {}) => world({ automation_state: [{ business_id: "default", tick_lease_until: null, pruned_on: null, phase4_compat: false }], automation_events: [],
      automation_trigger_log: [], automation_trigger_daily: [], automation_enrollment_keys: [], automation_wanted: [], ...over });

    // ── If / else: the first true branch wins; None; an empty None ends the run (done), a migrated gate's ends it skipped ──
    {
      const A = flow({ n1: ifn([br("b1", "Gutters", [{ field: "service", op: "is", v: "s9q" }]), br("b2", "Aircon", [{ field: "service", op: "is", v: "Aircon" }]), br("b3", "Any email", [{ field: "has_email", op: "true" }])],
        { b1: "n2", b2: "n3", b3: "n4", none: "n5" }), n2: push("gutters"), n3: push("aircon"), n4: push("email"), n5: push("none") });
      let db = world({ contacts: [lead("c1")], automations: [A], automation_runs: [runRow(A)] });
      sent.length = 0;
      let p: any = await step(db, NOW);
      const b = () => rowsOf(db).find((l: any) => l.status === "branch").detail;
      eq([p.status, titles(), b().branch_id, b().branch_name, b().conds.map((x: any) => x.ok)], ["done", ["aircon"], "b2", "Aircon", [true]], "If / else: the first true branch wins (b2, before b3 which is true too)");
      db = world({ contacts: [lead("c1", { division: "Plumbing", email: null })], automations: [A], automation_runs: [runRow(A)] });
      sent.length = 0; p = await step(db, NOW);
      eq([p.status, titles(), b().branch_id, b().branch_name], ["done", ["none"], "none", "Other"], "If / else: no branch true → None (its own name)");
      const E = flow({ n1: ifn([br("b1", "Has email", [{ field: "has_email", op: "true" }])], { b1: "n2", none: null }), n2: push("x") });
      db = world({ contacts: [lead("c1", { email: null })], automations: [E], automation_runs: [runRow(E)] });
      p = await step(db, NOW);
      eq([p.status, p.exit_reason, trail(db)], ["done", "end_of_workflow", ["n1:step:branch", "n1:exit:finished"]], "an empty None on a normal If / else = the end (done)");
      const Gt = flow({ n1: ifn([br("b1", "Yes", [{ field: "has_email", op: "true" }])], { b1: "n2", none: null }, { gate: true }), n2: push("x") });
      db = world({ contacts: [lead("c1", { email: null })], automations: [Gt], automation_runs: [runRow(Gt)] });
      p = await step(db, NOW);
      eq([p.status, p.reason, p.exit_reason], ["skipped", "condition: has_email", "condition"], "a migrated gate If (gate: true) with an empty None ends the run skipped (phase-4 words)");
    }

    // ── Split: 50/50 within ±2% over 10,000 leads; two Splits in a row independent; 0% never; the sticky ledger ──
    {
      const P50 = [{ id: "p1", percent: 50 }, { id: "p2", percent: 50 }];
      let a1 = 0; const leaf: Record<string, number> = {};
      for (let k = 0; k < 10000; k++) {
        const x = splitPath(P50, wfHash32(`w1:n1:c${k}`) % 100), y = splitPath(P50, wfHash32(`w1:n2:c${k}`) % 100);
        if (x === "p1") a1++;
        leaf[`${x}${y}`] = (leaf[`${x}${y}`] || 0) + 1;
      }
      ok(Math.abs(a1 - 5000) <= 200, "Split: 10,000 leads land within ±2% of 50/50", a1);
      ok(Object.keys(leaf).length === 4 && Object.values(leaf).every((n) => Math.abs(n - 2500) <= 250), "two Splits in a row are independent (≈25% per leaf)", leaf);
      let zero = 0; for (let k = 0; k < 1000; k++) if (splitPath([{ id: "p1", percent: 0 }, { id: "p2", percent: 100 }], wfHash32(`w1:n1:z${k}`) % 100) === "p1") zero++;
      eq([zero, splitPath([{ id: "p1", percent: 0 }, { id: "p2", percent: 0 }], 5), splitPath([{ id: "p1", percent: 30 }, { id: "p2", percent: 30 }], 99), wfHash32("abc") === wfHash32("abc")],
        [0, null, "p2", true], "a 0% path never takes anyone; no live path = null; percents short of 100 = the last live path; the hash is stable");
      const S = flow({ n1: { kind: "split", type: "split", config: { paths: [{ id: "p1", name: "A", percent: 50 }, { id: "p2", name: "B", percent: 50 }] }, out: { p1: "n2", p2: "n3" } }, n2: push("A"), n3: push("B") });
      let key = "";
      for (let k = 0; k < 500 && !key; k++) { const bk = wfHash32(`${S.id}:n1:k${k}`) % 100; if (bk >= 10 && bk < 50) key = `k${k}`; }   // path A at 50/50, path B at 10/90
      const db = world({ contacts: [lead("c1")], automations: [S], automation_runs: [runRow(S, { enrollment_key: key })],
        automation_enrollment_keys: [{ business_id: "default", automation_id: S.id, enrollment_key: key, first_at: isoMs(NOW), last_at: isoMs(NOW), runs: 1, splits: {} }] });
      sent.length = 0;
      await step(db, NOW);
      const det = (id: string) => rowsOf(db, id).find((l: any) => l.status === "branch").detail;
      eq([titles(), db.T.automation_enrollment_keys[0].splits, det("r32")], [["A"], { n1: "p1" }, { path_id: "p1", path_name: "A", percent: 50, kept: false }], "Split: the bucket's path; kept in the re-entry ledger; logged with its percent");
      // the owner changes the percents to 10 / 90; the same lead enters again: it keeps path A (GHL "keeps its path")
      const setPaths = (paths: any[]) => { const a = db.T.automations[0]; a.definition = { ...a.definition, nodes: { ...a.definition.nodes, n1: { ...a.definition.nodes.n1, config: { paths } } } }; };
      setPaths([{ id: "p1", name: "A", percent: 10 }, { id: "p2", name: "B", percent: 90 }]);
      db.T.automation_runs.push(runRow(S, { id: "r32b", event_key: "c1:again", enrollment_key: key }));
      sent.length = 0;
      await step(db, NOW, "r32b");
      eq([titles(), det("r32b").kept, det("r32b").percent], [["A"], true, 10], "after a % edit the lead keeps its path on re-entry");
      // the kept path now 0%: the bucket decides again (B) and the ledger follows
      setPaths([{ id: "p1", name: "A", percent: 0 }, { id: "p2", name: "B", percent: 100 }]);
      db.T.automation_runs.push(runRow(S, { id: "r32c", event_key: "c1:third", enrollment_key: key }));
      sent.length = 0;
      await step(db, NOW, "r32c");
      eq([titles(), db.T.automation_enrollment_keys[0].splits, det("r32c").kept], [["B"], { n1: "p2" }, false], "a kept path set to 0% is left: the bucket decides again, the ledger follows");
      // a run without a ledger key (phase-4 compat, a dry run) still splits by the same bucket, writing nothing
      const db2 = world({ contacts: [lead("c1")], automations: [flow(S.definition.nodes)], automation_runs: [] });
      db2.T.automation_runs.push(runRow(db2.T.automations[0]));
      sent.length = 0;
      await step(db2, NOW);
      eq([sent.length, (db2.T.automation_enrollment_keys || []).length], [1, 0], "no enrolment key: the bucket alone, nothing kept");
    }

    // ── Goal: met ahead during a period wait → jumped in the same tick (the wait's watch woke it); end / continue / wait;
    //    a goal inside a later branch; the event goals ──
    {
      const G = flow({ n1: period(1, "days", "n2"), n2: goal("stage_reached", { stages: ["Booked"], ifNotMet: "end" }, "n3"), n3: push("Booked!") }, {}, { triggers: quiet });
      const db = evWorld({ contacts: [lead("c1", { status: "Booked", stage_changed_at: isoMs(NOW - 2 * MIN), messages: [{ at: isoMs(NOW - DAYMS) }] })], automations: [G],
        automation_runs: [runRow(G, { cursor_step: "n1", steps_done: 1, anchor_at: isoMs(NOW - HR), due_at: isoMs(NOW + DAYMS - HR), watch: ["stage", "lead_status"], recheck: false,
          active_lock: "c1", enrollment_key: "c1", context: { _w: { id: "n1", loop: 0, startedAt: isoMs(NOW - HR), until: isoMs(NOW + DAYMS - HR) } } })] });
      sent.length = 0;
      const r: any = await tickAt(db, NOW);
      eq([r.engine, thisRun(db).status, titles(), trail(db), rowsOf(db).find((l: any) => l.status === "jumped").detail],
        ["v2-events", "done", ["Booked!"], ["n1:step:jumped", "n2:step:executed", "n3:action:sent", "n3:exit:finished"], { to: "n2", goal: true, skipped: [] }],
        "a goal met during a period wait: the stage event wakes the run and it jumps to the goal in the same tick");
      ok(db.T.automation_wanted.some((w: any) => w.event_type === "stage") && db.T.automation_events.some((e: any) => e.type === "stage"), "…the goal's events are wanted, so the stage move was produced");
      clock = NOW;
      // If the goal is not met: end / continue / wait
      const mk = (ifNotMet: string) => { const A = flow({ n1: goal("stage_reached", { stages: ["Booked"], ifNotMet }, "n2"), n2: push("after") }); return { A, db: world({ contacts: [lead("c1")], automations: [A], automation_runs: [runRow(A)] }) }; };
      let w = mk("end"); sent.length = 0;
      let p: any = await step(w.db, NOW);
      eq([p.status, p.reason, p.exit_reason, titles(), rowsOf(w.db)[0].detail], ["done", "goal not met", "goal_not_met", [], { met: false, then: "end" }], "goal not met, 'end the workflow': done, nothing after it runs");
      w = mk("continue"); sent.length = 0; p = await step(w.db, NOW);
      eq([p.status, titles(), rowsOf(w.db)[0].detail], ["done", ["after"], { met: false, then: "continue" }], "goal not met, 'continue': the next step runs");
      w = mk("wait"); sent.length = 0; p = await step(w.db, NOW);
      eq([p.status, p.due_at, p.recheck, p.watch, p.cursor_step, titles()], ["waiting", isoMs(NOW + HR), true, ["stage", "lead_status"], "n1", []], "goal not met, 'wait': held (its events wake it, an hourly recheck)");
      p = await step(w.db, NOW + HR);
      w.db.T.contacts[0].status = "Booked";
      p = await step(w.db, NOW + HR + 5 * MIN);
      eq([p.status, titles(), trail(w.db)], ["done", ["after"], ["n1:step:waiting", "n1:step:executed", "n2:action:sent", "n2:exit:finished"]], "…and goes on once it is met (one waiting row for the whole wait)");
      // a goal inside a later branch is ahead too
      const B = flow({ n1: period(1, "hours", "n2"), n2: ifn([br("b1", "Has email", [{ field: "has_email", op: "true" }])], { b1: "n3", none: null }), n3: goal("stage_reached", { stages: ["Booked"], ifNotMet: "end" }, "n4"), n4: push("in a branch") });
      const db3 = world({ contacts: [lead("c1")], automations: [B], automation_runs: [runRow(B)] });
      sent.length = 0;
      const h: any = await step(db3, NOW);
      db3.T.contacts[0].status = "Booked";
      p = await step(db3, NOW + 10 * MIN);
      eq([h.watch, p.status, titles(), rowsOf(db3).find((l: any) => l.status === "jumped").detail], [["stage", "lead_status"], "done", ["in a branch"], { to: "n3", goal: true, skipped: ["n2"] }],
        "a goal inside a later branch: watched, and jumped to (the If / else between is passed over)");
      // the event goals read what happened since the run started (f.since); state goals the card as it is
      const gdb = world({ contacts: [lead("c1"), lead("c2")], tasks: [{ id: "k1", title: "Call", status: "Open", contact_id: "c1", created_at: isoMs(NOW - MIN) }],
        automation_events: [
          { id: "e1", business_id: "default", type: "form_submitted", contact_id: "c1", record_id: "c1", at: isoMs(NOW - MIN), ctx: {} },
          { id: "e2", business_id: "default", type: "contact_tag", contact_id: "c1", record_id: "c1", at: isoMs(NOW - MIN), ctx: { tag: "VIP", action: "removed" } },
          { id: "e3", business_id: "default", type: "booking_status", contact_id: "c1", record_id: "c1", at: isoMs(NOW - MIN), ctx: { status: "rescheduled" } },
          { id: "e4", business_id: "default", type: "form_submitted", contact_id: "c2", record_id: "c2", at: isoMs(NOW - 2 * DAYMS), ctx: {} },
          { id: "e5", business_id: "default", type: "payment_received", contact_id: "c1", record_id: "j1", at: isoMs(NOW - MIN), ctx: {} },
          { id: "e6", business_id: "default", type: "task_completed", contact_id: "c1", record_id: "k1", at: isoMs(NOW - MIN), ctx: {} },
          { id: "e7", business_id: "default", type: "documents_contracts", contact_id: null, record_id: "sup1", at: isoMs(NOW - MIN), ctx: {} }],
        lead_messages: [{ id: "m1", contact_id: "c1", direction: "out", auto: false, channel: "email", at: isoMs(NOW - MIN), author_id: "u-va" },
          { id: "m2", contact_id: "c2", direction: "out", auto: true, channel: "email", at: isoMs(NOW - MIN) }] });
      const fc = (cid: string | null, o: any = {}) => ({ contact: cid ? { id: cid, status: "Won", tags: ["vip"] } : null, cat: CATALOG, since: isoMs(NOW - HR), recordId: cid, ...o });
      const met = async (type: string, config: any, f: any) => !!(await WF_GOAL_MET[type]({ kind: "goal", type, config }, f, gdb));
      eq([await met("tag_added", { tags: ["VIP"] }, fc("c1")), await met("tag_added", { tags: ["Hot"] }, fc("c1")), await met("tag_removed", { tags: ["vip"] }, fc("c1")), await met("tag_removed", { tags: ["VIP"] }, fc("c2")),
        await met("stage_reached", { stages: ["Won"] }, fc("c1")), await met("lead_status", { statuses: ["won"] }, fc("c1")), await met("lead_status", { statuses: ["open"] }, fc("c1")),
        await met("lead_status", { statuses: ["lost"] }, fc("c1", { contact: { id: "c1", status: "Gone" }, cat: { ...CATALOG, keys: { stageLost: "Gone" } } })),
        await met("appointment", { statuses: ["rescheduled"] }, fc("c1")), await met("appointment", { statuses: ["cancelled"] }, fc("c1")),
        await met("payment", {}, fc("c1")), await met("payment", {}, fc("c2", { job: { payment_status: "Paid" } })), await met("payment", {}, fc("c2", { job: { payment_status: "Unpaid" } })),
        await met("form", {}, fc("c1")), await met("form", {}, fc("c2")), await met("user_replied", { channels: ["email"] }, fc("c1")), await met("user_replied", {}, fc("c2")),
        await met("task", { status: "created" }, fc("c1")), await met("task", { status: "completed" }, fc("c1")), await met("task", { status: "created" }, fc("c2")),
        await met("document", {}, fc(null, { recordId: "sup1" })), has(WF_GOAL_MET, "email_event")],
        [true, false, true, false, true, true, false, true, true, false, true, true, false, true, false, true, false, true, true, false, true, false],
        "goals: tags, stage, status (catalog keys), booking status, paid, form, office reply, task, agreement — events only since the run started; tracking goals never met");
    }

    // ── Go to: a tight loop fails at 10 visits; a weekly loop runs on (20 times); each pass claims its actions again ──
    {
      const T1 = flow({ n1: push("tick", "n2"), n2: gotoN("n1") });
      let db = world({ contacts: [lead("c1")], automations: [T1], automation_runs: [runRow(T1)] });
      sent.length = 0;
      let p: any = await step(db, NOW);
      eq([p.status, p.reason, p.exit_reason, sent.length, rowsOf(db).filter((l: any) => l.row_kind === "action").map((l: any) => l.loop), rowsOf(db).filter((l: any) => l.status === "jumped").length],
        ["failed", "loop guard: Go to ran 10 times without waiting", "loop_guard", 10, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 9], "a Go to loop with no wait fails at 10 visits (one claim per pass)");
      const W7 = flow({ n1: period(7, "days", "n2"), n2: push("weekly", "n3"), n3: gotoN("n1") });
      db = world({ contacts: [lead("c1")], automations: [W7], automation_runs: [runRow(W7)] });
      sent.length = 0;
      let t = NOW;
      for (let k = 0; k < 80 && sent.length < 20; k++) { p = await step(db, t); if (p.status !== "waiting") break; t = Date.parse(p.due_at); }
      eq([p.status, sent.length, p.loop, new Set(rowsOf(db).filter((l: any) => l.row_kind === "action").map((l: any) => l.loop)).size, p.cursor_step], ["waiting", 20, 20, 20, "n1"],
        "a weekly loop runs 20 times (the wait resets the visits; each week claims its message again)");
    }

    // ── Add to workflow: the target's run (parent, chain, trigger data only when asked); Draft / chain limit / itself ──
    {
      const Tg = flow({ n1: push("child {first_name}") });
      const add = (id: string, o: any = {}) => ({ kind: "workflow", type: "add_to_workflow", config: { workflowId: id, ...o }, out: { next: "n2" } });
      const Src = flow({ n1: add(Tg.id, { passTriggerData: true }), n2: push("after") });
      let db = world({ contacts: [lead("c1")], automations: [Src, Tg], automation_runs: [runRow(Src, { context: { form: "website", _pass: "x" }, chain_depth: 0 })], automation_enrollment_keys: [] });
      sent.length = 0;
      let p: any = await step(db, NOW);
      const kid = db.T.automation_runs.find((r: any) => r.automation_id === Tg.id);
      eq([p.status, titles(), kid && [kid.status, kid.source, kid.parent_run_id, kid.cause_run_id, kid.chain_depth, kid.cursor_step, kid.event_key, kid.context, kid.trigger_id, kid.due_at, kid.event_at],
        rowsOf(db).find((l: any) => l.step_id === "n1").detail],
        ["done", ["after"], ["waiting", "workflow", "r32", "r32", 1, "n1", "wf:r32:n1:0", { form: "website" }, null, isoMs(NOW), isoMs(NOW)], { workflow_id: Tg.id, run_id: kid && kid.id }],
        "Add to workflow: a run of the target at its first step, now; parent + chain + 1; the trigger data (not the engine's own marks)");
      sent.length = 0;
      const k1: any = await step(db, NOW, kid.id);
      eq([k1.status, titles(), rowsOf(db, kid.id).map((l: any) => l.trigger_id)], ["done", ["child Sam"], [null, null, null]], "…the added run goes (no trigger: no trigger id)");
      const Src0 = flow({ n1: add(Tg.id), n2: push("after") });
      db = world({ contacts: [lead("c1")], automations: [Src0, Tg], automation_runs: [runRow(Src0, { context: { form: "website" } })], automation_enrollment_keys: [] });
      await step(db, NOW);
      eq(db.T.automation_runs.find((r: any) => r.automation_id === Tg.id).context, {}, "without 'Pass trigger data' the added run gets none");
      const Dr = flow({ n1: push("draft") }, {}, { row: { enabled: false } });
      const SrcD = flow({ n1: add(Dr.id), n2: push("after") });
      db = world({ contacts: [lead("c1")], automations: [SrcD, Dr], automation_runs: [runRow(SrcD)] });
      sent.length = 0; p = await step(db, NOW);
      eq([p.status, titles(), rowsOf(db)[0].status, rowsOf(db)[0].reason, db.T.automation_runs.length], ["done", ["after"], "skipped", "target is a Draft", 1], "a Draft target: skipped 'target is a Draft', the workflow goes on");
      db = world({ contacts: [lead("c1")], automations: [Src, Tg], automation_runs: [runRow(Src, { chain_depth: 3 })] });
      p = await step(db, NOW);
      eq([rowsOf(db)[0].reason, db.T.automation_runs.length], ["Stopped a loop between workflows", 1], "the chain limit: a run at depth 3 adds nobody (loop guard)");
      // itself, re-entry off: this run holds the lock → already in it
      const Self = flow({ n1: add("wf32-self"), n2: push("after") }, {}, { row: { id: "wf32-self" } });
      db = world({ contacts: [lead("c1")], automations: [Self], automation_runs: [runRow(Self, { active_lock: "c1", enrollment_key: "c1" })], automation_enrollment_keys: [] });
      p = await step(db, NOW);
      eq([rowsOf(db)[0].reason, db.T.automation_runs.length], ["Already in this workflow", 1], "adding a lead to the workflow it is in (re-entry off): already enrolled");
      // itself with no lock (an upgraded workflow): the chain stops at depth 3
      const Self2 = flow({ n1: add("wf32-self2"), n2: push("after") }, { reentry: "legacy_always" }, { row: { id: "wf32-self2" } });
      db = world({ contacts: [lead("c1")], automations: [Self2], automation_runs: [runRow(Self2)], automation_enrollment_keys: [] });
      for (let k = 0; k < 10; k++) { const w = db.T.automation_runs.find((r: any) => r.status === "waiting"); if (!w) break; await step(db, NOW, w.id); }
      const depth3 = db.T.automation_runs.find((r: any) => r.chain_depth === 3);
      eq([db.T.automation_runs.map((r: any) => [r.chain_depth, r.status]), depth3 && rowsOf(db, depth3.id).find((l: any) => l.row_kind === "step" && l.step_id === "n1").reason], [[[0, "done"], [1, "done"], [2, "done"], [3, "done"]], "Stopped a loop between workflows"],
        "a workflow that adds itself stops at chain depth 3");
    }

    // ── Remove from workflow: every scope, by lead (not enrolment key); a running run ends removed at its next write ──
    {
      const rm = (scope: string, wid?: string) => ({ kind: "workflow", type: "remove_from_workflow", config: { scope, ...(wid ? { workflowId: wid } : {}) }, out: ["current", "all"].includes(scope) ? {} : { next: "n2" } });
      const B = flow({ n1: period(1, "days", null) }), Cw = flow({ n1: push("C ran", "n2"), n2: period(1, "days", null) });
      const setup = (scope: string) => {
        const A = flow({ n1: rm(scope, scope === "another" ? B.id : undefined), ...(["current", "all"].includes(scope) ? {} : { n2: push("after") }) });
        const db = world({ contacts: [lead("c1"), lead("c2")], automations: [A, B, Cw], automation_runs: [runRow(A),
          runRow(B, { id: "rB", event_key: "b1", due_at: isoMs(NOW + DAYMS), cursor_step: "n1", steps_done: 1, active_lock: "c1" }),
          runRow(Cw, { id: "rC", event_key: "c1x", status: "running", lease_until: isoMs(NOW + 2 * MIN) }),
          runRow(A, { id: "rA2", event_key: "a2", record_kind: "job", record_id: "j1", due_at: isoMs(NOW + DAYMS) }),
          runRow(B, { id: "rX", event_key: "x1", contact_id: "c2", record_id: "c2", due_at: isoMs(NOW + DAYMS) })] });
        return { A, db };
      };
      const states = (db: any) => db.T.automation_runs.map((r: any) => `${r.id}:${r.status}${r.remove_requested ? "*" : ""}`);
      let s = setup("another");
      sent.length = 0;
      let p: any = await step(s.db, NOW);
      eq([p.status, titles(), states(s.db), rowsOf(s.db, "rB").map((l: any) => `${l.row_kind}:${l.status}:${l.reason}`), rowsOf(s.db, "rB")[0].detail, rowsOf(s.db)[0].detail],
        ["done", ["after"], ["r32:done", "rB:removed", "rC:running", "rA2:waiting", "rX:waiting"], ["exit:removed:Removed by External Workflow Action"], { exit_reason: "removed_by_external_action", by_run: "r32" },
          { scope: "another", workflow_id: B.id, removed: 1 }], "Remove from 'another' workflow: that workflow's waiting run of this lead (exit row); this run goes on");
      ok(thisRun(s.db, "rB").exit_reason === "removed_by_external_action" && thisRun(s.db, "rB").active_lock === null, "…removed_by_external_action, its lock given back");
      s = setup("all_except_current");
      p = await step(s.db, NOW);
      eq([p.status, states(s.db)], ["done", ["r32:done", "rB:removed", "rC:running*", "rA2:waiting", "rX:waiting"]], "'all except current': the other workflows' runs (a running one flagged), never this workflow's");
      // the flagged running run: its own advance (claimed before the flag) ends removed at its next write
      sent.length = 0;
      const rc: any = await advanceV2(s.db, { ...thisRun(s.db, "rC"), remove_requested: false }, ctxOf(s.db), NOW);
      eq([rc.status, rc.exit_reason, thisRun(s.db, "rC").status, rowsOf(s.db, "rC").map((l: any) => `${l.row_kind}:${l.status}`)], ["removed", "removed_by_external_action", "removed", ["action:sent", "step:waiting", "exit:removed"]],
        "a run being moved when it was removed ends removed at its next write (one exit row)");
      s = setup("all");
      p = await step(s.db, NOW);
      eq([p.status, p.exit_reason, states(s.db), rowsOf(s.db).map((l: any) => `${l.row_kind}:${l.status}:${l.reason}`)],
        ["removed", "removed_by_action", ["r32:removed", "rB:removed", "rC:running*", "rA2:removed", "rX:waiting"], ["step:executed:null", "exit:removed:Removed by Workflow Action"]],
        "'all': every run of this lead (this workflow's other runs too) and this run (Removed by Workflow Action)");
      s = setup("current");
      p = await step(s.db, NOW);
      eq([p.status, p.exit_reason, states(s.db)], ["removed", "removed_by_action", ["r32:removed", "rB:waiting", "rC:running", "rA2:waiting", "rX:waiting"]], "'current': only this run ends");
      // a run flagged before its claim ends removed at once (nothing sent)
      const s2 = setup("current");
      Object.assign(thisRun(s2.db, "rC"), { status: "waiting", remove_requested: true, due_at: isoMs(NOW) });
      sent.length = 0;
      const rc2: any = await step(s2.db, NOW, "rC");
      eq([rc2.status, rc2.exit_reason, sent.length], ["removed", "removed_by_external_action", 0], "a run flagged before it was claimed ends removed at once");
    }

    // ── reply wait: met vs timeout, woken by the reply within one tick; the reply that lands while the run is leased ──
    {
      const W = flow({ n1: { kind: "wait", type: "reply", config: { channels: ["email", "chat"], timeout: { n: 3, unit: "days" } }, out: { next: "n2", timeout: "n3" } }, n2: push("replied"), n3: push("timed out") }, {}, { triggers: quiet });
      let db = evWorld({ contacts: [lead("c1")], automations: [W], automation_runs: [runRow(W, { active_lock: "c1", enrollment_key: "c1" })] });
      sent.length = 0;
      await tickAt(db, NOW);
      const r0 = { ...thisRun(db) };
      eq([r0.status, r0.due_at, r0.recheck, r0.watch, rowsOf(db).map((l: any) => [l.status, l.next_at]), db.T.automation_wanted.map((x: any) => x.event_type)],
        ["waiting", isoMs(NOW + HR), true, ["customer_replied"], [["waiting", isoMs(NOW + 3 * DAYMS)]], ["customer_replied", "task_added"]],
        "reply wait: held with an hourly recheck, watching replies (wanted), its timeout in the waiting row");
      db.T.lead_messages.push({ id: "m0", contact_id: "c1", direction: "in", channel: "text", at: isoMs(NOW + 5 * MIN) },   // not one of its channels
        { id: "m1", contact_id: "c1", direction: "in", channel: "email", at: isoMs(NOW + 10 * MIN) });
      db.T.automation_events.push({ id: "ev-m1", business_id: "default", type: "customer_replied", event_key: "msg:m1", record_kind: "contact", record_id: "c1", contact_id: "c1",
        at: isoMs(NOW + 10 * MIN), available_at: isoMs(NOW + 10 * MIN), ctx: { channel: "email", at: isoMs(NOW + 10 * MIN) }, source: "capture", chain_depth: 0, status: "new", attempts: 0 });
      await tickAt(db, NOW + 11 * MIN);
      eq([thisRun(db).status, titles(), rowsOf(db).find((l: any) => l.status === "wait_finished").detail], ["done", ["replied"], { outcome: "met", resumed_by: "event" }], "…the reply wakes it and it goes down 'Replied' in the same tick");
      clock = NOW;
      db = world({ contacts: [lead("c1")], automations: [W], automation_runs: [runRow(W)] });
      sent.length = 0;
      await step(db, NOW);
      const pt: any = await step(db, NOW + 3 * DAYMS);
      eq([pt.status, titles(), rowsOf(db).find((l: any) => l.status === "wait_finished").detail.outcome], ["done", ["timed out"], "timeout"], "no reply by its timeout → 'Timed out'");
      // the race: the reply lands after the check and before the hold is written (the wake found the run running)
      db = world({ contacts: [lead("c1")], automations: [W], automation_runs: [runRow(W)] });
      let sel = 0;
      const spy = { ...db, from: (t: string) => {
        const q = db.from(t);
        if (t !== "lead_messages") return q;
        const th = q.then;
        q.then = (res: any, rej: any) => th((x: any) => { if (++sel === 1) db.T.lead_messages.push({ id: "m9", contact_id: "c1", direction: "in", channel: "chat", at: isoMs(NOW + 1000) }); return res(x); }, rej);
        return q;
      } };
      sent.length = 0;
      const pr: any = await step(db, NOW, "r32", spy);
      eq([pr.status, pr.due_at, thisRun(db).due_at], ["waiting", isoMs(NOW + HR), isoMs(NOW)], "a reply that landed while the run was leased: looked at once more after the hold, the run is due at once");
      const pr2: any = await step(db, NOW);
      eq([pr2.status, titles()], ["done", ["replied"]], "…and goes down 'Replied' on its next claim");
    }

    // ── user reply: written by a chosen person, never an automatic message ──
    {
      const U = flow({ n1: { kind: "wait", type: "user_reply", config: { channels: ["email"], users: ["u-va"], timeout: { n: 1, unit: "days" } }, out: { next: "n2", timeout: "n3" } }, n2: push("office replied"), n3: push("nobody") });
      const db = world({ contacts: [lead("c1")], automations: [U], automation_runs: [runRow(U)] });
      sent.length = 0;
      await step(db, NOW);
      db.T.lead_messages.push({ id: "m1", contact_id: "c1", direction: "out", auto: true, channel: "email", at: isoMs(NOW + MIN) }, { id: "m2", contact_id: "c1", direction: "out", auto: false, channel: "email", at: isoMs(NOW + MIN), author_id: "u-mgr" });
      const p1: any = await step(db, NOW + 5 * MIN);
      db.T.lead_messages.push({ id: "m3", contact_id: "c1", direction: "out", auto: false, channel: "email", at: isoMs(NOW + 6 * MIN), author_id: "u-va" });
      const p2: any = await step(db, NOW + 10 * MIN);
      eq([p1.status, p2.status, titles()], ["waiting", "done", ["office replied"]], "user reply: an automatic message or another person's does not count; the chosen person's does");
    }

    // ── conditions wait: an event re-check; the moment a time-relative rule changes; a 7-day wait with < 20 steps ──
    {
      const Cn = flow({ n1: { kind: "wait", type: "conditions", config: { when: F1([{ field: "lead.email", op: "is_not_empty" }]) }, out: { next: "n2" } }, n2: push("has email") });
      let db = world({ contacts: [lead("c1", { email: null })], automations: [Cn], automation_runs: [runRow(Cn)] });
      sent.length = 0;
      const h: any = await step(db, NOW);
      db.T.contacts[0].email = "sam@example.com";
      const p: any = await step(db, NOW + 20 * MIN);
      eq([h.status, h.due_at, h.recheck, h.watch, p.status, titles(), rowsOf(db).filter((l: any) => l.status === "waiting").length], ["waiting", isoMs(NOW + HR), true, ["contact_changed"], "done", ["has email"], 1],
        "conditions wait: held (watching the fields' events, hourly recheck) until the conditions are met");
      const Ct = flow({ n1: { kind: "wait", type: "conditions", config: { when: F1([{ field: "lead.booked_for", op: "within_next", n: 2, unit: "hours" }]) }, out: { next: "n2" } }, n2: push("soon") });
      db = world({ contacts: [lead("c1", { booked_for: isoMs(NOW + 150 * MIN) })], automations: [Ct], automation_runs: [runRow(Ct)] });
      sent.length = 0;
      const h2: any = await step(db, NOW);
      const p2: any = await step(db, Date.parse(h2.due_at));
      eq([h2.due_at, p2.status, titles()], [isoMs(NOW + 30 * MIN + 1000), "done", ["soon"]], "a time-relative condition: held only until the moment it can turn true (not the hour)");
      const C7 = flow({ n1: { kind: "wait", type: "conditions", config: { when: F1([{ field: "lead.email", op: "is_not_empty" }]), timeout: { n: 7, unit: "days" } }, out: { next: "n2", timeout: "n3" } },
        n2: push("met"), n3: push("a week went by") });
      db = world({ contacts: [lead("c1", { email: null })], automations: [C7], automation_runs: [runRow(C7)] });
      sent.length = 0;
      const p7: any = await drive(db, NOW);
      eq([p7.status, titles(), p7.steps_done < 20, p7.steps_done, rowsOf(db).filter((l: any) => l.status === "waiting").length], ["done", ["a week went by"], true, 2, 1],
        "a 7-day conditions wait (hourly rechecks) times out with steps_done < 20 and one waiting row");
    }

    // ── the dry run: assumed outcomes, the timeout, else the path stops ("Would wait for a reply") ──
    {
      const W = flow({ n1: { kind: "wait", type: "reply", config: { channels: ["email"], timeout: { n: 2, unit: "days" } }, out: { next: "n2", timeout: "n3" } }, n2: push("replied"), n3: push("timed out") });
      const Wn = flow({ n1: { kind: "wait", type: "reply", config: { channels: ["email"] } }, n2: push("x") });
      Wn.definition.nodes.n1.out = { next: "n2" };
      const Gw = flow({ n1: goal("stage_reached", { stages: ["Booked"], ifNotMet: "wait" }, "n2"), n2: push("booked") });
      const sdb = world({ contacts: [lead("c1")], automations: [W, Wn, Gw] });
      const before = JSON.stringify(sdb.T);
      const rin = { record_kind: "contact", record_id: "c1", contact_id: "c1", event_type: "newLead", event_at: isoMs(NOW), trigger_id: "t1", context: {} };
      const path = (d: any) => d.path.filter((x: any) => x.rowKind !== "exit").map((x: any) => `${x.stepId}:${x.status}${x.outcome ? ":" + x.outcome : ""}`);
      const d1: any = await dryRunV2(sdb, W, rin, ctxOf(sdb), NOW), d2: any = await dryRunV2(sdb, W, rin, ctxOf(sdb), NOW, 200, { n1: "met" });
      const d3: any = await dryRunV2(sdb, Wn, rin, ctxOf(sdb), NOW), d4: any = await dryRunV2(sdb, Gw, rin, ctxOf(sdb), NOW), d5: any = await dryRunV2(sdb, Gw, rin, ctxOf(sdb), NOW, 200, { n1: "met" });
      eq([path(d1), d1.ended, path(d2), [d3.ended, d3.reason], [d4.ended, d4.reason], path(d5), JSON.stringify(sdb.T) === before],
        [["n1:waiting", "n1:wait_finished:timeout", "n3:would"], "done", ["n1:wait_finished:met", "n2:would"], ["would_wait", "Would wait for a reply"], ["would_wait", "Would wait for the goal"],
          ["n1:executed", "n2:would"], true], "dry run: no reply → the timeout; assumed met → Replied; no timeout → stops 'Would wait for a reply'; goals the same; nothing written");
      const rdb = world({ contacts: [lead("c1")], automations: [W], lead_messages: [{ id: "m1", contact_id: "c1", direction: "in", channel: "email", at: isoMs(NOW - MIN) }] });
      const d6: any = await dryRunV2(rdb, W, { ...rin, event_at: isoMs(NOW - HR) }, ctxOf(rdb), NOW);
      eq(path(d6), ["n1:wait_finished:met", "n2:would"], "dry run: a reply already there since the test record's event counts");
    }

    // ── Stop on response: a reply after the first message stops the run before the next one; one before it does not ──
    {
      const St = flow({ n1: mail("n2"), n2: period(2, "days", "n3"), n3: mail(null) }, { stopOnResponse: true });
      const mk = (replyAt: number, stop = true) => world({ contacts: [lead("c1")], automations: [St], automation_runs: [runRow(St, { stop_on_reply: stop })],
        lead_messages: [{ id: "in1", contact_id: "c1", direction: "in", channel: "email", at: isoMs(replyAt) }] });
      let db = mk(NOW + HR);
      const p1: any = await step(db, NOW);
      const p2: any = await step(db, NOW + 2 * DAYMS);
      eq([p1.first_sent_at, p1.watch, p2.status, p2.reason, p2.exit_reason, mails(db).length, rowsOf(db).at(-1).status], [isoMs(NOW), ["customer_replied"], "stopped", "Stopped: the lead replied", "replied", 1, "stopped"],
        "Stop on response: the lead replied after the first message → stopped before the second (one exit row 'stopped')");
      db = mk(NOW - HR);
      await step(db, NOW);
      const q2: any = await step(db, NOW + 2 * DAYMS);
      eq([q2.status, mails(db).length], ["done", 2], "a reply from before the first message does not stop it");
      db = mk(NOW + HR, false);
      await step(db, NOW);
      eq([(await step(db, NOW + 2 * DAYMS) as any).status, mails(db).length], ["done", 2], "a run enrolled with Stop on response off is not stopped");
    }

    // ── the time window: every action keeps to it (team: deferred to its opening; customer: window ∩ customer hours);
    //    waits and logic steps never wait for it ──
    {
      const WIN = (days: number[], from: string, until: string) => ({ window: { on: true, days, from, until } });
      const wed20 = syd("2026-10-14", 20), wed21 = syd("2026-10-14", 21);
      let A = flow({ n1: ifn([br("b1", "Yes", [{ field: "has_email", op: "true" }])], { b1: "n2", none: null }), n2: push("in hours") }, WIN([1, 2, 3, 4, 5], "09:00", "17:00"));
      let db = world({ contacts: [lead("c1")], automations: [A], automation_runs: [runRow(A, { event_at: isoMs(wed20), anchor_at: isoMs(wed20), due_at: isoMs(wed20) })] });
      sent.length = 0;
      let p: any = await step(db, wed20);
      const p2: any = await step(db, syd("2026-10-15", 9));
      eq([p.status, p.due_at, p.cursor_step, p2.status, titles()], ["waiting", isoMs(syd("2026-10-15", 9)), "n1", "done", ["in hours"]], "a team action outside the time window waits for it to open (back over the If / else, checked again then)");
      const cust = (win: any, at: number) => { const B = flow({ n1: mail() }, win); return world({ contacts: [lead("c1")], automations: [B], automation_runs: [runRow(B, { event_at: isoMs(at), anchor_at: isoMs(at), due_at: isoMs(at) })] }); };
      db = cust(WIN([0, 1, 2, 3, 4, 5, 6], "06:00", "09:00"), wed21);
      p = await step(db, wed21);
      const p3: any = await step(db, syd("2026-10-15", 8));
      eq([p.due_at, p3.status, mails(db).length], [isoMs(syd("2026-10-15", 8)), "done", 1], "a customer message waits for the time window AND the customer hours (Thursday 08:00, not 06:00)");
      db = cust(WIN([0, 1, 2, 3, 4, 5, 6], "06:00", "23:00"), wed21);
      p = await step(db, wed21);
      eq(p.due_at, isoMs(syd("2026-10-15", 8)), "inside the window but outside the customer hours: the customer hours' morning");
      db = cust(WIN([0, 1, 2, 3, 4, 5, 6], "21:00", "23:00"), wed21);
      p = await step(db, wed21);
      eq([p.status, rowsOf(db)[0].status, rowsOf(db)[0].reason], ["done", "skipped", "the time window and the customer hours never meet"], "a time window that never meets the customer hours: the message is skipped");
      A = flow({ n1: period(10, "minutes", "n2"), n2: push("x") }, WIN([1, 2, 3, 4, 5], "09:00", "17:00"));
      db = world({ contacts: [lead("c1")], automations: [A], automation_runs: [runRow(A, { event_at: isoMs(wed20), anchor_at: isoMs(wed20), due_at: isoMs(wed20) })] });
      p = await step(db, wed20);
      const q: any = await step(db, wed20 + 10 * MIN);
      eq([p.due_at, q.due_at, q.cursor_step, trail(db)], [isoMs(wed20 + 10 * MIN), isoMs(syd("2026-10-15", 9)), "n2", ["n1:step:waiting", "n1:step:wait_finished"]], "a wait runs outside the window; only the action after it waits for the window");
    }

    // ── pauses (Global settings → Pause workflow): annual across New Year, 29 February; actions held, waits not ──
    {
      const pz = [{ start_wall: "2030-12-24T17:00", end_wall: "2031-01-02T08:00", annually: true, automation_ids: ["wA"] },
        { start_wall: "2032-02-29T09:00", end_wall: "2032-03-01T09:00", annually: true, automation_ids: ["wB"] },
        { start_wall: "2026-10-14T10:00", end_wall: "2026-10-16T10:00", annually: false, automation_ids: ["wC", "wA"] }];
      eq([pauseUntil(pz, "wA", syd("2026-12-31", 12), tz), pauseUntil(pz, "wA", syd("2027-01-01", 0), tz), pauseUntil(pz, "wA", syd("2026-12-24", 16, 59), tz), pauseUntil(pz, "wB", syd("2027-02-28", 10), tz),
        pauseUntil(pz, "wB", syd("2028-02-29", 10), tz), pauseUntil(pz, "wC", NOW, tz), pauseUntil(pz, "wA", NOW, tz), pauseUntil(pz, "wZ", NOW, tz), pauseUntil(pz, "wC", syd("2026-10-16", 10), tz)],
        [syd("2027-01-02", 8), syd("2027-01-02", 8), null, syd("2027-03-01", 9), syd("2028-03-01", 9), syd("2026-10-16", 10), syd("2026-10-16", 10), null, null],
        "pauseUntil: annual across New Year, 29 Feb (28 Feb in other years), several workflows, the end itself is not paused");
      const P = flow({ n1: period(1, "hours", "n2"), n2: push("after the pause") });
      const db = world({ contacts: [lead("c1")], automations: [P], automation_runs: [runRow(P)],
        automation_pauses: [{ id: "pz1", business_id: "default", start_wall: "2026-10-14T14:30", end_wall: "2026-10-16T10:00", annually: false, automation_ids: [P.id] }] });
      sent.length = 0;
      await step(db, NOW);
      const h: any = await step(db, NOW + HR);
      const h2: any = await step(db, NOW + 2 * HR);   // woken early: held again, no second row
      const end: any = await step(db, syd("2026-10-16", 10));
      eq([h.status, h.due_at, h.reason, h.watch, h2.due_at, trail(db).slice(0, 3), end.status, titles()],
        ["waiting", isoMs(syd("2026-10-16", 10)), `paused until ${isoMs(syd("2026-10-16", 10))}`, ["pause"], isoMs(syd("2026-10-16", 10)), ["n1:step:waiting", "n1:step:wait_finished", "n2:step:waiting"], "done", ["after the pause"]],
        "a pause holds the action (not the wait) until it ends, watching 'pause'; then it runs (max_late_hours counts from the end)");
    }

    // ── the re-entry ledger + per-record lock through a whole run: the lock goes with the run; off = once; per lead ──
    {
      const E = flow({ n1: push("x") }, { reentry: "after_exit" }), O = flow({ n1: push("y") }, { reentry: "off" });
      const db = world({ contacts: [lead("c1")], automations: [E, O], automation_enrollment_keys: [] });
      const en = (a: any, key: string, o: any = {}) => db.rpc("automation_enroll", { p_business: "default", p_automation: a.id, p_version: 1, p_revision: 1, p_trigger: "t1", p_event_key: key, p_event_type: "newLead",
        p_event_at: isoMs(NOW), p_record_kind: "contact", p_record_id: "c1", p_contact: "c1", p_enroll_key: "c1", p_lock_key: "c1", p_reentry: normWfSettings(a.settings).reentry, p_start: "n1", p_context: {},
        p_source: "trigger", p_chain: 0, p_cause: null, p_parent: null, p_stop_on_reply: false, p_now: isoMs(NOW), ...o }).then((r: any) => String(r.data));
      const e1 = await en(E, "k1"), e2 = await en(E, "k2");
      await step(db, NOW, e1.slice(9));
      const e3 = await en(E, "k3"), o1 = await en(O, "k1");
      await step(db, NOW, o1.slice(9));
      const o2 = await en(O, "k2");
      eq([e1.startsWith("enrolled:"), e2, e3.startsWith("enrolled:"), o1.startsWith("enrolled:"), o2, thisRun(db, e1.slice(9)).active_lock], [true, "already_enrolled", true, true, "reentry_off", null],
        "re-entry: one active run per key (the lock leaves with the finished run); after exit = again; off = once (the ledger)");
      const job = (j: string, s: any) => enrollKeyOf(normWfSettings(s), { record_kind: "job", record_id: j, contact_id: "c1", event_key: j });
      eq([job("j1", { perRecord: true }), job("j1", { perRecord: false }).key === job("j2", { perRecord: false }).key], [{ key: "job:j1", lock: "job:j1" }, true], "Allow multiple jobs off: two jobs of one lead share the lock");
    }

    // ── Mark as read after a message; a failed mark never stops the run ──
    {
      const M = flow({ n1: mail("n2"), n2: push("next") }, { markRead: true });
      let db = world({ contacts: [lead("c1")], automations: [M], automation_runs: [runRow(M)] });
      await step(db, NOW);
      eq([(db.T.automation_apply_calls || []).map((x: any) => [x.p_kind, x.p_id, x.p_ops, x.p_cause]), !!db.T.contacts[0].last_read_at],
        [[["contact", "c1", [{ op: "read" }], `r32:0:${M.id}`]], true], "'Conversations: Mark as read': the conversation is marked read after the message (cause = run:depth:workflow)");
      db = world({ contacts: [lead("c1")], automations: [flow({ n1: mail() })], automation_runs: [] });
      db.T.automation_runs.push(runRow(db.T.automations[0]));
      await step(db, NOW);
      eq(db.T.automation_apply_calls, undefined, "off: nothing marked");
      db = world({ contacts: [lead("c1")], automations: [M], automation_runs: [runRow(M)] });
      const bad = { ...db, rpc: (n: string, x: any) => n === "automation_apply" ? Promise.resolve({ data: null, error: { message: "boom" } }) : db.rpc(n, x) };
      const err0 = console.error; console.error = () => {};
      let pb: any;
      try { pb = await step(db, NOW, "r32", bad); } finally { console.error = err0; }
      eq([pb.status, mails(db).length], ["done", 1], "a failed mark-as-read never stops the run");
      // Sender: the workflow's "From name" signs its emails before the business's signer
      const K = flow({ n1: mail() }, { sender: { fromName: "Kim" } });
      db = world({ automation_settings: [{ business_id: "default", email_signer: "Ron" }], contacts: [lead("c1")], automations: [K], automation_runs: [runRow(K)] });
      await step(db, NOW);
      const db0 = world({ automation_settings: [{ business_id: "default", email_signer: "Ron" }], contacts: [lead("c1")], automations: [M], automation_runs: [runRow(M)] });
      await step(db0, NOW);
      eq([mails(db)[0].author, mails(db0)[0].author], ["Kim", "Ron"], "Sender: the workflow's From name before the business's email signer (unset = the business's)");
    }

    // ── a delinked cluster runs only from the trigger that goes to it (Advanced); trigger gates skipped for added runs ──
    {
      const A = flow({ n1: push("main"), n5: push("side") }, {}, { entry: "n1", triggers: [{ id: "t1", type: "newLead", filters: NONE }, { id: "t2", type: "contact_changed", filters: NONE, goto: "n5" }] });
      let db = world({ contacts: [lead("c1")], automations: [A], automation_runs: [runRow(A, { trigger_id: "t2" })] });
      sent.length = 0; await step(db, NOW);
      const side = titles();
      db = world({ contacts: [lead("c1")], automations: [A], automation_runs: [runRow(A, { trigger_id: "t1" })] });
      sent.length = 0; await step(db, NOW);
      eq([side, titles()], [["side"], ["main"]], "a delinked cluster is reached only through its trigger's Go to");
      const B = flow({ n1: push("stage") });
      const st = (source: string) => world({ contacts: [lead("c1", { status: "Quoted", stage_changed_at: isoMs(NOW - HR) })], automations: [B], automation_runs: [runRow(B, { event_type: "stage", source, context: {} })] });
      db = st("trigger"); const pT: any = await step(db, NOW);
      db = st("workflow"); const pW: any = await step(db, NOW);
      eq([pT.status, pW.status], ["skipped", "done"], "a stage trigger's own gate applies to its runs, never to a run added by another workflow");
    }

    // ── section markers; no business words in the new executor code ──
    const s4 = src("index.ts"), w0 = s4.indexOf("// ==== WAITS"), w1 = s4.indexOf("// Once a day: finished runs");
    eq(["Aircon", "Gutter", "Sydney", "Ron", "The Guys"].filter((w) => s4.slice(w0, w1).split("\n").filter((l: string) => !/^\s*\/\//.test(l)).join("\n").includes(w)), [], "no business words in the waits and executor code (G2.2)");
  }

  // ── 33. record actions, the inbound webhook, the outgoing webhook, custom values (G2.3, design §3.8–§3.12, §8.1 #9,
  //        #18, #21, #22): every apply op = the app's equivalent write's events, with the cause; a workflow never starts
  //        itself again; a chain of workflows stops at depth 3; SSRF refusals; payload 50 × 500 stored truncated; 404 / 429 ──
  {
    io.advance = PROD_ADVANCE;
    const NONE = { match: "all", segments: [{ match: "all", rules: [] }] };
    const F1 = (rules: any[]) => ({ match: "all", segments: [{ match: "all", rules }] });
    let k33 = 0;
    const flow = (nodes: any, o: any = {}) => {
      k33++;
      return { id: `w33-${String(k33).padStart(4, "0")}`, business_id: "default", name: `G23 ${k33}`, enabled: true, armed_at: "2026-10-01T00:00:00.000Z", version: 1, revision: 1,
        created_by_name: "Olivia Owner", trigger: {}, steps: [], definition: { schema: 2, seq: 60, entry: Object.keys(nodes)[0], triggers: o.triggers ?? [{ id: "t1", type: "newLead", filters: NONE }], nodes },
        settings: { reentry: "off", perRecord: true, ...(o.settings || {}) }, deleted_at: null, ...(o.row || {}) };
    };
    const act = (type: string, config: any, next: string | null = null) => ({ kind: "action", type, config, out: { next } });
    const runRow = (a: any, o: any = {}) => ({ id: "r33", business_id: "default", automation_id: a.id, automation_version: a.version, event_key: "c1:new", event_type: "newLead", event_at: isoMs(NOW),
      record_kind: "contact", record_id: "c1", contact_id: "c1", status: "waiting", step_index: 0, anchor_at: isoMs(NOW), due_at: isoMs(NOW), attempts: 0, context: {}, trigger_id: "t1",
      cursor_step: null, remove_requested: false, chain_depth: 0, ...o });
    const step = async (db: any, ms = NOW, id = "r33") => {
      const r = db.T.automation_runs.find((x: any) => x.id === id); Object.assign(r, { status: "running", attempts: (Number(r.attempts) || 0) + 1 });
      clock = ms; const p: any = await advanceV2(db, { ...r }, ctxOf(db), ms); Object.assign(r, p); clock = NOW; return p;
    };
    const acts33 = (db: any, id = "r33") => db.T.automation_log.filter((l: any) => l.run_id === id && l.row_kind === "action").map((l: any) => `${l.step_id}:${l.status}${l.reason ? ":" + l.reason : ""}`);
    const one = async (nodes: any, seed: any = {}, o: any = {}) => {
      const A = flow(nodes, o);
      const db = world({ contacts: [lead("c1")], automations: [A], automation_runs: [runRow(A, o.run || {})], ...seed });
      const p = await step(db, o.at ?? NOW);
      return { db, A, p };
    };

    // ── each record action → its automation_apply ops, the run's cause, and the write itself ──
    {
      sent.length = 0;
      const { db, A } = await one({
        n1: act("update_field", { field: "postcode", value: "2{suburb}9" }, "n2"), n2: act("add_tag", { tags: ["VIP", "vip", " Hot "] }, "n3"), n3: act("remove_tag", { tags: ["vip"] }, "n4"),
        n4: act("add_note", { text: "Called {first_name}" }, "n5"), n5: act("edit_conversation", {}, "n6"), n6: act("move_stage", { stage: "Quoted" }, "n7"),
        n7: act("internal_comment", { text: "Moved by {automation}" }, "n8"), n8: act("update_custom_value", { key: "promo", value: "SPRING{service}" }, "n9"),
        n9: act("internal_notification", { channel: "push", to: { roles: ["owner"] }, title: "Code {custom.promo}" }, "n10"), n10: act("add_task", { title: "Call {first_name}", due_days: 2 }, "n11"),
        n11: act("manual_call", { title: "Ring {name}" }, "n12"), n12: act("dnd", { mode: "enable", channel: "email" }, "n13"), n13: act("mark_lost", { reason: "Too far" }) });
      const calls = db.T.automation_apply_calls;
      eq(calls.map((x: any) => [x.p_kind, x.p_id, x.p_cause, x.p_ops.map((o: any) => o.op).join("+")]), [
        ["contact", "c1", `r33:0:${A.id}`, "set"], ["contact", "c1", `r33:0:${A.id}`, "tags"], ["contact", "c1", `r33:0:${A.id}`, "tags"], ["contact", "c1", `r33:0:${A.id}`, "note"],
        ["contact", "c1", `r33:0:${A.id}`, "read"], ["contact", "c1", `r33:0:${A.id}`, "stage"], ["contact", "c1", `r33:0:${A.id}`, "comment"], ["contact", "c1", `r33:0:${A.id}`, "custom"],
        ["contact", "c1", `r33:0:${A.id}`, "task"], ["contact", "c1", `r33:0:${A.id}`, "task"], ["contact", "c1", `r33:0:${A.id}`, "optout"], ["contact", "c1", `r33:0:${A.id}`, "stage"]],
        "every record action is ONE automation_apply call on the lead with the run's cause (run:depth:workflow)");
      const c = db.T.contacts[0];
      eq([calls[0].p_ops[0], calls[1].p_ops[0], calls[3].p_ops[0].text, c.postcode, c.tags, c.customer_notes.map((x: any) => [x.text, x.by]), c.status, c.lost_reason, !!c.last_read_at],
        [{ op: "set", field: "postcode", value: "220009" }, { op: "tags", add: ["VIP", "vip", "Hot"] }, "Called Sam", "220009", ["Hot"], [["Called Sam", `Automation: ${A.name}`]], "Lost", "Too far", true],
        "the writes: the field (merge filled), tags (one tag in any case; removed in any case), a note on the card ({id, text, by, at}), read, stage, lost with its reason");
      const tasks = db.T.tasks.map((t: any) => [t.title, t.board, t.due, t.contact_id, t.category, t.priority, t.created_by]);
      eq(tasks, [["Call Sam", "ron", "2026-10-16", "c1", "Client-related", "Medium", `Automation: ${A.name}`], ["Ring Sam Smith", "ron", "2026-10-14", "c1", "Client-related", "High", `Automation: ${A.name}`]],
        "Add task / Manual action to call: the office board, due in n days / today, the lead's task");
      eq([sent.map((x) => x.msg.title), db.T.automation_custom_values, db.T.customer_opt_outs.map((x: any) => x.channel)], [["Code SPRINGAircon cleaning"], [{ business_id: "default", key: "promo", value: "SPRINGAircon cleaning" }], ["email"]],
        "Update custom value: stored, and {custom.promo} has the new value in the very next step; Stop automatic messages: the opt-out");
      eq(acts33(db), ["n1:executed", "n2:executed", "n3:executed", "n4:executed", "n5:executed", "n6:executed", "n7:executed", "n8:executed", "n9:sent", "n10:executed", "n11:executed", "n12:executed", "n13:executed"],
        "the action rows: executed (record writes), sent (the push)");
      eq(db.T.activity_log.filter((l: any) => l.actor === `Automation: ${A.name}`).length, 11, "one activity line on the lead per write (Automation: <name>; a custom value has none)");
    }
    // a record action that meets a goal further down: the goal looks at the record as it is now (not the start's read)
    {
      sent.length = 0;
      const goal = (ifNotMet: string, next: string | null) => ({ kind: "goal", type: "tag_added", config: { tags: ["VIP"], ifNotMet }, out: { next } });
      let r = await one({ n1: act("add_tag", { tags: ["VIP"] }, "n2"), n2: goal("end", "n3"), n3: act("internal_notification", { channel: "push", to: { roles: ["owner"] }, title: "VIP {name}" }) });
      eq([r.p.status, r.p.exit_reason, sent.map((x) => x.msg.title), r.db.T.automation_log.filter((l: any) => l.step_id === "n2").map((l: any) => l.detail && l.detail.met)],
        ["done", "end_of_workflow", ["VIP Sam Smith"], [true]], "Add tag then a Goal for that tag: met (fresh facts after the write), the run goes on");
      sent.length = 0;
      r = await one({ n1: act("add_tag", { tags: ["VIP"] }, "n2"), n2: act("internal_notification", { channel: "push", to: { roles: ["owner"] }, title: "skipped over" }, "n3"), n3: goal("continue", "n4"),
        n4: act("internal_notification", { channel: "push", to: { roles: ["owner"] }, title: "after the goal" }) });
      eq([r.p.status, sent.map((x) => x.msg.title)], ["done", ["after the goal"]], "…and a goal further down that the write met is jumped to (the step between is passed over)");
    }
    {
      const { db } = await one({ n1: act("move_stage", { stage: "New" }, "n2"), n2: act("dnd", { mode: "disable", channel: "all" }) });
      eq(acts33(db), ["n1:skipped:already in that stage", "n2:skipped:unavailable: Only a person can turn automatic messages back on"], "refused writes are skipped with the reason: the same stage, turning messages back on");
      // a doc the validator lets through never reaches these, but the plan refuses them too (Won, a field off the whitelist)
      const fx0: any = { contact: { id: "c1" }, cat: CATALOG };
      eq([await recordPlan(db, act("move_stage", { stage: "won" }), { id: "r" }, {}, fx0, ctxOf(db), NOW, {}), await recordPlan(db, act("update_field", { field: "phone", value: "1" }), { id: "r" }, {}, fx0, ctxOf(db), NOW, {}),
        await recordPlan(db, act("add_tag", { tags: ["x"] }), { id: "r" }, {}, { contact: null }, ctxOf(db), NOW, {}), await recordPlan(db, act("send_email", {}), { id: "r" }, {}, fx0, ctxOf(db), NOW, {})],
        [{ skip: "A lead is won when its job is entered" }, { skip: "field not allowed" }, { skip: "No lead card" }, null], "the plan: Won refused, the field whitelist, a lead write needs a lead, a message is not a record write");
      // contactless (a Scheduler run): the team's task through apply (kind none); a lead-only write is 'No lead card'
      const S = flow({ n1: act("add_task", { title: "Weekly check" }, "n2"), n2: act("add_tag", { tags: ["x"] }) }, { triggers: [{ id: "t1", type: "scheduler", config: { freq: "daily", at: "09:00" }, filters: NONE }] });
      const db2 = world({ automations: [S], automation_runs: [runRow(S, { record_kind: "none", record_id: "sched:x", contact_id: null, event_type: "scheduler", event_key: "sched:x" })] });
      await step(db2);
      eq([db2.T.automation_apply_calls.map((x: any) => [x.p_kind, x.p_id, x.p_ops[0].op]), db2.T.tasks.map((t: any) => [t.title, t.contact_id, t.category]), acts33(db2)],
        [[["none", "r33", "task"]], [["Weekly check", null, null]], ["n1:executed", "n2:skipped:No lead card"]], "no lead: the task is the team's (apply kind 'none', the run's cause), a lead write is skipped");
      // the dry run: the ops it would apply, no write at all
      const D = flow({ n1: act("add_tag", { tags: ["VIP"] }, "n2"), n2: act("add_task", { title: "Call {first_name}" }) });
      const db3 = world({ contacts: [lead("c1")], automations: [D] });
      const before = JSON.stringify(db3.T);
      const d: any = await dryRunV2(db3, D, { record_kind: "contact", record_id: "c1", contact_id: "c1", event_type: "newLead", event_at: isoMs(NOW), trigger_id: "t1", context: {} }, ctxOf(db3), NOW);
      eq([d.ok, d.path.filter((x: any) => x.rowKind === "action").map((x: any) => [x.stepId, x.status, x.preview.title ?? null, x.preview.board ?? null, (x.preview.ops || []).map((o: any) => o.op)]), JSON.stringify(db3.T) === before],
        [true, [["n1", "would", null, null, ["tags"]], ["n2", "would", "Call Sam", "ron", ["task"]]], true], "the dry run shows the ops each record action would apply and writes nothing");
    }

    // ── apply ops emit the same events as the app's equivalent writes, each with the cause (design §8.1 #18) ──
    {
      const W = ["contact_changed", "contact_tag", "note_added", "lead_status", "contact_dnd", "stage"].map((t) => ({ business_id: "default", event_type: t }));
      const shape = (db: any) => db.T.automation_events.map((e: any) => [e.type, e.event_key.replace(/:\d+$/, ":<tx>").replace(/:note:[A-Za-z0-9_-]+$/, ":note:<id>").replace(/^[^:]+:(on|off)$/, "<optout>:$1")
        .replace(/:\d{4}-\d\d-\d\dT[\d:.]+Z$/, ":<at>"), { ...e.ctx, ...(e.ctx.note_id ? { note_id: "<id>" } : {}), ...(e.ctx.old !== undefined ? { old: "<old>" } : {}) }]).sort((x: any, y: any) => JSON.stringify(x) < JSON.stringify(y) ? -1 : 1);
      // the app: the lead card's writes (a field, the atomic tag / note edits, a stage move, an opt-out)
      const app = world({ contacts: [lead("c1")], automation_wanted: W.map((x) => ({ ...x })) });
      await app.from("contacts").update({ postcode: "2999" }).eq("id", "c1");
      await app.rpc("contact_tags_edit", { p_id: "c1", p_add: ["VIP"], p_remove: [] });
      await app.rpc("contact_tags_edit", { p_id: "c1", p_add: [], p_remove: ["vip"] });
      await app.rpc("contact_note_add", { p_id: "c1", p_note: { id: "n-app", text: "Gate 12", by: "Olivia Owner", at: isoMs(NOW) } });
      await app.from("contacts").update({ status: "Quoted", stage_changed_at: isoMs(NOW) }).eq("id", "c1");
      await app.from("customer_opt_outs").insert({ business_id: "default", contact_id: "c1", channel: "email", reason: "Olivia Owner" });
      // the engine: the same writes through automation_apply
      const E = flow({ n1: act("update_field", { field: "postcode", value: "2999" }, "n2"), n2: act("add_tag", { tags: ["VIP"] }, "n3"), n3: act("remove_tag", { tags: ["vip"] }, "n4"),
        n4: act("add_note", { text: "Gate 12" }, "n5"), n5: act("move_stage", { stage: "Quoted" }, "n6"), n6: act("dnd", { mode: "enable", channel: "email" }) });
      const eng = world({ contacts: [lead("c1")], automations: [E], automation_runs: [runRow(E, { chain_depth: 1 })], automation_wanted: W.map((x) => ({ ...x })) });
      await step(eng);
      const appEv = shape(app).filter((x: any) => x[0] !== "stage"), engEv = shape(eng).filter((x: any) => x[0] !== "stage");
      eq(engEv.map((x: any) => x.slice(0, 2)), appEv.map((x: any) => x.slice(0, 2)), "the same event types and keys (the transaction id aside) as the lead card's own writes");
      eq(engEv.map((x: any) => [x[0], x[2].action ?? x[2].field ?? x[2].status ?? x[2].tag ?? null]), appEv.map((x: any) => [x[0], x[2].action ?? x[2].field ?? x[2].status ?? x[2].tag ?? null]), "…with the same details");
      eq([app.T.automation_events.every((e: any) => e.cause_automation_id == null && e.chain_depth === 0),
        eng.T.automation_events.every((e: any) => e.cause_automation_id === E.id && e.cause_run_id === "r33" && e.chain_depth === 2)], [true, true],
        "the app's events have no cause; every event the workflow's writes make carries the run, the workflow and depth + 1");
      eq(eng.T.automation_events.filter((e: any) => e.type === "stage").map((e: any) => [e.event_key, e.source]), [[`c1:Quoted:${isoMs(NOW)}`, "engine"]], "a stage move writes the scanner's 'stage' event itself (its exact key), so the scanner adds nothing");
    }

    // the lead card's note keeps its whole text (an older note over 2000 characters comes back whole on Undo: delete,
    // then add again); notes that are not a list are never replaced, by the card (an error) or by a workflow (skipped)
    {
      const long = "x".repeat(2500), old = { id: "old1", text: long, by: "Olivia Owner", at: isoMs(NOW - DAYMS) };
      const db = world({ contacts: [lead("c1", { customer_notes: [old] }), lead("c2", { customer_notes: "a note from the old app" })] });
      await db.rpc("contact_note_remove", { p_id: "c1", p_note_id: "old1" });
      const gone = db.T.contacts[0].customer_notes.length;
      const back = await db.rpc("contact_note_add", { p_id: "c1", p_note: { ...old } });
      const bad = [await db.rpc("contact_note_add", { p_id: "c2", p_note: { id: "n1", text: "x" } }), await db.rpc("contact_note_remove", { p_id: "c2", p_note_id: "n1" })];
      eq([gone, back.error, db.T.contacts[0].customer_notes.map((x: any) => [x.id, x.text.length]), bad.map((x: any) => !!x.error), db.T.contacts[1].customer_notes],
        [0, null, [["old1", 2500]], [true, true], "a note from the old app"], "a 2,500-character note: delete then Undo brings it back whole; notes that are not a list: the card's add / delete refused, untouched");
      // any note id the card can show comes back on Undo (an imported "ghl:123/x"): any non-empty id up to 128
      // characters without control characters; the app's own new notes keep their uid() ids
      const odd = { id: "ghl:123/x", text: "Imported", by: "", at: "" }, n128 = "n".repeat(128);
      const db3 = world({ contacts: [lead("c1", { customer_notes: [odd] })] });
      await db3.rpc("contact_note_remove", { p_id: "c1", p_note_id: odd.id });
      const undo = await db3.rpc("contact_note_add", { p_id: "c1", p_note: { ...odd } });
      const restored = JSON.parse(JSON.stringify(db3.T.contacts[0].customer_notes));
      const ok128 = await db3.rpc("contact_note_add", { p_id: "c1", p_note: { id: n128, text: "Long id" } });
      const refused = await Promise.all(["", "n".repeat(129), "a\nb", "a\u0000b", null].map((id) => db3.rpc("contact_note_add", { p_id: "c1", p_note: { id, text: "x" } })));
      eq([undo.error, ok128.error, db3.T.contacts[0].customer_notes.map((x: any) => x.id.length > 20 ? x.id.length : x.id), refused.map((x: any) => x.error && x.error.message)],
        [null, null, ["ghl:123/x", 128], Array(5).fill("a note needs an id and some text")], "a deleted note with a foreign id comes back on Undo; ids up to 128 characters, none empty or with a control character");
      eq([restored, db3.T.contacts[0].customer_notes[1].at === isoMs(clock)], [[odd], true], "…exactly as it was (its empty time kept; a note given no time gets now)");
      const sqlTx = src(SQL_DIR + "stage2-automations.sql"), fnSql = (n0: string) => sqlTx.slice(sqlTx.indexOf(`create or replace function public.${n0}(`), sqlTx.indexOf("$$;", sqlTx.indexOf(`create or replace function public.${n0}(`)));
      eq(["contact_note_add", "contact_notes_append"].map((n0) => [fnSql(n0).includes("A-Za-z0-9_-]{1,64}"), fnSql(n0).includes("pg_catalog.char_length(p_note ->> 'id') > 128"), fnSql(n0).includes("[[:cntrl:]]")]),
        [[false, true, true], [false, true, true]], "SQL: contact_note_add and contact_notes_append take the same id rule (any id up to 128, no control characters)");
      const W2 = flow({ n1: act("add_note", { text: "From the workflow" }) });
      const eng = world({ contacts: [lead("c1", { customer_notes: "a note from the old app" })], automations: [W2], automation_runs: [runRow(W2)] });
      await step(eng);
      eq([acts33(eng), eng.T.contacts[0].customer_notes], [["n1:skipped:the notes on this card are not a list"], "a note from the old app"], "a workflow's Add note never replaces notes that are not a list (skipped, with the reason)");
    }

    // ── a workflow never starts itself again; a chain of workflows stops at depth 3 (event store, real ticks) ──
    {
      const tagTrig = (tag: string) => [{ id: "t1", type: "contact_tag", filters: F1([{ field: "trigger.tag", op: "is", v: tag }, { field: "trigger.action", op: "is", v: "added" }]) }];
      const anyTag = [{ id: "t1", type: "contact_tag", filters: F1([{ field: "trigger.action", op: "is", v: "added" }]) }];
      const Self = flow({ n1: act("add_tag", { tags: ["B"] }) }, { triggers: anyTag, settings: { reentry: "after_exit" } });
      const W = [1, 2, 3, 4, 5].map((i) => flow({ n1: act("add_tag", { tags: [`t${i}`] }) }, { triggers: tagTrig(`t${i - 1}`), settings: { reentry: "after_exit" } }));
      const st = () => [{ business_id: "default", tick_lease_until: null, pruned_on: null, phase4_compat: false }];
      const base = { automation_state: st(), automation_events: [], automation_trigger_log: [], automation_trigger_daily: [], automation_enrollment_keys: [], automation_wanted: [] };
      let db = world({ contacts: [lead("c1")], automations: [Self], ...base });
      await tickAt(db, NOW);   // publishes the capture list
      await db.rpc("contact_tags_edit", { p_id: "c1", p_add: ["A"], p_remove: [] });
      for (let i = 1; i <= 4; i++) await tickAt(db, NOW + i * MIN);
      eq([db.T.automation_runs.length, db.T.contacts[0].tags, db.T.automation_trigger_log.map((r: any) => `${r.event_key.split(":").slice(1, 4).join(":")}:${r.matched ? "match" : r.reason}`).sort()],
        [1, ["A", "B"], ["tag:+:A:match", "tag:+:B:own_change"]], "a workflow's own write never starts it again (own_change), even with re-entry on");
      db = world({ contacts: [lead("c1")], automations: W, ...base, automation_state: st() });
      await tickAt(db, NOW);
      await db.rpc("contact_tags_edit", { p_id: "c1", p_add: ["t0"], p_remove: [] });
      for (let i = 1; i <= 7; i++) await tickAt(db, NOW + i * MIN);
      eq([db.T.contacts[0].tags, db.T.automation_runs.map((r: any) => r.chain_depth).sort(),
        db.T.automation_trigger_log.filter((r: any) => r.automation_id === W[4].id && r.event_key.includes(":t4:")).map((r: any) => r.reason)],
        [["t0", "t1", "t2", "t3", "t4"], [0, 1, 2, 3], ["loop_guard"]], "a chain of workflows stops at depth 3: the 5th never starts (loop_guard)");
    }

    // ── {custom.x}, {trigger.x} (HTML-escaped in emails), unknown blanks stop a customer message ──
    {
      const vars = wfMergeVars({ contact: { full_name: "Sam Smith", estimated_value: 450, booked_for: "2026-10-20T00:00:00Z", lost_reason: null }, job: null, call: null, chat: null, task: { title: "Ring", due: "2026-10-21" },
        ctx: { form: "<b>x</b>", _wf: "w1", "Bad-Key": "no" }, cat: CATALOG, company: "Acme", S: normSettings({}), kind: "contact" }, { name: "A", steps: [] }, { promo: "SPRING", "Bad": "x" });
      eq([vars.quote_amount, vars.booked_date, vars.task_title, vars.due_date, vars["custom.promo"], vars["trigger.form"], has(vars, "trigger._wf"), has(vars, "custom.Bad")],
        ["$450", "2026-10-20", "Ring", "2026-10-21", "SPRING", "<b>x</b>", false, false], "stage-2 merge values: quote amount, dates, task, custom values, trigger data (never the engine's own _ keys)");
      const kn = wfKnown(vars);
      eq([wfFill("Hi {first_name}, code {custom.promo}{custom.none}", vars, kn), wfFill("Form: {trigger.form}", vars, kn, (v, k) => k.startsWith("trigger.") ? htmlEsc(v) : v),
        wfUnfilled(["a {custom.none} b {trigger.missing}"]), wfFill("{custom.none}", vars, "*")],
        ["Hi Sam, code SPRING{custom.none}", "Form: &lt;b&gt;x&lt;/b&gt;", ["custom.none", "trigger.missing"], ""], "fill: known blanks filled, {trigger.*} escaped in emails, unknown ones stay (and stop the message); team words: unknown = empty");
      const { db } = await one({ n1: act("send_email", { subject: "Hi {first_name}", body: "Your code {custom.nope}" }, "n2"), n2: act("send_email", { subject: "Re {trigger.form}", body: "{hi}, {quote_amount}" }) },
        {}, { run: { context: { form: "<i>web</i>" } } });
      eq([acts33(db), db.T.lead_messages.map((m: any) => m.subject)], [["n1:skipped:missing details: custom.nope", "n2:queued"], ["Re &lt;i&gt;web&lt;/i&gt;"]], "an unknown {custom.x} stops the email; a trigger value is escaped");
    }

    // ── send live chat message / send review request (customer actions with the full guard) ──
    {
      const chat = (o: any = {}) => ({ id: "s1", contact_id: "c1", created_at: isoMs(NOW - HR), full_name: "Sam Smith", ...o });
      let r = await one({ n1: act("send_live_chat", { body: "{hi}, we saw your chat" }) }, { chat_sessions: [chat()] });
      eq([acts33(r.db), r.db.T.lead_messages.map((m: any) => [m.session_id, m.channel, m.direction, m.auto, m.body])], [["n1:sent"], [["s1", "chat", "out", true, "Hi Sam, we saw your chat"]]],
        "Send live chat message: into the lead's open chat (an automatic row the widget shows)");
      r = await one({ n1: act("send_live_chat", { body: "x" }) }, { chat_sessions: [chat({ created_at: isoMs(NOW - 30 * HR) })] });
      eq(acts33(r.db), ["n1:skipped:no open chat"], "…no chat in the last 24 hours: skipped");
      r = await one({ n1: act("send_live_chat", { body: "x" }) }, { chat_sessions: [chat()], customer_opt_outs: [{ id: "o1", business_id: "default", contact_id: "c1", channel: "chat" }] });
      eq(acts33(r.db), ["n1:skipped:opted out"], "…opted out of chat: skipped");
      const cat2 = { ...CATALOG, reviews: { links: { Aircon: { link: "https://g.page/r/abc/review" } } } };
      const job = { id: "j1", contact_id: "c1", invoice_number: "INV-2400", date: "2026-10-13", job_type: "Aircon", technician: "Guy Tech", customer_name: "Sam Smith", amount: 300, payment_status: "Paid" };
      const rv = async (seed: any) => {
        const A = flow({ n1: act("send_review_request", {}) });
        const db = world({ contacts: [lead("c1")], automations: [A], automation_runs: [runRow(A)], jobs: [job], settings: [{ id: 1, company_name: "Acme Home Services", catalog: cat2, review_requests_enabled: true }], system_claims: [], ...seed });
        const T: any = { ...ctxOf(db), cat: cat2 };
        const run = db.T.automation_runs[0]; run.status = "running"; run.attempts = 1;
        Object.assign(run, await advanceV2(db, { ...run }, T, NOW));
        return db;
      };
      let db = await rv({});
      eq([acts33(db), db.T.review_requests.map((x: any) => [x.invoice_number, x.job_id, x.phone, x.email, x.review_link, x.status, x.source, x.first_name]), db.T.system_claims.map((x: any) => x.key)],
        [["n1:queued"], [["2400", "j1", "+61412345678", "sam@example.com", "https://g.page/r/abc/review", "waiting", "auto", "Sam"]], ["review:j1"]],
        "Send review request: one request in the Google reviews queue (the review-requests function sends it), the job's claim taken");
      db = await rv({ settings: [{ id: 1, company_name: "Acme Home Services", catalog: cat2, review_requests_enabled: false }] });
      eq(acts33(db), ["n1:skipped:unavailable: Turn on Google reviews first"], "…Google reviews off: skipped (unavailable)");
      db = await rv({ review_requests: [{ id: "rr0", phone: "+61412345678", status: "sent", created_at: isoMs(NOW - 20 * DAYMS) }] });
      eq(acts33(db), ["n1:skipped:asked for a review in the last 6 months"], "…asked recently: skipped");
      db = await rv({ system_claims: [{ business_id: "default", key: "review:j1", at: isoMs(NOW - HR) }] });
      eq([acts33(db), db.T.review_requests.length], [["n1:skipped:already asked for this job"], 0], "…the job's claim already taken (the legacy queue asked first): skipped, never twice");
    }

    // ── the outgoing webhook: SSRF refusals, no redirects, timeout + one retry, only host / status / time logged ──
    {
      eq(["http://x.com/h", "https://10.0.0.1/h", "https://[::1]/h", "https://localhost/h", "https://db.internal/h", "https://printer.local/h", "https://abc.supabase.co/h", "https://user:pw@x.com/h", "https://0x7f000001/h", "https://hooks.zapier.com/x"].map(webhookUrlProblem),
        ["Only https:// addresses", "An IP address is not allowed", "An IP address is not allowed", "An internal address is not allowed", "An internal address is not allowed", "An internal address is not allowed",
          "This address is not allowed", "No passwords in the address", "An IP address is not allowed", ""], "the address: https only; no IP literal, localhost, *.local / *.internal, Supabase, passwords");
      eq(["10.1.2.3", "172.20.0.1", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "8.8.8.8", "2606:4700::1111", "100.128.0.1"].map(ipBlocked),
        [true, true, true, true, true, true, true, true, true, true, true, true, true, false, false, false], "private, loopback, link-local (cloud metadata), CGNAT, multicast, mapped and NAT64 addresses are refused");
      const calls: any[] = [];
      let answers: any[] = [];
      io.fetch = async (url: string, init: any) => { calls.push({ url, init }); const a0 = answers.shift(); if (a0 instanceof Error) throw a0; return { status: a0, body: { cancel: async () => {} } }; };
      const dns0 = io.resolveDns;
      let dns: Record<string, string[]> = {};
      io.resolveDns = async (host: string, type: string) => { const l = (dns[host] || []).filter((x) => (type === "A") === !x.includes(":")); if (!l.length) throw Object.assign(new Error("no record"), { name: "NotFound" }); return l; };
      const hook = (cfg: any) => one({ n1: act("webhook", { url: "https://hooks.example.com/in", ...cfg }) });
      dns = { "hooks.example.com": ["93.184.216.34"] };
      answers = [200];
      let r = await hook({ headers: [{ name: "X-Source", value: "ops" }], fields: ["first_name", "custom.none"] });
      const row = r.db.T.automation_log.find((l: any) => l.row_kind === "action");
      eq([acts33(r.db), calls.length, calls[0].init.redirect, calls[0].init.method, JSON.parse(calls[0].init.body), calls[0].init.headers["X-Source"], row.channel, row.audience, row.detail, row.recipient],
        [["n1:sent"], 1, "manual", "POST", { first_name: "Sam", "custom.none": "" }, "ops", "webhook", "team", { host: "hooks.example.com", status: 200, ms: 0, tries: 1 }, "hooks.example.com"],
        "sent: the chosen fields as JSON, redirects not followed; the log row has only the host, the status, the time and the tries");
      ok(!JSON.stringify(r.db.T.automation_log).includes("X-Source") && !JSON.stringify(r.db.T.automation_log).includes("first_name"), "nothing of the headers or the body is logged");
      calls.length = 0; answers = [503, 200];
      r = await hook({ template: '{"who":"{name}","q":"{trigger.none}"}' });
      eq([acts33(r.db), calls.length, JSON.parse(calls[1].init.body)], [["n1:sent"], 2, { who: "Sam Smith", q: "" }], "a 5xx is tried once more; a JSON template's blanks are JSON-escaped");
      calls.length = 0; answers = [302];
      r = await hook({});
      eq([acts33(r.db), calls.length], [["n1:failed:the other system answered with a redirect (not followed)"], 1], "a redirect is never followed (no second call)");
      calls.length = 0; const ab = () => Object.assign(new Error("aborted"), { name: "AbortError" }); answers = [ab(), ab()];
      r = await hook({});
      eq([acts33(r.db), calls.length], [["n1:failed:no answer within 10 seconds"], 2], "no answer within 10 s: one more try, then failed");
      calls.length = 0; answers = [404];
      r = await hook({});
      eq([acts33(r.db), calls.length], [["n1:failed:the other system answered 404"], 1], "a 4xx is not tried again");
      calls.length = 0; dns = { "hooks.example.com": ["93.184.216.34", "10.0.0.7"] }; answers = [200];
      r = await hook({});
      eq([acts33(r.db), calls.length], [["n1:failed:refused: the address is a private one"], 0], "a name that resolves to a private address is refused before any call (DNS check)");
      dns = { "hooks.example.com": ["fd00::7"] };
      r = await hook({});
      eq([acts33(r.db), calls.length], [["n1:failed:refused: the address is a private one"], 0], "…also an IPv6 private address");
      dns = {};
      r = await hook({});
      eq([acts33(r.db), calls.length], [["n1:failed:the address was not found"], 0], "a name with no address: failed, no call");
      const dns1 = io.resolveDns; io.resolveDns = async () => { throw Object.assign(new Error("no permission"), { name: "PermissionDenied" }); }; answers = [302];
      r = await hook({});
      io.resolveDns = dns1;
      eq([acts33(r.db), calls.length], [["n1:failed:the other system answered with a redirect (not followed)"], 1], "a runtime that refuses name lookups: only the address is checked");
      calls.length = 0;
      dns = { "hooks.example.com": ["93.184.216.34"] }; answers = [{ opaque: true }];
      const f0 = io.fetch; io.fetch = async (url: string, init: any) => { calls.push({ url, init }); answers.shift(); return { type: "opaqueredirect", status: 0 }; };
      r = await hook({});
      io.fetch = f0;
      eq([acts33(r.db), calls.length], [["n1:failed:the other system answered with a redirect (not followed)"], 1], "an opaque redirect (status 0) is a redirect too: one call, never retried");
      calls.length = 0;
      r = await hook({ headers: [{ name: "Authorization", value: "Bearer x" }] });
      eq([acts33(r.db), calls.length], [["n1:failed:refused: a secret or bad header"], 0], "a secret header is refused at run time too");
      r = await hook({ template: '{"x": {name}}' });
      eq(acts33(r.db), ["n1:failed:the template is not valid JSON"], "a template that is not JSON once filled: failed, nothing sent");
      r = await one({ n1: act("webhook", { url: "https://hooks.example.com/in" }) }, { customer_opt_outs: [{ id: "o1", business_id: "default", contact_id: "c1", channel: "all" }] });
      const r2 = await one({ n1: act("webhook", { url: "https://hooks.example.com/in" }) }, { contacts: [lead("c1", { tags: ["test"] })] });
      eq([acts33(r.db), acts33(r2.db), calls.length], [["n1:skipped:opted out"], ["n1:skipped:test record"], 0], "a lead who opted out of everything, or a test record, is never sent out");
      io.resolveDns = null; answers = [200]; calls.length = 0;
      r = await hook({});
      eq([acts33(r.db), calls.length], [["n1:sent"], 1], "without a name lookup in the runtime only the address itself is checked");
      io.resolveDns = dns0; io.fetch = async () => { throw new Error("network is not allowed in the automations tests"); };
    }

    // ── the inbound webhook: token, 404, 429, 413 / 400, normalisation, lead match, contactless, the draft sample ──
    {
      eq([hookKey("Contact.Email"), hookKey("  First Name "), hookKey("__x__"), hookKey("ÄÖ"), hookKey("a".repeat(60)).length, hookTokenOf("/automations/hook/abc", null), hookTokenOf("/automations", "tok"), hookTokenOf("/automations", null)],
        ["contact_email", "first_name", "x", "", 40, "abc", "tok", ""], "keys: lowercase, dots and spaces → _, at most 40; the token from the path or the header");
      const big: any = {}; for (let i = 0; i < 60; i++) big[`Field.${i}`] = "x".repeat(500);
      const ctx = hookNormalize(big);
      eq([Object.keys(ctx).length <= 50, Object.values(ctx).every((v) => v.length === 150), new TextEncoder().encode(JSON.stringify(ctx)).length <= 7168, Object.keys(ctx)[0]],
        [true, true, true, "field_0"], "payload 50 × 500: at most 50 keys, values cut to 150, keys dropped until it is ≤ 7 KB");
      eq(hookNormalize({ a: { b: 1, c: [1, 2] }, "A.B": "dup", list: [{ n: "x" }], nil: null, t: true }), { a_b: "1", a_c: "1, 2", a_b_2: "dup", list_0_n: "x", nil: "", t: "true" },
        "nested objects joined with _, lists of values as text, a second a_b becomes a_b_2, null = empty");
      const token = "A".repeat(43), other = "B".repeat(43);
      const D = flow({ n1: act("internal_notification", { channel: "push", to: { roles: ["owner"] }, title: "Hook {trigger.first_name}" }) },
        { triggers: [{ id: "t1", type: "inbound_webhook", config: { match: { email: "email", phone: "mobile" } }, filters: NONE }] });
      const O = flow({ n1: act("internal_notification", { channel: "push", to: { roles: ["owner"] }, title: "other" }) }, { triggers: [{ id: "t1", type: "inbound_webhook", filters: NONE }] });
      const mk = async (o: any = {}) => {
        const db = world({ contacts: [lead("c1"), lead("c2", { email: "jo@x.com", phone: "0499 111 222", created_at: "2026-10-01" })], automations: [{ ...D, ...(o.row || {}) }, O],
          automation_hooks: [{ id: "h1", business_id: "default", automation_id: D.id, trigger_id: "t1", sample: [], revoked_at: o.revoked ? isoMs(NOW) : null, window_start: null, window_count: 0 },
            { id: "h2", business_id: "default", automation_id: O.id, trigger_id: "t1", sample: [], revoked_at: null, window_start: null, window_count: 0 }],
          automation_hook_secrets: [{ hook_id: "h1", token_hash: await sha256Hex(token) }, { hook_id: "h2", token_hash: await sha256Hex(other) }],
          automation_state: [{ business_id: "default", tick_lease_until: null, pruned_on: null, phase4_compat: false }], automation_events: [], automation_trigger_log: [], automation_trigger_daily: [],
          automation_enrollment_keys: [], automation_wanted: [] });
        return db;
      };
      let ipN = 0; const ip = () => `198.51.100.${++ipN}`;
      let db = await mk();
      eq([(await hookStep(db, "C".repeat(43), "{}", ip(), NOW)).status, (await hookStep(db, "short", "{}", ip(), NOW)).status, (await hookStep(db, token, "{bad", ip(), NOW)).status,
        (await hookStep(db, token, JSON.stringify({ x: "y".repeat(40000) }), ip(), NOW)).status], [404, 404, 400, 413], "unknown or malformed token: 404 (as no link); not JSON: 400; over 32 KB: 413");
      const okr = await hookStep(db, token, JSON.stringify({ Email: "JO@x.com", First_Name: "Jo", Mobile: "" }), ip(), NOW);
      const ev = db.T.automation_events[0];
      eq([okr, ev.type, ev.source, ev.record_kind, ev.record_id, ev.contact_id, ev.event_key.startsWith("hook:h1:"), ev.ctx, db.T.automation_hooks[0].window_count],
        [{ status: 200, body: { ok: true } }, "inbound_webhook", "hook", "contact", "c2", "c2", true, { email: "JO@x.com", first_name: "Jo", mobile: "", _hook: "h1", _wf: D.id, _trigger: "t1" }, 1],
        "published: one event, the lead matched by the trigger's email key (any case), the link's call counted");
      await hookStep(db, token, JSON.stringify({ mobile: "+61 499 111 222" }), ip(), NOW);
      await hookStep(db, token, JSON.stringify({ name: "nobody" }), ip(), NOW);
      eq(db.T.automation_events.slice(1).map((e: any) => [e.record_kind, e.contact_id]), [["contact", "c2"], ["hook", null]], "matched by the phone key; no match = a run with no lead");
      // the tick matches each call to ITS workflow only, the trigger data reaches the step
      sent.length = 0;
      await tickAt(db, NOW + MIN);
      eq([db.T.automation_runs.filter((r: any) => r.automation_id === D.id).map((r: any) => [r.record_kind, r.contact_id]).sort(), db.T.automation_runs.filter((r: any) => r.automation_id === O.id).length,
        sent.map((x) => x.msg.title).sort(), db.T.automation_trigger_log.filter((r: any) => r.automation_id === D.id).map((r: any) => r.reason).sort()],
        [[["contact", "c2"], ["hook", null]], 0, ["Hook", "Hook Jo"], ["already_enrolled", null, null]],
        "the tick: a call starts the link's own workflow with its data (one active run per lead; a call with no lead = its own run), never another inbound workflow");
      eq([db.T.automation_trigger_log.filter((r: any) => r.automation_id === O.id).length, db.T.automation_trigger_daily.filter((d: any) => d.automation_id === O.id).length], [0, 0],
        "…the other inbound workflow never looks at a call to another link (no unmatched row, no daily count: its 200-a-day cap and stats stay its own)");
      // the event store off (compat mode, step E rolled back): the call is refused (503) and nothing piles up to act late
      {
        const dbc = await mk();
        dbc.T.automation_state[0].phase4_compat = true;
        const r503 = await hookStep(dbc, token, JSON.stringify({ email: "jo@x.com" }), ip(), NOW);
        eq([r503.status, dbc.T.automation_events.length, dbc.T.automation_hooks[0].sample.length], [503, 0, 1], "compat mode: an inbound call is refused with 503 (only the sample kept), no event to start a run hours later");
      }
      // 429: 61 calls a minute on one link; 31 a minute from one address (before any database call)
      db = await mk();
      const codes: number[] = [];
      for (let i = 0; i < 61; i++) codes.push((await hookStep(db, token, "{}", `203.0.113.${i % 30}`, NOW + 10)).status);
      eq([codes.filter((c) => c === 200).length, codes[60]], [60, 429], "a link takes 60 calls a minute, then 429");
      eq((await hookStep(db, token, "{}", "203.0.113.200", NOW + 61e3)).status, 200, "…and again the next minute");
      db = await mk();
      const from1: number[] = []; const calls0 = db.calls.length;
      for (let i = 0; i < 31; i++) from1.push((await hookStep(db, "Z".repeat(43), "{}", "192.0.2.77", NOW + 3e6)).status);
      const before31 = db.calls.length;
      await hookStep(db, "Z".repeat(43), "{}", "192.0.2.77", NOW + 3e6);
      eq([from1.slice(0, 30).every((c) => c === 404), from1[30], db.calls.length === before31, calls0 < before31], [true, 429, true, true], "31 calls a minute from one address: 429, before any database call");
      // a revoked link is 404; a Draft keeps only the sample (keys and types of the last 3 payloads), no event
      db = await mk({ revoked: true });
      eq((await hookStep(db, token, "{}", ip(), NOW)).status, 404, "a revoked link: 404");
      db = await mk({ row: { enabled: false } });
      for (let i = 1; i <= 4; i++) await hookStep(db, token, JSON.stringify({ n: i, Who: "x".repeat(300), ok: true, z: null }), ip(), NOW + i);
      const smp = db.T.automation_hooks[0].sample;
      eq([db.T.automation_events.length, smp.length, smp[2].keys.map((x: any) => [x.key, x.type, x.value.length]), smp[0].keys[0].value],
        [0, 3, [["n", "number", 1], ["who", "text", 200], ["ok", "boolean", 4], ["z", "null", 0]], "2"], "a Draft: no event, only the sample — the last 3 payloads' keys and types (values ≤ 200)");
      // the builder's link steps: a new token shown once (only its sha-256 kept), the old one revoked; sample; revoke
      db = await mk({ row: { enabled: false } });
      const c1 = await handle(db, { step: "hook_create", automation_id: D.id, trigger_id: "t1" }, OWNER, false);
      const t1 = c1.body.token;
      const h1 = await sha256Hex(t1);
      eq([c1.status, HOOK_TOKEN_RE.test(t1), db.T.automation_hooks.find((h: any) => h.id === "h1").revoked_at != null, db.T.automation_hook_secrets.some((x: any) => x.token_hash === t1),
        db.T.automation_hook_secrets.some((x: any) => x.token_hash === h1 && x.hook_id === c1.body.hook_id), JSON.stringify(db.T.automation_hooks).includes(t1), c1.body.path.endsWith(t1)], [200, true, true, false, true, false, true],
        "hook_create: a 32-byte token shown once, only its sha-256 stored, the trigger's older link revoked");
      eq([(await handle(db, { step: "hook_create", automation_id: D.id, trigger_id: "t1" }, VA, false)).status, (await handle(db, { step: "hook_create", automation_id: D.id, trigger_id: "nope" }, OWNER, false)).status],
        [403, 404], "only owners and managers; only an inbound webhook trigger of a saved workflow");
      await hookStep(db, t1, JSON.stringify({ a: 1 }), ip(), NOW);
      const sm = await handle(db, { step: "hook_sample", automation_id: D.id, trigger_id: "t1" }, MANAGER, false);
      const rv = await handle(db, { step: "hook_revoke", hook_id: c1.body.hook_id }, OWNER, false);
      eq([sm.body.sample.length, sm.body.sample[0].keys[0].key, rv.body.revoked, (await hookStep(db, t1, "{}", ip(), NOW)).status], [1, "a", 1, 404], "hook_sample gives the Draft's sample; hook_revoke ends the link (404 after)");
    }

    // ── SQL Part 2 · G2.3: the replaced functions keep Part 1's contract; the ROLLBACK restores Part 1 exactly ──
    {
      const sql = src(SQL_DIR + "stage2-automations.sql"), p1 = sql.slice(sql.indexOf("-- PART 1"), sql.indexOf("-- END PART 1"));
      const g = sql.slice(sql.indexOf("-- PART 2 · G2.3"), sql.indexOf("-- END PART 2 · G2.3"));
      const tx = g.slice(g.indexOf("\nbegin;\n"), g.indexOf("\ncommit;\n"));
      const rbx = g.slice(g.indexOf("-- ROLLBACK (G2.3 only")).split("\n").filter((l: string) => l.startsWith("-- ") || l === "--").map((l: string) => l === "--" ? "" : l.slice(3)).join("\n");
      const fnOf = (text: string, name: string) => { const a0 = text.indexOf(`create or replace function public.${name}(`); return a0 < 0 ? "" : text.slice(a0, text.indexOf("end $$;", a0) + 7); };
      const allowed = /allowed constant text\[\] := array\[([^\]]*)\]/.exec(fnOf(tx, "automation_apply"));
      eq(allowed ? allowed[1].split(",").map((x: string) => x.trim().replace(/'/g, "")) : null, UPDATE_FIELD_COLUMNS, "G2.3's automation_apply: the 'set' whitelist is still UPDATE_FIELD_COLUMNS");
      ok(fnOf(rbx, "automation_apply") === fnOf(p1, "automation_apply") && fnOf(rbx, "automation_capture_contacts") === fnOf(p1, "automation_capture_contacts") && fnOf(p1, "automation_apply").length > 5000,
        "the G2.3 ROLLBACK restores Part 1's automation_apply and automation_capture_contacts byte for byte");
      const head = (name: string) => { const f0 = tx.indexOf(`function public.${name}(`); return tx.slice(f0, tx.indexOf("as $$", f0)); };
      ok(["contact_tags_edit", "contact_note_add", "contact_note_remove"].every((n0) => /security invoker/.test(head(n0)) && tx.includes(`grant execute on function public.${n0}(`) && new RegExp(`revoke all on function public\\.${n0}\\([^)]*\\) from public, anon;`).test(tx))
        && /security definer/.test(head("automation_hook_hit")) && /revoke all on function public\.automation_hook_hit\([^)]*\) from public, anon, authenticated;/.test(tx)
        && ["contact_tags_edit", "contact_note_add", "contact_note_remove", "automation_hook_hit", "contact_tags_merge", "contact_notes_append"].every((n0) => rbx.includes(`drop function if exists public.${n0}(`)),
        "the lead card's functions run with the signed-in person's rights (RLS), the link counter for the service role only; the ROLLBACK drops them all");
      ok(fnOf(tx, "automation_capture_contacts").includes("'note_added' = any(w)") && fnOf(tx, "automation_capture_contacts").replace(/\n    -- Note added[\s\S]*?\n    end if;\n/, "\n") === fnOf(p1, "automation_capture_contacts"),
        "the capture of contacts = Part 1's + Note added, nothing else changed");
      eq([...new Set([...src("index.ts").matchAll(/rpc\("(contact_[a-z_]+)"/g)].map((m: any) => m[1]))].filter((n0) => !SQL_SIGS[n0]), [], "every lead-card RPC exists");
      eq([SQL_SIGS.contact_tags_edit.params, SQL_SIGS.contact_note_add.params, SQL_SIGS.contact_note_remove.params, SQL_SIGS.automation_hook_hit.params],
        [["p_id", "p_add", "p_remove"], ["p_id", "p_note"], ["p_id", "p_note_id"], ["p_business", "p_hook", "p_now", "p_limit"]], "the RPC signatures the app and the engine call");
      const app = src("../../../index.html");
      eq(["contact_tags_edit", "contact_note_add", "contact_note_remove"].filter((n0) => !app.includes(`'${n0}'`)), [], "the lead card calls the three atomic functions");
    }
  }

  // ── 34. the API, the guards' twin, migration and housekeeping (G2.4, design §3.1, §3.13, §3.15, §3.16, §6, §8.1 #23,
  //        §8.2 #24, §8.3 #4): save / publish / duplicate / validate / schema / registry / migrate / restore /
  //        copy_version, snapshots, templates seeding, the Needs-review sweep, housekeeping with its cursor; wfToFlat
  //        (the old editor's adapter) round trip; migrate idempotent; the Part-2 SQL in step with the engine ──
  {
    io.advance = PROD_ADVANCE;
    const C34 = (x: any) => canonJson(x);
    const UP = JSON.parse(src("fixtures/upgrade.json")).cases;
    const NONE = { match: "all", segments: [{ match: "all", rules: [] }] };
    const api = (db: any, step: string, body: any = {}, me: any = OWNER) => handle(db, { step, ...body }, me, false);
    const v1row = (o: any = {}) => auto({ enabled: true, armed_at: "2026-10-01T00:00:00.000Z", version: 3, audience: "team", updated_at: "2026-10-02T00:00:00.000Z", revision: 1, settings: {}, layout: { v: 1 }, builder: "standard", origin: "user", list_summary: {}, deleted_at: null, ...o });

    // wfToFlat: the inverse of upgradeV1 on every phase-4 shape (the old editor opens it; design §7 G2.4)
    {
      const reIds = new Set(["ids that are not v2 ids get fresh ones", "the same id twice"]);
      for (const k of UP) {
        const f = wfToFlat(k.expect.doc);
        ok(!!f, `wfToFlat: ${k.name} is a straight phase-4 chain`);
        if (!f) continue;
        eq(C34(upgradeV1(f.trigger, f.steps).doc), C34(k.expect.doc), `wfToFlat → upgradeV1 gives the same doc back: ${k.name}`);
        const want = { trigger: { type: k.v1.trigger.type, params: Object.fromEntries(Object.entries(k.v1.trigger.params || {}).filter(([p, v]) => !(p === "stage" && v === ""))) }, steps: k.v1.steps };
        if (!reIds.has(k.name)) eq(C34(f), C34(want), `wfToFlat gives the phase-4 steps back: ${k.name}`);
      }
      const base = UP[0].expect.doc, mod = (fn: (d: any) => void) => { const d = JSON.parse(JSON.stringify(base)); fn(d); return wfToFlat(d); };
      eq([mod((d) => { d.nodes.s1.name = "Wait"; }), mod((d) => { d.nodes.s1.config.resume = { days: [1], from: "09:00", until: "17:00" }; }),
        mod((d) => { d.triggers.push({ id: "t9", type: "newLead", filters: NONE }); }), mod((d) => { d.triggers[0].disabled = true; }),
        mod((d) => { d.nodes.s2.config.branches.push({ id: "b9", name: "Other", when: { match: "any", segments: [{ match: "all", rules: [] }] } }); d.nodes.s2.out.b9 = null; }),
        mod((d) => { d.nodes.s2.out.none = "s4"; d.nodes.s2.out.s2_yes = "s3"; d.nodes.s3.out.next = null; }), mod((d) => { d.nodes.x9 = { kind: "action", type: "send_email", config: { subject: "a", body: "b" }, out: { next: null } }; }),
        mod((d) => { d.nodes.s4.type = "send_live_chat"; }), mod((d) => { d.triggers[0].type = "contact_tag"; }), mod((d) => { d.nodes.s4.disabled = true; }), mod((d) => { d.triggers[0].goto = "s3"; })],
        [null, null, null, null, null, null, null, null, null, null, null], "wfToFlat: anything only the new builder makes (names, resume, two triggers, a second branch, a step on None, an unconnected step, a stage-2 action or trigger, a paused step, a trigger Go to) → null");
      // the run view: an upgraded row that is still a phase-4 workflow runs as one; anything else runs its doc
      const leg = { ...WF_MIGRATED_SETTINGS }, d0 = JSON.parse(JSON.stringify(base));
      const r0 = wfRunRow({ id: "r0", definition: d0, settings: leg, trigger: UP[0].v1.trigger, steps: UP[0].v1.steps });
      eq([r0.definition, C34(r0.steps), C34(r0.trigger)], [null, C34(UP[0].v1.steps), C34(UP[0].v1.trigger)], "wfRunRow: an unedited upgraded row runs its own phase-4 steps (every claim id before the migration matches)");
      const d1 = JSON.parse(JSON.stringify(base)); d1.nodes.s4.config.subject = "New words";
      const r1 = wfRunRow({ id: "r1", definition: d1, settings: leg, trigger: UP[0].v1.trigger, steps: UP[0].v1.steps });
      eq([r1.definition, r1.steps[3].subject], [null, "New words"], "wfRunRow: edited in the old editor: the doc's steps (wfToFlat), still the phase-4 rules");
      const r2 = { id: "r2", definition: d1, settings: { ...leg, stopOnResponse: true }, trigger: {}, steps: [] }, r3 = { id: "r3", definition: d1, settings: {}, trigger: {}, steps: [] };
      eq([wfRunRow(r2) === r2, wfRunRow(r3) === r3, wfRunRow({ id: "r4", trigger: {}, steps: [] }).id, wfRunRow(null)], [true, true, "r4", null], "wfRunRow: a stage-2 setting or the GHL re-entry → the doc itself; a phase-4 row as it is");
      // an invalid phase-4 id upgradeV1 had to change still maps back (claims and log rows of before the migration)
      const odd = { id: "r5", definition: upgradeV1({ type: "newLead", params: {} }, [{ id: "a-1", kind: "action", type: "push", to: { roles: ["owner"] }, title: "X" }]).doc,
        settings: { reentry: "off" }, trigger: { type: "newLead", params: {} }, steps: [{ id: "a-1", kind: "action", type: "push", to: { roles: ["owner"] }, title: "X" }] };
      eq(C34(runDocOf(odd).idMap), C34({ "a-1": Object.keys(odd.definition.nodes)[0] }), "runDocOf: a doc row with old phase-4 steps maps an old id to its node (RUNBOOK §8)");
    }

    // wfGuardedChannels = SQL automation_guarded_channels; the audience map = the registry, line by line
    {
      eq(wfGuardedChannels({ nodes: { a: { kind: "action", type: "send_email" }, b: { kind: "action", type: "webhook", disabled: true }, c: { kind: "action", type: "internal_notification" },
        d: { kind: "teleport" }, e: { kind: "wait", type: "period" }, f: { kind: "action", type: "beam_me_up" } } }), ["beam_me_up", "send_email", "teleport", "webhook"],
        "guarded types: customer and external actions, paused ones too, unknown types and kinds count; team / waits never");
      const sql = src(SQL_DIR + "stage2-automations.sql"), g = sql.slice(sql.indexOf("-- PART 2 · G2.4"), sql.indexOf("-- END PART 2 · G2.4"));
      const tx = g.slice(g.indexOf("\nbegin;\n"), g.indexOf("\ncommit;\n"));
      const aud = Object.fromEntries([...tx.matchAll(/^    when '([a-z_]+)' then '([a-z]+)'$/gm)].map((m: any) => [m[1], m[2]]));
      eq(aud, Object.fromEntries(Object.values(WF_ACTIONS).map((a: any) => [a.key, a.audience])), "SQL automation_action_audience = the registry's audiences (every action, nothing else)");
      eq(Object.entries(aud).filter(([, a]) => a === "customer" || a === "external").map(([k]) => k).sort(), [...WF_GUARDED_TYPES].sort(), "the SQL guarded types = WF_GUARDED_TYPES");
      const fnOf = (text: string, name: string) => { const a0 = text.indexOf(`create or replace function public.${name}(`); return a0 < 0 ? "" : text.slice(a0, text.indexOf("end $$;", a0) + 7); };
      const rbx = g.slice(g.indexOf("-- ROLLBACK (G2.4 only")).split("\n").filter((l: string) => l.startsWith("-- ") || l === "--").map((l: string) => l === "--" ? "" : l.slice(3)).join("\n");
      const p4 = src(SQL_DIR + "settings-round2-phase4.sql"), p1 = sql.slice(sql.indexOf("-- PART 1"), sql.indexOf("-- END PART 1"));
      ok(fnOf(rbx, "automations_guard") === fnOf(p4, "automations_guard") && fnOf(p4, "automations_guard").length > 1000 && rbx.includes("create trigger automations_customer_off_guard before update on public.automations"),
        "the G2.4 ROLLBACK puts phase 4's guard and its customer switch-off trigger back byte for byte");
      const nr = (t: string) => { const a0 = t.indexOf("create or replace function public.automation_needs_review()"); return t.slice(a0, t.indexOf("$$;", t.indexOf("as $$", a0) + 5) + 3); };
      ok(nr(rbx) === nr(p1) && nr(p1).length > 200, "the ROLLBACK puts Part 1's automation_needs_review back");
      ok(["automations_after", "automation_save", "automation_publish", "automation_migrate_row", "automation_arm_key", "automation_def_shape", "automation_node_ports", "automation_guarded_channels_v1", "automation_guarded_channels", "automation_action_audience"].every((n0) => rbx.includes(`drop function if exists public.${n0}(`)),
        "the ROLLBACK drops every G2.4 function");
      ok(/a\.trigger = '\{\}'::jsonb/.test(rbx) && /a\.revision > coalesce\(\(select max\(v\.revision\) from public\.automation_versions v where v\.automation_id = a\.id and v\.reason = 'migration'\)/.test(rbx) && /a\.updated_at > s\.v2_migrated_at/.test(rbx),
        "the ROLLBACK switches off every row made or edited in stage 2 (made: no trigger; edited: a later revision than its migration snapshot, or changed after v2_migrated_at)");
      const head = (name: string) => { const f0 = tx.indexOf(`function public.${name}(`); return tx.slice(f0, tx.indexOf("as $$", f0)); };
      ok(["automation_save", "automation_publish", "automation_migrate_row", "automations_after"].every((n0) => /security definer/.test(head(n0)) && new RegExp(`revoke all on function public\\.${n0}\\([^)]*\\) from public, anon, authenticated;`).test(tx))
        && ["automation_save", "automation_publish", "automation_migrate_row"].every((n0) => new RegExp(`grant execute on function public\\.${n0}\\([^)]*\\) to service_role;`).test(tx)) && /security invoker/.test(head("automations_guard")),
        "the content writes run for the service role only (security definer); the guard with the caller's rights");
      ok(/set_config\('automation\.via', 'fn', true\)/.test(fnOf(tx, "automation_save")) && /set_config\('automation\.migrating', 'on', true\)/.test(fnOf(tx, "automation_migrate_row")) && /and a\.definition is null/.test(fnOf(tx, "automation_migrate_row")),
        "save / publish / migrate say who writes (automation.via); migrate only touches rows without a doc (idempotent)");
      ok(/raise exception 'This workflow was upgraded: reload the app'/.test(fnOf(tx, "automations_guard")) && /new\.enabled := false;\s+-- always a Draft/.test(fnOf(tx, "automations_guard")) && /drop trigger if exists automations_customer_off_guard/.test(tx),
        "the guard: a write of the phase-4 columns on an upgraded row is refused; an insert is always a Draft; the phase-4 switch-off trigger goes");
      eq(SQL_SIGS.automation_save.params, ["p_business", "p_id", "p_expected", "p_name", "p_definition", "p_settings", "p_layout", "p_builder", "p_origin", "p_reason", "p_draft", "p_summary", "p_actor", "p_actor_name"], "automation_save's parameters (the engine calls it by name)");
      // the staging check runs every shape.json pair through the SQL keys: its literal = the fixture (settings as stored)
      const chk = src(SQL_DIR + "stage2-part1-staging-checks.sql"), lm = /-- shape\.json \(generated\): (\[.*\])$/m.exec(chk);
      const lit = JSON.parse(src("fixtures/shape.json")).cases.map((k: any) => ({ name: k.name, a: k.a.doc, b: k.b.doc, sa: normWfSettings(k.a.settings, k.a.settings), sb: normWfSettings(k.b.settings, k.b.settings), shape: k.sameShape, arm: k.sameArm }));
      ok(!!lm && lm[1] === JSON.stringify(lit) && chk.includes("cases jsonb := '" + JSON.stringify(lit).replace(/'/g, "''") + "'"), "the staging check's shape cases = fixtures/shape.json (regenerate both together)");
    }

    // migrate (design §3.16, §8.3 #4): every row once, version / armed_at / enabled / audience kept, revision + 1, one
    // "migration" version each, the templates seeded once, v2_migrated_at; again = nothing
    {
      const a1 = v1row({ id: "m34-0001", name: "Team push" }), a2 = v1row({ id: "m34-0002", name: "Mail", audience: "customer", steps: [emailStep()] }),
        a3 = v1row({ id: "m34-0003", name: "Off", enabled: false, armed_at: null, version: 1 });
      const db = world({ automations: [a1, a2, a3], automation_versions: [], automation_templates: [] });
      eq((await api(db, "migrate", {}, MANAGER)).status, 403, "migrate: owners only");
      const before = db.T.automations.map((a: any) => [a.id, a.version, a.armed_at, a.enabled, a.audience, a.updated_at]);
      const m1 = await api(db, "migrate");
      eq([m1.status, m1.body.migrated, m1.body.left, m1.body.templates], [200, 3, 0, WF_TEMPLATE_SEEDS.length], "migrate: every phase-4 row gets its doc; the ready-made templates are seeded");
      eq(db.T.automations.map((a: any) => [a.id, a.version, a.armed_at, a.enabled, a.audience, a.updated_at]), before, "migrate keeps version, armed_at, enabled, audience (and the edit time): nothing re-arms, nothing waiting stops");
      eq(db.T.automations.map((a: any) => [a.revision, C34(a.definition) === C34(upgradeV1(a.trigger, a.steps).doc), a.settings.reentry, a.list_summary.audience]),
        [[2, true, "legacy_always", "team"], [2, true, "legacy_always", "customer"], [2, true, "legacy_always", "team"]], "migrate: the doc = upgradeV1 (shape equal), the phase-4 settings, revision + 1, the list summary");
      eq(db.T.automation_versions.map((v: any) => [v.automation_id, v.version_no, v.reason, v.revision, v.status]),
        [["m34-0001", 1, "migration", 2, "published"], ["m34-0002", 1, "migration", 2, "published"], ["m34-0003", 1, "migration", 2, "draft"]], "migrate: one migration snapshot each");
      ok(!!db.T.automation_state[0].v2_migrated_at && db.T.automation_templates.every((t: any) => t.origin === "system") && WF_TEMPLATE_SEEDS.every((t) => !validateStructure(t.definition).length && !validateDoc(t.definition, { catalog: CATALOG }).errors.length),
        "migrate: v2_migrated_at set; the templates are System ones and every seed is a valid workflow");
      const snap = JSON.stringify(db.T);
      const m2 = await api(db, "migrate");
      eq([m2.body.migrated, m2.body.templates, JSON.stringify(db.T) === snap], [0, 0, true], "migrate again: nothing (idempotent)");
      // a row the old app made after the migration is upgraded by the next run, alone
      db.T.automations.push(v1row({ id: "m34-0004", name: "Late" }));
      const m3 = await api(db, "migrate");
      eq([m3.body.migrated, db.T.automation_versions.length], [1, 4], "migrate: a row added later is upgraded by the next run");
      // a run started by phase 4 (step_index, no cursor) goes on after the migration on the same step
      const db2 = world({ contacts: [lead("c1")], automations: [v1row({ id: "m34-0005", steps: [{ id: "w1", kind: "wait", n: 10, unit: "minutes" }, { id: "p1", kind: "action", type: "push", to: { roles: ["owner"] }, title: "Hi {name}" }] })] });
      sent.length = 0;
      await tickAt(db2, NOW); await api(db2, "migrate");
      await tickAt(db2, NOW + 11 * MIN);
      eq([db2.T.automation_runs.map((r: any) => r.status), logOf(db2), sent.length], [["done"], ["p1:sent"], 1], "a run waiting across the migration finishes on the same step, once");
    }

    // save / publish / validate / duplicate / restore / copy_version (design §3.13, §4.7): snapshots, 409, Published
    // refuses errors, Draft saves with them, AI → Draft, only an owner adds a Webhook, the guard's twin (fake)
    {
      const db = world({ contacts: [lead("c1")], automations: [], automation_versions: [], automation_templates: [] });
      const doc = (nodes: any, triggers: any[] = [{ id: "t1", type: "newLead", filters: NONE }], entry = Object.keys(nodes)[0]) => ({ schema: 2, seq: 20, entry, triggers, nodes });
      const push = (title = "New lead: {name}", next: any = null) => ({ kind: "action", type: "internal_notification", config: { channel: "push", to: { roles: ["owner"] }, title }, out: { next } });
      const d1 = doc({ n1: push() });
      const s1 = await api(db, "save", { automation_id: null, name: "Team alert", definition: d1, settings: {} });
      const id = s1.body.id, row = () => db.T.automations.find((a: any) => a.id === id);
      eq([s1.status, s1.body.enabled, s1.body.revision, s1.body.version_no, row().origin, row().settings.reentry, db.T.automation_versions[0].reason], [200, false, 1, 1, "user", "off", "create"],
        "save: a new workflow is a Draft (GHL settings: re-entry off), one 'create' version");
      eq((await api(db, "save", { automation_id: id, expected_revision: 7, name: "X", definition: d1 })).status, 409, "save: someone saved in between → 409");
      const s2 = await api(db, "save", { automation_id: id, expected_revision: 1, name: "Team alert", definition: d1, settings: {}, layout: { v: 1, adv: { n1: [10, 20] } } });
      eq([s2.status, s2.body.revision, s2.body.version_no, db.T.automation_versions.length], [200, 2, null, 1], "save: a layout-only change → a new revision, no version row");
      const s3 = await api(db, "save", { automation_id: id, expected_revision: 2, name: "Team alert", definition: doc({ n1: push("Lead: {name}") }), reason: "save_version" });
      eq([s3.body.version_no, db.T.automation_versions[1].reason], [2, "save_version"], "save: new words → a version row (Save Version)");
      const s4 = await api(db, "save", { automation_id: id, expected_revision: 3, name: "Team alert", definition: doc({ n1: push("Lead: {name}") }) });
      eq([s4.body.revision, s4.body.version_no], [3, null], "save: the same content again → no version row (hash), no new revision");
      const bad = doc({ n1: { kind: "action", type: "internal_notification", config: { channel: "push", to: { roles: [] }, title: "x" }, out: { next: null } } });
      const s5 = await api(db, "save", { automation_id: id, expected_revision: 3, name: "Team alert", definition: bad });
      eq([s5.status, s5.body.errors.length > 0, row().revision], [200, true, 4], "save: a Draft is saved with its errors (listed)");
      const s6 = await api(db, "publish", { automation_id: id, on: true });
      eq([s6.status, s6.body.reason, row().enabled], [422, "errors", false], "publish: refused while there are errors");
      await api(db, "save", { automation_id: id, expected_revision: 4, name: "Team alert", definition: d1 });
      const p1 = await api(db, "publish", { automation_id: id, on: true });
      eq([p1.status, p1.body.enabled, !!p1.body.armed_at, p1.body.revision, row().published_by, db.T.automation_versions.slice(-1)[0].reason], [200, true, true, 5, "u-owner", "publish"],
        "publish: a team workflow goes on at once (no confirm), armed now, revision unchanged, a 'publish' version");
      eq((await api(db, "save", { automation_id: id, expected_revision: 5, name: "Team alert", definition: bad })).status, 422, "save: a Published workflow refuses errors (422)");
      // a run waits; a new shape cancels it at once (automations_after), a filter edit only re-arms, words neither
      const waitDoc = doc({ w1: { kind: "wait", type: "period", config: { n: 1, unit: "hours" }, out: { next: "n1" } }, n1: push() });
      let r = await api(db, "save", { automation_id: id, expected_revision: 5, name: "Team alert", definition: waitDoc });
      eq([r.body.shapeChanged, r.body.enabled, row().version], [true, true, 2], "save while Published: a new shape → version + 1");
      const armed0 = row().armed_at;
      db.T.automation_runs.push({ id: "run34", business_id: "default", automation_id: id, automation_version: 2, revision: 6, status: "waiting", due_at: isoMs(NOW + HR), event_key: "c1:new", event_type: "newLead",
        event_at: isoMs(NOW), record_kind: "contact", record_id: "c1", contact_id: "c1", cursor_step: "w1", enrollment_key: "c1", active_lock: "c1", context: {}, step_index: 0 });
      db.T.automation_enrollment_keys = [{ business_id: "default", automation_id: id, enrollment_key: "c1", first_at: isoMs(NOW), last_at: isoMs(NOW), runs: 1 }];
      clock = NOW + MIN;
      r = await api(db, "save", { automation_id: id, expected_revision: 6, name: "Team alert", definition: doc({ w1: waitDoc.nodes.w1, n1: push() }, [{ id: "t1", type: "newLead", filters: { match: "all", segments: [{ match: "all", rules: [{ field: "source", op: "is", v: "Referral" }] }] } }]) });
      eq([r.body.shapeChanged, r.body.armChanged, row().version, row().armed_at !== armed0, db.T.automation_runs[0].status], [false, true, 2, true, "waiting"], "save while Published: a filter edit re-arms (armed_at now), same version, nothing waiting stops");
      clock = NOW;
      r = await api(db, "save", { automation_id: id, expected_revision: 7, name: "Team alert", definition: doc({ w1: { ...waitDoc.nodes.w1, config: { n: 2, unit: "hours" } }, n1: push("Other words") }, row().definition.triggers) });
      eq([r.body.shapeChanged, r.body.armChanged, db.T.automation_runs[0].status], [false, false, "waiting"], "save while Published: words and numbers → neither (waiting runs go on with them)");
      r = await api(db, "save", { automation_id: id, expected_revision: 8, name: "Team alert", definition: doc({ n1: push() }) });
      const run = db.T.automation_runs[0], exit = db.T.automation_log.find((l: any) => l.run_id === "run34" && l.row_kind === "exit");
      eq([r.body.shapeChanged, run.status, run.exit_reason, run.reason, run.active_lock, !!exit && exit.status, db.T.automation_enrollment_keys.length],
        [true, "cancelled", "automation_changed", "automation changed", null, "removed", 0], "a new shape while a run waits: cancelled at once, an exit row, its re-entry key deleted (the lead can enter again)");
      // a customer email added while Published → Draft; then publish needs the confirm
      r = await api(db, "save", { automation_id: id, expected_revision: 9, name: "Team alert", definition: doc({ n1: push("x", "e1"), e1: { kind: "action", type: "send_email", config: { subject: "Hi", body: "{hi}, thanks." }, out: { next: null } } }) });
      eq([r.body.drafted, r.body.enabled, row().audience], [true, false, "customer"], "save: a customer email added to a Published workflow → Draft (the guard)");
      r = await api(db, "publish", { automation_id: id, on: true });
      eq([r.status, r.body.reason, r.body.confirm], [409, "confirm", ["Sends to customers: Send email"]], "publish: a workflow that writes to customers asks first (what it sends)");
      r = await api(db, "publish", { automation_id: id, on: true, confirm: true });
      eq([r.status, row().enabled], [200, true], "publish with the yes: on");
      // an AI edit of a Published workflow is saved as a Draft
      r = await api(db, "save", { automation_id: id, expected_revision: 10, name: "Team alert", definition: doc({ n1: push("AI words", "e1"), e1: row().definition.nodes.e1 }), ai_edited: true });
      eq([r.body.enabled, row().origin, db.T.automation_versions.slice(-1)[0].reason], [false, "user", "ai"], "save: an AI edit is always a Draft (reason ai)");
      // only an owner adds a Webhook step; the publish confirm names the host
      const hook = { kind: "action", type: "webhook", config: { url: "https://hooks.example.com/x", method: "POST" }, out: { next: null } };
      r = await api(db, "save", { automation_id: id, expected_revision: 11, name: "Team alert", definition: doc({ n1: push("x", "h1"), h1: hook }) }, MANAGER);
      eq([r.status, r.body.reason], [403, "Only an owner can add a Webhook step or change where it sends"], "save: a manager can't add a Webhook step");
      r = await api(db, "save", { automation_id: id, expected_revision: 11, name: "Team alert", definition: doc({ n1: push("x", "h1"), h1: hook }) });
      eq(r.status, 200, "save: the owner can");
      eq((await api(db, "publish", { automation_id: id, on: true })).body.confirm, ["Sends lead details to hooks.example.com"], "publish: the confirm says where lead details go");
      // validate: what a save would change
      db.T.automation_runs.push({ ...run, id: "run34b", status: "waiting", event_key: "c1:b", active_lock: null });
      const v = await api(db, "validate", { automation_id: id, definition: doc({ n1: push() }), settings: {}, base_revision: 3 });
      eq([v.status, v.body.shapeChanged, v.body.idsRemoved, v.body.waitingRunsAffected, v.body.revisionChanged, v.body.errors], [200, true, ["h1"], 1, true, []], "validate: shape change, the ids it removes, the runs it would stop, a newer revision");
      eq((await api(db, "validate", { definition: { schema: 2, seq: -1, entry: null, triggers: [], nodes: {} } })).body.errors.map((x: any) => x.code).includes("E_SCHEMA"), true, "validate: codes for a broken doc");
      // switch off: waiting runs stop at once, an 'unpublish' version
      await api(db, "publish", { automation_id: id, on: true, confirm: true });
      r = await api(db, "publish", { automation_id: id, on: false });
      eq([r.body.enabled, db.T.automation_runs.find((x: any) => x.id === "run34b").exit_reason, db.T.automation_versions.slice(-1)[0].reason, r.body.revision], [false, "switched_off", "unpublish", 12],
        "unpublish: off, what waits stops ('switched off'), an 'unpublish' version, the revision unchanged");
      // restore (Draft only) and copy_version
      eq((await api(db, "restore", { automation_id: id, version_no: 1 })).status, 200, "restore: a Draft takes an old version back");
      eq([row().definition.nodes.n1.config.title, row().name, db.T.automation_versions.slice(-1)[0].reason], ["New lead: {name}", "Team alert", "restore"], "restore: the snapshot's doc, as a 'restore' version");
      await api(db, "publish", { automation_id: id, on: true, confirm: true });
      eq((await api(db, "restore", { automation_id: id, version_no: 2 })).body.text, "Switch to Draft first, or create a new workflow from this version", "restore: refused while Published (GHL)");
      const cv = await api(db, "copy_version", { automation_id: id, version_no: 2 });
      const copy = db.T.automations.find((a: any) => a.id === cv.body.id);
      eq([cv.status, copy.enabled, copy.origin, copy.name, copy.definition.nodes.n1.config.title, copy.system_key], [200, false, "copy", "Copy of Team alert", "Lead: {name}", null], "copy_version: a new Draft from that version");
      // duplicate: library words copied to new keys (the copy never changes the original's messages); system_key never copied
      db.T.settings[0].catalog = { ...CATALOG, templates: { ...CATALOG.templates, my_abc12345: "{hi}, our words." }, msgTemplates: { my_abc12345: { name: "Ours", channel: "email" } } };
      db.T.automations.find((a: any) => a.id === id).system_key = "team:newLead";
      const withTpl = doc({ e1: { kind: "action", type: "send_email", config: { subject: "Hi", templateKey: "my_abc12345" }, out: { next: null } } });
      const base2 = await api(db, "save", { automation_id: null, name: "With words", definition: withTpl });
      const dup = await api(db, "duplicate", { automation_id: base2.body.id });
      const drow = db.T.automations.find((a: any) => a.id === dup.body.id), k2 = drow.definition.nodes.e1.config.templateKey, cat2 = db.T.settings[0].catalog;
      eq([dup.status, drow.enabled, drow.origin, k2 !== "my_abc12345" && WF_LIB_KEY_RE.test(k2), cat2.templates[k2], cat2.msgTemplates[k2].name, cat2.templates.my_abc12345], [200, false, "copy", true, "{hi}, our words.", "Copy of Ours", "{hi}, our words."],
        "duplicate: a Draft copy; its library words copied to a new key (the original's stay)");
      const dsys = await api(db, "duplicate", { automation_id: id });
      eq(db.T.automations.find((a: any) => a.id === dsys.body.id).system_key, null, "duplicate: a System row's system_key is never copied");
      const tpl = db.T.automation_templates[0] || null;
      if (!tpl) { await api(db, "migrate"); }
      const t0 = db.T.automation_templates.find((t: any) => t.key === "team_new_lead");
      const dt = await api(db, "duplicate", { template_id: t0.id });
      const trow = db.T.automations.find((a: any) => a.id === dt.body.id);
      eq([dt.status, trow.origin, trow.template_key, trow.enabled], [200, "template", "tpl:team_new_lead", false], "duplicate a template: origin template, template_key tpl:<key>, a Draft");
      // the template library's own templates (G3.3, design §4.3): Upload to Template Library, then Rename / Delete under Mine
      const nT = db.T.automation_templates.length;
      const tu = await api(db, "template_upload", { automation_id: id, name: "  Our team alert  ", description: "Tells the owners.", category: "Team notifications" });
      const mine = db.T.automation_templates.find((t: any) => t.id === tu.body.id);
      eq([tu.status, WF_TPL_KEY_RE.test(mine.key), mine.origin, mine.name, mine.description, mine.category, mine.source_automation_id, mine.created_by_name, mine.definition.schema, db.T.automation_templates.length - nT],
        [200, true, "user", "Our team alert", "Tells the owners.", "Team notifications", id, "Olivia Owner", 2, 1], "template_upload: the workflow's doc becomes a template of the business's own (origin user, a mine_ key)");
      eq(JSON.stringify(mine.definition) === JSON.stringify(row().definition) && mine.definition !== row().definition, true, "template_upload: a copy of the doc, never the same object");
      const up2 = await api(db, "template_upload", { automation_id: id, category: "Anything" });
      eq([up2.status, db.T.automation_templates.find((t: any) => t.id === up2.body.id).category, db.T.automation_templates.find((t: any) => t.id === up2.body.id).name], [200, null, "Team alert"], "template_upload: an unknown category is left empty; no name = the workflow's name");
      eq([(await api(db, "template_upload", { automation_id: "nope" })).status, (await api(db, "template_upload", { automation_id: id }, VA)).status, (await api(db, "template_upload", { automation_id: id, name: "   " }, MANAGER)).status],
        [404, 403, 200], "template_upload: an unknown workflow → 404; a VA → 403; a manager may (a blank name falls back to the workflow's)");
      const dm = await api(db, "duplicate", { template_id: mine.id });
      eq([dm.status, db.T.automations.find((a: any) => a.id === dm.body.id).template_key, db.T.automations.find((a: any) => a.id === dm.body.id).enabled], [200, "tpl:" + mine.key, false], "choosing one of Mine: a Draft with template_key tpl:<its key>");
      const rn = await api(db, "template_rename", { template_id: mine.id, name: " Owners' alert " });
      eq([rn.status, mine.name, (await api(db, "template_rename", { template_id: mine.id, name: "" })).status, mine.name], [200, "Owners' alert", 422, "Owners' alert"], "template_rename: one of Mine is renamed; an empty name is refused");
      const rs = await api(db, "template_rename", { template_id: t0.id, name: "X" }), ds = await api(db, "template_delete", { template_id: t0.id });
      eq([rs.status, rs.body.reason, ds.status, t0.name, t0.deleted_at ?? null], [409, "system", 409, "Tell the team about a new lead", null], "a System template is never renamed or deleted here");
      const tdel = await api(db, "template_delete", { template_id: mine.id });
      eq([tdel.status, !!mine.deleted_at, (await api(db, "template_delete", { template_id: mine.id })).status, (await api(db, "template_rename", { template_id: mine.id, name: "Y" })).status, (await api(db, "duplicate", { template_id: mine.id })).status],
        [200, true, 404, 404, 404], "template_delete: one of Mine leaves the library (deleted_at); then it is not found for rename, delete or choose");
      // the 200 limit counts the live templates in the database (head + count), never a read of the whole table: many
      // deleted ones (kept for good) never hide live ones, and a key already used (a deleted one too) is never minted again
      {
        const keep = db.T.automation_templates;
        const liveN = keep.filter((t: any) => !t.deleted_at && t.business_id === "default").length;
        const fill = (n0: number, del: boolean) => Array.from({ length: n0 }, (_, i) => ({ id: `tf-${del ? "d" : "l"}-${i}`, business_id: "default", key: `mine_fill${del ? "d" : "l"}${i}`, name: "F", origin: "user", deleted_at: del ? "2026-10-01T00:00:00.000Z" : null }));
        db.T.automation_templates = [...keep, ...fill(1200, true), ...fill(WF_TPL_LIMITS.perBusiness - liveN - 1, false)];
        const c0 = db.calls.length, ok1 = await api(db, "template_upload", { automation_id: id, name: "One more" });
        const reads = db.calls.slice(c0).filter((c: string) => c === "automation_templates.select").length;
        const full = await api(db, "template_upload", { automation_id: id, name: "Too many" });
        eq([ok1.status, full.status, full.body.reason, reads], [200, 409, "too_many", 2], "template_upload: 1,200 deleted templates never count; the 200th live one is the last (one count + one key probe)");
        db.T.automation_templates = keep;
      }
      const badDoc = await api(db, "save", { automation_id: null, name: "Broken", definition: { schema: 2, seq: 1, entry: "zz", triggers: [], nodes: {} } });
      const ub = await api(db, "template_upload", { automation_id: badDoc.body.id });
      eq([ub.status, ub.body.reason, db.T.automation_templates.some((t: any) => t.source_automation_id === badDoc.body.id)], [422, "errors", false], "template_upload: a workflow with problems is refused (a template opens without errors)");
      // template drafts come with a save (one catalog write; keys like the app's autoLibKey)
      const td = await api(db, "save", { automation_id: null, name: "New words", definition: doc({ e1: { kind: "action", type: "send_email", config: { subject: "Hi", templateKey: "my_zz99xx11" }, out: { next: null } } }),
        template_drafts: { my_zz99xx11: { name: "Welcome", channel: "email", body: "{hi}, welcome." } } });
      eq([td.status, td.body.templates, db.T.settings[0].catalog.templates.my_zz99xx11, db.T.settings[0].catalog.msgTemplates.my_zz99xx11.createdBy], [200, ["my_zz99xx11"], "{hi}, welcome.", "Olivia Owner"], "save: the template words come first (catalog), then the workflow");
      eq((await api(db, "save", { automation_id: null, name: "Bad", definition: d1, template_drafts: { "../x": { channel: "email", body: "x" } } })).status, 422, "save: a template key that isn't one of ours is refused");
      // review round 2: never on what the browser did not know. A draft sent as new on a key made meanwhile (other words)
      // → 409 template_taken; a change of a saved key that another Published workflow sends → 409 template_shared with its
      // name, until the person said yes (templates_confirmed)
      {
        const tdDoc = doc({ e1: { kind: "action", type: "send_email", config: { subject: "Hi", templateKey: "my_zz99xx11" }, out: { next: null } } });
        const tk1 = await api(db, "save", { automation_id: null, name: "Stale tab", definition: tdDoc, template_drafts: { my_zz99xx11: { name: "Mine", channel: "email", body: "Other words", new: true } } });
        const tk2 = await api(db, "save", { automation_id: null, name: "Retry", definition: tdDoc, template_drafts: { my_zz99xx11: { name: "Welcome", channel: "email", body: "{hi}, welcome.", new: true } } });
        eq([tk1.status, tk1.body.reason, tk1.body.keys, tk2.status, db.T.settings[0].catalog.templates.my_zz99xx11], [409, "template_taken", ["my_zz99xx11"], 200, "{hi}, welcome."],
          "save: a new template on a key someone made meanwhile with other words → 409, nothing written (the same words: a retry, fine)");
        const tdRow = db.T.automations.find((a: any) => a.id === td.body.id);
        tdRow.enabled = true;   // (as Published: the check reads the enabled rows)
        const sh1 = await api(db, "save", { automation_id: null, name: "Edits words", definition: tdDoc, template_drafts: { my_zz99xx11: { name: "Welcome", channel: "email", body: "New words" } } });
        const sh2 = await api(db, "save", { automation_id: td.body.id, expected_revision: Number(db.T.automations.find((a: any) => a.id === td.body.id).revision), name: "New words", definition: tdDoc,
          template_drafts: { my_zz99xx11: { name: "Welcome", channel: "email", body: "Its own words" } } });
        const before = db.T.settings[0].catalog.templates.my_zz99xx11;
        const sh3 = await api(db, "save", { automation_id: null, name: "Edits words", definition: tdDoc, templates_confirmed: true, template_drafts: { my_zz99xx11: { name: "Welcome", channel: "email", body: "New words" } } });
        eq([sh1.status, sh1.body.reason, sh1.body.names, sh2.status, before, sh3.status, db.T.settings[0].catalog.templates.my_zz99xx11], [409, "template_shared", ["New words"], 200, "Its own words", 200, "New words"],
          "save: changing a template another Published workflow sends → 409 with its name; the workflow itself may change it; with the yes → written");
        tdRow.enabled = false;
      }
      // where a copy of a ready-made came from (template_key): kept by the save on a new one only (since SQL Part 3 · G3.4
      // the app can't write the column); a key that isn't one, or one sent with an existing workflow, is ignored
      const tk = await api(db, "save", { automation_id: null, name: "Copy of review", definition: d1, template_key: "team:new-lead_1" });
      const tkBad = await api(db, "save", { automation_id: null, name: "Odd key", definition: d1, template_key: "../x; drop" });
      const tkRow = () => db.T.automations.find((a: any) => a.id === tk.body.id);
      const tkOld = await api(db, "save", { automation_id: tk.body.id, expected_revision: tk.body.revision, name: "Copy of review", definition: d1, template_key: "review" });
      eq([tk.status, tk.body.template_key, tkBad.status, tkBad.body.template_key, db.T.automations.find((a: any) => a.id === tkBad.body.id).template_key, tkOld.status, tkRow().template_key, tkRow().enabled],
        [200, "team:new-lead_1", 200, null, null, 200, "team:new-lead_1", false], "save: template_key kept on a new one (a Draft); a bad key or a later save never sets it");
      // overlap with a ready-made System row that is on
      const sysRow = db.T.automations.find((a: any) => a.id === id);
      Object.assign(sysRow, { enabled: true, list_summary: { triggers: ["newLead"] } });
      const other = await api(db, "save", { automation_id: null, name: "Same start", definition: d1 });
      const ov = await api(db, "publish", { automation_id: other.body.id, on: true });
      eq([ov.status, ov.body.text], [409, "Turn off the ready-made Team alert first, or it sends twice"], "publish: an active System row with the same start blocks (it would send twice)");
      // no trigger on: allowed, with the warning
      const nt = await api(db, "save", { automation_id: null, name: "Manual only", definition: doc({ n1: push() }, []) });
      const pn = await api(db, "publish", { automation_id: nt.body.id, on: true });
      eq([pn.status, pn.body.warnings.some((w: any) => w.text === "Only manual add or Add to workflow can start it")], [200, true], "publish with no trigger on: allowed, with the warning");
      // registry (the v2 DTO) and schema; office only
      const reg = await api(db, "registry", {}, MANAGER), sch = await api(db, "schema", { mode: "accept" });
      eq([reg.status, reg.body.v, reg.body.triggers.find((t: any) => t.key === "newLead").ghl, reg.body.actions.find((a: any) => a.key === "send_sms").availability.ok, typeof sch.body.schema.$defs], [200, 2, "Contact created", false, "object"],
        "registry: the stage-2 DTO (GHL words, availability); schema: the JSON Schema");
      eq([(await api(db, "registry", {}, VA)).status, (await api(db, "save", { name: "x", definition: d1 }, VA)).status, (await api(db, "publish", { automation_id: id, on: false }, TECH)).status], [403, 403, 403], "the API: owners and managers only");
      eq((await api(db, "save", { automation_id: id, name: "x", definition: d1 })).status, 400, "save of an existing workflow needs expected_revision");
      // the old editor saves a phase-4 row it opened before the migration: upgraded first, then saved at the revision it had
      const v1 = v1row({ id: "m34-0099", revision: 4 });
      db.T.automations.push(v1);
      const up = await api(db, "save", { automation_id: v1.id, expected_revision: 4, name: v1.name, definition: upgradeV1(v1.trigger, [{ ...v1.steps[0], title: "Changed" }]).doc });
      eq([up.status, db.T.automations.find((a: any) => a.id === v1.id).revision, db.T.automation_versions.filter((x: any) => x.automation_id === v1.id).map((x: any) => x.reason), up.body.shapeChanged],
        [200, 6, ["migration", "save"], false], "save of a phase-4 row (opened before the migration): upgraded first (revision + 1), then saved (+ 1); not a conflict, same shape");
      eq((await api(db, "save", { automation_id: v1.id, expected_revision: 4, name: v1.name, definition: up.body && db.T.automations.find((a: any) => a.id === v1.id).definition })).status, 409, "…and an old revision after that is a conflict");
    }

    // the phase-2 review: webhook edits are an owner's and a new host → Draft; publish checks the revision it validated
    // and blocks an unavailable step that was never live; a filter / re-entry edit re-arms and never stops what waits;
    // migrate is a compare-and-set; the ready-made templates never use an upsert on a partial index
    {
      const db = world({ contacts: [lead("c1")], automations: [], automation_versions: [], automation_templates: [] });
      const doc = (nodes: any, triggers: any[] = [{ id: "t1", type: "newLead", filters: NONE }]) => ({ schema: 2, seq: 20, entry: Object.keys(nodes)[0], triggers, nodes });
      const push = (title = "New lead: {name}", next: any = null) => ({ kind: "action", type: "internal_notification", config: { channel: "push", to: { roles: ["owner"] }, title }, out: { next } });
      const hook = (url: string, x: any = {}) => ({ kind: "action", type: "webhook", config: { url, method: "POST", ...x }, out: { next: null } });
      const row = (id: string) => db.T.automations.find((a: any) => a.id === id);
      clock = NOW;
      let r = await api(db, "save", { automation_id: null, name: "To the CRM", definition: doc({ n1: push("x", "h1"), h1: hook("https://crm.example.com/in") }) });
      const id = r.body.id, rev = () => Number(row(id).revision);
      r = await api(db, "publish", { automation_id: id, on: true, confirm: true });
      eq([r.status, row(id).enabled], [200, true], "an owner publishes a workflow whose webhook sends to crm.example.com");
      for (const [what, h] of [["url", hook("https://attacker.example/x")], ["fields", hook("https://crm.example.com/in", { fields: ["phone"] })], ["method", hook("https://crm.example.com/in", { method: "PUT" })]] as [string, any][]) {
        r = await api(db, "save", { automation_id: id, expected_revision: rev(), name: "To the CRM", definition: doc({ n1: push("x", "h1"), h1: h }) }, MANAGER);
        eq([r.status, r.body.reason, row(id).definition.nodes.h1.config], [403, "Only an owner can add a Webhook step or change where it sends", { url: "https://crm.example.com/in", method: "POST" }],
          `a manager can't change an existing webhook step's ${what} (same node id): 403, nothing saved`);
      }
      r = await api(db, "save", { automation_id: id, expected_revision: rev(), name: "To the CRM", definition: doc({ n1: push("new words", "h1"), h1: hook("https://crm.example.com/in") }) }, MANAGER);
      eq([r.status, r.body.enabled], [200, true], "a manager may edit the other steps (the webhook kept exactly as it was)");
      r = await api(db, "save", { automation_id: id, expected_revision: rev(), name: "To the CRM", definition: doc({ n1: push("new words", "h1"), h1: hook("https://crm.example.com/v2") }) });
      eq([r.status, r.body.enabled, r.body.drafted], [200, true, false], "the owner changes the path on the same host: it stays on");
      // review round 2: validate says first that the save makes it a Draft (and stops what waits in it): the builder asks
      const vNew = await api(db, "validate", { automation_id: id, definition: doc({ n1: push("new words", "h1"), h1: hook("https://other.example.net/in") }) });
      const vSame = await api(db, "validate", { automation_id: id, definition: doc({ n1: push("other words", "h1"), h1: hook("https://crm.example.com/v2") }) });
      const vAi = await api(db, "validate", { automation_id: id, definition: doc({ n1: push("other words", "h1"), h1: hook("https://crm.example.com/v2") }), ai_edited: true });
      eq([vNew.status, vNew.body.willDraft, vNew.body.shapeChanged, typeof vNew.body.waitingRunsAffected, vSame.body.willDraft, vAi.body.willDraft], [200, true, false, "number", false, true],
        "validate: a webhook to a new host (or Workflow AI's change) → willDraft, with what waits in it; the same host → not");
      r = await api(db, "save", { automation_id: id, expected_revision: rev(), name: "To the CRM", definition: doc({ n1: push("new words", "h1"), h1: hook("https://other.example.net/in") }) });
      eq([r.status, r.body.enabled, r.body.drafted, row(id).enabled], [200, false, true, false], "the owner points the webhook at a new host: Draft at once");
      r = await api(db, "publish", { automation_id: id, on: true });
      eq([r.status, r.body.confirm], [409, ["Sends lead details to other.example.net"]], "…and its publish asks again, naming the new host");
      // the revision the person saw: a save in between → 409, nothing switched on; a switch-off never waits for one
      const shown = rev();
      await api(db, "save", { automation_id: id, expected_revision: shown, name: "To the CRM", definition: doc({ n1: push("newer", "h1"), h1: hook("https://other.example.net/in") }) });
      r = await api(db, "publish", { automation_id: id, on: true, confirm: true, expected_revision: shown });
      eq([r.status, r.body.reason, r.body.revision, row(id).enabled], [409, "conflict", shown + 1, false], "publish of the revision someone was shown, after another save: 409, still off");
      r = await api(db, "publish", { automation_id: id, on: true, confirm: true, expected_revision: rev() });
      eq([r.status, row(id).enabled], [200, true], "…with the revision now shown: on");
      eq((await db.rpc("automation_publish", { p_business: "default", p_id: id, p_on: true, p_expected: rev() - 1, p_actor: null, p_actor_name: null })).data.reason, "conflict",
        "automation_publish itself refuses another revision (p_expected: a save between the function's check and its publish)");
      r = await api(db, "publish", { automation_id: id, on: false, expected_revision: 1 });
      eq([r.status, row(id).enabled], [200, false], "a switch-off goes through whatever the revision");
      // availability blocks a publish (design §6.2) unless the step was already live: a Draft saved twice is not
      const sms = doc({ n1: { kind: "action", type: "send_sms", config: { body: "Hi" }, out: { next: null } } });
      const t1 = await api(db, "save", { automation_id: null, name: "Texts", definition: sms });
      await api(db, "save", { automation_id: t1.body.id, expected_revision: 1, name: "Texts", definition: sms, layout: { v: 1, adv: { n1: [1, 2] } } });
      r = await api(db, "publish", { automation_id: t1.body.id, on: true, confirm: true });
      eq([r.status, r.body.reason, (r.body.errors || []).map((x: any) => x.code).includes("E_UNAVAILABLE"), row(t1.body.id).enabled], [422, "errors", true, false],
        "publish: a text step without the phone line blocks, even after a second save of the Draft (only what was live stays a warning)");
      const old = v1row({ id: "m34-0777", enabled: false, armed_at: null, steps: [{ id: "x1", kind: "action", type: "text", body: "Hi" }] });
      db.T.automations.push(old);
      await api(db, "migrate");
      r = await api(db, "publish", { automation_id: old.id, on: true, confirm: true });
      eq([r.status, (r.body.warnings || []).map((x: any) => x.code).includes("E_UNAVAILABLE")], [200, true], "…a migrated phase-4 row keeps its step as a warning (its migration snapshot is what was live)");
      // where the ready-made templates come from: plain inserts (Postgres can't take a partial index as ON CONFLICT)
      const up0 = await db.from("automation_templates").upsert([{ business_id: "default", key: "k1" }], { onConflict: "business_id,key", ignoreDuplicates: true });
      eq(up0.error && up0.error.code, "42P10", "the fake, as Postgres: an upsert naming the partial unique index of automation_templates fails (42P10)");
      const all = src("index.ts");
      const targets = [...new Set([...all.matchAll(/from\("(\w+)"\)\.upsert\([^;]*?onConflict: "([\w,]+)"/g)].map((m) => [m[1], m[2]].join("|")))];
      eq(targets.filter((x) => { const [t, c] = x.split("|"); const named = (UNIQUE[t] || []).filter((u) => !u.key && [...u.keys].sort().join(",") === c.split(",").sort().join(",")); return named.length > 0 && named.every((u) => u.where); }), [],
        "no upsert in the function names a partial unique index");
      const tpl = db.T.automation_templates.find((t: any) => t.key === "team_new_lead");
      tpl.deleted_at = isoMs(NOW);
      const m = await api(db, "migrate");
      eq([m.status, m.body.templates, db.T.automation_templates.filter((t: any) => t.key === "team_new_lead").length, db.T.automation_templates.length], [200, 0, 1, WF_TEMPLATE_SEEDS.length],
        "migrate again: a ready-made template the owner deleted never comes back");
      // a filter or re-entry edit while a run waits: re-armed for new events only; the waiting run carries on (design §2.8)
      const w = await api(db, "save", { automation_id: null, name: "Waits", definition: doc({ w1: { kind: "wait", type: "period", config: { n: 1, unit: "hours" }, out: { next: "n1" } }, n1: push("After the wait") }) });
      const wid = w.body.id;
      await api(db, "publish", { automation_id: wid, on: true });
      const wr = { ...row(wid) }, rev2 = () => Number(row(wid).revision);
      db.T.automation_runs.push({ id: "run-rearm", business_id: "default", automation_id: wid, automation_version: wr.version, revision: wr.revision, status: "waiting", due_at: isoMs(NOW + HR), anchor_at: isoMs(NOW),
        event_key: "c1:rearm", event_type: "newLead", event_at: isoMs(NOW), record_kind: "contact", record_id: "c1", contact_id: "c1", cursor_step: "w1", enrollment_key: "c1", active_lock: "c1", context: {}, step_index: 0, trigger_id: "t1" });
      clock = NOW + MIN;
      r = await api(db, "save", { automation_id: wid, expected_revision: rev2(), name: "Waits", definition: doc(row(wid).definition.nodes, [{ id: "t1", type: "newLead", filters: { match: "all", segments: [{ match: "all", rules: [{ field: "source", op: "is", v: "Google Ads" }] }] } }]) });
      clock = NOW + 2 * MIN;
      const r2 = await api(db, "save", { automation_id: wid, expected_revision: rev2(), name: "Waits", definition: row(wid).definition, settings: { reentry: "after_exit" } });
      eq([r.body.armChanged, r2.body.armChanged, row(wid).version, row(wid).switched_on_at, row(wid).armed_at], [true, true, wr.version, wr.armed_at, isoMs(NOW + 2 * MIN)],
        "a filter edit and a re-entry edit: re-armed (armed_at now), same version, switched_on_at kept (the moment it was switched on)");
      sent.length = 0;
      const run = db.T.automation_runs.find((x: any) => x.id === "run-rearm");
      clock = NOW + HR + 3 * MIN;
      const T = await loadContext(db, NOW + HR + 3 * MIN);
      Object.assign(run, { status: "running" });
      const pr: any = await advanceV2(db, { ...run }, T, NOW + HR + 3 * MIN);
      eq([pr.status, pr.exit_reason, sent.map((x) => x.msg.title)], ["done", "end_of_workflow", ["After the wait"]], "…and the waiting run goes on after the edits (never 'switched off and on again since then')");
      // switching off and on again still stops what waited from before the switch-on
      await api(db, "publish", { automation_id: wid, on: false }); clock = NOW + 2 * HR; await api(db, "publish", { automation_id: wid, on: true });
      eq([staleV2(row(wid), { automation_version: row(wid).version, event_at: isoMs(NOW) }), staleV2(row(wid), { automation_version: row(wid).version, event_at: isoMs(NOW + 3 * HR) })],
        [{ text: "switched off and on again since then", code: "switched_off" }, null], "switched off and on again: an event from before the switch-on is stale, one after is not");
      eq([staleV2({ enabled: true, version: 1, armed_at: isoMs(NOW) }, { automation_version: 1, event_at: isoMs(NOW - MIN) }), staleV2({ enabled: true, version: 1, armed_at: isoMs(NOW), switched_on_at: isoMs(NOW - HR) }, { automation_version: 1, event_at: isoMs(NOW - MIN) })],
        [{ text: "switched off and on again since then", code: "switched_off" }, null], "staleV2: armed_at is the marker only without switched_on_at (before G2.4 / after its rollback)");
      clock = NOW;
      // migrate = compare-and-set on the trigger / steps it read: an old tab's write in between is never replaced
      const dbm = world({ automations: [v1row({ id: "m34-0888", steps: [{ id: "p1", kind: "action", type: "push", to: { roles: ["owner"] }, title: "old words" }] })], automation_versions: [], automation_templates: [] });
      let raced = false;
      const racing = { ...dbm, rpc: async (n0: string, a: any) => { if (n0 === "automation_migrate_row" && !raced) { raced = true; dbm.T.automations[0].steps = [{ ...dbm.T.automations[0].steps[0], title: "new words" }]; } return await dbm.rpc(n0, a); } };
      const mm = await api(racing, "migrate");
      eq([mm.body.migrated, dbm.T.automations[0].definition.nodes.p1.config.title, dbm.calls.filter((c: string) => c === "rpc:automation_migrate_row").length], [1, "new words", 2],
        "migrate: steps written by an old tab between the read and the write → refused, read again, the doc made of the new steps");
      // a window step in office mode keeps only valid custom days and hours (the doc's schema)
      eq([winDormant({ days: [9], from: "7am", until: "14:00" }), winDormant({ days: [0, 6], from: "10:00", until: "24:00" }), winDormant({ days: [1, 1] }),
        upgradeV1({ type: "newLead", params: {} }, [{ id: "w1", kind: "window", mode: "office", days: [9], from: "7am", until: "14:00", outside: "next" }]).doc.nodes.w1.config.window],
        [{ until: "14:00" }, { days: [0, 6], from: "10:00", until: "24:00" }, {}, { use: "office", until: "14:00", outside: "next" }], "window: the custom days and hours an office step kept go along, invalid ones never");
      // an upgraded row (re-entry legacy_always: still run as phase 4) whose start the old editor changes while a run
      // waits: a new version and the run stops "automation changed", as phase 4 did (never "switched off and on again");
      // the same edit on a stage-2 workflow is a re-arm (above: what waits goes on)
      {
        const v1steps = [{ id: "w1", kind: "wait", n: 2, unit: "days" }, { id: "p1", kind: "action", type: "push", to: { roles: ["owner"] }, title: "Quote follow-up" }];
        const dbl = world({ contacts: [lead("c1")], automations: [v1row({ id: "m34-0555", trigger: { type: "stage", params: { stage: "Quoted" } }, steps: v1steps })], automation_versions: [], automation_templates: [] });
        await api(dbl, "migrate");
        const lr = dbl.T.automations[0], v0 = lr.version, r0 = lr.revision;
        dbl.T.automation_runs.push({ id: "run-legacy", business_id: "default", automation_id: lr.id, automation_version: v0, revision: r0, status: "waiting", due_at: isoMs(NOW + DAYMS), anchor_at: isoMs(NOW),
          event_key: "c1:Quoted:x", event_type: "stage", event_at: isoMs(NOW), record_kind: "contact", record_id: "c1", contact_id: "c1", cursor_step: "w1", enrollment_key: "c1", active_lock: null, context: {}, step_index: 0, trigger_id: "t1" });
        const val = await api(dbl, "validate", { automation_id: lr.id, definition: upgradeV1({ type: "stage", params: { stage: "Won" } }, v1steps).doc, settings: lr.settings });
        const sv = await api(dbl, "save", { automation_id: lr.id, expected_revision: r0, name: lr.name, definition: upgradeV1({ type: "stage", params: { stage: "Won" } }, v1steps).doc });
        const rl = dbl.T.automation_runs.find((x: any) => x.id === "run-legacy");
        eq([val.body.shapeChanged, val.body.waitingRunsAffected, sv.status, sv.body.shapeChanged, lr.version, rl.status, rl.exit_reason, rl.reason],
          [true, 1, 200, true, v0 + 1, "cancelled", "automation_changed", "automation changed"],
          "an upgraded row's start changed in the old editor while a run waits: a new version, the run stops 'automation changed' (phase 4's rule; validate says so first)");
        eq([versionChanged(lr.definition, { reentry: "off" }, upgradeV1({ type: "stage", params: { stage: "Lost" } }, v1steps).doc), versionChanged(lr.definition, lr.settings, upgradeV1({ type: "stage", params: { stage: "Won" } }, [v1steps[0], { ...v1steps[1], title: "New words" }]).doc)],
          [false, false], "versionChanged: a start change on a stage-2 workflow is a re-arm only; words on an upgraded one are neither");
      }
    }

    // housekeeping (design §3.15, §8.1 #23): a 20k backlog drains over ticks under the 1,000-row cap, the cursor carries
    // on; once a day; then the Needs-review sweep keeps the codes; before Part 1 phase 4's prune runs instead
    {
      const old = isoMs(NOW - 9 * DAYMS);
      const evs = Array.from({ length: 20000 }, (_, i) => ({ id: `hk${i}`, business_id: "default", type: "newLead", event_key: `hk:${i}`, status: "done", processed_at: old, created_at: old, at: old }));
      const sms = { schema: 2, seq: 2, entry: "n1", triggers: [{ id: "t1", type: "newLead", filters: NONE }], nodes: { n1: { kind: "action", type: "send_sms", config: { body: "Hi" }, out: { next: null } } } };
      const db = world({ automation_events: evs, automations: [{ id: "hk-0001", business_id: "default", name: "Texts", enabled: true, armed_at: "2026-10-01T00:00:00.000Z", version: 1, revision: 1, trigger: {}, steps: [],
        definition: sms, settings: { reentry: "off" }, list_summary: { triggers: ["newLead"] }, deleted_at: null, updated_at: "2026-10-02T00:00:00.000Z" }] });
      const calls: number[] = [];
      const timed = { ...db, rpc: async (n0: string, a: any) => { if (n0 === "automation_prune") { calls.push(a.p_budget); clock += 15e3; } return await db.rpc(n0, a); } };
      let ticks = 0;
      while ((db.T.automation_state[0].housekeeping || {}).stage !== "done" && ticks < 20) { await tickAt(timed, NOW + ticks * MIN); ticks++; }
      eq([db.T.automation_events.length, ticks > 3, calls.every((b) => b === 1000), calls.length, db.T.automation_state[0].housekeeping.pruned.events], [0, true, true, 21, 20000],
        "housekeeping: 20,000 old events go over several ticks, 1,000 at a time (the cursor carries on)");
      eq([db.T.automations[0].list_summary.review.codes, db.T.automations[0].updated_at, db.T.automations[0].list_summary.triggers], [["E_UNAVAILABLE"], "2026-10-02T00:00:00.000Z", ["newLead"]],
        "the Needs-review sweep keeps the problem codes (a text step without the phone line), the rest of the summary and the edit time untouched");
      const n0 = calls.length;
      await tickAt(timed, NOW + 30 * MIN);
      eq(calls.length, n0, "housekeeping: once a business day");
      db.T.settings[0].phone_enabled = true;
      await tickAt(timed, NOW + DAYMS);
      eq(db.T.automations[0].list_summary.review, undefined, "next day: the problem gone → the codes go");
      // the review askers include stage-2 docs with the condition (askedWithin)
      const engine = src("index.ts");
      ok(/JSON\.stringify\(x\.definition\)\.includes\('"field":"asked_within_months"'\)/.test(engine), "a doc that checks 'asked for a review' counts as an asker (askedWithin)");
      // before Part 1 (no phase4_compat column): phase 4's prune, not the housekeeping
      const pre = world({ automation_runs: [{ id: "p-old", business_id: "default", status: "done", finished_at: isoMs(NOW - 100 * DAYMS), due_at: isoMs(NOW - 100 * DAYMS) }] });
      const noPart1 = { ...pre, from: (t: string) => { const q0 = pre.from(t); if (t !== "automation_state") return q0; const sel = q0.select; q0.select = (c?: string) => (c && /phase4_compat/.test(c) ? { eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: "42703", message: "column automation_state.phase4_compat does not exist" } }) }) } : sel(c)); return q0; } };
      await tickAt(noPart1, NOW);
      eq([pre.T.automation_runs.length, pre.T.automation_state[0].pruned_on, pre.calls.includes("rpc:automation_prune")], [0, "2026-10-14", false], "before Part 1: phase 4's prune (90 days), no housekeeping");
    }
  }

  // ── 35. links into Settings → Automation (G3.1, design §4.1): the engine's wfLink = fixtures/links.json (the app's
  // wfLink reads the same file in tests/business-logic.test.js), and nothing that fails a rule gets into a link. ──
  {
    const L = JSON.parse(src("fixtures/links.json")).cases;
    ok(L.length >= 5, "links: the shared fixture has its cases");
    for (const c of L) eq(wfLink(c.id, c.wfTab, c.extra), c.link, `links: ${c.name}`);
    ok(!/["'<>\s]/.test(L.map((c: any) => wfLink(c.id, c.wfTab, c.extra)).join("")), "links: no quote, angle bracket or space ever gets into a link");
    eq(wfLink(null, undefined), "?tab=settings&page=automation", "links: nothing given → the Automation page");
  }

  // ── 36. Global Workflow Settings (G3.2, design §4.4): the engine's bizToUtc / cleanEmail / signatureOf and its pause
  // rules = fixtures/global-settings.json (the app's copies read the same file in tests/business-logic.test.js), and the
  // registry says whether the daily error alert is sent yet. ──
  {
    const G = JSON.parse(src("fixtures/global-settings.json"));
    for (const c of G.bizToUtc) eq(new Date(bizToUtc(c.day, c.hh, c.mm, c.tz)).toISOString(), c.utc, `global settings: bizToUtc — ${c.name}`);
    eq(G.cleanEmail.map((c: any) => cleanEmail(c.in)), G.cleanEmail.map((c: any) => c.out), "global settings: cleanEmail on every fixture");
    eq(G.signatureOf.map((c: any) => signatureOf(c.author, c.biz)), G.signatureOf.map((c: any) => c.out), "global settings: signatureOf on every fixture");
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    for (const c of G.pauseUntil) eq(iso(pauseUntil(G.pauses, c.id, Date.parse(c.now), c.tz)), c.until, `global settings: pauseUntil — ${c.name}`);
    for (const c of G.pauseOccurrences) {
      const p = G.pauses.find((x: any) => x.id === c.pause);
      eq(pauseOccurrences(p, Date.parse(c.now), c.tz).map((o) => [iso(o.start), iso(o.end)]), c.out, `global settings: pauseOccurrences — ${c.name}`);
    }
    eq([wallMs("2026-02-30T09:00", 0, "UTC"), wallMs("2026-10-14 09:00", 0, "UTC"), wallMs("2028-02-29T09:00", -1, "UTC")], [null, null, Date.parse("2027-02-28T09:00:00Z")],
      "global settings: wallMs refuses 30 February and a malformed wall; 29 February moved to a year without it is the 28th");
    eq([registryExport({ phone: false, xero: false, gbp: false, reviews: false, ai: false, teamEmail: false, atomicTags: true }, {}).features, WF_FEATURES.errorDigest], [{ errorDigest: true }, true], "global settings: the registry says the daily error alert is sent (G6.1)");
  }

  // ── 37. G3.5 (design §10 Q5 + Q6, quiet imports): the lead's "Assigned to" end to end (Assign to user / Remove assigned
  //        user through automation_apply, {lead.assigned_to}, Lead changed sees it), no Quote status trigger, and rows
  //        imported with import_quiet never start an automation by arriving (scans, timers, the app's look now, the
  //        capture) while a later change by a person still does; SQL Part 3 · G3.5 = what the fake does, ROLLBACK exact ──
  {
    io.advance = PROD_ADVANCE;
    const NONE = { match: "all", segments: [{ match: "all", rules: [] }] };
    const MIN0 = 60e3;
    // Assign to user → Remove assigned user: one automation_apply op each, the write, a history line each, the blank filled
    {
      const A = { id: "w37-0001", business_id: "default", name: "Assign", enabled: true, armed_at: "2026-10-01T00:00:00.000Z", version: 1, revision: 1, created_by_name: "Olivia Owner", trigger: {}, steps: [],
        definition: { schema: 2, seq: 9, entry: "n1", triggers: [{ id: "t1", type: "newLead", filters: NONE }], nodes: {
          n1: { kind: "action", type: "assign_user", config: { user: "u-mgr" }, out: { next: "n2" } },
          n2: { kind: "action", type: "internal_notification", config: { channel: "push", to: { roles: ["owner"] }, title: "{name} is {lead.assigned_to_first_name}'s ({lead.assigned_to})" }, out: { next: "n3" } },
          n3: { kind: "action", type: "assign_user", config: { user: "u-mgr" }, out: { next: "n4" } },
          n4: { kind: "action", type: "remove_assigned_user", config: {}, out: { next: "n5" } },
          n5: { kind: "action", type: "assign_user", config: { user: "not-a-person" }, out: { next: null } } } },
        settings: { reentry: "off", perRecord: true }, deleted_at: null };
      const db = world({ contacts: [lead("c1")], automations: [A], automation_runs: [{ id: "r37", business_id: "default", automation_id: A.id, automation_version: 1, event_key: "c1:new", event_type: "newLead",
        event_at: isoMs(NOW), record_kind: "contact", record_id: "c1", contact_id: "c1", status: "running", step_index: 0, anchor_at: isoMs(NOW), due_at: isoMs(NOW), attempts: 1, context: {}, trigger_id: "t1",
        cursor_step: null, remove_requested: false, chain_depth: 0 }], automation_wanted: [{ business_id: "default", event_type: "contact_changed" }] });
      // the uuid check of the step: the fake's people have short ids, so their ids are given as uuids here
      const U = "11111111-1111-4111-8111-111111111111";
      db.T.profiles.push({ id: U, full_name: "Max Manager", role: "manager", permissions: {} });
      A.definition.nodes.n1.config.user = U; A.definition.nodes.n3.config.user = U;
      sent.length = 0; clock = NOW;
      const p: any = await advanceV2(db, { ...db.T.automation_runs[0] }, ctxOf(db), NOW);
      clock = NOW;
      const calls = db.T.automation_apply_calls.map((x: any) => x.p_ops);
      eq([p.status, calls, db.T.contacts[0].assigned_user_id, sent.map((x) => x.msg.title)],
        ["done", [[{ op: "assign", user: U }], [{ op: "assign", user: U }], [{ op: "assign", user: null }]], null, ["Sam Smith is Max's (Max Manager)"]],
        "Assign to user / Remove assigned user: one 'assign' op each; {lead.assigned_to} and its first name are the person's; a step without a real person is skipped");
      eq(db.T.automation_log.filter((l: any) => l.run_id === "r37" && l.row_kind === "action").map((l: any) => `${l.step_id}:${l.status}${l.reason ? ":" + l.reason : ""}`),
        ["n1:executed", "n2:sent", "n3:skipped:already assigned to that person", "n4:executed", "n5:skipped:missing details: user"], "the action rows: assigned, the same person again skipped, removed, no person skipped");
      eq([db.T.activity_log.map((l: any) => l.text), db.T.automation_events.filter((e: any) => e.type === "contact_changed").map((e: any) => [e.ctx.field, e.ctx.old, e.ctx.new, !!e.cause_run_id])],
        [["Assigned to Max Manager", "Assigned user removed"], [["assigned_user", null, U, true], ["assigned_user", U, null, true]]],
        "a history line on the lead for each change; Lead changed sees field assigned_user (with the run's cause: never this workflow again)");
    }
    // the merge fields, the facts (the name read once a tick), and a function deployed before SQL G3.5 (no column: read again without)
    {
      const db = world({ contacts: [lead("c1", { assigned_user_id: "u-va" })] });
      const T0: any = ctxOf(db), run = { record_kind: "contact", record_id: "c1", event_type: "newLead", event_at: isoMs(NOW), context: {} };
      const f: any = await loadFactsV2(db, run, T0, NOW);
      const v = wfMergeVars(f, { name: "X", steps: [] });
      eq([f.assignedName, v["lead.assigned_to"], v["lead.assigned_to_first_name"], wfMergeVars({ contact: { id: "c2" }, cat: CATALOG }, { name: "X" })["lead.assigned_to"], !!T0.people],
        ["Vicky Va", "Vicky Va", "Vicky", "", true], "{lead.assigned_to} / {lead.assigned_to_first_name}: the assigned person's name (nobody: empty)");
      // the name is read by id (never the whole profiles table: it has no business column and the 1,000-row cap would cut
      // it), once a tick
      {
        const seen: string[] = [];
        const spy = { ...db, from: (t: string) => { const q0: any = db.from(t); if (t !== "profiles") return q0; const e0 = q0.eq; q0.eq = (k: string, x: any) => { seen.push(`${k}=${x}`); return e0(k, x); }; return q0; } };
        const T1: any = ctxOf(db), f1: any = await loadFactsV2(spy, run, T1, NOW), f2b: any = await loadFactsV2(spy, run, T1, NOW);
        eq([f1.assignedName, f2b.assignedName, seen], ["Vicky Va", "Vicky Va", ["id=u-va"]], "the assigned person's name: one read by id, kept for the tick");
      }
      let first = true;
      const old = { ...db, from: (t: string) => { const q0: any = db.from(t); if (t !== "contacts") return q0; const sel = q0.select; q0.select = (c?: string) => {
        if (first && c && c.includes("assigned_user_id")) { first = false; return { eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: "42703", message: "column contacts.assigned_user_id does not exist" } }) }) }; }
        return sel(c); }; return q0; } };
      const f2: any = await loadFactsV2(old, run, ctxOf(db) as any, NOW);
      eq([!!f2 && f2.contact.id, first], ["c1", false], "before SQL G3.5 the lead is read again without the new columns (the run goes on)");
      eq([withoutCols(CONTACT_COLS_V2).includes("assigned_user_id"), withoutCols("id, import_quiet, status"), noColumn({ code: "42703", message: "column jobs.import_quiet does not exist" }),
        noColumn({ code: "42703", message: "column contacts.shoe does not exist" }), noColumn({ code: "57014", message: "timeout" })], [false, "id, status", true, false, false],
        "noColumn: only a missing G3.5 column; withoutCols drops them");
    }
    // Q5: a doc with the old trigger key is refused as unknown (it was never published: no rows to move)
    eq(issueCodes(validateDoc({ schema: 2, seq: 2, entry: "n1", triggers: [{ id: "t1", type: "estimates", filters: NONE }], nodes: { n1: { kind: "action", type: "internal_notification", config: { channel: "push", to: { roles: ["owner"] }, title: "x" }, out: { next: null } } } }, { catalog: CATALOG }).errors),
      ["E_UNKNOWN_TYPE"], "Q5: Quote status is not a trigger any more (removed, not greyed)");

    // ── import_quiet: the engine's side ──
    {
      const at = (m: number) => isoMs(NOW - m * MIN0);
      const formMsg = [{ at: at(3), text: "Lead created automatically from the website form (Aircon)" }];
      const db = world({
        contacts: [lead("c-new", { messages: formMsg }), lead("c-imp", { import_quiet: true, messages: formMsg }), lead("c-imp-re", { import_quiet: true, reopened_at: at(2) }),
          lead("c-st-imp", { import_quiet: true, status: "Quoted", created_at: at(20), stage_changed_at: isoMs(NOW - 20 * MIN0 + 10e3), messages: [{ at: at(60) }] }),
          lead("c-st-moved", { import_quiet: true, status: "Booked", created_at: at(120), stage_changed_at: at(5), messages: [{ at: at(180) }] }),
          lead("c-st-new", { status: "Quoted", created_at: at(120), stage_changed_at: at(5), messages: [{ at: at(180) }] })],
        jobs: [{ id: "j-new", customer_name: "A", date: "2026-10-14", contact_id: null, created_at: at(5) }, { id: "j-imp", customer_name: "B", date: "2026-10-14", contact_id: null, created_at: at(5), import_quiet: true }],
      });
      const T0: any = ctxOf(db), w = { sinceMs: NOW - 3 * HR, nowMs: NOW, markMs: null };
      const keys = (l: any[]) => l.map((e: any) => `${e.type}:${e.key}`).sort();
      const arr = await EV_PRODUCERS.arrivals.run(db, w, T0, [], new Set(["newLead", "form_submitted"]));
      eq(keys(arr.events), [`form_submitted:c-new:form:new`, `newLead:c-imp-re:${at(2)}`, `newLead:c-new:new`, "newLead:c-st-new:new"].sort(),
        "new lead / website form: an imported lead (import_quiet) starts nothing; reopened later by a person, it does");
      eq(keys(await TRIGGERS.newLead.scan(db, w.sinceMs, NOW, T0.S)), [`newLead:c-imp-re:${at(2)}`, "newLead:c-new:new", "newLead:c-st-new:new"].sort(), "…the same in the phase-4 scanner (compat)");
      eq(keys(await TRIGGERS.stage.scan(db, w.sinceMs, NOW, T0.S)).filter((k: string) => k.includes("c-st")), [`stage:c-st-moved:Booked:${at(5)}`, `stage:c-st-new:Quoted:${at(5)}`].sort(),
        "stage: the stage an imported lead arrived in starts nothing; a later move by a person does");
      eq(keys(await TRIGGERS.jobClosed.scan(db, w.sinceMs, NOW, T0.S)), ["jobClosed:j-new"], "job closed: an imported job starts nothing");
      const jd = [mkEv("custom_date", "job", "j-imp", "job.date:j-imp:2026-10-14:on:0@09:00", NOW, null, {}), mkEv("custom_date", "job", "j-new", "job.date:j-new:2026-10-14:on:0@09:00", NOW, null, {}),
        mkEv("custom_date", "contact", "c-imp", "lead.next_follow_up:c-imp:2026-10-14:on:0@09:00", NOW, "c-imp", {})];
      eq((await dropQuiet(db, jd)).map((e) => e.recordId), ["j-new", "c-imp"], "job date reminders: an imported job's date starts nothing (a lead's own follow-up date still does)");
      // a quiet job rescheduled later by a person: only the imported date (jobs.import_quiet_date) stays quiet
      {
        const rdb = world({ jobs: [{ id: "j-re", customer_name: "R", date: "2026-11-03", contact_id: null, created_at: at(5), import_quiet: true, import_quiet_date: "2026-10-20" },
          { id: "j-old", customer_name: "O", date: "2026-10-20", contact_id: null, created_at: at(5), import_quiet: true }] });
        const evs2 = [mkEv("custom_date", "job", "j-re", "job.date:j-re:2026-11-03:before:1days@09:00", NOW, null, { field: "job.date", date: "2026-11-03" }),
          mkEv("custom_date", "job", "j-re", "job.date:j-re:2026-10-20:before:1days@09:00", NOW, null, { field: "job.date", date: "2026-10-20" }),
          mkEv("custom_date", "job", "j-old", "job.date:j-old:2026-10-20:before:1days@09:00", NOW, null, { field: "job.date", date: "2026-10-20" })];
        eq((await dropQuiet(rdb, evs2)).map((e) => e.key), ["job.date:j-re:2026-11-03:before:1days@09:00"],
          "a quiet job rescheduled by a person: the new date's reminder starts; the imported date's (and a job without import_quiet_date) stays quiet");
        // the fake returns whole rows: the world before SQL G3.5 has no import_quiet_date at all
        const ndb = world({ jobs: rdb.T.jobs.map((j: any) => { const { import_quiet_date: _d, ...rest } = j; return rest; }) });
        const noDateCol = { ...ndb, from: (t: string) => { const q0: any = ndb.from(t); const sel = q0.select;
          q0.select = (c?: string, o?: any) => (c && c.includes("import_quiet_date") ? (() => { const e: any = { in: () => e, eq: () => e, then: (res: any, rej: any) => Promise.resolve({ data: null, error: { code: "42703", message: "column jobs.import_quiet_date does not exist" } }).then(res, rej) }; return e; })() : sel(c, o));
          return q0; } };
        eq((await dropQuiet(noDateCol, evs2)).map((e) => e.key), [], "…before SQL G3.5 (no import_quiet_date) every date of a quiet job stays quiet, as before");
      }
      // a card made with a day only (a business day): a move the next local morning, still the day before in UTC, is a person's
      const syd = { type: "stage", at: "2026-10-15T21:00:00.000Z" } as any, made15 = { created_at: "2026-10-15" };
      eq([quietDrops(syd, made15, "Australia/Sydney"), quietDrops(syd, made15, "UTC"), quietDrops({ type: "stage", at: "2026-10-15T12:00:00.000Z" } as any, made15, "Australia/Sydney"),
        quietDrops({ type: "stage", at: "2026-10-15T13:30:00.000Z" } as any, made15, "Australia/Sydney"),
        quietDrops({ type: "stage", at: "2026-10-16T03:00:00.000Z" } as any, made15, "America/Los_Angeles")], [false, true, true, false, true],
        "quietDrops: a day-only card compares the move's BUSINESS day (Sydney: 15 Oct 23:00 is its arrival day, 16 Oct 00:30 and 08:00 count; Los Angeles: 15 Oct 20:00 is still its arrival day)");
      eq([quietDrops({ type: "stage", at: "2026-10-14T03:00:00.000Z" } as any, { created_at: "2026-10-14" }), quietDrops({ type: "stage", at: "2026-10-15T03:00:00.000Z" } as any, { created_at: "2026-10-14" }),
        quietDrops({ type: "stage", at: "2026-10-15T03:00:00.000Z" } as any, { created_at: "2026-10-14", reopened_at: "2026-10-15T02:00:00.000Z" }), quietDrops({ type: "newLead", key: "c:2026-10-15T02:00:00.000Z" } as any, null),
        quietDrops({ type: "task_reminder", key: "t:due" } as any, null)], [true, false, false, false, false],
        "quietDrops: a card made with a day only arrives that day; a reopened card and a reopen are a person's; task reminders are not touched");
      // stale: the stage an imported lead arrived in never goes stale; a later move by a person does
      const sdb = world({ contacts: [lead("s-imp", { import_quiet: true, status: "Quoted", created_at: isoMs(NOW - 7 * DAYMS - 10 * MIN0), stage_changed_at: isoMs(NOW - 7 * DAYMS - 10 * MIN0 + 5e3) }),
        lead("s-moved", { import_quiet: true, status: "Quoted", created_at: isoMs(NOW - 30 * DAYMS), stage_changed_at: isoMs(NOW - 7 * DAYMS - 10 * MIN0) }),
        lead("s-norm", { status: "Quoted", created_at: isoMs(NOW - 30 * DAYMS), stage_changed_at: isoMs(NOW - 7 * DAYMS - 10 * MIN0) })] });
      const stalePubs: any = [{ a: { id: "w-stale" }, R: { doc: { triggers: [{ id: "t1", type: "stale", config: { days: 7 }, filters: NONE }] } } }];
      const st = await EV_PRODUCERS.stale.run(sdb, { sinceMs: NOW - HR, nowMs: NOW, markMs: null }, ctxOf(sdb) as any, stalePubs, new Set(["stale"]));
      eq(st.events.map((e: any) => e.recordId).sort(), ["s-moved", "s-norm"], "stale: an imported lead's own (arrival) stage never goes stale; a stage a person set later does");
      const c0 = db.calls.length;
      eq([(await dropQuiet(db, [])).length, (await dropQuiet(db, [mkEv("chat", "chat", "s1", "s1", NOW, null, {})])).length, db.calls.length - c0], [0, 1, 0], "no event that could be quiet: nothing is read");
      const failing = (error: any) => { const q: any = { select: () => q, in: () => q, eq: () => q, limit: () => q, then: (res: any) => Promise.resolve({ data: null, error }).then(res) }; return { from: () => q }; };
      const noCol = failing({ code: "42703", message: "column contacts.import_quiet does not exist" }), broken = failing({ code: "57014", message: "timeout" });
      let threw = false; try { await quietIds(broken, "contacts", ["c1"]); } catch { threw = true; }
      eq([(await quietIds(noCol, "contacts", ["c1"])).size, threw, (await quietIds(db, "contacts", ["c-imp", "c-new", "c-imp", ""])).size], [0, true, 1],
        "before SQL G3.5 nothing is quiet; another read failure fails the scan (tried again next minute)");
      // the app's look now
      const lw = world({ contacts: [lead("c-new"), lead("c-imp", { import_quiet: true })], automations: [auto()] });
      const e1 = await handle(lw, { step: "event", type: "newLead", id: "c-imp" }, OWNER, false), e2 = await handle(lw, { step: "event", type: "newLead", id: "c-new" }, OWNER, false);
      eq([e1.body.runs, e1.body.reason, e2.body.runs], [0, "no event", 1], "the app's look now: an imported lead starts nothing, a new one does");
    }
    // ── import_quiet: the capture (the fake = SQL Part 3 · G3.5) ──
    {
      const db = world({ contacts: [lead("c1")], automation_wanted: ["contact_tag", "contact_changed", "task_added", "note_added"].map((t) => ({ business_id: "default", event_type: t })) });
      const evs = () => db.T.automation_events.map((e: any) => `${e.type}:${e.record_id}:${e.ctx.tag || e.ctx.field || ""}`);
      db.T.automation_events = [];
      await db.from("contacts").insert({ ...lead("c-imp", { import_quiet: true, tags: ["VIP"], customer_notes: [{ id: "n1", text: "old" }] }) });
      await db.from("tasks").insert({ id: "t-imp", title: "Imported", contact_id: "c-imp", import_quiet: true });
      await db.from("contacts").update({ import_quiet: true, tags: ["Old"], full_name: "Imported Name" }).eq("id", "c1");   // the import marks an existing lead
      eq(evs(), [], "an imported lead (tags, notes), an imported task and the import marking an existing lead: no event at all");
      await db.from("contacts").update({ tags: ["Old", "Hot"], assigned_user_id: "u-va" }).eq("id", "c1");   // a person, later
      await db.from("tasks").insert({ id: "t-new", title: "Call", contact_id: "c1" });
      await db.from("contacts").insert({ ...lead("c-new", { tags: ["VIP"] }) });
      eq(evs(), ["contact_changed:c1:assigned_user", "contact_tag:c1:Hot", "task_added:t-new:", "contact_tag:c-new:VIP"],
        "a person's later change of an imported lead counts (and Lead changed sees Assigned to); a new task and a new lead count");
    }

    // ── SQL Part 3 · G3.5: the replaced functions keep their contract; the ROLLBACK restores them exactly ──
    {
      const sql = src(SQL_DIR + "stage2-automations.sql"), p1 = sql.slice(sql.indexOf("-- PART 1"), sql.indexOf("-- END PART 1"));
      const g23 = sql.slice(sql.indexOf("-- PART 2 · G2.3"), sql.indexOf("-- END PART 2 · G2.3")), tx23 = g23.slice(g23.indexOf("\nbegin;\n"), g23.indexOf("\ncommit;\n"));
      const g = sql.slice(sql.indexOf("-- PART 3 · G3.5"), sql.indexOf("-- END PART 3 · G3.5"));
      const tx = g.slice(g.indexOf("\nbegin;\n"), g.indexOf("\ncommit;\n"));
      const rbx = g.slice(g.indexOf("-- ROLLBACK (G3.5 only")).split("\n").filter((l: string) => l.startsWith("-- ") || l === "--").map((l: string) => l === "--" ? "" : l.slice(3)).join("\n");
      const fnOf = (text: string, name: string) => { const a0 = text.indexOf(`create or replace function public.${name}(`); return a0 < 0 ? "" : text.slice(a0, text.indexOf("end $$;", a0) + 7); };
      const code = (t: string) => t.split("\n").filter((l: string) => !/^\s*--/.test(l)).join("\n");
      eq([(g.match(/^begin;$/gm) || []).length, (g.match(/^commit;$/gm) || []).length], [1, 1], "G3.5 is ONE transaction");
      ok(tx.includes("alter table public.contacts add column if not exists assigned_user_id uuid null references public.profiles (id) on delete set null;")
        && tx.includes("create index if not exists contacts_assigned_user_idx on public.contacts (assigned_user_id)")
        && ["contacts", "jobs", "tasks"].every((t) => tx.includes(`alter table public.${t} add column if not exists import_quiet boolean not null default false;`)),
        "the columns: contacts.assigned_user_id (→ profiles, on delete set null, indexed) and import_quiet on contacts / jobs / tasks, all idempotent");
      // capture: G2.3's contacts capture + the quiet rule + the assigned user − Quote status; Part 1's tasks / jobs + the quiet rule
      const QUIET = /\n    -- import_quiet \(G3\.5\)[\s\S]*?\n    end if;\n/, QUIET_JOBS = /\n    -- import_quiet \(G3\.5\): the import's own writes[\s\S]*?then return null; end if;\n/;
      const cap = fnOf(tx, "automation_capture_contacts"), est = /\n    if 'estimates' = any\(w\)[\s\S]*?\n    end if;\n/;
      const assignedLine = /\n      if new\.assigned_user_id is distinct from old\.assigned_user_id then chg[^\n]*/;
      ok(QUIET.test(cap) && assignedLine.test(cap) && est.test(fnOf(tx23, "automation_capture_contacts")) && cap.replace(QUIET, "\n").replace(assignedLine, "") === fnOf(tx23, "automation_capture_contacts").replace(est, "\n"),
        "the contacts capture = G2.3's + the quiet rule + the assigned user, without Quote status; nothing else changed");
      ok(!/estimates/.test(code(tx)) && !/'estimates'/.test(code(fnOf(tx, "automation_apply"))), "Q5: nothing in G3.5 writes or reads an 'estimates' event");
      const chg = [...cap.matchAll(/if new\.(\w+) is distinct from old\.\1 then chg := chg \|\| pg_catalog\.jsonb_build_object\('field', '(\w+)'/g)];
      eq([chg.map((m) => m[2]), chg.filter((m) => m[1] !== m[2]).map((m) => `${m[1]}=${m[2]}`)], [CONTACT_CHANGED_FIELDS, Object.entries(CONTACT_FIELD_COLUMN).map(([f, c]) => `${c}=${f}`)],
        "G3.5's capture compares exactly CONTACT_CHANGED_FIELDS (the assigned user included); a column is its field except the quote amount and the assigned user");
      ok(fnOf(tx, "automation_capture_tasks").replace(QUIET, "\n") === fnOf(p1, "automation_capture_tasks") && fnOf(tx, "automation_capture_jobs").replace(QUIET_JOBS, "\n") === fnOf(p1, "automation_capture_jobs"),
        "the tasks and jobs captures = Part 1's + the quiet rule");
      ok(["automation_capture_contacts", "automation_capture_tasks"].every((n0) => fnOf(tx, n0).includes("    if new.import_quiet then\n      if tg_op = 'INSERT' then return null; end if;\n      if not old.import_quiet or public.automation_import_write() then return null; end if;\n    end if;"))
        && fnOf(tx, "automation_capture_jobs").includes("if new.import_quiet and (not old.import_quiet or public.automation_import_write()) then return null; end if;"),
        "the quiet rule: no event for an INSERT of a quiet row nor for the import's own update (marking it, or the import's write); a later change counts");
      // apply: G2.3's + the 'assign' op
      const ap = fnOf(tx, "automation_apply"), assignBranch = /\n      elsif o = 'assign' then[\s\S]*?(?=\n      elsif o = 'task' then)/;
      const allowed = /allowed constant text\[\] := array\[([^\]]*)\]/.exec(ap);
      eq(allowed ? allowed[1].split(",").map((x: string) => x.trim().replace(/'/g, "")) : null, UPDATE_FIELD_COLUMNS, "G3.5's automation_apply: the 'set' whitelist is still UPDATE_FIELD_COLUMNS (the assigned user is not a 'set' field)");
      ok(assignBranch.test(ap) && ap.replace(assignBranch, "").replace("'stage', 'assign') and cid is null", "'stage') and cid is null") === fnOf(tx23, "automation_apply")
        && /select p\.full_name::text into v from public\.profiles p where p\.id = tgt::uuid;/.test(ap) && ap.includes("'Assigned user removed'") && ap.includes("'Assigned to ' ||"),
        "automation_apply = G2.3's + 'assign' (a person of the team or nobody; a history line); nothing else changed");
      // who may assign; the names; the import switch
      const head = (name: string) => { const f0 = tx.indexOf(`function public.${name}(`); return tx.slice(f0, tx.indexOf("as $$", f0)); };
      const guard = fnOf(tx, "contacts_assignee_guard");
      ok(/security invoker/.test(head("contacts_assignee_guard")) && guard.includes("if current_user::text not in ('authenticated', 'anon') then return new; end if;")
        && guard.includes("if new.assigned_user_id = auth.uid() or public.is_owner_or_manager() then return new; end if;")
        && tx.includes("create trigger contacts_assignee_guard before insert or update of assigned_user_id on public.contacts"),
        "Assigned to: owners and managers pick anyone; others only themselves or nobody (the app's roles; the engine and server code not limited)");
      ok(/stable security definer/.test(head("team_people")) && tx.includes("where auth.uid() is not null") && tx.includes("revoke all on function public.team_people() from public, anon;")
        && tx.includes("grant execute on function public.team_people() to authenticated, service_role;") && /stable/.test(head("automation_import_write"))
        && tx.includes("revoke all on function public.automation_import_write() from public, anon, authenticated;"),
        "team_people: names for signed-in people only; automation_import_write: the capture's, not the app's");
      // the rollback
      ok(fnOf(rbx, "automation_apply") === fnOf(tx23, "automation_apply") && fnOf(rbx, "automation_capture_contacts") === fnOf(tx23, "automation_capture_contacts")
        && fnOf(rbx, "automation_capture_tasks") === fnOf(p1, "automation_capture_tasks") && fnOf(rbx, "automation_capture_jobs") === fnOf(p1, "automation_capture_jobs") && fnOf(tx23, "automation_apply").length > 5000,
        "the G3.5 ROLLBACK restores G2.3's automation_apply / contacts capture and Part 1's tasks / jobs captures byte for byte");
      ok(["drop trigger if exists contacts_assignee_guard on public.contacts;", "drop function if exists public.contacts_assignee_guard();", "drop function if exists public.team_people();",
        "drop function if exists public.automation_import_write();", "drop index if exists public.contacts_assigned_user_idx;",
        "alter table public.contacts drop column if exists assigned_user_id;", "drop trigger if exists jobs_import_quiet_date on public.jobs;", "drop function if exists public.jobs_import_quiet_date();",
        "alter table public.jobs drop column if exists import_quiet_date;"].every((x) => rbx.includes(x)) && rbx.indexOf("drop trigger if exists contacts_assignee_guard") < rbx.indexOf("drop column if exists assigned_user_id")
        && !/drop column if exists import_quiet\b/.test(code(rbx)) && !/backup\.import_quiet/.test(rbx),
        "…and drops what G3.5 added — but never stage 5's import_quiet columns (stage5-mcp.sql owns them; its import and push read them)");
      const jq = fnOf(tx, "jobs_import_quiet_date");
      ok(tx.includes("alter table public.jobs add column if not exists import_quiet_date text;") && /security definer/.test(head("jobs_import_quiet_date"))
        && jq.includes("if new.import_quiet and (tg_op = 'INSERT' or not old.import_quiet or public.automation_import_write()) then\n    new.import_quiet_date := new.date::text;")
        && tx.includes("create trigger jobs_import_quiet_date before insert or update of date, import_quiet on public.jobs") && tx.includes("revoke all on function public.jobs_import_quiet_date() from public, anon, authenticated;")
        && !/import_quiet\s*:=/.test(code(tx)) && tx.indexOf("update public.jobs set import_quiet_date = date::text where import_quiet and import_quiet_date is null;") < tx.indexOf("create trigger jobs_import_quiet_date"),
        "a quiet job's imported date: set on the import's writes only (a person's reschedule keeps it; security definer: the app can't call automation_import_write); old imports get their date; import_quiet itself is never written");
      ok(/OWNED BY STAGE 5/.test(g) && /3 rows \(boolean, NO, false\) where stage5-mcp\.sql M5 is applied/.test(g) && !/nothing imported yet/.test(g),
        "G3.5's checks accept stage 5's import_quiet columns already there (live) and quiet rows already imported");
      const app = src("../../../index.html");
      ok(app.includes("'team_people'") && app.includes("assigned_user_id"), "the app reads the team's names and the lead's assigned user");
    }
  }

  // ── 38. Publish refuses what the old list switch refused (stage 2 phase 3, 15 Oct; defence in depth): the old editor's
  //        blocking checks = fixtures/editor-blocks.json word for word (the app's autoProblems reads the same file in
  //        tests/business-logic.test.js); step "publish" refuses them for a workflow the old editor shows, before it asks
  //        about customers; of the phase-4 corpus exactly the shapes the old switch refused are refused, with its words;
  //        a doc only the new builder shows keeps the v2 checks only. Duplicate / copy_version: the copy is fully editable
  //        (no locked step or condition, as the old Duplicate); a workflow chosen from a template keeps the template's
  //        locks (design §2.2: a template's guard node can't be removed). ──
  {
    io.advance = PROD_ADVANCE;
    const api = (db: any, step: string, body: any = {}, me: any = OWNER) => handle(db, { step, ...body }, me, false);
    const C34v = (x: any) => canonJson(x);
    const FX = JSON.parse(src("fixtures/editor-blocks.json"));
    ok(FX.cases.length >= 60, "editor blocks: the shared fixture has its cases");
    for (const c of FX.cases) eq(v1EditorProblems(c.def, { ...FX.catalog, ...(c.catalog || {}) }, c.wfName ?? "Workflow"), c.blocks, `editor blocks: ${c.name}`);
    eq([v1EditorProblems(null, null, null), v1EditorProblems({ trigger: { type: "newLead" }, steps: "nope" }, {}, "")], [["Pick what starts it (step 1).", "Pick at least one thing to do (step 5)."], ["Pick at least one thing to do (step 5)."]],
      "editor blocks: nothing given → its first two blocks; steps that are not a list = no steps");
    // the corpus, end to end: the phase-4 row is migrated, then published (with the yes to what it sends)
    const SHAPES = [...JSON.parse(src("fixtures/upgrade.json")).cases.map((k: any) => ({ name: k.name, trigger: k.v1.trigger, steps: k.v1.steps })),
      ...JSON.parse(src("differential/corpus/builtin.json")).automations.map((a: any) => ({ name: a.name, trigger: a.trigger, steps: a.steps }))];
    eq(Object.keys(FX.corpus).filter((n: string) => !SHAPES.some((s: any) => s.name === n)), [], "editor blocks: every name in the corpus list is a shape of the corpus");
    const ID38 = "a38-0000-0000";
    const world38 = (S: any) => {
      const db = world({ automations: [auto({ id: ID38, name: "Shape", enabled: false, armed_at: null, trigger: S.trigger, steps: S.steps, revision: 1, settings: {}, layout: { v: 1 }, builder: "standard",
        origin: "user", list_summary: {}, deleted_at: null, audience: "team" })], automation_versions: [], automation_templates: [] });
      db.T.settings[0].catalog = { ...CATALOG, templates: FX.catalog.templates };
      return db;
    };
    const got: Record<string, string> = {}, other: string[] = [];
    for (const S of SHAPES) {
      const db = world38(S);
      eq((await api(db, "migrate")).status, 200, `editor blocks: migrated — ${S.name}`);
      const p = await api(db, "publish", { automation_id: ID38, on: true, confirm: true }), row = db.T.automations[0];
      if (p.status === 422) { got[S.name] = (p.body.errors || [{}])[0].text; ok(row.enabled === false && p.body.errors.every((x: any) => x.severity === "error"), `editor blocks: refused and still a Draft — ${S.name}`); }
      else if (!(p.status === 200 && row.enabled === true)) other.push(`${S.name}: ${p.status} ${JSON.stringify(p.body).slice(0, 120)}`);
    }
    eq([got, other], [FX.corpus, []], "publish refuses exactly the corpus shapes the old switch refused (10 it let through in phase 3 before this fix: a task for nobody ×4, \"Service is one of\" ×2, the same id twice, {technician} on a new lead, more than 20 steps ×2), with the old editor's first words; every other shape goes on");
    // before the question about customers: a blocked customer shape is refused without its yes (422, not 409 "confirm")
    {
      const db = world38(SHAPES.find((s: any) => s.name === "A blank that cannot be filled"));
      await api(db, "migrate");
      const p = await api(db, "publish", { automation_id: ID38, on: true });
      eq([p.status, p.body.reason, (p.body.errors || [{}])[0].text, (p.body.errors || [{}])[0].code, db.T.automations[0].enabled], [422, "errors", "{technician} can't be filled in for \"A new lead comes in\" (step 6).", "E_EDITOR_BLOCK", false],
        "publish: a workflow the old editor would refuse is refused before the customer question");
      const off = await api(db, "publish", { automation_id: ID38, on: false });
      eq([off.status, off.body.enabled], [200, false], "publish: switching to Draft is never checked");
    }
    // the steps the old editor shows: an upgraded row whose ids phase 4 refuses → its stored steps (so "the same id twice"
    // is said); otherwise its doc as phase-4 steps; a row with no doc yet → its own steps; a doc only the new builder shows → none
    {
      const dup = SHAPES.find((s: any) => s.name === "the same id twice"), lw = SHAPES.find((s: any) => s.name === "Lead waiting (team card)");
      const up = (S: any) => ({ id: "v", trigger: S.trigger, steps: S.steps, definition: upgradeV1(S.trigger, S.steps).doc, settings: { ...WF_MIGRATED_SETTINGS } });
      eq([v1EditorView(up(dup)).steps.map((s: any) => s.id), v1EditorView({ ...up(dup), settings: {} }).steps.map((s: any) => s.id), C34v(v1EditorView(up(lw))), C34v(v1EditorView({ id: "w", trigger: lw.trigger, steps: lw.steps, definition: null }))],
        [["s1", "s1"], ["s1", "s3"], C34v(wfToFlat(upgradeV1(lw.trigger, lw.steps).doc)), C34v({ trigger: lw.trigger, steps: lw.steps })],
        "v1EditorView: the same id twice → the stored steps (an upgraded row as it was); with stage-2 settings → the doc's; a row with no doc → its own trigger and steps");
      const named = { schema: 2, seq: 2, entry: "n1", triggers: [{ id: "t1", type: "newLead", filters: { match: "all", segments: [{ match: "all", rules: [] }] } }],
        nodes: { n1: { kind: "action", type: "add_task", name: "Call them", config: { title: "Call {name}" }, out: { next: null } } } };
      eq(v1EditorView({ id: "n", definition: named, settings: {} }), null, "v1EditorView: a doc only the new builder shows (a named step) → none");
      const db = world({ automations: [], automation_versions: [], automation_templates: [] });
      const s = await api(db, "save", { automation_id: null, name: "New builder task", definition: named, settings: {} });
      const p = await api(db, "publish", { automation_id: s.body.id, on: true });
      eq([s.status, p.status, db.T.automations.find((a: any) => a.id === s.body.id).enabled], [200, 200, true], "publish: a doc only the new builder shows keeps the v2 checks only (its task for nobody is fine there)");
    }
    // a straight (flat) doc that the NEW builder saved last is judged by the v2 checks (layout.editor "builder"): 25 team
    // notifications are fine there (the old editor's "At most 20 steps." does not apply); the old editor saving the same
    // row takes the mark off, so its own block is back; a duplicate keeps the source's mark; a phase-4 row never saved by
    // the builder keeps the old block
    {
      const N = 25, nodes: any = {};
      for (let i = 1; i <= N; i++) nodes[`n${i}`] = { kind: "action", type: "internal_notification", config: { channel: "push", to: { roles: ["owner"] }, title: `Note ${i}` }, out: { next: i < N ? `n${i + 1}` : null } };
      const flat = { schema: 2, seq: N, entry: "n1", triggers: [{ id: "t1", type: "newLead", filters: { match: "all", segments: [{ match: "all", rules: [] }] } }], nodes };
      ok(!!wfToFlat(flat) && wfToFlat(flat).steps.length === N, "editor mark: the 25-step doc is straight (the old editor could show it)");
      const db = world({ automations: [], automation_versions: [], automation_templates: [] });
      const s1 = await api(db, "save", { automation_id: null, name: "Big alert", definition: flat, settings: {}, layout: { v: 1, stickies: [] }, builder: "standard", editor: "builder" });
      const row = () => db.T.automations.find((a: any) => a.id === s1.body.id);
      eq([s1.status, row().layout, v1EditorView(row())], [200, { v: 1, stickies: [], editor: "builder" }, null], "editor mark: a save from the new builder marks the row (its layout keeps the stickies)");
      const p1 = await api(db, "publish", { automation_id: s1.body.id, on: true, expected_revision: s1.body.revision });
      eq([p1.status, row().enabled], [200, true], "editor mark: published by the v2 rules (never refused in the old editor's words)");
      await api(db, "publish", { automation_id: s1.body.id, on: false });
      const d1 = await api(db, "duplicate", { automation_id: s1.body.id });
      eq([d1.status, (db.T.automations.find((a: any) => a.id === d1.body.id) || {}).layout?.editor], [200, "builder"], "editor mark: a duplicate keeps the source's layout and its mark");
      const s2 = await api(db, "save", { automation_id: s1.body.id, expected_revision: row().revision, name: "Big alert", definition: flat });
      eq([s2.status, has(row().layout, "editor"), row().layout.stickies], [200, false, []], "editor mark: a save from the old editor (no layout, no editor) takes the mark off and keeps the rest of the layout");
      const p2 = await api(db, "publish", { automation_id: s1.body.id, on: true, expected_revision: row().revision });
      eq([p2.status, (p2.body.errors || [{}])[0].code, (p2.body.errors || [{}])[0].text, row().enabled], [422, "E_EDITOR_BLOCK", "At most 20 steps.", false], "editor mark: the old editor saved it last → the old block is back, in its words");
      const s3 = await api(db, "save", { automation_id: s1.body.id, expected_revision: row().revision, name: "Big alert", definition: flat, editor: "builder" });
      const p3 = await api(db, "publish", { automation_id: s1.body.id, on: true, expected_revision: row().revision });
      eq([s3.status, row().layout, p3.status], [200, { v: 1, stickies: [], editor: "builder" }, 200], "editor mark: saved from the new builder again (no layout sent: the stored one is kept) → the v2 rules again");
      const forged = await api(db, "save", { automation_id: null, name: "Forged", definition: flat, layout: { v: 1, editor: "old" } });
      eq((db.T.automations.find((a: any) => a.id === forged.body.id) || {}).layout, { v: 1, editor: "old" }, "editor mark: another word in a layout is stored as given (only \"builder\" means the v2 rules)");
      eq(v1EditorView(db.T.automations.find((a: any) => a.id === forged.body.id)).steps.length, N, "editor mark: … so the old editor's view (and its blocks) apply to that one");
    }
    // a migrated row (re-entry legacy_always) the new builder saves while it is still a straight chain runs by the phase-4
    // rules (wfRunRow) → what those refuse is an error of validate / save / publish too (E_RUNS_OLD_WAY), never a Published
    // workflow that quietly stops starting and ends its waiting runs (wfEligible)
    {
      const ID = "a38-runs-old", T0 = { type: "newLead", params: {} };
      const S0 = [{ id: "c1", kind: "if", match: "all", conds: [{ field: "has_mobile", op: "true" }] }, { id: "p1", kind: "action", type: "push", to: { roles: ["owner"] }, title: "New lead" }];
      const db = world({ automations: [auto({ id: ID, name: "Gate", enabled: false, armed_at: null, trigger: T0, steps: S0, revision: 1, settings: {}, layout: { v: 1 }, builder: "standard",
        origin: "user", list_summary: {}, deleted_at: null, audience: "team" })], automation_versions: [], automation_templates: [] });
      eq((await api(db, "migrate")).status, 200, "runs the old way: migrated");
      const row = () => db.T.automations.find((a: any) => a.id === ID);
      // (fresh row objects: wfRunRow and wfEligible are memoised per row object, the fake database changes rows in place)
      ok(wfRunRow({ ...row() }).definition === null && wfEligible({ ...wfRunRow({ ...row() }), enabled: true, armed_at: "2026-10-01T00:00:00Z" }, CATALOG), "runs the old way: the migrated row runs as phase 4 and is eligible");
      const doc = JSON.parse(JSON.stringify(row().definition)), ifId = Object.keys(doc.nodes).find((k) => doc.nodes[k].kind === "if_else");
      doc.nodes[ifId].config.branches[0].when.segments[0].rules = [{ field: "lead.postcode", op: "is", v: "2000" }];
      ok(!!wfToFlat(doc) && validateDoc(doc, { builder: "standard", catalog: CATALOG }).errors.length === 0, "runs the old way: the edit is still straight and fine by the v2 checks");
      const v = await api(db, "validate", { automation_id: ID, definition: doc, editor: "builder" }), vOld = await api(db, "validate", { automation_id: ID, definition: doc });
      eq([v.status, (v.body.errors || []).map((x: any) => x.code), (vOld.body.errors || []).length], [200, ["E_RUNS_OLD_WAY", "E_EDITOR_BLOCK"], 0], "runs the old way: validate from the builder says so, with the old editor's own block too (its call is unchanged)");
      ok(/^It still runs the old way, which refuses this: .*lead\.postcode/.test(v.body.errors[0].text), "runs the old way: in words, with the phase-4 rule's reason");
      const s1 = await api(db, "save", { automation_id: ID, expected_revision: row().revision, name: "Gate", definition: doc, editor: "builder" });
      eq([s1.status, (s1.body.errors || []).map((x: any) => x.code), row().layout.editor], [200, ["E_RUNS_OLD_WAY", "E_EDITOR_BLOCK"], "builder"], "runs the old way: a Draft is saved with the errors (as every Draft error)");
      const p1 = await api(db, "publish", { automation_id: ID, on: true, confirm: true, expected_revision: row().revision });
      eq([p1.status, (p1.body.errors || [{}])[0].code, row().enabled], [422, "E_RUNS_OLD_WAY", false], "runs the old way: publish refuses it (never a Published row the engine would not enroll)");
      // published before the edit: the save itself is refused, the live row is unchanged and still eligible
      await api(db, "save", { automation_id: ID, expected_revision: row().revision, name: "Gate", definition: upgradeV1(T0, S0).doc, editor: "builder" });
      const p2 = await api(db, "publish", { automation_id: ID, on: true, confirm: true, expected_revision: row().revision });
      const before = JSON.stringify(row().definition), s2 = await api(db, "save", { automation_id: ID, expected_revision: row().revision, name: "Gate", definition: doc, editor: "builder" });
      eq([p2.status, s2.status, (s2.body.errors || [{}])[0].code, JSON.stringify(row().definition) === before, wfEligible(wfRunRow({ ...row() }), CATALOG)], [200, 422, "E_RUNS_OLD_WAY", true, true],
        "runs the old way: a Published row refuses the save (422), keeps what runs, and stays eligible");
      // a doc that runs as a doc (not straight any more) is not touched by this check
      const branchy = JSON.parse(JSON.stringify(doc)); branchy.nodes.x9 = { kind: "action", type: "add_task", config: { title: "Call" }, out: { next: null } };
      eq([wfToFlat(branchy), wfRunsOldProblems({ ...row(), definition: branchy }, CATALOG)], [null, []], "runs the old way: a doc that is not a straight chain runs as a doc: nothing to say");
      eq(wfRunsOldProblems({ ...row(), definition: doc, settings: {} }, CATALOG), [], "runs the old way: with stage-2 settings the row runs its doc: nothing to say");
    }
    // review round 2 (16 Oct): a migrated row the new builder saved (a sticky note: layout.editor "builder") still runs as
    // phase 4 while it is a straight chain with the upgrade's settings → the old editor's blocks stay errors of validate /
    // save / publish (wfRunsOldProblems → E_EDITOR_BLOCK): the 14 corpus shapes stay refused, the other 34 still go on
    {
      const got2: Record<string, string> = {}, other2: string[] = [];
      for (const S of SHAPES) {
        const db = world38(S);
        await api(db, "migrate");
        const r0 = db.T.automations[0];
        const s = await api(db, "save", { automation_id: ID38, expected_revision: r0.revision, name: "Shape", definition: JSON.parse(JSON.stringify(r0.definition)), layout: { v: 1, stickies: [{ id: "k1", text: "Check" }] }, editor: "builder" });
        if (s.status !== 200 || db.T.automations[0].layout.editor !== "builder") { other2.push(`${S.name}: save ${s.status}`); continue; }
        const p = await api(db, "publish", { automation_id: ID38, on: true, confirm: true, expected_revision: db.T.automations[0].revision });
        if (p.status === 422) { const blk = (p.body.errors || []).find((x: any) => x.code === "E_EDITOR_BLOCK"); got2[S.name] = blk ? blk.text : `(${(p.body.errors || [{}])[0].code})`; if (db.T.automations[0].enabled) other2.push(`${S.name}: switched on`); }
        else if (!(p.status === 200 && db.T.automations[0].enabled === true)) other2.push(`${S.name}: ${p.status}`);
      }
      eq([Object.keys(got2).sort(), other2, Object.entries(got2).filter(([n, t]) => !t.startsWith("(") && t !== FX.corpus[n])], [Object.keys(FX.corpus).sort(), [], []],
        "saved by the new builder (a sticky note) while it still runs as phase 4: exactly the 14 corpus shapes are still refused (the old editor's first words where it shows them), the other 34 still publish");
      eq(got2["A blank that cannot be filled"], FX.corpus["A blank that cannot be filled"], "… e.g. a new lead's email about {technician}: never live with the blank empty");
      const db = world38(SHAPES.find((s: any) => s.name === "A blank that cannot be filled"));
      await api(db, "migrate");
      const v = await api(db, "validate", { automation_id: ID38, definition: db.T.automations[0].definition, editor: "builder" });
      eq([v.status, (v.body.errors || []).map((x: any) => x.code)], [200, ["E_EDITOR_BLOCK"]], "… and the builder's validate already says so (its Errors panel and the save)");
    }
    // review round 2: the builder says whether it thinks the workflow is Published (a publish never bumps the revision):
    // one published or switched to Draft meanwhile → 409 "status" (the builder then saves the way that status saves)
    {
      const db = world38(SHAPES.find((s: any) => s.name === "new lead → push"));
      await api(db, "migrate");
      const r0 = db.T.automations[0], body = { automation_id: ID38, name: "Shape", definition: JSON.parse(JSON.stringify(r0.definition)), editor: "builder" };
      const s1 = await api(db, "save", { ...body, expected_revision: r0.revision, expected_enabled: true });
      eq([s1.status, s1.body.reason, s1.body.enabled, db.T.automations[0].revision], [409, "status", false, r0.revision], "save: the builder thinks it is Published, it is a Draft → 409 status, nothing written");
      await api(db, "publish", { automation_id: ID38, on: true, confirm: true });
      const s2 = await api(db, "save", { ...body, expected_revision: db.T.automations[0].revision, expected_enabled: false });
      const s3 = await api(db, "save", { ...body, expected_revision: db.T.automations[0].revision, expected_enabled: true });
      const s4 = await api(db, "save", { ...body, expected_revision: db.T.automations[0].revision });
      eq([s2.status, s2.body.reason, s2.body.enabled, s3.status, s4.status], [409, "status", true, 200, 200], "save: published meanwhile while the builder shows Draft → 409 status; the status it shows → saved; a caller that says nothing (the old editor) → saved");
    }
    // Duplicate / copy_version: no locked step or condition in the copy; the original keeps its locks; a template keeps them
    {
      const LOCKED = { trigger: { type: "newLead", params: {} }, steps: [{ id: "w1", kind: "wait", n: 15, unit: "minutes", lock: true },
        { id: "c1", kind: "if", match: "all", conds: [{ field: "not_picked", op: "true", lock: true }, { field: "has_email", op: "true" }] },
        { id: "p1", kind: "action", type: "push", to: { roles: ["owner"] }, title: "Waiting: {name}" }] };
      const locks = (d: any) => JSON.stringify(d).match(/"lock(ed)?":true/g)?.length ?? 0;
      const db = world38(LOCKED);
      await api(db, "migrate");
      const orig = db.T.automations[0], before = JSON.stringify(orig.definition);
      eq(locks(orig.definition), 2, "the migrated row keeps its lock (a locked step and a locked condition)");
      const d1 = await api(db, "duplicate", { automation_id: ID38 });
      const c1 = db.T.automations.find((a: any) => a.id === d1.body.id);
      eq([d1.status, locks(c1.definition), c1.definition.nodes.w1.locked, c1.definition.nodes.c1.config.branches[0].when.segments[0].rules, JSON.stringify(orig.definition) === before, locks(orig.definition)],
        [200, 0, undefined, [{ field: "not_picked", op: "true" }, { field: "has_email", op: "true" }], true, 2], "duplicate: the copy has no locked step or condition (the old Duplicate removed them); the original keeps both");
      const edit = (d: any) => { const x = JSON.parse(JSON.stringify(d)); x.nodes.c1.config.branches[0].when.segments[0].rules = [{ field: "has_email", op: "true" }]; delete x.nodes.w1; x.entry = "c1"; return x; };
      const vc = await api(db, "validate", { automation_id: c1.id, definition: edit(c1.definition) }), vo = await api(db, "validate", { automation_id: ID38, definition: edit(orig.definition) });
      eq([vc.status, vc.body.errors.map((x: any) => x.code), vo.body.errors.map((x: any) => x.code)], [200, [], ["E_LOCKED", "E_LOCKED"]],
        "the copy is fully editable (its wait and its condition can go: no error); the original still refuses both (E_LOCKED)");
      const vno = db.T.automation_versions.find((v: any) => v.automation_id === ID38 && v.reason === "migration").version_no;
      const cv = await api(db, "copy_version", { automation_id: ID38, version_no: vno });
      eq([cv.status, locks(db.T.automations.find((a: any) => a.id === cv.body.id).definition)], [200, 0], "copy_version: the new workflow from a version has no lock either");
      db.T.automation_templates.push({ id: "tpl38", business_id: "default", key: "mine_lock000000", name: "Guarded", description: null, category: null, definition: JSON.parse(before), settings: {}, origin: "user", deleted_at: null });
      const dt = await api(db, "duplicate", { template_id: "tpl38" });
      eq([dt.status, locks(db.T.automations.find((a: any) => a.id === dt.body.id).definition)], [200, 2], "a workflow chosen from a template keeps the template's locks (design §2.2: a System / template guard node)");
      const given = JSON.parse(before);
      eq([locks(wfUnlocked(given)), JSON.stringify(given) === before, wfUnlocked(null), wfUnlocked({ schema: 2, nodes: { x: null }, triggers: [null, { filters: { segments: [null, { rules: [null, 7] }] } }] }).nodes],
        [0, true, {}, { x: null }], "wfUnlocked: a copy without any lock; the doc given is never changed; odd docs never throw");
    }
  }

  // ── 39. people on vacation in stage-2 docs (main's stage 3, merged 15 Oct; 26b runs the phase-4 rows through both
  //        executors): Send internal notification skips them or goes to their stand-in (money or private details only
  //        to an owner stand-in), Add task goes to the stand-in on its due day with the line in its notes and the board
  //        of the person it went to, Assign to user gives the lead to the stand-in's login or is skipped "on vacation";
  //        the dry run (a doc's and a phase-4 row's) says the same on the day of its clock; one read a tick, shared by
  //        the copies of the tick's context ──
  {
    io.advance = PROD_ADVANCE;
    const NONE = { match: "all", segments: [{ match: "all", rules: [] }] };
    const PROFS = [OWNER, MANAGER, VA, VA_NOCRM, { ...TECH, full_name: "Cal Tech", technician_name: "Cal Tech" }];
    const EMPS = [{ id: "e-own", name: "Olivia Owner", status: "Active" }, { id: "e-mgr", name: "Max Manager", status: "Active" }, { id: "e-va", name: "Vicky Va", status: "Active" },
      { id: "e-va2", name: "Vera Va", status: "Active" }, { id: "e-cal", name: "Cal Tech", status: "Active" }, { id: "e-old", name: "Old Hand", status: "Inactive" }];
    const U_OWN = "22222222-2222-4222-8222-222222222222";   // a second login of the owner, with a uuid (the step checks it)
    const vac = (o: any = {}) => ({ id: "v1", business_id: "default", employee_id: "e-own", starts_on: "2026-10-13", ends_on: "2026-10-17", stand_in_id: null, options: { noNotify: true }, ended_at: null, cancelled_at: null, reminded_at: null, ...o });
    const push = (to: any, title = "New lead: {name}", next: string | null = null) => ({ kind: "action", type: "internal_notification", config: { channel: "push", to, title }, out: { next } });
    const task = (assignees: string[], o: any = {}, next: string | null = null) => ({ kind: "action", type: "add_task", config: { title: "Call {first_name}", assignees, due_days: 1, ...o }, out: { next } });
    const assign = (user: string, next: string | null = null) => ({ kind: "action", type: "assign_user", config: { user }, out: { next } });
    let wn = 0;
    const flowOf = (nodes: any) => ({ id: `w39-${String(++wn).padStart(4, "0")}`, business_id: "default", name: "Vacation " + wn, enabled: true, armed_at: "2026-10-01T00:00:00.000Z", version: 1, revision: 1,
      created_by_name: "Olivia Owner", trigger: {}, steps: [], definition: { schema: 2, seq: 9, entry: "n1", triggers: [{ id: "t1", type: "newLead", filters: NONE }], nodes }, settings: { reentry: "off", perRecord: true }, deleted_at: null });
    const worldOf = (vacs: any[], automations: any[] = []) => {
      const db = world({ profiles: [...PROFS, { id: U_OWN, full_name: "Olivia Owner", role: "owner", permissions: {}, technician_name: null }], employees: EMPS, employee_vacations: vacs, contacts: [lead("c1")], automations });
      db.T.push_subscriptions.push({ id: "d4", user_id: "u-va2", endpoint: "https://push/va2", p256dh: "k", auth: "a" });
      return db;
    };
    const docRun = async (vacs: any[], nodes: any) => {
      const A = flowOf(nodes), db = worldOf(vacs, [A]);
      db.T.automation_runs.push({ id: "r39", business_id: "default", automation_id: A.id, automation_version: 1, event_key: "c1:new", event_type: "newLead", event_at: isoMs(NOW), record_kind: "contact", record_id: "c1",
        contact_id: "c1", status: "running", step_index: 0, anchor_at: isoMs(NOW), due_at: isoMs(NOW), attempts: 1, context: {}, trigger_id: "t1", cursor_step: null, remove_requested: false, chain_depth: 0 });
      sent.length = 0; clock = NOW;
      const p: any = await advanceV2(db, { ...db.T.automation_runs[0] }, ctxOf(db), NOW);
      clock = NOW;
      const rows = acts(db).filter((l: any) => l.run_id === "r39");
      return { db, p, rows, log: rows.map((l: any) => `${l.step_id}:${l.status}${l.reason ? ":" + l.reason : ""}`), to: sent.map((s) => s.to) };
    };
    const standIn = (emp: string, o: any = {}) => vac({ stand_in_id: emp, options: { noNotify: true, standIn: true }, ...o });
    // Send internal notification
    let r = await docRun([standIn("e-mgr")], { n1: push({ roles: ["owner", "manager"] }) });
    eq([r.p.status, r.to, r.rows[0].recipient], ["done", ["https://push/mgr"], "Max Manager"], "doc push: the owner away (stand-in the manager) → the manager once");
    r = await docRun([vac()], { n1: push({ roles: ["owner"] }) });
    eq([r.to, r.log], [[], ["n1:skipped:on vacation"]], "doc push: owners only, the owner away without a stand-in → 'skipped: on vacation', not 'failed: no device'");
    r = await docRun([standIn("e-mgr")], { n1: push({ roles: ["owner"] }) });
    eq([r.to, r.log], [[], ["n1:skipped:on vacation"]], "doc push: owners only → a manager stand-in never gets it");
    r = await docRun([standIn("e-va2")], { n1: push({ roles: [], people: ["u-owner", "u-va"] }) });
    eq([r.to.sort(), r.rows[0].recipient], [["https://push/va", "https://push/va2"], "Vera Va, Vicky Va"], "doc push: the owner and a VA picked by name, the owner away → their VA stand-in (a VA's role was picked)");
    r = await docRun([standIn("e-va2")], { n1: push({ roles: [], people: ["u-owner", "u-va"] }, "Quote {quote_amount} for {name}") });
    eq([r.to, r.rows[0].recipient], [["https://push/va"], "Vicky Va"], "doc push with money ({quote_amount}, W_MONEY_TO_NON_OWNER's test): a stand-in who is not an owner never gets it");
    r = await docRun([], { n1: push({ roles: ["owner", "manager"] }) });
    eq(r.to.sort(), ["https://push/mgr", "https://push/owner"], "doc push: nobody away → as before");
    // Add task
    const away = (o: any = {}) => vac({ employee_id: "e-cal", stand_in_id: "e-va", options: { notAssignable: true, standIn: true }, ...o });
    r = await docRun([away()], { n1: task(["e-cal"], { notes: "Ring before 5" }) });
    eq([r.log, r.db.T.tasks.map((t: any) => [t.assignees, t.assigned_to, t.board, t.due, t.notes])],
      [["n1:executed"], [[["Vicky Va"], "Vicky Va", "ron", "2026-10-15", "For Cal Tech (on vacation): given to Vicky Va, the stand-in.\n\nRing before 5"]]],
      "doc task: someone not assignable on the due day → their stand-in, the board follows the stand-in, the line before the task's own notes");
    r = await docRun([away()], { n1: task(["e-cal"], { due_days: 7 }) });
    eq(r.db.T.tasks.map((t: any) => [t.assignees, t.due, t.notes]), [[["Cal Tech"], "2026-10-21", null]], "doc task: due after the return day → the person stays, no line");
    r = await docRun([away({ starts_on: "2026-10-20", ends_on: "2026-10-23" })], { n1: task(["e-cal"], { due_days: 7 }) });
    eq(r.db.T.tasks.map((t: any) => t.assignees), [["Vicky Va"]], "doc task: away on the due day (not today) → the stand-in");
    r = await docRun([away({ options: { notAssignable: true } })], { n1: task(["e-cal", "e-va"]) });
    eq(r.db.T.tasks.map((t: any) => [t.assignees, t.notes]), [[["Cal Tech", "Vicky Va"], null]], "doc task: no stand-in ticked → the person stays (a warning in the app, never a block)");
    // Assign to user
    r = await docRun([vac({ stand_in_id: "e-mgr", options: { notAssignable: true, standIn: true } })], { n1: assign(U_OWN) });
    eq([r.log, r.db.T.automation_apply_calls.map((x: any) => x.p_ops), r.db.T.contacts[0].assigned_user_id, r.rows[0].detail.vacation],
      [["n1:executed"], [[{ op: "assign", user: "u-mgr" }]], "u-mgr", "For Olivia Owner (on vacation): given to Max Manager, the stand-in."],
      "doc assign: the person picked is not assignable today → their stand-in's login; the log row says who it was for");
    r = await docRun([vac({ options: { notAssignable: true } })], { n1: assign(U_OWN) });
    eq([r.log, (r.db.T.automation_apply_calls || []).length, r.db.T.contacts[0].assigned_user_id ?? null], [["n1:skipped:on vacation"], 0, null], "doc assign: not assignable and no stand-in → skipped 'on vacation', nothing written");
    r = await docRun([vac({ stand_in_id: "e-mgr", options: { notAssignable: true, standIn: true } }), vac({ id: "v2", employee_id: "e-mgr", options: { notAssignable: true } })], { n1: assign(U_OWN) });
    eq(r.log, ["n1:skipped:on vacation"], "doc assign: the stand-in is away too → skipped");
    r = await docRun([vac({ stand_in_id: "e-old", options: { notAssignable: true, standIn: true } })], { n1: assign(U_OWN) });
    eq(r.log, ["n1:skipped:on vacation"], "doc assign: an inactive stand-in → skipped");
    r = await docRun([vac({ stand_in_id: "e-mgr", options: { noNotify: true, standIn: true } })], { n1: assign(U_OWN) });
    eq([r.log, r.db.T.contacts[0].assigned_user_id], [["n1:executed"], U_OWN], "doc assign: away but assignable (only 'No notifications') → assigned as picked");
    eq([vacAssignUser("x", { day: "2026-10-14", tz: "Australia/Sydney", vacs: [], employees: [], profiles: [] }), vacAssignUser("u-nobody", { day: "2026-10-14", tz: "Australia/Sydney", vacs: [vac({ options: { notAssignable: true } })], employees: EMPS, profiles: PROFS })],
      [{ user: "x" }, { user: "u-nobody" }], "vacAssignUser: nobody away, or a login without an employee card → as picked");
    // one read a tick: three people actions, and the copies of the tick's context share it (vacBox)
    r = await docRun([away()], { n1: push({ roles: ["owner"] }, "x", "n2"), n2: task(["e-cal"], {}, "n3"), n3: assign(U_OWN) });
    eq([r.log, r.db.calls.filter((c: string) => c === "employee_vacations.select").length], [["n1:sent", "n2:executed", "n3:executed"], 1], "doc: vacations read once for a push, a task and an assign");
    {
      const db = worldOf([away()]), L: any = await loadContext(db, NOW), TS: any = { ...L, S: { ...L.S, email_signer: "Sam" } }, T2: any = { ...L, autos: new Map() };
      const c1 = await vacOf(db, TS, NOW), c2 = await vacOf(db, T2, NOW), c3 = await vacOf(db, L, NOW);
      eq([db.calls.filter((c: string) => c === "employee_vacations.select").length, c1 === c2 && c2 === c3, c1.vacs.length], [1, true, 1], "vacOf: one read shared by the context's copies (a run's TS, a dry run's T2)");
      eq([vacOnDayOf(c1, NOW) === c1, vacOnDayOf(c1, NOW + 7 * DAYMS).day, vacOnDayOf(c1, NOW + 7 * DAYMS).vacs === c1.vacs], [true, "2026-10-21", true], "vacOnDayOf: the same read, on the day of the moment");
    }
    // the dry run says the same, on the day of its clock
    const rin = { record_kind: "contact", record_id: "c1", contact_id: "c1", event_type: "newLead", event_at: isoMs(NOW), trigger_id: "t1", context: {} };
    const dry = async (vacs: any[], A: any) => { const db = worldOf(vacs, [A]); sent.length = 0; const d: any = await dryRunV2(db, A, rin, ctxOf(db), NOW); return { d, acts: d.path.filter((x: any) => x.rowKind === "action").map((x: any) => `${x.stepId}:${x.status}${x.reason ? ":" + x.reason : ""}${x.to ? ">" + x.to : ""}`) }; };
    const later = (n2: any) => flowOf({ n1: { kind: "wait", type: "period", config: { n: 7, unit: "days" }, out: { next: "n2" } }, n2 });
    eq([(await dry([vac()], flowOf({ n1: push({ roles: ["owner"] }) }))).acts, (await dry([standIn("e-mgr")], flowOf({ n1: push({ roles: ["owner", "manager"] }) }))).acts],
      [["n1:skipped:on vacation"], ["n1:would>Max Manager"]], "dry run (doc): skipped 'on vacation' / the stand-in, as a real run");
    eq([(await dry([vac()], later(push({ roles: ["owner"] })))).acts, (await dry([vac({ starts_on: "2026-10-20", ends_on: "2026-10-23" })], later(push({ roles: ["owner"] })))).acts],
      [["n2:would>Olivia Owner, Olivia Owner"], ["n2:skipped:on vacation"]], "dry run (doc): the vacations of the day the action runs (after a 7-day wait), not today's (both of the owner's logins)");
    const dt = await dry([away()], flowOf({ n1: task(["e-cal"], { notes: "Ring" }, "n2"), n2: assign(U_OWN) }));
    const pt = dt.d.path.find((x: any) => x.stepId === "n1").preview;
    eq([pt.assignees, pt.board, pt.notes, dt.acts[1]], [["Vicky Va"], "ron", "For Cal Tech (on vacation): given to Vicky Va, the stand-in.\n\nRing", "n2:would"], "dry run (doc): the task's stand-in, board and line; an assignable person is assigned");
    const dv1 = await dry([vac()], auto({ id: "a39-v1", steps: [{ id: "p1", kind: "action", type: "push", to: { roles: ["owner"] }, title: "x" }, { id: "t1", kind: "action", type: "task", title: "Call", assignees: ["e-cal"], due_days: 1, notes: "Ring" }] }));
    eq(dv1.acts, ["p1:skipped:on vacation", "t1:would>Cal Tech"], "dry run (a phase-4 row, previewAction): the push skipped 'on vacation'; the task stays with someone who is assignable");
    const dv2 = await dry([away()], auto({ id: "a39-v2", steps: [{ id: "t1", kind: "action", type: "task", title: "Call", assignees: ["e-cal"], due_days: 1, notes: "Ring" }] }));
    eq([dv2.acts, dv2.d.path[0].preview.notes], [["t1:would>Vicky Va"], "For Cal Tech (on vacation): given to Vicky Va, the stand-in.\n\nRing"], "dry run (a phase-4 row): the task's stand-in and its line");
  }

  // ── 40. Workflow AI's steps (stage 7 A, .claude/plans/stage7-spec.md §2.1): "patch" applies edits to the stored doc and
  //        checks the result with ZERO writes (409 stale, 422 with opIndex, the outline read); "validate" with generate
  //        also checks the generation schema, and without it answers as before on every workflows.json case ──
  {
    const api = (db: any, step: string, body: any = {}, me: any = OWNER) => handle(db, { step, ...body }, me, false);
    const P = JSON.parse(src("fixtures/patch.json")).cases, W = JSON.parse(src("fixtures/workflows.json")).cases;
    const ID40 = "a40-0000-0000";
    const p0 = P.find((k: any) => k.name === "add a step at the end");
    const row40 = (o: any = {}) => auto({ id: ID40, name: "Lead alert", enabled: false, revision: 3, settings: {}, layout: { v: 1 }, builder: "standard", origin: "user", list_summary: {}, deleted_at: null, definition: JSON.parse(JSON.stringify(p0.doc)), ...o });
    const writes = (db: any) => db.calls.filter((c: string) => !/\.select$/.test(c));
    ok(WF_API_STEPS.includes("patch") && WF_PATCH_MAX_OPS === 60, "the API has a 'patch' step (at most 60 edits a call)");

    // patch: the edits applied and checked, nothing written
    {
      const db = world({ automations: [row40()], automation_versions: [] });
      db.calls.length = 0;
      const r = await api(db, "patch", { automation_id: ID40, base_revision: 3, ops: p0.ops });
      eq([r.status, r.body.ok, canonJson(r.body.definition) === canonJson(p0.result), r.body.idMap, r.body.changedIds, r.body.idsRemoved, r.body.shapeChanged, r.body.willDraft, r.body.revision, r.body.errors],
        [200, true, true, p0.idMap, ["n3", "n4"], [], true, false, 3, []], "patch: the edits on the stored doc (= patch.json), the ids added or changed, what a save would change");
      eq([writes(db), db.T.automations[0].revision, canonJson(db.T.automations[0].definition) === canonJson(p0.doc), db.T.automation_versions.length], [[], 3, true, 0], "patch: zero writes (no save, no snapshot, no revision bump)");
      db.T.automations[0].enabled = true;
      const ai = await api(db, "patch", { automation_id: ID40, base_revision: 3, ops: [{ op: "setNode", id: "n2", patch: { config: { title: "Lead: {name}" } } }], ai_edited: true });
      db.T.automations[0].enabled = false;
      eq([ai.body.willDraft, ai.body.changedIds, ai.body.shapeChanged], [true, ["n2"], false], "patch with ai_edited on a Published workflow: a save would be a Draft; words only = the same shape");
      const st = await api(db, "patch", { automation_id: ID40, base_revision: 2, ops: p0.ops });
      eq([st.status, st.body.reason, st.body.revision], [409, "conflict", 3], "patch at an old revision → 409 conflict (as save)");
      const bad = await api(db, "patch", { automation_id: ID40, base_revision: 3, ops: [p0.ops[0], { op: "setNode", id: "n99", patch: {} }] });
      eq([bad.status, bad.body.reason, bad.body.errors.length > 0 && bad.body.errors.every((e: any) => e.opIndex === 1)], [422, "errors", true], "patch: an edit that doesn't apply → 422 with its opIndex");
      const chk = await api(db, "patch", { automation_id: ID40, base_revision: 3, ops: [{ op: "setNode", id: "n1", patch: { config: { n: -5 } } }] });
      ok(chk.status === 200 && chk.body.errors.length > 0, "patch: a result that doesn't validate → 200 with its errors (as validate)", chk.body.errors);
      const o = await api(db, "patch", { automation_id: ID40, ops: [], outline: true });
      eq([o.status, o.body.revision, o.body.name, o.body.enabled, o.body.outline.entry, o.body.outline.nodes.map((n: any) => n.id), o.body.outline.triggers[0].type, "definition" in o.body],
        [200, 3, "Lead alert", false, "n1", ["n1", "n2", "n3"], "newLead", false], "patch outline: the stored doc's outline and revision (Workflow AI's read), no definition");
      eq([(await api(db, "patch", { automation_id: "a40-none", base_revision: 3, ops: [] })).status, (await api(db, "patch", { automation_id: ID40, ops: [] })).status,
        (await api(db, "patch", { automation_id: ID40, base_revision: 3, ops: Array.from({ length: 61 }, () => ({ op: "rename", name: "x" })) })).status, (await api(db, "patch", { automation_id: ID40, base_revision: 3, ops: [] }, VA)).status],
        [404, 400, 400, 403], "patch: not found 404, no base_revision 400, over 60 edits 400, not an owner or manager 403");
      eq(writes(db), [], "patch: still zero writes after every call");
      const db4 = world({ automations: [auto({ id: "a40-v1", revision: 1, deleted_at: null })], automation_versions: [] });
      db4.calls.length = 0;
      eq([(await api(db4, "patch", { automation_id: "a40-v1", ops: [], outline: true })).status, writes(db4)], [409, []], "patch on a phase-4 row (never upgraded): 409, and it doesn't upgrade it (no write)");
      // a write attempt inside patch is an error, never a write (readOnlySb)
      let threw = "";
      try { await readOnlySb(db).from("automations").update({ name: "x" }); } catch (x) { threw = (x as Error).name; }
      eq(threw, "SimulationWriteError", "patch runs on readOnlySb: a write would throw");
    }

    // validate: without generate, the same answer as before on every workflows.json case; with it, only E_SCHEMA added
    {
      const db = world({ automations: [], automation_versions: [] });
      const C40 = await apiCtx(db);
      let same = 0, superset = 0;
      for (const k of W) {
        const a = await api(db, "validate", { definition: k.doc, builder: k.builder }), b = await api(db, "validate", { definition: k.doc, builder: k.builder, generate: false });
        const g = await api(db, "validate", { definition: k.doc, builder: k.builder, generate: true });
        if (a.status !== 200) { if (JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(a) === JSON.stringify(g)) { same++; superset++; } else ok(false, `validate (not a doc): ${k.name}`, [a, g]); continue; }
        const want = wfCheck(k.doc, {}, {}, C40, null, builderOf(k.builder, null));
        if (a.status === 200 && JSON.stringify(a.body) === JSON.stringify(b.body) && canonJson(a.body.errors) === canonJson(want.errors) && canonJson(a.body.warnings) === canonJson(want.warnings)) same++;
        else ok(false, `validate without generate: ${k.name}`, [a.body.errors, want.errors]);
        const extra = g.body.errors.slice(a.body.errors.length);
        if (canonJson(g.body.errors.slice(0, a.body.errors.length)) === canonJson(a.body.errors) && extra.every((e: any) => e.code === "E_SCHEMA" && typeof e.path === "string")) superset++;
        else ok(false, `validate with generate adds only E_SCHEMA: ${k.name}`, extra.slice(0, 3));
      }
      ok(W.length >= 60 && same === W.length && superset === W.length, `validate: without generate as before on all ${W.length} cases; generate adds only E_SCHEMA issues`);
      const legacy = W.find((k: any) => k.name === "upgrade-3: the generation schema has no legacy gate");
      const [lo, lg] = [await api(db, "validate", { definition: legacy.doc }), await api(db, "validate", { definition: legacy.doc, generate: true })];
      eq([lo.body.errors.some((e: any) => e.code === "E_SCHEMA"), lg.body.errors.some((e: any) => e.code === "E_SCHEMA" && e.path.startsWith("/definition"))], [false, true], "generate: the legacy gate is refused (E_SCHEMA with a JSON pointer), accepted without");
      const sms = { schema: 2, seq: 2, entry: "n1", triggers: [{ id: "t1", type: "newLead", filters: { match: "all", segments: [{ match: "all", rules: [] }] } }], nodes: { n1: { kind: "action", type: "send_sms", config: { body: "Hi {first_name}" }, out: { next: null } } } };
      const gs = await api(db, "validate", { definition: sms, generate: true });
      eq([gs.body.errors.some((e: any) => e.code === "E_UNAVAILABLE"), gs.body.errors.some((e: any) => e.code === "E_SCHEMA")], [true, true], "generate: a greyed type (SMS without a phone line) → E_UNAVAILABLE and E_SCHEMA");
    }

    // wfOutline (pure): ids, types, labels, names, the filters in words (catalog names), the required / narrated config
    {
      const d = { schema: 2, seq: 5, entry: "n1", triggers: [{ id: "t1", type: "stage", name: "To Quoted", filters: { match: "all", segments: [{ match: "all", rules: [{ field: "stage", op: "is", v: "Quoted" }] }] } }],
        nodes: { n1: { kind: "wait", type: "period", name: "Wait", config: { n: 2, unit: "days" }, out: { next: "n2" } },
          n2: { kind: "action", type: "send_email", config: { subject: "Hi", body: "x".repeat(400), fromName: "Office" }, out: { next: null } } } };
      const o: any = wfOutline(d, { stages: [{ key: "Quoted", label: "Quote sent" }] });
      eq([o.entry, o.triggers[0].id, o.triggers[0].type, o.triggers[0].name, o.triggers[0].filters, o.nodes.map((n: any) => [n.id, n.kind, n.type, n.out.next ?? null])],
        ["n1", "t1", "stage", "To Quoted", "stage is Quote sent (Quoted)", [["n1", "wait", "period", "n2"], ["n2", "action", "send_email", null]]], "wfOutline: the trigger's filters in words with the catalog's names; the steps with their ports");
      ok(o.nodes[1].config.body.length <= 160 && o.nodes[1].config.subject === "Hi" && typeof o.nodes[1].label === "string" && o.nodes[1].label.length > 0, "wfOutline: config text clipped to 160 characters; the registry's label", o.nodes[1]);
      eq(wfOutline({ triggers: [], nodes: {} }), { entry: null, triggers: [], nodes: [] }, "wfOutline: an empty doc");
      const hk = (url: string) => wfOutline({ schema: 2, seq: 1, entry: "n1", triggers: [], nodes: { n1: { kind: "action", type: "webhook", config: { url, method: "POST" }, out: { next: null } } } });
      const ho: any = hk("https://hooks.slack.com/services/T000/B000/s3cr3tToken?api_key=k123");
      eq([ho.nodes[0].config.url, JSON.stringify(ho).includes("s3cr3t"), JSON.stringify(ho).includes("k123"), (hk("not a url") as any).nodes[0].config.url], ["hooks.slack.com", false, false, "another system"],
        "wfOutline: a webhook's url only by its host (its path and query never reach the AI)");
    }

    // patch: the other things a save would change (a trigger taken away, the settings, the first step); restore with
    // expected_revision; a new workflow the AI made is saved with version reason "ai"
    {
      const db = world({ automations: [row40({ definition: { ...JSON.parse(JSON.stringify(p0.doc)), triggers: [...JSON.parse(JSON.stringify(p0.doc.triggers)), { id: "t9", type: "newLead", filters: { match: "all", segments: [{ match: "all", rules: [] }] } }] } })], automation_versions: [] });
      const pt = await api(db, "patch", { automation_id: ID40, base_revision: 3, ops: [{ op: "removeTrigger", id: "t9" }], ai_edited: true });
      eq([pt.status, pt.body.changedIds, pt.body.idsRemoved, pt.body.triggersRemoved, pt.body.settingsChanged, pt.body.entryChanged], [200, [], [], ["t9"], [], false], "patch: a trigger taken away is listed (triggersRemoved)");
      const ps = await api(db, "patch", { automation_id: ID40, base_revision: 3, ops: [{ op: "setSettings", patch: { stopOnResponse: true } }], ai_edited: true });
      eq([ps.status, ps.body.changedIds, ps.body.triggersRemoved, ps.body.settingsChanged, ps.body.entryChanged], [200, [], [], ["stopOnResponse"], false], "patch: a settings-only edit lists the settings it changes");
      const pn = await api(db, "patch", { automation_id: ID40, base_revision: 3, ops: [{ op: "rename", name: "Other" }] });
      eq([pn.body.settingsChanged, pn.body.entryChanged, pn.body.triggersRemoved], [[], false, []], "patch: a rename changes neither the settings nor the first step");
      const dbs = world({ contacts: [], automations: [], automation_versions: [], automation_templates: [] });
      const sv = await api(dbs, "save", { automation_id: null, name: "Welcome", definition: JSON.parse(JSON.stringify(p0.doc)), settings: {}, ai_edited: true });
      eq([sv.status, sv.body.enabled, dbs.T.automations[0].origin, dbs.T.automation_versions[0].reason], [200, false, "ai", "ai"], "save: a new workflow the AI made is a Draft, origin ai, version reason ai");
      const s2 = await api(dbs, "save", { automation_id: sv.body.id, expected_revision: sv.body.revision, name: "Welcome 2", definition: JSON.parse(JSON.stringify(p0.result)), settings: {} });
      const rs = await api(dbs, "restore", { automation_id: sv.body.id, version_no: 1, expected_revision: s2.body.revision - 1 });
      const rok = await api(dbs, "restore", { automation_id: sv.body.id, version_no: 1, expected_revision: s2.body.revision });
      eq([s2.status, rs.status, rs.body.reason, rok.status], [200, 409, "conflict", 200], "restore with expected_revision: saved since → 409 (nothing overwritten); the current one → restored");
    }
  }

  // ── 41. G6.1 (design §3.14, §3.15, §4.9, §7 G6.1, §10 Q2 / Q7): step "test" (zero writes; every "would" kind; the
  //        trigger's verdict and the guard verdicts; assume), Add to workflow (record_runs + the enrollable list, enroll,
  //        unenroll; the role matrix per Q2; re-entry; a double click = one run; wrong_kind; busy) and the daily error
  //        digest (one phone alert a day at most, Q7) ──
  {
    io.advance = PROD_ADVANCE;
    const NONE = { match: "all", segments: [{ match: "all", rules: [] }] };
    const F1 = (rules: any[]) => ({ match: "all", segments: [{ match: "all", rules }] });
    const tr = [{ id: "t1", type: "newLead", filters: NONE }];
    let wn = 0;
    const flowOf = (nodes: any, o: any = {}) => ({ id: `w40-${String(++wn).padStart(4, "0")}`, business_id: "default", name: o.name || "Flow " + wn, enabled: true, armed_at: "2026-10-01T00:00:00.000Z",
      version: 1, revision: 1, created_by_name: "Olivia Owner", trigger: {}, steps: [], definition: { schema: 2, seq: 30, entry: Object.keys(nodes)[0], triggers: o.triggers || tr, nodes },
      settings: { reentry: "off", perRecord: true, ...(o.settings || {}) }, deleted_at: null, ...(o.row || {}) });
    const push = (title: string, next: string | null = null) => ({ kind: "action", type: "internal_notification", config: { channel: "push", to: { roles: ["owner"] }, title }, out: { next } });
    const mail = (next: string | null = null) => ({ kind: "action", type: "send_email", config: { subject: "Hello {first_name}", body: "{hi}, thanks." }, out: { next } });
    const V2 = { business_id: "default", tick_lease_until: null, pruned_on: null, phase4_compat: false, error_notice_at: null };
    const W = (over: Record<string, any[]> = {}) => world({ automation_state: [{ ...V2 }], contacts: [lead("c1"), lead("c2", { tags: ["test"], email: "tess@example.com", phone: "0412 000 111" })], ...over });
    const writes = (db: any) => db.calls.filter((c: string) => /\.(insert|update|upsert|delete)$|^rpc:/.test(c));

    // ── test: every would kind in one fixture, nothing written, nothing sent, no network ──
    const ALL = flowOf({
      n1: { kind: "if_else", type: "if_else", config: { branches: [{ id: "b1", name: "Has email", when: F1([{ field: "has_email", op: "true" }]) }], noneName: "Other" }, out: { b1: "n3", none: "n9" } },
      n3: mail("n4"), n4: mail("n5"),
      n5: { kind: "wait", type: "reply", config: { channels: ["email"], timeout: { n: 2, unit: "days" } }, out: { next: "n8", timeout: "n6" } },
      n6: { kind: "goal", type: "stage_reached", config: { stages: ["Booked"], ifNotMet: "continue" }, out: { next: "n7" } },
      n7: { kind: "goto", type: "goto", config: { target: "n8" }, out: {} },
      n8: { kind: "workflow", type: "remove_from_workflow", config: { scope: "current" }, out: {} },
      n9: push("never"),
    }, { name: "Every kind" });
    {
      const db = W({ automations: [ALL] }), before = JSON.stringify(db.T), f0 = fetchCalls;
      sent.length = 0;
      const r: any = await handle(db, { step: "test", automation_id: ALL.id, definition: ALL.definition, settings: ALL.settings, record: { kind: "contact", id: "c1" }, assume: { n5: "timeout" } }, MANAGER, false);
      const b = r.body, kinds = b.path.map((x: any) => `${x.stepId}:${x.would}${x.branchId ? ":" + x.branchId : ""}${x.outcome ? ":" + x.outcome : ""}${x.guard ? ":" + x.guard : ""}${x.target ? ">" + x.target : ""}`);
      eq([r.status, b.ok, b.trigger.matched, b.ended], [200, true, true, "removed"], "test: the draft runs for the lead (manager); the trigger matches; the path ends where Remove from workflow ends it");
      eq(kinds, ["n1:branch:b1", "n3:execute", "n4:skip:cap", "n5:wait:timeout:timeout", "n6:goal:not_met", "n7:goto>n8", "n8:execute", "n8:stop", "n9:not_reached"],
        "test: branch, execute, skip (the daily cap guard: the path goes on), wait (assumed timeout), goal, go to, stop, not reached");
      eq([...new Set(b.path.map((x: any) => x.would))].sort(), [...WF_TEST_WOULD].sort(), "test: every would kind of WF_TEST_WOULD comes out of the fixture");
      eq([b.path[1].preview.subject, b.path[3].until > b.path[3].at, b.notes[0]], ["Hello Sam", true, "Test result: nothing was sent"], "test: the filled message; the wait's until after its start; the note");
      eq([JSON.stringify(db.T) === before, writes(db), sent.length, fetchCalls - f0], [true, [], 0, 0], "test: ZERO writes (the database byte-identical, no write call, no RPC), nothing sent, no network");
      // no assumption: a reply wait with a timeout takes its timeout; a reply already there counts; told "met" → Replied
      const r2: any = await handle(db, { step: "test", definition: ALL.definition, settings: ALL.settings, record: { kind: "contact", id: "c1" }, assume: { n5: "met" } }, OWNER, false);
      eq([r2.body.path.find((x: any) => x.stepId === "n5").branchId, r2.body.path.filter((x: any) => x.would === "not_reached").map((x: any) => x.stepId), r2.body.notes.includes("Tested as if published")],
        ["next", ["n6", "n7", "n9"], true], "test: an unsaved draft (no automation_id) as if published; assumed met → the Replied branch, the timeout side not reached");
      const db2 = W({ automations: [ALL], lead_messages: [{ id: "m1", contact_id: "c1", direction: "in", channel: "email", body: "yes", created_at: isoMs(NOW - MIN), at: isoMs(NOW - MIN) }] });
      const r3: any = await handle(db2, { step: "test", definition: ALL.definition, settings: ALL.settings, record: { kind: "contact", id: "c1" }, assume: { n5: "timeout", n6: "met" } }, OWNER, false);
      eq([r3.body.path.find((x: any) => x.stepId === "n5").branchId, r3.body.path.find((x: any) => x.stepId === "n6").outcome], ["timeout", "met"], "test: assume wins (timeout over a reply already there; a goal assumed met)");
      // a test record: the trigger does not match (said, with the reason) and the path goes on as if it did; its emails show the guard
      const r4: any = await handle(db, { step: "test", definition: ALL.definition, settings: ALL.settings, record: { kind: "contact", id: "c2" } }, OWNER, false);
      eq([r4.body.ok, r4.body.trigger.matched, r4.body.trigger.reason, r4.body.path.find((x: any) => x.stepId === "n3").guard, r4.body.notes.some((n: string) => n.startsWith("The trigger would not start it"))], [true, false, "test_record", "test_record", true],
        "test: a test record → trigger.matched false + reason, the path goes on, the email's guard says test_record");
      // a filter the lead fails
      const Fl = flowOf({ n1: push("x") }, { triggers: [{ id: "t1", type: "newLead", filters: F1([{ field: "has_tag", op: "includes", value: ["VIP"] }]) }] });
      const r5: any = await handle(db, { step: "test", definition: Fl.definition, settings: Fl.settings, record: { kind: "contact", id: "c1" } }, OWNER, false);
      eq([r5.body.trigger.matched, String(r5.body.trigger.reason).startsWith("filter:"), r5.body.path.map((x: any) => x.would)], [false, true, ["execute"]], "test: a filter not matched → said, the path still shown");
      // outside the customer hours (06:00–07:00 Sydney; now 14:00): the email's guard says customer_hours and until when, the path goes on then
      const Hm = flowOf({ n1: mail("n2"), n2: push("after") });
      const hdb = W({ automations: [Hm], automation_settings: [{ business_id: "default", customer_from: "06:00", customer_until: "07:00" }] }), hb = JSON.stringify(hdb.T);
      const r6: any = await handle(hdb, { step: "test", definition: Hm.definition, settings: Hm.settings, record: { kind: "contact", id: "c1" } }, OWNER, false);
      eq([r6.body.ok, r6.body.path.map((x: any) => `${x.stepId}:${x.would}${x.guard ? ":" + x.guard : ""}`), r6.body.path[0].until, JSON.stringify(hdb.T) === hb, writes(hdb)],
        [true, ["n1:execute:customer_hours", "n2:execute"], "2026-10-14T19:00:00.000Z", true, []], "test: the customer hours guard (held until 06:00 the next day), the path goes on; nothing written");
      // who, and what is refused
      const T = (me: any, o: any = {}) => handle(db, { step: "test", definition: ALL.definition, settings: ALL.settings, record: { kind: "contact", id: "c1" }, ...o }, me, false);
      eq([(await T(VA)).status, (await T(TECH)).status, (await T(OWNER, { assume: { n5: "maybe" } })).status, (await T(OWNER, { record: { kind: "task", id: "x" } })).status, (await T(OWNER, { record: null })).status,
        (await T(OWNER, { trigger_id: "t9" })).status], [403, 403, 422, 422, 422, 422], "test: owners and managers only; a bad assume / record kind / no record / unknown trigger refused");
      const bad = await T(OWNER, { definition: { schema: 2, seq: 1, entry: "n1", triggers: tr, nodes: { n1: { kind: "action", type: "fax_it", config: {}, out: { next: null } } } } });
      eq([bad.status, bad.body.ok, bad.body.problems.length > 0], [200, false, true], "test: a draft with errors → ok:false with its problems, nothing run");
      eq([JSON.stringify(db.T) === before, writes(db), sent.length], [true, [], 0], "test: still nothing written or sent after every call above");
    }

    // ── Add to workflow ──
    const OK = flowOf({ n1: { kind: "wait", type: "period", config: { n: 1, unit: "days" }, out: { next: "n2" } }, n2: push("Added {name}") }, { name: "Nurture" });
    const AGAIN = flowOf({ n1: { kind: "wait", type: "period", config: { n: 1, unit: "days" }, out: { next: "n2" } }, n2: push("Again") }, { name: "Again", settings: { reentry: "after_exit" } });
    const DRAFT = flowOf({ n1: push("x") }, { name: "Draft one", row: { enabled: false, armed_at: null } });
    const JOB = flowOf({ n1: push("x") }, { name: "Job one", triggers: [{ id: "t1", type: "jobClosed", filters: NONE }] });
    const MERGE = flowOf({ n1: push("Tech {technician}") }, { name: "Merge one", triggers: [{ id: "t1", type: "newLead", filters: NONE }, { id: "t2", type: "jobClosed", filters: NONE }] });
    {
      const db = W({ automations: [OK, AGAIN, DRAFT, JOB, MERGE] });
      const E = (me: any, o: any = {}) => handle(db, { step: "enroll", automation_id: OK.id, record: { kind: "contact", id: "c1" }, request_id: "req-00000001", ...o }, me, false);
      const runs = () => db.T.automation_runs.filter((r: any) => r.automation_id === OK.id);
      eq([(await E(VA)).status, (await E(TECH)).status, (await E(VA_NOCRM)).status, runs().length], [403, 403, 403, 0], "enroll (Q2): a VA or a technician cannot add a lead");
      const e1: any = await E(OWNER), e2: any = await E(OWNER);
      eq([e1.status, e1.body.ok, e2.status, e2.body.again, e2.body.run_id === e1.body.run_id, runs().length], [200, true, 200, true, true, 1], "enroll: a double click (the same request id) = one run");
      const r = runs()[0];
      eq([r.status, r.source, r.trigger_id, r.event_key, r.cursor_step, r.due_at, r.context, r.event_type], ["waiting", "manual", null, "manual:req-00000001", "n1", isoMs(NOW), { manual: true, by: "u-owner", byName: "Olivia Owner" }, "manual"],
        "enroll: source manual, no trigger, at the workflow's start, due now, who added it in the context");
      ok(db.T.automation_log.some((l: any) => l.run_id === r.id && l.row_kind === "enroll" && l.detail.source === "manual"), "enroll: the enroll log row says manual");
      const e3: any = await E(MANAGER, { request_id: "req-00000002" });
      eq([e3.status, e3.body.reason, runs().length], [409, "already_enrolled", 1], "enroll (manager): already in the workflow → refused, no second run");
      r.status = "done"; r.active_lock = null;
      const e4: any = await E(OWNER, { request_id: "req-00000003" });
      eq([e4.status, e4.body.reason], [409, "reentry_off"], "enroll: re-entry off → once only");
      const A1: any = await handle(db, { step: "enroll", automation_id: AGAIN.id, record: { kind: "contact", id: "c1" }, request_id: "req-a0000001" }, OWNER, false);
      db.T.automation_runs.find((x: any) => x.id === A1.body.run_id).status = "done";
      db.T.automation_runs.find((x: any) => x.id === A1.body.run_id).active_lock = null;
      const A2: any = await handle(db, { step: "enroll", automation_id: AGAIN.id, record: { kind: "contact", id: "c1" }, request_id: "req-a0000002" }, OWNER, false);
      eq([A1.status, A2.status, A2.body.run_id !== A1.body.run_id], [200, 200, true], "enroll: re-entry after exit → in again once the first run ended");
      const later: any = await E(OWNER, { automation_id: AGAIN.id, request_id: "req-a0000003", start_at: isoMs(NOW + 2 * DAYMS) });
      eq([later.status, later.body.reason], [409, "already_enrolled"], "enroll: the active lock holds a second run while one waits");
      db.T.automation_runs.filter((x: any) => x.automation_id === AGAIN.id).forEach((x: any) => { x.status = "done"; x.active_lock = null; });
      const at: any = await E(OWNER, { automation_id: AGAIN.id, request_id: "req-a0000004", start_at: isoMs(NOW + 2 * DAYMS) });
      eq([at.status, at.body.due_at, db.T.automation_runs.find((x: any) => x.id === at.body.run_id).due_at], [200, isoMs(NOW + 2 * DAYMS), isoMs(NOW + 2 * DAYMS)], "enroll: 'At a date and time' → due then");
      const refused = async (o: any) => { const x: any = await E(OWNER, o); return `${x.status}:${x.body.reason}`; };
      eq([await refused({ request_id: "req-b1", automation_id: OK.id }), await refused({ request_id: "req-b0000001", record: { kind: "job", id: "j1" } }), await refused({ request_id: "req-b0000002", automation_id: JOB.id }),
        await refused({ request_id: "req-b0000003", automation_id: DRAFT.id }), await refused({ request_id: "req-b0000004", automation_id: MERGE.id }), await refused({ request_id: "req-b0000005", record: { kind: "contact", id: "c2" } }),
        await refused({ request_id: "req-b0000006", record: { kind: "contact", id: "c404" } }), await refused({ request_id: "req-b0000007", start_at: isoMs(NOW + 31 * DAYMS) }), await refused({ request_id: "req-b0000008", automation_id: "w-none" })],
        ["422:request_id", "409:wrong_kind", "409:wrong_kind", "409:draft", "409:merge", "409:test_record", "404:record", "422:start_at", "404:not_found"],
        "enroll refuses: a bad request id, a job record, a job-only workflow (wrong_kind), a Draft, a lead-less blank, a test record, a gone lead, > 30 days, a gone workflow");
      const cdb = world({ contacts: [lead("c1")], automations: [OK] });
      eq((await handle(cdb, { step: "enroll", automation_id: OK.id, record: { kind: "contact", id: "c1" }, request_id: "req-c0000001" }, OWNER, false)).body.reason, "not_ready", "enroll: not before the event store (compat mode)");

      // record_runs: the lead's runs for the office; the enrollable list (with the greyed reasons) for owners and managers
      const rr: any = await handle(db, { step: "record_runs", record: { kind: "contact", id: "c1" } }, OWNER, false);
      const why = Object.fromEntries(rr.body.enrollable.map((x: any) => [x.name, x.why]));
      eq([rr.status, rr.body.canAdd, rr.body.runs.length, rr.body.runs.find((x: any) => x.id === r.id).by, rr.body.runs.find((x: any) => x.id === r.id).name],
        [200, true, 4, "Olivia Owner", "Nurture"], "record_runs: the lead's runs, who added them, the workflow's name");
      eq(why, { "Again": null, "Draft one": "Publish it first", "Job one": "Starts from a job, not a lead", "Merge one": "Uses details only its trigger has (e.g. {technician})", "Nurture": null },
        "record_runs: the picker's greyed reasons (Draft, job-only, a blank only its trigger has)");
      // a saved template's blanks count as the step's own: one with job-only blanks is greyed (it would be sent with them blank)
      const TPL = flowOf({ n1: { kind: "action", type: "send_email", config: { subject: "Thanks", templateKey: "my_job12345" }, out: { next: null } } }, { name: "Template one" });
      const tcat = (t: string) => ({ templates: { my_job12345: t } }), mw = (t: string) => { const x = wfManualWhy(wfRunRow(TPL), tcat(t)); return x ? x.code : null; };
      eq([mw("Hi {first_name}, {technician} will see you on {job_date}."), mw("Hi {first_name}, see you soon.")], ["merge", null],
        "enroll: a saved template with job-only blanks ({technician}, {job_date}) → merge, as the same words typed in; a lead-only one → fine");
      const rv: any = await handle(db, { step: "record_runs", record: { kind: "contact", id: "c1" } }, VA, false);
      eq([rv.status, rv.body.canAdd, rv.body.enrollable, rv.body.runs.length], [200, false, [], 4], "record_runs: a VA with CRM access sees the lead's runs, cannot add (Q2)");
      eq([(await handle(db, { step: "record_runs", record: { kind: "contact", id: "c1" } }, VA_NOCRM, false)).status, (await handle(db, { step: "record_runs", record: { kind: "contact", id: "c1" } }, TECH, false)).status,
        (await handle(db, { step: "record_runs", record: { kind: "task", id: "c1" } }, OWNER, false)).status], [403, 403, 422], "record_runs: no CRM access or a technician → 403; a task record → 422");

      // unenroll: a waiting run ends removed "Removed by <name>"; a moving one is busy; an ended one is not active; Q2
      const wait1 = db.T.automation_runs.find((x: any) => x.id === at.body.run_id);
      const U = (me: any, id: string) => handle(db, { step: "unenroll", run_id: id }, me, false);
      eq([(await U(VA, wait1.id)).status, (await U(TECH, wait1.id)).status, wait1.status], [403, 403, "waiting"], "unenroll (Q2): a VA or a technician cannot remove");
      wait1.status = "running";
      const busy: any = await U(OWNER, wait1.id);
      eq([busy.status, busy.body.reason, wait1.status], [409, "busy", "running"], "unenroll: a run moving right now → busy, untouched");
      wait1.status = "waiting";
      const u1: any = await U(MANAGER, wait1.id), u2: any = await U(MANAGER, wait1.id);
      eq([u1.status, wait1.status, wait1.reason, wait1.exit_reason, wait1.active_lock, u2.status, u2.body.reason, (await U(OWNER, "r-none")).status], [200, "removed", "Removed by Max Manager", "removed_by_user", null, 409, "not_active", 404],
        "unenroll: removed by the manager (its lock given back); again → not_active; unknown → 404");
      ok(db.T.automation_log.some((l: any) => l.run_id === wait1.id && l.row_kind === "exit" && l.status === "removed" && l.reason === "Removed by Max Manager"), "unenroll: one exit row with who removed it");
    }

    // ── the error digest ──
    {
      eq([wfDigestPeople({ users: ["u-mgr", "u-va"] }, [OWNER, MANAGER, VA]), wfDigestPeople({ users: ["u-va"] }, [OWNER, MANAGER, VA]), wfDigestPeople({}, [OWNER, MANAGER]), wfDigestPeople({ users: [] }, [MANAGER])],
        [["u-mgr"], ["u-owner"], ["u-owner"], []], "digest: the chosen people still owners / managers, else the owners");
      eq(wfDigestText([{ name: "A", runs: 2 }, { name: "B", runs: 1 }, { name: "C", runs: 1 }, { name: "D", runs: 1 }]).body, "5 runs failed in 4 workflows: A, B, C and 1 more. Open Automation → Needs review.", "digest: the words");
      const fail = (id: string, run: string, name: string, at: number) => ({ id, business_id: "default", run_id: run, step_id: "n1", row_kind: "action", status: "failed", automation_id: name === "A" ? "wa" : "wb", automation_name: name, at: isoMs(at) });
      const db = W({ automation_log: [fail("l1", "r1", "A", NOW - HR), fail("l2", "r1", "A", NOW - HR), fail("l3", "r2", "B", NOW - 2 * HR), fail("l4", "r3", "A", NOW - 3 * HR), fail("l0", "r0", "Old", NOW - 8 * DAYMS)] });
      sent.length = 0;
      const d1: any = await errorDigest(db, NOW);
      eq([d1.sent, d1.failed, sent.map((x) => [x.to, x.msg.title, x.msg.body, x.msg.tag]), db.T.automation_state[0].error_notice_at],
        [true, [{ name: "A", runs: 2 }, { name: "B", runs: 1 }], [["https://push/owner", "Workflow errors", "3 runs failed in 2 workflows: A, B. Open Automation → Needs review.", "automation-errors"]], isoMs(NOW)],
        "digest: distinct failed runs of the last 7 days, to the owners (nothing chosen), stamped");
      ok(String(sent[0].msg.url).includes("listTab=review"), "digest: opens the Needs review list", sent[0].msg.url);
      db.T.automation_log.push(fail("l5", "r4", "B", NOW + HR));
      const d2: any = await errorDigest(db, NOW + 2 * HR), d3: any = await errorDigest(db, NOW + DAYMS + HR);
      eq([d2.why, d3.sent, d3.failed, sent.length], ["today", true, [{ name: "B", runs: 1 }], 2], "digest: once a day at most; the next one counts only what failed since the last");
      const d4: any = await errorDigest(db, NOW + 3 * DAYMS);
      eq([d4.why, sent.length], ["none", 2], "digest: nothing failed since → nothing sent");
      db.T.automation_settings[0].error_notify = { push: false, users: ["u-mgr"] };
      db.T.automation_log.push(fail("l6", "r5", "A", NOW + 3 * DAYMS + HR));
      eq([(await errorDigest(db, NOW + 4 * DAYMS)).why, sent.length], ["off", 2], "digest: the phone alert switched off → nothing sent");
      db.T.automation_settings[0].error_notify = { push: true, users: ["u-mgr"] };
      const d5: any = await errorDigest(db, NOW + 4 * DAYMS);
      eq([d5.sent, sent.slice(2).map((x) => x.to)], [true, ["https://push/mgr"]], "digest: to the chosen manager");
      // the tick sends it (event store on): one alert, then not again the same day
      const tdb = W({ automation_log: [fail("l1", "r1", "A", NOW - HR)] });
      sent.length = 0;
      await tickAt(tdb, NOW); await tickAt(tdb, NOW + 5 * MIN);
      eq([sent.filter((x) => x.msg.tag === "automation-errors").length, tdb.T.automation_state[0].error_notice_at], [1, isoMs(NOW)], "digest: the tick sends it once a day");
      // vacations (stage 3), as every push: away with "No notifications" → left out, a stand-in gets it, all the chosen away → the owners
      const vemps = [{ id: "e-own", name: "Olivia Owner", status: "Active" }, { id: "e-mgr", name: "Max Manager", status: "Active" }];
      const vac = (o: any = {}) => ({ id: "v1", business_id: "default", employee_id: "e-own", starts_on: "2026-10-13", ends_on: "2026-10-17", stand_in_id: null, options: { noNotify: true }, ended_at: null, cancelled_at: null, reminded_at: null, ...o });
      const vd = async (vacs: any[], notify: any = null) => {
        const v = W({ automation_log: [fail("l1", "r1", "A", NOW - HR)], employees: vemps, employee_vacations: vacs });
        if (notify) v.T.automation_settings[0].error_notify = notify;
        sent.length = 0; await errorDigest(v, NOW); return sent.filter((x) => x.msg.tag === "automation-errors").map((x) => x.to);
      };
      eq([await vd([]), await vd([vac()]), await vd([vac({ stand_in_id: "e-mgr", options: { noNotify: true, standIn: true } })]), await vd([vac({ employee_id: "e-mgr" })], { push: true, users: ["u-mgr"] })],
        [["https://push/owner"], [], ["https://push/mgr"], ["https://push/owner"]], "digest (stage 3): the owner away with No notifications → not to them; their stand-in manager gets it; the chosen manager away → the owners");
    }
  }

  console.log(`automations: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error("automations tests crashed:", e); process.exit(1); });
