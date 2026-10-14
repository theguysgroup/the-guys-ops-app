// Stage 2 phase 1 — OFFLINE differential harness (design §8.3 #1; group G1.4). Run through run.sh (it builds a temporary folder).
// deno-lint-ignore-file no-explicit-any
import "./setup.ts";
import * as OLD from "./old.ts";
import * as NEW from "./new.ts";
import * as RB from "./rb.ts";
import { fakeDb, SQL_SIGS, sqlSigs } from "./fake.ts";
import * as fs from "node:fs";

const WT = process.env.WT as string, DIFF_DIR = process.env.DIFF_DIR as string;
const args = process.argv.slice(2);
const abs = (f: string) => (!f || f.startsWith("/") ? f : (process.env.ORIG_PWD || ".") + "/" + f);
const corpusArg = abs(args.includes("--corpus") ? args[args.indexOf("--corpus") + 1] : "");
const QUICK = args.includes("--quick");
const recordsArg = abs(args.includes("--records") ? args[args.indexOf("--records") + 1] : "");
const say = console.log.bind(console);

// ── the same SQL signatures the tests use: the fake refuses an RPC call whose argument names do not fit ──
{
  const dir = WT + "/.claude/sql/";
  const files = fs.readdirSync(dir).filter((f: string) => f.endsWith(".sql") && f !== "stage2-automations.sql").sort().concat(["stage2-automations.sql"]);
  for (const f of files) Object.assign(SQL_SIGS, sqlSigs(fs.readFileSync(dir + f, "utf8")));
}

// ── the outside world, shared by the three engines ──
type Engine = { name: string; M: any; wrap?: (db: any) => any };
// the database before SQL Part 1 as the v2 build sees it: automation_state has no phase4_compat column (Postgres 42703)
const noPart1 = (db: any) => ({ ...db, from: (t: string) => {
  const q = db.from(t);
  if (t !== "automation_state") return q;
  const sel = q.select;
  q.select = (cols?: string) => (cols && /phase4_compat/.test(cols) ? { eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: "42703", message: "column automation_state.phase4_compat does not exist" } }) }) } : sel(cols));
  return q;
} });
const ENG: Record<string, Engine> = { old: { name: "old", M: OLD }, new: { name: "new", M: NEW }, rb: { name: "rb", M: RB },
  nf: { name: "nf", M: NEW, wrap: noPart1 } };   // nf = the v2 build deployed before Part 1 (its phase-4 fallback)
let clock = 0;
let PUSHES: any[] = [];
for (const { M } of Object.values(ENG)) {
  M.io.now = () => clock;
  M.io.send = async (sub: any, payload: string) => { PUSHES.push({ to: sub.endpoint, ...JSON.parse(payload) }); return { statusCode: 201 }; };
  M.io.build = () => ({ method: "POST", headers: { Authorization: "vapid" }, body: new Uint8Array(1) });
  M.io.generate = () => ({ publicKey: "PUB", privateKey: "PRIV" });
  M.io.waitUntil = () => {};
  M.io.holidayLib = async () => { throw new Error("offline"); };
}
(globalThis as any).fetch = () => { throw new Error("network is not allowed in the differential"); };
// console lines of the engines: known noise dropped, everything else kept per world (and compared)
const NOISE = /public holidays not worked out|^automations engine: /;
let LINES: string[] = [];
console.error = (...x: any[]) => { const s = x.map(String).join(" "); if (!NOISE.test(s)) LINES.push("error: " + s); };
console.log = (...x: any[]) => { const s = x.map(String).join(" "); if (!NOISE.test(s)) LINES.push("log: " + s); };

