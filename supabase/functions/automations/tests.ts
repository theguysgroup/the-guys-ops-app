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
  const m = /^([a-z_]+)\.(eq|gte|lte|lt|is)\.(.*)$/.exec(p);
  if (!m) throw new Error("fake or(): " + p);
  let v = m[3]; if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  const k = m[1], op = m[2];
  return (r: any) => op === "eq" ? r[k] != null && String(r[k]) === v : op === "is" ? (v === "null" && r[k] == null)
    : r[k] != null && (op === "gte" ? cmp(r[k], v) >= 0 : op === "lte" ? cmp(r[k], v) <= 0 : cmp(r[k], v) < 0);
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
const uniqKey = (u: Uniq, r: any): string | null => u.key ? u.key(r) : u.keys.some((k) => r[k] == null) ? null : JSON.stringify(u.keys.map((k) => r[k]));
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
  function q(table: string) {
    const rows = () => (T[table] = T[table] || []);
    const filters: ((r: any) => boolean)[] = [];
    let op = "select", payload: any = null, opts: any = {}, single = false, maybe = false, lim = Infinity, rng: [number, number] | null = null, wantRows = false;
    const orders: [string, boolean][] = [];
    const b: any = {
      select() { if (op !== "select") wantRows = true; return b; },
      insert(p: any) { op = "insert"; payload = p; return b; }, update(p: any) { op = "update"; payload = p; return b; },
      upsert(p: any, o?: any) { op = "upsert"; payload = p; opts = o || {}; return b; }, delete() { op = "delete"; return b; },
      eq(k: string, v: any) { filters.push((r) => r[k] === v); return b; },
      gte(k: string, v: any) { filters.push((r) => r[k] != null && cmp(r[k], v) >= 0); return b; },
      lte(k: string, v: any) { filters.push((r) => r[k] != null && cmp(r[k], v) <= 0); return b; },
      lt(k: string, v: any) { filters.push((r) => r[k] != null && cmp(r[k], v) < 0); return b; },
      in(k: string, l: any[]) { filters.push((r) => l.includes(r[k])); return b; },
      is(k: string, v: any) { filters.push((r) => (r[k] ?? null) === v); return b; },
      or(expr: string) { const parts = splitOr(expr).map(parseCond); filters.push((r) => parts.some((p) => p(r))); return b; },
      order(k: string, o?: any) { orders.push([k, !(o && o.ascending === false)]); return b; },
      limit(x: number) { lim = x; return b; }, range(a: number, z: number) { rng = [a, z]; return b; },
      single() { single = true; return b; }, maybeSingle() { maybe = true; return b; },
      then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej); },
    };
    const out = (list: any[]) => single ? (list[0] ? { data: list[0], error: null } : { data: null, error: { message: "no rows" } }) : maybe ? { data: list[0] || null, error: null } : { data: list, error: null };
    function run() {
      calls.push(`${table}.${op}`);
      const match = () => rows().filter((r) => filters.every((f) => f(r)));
      if (op === "insert") {
        const list = (Array.isArray(payload) ? payload : [payload]).map((r: any) => before(table, withDefaults(table, r)));
        for (let i = 0; i < list.length; i++) { const d = dupOf(table, list[i], [...rows(), ...list.slice(0, i)]); if (d) return dupErr(d); }   // one statement: all or nothing
        const added = list.map((r) => ({ id: r.id ?? `${table}-${++n}`, ...r }));
        rows().push(...added);
        return wantRows || single || maybe ? out(added.map((x) => ({ ...x }))) : { data: null, error: null };
      }
      if (op === "upsert") {
        const list = (Array.isArray(payload) ? payload : [payload]).map((r: any) => before(table, withDefaults(table, r))), added: any[] = [];
        for (const r of list) { if (dup(table, r)) { if (!opts.ignoreDuplicates) throw new Error("fake upsert: only ignoreDuplicates"); continue; } const x = { id: r.id ?? `${table}-${++n}`, ...r }; rows().push(x); added.push(x); }
        return wantRows ? out(added.map((x) => ({ ...x }))) : { data: null, error: null };
      }
      if (op === "update") {
        // all matched rows change or none (a unique key broken by the new values fails the statement, as in SQL)
        const m = match(), next = m.map((r) => before(table, { ...r, ...payload }));
        for (let i = 0; i < m.length; i++) { const d = dupOf(table, next[i], rows().map((x) => (m.includes(x) ? next[m.indexOf(x)] : x))); if (d) return dupErr(d); }
        m.forEach((r, i) => Object.assign(r, next[i]));
        return wantRows ? out(m.map((x) => ({ ...x }))) : { data: null, error: null };
      }
      if (op === "delete") { const gone = match(); T[table] = rows().filter((r) => !gone.includes(r)); return { data: gone, error: null }; }
      let list = match();
      for (const [k, asc] of [...orders].reverse()) list = [...list].sort((x, y) => (asc ? 1 : -1) * cmp(x[k], y[k]));
      if (rng) list = list.slice(rng[0], rng[1] + 1);
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
        .sort((x, y) => cmp(x.due_at, y.due_at)).slice(0, Math.min(Math.max(a.p_limit, 1), 50));
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
    customer_opt_outs: [], sms_opt_outs: [], review_requests: [],
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
    eq(sent.length, 1, "only the deleted one's first notification went before it was deleted");
    db2.T.automations.find((a: any) => a.id === "a-ver").version = 2;
    db2.T.automations = db2.T.automations.filter((a: any) => a.id !== "a-del");
    await tickAt(db2, NOW + 11 * MIN);
    eq([by("r-ver"), by("r-del"), sent.length], ["cancelled:automation changed", "cancelled:automation deleted", 1], "edited while waiting → cancelled; deleted → cancelled; nothing more sent");
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
      ],
    });
    await tickAt(db, NOW);
    const st = (id: string) => (db.T.automation_log.find((l: any) => l.id === id) || {}).status;
    eq([st("l1"), st("l2"), st("l3")], ["sent", "failed", "queued"], "reconcile: sent by the mailbox → sent; still queued after a day → failed; recent ones wait");
    eq(db.T.automation_log.find((l: any) => l.id === "l2").reason, "not picked up by the mailbox", "reconcile: the reason says why");
    eq([db.T.automation_runs.map((r: any) => r.id), db.T.automation_log.some((l: any) => l.id === "l4"), db.T.automation_log.some((l: any) => l.id === "l5"), db.T.automation_state[0].pruned_on], [["keep", "other"], false, true, "2026-10-14"], "prune: finished runs over 90 days and log rows over 180 days go (this business only)");
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
    const reg = await handle(db, { step: "registry" }, MANAGER, false);
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
    const AV_ALL: any = { phone: true, xero: true, gbp: true, reviews: true, ai: true, teamEmail: true, assignee: true, atomicTags: true };
    const AV_OFF: any = { phone: false, xero: false, gbp: false, reviews: false, ai: false, teamEmail: false, assignee: false, atomicTags: false };
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
      [["add_tag", "Coming with the new lead card"], ["assign_user", "Needs 'Assigned to' on the lead card"], ["send_sms", "Needs the phone line (Twilio)"], ["send_invoice", "Needs Xero"], ["math", "Coming later"], ["ai_agent", "Coming with Workflow AI"]], "greyed reasons are the design's words");
    eq([wfAliasOf("trigger", "missedCall"), wfAliasOf("trigger", "googleReview"), wfAliasOf("trigger", "docExpiry"), wfAliasOf("trigger", "bizInsurance"), wfAliasOf("trigger", "newLead"), wfAliasOf("trigger", "invoice"),
      wfAliasOf("action", "push"), wfAliasOf("action", "task"), wfAliasOf("action", "email"), wfAliasOf("action", "text"), wfAliasOf("action", "assign_owner")],
      ["call_details", "review_received", "doc_expiring", "insurance_expiring", "newLead", "invoice", "internal_notification", "add_task", "send_email", "send_sms", "assign_user"], "v1 and mirror keys map to the stored keys");
    eq(WF_ALWAYS_REENTER.filter((k) => !WF_TRIGGERS[k].alwaysReenter), [], "alwaysReenter is set on the GHL appointment / invoice style triggers");
    eq(WF_GUARDED_TYPES, ["send_email", "send_sms", "send_review_request", "send_live_chat", "send_invoice", "send_estimate", "webhook"], "guarded types = customer messages + the outgoing webhook");
    eq(["newLead", "stage", "jobClosed", "chat"].every((k) => !!WF_TRIGGERS[k]) && !WF_TRIGGERS.missedCall, true, "phase-4 trigger keys stay stored keys (missedCall is the alias of call_details)");
    eq(Object.keys(CONDITIONS).filter((k) => !WF_FIELDS[k] || !CONDITIONS[k].ops.every((o) => WF_FIELDS[k].ops.includes(o))), [], "every phase-4 condition is a field with (at least) its phase-4 ops");
    eq(Object.keys(MERGE_FIELDS).filter((k) => !WF_MERGE[k]), [], "every phase-4 blank is a merge field");
    eq(availCtxOf({ phone_enabled: true, review_requests_auto: true }, { connectors: { xero: { connected: true } }, features: { leadAssignee: true } }),
      { phone: true, xero: true, gbp: false, reviews: true, ai: false, teamEmail: false, assignee: true, atomicTags: false }, "availCtxOf reads the settings row and the catalog");

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
      record_kind: "contact", record_id: "c1", contact_id: "c1", status: "running", step_index: 0, anchor_at: isoMs(NOW), due_at: isoMs(NOW), attempts: 1, context: {}, trigger_id: "t1", cursor_step: null, ...o });
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
      db = world({ contacts: [lead("c1")], automations: [flow({ definition: doc({ n1: { kind: "action", type: "add_tag", config: { tags: ["VIP"] }, out: { next: "n2" } }, n2: { kind: "action", type: "send_sms", config: { body: "{hi}" }, out: { next: null } } }) })], automation_runs: [runRow()] });
      const u1: any = await step(db, NOW);
      eq([u1.status, logOf(db)], ["done", ["n1:skipped:unavailable: Coming with the new lead card", "n2:waiting_phone:waiting for the business phone"]], "unavailable steps skip with the reason; a text logs waiting_phone");
    }

    // ── watch: goals ahead and Stop on response; a goal met ahead is jumped to ──
    {
      const gdoc = doc({ n1: period(1, "days", "n2"), n2: { kind: "goal", type: "stage_reached", config: { stages: ["Booked"], ifNotMet: "continue" }, out: { next: "n3" } }, n3: push("Booked!") });
      const db = world({ contacts: [lead("c1")], automations: [flow({ definition: gdoc, settings: { stopOnResponse: true } })], automation_runs: [runRow()] });
      const w1: any = await step(db, NOW);
      eq(w1.watch, ["stage", "lead_status", "customer_replied"], "a hold watches the goals ahead and the reply when Stop on response is on");
      WF_GOAL_MET.stage_reached = (n: any, f: any) => (n.config.stages as string[]).includes(String(f.contact && f.contact.status));
      db.T.contacts[0].status = "Booked";
      const w2: any = await step(db, NOW + HR);
      delete WF_GOAL_MET.stage_reached;
      eq([rowsOf(db).filter((l: any) => l.status === "jumped").map((l: any) => [l.step_id, l.detail.to, l.detail.goal]), w2.loop, w2.reason], [[["n1", "n2", true]], 0, "not supported yet: goal stage_reached"],
        "a goal met ahead: the wait is left at once (jumped; the goal step itself comes with G2.2)");
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
      const norm = (path: any[]) => path.map((x: any) => ({ ...x, status: ["sent", "queued", "would"].includes(x.status) ? "acted" : x.status, preview: undefined }));
      const realPath = wfPathOfRows(realDb.T.automation_log.filter((l: any) => l.run_id === "r-par"));
      eq([pr.status, d.ok, d.ended], ["done", true, "done"], "the fixture runs to the end, really and dry");
      eq(JSON.stringify(norm(d.path)), JSON.stringify(norm(realPath)), "simFx path = realFx path (every step, status, reason, time and branch)");
      eq(realPath.map((x: any) => `${x.stepId}:${x.rowKind}:${x.status}${x.reason && x.rowKind !== "exit" ? ":" + x.reason : ""}`), ["n1:step:waiting", "n1:step:wait_finished", "n2:step:wait_finished", "n3:step:branch", "n2:step:wait_finished", "n3:step:branch",
        "n4:action:queued", "n5:action:sent", "n8:action:skipped:already contacted today", "n6:step:waiting", "n6:step:wait_finished", "n7:action:sent", "n7:exit:finished"], "the fixture's path: deferred to the morning (back over the If / else to the window), capped second email, date wait");
      eq([d.path.find((x: any) => x.stepId === "n4").preview.subject, d.path.find((x: any) => x.stepId === "n7").preview.board, d.path.find((x: any) => x.stepId === "n4").at], ["Your Aircon cleaning enquiry", "ron", isoMs(syd("2026-10-16", 8))], "the dry run previews the filled message and the board, at the time it would go");
      eq([JSON.stringify(simDb.T) === before, sent.length, fetchCalls - f0, simDb.calls.filter((c: string) => /\.(insert|update|upsert|delete)$|^rpc:/.test(c))], [true, 0, 0, []], "the dry run: the database byte-identical, nothing sent, no network, no write call");
      ok(realSent === 1 && d.writes.some((w: any) => w.op === "run"), "the real run sent its push; the dry run only recorded its run writes", { realSent });
      // a write attempt inside a dry run is an internal error, never a verdict
      const ro = readOnlySb(simDb);
      let e1 = "", e2 = "";
      try { ro.from("contacts").insert({ id: "x" }); } catch (e) { e1 = (e as Error).name; }
      try { ro.rpc("automation_claim_customer_v2", {}); } catch (e) { e2 = (e as Error).name; }
      eq([e1, e2, (await ro.from("contacts").select("id").eq("id", "c1").maybeSingle()).data], ["SimulationWriteError", "SimulationWriteError", { ...simDb.T.contacts[0] }], "readOnlySb: reads pass, writes and RPCs throw");
      WF_GOAL_MET.stage_reached = async (_n: any, _f: any, sb: any) => { await sb.from("contacts").update({ status: "x" }).eq("id", "c1"); return false; };
      const gw = await dryRunV2(simDb, flow({ definition: doc({ n1: period(1, "days", "n2"), n2: { kind: "goal", type: "stage_reached", config: { stages: ["Booked"], ifNotMet: "continue" }, out: { next: null } } }) }),
        { record_kind: "contact", record_id: "c1", contact_id: "c1", event_type: "newLead", event_at: isoMs(NOW), context: {} }, ctxOf(simDb), NOW);
      delete WF_GOAL_MET.stage_reached;
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
    eq(chg.map((m) => m[2]), CONTACT_CHANGED_FIELDS, "the contacts capture compares exactly CONTACT_CHANGED_FIELDS (statically, column by column)");
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
      && (chk.match(/raise notice 'PASS \d+/g) || []).length === 13 && chk.includes("automations_a_v2_pin") && chk.includes("for update skip locked"),
      "the staging checks: phase-4 claim, forced capture failure, RLS as VA/technician, column privileges, the v2 column pin, the non-blocking counter (13 checks, all undone)");
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

    // phase4_compat off in this build: still the phase-4 scanners (no event store yet), still advanceV2
    const raw5 = world({ contacts: [lead("c1")], automations: [auto({ id: "a-cmp-0006" })], automation_state: [{ business_id: "default", tick_lease_until: null, pruned_on: null, phase4_compat: false }] });
    r = await tickAt(raw5, NOW);
    eq([r.engine, r.enqueued, logOf(raw5), spy], ["v2-compat", 1, ["p1:sent"], 2], "compat switch: phase4_compat = false waits for the event store (G2.1): phase-4 scanners kept");

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

  console.log(`automations: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error("automations tests crashed:", e); process.exit(1); });
