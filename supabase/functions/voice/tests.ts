
// ── tests ──
let pass = 0, fail = 0;
function eq(a: unknown, b: unknown, name: string) { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? pass++ : fail++; if (!ok) console.log("FAIL", name, "\n  got ", JSON.stringify(a), "\n  want", JSON.stringify(b)); }
function has(s: string, part: string, name: string) { const ok = s.includes(part); ok ? pass++ : fail++; if (!ok) console.log("FAIL", name, "\n  missing", part, "\n  in", s); }
function hasNot(s: string, part: string, name: string) { const ok = !s.includes(part); ok ? pass++ : fail++; if (!ok) console.log("FAIL", name, "\n  should not contain", part, "\n  in", s); }

const ROUTING = {
  people: { ofek: { name: "Ofek", mobile: "+61418638552", available: true }, noam: { name: "Noam", mobile: "0407 735 994", available: true } },
  divisions: { Aircon: ["noam"], Chimney: ["noam"], "Pressure Washing": ["ofek"], Other: ["ofek", "noam"] },
  backupHours: { from: "08:00", to: "20:00", days: [0, 1, 2, 3, 4, 5, 6] },
  officeRingSeconds: 20, backupRingSeconds: 20, callerId: "1300 380 090",
};
// A tiny in-memory stand-in for the Supabase client.
function fakeDb(opts: { ronOn?: boolean; ronDate?: string; ronBreak?: boolean; routing?: any } = {}) {
  const T: Record<string, any[]> = {
    contacts: [{ id: "c-known", full_name: "Kevin Love", phone: "+61466103709", division: "Chimney", created_at: "2026-09-23", messages: [], contacted_at: null }],
    calls: [],
    profiles: [{ id: "ron1", role: "va", permissions: { crm: true }, on_duty: opts.ronOn !== false, on_duty_date: opts.ronDate || "2026-10-02", on_break: !!opts.ronBreak }, { id: "tech1", role: "technician", permissions: { crm: false }, on_duty: true, on_duty_date: "2026-10-02" }, { id: "own1", role: "owner", permissions: {} }],
    settings: [{ phone_routing: opts.routing || JSON.parse(JSON.stringify(ROUTING)) }],
  };
  const from = (t: string) => {
    const st: any = { f: [] as any[], upd: null as any, range: null as any };
    const rows = () => { let r = T[t] || []; for (const f of st.f) r = r.filter(f); if (st.range) r = r.slice(st.range[0], st.range[1] + 1); return r; };
    const api: any = {
      select: () => api, order: () => api, limit: () => api,
      range: (a: number, b: number) => { st.range = [a, b]; return api; },
      eq: (k: string, v: any) => { st.f.push((r: any) => r[k] === v); return api; },
      is: (k: string, v: any) => { st.f.push((r: any) => (r[k] ?? null) === v); return api; },
      single: () => Promise.resolve({ data: rows()[0] || null, error: null }),
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
const FRI_10 = Date.parse("2026-10-02T00:00:00Z");    // Friday 10:00 Sydney (AEST)
const FRI_21 = Date.parse("2026-10-02T11:00:00Z");    // Friday 21:00 Sydney
const SAT_0730 = Date.parse("2026-10-02T21:30:00Z");  // Saturday 07:30 Sydney
const IN = { From: "+61412345678", To: "+61400000001" };

(async () => {
  // Numbers
  eq([toE164("0412 345 678"), toE164("61412345678"), toE164("02 9876 5432"), toE164("1300 380 090"), toE164("abc")], ["+61412345678", "+61412345678", "+61298765432", "+611300380090", ""], "numbers to E.164");
  eq([pretty("+61412345678"), pretty("+61298765432"), pretty("+611300380090")], ["0412 345 678", "02 9876 5432", "1300 380 090"], "pretty numbers");

  // 1. Known customer, Ron on shift, 10:00: notice, no menu, ring Ron (never a technician), then after_office for Chimney.
  let db = fakeDb();
  let x = await body(await step(db, "incoming", { CallSid: "CA1", From: "0466 103 709", To: IN.To }, {}, FRI_10));
  has(x, "This call may be recorded", "notice first");
  hasNot(x, "<Gather", "known customer: no menu");
  has(x, "<Client><Identity>office-ron1</Identity>", "rings Ron");
  hasNot(x, "office-tech1", "never a technician");
  has(x, 'name="callerName" value="Kevin Love"', "Ron sees who is calling");
  has(x, "step=after_office&amp;div=Chimney", "then the Chimney backup");

  // 2. New caller, 10:00: a new lead and the menu.
  x = await body(await step(db, "incoming", { CallSid: "CA2", ...IN }, {}, FRI_10));
  has(x, "<Gather", "new caller hears the menu");
  has(x, "press 3", "menu has 3 options");
  eq([db.T.contacts.length, db.T.contacts[1].full_name], [2, "Caller 0412 345 678"], "new caller becomes a lead");

  // 3. Presses 3 → Pressure Washing on the call and the card, rings Ron with the service.
  x = await body(await step(db, "menu", { CallSid: "CA2", Digits: "3", ...IN }, {}, FRI_10));
  eq([db.T.calls.find((c: any) => c.call_sid === "CA2").division, db.T.contacts[1].division], ["Pressure Washing", "Pressure Washing"], "service saved");
  has(x, "office-ron1", "rings Ron after the menu");
  has(x, "div=Pressure%20Washing", "carries the service");

  // 4–5. Ron didn't answer: pressure washing → Ofek only; aircon/chimney → Noam only; mobiles see the caller.
  x = await body(await step(db, "after_office", { CallSid: "CA2", DialCallStatus: "no-answer", ...IN }, { div: "Pressure Washing" }, FRI_10));
  has(x, "<Number>+61418638552</Number></Dial>", "pressure washing → Ofek");
  hasNot(x, "+61407735994", "…not Noam");
  has(x, 'callerId="+61412345678"', "mobile shows the customer");
  x = await body(await step(db, "after_office", { CallSid: "CA1", DialCallStatus: "no-answer", From: "+61466103709", To: IN.To }, { div: "Chimney" }, FRI_10));
  has(x, "<Number>+61407735994</Number></Dial>", "chimney → Noam");
  hasNot(x, "+61418638552", "…not Ofek");
  x = await body(await step(db, "after_office", { CallSid: "CA9", DialCallStatus: "no-answer", ...IN }, { div: "Other" }, FRI_10));
  has(x, "<Number>+61418638552</Number><Number>+61407735994</Number>", "unknown service → both");

  // 6. Noam away → his services go to Ofek. 7. Both away → voicemail.
  const away = JSON.parse(JSON.stringify(ROUTING)); away.people.noam.available = false;
  db = fakeDb({ routing: away });
  x = await body(await step(db, "after_office", { CallSid: "CA3", DialCallStatus: "no-answer", ...IN }, { div: "Aircon" }, FRI_10));
  has(x, "<Number>+61418638552</Number></Dial>", "Noam away → aircon goes to Ofek");
  const bothAway = JSON.parse(JSON.stringify(ROUTING)); bothAway.people.noam.available = false; bothAway.people.ofek.available = false;
  db = fakeDb({ routing: bothAway }); sms.length = 0;
  await step(db, "incoming", { CallSid: "CA4", ...IN }, {}, FRI_10);
  x = await body(await step(db, "after_office", { CallSid: "CA4", DialCallStatus: "no-answer", ...IN }, { div: "Aircon" }, FRI_10));
  has(x, "couldn't get to the phone", "both away → voicemail");
  has(x, "<Record ", "takes a message");

  // 8. Ron off shift, 10:00, known chimney customer → straight to Noam (no browser ring). 9. Yesterday's shift doesn't count.
  db = fakeDb({ ronOn: false });
  x = await body(await step(db, "incoming", { CallSid: "CA5", From: "0466103709", To: IN.To }, {}, FRI_10));
  hasNot(x, "<Client>", "Ron off shift: no browser ring");
  has(x, "<Number>+61407735994</Number>", "straight to Noam");
  db = fakeDb({ ronDate: "2026-10-01" });
  x = await body(await step(db, "incoming", { CallSid: "CA6", From: "0466103709", To: IN.To }, {}, FRI_10));
  hasNot(x, "<Client>", "a shift from yesterday doesn't ring Ron today");
  // A break is only recorded (Ofek 3/10): Ron's browser still rings.
  db = fakeDb({ ronBreak: true });
  x = await body(await step(db, "incoming", { CallSid: "CA6b", From: "0466103709", To: IN.To }, {}, FRI_10));
  has(x, "<Client>", "Ron on a break: his browser still rings");

  // 10. 21:00, Ron off shift → office-closed voicemail and text, no notice or menu.
  db = fakeDb({ ronOn: false }); sms.length = 0;
  x = await body(await step(db, "incoming", { CallSid: "CA7", ...IN }, {}, FRI_21));
  has(x, "Our office is closed", "after hours: closed message");
  hasNot(x, "<Gather", "no menu after hours");
  has(x, "<Record ", "after hours: voicemail");
  eq([sms.length, /closed right now/.test(sms[0] && sms[0].Body)], [1, true], "after-hours text");
  const c7 = db.T.calls.find((c: any) => c.call_sid === "CA7");
  eq([c7.status, c7.missed], ["missed", true], "after-hours call flagged for a call-back");
  // 07:30 Saturday is also closed (owners from 08:00).
  db = fakeDb({ ronOn: false });
  x = await body(await step(db, "incoming", { CallSid: "CA8", ...IN }, {}, SAT_0730));
  has(x, "Our office is closed", "07:30 is closed");

  // 11. 21:00 but Ron still on shift (today): rings Ron; not answered → closed voicemail (owners' hours are over).
  db = fakeDb();
  x = await body(await step(db, "incoming", { CallSid: "CA10", From: "0466103709", To: IN.To }, {}, FRI_21));
  has(x, "office-ron1", "Ron on shift late: rings Ron");
  x = await body(await step(db, "after_office", { CallSid: "CA10", DialCallStatus: "no-answer", From: "+61466103709", To: IN.To }, { div: "Chimney" }, FRI_21));
  has(x, "Our office is closed", "then the closed voicemail");

  // 12. Owners didn't answer → voicemail, text, missed + unread message on the card.
  db = fakeDb(); sms.length = 0;
  await step(db, "incoming", { CallSid: "CA11", ...IN }, {}, FRI_10);
  x = await body(await step(db, "after_owners", { CallSid: "CA11", DialCallStatus: "no-answer", ...IN }, { div: "Aircon" }, FRI_10));
  has(x, "couldn't get to the phone", "owners missed → voicemail");
  eq([sms.length, sms[0].To, sms[0].From], [1, "+61412345678", "+61400000001"], "text from the Twilio number");
  const lead = db.T.contacts[1];
  eq([lead.messages.slice(-1)[0].kind, lead.messages.slice(-1)[0].direction, /Missed call/.test(lead.messages.slice(-1)[0].text)], ["message", "in", true], "unread missed call on the card");

  // 13. The voicemail recording → saved, and an unread note on the card. A 1-second hang-up is not a voicemail.
  await step(db, "voicemail", { CallSid: "CA11", RecordingSid: "RE9", RecordingStatus: "completed", RecordingDuration: "34" }, {}, FRI_10);
  const c11 = db.T.calls.find((c: any) => c.call_sid === "CA11");
  eq([c11.recording_sid, c11.voicemail, /Voicemail left \(34s\)/.test(lead.messages.slice(-1)[0].text)], ["RE9", true, true], "voicemail saved");
  x = await body(await step(db, "voicemail_done", { CallSid: "CA11" }, {}, FRI_10));
  has(x, "Goodbye", "voicemail ends politely");

  // 14. Answered by the owner.
  db = fakeDb();
  await step(db, "incoming", { CallSid: "CA12", From: "0466103709", To: IN.To }, {}, FRI_10);
  x = await body(await step(db, "after_owners", { CallSid: "CA12", DialCallStatus: "completed", From: "+61466103709" }, { div: "Chimney" }, FRI_10));
  has(x, "<Hangup/>", "owner answered");
  eq(db.T.calls.find((c: any) => c.call_sid === "CA12").answered_by, "owner", "answered by the owner");
  await step(db, "status", { CallSid: "CA12", CallStatus: "completed", CallDuration: "195" }, {}, FRI_10);
  eq([db.T.contacts[0].messages.slice(-1)[0].text, !!db.T.contacts[0].contacted_at], ["📞 Incoming call · 3m 15s", true], "note on the card; contacted");

  // 15. Outgoing from Ron: customers see 1300 380 090. Only our browser phones; only real numbers.
  x = await body(await step(db, "outbound", { CallSid: "CA13", From: "client:office-ron1", To: "0466 103 709" }, {}, FRI_10));
  has(x, '<Dial callerId="+611300380090"', "outgoing shows the 1300 number");
  has(x, "<Number>+61466103709</Number>", "dials the customer");
  x = await body(await step(db, "outbound", { CallSid: "CA14", From: "+61400000000", To: "0466103709" }, {}, FRI_10));
  has(x, "<Reject/>", "only our browser phones can call out");

  // 16. Calling a missed caller back clears the missed call once it connects.
  db.T.calls.push({ id: "m1", call_sid: "CAm", direction: "inbound", from_number: "+61466103709", status: "missed", missed: true, callback_done_at: null });
  await step(db, "status", { CallSid: "CA13", CallStatus: "completed", CallDuration: "40" }, {}, FRI_10);
  eq([db.T.calls.find((c: any) => c.call_sid === "CA13").status, !!db.T.calls.find((c: any) => c.id === "m1").callback_done_at], ["answered", true], "called back → cleared");

  // 17. Landline callers get no text.
  db = fakeDb({ ronOn: false }); sms.length = 0;
  await step(db, "incoming", { CallSid: "CA15", From: "+61298765432", To: IN.To }, {}, FRI_21);
  eq(sms.length, 0, "landline: no text");

  // 18. Signature and token.
  eq(await twilioSignatureOk("https://example.supabase.co/functions/v1/voice?step=incoming", { CallSid: "CA1", From: "+61412345678", To: "+61290001111" }, SIG_EXPECTED), true, "valid signature accepted");
  eq(await twilioSignatureOk("https://example.supabase.co/functions/v1/voice?step=incoming", { CallSid: "CA1", From: "+61412345678", To: "+61290001112" }, SIG_EXPECTED), false, "tampered request refused");
  eq(await twilioSignatureOk("https://example.supabase.co/functions/v1/voice?step=incoming", { CallSid: "CA1" }, ""), false, "unsigned request refused");
  const tok = await voiceToken("office-ron1", 1790000000);
  const [h, pl] = tok.split(".").slice(0, 2).map((s) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));
  eq([h.alg, h.cty, pl.iss, pl.sub, pl.exp - pl.iat, pl.grants.identity, pl.grants.voice.incoming.allow, pl.grants.voice.outgoing.application_sid], ["HS256", "twilio-fpa;v=1", "SKtest", "ACtest", 3600, "office-ron1", true, "APtest"], "token payload");
  console.log(`${pass} passed, ${fail} failed`);
  console.log("TOKEN " + tok);
})();