// ── the business ──
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60e3, HR = 60 * MIN, DAY = 24 * HR;
const syd = (day: string, h: number, m = 0) => NEW.zoneToUtc(day, h, m, "Australia/Sydney");
const sydDay = (ms: number) => NEW.zoneParts(ms, "Australia/Sydney").day;
const CATALOG = {
  services: [{ key: "Aircon", label: "Aircon cleaning" }, { key: "s9q", label: "Gutter cleaning" }],
  sources: [{ key: "Google Ads", label: "Google Ads" }, { key: "Referral", label: "A friend" }],
  stages: [{ key: "New", label: "New" }, { key: "Quoted", label: "Quote sent" }, { key: "Booked", label: "Booked" }, { key: "Won", label: "Won" }, { key: "Lost", label: "Lost" }],
  tags: [{ tag: "VIP" }, { tag: "test" }],
  brands: { Aircon: "Fresh Air Co" },
  templates: { welcomeEmail: "{hi}, thanks for asking {business_name} about {service}.", reviewSms: "{hi}, how did {technician} go? A review helps us.",
    reviewEmailBody: "{hi}, thanks for choosing {business_name}. How did we go?", chatOpen: "{hi}, {agent} from {business_name} here.", missedCall: "{hi}, sorry we missed your call." },
  hours: { nsw: true },
  holidays: { region: "AU-NSW", days: { "2026-10-05": "Labour Day", "2026-12-25": "Christmas Day", "2026-12-26": "Boxing Day", "2027-01-01": "New Year's Day", "2027-01-26": "Australia Day" } },
};
const PROFILES = [
  { id: "u-owner", full_name: "Olivia Owner", role: "owner", permissions: {}, technician_name: null },
  { id: "u-mgr", full_name: "Max Manager", role: "manager", permissions: {}, technician_name: null },
  { id: "u-va", full_name: "Vicky Va", role: "va", permissions: { crm: true }, technician_name: null, on_duty: true, on_duty_date: "2026-10-14" },
  { id: "u-tech", full_name: "Guy Tech", role: "technician", permissions: { jobs: true }, technician_name: "Guy Tech" },
];
const OWNER = PROFILES[0];

type Mut = { off: number; what: string; fn?: (db: any) => void; app?: { type: string; id: string } };
type Scn = { name: string; t0: number; signer?: string | null; maker?: string; settings?: any; seed?: (r: any) => void; muts?: Mut[]; outage?: [number, number];
  tables?: any; only?: string };   // tables = a live shadow world (the exported records); only = run just this automation id

