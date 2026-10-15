// Tests for mcp/index.ts. Run: bash supabase/functions/mcp/run_tests.sh
// (the runner swaps the esm.sh import for a stub, adds the app's own role and pay functions from index.html as APP,
// appends this file and runs it with npx tsx). The parity tests compare the server's ports with the live app code.
// deno-lint-ignore-file no-explicit-any

// ── a small in-memory stand-in for the Supabase client (conversations/tests.ts, plus what this function uses) ──
function fakeDb(seed: Record<string, any[]>, opts: { users?: Record<string, any>; jwts?: Record<string, string>; fail?: string[]; maxRows?: number } = {}) {
  const T: Record<string, any[]> = { mcp_tokens: [], mcp_access_log: [], ...seed };
  const ranges: Record<string, number> = {};          // .range() calls per table
  const ors: string[][] = [];                          // every .or() filter, as its clauses
  const selects: [string, string][] = [];              // every select's column list
  let seq = 0;
  const cmp = (a: any, b: any) => (a == null && b == null ? 0 : a == null ? 1 : b == null ? -1 : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
  // numbers (the access log's bigserial ids) compare as numbers, anything else as text
  const order = (a: any, b: any) => (typeof a === "number" && typeof b === "number" ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
  const like = (v: any, pat: string) => v != null && new RegExp("^" + pat.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i").test(String(v));
  function clause(s: string) {
    const a = s.indexOf("."), b = s.indexOf(".", a + 1), col = s.slice(0, a), op = s.slice(a + 1, b), val = s.slice(b + 1).replace(/^"(.*)"$/, "$1");
    if (op === "ilike") return (r: any) => like(r[col], val);
    if (op === "eq") return (r: any) => r[col] != null && String(r[col]) === val;
    if (op === "neq") return (r: any) => r[col] != null && String(r[col]) !== val;
    if (op === "is" && val === "null") return (r: any) => r[col] == null;
    if (op === "lt") return (r: any) => r[col] != null && String(r[col]) < val;
    if (op === "match") return (r: any) => r[col] != null && new RegExp(val).test(String(r[col]));
    throw new Error("fake or: " + s);
  }
  function from(table: string) {
    const rows = () => (T[table] = T[table] || []);
    const filters: ((r: any) => boolean)[] = [];
    const orders: [string, boolean, boolean][] = [];
    let op = "select", payload: any = null, head = false, wantCount = false, single = 0, range: [number, number] | null = null, sel = false, lim = Infinity;
    const b: any = {
      select(c?: string, o?: any) { if (op === "select") { selects.push([table, String(c)]); head = !!(o && o.head); wantCount = !!(o && o.count); } else sel = true; return b; },
      insert(p: any) { op = "insert"; payload = p; return b; },
      update(p: any) { op = "update"; payload = p; return b; },
      delete() { op = "delete"; return b; },
      eq(k: string, v: any) { filters.push((r) => r[k] === v); return b; },
      neq(k: string, v: any) { filters.push((r) => r[k] != null && r[k] !== v); return b; },
      gt(k: string, v: any) { filters.push((r) => r[k] != null && order(r[k], v) > 0); return b; },
      gte(k: string, v: any) { filters.push((r) => r[k] != null && order(r[k], v) >= 0); return b; },
      lt(k: string, v: any) { filters.push((r) => r[k] != null && order(r[k], v) < 0); return b; },
      lte(k: string, v: any) { filters.push((r) => r[k] != null && order(r[k], v) <= 0); return b; },
      is(k: string, v: any) { filters.push((r) => (r[k] ?? null) === v); return b; },
      in(k: string, list: any[]) { filters.push((r) => list.includes(r[k])); return b; },
      ilike(k: string, p: string) { filters.push((r) => like(r[k], p.replace(/%/g, "*"))); return b; },
      or(s: string) { const parts = s.split(","); ors.push(parts); const cl = parts.map(clause); filters.push((r) => cl.some((f) => f(r))); return b; },
      order(k: string, o?: any) { orders.push([k, !(o && o.ascending === false), !!(o && o.nullsFirst)]); return b; },
      limit(n: number) { lim = n; return b; },
      range(a: number, z: number) { range = [a, z]; ranges[table] = (ranges[table] || 0) + 1; return b; },
      single() { single = 1; return b; },
      maybeSingle() { single = 2; return b; },
      then(res: any, rej: any) { let out; try { out = run(); } catch (e) { return Promise.reject(e).then(res, rej); } return Promise.resolve(out).then(res, rej); },
    };
    function run() {
      if ((opts.fail || []).includes(table)) return { data: null, error: { message: `${table} is not readable` } };
      const match = () => rows().filter((r) => filters.every((f) => f(r)));
      if (op !== "select") ctl.writes.push(`${table}.${op}`);
      // the failure hook: a write touching a row that holds one of these values fails as a whole (as Postgres would)
      const hooked = (list: any[]) => list.some((r) => Object.values(r).some((v) => ctl.failValues.has(v)));
      if (op === "insert") {
        const list = (Array.isArray(payload) ? payload : [payload]).map((r: any) => ({ id: r.id ?? (table === "mcp_access_log" ? ++seq : crypto.randomUUID()), ...r }));
        if (table === "mcp_tokens" && list.some((x: any) => rows().some((y) => y.token_hash === x.token_hash))) return { data: null, error: { message: "duplicate key" } };
        if (hooked(list)) return { data: null, error: { message: "insert refused by the test hook" } };
        // the partial unique index mcp_import_runs_one_running: one 'running' run per rule
        if (table === "mcp_import_runs" && list.some((x: any) => x.status === "running" && rows().some((y) => y.rule_id === x.rule_id && y.status === "running"))) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        rows().push(...list);
        const out = list.map((x: any) => ({ ...x }));
        return { data: single ? out[0] : sel ? out : null, error: null };
      }
      if (op === "update") { const m = match(); m.forEach((r) => Object.assign(r, payload)); const out = m.map((r) => ({ ...r })); return { data: single ? out[0] || null : out, error: null }; }
      if (op === "delete") {
        const m = match();
        if (hooked(m)) return { data: null, error: { message: "delete refused by the test hook (a foreign key)" } };
        T[table] = rows().filter((r) => !m.includes(r));
        // the SQL trigger mcp_servers_drop_secret: a deleted server takes its Vault secret with it
        if (table === "mcp_servers") m.forEach((r) => { if (r.secret_id) vault.delete(r.id); });
        // mcp_import_runs.rule_id … on delete set null: a deleted rule's runs stay
        if (table === "mcp_import_rules") (T.mcp_import_runs || []).forEach((x) => { if (m.some((r) => r.id === x.rule_id)) x.rule_id = null; });
        return { data: sel ? m.map((r) => ({ ...r })) : null, error: null };
      }
      let m = match().slice().sort((a, z) => {
        for (const [k, asc, nf] of orders) { const c = nf && (a[k] == null) !== (z[k] == null) ? (a[k] == null ? -1 : 1) * (asc ? 1 : -1) : cmp(a[k], z[k]); if (c) return asc ? c : -c; }
        return 0;
      });
      const count = m.length;
      if (range) m = m.slice(range[0], range[1] + 1);
      m = m.slice(0, Math.min(lim, opts.maxRows ?? Infinity));   // the server's row cap, as Supabase answers (max-rows)
      if (head) return { data: null, count, error: null };
      const out = m.map((r) => JSON.parse(JSON.stringify(r)));
      if (single === 1) return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: "not one row" } };
      if (single === 2) return out.length > 1 ? { data: null, error: { message: "more than one row" } } : { data: out[0] || null, error: null };
      return { data: out, count: wantCount ? count : null, error: null };
    }
    return b;
  }
  const users = opts.users || {}, jwts = opts.jwts || {};
  const auth = {
    getUser: async (jwt: string) => (jwts[jwt] ? { data: { user: { id: jwts[jwt] } }, error: null } : { data: { user: null }, error: { message: "invalid JWT" } }),
    admin: { getUserById: async (id: string) => (ctl.authDown ? { data: { user: null }, error: { status: 503, message: "Service unavailable" } } : users[id] ? { data: { user: { ...users[id] } }, error: null } : { data: { user: null }, error: { status: 404, message: "User not found" } }) },
  };
  // Supabase Vault, as mcp_server_secret_set / _get see it (server id → secret). ctl.rpcFail makes both fail.
  const vault = new Map<string, string>();
  const ctl = { rpcFail: false, authDown: false, rpcs: [] as string[], writes: [] as string[], failValues: new Set<any>() };
  const rpc = async (name: string, args: any) => {
    ctl.rpcs.push(name);
    if (name === "mcp_server_secret_set" || name === "mcp_server_secret_get") {
      if (ctl.rpcFail) return { data: null, error: { message: "permission denied for schema vault" } };
      const row = (T.mcp_servers || []).find((r) => r.id === args.p_server);
      if (!row) return { data: null, error: { message: "mcp server not found" } };
      if (name === "mcp_server_secret_get") return { data: row.secret_id ? vault.get(row.id) ?? null : null, error: null };
      if (!args.p_secret) { vault.delete(row.id); row.secret_id = null; return { data: false, error: null }; }
      vault.set(row.id, args.p_secret); row.secret_id = "vault-" + row.id;
      return { data: true, error: null };
    }
    if (name !== "mcp_set_catalog") return { data: null, error: { message: "no such function" } };
    const st = T.settings[0]; st.catalog = { ...(st.catalog || {}), mcp: args.p_mcp };
    return { data: args.p_mcp, error: null };
  };
  return { T, ranges, ors, selects, from, rpc, auth, vault, ctl };
}

let pass = 0, fail = 0;
function eq(got: any, want: any, name: string) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}
const ok = (cond: boolean, name: string) => eq(!!cond, true, name);
// Warnings and errors are kept here (and never printed), so a test can check that a key is never written to a log.
const logged: string[] = [];
console.warn = (...a: any[]) => { logged.push(a.map(String).join(" ")); };
console.error = (...a: any[]) => { logged.push(a.map(String).join(" ")); };

// ── the fixture: one small business, two weeks of work around Wed 14 Oct 2026 (Sydney) ──
// Sydney: AEST (UTC+10) until Sun 4 Oct 2026 02:00, then AEDT (UTC+11).
const NOW = Date.parse("2026-10-14T01:00:00Z");     // Wed 14 Oct 12:00 AEDT
const D = (role: string) => APP.defaultPermissionsFor(role);
const CAT = {
  // Weeks start on Sunday until a change to Monday weeks from Wed 7 Oct: Sun 4–Tue 6 (cut short by the change), then the
  // transition week Wed 7–Sun 11 (5 days), then Mon 12–Sun 18.
  region: { timeZone: "Australia/Sydney", weeks: [{ weekStart: 1, from: "2026-10-07" }] },
  // Hourly pay changes from Thu 8 Oct: $12 an hour, bonus $20 from 6 bookings, $5 from 3 (before: $10, 5/8/12 → 10/15/25).
  pay: { hourly: [{ from: "2026-10-08", rate: 12, tiers: [{ min: 6, bonus: 20 }, { min: 3, bonus: 5 }] }] },
  other: { keep: true },
};
const C1 = "11111111-1111-4111-8111-111111111111", C2 = "22222222-2222-4222-8222-222222222222", C3 = "33333333-3333-4333-8333-333333333333";
const PROFILES = [
  { id: "u-owner", full_name: "Odette", role: "owner", technician_name: null, permissions: D("owner") },
  { id: "u-mgr", full_name: "Maya", role: "manager", technician_name: null, permissions: D("manager") },
  { id: "u-riley", full_name: "Riley", role: "va", technician_name: null, permissions: { ...D("va"), mcp: true } },
  { id: "u-dana", full_name: "Dana", role: "va", technician_name: null, permissions: { ...D("va"), tasks: false, mcp: true } },
  { id: "u-pia", full_name: "Pia", role: "va", technician_name: null, permissions: D("va") },                       // MCP not switched on
  { id: "u-gabe", full_name: "Gabe Green", role: "technician", technician_name: "Gabe", permissions: { ...D("technician"), mcp: true } },
  { id: "u-alex", full_name: "Alexandra", role: "technician", technician_name: "Alex", permissions: { ...D("technician"), jobs: true, crm: true, closings: true, outstanding: true, crmOverview: true, adsGoogle: true, mcp: true } },
  { id: "u-tal", full_name: "Tal", role: "technician", technician_name: null, permissions: { ...D("technician"), mcp: true } },
  { id: "u-mkt", full_name: "Agency", role: "marketing", technician_name: null, permissions: { ...D("marketing"), mcp: true } },
  { id: "u-mkt2", full_name: "Agency Two", role: "marketing", technician_name: null, permissions: { ...D("marketing"), crmOverview: true, mcp: true } },
];
const job = (id: string, o: any) => ({ id, customer_name: "Customer " + id, invoice_number: "INV-" + id, job_type: "Aircon", commission_percent: 30, includes_gst: false, payment_method: null, parts_cost: 0, parts_paid_by: null, parts_refund_status: "N/A", date_paid: null, paid_to_technician: null, parts_pending_at: null, parts_refund_week: null, contact_id: null, ...o });
const msgs = Array.from({ length: 12 }, (_, i) => ({ id: "m" + i, kind: "message", direction: i % 2 ? "in" : "out", author: i % 2 ? "Ann" : "Riley", at: `2026-10-1${i < 10 ? 0 : 1}T0${i % 10}:00:00Z`, text: i === 11 ? "x".repeat(800) : "hello " + i }));
const SEED: Record<string, any[]> = {
  settings: [{ id: 1, company_name: "Demo Home Services", gst_rate_percent: 10, catalog: CAT }],
  profiles: PROFILES,
  employees: [
    { id: "e1", name: "Gabe", roles: ["Technician"], status: "Active", employment_type: "Freelance" },
    { id: "e2", name: "Alex", roles: ["Technician"], status: "Active", employment_type: "Independent Contractor" },
    { id: "e3", name: "Riley", roles: ["VA"], status: "Active", employment_type: "Hourly" },
    { id: "e4", name: "Odette", roles: ["Owner", "Technician"], status: "Active", employment_type: "" },
    { id: "e5", name: "Old", roles: ["Technician"], status: "Inactive", employment_type: "Freelance" },
  ],
  jobs: [
    job("j1", { date: "2026-10-05", technician: "Gabe", amount: 200, includes_gst: true, payment_status: "Paid", payment_method: "Cash", date_paid: "2026-10-05", parts_cost: 20, parts_paid_by: "Gabe", parts_refund_status: "Pending Refund", parts_pending_at: "2026-10-05T03:00:00Z", contact_id: C1 }),
    job("j2", { date: "2026-10-08", technician: "Gabe", amount: 300, payment_status: "Paid", payment_method: "Bank Transfer", date_paid: "2026-10-09" }),
    job("j3", { date: "2026-10-09", technician: "Alex", job_type: "Pressure Washing", commission_percent: 40, amount: 500, includes_gst: true, payment_status: "Paid", payment_method: "Credit Card", date_paid: "2026-10-12", parts_cost: 50, parts_paid_by: "Business" }),
    job("j4", { date: "2026-10-12", technician: "Gabe", amount: 150, includes_gst: true, payment_status: "Unpaid" }),
    job("j5", { date: "2026-10-13", technician: "Gabe", amount: 250, includes_gst: true, payment_status: "Paid", payment_method: "Cash", date_paid: "2026-10-13", paid_to_technician: "Stuck" }),
    job("j6", { date: "2026-10-13", technician: null, amount: 100, payment_status: null, commission_percent: 0 }),
    job("j7", { date: "2026-10-10", technician: "Alex", commission_percent: 40, amount: 400, payment_status: "Unpaid" }),
  ],
  equipment_spend: [
    { id: "eq1", date: "2026-10-06", item: "Vacuum", technician: "Gabe", paid_by: "Gabe", cost: 110, reimbursed: "Pending", created_at: "2026-10-06T02:00:00Z", reimbursed_week: null },
    { id: "eq2", date: "2026-10-12", item: "Ladder", technician: "Alex", paid_by: "Business", cost: 80, reimbursed: "N/A", created_at: "2026-10-12T02:00:00Z", reimbursed_week: null },
    { id: "eq3", date: "2026-10-01", item: "Hose", technician: "Gabe", paid_by: "Gabe", cost: 30, reimbursed: "Reimbursed", created_at: "2026-10-01T02:00:00Z", reimbursed_week: "2026-10-04" },
  ],
  closings: [
    { id: "cl1", date: "2026-10-08", technician_name: "Gabe", customer_name: "Ann Lee", invoice_number: "INV-j2", job_type: "Aircon", amount: 300, includes_gst: false, payment_status: "Paid", payment_method: "Bank Transfer", parts_cost: 0, posted_by: "Riley", linked_job_id: "j2" },
    { id: "cl2", date: "2026-10-09", technician_name: "Alex", customer_name: "Bob Stone", invoice_number: "INV-j3", job_type: "Pressure Washing", amount: 550, includes_gst: true, payment_status: "Paid", payment_method: "Credit Card", parts_cost: 50, posted_by: "Riley", linked_job_id: "j3" },
  ],
  tasks: [
    { id: "t1", title: "Call Ann", board: "Riley", status: "To do", due: "2026-10-15", assignees: ["Riley"], assigned_to: null, contact_id: C1, notes: "n".repeat(400), subtasks: [{ t: 1 }, { t: 2 }] },
    { id: "t2", title: "Restock van", board: "Gabe", status: "Doing", due: null, assignees: [], assigned_to: null, contact_id: null },
    { id: "t3", title: "Quote Bob", board: "Odette", status: "To do", due: "2026-10-14", assignees: ["Gabe", "Riley"], assigned_to: null, contact_id: null },
    { id: "t4", title: "Old task", board: "Odette", status: "To do", due: "2026-10-20", assignees: null, assigned_to: "Riley", contact_id: null },
    { id: "t5", title: "Wash quote", board: "Nora", status: "Done", due: "2026-10-01", assignees: ["Alex"], assigned_to: null, contact_id: C1 },
  ],
  contacts: [
    { id: C1, full_name: "Ann Lee", phone: "0412345678", email: "ann@example.com", postcode: "2000", division: "Aircon", source: "Google Ads", status: "New", created_at: "2026-10-10T01:00:00Z", next_follow_up: "2026-10-16", tags: ["vip"], estimated_value: 500, sales_value: 0, notes: "Two units", customer_notes: [{ id: "n1", text: "Gate code 4321", by: "Riley", at: "2026-10-12T01:00:00Z" }, { id: "n2", text: "Dog in the yard", by: "Odette", at: "2026-10-13T01:00:00Z" }, { id: "n3", text: "" }], followup_note: "", job_description: "Clean two splits", lost_reason: "", sub_source: "", messages: msgs },
    { id: C2, full_name: "Bob Stone", phone: "+61400111222", email: "bob@example.com", postcode: "2010", division: "Chimney", source: "Facebook", status: "Won", created_at: "2026-10-13T20:00:00Z", next_follow_up: null, tags: [], estimated_value: 0, sales_value: 900, notes: "", messages: [] },
    { id: C3, full_name: "Cara Old", phone: "", email: "", postcode: "2100", division: "Aircon", source: "Referral", status: "Lost", created_at: "2026-09-01T00:00:00Z", next_follow_up: null, tags: [], estimated_value: 0, sales_value: 0, notes: "", messages: [] },
  ],
  calls: [
    { id: "k1", direction: "inbound", from_number: "+61412345678", to_number: "+61290000000", status: "missed", missed: true, answered_by: null, duration: 0, voicemail: true, started_at: "2026-10-03T14:30:00.000Z", callback_done_at: null, contact_id: C1 },
    { id: "k2", direction: "inbound", from_number: "+61400111222", to_number: "+61290000000", status: "missed", missed: true, answered_by: null, duration: 0, voicemail: false, started_at: "2026-10-03T13:59:00.000Z", callback_done_at: "2026-10-04T00:00:00.000Z", contact_id: C2 },
    { id: "k3", direction: "inbound", from_number: "+61400999888", to_number: "+61290000000", status: "answered", missed: false, answered_by: "office", duration: 120, voicemail: false, started_at: "2026-10-12T22:00:00.000Z", callback_done_at: null, contact_id: null },
  ],
  ad_spend: [
    { id: "a1", date: "2026-10-05", channel: "Google Ads", spend: 100, leads_reported: 2 },
    { id: "a2", date: "2026-10-08", channel: "Google Ads", spend: 120.5, leads_reported: 0 },
    { id: "a3", date: "2026-10-12", channel: "Meta", spend: 50.5, leads_reported: 1 },
    { id: "a4", date: "2026-09-01", channel: "Google Ads", spend: 999, leads_reported: 9 },
  ],
  ad_calls: [
    { id: "ac1", date: "2026-10-06", status: "MISSED", duration_seconds: 0, campaign: "Aircon Sydney", account: "1" },
    { id: "ac2", date: "2026-10-07", status: "ANSWERED", duration_seconds: 45, campaign: "Chimney", account: "2" },
    { id: "ac3", date: "2026-10-08", status: "ANSWERED", duration_seconds: 10, campaign: "Chimney", account: "2" },
  ],
  payroll_weeks: [{ id: "pw1", week_start: "2026-10-04", person: "Gabe", cash_collected: true, salary_paid: true, salary_paid_amount: null }],
  payroll_bonuses: [
    { id: "b1", week_start: "2026-10-12", person: "Gabe", amount: 50, reason: "Great reviews", created_at: "2026-10-13T00:00:00Z" },
    { id: "b2", week_start: "2026-10-07", person: "Riley", amount: 20, reason: "Extra shift", created_at: "2026-10-09T00:00:00Z" },
  ],
  sales_daily_log: [
    { id: "s1", person: "Riley", date: "2026-10-07", hours: 4, bookings_aircon: 3, bookings_chimney: 1, bookings_pw: 0 },
    { id: "s2", person: "Riley", date: "2026-10-08", hours: 6, bookings_aircon: 5, bookings_chimney: 0, bookings_pw: 1 },
    { id: "s3", person: "Riley", date: "2026-10-13", hours: 5, bookings_aircon: 8, bookings_chimney: 2, bookings_pw: 2 },
  ],
};
const USERS = () => Object.fromEntries(PROFILES.map((p) => [p.id, { id: p.id, banned_until: null }]));
const JWTS = Object.fromEntries(PROFILES.map((p) => ["jwt-" + p.id, p.id]));
const world = (over: Record<string, any[]> = {}, opts: any = {}) => fakeDb({ ...JSON.parse(JSON.stringify(SEED)), ...over }, { users: USERS(), jwts: JWTS, ...opts });
const prof = (id: string) => appProfile(PROFILES.find((p) => p.id === id));
// The app's own profile shape (technicianName may be null, as the app loads it).
const appProf = (id: string) => { const p: any = PROFILES.find((x) => x.id === id); return { id: p.id, fullName: p.full_name, role: p.role, technicianName: p.technician_name, permissions: p.permissions || {} }; };
// The fixture as the app loads it (its own row mappers).
function appData() {
  const S = JSON.parse(JSON.stringify(SEED));
  return {
    jobs: S.jobs.map(APP.mapJobRow), equipmentSpend: S.equipment_spend.map(APP.mapEquipSpendRow), tasks: S.tasks.map(APP.mapTaskRow),
    contacts: S.contacts.map((c: any) => ({ id: c.id })), closings: S.closings.map(APP.mapClosingRow), equipmentCatalog: [], suppliers: [],
    employees: S.employees.map((e: any) => ({ id: e.id, name: e.name, roles: e.roles || [], status: e.status, employmentType: e.employment_type || "" })),
    payrollWeeks: S.payroll_weeks.map(APP.mapPayrollRow), payrollBonuses: S.payroll_bonuses.map(APP.mapBonusRow), salesLogs: S.sales_daily_log.map(APP.mapSalesLogRow),
    settings: { gstRatePercent: 10, catalog: S.settings[0].catalog },
  };
}
// The server's calc context over the same rows.
function serverCalc(data?: any) {
  const S = JSON.parse(JSON.stringify(SEED));
  return {
    gstRate: 10, catalog: S.settings[0].catalog, tz: "Australia/Sydney", today: "2026-10-14", employees: S.employees.map(employeeFromRow),
    rules: weekRules(S.settings[0].catalog.region), weekCache: new Map(),
    jobs: S.jobs.map(jobFromRow), equipmentSpend: S.equipment_spend.map(equipFromRow), payrollWeeks: S.payroll_weeks.map(payrollFromRow),
    payrollBonuses: S.payroll_bonuses.map(bonusFromRow), salesLogs: S.sales_daily_log.map(salesLogFromRow), ...(data || {}),
  };
}

// ── HTTP helpers: every call goes through handleHttp(new Request(...)) ──
let clock = NOW;   // each request moves the clock 3 s on (so the default 60-a-minute limit is never reached by accident)
async function http(sb: any, o: any = {}) {
  const h: Record<string, string> = { "content-type": "application/json", ...(o.headers || {}) };
  if (o.token) h.authorization = "Bearer " + o.token;
  const method = o.method || "POST";
  const body = method === "POST" ? (o.raw !== undefined ? o.raw : JSON.stringify(o.body)) : undefined;
  const res = await handleHttp(new Request("https://example.supabase.co" + (o.path || "/functions/v1/mcp"), { method, headers: h, body }), { sb, nowMs: o.at ?? (clock += 3000) });
  const text = await res.text();
  let parsed: any = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, headers: res.headers, text, body: parsed };
}
let rid = 0;
// Keys are for owners and managers only (Ofek 15 Oct): anyone else's key (made before, when a per-person switch existed)
// is refused over HTTP. The role scope still guards every tool (defence in depth, and stage 8 reuses it), so the role
// tests run those people's calls past the key check, straight into handleRpc with their own key row (direct below).
// Over http() a legacy key is always refused.
const LEGACY = new Set<string>();
async function direct(sb: any, token: string, msg: any, at?: number) {
  const hash = await sha256Hex(token), row = sb.T.mcp_tokens.find((x: any) => x.token_hash === hash && !x.revoked_at);
  const p = row && sb.T.profiles.find((x: any) => x.id === row.user_id);
  if (!p) return { status: 401, headers: new Headers(), text: "", body: null };
  const nowMs = at ?? (clock += 3000);
  const r = await handleRpc(msg, { sb, s: scopeOf(appProfile(p)), biz: await loadBusiness(sb), nowMs, token: row });
  return { status: r.status, headers: new Headers(r.headers || {}), text: JSON.stringify(r.body), body: r.body };
}
const rpc = (sb: any, token: string, method: string, params?: any, extra: any = {}) => {
  const msg = { jsonrpc: "2.0", id: ++rid, method, ...(params === undefined ? {} : { params }) };
  return LEGACY.has(token) && !extra.path && !extra.headers ? direct(sb, token, msg, extra.at) : http(sb, { token, body: msg, ...extra });
};
const call = (sb: any, token: string, name: string, args?: any, extra: any = {}) => rpc(sb, token, "tools/call", { name, ...(args === undefined ? {} : { arguments: args }) }, extra);
const sc = (r: any) => r.body && r.body.result && r.body.result.structuredContent;
const errText = (r: any) => (r.body && r.body.result && r.body.result.isError ? r.body.result.content[0].text : null);
const ids = (rows: any[]) => rows.map((x: any) => x.id);
const manage = (sb: any, step: string, me: string | null, extra: any = {}, at?: number) => http(sb, { path: "/functions/v1/mcp/manage", body: { step, ...extra }, headers: me ? { authorization: "Bearer jwt-" + me } : {}, at });
// A key for everyone: owners and managers through create_token (so the hashes are real); everyone else a key made
// before 15 Oct (written straight into mcp_tokens, as the per-person switch allowed then), used by the role tests
// (LEGACY, direct above). Pia never had the switch: no key.
async function keysFor(sb: any) {
  const out: Record<string, string> = {};
  for (const p of PROFILES) {
    if (canUseMcp(prof(p.id))) { out[p.id] = (await manage(sb, "create_token", p.id, { name: "Laptop" })).body.token; continue; }
    if (p.id === "u-pia") continue;
    const token = newToken();
    sb.T.mcp_tokens.push({ id: crypto.randomUUID(), business_id: "default", user_id: p.id, name: "Old laptop", token_prefix: tokenPrefix(token), token_hash: await sha256Hex(token), scopes: ["read"], created_at: "2026-10-14T00:00:00Z", revoked_at: null, last_used_at: null });
    LEGACY.add(token); out[p.id] = token;
  }
  return out;
}
const ALL_TOOLS = ["whoami", "search_contacts", "get_contact", "list_jobs", "list_closings", "list_outstanding", "money_summary", "payroll_summary", "marketing_summary", "list_tasks", "list_calls"];

