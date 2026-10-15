// Tests for push/index.ts. Run: bash supabase/functions/push/run_tests.sh
// deno-lint-ignore-file no-explicit-any

// A value as PostgREST filters see it: a column, or options->>key (a jsonb key as text).
const col = (r: any, k: string) => { const m = /^(\w+)->>(\w+)$/.exec(k); if (!m) return r[k]; const o = r[m[1]]; return o && typeof o === "object" && o[m[2]] != null ? String(o[m[2]]) : null; };
// or("a.gte.x,b->>c.eq.y,d.is.null,e.neq.z")
const orCond = (p: string) => {
  const m = /^([\w>-]+)\.(eq|neq|gte|lte|is)\.(.*)$/.exec(p); if (!m) throw new Error("fake or(): " + p);
  const [, k, op, v] = m;
  return (r: any) => { const x = col(r, k); return op === "is" ? v === "null" && x == null : x == null ? false : op === "eq" ? String(x) === v : op === "neq" ? String(x) !== v : op === "gte" ? x >= v : x <= v; };
};
function fakeDb(seed: Record<string, any[]> = {}) {
  const T: Record<string, any[]> = { app_keys: [], push_subscriptions: [], payroll_weeks: [], profiles: [], ...seed };
  function q(table: string) {
    const rows = () => (T[table] = T[table] || []);
    const filters: ((r: any) => boolean)[] = [];
    let op = "select", payload: any = null, lim = Infinity, single = false, rng: [number, number] | null = null;
    const b: any = {
      select() { return b; }, insert(p: any) { op = "insert"; payload = p; return b; }, delete() { op = "delete"; return b; },
      update(p: any) { op = "update"; payload = p; return b; },
      eq(k: string, v: any) { filters.push((r) => r[k] === v); return b; },
      is(k: string, v: any) { filters.push((r) => (r[k] ?? null) === v); return b; },
      gte(k: string, v: any) { filters.push((r) => r[k] >= v); return b; },
      lte(k: string, v: any) { filters.push((r) => r[k] != null && r[k] <= v); return b; },
      in(k: string, list: any[]) { filters.push((r) => list.includes(r[k])); return b; },
      or(expr: string) { const ps = expr.split(",").map(orCond); filters.push((r) => ps.some((f) => f(r))); return b; },
      order() { return b; }, range(a: number, z: number) { rng = [a, z]; return b; },
      limit(n: number) { lim = n; return b; }, single() { single = true; return b; },
      then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej); },
    };
    function run() {
      const m = () => rows().filter((r) => filters.every((f) => f(r)));
      if (op === "insert") { if ((table === "app_keys" && rows().some((r) => r.name === payload.name)) || (table === "push_sent" && rows().some((r) => r.key === payload.key))) return { data: null, error: { message: "duplicate" } }; rows().push({ ...payload }); return { data: null, error: null }; }
      if (op === "delete") { const gone = m(); T[table] = rows().filter((r) => !gone.includes(r)); return { data: gone, error: null }; }
      if (op === "update") { m().forEach((r) => Object.assign(r, payload)); return { data: null, error: null }; }
      // PostgREST's max-rows: at most 1000 rows a request
      const out = (rng ? m().slice(rng[0], rng[1] + 1) : m()).slice(0, Math.min(lim, 1000)).map((r) => ({ ...r }));
      return { data: single ? out[0] || null : out, error: null };
    }
    return b;
  }
  return { T, from: q };
}
let pass = 0, fail = 0;
function eq(got: any, want: any, name: string) { const g = JSON.stringify(got), w = JSON.stringify(want); if (g === w) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); } }

const sent: any[] = [];
let gone = new Set<string>();
let made = 0;
io.generate = () => { made++; return { publicKey: "PUB" + made, privateKey: "PRIV" + made }; };
io.send = async (sub: any, payload: string) => { if (gone.has(sub.endpoint)) { const e: any = new Error("gone"); e.statusCode = 410; throw e; } sent.push({ to: sub.endpoint, msg: JSON.parse(payload) }); return { statusCode: 201 }; };
io.build = () => ({ method: "POST", headers: { Authorization: "vapid t=x, k=y" }, body: new Uint8Array(120) });

const OFEK = { id: "u-ofek", role: "owner", full_name: "Ofek", technician_name: "Ofek" };
const NOAM = { id: "u-noam", role: "owner", full_name: "Noam", technician_name: "Noam" };
const GUY = { id: "u-guy", role: "technician", full_name: "Guy Galili", technician_name: "Guy" };
const DOLEV = { id: "u-dolev", role: "technician", full_name: "Dolev", technician_name: "Dolev" };