function records(t0: number) {
  const day = sydDay(t0), old = t0 - 3 * DAY, older = t0 - 30 * DAY;
  return {
    contacts: [
      { id: "c1", full_name: "Sam Smith", phone: "0412 345 678", email: "sam@example.com", postcode: "2000", division: "Aircon", source: "Google Ads", status: "New", tags: [], created_at: day,
        contacted_at: null, last_read_at: null, reopened_at: null, messages: [{ at: iso(t0) }], stage_changed_at: null, linked_job_id: null, booked_for: null, next_follow_up: null },
      { id: "c2", full_name: "Kim Park", phone: "0400 111 222", email: "kim@example.com", postcode: "2010", division: "s9q", source: "Referral", status: "Quoted", tags: ["VIP"], created_at: sydDay(old),
        contacted_at: iso(old + HR), last_read_at: null, reopened_at: null, messages: [{ at: iso(old) }], stage_changed_at: iso(t0), linked_job_id: null, booked_for: null, next_follow_up: null },
      { id: "c3", full_name: "Pat Lee", phone: "0400 555 666", email: "pat@example.com", postcode: "2020", division: "Aircon", source: "Google Ads", status: "Won", tags: [], created_at: sydDay(older),
        contacted_at: iso(older + HR), last_read_at: null, reopened_at: null, messages: [{ at: iso(older) }], stage_changed_at: iso(older + DAY), linked_job_id: "j1", booked_for: null, next_follow_up: null },
      { id: "c4", full_name: "Lee Wong", phone: "0400 333 444", email: "lee@example.com", postcode: "2030", division: "Aircon", source: "Google Ads", status: "Booked", tags: [], created_at: sydDay(old),
        contacted_at: iso(old + HR), last_read_at: null, reopened_at: null, messages: [{ at: iso(old) }], stage_changed_at: iso(t0), linked_job_id: null, booked_for: null, next_follow_up: null },
    ],
    jobs: [{ id: "j1", customer_name: "Pat Lee", invoice_number: "INV-1", date: day, job_type: "Aircon", technician: "Guy Tech", amount: 480, payment_status: "Unpaid", review_do_not_ask: false,
      contact_id: "c3", created_at: iso(t0) }],
    calls: [{ id: "k1", from_number: "+61412345678", to_number: "+61200000000", direction: "inbound", missed: true, started_at: iso(t0), created_at: iso(t0), division: "Aircon", contact_id: "c1", status: "no-answer" }],
    chat_sessions: [{ id: "s1", contact_id: "c1", phone: "0412 345 678", first_name: "Sam", full_name: "Sam Smith", service_key: "Aircon", brand: "", service_text: "", test: false, created_at: iso(t0) }],
    lead_messages: [] as any[], customer_opt_outs: [] as any[], review_requests: [] as any[],
  };
}
const WED = syd("2026-10-14", 14, 7);
const SCENARIOS: Scn[] = [
  { name: "in hours (Wed 14:07)", t0: WED },
  { name: "outside hours (Wed 21:33)", t0: syd("2026-10-14", 21, 33) },
  { name: "the night before daylight saving (Sat 3 Oct 21:30)", t0: syd("2026-10-03", 21, 30) },
  { name: "public holiday (Mon 5 Oct 10:00)", t0: syd("2026-10-05", 10, 0) },
  { name: "weekend morning (Sat 17 Oct 06:40)", t0: syd("2026-10-17", 6, 40) },
  { name: "opted out (every card, every channel)", t0: WED, seed: (r) => { r.customer_opt_outs = ["c1", "c2", "c3", "c4"].map((c, i) => ({ id: "o" + i, business_id: "default", contact_id: c, channel: "all", value_key: null })); } },
  { name: "test records", t0: WED, seed: (r) => { r.contacts.forEach((c: any) => { c.tags = ["test"]; }); r.chat_sessions[0].test = true; } },
  { name: "capped (another function texted everyone an hour ago)", t0: WED,
    seed: (r) => { r.lead_messages = ["c1", "c2", "c3", "c4"].map((c, i) => ({ id: "lm" + i, contact_id: c, channel: "text", direction: "out", auto: true, status: "sent", body: "hi", at: iso(WED - HR) })); } },
  { name: "stage undone within 30 s", t0: WED, muts: [{ off: 10e3, what: "undo", fn: (db) => { for (const id of ["c2", "c4"]) Object.assign(db.T.contacts.find((c: any) => c.id === id), { status: "New", stage_changed_at: iso(WED - 3 * DAY + HR) }); } }] },
  { name: "stage moved on after the run started", t0: WED, muts: [{ off: 5 * MIN, what: "moved on", fn: (db) => { for (const id of ["c2", "c4"]) Object.assign(db.T.contacts.find((c: any) => c.id === id), { status: "Won", stage_changed_at: iso(WED + 5 * MIN) }); } }] },
  { name: "no customer card (job, call and chat not linked)", t0: WED, seed: (r) => { r.jobs[0].contact_id = null; r.calls[0].contact_id = null; r.chat_sessions[0].contact_id = null; } },
  { name: "card linked 4 minutes later", t0: WED, seed: (r) => { r.jobs[0].contact_id = null; r.calls[0].contact_id = null; },
    muts: [{ off: 4 * MIN, what: "linked", fn: (db) => { db.T.jobs[0].contact_id = "c3"; db.T.calls[0].contact_id = "c1"; } }] },
  { name: "late (the timer was down for 30 hours)", t0: WED, outage: [2 * MIN, 30 * HR] },
  { name: "no email signer and no maker name", t0: WED, signer: null, maker: "" },
  { name: "picked up and chat answered", t0: WED,
    muts: [{ off: 3 * MIN, what: "picked up", fn: (db) => { Object.assign(db.T.contacts[0], { contacted_at: iso(WED + 3 * MIN), status: "Contacted" });
      db.T.lead_messages.push({ id: "lm-ans", contact_id: "c1", channel: "chat", direction: "out", auto: false, status: "sent", body: "hello", at: iso(WED + 3 * MIN) }); } }] },
  { name: "don't ask + asked lately + paid", t0: WED, seed: (r) => { r.jobs[0].review_do_not_ask = true; r.jobs[0].payment_status = "Paid";
    r.review_requests = [{ id: "rr1", status: "sent", phone: "+61400555666", email: "pat@example.com", created_at: iso(WED - 10 * DAY), sent_at: iso(WED - 10 * DAY) }]; } },
  { name: "the app's 'look now' for every record", t0: WED,
    muts: [{ off: 20e3, what: "app event", app: { type: "newLead", id: "c1" } }, { off: 40e3, what: "app event", app: { type: "stage", id: "c2" } },
      { off: 45e3, what: "app event", app: { type: "jobClosed", id: "j1" } }, { off: 50e3, what: "app event", app: { type: "missedCall", id: "k1" } }, { off: 55e3, what: "app event", app: { type: "chat", id: "s1" } }] },
];

