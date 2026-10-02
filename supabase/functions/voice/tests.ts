
// ── tests (run: node build_voice_test.mjs && npx tsx voice_test.ts) ──
let pass = 0, fail = 0;
function eq(a: unknown, b: unknown, name: string) { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? pass++ : fail++; if (!ok) console.log("FAIL", name, "\n  got ", JSON.stringify(a), "\n  want", JSON.stringify(b)); }
function has(s: string, part: string, name: string) { const ok = s.includes(part); ok ? pass++ : fail++; if (!ok) console.log("FAIL", name, "\n  missing", part, "\n  in", s); }
function hasNot(s: string, part: string, name: string) { const ok = !s.includes(part); ok ? pass++ : fail++; if (!ok) console.log("FAIL", name, "\n  should not contain", part); }

// A tiny in-memory stand-in for the Supabase client: contacts, calls, profiles.
function fakeDb() {
  const T: Record<string, any[]> = {
    contacts: [{ id: "c-known", full_name: "Kevin Love", phone: "+61466103709", created_at: "2026-09-23", messages: [], contacted_at: null }],
    calls: [],
    profiles: [{ id: "ron1", role: "va", permissions: { crm: true } }, { id: "tech1", role: "technician", permissions: { crm: false } }, { id: "own1", role: "owner", permissions: {} }],
  };
  const from = (t: string) => {
    const st: any = { f: [] as any[], upd: null as any, single: false, range: null as any };
    const rows = () => { let r = T[t] || []; for (const f of st.f) r = r.filter(f); if (st.range) r = r.slice(st.range[0], st.range[1] + 1); return r; };
    const api: any = {
      select: () => api, order: () => api,
      range: (a: number, b: number) => { st.range = [a, b]; return api; },
      eq: (k: string, v: any) => { st.f.push((r: any) => r[k] === v); return api; },
      is: (k: string, v: any) => { st.f.push((r: any) => (r[k] ?? null) === v); return api; },
      single: () => { const r = rows(); return Promise.resolve({ data: r[0] || null, error: null }); },
      insert: (o: any) => { const row = { id: o.id || `${t}-${(T[t] = T[t] || []).length + 1}`, ...o }; T[t].push(row); return { select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }), then: (ok: any) => ok({ error: null }) }; },
      update: (o: any) => { st.upd = o; return api; },
      then: (ok: any, bad: any) => { if (st.upd) { rows().forEach((r: any) => Object.assign(r, st.upd)); return Promise.resolve({ error: null }).then(ok, bad); } return Promise.resolve({ data: rows(), error: null }).then(ok, bad); },
    };
    return api;
  };
  return { T, from };
}
const sms: any[] = [];
(globalThis as any).fetch = async (url: string, opts: any) => {
  if (String(url).includes("/Messages.json")) { sms.push(Object.fromEntries(new URLSearchParams(opts.body))); return { ok: true, status: 201 }; }
  return { ok: false, status: 404 };
};
const body = async (r: Response) => await r.text();