// ── a pretend external MCP server (Streamable HTTP) for the client steps; it records every request it gets ──
// Modes: protocol, sse ('open' = the stream never ends, 'close'), redirect, status, hang, down, huge ('body' | 'length'),
// badJson, wrongId, rpcErrorOn (a method), echoSecret (the secret comes back in a tool, a result and an error), tools,
// callResult.
function fakeRemote(o: any = {}) {
  const reqs: any[] = [];
  const sec = o.secret || "";
  const page1 = [
    { name: "list_leads", title: "List leads", description: "Lists new leads" + (o.echoSecret ? " (key " + sec + ", Bearer " + sec + ")" : ""), inputSchema: { type: "object", properties: { since: { type: "string" } } } },
    { name: "get_lead", description: "One lead", inputSchema: { type: "object" } },
  ];
  const page2 = [{ name: "list_jobs", description: "Jobs", inputSchema: { type: "object" } }];
  const items = [{ name: "Ann Lee", phone: "0400 000 001" }, { name: "Bob Ray", phone: "0400 000 002" }];
  const te = new TextEncoder();
  const fetch = async (url: string, init: any, ip?: string | null): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = String(v);
    const body = JSON.parse(init.body);
    reqs.push({ url, ip: ip ?? null, method: init.method, redirect: init.redirect, headers, body });
    if (o.hang) return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }))));
    if (o.down) throw new TypeError("fetch failed");
    if (o.redirect) return new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/mcp" } });
    if (o.status) return new Response("no", { status: o.status });
    if (body.id === undefined) return new Response(null, { status: 202 });
    let msg: any;
    if (body.method === "initialize") msg = { result: { protocolVersion: o.protocol || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Fake CRM", version: "2.1" } } };
    else if (o.rpcErrorOn === body.method) msg = { error: { code: -32000, message: "Bad key " + sec + " for this call" } };
    else if (body.method === "tools/list") msg = { result: body.params && body.params.cursor === "p2" ? { tools: page2 } : { tools: o.tools || page1, nextCursor: "p2" } };
    else if (body.method === "tools/call") msg = { result: o.callResult || { content: [{ type: "text", text: JSON.stringify({ items, ...(o.echoSecret ? { note: "key " + sec } : {}) }) }] } };
    else msg = { error: { code: -32601, message: "Method not found" } };
    const answer = { jsonrpc: "2.0", id: o.wrongId ? body.id + 100 : body.id, ...msg };
    const hdrs: Record<string, string> = body.method === "initialize" ? { "Mcp-Session-Id": "sess-1" } : {};
    if (o.huge === "length") return new Response(JSON.stringify(answer), { headers: { ...hdrs, "content-type": "application/json", "content-length": "3000000" } });
    if (o.huge === "body") return new Response("[" + " ".repeat(3_000_000) + "]", { headers: { ...hdrs, "content-type": "application/json" } });
    if (o.badJson) return new Response("<html>hello</html>", { headers: { ...hdrs, "content-type": "text/html" } });
    if (o.sse) {
      const js = JSON.stringify(answer), cut = js.indexOf(",") + 1;
      const ans = "event: message\ndata: " + js.slice(0, cut) + "\ndata: " + js.slice(cut) + "\n\n";   // two data lines
      const chunks = [
        'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}\n\n',
        `data:{"jsonrpc":"2.0","id":${body.id},"method":"sampling/createMessage","params":{}}\r\n\r\n`,   // a server→client request with our id
        "data: not json\n\n",
        ans.slice(0, 12), ans.slice(12),
      ];
      const stream = new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(te.encode(ch)); if (o.sse === "close") c.close(); } });
      return new Response(stream, { headers: { ...hdrs, "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify(answer), { headers: { ...hdrs, "content-type": "application/json" } });
  };
  return { fetch, reqs };
}

(async () => {
  // ── small helpers ──
  const t1 = newToken();
  eq([TOKEN_RE.test(t1), t1.length, tokenPrefix(t1).length, tokenPrefix(t1), newToken() !== t1], [true, 51, 12, t1.slice(0, 12), true], "newToken: ops_mcp_ + 43 url-safe characters (51), a 12-character prefix, never the same twice");
  eq([sameSecret("abc", "abc"), sameSecret("abc", "abd"), sameSecret("", ""), sameSecret("abc", "abcd")], [true, false, false, false], "sameSecret");
  eq(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "sha256Hex");
  eq([isDay("2026-02-28"), isDay("2026-02-30"), isDay("2026-2-1"), isDay(5)], [true, false, false, false], "isDay round-trips the date");
  eq([isUuid(C1), isUuid("x"), isUuid(C1 + "0")], [true, false, false], "isUuid");
  eq(mcpSettings({}), { rateLimitPerMin: 60, logKeepDays: 90, importSource: "MCP import" }, "mcpSettings: nothing saved = 60 / 90 / 'MCP import'");
  eq(mcpSettings({ mcp: { rateLimitPerMin: 0, logKeepDays: 6, importSource: "   " } }), { rateLimitPerMin: 60, logKeepDays: 90, importSource: "MCP import" }, "mcpSettings: out-of-range values fall back");
  eq(mcpSettings({ mcp: { rateLimitPerMin: 2.5, logKeepDays: "30", importSource: 7 } }), { rateLimitPerMin: 60, logKeepDays: 90, importSource: "MCP import" }, "mcpSettings: wrong types fall back");
  eq(mcpSettings({ mcp: { rateLimitPerMin: 600, logKeepDays: 7, importSource: "  " + "y".repeat(70) + " " } }), { rateLimitPerMin: 600, logKeepDays: 7, importSource: "y".repeat(60) }, "mcpSettings: valid values kept, importSource trimmed and clipped to 60");
  eq(mcpSettings({ mcp: [1] }).rateLimitPerMin, 60, "mcpSettings: a list is not settings");
  const schema = TOOLS.find((t) => t.name === "search_contacts")!.inputSchema;
  eq(summarizeArgs({ query: "q".repeat(500), secret: "s3cr3t", limit: 5, status: ["x"] }, schema), JSON.stringify({ query: "q".repeat(60), status: "[…]", limit: 5 }), "summarizeArgs: only the tool's fields, text clipped to 60, lists replaced");
  ok(summarizeArgs({ query: "word ".repeat(200) }, { properties: { query: {}, a: {}, b: {} } }).length <= 300, "summarizeArgs: at most 300 characters");
  eq([summarizeArgs(undefined, schema), summarizeArgs([1], schema)], ["", ""], "summarizeArgs: no arguments");

  // ── routes and keys in requests ──
  eq([routeOf("/mcp"), routeOf("/functions/v1/mcp"), routeOf("/mcp/"), routeOf("/mcp/t/" + t1), routeOf("/mcp/t/garbage"), routeOf("/functions/v1/mcp/manage"), routeOf("/mcp/cron"), routeOf("/other"), routeOf("/mcp/foo"), routeOf("/mcpx")],
    [{ kind: "mcp" }, { kind: "mcp" }, { kind: "mcp" }, { kind: "mcp", pathToken: t1 }, { kind: "mcp", pathToken: "" }, { kind: "manage" }, { kind: "cron" }, null, null, null], "routeOf");
  const rq = (auth?: string) => new Request("https://x.test/mcp", { headers: auth ? { authorization: auth } : {} });
  eq([tokenFrom(rq("Bearer " + t1), {}), tokenFrom(rq("Bearer sb_publishable_x"), {}), tokenFrom(rq(), {}), tokenFrom(rq("Bearer " + t1), { pathToken: "" })], [t1, "", "", ""], "tokenFrom: an ops_mcp_ bearer key, else none; a path key wins");

  // ── time zone: the business's (settings.catalog.region.timeZone, the region block shared with every function) ──
  const SYD = "Australia/Sydney", CHI = "America/Chicago";
  const midnight = (day: string, tz: string) => new Date(bizToUtc(day, 0, 0, tz)).toISOString();
  eq([midnight("2026-10-04", SYD), midnight("2026-10-05", SYD), midnight("2027-04-04", SYD), midnight("2027-04-05", SYD)],
    ["2026-10-03T14:00:00.000Z", "2026-10-04T13:00:00.000Z", "2027-04-03T13:00:00.000Z", "2027-04-04T14:00:00.000Z"], "bizToUtc: midnight in Sydney across both daylight-saving changes");
  eq([midnight("2026-07-01", "UTC"), midnight("2026-11-01", CHI)], ["2026-07-01T00:00:00.000Z", "2026-11-01T05:00:00.000Z"], "bizToUtc: UTC, and Chicago on its daylight-saving night");
  eq([bizTzOf({ region: { timeZone: "Europe/London" } }), bizTzOf({ region: { timeZone: "Mars/Base" } }), bizTzOf({ region: {} }), bizTzOf({}), bizTzOf(null)], ["Europe/London", SYD, SYD, SYD, SYD], "bizTzOf: the saved zone; a zone the runtime doesn't know or nothing saved = the default");
  eq([bizParts(NOW, SYD).day, bizParts(Date.parse("2026-10-13T20:00:00Z"), SYD).day, bizParts(Date.parse("2026-10-13T20:00:00Z"), "UTC").day, bizParts(NOW, CHI).day], ["2026-10-14", "2026-10-14", "2026-10-13", "2026-10-13"], "bizParts: the business day at an instant");
  eq([shiftDay("2026-10-31", 1), shiftDay("2026-03-01", -1), shiftDay("2028-02-28", 1)], ["2026-11-01", "2026-02-28", "2028-02-29"], "shiftDay");
  eq(rangeOf({}, SYD, NOW), { from: "2026-09-15", to: "2026-10-14", fromIso: "2026-09-14T14:00:00.000Z", toIso: "2026-10-14T13:00:00.000Z" }, "rangeOf: the last 30 days ending today in the business time zone");
  eq(rangeOf({}, CHI, NOW), { from: "2026-09-14", to: "2026-10-13", fromIso: "2026-09-14T05:00:00.000Z", toIso: "2026-10-14T05:00:00.000Z" }, "rangeOf: Chicago: 11:00 Wed in Sydney is still Tuesday there, and its days start at its midnight");
  const rerr = (a: any) => { try { rangeOf(a, SYD, NOW); return null; } catch (e) { return [(e as any) instanceof ToolError, (e as Error).message]; } };
  eq([rerr({ from: "2026-10-10", to: "2026-10-01" }), rerr({ from: "x" }), rerr({ from: "2025-01-01", to: "2026-02-04" }), rerr({ from: "2025-10-14", to: "2026-10-14" })],
    [[true, "'from' must be on or before 'to'."], [true, "'from' must be a date (YYYY-MM-DD)."], [true, "Pick a range of at most 366 days."], null], "rangeOf: refuses from > to, a non-date and more than 366 days (366 is fine)");
  eq(rangeOf({ to: "2026-10-01" }, "UTC", NOW).from, "2026-09-02", "rangeOf: only 'to' given = the 30 days ending then");
  {
    const zoned = (timeZone: unknown) => world({ settings: [{ id: 1, company_name: "Demo Home Services", gst_rate_percent: 10, catalog: { ...CAT, region: { ...CAT.region, timeZone } } }] });
    eq([(await loadBusiness(zoned("Mars/Base"))).tz, (await loadBusiness(zoned(undefined))).tz, (await loadBusiness(zoned(CHI))).tz], [SYD, SYD, CHI], "loadBusiness: the zone of Settings → Region and format; an invalid or missing one = the default");
    // automation_settings.timezone is not read any more (stage 1: one zone for the whole business)
    const w = world({ automation_settings: [{ business_id: "default", timezone: "Europe/London" }] });
    eq([(await loadBusiness(w)).tz, w.selects.some(([t]: any) => t === "automation_settings")], [SYD, false], "loadBusiness: never reads automation_settings");
    eq(await loadBusiness(world()), { companyName: "Demo Home Services", gstRate: 10, catalog: CAT, tz: SYD, office: "Office", mcp: { rateLimitPerMin: 60, logKeepDays: 90, importSource: "MCP import" } }, "loadBusiness");
    // the whole function in Chicago: whoami's day, and a list's default range
    const wc = zoned(CHI), kc = await keysFor(wc);
    const who = sc(await call(wc, kc["u-owner"], "whoami"));
    eq([who.timeZone, who.today], [CHI, "2026-10-13"], "whoami in Chicago: its zone and its day");
  }

  // ── arguments ──
  const lim = TOOLS.find((t) => t.name === "list_tasks")!.inputSchema;
  eq(validateArgs(lim, undefined), { ok: true, value: { limit: 50 } }, "validateArgs: no arguments = the defaults");
  eq([validateArgs(lim, { limit: 0 }).ok, validateArgs(lim, { limit: 501 }).ok, validateArgs(lim, { limit: 2.5 }).ok, validateArgs(lim, { limit: "5" }).ok, validateArgs(lim, { limit: 500 }).ok], [false, false, false, false, true], "validateArgs: limit is a whole number 1–500");
  eq(validateArgs(lim, { nope: 1 }).error, "Invalid arguments: nope is not a field of this tool.", "validateArgs: unknown field");
  eq([validateArgs(lim, [1]).ok, validateArgs(lim, "x").ok, validateArgs(lim, { mine: "yes" }).ok], [false, false, false], "validateArgs: arguments are an object; booleans are booleans");
  eq(validateArgs(TOOLS.find((t) => t.name === "get_contact")!.inputSchema, {}).error, "Invalid arguments: id is required.", "validateArgs: required");

  // ── role parity with the app: canViewSection, for every person and section ──
  const SECTIONS = ["myDay", "crm", "dashboard", "crmOverview", "adsGoogle", "closings", "jobs", "payroll", "outstanding", "reminders", "openItems", "tasks", "reference", "settings", "finance"];
  const diffs: string[] = [];
  for (const p of PROFILES) for (const sec of SECTIONS) if (canViewSection(prof(p.id), sec) !== APP.canViewSection(appProf(p.id), sec)) diffs.push(p.id + "/" + sec);
  eq(diffs, [], "canViewSection: the server's answer equals the app's for every profile × section");
  eq([BASE_LISTS.services, BASE_LISTS.stages, BASE_LISTS.sources, STAGE_CORE, BASE_LABELS.stages, BASE_LABELS.sources], [APP.LEAD_DIVISIONS, APP.LEAD_STATUSES, APP.LEAD_SOURCES, APP.STAGE_CORE, APP.LEAD_STAGE_LABEL, APP.LEAD_SOURCE_LABEL],
    "imports: the built-in services, stages, sources and their labels are the app's (an import checks values against the same lists)");
  // RLS-only rules (the app asks no section for these): pinned to the policies as written in the database —
  // ad_spend: role in (owner, manager) or permissions ->> 'crmOverview' / 'adsGoogle' is true; ad_calls: owner, manager.
  {
    const policyAdSpend = (row: any) => ["owner", "manager"].includes(row.role) || row.permissions?.crmOverview === true || row.permissions?.adsGoogle === true;
    const policyAdCalls = (row: any) => ["owner", "manager"].includes(row.role);
    const extra = [
      { id: "x-fin", role: "va", permissions: { finance: true } }, { id: "x-ads", role: "va", permissions: { adsGoogle: true } },
      { id: "x-ov", role: "marketing", permissions: { crmOverview: true } }, { id: "x-none", role: "marketing", permissions: {} },
      { id: "x-tech", role: "technician", permissions: { adsGoogle: true } },
    ];
    const rlsDiffs: string[] = [];
    for (const row of [...PROFILES, ...extra] as any[]) {
      const s = scopeOf(appProfile(row));
      if (adSpendVisible(s) !== policyAdSpend(row)) rlsDiffs.push(row.id + "/ad_spend");
      if (adCallsVisible(s) !== policyAdCalls(row)) rlsDiffs.push(row.id + "/ad_calls");
    }
    eq(rlsDiffs, [], "RLS-only rules: adSpendVisible / adCallsVisible equal the ad_spend and ad_calls policies for every profile");
  }

  // ── role parity with the app: filterForProfile (non-technicians: the same rows; technicians: a subset) ──
  {
    const S = JSON.parse(JSON.stringify(SEED)), data = appData();
    const sub = (a: string[], b: string[]) => a.every((x) => b.includes(x));
    for (const p of PROFILES) {
      const app = APP.filterForProfile(data, appProf(p.id)), s = scopeOf(prof(p.id));
      const server = {
        jobs: ids(S.jobs.filter((r: any) => jobVisible(s, r))), equipmentSpend: ids(S.equipment_spend.filter((r: any) => equipVisible(s, r))),
        tasks: ids(S.tasks.filter((r: any) => taskVisible(s, r))), contacts: contactVisible(s) ? ids(S.contacts) : [], closings: ids(S.closings.filter((r: any) => closingVisible(s, r))),
      };
      const mine = { jobs: ids(app.jobs), equipmentSpend: ids(app.equipmentSpend), tasks: ids(app.tasks), contacts: ids(app.contacts), closings: ids(app.closings) };
      if (p.role !== "technician") eq(server, mine, `filterForProfile parity: ${p.id} sees exactly the app's rows`);
      else eq(Object.keys(mine).filter((k) => !sub((server as any)[k], (mine as any)[k])), [], `filterForProfile parity: technician ${p.id} sees a subset of the app's rows`);
    }
    const sGuy = scopeOf(prof("u-gabe")), sAle = scopeOf(prof("u-alex")), sTal = scopeOf(prof("u-tal"));
    eq(ids(S.jobs.filter((r: any) => jobVisible(sGuy, r))), ids(APP.filterForProfile(data, appProf("u-gabe")).jobs), "technician: own jobs equal the app's");
    eq([ids(S.closings.filter((r: any) => closingVisible(sAle, r))), ids(APP.filterForProfile(data, appProf("u-alex")).closings)], [["cl2"], ["cl1", "cl2"]], "technician: only their own closings (the app shows all with the Closings page)");
    eq([ids(S.jobs.filter((r: any) => jobVisible(sTal, r))), ids(APP.filterForProfile(data, appProf("u-tal")).jobs)], [[], ["j6"]], "technician without a technician name: no jobs (the app would show the unassigned job)");
    eq([jobVisible(sTal, { technician: "" }), equipVisible(sTal, { technician: "" }), closingVisible(sTal, { technician_name: "" }), taskVisible(sTal, { board: "", assignees: [""] })], [false, false, false, false], "technician without a technician name: nothing matches an empty name either");
    eq(ids(S.tasks.filter((r: any) => taskVisible(sGuy, r))), ["t2", "t3"], "technician tasks: assigned to him (t3) or on his board (t2)");
    eq([Object.keys(redactForTech(sAle, S.contacts[0])).includes("estimated_value"), Object.keys(redactForTech(scopeOf(prof("u-riley")), S.contacts[0])).includes("estimated_value")], [false, true], "redactForTech: a contact's money only goes to non-technicians");
    eq([assigneeNames(S.tasks[0]), assigneeNames(S.tasks[3]), APP.assigneeNames(APP.mapTaskRow(S.tasks[3]))], [["Riley"], [], []], "assigneeNames reads a row as the app does (a missing assignees list is an empty one)");
  }

  // ── calc parity with the app (the app's functions run on the same fixture) ──
  {
    const data = appData(); APP.STATE.data = data;
    const d = serverCalc();
    // weekBounds / payrollWeekOf for several week changes (a short 5-day and a long 10-day transition week, two changes),
    // over two months and across both daylight-saving changes.
    const REGIONS = [{}, CAT.region, { weeks: [{ weekStart: 4, from: "2026-10-05" }] }, { weeks: [{ weekStart: 3, from: "2026-10-04" }, { weekStart: 0, from: "2026-11-01" }, { weekStart: 9, from: "2026-10-20" }] }];
    const bad: string[] = [];
    for (const reg of REGIONS) {
      const rs = weekRules(reg), ar = APP.weekRules(reg);
      eq(rs, ar, "weekRules parity " + JSON.stringify(reg));
      for (const start of ["2026-09-20", "2027-03-20"]) for (let i = 0, day = start; i < 75; i++, day = shiftDay(day, 1)) {
        const a = weekBounds(day, rs), b = APP.weekBounds(day, ar);
        if (JSON.stringify(a) !== JSON.stringify(b)) bad.push(JSON.stringify([reg, day, a, b]));
      }
    }
    eq(bad.slice(0, 3), [], "weekBounds parity: every day, every rule set");
    eq([weekBounds("2026-10-08", weekRules(CAT.region)), weekBounds("2026-10-05", weekRules(REGIONS[2])).days], [{ start: "2026-10-07", end: "2026-10-11", days: 5 }, 10], "weekBounds: the 5-day and the 10-day transition weeks");
    const keys = ["2026-09-27", "2026-10-04", "2026-10-07", "2026-10-12", "2026-10-19"];
    eq(keys.map((k) => [payrollWeekOf(d, k), shiftPayrollWeek(d, k, 1), shiftPayrollWeek(d, k, -2)]), keys.map((k) => [APP.payrollWeekOf(k), APP.shiftPayrollWeek(k, 1), APP.shiftPayrollWeek(k, -2)]), "payrollWeekOf / shiftPayrollWeek parity");
    // Commission: Alex is an Independent Contractor (no parts taken off): j3 = 500 × 40% = 200 (a regular technician: (500 − 50) × 40% = 180).
    const j3 = jobFromRow(SEED.jobs[2]), j1 = jobFromRow(SEED.jobs[0]);
    eq([jobCommissionAmount(d, j3), APP.jobCommissionAmount(APP.mapJobRow(SEED.jobs[2])), jobCommissionAmount({ ...d, employees: [] }, j3)], [200, 200, 180], "jobCommissionAmount: Independent Contractor (parts not deducted) = the app's");
    eq([jobCommissionAmount(d, j1), APP.jobCommissionAmount(APP.mapJobRow(SEED.jobs[0])), jobGst(d, j1), jobTotalCollected(d, j1)], [54, 54, 20, 220], "jobCommissionAmount: a regular technician (200 − 20 parts) × 30% = 54; GST 20, total 220");
    const pick = (x: any) => [x.total, x.grandTotal, x.onHoldTotal, x.expected, x.materials.total, x.bonus.total, x.cash, x.percent];
    for (const k of keys) for (const person of ["Gabe", "Alex"]) {
      const s = computePayrollCommission(d, person, k), a = APP.computePayrollCommission(data, person, k);
      eq([...pick(s), s.paidJobs, s.unpaidJobs, s.materials.gst], [...pick(a), a.lines.length, a.unpaid.length, a.materials.gst], `computePayrollCommission parity ${person} ${k}`);
      const h = computePayrollHourly(d, "Riley", k), ah = APP.computePayrollHourly(data, "Riley", k);
      eq([h.hours, h.bookings, h.bonuses, h.total, h.extra.total], [ah.hours, ah.bookings, ah.bonuses, ah.total, ah.extra.total], `computePayrollHourly parity Riley ${k}`);
    }
    // Hand-computed: Gabe, week Wed 7–Sun 11: j2 paid 9 Oct, 300 × 30% = 90; the Vacuum (110) and j1's parts (20) were entered
    // in the week of 4 Oct, which is already paid, so they move to this week: 130 (GST in it 130 × 10/110 = 11.82). 90 + 130 = 220.
    const g7 = computePayrollCommission(d, "Gabe", "2026-10-07");
    eq([g7.total, g7.materials, g7.grandTotal, g7.cash, g7.expected], [90, { total: 130, gst: 11.82, count: 2 }, 220, 0, 0], "Gabe, week of 7 Oct (hand-computed)");
    // Gabe, week Mon 12–Sun 18: j5 (250 × 30% = 75) is on hold; j4 unpaid (150 × 30% = 45 expected); j5 was cash (275); bonus 50.
    const g12 = computePayrollCommission(d, "Gabe", "2026-10-12");
    eq([g12.total, g12.onHoldTotal, g12.expected, g12.cash, g12.bonus.total, g12.grandTotal, g12.percent], [0, 75, 45, 275, 50, 50, 30], "Gabe, week of 12 Oct (hand-computed)");
    // Gabe, week of 4 Oct (marked paid): j1 = 54, cash 220, and only what was paid back in it (the Hose, 30).
    const g4 = computePayrollCommission(d, "Gabe", "2026-10-04");
    eq([g4.total, g4.cash, g4.materials.total, g4.grandTotal], [54, 220, 30, 84], "Gabe, week of 4 Oct (hand-computed)");
    // Riley, Wed 7–Sun 11: 7 Oct 4 h × $10, 4 bookings (no bonus under 5) = 40; 8 Oct (new pay) 6 h × $12 + 6 bookings → $20 = 92;
    // plus the owners' $20 bonus = 152. Mon 12–Sun 18: 13 Oct 5 h × $12 + 12 bookings → $20 = 80.
    const r7 = computePayrollHourly(d, "Riley", "2026-10-07"), r12 = computePayrollHourly(d, "Riley", "2026-10-12");
    eq([r7.hours, r7.bookings, r7.bonuses, r7.total, r12.total], [10, 10, 20, 152, 80], "Riley's hourly pay with a pay change mid-week (hand-computed)");
    eq([payrollCommissionPeople(d), payrollHourlyPeople(d)], [APP.payrollCommissionPeople(data), APP.payrollHourlyPeople(data)], "payroll people parity");
    // The money of one business week = the app's computeWeek (all but paidToTechTotal).
    for (const k of ["2026-10-04", "2026-10-07", "2026-10-12"]) {
      const wk = payrollWeekOf(d, k), app = APP.computeWeek(data, k);
      const J = d.jobs.filter((j: any) => j.date >= wk.start && j.date <= wk.end), E = d.equipmentSpend.filter((e: any) => e.date >= wk.start && e.date <= wk.end);
      const m = moneyOverview(d, J, E), { paidToTechTotal: _x, ...ov } = app.overview;
      eq([m.overview, m.remainingAfterTech], [ov, app.remainingAfterTech], "moneyOverview parity with computeWeek " + k);
    }
    // Hand-computed, Wed 7–Sun 11: j2 300 bank, j3 500 + 50 GST card, j7 400 unpaid; parts 50; commission 90 + 200 + 160 = 450;
    // left after technicians 1200 − 450 − 50 = 700.
    const m7 = moneyOverview(d, d.jobs.filter((j: any) => j.date >= "2026-10-07" && j.date <= "2026-10-11"), []);
    eq([m7.overview.bankTransfer, m7.overview.creditCard, m7.overview.gstOther, m7.overview.paidTotal, m7.overview.unpaidTotal, m7.overview.commissionOwedTotal, m7.remainingAfterTech], [300, 550, 50, 800, 400, 450, 700], "moneyOverview, week of 7 Oct (hand-computed)");
  }

  // ── keys: create_token, stored only as a hash ──
  const sb = world();
  const K = await keysFor(sb);
  eq([Object.keys(K).filter((id) => !LEGACY.has(K[id])), sb.T.mcp_tokens.filter((x: any) => x.name === "Laptop").map((x: any) => x.user_id)], [["u-owner", "u-mgr"], ["u-owner", "u-mgr"]], "create_token: keys for owners and managers");
  {
    // keys are for owners and managers only (Ofek 15 Oct): anyone else is refused, an old per-person switch or not
    const n0 = sb.T.mcp_tokens.length;
    const refused = await Promise.all(["u-riley", "u-pia", "u-gabe", "u-mkt"].map((id) => manage(sb, "create_token", id, { name: "Mine" })));
    eq([refused.map((r) => r.status), refused.map((r) => r.body.reason), sb.T.mcp_tokens.length - n0], [[403, 403, 403, 403], Array(4).fill("Only owners and managers can make keys."), 0], "create_token: only owners and managers (permissions.mcp switched on means nothing)");
    eq([canUseMcp(prof("u-owner")), canUseMcp(prof("u-mgr")), canUseMcp(prof("u-riley")), canUseMcp(prof("u-pia")), canUseMcp(prof("u-gabe")), canUseMcp(prof("u-mkt"))], [true, true, false, false, false, false], "canUseMcp: owners and managers only");
  }
  {
    const r = await manage(sb, "create_token", "u-owner", { name: "  Claude   desktop  " });
    eq([r.status, r.body.ok, r.body.name, TOKEN_RE.test(r.body.token), r.body.prefix, r.body.url, r.body.pathUrl], [200, true, "Claude desktop", true, r.body.token.slice(0, 12), "https://example.supabase.co/functions/v1/mcp", "https://example.supabase.co/functions/v1/mcp/t/" + r.body.token], "create_token: returns the key, its prefix and both URLs once");
    const row = sb.T.mcp_tokens.find((x: any) => x.id === r.body.id);
    eq([row.token_hash, row.token_prefix, row.scopes, row.business_id, row.user_id, "token" in row], [await sha256Hex(r.body.token), r.body.prefix, ["read"], "default", "u-owner", false], "create_token: only the sha256 is stored");
    ok(!JSON.stringify(sb.T).includes(r.body.token) && !Object.values(K).some((k) => JSON.stringify(sb.T).includes(k)), "create_token: no table row ever holds a key");
  }

  // ── protocol ──
  const O = K["u-owner"];
  {
    const init = await rpc(sb, O, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    eq([init.status, init.body.result.protocolVersion, init.body.result.serverInfo.name, init.body.result.serverInfo.title, init.body.result.capabilities], [200, "2025-03-26", "ops-mcp", "Demo Home Services (OPS)", { tools: { listChanged: false } }], "initialize: echoes a supported protocol version");
    eq(init.body.result.instructions, "Read-only access to Demo Home Services as Odette (owner). Only what this person can see in the OPS app. Dates are in Australia/Sydney.", "initialize: instructions");
    eq((await rpc(sb, O, "initialize", { protocolVersion: "1999-01-01" })).body.result.protocolVersion, "2025-06-18", "initialize: an unknown version is answered with the latest");
    const note = await http(sb, { token: O, body: { jsonrpc: "2.0", method: "notifications/initialized" } });
    eq([note.status, note.text], [202, ""], "notifications/initialized → 202, empty body");
    eq((await http(sb, { token: O, body: { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } } })).status, 202, "notifications/cancelled → 202");
    eq((await http(sb, { token: O, body: { jsonrpc: "2.0", id: 9, result: {} } })).status, 202, "a client's JSON-RPC answer → 202");
    const ping = await rpc(sb, O, "ping");
    eq([ping.status, ping.body], [200, { jsonrpc: "2.0", id: rid, result: {} }], "ping → {}");
    eq((await rpc(sb, O, "resources/list")).body.error, { code: -32601, message: "Method not found" }, "unknown method → -32601");
    const parse = await http(sb, { token: O, raw: "{nope" });
    eq([parse.status, parse.body.error.code], [400, -32700], "non-JSON body → 400 -32700");
    const batch = await http(sb, { token: O, body: [{ jsonrpc: "2.0", id: 1, method: "ping" }] });
    eq([batch.status, batch.body.error], [400, { code: -32600, message: "Invalid Request (batches are not supported)" }], "a batch → 400 -32600");
    eq([(await http(sb, { token: O, body: { id: 1, method: "ping" } })).body.error.code, (await http(sb, { token: O, body: { jsonrpc: "2.0", id: 1 } })).body.error.code], [-32600, -32600], "jsonrpc or method missing → -32600");
    for (const m of ["GET", "DELETE"]) { const r = await http(sb, { token: O, method: m }); eq([r.status, r.headers.get("allow")], [405, "POST"], `${m} /mcp → 405 Allow: POST`); }
    const opt = await http(sb, { method: "OPTIONS" });
    const allow = String(opt.headers.get("access-control-allow-headers"));
    eq([opt.status, allow.includes("mcp-protocol-version"), allow.includes("mcp-session-id"), opt.headers.get("access-control-allow-origin")], [204, true, true, "*"], "OPTIONS → 204 with the MCP headers allowed");
    eq((await rpc(sb, O, "ping", undefined, { headers: { "mcp-protocol-version": "2030-01-01" } })).status, 400, "an unsupported mcp-protocol-version header → 400");
    eq((await rpc(sb, O, "ping", undefined, { headers: { "mcp-protocol-version": "2025-06-18" } })).status, 200, "a supported mcp-protocol-version header is fine");
    eq((await http(sb, { token: O, path: "/functions/v1/mcp/foo", body: {} })).status, 404, "an unknown path → 404");
    eq((await rpc(sb, O, "ping", undefined, { path: "/mcp" })).status, 200, "the path without /functions/v1 works too");
  }

  // ── auth ──
  {
    const w = world(), keys = await keysFor(w), k = keys["u-mgr"];
    const logBefore = w.T.mcp_access_log.length;
    logged.length = 0;
    const none = await http(w, { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    eq([none.status, none.headers.get("www-authenticate"), none.body.error.code, none.body.id], [401, 'Bearer realm="ops-mcp"', -32001, 1], "no key → 401 with WWW-Authenticate and -32001");
    const wrong = newToken();
    const bad = [await rpc(w, "sb_publishable_x", "ping"), await rpc(w, "jwt-u-owner", "ping"), await rpc(w, wrong, "ping"), await http(w, { path: "/mcp/t/garbage", body: { jsonrpc: "2.0", id: 1, method: "ping" } })];
    eq(bad.map((r) => r.status), [401, 401, 401, 401], "a Supabase key, a user token, a wrong key and a bad path key → 401");
    eq((await rpc(w, k, "initialize", {})).status, 200, "initialize needs a key, and works with one");
    eq([(await rpc(w, k, "ping")).status, (await http(w, { path: "/functions/v1/mcp/t/" + k, body: { jsonrpc: "2.0", id: 1, method: "ping" } })).status], [200, 200], "the same key works as a bearer header and in the path");
    eq([w.T.mcp_access_log.length - logBefore, w.T.mcp_access_log[w.T.mcp_access_log.length - 1].tool], [1, "initialize"], "unauthenticated requests and ping write no log row; initialize writes one (it counts toward the rate limit)");
    ok(logged.length > 0 && !logged.some((l) => l.includes("ops_mcp_") || l.includes(wrong)), "a refused key is warned about, never written out");
    const id = w.T.mcp_tokens.find((x: any) => x.user_id === "u-mgr").id;
    eq((await manage(w, "revoke_token", "u-mgr", { id })).status, 200, "revoke own key");
    eq((await rpc(w, k, "ping")).status, 401, "a revoked key → 401");
    w.T.profiles = w.T.profiles.filter((p: any) => p.id !== "u-mkt");
    // the gate: a key of anyone but an owner or manager (made before 15 Oct, when a switch existed) stops working
    const old = ["u-riley", "u-dana", "u-gabe", "u-alex", "u-tal", "u-mkt2"].map((id) => http(w, { token: keys[id], body: { jsonrpc: "2.0", id: 1, method: "tools/list" } }));
    eq((await Promise.all(old)).map((r) => r.status), [401, 401, 401, 401, 401, 401], "a key of a VA, technician or marketing person (permissions.mcp still on) → 401");
    eq((await http(w, { path: "/functions/v1/mcp/t/" + keys["u-riley"], body: { jsonrpc: "2.0", id: 1, method: "ping" } })).status, 401, "… in the path too");
    const mk = (await manage(w, "create_token", "u-mgr", { name: "Phone" })).body.token;
    eq((await rpc(w, mk, "ping")).status, 200, "a manager's new key works");
    const mgr = w.T.profiles.find((p: any) => p.id === "u-mgr");
    mgr.role = "va";
    eq((await rpc(w, mk, "ping")).status, 401, "a manager made a VA: their key stops working");
    mgr.role = "manager";
    w.T.profiles = w.T.profiles.filter((p: any) => p.id !== "u-mkt");
    eq((await rpc(w, keys["u-mkt"], "ping")).status, 401, "a key whose person's profile is gone → 401");
    eq((await manage(w, "revoke_token", "u-owner", { id: w.T.mcp_tokens.find((x: any) => x.user_id === "u-mkt").id })).status, 200, "an owner can still revoke someone else's old key");
    banCache.clear();
    const banned = fakeDb(JSON.parse(JSON.stringify(w.T)), { users: { ...USERS(), "u-mgr": { id: "u-mgr", banned_until: "2027-01-01T00:00:00Z" } }, jwts: JWTS });
    eq([(await rpc(banned, mk, "ping")).status, (await rpc(banned, keys["u-owner"], "ping")).status], [401, 200], "a person whose sign-in is switched off → 401");
    banCache.clear();
    const other = newToken();
    w.T.mcp_tokens.push({ id: crypto.randomUUID(), business_id: "other", user_id: "u-owner", name: "x", token_prefix: tokenPrefix(other), token_hash: await sha256Hex(other), scopes: ["read"], revoked_at: null, last_used_at: null });
    eq((await rpc(w, other, "ping")).status, 401, "a key of another business → 401");
  }

  // ── last_used_at: at most once a minute ──
  {
    const w = world(), keys = await keysFor(w), row = w.T.mcp_tokens.find((x: any) => x.user_id === "u-owner");
    const T0 = NOW + 3_600_000;
    eq(row.last_used_at ?? null, null, "a new key has never been used");
    await rpc(w, keys["u-owner"], "ping", undefined, { at: T0 });
    eq(row.last_used_at, new Date(T0).toISOString(), "last_used_at is set on first use");
    await rpc(w, keys["u-owner"], "ping", undefined, { at: T0 + 30_000 });
    eq(row.last_used_at, new Date(T0).toISOString(), "not rewritten within 60 s");
    await rpc(w, keys["u-owner"], "ping", undefined, { at: T0 + 61_000 });
    eq(row.last_used_at, new Date(T0 + 61_000).toISOString(), "rewritten after 61 s");
  }

  // ── rate limit ──
  {
    const w = world(), keys = await keysFor(w), k = keys["u-mgr"], T0 = NOW + 7_200_000;
    w.T.settings[0].catalog = { ...CAT, mcp: { rateLimitPerMin: 3 } };
    const r = [];
    for (let i = 0; i < 4; i++) r.push(await call(w, k, "whoami", {}, { at: T0 + i * 1000 }));
    eq(r.map((x) => x.status), [200, 200, 200, 429], "with 3 a minute, the 4th call within 60 s → 429");
    eq([r[3].headers.get("retry-after"), r[3].body.error], ["60", { code: -32029, message: "Too many calls: at most 3 a minute. Try again in a minute." }], "429: Retry-After 60 and -32029");
    eq(w.T.mcp_access_log.map((x: any) => x.status), ["ok", "ok", "ok", "rate_limited"], "the refused call is logged rate_limited");
    eq((await call(w, k, "whoami", {}, { at: T0 + 3000 + 61_000 })).status, 200, "calls older than 60 s don't count");
    await call(w, k, "whoami", {}, { at: T0 + 64_100 }); await call(w, k, "whoami", {}, { at: T0 + 64_200 });
    eq((await call(w, keys["u-owner"], "whoami", {}, { at: T0 + 64_500 })).status, 429, "the limit is per business: the owner's key shares the manager's minute (3 calls by the manager → the owner's 4th is refused)");
    eq((await call(w, keys["u-owner"], "whoami", {}, { at: T0 + 125_000 })).status, 200, "… and a quiet minute later it works again");
    // initialize and tools/list count too (and are refused the same way)
    const T1 = T0 + 600_000;
    const seq = [await rpc(w, k, "initialize", {}, { at: T1 }), await rpc(w, k, "tools/list", undefined, { at: T1 + 1 }), await call(w, keys["u-owner"], "whoami", {}, { at: T1 + 2 }), await rpc(w, k, "tools/list", undefined, { at: T1 + 3 }), await rpc(w, k, "initialize", {}, { at: T1 + 4 }), await rpc(w, k, "ping", undefined, { at: T1 + 5 })];
    eq(seq.map((x) => x.status), [200, 200, 200, 429, 429, 200], "initialize and tools/list count toward the business's limit (3 a minute); ping never does");
    eq([seq[3].body.error.code, seq[3].headers.get("retry-after"), w.T.mcp_access_log.slice(-5).map((x: any) => x.tool + ":" + x.status)], [-32029, "60", ["initialize:ok", "tools/list:ok", "whoami:ok", "tools/list:rate_limited", "initialize:rate_limited"]], "… logged as their own rows");
    eq((await loadBusiness(world())).mcp.rateLimitPerMin, 60, "with nothing saved the limit is 60");
  }

  // ── tools/list per role ──
  {
    const names = async (k: string) => (await rpc(sb, k, "tools/list")).body.result.tools.map((t: any) => t.name);
    const list = (await rpc(sb, O, "tools/list")).body.result.tools;
    eq([list.map((t: any) => t.name), list.every((t: any) => JSON.stringify(t.annotations) === JSON.stringify({ readOnlyHint: true, destructiveHint: false, openWorldHint: false }) && t.inputSchema.additionalProperties === false && t.title && t.description)], [ALL_TOOLS, true], "owner: all 11 tools, each read-only with a closed schema");
    eq(await names(K["u-mgr"]), ALL_TOOLS, "manager: all 11 tools");
    {
      const wv = world({ settings: [{ id: 1, company_name: "Demo Home Services", gst_rate_percent: 20, catalog: { ...CAT, region: { ...CAT.region, country: "GB" } } }] }), kv = await keysFor(wv);
      const d = (list: any[], n: string) => list.find((t: any) => t.name === n).description;
      const uk = (await rpc(wv, kv["u-owner"], "tools/list")).body.result.tools;
      eq([d(list, "list_jobs").includes("before GST, GST,"), d(uk, "list_jobs").includes("before VAT, VAT,"), /\bGST\b/.test(d(uk, "money_summary"))], [true, true, false], "tools/list: the tax goes by the business's own name (GST here, VAT in the UK)");
    }
    eq(await names(K["u-riley"]), ["whoami", "search_contacts", "get_contact", "list_jobs", "list_closings", "list_outstanding", "payroll_summary", "list_tasks", "list_calls"], "VA (default pages): no money or marketing summary");
    eq(await names(K["u-dana"]), ["whoami", "search_contacts", "get_contact", "list_jobs", "list_closings", "list_outstanding", "payroll_summary", "list_calls"], "VA without Tasks: no list_tasks");
    eq(await names(K["u-gabe"]), ["whoami", "list_jobs", "payroll_summary", "list_tasks"], "technician (default pages): own jobs, own pay, tasks");
    eq(await names(K["u-alex"]), ["whoami", "search_contacts", "get_contact", "list_jobs", "list_closings", "payroll_summary", "list_tasks", "list_calls"], "technician with Jobs, CRM, Closings, Outstanding, Leads and Ads pages: still no money, marketing or outstanding");
    eq(await names(K["u-mkt"]), ["whoami", "marketing_summary"], "marketing: whoami and marketing_summary");
    eq(await names(K["u-mkt2"]), ["whoami", "search_contacts", "get_contact", "marketing_summary"], "marketing with Leads & Marketing: contacts too");
    const before = sb.T.mcp_access_log.length;
    const hidden = await call(sb, K["u-gabe"], "money_summary", {});
    eq([hidden.body.error, sb.T.mcp_access_log.length - before, sb.T.mcp_access_log[sb.T.mcp_access_log.length - 1].status], [{ code: -32602, message: "Unknown tool: money_summary" }, 1, "denied"], "a hidden tool looks unknown, and is logged denied");
    eq((await call(sb, O, "no_such_tool", {})).body.error.message, "Unknown tool: no_such_tool", "an unknown tool → -32602");
    eq((await rpc(sb, K["u-gabe"], "tools/call", {})).body.error.code, -32602, "tools/call without a name → -32602");
  }

  // ── the access log ──
  {
    const L = sb.T.mcp_access_log, n0 = L.length;
    await rpc(sb, O, "ping");
    eq(L.length, n0, "ping writes no row");
    const r = await call(sb, K["u-riley"], "list_tasks", { mine: true });
    const last = () => L[L.length - 1];
    eq([L.length - n0, last().status, last().rows_returned, last().token_id, last().user_id, last().business_id, last().tool, last().args_summary], [1, "ok", sc(r).rows.length, sb.T.mcp_tokens.find((x: any) => x.user_id === "u-riley").id, "u-riley", "default", "list_tasks", '{"mine":true,"limit":50}'.replace(',"limit":50', "")], "ok: one row with the key, the person, the tool and rows_returned");
    const e1 = await call(sb, K["u-riley"], "search_contacts", { query: "a", secret: "s3cr3t" });
    eq([errText(e1), last().status, last().args_summary], ["Invalid arguments: secret is not a field of this tool.", "error", '{"query":"a"}'], "bad arguments: isError, logged error, and an extra 'secret' never reaches the log");
    const e2 = await call(sb, K["u-riley"], "search_contacts", { query: "q".repeat(500) });
    eq([errText(e2), last().args_summary], ["Invalid arguments: query is too long (at most 60 characters).", JSON.stringify({ query: "q".repeat(60) })], "a 500-character query is clipped to 60 in the log");
    const e3 = await call(sb, O, "list_jobs", { from: "2026-10-10", to: "2026-10-01" });
    eq([errText(e3), last().status], ["'from' must be on or before 'to'.", "error"], "a ToolError: isError, logged error");
    const broken = world({}, { fail: ["tasks"] }), bk = await keysFor(broken);
    const e4 = await call(broken, bk["u-owner"], "list_tasks", {});
    eq([errText(e4), broken.T.mcp_access_log[broken.T.mcp_access_log.length - 1].status], ["Something went wrong reading the data.", "error"], "a failing read: a plain isError, logged error");
    ok(L.every((x: any) => x.args_summary.length <= 300 && x.tool.length <= 64), "every args_summary ≤ 300 and tool ≤ 64 characters");
  }

  // ── each tool, per role ──
  {
    const who = sc(await call(sb, K["u-gabe"], "whoami"));
    eq(who, { name: "Gabe Green", role: "technician", technicianName: "Gabe", business: "Demo Home Services", timeZone: "Australia/Sydney", today: "2026-10-14", tools: ["whoami", "list_jobs", "payroll_summary", "list_tasks"] }, "whoami");
    const r = await call(sb, K["u-gabe"], "list_jobs");
    eq([ids(sc(r).rows), sc(r).from, sc(r).to, r.body.result.content[0].type, JSON.parse(r.body.result.content[0].text).count], [["j5", "j4", "j2", "j1"], "2026-09-15", "2026-10-14", "text", 4], "technician list_jobs: only his jobs, newest first, as text and structured content");
    eq(sc(r).rows[3], { id: "j1", date: "2026-10-05", customerName: "Customer j1", invoiceNumber: "INV-j1", technician: "Gabe", jobType: "Aircon", amount: 200, gst: 20, total: 220, commission: 54, paymentStatus: "Paid", paymentMethod: "Cash", datePaid: "2026-10-05", partsCost: 20, contactId: C1 }, "a job row");
    eq(errText(await call(sb, K["u-gabe"], "list_jobs", { technician: "Alex" })), "You can only see your own jobs.", "technician list_jobs for someone else → isError");
    eq(ids(sc(await call(sb, K["u-gabe"], "list_jobs", { technician: "Gabe" })).rows), ["j5", "j4", "j2", "j1"], "technician list_jobs naming himself is fine");
    eq(sc(await call(sb, K["u-tal"], "list_jobs")).rows, [], "technician without a technician name: no jobs");
    const all = sc(await call(sb, O, "list_jobs", { limit: 2 }));
    eq([ids(all.rows), all.count, all.truncated], [["j5", "j6"], 7, true], "owner list_jobs: every job, limit 2 → truncated");
    eq(ids(sc(await call(sb, K["u-riley"], "list_jobs", { unpaid_only: true })).rows), ["j6", "j4", "j7"], "unpaid_only includes a job with no payment status");
    eq(ids(sc(await call(sb, O, "list_jobs", { technician: "Alex", from: "2026-10-10", to: "2026-10-10" })).rows), ["j7"], "list_jobs by technician and day");

    // contacts
    const ale = sc(await call(sb, K["u-alex"], "search_contacts", {}));
    eq([ids(ale.rows), ale.rows.some((x: any) => "estimatedValue" in x || "salesValue" in x)], [[C2, C1, C3], false], "technician with CRM: contacts without their money values");
    const va = sc(await call(sb, K["u-riley"], "search_contacts", { query: "ann" }));
    eq(va.rows, [{ id: C1, name: "Ann Lee", phone: "0412345678", email: "ann@example.com", postcode: "2000", division: "Aircon", source: "Google Ads", status: "New", createdOn: "2026-10-10", nextFollowUp: "2026-10-16", tags: ["vip"], estimatedValue: 500, salesValue: 0 }], "VA search_contacts by name, with the values");
    eq(sc(await call(sb, O, "search_contacts", { status: "Won" })).rows.map((x: any) => [x.name, x.createdOn]), [["Bob Stone", "2026-10-14"]], "status filter; created_at shown as the Sydney day");
    eq([ids(sc(await call(sb, O, "search_contacts", { query: "345678" })).rows), sb.ors[sb.ors.length - 1].length], [[C1], 4], "phone digits search (4 clauses)");
    await call(sb, O, "search_contacts", { query: "a,b),or(id.eq.1*%:'\"\\" });
    eq([sb.ors[sb.ors.length - 1].length, sb.ors[sb.ors.length - 1].every((x: string) => !/[,()*%:'"\\]/.test(x.split(".").slice(2).join(".").replace(/^\*|\*$/g, "")))], [3, true], "a query with , ( ) * % : quotes is sanitized: exactly three or-clauses, no filter injection");
    const lim1 = sc(await call(sb, O, "search_contacts", { limit: 1 }));
    eq([lim1.rows.length, lim1.truncated], [1, true], "search_contacts: limit 1 of 3 → truncated");

    const gc = sc(await call(sb, K["u-riley"], "get_contact", { id: C1 }));
    eq([gc.customerNotes, "notes" in gc], [[{ text: "Dog in the yard", by: "Odette", at: "2026-10-13T01:00:00Z" }, { text: "Gate code 4321", by: "Riley", at: "2026-10-12T01:00:00Z" }, { text: "Two units", by: "", at: null }], false], "get_contact: the customer notes as the app shows them (newest first, the old single note last, empty ones left out), not the legacy notes column alone");
    eq([gc.name, gc.customerNotes.length, gc.messages.length, gc.messages[0].text, gc.messages[9].text.length, ids(gc.jobs), ids(gc.tasks), ids(gc.calls)], ["Ann Lee", 3, 10, "hello 2", 500, ["j1"], ["t1", "t5"], ["k1"]], "VA get_contact: details, the last 10 messages (clipped to 500), jobs, tasks and calls");
    const gm = sc(await call(sb, K["u-mkt2"], "get_contact", { id: C1 }));
    eq([gm.jobs, gm.tasks, "calls" in gm, gm.estimatedValue], [[], [], false, 500], "Leads & Marketing only: no jobs, tasks or calls");
    const gt = sc(await call(sb, K["u-alex"], "get_contact", { id: C1 }));
    eq([ids(gt.jobs), ids(gt.tasks), "estimatedValue" in gt, "salesValue" in gt], [[], ["t5"], false, false], "technician get_contact: only his own jobs and tasks, no money values");
    eq(errText(await call(sb, O, "get_contact", { id: "44444444-4444-4444-8444-444444444444" })), "No contact with that id.", "get_contact: not found");
    eq(errText(await call(sb, O, "get_contact", { id: "nope" })), "Invalid arguments: id must be an id.", "get_contact: a non-uuid → isError");

    // closings
    eq([ids(sc(await call(sb, K["u-alex"], "list_closings")).rows), ids(sc(await call(sb, K["u-riley"], "list_closings")).rows)], [["cl2"], ["cl2", "cl1"]], "list_closings: a technician only his own");
    eq(sc(await call(sb, K["u-riley"], "list_closings", { from: "2026-10-08", to: "2026-10-08" })).rows[0], { id: "cl1", date: "2026-10-08", technician: "Gabe", customerName: "Ann Lee", invoiceNumber: "INV-j2", jobType: "Aircon", totalInclGst: 300, includesGST: false, paymentStatus: "Paid", paymentMethod: "Bank Transfer", partsCost: 0, postedBy: "Riley", linkedJobId: "j2" }, "a closing row");

    // outstanding (the same three lists as the Outstanding page)
    const out = sc(await call(sb, K["u-riley"], "list_outstanding"));
    eq([out.rows.map((x: any) => [x.id, x.totalInclGst, x.daysWaiting]), out.unpaidTotal, ids(out.partsRefunds), ids(out.equipmentRefunds)], [[["j7", 400, 4], ["j4", 165, 2], ["j6", 100, 1]], 665, ["j1"], ["eq1"]], "list_outstanding: unpaid jobs oldest first (incl. GST), parts and equipment refunds (hand-computed)");
    {
      const data = appData(); APP.STATE.data = data;
      const f = APP.filterForProfile(data, appProf("u-riley"));
      eq([ids(f.jobs.filter((j: any) => j.paymentStatus !== "Paid").sort((a: any, b: any) => a.date.localeCompare(b.date))), ids(f.jobs.filter((j: any) => j.partsRefundStatus === "Pending Refund")), ids(f.equipmentSpend.filter((e: any) => e.reimbursed === "Pending"))],
        [ids(out.rows), ids(out.partsRefunds), ids(out.equipmentRefunds)], "list_outstanding parity with renderOutstanding's three lists");
    }

    // money
    const mo = sc(await call(sb, O, "money_summary", { from: "2026-10-07", to: "2026-10-11" }));
    {
      const data = appData(); APP.STATE.data = data;
      const app = APP.computeWeek(data, "2026-10-07");
      const { paidToTechTotal: _p, ...ov } = app.overview;
      eq([mo.overview, mo.remainingAfterTech], [Object.fromEntries(Object.entries(ov).map(([k, v]) => [k, k.endsWith("Count") ? v : APP.round2(v)])), APP.round2(app.remainingAfterTech)], "money_summary over one business week = the app's computeWeek");
    }
    eq([mo.jobsCount, mo.adSpend, mo.remainingAfterTechAndAds, mo.truncated], [3, { total: 120.5, byChannel: { "Google Ads": 120.5 } }, 579.5, false], "money_summary: ad spend and what is left after ads (700 − 120.5)");
    eq(Object.keys(sc(await call(sb, K["u-mgr"], "money_summary"))), ["from", "to", "jobsCount", "overview", "remainingAfterTech", "adSpend", "remainingAfterTechAndAds", "truncated"], "manager: money_summary");
    {
      // Finance alone (no Leads & Marketing, no Google Ads page): the money, but no ad figures (the ad_spend RLS).
      const fin = appProfile({ id: "u-fin", full_name: "Fin", role: "va", technician_name: null, permissions: { ...D("va"), finance: true, crmOverview: false, adsGoogle: false } });
      const tool = TOOLS.find((t) => t.name === "money_summary")!, sFin = scopeOf(fin);
      const out = (await tool.run({ sb, s: sFin, biz: await loadBusiness(sb), nowMs: NOW }, { from: "2026-10-07", to: "2026-10-11" })).payload;
      eq([tool.gate(sFin), "adSpend" in out, "remainingAfterTechAndAds" in out, out.remainingAfterTech, out.truncated], [true, false, false, mo.remainingAfterTech, false], "money_summary with Finance only: the money, no ad spend (gated like the ad_spend RLS, not by Finance)");
      const withAds = appProfile({ ...{ id: "u-fin2", full_name: "Fin Two", role: "va", technician_name: null }, permissions: { ...D("va"), finance: true, adsGoogle: true } });
      const out2 = (await tool.run({ sb, s: scopeOf(withAds), biz: await loadBusiness(sb), nowMs: NOW }, { from: "2026-10-07", to: "2026-10-11" })).payload;
      eq([out2.adSpend, out2.remainingAfterTechAndAds], [mo.adSpend, mo.remainingAfterTechAndAds], "money_summary with Finance and the Google Ads page: ad spend too");
    }

    // payroll
    const pg = sc(await call(sb, K["u-gabe"], "payroll_summary", { week: "2026-10-08" }));
    eq([pg.week, pg.rows.map((x: any) => x.person), pg.rows[0].commission.grandTotal, pg.rows[0].commission.materials, "hourly" in pg.rows[0], pg.rows[0].status], [{ start: "2026-10-07", end: "2026-10-11" }, ["Gabe"], 220, { total: 130, gst: 11.82, count: 2 }, false, { cashCollected: false, salaryPaid: false }], "technician payroll_summary: only himself (the 220 above)");
    {
      const data = appData(); APP.STATE.data = data;
      const mine = APP.filterForProfile(data, appProf("u-gabe"));
      const a = APP.computePayrollCommission(mine, "Gabe", "2026-10-12");
      const s = sc(await call(sb, K["u-gabe"], "payroll_summary", {})).rows[0].commission;
      eq([s.total, s.grandTotal, s.onHoldTotal, s.expected, s.cash, s.bonus.total], [a.total, a.grandTotal, a.onHoldTotal, a.expected, a.cash, a.bonus.total], "technician payroll_summary (this week) = the app's own pay page");
    }
    const pr = sc(await call(sb, K["u-riley"], "payroll_summary", { week: "2026-10-09" }));
    eq([pr.rows.map((x: any) => x.person), "commission" in pr.rows[0], pr.rows[0].hourly], [["Riley"], false, { person: "Riley", week: { start: "2026-10-07", end: "2026-10-11" }, hours: 10, bookings: 10, bonuses: 20, total: 152, extra: { total: 20 } }], "VA payroll_summary: only himself, the hourly block");
    for (const k of ["u-owner", "u-mgr"]) {
      const po = sc(await call(sb, K[k], "payroll_summary", { week: "2026-10-12" }));
      eq([po.rows.map((x: any) => x.person), po.rows.map((x: any) => [!!x.commission, !!x.hourly])], [["Alex", "Gabe", "Riley"], [[true, false], [true, false], [false, true]]], `${k}: payroll_summary for every active commission and hourly person (as the Payroll board)`);
    }
    const po = sc(await call(sb, O, "payroll_summary", { week: "2026-10-12" }));
    eq([po.rows[0].commission.total, po.rows[0].commission.expected, po.rows[1].commission.grandTotal, po.rows[2].hourly.total], [200, 160, 50, 80], "owner payroll numbers (Alex 200 / 160 expected, Gabe 50, Riley 80; hand-computed above)");

    // marketing
    const mk = sc(await call(sb, O, "marketing_summary", { from: "2026-10-01", to: "2026-10-14" }));
    eq([mk.adSpend, mk.adCalls, mk.leads, mk.costPerLead], [{ total: 271, byChannel: { "Google Ads": 220.5, Meta: 50.5 }, leadsReported: 3 }, { total: 3, answered: 2, missed: 1, over30s: 1, byCampaign: { "Aircon Sydney": 1, Chimney: 2 } }, { count: 2, bySource: { "Google Ads": 1, Facebook: 1 }, byDivision: { Aircon: 1, Chimney: 1 } }, 135.5], "owner marketing_summary: spend, ad calls, leads, cost per lead (271 / 2)");
    {
      const a = APP.summarizeCalls(SEED.ad_calls.map((c: any) => ({ status: c.status, durationSeconds: c.duration_seconds, campaign: c.campaign, account: c.account })));
      eq([mk.adCalls.total, mk.adCalls.answered, mk.adCalls.missed, mk.adCalls.over30s], [a.total, a.answered, a.missed, a.over30s], "ad calls: the app's summarizeCalls counts");
    }
    const mm = sc(await call(sb, K["u-mkt"], "marketing_summary", { from: "2026-10-01", to: "2026-10-14" }));
    eq([mm.adSpend.total, "adCalls" in mm, "leads" in mm], [271, false, false], "marketing: ad spend, no ad calls and no leads");
    const mm2 = sc(await call(sb, K["u-mkt2"], "marketing_summary", { from: "2026-10-14", to: "2026-10-14" }));
    eq(["adCalls" in mm2, mm2.leads, mm2.costPerLead], [false, { count: 1, bySource: { Facebook: 1 }, byDivision: { Chimney: 1 } }, null], "marketing with Leads & Marketing: leads of that Sydney day (Bob, 07:00 on 14 Oct), no ad calls");

    // tasks
    eq(ids(sc(await call(sb, K["u-riley"], "list_tasks", { mine: true })).rows), ["t3", "t1"], "VA list_tasks mine: only tasks assigned to Riley, earliest due first");
    eq(ids(sc(await call(sb, K["u-gabe"], "list_tasks")).rows), ["t3", "t2"], "technician list_tasks: assigned to him or on his board (no due date last)");
    eq(ids(sc(await call(sb, O, "list_tasks", { status: "To do" })).rows), ["t3", "t1", "t4"], "status filter");
    eq(ids(sc(await call(sb, K["u-riley"], "list_tasks", { limit: 1 })).rows), ["t5"], "list_tasks limit 1: the earliest due");
    const t = sc(await call(sb, K["u-riley"], "list_tasks", {})).rows.find((x: any) => x.id === "t1");
    eq([t.notes.length, t.subtasks, t.assignees, t.board, t.due], [300, 2, ["Riley"], "Riley", "2026-10-15"], "a task row (notes clipped to 300, subtasks counted)");
    // the office board (storage key 'ron') is shown by the office's name (catalog.labels.office, default "Office"), never by the key
    {
      const wo = world(), ko = await keysFor(wo);
      wo.T.tasks.push({ id: "t6", title: "Office task", board: "ron", status: "To do", due: null, assignees: [], assigned_to: null, contact_id: null });
      const boardOf = async () => sc(await call(wo, ko["u-owner"], "list_tasks", {})).rows.find((x: any) => x.id === "t6").board;
      const b1 = await boardOf();
      wo.T.settings[0].catalog = { ...CAT, labels: { office: "  Front desk team of the whole company  " } };
      const b2 = await boardOf();
      wo.T.settings[0].catalog = { ...CAT, labels: { office: "   " } };
      eq([b1, b2, await boardOf()], ["Office", "Front desk team of the whole c", "Office"], "list_tasks: the office board is \"Office\" or the business's own office name (trimmed, 30 characters), never 'ron'");
      eq([officeOf(null), officeOf({ labels: "x" }), officeOf({ labels: { office: "Desk" } })], ["Office", "Office", "Desk"], "officeOf: the app's officeLabel() rule");
    }

    // calls (dates in Sydney, across the daylight-saving change on 4 Oct)
    const k4 = sc(await call(sb, K["u-riley"], "list_calls", { from: "2026-10-04", to: "2026-10-04" }));
    eq([ids(k4.rows), k4.rows[0].contactName, k4.total, k4.missed, k4.missedOpen], [["k1"], "Ann Lee", 1, 1, 1], "list_calls on 4 Oct (Sydney): 14:00Z on the 3rd to 13:00Z on the 4th");
    const ka = sc(await call(sb, O, "list_calls", { from: "2026-10-01", missed_only: true }));
    eq([ids(ka.rows), ka.missed, ka.missedOpen, ka.rows[1].calledBackAt], [["k1", "k2"], 2, 1, "2026-10-04T00:00:00.000Z"], "list_calls missed_only, newest first; missedOpen = not called back");
    eq(sb.ranges.calls > 0 && !sb.selects.some(([, c]) => c.trim() === "*"), true, "every read names its columns");
  }

  // ── phone search, name lookups, payroll reads, outages, calls at the same moment ──
  {
    const C4 = "44444444-0000-4000-8000-000000000004";
    const wp = world({ contacts: [...JSON.parse(JSON.stringify(SEED.contacts)), { id: C4, full_name: "Dee Spaced", phone: "+61 491-570 006", email: "", postcode: "", status: "New", created_at: "2026-10-11T01:00:00Z", tags: [], messages: [] }] }), kp = await keysFor(wp);
    const find = async (q: string) => ids(sc(await call(wp, kp["u-owner"], "search_contacts", { query: q })).rows);
    eq([await find("0491570006"), await find("0491 570 006"), await find("491-570"), await find("0412 345 678")], [[C4], [C4], [C4], [C1]], "search_contacts: a phone stored with spaces, dashes or +61 is found by its digits, however they are typed");
    eq([phoneClause("0491 570 006"), phoneClause("12"), await find("0491 570 007")], [',phone.match."9[^0-9]*1[^0-9]*5[^0-9]*7[^0-9]*0[^0-9]*0[^0-9]*0[^0-9]*6"', "", []], "phoneClause: the last 8 digits with anything but a digit between them; another number doesn't match");

    const many = Array.from({ length: 150 }, (_, i) => ({ id: "kc" + String(i).padStart(3, "0"), direction: "inbound", from_number: "+614000000" + String(i).padStart(2, "0"), to_number: "+61290000000", status: "answered", missed: false, answered_by: "office", duration: 30, voicemail: false, started_at: new Date(Date.parse("2026-10-13T00:00:00Z") + i * 60000).toISOString(), callback_done_at: null, contact_id: "cc" + i }));
    const wc = world({ calls: many, contacts: many.map((k) => ({ id: k.contact_id, full_name: "Caller " + k.contact_id.slice(2), created_at: "2026-10-01T00:00:00Z" })) }), kc = await keysFor(wc);
    const nameReads = () => wc.selects.filter(([t, c]) => t === "contacts" && c === "id, full_name").length;
    const n0 = nameReads(), lc = sc(await call(wc, kc["u-owner"], "list_calls", { from: "2026-10-13", to: "2026-10-14", limit: 500 }));
    eq([lc.rows.length, lc.rows.every((r: any) => r.contactName === "Caller " + r.contactId.slice(2)), nameReads() - n0, NAME_CHUNK], [150, true, 2, 100], "list_calls: 150 contacts' names read in chunks of 100 (a short request address), every name found");

    // payroll_summary reads only what the week can use: years of old paid jobs change nothing and are never read
    const old = Array.from({ length: 40 }, (_, i) => job("old" + i, { date: "2025-0" + (1 + (i % 9)) + "-10", technician: i % 2 ? "Gabe" : "Alex", amount: 100, payment_status: "Paid", payment_method: "Cash", date_paid: "2025-0" + (1 + (i % 9)) + "-11" }));
    const wy = world({ jobs: [...JSON.parse(JSON.stringify(SEED.jobs)), ...old] }), ky = await keysFor(wy);
    let read = 0;
    const counting = { ...wy, from: (t: string) => { const b = wy.from(t); if (t !== "jobs") return b; const th = b.then; b.then = (res: any, rej: any) => th((out: any) => { read += (out.data || []).length; return res(out); }, rej); return b; } };
    for (const [who, week] of [["u-owner", "2026-10-12"], ["u-owner", "2026-10-08"], ["u-gabe", "2026-10-08"], ["u-riley", "2026-10-09"]]) {
      read = 0;
      const a = sc(await call(counting, ky[who], "payroll_summary", { week })), b = sc(await call(sb, K[who], "payroll_summary", { week }));
      eq([JSON.stringify(a) === JSON.stringify(b), a.truncated, read < 10], [true, false, true], `payroll_summary ${who} ${week}: the same answer with 40 old paid jobs in the table, which are never read`);
    }

    // a database or Auth outage is a 500, never "this key is revoked" (401)
    const wo = world(), ko = await keysFor(wo);
    banCache.clear();
    wo.ctl.authDown = true;
    const down = await rpc(wo, ko["u-mgr"], "ping");
    wo.ctl.authDown = false;
    eq([down.status, down.body.error.code, down.headers.get("www-authenticate")], [500, -32603, null], "Auth not answering → 500 internal error (no WWW-Authenticate), not 401");
    for (const t of ["mcp_tokens", "profiles"]) {
      const broken = fakeDb(JSON.parse(JSON.stringify(wo.T)), { users: USERS(), jwts: JWTS, fail: [t] });
      const r = await rpc(broken, ko["u-mgr"], "ping");
      eq([r.status, r.body.error.code], [500, -32603], `${t} not readable → 500, not 401`);
    }
    eq([(await rpc(wo, ko["u-mgr"], "ping")).status, logged.filter((l) => l.includes(ko["u-mgr"])).length], [200, 0], "after the outage the key works; no log line ever holds a key");
    banCache.clear();
    const gone = fakeDb(JSON.parse(JSON.stringify(wo.T)), { users: { ...USERS(), "u-mgr": undefined }, jwts: JWTS });
    eq((await rpc(gone, ko["u-mgr"], "ping")).status, 401, "a person whose account is gone (Auth 404) → 401");
    banCache.clear();

    // calls sent at the same moment: each counts only the log rows written before its own
    const wr = world(), kr = await keysFor(wr), T0 = NOW + 9_000_000;
    wr.T.settings[0].catalog = { ...CAT, mcp: { rateLimitPerMin: 3 } };
    const burst = await Promise.all(Array.from({ length: 7 }, () => call(wr, kr["u-mgr"], "whoami", {}, { at: T0 })));
    eq([burst.filter((r) => r.status === 200).length, burst.filter((r) => r.status === 429).length, wr.T.mcp_access_log.filter((x: any) => x.status === "ok").length, wr.T.mcp_access_log.filter((x: any) => x.status === "rate_limited").length, wr.T.mcp_access_log.length],
      [3, 4, 3, 4, 7], "7 calls at the same moment with 3 a minute: exactly 3 run, 4 refused, one log row each");
  }

  // ── paging and caps ──
  {
    const many = Array.from({ length: 2500 }, (_, i) => ({ id: "t" + String(i).padStart(5, "0"), title: "Task " + i, board: "Odette", status: "To do", due: null, assignees: [], contact_id: null }));
    const w = world({ tasks: many }), keys = await keysFor(w);
    w.ranges.tasks = 0;
    const r = sc(await call(w, keys["u-owner"], "list_tasks", { limit: 500 }));
    eq([w.ranges.tasks, r.rows.length, r.count, r.truncated], [1, 500, 1000, true], "list_tasks: one page holds more than `limit` → it stops reading there; at most `limit` rows come back, flagged truncated");
    w.T.tasks.push({ id: "t99999", title: "Gabe's", board: "Gabe", status: "Doing", due: null, assignees: [], contact_id: null });
    w.ranges.tasks = 0;
    const rg = sc(await call(w, keys["u-owner"], "list_tasks", { status: "Doing" }));
    eq([w.ranges.tasks, ids(rg.rows), rg.truncated], [1, ["t99999"], false], "list_tasks: the status is filtered by the database (one short page)");
    w.T.tasks.find((x: any) => x.id === "t01234").due = "2026-10-20";
    w.ranges.tasks = 0;
    eq([ids(sc(await call(w, keys["u-owner"], "list_tasks", { limit: 2 })).rows), w.ranges.tasks], [["t01234", "t00000"], 1], "list_tasks: the database orders it (due first, no due date last, then id)");
    const p = await pageAll((a, z) => w.from("tasks").select("id").order("id").range(a, z), 1500);
    eq([p.rows.length, p.truncated], [1500, true], "pageAll stops at its cap and says so");
    const big = { rows: Array.from({ length: 100 }, (_, i) => ({ i, pad: "p".repeat(100) })), count: 100, truncated: false };
    const f = fitPayload(big, 2000);
    eq([f.payload.rows.length < 100, f.payload.truncated, f.text.length <= 2000, f.payload.count], [true, true, true, 100], "a payload over the size cap is halved until it fits and flagged truncated");
    eq(fitPayload({ rows: [1], truncated: false }).payload.truncated, false, "a small payload is left alone");
    eq([MAX_ROWS, PAGE, MAX_RESULT_CHARS], [500, 1000, 1_000_000], "caps");
  }

  // ── management ──
  {
    const w = world();
    eq((await manage(w, "create_token", null, { name: "x" })).status, 401, "create_token without a sign-in → 401");
    eq((await http(w, { path: "/mcp/manage", body: { step: "create_token", name: "x" }, headers: { authorization: "Bearer " + newToken() } })).status, 401, "an MCP key is not a sign-in");
    eq([(await manage(w, "create_token", "u-pia", { name: "x" })).status, (await manage(w, "create_token", "u-pia", { name: "x" })).body.reason], [403, "Only owners and managers can make keys."], "a VA → 403, owners and managers only");
    eq([(await manage(w, "create_token", "u-riley", { name: "x" })).status, (await manage(w, "create_token", "u-mgr", { name: "x" })).status, (await manage(w, "create_token", "u-owner", { name: "x" })).status], [403, 200, 200], "a VA with the old switch still on can't; a manager and an owner can make keys");
    eq([(await manage(w, "create_token", "u-owner", { name: "   " })).status, (await manage(w, "create_token", "u-owner", {})).body.reason], [400, "Give the key a name."], "an empty name → 400");
    for (let i = 0; i < 19; i++) await manage(w, "create_token", "u-mgr", { name: "k" + i });
    const full = await manage(w, "create_token", "u-mgr", { name: "21st" });
    eq([full.status, w.T.mcp_tokens.filter((x: any) => x.user_id === "u-mgr").length], [409, 20], "the 21st active key → 409");
    // a key the VA made before 15 Oct (when the switch existed)
    w.T.mcp_tokens.push({ id: crypto.randomUUID(), business_id: "default", user_id: "u-riley", name: "Old", token_prefix: "ops_mcp_abcd", token_hash: "0".repeat(64), scopes: ["read"], revoked_at: null, last_used_at: null });
    const mgrKey = w.T.mcp_tokens.find((x: any) => x.user_id === "u-mgr"), ronKey = w.T.mcp_tokens.find((x: any) => x.user_id === "u-riley");
    eq((await manage(w, "revoke_token", "u-mgr", { id: mgrKey.id })).status, 200, "revoke your own key");
    eq((await manage(w, "create_token", "u-mgr", { name: "after a revoke" })).status, 200, "a revoked key frees a place");
    const other = await manage(w, "revoke_token", "u-riley", { id: w.T.mcp_tokens.find((x: any) => x.user_id === "u-owner").id });
    eq([other.status, other.body.reason], [403, "Only an owner can revoke someone else's key."], "a VA can't revoke someone else's key");
    const T1 = NOW + 10_000;
    const own = await manage(w, "revoke_token", "u-owner", { id: ronKey.id }, T1);
    eq([own.status, own.body, ronKey.revoked_at, ronKey.revoked_by], [200, { ok: true, revokedAt: new Date(T1).toISOString() }, new Date(T1).toISOString(), "u-owner"], "an owner can revoke anyone's key");
    eq((await manage(w, "revoke_token", "u-owner", { id: ronKey.id }, T1 + 5000)).body, { ok: true, revokedAt: new Date(T1).toISOString() }, "revoking again is fine (and keeps the first time)");
    eq([(await manage(w, "revoke_token", "u-owner", { id: "55555555-5555-4555-8555-555555555555" })).status, (await manage(w, "revoke_token", "u-owner", { id: "x" })).status], [404, 400], "an unknown key id → 404, not an id → 400");
    eq((await manage(w, "set_mcp_settings", "u-mgr", { rateLimitPerMin: 10 })).status, 403, "set_mcp_settings: owners only");
    const bad = [{ rateLimitPerMin: 0 }, { rateLimitPerMin: 601 }, { rateLimitPerMin: "x" }, { logKeepDays: 6 }, { importSource: "" }, { importSource: "z".repeat(61) }];
    eq(await Promise.all(bad.map(async (b) => (await manage(w, "set_mcp_settings", "u-owner", b)).status)), [400, 400, 400, 400, 400, 400], "set_mcp_settings: out-of-range values → 400");
    eq((await manage(w, "set_mcp_settings", "u-owner", { logKeepDays: 6 })).body.reason, "Keep the log for a whole number of days, from 7 to 3650.", "a plain-English reason");
    const s1 = await manage(w, "set_mcp_settings", "u-owner", { rateLimitPerMin: 30, importSource: "  From the CRM  " });
    eq([s1.status, s1.body.mcp, w.T.settings[0].catalog.mcp, w.T.settings[0].catalog.other, w.T.settings[0].catalog.region], [200, { rateLimitPerMin: 30, logKeepDays: 90, importSource: "From the CRM" }, { rateLimitPerMin: 30, logKeepDays: 90, importSource: "From the CRM" }, { keep: true }, CAT.region], "set_mcp_settings: writes catalog.mcp through mcp_set_catalog, the rest of the catalog untouched");
    eq((await manage(w, "set_mcp_settings", "u-owner", { logKeepDays: 365 })).body.mcp, { rateLimitPerMin: 30, logKeepDays: 365, importSource: "From the CRM" }, "set_mcp_settings: merges onto what is saved");
    eq([(await manage(w, "nope", "u-owner")).status, (await manage(w, "toString", "u-owner")).status, (await manage(w, "__proto__", "u-owner")).status], [400, 400, 400], "an unknown step → 400");
    eq((await http(w, { path: "/mcp/manage", method: "GET" })).status, 405, "GET /mcp/manage → 405");
    eq((await http(w, { path: "/mcp/manage", raw: "{x" })).status, 400, "a body that isn't JSON → 400");
  }

  // ── the cron route (the hourly imports themselves are tested with the imports below) ──
  {
    const w = world(), cron = (secret: string | null, body: any = { step: "import_hourly" }, method = "POST") => http(w, { path: "/functions/v1/mcp/cron", method, body, headers: secret === null ? {} : { "x-mcp-cron-secret": secret } });
    const origWait = io.waitUntil, waits: Promise<unknown>[] = [];
    io.waitUntil = (p: Promise<unknown>) => { waits.push(p); };
    try {
      eq([(await cron(null)).status, (await cron("wrong")).status, waits.length], [401, 401, 0], "cron: a missing or wrong secret → 401, nothing started");
      const okr = await cron("test-cron-secret");
      eq([okr.status, okr.body, waits.length], [202, { ok: true }, 1], "cron: the right secret → 202 at once, the imports in the background");
      eq((await cron("test-cron-secret", null)).status, 202, "cron: the body is not needed (M1's timer posts {step:'import_hourly'})");
      eq((await cron("test-cron-secret", null, "GET")).status, 405, "cron: GET → 405");
      (globalThis as any).__MCP_ENV__.MCP_CRON_SECRET = "";
      eq((await cron("")).status, 401, "cron: refused while MCP_CRON_SECRET is not set");
      (globalThis as any).__MCP_ENV__.MCP_CRON_SECRET = "test-cron-secret";
      await Promise.all(waits);
      const broken = fakeDb(JSON.parse(JSON.stringify(w.T)), { users: USERS(), jwts: JWTS, fail: ["mcp_import_rules"] });
      const n0 = logged.length;
      const br = await http(broken, { path: "/functions/v1/mcp/cron", body: {}, headers: { "x-mcp-cron-secret": "test-cron-secret" } });
      await Promise.all(waits);
      eq([br.status, logged.slice(n0).some((l) => l.startsWith("mcp cron failed:"))], [202, true], "cron: a failure in the background is logged, never thrown");
    } finally { io.waitUntil = origWait; }
  }

  // ── server errors ──
  {
    const w = world(), keys = await keysFor(w);
    const broken = fakeDb(JSON.parse(JSON.stringify(w.T)), { users: USERS(), jwts: JWTS, fail: ["settings"] });
    const r = await rpc(broken, keys["u-owner"], "tools/list");
    eq([r.status, r.body.error.code], [500, -32603], "a failure outside a tool → 500 -32603");
  }

  // ── client direction: the address guard (SSRF) ──
  {
    const PRIV = "That address is private or local, so OPS won't call it.";
    const why = (x: unknown) => { const r = checkServerUrl(x); return r.ok ? "ok" : r.reason; };
    eq(checkServerUrl("  https://mcp.example.com/mcp#tools "), { ok: true, url: "https://mcp.example.com/mcp", host: "mcp.example.com" }, "checkServerUrl: an https address is kept, trimmed, the #fragment dropped");
    eq(why("https://wblsrpmjiqwuxmrmuklc.supabase.co/functions/v1/mcp"), "ok", "checkServerUrl: a Supabase function address is fine");
    eq([why("http://mcp.example.com/"), why("ftp://mcp.example.com/"), why("javascript:alert(1)"), why(""), why(7), why("https://mcp.example.com/" + "x".repeat(500)), why("not a url")],
      ["Use an https:// address.", "Use an https:// address.", "Use an https:// address.", "Enter the server's https:// address.", "Enter the server's https:// address.", "That address is too long.", "That isn't a web address."], "checkServerUrl: http, ftp, javascript:, empty, not text, over 500 characters, not an address");
    eq(why("https://user:pw@mcp.example.com/"), "Put the key in the secret field, not in the address.", "checkServerUrl: a user:password in the address is refused");
    eq([why("https://mcp.example.com:22/"), why("https://mcp.example.com:80/"), why("https://mcp.example.com:8/"), why("https://mcp.example.com:443/"), why("https://mcp.example.com:8443/")],
      ["Use port 443 or a port above 1023.", "Use port 443 or a port above 1023.", "Use port 443 or a port above 1023.", "ok", "ok"], "checkServerUrl: ports 22 / 80 / 8 refused, 443 and 8443 fine");
    eq(["localhost", "foo.localhost", "printer.local", "metadata.google.internal", "x.internal", "router.lan", "nas.home.arpa", "home.arpa", "intranet", "localhost.", "box.corp"].map((h) => why("https://" + h + "/mcp")),
      new Array(11).fill(PRIV), "checkServerUrl: local and internal host names (and single-label ones) are refused");
    const v4 = ["127.0.0.1", "127.1", "2130706433", "0x7f.0.0.1", "0.0.0.0", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "100.100.100.200", "169.254.169.254", "168.63.129.16", "224.0.0.1", "255.255.255.255", "198.18.0.1"];
    eq(v4.map((h) => why("https://" + h + "/")), new Array(v4.length).fill(PRIV), "checkServerUrl: private / loopback / CGNAT / metadata / multicast IPs refused, in every spelling");
    eq([why("https://8.8.8.8/"), why("https://172.32.0.1/"), why("https://[2606:4700::1111]/mcp")], ["ok", "ok", "ok"], "checkServerUrl: public IPv4 and IPv6 addresses are fine");
    eq([why("https://[::1]/"), why("https://[::ffff:127.0.0.1]/"), why("https://[fd00:ec2::254]/")], [PRIV, PRIV, PRIV], "checkServerUrl: IPv6 loopback, mapped and AWS metadata literals refused");
    const v6 = ["::", "::1", "[::ffff:127.0.0.1]", "::ffff:8.8.8.8", "64:ff9b::a00:1", "fc00::1", "fd00:ec2::254", "fe80::1", "fe80::1%eth0", "ff02::1", "2001:db8::1", "2002::1", "2001::1", "100::1", "zz::", "1:2:3:4:5:6:7:8:9", "1::2::3"];
    eq(v6.filter((x) => !isBlockedIp(x)), [], "isBlockedIp: IPv6 special ranges, zone ids and unreadable addresses are blocked");
    eq([isBlockedIp("2606:4700::1111"), isBlockedIp("2a00:1450:4001:80b::200e"), isBlockedIp("8.8.8.8"), isBlockedIp("256.1.1.1"), isBlockedIp("")], [false, false, false, true, true], "isBlockedIp: public addresses pass, unreadable ones are blocked");
    eq([expandV6("::ffff:1.2.3.4"), expandV6("1::"), expandV6("1:2:3:4:5:6:7:8")], [[0, 0, 0, 0, 0, 0xffff, 0x102, 0x304], [1, 0, 0, 0, 0, 0, 0, 0], [1, 2, 3, 4, 5, 6, 7, 8]], "expandV6: '::', a dotted tail and the full form");
    eq([isBlockedHostname("Example.COM"), isBlockedHostname("LOCALHOST."), isBlockedHostname("")], [false, true, true], "isBlockedHostname: case and a trailing dot don't matter; empty is blocked");
    // DNS at use time
    const dns = io.resolveDns;
    const at = async (answer: any) => { io.resolveDns = typeof answer === "function" ? answer : async () => answer; return await checkResolved("mcp.example.com"); };
    eq(await at(["10.0.0.5"]), PRIV, "checkResolved: a name that resolves to a private address is refused");
    eq(await at(["93.184.216.34", "fd00::1"]), PRIV, "checkResolved: one private answer among public ones is enough to refuse");
    eq(await at([]), "That address doesn't exist.", "checkResolved: no answer = doesn't exist");
    eq(await at(async () => { throw new Error("SERVFAIL"); }), "OPS couldn't look up that address.", "checkResolved: a lookup failure is refused");
    eq(await at(null), "OPS can't check that address here, so it won't call it.", "checkResolved: a runtime without DNS lookups refuses every host name (fails closed)");
    eq(await (async () => { io.resolveDns = async () => null; return [await resolveChecked("8.8.8.8"), await resolveChecked("[2606:4700::1111]")]; })(), [{ ok: true, ip: null }, { ok: true, ip: null }], "resolveChecked: an IP literal needs no lookup (nothing to rebind), even without DNS");
    io.resolveDns = async () => ["93.184.216.34", "2606:4700::1111"];
    eq(await resolveChecked("mcp.example.com"), { ok: true, ip: "93.184.216.34" }, "resolveChecked: the first checked answer is the address the request is pinned to");
    eq(await at(["93.184.216.34", "2606:4700::1111"]), null, "checkResolved: public answers are fine");
    let looked = 0;
    io.resolveDns = async () => { looked++; return ["10.0.0.1"]; };
    eq([await checkResolved("8.8.8.8"), await checkResolved("[2606:4700::1111]"), looked], [null, null, 0], "checkResolved: IP literals skip DNS");
    io.resolveDns = dns;
  }

  // ── client direction: the pinned connection (a request goes to the address that was checked, never looked up again) ──
  {
    const te = new TextEncoder();
    const streamOf = (chunks: string[], close = true) => new ReadableStream<Uint8Array>({ start(c) { for (const ch of chunks) c.enqueue(te.encode(ch)); if (close) c.close(); } });
    let done = 0;
    const r1 = await readHttpResponse(streamOf(["HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Len", "gth: 7\r\nX-Bad Header\r\n\r\n{\"a\":", "1}trailing junk"]), () => done++);
    eq([r1.status, r1.headers.get("content-type"), await r1.text(), done], [200, "application/json", '{"a":1}', 1], "readHttpResponse: 100 Continue skipped, headers split across reads, the body cut at Content-Length, done once");
    const r2 = await readHttpResponse(streamOf(["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhel", "lo\r\n6;ext=1\r\n world\r\n0\r\nX-T: 1\r\n\r\n"]));
    eq(await r2.text(), "hello world", "readHttpResponse: chunked (sizes, extensions, a chunk split across reads, trailers)");
    eq(await (await readHttpResponse(streamOf(["HTTP/1.0 404 Not Found\r\n\r\nno such page"]))).text(), "no such page", "readHttpResponse: no length = until the connection closes");
    eq((await readHttpResponse(streamOf(["HTTP/1.1 302 Found\r\nLocation: https://elsewhere.example.com/\r\n\r\n"]))).status, 302, "readHttpResponse: a redirect comes back as it is (never followed)");
    const ev = 'data: {"id":1,"result":{}}\n\n';
    const sse = await readHttpResponse(streamOf(["HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n", ev.length.toString(16) + "\r\n" + ev + "\r\n"], false));
    eq(await readCapped(sse, 1000, (t) => t.includes("\n\n")), ev, "readHttpResponse: an SSE stream that stays open is read up to our answer");
    let bad = "";
    try { await readHttpResponse(streamOf(["SSH-2.0-OpenSSH\r\n\r\n"])); } catch (e) { bad = (e as Error).message; }
    eq(bad, "bad HTTP answer", "readHttpResponse: not HTTP → refused");
    // pinnedFetch over a pretend Deno.connect / Deno.startTls
    const D: any = (globalThis as any).Deno, seen: any = { written: "" };
    D.connect = async (o: any) => { seen.connect = o; return { close() { seen.closed = (seen.closed || 0) + 1; } }; };
    D.startTls = async (_c: any, o: any) => {
      seen.tls = o;
      return { write: async (b: Uint8Array) => { const n = Math.min(b.length, 50); seen.written += new TextDecoder().decode(b.subarray(0, n)); return n; }, close() { seen.closed = (seen.closed || 0) + 1; },
        readable: streamOf(["HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"]) };
    };
    try {
      const res = await pinnedFetch("https://mcp.example.com:8443/mcp?x=1#f", { method: "POST", headers: { "Content-Type": "application/json", Host: "evil.example", Authorization: "Bearer k" }, body: '{"jsonrpc":"2.0"}' }, "93.184.216.34");
      eq([seen.connect, seen.tls, await res.text(), seen.closed >= 1], [{ hostname: "93.184.216.34", port: 8443 }, { hostname: "mcp.example.com" }, "ok", true], "pinnedFetch: connects to the checked address; TLS (certificate and SNI) for the address's own name; closed after the answer");
      eq([seen.written.startsWith("POST /mcp?x=1 HTTP/1.1\r\nHost: mcp.example.com:8443\r\nConnection: close\r\nContent-Length: 17\r\n"), seen.written.includes("evil.example"), seen.written.includes("authorization: Bearer k\r\n"), seen.written.endsWith('\r\n\r\n{"jsonrpc":"2.0"}')], [true, false, true, true], "pinnedFetch: the request line, its own Host (a passed Host is dropped), the headers and the body, written in full");
      await pinnedFetch("https://[2606:4700::1111]/", { method: "POST", body: "" }, "[2606:4700::1111]");
      eq([seen.connect.hostname, seen.connect.port], ["2606:4700::1111", 443], "pinnedFetch: an IPv6 address without brackets, port 443 by default");
      // A connect (or TLS handshake) that hangs: the abort answers at once, and the connection that opens late is closed.
      let openLate: any = null, lateClosed = 0;
      D.connect = (o: any) => { seen.connect = o; return new Promise((res) => { openLate = () => res({ close() { lateClosed++; } }); }); };
      const ctl = new AbortController();
      const hung = pinnedFetch("https://mcp.example.com/", { method: "POST", body: "", signal: ctl.signal }, "93.184.216.34").then(() => "answered", (e) => (e as Error).message);
      ctl.abort();
      eq(await hung, "aborted", "pinnedFetch: a connect that never answers is given up when the signal aborts (connect can't take a signal)");
      openLate(); await new Promise((r) => setTimeout(r, 0));
      eq(lateClosed, 1, "pinnedFetch: the connection that opens after the abort is closed, not left open");
      D.connect = async (o: any) => { seen.connect = o; return { close() { lateClosed++; } }; };
      let tlsLate: any = null;
      D.startTls = () => new Promise((res) => { tlsLate = () => res({ close() { lateClosed++; } }); });
      const ctl2 = new AbortController();
      const hung2 = pinnedFetch("https://mcp.example.com/", { method: "POST", body: "", signal: ctl2.signal }, "93.184.216.34").then(() => "answered", (e) => (e as Error).message);
      await new Promise((r) => setTimeout(r, 0));
      ctl2.abort();
      eq(await hung2, "aborted", "pinnedFetch: a TLS handshake that hangs is given up when the signal aborts");
      tlsLate(); await new Promise((r) => setTimeout(r, 0));
      eq(lateClosed, 3, "pinnedFetch: the TCP connection (on abort) and the late TLS connection are both closed");
      eq(await raceAbort(Promise.resolve(7), undefined, () => {}), 7, "raceAbort: without a signal it is the step itself");
    } finally { delete D.connect; delete D.startTls; }
    let noApi = "";
    try { await pinnedFetch("https://mcp.example.com/", { method: "POST" }, "93.184.216.34"); } catch (e) { noApi = (e as Error).message; }
    eq(noApi, "pinned connections are not available", "pinnedFetch: without Deno.connect it refuses (never an unpinned request)");
  }

  // ── client direction: key, masking and answer helpers ──
  {
    eq([cleanAuthHeader(null), cleanAuthHeader(""), cleanAuthHeader(undefined), cleanAuthHeader("X-Api-Key")], [{ ok: true, value: null }, { ok: true, value: null }, { ok: true, value: null }, { ok: true, value: "X-Api-Key" }], "cleanAuthHeader: nothing = no header; X-Api-Key fine");
    eq(["Host", "Content-Length", "Mcp-Session-Id", "cookie", "bad header", "a:b", "x".repeat(65), 5].map((h) => (cleanAuthHeader(h) as any).reason), new Array(8).fill("That header name can't be used."), "cleanAuthHeader: reserved, spaced, colon, too long and non-text names refused");
    eq([checkSecret("abc"), checkSecret("a\r\nX-Evil: 1"), checkSecret("x".repeat(4097)), checkSecret(""), checkSecret(5), checkSecret("x".repeat(4096))],
      [null, "The secret can only contain plain characters (no line breaks).", "The secret can be at most 4096 characters.", "Enter the secret.", "Enter the secret.", null], "checkSecret: line breaks and over 4096 characters refused");
    eq([authHeaderValue("Authorization", "abc"), authHeaderValue("authorization", "Basic xyz"), authHeaderValue("Authorization", "Bearer abc"), authHeaderValue("X-Api-Key", "abc")], ["Bearer abc", "Basic xyz", "Bearer abc", "abc"], "authHeaderValue: Authorization gets 'Bearer ' unless a scheme is given; other headers as typed");
    eq(redact("a sk1 b Bearer sk1 c sk1", ["sk1"]), "a ••• b ••• c •••", "redact: every copy and the Bearer form masked");
    eq([redact("same text", ["", null, undefined]), redact("x", [])], ["same text", "x"], "redact: empty secrets change nothing");
    const pub = publicServer({ id: "s1", name: "CRM", url: "https://x.example.com/", auth_header: "Authorization", secret_id: "vault-s1", business_id: "default", created_by: "u", created_at: "t", last_test_at: null, last_test_ok: null, last_tools: null });
    eq([pub.has_secret, "secret_id" in pub, "business_id" in pub, publicServer({ id: "s2", secret_id: null }).has_secret], [true, false, false, false], "publicServer: has_secret only, never the Vault id");
    // SSE and picking our answer
    eq(parseSse('data: {"a":\ndata:  1}\n\nevent: x\ndata: nope\r\n\r\ndata: {"b":2}\r\n\r\n: comment\n\n'), [{ a: 1 }, { b: 2 }], "parseSse: data lines joined, one leading space stripped, CRLF, junk and comments skipped");
    const msgs = [{ jsonrpc: "2.0", method: "notifications/progress" }, { jsonrpc: "2.0", id: 3, method: "sampling/createMessage" }, { jsonrpc: "2.0", id: 3, result: { ok: 1 } }];
    eq([pickResponse(msgs, 3), pickResponse(msgs, 4), pickResponse([{ id: 3, result: 1 }], 3), pickResponse([[{ jsonrpc: "2.0", id: 1, error: { message: "x" } }]], 1)], [{ jsonrpc: "2.0", id: 3, result: { ok: 1 } }, null, null, { jsonrpc: "2.0", id: 1, error: { message: "x" } }], "pickResponse: notifications and server requests ignored, wrong id → null, a batch is searched");
    // tools
    const max = CLIENT.maxTools;
    CLIENT.maxTools = 3;
    const tl = cleanTools([{ name: "a", description: "d".repeat(600) + " sk9" }, { title: "no name" }, { name: "b", title: "B", description: "uses sk9", inputSchema: { type: "object", properties: { big: { type: "string", description: "z".repeat(9000) } } } }, { name: "c" }, { name: "d" }], "sk9");
    CLIENT.maxTools = max;
    eq([tl.length, tl.map((t: any) => t.name), tl[0].description.length, tl[1].description, tl[1].title, tl[1].inputSchema, tl[2].inputSchema], [3, ["a", "b", "c"], 500, "uses •••", "B", { type: "object", note: "schema too large to store" }, { type: "object" }], "cleanTools: capped, nameless dropped, description clipped to 500 and masked, an oversized schema replaced");
    // previews
    eq(previewResult({ structuredContent: { n: 1 }, content: [{ type: "text", text: "ignored" }] }, null), { isError: false, preview: '{\n  "n": 1\n}', truncated: false }, "previewResult: structured content first, as JSON");
    eq(previewResult({ isError: true, content: [{ type: "text", text: "boom sk9" }, { type: "image", mimeType: "image/png", data: "AAAA" }, { type: "resource", resource: { uri: "file:///a.txt", text: "hi" } }, { type: "resource_link", uri: "https://x.example.com/f" }, { type: "odd", v: 1 }] }, "sk9"),
      { isError: true, preview: 'boom •••\n\n[image image/png]\n\n[resource file:///a.txt]\nhi\n\n[link https://x.example.com/f]\n\n{"type":"odd","v":1}', truncated: false }, "previewResult: text / image / resource / link / other items, masked, isError passed on");
    const pc = CLIENT.previewChars;
    CLIENT.previewChars = 10;
    eq(previewResult({ content: [{ type: "text", text: "0123456789abc" }] }, null), { isError: false, preview: "0123456789", truncated: true }, "previewResult: cut at CLIENT.previewChars and flagged");
    CLIENT.previewChars = pc;
    eq([resultData({ structuredContent: { a: 1 }, content: [{ type: "text", text: '{"b":2}' }] }), resultData({ content: [{ type: "image" }, { type: "text", text: '{"b":2}' }] }), resultData({ content: [{ type: "text", text: "plain" }] }), resultData({ content: [] }), resultData(null)],
      [{ a: 1 }, { b: 2 }, "plain", null, null], "resultData: structured content, else the first text as JSON, else that text");
    eq([cleanArgs(undefined), cleanArgs(null), cleanArgs({ a: 1 }), cleanArgs('{"a":2}'), cleanArgs("  ")], [{ ok: true, args: {} }, { ok: true, args: {} }, { ok: true, args: { a: 1 } }, { ok: true, args: { a: 2 } }, { ok: true, args: {} }], "cleanArgs: nothing = {}, an object or its JSON");
    eq([cleanArgs([1]), cleanArgs(5), cleanArgs("{x"), cleanArgs("[1]"), cleanArgs({ big: "x".repeat(20001) })].map((r: any) => r.reason),
      ["The tool input must be a JSON object.", "The tool input must be a JSON object.", "The tool input must be a JSON object.", "The tool input must be a JSON object.", "The tool input is too large."], "cleanArgs: arrays, numbers, bad JSON and over 20 KB refused");
    eq([TOOL_NAME.test("list_leads"), TOOL_NAME.test("crm.leads/list-all"), TOOL_NAME.test("bad name"), TOOL_NAME.test("")], [true, true, false, false], "TOOL_NAME");
    // readCapped on its own
    const small = await readCapped(new Response("hello"), 10);
    let big = "";
    try { await readCapped(new Response("x".repeat(20)), 10); } catch (e) { big = (e as Error).message; }
    eq([small, big], ["hello", "The server's answer is larger than 0 MB."], "readCapped: reads up to the cap, refuses more");
  }

  // ── client direction: the owner's steps (save / delete / test / call), against a pretend server ──
  {
    const SECRET = "sk-test-Zq9fake-secret-123";
    const origFetch = io.fetch, origDns = io.resolveDns, origNow = io.now, origLog = console.log;
    const said: string[] = [];
    console.log = (...a: any[]) => { said.push(a.map(String).join(" ")); origLog(...a); };
    io.resolveDns = async () => ["93.184.216.34"];
    io.now = () => NOW;
    let remote = fakeRemote({ secret: SECRET });
    io.fetch = (u: string, i: RequestInit, ip?: string | null) => remote.fetch(u, i, ip);
    const use = (o: any = {}) => { remote = fakeRemote({ secret: SECRET, ...o }); return remote; };
    const keep: string[] = [];   // every answer body and stored row, checked for the secret at the end
    const m = async (w: any, step: string, me: string | null, extra: any = {}) => { const r = await manage(w, step, me, extra); keep.push(r.text); return r; };
    try {
      // who may
      {
        const w = world();
        for (const step of CLIENT_ACTIONS) {
          const res = [];
          for (const who of ["u-mgr", "u-riley", "u-gabe", "u-mkt"]) res.push(await m(w, step, who, { id: C1, name: "x", url: "https://mcp.example.com/mcp", secret: SECRET, tool: "t" }));
          eq(res.map((r) => [r.status, r.body.reason]), new Array(4).fill([403, "owners only"]), `${step}: manager / va / technician / marketing → 403 owners only`);
          eq((await m(w, step, null)).status, 401, `${step}: nobody signed in → 401`);
        }
        eq([(w.T.mcp_servers || []).length, w.ctl.rpcs, remote.reqs.length], [0, [], 0], "refused steps write nothing, touch no secret and call no server");
        eq(await clientAction(w, { step: "nope" }, prof("u-owner")), { status: 400, body: { ok: false, reason: "unknown action" } }, "clientAction: an unknown action → 400");
        eq(await clientAction(w, { step: "save_server" }, null), { status: 401, body: { ok: false, reason: "unauthorized" } }, "clientAction: no caller → 401");
        const key = (await manage(w, "create_token", "u-owner", { name: "Laptop" })).body.token;
        const viaKey = await http(w, { path: "/functions/v1/mcp/manage", token: key, body: { step: "save_server", name: "x", url: "https://mcp.example.com/mcp" } });
        eq([viaKey.status, viaKey.body.reason, (w.T.mcp_servers || []).length], [401, "unauthorized", 0], "/manage: an ops_mcp_ key is never a caller for the client steps (401)");
      }
      // save_server
      const w = world();
      const s1 = await m(w, "save_server", "u-owner", { name: "  Our  CRM ", url: "https://mcp.example.com/mcp#x", secret: SECRET });
      const row = () => w.T.mcp_servers.find((r: any) => r.id === s1.body.server.id);
      eq([s1.status, s1.body.ok, s1.body.server.name, s1.body.server.url, s1.body.server.auth_header, s1.body.server.has_secret, "secret_id" in s1.body.server], [200, true, "Our CRM", "https://mcp.example.com/mcp", "Authorization", true, false], "save_server: saved, the header defaults to Authorization with a secret, has_secret only");
      eq([row().business_id, row().created_by, w.vault.get(row().id), Object.values(row()).some((v) => String(v).includes(SECRET))], ["default", "u-owner", SECRET, false], "save_server: business 'default', made by the owner, the secret only in the vault");
      eq(s1.text.includes(SECRET), false, "save_server: the answer never contains the secret");
      const n0 = w.T.mcp_servers.length;
      const bad = [];
      for (const url of ["http://mcp.example.com/mcp", "https://10.0.0.1/mcp", "https://localhost/mcp", "https://169.254.169.254/latest"]) bad.push(await m(w, "save_server", "u-owner", { name: "x", url, secret: SECRET }));
      eq(bad.map((r) => [r.status, r.body.reason]), [[400, "Use an https:// address."], [400, "That address is private or local, so OPS won't call it."], [400, "That address is private or local, so OPS won't call it."], [400, "That address is private or local, so OPS won't call it."]], "save_server: http / private / local / metadata addresses → 400");
      io.resolveDns = async () => ["10.1.2.3"];
      const rebind = await m(w, "save_server", "u-owner", { name: "x", url: "https://sneaky.example.com/mcp" });
      io.resolveDns = async () => ["93.184.216.34"];
      eq([rebind.status, rebind.body.reason, w.T.mcp_servers.length, w.vault.size], [400, "That address is private or local, so OPS won't call it.", n0, 1], "save_server: a name resolving to 10.x → 400, nothing written");
      eq([(await m(w, "save_server", "u-owner", { name: " ", url: "https://a.example.com/" })).body.reason, (await m(w, "save_server", "u-owner", { name: "x".repeat(81), url: "https://a.example.com/" })).body.reason, (await m(w, "save_server", "u-owner", { name: "x", url: "https://a.example.com/", auth_header: "Host" })).body.reason, (await m(w, "save_server", "u-owner", { name: "x", url: "https://a.example.com/", secret: "a\nb" })).body.reason],
        ["Give the server a name.", "Give the server a name.", "That header name can't be used.", "The secret can only contain plain characters (no line breaks)."], "save_server: name, header and secret checks");
      // edit semantics
      const id = s1.body.server.id;
      row().last_test_at = "2026-10-13T00:00:00.000Z"; row().last_test_ok = true; row().last_tools = [{ name: "a" }];
      for (const secret of [undefined, "", null]) await m(w, "save_server", "u-owner", { id, name: "CRM", url: "https://mcp.example.com/mcp", auth_header: "Authorization", ...(secret === undefined ? {} : { secret }) });
      eq([w.vault.get(id), row().secret_id !== null, row().name, row().last_test_ok], [SECRET, true, "CRM", true], "save_server: no / empty / null secret keeps the saved one (and a rename keeps the last test)");
      await m(w, "save_server", "u-owner", { id, name: "CRM", url: "https://mcp.example.com/v2/mcp" });
      eq([row().url, row().auth_header, row().last_test_at, row().last_test_ok, row().last_tools], ["https://mcp.example.com/v2/mcp", "Authorization", null, null, null], "save_server: a new address resets the last test (an unsent header stays)");
      const cl = await m(w, "save_server", "u-owner", { id, name: "CRM", url: "https://mcp.example.com/v2/mcp", clear_secret: true });
      eq([cl.body.server.has_secret, w.vault.has(id), row().secret_id], [false, false, null], "save_server: clear_secret removes the secret from the vault");
      await m(w, "save_server", "u-owner", { id, name: "CRM", url: "https://mcp.example.com/mcp", secret: SECRET });
      const moved = await m(w, "save_server", "u-owner", { id, name: "CRM", url: "https://attacker.example.net/mcp" });
      const port = await m(w, "save_server", "u-owner", { id, name: "CRM", url: "https://mcp.example.com:8443/mcp" });
      eq([moved.status, moved.body.reason, port.status, row().url, w.vault.get(id)], [400, "Enter the key again for the new address (or remove the saved key).", 400, "https://mcp.example.com/mcp", SECRET], "save_server: a new host or port with the saved secret → 400, nothing changed (the secret never goes to an address it wasn't given for)");
      eq([(await m(w, "save_server", "u-owner", { id, name: "CRM", url: "https://MCP.example.com/other" })).status, row().url], [200, "https://mcp.example.com/other"], "save_server: the same host (any case) with another path keeps the secret");
      await m(w, "save_server", "u-owner", { id, name: "CRM", url: "https://mcp.example.com/mcp" });
      eq([(await m(w, "save_server", "u-owner", { id: C3, name: "x", url: "https://a.example.com/" })).status, (await m(w, "save_server", "u-owner", { id: "nope", name: "x", url: "https://a.example.com/" })).status], [404, 404], "save_server: an unknown id → 404");
      w.ctl.rpcFail = true;
      const n1 = w.T.mcp_servers.length;
      const rf = await m(w, "save_server", "u-owner", { name: "Other", url: "https://other.example.com/mcp", secret: "other-secret" });
      w.ctl.rpcFail = false;
      eq([rf.status, rf.body.reason, w.T.mcp_servers.length], [500, "The secret could not be saved.", n1], "save_server: the vault failing on a new server → 500 and the row is removed");
      // another business's server is invisible
      w.T.mcp_servers.push({ id: C2, business_id: "other-biz", name: "Theirs", url: "https://theirs.example.com/", auth_header: null, secret_id: null });
      eq([(await m(w, "test_server", "u-owner", { id: C2 })).status, (await m(w, "delete_server", "u-owner", { id: C2 })).status, (await m(w, "call_tool", "u-owner", { id: C2, tool: "x" })).status, w.T.mcp_servers.some((r: any) => r.id === C2)], [404, 404, 404, true], "another business's server: 404 for every step, untouched");

      // test_server: the happy path
      const timers = () => ((globalThis as any).process.getActiveResourcesInfo() as string[]).filter((x) => x === "Timeout").length;
      const t0 = timers();
      use();
      const t1 = await m(w, "test_server", "u-owner", { id });
      const rq = remote.reqs;
      eq([t1.status, t1.body.ok, t1.body.test_ok, t1.body.protocol, t1.body.server_info, t1.body.tools.map((t: any) => t.name)], [200, true, true, "2025-06-18", { name: "Fake CRM", version: "2.1" }, ["list_leads", "get_lead", "list_jobs"]], "test_server: ok, protocol, server info, every page of tools");
      eq(rq.map((r: any) => r.body.method + (r.body.params && r.body.params.cursor ? ":" + r.body.params.cursor : "")), ["initialize", "notifications/initialized", "tools/list", "tools/list:p2"], "test_server: initialize → initialized → tools/list (two pages via nextCursor)");
      eq(rq.slice(1).map((r: any) => [r.headers["mcp-session-id"], r.headers["mcp-protocol-version"]]), new Array(3).fill(["sess-1", "2025-06-18"]), "test_server: later requests carry the session id and the protocol version");
      eq(rq.map((r: any) => [r.url, r.method, r.redirect, r.headers.accept, r.headers.authorization]), new Array(4).fill(["https://mcp.example.com/mcp", "POST", "manual", "application/json, text/event-stream", "Bearer " + SECRET]), "test_server: POST, Accept both, redirect manual, the configured key");
      eq(rq.map((r: any) => Object.keys(r.headers).filter((h) => h === "apikey" || h.startsWith("x-mcp") || h === "x-client-info")).flat(), [], "test_server: no OPS headers (apikey, x-mcp-…) are sent");
      eq(rq.map((r: any) => r.ip), new Array(4).fill("93.184.216.34"), "test_server: every request is pinned to the address the DNS check approved");
      eq([Object.keys(rq[0].body.params), rq[0].body.params.clientInfo, rq[0].headers["mcp-session-id"]], [["protocolVersion", "capabilities", "clientInfo"], { name: "ops-mcp-client", version: "1.0.0" }, undefined], "test_server: initialize sends only the protocol, capabilities and client info");
      eq([row().last_test_ok, row().last_test_at, row().last_tools.length, row().last_tools[0]], [true, new Date(NOW).toISOString(), 3, { name: "list_leads", title: "List leads", description: "Lists new leads", inputSchema: { type: "object", properties: { since: { type: "string" } } } }], "test_server: the row keeps the cleaned tools and the time");
      eq(timers(), t0, "test_server: every request timer is cleared");
      const goodTools = JSON.stringify(row().last_tools);
      // SSE answers, with a stream that never ends
      use({ sse: "open" });
      const t2 = await m(w, "test_server", "u-owner", { id });
      eq([t2.status, t2.body.tools.length, remote.reqs.length], [200, 3, 4], "test_server: SSE answers (a notification, a server request and junk first; the stream stays open) end on our answer");
      use({ sse: "close" });
      eq((await m(w, "test_server", "u-owner", { id })).status, 200, "test_server: SSE answers on a stream that closes");
      // failures: 502 with the stage, last_test_ok false, the last good tool list kept
      const failCase = async (o: any, name: string, want: [string, string]) => {
        use(o);
        const r = await m(w, "test_server", "u-owner", { id });
        eq([r.status, r.body.ok, r.body.test_ok, r.body.stage, r.body.reason.includes(want[1]) ? want[1] : r.body.reason, row().last_test_ok, JSON.stringify(row().last_tools) === goodTools], [502, false, false, want[0], want[1], false, true], "test_server fails: " + name);
        return r;
      };
      await failCase({ protocol: "2023-01-01" }, "an MCP version OPS doesn't speak", ["initialize", "The server speaks an MCP version OPS doesn't support (2023-01-01)."]);
      const pvEcho = await failCase({ protocol: SECRET }, "a protocol version that is the secret (masked before it is cut)", ["initialize", "The server speaks an MCP version OPS doesn't support (•••)."]);
      eq(pvEcho.text.includes(SECRET.slice(0, 12)), false, "no part of the secret leaks through a clipped server value");
      await failCase({ status: 401 }, "HTTP 401", ["initialize", "The server refused the key (HTTP 401)."]);
      await failCase({ status: 404 }, "HTTP 404", ["initialize", "No MCP endpoint at that address (HTTP 404)."]);
      await failCase({ status: 500 }, "HTTP 500", ["initialize", "The server answered HTTP 500."]);
      await failCase({ redirect: true }, "a redirect (not followed)", ["initialize", "The server redirected the call; enter the final address."]);
      eq(remote.reqs.length, 1, "a redirect: exactly one request, nothing followed");
      await failCase({ down: true }, "unreachable", ["initialize", "OPS couldn't reach the server."]);
      CLIENT.timeoutMs = 50;
      await failCase({ hang: true }, "a server that never answers", ["initialize", "The server took too long"]);
      CLIENT.timeoutMs = 15000;
      eq(timers(), t0, "a timed-out request leaves no timer behind");
      const bud = CLIENT.budgetMs;
      CLIENT.budgetMs = 0;
      await failCase({}, "the step's time budget used up", ["initialize", "The server took too long."]);
      CLIENT.budgetMs = bud;
      await failCase({ huge: "body" }, "a 3 MB answer", ["initialize", "The server's answer is larger than 2 MB."]);
      await failCase({ huge: "length" }, "a content-length over the cap", ["initialize", "The server's answer is larger than 2 MB."]);
      await failCase({ badJson: true }, "an answer that isn't JSON", ["initialize", "The server did not answer in MCP format."]);
      await failCase({ wrongId: true }, "an answer to another id", ["initialize", "The server did not answer in MCP format."]);
      const re = await failCase({ rpcErrorOn: "tools/list" }, "a JSON-RPC error (masked)", ["tools/list", "The server answered: Bad key ••• for this call (code -32000)"]);
      eq(re.text.includes(SECRET), false, "a JSON-RPC error never echoes the secret");
      // a stored address that has turned private: no request at all
      io.resolveDns = async () => ["192.168.0.10"];
      use();
      await failCase({}, "the address now resolves to a private IP", ["address", "That address is private or local, so OPS won't call it."]);
      eq(remote.reqs.length, 0, "a now-private address: no request made");
      io.resolveDns = async () => ["93.184.216.34"];
      // a server that echoes the secret everywhere
      use({ echoSecret: true });
      const ec = await m(w, "test_server", "u-owner", { id });
      const ecCall = await m(w, "call_tool", "u-owner", { id, tool: "list_leads", args: {} });
      eq([ec.status, ec.body.tools[0].description, ecCall.status], [200, "Lists new leads (key •••, •••)", 200], "an echoing server: its tool description is masked");
      eq([JSON.stringify(row().last_tools).includes(SECRET), ec.text.includes(SECRET), ecCall.text.includes(SECRET), ecCall.body.preview.includes("•••")], [false, false, false, true], "an echoing server: the stored tools, the test answer and the call answer never contain the secret");

      // call_tool
      use();
      eq([(await m(w, "call_tool", "u-owner", { id, tool: "bad name" })).body.reason, (await m(w, "call_tool", "u-owner", { id, tool: "list_leads", args: [1] })).body.reason, (await m(w, "call_tool", "u-owner", { id, tool: "list_leads", args: { big: "x".repeat(20001) } })).body.reason, remote.reqs.length],
        ["That tool name doesn't look right.", "The tool input must be a JSON object.", "The tool input is too large.", 0], "call_tool: a bad tool name or input → 400, no request");
      const c1 = await m(w, "call_tool", "u-owner", { id, tool: "list_leads", args: { since: "2026-10-01" } });
      const callReq = remote.reqs.find((r: any) => r.body.method === "tools/call");
      eq([c1.status, c1.body.ok, c1.body.isError, c1.body.truncated, JSON.parse(c1.body.preview).items.length], [200, true, false, false, 2], "call_tool: ok, with a preview of the answer");
      eq(callReq.body.params, { name: "list_leads", arguments: { since: "2026-10-01" } }, "call_tool: sends exactly the tool name and the owner's arguments");
      use({ callResult: { isError: true, content: [{ type: "text", text: "no such list" }] } });
      eq((await m(w, "call_tool", "u-owner", { id, tool: "list_leads", args: "{}" })).body, { ok: true, isError: true, preview: "no such list", truncated: false }, "call_tool: a tool error is passed on as isError");
      CLIENT.previewChars = 5;
      use();
      const c3 = await m(w, "call_tool", "u-owner", { id, tool: "list_leads" });
      CLIENT.previewChars = 20000;
      eq([c3.body.preview.length, c3.body.truncated], [5, true], "call_tool: the preview is cut at CLIENT.previewChars");
      use({ callResult: { nothing: true } });
      const c4 = await m(w, "call_tool", "u-owner", { id, tool: "list_leads" });
      eq([c4.status, c4.body.stage, c4.body.reason], [502, "tools/call", "The server did not answer in MCP format."], "call_tool: a result without content → 502 tools/call");
      use({ status: 403 });
      eq([(await m(w, "call_tool", "u-owner", { id, tool: "list_leads" })).body.stage], ["initialize"], "call_tool: a failure carries its stage");

      // remoteCall (the imports' way in)
      use();
      const rc = await remoteCall(w, id, "list_leads", {});
      eq([rc.data, Array.isArray(rc.result.content)], [{ items: [{ name: "Ann Lee", phone: "0400 000 001" }, { name: "Bob Ray", phone: "0400 000 002" }] }, true], "remoteCall: the raw result and its parsed data");
      use({ echoSecret: true });
      const rcs = await remoteCall(w, id, "list_leads", {});
      eq([JSON.stringify(rcs).includes(SECRET), (rcs.data as any).note], [false, "key •••"], "remoteCall: a secret the server echoes is masked before an import could keep it");
      use();
      let rcErr: any = null;
      try { await remoteCall(w, C3, "list_leads", {}); } catch (e) { rcErr = e; }
      eq([rcErr instanceof ClientError, rcErr && rcErr.message], [true, "No such server."], "remoteCall: an unknown server throws");
      w.ctl.rpcFail = true;
      const sf = await m(w, "test_server", "u-owner", { id });
      w.ctl.rpcFail = false;
      eq([sf.status, sf.body, logged.some((l) => l.includes("secret store unavailable")), logged.some((l) => l.includes("vault"))], [500, { ok: false, reason: "server" }, true, false], "the secret store failing → 500, logged without the store's answer");

      // delete_server
      const before = w.T.mcp_servers.length;
      const d1 = await m(w, "delete_server", "u-owner", { id });
      eq([d1.status, d1.body, w.T.mcp_servers.length, w.vault.has(id)], [200, { ok: true }, before - 1, false], "delete_server: the row and its vault secret are gone");
      eq((await m(w, "delete_server", "u-owner", { id })).status, 404, "delete_server: an unknown id → 404");

      // nothing anywhere ever held the secret
      eq([keep.filter((t) => t.includes(SECRET)).length, logged.filter((l) => l.includes(SECRET)).length, said.filter((l) => l.includes(SECRET)).length, JSON.stringify(w.T).includes(SECRET)], [0, 0, 0, false], "the secret is in no answer, no log line and no table row");
    } finally {
      io.fetch = origFetch; io.resolveDns = origDns; io.now = origNow; console.log = origLog;
      CLIENT.timeoutMs = 15000; CLIENT.budgetMs = 45000; CLIENT.previewChars = 20000;
    }
  }

  // ── imports (M4): the pure helpers ──
  {
    const tz = "Australia/Sydney", cx = { tz, people: ["Gabe Tech", "Riley"] };
    const F = IMPORT_FIELDS;
    const data = { a: { b: [{ c: 1 }, { c: 2 }] } };
    eq([getPath(data, "a.b[1].c"), getPath(data, "a.x.c") === undefined, getPath(data, "") === data, getPath(data, "a.b[5]") === undefined], [2, true, true, true], "getPath: a.b[1].c resolves; a missing step → undefined; '' → the root");
    eq(["a.b[1].c", "data.items", "$x-y_z", ""].map(validPath), [true, true, true, true], "validPath: names, [n] and '' are fine");
    eq(["a..b", "a[x]", "__proto__.x", "constructor", "a.prototype", "x".repeat(201), "a.b.c.d.e.f.g.h.i.j.k.l.m", "a b"].map(validPath), new Array(8).fill(false), "validPath: empty steps, a non-number index, __proto__ / constructor / prototype, over 200 characters or 12 steps, spaces");
    eq([getPath({}, "toString") === undefined, getPath({ a: 1 }, "a.constructor") === undefined, getPath(Object.create({ x: 1 }), "x") === undefined], [true, true, true], "getPath: never an inherited property");

    eq(toolData({ structuredContent: { items: [1] }, content: [{ type: "text", text: '{"items":[2]}' }] }), { ok: true, data: { items: [1] } }, "toolData: structured content first");
    eq(toolData({ content: [{ type: "image", data: "x" }, { type: "text", text: '{"items":[2]}' }] }), { ok: true, data: { items: [2] } }, "toolData: else the first text item as JSON");
    eq(toolData({ isError: true, content: [{ type: "text", text: "x".repeat(300) }] }), { ok: false, reason: "The tool reported an error: " + "x".repeat(200) }, "toolData: a tool error, its text clipped to 200");
    eq([toolData({ content: [{ type: "text", text: "hello" }] }), toolData({ content: [] }), toolData(null)], [{ ok: false, reason: "The tool did not return JSON data" }, { ok: false, reason: "The tool returned nothing" }, { ok: false, reason: "The tool returned nothing" }], "toolData: text that isn't JSON; nothing");

    eq(itemsAt([1, 2], ""), { ok: true, items: [1, 2], truncated: false }, "itemsAt: the whole answer is the list");
    eq(itemsAt({ data: { items: [{ a: 1 }] } }, "data.items"), { ok: true, items: [{ a: 1 }], truncated: false }, "itemsAt: a nested list");
    eq([itemsAt({}, "x"), itemsAt({ x: {} }, "x")], [{ ok: false, reason: 'Nothing found at "x"' }, { ok: false, reason: '"x" is not a list' }], "itemsAt: missing; not a list");
    const big: any = itemsAt({ items: Array.from({ length: 600 }, (_, k) => k) }, "items");
    eq([big.items.length, big.items[499], big.truncated], [500, 499, true], "itemsAt: 600 items → the first 500, truncated");

    const C_ = (f: any, v: unknown) => coerceField(f, v, cx);
    eq([C_(F.contacts.full_name, "  Ann \n  Lee "), C_(F.contacts.postcode, "123456789012"), C_(F.contacts.full_name, 42), C_(F.contacts.full_name, { a: 1 })],
      [{ ok: true, value: "Ann Lee" }, { ok: true, value: "1234567890" }, { ok: true, value: "42" }, { ok: false, reason: "is not text" }], "coerceField text: trimmed, collapsed, clipped; a number is text; an object is not");
    eq([C_(F.contacts.email, " ANN@Example.COM "), C_(F.contacts.email, "nope"), C_(F.contacts.email, "a,b@x.co")], [{ ok: true, value: "ann@example.com" }, { ok: false, reason: "is not a valid email" }, { ok: false, reason: "is not a valid email" }], "coerceField email");
    eq([C_(F.contacts.phone, " 0412 345 678 "), C_(F.contacts.phone, "9".repeat(50)).ok && (C_(F.contacts.phone, "9".repeat(50)) as any).value.length], [{ ok: true, value: "0412 345 678" }, 40], "coerceField phone: kept as written, clipped to 40");
    eq([C_(F.jobs.date, "2026-10-14"), C_(F.jobs.date, "2026-10-14T23:30:00Z"), C_(F.jobs.date, "soon"), C_(F.jobs.date, "2026-02-30")], [{ ok: true, value: "2026-10-14" }, { ok: true, value: "2026-10-15" }, { ok: false, reason: "is not a date" }, { ok: false, reason: "is not a date" }], "coerceField day: kept; a timestamp → its day in the business's zone; not a date");
    // a date-time with no zone is the day as written (never moved through the business's zone); one with a zone is its day there
    {
      const Cz = (zone: string, v: string) => (coerceField(F.jobs.date, v, { ...cx, tz: zone }) as any).value ?? "bad";
      eq([Cz(SYD, "2026-09-30T18:00:00"), Cz(SYD, "2026-09-30 15:30"), Cz(SYD, "2026-09-30T23:59:59.999"), Cz(SYD, "Sep 30 2026 22:00")],
        ["2026-09-30", "2026-09-30", "2026-09-30", "2026-09-30"], "coerceField day: Sydney, an evening wall time with no zone stays that day");
      eq([Cz(CHI, "09/30/2026"), Cz(CHI, "Sep 30 2026"), Cz(CHI, "2026-09-30T00:00:00"), Cz(CHI, "2026-09-30 00:00")],
        ["2026-09-30", "2026-09-30", "2026-09-30", "2026-09-30"], "coerceField day: Chicago, a bare or midnight date with no zone is not the day before");
      eq([Cz(SYD, "2026-09-30T18:00:00Z"), Cz(SYD, "2026-09-30T18:00:00+00:00"), Cz(SYD, "2026-09-30T18:00:00.000+1000"), Cz(CHI, "2026-09-30T02:00:00Z"), Cz(SYD, "Wed, 30 Sep 2026 18:00:00 GMT"), Cz(CHI, "2026-09-30T23:00:00-05:00")],
        ["2026-10-01", "2026-10-01", "2026-09-30", "2026-09-29", "2026-10-01", "2026-09-30"], "coerceField day: a time with Z, an offset or GMT → its day in the business's zone");
      eq([Cz(SYD, "2026-13-01T10:00"), Cz(SYD, "2026-02-30 10:00"), [ZONED_TIME.test("09-30-2026"), ZONED_TIME.test("2026-09-30"), ZONED_TIME.test("18:00Z"), ZONED_TIME.test("18:00 +10")]],
        ["bad", "bad", [false, false, true, true]], "coerceField day: an impossible date with a time is not a date; a date's dashes are not an offset");
    }
    eq([C_(F.jobs.amount, "$1,234.50"), C_(F.jobs.amount, 99.999), C_(F.jobs.amount, "abc"), C_(F.jobs.amount, -5), C_(F.jobs.amount, "$"), C_(F.jobs.amount, 2e7)],
      [{ ok: true, value: 1234.5 }, { ok: true, value: 100 }, { ok: false, reason: "is not an amount" }, { ok: false, reason: "is not an amount" }, { ok: false, reason: "is not an amount" }, { ok: false, reason: "is not an amount" }], "coerceField money: $ and commas dropped, cents; not a number, negative or over 10 million refused");
    eq([C_(F.jobs.includes_gst, "Yes"), C_(F.jobs.includes_gst, "0"), C_(F.jobs.includes_gst, true), C_(F.jobs.includes_gst, 1), C_(F.jobs.includes_gst, "maybe")],
      [{ ok: true, value: true }, { ok: true, value: false }, { ok: true, value: true }, { ok: true, value: true }, { ok: false, reason: "is not yes/no" }], "coerceField bool");
    eq([mapItem("jobs", { customer_name: "c", includes_gst: "g" }, { c: "Ann", g: "maybe" }, { ...cx, tax: "VAT" }).errors, mapItem("jobs", { customer_name: "c", includes_gst: "g" }, { c: "Ann", g: "maybe" }, cx).errors],
      [["Includes VAT is not yes/no"], ["Includes GST is not yes/no"]], "mapItem: the tax field's problem says the business's own tax name");
    eq([C_(F.jobs.payment_status, "paid"), C_(F.jobs.payment_status, "maybe"), C_(F.tasks.status, "in progress")], [{ ok: true, value: "Paid" }, { ok: false, reason: "is not one of: Paid, Unpaid" }, { ok: true, value: "In Progress" }], "coerceField enum: the canonical value, or the list");
    eq([C_(F.contacts.tags, "a, b,,a"), (C_(F.contacts.tags, Array.from({ length: 25 }, (_, k) => "t" + k)) as any).value.length, C_(F.contacts.tags, [{}])], [{ ok: true, value: ["a", "b"] }, 20, { ok: false, reason: "is not a list of tags" }], "coerceField tags: split, trimmed, empties dropped, de-duplicated, at most 20");
    eq([C_(F.contacts.tags, [" VIP ", "vip", "Vip customer", "x".repeat(70)])], [{ ok: true, value: ["VIP", "Vip customer", "x".repeat(60)] }], "coerceField tags: as the lead card keeps them (trimmed, at most 60 characters, one of each whatever the case, the first spelling kept)");
    const IC0 = { quiet: true, nowMs: NOW, tz: "Australia/Sydney", ruleName: "Leads", serverName: "Fake CRM", importSource: "MCP import", profiles: PROFILES };
    // the business's own lists (Settings → Pipeline / Services / Lead sources); unknown → New / the catch-all service
    {
      const cat = { stages: [{ key: "New", label: "Fresh" }, { key: "s1", label: "Site visit" }, { key: "Chasing", active: false }, { key: "Quoted", deleted: true }], services: [{ key: "Solar", label: "Solar panels" }, { key: "Chimney", deleted: true }], sources: [{ key: "Expo", label: "Home show" }] };
      const lc = { ...cx, lists: catalogLists(cat) };
      const CL = (f: any, v: unknown) => coerceField(f, v, lc);
      eq([CL(F.contacts.status, "site visit"), CL(F.contacts.status, "S1"), CL(F.contacts.status, "fresh"), CL(F.contacts.status, "Chasing"), CL(F.contacts.status, "Quoted"), CL(F.contacts.status, "Lost"), CL(F.contacts.status, "Hot!"), CL(F.contacts.status, { a: 1 })],
        [{ ok: true, value: "s1" }, { ok: true, value: "s1" }, { ok: true, value: "New" }, { ok: true, value: "New" }, { ok: true, value: "New" }, { ok: true, value: "Lost" }, { ok: true, value: "New" }, { ok: false, reason: "is not text" }],
        "coerceField stage: a stage of the business's pipeline by key or label (any case) → its key; switched off, deleted or unknown → New; Won and Lost are always on");
      eq([CL(F.contacts.division, "solar panels"), CL(F.contacts.division, "aircon"), CL(F.contacts.division, "Chimney"), CL(F.contacts.division, "Plumbing")], [{ ok: true, value: "Solar" }, { ok: true, value: "Aircon" }, { ok: true, value: "Other" }, { ok: true, value: "Other" }],
        "coerceField service: the business's services and the built-in ones it keeps; deleted or unknown → the catch-all service (Other)");
      eq([CL(F.contacts.source, "home show"), CL(F.contacts.source, "Organic web"), CL(F.contacts.source, "Website")], [{ ok: true, value: "Expo" }, { ok: true, value: "Organic" }, { ok: true, value: ""}],
        "coerceField source: by key or label; unknown → empty, so the row gets the import's own source");
      const row: any = importRow("contacts", mapItem("contacts", { full_name: "n", source: "s", status: "st", division: "d" }, { n: "Zed", s: "Billboard", st: "Hot", d: "Roofing" }, lc).values, IC0);
      eq([row.source, row.status, row.division], ["MCP import", "New", "Other"], "importRow: unknown source / stage / service → the import's source, New and the catch-all service");
      eq(catalogLists(null), { services: BASE_LISTS.services.map((k) => ({ key: k, label: k })), stages: BASE_LISTS.stages.map((k) => ({ key: k, label: BASE_LABELS.stages[k] })), sources: BASE_LISTS.sources.map((k) => ({ key: k, label: BASE_LABELS.sources[k] || k })) }, "catalogLists: nothing saved = the app's built-in lists");
    }
    // Paid / Done / Won / Lost as the business calls them (catalog.keys; their stage 2), else the app's words
    {
      const keys = catalogKeys({ keys: { paid: " Settled ", done: "Finished", won: "", lost: 'Bad"word' } });
      eq([keys, catalogKeys(null), catalogKeys({ keys: [1] }), renamedKey(keys, "Paid"), renamedKey(keys, "Unpaid"), renamedKey(undefined, "Paid")],
        [{ paid: "Settled", done: "Finished", won: "Won", lost: "Lost" }, KEY_DEFAULTS, KEY_DEFAULTS, "Settled", "Unpaid", "Paid"], "catalogKeys: the saved words (trimmed), else the defaults (empty or unsafe ones too)");
      const kc = { ...cx, keys };
      eq([coerceField(F.jobs.payment_status, "settled", kc), coerceField(F.jobs.payment_status, "Paid", kc), coerceField(F.tasks.status, "finished", kc)], [{ ok: true, value: "Settled" }, { ok: false, reason: "is not one of: Settled, Unpaid" }, { ok: true, value: "Finished" }],
        "coerceField enum: Paid and Done as the business renamed them");
      eq([(importRow("jobs", { customer_name: "A", payment_status: "Settled", date: "2026-10-10" }, { ...IC0, keys }) as any).date_paid, (importRow("jobs", { customer_name: "A", payment_status: "Paid", date: "2026-10-10" }, IC0) as any).date_paid], ["2026-10-10", "2026-10-10"], "importRow: a job in the business's Paid gets its date paid");
      eq(catalogLists({ stages: [{ key: "Won", label: "Won" }] }, keys).stages.map((x) => x.key).includes("Won"), true, "catalogLists: an unchanged Won key stays Won");
      eq(catalogLists(null, { ...KEY_DEFAULTS, won: "Closed" }).stages.map((x) => x.key), ["New", "Chasing", "Quoted", "Follow-up", "Booked", "Closed", "Lost"], "catalogLists: a renamed Won is the stage's value");
    }
    eq([C_(F.tasks.assigned_to, "gabe tech"), C_(F.tasks.assigned_to, "Old Hand")], [{ ok: true, value: "Gabe Tech" }, { ok: false, reason: "is not someone on the team" }], "coerceField person: an active employee's own name, or refused");
    const types = ["text", "phone", "email", "day", "money", "bool", "enum", "tags", "person"];
    eq(types.map((t) => (coerceField({ label: "x", type: t as any, values: ["A"] }, null, cx) as any).value), ["", "", "", null, 0, false, null, [], ""], "coerceField: empty values give each type's empty value");
    eq((coerceField(F.contacts.full_name, "   ", cx) as any).value, "", "coerceField: blanks are empty");

    const item = { name: "Ann", contact: { phone: "0400 000 001" }, mail: "bad" };
    eq(mapItem("contacts", { full_name: "name", phone: { path: "contact.phone" }, source: { value: "meta ads" }, nope: "name" }, item, cx), { values: { full_name: "Ann", phone: "0400 000 001", source: "Meta Ads" }, errors: [] }, "mapItem: shorthand, {path} and {value}; an unknown target is ignored");
    eq(mapItem("contacts", { phone: "contact.phone" }, item, cx).errors, ["Name is missing"], "mapItem: a required field not filled → '<Label> is missing'");
    eq(mapItem("contacts", { full_name: "name", email: "mail" }, item, cx).errors, ["Email is not a valid email"], "mapItem: a coercion error carries the field's label");
    eq(mapItem("contacts", { full_name: "nothing.here" }, item, cx).errors, ["Name is missing"], "mapItem: a path that finds nothing → missing");

    eq([normKey("phone", "0412 345 678"), normKey("phone", "+61 412 345 678"), normKey("phone", "1234")], ["412345678", "412345678", ""], "normKey phone: the last 9 digits (fewer than 8 digits = none)");
    eq([normKey("email", " A@B.co "), normKey("text", "INV-2001", "invoice_number"), normKey("text", "2001", "invoice_number"), normKey("text", "  Big   Job ", "customer_name"), normKey("tags", ["b", "a"])], ["a@b.co", "2001", "2001", "big job", "a,b"], "normKey: email, invoice digits, text, tags");
    eq([rowKeys("tasks", { fields: ["title", "due"], match: "all" }, { title: "X", due: null }), rowKeys("tasks", { fields: ["title", "due"], match: "all" }, { title: " X ", due: "2026-10-14" }), rowKeys("tasks", { fields: ["title", "due"], match: "all" }, { title: "", due: null })], [["title=x|due="], ["title=x|due=2026-10-14"], null], "rowKeys 'all': an empty part is part of the combined key (an undated task); null only when every part is empty");
    const tIdx = keyIndex("tasks", DEFAULT_DEDUPE.tasks, [{ id: "tA", title: "Call Ann", due: null }, { id: "tB", title: "Call Bob", due: "2026-10-20" }]);
    eq(flagRows("tasks", DEFAULT_DEDUPE.tasks, [{ values: { title: "Undated" }, errors: [] }, { values: { title: "call ann" }, errors: [] }, { values: { title: "Call Bob" }, errors: [] }, { values: { title: "Call Bob", due: "2026-10-20" }, errors: [] }], tIdx).map((r) => [r.status, r.match_id || ""]),
      [["new", ""], ["duplicate", "tA"], ["new", ""], ["duplicate", "tB"]], "flagRows with the default task check: an undated task is new (not an error); same title and no date matches an undated one; a date must match too");
    eq([rowKeys("contacts", DEFAULT_DEDUPE.contacts, { phone: "", email: "A@b.co" }), rowKeys("contacts", DEFAULT_DEDUPE.contacts, { phone: "", email: "" })], [["email=a@b.co"], null], "rowKeys 'any': the filled fields only; none → null");

    const existing = keyIndex("contacts", DEFAULT_DEDUPE.contacts, [{ id: "c1", phone: "0412345678", email: "" }, { id: "c2", phone: null, email: "Bob@Example.com" }]);
    const fl = flagRows("contacts", DEFAULT_DEDUPE.contacts, [
      { values: { phone: "+61 412 345 678" }, errors: [] }, { values: { email: "bob@example.com" }, errors: [] }, { values: { phone: "0400 000 009" }, errors: [] },
      { values: { phone: "0400000009" }, errors: [] }, { values: {}, errors: [] }, { values: { phone: "1" }, errors: ["Name is missing"] },
    ], existing);
    eq(fl.map((r) => [r.i, r.status, r.reason || "", r.match_id || ""]), [[0, "duplicate", "Already in OPS", "c1"], [1, "duplicate", "Already in OPS", "c2"], [2, "new", "", ""], [3, "duplicate", "Repeated in this import", ""], [4, "error", "No value in the duplicate-check fields", ""], [5, "error", "Name is missing", ""]],
      "flagRows: a match in OPS (phone in another spelling, email in another case), repeated in this batch, no key, a mapping error, new");

    const SRV0 = "44444444-4444-4444-8444-444444444444";
    const GOOD = { name: "Leads", kind: "contacts", server_id: SRV0, tool: "list_leads", tool_args: { since: "2026-10-01" }, items_path: "items", mapping: { full_name: "name", phone: "phone", email: { path: "email" }, source: { value: "CRM" } }, dedupe: { fields: ["phone", "email"], match: "any" }, mode: "manual", enabled: false, run_automations: false };
    eq(validateRule(GOOD), [], "validateRule: a good contacts rule");
    eq([validateRule({ ...GOOD, tool_args: undefined, items_path: undefined }), validateRule({ ...GOOD, kind: "jobs", mapping: { customer_name: "c", invoice_number: "n" }, dedupe: { fields: ["invoice_number"], match: "any" } })], [[], []], "validateRule: tool_args and items_path may be left out; a jobs rule");
    const bad = [
      { kind: "leads" }, { mapping: { ...GOOD.mapping, nope: "x" } }, { mapping: { phone: "phone", email: "email" } }, { dedupe: { fields: [], match: "any" } },
      { dedupe: { fields: ["source"], match: "any" } }, { dedupe: { fields: ["postcode"], match: "any" } }, { dedupe: { fields: ["phone"], match: "some" } }, { mode: "daily" },
      { tool_args: [] }, { tool_args: { x: "y".repeat(4000) } }, { items_path: "a..b" }, { name: "" }, { name: "n".repeat(81) }, { tool: "list leads" },
      { server_id: "x" }, { mapping: { ...GOOD.mapping, phone: { path: "a", value: 1 } } }, { mapping: { ...GOOD.mapping, notes: { value: { a: 1 } } } }, { enabled: "yes" }, { run_automations: 1 },
    ];
    eq(bad.map((o) => validateRule({ ...GOOD, ...o }).length > 0), new Array(bad.length).fill(true), "validateRule: a bad kind, unknown target, required field not mapped, no dedupe fields, a dedupe field by constant or not mapped, a bad match, mode, tool_args (array / too long), items path, name (empty / 81), tool with a space, server id, a bad mapping entry, non-boolean switches");
    eq(validateRule({ ...GOOD, dedupe: { fields: ["source"], match: "any" } }), ["Lead source finds duplicates, so map it from the data (not a fixed value)."], "validateRule: a plain-English reason");
    eq(validateRule({ ...GOOD, mapping: { phone: "phone", email: "email" } }), ["Map Name: it is required."], "validateRule: the required field by its label");

    const IC = { quiet: true, nowMs: NOW, tz, ruleName: "Leads", serverName: "Fake CRM", importSource: "MCP import", profiles: PROFILES };
    const keysOf = (o: any) => Object.keys(o).sort().join(",");
    const qc: any = importRow("contacts", { full_name: "A" }, IC), lc: any = importRow("contacts", { full_name: "B", phone: "1", email: "a@b.co", tags: ["x"], created_at: "2026-10-01", source: "Web" }, { ...IC, quiet: false, importSource: "From the CRM" });
    eq(keysOf(qc), keysOf(lc), "importRow contacts: the same keys for any input (bulk insert safety)");
    eq([qc.messages[0].quiet, qc.messages[0].kind, qc.messages[0].at, qc.messages[0].text, qc.last_read_at, qc.stage_changed_at, qc.source, qc.division, qc.status, qc.created_at, qc.linked_job_id, qc.starred, qc.tags, qc.estimated_value],
      [true, "event", new Date(NOW).toISOString(), "Imported from Fake CRM (Leads), automatic messages off", new Date(NOW).toISOString(), null, "MCP import", "Other", "New", "2026-10-14", null, false, [], 0], "importRow: a quiet contact (quiet on its first entry, read, no stage time, the import source, today in the zone)");
    eq(["quiet" in lc.messages[0], lc.messages[0].text, lc.last_read_at, lc.source, lc.created_at], [false, "Imported from Fake CRM (Leads)", null, "Web", "2026-10-01"], "importRow: a contact with automations on has no quiet key and stays unread; mapped values win");
    eq((importRow("contacts", { full_name: "C" }, { ...IC, importSource: "From the CRM" }) as any).source, "From the CRM", "importRow: the source is catalog.mcp.importSource");
    // "Date received" mapped: the card arrived that business day (created_at AND its first entry), never as today's new
    // lead; Sydney keeps the bare date (midnight UTC is still that day there), Chicago gets noon that day in Chicago
    const dr = (tz: string, quiet = true) => importRow("contacts", { full_name: "D", created_at: "2026-09-30" }, { ...IC, tz, quiet }) as any;
    eq([dr(SYD).created_at, dr(SYD).messages[0].at, dr(CHI).created_at, dr(CHI).messages[0].at, dr(SYD, false).messages[0].at],
      ["2026-09-30", "2026-09-30T00:00:00.000Z", "2026-09-30T17:00:00.000Z", "2026-09-30T17:00:00.000Z", "2026-09-30T00:00:00.000Z"], "importRow: Date received dates the card and its first entry in the business's zone (bizDayStamp)");
    // "Date received" after the business's today is a problem row (never clamped); a job date or due date may be ahead
    {
      const tc = { ...cx, today: "2026-10-14" }, DR = F.contacts.created_at;
      eq([coerceField(DR, "2026-10-14", tc), coerceField(DR, "2026-10-15", tc), coerceField(DR, "2026-10-14T23:30:00Z", tc), coerceField(DR, "2026-10-13T13:30:00Z", tc), coerceField(DR, "10/20/2026", tc), coerceField(DR, "2026-10-15", cx)],
        [{ ok: true, value: "2026-10-14" }, { ok: false, reason: "is in the future" }, { ok: false, reason: "is in the future" }, { ok: true, value: "2026-10-14" }, { ok: false, reason: "is in the future" }, { ok: true, value: "2026-10-15" }],
        "coerceField: a Date received after today (as written, or a zoned instant that is tomorrow in Sydney) is in the future; no today given = not checked");
      eq([coerceField(F.jobs.date, "2026-11-01", tc), coerceField(F.tasks.due, "2026-11-01", tc)], [{ ok: true, value: "2026-11-01" }, { ok: true, value: "2026-11-01" }], "coerceField: a job date or a due date can be ahead");
      eq(mapItem("contacts", { full_name: "n", created_at: "d" }, { n: "Zed", d: "2027-01-01" }, tc).errors, ["Date received is in the future"], "mapItem: a future Date received is a problem row with a clear reason");
    }
    eq([(importRow("contacts", { full_name: "E" }, { ...IC, tz: CHI }) as any).created_at, qc.created_at], ["2026-10-13T17:00:00.000Z", "2026-10-14"], "importRow: nothing mapped = today in the business's zone, stamped like conversations / voice");
    // the one marker the engine and push read: import_quiet on every kind
    const mk3 = (quiet: boolean) => ["contacts", "jobs", "tasks"].map((k) => (importRow(k, { full_name: "A", customer_name: "A", title: "A" }, { ...IC, quiet }) as any).import_quiet);
    eq([mk3(true), mk3(false)], [[true, true, true], [false, false, false]], "importRow: import_quiet is the run's quiet, on contacts, jobs and tasks");
    const qj: any = importRow("jobs", { customer_name: "A" }, IC), lj: any = importRow("jobs", { customer_name: "B", payment_status: "Paid", date: "2026-10-10", amount: 300, includes_gst: true }, { ...IC, quiet: false });
    eq([keysOf(qj) === keysOf(lj), qj.created_at, qj.review_do_not_ask, lj.created_at, lj.review_do_not_ask], [true, null, true, new Date(NOW).toISOString(), false], "importRow jobs: same keys; quiet = created_at null + review_do_not_ask; else now / false");
    eq([qj.date, qj.date_paid, qj.payment_status, qj.job_type, qj.amount, qj.parts_cost, qj.includes_gst, lj.date_paid, qj.entered_by, qj.paid_to_technician, qj.parts_refund_status, qj.cash_confirmed, qj.commission_percent],
      ["2026-10-14", null, "Unpaid", "Other", 0, 0, true, "2026-10-10", "MCP import: Leads", "Not Paid", "N/A", false, 0], "importRow jobs: defaults (GST applies unless mapped, as the app's job form; no rate = 0%); date_paid only when Paid");
    const RATES = { Gabe: { Aircon: 30, Chimney: null }, Alex: { "Pressure Washing": 40 } };
    const rj = (v: any) => importRow("jobs", { customer_name: "A", ...v }, { ...IC, rates: RATES }) as any;
    eq([rj({ technician: "Gabe", job_type: "Aircon" }).commission_percent, rj({ technician: "Gabe", job_type: "Chimney" }).commission_percent, rj({ technician: "Alex", job_type: "Aircon" }).commission_percent, rj({ technician: "Gabe", job_type: "Aircon", includes_gst: false }).includes_gst, keysOf(rj({ technician: "Gabe" })) === keysOf(qj)],
      [30, 0, 0, false, true], "importRow jobs: commission % from the technician's rate for the job type (none → 0); a mapped 'no GST' stays; the same keys");
    const pairs: [string, string][] = [["Gabe", "Aircon"], ["Gabe", "Chimney"], ["Alex", "Aircon"], ["Nobody", "Aircon"], ["Alex", "Pressure Washing"]];
    eq(pairs.map(([t, j]) => commissionRateFor(RATES, t, j)), pairs.map(([t, j]) => APP.commissionRateFor(RATES, t, j)), "commissionRateFor: the same as the app's");
    eq([mapItem("jobs", { customer_name: "c", technician: "t" }, { c: "Ann", t: "gabe tech" }, cx), mapItem("jobs", { customer_name: "c", technician: "t" }, { c: "Ann", t: "Dan" }, cx).errors],
      [{ values: { customer_name: "Ann", technician: "Gabe Tech" }, errors: [] }, ["Technician is not someone on the team"]], "mapItem jobs: the technician must be an active employee (their own spelling), else the row is a problem");
    const t1i: any = importRow("tasks", { title: "A", assigned_to: "Riley" }, IC), t2i: any = importRow("tasks", { title: "B", assigned_to: "Gabe", due: "2026-10-20", status: "Done", priority: "High", category: "Financial" }, IC), t3i: any = importRow("tasks", { title: "C" }, IC);
    eq([keysOf(t1i) === keysOf(t2i), keysOf(t1i) === keysOf(t3i)], [true, true], "importRow tasks: same keys");
    eq([t1i.board, t1i.assignees, t2i.board, t2i.assignees, t3i.board, t3i.assignees, t3i.status, t3i.priority, t3i.category, t3i.created_by, t3i.subtasks, t3i.contact_id],
      ["ron", ["Riley"], "Gabe", ["Gabe"], "ron", [], "Not Started", "Medium", "", "MCP import: Leads", [], null], "importRow tasks: the app's board rule (a VA or nobody → 'ron'), defaults");
    // the board rule = the app's boardForAssignees (stage 1: a VA by full name, technician name or first name, or an
    // employee with the VA role; no name is special any more)
    {
      const profs = [...PROFILES, { id: "u-va2", full_name: "Kim Lane", role: "va", technician_name: "KL", permissions: {} }];
      const emps = [...SEED.employees, { id: "e9", name: "Sam", roles: ["VA"], status: "Active", employment_type: "Hourly" }, { id: "e10", name: "Jo", roles: ["Technician"], status: "Active", employment_type: "" }];
      APP.STATE.profiles = profs.map((p: any) => ({ id: p.id, fullName: p.full_name, role: p.role, technicianName: p.technician_name || "", permissions: p.permissions || {} }));
      const prevData = APP.STATE.data;
      APP.STATE.data = { employees: emps.map((e: any) => ({ name: e.name, roles: e.roles || [], status: e.status })) };
      const cases = [[], ["Riley"], ["Kim Lane"], ["Kim"], ["KL"], ["Sam"], ["Jo"], ["Gabe", "Riley"], ["Riley", "Gabe"], ["Nobody"], ["Odette"]];
      eq(cases.map((n) => boardFor(n, profs, emps)), cases.map((n) => APP.boardForAssignees(n)), "boardFor: the same board as the app's boardForAssignees for every case");
      eq(cases.map((n) => boardFor(n, profs, emps)), ["ron", "ron", "ron", "ron", "ron", "ron", "Jo", "Gabe", "ron", "Nobody", "Odette"], "boardFor: the office's board for a VA (any of their names) or an employee with the VA role; else the first person's own");
      APP.STATE.data = prevData; APP.STATE.profiles = [];
      const t4 = importRow("tasks", { title: "D", assigned_to: "Sam" }, { ...IC, employees: emps }) as any, t5 = importRow("tasks", { title: "D", assigned_to: "Sam" }, IC) as any;
      eq([t4.board, t5.board], ["ron", "Sam"], "importRow tasks: an employee with the VA role (no login) goes on the office's board when the run has the employees");
    }
    eq([runStatus(3, 0), runStatus(0, 0), runStatus(2, 1), runStatus(0, 2)], ["done", "done", "partial", "failed"], "runStatus");
    eq(IMPORT_KINDS.map((k) => (DEFAULT_DEDUPE as any)[k].fields.every((f: string) => f in IMPORT_FIELDS[k])), [true, true, true], "DEFAULT_DEDUPE: only real fields of each kind");
  }

  // ── imports (M4): the owner's steps against the database ──
  {
    const SRV = "44444444-4444-4444-8444-444444444444", GONE_SRV = "55555555-5555-4555-8555-555555555555";
    const RULE = { name: "Leads", kind: "contacts", server_id: SRV, tool: "list_leads", tool_args: { since: "2026-10-01" }, items_path: "items", mapping: { full_name: "name", phone: "phone", email: "email" }, dedupe: { fields: ["phone", "email"], match: "any" }, mode: "manual" };
    const ITEMS = [
      { name: "Ann Lee", phone: "0412 345 678", email: "" },              // C1's phone → duplicate
      { name: "Bobby", phone: "", email: "BOB@example.com" },             // C2's email → duplicate
      { name: "Cleo New", phone: "0400 000 001", email: "cleo@example.com" },
      { name: "Dan New", phone: "0400 000 002", email: "" },
      { name: "Cleo Again", phone: "0400000001", email: "" },             // repeated in this import
      { name: "Eve New", phone: "0400 000 004", email: "" },
    ];
    const toolCalls: any[] = [];
    let answer: any = null;
    const answerWith = (items: any[]) => { answer = { ok: true, result: { content: [{ type: "text", text: JSON.stringify({ items }) }] } }; };
    const origCall = io.callTool, origWait = io.waitUntil, origNow = io.now, origFetch4 = io.fetch;
    io.fetch = () => { throw new Error("no network in the import tests"); };   // every tool call below is the stub
    io.callTool = async (_sb: any, server: any, tool: string, args: any) => { toolCalls.push({ server: server.id, tool, args: JSON.parse(JSON.stringify(args)) }); return typeof answer === "function" ? answer() : answer; };
    const iw = (over: Record<string, any[]> = {}) => world({ mcp_servers: [{ id: SRV, business_id: "default", name: "Fake CRM", url: "https://crm.example.com/mcp", auth_header: null, secret_id: null }], mcp_import_rules: [], mcp_import_runs: [], activity_log: [], ...over });
    const save = async (w: any, rule: any, me = "u-owner", at?: number) => manage(w, "save_rule", me, { rule }, at);
    try {
      // save_rule
      let w = iw();
      eq([(await save(w, RULE, "u-mgr")).status, (await save(w, RULE, "u-mgr")).body.reason, (await save(w, RULE, "u-gabe")).status, (await save(w, RULE, null)).status], [403, "Owners only.", 403, 401], "save_rule: owners only (a manager and a technician get 403)");
      const s1 = await save(w, { ...RULE, business_id: "other", created_by: "hacker", last_run_at: "2020-01-01T00:00:00Z" }, "u-owner", NOW);
      const R1 = s1.body.rule;
      eq([s1.status, R1.business_id, R1.run_automations, R1.enabled, R1.created_by, R1.last_run_at, R1.items_path, R1.dedupe, w.T.mcp_import_rules.length], [200, "default", false, false, "u-owner", undefined, "items", { fields: ["phone", "email"], match: "any" }, 1], "save_rule: saved for this business, OFF and automations OFF unless === true; unknown columns ignored");
      const s2 = await save(w, { ...RULE, run_automations: true, enabled: true, mode: "hourly", name: "Hourly" });
      eq([s2.body.rule.run_automations, s2.body.rule.enabled], [true, true], "save_rule: switched on only by === true");
      const sb1 = await save(w, { ...RULE, mapping: { phone: "phone" } });
      eq([sb1.status, sb1.body.reason, Array.isArray(sb1.body.errors) && sb1.body.errors.length > 1], [400, "Map Name: it is required.", true], "save_rule: an invalid rule → 400 with errors[]");
      eq([(await save(w, { ...RULE, server_id: GONE_SRV })).status, (await save(w, { ...RULE, id: GONE_SRV })).status], [404, 404], "save_rule: an unknown server or rule id → 404");
      const u1 = await save(w, { ...RULE, id: R1.id, name: "Leads (CRM)", created_by: "hacker", created_at: "2020-01-01T00:00:00Z" }, "u-owner", NOW + 60e3);
      const stored = w.T.mcp_import_rules.find((r: any) => r.id === R1.id);
      eq([u1.status, stored.name, stored.created_by, stored.created_at, stored.updated_at], [200, "Leads (CRM)", "u-owner", new Date(NOW).toISOString(), new Date(NOW + 60e3).toISOString()], "save_rule: an update changes only the rule's own columns (created_by / created_at stay)");

      // preview_import
      answerWith([...ITEMS, { name: "", phone: "0400 000 003" }]);
      const writes0 = w.ctl.writes.length, contacts0 = JSON.stringify(w.T.contacts);
      eq((await manage(w, "preview_import", "u-mgr", { rule_id: R1.id })).status, 403, "preview_import: owners only");
      const pv = await manage(w, "preview_import", "u-owner", { rule_id: R1.id });
      eq([pv.status, pv.body.fetched, pv.body.truncated, pv.body.counts], [200, 7, false, { new: 3, duplicate: 3, error: 1 }], "preview_import: counts against what is in OPS (same phone; same email in another case; repeated; a missing name)");
      eq(pv.body.rows.map((r: any) => [r.status, r.match_id || null]), [["duplicate", C1], ["duplicate", C2], ["new", null], ["new", null], ["duplicate", null], ["new", null], ["error", null]], "preview_import: each row's flag and match");
      eq([w.ctl.writes.length - writes0, JSON.stringify(w.T.contacts) === contacts0], [0, true], "preview_import: nothing inserted, updated or deleted");
      eq(toolCalls[toolCalls.length - 1], { server: SRV, tool: "list_leads", args: { since: "2026-10-01" } }, "preview_import: the tool gets exactly the saved tool and arguments (no OPS data added)");
      answerWith(Array.from({ length: 250 }, (_, k) => ({ name: "P" + k, phone: "0499 000 " + String(k).padStart(3, "0") })));
      const pv2 = await manage(w, "preview_import", "u-owner", { rule_id: R1.id });
      eq([pv2.body.rows.length, pv2.body.counts.new], [200, 250], "preview_import: at most 200 rows shown (the counts cover all)");
      // a "Date received" after the business's today (Sydney, 14 Oct) is a problem row with its reason; today and before are fine
      {
        const RD = (await save(w, { ...RULE, name: "Dated", mapping: { ...RULE.mapping, created_at: "got" } }, "u-owner", NOW)).body.rule;
        answerWith([{ name: "Today", phone: "0411 000 001", got: "2026-10-14" }, { name: "Tomorrow", phone: "0411 000 002", got: "2026-10-15" }, { name: "Past", phone: "0411 000 003", got: "2026-09-01" }]);
        const pd = await manage(w, "preview_import", "u-owner", { rule_id: RD.id }, NOW);
        eq(pd.body.rows.map((r: any) => [r.status, r.reason || ""]), [["new", ""], ["error", "Date received is in the future"], ["new", ""]], "preview_import: a future Date received is a problem row (the business's today), never clamped");
      }
      answer = { ok: true, result: { isError: true, content: [{ type: "text", text: "quota exceeded" }] } };
      eq([(await manage(w, "preview_import", "u-owner", { rule_id: R1.id })).status, (await manage(w, "preview_import", "u-owner", { rule_id: R1.id })).body.reason], [400, "The tool reported an error: quota exceeded"], "preview_import: a tool error → 400 with the reason");
      answer = { ok: false, reason: "The server took too long (15 s)." };
      eq((await manage(w, "preview_import", "u-owner", { rule_id: R1.id })).body, { ok: false, reason: "The server took too long (15 s)." }, "preview_import: a failed call → its reason");
      eq([(await manage(w, "preview_import", "u-owner", { rule_id: GONE_SRV })).status, (await manage(w, "preview_import", "u-owner", { rule_id: "x" })).status], [404, 404], "preview_import: a missing rule → 404");
      const wg = iw({ mcp_import_rules: [{ ...RULE, id: "66666666-6666-4666-8666-666666666666", business_id: "default", server_id: GONE_SRV, enabled: false, run_automations: false }] });
      eq((await manage(wg, "preview_import", "u-owner", { rule_id: "66666666-6666-4666-8666-666666666666" })).status, 404, "preview_import: a rule whose server is gone → 404");

      // a duplicate check that can't read every existing record refuses (it would let duplicates through)
      const scanMax = IMPORT_SCAN.max;
      IMPORT_SCAN.max = 2;
      answerWith(ITEMS);
      const pvBig = await manage(w, "preview_import", "u-owner", { rule_id: R1.id }), contactsBefore = w.T.contacts.length;
      const cmBig = await manage(w, "commit_import", "u-owner", { rule_id: R1.id });
      IMPORT_SCAN.max = scanMax;
      eq([pvBig.status, pvBig.body.reason, cmBig.body.run.status, cmBig.body.run.inserted || 0, w.T.contacts.length - contactsBefore], [400, "The duplicate check can only read 2 existing records, and there are more, so nothing was imported.", "failed", 0, 0], "more existing records than the duplicate check reads → preview refuses, commit records a failed run and inserts nothing");

      // commit_import
      w = iw();
      const R = (await save(w, RULE, "u-owner", NOW)).body.rule;
      answerWith(ITEMS);
      const before = JSON.parse(JSON.stringify(w.T.contacts));
      const T1 = NOW + 3600e3;
      const c1 = await manage(w, "commit_import", "u-owner", { rule_id: R.id }, T1);
      const run = c1.body.run, made = w.T.contacts.filter((c: any) => run.inserted_ids.includes(c.id));
      eq([c1.status, run.status, run.fetched, run.inserted, run.duplicates, run.source, run.started_by, run.run_automations, run.kind, run.rule_name, run.errors], [200, "done", 6, 3, 3, "manual", "u-owner", false, "contacts", "Leads", []], "commit_import: a done run with what was fetched, inserted and found duplicate");
      eq([made.map((c: any) => c.full_name), w.T.contacts.length], [["Cleo New", "Dan New", "Eve New"], 6], "commit_import: only the new rows are inserted; inserted_ids = exactly them");
      eq(JSON.stringify(w.T.contacts.filter((c: any) => [C1, C2, C3].includes(c.id))), JSON.stringify(before), "commit_import: the contacts already there are untouched (insert only)");
      eq([w.T.activity_log.length, w.T.activity_log.every((l: any) => l.record_kind === "contact" && run.inserted_ids.includes(l.record_id) && l.actor === "MCP import" && l.manual === false), w.T.activity_log[0].text], [3, true, 'Added by the import "Leads" from Fake CRM'], "commit_import: one history row per inserted record");
      eq([made.every((c: any) => c.messages[0].quiet === true && c.last_read_at === new Date(T1).toISOString() && c.source === "MCP import"), made[0].phone, made[0].email], [true, "0400 000 001", "cleo@example.com"], "commit_import: quiet by default (automations off), the import source");
      eq(w.T.mcp_import_rules[0].last_run_at, new Date(T1).toISOString(), "commit_import: the rule's last_run_at");
      const c2 = await manage(w, "commit_import", "u-owner", { rule_id: R.id }, T1 + 60e3);
      eq([c2.body.run.inserted, c2.body.run.duplicates, c2.body.run.status, w.T.contacts.length], [0, 6, "done", 6], "commit_import again: nothing new, all duplicates");
      eq((await manage(w, "commit_import", "u-mgr", { rule_id: R.id })).status, 403, "commit_import: owners only");
      const RA = (await save(w, { ...RULE, name: "Loud", run_automations: true }, "u-owner", NOW)).body.rule;
      answerWith([{ name: "Finn Loud", phone: "0400 000 005", email: "" }]);
      const c3 = await manage(w, "commit_import", "u-owner", { rule_id: RA.id }, T1 + 120e3);
      const loud = w.T.contacts.find((c: any) => c.id === c3.body.run.inserted_ids[0]);
      eq([c3.body.run.run_automations, "quiet" in loud.messages[0], loud.last_read_at], [true, false, null], "commit_import with run_automations: a normal new lead (no quiet key), recorded on the run");

      // concurrency
      answerWith(ITEMS);
      const T2 = T1 + 7200e3;
      w.T.mcp_import_runs.push({ id: "77777777-7777-4777-8777-777777777777", business_id: "default", rule_id: R.id, kind: "contacts", status: "running", started_at: new Date(T2 - 60e3).toISOString(), inserted_ids: [], errors: [] });
      const busy = await manage(w, "commit_import", "u-owner", { rule_id: R.id }, T2);
      eq([busy.status, busy.body.reason], [409, "An import of this rule is already running."], "commit_import: a run of this rule already running → 409");
      w.T.mcp_import_runs.find((x: any) => x.id === "77777777-7777-4777-8777-777777777777").started_at = new Date(T2 - 11 * 60e3).toISOString();
      const after = await manage(w, "commit_import", "u-owner", { rule_id: R.id }, T2);
      const stale = w.T.mcp_import_runs.find((x: any) => x.id === "77777777-7777-4777-8777-777777777777");
      eq([after.status, after.body.run.status, stale.status, stale.errors], [200, "done", "failed", [{ reason: "Stopped before it finished" }]], "commit_import: a run 'running' for 11 minutes is closed as failed and the new one goes ahead");

      // partial
      let wp = iw();
      const RP = (await save(wp, RULE, "u-owner", NOW)).body.rule;
      wp.ctl.failValues.add("Dan New");
      const p1 = await manage(wp, "commit_import", "u-owner", { rule_id: RP.id }, T1);
      eq([p1.body.run.status, p1.body.run.inserted, p1.body.run.errors.map((e: any) => [e.i, typeof e.reason]), wp.T.contacts.filter((c: any) => p1.body.run.inserted_ids.includes(c.id)).map((c: any) => c.full_name)],
        ["partial", 2, [[3, "string"]], ["Cleo New", "Eve New"]], "commit_import: a refused row → the chunk goes row by row; partial, the error has its item, the others are in");
      wp = iw();
      const RP2 = (await save(wp, RULE, "u-owner", NOW)).body.rule;
      ["Cleo New", "Dan New", "Eve New"].forEach((n) => wp.ctl.failValues.add(n));
      const p2 = await manage(wp, "commit_import", "u-owner", { rule_id: RP2.id }, T1);
      eq([p2.body.run.status, p2.body.run.inserted, p2.body.run.errors.length, wp.T.contacts.length], ["failed", 0, 3, 3], "commit_import: every row refused → failed, nothing in");
      answerWith(Array.from({ length: 501 }, (_, k) => ({ name: "Q" + k, phone: "0488 000 " + String(k).padStart(3, "0") })));
      wp = iw();
      const RP3 = (await save(wp, RULE, "u-owner", NOW)).body.rule;
      const p3 = await manage(wp, "commit_import", "u-owner", { rule_id: RP3.id }, T1);
      eq([p3.body.run.status, p3.body.run.inserted, p3.body.run.errors, wp.T.activity_log.length], ["done", 500, [{ reason: "Only the first 500 items were read" }], 500], "commit_import: 501 items → 500 in (5 chunks), the cut is noted");
      answerWith(ITEMS);

      // a worker stopped right after a chunk was inserted (before the run was updated): the ids were listed first
      {
        const wk = iw(), RK = (await save(wk, RULE, "u-owner", NOW)).body.rule;
        let runCalls = 0;
        const dying = { ...wk, from: (t: string) => { if (t === "mcp_import_runs" && ++runCalls === 4) throw new Error("worker stopped"); return wk.from(t); } };
        const w0 = wk.ctl.writes.length;
        const ck = await manage(dying, "commit_import", "u-owner", { rule_id: RK.id }, T1);
        const kr = wk.T.mcp_import_runs[0], made = wk.T.contacts.filter((c: any) => ![C1, C2, C3].includes(c.id)).map((c: any) => c.id);
        eq([ck.status, kr.status, made.length, made.every((id: string) => kr.inserted_ids.includes(id)), kr.inserted, wk.ctl.writes.slice(w0).filter((x: string) => x !== "mcp_import_rules.update").slice(0, 4)],
          [500, "running", 3, true, 3, ["mcp_import_runs.update", "mcp_import_runs.insert", "mcp_import_runs.update", "contacts.insert"]], "a chunk's ids are on the run BEFORE the chunk is inserted, so a stopped worker leaves nothing Undo can't find");
        const uk = await manage(wk, "undo_import", "u-owner", { run_id: kr.id }, T1 + RUN_STALE_MS + 60e3);
        eq([uk.body, wk.T.contacts.length], [{ ok: true, deleted: 3, kept: 0, paused: false }, 3], "…and Undo (once the run is stale) takes all three back");
      }

      // undo_import
      const wu = iw();
      const RU = (await save(wu, RULE, "u-owner", NOW)).body.rule;
      const cu = (await manage(wu, "commit_import", "u-owner", { rule_id: RU.id }, T1)).body.run;
      const idOf = (n: string) => wu.T.contacts.find((c: any) => c.full_name === n).id;
      const cleo = idOf("Cleo New"), dan = idOf("Dan New"), eve = idOf("Eve New");
      eq((await manage(wu, "undo_import", "u-mgr", { run_id: cu.id })).status, 403, "undo_import: owners only");
      wu.T.contacts = wu.T.contacts.filter((c: any) => c.id !== dan);   // the office already deleted one
      wu.ctl.failValues.add("Eve New");                                      // something now points at another
      const un = await manage(wu, "undo_import", "u-owner", { run_id: cu.id }, T1 + 60e3);
      const urun = wu.T.mcp_import_runs.find((x: any) => x.id === cu.id);
      eq([un.status, un.body], [200, { ok: true, deleted: 1, kept: 1, paused: false }], "undo_import: deletes its rows; one already gone is no error; one that can't go is kept");
      eq([wu.T.contacts.some((c: any) => c.id === cleo), wu.T.contacts.some((c: any) => c.id === eve), wu.T.contacts.filter((c: any) => [C1, C2, C3].includes(c.id)).length], [false, true, 3], "undo_import: the same-phone contact that was not imported stays");
      eq([wu.T.activity_log.some((l: any) => l.record_id === cleo), wu.T.activity_log.some((l: any) => l.record_id === eve)], [false, true], "undo_import: the history of the deleted rows goes");
      eq([urun.undone_at, urun.undone_by, urun.undo_deleted, urun.undo_kept], [new Date(T1 + 60e3).toISOString(), "u-owner", 1, 1], "undo_import: the run is marked undone (who, when, counts)");
      eq([(await manage(wu, "undo_import", "u-owner", { run_id: cu.id })).status, (await manage(wu, "undo_import", "u-owner", { run_id: cu.id })).body.reason], [409, "Already undone."], "undo_import: a second undo → 409");
      eq([(await manage(wu, "undo_import", "u-owner", { run_id: GONE_SRV })).status, (await manage(wu, "undo_import", "u-owner", { run_id: "x" })).status], [404, 404], "undo_import: an unknown run → 404");
      wu.T.mcp_import_runs.push({ id: "88888888-8888-4888-8888-888888888888", business_id: "default", rule_id: RU.id, kind: "contacts", status: "running", started_at: new Date(T1 + 100e3).toISOString(), inserted_ids: [], errors: [], undone_at: null });
      const ur = await manage(wu, "undo_import", "u-owner", { run_id: "88888888-8888-4888-8888-888888888888" }, T1 + 160e3);
      eq([ur.status, ur.body.reason], [409, "This import is still running."], "undo_import: a running import → 409");
      // an undo stopped in the middle (the platform's time limit) is not marked undone, and resumes once stale
      {
        const wz = iw(), RZ = (await save(wz, RULE, "u-owner", NOW)).body.rule;
        const cz = (await manage(wz, "commit_import", "u-owner", { rule_id: RZ.id }, T1)).body.run, zids: string[] = cz.inserted_ids.slice();
        const zr = () => wz.T.mcp_import_runs.find((x: any) => x.id === cz.id);
        const stop: any = new Proxy(wz, { get(t: any, k: any) {
          if (k !== "from") return t[k];
          return (tb: string) => { const q = t.from(tb); if (tb === "contacts") q.delete = () => { throw new Error("stopped by the time limit"); }; return q; };
        } });
        let stopped = "";
        try { await undoImport(stop, cz.id, { id: "u-owner" }, T1 + 60e3); } catch (e) { stopped = (e as Error).message; }
        eq([zids.length, stopped, zr().undone_at ?? null, zr().undo_started_at, wz.T.contacts.filter((c: any) => zids.includes(c.id)).length], [3, "stopped by the time limit", null, iso(T1 + 60e3), 3],
          "undo_import: an undo stopped in the middle is only claimed (undo_started_at), never marked undone with its records still there");
        const busy = await manage(wz, "undo_import", "u-owner", { run_id: cz.id }, T1 + 120e3);
        eq([busy.status, busy.body.reason], [409, "This import is being undone right now."], "undo_import: a second undo while one is under way → 409");
        // the stopped undo had deleted one record and saved its count
        wz.T.contacts = wz.T.contacts.filter((c: any) => c.id !== zids[0]); zr().undo_deleted = 1;
        const at = T1 + 60e3 + UNDO_STALE_MS + 1000, res = await manage(wz, "undo_import", "u-owner", { run_id: cz.id }, at);
        eq([res.body, zr().undone_at, zr().undo_deleted, wz.T.contacts.filter((c: any) => zids.includes(c.id)).length], [{ ok: true, deleted: 3, kept: 0, paused: false }, iso(at), 3, 0],
          "undo_import: pressed again once stale it resumes, deletes the rest, carries the count on (1 + 2) and only then marks the run undone");
      }
      // records the team has used since are kept with their history; the import's own entries of deleted records go
      {
        const wv = iw(), RV = (await save(wv, RULE, "u-owner", NOW)).body.rule;
        const cv = (await manage(wv, "commit_import", "u-owner", { rule_id: RV.id }, T1)).body.run;
        const id = (n: string) => wv.T.contacts.find((c: any) => c.full_name === n).id, cleo = id("Cleo New"), dan = id("Dan New"), eve = id("Eve New");
        wv.T.lead_messages = [{ id: "lm1", contact_id: cleo, channel: "sms", direction: "in", body: "Yes please" }];
        wv.T.activity_log.push({ id: "al-riley", record_kind: "contact", record_id: dan, actor: "Riley", text: "Stage → Quoted", manual: true, at: new Date(T1 + 5e3).toISOString() });
        const uv = await manage(wv, "undo_import", "u-owner", { run_id: cv.id }, T1 + 60e3);
        eq([uv.body, wv.T.contacts.some((c: any) => c.id === cleo), wv.T.contacts.some((c: any) => c.id === dan), wv.T.contacts.some((c: any) => c.id === eve), wv.T.lead_messages.length],
          [{ ok: true, deleted: 1, kept: 2, paused: false }, true, true, false, 1], "undo_import: a lead with a text thread and a lead the team worked on are kept (their thread would cascade away); the untouched one goes");
        eq(wv.T.activity_log.map((l: any) => [l.record_id === cleo ? "cleo" : l.record_id === dan ? "dan" : "eve", l.actor]).sort(), [["cleo", "MCP import"], ["dan", "MCP import"], ["dan", "Riley"]], "undo_import: only the import's own history entry of the deleted lead goes; Riley's entry and the kept leads' history stay");
        const wz = iw({ closings: [{ id: "cl9", linked_job_id: "J1" }], contacts: [{ id: "K1", messages: [{}, {}] }, { id: "K2", messages: [{}], stage_changed_at: "2026-10-14T00:00:00Z" }, { id: "K3", messages: [{}] }, { id: "K4", messages: [{}] }, { id: "K5", messages: [{}], linked_job_id: "J2" }],
          calls: [{ id: "c9", contact_id: "K3" }], tasks: [{ id: "T1", updates: [{ text: "done" }], subtasks: [] }, { id: "T2", updates: [], subtasks: [] }, { id: "T3", updates: [], subtasks: [{ t: 1 }] }] });
        eq([[...await usedSince(wz, "contacts", ["K1", "K2", "K3", "K4", "K5"])].sort(), [...await usedSince(wz, "jobs", ["J1", "J2", "J3"])].sort(), [...await usedSince(wz, "tasks", ["T1", "T2", "T3"])].sort()],
          [["K1", "K2", "K3", "K5"], ["J1", "J2"], ["T1", "T3"]], "usedSince: a grown thread, a stage move, a call, a linked job; a job a closing or lead points at; a task with updates or subtasks");
        // a review request waiting to go out for an imported job keeps the job (else the text still goes, for a job that is gone)
        const wr = iw({ review_requests: [{ id: "rr1", job_id: "J3", status: "waiting" }, { id: "rr2", job_id: null, status: "sent" }] });
        eq([...await usedSince(wr, "jobs", ["J3", "J4"])], ["J3"], "usedSince: a job with a review request (waiting or sent) is used");
        const wrx = fakeDb(JSON.parse(JSON.stringify(iw().T)), { users: USERS(), jwts: JWTS, fail: ["review_requests"] });
        eq([...await usedSince(wrx, "jobs", ["J4"])], ["J4"], "usedSince: review requests that can't be read keep the job");
        const wf = fakeDb(JSON.parse(JSON.stringify(wz.T)), { users: USERS(), jwts: JWTS, fail: ["lead_messages"] });
        eq([...await usedSince(wf, "contacts", ["K4"])], ["K4"], "usedSince: a check that can't be read keeps the record (never deletes blind)");
        // an automation already texted / emailed the lead (sent, queued, or sending right now): Undo keeps it. A skipped,
        // failed or waiting_phone step sent nothing (waiting_phone is final: no texts without Twilio), and a team push is not the customer
        const wa = iw({ contacts: ["A1", "A2", "A3", "A4", "A5", "A6", "A7"].map((id) => ({ id, messages: [{}] })),
          automation_log: [{ id: "x1", contact_id: "A1", audience: "customer", channel: "text", status: "sent" }, { id: "x2", contact_id: "A2", audience: "customer", channel: "email", status: "queued" },
            { id: "x3", contact_id: "A3", audience: "customer", channel: "text", status: "skipped" }, { id: "x4", contact_id: "A4", audience: "team", channel: "push", status: "sent" },
            { id: "x5", contact_id: "A5", audience: "customer", channel: "text", status: "failed" }, { id: "x6", contact_id: "A6", audience: "customer", channel: "email", status: "sending" },
            { id: "x7", contact_id: "A7", audience: "customer", channel: "text", status: "waiting_phone" }] });
        eq([...await usedSince(wa, "contacts", ["A1", "A2", "A3", "A4", "A5", "A6", "A7"])].sort(), ["A1", "A2", "A6"], "usedSince: a lead an automation texted or emailed (sent, queued, sending) is used; a skipped, failed or waiting_phone step or a push to the team is not");
        const wax = fakeDb(JSON.parse(JSON.stringify(wa.T)), { users: USERS(), jwts: JWTS, fail: ["automation_log"] });
        eq([...await usedSince(wax, "contacts", ["A4"])], ["A4"], "usedSince: an automation log that can't be read keeps the lead");
        {
          const wq = iw(), RQ = (await save(wq, { ...RULE, run_automations: true }, "u-owner", NOW)).body.rule;
          const cq = (await manage(wq, "commit_import", "u-owner", { rule_id: RQ.id }, T1)).body.run;
          const texted = wq.T.contacts.find((c: any) => c.full_name === "Cleo New").id;
          wq.T.automation_log = [{ id: "al-auto", contact_id: texted, audience: "customer", channel: "text", status: "sent", automation_name: "Welcome text" }];
          const uq = await manage(wq, "undo_import", "u-owner", { run_id: cq.id }, T1 + 60e3);
          eq([uq.body, wq.T.contacts.some((c: any) => c.id === texted), wq.T.contacts.filter((c: any) => cq.inserted_ids.includes(c.id)).length], [{ ok: true, deleted: 2, kept: 1, paused: false }, true, 1],
            "undo_import: the lead an automation already texted is kept; the others go");
        }
        // a lead with 1,500 texts and 1,200 history entries sits in front of the others: the server answers at most 1,000
        // rows a request, so a single read would never see L2's text or L3's entry (and Undo would delete them)
        const lots = (n: number, f: (i: number) => any) => Array.from({ length: n }, (_, i) => f(i));
        const big = {
          contacts: [{ id: "L1", messages: [{}] }, { id: "L2", messages: [{}] }, { id: "L3", messages: [{}] }, { id: "L4", messages: [{}] }, { id: "L5", messages: [{}], contacted_at: "2026-10-14T02:00:00Z" },
            { id: "L6", messages: [{}], customer_notes: [{ id: "n1", text: "Gate code 1234", by: "Ann", at: "2026-10-14T02:00:00Z" }] }, { id: "L7", messages: [{}], contacted_at: null, customer_notes: [] }],
          lead_messages: [...lots(1500, (i) => ({ id: "lm" + i, contact_id: "L1" })), { id: "lmx", contact_id: "L2" }],
          activity_log: [...lots(1200, (i) => ({ id: "al" + i, record_kind: "contact", record_id: "L1", actor: "Ann", text: "Called" })), { id: "aly", record_kind: "contact", record_id: "L3", actor: "Ann", text: "Called" }],
        };
        const capped = fakeDb(JSON.parse(JSON.stringify(big)), { maxRows: 1000 });
        const all7 = ["L1", "L2", "L3", "L4", "L5", "L6", "L7"];
        eq([...await usedSince(capped, "contacts", all7)].sort(), ["L1", "L2", "L3", "L5", "L6"], "usedSince: every read is paged past the server's 1,000-row cap (L2's text, L3's history); a lead called (contacted_at) or noted (customer_notes) is used");
        ok((capped.ranges.lead_messages || 0) >= 2 && (capped.ranges.activity_log || 0) >= 2, "usedSince: the big tables were read in more than one page");
        // and Undo end to end: the lead the team texted, behind 1,500 other texts, is kept
        const wb = iw(), RB = (await save(wb, RULE, "u-owner", NOW)).body.rule;
        const cb = (await manage(wb, "commit_import", "u-owner", { rule_id: RB.id }, T1)).body.run;
        const bid = (n: string) => wb.T.contacts.find((c: any) => c.full_name === n).id, b1 = bid("Cleo New"), b2 = bid("Dan New"), b3 = bid("Eve New");
        wb.T.lead_messages = [...lots(1500, (i) => ({ id: "bm" + i, contact_id: b1 })), { id: "bmx", contact_id: b2 }];
        wb.T.contacts.find((c: any) => c.id === b3).customer_notes = [{ id: "n2", text: "Back on Monday", by: "Ann", at: new Date(T1).toISOString() }];
        const wbc = fakeDb(wb.T, { users: USERS(), jwts: JWTS, maxRows: 1000 });
        const ub = await manage(wbc, "undo_import", "u-owner", { run_id: cb.id }, T1 + 60e3);
        eq([ub.body, [b1, b2, b3].map((x) => wbc.T.contacts.some((c: any) => c.id === x)), wbc.T.lead_messages.length], [{ ok: true, deleted: 0, kept: 3, paused: false }, [true, true, true], 1501], "undo_import with the server's row cap: the leads with texts (one behind 1,500 others) and the noted lead are all kept");
      }

      // delete_rule, then undo its import
      wu.ctl.failValues.clear();
      answerWith([{ name: "Gil New", phone: "0400 000 006", email: "" }]);
      const cg = (await manage(wu, "commit_import", "u-owner", { rule_id: RU.id }, T1 + 30 * 60e3)).body.run;
      eq((await manage(wu, "delete_rule", "u-mgr", { id: RU.id })).status, 403, "delete_rule: owners only");
      const dr = await manage(wu, "delete_rule", "u-owner", { id: RU.id });
      eq([dr.status, wu.T.mcp_import_rules.length, wu.T.mcp_import_runs.filter((x: any) => x.rule_name === "Leads").every((x: any) => x.rule_id === null), wu.T.mcp_import_runs.length], [200, 0, true, 3], "delete_rule: the rule goes; its runs stay (rule_id cleared, rule_name kept)");
      eq((await manage(wu, "delete_rule", "u-owner", { id: RU.id })).status, 404, "delete_rule: again → 404");
      const ug = await manage(wu, "undo_import", "u-owner", { run_id: cg.id }, T1 + 40 * 60e3);
      eq([ug.body, wu.T.contacts.some((c: any) => c.full_name === "Gil New")], [{ ok: true, deleted: 1, kept: 0, paused: false }, false], "undo_import: still works after its rule was deleted");
      // an hourly rule's import: undo switches the rule off
      const RH = (await save(wu, { ...RULE, name: "Every hour", mode: "hourly", enabled: true }, "u-owner", NOW)).body.rule;
      answerWith([{ name: "Hal New", phone: "0400 000 007", email: "" }]);
      const ch = (await manage(wu, "commit_import", "u-owner", { rule_id: RH.id }, T1 + 50 * 60e3)).body.run;
      const uh = await manage(wu, "undo_import", "u-owner", { run_id: ch.id }, T1 + 51 * 60e3);
      eq([uh.body.paused, wu.T.mcp_import_rules.find((r: any) => r.id === RH.id).enabled], [true, false], "undo_import: an hourly rule is switched off (or the next hour would bring it all back)");
      // an import of the same rule still running (claimed before the pause) would add the deleted rows again: Undo deletes
      // nothing until it finishes, hands its claim back, and works once it has
      {
        const RB2 = (await save(wu, { ...RULE, name: "Busy hour", mode: "hourly", enabled: true }, "u-owner", NOW)).body.rule;
        answerWith([{ name: "Ivy New", phone: "0400 000 008", email: "" }]);
        const ca = (await manage(wu, "commit_import", "u-owner", { rule_id: RB2.id }, T1 + 52 * 60e3)).body.run;
        wu.T.mcp_import_runs.push({ id: "b2222222-2222-4222-8222-222222222222", business_id: "default", rule_id: RB2.id, rule_name: "Busy hour", kind: "contacts", source: "hourly", status: "running", started_at: new Date(T1 + 53 * 60e3).toISOString() });
        const ub2 = await manage(wu, "undo_import", "u-owner", { run_id: ca.id }, T1 + 54 * 60e3);
        const runA = () => wu.T.mcp_import_runs.find((x: any) => x.id === ca.id);
        eq([ub2.status, ub2.body.reason, wu.T.contacts.some((c: any) => c.full_name === "Ivy New"), wu.T.mcp_import_rules.find((r: any) => r.id === RB2.id).enabled, runA().undo_started_at ?? null, runA().undone_at ?? null],
          [409, "An import of this rule is running; undo it when it finishes.", true, false, null, null], "undo_import: another run of the rule still running → 409, nothing deleted, the rule off, the undo claim handed back");
        wu.T.mcp_import_runs.find((x: any) => x.id === "b2222222-2222-4222-8222-222222222222").status = "done";
        const ub3 = await manage(wu, "undo_import", "u-owner", { run_id: ca.id }, T1 + 55 * 60e3);
        eq([ub3.body, wu.T.contacts.some((c: any) => c.full_name === "Ivy New")], [{ ok: true, deleted: 1, kept: 0, paused: true }, false], "undo_import: once that run has finished, Undo goes ahead");
      }

      // jobs and tasks end to end
      const wj = iw({ jobs: [{ id: "j-old", customer_name: "Old", invoice_number: "INV-2001", date: "2026-10-01" }] });
      const RJ = (await save(wj, { ...RULE, kind: "jobs", name: "Jobs", mapping: { customer_name: "c", invoice_number: "n", amount: "a", payment_status: "p" }, dedupe: { fields: ["invoice_number"], match: "any" } }, "u-owner", NOW)).body.rule;
      answerWith([{ c: "Ann", n: "2001", a: "$300", p: "paid" }, { c: "Bob", n: "INV-2002", a: "120.5", p: "Unpaid" }]);
      const cj = (await manage(wj, "commit_import", "u-owner", { rule_id: RJ.id }, T1)).body.run;
      const nj = wj.T.jobs.find((j: any) => j.invoice_number === "INV-2002");
      eq([cj.inserted, cj.duplicates, nj.amount, nj.created_at, nj.review_do_not_ask, nj.entered_by, wj.T.activity_log[0].record_kind], [1, 1, 120.5, null, true, "MCP import: Jobs", "job"], "jobs import: 'INV-2001' matches '2001'; a quiet job (no created_at, no review request)");
      const wr = iw({ commission_rates: [{ technician_name: "Gabe", rates: { Aircon: 30 } }] });
      const RR = (await save(wr, { ...RULE, kind: "jobs", name: "Paid jobs", mapping: { customer_name: "c", invoice_number: "n", technician: "t", job_type: "j", amount: "a" }, dedupe: { fields: ["invoice_number"], match: "any" } }, "u-owner", NOW)).body.rule;
      answerWith([{ c: "Ann", n: "3001", t: "gabe", j: "Aircon", a: 200 }, { c: "Bob", n: "3002", t: "dan", j: "Aircon", a: 100 }]);
      const cr = (await manage(wr, "commit_import", "u-owner", { rule_id: RR.id }, T1)).body.run;
      const ann = wr.T.jobs.find((j: any) => j.invoice_number === "3001");
      eq([cr.status, cr.inserted, cr.errors.map((e: any) => e.reason), ann.technician, ann.commission_percent, ann.includes_gst, wr.T.jobs.some((j: any) => j.invoice_number === "3002")],
        ["partial", 1, ["Technician is not someone on the team"], "Gabe", 30, true, false], "jobs import: Dan's rate 30% filled in, GST on as in the app; a technician who isn't on the team is a problem row, not an invisible job");
      // automatic review asking queued a text for the imported job: Undo keeps that job (its text would still go out)
      wr.T.review_requests = [{ id: "rr-ann", job_id: ann.id, invoice_number: "3001", status: "waiting" }];
      const urr = await manage(wr, "undo_import", "u-owner", { run_id: cr.id }, T1 + 60e3);
      eq([urr.body, wr.T.jobs.some((j: any) => j.id === ann.id)], [{ ok: true, deleted: 0, kept: 1, paused: false }, true], "undo_import: an imported job with a waiting review request is kept");
      const wt = iw();
      const RT = (await save(wt, { ...RULE, kind: "tasks", name: "Tasks", mapping: { title: "t", due: "d", assigned_to: "who" }, dedupe: { fields: ["title", "due"], match: "all" } }, "u-owner", NOW)).body.rule;
      answerWith([{ t: "Call Ann", d: "2026-10-20", who: "gabe" }, { t: "Call Bob", d: "2026-10-21", who: "Stranger" }, { t: "Call Cy", d: "2026-10-22" }]);
      const ct = (await manage(wt, "commit_import", "u-owner", { rule_id: RT.id }, T1)).body.run;
      const nt = wt.T.tasks.filter((t: any) => ct.inserted_ids.includes(t.id));
      eq([ct.status, ct.inserted, ct.errors.map((e: any) => e.reason), nt.map((t: any) => [t.title, t.board, t.assignees])], ["partial", 2, ["Assigned to is not someone on the team"], [["Call Ann", "Gabe", ["Gabe"]], ["Call Cy", "ron", []]]], "tasks import: only active employees can be assigned; boards by the app's rule");

      // the hourly timer
      const waits: Promise<unknown>[] = [];
      io.waitUntil = (p: Promise<unknown>) => { waits.push(p); };
      let tNow = Date.parse("2026-10-14T05:17:00Z");
      io.now = () => tNow;
      const mk = (id: string, o: any) => ({ ...RULE, id, business_id: "default", enabled: true, run_automations: false, mode: "hourly", last_run_at: null, tool_args: { tag: id.slice(0, 2) }, ...o });
      const wc = iw({
        mcp_import_rules: [
          mk("a1111111-1111-4111-8111-111111111111", { name: "H1" }),
          mk("a2222222-2222-4222-8222-222222222222", { name: "H2", last_run_at: new Date(tNow - 2 * 3600e3).toISOString() }),
          mk("a3333333-3333-4333-8333-333333333333", { name: "Manual", mode: "manual" }),
          mk("a4444444-4444-4444-8444-444444444444", { name: "Off", enabled: false }),
          mk("a5555555-5555-4555-8555-555555555555", { name: "Recent", last_run_at: new Date(tNow - 10 * 60e3).toISOString() }),
          mk("a6666666-6666-4666-8666-666666666666", { name: "No server", server_id: GONE_SRV }),
        ],
      });
      answerWith(ITEMS);
      const n0 = toolCalls.length;
      eq([handleCron(wc, "", "test-cron-secret").status, handleCron(wc, "wrong", "test-cron-secret").status, waits.length, toolCalls.length - n0], [401, 401, 0, 0], "cron: no or a wrong secret → 401, nothing called");
      eq(handleCron(wc, "test-cron-secret", "test-cron-secret"), { status: 202, body: { ok: true } }, "cron: the right secret → 202 at once");
      await Promise.all(waits);
      const ran = wc.T.mcp_import_runs.map((x: any) => [x.rule_name, x.source]).sort();
      eq([ran, toolCalls.slice(n0).map((c: any) => c.args.tag).sort()], [[["H1", "hourly"], ["H2", "hourly"]], ["a1", "a2"]], "cron: only the enabled hourly rules ran, each once, as 'hourly' (not a manual, a disabled, a recently run rule, or one whose server is gone)");
      eq(wc.T.mcp_import_runs.map((x: any) => x.started_by), [null, null], "cron: no person started them");
      handleCron(wc, "test-cron-secret", "test-cron-secret");
      await Promise.all(waits);
      eq([wc.T.mcp_import_runs.length, toolCalls.length - n0], [2, 2], "cron: a second timer right after runs nothing (each rule claimed for the hour)");
      tNow += 3600e3;
      const n1 = toolCalls.length;
      answer = () => { tNow += CRON_BUDGET_MS + 1; return { ok: true, result: { content: [{ type: "text", text: JSON.stringify({ items: [] }) }] } }; };
      const out = await cronImports(wc, tNow);
      eq([toolCalls.length - n1, out.ran, out.deferred], [1, 1, 3], "cron: past CRON_BUDGET_MS no further rule starts; they wait for the next hour");
      ok(CRON_BUDGET_MS + CLIENT.budgetMs <= 90e3, "cron: the last rule's start plus its server time stays well inside the platform's 150 s for background work");
      // Undo switches the rule off after the timer read its list: the claim checks enabled, so it never runs and brings the rows back
      {
        answerWith(ITEMS);
        const RACE = "a7777777-7777-4777-8777-777777777777", wrc = iw({ mcp_import_rules: [mk(RACE, { name: "Raced" })] });
        let reads = 0;
        const raced: any = new Proxy(wrc, { get(t: any, k: any) {
          if (k !== "from") return t[k];
          return (tb: string) => {
            if (tb === "mcp_import_rules" && ++reads === 2) t.T.mcp_import_rules.find((r: any) => r.id === RACE).enabled = false;   // the undo, between the list and the claim
            return t.from(tb);
          };
        } });
        const n2 = toolCalls.length, o2 = await cronImports(raced, tNow);
        eq([o2.ran, o2.skipped, toolCalls.length - n2, wrc.T.mcp_import_runs.length, wrc.T.mcp_import_rules[0].last_run_at], [0, 1, 0, 0, null], "cron: a rule switched off (by Undo) after the list was read is not claimed and does not run");
      }
      // Undo switches the rule off after the claim, while the hourly run fetches: the run reads the rule again before it
      // inserts, and adds nothing
      {
        const LATE = "a8888888-8888-4888-8888-888888888888", wl = iw({ mcp_import_rules: [mk(LATE, { name: "Late" })] }), before = wl.T.contacts.length;
        answer = () => { wl.T.mcp_import_rules[0].enabled = false; return { ok: true, result: { content: [{ type: "text", text: JSON.stringify({ items: ITEMS }) }] } }; };
        const o3 = await cronImports(wl, tNow), r3 = wl.T.mcp_import_runs[0];
        eq([o3.ran, wl.T.mcp_import_runs.length, r3.status, r3.inserted, (r3.errors || []).map((e: any) => e.reason), wl.T.contacts.length - before],
          [1, 1, "failed", 0, ["The rule was switched off, so the rest was not imported"], 0], "cron: a rule switched off (by Undo) between the claim and the insert adds nothing");
      }
    } finally {
      io.callTool = origCall; io.waitUntil = origWait; io.now = origNow; io.fetch = origFetch4;
    }
  }

  console.log(`mcp: ${pass} passed, ${fail} failed`);
  if (fail) (globalThis as any).process?.exit(1);
})().catch((e) => { console.log("mcp tests crashed:", e && e.stack || e); console.log(`mcp: ${pass} passed, ${fail + 1} failed`); (globalThis as any).process?.exit(1); });