// ── the corpus ──
const builtin = JSON.parse(fs.readFileSync(DIFF_DIR + "/corpus/builtin.json", "utf8")).automations as any[];
const upgrade = JSON.parse(fs.readFileSync(WT + "/supabase/functions/automations/fixtures/upgrade.json", "utf8")).cases.map((c: any) => ({ name: "upgrade.json: " + c.name, trigger: c.v1.trigger, steps: c.v1.steps }));
const live: any[] = corpusArg ? (JSON.parse(fs.readFileSync(corpusArg, "utf8")) as any[]).map((a) => ({ ...a, name: "live: " + String(a.name || a.id) })) : [];
const CORPUS = [...builtin, ...upgrade, ...live].map((a, i) => ({ ...a, id: a.id || `a${String(i + 1).padStart(3, "0")}-0000-4000-8000-000000000000` }));

function world(scn: Scn, autos: any[]) {
  const r: any = scn.tables ? JSON.parse(JSON.stringify(scn.tables)) : records(scn.t0);
  if (scn.seed) scn.seed(r);
  const profiles = r.profiles || PROFILES.map((p) => ({ ...p }));
  return fakeDb({
    automation_settings: r.automation_settings || [{ business_id: "default", email_signer: scn.signer === undefined ? "Olivia" : scn.signer, ...(scn.settings || {}) }],
    automation_state: [{ business_id: "default", tick_lease_until: null, pruned_on: null, phase4_compat: true }],
    settings: r.settings || [{ id: 1, company_name: "Acme Home Services", catalog: CATALOG }],
    push_subscriptions: profiles.map((p: any, i: number) => ({ id: "d" + i, user_id: p.id, endpoint: "https://push/" + p.id, p256dh: "k", auth: "a" })),
    employees: [{ id: "e-va", name: "Vicky Va", status: "Active", roles: ["VA"] }, { id: "e-guy", name: "Guy Tech", status: "Active", roles: ["Technician"] }],
    app_keys: [{ name: "vapid", value: { publicKey: "PUB", privateKey: "PRIV" } }],
    tasks: [], automation_runs: [], automation_log: [], sms_opt_outs: [],
    ...r, profiles,
    automations: autos.map((a) => ({ business_id: "default", enabled: true, armed_at: iso(scn.t0 - 7 * DAY), version: 1, created_by_name: scn.maker === undefined ? "Olivia Owner" : scn.maker,
      id: a.id, name: a.name, trigger: JSON.parse(JSON.stringify(a.trigger ?? {})), steps: JSON.parse(JSON.stringify(a.steps ?? [])) })),
  });
}

// ── the live shadow (design §8.3 #2, offline): each live automation × its last 20 matching records of a READ-ONLY
// export, each record alone in a world at the moment of its event (RUNBOOK step 3) ──
function shadowScenarios(): Scn[] {
  if (!recordsArg) return [];
  const X = JSON.parse(fs.readFileSync(recordsArg, "utf8"));
  const S = OLD.normSettings((X.automation_settings || [])[0]);
  const byTable: Record<string, string> = { contact: "contacts", job: "jobs", call: "calls", chat: "chat_sessions" };
  const out: Scn[] = [];
  for (const a of live) {
    if (OLD.validateAutomation(a, ((X.settings || [])[0] || {}).catalog || {}).length) continue;
    const t = a.trigger || {}, trig = OLD.TRIGGERS[t.type];
    if (!trig) continue;
    const evs = (X[byTable[trig.recordKind]] || []).map((row: any) => ({ row, e: trig.fromRecord(row, S) }))
      .filter((x: any) => x.e && trig.match(t.params || {}, x.e, Date.parse(x.e.at) + MIN, S.timezone))
      .sort((x: any, y: any) => Date.parse(y.e.at) - Date.parse(x.e.at)).slice(0, 20);
    for (const { row, e } of evs) {
      const cid = e.contactId || row.contact_id || null;
      const mine = (l: any[] = [], k = "contact_id") => l.filter((x) => x && cid && x[k] === cid);
      const tables: any = {
        contacts: (X.contacts || []).filter((c: any) => c.id === cid || (trig.recordKind === "contact" && c.id === row.id)),
        jobs: trig.recordKind === "job" ? [row] : mine(X.jobs), calls: trig.recordKind === "call" ? [row] : [], chat_sessions: trig.recordKind === "chat" ? [row] : [],
        lead_messages: mine(X.lead_messages), customer_opt_outs: mine(X.customer_opt_outs), review_requests: X.review_requests || [], sms_opt_outs: X.sms_opt_outs || [],
        settings: X.settings, automation_settings: X.automation_settings, profiles: X.profiles, employees: X.employees,
      };
      for (const k of Object.keys(tables)) if (tables[k] === undefined) delete tables[k];
      out.push({ name: `live shadow: ${a.name} × ${trig.recordKind} ${row.id}`, t0: Date.parse(e.at), tables, only: a.id });
    }
  }
  return out;
}