(async () => {
  // Phone numbers
  eq([toE164("0412 345 678"), toE164("+61 412 345 678"), toE164("61412345678"), toE164("412345678"), toE164("02 9876 5432"), toE164("abc"), toE164("+15551234567")],
     ["+61412345678", "+61412345678", "+61412345678", "+61412345678", "+61298765432", "", "+15551234567"], "AU numbers to E.164");
  eq([pretty("+61412345678"), pretty("+61298765432")], ["0412 345 678", "02 9876 5432"], "pretty numbers");

  // Incoming from an unknown number: new lead, notice, ring Ron's browser phone only (not technicians/owners), record, then after_office.
  let db = fakeDb();
  let x = await body(await step(db, "incoming", { CallSid: "CA1", From: "+61412345678", To: "+61290001111" }));
  has(x, "This call may be recorded", "notice is played first");
  has(x, "<Client><Identity>office-ron1</Identity>", "rings Ron's browser phone");
  hasNot(x, "office-tech1", "never rings a technician");
  has(x, 'timeout="20"', "rings 20 seconds");
  has(x, 'record="record-from-answer-dual"', "records the call");
  has(x, "step=after_office", "then goes to the next step");
  eq([db.T.contacts.length, db.T.contacts[1].full_name, db.T.contacts[1].status, db.T.calls[0].contact_id === db.T.contacts[1].id], [2, "Caller 0412 345 678", "New", true], "unknown caller becomes a new lead, linked to the call");

  // Incoming from a known customer: no new card, the browser phone gets the name.
  x = await body(await step(db, "incoming", { CallSid: "CA2", From: "0466 103 709", To: "+61290001111" }));
  eq(db.T.contacts.length, 2, "known caller: no new card");
  has(x, 'name="callerName" value="Kevin Love"', "browser phone shows who is calling");

  // Nobody answered in the browser → both owner mobiles ring together, showing the customer's number.
  x = await body(await step(db, "after_office", { CallSid: "CA1", DialCallStatus: "no-answer", From: "+61412345678", To: "+61290001111" }));
  has(x, "<Number>+61418638552</Number><Number>+61400111222</Number>", "rings Ofek and Noam together");
  has(x, 'callerId="+61412345678"', "mobiles see the customer's number");
  has(x, "step=after_owners", "then the last step");

  // Still nobody → apology, SMS to the caller, missed + unread message on the card.
  x = await body(await step(db, "after_owners", { CallSid: "CA1", DialCallStatus: "no-answer", From: "+61412345678", To: "+61290001111" }));
  has(x, "Sorry we missed your call", "caller hears the apology");
  eq([sms.length, sms[0].To, sms[0].From], [1, "+61412345678", "+61290001111"], "missed-call text from the business number");
  const c1 = db.T.calls.find((c: any) => c.call_sid === "CA1");
  eq([c1.status, c1.missed, c1.sms_sent], ["missed", true, true], "call marked missed");
  const lead = db.T.contacts[1];
  eq([lead.messages.length, lead.messages[1].kind, lead.messages[1].direction, /Missed call/.test(lead.messages[1].text)], [2, "message", "in", true], "unread 'missed call' on the card");

  // Answered in the browser → hang-up TwiML, answered by office; status adds a note and marks the lead contacted.
  x = await body(await step(db, "after_office", { CallSid: "CA2", DialCallStatus: "completed", From: "+61466103709" }));
  has(x, "<Hangup/>", "answered: nothing more");
  await step(db, "status", { CallSid: "CA2", CallStatus: "completed", CallDuration: "195" });
  const c2 = db.T.calls.find((c: any) => c.call_sid === "CA2");
  eq([c2.status, c2.answered_by, c2.duration], ["answered", "office", 195], "answered call saved with duration");
  const kev = db.T.contacts[0];
  eq([kev.messages.slice(-1)[0].text, !!kev.contacted_at], ["📞 Incoming call · 3m 15s", true], "note on the card; lead counts as contacted");

  // A missed call's final status keeps it missed (no second note).
  await step(db, "status", { CallSid: "CA1", CallStatus: "completed", CallDuration: "30" });
  eq([db.T.calls.find((c: any) => c.call_sid === "CA1").status, lead.messages.length], ["missed", 2], "missed stays missed");

  // Non-mobile callers get no SMS.
  db = fakeDb(); sms.length = 0;
  await step(db, "incoming", { CallSid: "CA3", From: "+61298765432", To: "+61290001111" });
  await step(db, "after_owners", { CallSid: "CA3", DialCallStatus: "no-answer", From: "+61298765432", To: "+61290001111" });
  eq(sms.length, 0, "landline caller: no SMS");

  // Outgoing from Ron's browser phone.
  x = await body(await step(db, "outbound", { CallSid: "CA4", From: "client:office-ron1", To: "0466 103 709" }));
  has(x, '<Dial callerId="+61290001111"', "shows the business number");
  has(x, "<Number>+61466103709</Number>", "dials the customer");
  eq(db.T.calls.find((c: any) => c.call_sid === "CA4").contact_id, "c-known", "outgoing call linked to the card");
  x = await body(await step(db, "outbound", { CallSid: "CA5", From: "+61400000000", To: "0466103709" }));
  has(x, "<Reject/>", "only our browser phones can call out");
  x = await body(await step(db, "outbound", { CallSid: "CA6", From: "client:office-ron1", To: "12" }));
  has(x, "not valid", "bad number");

  // Calling a missed caller back clears the missed call once the call connects.
  db.T.calls.push({ id: "m1", call_sid: "CAm", direction: "inbound", from_number: "+61466103709", status: "missed", missed: true, callback_done_at: null });
  await step(db, "status", { CallSid: "CA4", CallStatus: "completed", CallDuration: "40" });
  eq([db.T.calls.find((c: any) => c.call_sid === "CA4").status, !!db.T.calls.find((c: any) => c.id === "m1").callback_done_at], ["answered", true], "called back → missed call cleared");

  // Recording saved on the parent call.
  await step(db, "recording", { CallSid: "CA4", RecordingSid: "RE1", RecordingStatus: "completed", RecordingDuration: "61" });
  eq([db.T.calls.find((c: any) => c.call_sid === "CA4").recording_sid, db.T.calls.find((c: any) => c.call_sid === "CA4").recording_duration], ["RE1", 61], "recording saved");

  // Twilio signature: matches Python's hmac (checked against a value computed outside this code).
  eq(await twilioSignatureOk("https://example.supabase.co/functions/v1/voice?step=incoming", { CallSid: "CA1", From: "+61412345678", To: "+61290001111" }, SIG_EXPECTED), true, "valid signature accepted");
  eq(await twilioSignatureOk("https://example.supabase.co/functions/v1/voice?step=incoming", { CallSid: "CA1", From: "+61412345678", To: "+61290001112" }, SIG_EXPECTED), false, "tampered request refused");
  eq(await twilioSignatureOk("https://example.supabase.co/functions/v1/voice?step=incoming", { CallSid: "CA1" }, ""), false, "unsigned request refused");

  // Browser-phone token: a valid HS256 JWT with the voice grant.
  const tok = await voiceToken("office-ron1", 1790000000);
  const [h, pl] = tok.split(".").slice(0, 2).map((s) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));
  eq([h.alg, h.cty, pl.iss, pl.sub, pl.exp - pl.iat, pl.grants.identity, pl.grants.voice.incoming.allow, pl.grants.voice.outgoing.application_sid], ["HS256", "twilio-fpa;v=1", "SKtest", "ACtest", 3600, "office-ron1", true, "APtest"], "token payload");
  (globalThis as any).__TOKEN__ = tok;
  console.log(`${pass} passed, ${fail} failed`);
  console.log("TOKEN " + tok);
})();
