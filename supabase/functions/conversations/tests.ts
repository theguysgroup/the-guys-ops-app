// Tests for conversations/index.ts. Run: bash supabase/functions/conversations/run_tests.sh
// (the runner swaps the esm.sh import for a stub, appends this file and runs it with npx tsx).
// deno-lint-ignore-file no-explicit-any

// ── a small in-memory stand-in for the Supabase client ──
function fakeDb(seed: Record<string, any[]> = {}) {
  const T: Record<string, any[]> = { contacts: [], chat_sessions: [], lead_messages: [], sms_opt_outs: [], calls: [], settings: [{ id: 1, chat_auto_sms: true, chat_tick_at: null }], ...seed };
  function q(table: string) {
    const rows = () => (T[table] = T[table] || []);
    const filters: ((r: any) => boolean)[] = [];
    let op = "select", payload: any = null, opts: any = {}, single = false, lim = Infinity, order: [string, boolean] | null = null, range: [number, number] | null = null, wantRows = true;
    const b: any = {
      select(_c?: string, o?: any) { if (op === "select") opts = o || {}; else wantRows = true; return b; },
      insert(p: any) { op = "insert"; payload = p; wantRows = false; return b; },
      update(p: any) { op = "update"; payload = p; return b; },
      upsert(p: any) { op = "upsert"; payload = p; return b; },
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
      if (op === "upsert") { const i = rows().findIndex((r) => r.phone_key === payload.phone_key); if (i >= 0) rows()[i] = { ...rows()[i], ...payload }; else rows().push({ ...payload }); return { data: null, error: null }; }
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
let smsMode: "ok" | "off" | "fail" = "ok";
const intakes: any[] = [], alerts: any[] = [];
io.sendSms = async (to: string, body: string) => { if (smsMode === "off") return { ok: false, error: "sms_not_set_up" }; if (smsMode === "fail") return { ok: false, error: "21610" }; sent.push({ to, body }); return { ok: true, sid: "SM" + sent.length }; };
io.intake = async (f: any) => { intakes.push(f); return { id: "c-new", attached: "" }; };
io.alertOffice = async (p: any) => { alerts.push(p); return true; };

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
  eq([alerts.length, alerts[0].subject, /Source: Google Ads \(click id\)/.test(alerts[0].body), !!s1.alert_sent_at], [1, "New website chat lead - Sarah Jones 0412 345 678", true, true], "office alerted at once");
  const r2: any = await chatStart(db, { name: "Bob", phone: "0498765432", service: "nonsense" }, "", MON_1000);
  const s2 = db.T.chat_sessions.find((s: any) => s.id === r2.session);
  eq([s2.service_key, s2.brand, s2.service_text, db.T.lead_messages.find((m: any) => m.session_id === s2.id).body, intakes[1].division], ["other", "The Guys Group", "your enquiry", "Hi, I'd like a quote.", "Other"], "something else");
  for (let i = 0; i < 5; i++) await chatStart(db, { name: "Sam", phone: "0411111111", service: "pw" }, "", MON_1000);
  eq((await chatStart(db, { name: "Sam", phone: "0411111111", service: "pw" }, "", MON_1000)).reason, "limit", "a 6th chat in a day from one phone is refused");
  const keepIntake = io.intake;
  io.intake = async () => { throw new Error("network"); };
  const rDown: any = await chatStart(db, { name: "Kim", phone: "0422222222", service: "pw" }, "", MON_1000);
  io.intake = keepIntake;
  eq([rDown.ok, db.T.chat_sessions.find((s: any) => s.id === rDown.session).contact_id, /could not be created/.test(alerts[alerts.length - 1].body)], [true, null, true], "intake-lead down: the chat still starts and the alert says so");
  const before = intakes.length;
  const rt: any = await chatStart(db, { name: "Ofek", phone: "0418638552", service: "chimney", test: true }, "", MON_1000);
  const tc = db.T.contacts.find((c: any) => c.id === db.T.chat_sessions.find((s: any) => s.id === rt.session).contact_id);
  eq([intakes.length === before, tc.full_name, tc.tags, alerts[alerts.length - 1].subject.startsWith("[TEST]")], [true, "TEST - Ofek", ["Test"], true], "test chat: own TEST card, no intake-lead");

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

  // ── Twilio signature ──
  const url = "https://x.supabase.co/functions/v1/conversations?step=sms_in";
  const params = { Body: "hi", From: "+61412345678" };
  const sig = await hmacSha1Base64("tok", url + "Bodyhi" + "From+61412345678");
  eq([await twilioSignatureOk(url, params, sig, "tok"), await twilioSignatureOk(url, params, sig, "other")], [true, false], "Twilio signature checked");

  console.log(`conversations: ${pass} passed, ${fail} failed`);
  if (fail) (globalThis as any).process?.exit?.(1);
})();