// ── one world, played tick by tick (a minute apart for 20 minutes, then at each next due moment) ──
type Plan = (k: number) => Engine;
async function play(scn: Scn, autos: any[], plan: Plan) {
  const db = world(scn, autos);
  PUSHES = []; LINES = [];
  const hist: Record<string, any[]> = {};
  const keyOf = (r: any) => `${r.automation_id}|${r.event_key}`;
  const done = new Set<number>();
  const first: number[] = [15e3]; for (let m = 1; m <= 20; m++) first.push(m * MIN);
  let t = scn.t0 + first[0], k = 0, fi = 0;
  const inOutage = (x: number) => !!scn.outage && x >= scn.t0 + scn.outage[0] && x < scn.t0 + scn.outage[1];
  while (k < 400 && t <= scn.t0 + 40 * DAY) {
    if (inOutage(t)) t = scn.t0 + (scn.outage as [number, number])[1];
    const E = plan(k);
    clock = t;
    for (let i = 0; i < (scn.muts || []).length; i++) {
      const m = (scn.muts as Mut[])[i];
      if (done.has(i) || scn.t0 + m.off > t) continue;
      done.add(i);
      if (m.fn) m.fn(db);
      if (m.app) { clock = scn.t0 + m.off; const res = await E.M.handle(E.wrap ? E.wrap(db) : db, { step: "event", type: m.app.type, id: m.app.id }, OWNER, false); LINES.push(`app ${m.app.type}/${m.app.id}: ${JSON.stringify(res.body)}`); clock = t; }
    }
    await E.M.tick(E.wrap ? E.wrap(db) : db, t);
    for (const r of db.T.automation_runs) {
      const h = (hist[keyOf(r)] = hist[keyOf(r)] || []), s = [r.status, r.due_at, r.step_index];
      if (!h.length || JSON.stringify(h[h.length - 1]) !== JSON.stringify(s)) h.push(s);
    }
    k++;
    // the next moment: the next of the first minutes, else the earliest due run (or expired lease); none → stop
    fi++;
    const nexts = db.T.automation_runs.filter((r: any) => r.status === "waiting" || r.status === "running")
      .map((r: any) => Date.parse(r.status === "waiting" ? r.due_at : r.lease_until)).filter((x: number) => !Number.isNaN(x));
    const pendingMut = (scn.muts || []).map((m, i) => (done.has(i) ? NaN : scn.t0 + m.off)).filter((x) => !Number.isNaN(x));
    if (fi < first.length) { t = scn.t0 + first[fi]; continue; }
    const cand = [...nexts, ...pendingMut];
    if (!cand.length) break;
    t = Math.max(t + MIN, Math.min(...cand));
  }
  const runKey: Record<string, string> = {};
  for (const r of db.T.automation_runs) runKey[r.id] = keyOf(r);
  return {
    ticks: k,
    runs: db.T.automation_runs.map((r: any) => ({ key: keyOf(r), status: r.status, reason: r.reason ?? null, step_index: r.step_index, history: hist[keyOf(r)] }))
      .sort((a: any, b: any) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    actions: db.T.automation_log.filter((l: any) => (l.row_kind ?? "action") === "action")
      .map((l: any) => [runKey[l.run_id] || l.run_id, l.step_id, l.channel, l.audience, l.status, l.reason ?? null, l.recipient ?? null, l.at, l.loop ?? 0]),
    v2rows: db.T.automation_log.filter((l: any) => (l.row_kind ?? "action") !== "action").length,
    pushes: PUSHES.map((p) => [p.to, p.title, p.body, p.url, p.tag]),
    tasks: db.T.tasks.map((x: any) => [x.board, x.title, x.notes, x.due, x.assignees, x.priority, x.client, x.contact_id, x.created_by, x.created_at]),
    emails: db.T.lead_messages.filter((m: any) => m.auto === true && !String(m.id).startsWith("lm")).map((m: any) => [m.contact_id, m.channel, m.subject, m.body, m.author, m.email, m.status, m.at]),
    lines: LINES.slice(),
  };
}

// the first difference between two results (path + both values), or null
function firstDiff(a: any, b: any, path = ""): string | null {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) { const d = firstDiff(a[k], b[k], `${path}/${k}`); if (d) return d; }
  }
  return `${path || "/"}: old ${JSON.stringify(a)?.slice(0, 400)} | other ${JSON.stringify(b)?.slice(0, 400)}`;
}

