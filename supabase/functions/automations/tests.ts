// Tests for automations/index.ts. Run: bash supabase/functions/automations/run_tests.sh
// (the runner swaps the esm.sh and npm imports for stubs, gives a pretend Deno.env, appends this file and runs it with tsx).
// deno-lint-ignore-file no-explicit-any

const ENV = (globalThis as any).__AUTO_ENV__ as Record<string, string>;
let pass = 0, fail = 0;
function eq(got: any, want: any, name: string) { const g = JSON.stringify(got), w = JSON.stringify(want); if (g === w) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); } }
function ok(cond: any, name: string, extra?: any) { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : ""); } }

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
const UNIQUE: Record<string, string[]> = { automation_runs: ["automation_id", "event_key"], automation_log: ["run_id", "step_id"], app_keys: ["name"] };
function fakeDb(seed: Record<string, any[]> = {}) {
  const T: Record<string, any[]> = {};
  for (const [k, v] of Object.entries(seed)) T[k] = v.map((r) => ({ ...r }));
  const calls: string[] = [];
  let n = 0;
  const dup = (table: string, r: any) => { const u = UNIQUE[table]; return !!u && (T[table] || []).some((x) => u.every((k) => x[k] === r[k])); };
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
        const list = Array.isArray(payload) ? payload : [payload];
        for (const r of list) if (dup(table, r)) return { data: null, error: { code: "23505", message: "duplicate key value" } };
        const added = list.map((r) => ({ id: r.id ?? `${table}-${++n}`, ...r }));
        rows().push(...added);
        return wantRows || single || maybe ? out(added.map((x) => ({ ...x }))) : { data: null, error: null };
      }
      if (op === "upsert") {
        const list = Array.isArray(payload) ? payload : [payload], added: any[] = [];
        for (const r of list) { if (dup(table, r)) { if (!opts.ignoreDuplicates) throw new Error("fake upsert: only ignoreDuplicates"); continue; } const x = { id: r.id ?? `${table}-${++n}`, ...r }; rows().push(x); added.push(x); }
        return wantRows ? out(added.map((x) => ({ ...x }))) : { data: null, error: null };
      }
      if (op === "update") { const m = match(); m.forEach((r) => Object.assign(r, payload)); return wantRows ? out(m.map((x) => ({ ...x }))) : { data: null, error: null }; }
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
    if (name === "automation_claim_customer") {
      // the same rule as the SQL function: count this engine's customer messages of the last 24 h to the card or any of
      // its addresses (including ones being sent), then claim the row only under the cap; a second claim does nothing
      T.automation_log = T.automation_log || [];
      const recips: string[] = a.p_recipients || [];
      if (T.automation_log.some((l) => l.run_id === a.p_run && l.step_id === a.p_step)) return { data: "done", error: null };
      const k = T.automation_log.filter((l) => l.business_id === a.p_business && l.audience === "customer" && ["sending", "sent", "queued"].includes(l.status) && cmp(l.at, a.p_since) >= 0
        && ((a.p_contact && l.contact_id === a.p_contact) || recips.includes(l.recipient))).length;
      if (k >= Math.max(a.p_cap, 1)) return { data: "capped", error: null };
      const id = `automation_log-${++n}`;
      T.automation_log.push({ id, business_id: a.p_business, run_id: a.p_run, step_id: a.p_step, status: "sending", channel: a.p_channel, audience: "customer", automation_id: a.p_automation,
        automation_name: a.p_name, record_kind: a.p_record_kind, record_id: a.p_record_id, contact_id: a.p_contact, recipient: recips[0] || null, at: a.p_now });
      return { data: "claimed:" + id, error: null };
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
const logOf = (db: any) => db.T.automation_log.map((l: any) => `${l.step_id}:${l.status}${l.reason ? ":" + l.reason : ""}`);
const runOf = (db: any) => db.T.automation_runs.map((r: any) => `${r.status}${r.reason ? ":" + r.reason : ""}`);
const ctxOf = (db: any) => ({ S: normSettings(db.T.automation_settings[0]), cat: CATALOG, company: "Acme Home Services", autos: new Map(), counts: { events: 0, enqueued: 0, processed: 0, sent: 0, queued: 0, skipped: 0, deferred: 0 } });
// Syd wall clock → UTC ms
const syd = (day: string, h: number, m = 0) => zoneToUtc(day, h, m, "Australia/Sydney");

(async () => {
  const fs: any = await import("node:fs");
  const src = (p: string) => fs.readFileSync(p, "utf8") as string;
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
    eq([sent.length, runOf(db), db.T.automation_log.length], [1, ["done"], 1], "re-claimed after an expired lease: no second push");
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
    eq(db2.T.automation_log.filter((l: any) => l.automation_id === "a-del").map((l: any) => l.automation_name), ["Deleted one"], "the log keeps the deleted automation's name");
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
    ok(db.calls.includes("rpc:automation_claim_customer"), "a customer email is claimed through automation_claim_customer");
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

  console.log(`automations: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error("automations tests crashed:", e); process.exit(1); });
