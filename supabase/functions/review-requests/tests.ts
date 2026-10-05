// Tests for review-requests/index.ts. Run: bash supabase/functions/review-requests/run_tests.sh
// (the runner swaps the esm.sh import for a stub, appends this file and runs it with npx tsx).
// deno-lint-ignore-file no-explicit-any

// ── a small in-memory stand-in for the Supabase client ──
function fakeDb(seed: Record<string, any[]> = {}) {
  const T: Record<string, any[]> = { contacts: [], jobs: [], review_requests: [], sms_opt_outs: [], activity_log: [], settings: [{ id: 1, review_requests_enabled: true, review_requests_auto: false, reviews_from: "2026-10-03" }], ...seed };
  function q(table: string) {
    const rows = () => (T[table] = T[table] || []);
    const filters: ((r: any) => boolean)[] = [];
    let op = "select", payload: any = null, single = false, lim = Infinity, order: [string, boolean] | null = null, range: [number, number] | null = null;
    const b: any = {
      select() { return b; },
      insert(p: any) { op = "insert"; payload = p; return b; },
      update(p: any) { op = "update"; payload = p; return b; },
      eq(k: string, v: any) { filters.push((r) => r[k] === v); return b; },
      gte(k: string, v: any) { filters.push((r) => r[k] !== null && r[k] !== undefined && String(r[k]) >= String(v)); return b; },
      lte(k: string, v: any) { filters.push((r) => r[k] !== null && r[k] !== undefined && String(r[k]) <= String(v)); return b; },
      is(k: string, v: any) { filters.push((r) => (r[k] ?? null) === v); return b; },
      in(k: string, list: any[]) { filters.push((r) => list.includes(r[k])); return b; },
      ilike(k: string, pat: string) { const want = pat.replace(/\\(.)/g, "$1").toLowerCase(); filters.push((r) => String(r[k] ?? "").toLowerCase() === want); return b; },
      or(expr: string) {
        const parts = expr.split(",").map((p) => { const [col, opx, ...rest] = p.split("."); return { col, opx, val: rest.join(".") }; });
        filters.push((r) => parts.some((p) => p.opx === "eq" && String(r[p.col] ?? "") === p.val));
        return b;
      },
      order(k: string, o?: any) { order = [k, !(o && o.ascending === false)]; return b; },
      limit(x: number) { lim = x; return b; },
      range(a: number, z: number) { range = [a, z]; return b; },
      single() { single = true; return b; },
      then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej); },
    };
    function run() {
      const match = () => rows().filter((r) => filters.every((f) => f(r)));
      if (op === "insert") {
        const list = (Array.isArray(payload) ? payload : [payload]).map((r: any) => ({ id: r.id || crypto.randomUUID(), created_at: NOW_ISO, ...r }));
        rows().push(...list);
        return { data: single ? list[0] : list, error: null };
      }
      if (op === "update") { const m = match(); m.forEach((r) => Object.assign(r, payload)); return { data: m, error: null }; }
      let m = match();
      if (order) { const [k, asc] = order; m = m.slice().sort((a, z) => (String(a[k]) < String(z[k]) ? -1 : String(a[k]) > String(z[k]) ? 1 : 0) * (asc ? 1 : -1)); }
      if (range) m = m.slice(range[0], range[1] + 1);
      m = m.slice(0, lim);
      return { data: single ? (m[0] ? { ...m[0] } : null) : m.map((r) => ({ ...r })), error: null };
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
// GHL (the text) is the only outside call: record it, or make it fail.
const texts: any[] = [];
let ghlOk = true;
(globalThis as any).fetch = async (url: string, init: any) => {
  if (url === "https://ghl.test/hook") { if (!ghlOk) return { ok: false, status: 500 }; texts.push(JSON.parse(init.body)); return { ok: true, status: 200 }; }
  throw new Error("unexpected fetch " + url);
};

// Sydney is on daylight time (UTC+11) from 4 Oct 2026.
const TUE_1000 = Date.parse("2026-10-05T23:00:00Z");   // Tue 6 Oct 10:00 Sydney
let NOW_ISO = new Date(TUE_1000).toISOString();
const card = (id: string, full_name: string, phone: string, email = "") => ({ id, full_name, phone, email, created_at: "2026-10-01" });
const job = (id: string, inv: string, extra: any = {}) => ({ id, invoice_number: inv, customer_name: "Sarah Smith", date: "2026-10-06", job_type: "Aircon", technician: "Guy", review_taken: false, review_do_not_ask: false, contact_id: null, ...extra });

(async () => {
  // ── sending hours ──
  eq(new Date(sendAt(TUE_1000)).toISOString(), new Date(TUE_1000).toISOString(), "10:00 → goes at once");
  eq(new Date(sendAt(Date.parse("2026-10-05T20:30:00Z"))).toISOString(), "2026-10-05T23:00:00.000Z", "07:30 → 10:00 the same morning");
  eq(new Date(sendAt(Date.parse("2026-10-06T09:30:00Z"))).toISOString(), "2026-10-06T23:00:00.000Z", "20:30 → 10:00 the next morning");
  eq(inSendWindow(Date.parse("2026-10-05T21:00:00Z")), true, "08:00 is inside the sending hours");
  eq(inSendWindow(Date.parse("2026-10-06T09:00:00Z")), false, "20:00 is outside");

  // ── the customer's details come from the CRM card ──
  {
    const db = fakeDb({
      contacts: [card("c1", "Sarah Smith", "0412 345 678", "Sarah@Example.com"), card("c2", "Tom Land", "02 9999 1234", "tom@x.co"), card("c3", "Ann Stop", "0400 111 222"),
        card("c4", "Twin Name", "0411 000 001"), card("c5", "twin name", "0411 000 002")],
      sms_opt_outs: [{ phone_key: "400111222" }],
    });
    eq(await contactFromCrm(db, job("j", "1", { contact_id: "c1" })), { id: "c1", phone: "+61412345678", email: "sarah@example.com", first: "Sarah" }, "linked card: mobile, email and first name");
    eq((await contactFromCrm(db, job("j", "1", { contact_id: "c2", customer_name: "Tom Land" })))!.phone, "", "a landline gets no text");
    eq((await contactFromCrm(db, job("j", "1", { contact_id: "c3" })))!.phone, "", "a number that texted STOP gets no text");
    eq((await contactFromCrm(db, job("j", "1", { customer_name: "sarah smith" })))!.id, "c1", "not linked: the one card with the same name");
    eq(await contactFromCrm(db, job("j", "1", { customer_name: "Twin Name" })), null, "two cards with the same name: no guess");
    eq(await contactFromCrm(db, job("j", "1", { customer_name: "Nobody Here" })), null, "no card at all");
  }

  // ── "Ask for review" by hand ──
  {
    const db = fakeDb({
      contacts: [card("c1", "Sarah Smith", "0412 345 678", "sarah@example.com"), card("c2", "No Details", "", "")],
      jobs: [job("j1", "2501", { contact_id: "c1" }), job("j2", "2502", { customer_name: "Nobody Here" }), job("j3", "2503", { contact_id: "c2", customer_name: "No Details" }),
        job("j4", "2504", { contact_id: "c1", review_do_not_ask: true }), job("j5", "2505", { contact_id: "c1", review_taken: true }), job("j6", "2506", { contact_id: "c1", job_type: "Other" }),
        job("j7", "2507", { contact_id: "c1", date: "2026-10-05" })],
    });
    eq((await askForReview(db, "j2", "Ron", TUE_1000)).reason, "no_card", "no customer card → not sent, says why");
    eq((await askForReview(db, "j3", "Ron", TUE_1000)).reason, "no_contact", "card without mobile or email → not sent");
    eq((await askForReview(db, "j4", "Ron", TUE_1000)).reason, "do_not_ask", "don't ask → refused");
    eq((await askForReview(db, "j5", "Ron", TUE_1000)).reason, "review_taken", "review taken → refused");
    eq((await askForReview(db, "j6", "Ron", TUE_1000)).reason, "unknown_job_type", "unknown job type → refused");
    texts.length = 0;
    const r1 = await askForReview(db, "j1", "Ron", TUE_1000);
    eq([r1.ok, r1.status], [true, "sent"], "in hours: sent at once");
    eq(texts.map((t) => [t.phone, t.job_number]), [["+61412345678", "2501"]], "the text went to the card's mobile");
    eq(/^Hi Sarah, Guy from The Guys Service Group here - thanks for having us today!/.test(texts[0].sms_text), true, "same approved wording, first name from the card");
    const row1 = db.T.review_requests.find((r: any) => r.invoice_number === "2501");
    eq([row1.ask_count, row1.first_sent_at, row1.email, row1.requested_by], [1, NOW_ISO, "sarah@example.com", "Ron"], "first request: count 1, first sent now, email kept for info@");
    eq((await askForReview(db, "j1", "Ron", TUE_1000)).reason, "already_asked", "pressing again without meaning to → asks first");
    eq((await askForReview(db, "j7", "Ron", TUE_1000)).reason, "asked_recently", "same customer, another job, asked in the last 6 months → asks first");
    // The reminder a day later ("Ask again").
    const WED_1100 = TUE_1000 + 25 * 3600 * 1000; NOW_ISO = new Date(WED_1100).toISOString();
    const r2 = await askForReview(db, "j1", "Ron", WED_1100, true);
    eq([r2.ok, r2.status], [true, "sent"], "Ask again: sent");
    eq([row1.ask_count, row1.first_sent_at, row1.sent_at, row1.email_sent_at], [2, new Date(TUE_1000).toISOString(), NOW_ISO, null], "Ask again: count 2, first date kept, email goes again");
    eq(texts.length, 2, "two texts in total");
    NOW_ISO = new Date(TUE_1000).toISOString();
    // After hours: waits for 10:00 the next morning.
    const NIGHT = Date.parse("2026-10-06T10:00:00Z");   // Tue 21:00 Sydney
    const db2 = fakeDb({ contacts: [card("c1", "Sarah Smith", "0412 345 678")], jobs: [job("j1", "2601", { contact_id: "c1" })] });
    const r3 = await askForReview(db2, "j1", "Ron", NIGHT);
    eq([r3.ok, r3.status, r3.send_after], [true, "waiting", "2026-10-06T23:00:00.000Z"], "21:00 → waits for 10:00 tomorrow");
  }

  // ── automatic request when a job comes in ──
  {
    const seed = () => ({
      contacts: [card("c1", "Sarah Smith", "0412 345 678", "sarah@example.com"), card("c2", "Ben Ng", "0413 000 111")],
      jobs: [
        job("j1", "2701", { contact_id: "c1" }),                                          // new job, card linked → asked at once
        job("j2", "2702", { customer_name: "Nobody Here" }),                             // no card → skipped, for the office
        job("j3", "2703", { contact_id: "c2", customer_name: "Ben Ng", date: "2026-10-02" }), // before reviews_from → never
        job("j4", "2704", { contact_id: "c2", customer_name: "Ben Ng", review_taken: true }),  // taken on site → never
        job("j5", "2705", { contact_id: "c2", customer_name: "Ben Ng", review_do_not_ask: true }), // don't ask → never
        job("j6", "2706", { contact_id: "c2", customer_name: "Ben Ng" }),                // "don't ask" note in the sheet → skipped
      ],
    });
    const off = fakeDb(seed());
    texts.length = 0;
    const o1 = await handle(off, [], TUE_1000);
    eq([o1.queued, off.T.review_requests.length, texts.length], [0, 0, 0], "switched off (now, until go-live): nothing is asked");
    const db = fakeDb(seed()); db.T.settings[0].review_requests_auto = true;
    const out = await handle(db, [{ invoice: "2706", review: "Don't ask - complained" }], TUE_1000);
    const by = (inv: string) => db.T.review_requests.find((r: any) => r.invoice_number === inv);
    eq([by("2701").status, by("2701").source, by("2701").ask_count], ["sent", "auto", 1], "new job: asked automatically at once");
    eq(texts.map((t) => t.job_number), ["2701"], "one text, for that job only");
    eq([by("2702").status, by("2702").reason], ["skipped", "no customer card in the CRM for this job"], "no card: written down with the reason (shows in the bubble)");
    eq([by("2703"), by("2704"), by("2705")], [undefined, undefined, undefined], "before the start date / taken / don't ask: left alone");
    eq([by("2706").status, by("2706").reason], ["skipped", "do not ask (unhappy customer or complaint)"], "a don't-ask note in the sheet stops it");
    eq([out.queued, out.skipped], [1, 2], "counts");
    const again = await handle(db, [], TUE_1000 + 15 * 60000);
    eq([again.queued, again.skipped, db.T.review_requests.length, texts.length], [0, 0, 3, 1], "next run 15 minutes later: nothing twice");
    // At night the request waits for the morning, then goes.
    const night = fakeDb(seed()); night.T.settings[0].review_requests_auto = true; texts.length = 0;
    await handle(night, [], Date.parse("2026-10-06T10:00:00Z"));
    const w = night.T.review_requests.find((r: any) => r.invoice_number === "2701");
    eq([w.status, w.send_after, texts.length], ["waiting", "2026-10-06T23:00:00.000Z", 0], "entered at 21:00: waits for 10:00");
    night.T.jobs.find((j: any) => j.id === "j1").review_taken = true;   // the tech marked the review taken in the meantime
    await handle(night, [], Date.parse("2026-10-06T23:00:00Z"));
    eq([w.status, w.reason, texts.filter((t) => t.job_number === "2701").length], ["skipped", "review taken", 0], "marked taken overnight: not sent in the morning");
    eq(texts.map((t) => t.job_number), ["2706"], "the other job that waited overnight goes at 10:00");
    // Without a start date nothing is ever sent automatically.
    const nodate = fakeDb(seed()); nodate.T.settings[0].review_requests_auto = true; nodate.T.settings[0].reviews_from = null;
    eq((await handle(nodate, [], TUE_1000)).queued, 0, "no reviews_from: no automatic request");
    // A job more than a week old is not asked automatically.
    const old = fakeDb({ ...seed(), jobs: [job("j1", "2801", { contact_id: "c1", date: "2026-09-20" })] }); old.T.settings[0].review_requests_auto = true; old.T.settings[0].reviews_from = "2026-09-01";
    eq((await handle(old, [], TUE_1000)).queued, 0, "a job from 2 weeks ago: not asked automatically");
    // The text failing: kept as an error (shows in the bubble), not counted as sent.
    const bad = fakeDb(seed()); bad.T.settings[0].review_requests_auto = true; ghlOk = false;
    await handle(bad, [], TUE_1000); ghlOk = true;
    eq(bad.T.review_requests.find((r: any) => r.invoice_number === "2701").status, "error", "text failed → error, the office sees it");
  }

  // ── jobs sheet → OPS: a "don't ask" note marks the job (one way) ──
  {
    const db = fakeDb({ jobs: [
      { ...job("j1", "2901"), entered_by: "System (sheet sync)", sheet_snapshot: null },
      { ...job("j2", "2902", { review_do_not_ask: true }), entered_by: "System (sheet sync)", sheet_snapshot: null },
    ] });
    const row = (inv: string, review: string) => ({ invoice: inv, name: "Sarah Smith", date: "2026-10-06", job_type: "Aircon", technician: "Guy", amount: "300", review });
    await syncSheetJobs(db, [row("2901", "Don't ask"), row("2902", ""), row("2903", "dont ask - complained")], TUE_1000);
    const j = (inv: string) => db.T.jobs.find((x: any) => x.invoice_number === inv);
    eq(j("2901").review_do_not_ask, true, "existing job: the sheet's don't-ask note marks it");
    eq(j("2902").review_do_not_ask, true, "don't ask ticked in the app is never cleared by the sheet");
    eq(j("2903").review_do_not_ask, true, "new job from the sheet with the note: marked from the start");
  }

  console.log(`review-requests: ${pass} passed, ${fail} failed`);
  if (fail) (globalThis as any).process?.exit(1);
})();
