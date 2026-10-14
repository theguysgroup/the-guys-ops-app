// Tests for conversations/index.ts. Run: bash supabase/functions/conversations/run_tests.sh
// (the runner swaps the esm.sh import for a stub, appends this file and runs it with npx tsx).
// deno-lint-ignore-file no-explicit-any

// The business's own names as the C-names SQL saves them (round 3): today's words, now coming from the settings row.
const SETTINGS_ROW = () => ({ company_name: "The Guys Service Group", catalog: { business: { phone: "1300 380 090", shortName: "The Guys Group" }, brands: { Aircon: "The AC Cleaning Guys", Chimney: "The Chimney Guys", "Pressure Washing": "The Pressure Washing Guys" } } });
// ── a small in-memory stand-in for the Supabase client ──
function fakeDb(seed: Record<string, any[]> = {}) {
  const T: Record<string, any[]> = { contacts: [], chat_sessions: [], lead_messages: [], sms_opt_outs: [], calls: [], settings: [{ id: 1, chat_auto_sms: true, chat_tick_at: null, ...SETTINGS_ROW() }], profiles: [{ full_name: "Ron", role: "va" }], ...seed };
  function q(table: string) {
    const rows = () => (T[table] = T[table] || []);
    const filters: ((r: any) => boolean)[] = [];
    let op = "select", payload: any = null, opts: any = {}, single = false, lim = Infinity, order: [string, boolean] | null = null, range: [number, number] | null = null, wantRows = true;
    const b: any = {
      select(_c?: string, o?: any) { if (op === "select") opts = o || {}; else wantRows = true; return b; },
      insert(p: any) { op = "insert"; payload = p; wantRows = false; return b; },
      update(p: any) { op = "update"; payload = p; return b; },
      upsert(p: any, o?: any) { op = "upsert"; payload = p; opts = o || {}; return b; },
      delete() { op = "delete"; return b; },
      eq(k: string, v: any) { filters.push((r) => r[k] === v); return b; },
      gt(k: string, v: any) { filters.push((r) => String(r[k]) > String(v)); return b; },
      gte(k: string, v: any) { filters.push((r) => String(r[k]) >= String(v)); return b; },
      lte(k: string, v: any) { filters.push((r) => String(r[k]) <= String(v)); return b; },
      is(k: string, v: any) { filters.push((r) => (r[k] ?? null) === v); return b; },
      order(k: string, o?: any) { order = [k, !(o && o.ascending === false)]; return b; },
      limit(x: number) { lim = x; return b; },
      range(a: number, z: number) { range = [a, z]; return b; },
      single() { single = true; return b; },
      then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej); },
    };
    function run() {
      const match = () => rows().filter((r) => filters.every((f) => f(r)));
      if (op === "insert") {
        const list = (Array.isArray(payload) ? payload : [payload]).map((r: any) => ({ id: r.id || crypto.randomUUID(), auto: false, ...r }));
        rows().push(...list);
        return { data: single ? list[0] : list, error: null };
      }
      if (op === "upsert") { const key = opts.onConflict || "phone_key"; const i = rows().findIndex((r) => r[key] === payload[key]); if (i >= 0) rows()[i] = { ...rows()[i], ...payload }; else rows().push({ ...payload }); return { data: null, error: null }; }
      if (op === "update") { const m = match(); m.forEach((r) => Object.assign(r, payload)); return { data: m, error: null }; }
      if (op === "delete") { const m = match(); T[table] = rows().filter((r) => !m.includes(r)); return { data: m, error: null }; }
      let m = match();
      if (order) { const [k, asc] = order; m = m.slice().sort((a, z) => (String(a[k]) < String(z[k]) ? -1 : String(a[k]) > String(z[k]) ? 1 : 0) * (asc ? 1 : -1)); }
      if (range) m = m.slice(range[0], range[1] + 1);
      m = m.slice(0, lim);
      if (opts.head) return { data: null, count: m.length, error: null };
      return { data: single ? (m[0] || null) : m.map((r) => ({ ...r })), error: null };
    }
    return b;
  }
  return { T, from: q };
}

let pass = 0, fail = 0;
function eq(got: any, want: any, name: string) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}
const sent: { to: string; body: string }[] = [];
const waSent: { to: string; body: string }[] = [];
let waMode: "ok" | "off" = "off";
io.sendWhatsApp = async (to: string, body: string) => { if (waMode === "off") return { ok: false, error: "whatsapp_not_set_up" }; waSent.push({ to, body }); return { ok: true, sid: "WA" + waSent.length }; };
let smsMode: "ok" | "off" | "fail" = "ok";
const intakes: any[] = [];
io.sendSms = async (to: string, body: string) => { if (smsMode === "off") return { ok: false, error: "sms_not_set_up" }; if (smsMode === "fail") return { ok: false, error: "21610" }; sent.push({ to, body }); return { ok: true, sid: "SM" + sent.length }; };
io.intake = async (f: any) => { intakes.push(f); return { id: "c-new", attached: "" }; };
io.isMailbox = async (tok: any) => tok === "good-token-good-token";

// Sydney times (AEST = UTC+10 until 4 Oct 2026 02:00, then AEDT = UTC+11)
const MON_1000 = Date.parse("2026-09-28T00:00:00Z");          // Mon 28 Sep 10:00 AEST

