
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
// opts.vac (stage 3): the employees and their vacations; throws = reading the vacations fails.
function fakeDb(opts: { ronOn?: boolean; ronDate?: string; ronBreak?: boolean; routing?: any; vac?: { employees?: any[]; vacations?: any[]; throws?: boolean } } = {}) {
  const T: Record<string, any[]> = {
    contacts: [{ id: "c-known", full_name: "Kevin Love", phone: "+61466103709", division: "Chimney", created_at: "2026-09-23", messages: [], contacted_at: null }],
    calls: [],
    profiles: [{ id: "ron1", role: "va", full_name: "Ron", permissions: { crm: true }, on_duty: opts.ronOn !== false, on_duty_date: opts.ronDate || "2026-10-02", on_break: !!opts.ronBreak }, { id: "tech1", role: "technician", permissions: { crm: false }, on_duty: true, on_duty_date: "2026-10-02" }, { id: "own1", role: "owner", permissions: {} }],
    settings: [{ phone_routing: opts.routing || JSON.parse(JSON.stringify(ROUTING)), company_name: "The Guys Service Group" }],
    ...(opts.vac ? { employees: opts.vac.employees || [], employee_vacations: opts.vac.vacations || [] } : {}),
  };
  const from = (t: string) => {
    if (t === "employee_vacations" && opts.vac && opts.vac.throws) throw new Error("vacations unreadable");
    const st: any = { f: [] as any[], upd: null as any, range: null as any };
    const rows = () => { let r = T[t] || []; for (const f of st.f) r = r.filter(f); if (st.range) r = r.slice(st.range[0], st.range[1] + 1); return r; };
    const api: any = {
      select: () => api, order: () => api, limit: () => api,
      range: (a: number, b: number) => { st.range = [a, b]; return api; },
      eq: (k: string, v: any) => { st.f.push((r: any) => r[k] === v); return api; },
      is: (k: string, v: any) => { st.f.push((r: any) => (r[k] ?? null) === v); return api; },
      lte: (k: string, v: any) => { st.f.push((r: any) => r[k] != null && r[k] <= v); return api; },
      // or("ends_on.gte.x,options->>autoBack.eq.false"): a column or a jsonb key as text
      or: (expr: string) => {
        const ps = expr.split(",").map((p) => {
          const m = /^(\w+)(?:->>(\w+))?\.(eq|gte)\.(.*)$/.exec(p); if (!m) throw new Error("fake or(): " + p);
          const val = (r: any) => m[2] ? (r[m[1]] && r[m[1]][m[2]] != null ? String(r[m[1]][m[2]]) : null) : r[m[1]];
          return (r: any) => { const x = val(r); return x != null && (m[3] === "eq" ? String(x) === m[4] : x >= m[4]); };
        });
        st.f.push((r: any) => ps.some((f) => f(r))); return api;
      },
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

  // 16b. Message templates (Settings → Message templates, Ofek 12 Oct): nothing edited = the approved words, exactly;
  // an edited one is used; a blank one keeps the approved words.
  db = fakeDb(); sms.length = 0;
  await step(db, "incoming", { CallSid: "CT1", ...IN }, {}, FRI_10);
  await step(db, "after_owners", { CallSid: "CT1", DialCallStatus: "no-answer", ...IN }, { div: "Aircon" }, FRI_10);
  eq(sms[0] && sms[0].Body, "Hi, it's The Guys Service Group. Sorry we missed your call! We'll call you back shortly. If it's easier, reply here with what you need and your suburb.", "missed call, nothing edited: the approved text");
  db = fakeDb({ ronOn: false }); sms.length = 0;
  await step(db, "incoming", { CallSid: "CT2", ...IN }, {}, FRI_21);
  eq(sms[0] && sms[0].Body, "Hi, it's The Guys Service Group. Thanks for calling - our office is closed right now, we'll call you back first thing. If it's easier, reply here with what you need and your suburb.", "office closed, nothing edited: the approved text");
  db = fakeDb(); db.T.settings[0].catalog = { templates: { missedCall: "Sorry we missed you - we'll ring back soon.", missedCallClosed: " " } }; sms.length = 0;
  await step(db, "incoming", { CallSid: "CT3", ...IN }, {}, FRI_10);
  await step(db, "after_owners", { CallSid: "CT3", DialCallStatus: "no-answer", ...IN }, { div: "Aircon" }, FRI_10);
  eq(sms[0] && sms[0].Body, "Sorry we missed you - we'll ring back soon.", "missed call: the edited text");
  db = fakeDb({ ronOn: false }); db.T.settings[0].catalog = { templates: { missedCall: "edited", missedCallClosed: " " } }; sms.length = 0;
  await step(db, "incoming", { CallSid: "CT4", ...IN }, {}, FRI_21);
  eq(sms[0] && /^Hi, it's The Guys Service Group\. Thanks for calling/.test(sms[0].Body), true, "office closed, its template blank: the approved text");

  // 16b2. The business name in the words (round 3, T1.9): settings.company_name fills {business_name}.
  db = fakeDb(); db.T.settings[0].company_name = "Acme Plumbing"; sms.length = 0;
  x = await body(await step(db, "incoming", { CallSid: "CB1", ...IN }, {}, FRI_10));
  has(x, "Thanks for calling Acme Plumbing. This call may be recorded for quality and training.", "greeting: the business name from Business details");
  await step(db, "after_owners", { CallSid: "CB1", DialCallStatus: "no-answer", ...IN }, { div: "Aircon" }, FRI_10);
  eq(sms[0] && sms[0].Body.startsWith("Hi, it's Acme Plumbing. Sorry we missed your call!"), true, "missed-call text: the business name from Business details");
  db = fakeDb(); db.T.settings[0].company_name = "Acme Plumbing"; db.T.settings[0].catalog = { templates: { phoneGreeting: "You reached {business_name}!" } };
  x = await body(await step(db, "incoming", { CallSid: "CB2", ...IN }, {}, FRI_10));
  has(x, "You reached Acme Plumbing!", "an edited greeting with {business_name} is filled");
  db = fakeDb(); db.T.settings[0].company_name = "";
  x = await body(await step(db, "incoming", { CallSid: "CB3", ...IN }, {}, FRI_10));
  has(x, "Thanks for calling. This call may be recorded for quality and training.", "no business name: the blank goes cleanly (no double space)");
  // A settings read that fails ({ data: null, error }, no throw) keeps the words read last, never "no business name".
  db = fakeDb(); db.T.settings[0].company_name = "Acme Plumbing";
  await body(await step(db, "incoming", { CallSid: "CB4", ...IN }, {}, FRI_10));
  { const bad = fakeDb(), from0 = bad.from;
    bad.from = (t: string) => t === "settings" ? { select: () => ({ limit: async () => ({ data: null, error: { message: "timeout" } }) }) } : from0(t);
    x = await body(await step(bad, "incoming", { CallSid: "CB5", ...IN }, {}, FRI_10));
    has(x, "Thanks for calling Acme Plumbing. This call may be recorded", "a failed settings read keeps the business name read last"); }
  // A new caller's card is on the business's day: Fri 10:00 Sydney = Thu 19:00 in Chicago → noon Thu 1 Oct Chicago
  // (a bare date would be midnight UTC = Wednesday evening there); Sydney keeps the bare date as before.
  db = fakeDb(); db.T.settings[0].catalog = { region: { timeZone: "America/Chicago" } };
  await step(db, "incoming", { CallSid: "CB6", ...IN }, {}, FRI_10);
  const syd = fakeDb(); await step(syd, "incoming", { CallSid: "CB7", ...IN }, {}, FRI_10);
  eq([db.T.contacts[1] && db.T.contacts[1].created_at, syd.T.contacts[1] && syd.T.contacts[1].created_at], ["2026-10-01T17:00:00.000Z", "2026-10-02"], "new caller's card: the business's day (Chicago noon; Sydney's bare date as before)");
  useTemplates({}, "Acme");
  eq([fillBiz("Hi, it's {business_name}."), fillBiz("No blank here."), fillBiz("{business_name} and {other}")], ["Hi, it's Acme.", "No blank here.", "Acme and {other}"], "fillBiz: fills only {business_name}");
  useTemplates({}, "");
  eq([fillBiz("Thanks for calling {business_name}. Bye"), fillBiz("Hi, it's {business_name}."), fillBiz("Hello {business_name}, hi")], ["Thanks for calling. Bye", "Hi, it's.", "Hello, hi"], "fillBiz: no name takes its loose space with it");

  // 16c. Settings → Phone (Ofek 13 Oct): nothing saved = the same menu and spoken words, word for word.
  eq(menuText(menuOf({})), "For air conditioning, press 1. For chimney, press 2. For pressure washing, press 3.", "menu, nothing saved: the original words");
  eq(menuOf({ menu: [{ key: " ", say: "x" }, { key: "Aircon" }] }).length, 3, "a menu with no usable rows falls back to the original three");
  db = fakeDb();
  x = await body(await step(db, "incoming", { CallSid: "CM1", ...IN }, {}, FRI_10));
  has(x, "Thanks for calling The Guys Service Group. This call may be recorded for quality and training.", "greeting, nothing edited: the approved words");
  has(x, "For air conditioning, press 1. For chimney, press 2. For pressure washing, press 3.", "menu, nothing edited: the original words");
  // A menu of two, in a new order, and an edited greeting: the menu says it, the keys map to it, 3 is now "Other".
  const two = JSON.parse(JSON.stringify(ROUTING)); two.menu = [{ key: "Chimney", say: "chimney sweeping" }, { key: "Aircon", say: "air con" }];
  db = fakeDb({ routing: two }); db.T.settings[0].catalog = { templates: { phoneGreeting: "Hi, you've reached The Guys." } };
  x = await body(await step(db, "incoming", { CallSid: "CM2", ...IN }, {}, FRI_10));
  has(x, "Hi, you've reached The Guys.", "edited greeting is spoken");
  hasNot(x, "This call may be recorded", "…instead of the original");
  has(x, "For chimney sweeping, press 1. For air con, press 2.", "menu from the settings");
  hasNot(x, "press 3", "only two options");
  await step(db, "menu", { CallSid: "CM2", Digits: "2", ...IN }, {}, FRI_10);
  eq(db.T.calls.find((c: any) => c.call_sid === "CM2").division, "Aircon", "key 2 = the second service");
  db = fakeDb({ routing: two });
  await step(db, "incoming", { CallSid: "CM3", ...IN }, {}, FRI_10);
  await step(db, "menu", { CallSid: "CM3", Digits: "3", ...IN }, {}, FRI_10);
  eq(db.T.calls.find((c: any) => c.call_sid === "CM3").division, "Other", "a key past the menu = Other");
  // A known Pressure Washing customer when Pressure Washing is not in the menu: they hear the menu.
  db = fakeDb({ routing: two }); db.T.contacts[0].division = "Pressure Washing";
  x = await body(await step(db, "incoming", { CallSid: "CM4", From: "0466103709", To: IN.To }, {}, FRI_10));
  has(x, "<Gather", "known customer of a service not in the menu hears the menu");
  eq(db.T.calls.find((c: any) => c.call_sid === "CM4").division, null, "…and the call has no service yet");
  // Edited closed and missed voicemail words; ring times from the settings, out-of-range = 20.
  db = fakeDb({ ronOn: false }); db.T.settings[0].catalog = { templates: { phoneClosed: "We're closed - leave a message.", phoneMissed: " " } };
  x = await body(await step(db, "incoming", { CallSid: "CM5", ...IN }, {}, FRI_21));
  has(x, "We're closed - leave a message.", "edited closed words are spoken");
  db = fakeDb({ routing: bothAway }); db.T.settings[0].catalog = { templates: { phoneMissed: " " } };
  await step(db, "incoming", { CallSid: "CM6", ...IN }, {}, FRI_10);
  x = await body(await step(db, "after_office", { CallSid: "CM6", DialCallStatus: "no-answer", ...IN }, { div: "Aircon" }, FRI_10));
  has(x, "Sorry, we couldn't get to the phone.", "missed words blank: the approved words");
  const rings = JSON.parse(JSON.stringify(ROUTING)); rings.officeRingSeconds = 30; rings.backupRingSeconds = 300;
  db = fakeDb({ routing: rings });
  x = await body(await step(db, "incoming", { CallSid: "CM7", From: "0466103709", To: IN.To }, {}, FRI_10));
  has(x, 'timeout="30"', "office rings for the set seconds");
  x = await body(await step(db, "after_office", { CallSid: "CM7", DialCallStatus: "no-answer", From: "+61466103709", To: IN.To }, { div: "Chimney" }, FRI_10));
  has(x, 'timeout="20"', "out-of-range backup ring = 20 seconds");

  // 16b. Backup hours per weekday (Ofek 13 Oct). The old shape ({ from, to, days: [..] }) still reads the same; the
  // ROUTING fixture above keeps it, so every test before this one proves that too.
  const SAT_10 = Date.parse("2026-10-03T00:00:00Z");    // Saturday 10:00 Sydney
  const FRI_1830 = Date.parse("2026-10-02T08:30:00Z");  // Friday 18:30 Sydney
  const SAT_1330 = Date.parse("2026-10-03T03:30:00Z");  // Saturday 13:30 Sydney
  const at = (h: any, ms: number) => backupOpen({ backupHours: h } as any, ms);
  const oldAll = { from: "08:00", to: "20:00", days: [0, 1, 2, 3, 4, 5, 6] }, oldWeek = { from: "08:00", to: "20:00", days: [1, 2, 3, 4, 5] };
  eq([at(oldAll, FRI_10), at(oldAll, FRI_21), at(oldAll, SAT_0730)], [true, false, false], "old shape: every day 08:00–20:00");
  eq([at(oldWeek, FRI_10), at(oldWeek, SAT_10)], [true, false], "old shape: an unticked day has no backup");
  eq([at({ from: "08:00", to: "20:00", days: [] }, FRI_10), at({ from: "08:00", to: "20:00" }, FRI_10)], [false, false], "old shape: no days ticked = no backup, as before");
  const perDayH = { days: { 5: { on: true, from: "09:00", to: "17:00" }, 6: { on: false, from: "08:00", to: "20:00" } } };
  eq([at(perDayH, FRI_10), at(perDayH, FRI_1830), at(perDayH, SAT_10)], [true, false, false], "per day: Friday 09:00–17:00, Saturday off");
  eq(at({ days: { 5: { on: true, from: "08:00", to: "21:30" } } }, FRI_21), true, "per day: a late Friday");
  eq([at({ days: {} }, FRI_10), at({ days: {} }, FRI_21)], [true, false], "per day: a missing day is on, 08:00–20:00");
  eq(at({ days: { 5: { on: true, from: "17:00", to: "09:00" } } }, FRI_10), false, "per day: end before start = no backup");
  eq(at({ days: { 5: { on: true, from: "bad", to: "20:00" } } }, FRI_10), false, "per day: a bad time = no backup");
  eq([at(null, FRI_10), at("x", FRI_10), at({ days: 5 }, FRI_10)], [false, false, false], "odd data never throws, just no backup");
  eq(backupOpen({ backupHours: JSON.parse('{"days":{"5":{"on":true,"from":"08:00","to":"12:00"}}}') } as any, FRI_10), true, "per day: string keys from JSON");
  eq(backupDay(JSON.parse('{"days":{"5":{"on":true,"from":"09:00","to":"17:00"}}}'), 5), { from: 540, to: 1020 }, "backupDay in minutes");
  // The business's time zone (Region and format), read with the routing: Fri 2 Oct 15:00 UTC = Fri 10:00 in Chicago,
  // Sat 01:00 in Sydney.
  { const FRI_10_CHI = Date.parse("2026-10-02T15:00:00Z"), rdb = fakeDb();
    eq(at(oldAll, FRI_10_CHI), false, "time zone: nothing saved = Sydney (01:00, no backup)");
    rdb.T.settings[0].catalog = { region: { timeZone: "America/Chicago" } }; await routing(rdb);
    eq(at(oldAll, FRI_10_CHI), true, "time zone: Chicago's 10:00 once the routing has read the region");
    rdb.T.settings[0].catalog = {}; await routing(rdb);
    eq(at(oldAll, FRI_10_CHI), false, "time zone: back to Sydney when it is cleared"); }
  const perDay = JSON.parse(JSON.stringify(ROUTING));
  perDay.backupHours = { days: { 0: { on: false }, 1: { on: true, from: "08:00", to: "20:00" }, 2: { on: true, from: "08:00", to: "20:00" }, 3: { on: true, from: "08:00", to: "20:00" }, 4: { on: true, from: "08:00", to: "20:00" }, 5: { on: false, from: "08:00", to: "20:00" }, 6: { on: true, from: "09:00", to: "13:00" } } };
  db = fakeDb({ ronOn: false, routing: perDay });
  x = await body(await step(db, "incoming", { CallSid: "CB1", ...IN }, {}, FRI_10));
  has(x, "Our office is closed", "per day: no backup on Friday → closed");
  has(x, "<Record ", "…voicemail");
  db = fakeDb({ ronOn: false, ronDate: "2026-10-03", routing: perDay });
  x = await body(await step(db, "incoming", { CallSid: "CB2", From: "0466103709", To: IN.To }, {}, SAT_10));
  has(x, "<Number>+61407735994</Number>", "per day: Saturday 10:00 open, chimney → Noam");
  db = fakeDb({ ronOn: false, ronDate: "2026-10-03", routing: perDay });
  x = await body(await step(db, "incoming", { CallSid: "CB3", From: "0466103709", To: IN.To }, {}, SAT_1330));
  has(x, "Our office is closed", "per day: Saturday after 13:00 closed");
  db = fakeDb({ ronDate: "2026-10-02", routing: perDay });
  await step(db, "incoming", { CallSid: "CB4", From: "0466103709", To: IN.To }, {}, FRI_10);
  x = await body(await step(db, "after_office", { CallSid: "CB4", DialCallStatus: "no-answer", From: "+61466103709", To: IN.To }, { div: "Chimney" }, FRI_10));
  has(x, "Our office is closed", "per day: Ron didn't answer on a day with no backup → closed voicemail");
  const nothing = { people: ROUTING.people, divisions: ROUTING.divisions };
  db = fakeDb({ ronOn: false, routing: nothing });
  x = await body(await step(db, "incoming", { CallSid: "CB5", From: "0466103709", To: IN.To }, {}, FRI_10));
  has(x, "<Number>+61407735994</Number>", "nothing saved: backup at 10:00");
  db = fakeDb({ ronOn: false, routing: nothing });
  x = await body(await step(db, "incoming", { CallSid: "CB6", ...IN }, {}, FRI_21));
  has(x, "Our office is closed", "nothing saved: closed at 21:00");
  const perDayAway = JSON.parse(JSON.stringify(perDay)); perDayAway.people.noam.available = false;
  db = fakeDb({ ronDate: "2026-10-03", routing: perDayAway });
  await step(db, "incoming", { CallSid: "CB7", ...IN }, {}, SAT_10);
  x = await body(await step(db, "after_office", { CallSid: "CB7", DialCallStatus: "no-answer", ...IN }, { div: "Aircon" }, SAT_10));
  has(x, "<Number>+61418638552</Number></Dial>", "per day + Noam not available → aircon goes to Ofek");
  hasNot(x, "+61407735994", "…not Noam");

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
  // 19. Vacations (stage 3): "Calls not routed to them" skips the person; everything else as before.
  // Their own routing with neutral demo names and made-up mobiles (the repo is public); the office login is the fixture's.
  const R19 = () => ({ ...JSON.parse(JSON.stringify(ROUTING)), people: { ava: { name: "Ava", mobile: "+61400000022", available: true }, ben: { name: "Ben", mobile: "0400 000 011", available: true } },
    divisions: { Aircon: ["ben"], Chimney: ["ben"], "Pressure Washing": ["ava"], Other: ["ava", "ben"] } });
  const EMPS = [{ id: "e-noam", name: "Noam Gal", phone: "0400 000 011", status: "Active" }, { id: "e-ofek", name: "Ofek", phone: "0400 000 022", status: "Active" }, { id: "e-ron", name: "Ron", phone: "", status: "Active" }];
  const VAC = (o: any = {}) => ({ id: "v1", employee_id: "e-noam", starts_on: "2026-10-01", ends_on: "2026-10-05", stand_in_id: null, options: { noCalls: true }, ended_at: null, cancelled_at: null, ...o });
  const C0 = (emps: any[], vacs: any[]): any => ({ day: "2026-10-02", tz: "Australia/Sydney", vacs, employees: emps, profiles: [] });
  const P = { ofek: { name: "Ofek", mobile: "+61400000022", available: true }, noam: { name: "Noam", mobile: "0400 000 011", available: true } };
  const awayKeys = (people: any, emps: any[], vacs: any[]) => [...vacPhoneAway(people, C0(emps, vacs))].sort();
  eq(awayKeys(P, [{ id: "e1", name: "N. G.", phone: "0400000011" }], [VAC({ employee_id: "e1" })]), ["noam"], "vacPhoneAway: by mobile");
  eq(awayKeys(P, [{ id: "e1", name: "Ofek", phone: "" }], [VAC({ employee_id: "e1" })]), ["ofek"], "vacPhoneAway: by full name");
  eq(awayKeys(P, [{ id: "e1", name: "Noam Gal", phone: "" }], [VAC({ employee_id: "e1" })]), ["noam"], "vacPhoneAway: by a first name nobody else has");
  eq(awayKeys(P, [{ id: "e1", name: "Noam Gal", phone: "" }, { id: "e2", name: "Noam Levi", phone: "" }], [VAC({ employee_id: "e1" })]), [], "vacPhoneAway: a shared first name is no match");
  eq(awayKeys({ nc: { name: "Noam Cohen", mobile: "" } }, [{ id: "e1", name: "Noam Gal", phone: "" }], [VAC({ employee_id: "e1" })]), [], "vacPhoneAway: a different full name is no match");
  eq(awayKeys(P, [{ id: "e1", name: "Ofek", phone: "" }], [VAC({ employee_id: "e1", options: { noNotify: true } })]), [], "vacPhoneAway: only 'Calls not routed' counts");
  // the owner Noam Gal (a login with no employee card) is the backup phone "Noam"; the technician Noam Levi is on vacation
  const BENS = { noam: { name: "Noam", mobile: "", available: true } }, LEVI = [{ id: "e-levi", name: "Noam Levi", phone: "0400 000 001" }];
  const withProfiles = (people: any, emps: any[], vacs: any[], profiles: any[]) => [...vacPhoneAway(people, { ...C0(emps, vacs), profiles })].sort();
  eq(withProfiles(BENS, LEVI, [VAC({ employee_id: "e-levi" })], [{ id: "p-gal", full_name: "Noam Gal", technician_name: null, role: "owner" }]), [],
    "vacPhoneAway: a login of any role with that first name (the owner Noam Gal, no employee card) is a twin → the owner's phone isn't skipped");
  eq(withProfiles(BENS, LEVI, [VAC({ employee_id: "e-levi" })], [{ id: "p-levi", full_name: "Noam Levi", technician_name: "Noam Levi", role: "technician" }]), ["noam"],
    "vacPhoneAway: Noam Levi's own login is no twin");
  eq(withProfiles(BENS, LEVI, [VAC({ employee_id: "e-levi" })], [{ id: "p-x", full_name: "Someone", technician_name: "Noam", role: "technician" }]), [], "vacPhoneAway: a Jobs & Commissions name counts as a twin too");
  // the backup phone "Sam" has the mobile of Sam Lee (not away): Sam Park, away, is not that phone
  const SAMS = [{ id: "e-lee", name: "Sam Lee", phone: "0411 111 111" }, { id: "e-park", name: "Sam Park", phone: "" }];
  eq(awayKeys({ sam: { name: "Sam", mobile: "0411111111" } }, SAMS, [VAC({ employee_id: "e-park" })]), [], "vacPhoneAway: the same mobile decides first (Sam Lee), never the name of someone else away");
  eq(awayKeys({ sam: { name: "Sam", mobile: "0411111111" } }, SAMS, [VAC({ employee_id: "e-lee" })]), ["sam"], "vacPhoneAway: …and when that person is away, skipped");
  eq(awayKeys({ x: { name: "X", mobile: "0411111111" } }, [...SAMS, { id: "e-dup", name: "Dup", phone: "0411 111 111" }], [VAC({ employee_id: "e-lee" })]), [], "vacPhoneAway: a mobile two employees share is no match");
  eq([vacPhoneEmployee({ name: "Sam Park", mobile: "" } as any, "k", C0(SAMS, []))?.id, vacPhoneEmployee({ name: "", mobile: "" } as any, "Sam Lee", C0(SAMS, []))?.id, vacPhoneEmployee({ name: "Sam", mobile: "" } as any, "k", C0(SAMS, []))],
    ["e-park", "e-lee", null], "vacPhoneEmployee: the full name, the key when unnamed, a shared first name → none");
  eq(ownersFor({ ...R19(), people: P } as any, "Aircon", new Set(["noam"])), ["+61400000022"], "ownersFor: someone away → the next in line");
  // Noam away: an aircon caller (his service), Ron off shift, 10:00 → Ofek, never Noam.
  const aircon = (o: any) => { const d = fakeDb({ ronOn: false, routing: R19(), ...o }); d.T.contacts[0].division = "Aircon"; return d; };
  db = aircon({ vac: { employees: EMPS, vacations: [VAC()] } });
  x = await body(await step(db, "incoming", { CallSid: "CV1", From: "0466 103 709", To: IN.To }, {}, FRI_10));
  has(x, "<Number>+61400000022</Number>", "vacation: Noam away → Ofek rings");
  hasNot(x, "+61400000011", "vacation: …never Noam's number");
  db = aircon({ vac: { employees: EMPS, vacations: [VAC(), VAC({ id: "v2", employee_id: "e-ofek" })] } }); sms.length = 0;
  x = await body(await step(db, "incoming", { CallSid: "CV2", From: "0466 103 709", To: IN.To }, {}, FRI_10));
  has(x, "couldn't get to the phone", "vacation: both owners away → voicemail with the 'missed' words");
  hasNot(x, "Our office is closed", "vacation: …not the 'closed' words");
  db = aircon({ vac: { employees: EMPS, vacations: [VAC({ options: { noNotify: true } })] } });
  x = await body(await step(db, "incoming", { CallSid: "CV3", From: "0466 103 709", To: IN.To }, {}, FRI_10));
  has(x, "<Number>+61400000011</Number>", "vacation: 'Calls not routed' unticked → Noam rings as before");
  db = aircon({ vac: { employees: EMPS, vacations: [VAC({ ended_at: "2026-10-01T03:00:00Z" })] } });
  x = await body(await step(db, "incoming", { CallSid: "CV4", From: "0466 103 709", To: IN.To }, {}, FRI_10));
  has(x, "<Number>+61400000011</Number>", "vacation: ended → Noam rings as before");
  // after_office (Ron didn't answer) skips Noam too
  db = fakeDb({ routing: R19(), vac: { employees: EMPS, vacations: [VAC()] } });
  x = await body(await step(db, "after_office", { CallSid: "CV5", DialCallStatus: "no-answer", ...IN }, { div: "Aircon" }, FRI_10));
  has(x, "<Number>+61400000022</Number>", "vacation: after the office, Noam away → Ofek");
  hasNot(x, "+61400000011", "vacation: …not Noam");
  // Ron on vacation while his shift is on today → his browser phone stays quiet
  const RONV = VAC({ id: "v3", employee_id: "e-ron" });
  db = fakeDb({ routing: R19(), vac: { employees: EMPS, vacations: [RONV] } });
  x = await body(await step(db, "incoming", { CallSid: "CV6", From: "0466 103 709", To: IN.To }, {}, FRI_10));
  hasNot(x, "office-ron1", "vacation: Ron away → his browser phone doesn't ring");
  has(x, "<Number>+61400000011</Number>", "vacation: …the call goes to the owners (Chimney → Noam)");
  db = fakeDb({ routing: R19(), vac: { employees: EMPS, vacations: [RONV] } });
  x = await body(await step(db, "incoming", { CallSid: "CV7", ...IN }, {}, FRI_21));
  has(x, "Our office is closed", "vacation: Ron away, outside the backup hours → the closed voicemail");
  db = fakeDb({ routing: R19(), vac: { employees: EMPS, vacations: [VAC({ id: "v3", employee_id: "e-ron", options: { noNotify: true } })] } });
  x = await body(await step(db, "incoming", { CallSid: "CV8", From: "0466 103 709", To: IN.To }, {}, FRI_10));
  has(x, "office-ron1", "vacation: Ron away without 'Calls not routed' → rings as before");
  // fail-open: no vacations table, or reading it throws → routing exactly as before
  db = fakeDb();
  x = await body(await step(db, "incoming", { CallSid: "CV9", From: "0466 103 709", To: IN.To }, {}, FRI_10));
  has(x, "office-ron1", "vacation: no table → as before");
  const quiet = console.error; let logged = "";
  console.error = (...a: any[]) => { logged += a.map(String).join(" "); };
  db = fakeDb({ routing: R19(), vac: { employees: EMPS, vacations: [RONV], throws: true } });
  x = await body(await step(db, "incoming", { CallSid: "CV10", From: "0466 103 709", To: IN.To }, {}, FRI_10));
  console.error = quiet;
  has(x, "office-ron1", "vacation: reading them throws → as before (Ron rings)");
  eq(logged.includes("vacations not read"), true, "vacation: the failure is logged");
  // the day is the business's (settings.catalog.region.timeZone, review A2): Fri 2 Oct 10:00 Sydney is Thu 1 Oct 19:00 in Chicago
  const TILL1 = VAC({ starts_on: "2026-09-28", ends_on: "2026-10-01" });
  db = aircon({ vac: { employees: EMPS, vacations: [TILL1] } });
  x = await body(await step(db, "incoming", { CallSid: "CV11", From: "0466 103 709", To: IN.To }, {}, FRI_10));
  has(x, "<Number>+61400000011</Number>", "vacation zone: a Sydney business, away until 1 Oct → back on the 2nd, Ben rings");
  db = aircon({ vac: { employees: EMPS, vacations: [TILL1] } }); db.T.settings[0].catalog = { region: { timeZone: "America/Chicago" } };
  x = await body(await step(db, "incoming", { CallSid: "CV12", From: "0466 103 709", To: IN.To }, {}, FRI_10));
  has(x, "<Number>+61400000022</Number>", "vacation zone: a Chicago business, still 1 Oct there → Ben is away, Ava rings");
  hasNot(x, "+61400000011", "vacation zone: …never Ben");

  console.log(`${pass} passed, ${fail} failed`);
  if (fail) (globalThis as any).process?.exit(1);
  console.log("TOKEN " + tok);
})();