(async () => {
  const started = Date.now();
  // 0. the rollback build is the phase-4 source + its header + the two documented code edits, nothing else
  const p4 = fs.readFileSync("phase4.src.ts", "utf8"), rb = fs.readFileSync("rb.src.ts", "utf8");
  const bar = "// ════════════════════════════════════════════════════════════════════════════════════════════════════════════\n";
  const headEnd = rb.indexOf(bar, bar.length) + bar.length;
  const undone = rb.slice(headEnd)
    .replace('if (!x || x.deleted_at) return "automation deleted";   // ROLLBACK BUILD edit 2: a soft delete (stage 2) is a delete', 'if (!x) return "automation deleted";')
    .replace('    // ROLLBACK BUILD edit 1: only ACTION rows (no row_kind column = a phase-4 row = an action row)\n    const { data: prior } = await sb.from("automation_log").select("*").eq("run_id", run.id).eq("step_id", st.id).limit(50);\n    // deno-lint-ignore no-explicit-any\n    if (prior && prior.some((l: any) => (l.row_kind ?? "action") === "action")) { i++; continue; }',
      '    const { data: prior } = await sb.from("automation_log").select("id").eq("run_id", run.id).eq("step_id", st.id).limit(1);\n    if (prior && prior.length) { i++; continue; }');
  const rbOk = rb.startsWith(bar) && undone === p4;
  const fp = (s: string) => { let x = 0; for (let i = 0; i < s.length; i++) x = (x + s.charCodeAt(i) * (i % 97 + 1)) % 1000000007; return x; };
  say(`rollback build = phase-4 (${process.env.PHASE4_COMMIT || "7ae5b19"}) + header + 2 documented edits: ${rbOk ? "OK" : "DIFFERENT"}`);
  say(`fingerprints (sum(charCode*(i%97+1)) % 1000000007 / length): phase-4 ${fp(p4)}/${p4.length} · rollback build ${fp(rb)}/${rb.length}`);

  // 1. the corpus as the phase-4 validator sees it
  const invalid = CORPUS.filter((a) => OLD.validateAutomation(a, CATALOG).length).map((a) => a.name);
  say(`corpus: ${CORPUS.length} automations (${builtin.length} built-in, ${upgrade.length} upgrade.json shapes, ${live.length} live); refused by phase 4 (never start, in either engine): ${invalid.length}`);

  const shadow = shadowScenarios();
  const scns = [...(QUICK ? SCENARIOS.slice(0, 3) : SCENARIOS), ...shadow];
  if (recordsArg) say(`live shadow: ${shadow.length} (automation × record) worlds from ${recordsArg}`);
  const findings: any[] = [];
  let worlds = 0, cases = 0, acted = 0, v2seen = 0;
  const totals = { actions: 0, pushes: 0, tasks: 0, emails: 0, runs: 0 };
  for (const scn of scns) {
    const groups: { label: string; autos: any[] }[] = scn.only ? [{ label: String(scn.only), autos: CORPUS.filter((a) => a.id === scn.only) }]
      : [{ label: "ALL together", autos: CORPUS }, ...CORPUS.map((a) => ({ label: a.name, autos: [a] }))];
    for (const g of groups) {
      cases++;
      const base = await play(scn, g.autos, () => ENG.old); worlds++;
      const mid = Math.max(1, Math.floor(base.ticks / 2));
      if (base.actions.length) acted++;
      totals.actions += base.actions.length; totals.pushes += base.pushes.length; totals.tasks += base.tasks.length; totals.emails += base.emails.length; totals.runs += base.runs.length;
      const others: [string, Plan][] = [
        ["new (v2 compat)", () => ENG.new], ["rb (rollback build)", () => ENG.rb], ["new before Part 1 (its phase-4 fallback)", () => ENG.nf],
        [`new before Part 1 → Part 1 applied after tick ${mid}`, (k) => (k < mid ? ENG.nf : ENG.new)],
        ["old → new after tick 1 (deploy)", (k) => (k < 1 ? ENG.old : ENG.new)], [`old → new after tick ${mid} (deploy)`, (k) => (k < mid ? ENG.old : ENG.new)],
        ["new → rb after tick 1 (rollback)", (k) => (k < 1 ? ENG.new : ENG.rb)], [`new → rb after tick ${mid} (rollback)`, (k) => (k < mid ? ENG.new : ENG.rb)],
        [`new → old after tick ${mid} (rollback to plain phase 4)`, (k) => (k < mid ? ENG.new : ENG.old)],
        [`old → new → rb (ticks 1 / ${mid + 1})`, (k) => (k < 1 ? ENG.old : k < mid + 1 ? ENG.new : ENG.rb)],
        // a rollback, then the v2 build again (a fixed redeploy): runs phase 4 moved on in between
        [`new → rb → new (ticks 1 / ${mid + 1})`, (k) => (k < 1 ? ENG.new : k < mid + 1 ? ENG.rb : ENG.new)],
        ["alternating every tick (new / rb)", (k) => (k % 2 ? ENG.rb : ENG.new)],
      ];
      for (const [label, plan] of others) {
        const got = await play(scn, g.autos, plan); worlds++;
        if (label.startsWith("new (")) v2seen += got.v2rows;
        // the pre-Part-1 fallback must really be phase 4 (no v2 rows at all)
        if (label.startsWith("new before Part 1 (") && got.v2rows) findings.push({ scenario: scn.name, automations: g.label, engine: label, diff: `v2 rows written before Part 1: ${got.v2rows}` });
        const { v2rows: _a, ...gotCmp } = got, { v2rows: _b, ...baseCmp } = base;
        const d = firstDiff(baseCmp, gotCmp);
        if (d) findings.push({ scenario: scn.name, automations: g.label, engine: label, diff: d });
      }
    }
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  say(`scenarios ${scns.length} · cases ${cases} · worlds ${worlds} · cases where phase 4 acted ${acted} · phase-4 totals: runs ${totals.runs}, action rows ${totals.actions}, pushes ${totals.pushes}, tasks ${totals.tasks}, emails ${totals.emails} · v2 step/exit rows seen ${v2seen} · ${secs} s`);
  const reportPath = process.env.REPORT || DIFF_DIR + "/report.json";
  fs.writeFileSync(reportPath, JSON.stringify({ at: new Date().toISOString(), rollbackBuildOk: rbOk, corpus: CORPUS.length, invalid, scenarios: scns.map((s) => s.name), cases, worlds, acted, totals, v2seen, findings }, null, 1));
  if (findings.length) {
    say(`DIFFERENCES: ${findings.length}`);
    for (const f of findings.slice(0, 40)) say(`- [${f.scenario}] ${f.automations} — ${f.engine}\n    ${f.diff}`);
  }
  say(`report: ${reportPath}`);
  const okAll = rbOk && !findings.length && v2seen > 0 && acted > 0;
  say(okAll ? "DIFFERENTIAL: IDENTICAL (old = new = rollback build, and every cutover)" : "DIFFERENTIAL: FAILED");
  process.exit(okAll ? 0 : 1);
})().catch((e) => { say("differential crashed:", e && e.stack || e); process.exit(1); });
