// Tests for push/index.ts. Run: bash supabase/functions/push/run_tests.sh
// deno-lint-ignore-file no-explicit-any

function fakeDb(seed: Record<string, any[]> = {}) {
  const T: Record<string, any[]> = { app_keys: [], push_subscriptions: [], payroll_weeks: [], profiles: [], ...seed };
  function q(table: string) {
    const rows = () => (T[table] = T[table] || []);
    const filters: ((r: any) => boolean)[] = [];
    let op = "select", payload: any = null, lim = Infinity, single = false;
    const b: any = {
      select() { return b; }, insert(p: any) { op = "insert"; payload = p; return b; }, delete() { op = "delete"; return b; },
      eq(k: string, v: any) { filters.push((r) => r[k] === v); return b; },
      gte(k: string, v: any) { filters.push((r) => r[k] >= v); return b; },
      in(k: string, list: any[]) { filters.push((r) => list.includes(r[k])); return b; },
      limit(n: number) { lim = n; return b; }, single() { single = true; return b; },
      then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej); },
    };
    function run() {
      const m = () => rows().filter((r) => filters.every((f) => f(r)));
      if (op === "insert") { if ((table === "app_keys" && rows().some((r) => r.name === payload.name)) || (table === "push_sent" && rows().some((r) => r.key === payload.key))) return { data: null, error: { message: "duplicate" } }; rows().push({ ...payload }); return { data: null, error: null }; }
      if (op === "delete") { const gone = m(); T[table] = rows().filter((r) => !gone.includes(r)); return { data: gone, error: null }; }
      const out = m().slice(0, lim).map((r) => ({ ...r }));
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
  eq([sydParts(Date.parse("2026-10-12T03:30:00Z")).day, sydParts(Date.parse("2026-10-12T03:30:00Z")).hour, shiftDay("2026-10-01", -7)], ["2026-10-12", 14, "2026-09-24"], "scan helpers: Sydney time (AEDT) and day shifts");
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

  console.log(`push: ${pass} passed, ${fail} failed`);
  if (fail) (globalThis as any).process?.exit(1);
})();
