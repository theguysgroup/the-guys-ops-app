// Tests for stage 8's read tools (step B): periods in the business's zone and weeks, lean results, and who gets what.
// Appended to tests.ts by run_tests.sh; it only pushes a suite, so it shares tests.ts's helpers (fakeDb, eq, ok, …) and
// APP. The tools run against a plain fakeDb that returns EVERY row (no row-level security), so what a person gets here
// is the shared block's rule alone (jobVisible, taskVisible, …), not the database's.
// deno-lint-ignore-file no-explicit-any

SUITES.push(async () => {
  const SYD = "Australia/Sydney";
  const NOW8 = Date.parse("2026-10-15T02:00:00Z");   // 13:00 on Thursday 15 Oct in Sydney (daylight saving)
  const prof = (id: string, full_name: string, role: string, extra: any = {}, technician_name: string | null = null) =>
    ({ id, full_name, role, permissions: { ...APP.defaultPermissionsFor(role), ...extra }, technician_name });
  // the app's own default pages for each role (index.html defaultPermissionsFor)
  const OW = prof("r-owner", "Olivia Owner", "owner"), MG = prof("r-manager", "Max Manager", "manager"), VA8 = prof("r-va", "Vera Vance", "va");
  const TE = prof("r-tech", "Tia Tech", "technician", {}, "Tia"), TN = prof("r-techn", "Tom Noname", "technician");
  const MK = prof("r-mkt", "Mia Marketing", "marketing"), MKO = prof("r-mkto", "Mo Overview", "marketing", { crmOverview: true });
  const P = (x: any) => appProfile(x);
  const CAT8 = { region: { timeZone: SYD } };
  const UID = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const SEED = () => ({
    settings: [{ id: 1, company_name: "Acme Home Services", gst_rate_percent: 10, catalog: JSON.parse(JSON.stringify(CAT8)) }],
    contacts: [
      { id: UID(1), full_name: "Demo Lead", phone: "0491 570 006", postcode: "2000", email: "demo@example.com", notes: "private", estimated_value: 500, status: "New", source: "Google Ads", division: "Aircon", created_at: "2026-10-14T23:30:00Z", next_follow_up: null, booked_for: null },
      { id: UID(2), full_name: "Quinn Quoted", phone: "0400 111 222", postcode: "2150", status: "Quoted", source: "Meta Ads", division: "Chimney", created_at: "2026-10-01T03:00:00Z", next_follow_up: "2026-10-20", booked_for: null },
      // 00:30 on 1 Oct in Sydney (this month) and 23:30 on 30 Sep (last month): the business's day, not UTC's
      { id: UID(3), full_name: "Bob Booked", phone: "0400 333 444", postcode: "2010", status: "Booked", source: "Google Maps", division: "Aircon", created_at: "2026-09-30T14:30:00Z", next_follow_up: null, booked_for: "2026-10-17" },
      { id: UID(4), full_name: "Old Lead", phone: "", postcode: "", status: "Lost", source: "Organic", division: "Aircon", created_at: "2026-09-30T13:30:00Z", next_follow_up: null, booked_for: null },
      { id: UID(5), full_name: "Wanda Won", phone: "", postcode: "", status: "Won", source: "Google Ads", division: "Pressure Washing", created_at: "2026-10-10T00:00:00Z", next_follow_up: null, booked_for: null },
    ],
    calls: [
      { id: "c1", missed: false, callback_done_at: null, started_at: "2026-10-14T22:00:00Z", contact_id: UID(1) },
      { id: "c2", missed: true, callback_done_at: null, started_at: "2026-10-13T00:00:00Z", contact_id: UID(1) },
      { id: "c3", missed: true, callback_done_at: "2026-10-12T01:00:00Z", started_at: "2026-10-12T00:00:00Z", contact_id: UID(2) },
      { id: "c4", missed: true, callback_done_at: null, started_at: "2026-10-11T00:00:00Z", contact_id: null },
      { id: "c5", missed: true, callback_done_at: null, started_at: "2026-08-01T00:00:00Z", contact_id: UID(1) },
    ],
    ad_calls: [{ id: "a1", date: "2026-10-10", status: "ANSWERED", duration_seconds: 45 }, { id: "a2", date: "2026-10-11", status: "MISSED", duration_seconds: 0 }, { id: "a3", date: "2026-07-01", status: "MISSED", duration_seconds: 0 }],
    jobs: [
      { id: "j1", date: "2026-10-14", technician: "Tia", customer_name: "Demo Lead", job_type: "Aircon", amount: 200, includes_gst: true, payment_status: "Paid", payment_method: "Cash", commission_percent: 30, parts_cost: 20, parts_paid_by: "Tia", parts_refund_status: "Pending Refund", date_paid: "2026-10-14" },
      { id: "j2", date: "2026-10-13", technician: "Gabe", customer_name: "Quinn Quoted", job_type: "Chimney", amount: 300, includes_gst: false, payment_status: "Unpaid", payment_method: "", commission_percent: 25, parts_cost: 0 },
      { id: "j3", date: "2026-10-16", technician: "Tia", customer_name: "Future Fran", job_type: "Chimney", amount: 150, includes_gst: true, payment_status: null, commission_percent: 30, parts_cost: 0 },
      { id: "j4", date: "2026-10-20", technician: "Gabe", customer_name: "Gary Later", job_type: "Aircon", amount: 400, includes_gst: true, payment_status: null, commission_percent: 25, parts_cost: 0 },
      { id: "j5", date: "2026-09-01", technician: "Gabe", customer_name: "Sept Sam", job_type: "Aircon", amount: 999, includes_gst: true, payment_status: "Paid", payment_method: "Cash", commission_percent: 25, parts_cost: 0, date_paid: "2026-09-01" },
      { id: "j6", date: "2026-10-02", technician: "Tia", customer_name: "Bank Ben", job_type: "Aircon", amount: 100, includes_gst: true, payment_status: "Paid", payment_method: "Bank Transfer", commission_percent: 30, parts_cost: 0, date_paid: "2026-10-05" },
      { id: "j7", date: "2026-10-01", technician: "Gabe", customer_name: "Parts Pat", job_type: "Aircon", amount: 80, includes_gst: false, payment_status: "Unpaid", commission_percent: 25, parts_cost: 30, parts_paid_by: "Gabe", parts_refund_status: "Pending Refund" },
    ],
    equipment_spend: [
      { id: "e1", date: "2026-10-03", item: "Ladder", technician: "Tia", paid_by: "Tia", cost: 50, reimbursed: "Pending", created_at: "2026-10-03T00:00:00Z" },
      { id: "e2", date: "2026-10-05", item: "Hose", technician: "Gabe", paid_by: "Gabe", cost: 40, reimbursed: "Reimbursed", reimbursed_week: "2026-10-04", created_at: "2026-10-05T00:00:00Z" },
    ],
    ad_spend: [{ id: "s1", date: "2026-10-05", channel: "google", spend: 120 }, { id: "s2", date: "2026-09-05", channel: "google", spend: 50 }],
    employees: [
      { name: "Tia", roles: ["Technician"], status: "Active", employment_type: "Employee" }, { name: "Gabe", roles: ["Technician"], status: "Active", employment_type: "Employee" },
      { name: "Hana Hours", roles: [], status: "Active", employment_type: "Hourly" },
    ],
    payroll_weeks: [{ id: "w1", week_start: "2026-10-04", person: "Tia", cash_collected: false, salary_paid: true, salary_paid_amount: null }],
    payroll_bonuses: [], sales_daily_log: [{ id: "l1", person: "Hana Hours", date: "2026-10-06", hours: 5, bookings_aircon: 0, bookings_chimney: 0, bookings_pw: 0 }],
    tasks: [
      { id: "t1", title: "Call supplier", board: "Tia", status: "Not Started", due: "2026-10-15", priority: "High", assignees: ["Tia"] },
      { id: "t2", title: "Office filing", board: "ron", status: "In Progress", due: "2026-10-14", priority: "", assignees: ["Vera Vance"] },
      { id: "t3", title: "Done thing", board: "Tia", status: "Done", due: "2026-10-16", priority: "", assignees: ["Tia"] },
      { id: "t4", title: "Gabe stuff", board: "Gabe", status: "Not Started", due: "2026-10-17", priority: "", assignees: ["Gabe"] },
      { id: "t5", title: "No due", board: "ron", status: "Not Started", due: null, priority: "", assignees: [] },
    ],
    manual_reminders: [{ id: "m1", title: "Call back Quinn", date: "2026-10-14", done: false }, { id: "m2", title: "Later", date: "2026-10-20", done: false }, { id: "m3", title: "Old done", date: "2026-10-01", done: true }],
    dismissed_reminders: [],
  });
  const ctxFor = (p: any, db: any, o: { now?: number; chars?: number; catalog?: any; tz?: string } = {}): any => ({
    me: P(p), biz: { companyName: "Acme Home Services", catalog: o.catalog ?? CAT8, tz: o.tz ?? SYD, gstRate: 10 }, settings: normSettings(AI_ROW()), userSb: db, sb: db,
    conversationId: "c", mode: MODES.assistant, step: 0, nowMs: o.now ?? NOW8, resultChars: o.chars ?? MAX_TOOL_RESULT_CHARS,
    emit: () => {}, card: () => {}, propose: async () => null, stepMeta: { proposals: [], cards: [] },
  });
  // A tool as the loop runs it: its check first, then run (the error text the model would read on a failure).
  const run = async (name: string, p: any, input: any, db: any, o: any = {}): Promise<any> => {
    const ctx = ctxFor(p, db, o), t = TOOLS[name], bad = validateInput(input, t.input_schema);
    if (bad.length) return { error: bad.join("; ") };
    const c = t.check ? t.check(input, ctx) : null;
    if (c) return { error: c };
    try { return await t.run(input, ctx); } catch (e) { return { error: (e as Error).message }; }
  };
  const keysDeep = (v: any, out: string[] = []): string[] => { if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out)); else if (v && typeof v === "object") for (const k of Object.keys(v)) { out.push(k); keysDeep(v[k], out); } return out; };
  const MONEY_KEY = /amount|total|gst|commission|cost|spend|pay/i;
  const READ8 = ["count_calls", "count_leads", "find_leads", "list_jobs", "list_reminders", "list_tasks", "money_summary", "payroll_summary", "read_office_hours", "read_settings", "upcoming_work", "whoami"];
  const reads = (p: any) => toolsFor("assistant", P(p)).filter((t) => t.kind === "read").map((t) => t.name);

  // ── 1. registry: schemas, descriptions, the role matrix ──
  {
    const mine = READ8.filter((n) => !["whoami", "read_office_hours"].includes(n));
    for (const n of mine) {
      const t = TOOLS[n];
      ok(!!t && t.kind === "read" && t.modes.join() === "assistant", `${n}: a read tool of the assistant`);
      eq(strictSchemaProblems(t.input_schema), [], `${n}: strict-compatible schema`);
      eq(toOpenAiTools(apiTools([t]))[0], { type: "function", function: { name: n, description: t.description, parameters: t.input_schema, strict: false } }, `${n}: an OpenAI-style function`);
      ok(t.description.length <= 300 && t.status.length > 0, `${n}: description ≤ 300 chars and a status label`);
      ok(!JSON.stringify(t.input_schema).includes('"required"') || n === "read_settings", `${n}: nothing required (read_settings: section)`);
    }
    eq(TOOLS.read_settings.input_schema.required, ["section"], "read_settings: section is required");
    eq(TASK_STATUSES, APP.TASK_STATUSES, "TASK_STATUSES = the app's");
    const size = JSON.stringify(apiTools(toolsFor("assistant", P(OW)))).length;
    ok(size <= 14000, `apiTools(owner) is ${size} chars as JSON (≤ 14,000)`);
    console.log(`  (stage 8: apiTools(toolsFor("assistant", owner)) = ${size} chars as JSON)`);
    eq(reads(OW), READ8, "owner: all 12 read tools");
    eq(reads(MG), READ8, "manager: all 12 read tools");
    eq(reads(VA8), ["count_calls", "count_leads", "find_leads", "list_jobs", "list_reminders", "list_tasks", "read_office_hours", "read_settings", "upcoming_work", "whoami"], "va: no money or payroll");
    const techReads = ["list_jobs", "list_reminders", "list_tasks", "read_office_hours", "read_settings", "upcoming_work", "whoami"];
    eq(reads(TE), techReads, "technician: own jobs, schedule, tasks, reminders, settings");
    eq(reads(TN), techReads, "technician without technician_name: the same tools (jobs come back empty)");
    eq(reads(MK), ["read_office_hours", "read_settings", "whoami"], "marketing (Google Ads only): no leads, calls or jobs");
    eq(reads(MKO), ["count_leads", "find_leads", "read_office_hours", "read_settings", "whoami"], "marketing + Leads & Marketing: + find_leads, count_leads");
    for (const p of [TE, TN]) ok(!reads(p).includes("money_summary") && !reads(p).includes("payroll_summary"), `${p.full_name}: never money_summary / payroll_summary, whatever pages (finance, payroll) are granted`);
  }

  // ── 2. periods: the business's day, weeks and months; daylight saving ──
  {
    const pr = (period: string, o: { now?: number; tz?: string; cat?: any } = {}) => { const r = periodRange({ period }, o.cat ?? CAT8, o.tz ?? SYD, o.now ?? NOW8, "today"); return [r.from, r.to]; };
    eq(pr("today"), ["2026-10-15", "2026-10-15"], "today = the business's day");
    eq(pr("today", { now: Date.parse("2026-10-14T14:30:00Z") }), ["2026-10-15", "2026-10-15"], "… 01:30 in Sydney is already the 15th (UTC still says the 14th)");
    eq(pr("yesterday"), ["2026-10-14", "2026-10-14"], "yesterday");
    eq(pr("this_week"), ["2026-10-11", "2026-10-17"], "this_week: Sunday to Saturday when no week start is saved");
    const MON = { region: { timeZone: SYD, weeks: [{ weekStart: 1, from: "2026-01-05" }] } };
    eq(pr("this_week", { cat: MON }), ["2026-10-12", "2026-10-18"], "this_week: the business's week (Monday start)");
    eq(pr("last_week", { cat: MON }), ["2026-10-05", "2026-10-11"], "last_week: the business's week before");
    eq(pr("this_month"), ["2026-10-01", "2026-10-31"], "this_month");
    eq(pr("last_month"), ["2026-09-01", "2026-09-30"], "last_month");
    eq(pr("last_month", { now: Date.parse("2026-03-10T02:00:00Z") }), ["2026-02-01", "2026-02-28"], "last_month in March: February");
    eq(pr("last_7_days"), ["2026-10-09", "2026-10-15"], "last_7_days ends today");
    eq(pr("last_30_days"), ["2026-09-16", "2026-10-15"], "last_30_days");
    eq(pr("this_year"), ["2026-01-01", "2026-12-31"], "this_year");
    eq(pr("next_7_days"), ["2026-10-15", "2026-10-21"], "next_7_days starts today");
    eq(pr("next_30_days"), ["2026-10-15", "2026-11-13"], "next_30_days");
    // daylight saving starts in Sydney on 4 Oct 2026 (02:00 → 03:00): the day is 23 hours long
    let r = periodRange({ period: "today" }, CAT8, SYD, Date.parse("2026-10-04T05:00:00Z"), "today");
    eq([r.from, r.fromIso, r.toIso], ["2026-10-04", "2026-10-03T14:00:00.000Z", "2026-10-04T13:00:00.000Z"], "Sydney across the change to daylight saving: [midnight, next midnight)");
    // and ends in New York on 1 Nov 2026 (02:00 → 01:00): 25 hours
    r = periodRange({ period: "today" }, { region: { timeZone: "America/New_York" } }, "America/New_York", Date.parse("2026-11-01T17:00:00Z"), "today");
    eq([r.from, r.fromIso, r.toIso], ["2026-11-01", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"], "New York across the end of daylight saving");
    r = periodRange({ from: "2026-10-01", to: "2026-10-03" }, CAT8, SYD, NOW8, "today");
    eq([r.from, r.to, r.label, r.toIso], ["2026-10-01", "2026-10-03", "2026-10-01 to 2026-10-03", "2026-10-03T14:00:00.000Z"], "from / to: days in the zone, half-open");
    eq(periodRange({}, CAT8, SYD, NOW8, "last_30_days").label, "last_30_days", "nothing given = the tool's default period");
    const err = (x: any) => { try { periodRange(x, CAT8, SYD, NOW8, "today"); return ""; } catch (e) { return (e as Error).message; } };
    eq(err({ period: "today", from: "2026-10-01" }), "Give either period or from / to, not both.", "period and from → invalid");
    eq(err({ from: "2025-01-01", to: "2026-10-01" }), "Pick a range of at most 366 days.", "more than 366 days → invalid");
    eq(err({ from: "2026-10-05", to: "2026-10-01" }), "'from' must be on or before 'to'.", "from after to → invalid");
    eq(readCheck({ period: "today", to: "2026-10-01" }), "Give either period or from / to, not both.", "check(): both kinds of period");
    eq([readCheck({ limit: 26 }), readCheck({ limit: 0 }), readCheck({ limit: 25 })], ["limit must be 1 to 25.", "limit must be 1 to 25.", null], "check(): limit 1–25");
    eq([readCheck({ days: 32 }), readCheck({ query: "x".repeat(81) })], ["days must be 1 to 31.", "query must be at most 80 characters."], "check(): days and lengths");
  }

  // ── 3. leads ──
  {
    const db = fakeDb(SEED());
    let out = await run("find_leads", VA8, { query: "0491570006" }, db);
    eq(out.rows.map((r: any) => r.name), ["Demo Lead"], "find_leads by phone (any spacing)");
    eq(Object.keys(out.rows[0]), ["id", "name", "phone", "stage", "source", "service", "createdOn", "nextFollowUp", "bookedFor"], "… only the listed fields: no email, values or notes");
    eq([out.rows[0].stage, out.rows[0].createdOn], ["New lead", "2026-10-15"], "… the stage's label and the business's day");
    eq((await run("find_leads", VA8, { query: "2150" }, db)).rows.map((r: any) => r.name), ["Quinn Quoted"], "find_leads by postcode");
    eq((await run("find_leads", VA8, { stage: "quoted" }, db)).rows.map((r: any) => r.name), ["Quinn Quoted"], "find_leads by stage (label, any case)");
    eq((await run("find_leads", VA8, { source: "google" }, db)).rows.map((r: any) => r.name), ["Demo Lead", "Wanda Won", "Bob Booked"], "find_leads by source: contains-match (Google Ads + Google Maps), newest first");
    eq((await run("find_leads", VA8, { period: "last_month" }, db)).rows.map((r: any) => r.name), ["Old Lead"], "find_leads in a period (the business's days)");
    eq((await run("find_leads", VA8, { stage: "nope" }, db)).error.startsWith("No stage matches that."), true, "an unknown stage → invalid, with the list");
    out = await run("find_leads", VA8, { limit: 3 }, db);
    eq([out.count, out.rows.length, out.truncated, Object.keys(out)[0]], [3, 3, true, "count"], "limit: 3 of 5, truncated, count first");
    out = await run("count_leads", VA8, {}, db);
    eq(out, { total: 4, from: "2026-10-01", to: "2026-10-31", groups: [{ key: "Google Ads", label: "Google Ads", count: 2 }, { key: "Google Maps", label: "Google Maps", count: 1 }, { key: "Meta Ads", label: "Meta Ads", count: 1 }], truncated: false },
      "count_leads: this month by source (00:30 on 1 Oct in Sydney counts; 23:30 on 30 Sep doesn't)");
    eq((await run("count_leads", VA8, { period: "last_month" }, db)).total, 1, "count_leads last month: the lead from 23:30 on 30 Sep");
    eq((await run("count_leads", VA8, { group_by: "stage" }, db)).groups.map((g: any) => [g.label, g.count]), [["Booked", 1], ["New lead", 1], ["Quoted", 1], ["Won", 1]], "group_by stage: the stages' labels");
    eq((await run("count_leads", VA8, { group_by: "day", period: "this_year" }, db)).groups.map((g: any) => g.key), ["2026-09-30", "2026-10-01", "2026-10-10", "2026-10-15"], "group_by day: chronological, business days");
    eq((await run("count_leads", VA8, { group_by: "week", period: "this_year" }, db)).groups.map((g: any) => [g.key, g.count]), [["2026-09-27", 3], ["2026-10-04", 1], ["2026-10-11", 1]], "group_by week: the business week's first day");
    eq((await run("count_leads", VA8, { group_by: "service", source: "google" }, db)).groups.map((g: any) => [g.key, g.count]), [["Aircon", 2], ["Pressure Washing", 1]], "group_by service, only Google sources");
    const many = fakeDb({ ...SEED(), contacts: Array.from({ length: 25 }, (_, i) => ({ id: UID(100 + i), full_name: "L" + i, status: "New", source: "Src" + String(i).padStart(2, "0"), division: "Aircon", created_at: "2026-10-05T00:00:00Z" })) });
    out = await run("count_leads", OW, {}, many);
    eq([out.total, out.groups.length, out.groups[19]], [25, 20, { key: "other", label: "Other", count: 6 }], "more than 20 groups: 19 + the rest as other");
    // limit / truncation under the free AI's cap: rows dropped from the end until it fits
    const long = fakeDb({ ...SEED(), contacts: Array.from({ length: 25 }, (_, i) => ({ id: UID(200 + i), full_name: "Long name " + "x".repeat(400) + i, phone: "0400 000 0" + String(i).padStart(2, "0"), status: "New", source: "Organic", division: "Aircon", created_at: `2026-10-0${1 + (i % 9)}T00:00:00Z` })) });
    out = await run("find_leads", OW, { limit: 25 }, long, { chars: FREE_TOOL_RESULT_CHARS });
    ok(JSON.stringify(out).length <= FREE_TOOL_RESULT_CHARS * 0.9 && out.rows.length < 25 && out.rows.length > 5 && out.truncated && out.count === out.rows.length, `fitRows: ${out.rows.length} rows fit under the free cap, truncated, count follows`);
    out = await run("find_leads", OW, { limit: 25 }, long);
    eq([out.rows.length, out.truncated], [25, false], "… the same read under the paid cap: all 25");
    const fit = fitRows({ count: 3, rows: ["a".repeat(50), "b".repeat(50), "c".repeat(50)], truncated: false }, "rows", { resultChars: 150 });
    eq([fit.count, fit.rows.length, fit.truncated], [1, 1, true], "fitRows: drops from the end, sets truncated");
  }

  // ── 4. calls ──
  {
    const db = fakeDb(SEED());
    let out = await run("count_calls", OW, {}, db);
    eq(out, { total: 4, answered: 1, missed: 3, missedNotCalledBack: 2, bySource: [{ source: "Google Ads", count: 2 }, { source: "(no lead)", count: 1 }, { source: "Meta Ads", count: 1 }], from: "2026-09-16", to: "2026-10-15",
      adCalls: { total: 2, answered: 1, missed: 1, over30s: 1 }, truncated: false }, "count_calls (owner): the last 30 days, by the lead's source, and the Google Ads calls");
    out = await run("count_calls", OW, { source: "google" }, db);
    eq([out.total, out.missed, !!out.adCalls], [2, 1, true], "source google: only those leads' calls, plus the Google Ads calls (said separately)");
    out = await run("count_calls", OW, { source: "meta" }, db);
    eq([out.total, "adCalls" in out], [1, false], "source meta: no Google Ads calls");
    out = await run("count_calls", VA8, {}, db);
    eq([out.total, "adCalls" in out], [4, false], "va: the calls, never the Google Ads calls (owners and managers only)");
  }

  // ── 5. jobs: a technician gets only his own, never money ──
  {
    const db = fakeDb(SEED());
    let out = await run("list_jobs", OW, {}, db);
    eq(out.rows.map((r: any) => r.id), ["j1", "j2"], "owner: the last 7 days, newest first");
    eq(out.rows[0], { id: "j1", date: "2026-10-14", customerName: "Demo Lead", jobType: "Aircon", technician: "Tia", amount: 200, total: 220, paymentStatus: "Paid", commission: jobCommissionAmount(await calcFor(ctxFor(OW, db)), jobFromRow(db.T.jobs[0])) }, "owner: amount, total, payment status, commission");
    eq((await run("list_jobs", OW, { unpaid_only: true, period: "this_month" }, db)).rows.map((r: any) => r.id), ["j4", "j3", "j2", "j7"], "unpaid_only: no status or not Paid");
    eq((await run("list_jobs", OW, { technician: "gabe", period: "this_month" }, db)).rows.map((r: any) => r.id), ["j4", "j2", "j7"], "owner: one technician's jobs (any case)");
    out = await run("list_jobs", VA8, {}, db);
    eq(out.rows.map((r: any) => Object.keys(r).join()), ["id,date,customerName,jobType,technician,paymentStatus", "id,date,customerName,jobType,technician,paymentStatus"], "va: payment status, no amounts");
    ok(!keysDeep(out).some((k) => /amount|total|gst|commission|cost|spend/i.test(k)), "va: no amount keys anywhere");
    eq((await run("list_jobs", VA8, { unpaid_only: true }, db)).error, "unpaid_only is for owners and managers.", "va: unpaid_only refused");
    out = await run("list_jobs", TE, { period: "this_month" }, db);
    eq(out.rows.map((r: any) => r.id), ["j3", "j1", "j6"], "technician: only his own jobs (the fake returns every row: the block's rule)");
    ok(!keysDeep(out).some((k) => MONEY_KEY.test(k)), "technician: no money keys anywhere (amount, total, gst, commission, cost, spend, pay)");
    eq((await run("list_jobs", TE, { technician: "Gabe" }, db)).error, "A technician sees only his own jobs: leave technician out.", "technician: can't ask for someone else's jobs");
    eq(await run("list_jobs", TN, { period: "this_year" }, db), { count: 0, rows: [], truncated: false }, "technician without technician_name: no jobs (block rule b)");
    out = await run("upcoming_work", TE, {}, db);
    eq(out, { next: { day: "2026-10-15", kind: "task", title: "Call supplier" }, items: [{ day: "2026-10-15", kind: "task", title: "Call supplier" }, { day: "2026-10-16", kind: "job", title: "Chimney – Future Fran", technician: "Tia" }], days: 7, truncated: false },
      "upcoming_work (technician): his own job and his own open task; no bookings, nobody else's");
    ok(!keysDeep(out).some((k) => MONEY_KEY.test(k)), "upcoming_work (technician): no money keys");
    out = await run("upcoming_work", OW, { days: 7 }, db);
    eq(out.items.map((x: any) => [x.day, x.kind, x.title]), [["2026-10-16", "job", "Chimney – Future Fran"], ["2026-10-17", "booking", "Bob Booked – Aircon"], ["2026-10-20", "job", "Aircon – Gary Later"]], "upcoming_work (owner): jobs and booked leads by day");
    eq(Object.keys(out)[0], "next", "… next first");
    eq((await run("upcoming_work", OW, {}, fakeDb({}))).next, null, "nothing recorded → next: null");
    eq((await run("upcoming_work", TN, {}, db)).items.map((x: any) => x.kind), [], "technician without technician_name: nothing (no jobs, no own tasks)");
    eq((await run("upcoming_work", VA8, { days: 3 }, db)).items.map((x: any) => [x.kind, x.title]), [["job", "Chimney – Future Fran"], ["booking", "Bob Booked – Aircon"]], "va: jobs and bookings in 3 days");
  }

  // ── 6. money and payroll: owners and managers; the numbers are mcp's calc ──
  {
    const db = fakeDb(SEED());
    const out = await run("money_summary", MG, {}, db);
    eq(Object.keys(out).slice(0, 3), ["remainingAfterTech", "paidTotal", "unpaidTotal"], "money_summary: the answer first");
    eq([out.jobsCount, out.cash, out.bankTransfer, out.gst, out.paidTotal, out.unpaidTotal, out.equipmentTotal, out.partsTotal, out.adSpend, out.currency, out.from, out.to], [6, 220, 110, 30, 300, 930, 90, 50, 120, "AUD", "2026-10-01", "2026-10-31"], "money_summary this month (hand-checked)");
    // parity: mcp's money_summary = moneyOverview over calcCtx (the shared block), on the same rows
    const d: any = { gstRate: 10, catalog: CAT8, tz: SYD, today: "2026-10-15", paidKey: "Paid", employees: SEED().employees.map(employeeFromRow), rules: weekRules(undefined), weekCache: new Map() };
    const m = moneyOverview(d, SEED().jobs.filter((j) => j.date >= "2026-10-01" && j.date <= "2026-10-31").map(jobFromRow), SEED().equipment_spend.map(equipFromRow));
    eq([out.remainingAfterTech, out.commissionOwedTotal, out.remainingAfterTechAndAds], [round2(m.remainingAfterTech), round2(m.overview.commissionOwedTotal), round2(m.remainingAfterTech - 120)], "money_summary totals = mcp's calc on the same fixture");
    const pay = await run("payroll_summary", OW, {}, db);
    eq([pay.weekStart, pay.weekEnd, pay.currency], ["2026-10-04", "2026-10-10", "AUD"], "payroll_summary: last business week by default");
    const want = (name: string) => round2(computePayrollCommission({ ...d, jobs: SEED().jobs.map(jobFromRow), equipmentSpend: SEED().equipment_spend.map(equipFromRow), payrollWeeks: SEED().payroll_weeks.map(payrollFromRow), payrollBonuses: [], salesLogs: SEED().sales_daily_log.map(salesLogFromRow) }, name, "2026-10-04").grandTotal);
    eq(pay.people.map((p: any) => [p.person, p.type, p.paid]), [["Gabe", "commission", false], ["Tia", "commission", true], ["Hana Hours", "hourly", false]], "people: commission and hourly, and who is marked paid");
    eq(pay.people.find((p: any) => p.person === "Hana Hours").total, 50, "hourly: 5 hours × the default rate");
    eq(pay.people.find((p: any) => p.person === "Tia").total, want("Tia"), "commission: the shared calc's grand total");
    eq(pay.total, round2(pay.people.reduce((n: number, p: any) => n + p.total, 0)), "total = the people's totals");
    eq((await run("payroll_summary", OW, { person: "han" }, db)).people.map((p: any) => p.person), ["Hana Hours"], "person: a part of the name");
  }

  // ── 7. tasks and reminders ──
  {
    const db = fakeDb(SEED());
    let out = await run("list_tasks", OW, {}, db);
    eq(out.rows.map((t: any) => t.id), ["t2", "t1", "t3", "t4", "t5"], "owner: every task, earliest due first, no due date last");
    eq(out.rows[0], { id: "t2", title: "Office filing", board: "Office Tasks", status: "In Progress", due: "2026-10-14", priority: "", assignees: ["Vera Vance"] }, "the board's label (the office's name), only the listed fields");
    eq((await run("list_tasks", OW, { due: "overdue" }, db)).rows.map((t: any) => t.id), ["t2"], "due overdue: before today, not done");
    eq((await run("list_tasks", OW, { due: "none" }, db)).rows.map((t: any) => t.id), ["t5"], "due none");
    out = await run("list_tasks", OW, { status: "open", limit: 2 }, db);
    eq([out.count, out.rows.map((t: any) => t.id), out.truncated], [2, ["t2", "t1"], true], "open (not done), limit 2: truncated");
    eq((await run("list_tasks", TE, {}, db)).rows.map((t: any) => t.id), ["t1", "t3"], "technician: his own tasks by default (mine)");
    eq((await run("list_tasks", TE, { mine: false }, db)).rows.map((t: any) => t.id), ["t1", "t3"], "technician, mine false: still only what the block lets him see (his board)");
    eq((await run("list_tasks", VA8, { mine: true }, db)).rows.map((t: any) => t.id), ["t2"], "va, mine: assigned to her");
    out = await run("list_reminders", OW, {}, db);
    eq(out, { count: 4, rows: [
      { type: "refund", date: "2026-10-01", title: "Parts refund pending for Gabe", overdueDays: 14 }, { type: "equipment", date: "2026-10-03", title: "Equipment reimbursement pending for Tia", overdueDays: 12 },
      { type: "refund", date: "2026-10-14", title: "Parts refund pending for Tia", overdueDays: 1 }, { type: "followup", date: "2026-10-14", title: "Call back Quinn", overdueDays: 1 },
    ], truncated: false, notIncluded: ["pay", "documents", "insurance"] }, "list_reminders (owner): refunds, equipment, due follow-ups, oldest first");
    const dis = fakeDb({ ...SEED(), dismissed_reminders: [{ key: "refund:j7" }] });
    eq((await run("list_reminders", OW, {}, dis)).count, 3, "a dismissed reminder is left out");
    out = await run("list_reminders", TE, {}, db);
    eq(out.rows.map((r: any) => r.title), ["Equipment reimbursement pending for Tia", "Parts refund pending for Tia"], "technician: only his own refund / equipment, no follow-ups");
    ok(!keysDeep(out).some((k) => MONEY_KEY.test(k)), "technician's reminders: no amounts");
    ok(!keysDeep(await run("list_tasks", TE, {}, db)).some((k) => MONEY_KEY.test(k)), "technician's tasks: no money keys");
  }

  // ── 8. settings ──
  {
    const db = fakeDb({ ...SEED(), settings: [{ id: 1, company_name: "Acme Home Services", catalog: { region: { timeZone: SYD, weeks: [{ weekStart: 1, from: "2026-01-05" }] }, business: { shortName: "Acme", website: "https://acme.example" } } }] });
    eq(await run("read_settings", TE, { section: "region" }, db), { timeZone: SYD, currency: "AUD", country: "AU", state: "NSW", taxName: "GST", weekStartsOn: "monday" }, "region: zone, currency, tax, the business's week start");
    eq(await run("read_settings", MK, { section: "business" }, db), { name: "Acme Home Services", shortName: "Acme", website: "https://acme.example" }, "business: name, short name, website");
    eq((await run("read_settings", TE, { section: "pipeline" }, db)).error, "Not allowed for your role.", "technician: no pipeline");
    eq((await run("read_settings", MK, { section: "lead_sources" }, db)).error, "Not allowed for your role.", "marketing (Google Ads only): no lead sources");
    const pipe = await run("read_settings", VA8, { section: "pipeline" }, db);
    eq([pipe.stages.map((s: any) => s.key), pipe.needDate, pipe.lostReasons.length > 0], [["New", "Chasing", "Quoted", "Follow-up", "Booked", "Won", "Lost"], ["Quoted", "Follow-up"], true], "pipeline: stages, which need a date, lost reasons");
    eq((await run("read_settings", MKO, { section: "services" }, db)).services.map((s: any) => s.key), ["Aircon", "Chimney", "Pressure Washing", "Other"], "services (Leads & Marketing)");
  }

  // ── 9. the loop: a forced call is refused, a result fits the free cap, whoami lists the tools ──
  {
    const db = fakeDb(SEED());
    const before = io.userClient;
    io.userClient = () => db;
    const turn = (p: any, keySource = "free") => ({ me: P(p), biz: { companyName: "", catalog: CAT8, tz: SYD, gstRate: 10 }, s: normSettings(AI_ROW()), jwt: "jwt-x", sb: db, conv: { id: "c" }, mode: MODES.assistant, source: { keySource } });
    const forced = async (p: any, name: string, input: any = {}, ks = "free") => {
      const meta = { tools: [] as any[], proposals: [], cards: [] };
      const res = await runTools(turn(p, ks) as any, [{ id: "u1", name, input }], undefined, Object.values(TOOLS), 0, meta, () => {});
      return res[0];
    };
    for (const n of ["money_summary", "payroll_summary"]) eq([(await forced(TE, n)).content, (await forced(TE, n)).is_error], ["Not allowed for your role", true], `technician forcing ${n}: "Not allowed for your role"`);
    for (const n of ["find_leads", "count_calls", "list_jobs"]) eq((await forced(MK, n)).content, "Not allowed for your role", `marketing forcing ${n}: refused`);
    eq((await forced(VA8, "money_summary")).content, "Not allowed for your role", "va forcing money_summary: refused");
    const res = await forced(OW, "count_leads", {});
    ok(!res.is_error && res.content.length <= FREE_TOOL_RESULT_CHARS && res.content.startsWith('{"total":4'), "an owner's count_leads through the loop (free AI): fits, headline first");
    const w = JSON.parse((await forced(TE, "whoami")).content);
    eq(w.tools, toolsFor("assistant", P(TE)).map((t) => t.name), "whoami.tools: what this person can use");
    // the test provider's line shows the headline (the staging check reads it)
    const wdb = world({}, { contacts: SEED().contacts.map((c) => ({ ...c, created_at: "2026-10-15T12:00:00Z" })) });
    io.userClient = () => wdb;
    const r = await chat(wdb, { text: "[mock:tool count_leads {}]" });
    ok(evs(r, "text").map((t: any) => t.delta).join("").includes('— {"total":5,'), "the mock reply quotes the headline (total first)");
    io.userClient = before;
  }
});