(async () => {
  // ── office hours, including the edges and the daylight-saving change ──
  eq(officeOpen(Date.parse("2026-09-27T21:59:00Z")), false, "Mon 07:59 closed");
  eq(officeOpen(Date.parse("2026-09-27T22:00:00Z")), true, "Mon 08:00 open");
  eq(officeOpen(Date.parse("2026-10-02T06:59:00Z")), true, "Fri 16:59 open");
  eq(officeOpen(Date.parse("2026-10-02T07:00:00Z")), false, "Fri 17:00 closed");
  eq(officeOpen(Date.parse("2026-10-03T02:00:00Z")), false, "Sat noon closed");
  eq(officeOpen(Date.parse("2026-10-04T21:00:00Z")), true, "Mon 5 Oct 08:00 AEDT open (after daylight saving)");
  eq(officeOpen(Date.parse("2026-10-04T20:59:00Z")), false, "Mon 5 Oct 07:59 AEDT closed");

  // ── texts ──
  useSettings(SETTINGS_ROW());
  eq(fill("{hi}, it's Ron from {brand} about {service}.", { first_name: "sarah", brand: "The Chimney Guys", service_text: "chimney cleaning" }), "Hi Sarah, it's Ron from The Chimney Guys about chimney cleaning.", "fill with name");
  eq(fill("{hi}, from {brand} about {service}.", { first_name: "", brand: "", service_text: "" }), "Hi there, from The Guys Group about your enquiry.", "fill without name");
  eq(cleanFirstName("TEST 10 - Claude"), "TEST", "first word only");
  eq(cleanFirstName("1234"), "", "a number is not a name");

  // ── chat_start ──
  let db = fakeDb();
  eq((await chatStart(db, { name: "123", phone: "0412345678", service: "split" }, "1.1.1.1", MON_1000)).reason, "bad_name", "rejects a bad name");
  eq((await chatStart(db, { name: "Sarah", phone: "12345", service: "split" }, "1.1.1.1", MON_1000)).reason, "bad_phone", "rejects a bad phone");
  const r1: any = await chatStart(db, { name: "Sarah Jones", phone: "0412 345 678", service: "ducted", page: "/ducted-aircon-cleaning/", attribution: { gclid: "abc", utm_source: "" } }, "1.1.1.1", MON_1000);
  eq([r1.ok, typeof r1.token, db.T.chat_sessions.length], [true, "string", 1], "starts a session");
  const s1 = db.T.chat_sessions[0];
  eq([s1.contact_id, s1.first_name, s1.brand, s1.service_text, s1.phone, s1.token_hash === r1.token], ["c-new", "Sarah", "The AC Cleaning Guys", "ducted aircon cleaning", "+61412345678", false], "session fields (token stored hashed)");
  eq([intakes[0].full_name, intakes[0].division, intakes[0].lead_channel, intakes[0].job_description, intakes[0].gclid, intakes[0].submission_page], ["Sarah Jones", "Aircon", "chat", "Website chat: ducted aircon cleaning", "abc", "/ducted-aircon-cleaning/"], "the card goes through intake-lead");
  eq([db.T.lead_messages[0].body, db.T.lead_messages[0].direction, db.T.lead_messages[0].channel], ["Hi, I'd like a quote for ducted aircon cleaning.", "in", "chat"], "first message stored");
  eq([s1.alert_subject, /Source: Google Ads \(click id\)/.test(s1.alert_body), s1.alert_sent_at ?? null], ["New website chat lead - Sarah Jones 0412 345 678", true, null], "office email written, waiting for info@");
  eq((await alerts(db, { id_token: "forged-token-forged" }, MON_1000)).reason, "unauthorized", "only the info@ mailbox gets the emails");
  const al: any = await alerts(db, { id_token: "good-token-good-token" }, MON_1000);
  eq([al.emails.length, al.emails[0].to, al.emails[0].subject], [1, "info@theguyservicegroup.com", "New website chat lead - Sarah Jones 0412 345 678"], "info@ gets the email");
  await alerts(db, { id_token: "good-token-good-token", sent: [al.emails[0].id] }, MON_1000 + 60000);
  eq([!!db.T.chat_sessions[0].alert_sent_at, (await alerts(db, { id_token: "good-token-good-token" }, MON_1000 + 61000)).emails.length], [true, 0], "sent once only");
  const r2: any = await chatStart(db, { name: "Bob", phone: "0498765432", service: "nonsense" }, "", MON_1000);
  const s2 = db.T.chat_sessions.find((s: any) => s.id === r2.session);
  eq([s2.service_key, s2.brand, s2.service_text, db.T.lead_messages.find((m: any) => m.session_id === s2.id).body, intakes[1].division], ["other", "The Guys Group", "your enquiry", "Hi, I'd like a quote.", "Other"], "something else");
  // the settings can't be read when a chat starts (cold instance, { data: null, error }): the chat is stored without a
  // brand, and its texts get the service's brand once the settings are read again
  {
    const bad = fakeDb(), from0 = bad.from;
    bad.from = (t: string) => t === "settings" ? { select: () => ({ limit: async () => ({ data: null, error: { message: "timeout" } }) }) } : from0(t);
    useSettings(null);
    const rb: any = await chatStart(bad, { name: "Tia", phone: "0433333333", service: "split" }, "", MON_1000);
    const sb3 = bad.T.chat_sessions.find((s: any) => s.id === rb.session);
    useSettings(SETTINGS_ROW());
    eq([rb.ok, sb3.brand, fill("from {brand}", sb3)], [true, "", "from The AC Cleaning Guys"], "a failed settings read: no empty brand in the texts (the service's brand once read)");
    await loadCatalog(bad);
    eq(fill("from {brand}", { brand: "", service_key: "pw" }), "from The Pressure Washing Guys", "a failed read keeps the settings read last (never 'nothing saved')");
  }
  for (let i = 0; i < 5; i++) await chatStart(db, { name: "Sam", phone: "0411111111", service: "pw" }, "", MON_1000);
  eq((await chatStart(db, { name: "Sam", phone: "0411111111", service: "pw" }, "", MON_1000)).reason, "limit", "a 6th chat in a day from one phone is refused");
  const keepIntake = io.intake;
  io.intake = async () => { throw new Error("network"); };
  const rDown: any = await chatStart(db, { name: "Kim", phone: "0422222222", service: "pw" }, "", MON_1000);
  io.intake = keepIntake;
  const sDown = db.T.chat_sessions.find((s: any) => s.id === rDown.session);
  eq([rDown.ok, sDown.contact_id, /could not be created/.test(sDown.alert_body)], [true, null, true], "intake-lead down: the chat still starts and the email says so");
  const before = intakes.length;
  const rt: any = await chatStart(db, { name: "Ofek", phone: "0418638552", service: "chimney", test: true }, "", MON_1000);
  const tc = db.T.contacts.find((c: any) => c.id === db.T.chat_sessions.find((s: any) => s.id === rt.session).contact_id);
  eq([intakes.length === before, tc.full_name, tc.tags, db.T.chat_sessions.find((s: any) => s.id === rt.session).alert_subject.startsWith("[TEST]")], [true, "TEST - Ofek", ["Test"], true], "test chat: own TEST card, no intake-lead");

  // ── chat_send / chat_poll ──
  db.T.contacts.push({ id: "c-new", job_description: "Website chat: ducted aircon cleaning" });
  eq((await chatSend(db, { session: r1.session, token: "wrong-token-wrong-token", text: "hi" }, MON_1000)).reason, "session", "wrong token refused");
  await chatSend(db, { session: r1.session, token: r1.token, text: "Bondi, 3 bedroom house" }, MON_1000 + 1000);
  await chatSend(db, { session: r1.session, token: r1.token, text: "Also gutters?" }, MON_1000 + 2000);
  eq([db.T.contacts.find((c: any) => c.id === "c-new").job_description, db.T.chat_sessions[0].details], ["Website chat: ducted aircon cleaning. Bondi, 3 bedroom house", "Bondi, 3 bedroom house"], "first details go on the card once");
  const user = { id: "ron", full_name: "Ron" };
  db.T.contacts.find((c: any) => c.id === "c-new").phone = "0412 345 678";
  eq((await reply(db, user, { contact_id: "c-new", channel: "chat", text: "Hi Sarah, Ron here!" }, MON_1000 + 60000)).ok, true, "Ron answers in the chat");
  const polled: any = await chatPoll(db, { session: r1.session, token: r1.token }, MON_1000 + 61000);
  eq(polled.messages.map((m: any) => m.text), ["Hi Sarah, Ron here!"], "the customer's window gets Ron's reply only");
  eq((await chatPoll(db, { session: r1.session, token: r1.token, after: polled.messages[0].at }, MON_1000 + 62000)).messages.length, 0, "nothing new after the last one");

  // ── reply by SMS ──
  eq((await reply(db, user, { contact_id: "c-new", channel: "sms", text: "Hi Sarah" }, MON_1000)).ok, true, "SMS reply sent");
  eq([sent[sent.length - 1].to, db.T.lead_messages[db.T.lead_messages.length - 1].status], ["+61412345678", "sent"], "to the card's mobile, logged");
  db.T.sms_opt_outs.push({ phone_key: "412345678" });
  eq((await reply(db, user, { contact_id: "c-new", channel: "sms", text: "Hi" }, MON_1000)).reason, "opted_out", "never to a number that sent STOP");
  db.T.contacts.push({ id: "c-land", phone: "02 9999 8888" });
  eq((await reply(db, user, { contact_id: "c-land", channel: "sms", text: "Hi" }, MON_1000)).reason, "not_mobile", "landlines can't get texts");
  smsMode = "off";
  const nMsgs = db.T.lead_messages.length;
  eq([(await reply(db, user, { contact_id: "c-new", channel: "sms", text: "Hi", phone: "0499999999" }, MON_1000)).reason, db.T.lead_messages.length - nMsgs], ["sms_not_set_up", 0], "texts not switched on: nothing logged");
  smsMode = "ok";

  // ── reply by email / WhatsApp ──
  db.T.contacts.find((c: any) => c.id === "c-new").email = "Sarah@Example.com";
  db.T.contacts.find((c: any) => c.id === "c-new").division = "Chimney";
  const re: any = await reply(db, user, { contact_id: "c-new", channel: "email", text: "Here is the quote." }, MON_1000);
  const em = db.T.lead_messages[db.T.lead_messages.length - 1];
  eq([re.ok, re.queued, em.channel, em.status, em.email, em.subject], [true, true, "email", "queued", "sarah@example.com", "Your enquiry - The Chimney Guys"], "email reply queued for info@ to send");
  eq((await reply(db, user, { contact_id: "c-land", channel: "email", text: "Hi" }, MON_1000)).reason, "no_email", "no email on the card → refused");
  const ae: any = await alerts(db, { id_token: "good-token-good-token" }, MON_1000 + 1000);
  const custEmail = ae.emails.find((m: any) => m.id === "m:" + em.id);
  eq([custEmail && custEmail.to, custEmail && /Here is the quote\.\n\nRon\nThe Guys Service Group/.test(custEmail.text)], ["sarah@example.com", true], "info@ gets the customer email, signed by Ron");
  await alerts(db, { id_token: "good-token-good-token", sent: ["m:" + em.id] }, MON_1000 + 2000);
  eq(em.status, "sent", "marked sent once info@ sent it");

  // ── the weekly backup email (backup function → backup_runs), sent by the same info@ script ──
  {
    const bdb = fakeDb({ backup_runs: [
      { id: "r1", email_status: "queued", email_queued_at: new Date(MON_1000 - 3600e3).toISOString(), email_to: "owner@example.com", email_subject: "Weekly backup of the OPS app, Sun 27 Sep 2026 (locked)", email_body: "The weekly backup is ready…\nhttps://signed/1" },
      { id: "r-old", email_status: "queued", email_queued_at: new Date(MON_1000 - 49 * 3600e3).toISOString(), email_to: "owner@example.com", email_subject: "old", email_body: "old" },
      { id: "r-sent", email_status: "sent", email_queued_at: new Date(MON_1000 - 3600e3).toISOString(), email_to: "owner@example.com", email_subject: "x", email_body: "x" },
    ] });
    eq((await alerts(bdb, { id_token: "forged-token-forged" }, MON_1000)), { ok: false, reason: "unauthorized" }, "backup email: a forged token gets nothing");
    const a1: any = await alerts(bdb, { id_token: "good-token-good-token" }, MON_1000);
    eq(a1.emails, [{ id: "b:r1", to: "owner@example.com", subject: "Weekly backup of the OPS app, Sun 27 Sep 2026 (locked)", text: "The weekly backup is ready…\nhttps://signed/1" }], "backup email: only the queued one of the last 48 h, to the chosen address, as written (no signature)");
    await alerts(bdb, { id_token: "good-token-good-token", sent: ["b:r1"] }, MON_1000 + 60000);
    const r1 = bdb.T.backup_runs.find((r: any) => r.id === "r1");
    eq([r1.email_status, r1.email_sent_at, (await alerts(bdb, { id_token: "good-token-good-token" }, MON_1000 + 61000)).emails.length], ["sent", new Date(MON_1000 + 60000).toISOString(), 0], "backup email: marked sent once, then no longer handed out");
    await alerts(bdb, { id_token: "good-token-good-token", sent: ["b:r1"] }, MON_1000 + 120000);
    eq(r1.email_sent_at, new Date(MON_1000 + 60000).toISOString(), "backup email: a second report doesn't change the sent time");
    // no backup_runs table yet (the SQL not run): exactly today's answer
    const plain = fakeDb({ chat_sessions: [{ id: "s9", alert_subject: "New chat", alert_body: "b", created_at: new Date(MON_1000).toISOString() }] });
    const want = await alerts(plain, { id_token: "good-token-good-token" }, MON_1000);
    const broken = fakeDb({ chat_sessions: [{ id: "s9", alert_subject: "New chat", alert_body: "b", created_at: new Date(MON_1000).toISOString() }] });
    const realFrom = broken.from;
    (broken as any).from = (t: string) => t === "backup_runs" ? { select: () => { throw new Error("relation \"public.backup_runs\" does not exist"); } } : realFrom(t);
    eq([await alerts(broken, { id_token: "good-token-good-token" }, MON_1000), want], [{ ok: true, emails: [{ id: "s9", to: "info@theguyservicegroup.com", subject: "New chat", text: "b" }] }, { ok: true, emails: [{ id: "s9", to: "info@theguyservicegroup.com", subject: "New chat", text: "b" }] }], "no backup_runs table: the answer is exactly as before");
    const errDb = fakeDb({ chat_sessions: [] });
    const errFrom = errDb.from;
    (errDb as any).from = (t: string) => { if (t !== "backup_runs") return errFrom(t); const b: any = { select: () => b, eq: () => b, gte: () => b, order: () => b, limit: () => b, update: () => b, then: (res: any) => Promise.resolve({ data: null, error: { message: "does not exist" } }).then(res) }; return b; };
    eq(await alerts(errDb, { id_token: "good-token-good-token", sent: ["b:r1"] }, MON_1000), { ok: true, emails: [] }, "a table error is ignored too (and a 'b:' report doesn't break)");
  }
  db.T.sms_opt_outs.length = 0;
  db.T.settings[0].whatsapp_enabled = false;
  eq((await reply(db, user, { contact_id: "c-new", channel: "whatsapp", text: "Hi" }, MON_1000)).reason, "whatsapp_not_set_up", "WhatsApp off in settings → refused");
  db.T.settings[0].whatsapp_enabled = true; waMode = "ok";
  eq([(await reply(db, user, { contact_id: "c-new", channel: "whatsapp", text: "Hi on WhatsApp" }, MON_1000)).ok, waSent[0] && waSent[0].to, db.T.lead_messages[db.T.lead_messages.length - 1].channel], [true, "+61412345678", "whatsapp"], "WhatsApp reply sent and logged");
  waMode = "off";

  // ── daily report ──
  db.T.settings[0].daily_report_to = [{ name: "Ofek", whatsapp: "+972509400581" }, { name: "Noam", whatsapp: "+972 50-773-1672" }];
  db.T.settings[0].whatsapp_enabled = false;
  db.T.myday_days = [];
  const dr: any = await dailyReport(db, user, { day: "2026-09-28", text: "Report text" }, MON_1000);
  const rep1 = db.T.lead_messages[db.T.lead_messages.length - 1];
  eq([dr.via, rep1.email, rep1.subject, db.T.myday_days[0].report_sent_at ? true : false], ["email", "info@theguyservicegroup.com", "Daily report 2026-09-28", true], "report by email while WhatsApp is off, marked sent");
  eq((await dailyReport(db, user, { day: "2026-09-28", text: "Again" }, MON_1000 + 1000)).already, true, "only once a day");
  db.T.settings[0].whatsapp_enabled = true; waMode = "ok"; waSent.length = 0;
  const dr2: any = await dailyReport(db, user, { day: "2026-09-29", text: "WA report" }, MON_1000);
  eq([dr2.via, waSent.map((w) => w.to)], ["whatsapp", ["+972509400581", "+972507731672"]], "report on WhatsApp to Ofek and Noam (Israeli numbers kept)");
  waMode = "off";

  // ── status to the owners (Ron's break) ──
  db.T.settings[0].whatsapp_enabled = false;
  eq((await ownerStatus(db, { text: "Ron went on his lunch break" })).via, "none", "status: nothing sent while WhatsApp is off");
  db.T.settings[0].whatsapp_enabled = true; waMode = "ok"; waSent.length = 0;
  const os: any = await ownerStatus(db, { text: "Ron went on his lunch break" });
  eq([os.via, os.sent, waSent.map((w) => w.to)], ["whatsapp", 2, ["+972509400581", "+972507731672"]], "status: WhatsApp to Ofek and Noam");
  waMode = "off";

  // ── tick: the automatic text ──
  const mk = (over: any) => ({ id: crypto.randomUUID(), contact_id: "c1", first_name: "Sarah", phone: "+61400000001", brand: "The Chimney Guys", service_text: "chimney cleaning", test: false, auto_sms_at: null, auto_sms_skip: null, created_at: new Date(MON_1000 - 6 * 60000).toISOString(), ...over });
  db = fakeDb({ chat_sessions: [mk({})] });
  sent.length = 0;
  let t: any = await tick(db, MON_1000);
  eq([t.sent, sent[0] && sent[0].body], [1, "Hi Sarah, Ron here from The Chimney Guys. I saw your message about chimney cleaning - I'm just finishing up another call and will get back to you very shortly. Feel free to reply here in the meantime."], "office open: the 'on another call' text");
  eq([db.T.chat_sessions[0].auto_sms_kind, db.T.lead_messages[0].auto, db.T.lead_messages[0].author], ["open", true, "Ron (automatic)"], "logged as automatic");
  eq((await tick(db, MON_1000 + 10000)).busy, true, "two runs within 40 seconds: the second does nothing");
  eq((await tick(db, MON_1000 + 60000)).sent, 0, "never twice for one chat");

  const SAT = Date.parse("2026-10-03T02:00:00Z");
  db = fakeDb({ chat_sessions: [mk({ created_at: new Date(SAT - 6 * 60000).toISOString() })] });
  sent.length = 0;
  await tick(db, SAT);
  eq(sent[0] && sent[0].body, "Hi Sarah, it's Ron from The Chimney Guys. You sent us a message on our website chat about chimney cleaning. I'll call you first thing when our office opens, or you can reply here.", "office closed: the approved after-hours text");

  db = fakeDb({ chat_sessions: [mk({ created_at: new Date(MON_1000 - 4 * 60000).toISOString() })] });
  eq((await tick(db, MON_1000)).sent, 0, "not before 5 minutes");
  const s5 = mk({});
  db = fakeDb({ chat_sessions: [s5], lead_messages: [{ contact_id: "c1", direction: "out", auto: false, channel: "chat", at: new Date(MON_1000 - 60000).toISOString() }] });
  await tick(db, MON_1000);
  eq(db.T.chat_sessions[0].auto_sms_skip, "answered", "Ron answered in the chat → no text");
  db = fakeDb({ chat_sessions: [mk({})], lead_messages: [{ contact_id: "c1", direction: "out", auto: false, channel: "sms", status: "failed", at: new Date(MON_1000 - 60000).toISOString() }] });
  eq((await tick(db, MON_1000)).sent, 1, "a text from Ron that failed doesn't count as an answer");
  db = fakeDb({ chat_sessions: [mk({})], calls: [{ direction: "outbound", to_number: "+61400000001", status: "completed", duration: 95, created_at: new Date(MON_1000 - 60000).toISOString() }] });
  await tick(db, MON_1000);
  eq(db.T.chat_sessions[0].auto_sms_skip, "called", "Ron called and they talked → no text");
  db = fakeDb({ chat_sessions: [mk({})], calls: [{ direction: "outbound", to_number: "+61400000001", status: "no-answer", duration: 0, created_at: new Date(MON_1000 - 60000).toISOString() }] });
  eq((await tick(db, MON_1000)).sent, 1, "a call nobody answered doesn't count");
  db = fakeDb({ chat_sessions: [mk({ phone: "+61299998888" })] });
  await tick(db, MON_1000);
  eq(db.T.chat_sessions[0].auto_sms_skip, "not_mobile", "landline → no text");
  db = fakeDb({ chat_sessions: [mk({})], lead_messages: [{ phone: "+61400000001", auto: true, channel: "sms", direction: "out", at: new Date(MON_1000 - 3 * 3600000).toISOString() }] });
  await tick(db, MON_1000);
  eq(db.T.chat_sessions[0].auto_sms_skip, "one_a_day", "one automatic text per phone per 24 hours");
  db = fakeDb({ chat_sessions: [mk({})], sms_opt_outs: [{ phone_key: "400000001" }] });
  await tick(db, MON_1000);
  eq(db.T.chat_sessions[0].auto_sms_skip, "opted_out", "STOP respected");
  db = fakeDb({ chat_sessions: [mk({ test: true })] });
  await tick(db, MON_1000);
  eq(db.T.chat_sessions[0].auto_sms_skip, "test", "a test chat only texts Ofek's approved number");
  db = fakeDb({ chat_sessions: [mk({ test: true, phone: "+61418638552" })] });
  eq((await tick(db, MON_1000)).sent, 1, "…and does text it");
  db = fakeDb({ chat_sessions: [mk({})] });
  db.T.settings[0].chat_auto_sms = false;
  eq((await tick(db, MON_1000)).off, true, "switched off in settings → nothing");
  smsMode = "off";
  db = fakeDb({ chat_sessions: [mk({})] });
  eq([(await tick(db, MON_1000)).waiting, db.T.chat_sessions[0].auto_sms_skip ?? null], [1, null], "SMS not set up yet → waits and tries again");
  smsMode = "ok";
  db = fakeDb({ chat_sessions: [mk({ created_at: new Date(MON_1000 - 3 * 3600000).toISOString() })] });
  eq((await tick(db, MON_1000)).sent, 0, "a chat older than 2 hours is left alone");

  // ── message templates (Settings → Message templates, Ofek 12 Oct) ──
  // Edited words are used for the automatic text; a blank one, or none, keeps the approved words (checked above too).
  db = fakeDb({ chat_sessions: [mk({})] });
  db.T.settings[0].catalog = { templates: { chatOpen: "{hi}! {brand} got your message about {service}. {hi} again from Ron.", chatClosed: "" } };
  sent.length = 0;
  await tick(db, MON_1000);
  eq(sent[0] && sent[0].body, "Hi Sarah! The Chimney Guys got your message about chimney cleaning. Hi Sarah again from Ron.", "office open: the edited text, every blank filled");
  db = fakeDb({ chat_sessions: [mk({ created_at: new Date(SAT - 6 * 60000).toISOString() })] });
  db.T.settings[0].catalog = { templates: { chatOpen: "edited", chatClosed: "  " } };
  sent.length = 0;
  await tick(db, SAT);
  eq(sent[0] && sent[0].body, "Hi Sarah, it's Ron from The Chimney Guys. You sent us a message on our website chat about chimney cleaning. I'll call you first thing when our office opens, or you can reply here.", "office closed, its template blank: the approved words");
  db = fakeDb({ chat_sessions: [mk({})] });
  sent.length = 0;
  await tick(db, MON_1000);
  eq(sent[0] && sent[0].body && sent[0].body.startsWith("Hi Sarah, Ron here from The Chimney Guys."), true, "the next run with no templates: back to the approved words (nothing left over)");
  useTemplates({});
  eq(introFor({ first_name: "sarah", brand: "The Chimney Guys", service_text: "chimney cleaning" }, "Ron"), "Hi Sarah, it's Ron from The Chimney Guys. You sent us a message on our website chat about chimney cleaning. I'll give you a call shortly, or you can reply here.", "intro: the approved words");

  // ── office hours, chat timings and brands from Settings (13 Oct); nothing saved = Mon–Fri 8–17, 5 min, 2 h, one a day ──
  useCatalog({});
  const MON_0730 = Date.parse("2026-10-11T20:30:00Z"), SAT_10 = Date.parse("2026-10-09T23:00:00Z"), MON_LABOUR = Date.parse("2026-10-04T23:00:00Z");   // Mon 12 Oct 7:30, Sat 10 Oct 10:00, Mon 5 Oct (Labour Day) 10:00
  eq([officeOpen(MON_1000), officeOpen(MON_0730), officeOpen(SAT_10), officeOpen(MON_LABOUR)], [true, false, false, true], "office hours: the original Mon-Fri 8-17, public holidays not off");
  eq(chatRules(), { waitMinutes: 5, windowHours: 2, oneADay: true }, "chat rules: the originals");
  useCatalog({ hours: { days: { 1: { on: true, from: "07:00", to: "17:00" }, 6: { on: true, from: "09:00", to: "13:00" } }, nsw: true, extra: [{ date: "2026-09-28", name: "Team day" }] }, holidays: { region: "AU-NSW", days: { "2026-10-05": "Labour Day" } }, chat: { waitMinutes: 10, windowHours: 4, oneADay: false }, brands: { Chimney: "Chimney Pros" } });
  eq([officeOpen(MON_0730), officeOpen(SAT_10), officeOpen(MON_LABOUR), officeOpen(MON_1000)], [true, true, false, false], "office hours from Settings: Monday from 7:00, Saturday morning open, Labour Day off (NSW on), own day off closed");
  eq([chatRules(), brandFor("Chimney", "The Chimney Guys"), brandFor("Aircon", "The AC Cleaning Guys")], [{ waitMinutes: 10, windowHours: 4, oneADay: false }, "Chimney Pros", "The AC Cleaning Guys"], "chat rules and a renamed brand from Settings");
  useCatalog({ chat: { waitMinutes: 120, windowHours: 2 } });
  eq(chatRules().windowHours, 3, "the window is always longer than the wait (a 2-hour wait with a 2-hour window would never send)");
  useCatalog({ hours: { days: { 0: { on: false }, 1: { on: false }, 2: { on: false }, 3: { on: false }, 4: { on: false }, 5: { on: false }, 6: { on: false } } } });
  eq(officeOpen(MON_1000), true, "no office day at all falls back to Mon-Fri 8-17");
  // the minute run follows the saved wait: 6 minutes is too early for a 10-minute wait
  db = fakeDb({ chat_sessions: [mk({})] });
  db.T.settings[0].catalog = { chat: { waitMinutes: 10 } };
  eq((await tick(db, MON_1000)).sent, 0, "a 10-minute wait: a 6-minute-old chat is left alone");
  useCatalog({});

  // ── a customer's text in ──
  db = fakeDb({ contacts: [{ id: "c9", full_name: "Sarah Jones", phone: "0412 345 678", created_at: "2026-09-01" }] });
  await smsIn(db, { From: "+61412345678", Body: "Yes Tuesday works", MessageSid: "SM1" }, MON_1000);
  eq([db.T.lead_messages[0].contact_id, db.T.lead_messages[0].direction, db.T.lead_messages[0].body], ["c9", "in", "Yes Tuesday works"], "reply lands on the customer's card");
  await smsIn(db, { From: "+61412345678", Body: "STOP" }, MON_1000);
  eq(db.T.sms_opt_outs.map((o: any) => o.phone_key), ["412345678"], "STOP → opted out");
  await smsIn(db, { From: "+61412345678", Body: "start" }, MON_1000);
  eq(db.T.sms_opt_outs.length, 0, "START → back in");
  await smsIn(db, { From: "+61455555555", Body: "Hi do you clean gutters?" }, MON_1000);
  eq(db.T.contacts.find((c: any) => c.id !== "c9").full_name, "Text from 0455 555 555", "unknown number → a new card");
  // the new card's day is the business's day (its time zone, read with the catalog): Mon 28 Sep 10:00 Sydney = Sun 27 Sep in Chicago
  db = fakeDb({ contacts: [] }); db.T.settings[0].catalog = { region: { timeZone: "America/Chicago" } };
  await smsIn(db, { From: "+61466666666", Body: "hello" }, MON_1000);
  // (a bare date is midnight UTC in the timestamptz column = the evening before in Chicago, so west of UTC it is noon that day)
  eq(db.T.contacts[0] && db.T.contacts[0].created_at, "2026-09-27T17:00:00.000Z", "a text from a new number: the card is on the business's day (noon Sun 27 Sep in Chicago)");
  eq([bizDayStamp("2026-10-14", "Australia/Sydney"), bizDayStamp("2026-10-14", "UTC"), bizDayStamp("2026-10-14", "America/Chicago"), bizParts(Date.parse(bizDayStamp("2026-10-14", "America/Los_Angeles")), "America/Los_Angeles").day],
    ["2026-10-14", "2026-10-14", "2026-10-14T17:00:00.000Z", "2026-10-14"], "bizDayStamp: the bare date where midnight UTC is that day (Sydney as before), else noon that day in the zone");
  db = fakeDb({ contacts: [] });
  await smsIn(db, { From: "+61466666666", Body: "hello" }, MON_1000);
  eq(db.T.contacts[0] && db.T.contacts[0].created_at, "2026-09-28", "…and Sydney's day when no time zone is saved");

  // ── the region (T1.2/T1.3): office hours in the business's time zone; public holidays from the stored list ──
  useCatalog({ region: { timeZone: "America/Chicago" } });
  eq([officeOpen(Date.parse("2026-09-28T13:00:00Z")), officeOpen(Date.parse("2026-09-28T12:59:00Z"))], [true, false], "office hours follow the business's time zone (Mon 08:00 / 07:59 in Chicago)");
  useCatalog({ hours: { nsw: true }, holidays: { region: "AU-NSW", days: { "2026-10-05": "Labour Day" } } });
  eq(officeOpen(MON_LABOUR), false, "the stored public holidays with the old NSW switch: Labour Day closed");
  useCatalog({ hours: { nsw: true } });
  eq(officeOpen(MON_LABOUR), true, "the old NSW switch with no stored list = no public holidays (the SQL stores the list first)");
  useCatalog({ hours: { publicOn: true, holidayOff: ["labour day"] }, holidays: { region: "AU-NSW", days: { "2026-10-05": "Labour Day" } } });
  eq(officeOpen(MON_LABOUR), true, "a public holiday switched off is an office day");
  useCatalog({});

  // ── the business's names (round 3, T1.7/T1.9): the office's name, Business details, the office person ──
  {
    eq(signatureOf("Ron Smith", { name: "Acme", phone: "" }), "\n\nRon\nAcme", "signature: the author's first word and the business name (no phone saved)");
    eq(signatureOf("", { name: "Acme", phone: "02 1", office: "Reception" }), "\n\nReception\nAcme\n02 1", "signature: no author = the office's name");
    eq(signatureOf("", {}), "\n\nOffice", "signature: nothing at all = Office");
    useCatalog({});
    const DAY = "2026-09-28";
    eq(agentName([{ full_name: "Zoe Lee", role: "va" }, { full_name: "kim day", role: "va", on_duty: true, on_duty_date: DAY }, { full_name: "Adam", role: "owner" }], DAY), "Kim", "agent: the VA on shift today first");
    eq(agentName([{ full_name: "Zoe Lee", role: "va" }, { full_name: "Kim Day", role: "va", on_duty: true, on_duty_date: "2026-09-27" }], DAY), "Kim", "agent: nobody on shift today = A–Z");
    eq(agentName([{ full_name: "Adam", role: "owner" }], DAY), "Office", "agent: no VA = Office");
    useCatalog({ labels: { office: " Reception " } });
    eq([agentName([], DAY), officeLabel()], ["Reception", "Reception"], "agent: no VA = the office's name");
    useCatalog({});
    // the automatic text is from the VA on shift; the log says who
    let ndb = fakeDb({ chat_sessions: [mk({})], profiles: [{ full_name: "Ron", role: "va" }, { full_name: "Kim Day", role: "va", on_duty: true, on_duty_date: "2026-09-28" }] });
    sent.length = 0;
    await tick(ndb, MON_1000);
    eq([sent[0] && sent[0].body.startsWith("Hi Sarah, Kim here from The Chimney Guys."), ndb.T.lead_messages[0].author], [true, "Kim (automatic)"], "tick: the text names the VA on shift");
    ndb = fakeDb({ chat_sessions: [mk({})], profiles: [] });
    ndb.T.settings[0].catalog = { ...ndb.T.settings[0].catalog, labels: { office: "Reception" } };
    sent.length = 0;
    await tick(ndb, MON_1000);
    eq([sent[0] && sent[0].body.startsWith("Hi Sarah, Reception here from The Chimney Guys."), ndb.T.lead_messages[0].author], [true, "Reception (automatic)"], "tick: no VA = the office's name");
    // 'something else' in the chat: the short name, else the business name
    ndb = fakeDb();
    const ro: any = await chatStart(ndb, { name: "Bob", phone: "0498765432", service: "other" }, "", MON_1000);
    eq(ndb.T.chat_sessions.find((s: any) => s.id === ro.session).brand, "The Guys Group", "chat about something else: the short name");
    ndb = fakeDb(); ndb.T.settings[0] = { id: 1, chat_auto_sms: true, company_name: "Acme Plumbing", catalog: {} };
    const ro2: any = await chatStart(ndb, { name: "Bob", phone: "0498765432", service: "split" }, "", MON_1000);
    eq(ndb.T.chat_sessions.find((s: any) => s.id === ro2.session).brand, "Acme Plumbing", "no short name and no brand saved: the business name");
    // the customer's window shows the replier's first name
    ndb.T.contacts.push({ id: "c-new", phone: "0498765432" });
    ndb.T.chat_sessions[0].contact_id = "c-new";
    await reply(ndb, { id: "u1", full_name: "kim day" }, { contact_id: "c-new", channel: "chat", text: "Hi Bob" }, MON_1000 + 1000);
    eq((await chatPoll(ndb, { session: ro2.session, token: ro2.token }, MON_1000 + 2000)).messages.map((m: any) => m.author), ["Kim"], "chat poll: the author is the replier's first name");
    // the email signature and subject from Business details
    ndb.T.contacts[0].email = "bob@example.com"; ndb.T.contacts[0].division = "Other";
    ndb.T.settings[0] = { id: 1, chat_auto_sms: true, company_name: "Acme", catalog: {} };
    const er: any = await reply(ndb, { id: "u1", full_name: "Ron" }, { contact_id: "c-new", channel: "email", text: "Quote attached." }, MON_1000);
    const qm = ndb.T.lead_messages[ndb.T.lead_messages.length - 1];
    eq([er.ok, qm.subject], [true, "Your enquiry - Acme"], "email subject: no brand for the service = the business name");
    qm.subject = "";
    const ae2: any = await alerts(ndb, { id_token: "good-token-good-token" }, MON_1000 + 1000);
    const m2 = ae2.emails.find((x: any) => x.id === "m:" + qm.id);
    eq([m2 && m2.text, m2 && m2.subject], ["Quote attached.\n\nRon\nAcme", "Acme"], "alerts: signed with the business name (no phone saved); an empty subject = the business name");
    // the daily report with no name on the login: the office's name
    ndb.T.myday_days = []; ndb.T.settings[0].catalog = { labels: { office: "Dispatch" } };
    await dailyReport(ndb, { id: "u2", full_name: "" }, { day: "2026-09-28", text: "Report" }, MON_1000);
    eq(ndb.T.lead_messages[ndb.T.lead_messages.length - 1].author, "Dispatch", "daily report: no name = the office's name");
    useSettings(SETTINGS_ROW());
    // no person's or business's name left in the code (comments aside)
    const fs: any = await import("node:fs");
    const code = String(fs.readFileSync("index.ts", "utf8")).split("\n").filter((l: string) => !/^\s*\/\//.test(l)).join("\n");
    eq(["Ron", "The Guys", "1300 380"].filter((w) => new RegExp("\\b" + w + "\\b").test(code)), [], "no 'Ron', 'The Guys' or '1300 380' in the code");
  }

  // ── Twilio signature ──
  const url = "https://x.supabase.co/functions/v1/conversations?step=sms_in";
  const params = { Body: "hi", From: "+61412345678" };
  const sig = await hmacSha1Base64("tok", url + "Bodyhi" + "From+61412345678");
  eq([await twilioSignatureOk(url, params, sig, "tok"), await twilioSignatureOk(url, params, sig, "other")], [true, false], "Twilio signature checked");

  console.log(`conversations: ${pass} passed, ${fail} failed`);
  if (fail) (globalThis as any).process?.exit?.(1);
})();