(async () => {
  eq(weekText("2026-10-04"), "4–10 Oct", "weekText: one month");
  eq(weekText("2026-09-27"), "27 Sep – 3 Oct", "weekText: across two months");

  const db = fakeDb({
    profiles: [OFEK, NOAM, GUY, DOLEV],
    push_subscriptions: [
      { id: "s1", user_id: "u-ofek", endpoint: "https://push/ofek-phone", p256dh: "k", auth: "a" },
      { id: "s2", user_id: "u-noam", endpoint: "https://push/noam-phone", p256dh: "k", auth: "a" },
      { id: "s3", user_id: "u-noam", endpoint: "https://push/noam-old", p256dh: "k", auth: "a" },
      { id: "s4", user_id: "u-guy", endpoint: "https://push/guy-phone", p256dh: "k", auth: "a" },
    ],
    payroll_weeks: [{ week_start: "2026-10-04", person: "Guy", salary_invoice_file: "sb:payroll/2026-10-04/Guy/salary-invoice-1.pdf" }, { week_start: "2026-10-04", person: "Dolev", salary_invoice_file: null }],
  });

  // the key pair: made once, then the same one every time; anyone may ask for the public half
  const k1 = await handle(db, { step: "key" }, null), k2 = await handle(db, { step: "key" }, null);
  eq([k1.status, k1.body.publicKey, k2.body.publicKey, made, db.T.app_keys.length], [200, "PUB1", "PUB1", 1, 1], "key: made on first use, kept, the same after");
  eq(JSON.stringify(k1.body).includes("PRIV"), false, "key: the private half never leaves");

  // a technician's commission invoice → every owner's devices, not the technician's
  gone = new Set(["https://push/noam-old"]);
  const r = await handle(db, { step: "invoice", week: "2026-10-04", person: "Guy" }, GUY);
  eq([r.status, r.body.sent, r.body.failed, r.body.removed], [200, 2, 1, 1], "invoice: both owners' phones get it; a phone that is gone is removed");
  eq(sent.map((x) => x.to), ["https://push/ofek-phone", "https://push/noam-phone"], "invoice: only the owners' devices");
  eq([sent[0].msg.title, sent[0].msg.body, sent[0].msg.url], ["Invoice in: Guy", "Guy sent his commission invoice for 4–10 Oct. You can pay him.", "https://theguysgroup.github.io/the-guys-ops-app/?tab=payroll&week=2026-10-04"], "invoice: what the notification says and where it opens");
  eq(db.T.push_subscriptions.some((s) => s.id === "s3"), false, "invoice: the gone device is deleted");

  // who may ask
  eq((await handle(db, { step: "invoice", week: "2026-10-04", person: "Guy" }, DOLEV)).status, 403, "invoice: another technician cannot send it for Guy");
  eq((await handle(db, { step: "invoice", week: "2026-10-04", person: "Dolev" }, DOLEV)).status, 409, "invoice: nothing is sent when there is no invoice on the week");
  eq((await handle(db, { step: "invoice", week: "2026-10-04", person: "Guy" }, null)).status, 401, "invoice: not signed in");
  eq((await handle(db, { step: "invoice", week: "4 Oct", person: "Guy" }, OFEK)).status, 400, "invoice: a bad week is refused");
  eq((await handle(db, { step: "invoice", week: "2026-10-04", person: "Guy" }, OFEK)).body.sent, 2, "invoice: an owner may send it for a technician too");

  // test and selftest: owners only, to their own devices
  sent.length = 0;
  const t = await handle(db, { step: "test" }, OFEK);
  eq([t.body.ok, sent.map((x) => x.to)], [true, ["https://push/ofek-phone"]], "test: only the caller's own devices");
  eq((await handle(db, { step: "test" }, GUY)).status, 403, "test: owners only");
  const st = await handle(db, { step: "selftest" }, OFEK);
  eq([st.status, st.body.ok, st.body.method], [200, true, "POST"], "selftest: builds a signed, encrypted message without sending it");
  eq((await handle(db, { step: "nope" }, OFEK)).status, 400, "unknown step");

  // scan: the news switched on in Settings → Notifications, each sent once
  const SYD = REGION_DEFAULTS.timeZone;
  eq([bizParts(Date.parse("2026-10-12T03:30:00Z"), SYD).day, bizParts(Date.parse("2026-10-12T03:30:00Z"), SYD).hour, shiftDay("2026-10-01", -7)], ["2026-10-12", 14, "2026-09-24"], "scan helpers: Sydney time (AEDT) and day shifts");
  eq([bizParts(Date.parse("2026-10-12T03:30:00Z"), "America/Chicago").day, bizParts(Date.parse("2026-10-12T03:30:00Z"), "America/Chicago").hour], ["2026-10-11", 22], "scan helpers: the same moment in Chicago");
  eq([unpaidPayload({ id: "j", customer_name: "Jo", amount: 480, date: "2026-10-05" }, { unpaidDays: 7 }).body, unpaidPayload({ id: "j", customer_name: "Jo", amount: 480, date: "2026-10-05" }, { unpaidDays: 7 }, { region: { currency: "GBP" } }).body],
    ["$480 from 2026-10-05. Time to chase it.", "£480 from 2026-10-05. Time to chase it."], "unpaid: the amount as before, or in the business's currency");
  const NOW = Date.parse("2026-10-12T03:30:00Z");   // Monday 12 Oct, 14:30 Sydney
  const sdb = fakeDb({
    profiles: [OFEK, NOAM, GUY, { id: "u-ron", role: "va", full_name: "Ron" }],
    push_subscriptions: [
      { id: "p1", user_id: "u-ofek", endpoint: "https://push/ofek", p256dh: "k", auth: "a" },
      { id: "p2", user_id: "u-ron", endpoint: "https://push/ron", p256dh: "k", auth: "a" },
    ],
    settings: [{ id: 1, catalog: {} }],
    contacts: [
      { id: "c1", full_name: "Sam New", division: "Aircon", source: "Google Ads", status: "New", created_at: "2026-10-12", messages: [{ at: "2026-10-12T03:00:00Z" }], tags: [] },   // 30 min ago, untouched
      { id: "c2", full_name: "Old Lead", division: "Aircon", source: "Meta Ads", status: "New", created_at: "2026-10-11", messages: [{ at: "2026-10-11T01:00:00Z" }], tags: [] },  // a day ago: not news
      { id: "c3", full_name: "Test Person", division: "Other", source: "Organic", status: "New", created_at: "2026-10-12", messages: [{ at: "2026-10-12T03:20:00Z" }], tags: ["Test"] },
      { id: "c4", full_name: "Called Already", division: "Chimney", source: "Organic", status: "Chasing", created_at: "2026-10-12", messages: [{ at: "2026-10-12T02:50:00Z" }], tags: [] },
      { id: "c5", full_name: "Quiet Import", division: "Other", source: "MCP import", status: "New", created_at: "2026-10-12", messages: [{ at: "2026-10-12T03:00:00Z", quiet: true }], tags: [] },   // an MCP import with automations off: no news
      { id: "c6", full_name: "Quiet Column", division: "Other", source: "MCP import", status: "New", created_at: "2026-10-12", messages: [{ at: "2026-10-12T03:00:00Z" }], import_quiet: true, tags: [] },   // the import_quiet column alone: no news either
    ],
    calls: [{ id: "k1", from_number: "+61400000000", missed: true, started_at: "2026-10-12T03:10:00Z", division: "Aircon" }],
    jobs: [{ id: "j1", customer_name: "Jo", amount: 450, date: "2026-10-05", payment_status: "Unpaid" }, { id: "j2", customer_name: "Older", amount: 300, date: "2026-10-01", payment_status: "Unpaid" }],
    employees: [{ id: "e1", name: "Guy", status: "Active", documents: { license: { expiry: "2026-10-30" }, passport: { expiry: "2030-01-01" } } }],
    push_sent: [],
  });
  sent.length = 0;
  eq((await scan(sdb, NOW)).off, true, "scan: everything switched off = nothing happens");
  sdb.T.settings[0].catalog = { notify: { newLead: { on: true, office: true }, leadWaiting: { on: true }, missedCall: { on: true }, unpaid: { on: true }, docExpiry: { on: true } } };
  const r1 = await scan(sdb, NOW);
  const got = sent.map((x) => `${x.to.replace("https://push/", "")}:${x.msg.title}`).sort();
  eq(got, ["ofek:Guy's driver licence expires soon", "ofek:Missed call", "ofek:New lead: Called Already", "ofek:New lead: Sam New", "ofek:Unpaid for a week: Jo", "ofek:Waiting 15+ minutes: Sam New", "ron:New lead: Called Already", "ron:New lead: Sam New"],
    "scan: new leads (to the office too, as chosen), a lead untouched 15+ minutes, a missed call, a job turning 7 days unpaid, a document expiring; not a day-old lead, not a test, not a lead someone is chasing, not an older unpaid job");
  sent.length = 0;
  eq([(await scan(sdb, NOW + 60000)).busy, sent.length], [true, 0], "scan: a second call in the same window does nothing");
  const r3 = await scan(sdb, NOW + 9 * 60000);
  eq([r3.sent, r3.skipped > 0, sent.length], [0, true, 0], "scan: the next window sends nothing again (each piece of news once)");
  // A quiet MCP import is no news; once the customer comes back (reopened) it is.
  const qdb = fakeDb({
    profiles: [OFEK], push_subscriptions: [{ id: "p1", user_id: "u-ofek", endpoint: "https://push/ofek", p256dh: "k", auth: "a" }],
    settings: [{ id: 1, catalog: { notify: { newLead: { on: true }, leadWaiting: { on: true } } } }], push_sent: [], calls: [], jobs: [], employees: [],
    contacts: [{ id: "q1", full_name: "Back Again", division: "Aircon", source: "MCP import", status: "New", created_at: "2026-10-12", messages: [{ at: "2026-10-11T03:00:00Z", quiet: true }], reopened_at: "2026-10-12T03:00:00Z", tags: [] }],
  });
  sent.length = 0;
  await scan(qdb, NOW);
  eq(sent.map((x) => x.msg.title).sort(), ["New lead: Back Again", "Waiting 15+ minutes: Back Again"], "scan: a quiet import reopened 30 minutes ago is news again (New lead + Waiting)");

  // The business's day (Region and format): at 14:30 Monday in Sydney it is still Sunday 11 Oct in Chicago, so the job of
  // 4 Oct (not 5 Oct) turns a week unpaid; the amount is in the business's currency.
  const cdb = fakeDb({
    profiles: [OFEK], push_subscriptions: [{ id: "p1", user_id: "u-ofek", endpoint: "https://push/ofek", p256dh: "k", auth: "a" }],
    settings: [{ id: 1, catalog: { region: { timeZone: "America/Chicago", currency: "GBP" }, notify: { unpaid: { on: true } } } }],
    contacts: [], calls: [], employees: [], push_sent: [],
    jobs: [{ id: "j1", customer_name: "Jo", amount: 450, date: "2026-10-05", payment_status: "Unpaid" }, { id: "j4", customer_name: "Four", amount: 120, date: "2026-10-04", payment_status: "Unpaid" }],
  });
  sent.length = 0;
  await scan(cdb, NOW);
  eq(sent.map((x) => `${x.msg.title} | ${x.msg.body}`), ["Unpaid for a week: Four | £120 from 2026-10-04. Time to chase it."], "scan: the business's day and currency (Chicago, pounds)");

  // The technician invoice notification can be switched off in Settings (13 Oct).
  db.T.settings = [{ id: 1, catalog: { notify: { invoice: { on: false } } } }];
  sent.length = 0;
  const off = await handle(db, { step: "invoice", week: "2026-10-04", person: "Guy" }, GUY);
  eq([off.status, off.body.off, sent.length], [200, true, 0], "invoice: switched off = nothing sent");
  db.T.settings = [];

  // The numbers from Settings (13 Oct): nothing set = 15 minutes, 8 to 20, 30 days, the business's unpaid days (7).
  eq(notifyRules({}, undefined), { waitMinutes: 15, from: 8, until: 20, docDays: 30, unpaidDays: 7 }, "rules: the originals");
  eq(notifyRules({ rules: { waitMinutes: 30, from: 20, until: 7, docDays: 60 } }, 10), { waitMinutes: 30, from: 8, until: 20, docDays: 60, unpaidDays: 10 }, "rules: saved numbers used; impossible hours fall back");
  const ndb = fakeDb({
    profiles: [OFEK], push_subscriptions: [{ id: "p1", user_id: "u-ofek", endpoint: "https://push/ofek", p256dh: "k", auth: "a" }],
    settings: [{ id: 1, unpaid_reminder_days: 10, catalog: { notify: { leadWaiting: { on: true }, unpaid: { on: true }, docExpiry: { on: true }, rules: { waitMinutes: 45, docDays: 10 } } } }],
    contacts: [{ id: "c1", full_name: "Sam New", division: "Aircon", source: "Google Ads", status: "New", created_at: "2026-10-12", messages: [{ at: "2026-10-12T03:00:00Z" }], tags: [] }],
    calls: [], jobs: [{ id: "j1", customer_name: "Jo", amount: 450, date: "2026-10-05", payment_status: "Unpaid" }, { id: "j3", customer_name: "Ten", amount: 99, date: "2026-10-02", payment_status: "Unpaid" }],
    employees: [{ id: "e1", name: "Guy", status: "Active", documents: { license: { expiry: "2026-10-30" } } }], push_sent: [],
  });
  sent.length = 0;
  await scan(ndb, NOW);
  eq(sent.map((x) => x.msg.title).sort(), ["Unpaid for 10 days: Ten"], "scan with saved numbers: 30 minutes is not yet 45, a 7-day job is not 10, a licence 18 days off is outside 10");
  sent.length = 0;
  await scan(ndb, NOW + 20 * 60000);
  eq(sent.map((x) => x.msg.title), ["Waiting 45+ minutes: Sam New"], "scan with saved numbers: 50 minutes passes 45");

  // A short or long week after a week-start change (14 Oct): the invoice names the real last day.
  eq(weekText("2026-10-18", "2026-10-25"), "18–25 Oct", "weekText: an 8-day week");
  eq(weekText("2026-10-25", "2026-11-01"), "25 Oct – 1 Nov", "weekText: an end across two months");
  eq(weekText("2026-10-18", "x"), "18–24 Oct", "weekText: an end that is not a date is ignored");
  eq(weekText("2026-10-18", "2026-10-10"), "18–24 Oct", "weekText: an end before the start is ignored");
  eq(weekText("2026-10-18", "2026-11-30"), "18–24 Oct", "weekText: an end more than 13 days on is ignored");
  sent.length = 0;
  await handle(db, { step: "invoice", week: "2026-10-04", person: "Guy", end: "2026-10-11" }, GUY);
  eq(sent[0] && sent[0].msg.body, "Guy sent his commission invoice for 4–11 Oct. You can pay him.", "invoice: with the week's end");

  // The business's own insurance (14 Oct): within the document days, to the owners only (not the office), once.
  const bizDb = (catalog: any) => fakeDb({
    profiles: [OFEK, { id: "u-ron", role: "va", full_name: "Ron" }],
    push_subscriptions: [
      { id: "p1", user_id: "u-ofek", endpoint: "https://push/ofek", p256dh: "k", auth: "a" },
      { id: "p2", user_id: "u-ron", endpoint: "https://push/ron", p256dh: "k", auth: "a" },
    ],
    settings: [{ id: 1, catalog }], employees: [], push_sent: [],
  });
  const bdb = bizDb({ notify: { docExpiry: { on: true, office: true } }, business: { insurance: { workers: { expiry: "2026-11-01" }, liability: { expiry: "2027-03-01" }, other: { expiry: "2026-10-20" } } } });
  sent.length = 0;
  await scan(bdb, NOW);
  eq(sent.map((x) => ({ to: x.to.replace("https://push/", ""), title: x.msg.title })), [{ to: "ofek", title: "Business insurance: workers compensation expires soon" }],
    "business insurance: owners only even with Office ticked; liability is outside 30 days; an unknown kind is ignored");
  eq([sent[0] && sent[0].msg.body, sent[0] && sent[0].msg.url], ["On 2026-11-01. Renew it and upload the new certificate in Settings → Business details.", "https://theguysgroup.github.io/the-guys-ops-app/?tab=settings&page=profile"], "business insurance: what it says and where it opens");
  sent.length = 0;
  const b2 = await scan(bdb, NOW + 9 * 60000);
  eq([b2.sent, b2.skipped > 0, sent.length], [0, true, 0], "business insurance: sent once only");
  bdb.T.settings[0].catalog.business.insurance.workers.expiry = "2026-10-30";
  await scan(bdb, NOW + 18 * 60000);
  eq(sent.map((x) => x.msg.title), ["Business insurance: workers compensation expires soon"], "business insurance: a renewed expiry is news again");
  const bizNothing = async (catalog: any, name: string) => { sent.length = 0; const r = await scan(bizDb(catalog), NOW); eq(sent.length, 0, name); return r; };
  await bizNothing({ notify: { docExpiry: { on: true } }, business: { insurance: { workers: { expiry: "2026-10-01" } } } }, "business insurance: already expired = nothing sent");
  await bizNothing({ notify: { docExpiry: { on: true } }, business: { insurance: { workers: { expiry: "1/11/2026" } } } }, "business insurance: a bad date = nothing sent");
  eq((await bizNothing({ notify: { docExpiry: { on: false } }, business: { insurance: { workers: { expiry: "2026-11-01" } } } }, "business insurance: switch off = nothing sent")).off, true, "business insurance: rides on the document switch");
  // Its window is always 30 days (14 Oct, the Notifications card says "Always 30 days before"), whatever the document days.
  sent.length = 0;
  await scan(bizDb({ notify: { docExpiry: { on: true }, rules: { docDays: 10 } }, business: { insurance: { workers: { expiry: "2026-11-01" } } } }), NOW);
  eq(sent.map((x) => x.msg.title), ["Business insurance: workers compensation expires soon"], "business insurance: 20 days off is sent even with 10 saved document days (always 30)");
  await bizNothing({ notify: { docExpiry: { on: true }, rules: { docDays: 60 } }, business: { insurance: { workers: { expiry: "2026-11-12" } } } }, "business insurance: 31 days off is not sent, even with 60 saved document days");

  // Its own switch (14 Oct). No bizInsurance key = it follows the document switch (above).
  const empDocs = [{ id: "e1", name: "Guy", status: "Active", documents: { license: { expiry: "2026-10-30" } } }];
  const own = async (notify: any) => { const d = bizDb({ notify, business: { insurance: { workers: { expiry: "2026-11-01" } } } }); d.T.employees = empDocs; sent.length = 0; const r = await scan(d, NOW); return { r, titles: sent.map((x) => x.msg.title).sort() }; };
  eq((await own({ docExpiry: { on: true }, bizInsurance: { on: false } })).titles, ["Guy's driver licence expires soon"], "business insurance: its own switch off = the employee document still goes, the insurance does not");
  const onlyIns = await own({ bizInsurance: { on: true } });
  eq([onlyIns.titles, onlyIns.r.off], [["Business insurance: workers compensation expires soon"], undefined], "business insurance: its own switch on with documents off = only the insurance, and the scan is not 'off'");
  eq((await own({ docExpiry: { on: false }, bizInsurance: { on: "yes" } })).r.off, true, "business insurance: a saved value that is not true / false follows the document switch");

  // notifyOn: the same rule as the app's.
  eq([notifyOn({}, "newLead"), notifyOn({}, "unpaid"), notifyOn({}, "docExpiry"), notifyOn({}, "invoice"), notifyOn({ invoice: { on: false } }, "invoice"), notifyOn(undefined, "invoice")],
    [false, false, false, true, false, true], "notifyOn: off unless switched on; the invoice one on unless switched off");
  eq([notifyOn({ docExpiry: { on: true } }, "bizInsurance"), notifyOn({ docExpiry: { on: false } }, "bizInsurance"), notifyOn({ docExpiry: { on: true }, bizInsurance: { on: false } }, "bizInsurance"), notifyOn({ bizInsurance: { on: true } }, "bizInsurance"), notifyOn({ docExpiry: { on: true }, bizInsurance: {} }, "bizInsurance")],
    [true, false, false, true, true], "notifyOn: the business insurance follows the document switch until it has its own");

  // Office only for a new lead, a waiting lead and a missed call (14 Oct): money and private details stay with the owners.
  const odb = fakeDb({
    profiles: [OFEK, { id: "u-ron", role: "va", full_name: "Ron" }],
    push_subscriptions: [{ id: "p1", user_id: "u-ofek", endpoint: "https://push/ofek", p256dh: "k", auth: "a" }, { id: "p2", user_id: "u-ron", endpoint: "https://push/ron", p256dh: "k", auth: "a" }],
    settings: [{ id: 1, catalog: { notify: { unpaid: { on: true, office: true }, docExpiry: { on: true, office: true } } } }],
    jobs: [{ id: "j1", customer_name: "Jo", amount: 450, date: "2026-10-05", payment_status: "Unpaid" }], employees: empDocs, push_sent: [],
  });
  sent.length = 0;
  await scan(odb, NOW);
  eq(sent.map((x) => `${x.to.replace("https://push/", "")}:${x.msg.title}`).sort(), ["ofek:Guy's driver licence expires soon", "ofek:Unpaid for a week: Jo"], "office: an unpaid job and a document go to the owners only, even with office saved on them");

  // "Send a test" on one card (14 Oct): the real wording, "Test · " in front, its own tag; never recorded as sent.
  const R0 = notifyRules({}, undefined), TODAY = "2026-10-13";
  const tp = (k: string) => { const p = testPayload(k, R0, TODAY); return p && [p.title, p.body, p.tag]; };
  eq(tp("newLead"), ["Test · New lead: Sarah Mitchell", "Aircon · Google Ads", "test-newLead"], "testPayload: new lead");
  eq(tp("leadWaiting"), ["Test · Waiting 15+ minutes: James Nguyen", "Nobody has picked up this Chimney lead yet.", "test-leadWaiting"], "testPayload: waiting lead");
  eq(tp("missedCall"), ["Test · Missed call", "0491 570 156 · Aircon. Call them back.", "test-missedCall"], "testPayload: missed call");
  eq(tp("unpaid"), ["Test · Unpaid for a week: Daniel Russo", "$480 from 2026-10-06. Time to chase it.", "test-unpaid"], "testPayload: unpaid job");
  eq(tp("invoice"), ["Test · Invoice in: Sample Technician", "Sample Technician sent his commission invoice for 6–12 Oct. You can pay him.", "test-invoice"], "testPayload: commission invoice");
  eq(tp("docExpiry"), ["Test · Sample Employee's refrigerant licence expires soon", "On 2026-11-12. Ask for the new one.", "test-docExpiry"], "testPayload: employee document");
  eq(tp("bizInsurance"), ["Test · Business insurance: public liability expires soon", "On 2026-11-12. Renew it and upload the new certificate in Settings → Business details.", "test-bizInsurance"], "testPayload: business insurance");
  eq([testPayload("googleReview", R0, TODAY), testPayload("nope", R0, TODAY)], [null, null], "testPayload: no Google review yet, nothing for an unknown kind");
  eq(testPayload("unpaid", notifyRules({}, 10), TODAY)?.title, "Test · Unpaid for 10 days: Daniel Russo", "testPayload: uses the saved numbers");
  eq([testPayload("newLead", R0, TODAY)?.url, testPayload("bizInsurance", R0, TODAY)?.url], [APP_URL + "?tab=crm", APP_URL + "?tab=settings&page=profile"], "testPayload: opens where the real one does");
  const tdb = fakeDb({
    profiles: [OFEK, NOAM, GUY],
    push_subscriptions: [{ id: "p1", user_id: "u-ofek", endpoint: "https://push/ofek", p256dh: "k", auth: "a" }, { id: "p2", user_id: "u-noam", endpoint: "https://push/noam", p256dh: "k", auth: "a" }],
    settings: [{ id: 1, unpaid_reminder_days: 7, catalog: {} }], push_sent: [],
  });
  sent.length = 0;
  const tk = await handle(tdb, { step: "test", kind: "newLead" }, OFEK);
  eq([tk.status, tk.body.ok, tk.body.sent, sent.map((x) => x.to), sent[0] && sent[0].msg.title, sent[0] && sent[0].msg.tag, tdb.T.push_sent.length],
    [200, true, 1, ["https://push/ofek"], "Test · New lead: Sarah Mitchell", "test-newLead", 0], "test with a kind: only the caller's devices, that card's wording, nothing recorded as sent");
  sent.length = 0;
  await handle(tdb, { step: "test" }, OFEK);
  eq(sent[0] && sent[0].msg, { title: "Notifications are on", body: "This phone will get the notifications that are switched on in Settings → Notifications.", url: APP_URL + "?tab=payroll", tag: "test" }, "test without a kind: exactly the original message");
  sent.length = 0;
  await handle(tdb, { step: "test", kind: "" }, OFEK);
  eq(sent[0] && sent[0].msg.tag, "test", "test with an empty kind: the original message");
  const bad = await handle(tdb, { step: "test", kind: "nope" }, OFEK);
  eq([bad.status, bad.body.reason], [400, "unknown notification"], "test: an unknown kind is refused");
  eq((await handle(tdb, { step: "test", kind: "newLead" }, GUY)).status, 403, "test with a kind: owners and managers only");
  const none = await handle(tdb, { step: "test", kind: "newLead" }, { id: "u-nobody", role: "owner" });
  eq([none.body.ok, none.body.devices], [false, 0], "test: no devices = not ok, 0 devices");

  // ── vacations (stage 3) ──
  // their own made-up people (neutral demo names: the repo is public)
  const AVA = { id: "u-ava", role: "owner", full_name: "Ava", technician_name: "Ava" };
  const BEN = { id: "u-ben", role: "owner", full_name: "Ben", technician_name: "Ben" };
  const CAL = { id: "u-cal", role: "technician", full_name: "Cal Tech", technician_name: "Cal" };
  const DEE = { id: "u-dee", role: "technician", full_name: "Dee", technician_name: "Dee" };
  // SYD (REGION_DEFAULTS.timeZone, Australia/Sydney) is declared with the scan tests above
  // the same days and DST edges as the app's tests (business-logic testVacations), so server and app agree
  // the day is the region block's (bizParts / bizTzOf on settings.catalog.region.timeZone), no zone code of its own
  eq([bizParts(Date.parse("2026-10-03T14:30:00Z"), SYD).day, bizParts(Date.parse("2026-10-04T13:30:00Z"), SYD).day], ["2026-10-04", "2026-10-05"], "vacation days: 00:30 AEST on the 4th, 00:30 AEDT on the 5th");
  eq([bizTzOf({ region: { timeZone: "Australia/Perth" } }), bizTzOf({ region: { timezone: "Australia/Perth" } }), bizTzOf({ region: { timeZone: "Mars/Base" } })], ["Australia/Perth", SYD, SYD], "vacation zone: region.timeZone (the old lowercase key is not read), else Sydney");
  eq([vacOpt({ options: {} }, "autoBack"), vacOpt({ options: { autoBack: "false" } }, "autoBack"), vacOpt({ options: { autoBack: false } }, "autoBack"), vacOpt({ options: { noNotify: "true" } }, "noNotify"), vacOpt({}, "noNotify")],
    [true, true, false, false, false], "vacOpt: autoBack on unless false; the rest only when true");
  const VR = (o: any = {}) => ({ id: "v1", employee_id: "e-a", starts_on: "2026-10-20", ends_on: "2026-10-24", stand_in_id: null, options: {}, ended_at: null, cancelled_at: null, reminded_at: null, ...o });
  const onD = (v: any, d: string) => vacOnDay(v, d, SYD);
  eq([onD(VR(), "2026-10-19"), onD(VR(), "2026-10-20"), onD(VR(), "2026-10-24"), onD(VR(), "2026-10-25")], [false, true, true, false], "vacOnDay: 20–24 with autoBack");
  eq([onD(VR({ options: { autoBack: false } }), "2026-10-30"), onD(VR({ cancelled_at: "2026-10-01T00:00:00Z" }), "2026-10-21")], [true, false], "vacOnDay: autoBack off stays; cancelled never");
  eq([onD(VR({ ended_at: "2026-10-21T13:30:00Z" }), "2026-10-21"), onD(VR({ ended_at: "2026-10-21T13:30:00Z" }), "2026-10-22"), onD(VR({ ended_at: "2026-10-21T12:30:00Z" }), "2026-10-21")],
    [true, false, false], "vacOnDay: ended 22 Oct 00:30 Sydney → back on the 22nd; ended 21 Oct 23:30 → back on the 21st");

  // who gets a notification
  const EMPS = [{ id: "e-a", name: "Ann", status: "Active" }, { id: "e-m", name: "Max", status: "Active" }, { id: "e-b", name: "Bea", status: "Active" }, { id: "e-x", name: "Xena", status: "Inactive" }, { id: "e-as", name: "Ann Smith", status: "Active" }];
  const PROFS = [{ id: "pa", full_name: "Ann Smith", technician_name: "Ann" }, { id: "pm", full_name: "Max", technician_name: null }, { id: "pb", full_name: "Bea" }, { id: "pn", full_name: "No Card" }, { id: "px", full_name: "Xena" }];
  const ctx = (vacs: any[]): any => ({ day: "2026-10-21", tz: SYD, vacs, employees: EMPS, profiles: PROFS });
  const RC = (ids: string[], vacs: any[]) => vacRecipients(ids, ctx(vacs));
  eq(RC(["pa", "pm"], [VR({ options: { noNotify: true } })]), ["pm"], "recipients: away with noNotify → left out");
  eq(RC(["pa"], [VR({ options: { noNotify: true, standIn: true }, stand_in_id: "e-m" })]), ["pm"], "recipients: noNotify + stand-in → the stand-in");
  eq([RC(["pa", "pm"], [VR({ options: { noNotify: true, standIn: true }, stand_in_id: "e-m" })]), RC(["pm", "pa"], [VR({ options: { noNotify: true, standIn: true }, stand_in_id: "e-m" })])], [["pm"], ["pm"]], "recipients: the stand-in already listed → once");
  eq(RC(["pa"], [VR({ options: { standIn: true }, stand_in_id: "e-m" })]), ["pa", "pm"], "recipients: stand-in without noNotify → both");
  eq(RC(["pa"], [VR({ options: { noNotify: true, standIn: true }, stand_in_id: "e-m" }), VR({ id: "v2", employee_id: "e-m", options: { noNotify: true, standIn: true }, stand_in_id: "e-b" })]), ["pb"], "recipients: a stand-in away too passes it on (chain)");
  eq(RC(["pa", "pm"], [VR({ options: { noNotify: true, standIn: true }, stand_in_id: "e-m" }), VR({ id: "v2", employee_id: "e-m", options: { noNotify: true, standIn: true }, stand_in_id: "e-a" })]), [], "recipients: A ↔ M both away → nobody twice, no loop");
  eq(RC(["pa"], [VR({ options: { standIn: true }, stand_in_id: "e-m" }), VR({ id: "v2", employee_id: "e-m", options: { standIn: true }, stand_in_id: "e-a" })]), ["pa", "pm"], "recipients: a stand-in loop without noNotify → each once");
  eq(RC(["pa"], [VR({ options: { noNotify: true, standIn: true }, stand_in_id: "e-x" })]), [], "recipients: an inactive stand-in is skipped");
  eq(RC(["pn", "pa"], [VR({ options: { noNotify: true } })]), ["pn"], "recipients: a login with no employee card is kept");
  eq([RC(["pa"], [VR({ options: { noNotify: true }, cancelled_at: "2026-10-19T00:00:00Z" })]), RC(["pa"], [VR({ options: { noNotify: true }, ended_at: "2026-10-20T03:00:00Z" })]), RC(["pa"], [VR({ options: { noNotify: true }, starts_on: "2026-10-22" })])],
    [["pa"], ["pa"], ["pa"]], "recipients: cancelled, ended or not started yet → unchanged");
  eq([RC(["pa"], [VR({ employee_id: "e-as", options: { noNotify: true } })]), RC(["pm"], [VR({ employee_id: "e-m", options: { noNotify: true } })])], [["pa"], []], "recipients: matched by technician_name first, then full_name");
  eq(RC(["pa", "pa", "pm"], []), ["pa", "pm"], "recipients: nobody away → the list as it was");
  // an owner on vacation whose stand-in is a technician: money and private details never reach the technician
  const ROLES = [{ id: "po", full_name: "Ava", role: "owner" }, { id: "pt", full_name: "Ben Lee", role: "technician" }, { id: "pv", full_name: "Vera", role: "va" }, { id: "po2", full_name: "Dana", role: "owner" }];
  const RE = [{ id: "e-o", name: "Ava", status: "Active" }, { id: "e-t", name: "Ben Lee", status: "Active" }, { id: "e-v", name: "Vera", status: "Active" }, { id: "e-o2", name: "Dana", status: "Active" }];
  const rctx = (stand: string, more: any[] = []): any => ({ day: "2026-10-21", tz: SYD, vacs: [VR({ employee_id: "e-o", options: { noNotify: true, standIn: true }, stand_in_id: stand }), ...more], employees: RE, profiles: ROLES });
  eq([vacRecipients(["po"], rctx("e-t"), ["owner"]), vacRecipients(["po"], rctx("e-t"), ["owner", "va", "manager"]), vacRecipients(["po"], rctx("e-t"))], [[], [], ["pt"]],
    "recipients: an owner's technician stand-in gets no owners-only kind (unpaid, documents, invoices), nor an office kind; any role when roles aren't given");
  eq([vacRecipients(["po"], rctx("e-v"), ["owner"]), vacRecipients(["po"], rctx("e-v"), ["owner", "va", "manager"]), vacRecipients(["po"], rctx("e-o2"), ["owner"])], [[], ["pv"], ["po2"]],
    "recipients: a VA stand-in gets the office kinds only; an owner stand-in gets everything");
  eq(vacRecipients(["po"], rctx("e-o2", [VR({ id: "v2", employee_id: "e-o2", options: { noNotify: true, standIn: true }, stand_in_id: "e-t" })]), ["owner"]), [], "recipients: a chain that ends at a technician stops there for an owners-only kind");
  eq([vacAwayProfile(ctx([VR({ options: { noCalls: true } })]), "pa", "noCalls")?.id, vacAwayProfile(ctx([VR({ options: { noCalls: true } })]), "pa", "noNotify"), vacProfilesOf(EMPS[0], ctx([])).map((p: any) => p.id)], ["v1", null, ["pa"]], "vacAwayProfile / vacProfilesOf");

  // fail-open: no table, an error or a throw = nobody is away
  const quiet = console.error; let logged = "";
  console.error = (...a: any[]) => { logged += a.map(String).join(" "); };
  const errQ: any = { select: () => errQ, is: () => errQ, lte: () => errQ, or: () => errQ, then: (ok: any) => ok({ data: null, error: { message: "relation \"employee_vacations\" does not exist" } }) };
  const errDb = { from: () => errQ };
  const c1 = await vacContext(fakeDb({}), NOW, SYD), c2 = await vacContext(errDb, NOW, SYD), c3 = await vacContext({ from: () => { throw new Error("boom"); } }, NOW, SYD);
  console.error = quiet;
  eq([c1.vacs.length, c2.vacs.length, c3.vacs.length, c1.day, c3.tz], [0, 0, 0, "2026-10-12", SYD], "vacContext: no table, an error, a throw → nobody away");
  eq([logged.includes("vacations not read: employee_vacations: relation \"employee_vacations\" does not exist"), logged.includes("vacations not read: boom"), vacRecipients(["u-ava", "u-ben"], c3)], [true, true, ["u-ava", "u-ben"]], "vacContext: an error and a throw are logged (\"vacations not read: ...\") and every recipient stays");
  logged = ""; console.error = (...a: any[]) => { logged += a.map(String).join(" "); };
  const empErr = fakeDb({ employee_vacations: [VR({ starts_on: "2026-10-10", ends_on: "2026-10-14" })] });
  const empQ: any = { select: () => empQ, then: (ok: any) => ok({ data: null, error: { message: "permission denied for table employees" } }) };
  const c6 = await vacContext({ from: (t: string) => t === "employees" ? empQ : empErr.from(t) }, NOW, SYD);
  console.error = quiet;
  eq([c6.vacs.length, logged.includes("vacations not read: employees: permission denied")], [0, true], "vacContext: the people can't be read → nobody away, and the log says which table");
  // NOW is 12 Oct: only what can be in force today is read (an old vacation that ended on its own never again)
  const vcdb = fakeDb({ employee_vacations: [VR({ id: "v1", starts_on: "2026-10-10", ended_at: "2026-10-11T00:00:00Z" }), VR({ id: "v2", starts_on: "2026-10-10", ends_on: "2026-10-12" }),
    VR({ id: "old", starts_on: "2026-09-01", ends_on: "2026-09-05" }), VR({ id: "open", starts_on: "2026-09-01", ends_on: "2026-09-05", options: { autoBack: false } }), VR({ id: "later", starts_on: "2026-10-13", ends_on: "2026-10-14" })], employees: EMPS, profiles: PROFS });
  const c4 = await vacContext(vcdb, NOW, SYD);
  eq([c4.vacs.map((v: any) => v.id), c4.employees.length, c4.profiles.length], [["v2", "open"], 5, 5], "vacContext: in force today (ended, over, not started yet → not read), then the people");
  eq((await vacContext(vcdb, NOW, SYD, 3)).vacs.map((v: any) => v.id), ["v2", "open", "later"], "vacContext: aheadDays also reads the ones starting by then");
  const c5 = await vacContext(fakeDb({ employee_vacations: [VR({ id: "old", starts_on: "2026-09-01", ends_on: "2026-09-05" })], employees: EMPS, profiles: PROFS }), NOW, SYD);
  eq([c5.vacs.length, c5.employees.length], [0, 0], "vacContext: only past vacations → nobody away, the people aren't read");

  // scan + invoice with an owner on vacation (No notifications + stand-in Ben)
  const away = (from: string, to: string) => ({ id: "v-ava", employee_id: "e-ava", starts_on: from, ends_on: to, stand_in_id: "e-ben", options: { noNotify: true, standIn: true }, ended_at: null, cancelled_at: null });
  const today = bizParts(Date.now(), SYD).day;
  const vdb = fakeDb({
    profiles: [AVA, BEN, { id: "u-eve", role: "va", full_name: "Eve" }],
    push_subscriptions: [
      { id: "p1", user_id: "u-ava", endpoint: "https://push/ava", p256dh: "k", auth: "a" }, { id: "p2", user_id: "u-ben", endpoint: "https://push/ben", p256dh: "k", auth: "a" },
      { id: "p3", user_id: "u-eve", endpoint: "https://push/eve", p256dh: "k", auth: "a" },
    ],
    settings: [{ id: 1, catalog: { notify: { newLead: { on: true, office: true } } } }],
    contacts: [{ id: "c1", full_name: "Sam New", division: "Aircon", source: "Google Ads", status: "New", created_at: "2026-10-12", messages: [{ at: "2026-10-12T03:00:00Z" }], tags: [] }],
    employees: [{ id: "e-ava", name: "Ava", status: "Active" }, { id: "e-ben", name: "Ben", status: "Active" }],
    employee_vacations: [away("2026-10-11", "2026-10-14")], push_sent: [],
    payroll_weeks: [{ week_start: "2026-10-04", person: "Cal", salary_invoice_file: "sb:payroll/x.pdf" }],
  });
  sent.length = 0;
  await scan(vdb, NOW);
  eq(sent.map((x) => `${x.to.replace("https://push/", "")}:${x.msg.title}`).sort(), ["ben:New lead: Sam New", "eve:New lead: Sam New"], "scan: Ava away → his stand-in Ben once (not twice), the office still gets it");
  vdb.T.employee_vacations = [away(shiftDay(today, -1), shiftDay(today, 2))];
  sent.length = 0;
  await handle(vdb, { step: "invoice", week: "2026-10-04", person: "Cal" }, AVA);
  eq(sent.map((x) => x.to), ["https://push/ben"], "invoice: to Ben, not Ava who is away");
  // the stand-in is a technician: no invoice, no unpaid job, no new lead (the office still gets that one)
  const tdb2 = fakeDb({
    profiles: [AVA, CAL, { id: "u-eve", role: "va", full_name: "Eve" }],
    push_subscriptions: ["ava", "cal", "eve"].map((n, i) => ({ id: "t" + i, user_id: "u-" + n, endpoint: "https://push/" + n, p256dh: "k", auth: "a" })),
    settings: [{ id: 1, catalog: { notify: { newLead: { on: true, office: true }, unpaid: { on: true } } } }],
    contacts: [{ id: "c1", full_name: "Sam New", division: "Aircon", source: "Google Ads", status: "New", created_at: "2026-10-12", messages: [{ at: "2026-10-12T03:00:00Z" }], tags: [] }],
    jobs: [{ id: "j1", customer_name: "Rich Client", amount: 1250, date: shiftDay("2026-10-12", -7), payment_status: "Unpaid" }],
    employees: [{ id: "e-ava", name: "Ava", status: "Active" }, { id: "e-cal", name: "Cal", status: "Active" }],
    employee_vacations: [{ ...away("2026-10-11", "2026-10-14"), stand_in_id: "e-cal" }], push_sent: [],
    payroll_weeks: [{ week_start: "2026-10-04", person: "Dee", salary_invoice_file: "sb:payroll/x.pdf" }],
  });
  sent.length = 0;
  await scan(tdb2, NOW);
  eq(sent.map((x) => `${x.to.replace("https://push/", "")}:${x.msg.title.split(":")[0]}`).sort(), ["eve:New lead"], "scan: an owner's technician stand-in gets neither the unpaid job nor the new lead; the office gets the lead");
  tdb2.T.employee_vacations = [{ ...away(shiftDay(today, -1), shiftDay(today, 2)), stand_in_id: "e-cal" }];
  sent.length = 0;
  await handle(tdb2, { step: "invoice", week: "2026-10-04", person: "Dee" }, AVA);
  eq(sent.length, 0, "invoice: never to an owner's technician stand-in");
  sent.length = 0;
  await handle(vdb, { step: "test" }, AVA);
  eq(sent.map((x) => x.to), ["https://push/ava"], "test: still the caller's own device while on vacation");
  vdb.T.employee_vacations = [];
  sent.length = 0;
  await handle(vdb, { step: "invoice", week: "2026-10-04", person: "Cal" }, AVA);
  eq(sent.map((x) => x.to), ["https://push/ava", "https://push/ben"], "invoice: no vacations → both owners, as before");

  // the day before someone is back
  const BACK_9 = Date.parse("2026-10-23T22:00:00Z"), BACK_0730 = Date.parse("2026-10-23T20:30:00Z");   // Saturday 24 Oct 09:00 / 07:30 Sydney
  const CALV = (o: any = {}) => ({ id: "v-cal", employee_id: "e-cal", starts_on: "2026-10-20", ends_on: "2026-10-24", stand_in_id: null, options: { remind: true, noNotify: true }, ended_at: null, cancelled_at: null, reminded_at: null, ...o });
  const backDb = (vacs: any[], catalog: any = {}) => fakeDb({
    profiles: [AVA, BEN, CAL, DEE],
    push_subscriptions: ["ava", "ben", "cal", "dee"].map((n, i) => ({ id: "b" + i, user_id: "u-" + n, endpoint: "https://push/" + n, p256dh: "k", auth: "a" })),
    settings: [{ id: 1, catalog }],
    employees: [{ id: "e-cal", name: "Cal", status: "Active" }, { id: "e-ava", name: "Ava", status: "Active" }, { id: "e-ben", name: "Ben", status: "Active" }, { id: "e-dee", name: "Dee", status: "Active" }],
    employee_vacations: vacs, push_sent: [],
    tasks: [
      { id: "t1", status: "Not Started", assignees: ["Cal"], assigned_to: "Cal", contact_id: "c1" }, { id: "t2", status: "In Progress", assignees: ["Cal", "Ben"], assigned_to: "Cal", contact_id: "c1" },
      { id: "t3", status: "Done", assignees: ["Cal"], assigned_to: "Cal", contact_id: "c2" }, { id: "t4", status: "Not Started", assignees: ["Ben"], assigned_to: "Ben", contact_id: "c3" },
    ],
    jobs: [{ id: "j1", technician: "Cal", date: "2026-10-26" }, { id: "j2", technician: "Cal", date: "2026-11-05" }, { id: "j3", technician: "Ben", date: "2026-10-26" }, { id: "j4", technician: "Cal", date: "2026-10-22" }],
  });
  const msgs = () => sent.map((x) => `${x.to.replace("https://push/", "")}:${x.msg.title}|${x.msg.body}`).sort();
  const bdb2 = backDb([CALV()]);
  sent.length = 0;
  eq((await scan(bdb2, BACK_0730)).off, true, "back tomorrow: 07:30 is before the morning hour → nothing (and off, nothing else is on)");
  eq(sent.length, 0, "back tomorrow: nothing at 07:30");
  const rb = await scan(bdb2, BACK_9);
  eq(msgs(), [
    "ava:Cal is back tomorrow|Waiting for them: 2 open tasks, 1 job in the first week back and 1 lead.",
    "ben:Cal is back tomorrow|Waiting for them: 2 open tasks, 1 job in the first week back and 1 lead.",
    "cal:You're back tomorrow|Waiting for you: 2 open tasks, 1 job in the first week back and 1 lead.",
  ], "back tomorrow: to Cal (even with No notifications) and the owners, with what is waiting");
  eq([rb.off, sent.find((x) => x.to.endsWith("/cal"))?.msg.url, sent.find((x) => x.to.endsWith("/ava"))?.msg.url, sent[0].msg.tag], [undefined, APP_URL + "?tab=tasks", APP_URL + "?tab=settings&page=people", "vacback-v-cal"], "back tomorrow: runs with every notification off; where it opens");
  eq([bdb2.T.push_sent.some((r: any) => r.key === "vacback:v-cal:2026-10-24"), typeof bdb2.T.employee_vacations[0].reminded_at], [true, "string"], "back tomorrow: recorded once (push_sent) and reminded_at set");
  sent.length = 0;
  await scan(bdb2, BACK_9 + 9 * 60000);
  eq(sent.length, 0, "back tomorrow: the next scan sends nothing again");
  for (const [o, name] of [[{ options: { noNotify: true } }, "remind unticked"], [{ cancelled_at: "2026-10-19T00:00:00Z" }, "cancelled"], [{ ended_at: "2026-10-22T01:00:00Z" }, "ended"], [{ ends_on: "2026-10-25" }, "not the last day yet"],
    [{ options: { remind: true, noNotify: true, autoBack: false } }, "autoBack off (not back tomorrow: it goes on until someone ends it)"]] as [any, string][]) {
    sent.length = 0;
    await scan(backDb([CALV(o)]), BACK_9);
    eq(sent.length, 0, `back tomorrow: ${name} → nothing`);
  }
  // another vacation of theirs starts tomorrow: not back then either (main builder review 1.C.3)
  sent.length = 0;
  const nextDb = backDb([CALV(), CALV({ id: "v-cal2", starts_on: "2026-10-25", ends_on: "2026-10-28" })]);
  await scan(nextDb, BACK_9);
  eq([sent.length, nextDb.T.push_sent.some((r: any) => String(r.key).startsWith("vacback:"))], [0, false], "back tomorrow: another vacation starts tomorrow → nothing, nothing claimed");
  sent.length = 0;
  await scan(backDb([CALV(), CALV({ id: "v-cal2", starts_on: "2026-10-27", ends_on: "2026-10-28" })]), BACK_9);
  eq(sent.length, 3, "back tomorrow: the next vacation starts later → the reminder goes");
  sent.length = 0;
  await scan(backDb([CALV(), CALV({ id: "v-cal2", starts_on: "2026-10-25", ends_on: "2026-10-28", cancelled_at: "2026-10-20T00:00:00Z" })]), BACK_9);
  eq(sent.length, 3, "back tomorrow: a cancelled next vacation doesn't count");
  // an employee card that can't be found: nothing claimed, so it can still go once the card is there
  const noCard = backDb([CALV()]);
  noCard.T.employees = noCard.T.employees.filter((e: any) => e.id !== "e-cal");
  sent.length = 0;
  await scan(noCard, BACK_9);
  eq([sent.length, noCard.T.push_sent.some((r: any) => String(r.key).startsWith("vacback:"))], [0, false], "back tomorrow: no employee card → nothing sent and nothing claimed");
  // the jobs are read for the first week back only
  const weekDb = backDb([CALV()]);
  weekDb.T.jobs.push(...Array.from({ length: 30 }, (_, i) => ({ id: "late" + i, technician: "Cal", date: shiftDay("2026-11-01", i) })));
  const reads: string[] = [];
  const realFrom = weekDb.from.bind(weekDb);
  weekDb.from = (t: string) => { const q = realFrom(t); if (t !== "jobs") return q; const lte = q.lte.bind(q); q.lte = (k: string, v: any) => { reads.push(`${k}<=${v}`); return lte(k, v); }; return q; };
  sent.length = 0;
  await scan(weekDb, BACK_9);
  eq([reads, sent.find((x) => x.to.endsWith("/cal"))?.msg.body], [["date<=2026-10-31"], "Waiting for you: 2 open tasks, 1 job in the first week back and 1 lead."], "back tomorrow: the jobs query stops at the first week back");
  sent.length = 0;
  await scan(backDb([CALV(), { id: "v-ava", employee_id: "e-ava", starts_on: "2026-10-23", ends_on: "2026-10-30", stand_in_id: "e-dee", options: { noNotify: true, standIn: true }, ended_at: null, cancelled_at: null }]), BACK_9);
  eq(sent.map((x) => x.to.replace("https://push/", "")).sort(), ["ben", "cal"], "back tomorrow: an owner away is skipped; their technician stand-in never gets the owners' copy");
  sent.length = 0;
  eq((await scan(backDb([]), BACK_9)).off, true, "back tomorrow: everything off and nobody away → still off");
  // more than 1000 tasks (PostgREST's cap): the open ones are read page by page, the Done ones not at all
  const many = backDb([CALV()]);
  many.T.tasks = [...Array.from({ length: 1500 }, (_, i) => ({ id: "d" + i, status: "Done", assignees: ["Cal"], assigned_to: "Cal" })), ...Array.from({ length: 1100 }, (_, i) => ({ id: "n" + i, status: "Not Started", assignees: ["Ben"], assigned_to: "Ben" })),
    { id: "g1", status: "Not Started", assignees: ["Cal"], assigned_to: "Cal", contact_id: null }, { id: "g2", status: null, assignees: ["Cal"], assigned_to: "Cal", contact_id: null }];
  sent.length = 0;
  await scan(many, BACK_9);
  eq(sent.find((x) => x.to.endsWith("/cal"))?.msg.body, "Waiting for you: 2 open tasks and 1 job in the first week back.", "back tomorrow: open tasks past the first 1000 rows still count");
  eq((await vacOpenTasks(many)).length, 1102, "vacOpenTasks: every open task (no status counts as open), over two pages");
  // the summary itself
  const W = (t: any[], j: any[]) => vacWaiting("Cal", "2026-10-25", t, j);
  const w1 = W([{ status: "Done", assignees: ["Cal"] }, { status: "Not Started", assigned_to: "Cal", contact_id: "c1" }, { status: "Not Started", assignees: [], assigned_to: "Cal" }, { status: "Not Started", assignees: ["Cal"], contact_id: null }],
    [{ technician: "Cal", date: "2026-10-25" }, { technician: "Cal", date: "2026-10-31" }, { technician: "Cal", date: "2026-11-01" }, { technician: "Ben", date: "2026-10-26" }, { technician: "Cal", date: "2026-10-24" }]);
  eq([w1.tasks.length, w1.jobs.length, w1.leads], [2, 2, 1], "vacWaiting: Done not counted, assigned_to only without an array, jobs from the return day to 6 days after, leads = distinct cards");
  eq([vacWaitingText({ tasks: [1], jobs: [], leads: 0 } as any), vacWaitingText({ tasks: [], jobs: [1, 2], leads: 3 } as any), vacWaitingText({ tasks: [1, 2, 3], jobs: [1, 2], leads: 1 } as any), vacWaitingText({ tasks: [], jobs: [], leads: 0 })],
    ["1 open task", "2 jobs in the first week back and 3 leads", "3 open tasks, 2 jobs in the first week back and 1 lead", "nothing yet"], "vacWaitingText: singular / plural, empty parts dropped");
  eq([bizParts(BACK_9, SYD).hour, bizParts(BACK_0730, SYD).hour, bizParts(BACK_9, "Australia/Perth").hour], [9, 7, 6], "back tomorrow: the hour in the business zone");
  // its own switch (Settings → Notifications, on unless switched off) and the notifications' hours (review A4)
  eq([notifyOn({}, "vacationBack"), notifyOn({ vacationBack: { on: false } }, "vacationBack"), notifyOn({ vacationBack: { on: true } }, "vacationBack"), NOTIFY_KINDS.includes("vacationBack")], [true, false, true, true], "notifyOn: back tomorrow is on unless switched off");
  sent.length = 0;
  eq([(await scan(backDb([CALV()], { notify: { vacationBack: { on: false } } }), BACK_9)).off, sent.length], [true, 0], "back tomorrow: switched off → nothing, and nothing is read");
  sent.length = 0;
  await scan(backDb([CALV()], { notify: { rules: { from: 6, until: 9 } } }), BACK_9);
  eq(sent.length, 0, "back tomorrow: 09:00 is past the hours (6 am to 9 am) → nothing (quiet hours)");
  sent.length = 0;
  await scan(backDb([CALV()], { notify: { rules: { from: 6, until: 10 } } }), BACK_9);
  eq(sent.length, 3, "back tomorrow: inside the hours → sent");
  // the business's zone (region.timeZone): 09:00 Sydney is 06:00 in Perth, before the morning hour; 09:00 Perth is the time
  sent.length = 0;
  await scan(backDb([CALV()], { region: { timeZone: "Australia/Perth" } }), BACK_9);
  eq(sent.length, 0, "back tomorrow: Perth business, 06:00 there → nothing yet");
  await scan(backDb([CALV()], { region: { timeZone: "Australia/Perth" } }), BACK_9 + 3 * 3600e3);
  eq(sent.length, 3, "back tomorrow: Perth business, 09:00 there → sent");
  const tvb = testPayload("vacationBack", notifyRules({}, 7), "2026-10-23");
  eq([tvb && tvb.title, tvb && tvb.tag], ["Test · Sample Employee is back tomorrow", "test-vacationBack"], "test: the back-tomorrow card has a test with made-up data");

  console.log(`push: ${pass} passed, ${fail} failed`);
  if (fail) (globalThis as any).process?.exit(1);
})();
