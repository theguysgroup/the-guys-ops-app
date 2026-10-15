// Tests for the change pipeline (stage 6 G2): the four change kinds, confirm / cancel / undo / list_changes, the read
// tools' G2 fields and the test provider's change scripts. Appended to tests.ts by run_tests.sh; it only pushes suites
// (tests.ts runs them before its summary), so it shares tests.ts's helpers (fakeDb, eq, ok, chat, manage, …) and APP.
// deno-lint-ignore-file no-explicit-any

SUITES.push(async () => {
  const G1_USER_CLIENT = io.userClient;
  const clone = (v: any) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const canon = (v: any): string => JSON.stringify(v ?? null, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
  const jeq = (a: any, b: any) => canon(a ?? null) === canon(b ?? null);
  const UID = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  // ── people, leads, jobs, employees ──
  const VA = { id: "u-va", full_name: "Vera Vance", role: "va", permissions: { crm: true, tasks: true }, technician_name: null };
  const MKT = { id: "u-mkt", full_name: "Mia Marketing", role: "marketing", permissions: {}, technician_name: null };
  const TECHX = { id: "u-techx", full_name: "Tom Noboard", role: "technician", permissions: { tasks: true }, technician_name: null };
  const OVA = { id: "u-ova", full_name: "Kim Lane", role: "va", permissions: { crm: true, tasks: true }, technician_name: "KL" };
  const JWTS: Record<string, string> = { "jwt-owner": "u-owner", "jwt-owner2": "u-owner2", "jwt-manager": "u-manager", "jwt-tech": "u-tech", "jwt-va": "u-va", "jwt-mkt": "u-mkt", "jwt-techx": "u-techx" };
  const lead = (n: number, over: any) => ({
    id: UID(n), full_name: "", phone: "", email: `lead${n}@example.com`, status: "New", stage_changed_at: null, next_follow_up: null, chasing_since: null,
    chase_alert_done: false, chase_round: 0, lost_reason: "", booked_for: null, reopened_at: null, contacted_at: null, created_at: "2026-10-15T15:00:00.000Z",
    messages: [{ id: "m" + n, kind: "in", text: "Hi, I need a quote", at: "2026-10-15T15:00:00.000Z" }], customer_notes: [], notes: "private office notes", ...over,
  });
  const LEADS = () => [
    lead(1, { full_name: "Demo Lead", phone: "0491 570 006", customer_notes: [{ id: "n0", text: "Old note", by: "Max Manager", at: "2026-10-15T15:10:00.000Z" }] }),
    lead(2, { full_name: "Quinn Quoted", status: "Quoted", stage_changed_at: "2026-10-10T00:00:00.000Z", next_follow_up: "2026-10-20", contacted_at: "2026-10-15T15:30:00.000Z" }),
    lead(3, { full_name: "Wanda Won", status: "Won" }),
    lead(4, { full_name: "Jack Job" }),
    lead(5, { full_name: "Nora Name", status: "Chasing", chasing_since: "2026-10-12T00:00:00.000Z", chase_round: 2 }),
    lead(6, { full_name: "Rita Return", reopened_at: "2026-10-10T00:00:00.000Z" }),
    lead(7, { full_name: "Ann Alpha", created_at: "2026-10-14T15:00:00.000Z" }),
    lead(8, { full_name: "Ann Beta", status: "Lost", lost_reason: "spam", created_at: "2026-10-13T15:00:00.000Z" }),
    lead(9, { full_name: "Hidden Hal", hidden: true }),
  ];
  const JOBS = () => [
    { id: "j1", contact_id: UID(4), customer_name: "J. Job", date: "2026-10-01" },
    { id: "j2", contact_id: null, customer_name: "  nora NAME ", date: "2026-09-01" },
    { id: "j3", contact_id: UID(6), customer_name: "Rita Return", date: "2026-01-05" },
  ];
  const EMPLOYEES = () => [
    { name: "Gabe Tech", status: "Active", roles: ["Technician"] }, { name: "Kim Lane", status: "Active", roles: ["VA"] },
    { name: "Sam Lee", status: "Active", roles: [] }, { name: "Sam Park", status: "Active", roles: [] }, { name: "Olivia Owner", status: "Active", roles: [] },
    { name: "Vera Vance", status: "Active", roles: [] }, { name: "Tia", status: "Active", roles: ["Technician"] }, { name: "Old Timer", status: "Inactive", roles: [] },
    { name: "Desk Helper", status: "Active", roles: ["VA"] },
  ];
  const CAT2 = { region: { timeZone: TZ }, branding: { appName: "Acme Ops" }, labels: { office: "Front Desk" } };   // hours never saved

  // ── the database's row-level security, as the tests assume the live rules (contacts: CRM; tasks: Tasks, a technician
  // only on his own board; settings: owners change) ──
  const isOM = (u: any) => u.role === "owner" || u.role === "manager";
  const DENY = new Set<string>();   // "table.op" switched off for a test
  const RLS = {
    select: (t: string, r: any, u: any) => !DENY.has(t + ".select") && (t === "contacts" ? (isOM(u) || !!u.permissions.crm || !!u.permissions.crmOverview) && !(r.hidden && u.role !== "owner") : t === "tasks" ? isOM(u) || !!u.permissions.tasks : true),
    update: (t: string, r: any, u: any) => !DENY.has(t + ".update") && (t === "settings" ? u.role === "owner" : t === "contacts" ? isOM(u) || !!u.permissions.crm : t === "tasks" ? isOM(u) || (!!u.permissions.tasks && (u.role !== "technician" || r.board === u.technician_name)) : false),
    insert: (t: string, r: any, u: any) => !DENY.has(t + ".insert") && (t === "activity_log" ? true : t === "tasks" ? isOM(u) || (!!u.permissions.tasks && (u.role !== "technician" || r.board === u.technician_name)) : false),
    delete: (t: string, r: any, u: any) => !DENY.has(t + ".delete") && (t === "tasks" ? isOM(u) || (!!u.permissions.tasks && (u.role !== "technician" || r.board === u.technician_name)) : false),
  };
  const CONTACT_OK = ["status", "stage_changed_at", "next_follow_up", "chasing_since", "chase_alert_done", "chase_round", "lost_reason", "booked_for", "contacted_at"];
  const TASK_OK = ["title", "status", "due", "board", "assignees", "priority", "notes", "subtasks", "updates", "contact_id", "heads_up"];
  // The three compare-and-set functions of the SQL section G2-changes, as plain code (SECURITY INVOKER: the row is
  // locked only when the person can see AND update it).
  function casRpc(db: any, u: any, name: string, a: any) {
    const T = db.T, res = (data: any) => ({ data, error: null }), err = (message: string) => ({ data: null, error: { message } });
    if (name === "ai_catalog_cas") {
      if (a.p_section !== "hours") return err(`ai_catalog_cas: ${a.p_section} is not a section the assistant changes`);
      const row = (T.settings || []).find((r: any) => r.id === 1);
      if (!row || !u || !RLS.select("settings", row, u) || !RLS.update("settings", row, u)) return res({ ok: false, code: "denied" });
      const cur = row.catalog && row.catalog.hours !== undefined ? row.catalog.hours : null;
      if (!jeq(cur, a.p_expected)) return res({ ok: false, code: "changed", now: clone(cur) });
      row.catalog = { ...(row.catalog || {}) };
      if (a.p_value === null || a.p_value === undefined) delete row.catalog.hours; else row.catalog.hours = clone(a.p_value);
      return res({ ok: true, value: clone(a.p_value ?? null) });
    }
    if (name === "ai_contact_cas") {
      for (const k of Object.keys({ ...(a.p_patch || {}), ...(a.p_expected || {}) })) if (!CONTACT_OK.includes(k)) return err(`ai_contact_cas: ${k} is not a field the assistant changes`);
      const row = (T.contacts || []).find((r: any) => r.id === a.p_id);
      if (!row || !u || !RLS.select("contacts", row, u) || !RLS.update("contacts", row, u)) return res({ ok: false, code: "gone" });
      for (const [k, v] of Object.entries(a.p_expected || {})) if (!jeq(row[k], v)) return res({ ok: false, code: "changed", field: k, now: clone(row[k] ?? null) });
      const notes = Array.isArray(row.customer_notes) ? row.customer_notes : [];
      if (a.p_note_remove && !notes.some((n: any) => jeq(n, a.p_note_remove))) return res({ ok: false, code: "changed", field: "customer_notes" });
      Object.assign(row, clone(a.p_patch || {}));
      if (a.p_event) row.messages = [...(Array.isArray(row.messages) ? row.messages : []), clone(a.p_event)];
      if (a.p_note_add) row.customer_notes = [...notes, clone(a.p_note_add)];
      else if (a.p_note_remove) row.customer_notes = notes.filter((n: any) => !jeq(n, a.p_note_remove));
      const out: any = { id: row.id }; for (const k of CONTACT_OK) out[k] = clone(row[k] ?? null);
      return res({ ok: true, row: out });
    }
    if (name === "ai_task_delete_cas") {
      for (const k of Object.keys(a.p_expected || {})) if (!TASK_OK.includes(k)) return err(`ai_task_delete_cas: ${k} is not a compared field`);
      const row = (T.tasks || []).find((r: any) => r.id === a.p_id);
      if (!row || !u || !RLS.select("tasks", row, u) || !RLS.update("tasks", row, u)) return res({ ok: false, code: "gone" });
      for (const [k, v] of Object.entries(a.p_expected || {})) if (!jeq(row[k], v)) return res({ ok: false, code: "changed", field: k, now: clone(row[k] ?? null) });
      if (!RLS.delete("tasks", row, u)) return res({ ok: false, code: "denied" });
      T.tasks = T.tasks.filter((r: any) => r !== row);
      return res({ ok: true });
    }
    return err("no such function");
  }
  const UW: string[] = [];   // writes made with a person's own client ("table.op" / "rpc:name")
  const UJ: string[] = [];   // the tokens those clients were made with
  function fakeUserClient(jwt: string) {
    UJ.push(jwt);
    const db = CUR, u = (db.T.profiles || []).find((p: any) => p.id === JWTS[jwt]);
    return {
      __jwt: jwt,
      from(t: string) {
        const b = db.from(t).where((r: any) => !!u && RLS.select(t, r, u));
        let denied = false;
        const ins = b.insert, upd = b.update, del = b.delete, then = b.then;
        b.insert = (p: any) => { UW.push(t + ".insert"); if (!u || !(Array.isArray(p) ? p : [p]).every((r: any) => RLS.insert(t, r, u))) denied = true; return ins(p); };
        b.update = (p: any) => { UW.push(t + ".update"); b.where((r: any) => RLS.update(t, r, u)); return upd(p); };
        b.delete = () => { UW.push(t + ".delete"); b.where((r: any) => RLS.delete(t, r, u)); return del(); };
        b.then = (ok2: any, no: any) => (denied ? Promise.resolve({ data: null, error: { code: "42501", message: `new row violates row-level security policy for table "${t}"` } }).then(ok2, no) : then(ok2, no));
        return b;
      },
      rpc: async (name: string, a: any) => { UW.push("rpc:" + name); return casRpc(db, u, name, a); },
    };
  }
  // What the service client wrote (every write minus the person's own ones).
  const serviceWrites = (db: any) => {
    const left = UW.filter((w) => !w.startsWith("rpc:"));
    return db.ctl.writes.filter((w: string) => { const i = left.indexOf(w); if (i >= 0) { left.splice(i, 1); return false; } return true; });
  };
  const onlyAiWrites = (db: any) => serviceWrites(db).every((w: string) => /^ai_/.test(w));
  function world2(o: { ai?: any; catalog?: any; seed?: Record<string, any[]> } = {}) {
    NOW = T0; UW.length = 0; UJ.length = 0; DENY.clear();
    const db = fakeDb({
      profiles: [OWNER, OWNER2, MANAGER, TECH, VA, MKT, TECHX, OVA].map(clone),
      settings: [{ id: 1, company_name: "Acme Home Services", catalog: clone(o.catalog ?? CAT2) }],
      ai_settings: [{ ...AI_ROW(), ...(o.ai || {}) }],
      ai_usage: [], ai_conversations: [], ai_messages: [], ai_changes: [], activity_log: [], tasks: [], contacts: LEADS(), jobs: JOBS(), employees: EMPLOYEES(),
      app_keys: [{ name: "vapid", value: { publicKey: "pk", privateKey: "sk" } }], push_subscriptions: [],
      ...(o.seed || {}),
    }, { jwts: JWTS });
    CUR = db;
    return db;
  }
  io.userClient = (jwt: string) => fakeUserClient(jwt);
  const toolCall = (db: any, jwt: string, tool: string, input: any) => chat(db, { text: `[mock:tool ${tool} ${JSON.stringify(input)}]` }, jwt);
  // The first tool_result of a chat (the change tool's answer to the model).
  const resultOf = (db: any, r: any) => {
    const rows = msgs(db, convOf(r)), tr = rows.find((m: any) => m.role === "user" && Array.isArray(m.content) && m.content[0] && m.content[0].type === "tool_result");
    return tr ? tr.content[0] : null;
  };
  const errText = (db: any, r: any) => { const b = resultOf(db, r); return b && b.is_error ? String(b.content) : ""; };
  const lastChange = (db: any) => db.T.ai_changes[db.T.ai_changes.length - 1];
  const contact = (db: any, n: number) => db.T.contacts.find((c: any) => c.id === UID(n));
  const acts = (db: any) => db.T.activity_log.map((a: any) => a.text);
  const proposeOk = async (db: any, jwt: string, tool: string, input: any) => {
    const r = await toolCall(db, jwt, tool, input);
    const e = errText(db, r);
    if (e) console.log("  (unexpected tool error: " + e + ")");
    return { r, row: lastChange(db) };
  };
  const confirm = (db: any, id: string, jwt: string) => manage(db, { step: "confirm_change", id }, jwt);
  const undo = (db: any, id: string, jwt: string) => manage(db, { step: "undo_change", id }, jwt);
  const P = (x: any) => appProfile(x);

  // ── 1. registry ──
  {
    const g2 = ["change_office_hours", "add_task", "move_lead_stage", "add_lead_note"];
    eq(Object.keys(CHANGE_KINDS).filter((k) => !k.startsWith("test_")), ["office_hours", "task_add", "lead_stage", "lead_note"], "G2 change kinds");
    for (const n of g2) {
      const t = TOOLS[n];
      eq([t.kind, t.modes, strictSchemaProblems(t.input_schema)], ["change", ["assistant"], []], `${n}: a change tool of the assistant mode with a strict schema`);
      const s = JSON.stringify(t.input_schema);
      ok(!/"(minimum|maximum|minLength|maxLength|pattern|minItems|maxItems)"/.test(s), `${n}: no length / range / pattern keywords`);
      ok(/Nothing changes until the person presses Confirm/.test(t.description) && /never say it is done/.test(t.description), `${n}: the description says it only proposes`);
      ok(!/\d{4}-\d{2}|Olivia|Acme|Demo Lead/.test(t.description), `${n}: the description holds no dates or names (cache-stable)`);
    }
    eq(apiTools([TOOLS.add_task])[0].strict, true, "sent with strict: true");
    eq(TOOLS.change_office_hours.input_schema.properties.days.items.properties.day.enum, ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"], "office hours: the days as an enum");
  }

  // ── 2. which tools each role gets ──
  {
    const names = (p: any) => toolsFor("assistant", P(p)).map((t) => t.name);
    eq(names(OWNER), ["add_lead_note", "add_task", "change_office_hours", "move_lead_stage", "read_office_hours", "whoami"], "owner: all six");
    eq(names(MANAGER), ["add_lead_note", "add_task", "move_lead_stage", "read_office_hours", "whoami"], "manager: everything but office hours");
    eq(names(VA), names(MANAGER), "a VA with CRM + Tasks: the same as a manager");
    eq(names(TECH), ["add_task", "read_office_hours", "whoami"], "a technician with Tasks (no CRM): add_task and the reads");
    eq(names(TECHX), ["read_office_hours", "whoami"], "a technician without his own board: no add_task");
    eq(names(MKT), ["read_office_hours", "whoami"], "marketing: only the two read tools");
    eq(names({ ...VA, permissions: { crmOverview: true } }), ["read_office_hours", "whoami"], "Leads & Marketing alone is read-only");
  }

  // ── 3. a tool called without being offered (a scripted call) is refused; nothing is proposed ──
  {
    const db = world2();
    const r = await toolCall(db, "jwt-tech", "move_lead_stage", { lead: "Demo Lead", stage: "Quoted", follow_up: "2026-10-20" });
    eq([errText(db, r), db.T.ai_changes.length], ["Unknown tool move_lead_stage. Available: add_task, read_office_hours, whoami", 0], "a technician's move_lead_stage: not even offered → is_error, no row");
    const r2 = await toolCall(db, "jwt-mkt", "add_lead_note", { lead: "Demo Lead", text: "x" });
    ok(/^Unknown tool add_lead_note/.test(errText(db, r2)) && db.T.ai_changes.length === 0, "marketing's add_lead_note: refused, no row");
  }

  // ── 4. proposing writes nothing but the proposal ──
  {
    const cases: [string, any, string][] = [
      ["change_office_hours", { days: [{ day: "saturday", open: true, from: "09:00", to: "13:00" }] }, "office_hours"],
      ["add_task", { title: "Call the supplier", assignees: ["Gabe"], due: "2026-10-16" }, "task_add"],
      ["move_lead_stage", { lead: "Demo Lead", stage: "Quoted", follow_up: "2026-10-20" }, "lead_stage"],
      ["add_lead_note", { lead: "Demo Lead", text: "Prefers a morning visit" }, "lead_note"],
    ];
    for (const [tool, input, kind] of cases) {
      const db = world2();
      const before = clone({ s: db.T.settings, c: db.T.contacts, t: db.T.tasks, a: db.T.activity_log });
      const r = await toolCall(db, "jwt-owner", tool, input);
      const row = lastChange(db), res = resultOf(db, r);
      eq([db.T.ai_changes.length, row.kind, row.status, row.business_id, row.user_id, row.conversation_id], [1, kind, "proposed", "default", "u-owner", convOf(r)], `${kind}: one ai_changes row 'proposed'`);
      eq(UW, [], `${kind}: the person's client wrote nothing`);
      eq(serviceWrites(db).filter((w: string) => !/^ai_/.test(w)), [], `${kind}: the service client wrote nothing outside ai_*`);
      ok(jeq(before, { s: db.T.settings, c: db.T.contacts, t: db.T.tasks, a: db.T.activity_log }), `${kind}: settings, contacts, tasks and activity_log unchanged`);
      const out = JSON.parse(res.content);
      eq([res.is_error, out.proposed, out.change_id, out.status, Array.isArray(out.changes) && out.changes.length > 0], [undefined, true, row.id, "waiting_for_confirmation", true], `${kind}: the model is told it waits for a confirmation, with the rows`);
      eq(evs(r, "proposal")[0], { change: changeOut(row, P(OWNER)) }, `${kind}: the proposal event = changeOut(row)`);
      eq([evs(r, "proposal")[0].change.can_confirm, evs(r, "proposal")[0].change.can_undo], [true, false], `${kind}: the card can be confirmed`);
    }
  }

  // ── 5. at most three proposals per turn ──
  {
    const db = world2();
    const turn: any = {};
    const ctx: any = { me: P(OWNER), sb: db, conversationId: null, emit: () => {}, stepMeta: { proposals: [], cards: [] }, turn };
    const p = { kind: "lead_note", target: { table: "contacts", id: UID(1), label: "Demo Lead" }, before: null, after: { note: { id: "x", text: "t", by: "Olivia Owner", at: AT_CONFIRM } }, summary: "Add a note" };
    for (let i = 0; i < 3; i++) await proposeChange(ctx, p);
    let refused = "";
    try { await proposeChange(ctx, p); } catch (e) { refused = (e as Error).message; }
    eq([refused, db.T.ai_changes.length, turn.proposals], ["Too many changes in one go — ask for them one at a time.", 3, 3], "the 4th change in one turn → refused, no row");
  }

  // ── 6. office hours ──
  {
    const H = (cat: any, days: any) => { try { return officeHoursProposal(cat, days); } catch (e) { return (e as Error).message; } };
    eq(H({}, [{ day: "monday", open: true }, { day: "monday", open: false }]), "Monday is listed twice.", "office hours: a duplicate day");
    eq(H({}, [{ day: "monday", open: true, from: "8am" }]), 'Times are 24-hour HH:MM, like 08:30 or 17:00 ("8am" isn\'t).', "… a time that isn't HH:MM");
    eq(H({}, [{ day: "monday", open: true, from: "17:00", to: "09:00" }]), "The office has to close after it opens", "… closing before opening");
    eq(H({}, [1, 2, 3, 4, 5].map((d) => ({ day: DAY_KEYS[d], open: false }))), "At least one day has to be an office day", "… no office day at all");
    eq(H({}, [{ day: "monday", open: true }]), "Nothing changes: the office hours are already like that.", "… no change");
    eq(H({}, []), "Give 1 to 7 days.", "… no days");
    const keep = officeHoursProposal({ hours: { days: { 6: { on: false, from: "10:00", to: "12:00" } } } }, [{ day: "saturday", open: true }]) as any;
    eq([keep.hours.days[6], keep.what], [{ on: true, from: "10:00", to: "12:00" }, "Saturday is an office day, 10:00–12:00"], "open without times keeps the day's times");
    const p = officeHoursProposal({}, [{ day: "friday", open: true, from: "9:00", to: "15:00" }, { day: "saturday", open: true, from: "09:00", to: "13:00" }, { day: "monday", open: false }]) as any;
    eq(p.what, "Monday is closed, Friday 09:00–15:00, Saturday is an office day, 09:00–13:00", "the summary: Monday → Sunday, times zero-padded");
    eq(p.rows, [{ label: "Monday", before: "8:00–17:00", after: "Closed" }, { label: "Friday", before: "8:00–17:00", after: "9:00–15:00" }, { label: "Saturday", before: "Closed", after: "9:00–13:00" }], "display rows per changed day");
    APP.STATE.data.settings.catalog = { hours: p.hours };
    eq(p.hours, APP.catalogHours(), "the written object is the app's whole catalogHours() shape");

    // apply (owner), with every other catalog key untouched
    const cat = { ...CAT2, security: { pin: "x" }, rules: { needDate: true }, branding: { appName: "Acme Ops", color: "#123456" } };
    let db = world2({ catalog: cat });
    let { r, row } = await proposeOk(db, "jwt-owner", "change_office_hours", { days: [{ day: "saturday", open: true, from: "09:00", to: "13:00" }] });
    eq([row.summary, row.before, row.target], ["Office hours: Saturday is an office day, 09:00–13:00", { hours: null }, { table: "settings", id: "1", label: "Office hours" }], "proposal: summary, before (never saved = null), target");
    let c = await confirm(db, row.id, "jwt-owner");
    const after = db.T.settings[0].catalog;
    eq([c.status, c.body.change.status, after.hours.days[6]], [200, "confirmed", { on: true, from: "09:00", to: "13:00" }], "confirm: saved");
    ok(jeq({ ...after, hours: undefined }, { ...cat, hours: undefined }) && Object.keys(after).length === Object.keys(cat).length + 1, "every other catalog key is unchanged");
    eq(db.T.activity_log.map((a: any) => [a.record_kind, a.record_id, a.actor, a.text, a.manual]), [["settings", "global", "Olivia Owner", "Office hours: Saturday is an office day, 09:00–13:00 (via Acme Ops)", true]], "the settings history line, as the person");
    eq([UJ, UW], [["jwt-owner"], ["rpc:ai_catalog_cas", "activity_log.insert"]], "applied with the person's own client (their token)");
    ok(onlyAiWrites(db), "the service client wrote only ai_* rows");
    eq(lastChange(db).after.hours, after.hours, "after = the object written");
    // undo: a business that never saved hours goes back to no hours at all
    c = await undo(db, row.id, "jwt-owner");
    eq([c.status, c.body.change.status, "hours" in db.T.settings[0].catalog, acts(db)[1]], [200, "undone", false, "Office hours: change undone (via Acme Ops)"], "undo removes the key (back to the app's defaults)");
    // the assistant's name comes from ai_settings.assistant_name when set
    db = world2({ ai: { assistant_name: "Helper" }, catalog: { hours: { days: { 1: { on: true, from: "08:00", to: "16:00" } } } } });
    ({ row } = await proposeOk(db, "jwt-owner", "change_office_hours", { days: [{ day: "monday", open: true, to: "17:00" }] }));
    c = await confirm(db, row.id, "jwt-owner");
    eq(acts(db), ["Office hours: Monday 08:00–17:00 (via Helper)"], "the history names the assistant from ai_settings.assistant_name");
    // someone edits the hours in Settings → undo refused, stays confirmed
    db.T.settings[0].catalog.hours.days[2] = { on: false, from: "08:00", to: "17:00" };
    c = await undo(db, row.id, "jwt-owner");
    const ch = lastChange(db);
    eq([c.status, c.body.code, ch.status, ch.undone_at, ch.undone_by], [409, "changed_since", "confirmed", null, null], "undo after a Settings edit → 409, stays confirmed");
    eq(c.body.reason, "Office hours were changed after this change (now Mon 8:00–17:00, Wed–Fri 8:00–17:00), so they can't be put back.", "… naming the current hours");
    eq(ch.error, c.body.reason, "… the reason is kept on the change");
    // stale proposal: edited between propose and confirm
    db = world2();
    ({ row } = await proposeOk(db, "jwt-owner", "change_office_hours", { days: [{ day: "sunday", open: true, from: "10:00", to: "14:00" }] }));
    db.T.settings[0].catalog.hours = { days: { 1: { on: false } } };
    c = await confirm(db, row.id, "jwt-owner");
    eq([c.status, c.body.code, lastChange(db).status, db.T.settings[0].catalog.hours, db.T.activity_log.length], [409, "changed_since", "failed", { days: { 1: { on: false } } }, 0], "edited in Settings before Confirm → failed, nothing written");
    ok(/^Office hours were changed after this was suggested \(now Tue–Fri 8:00–17:00\)/.test(lastChange(db).error), "… the reason names the hours now");
    // the database says no (RLS)
    db = world2();
    ({ row } = await proposeOk(db, "jwt-owner", "change_office_hours", { days: [{ day: "sunday", open: true }] }));
    DENY.add("settings.update");
    c = await confirm(db, row.id, "jwt-owner");
    eq([c.status, c.body.code, c.body.reason, lastChange(db).status, "hours" in db.T.settings[0].catalog], [403, "denied", "You don't have access to change this.", "failed", false], "RLS refusal → 403 denied, failed, catalog unchanged");
    // parity of the office-hours text after a change (the app's OFFICE.days fill, incl. the all-closed fallback)
    for (const hrs of [p.hours, hoursOf({ hours: { days: { 1: { on: false }, 2: { on: false }, 3: { on: false }, 4: { on: false }, 5: { on: false } } } })]) {
      const days = officeDaysOf(hrs); APP.OFFICE.days = days;
      eq(officeHoursText(days), APP.officeHoursText(), "officeHoursText after a change = the app's");
    }
    APP.STATE.data.settings.catalog = {};
  }

  // ── 7. a new task ──
  {
    let db = world2();
    const T = async (jwt: string, input: any) => { const r = await toolCall(db, jwt, "add_task", input); return errText(db, r); };
    eq(await T("jwt-owner", { title: "  ", assignees: ["Gabe"] }), "The tool failed: A task needs a title.", "task: empty title");
    eq(await T("jwt-owner", { title: "x".repeat(201), assignees: ["Gabe"] }), "The tool failed: Keep the title to 200 characters.", "task: title over 200");
    eq(await T("jwt-owner", { title: "A", assignees: ["Gabe"], notes: "n".repeat(2001) }), "The tool failed: Keep the notes to 2,000 characters.", "task: notes over 2,000");
    eq(await T("jwt-owner", { title: "A", assignees: [] }), "The tool failed: Choose who the task is assigned to", "task: nobody assigned (Ofek 5/10)");
    const unknown = await T("jwt-owner", { title: "A", assignees: ["Old Timer"] });
    ok(/No active team member called "Old Timer"\. Active team members: Gabe Tech, Kim Lane, Sam Lee/.test(unknown) && !unknown.includes("Old Timer.") && !/Old Timer,/.test(unknown), "task: an inactive person is unknown; the list holds active names only");
    eq(await T("jwt-owner", { title: "A", assignees: ["Sam"] }), 'The tool failed: "Sam" matches more than one person: Sam Lee, Sam Park. Use the full name.', "task: an ambiguous first name");
    eq(await T("jwt-owner", { title: "A", assignees: ["Gabe"], due: "2026-02-30" }), "Invalid input: input.due must be a date (YYYY-MM-DD)", "task: not a real date");
    eq(db.T.ai_changes.length, 0, "no refused task left a proposal");
    eq(resolveAssignees(["gabe tech", "Gabe", "kim"], EMPLOYEES()), ["Gabe Tech", "Kim Lane"], "names: any case, first name, no duplicates");
    // boards
    const boardOf = async (jwt: string, assignees: string[], cat?: any) => { db = world2(cat ? { catalog: cat } : {}); const { row } = await proposeOk(db, jwt, "add_task", { title: "B", assignees }); return [row.after.row.board, row.display.rows.find((x: any) => x.label === "Board").after]; };
    eq(await boardOf("jwt-owner", ["Kim Lane"]), ["ron", "Front Desk Tasks"], "a VA (by full name) → the office's board, named from catalog.labels.office");
    eq(await boardOf("jwt-owner", ["Desk Helper"]), ["ron", "Front Desk Tasks"], "an employee with the VA role → the office's board");
    eq(await boardOf("jwt-owner", ["Kim"], {}), ["ron", "Office Tasks"], "… by first name; no label saved = 'Office'");
    eq(await boardOf("jwt-owner", ["Gabe", "Kim Lane"]), ["Gabe Tech", "Gabe Tech's Tasks"], "anyone else first → their own board");
    eq(await boardOf("jwt-tech", ["Gabe"]), ["Tia", "Tia's Tasks"], "a technician's task goes on his own board, whoever is assigned");
    {
      const profs = [OWNER, MANAGER, TECH, VA, OVA, { id: "u-x", full_name: "Kim Lane", role: "manager", technician_name: null }];
      const emps = [...EMPLOYEES(), { name: "Jo", status: "Active", roles: ["Technician"] }];
      APP.STATE.profiles = profs.map((p: any) => ({ id: p.id, fullName: p.full_name, role: p.role, technicianName: p.technician_name || "", permissions: p.permissions || {} }));
      APP.STATE.data.employees = emps.map((e: any) => ({ name: e.name, roles: e.roles || [], status: e.status }));
      const cases = [[], ["Riley"], ["Kim Lane"], ["Kim"], ["KL"], ["Desk Helper"], ["Jo"], ["Gabe Tech", "Kim"], ["Kim", "Gabe Tech"], ["Vera"], ["Nobody"]];
      eq(cases.map((n) => boardFor(n, profs, emps)), cases.map((n) => APP.boardForAssignees(n)), "boardFor = the app's boardForAssignees for every case");
      for (const c of [{}, { labels: { office: "  Dispatch  " } }, { labels: { office: "x".repeat(40) } }]) {
        APP.STATE.data.settings.catalog = c;
        eq([boardLabel("ron", officeLabelOf(c)), boardLabel("Gabe", officeLabelOf(c))], [APP.taskBoardLabel("ron"), APP.taskBoardLabel("Gabe")], `boardLabel = the app's taskBoardLabel (${JSON.stringify(c).slice(0, 30)})`);
      }
      APP.STATE.data.settings.catalog = {}; APP.STATE.profiles = []; APP.STATE.data.employees = [];
    }
    // a technician without his own board: refused even when called directly
    db = world2();
    eq(errText(db, await toolCall(db, "jwt-techx", "add_task", { title: "B", assignees: ["Gabe"] })), "Unknown tool add_task. Available: read_office_hours, whoami", "a technician without technician_name can't add tasks");
    // apply, with a lead (not contacted since it came in)
    db = world2();
    let { row } = await proposeOk(db, "jwt-va", "add_task", { title: "Call back about the quote", assignees: ["Gabe", "Sam Lee"], due: "2026-10-16", priority: "High", notes: "Ask about Friday", lead: "Demo" });
    eq(row.summary, 'Add a task "Call back about the quote" for Gabe Tech, Sam Lee, due 16 Oct', "task summary");
    eq(row.display.rows.map((x: any) => [x.label, x.after]), [["Title", "Call back about the quote"], ["Assigned to", "Gabe Tech, Sam Lee"], ["Board", "Gabe Tech's Tasks"], ["Due", "16 Oct"], ["Priority", "High"], ["Notes", "Ask about Friday"], ["Lead", "Demo Lead"]], "task display rows");
    NOW = T0 + 60000;
    let c = await confirm(db, row.id, "jwt-va");
    const task = db.T.tasks[0];
    eq([c.status, db.T.tasks.length], [200, 1], "confirm inserts the task");
    eq([task.status, task.heads_up, task.category, task.technician, task.subtasks, task.updates, task.created_by, task.created_at, task.board, task.assignees, task.due, task.priority, task.client, task.contact_id],
      ["Not Started", "", "Client-related", "", [], [], "Vera Vance", new Date(T0 + 60000).toISOString(), "Gabe Tech", ["Gabe Tech", "Sam Lee"], "2026-10-16", "High", "Demo Lead", UID(1)], "the row as the app's task form makes it (created at Confirm)");
    eq(acts(db), ["Task created (via Acme Ops)", 'Task created: "Call back about the quote" for Gabe Tech, Sam Lee · due 16 Oct (via Acme Ops)'], "history: the task's and the lead's");
    eq([db.T.activity_log[0].record_kind, db.T.activity_log[0].record_id, db.T.activity_log[1].record_kind, db.T.activity_log[1].record_id], ["task", task.id, "contact", UID(1)], "… on the task and on the lead");
    eq(contact(db, 1).contacted_at, new Date(T0 + 60000).toISOString(), "the lead counts as contacted (markLeadContacted)");
    eq([lastChange(db).target.id, lastChange(db).after.row.id, lastChange(db).after.row.status], [task.id, task.id, "Not Started"], "after = the stored row (the undo snapshot)");
    ok(UJ.every((j) => j === "jwt-va") && onlyAiWrites(db), "all writes with the person's own client");
    // the lead's contacted_at write fails after the task is in: still saved (with the task's id), and it can be undone
    db = world2();
    ({ row } = await proposeOk(db, "jwt-va", "add_task", { title: "Flaky follow-up", assignees: ["Gabe"], lead: "Demo" }));
    io.userClient = (jwt: string) => { const cl: any = fakeUserClient(jwt), rpc = cl.rpc; cl.rpc = async (n: string, a: any) => (n === "ai_contact_cas" ? { data: null, error: { message: "statement timeout" } } : rpc(n, a)); return cl; };
    c = await confirm(db, row.id, "jwt-va");
    io.userClient = (jwt: string) => fakeUserClient(jwt);
    eq([c.status, c.body.change.status, lastChange(db).status, lastChange(db).after.row.id, lastChange(db).target.id, db.T.tasks.length], [200, "confirmed", "confirmed", db.T.tasks[0].id, db.T.tasks[0].id, 1], "a failed follow-up after the insert: the change is saved with the task's id (not 'Not saved')");
    c = await undo(db, row.id, "jwt-va");
    eq([c.status, c.body.change.status, db.T.tasks.length], [200, "undone", 0], "… and the task can be undone from the log");
    // a lead contacted after it came in is not touched again
    db = world2();
    ({ row } = await proposeOk(db, "jwt-owner", "add_task", { title: "Send the quote", assignees: ["Gabe"], lead_id: UID(2) }));
    await confirm(db, row.id, "jwt-owner");
    eq([contact(db, 2).contacted_at, acts(db)[1]], ["2026-10-15T15:30:00.000Z", 'Task created: "Send the quote" for Gabe Tech (via Acme Ops)'], "already contacted since it came in: contacted_at kept; no due → no 'due'");
    // RLS: a technician may only write on his own board
    db = world2();
    db.T.profiles.find((p: any) => p.id === "u-tech").technician_name = "Tia";
    ({ row } = await proposeOk(db, "jwt-tech", "add_task", { title: "Own", assignees: ["Gabe"] }));
    db.T.profiles.find((p: any) => p.id === "u-tech").technician_name = "Tia";
    const bad = { ...row.after.row, board: "Gabe Tech" };
    db.T.ai_changes[0].after = { row: bad };
    c = await confirm(db, row.id, "jwt-tech");
    eq([c.status, c.body.code, lastChange(db).status, db.T.tasks.length], [403, "denied", "failed", 0], "a technician inserting on another board → denied by RLS, no task");
    // undo
    const addOne = async () => { const d = world2(); const x = await proposeOk(d, "jwt-owner", "add_task", { title: "Undo me", assignees: ["Gabe"] }); await confirm(d, x.row.id, "jwt-owner"); return { d, id: x.row.id }; };
    let x = await addOne();
    UJ.length = 0;
    c = await undo(x.d, x.id, "jwt-owner");
    eq([c.status, c.body.change.status, x.d.T.tasks.length, UJ], [200, "undone", 0, ["jwt-owner"]], "undo deletes the task with the undoer's token");
    for (const [what, edit, reason] of [
      ["status changed", (t: any) => { t.status = "In Progress"; }, "The task was changed after it was added (status is now In Progress), so it wasn't removed."],
      ["an update posted", (t: any) => { t.updates = [{ id: "u1", text: "Called", by: "Gabe Tech" }]; }, "The task was changed after it was added (updates now has 1 item), so it wasn't removed."],
      ["a subtask added", (t: any) => { t.subtasks = [{ id: "s1", text: "Find number" }, { id: "s2", text: "Call" }]; }, "The task was changed after it was added (subtasks now has 2 items), so it wasn't removed."],
    ] as [string, (t: any) => void, string][]) {
      x = await addOne();
      edit(x.d.T.tasks[0]);
      c = await undo(x.d, x.id, "jwt-owner");
      eq([c.status, c.body.code, c.body.reason, x.d.T.tasks.length, lastChange(x.d).status], [409, "changed_since", reason, 1, "confirmed"], `task undo refused after ${what}; the task stays`);
    }
    x = await addOne();
    x.d.T.tasks = [];
    c = await undo(x.d, x.id, "jwt-owner");
    eq([c.status, c.body.code, c.body.reason], [409, "gone", "That record no longer exists."], "task already deleted → 409 gone");
  }

  // ── 7b. a new task for someone on vacation (stage 3): the app's warning line on the card ──
  {
    const EMPS = () => EMPLOYEES().map((e: any, i: number) => ({ id: "e" + i, ...e }));   // e0 Gabe Tech, e1 Kim Lane, e2 Sam Lee, e6 Tia
    const vac = (n: number, over: any) => ({ id: "v" + n, business_id: "default", employee_id: "e0", employee_name: "Gabe Tech", starts_on: "2026-10-14", ends_on: "2026-10-24",
      stand_in_id: "e2", stand_in_name: "Sam Lee", options: { notAssignable: true, standIn: true }, ended_at: null, cancelled_at: null, ...over });
    const world = (vacs: any[]) => world2({ seed: { employees: EMPS(), employee_vacations: vacs } });
    const propose = async (db: any, input: any, jwt = "jwt-owner") => { const { r, row } = await proposeOk(db, jwt, "add_task", { title: "Check the unit", ...input }); return { r, row, res: JSON.parse(String(resultOf(db, r).content)) }; };
    // away on the due date, "Not assignable" ticked, a stand-in who is in
    let db = world([vac(1, {})]);
    let { row, res } = await propose(db, { assignees: ["Gabe"], due: "2026-10-16" });
    eq(row.display.warnings, ["Gabe Tech is on vacation then (On vacation until 24 Oct).", "Or assign Sam Lee instead."], "away on the due date: the app's line, then its other answer (the stand-in)");
    eq([res.warnings, res.changes.map((x: any) => x.label)], [row.display.warnings, ["Title", "Assigned to", "Board", "Due"]], "… told to the model too; the rows are unchanged");
    ok(UJ.length > 0 && UJ.every((j) => j === "jwt-owner"), "the vacations are read with the person's own client");
    eq([db.T.ai_changes.length, db.T.tasks.length], [1, 0], "a warning, not a block: the proposal is made, nothing written");
    // no due date: today (Thursday 15 Oct in the business's zone)
    db = world([vac(1, {})]);
    ({ row } = await propose(db, { assignees: ["Gabe"] }));
    eq(row.display.warnings, ["Gabe Tech is on vacation then (On vacation until 24 Oct).", "Or assign Sam Lee instead."], "no due date → today");
    // nobody away that day / the option off / cancelled / ended / someone else
    const none = async (vacs: any[], input: any, what: string) => { db = world(vacs); ({ row } = await propose(db, input)); eq([row.display.warnings, "warnings" in row.display], [undefined, false], what); };
    await none([vac(1, {})], { assignees: ["Gabe"], due: "2026-10-25" }, "back by the due date → no warning");
    await none([vac(1, { options: { standIn: true } })], { assignees: ["Gabe"], due: "2026-10-16" }, "'Not assignable' not ticked → no warning");
    await none([vac(1, { cancelled_at: "2026-10-10T00:00:00Z" })], { assignees: ["Gabe"], due: "2026-10-16" }, "a cancelled vacation → no warning");
    await none([vac(1, { ended_at: "2026-10-15T14:00:00Z" })], { assignees: ["Gabe"], due: "2026-10-16" }, "ended early (back on the 15th) → no warning");
    await none([vac(1, {})], { assignees: ["Sam Lee"], due: "2026-10-16" }, "someone else → no warning");
    await none([], { assignees: ["Gabe"], due: "2026-10-16" }, "no vacations → no warning");
    // left open (autoBack off): still away after the last day, "due back"
    db = world([vac(1, { options: { notAssignable: true, autoBack: false }, stand_in_id: null, stand_in_name: "" })]);
    ({ row } = await propose(db, { assignees: ["Gabe"], due: "2026-10-28" }));
    eq(row.display.warnings, ["Gabe Tech is on vacation then (On vacation (due back 25 Oct))."], "autoBack off: still away past the end date; no stand-in → one line");
    // two people away; the stand-in away too is not offered
    db = world([vac(1, {}), vac(2, { employee_id: "e1", employee_name: "Kim Lane", stand_in_id: "e0", stand_in_name: "Gabe Tech", ends_on: "2026-10-31" })]);
    ({ row } = await propose(db, { assignees: ["Gabe", "Kim Lane"], due: "2026-10-16" }));
    eq(row.display.warnings, ["Gabe Tech (On vacation until 24 Oct) and Kim Lane (On vacation until 31 Oct) are on vacation then.", "Or assign Sam Lee instead."], "two away: one line for both; a stand-in who is away himself is not offered");
    // a person who can't read the employees (RLS): matched by the rows' name copies, the stand-in from the row
    db = world([vac(1, {})]);
    DENY.add("employees.select");
    ({ row } = await propose(db, { assignees: ["Gabe"], due: "2026-10-16" }, "jwt-va"));
    eq(row.display.warnings, ["Gabe Tech is on vacation then (On vacation until 24 Oct).", "Or assign Sam Lee instead."], "no employees for the person: by name, the stand-in from the row (as in the app)");
    // the person can't read the vacations: no warning (it is read as them, never with the service role)
    db = world([vac(1, {})]);
    DENY.add("employee_vacations.select");
    ({ row } = await propose(db, { assignees: ["Gabe"], due: "2026-10-16" }));
    eq("warnings" in row.display, false, "vacations hidden from the person → no warning");
    // a failed read: logged, no warning, the proposal still made
    db = world([vac(1, {})]);
    io.userClient = (jwt: string) => {
      const cl: any = fakeUserClient(jwt), from = cl.from;
      const eb: any = { select: () => eb, is: () => eb, lte: () => eb, or: () => eb, then: (a: any, z: any) => Promise.resolve({ data: null, error: { message: "statement timeout" } }).then(a, z) };
      cl.from = (t: string) => (t === "employee_vacations" ? eb : from(t));
      return cl;
    };
    ({ row } = await propose(db, { assignees: ["Gabe"], due: "2026-10-16" }));
    io.userClient = (jwt: string) => fakeUserClient(jwt);
    eq([row && row.status, "warnings" in row.display], ["proposed", false], "vacations not read: the task is still proposed, without a warning");
    // parity: the helpers = the app's (vacationAssignInfo / vacationAssignConflicts / vacationAssignLine), in the business's zone
    {
      APP.STATE.data.settings.catalog = { region: { timeZone: TZ } };
      const emps = EMPS();
      const rows = [vac(1, {}), vac(2, { employee_id: "e1", employee_name: "Kim Lane", stand_in_id: "e0", stand_in_name: "Gabe Tech", ends_on: "2026-10-31" }),
        vac(3, { employee_id: "e6", employee_name: "Tia", starts_on: "2026-10-01", ends_on: "2026-10-05", options: { notAssignable: true, autoBack: false }, ended_at: "2026-10-18T03:30:00Z" }),
        vac(4, { employee_id: "e2", employee_name: "Sam Lee", options: { notAssignable: true, standIn: true }, stand_in_id: "e8", stand_in_name: "Desk Helper", starts_on: "2026-10-20", cancelled_at: null }),
        vac(5, { employee_id: "e8", employee_name: "Desk Helper", cancelled_at: "2026-10-01T00:00:00Z" })];
      const appData = (withEmps: boolean) => ({ vacations: rows.map((r) => APP.mapVacationRow(r)), employees: withEmps ? emps.map((e: any) => ({ id: e.id, name: e.name, status: e.status, roles: e.roles })) : [] });
      const ours = (withEmps: boolean) => ({ vacations: rows.map(mapVacRow), employees: withEmps ? emps : [] });
      const people = ["Gabe Tech", "Kim Lane", "Tia", "Sam Lee", "Desk Helper", "Nobody"];
      const strip = (x: any) => (x ? { name: x.name, id: x.vac.id, label: x.label, standIn: x.standIn } : null);
      for (const withEmps of [true, false]) for (const day of ["2026-10-13", "2026-10-14", "2026-10-17", "2026-10-18", "2026-10-21", "2026-10-24", "2026-10-25", "2026-11-01"]) {
        eq(people.map((n) => strip(vacationAssignInfo(n, day, ours(withEmps), TZ))), people.map((n) => strip(APP.vacationAssignInfo(n, day, appData(withEmps), TZ))), `vacationAssignInfo = the app's (${day}, ${withEmps ? "with" : "without"} employees)`);
        const c1 = vacationAssignConflicts(people, ["Kim Lane"], day, ours(withEmps), TZ), c2 = APP.vacationAssignConflicts(people, ["Kim Lane"], day, appData(withEmps), TZ);
        eq([c1.map(strip), vacationAssignLine(c1)], [c2.map(strip), APP.vacationAssignLine(c2)], `vacationAssignConflicts + the line = the app's (${day})`);
      }
      eq([listJoin([]), listJoin(["A"]), listJoin(["A", "", "B", "C"]), listJoin(["A", "B"], "or")], [APP.listJoin([]), APP.listJoin(["A"]), APP.listJoin(["A", "", "B", "C"]), APP.listJoin(["A", "B"], "or")], "listJoin = the app's");
      APP.STATE.data.settings.catalog = {};
    }
  }

  // ── 8. a lead's stage ──
  {
    const today = "2026-10-15";
    const S = async (input: any, jwt = "jwt-manager", cat?: any) => { const db = world2(cat ? { catalog: cat } : {}); const r = await toolCall(db, jwt, "move_lead_stage", input); return { db, e: errText(db, r).replace(/^The tool failed: /, ""), row: lastChange(db) }; };
    eq((await S({ lead: "Demo Lead", stage: "Won" })).e, "Won is set automatically once the customer has a job in Jobs & Commissions", "stage: Won is never set by hand");
    eq((await S({ lead: "Wanda", stage: "Lost", lost_reason: "spam" })).e, "Wanda Won already has a job, so the lead stays Won", "… a lead that is Won (status)");
    eq((await S({ lead: "Jack Job", stage: "Chasing" })).e, "Jack Job already has a job, so the lead stays Won", "… Won by a job linked by id");
    eq((await S({ lead: "Nora", stage: "Lost", lost_reason: "spam" })).e, "Nora Name already has a job, so the lead stays Won", "… Won by a job under the same name (case and spaces ignored)");
    const back = await S({ lead: "Rita", stage: "Chasing" });
    eq([back.e, back.row && back.row.kind], ["", "lead_stage"], "a returning customer (job before they came back) is not Won");
    eq((await S({ lead: "Demo Lead", stage: "Chasing" }, "jwt-manager", { stages: [{ key: "Chasing", label: "Chasing", active: false }] })).e, "Chasing is switched off in Settings → Pipeline", "… a stage switched off");
    ok(/^"Nowhere" isn't a stage\. Stages: New lead, Chasing, Quoted, Follow up, Booked, Lost\.$/.test((await S({ lead: "Demo Lead", stage: "Nowhere" })).e), "… an unknown stage lists the stages");
    eq((await S({ lead: "Demo Lead", stage: "new lead" })).e, "Demo Lead is already in New lead", "… the same stage");
    eq((await S({ lead: "Demo Lead", stage: "Booked" })).e, "Moving a lead to Booked stays in the app: it also counts a booking for the day and has no undo.", "… Booked stays in the app");
    const lostCat = { lostReasons: [{ key: "noAnswer", label: "No answer", active: false }, { key: "spam", label: "Spam", deleted: true }, { key: "x1", label: "Went elsewhere" }] };
    eq((await S({ lead: "Demo Lead", stage: "Lost" }, "jwt-manager", lostCat)).e, "A lost lead always needs a reason. Reasons: Went elsewhere, Outside service area, Wrong number, Wrong details, Too expensive, Not interested.", "… Lost without a reason lists only active, not deleted reasons (the app's order: saved, then the shipped ones missing)");
    eq((await S({ lead: "Demo Lead", stage: "Quoted" })).e, "A lead in Quoted needs a follow-up day after today: ask the person for one.", "… Quoted without a future follow-up");
    eq((await S({ lead: "Demo Lead", stage: "Quoted", follow_up: today })).e, "Pick a follow-up day after today.", "… a follow-up today");
    eq((await S({ lead: "Demo Lead", stage: "follow up", follow_up: "2026-10-01" })).e, "Pick a follow-up day after today.", "… a follow-up in the past");
    eq((await S({ lead: "Demo Lead", stage: "Quoted" }, "jwt-manager", { rules: { needDate: false } })).e, "", "rules.needDate off → Quoted needs no date");
    const fq = await S({ lead: "Quinn", stage: "Follow-up" });
    eq([fq.e, fq.row.display.rows], ["", [{ label: "Stage", before: "Quoted", after: "Follow up" }]], "a lead with a future follow-up needs no date (and keeps it)");
    // the patch = the app's (stageMovePlan's non-quiet patch through contactPatchToRow)
    {
      const M: Record<string, string> = { status: "status", stageChangedAt: "stage_changed_at", nextFollowUp: "next_follow_up", chasingSince: "chasing_since", chaseAlertDone: "chase_alert_done", chaseRound: "chase_round", lostReason: "lost_reason", bookedFor: "booked_for" };
      const NULLS = ["next_follow_up", "stage_changed_at", "chasing_since", "booked_for"];
      const toCols = (p: any) => Object.fromEntries(Object.entries(p).map(([k, v]) => [M[k], NULLS.includes(M[k]) && v === "" ? null : v]));
      const nowIso = "2026-10-15T16:00:00.000Z", extra = { lostReason: "spam", nextFollowUp: "2026-10-20" };
      let n = 0;
      APP.STATE.data.jobs = [];
      for (const from of ["New", "Chasing", "Quoted", "Follow-up"]) for (const to of ["New", "Chasing", "Quoted", "Follow-up", "Lost"]) for (const fu of ["", "2026-10-30"]) {
        if (from === to) continue;
        const c = { id: "c" + n, fullName: "X", status: from, nextFollowUp: fu };
        const plan = APP.stageMovePlan([c], from, to, extra, nowIso, today)[0];
        const giveFu = STAGES_NEED_DATE.includes(to) && !(fu && fu > today) ? extra.nextFollowUp : undefined;
        const mine = stagePatch(from, to, { lostReason: to === "Lost" ? extra.lostReason : undefined, nextFollowUp: giveFu }, nowIso);
        if (canon(mine) !== canon(toCols(plan.patch))) { eq(mine, toCols(plan.patch), `stagePatch ${from} → ${to} (follow-up ${fu || "none"})`); n = -1000; }
        n++;
      }
      ok(n > 20, "stagePatch = the app's stage patch for every (from, to, follow-up) case");
      for (const status of ["New", "Quoted", "Won", "Lost", "Not Relevant", "Weird", "Follow-up"]) eq(leadStageOf({}, { status }, false), APP.leadStage({ id: "z" + status, status, fullName: "Nobody Here" }), `leadStageOf = the app's leadStage (${status})`);
    }
    // apply: Lost, with an inbound message arriving between propose and confirm
    let db = world2();
    let { row } = await proposeOk(db, "jwt-va", "move_lead_stage", { lead: "Demo Lead", stage: "Lost", lost_reason: "too expensive" });
    eq([row.summary, row.before.cols, row.after.cols], ["Move Demo Lead from New lead to Lost (Too expensive)", { status: "New", stage_changed_at: null, next_follow_up: null, chasing_since: null, chase_alert_done: false, chase_round: 0, lost_reason: "", booked_for: null },
      { status: "Lost", stage_changed_at: AT_CONFIRM, next_follow_up: null, lost_reason: "tooExpensive" }], "proposal: the 8 fields before, the patch after (time filled at Confirm)");
    eq(row.display.rows, [{ label: "Stage", before: "New lead", after: "Lost" }, { label: "Lost reason", before: "—", after: "Too expensive" }], "display rows: stage and reason");
    contact(db, 1).messages.push({ id: "m-late", kind: "in", text: "Actually, call me", at: "2026-10-15T16:00:30.000Z" });
    NOW = T0 + 120000;
    let c = await confirm(db, row.id, "jwt-va");
    const L = contact(db, 1), at = new Date(T0 + 120000).toISOString();
    eq([c.status, L.status, L.stage_changed_at, L.lost_reason, L.next_follow_up, L.contacted_at], [200, "Lost", at, "tooExpensive", null, at], "confirm: the stage fields, stage_changed_at = Confirm time, contacted");
    eq(L.messages.map((m: any) => m.text), ["Hi, I need a quote", "Actually, call me", 'Stage changed from "New lead" to "Lost"'], "the thread keeps the message that came in meanwhile and gets the event");
    ok(/^id[0-9a-z]+$/.test(L.messages[2].id) && L.messages[2].kind === "event" && L.messages[2].at === at, "the event as the app's logLeadEvent writes it");
    eq(acts(db), ['Stage changed from "New lead" to "Lost" (Too expensive) (via Acme Ops)'], "history line with the reason");
    eq(lastChange(db).after.cols.stage_changed_at, at, "after = the stored fields");
    // undo puts all 8 back
    c = await undo(db, row.id, "jwt-va");
    eq([c.status, pick(contact(db, 1), STAGE_COLS)], [200, { status: "New", stage_changed_at: null, next_follow_up: null, chasing_since: null, chase_alert_done: false, chase_round: 0, lost_reason: "", booked_for: null }], "undo restores the 8 fields exactly (nulls included)");
    eq([contact(db, 1).messages.slice(-1)[0].text, acts(db).slice(-1)[0], contact(db, 1).contacted_at], ['Stage change undone: back to "New lead"', 'Stage change undone: back to "New lead" (via Acme Ops)', at], "… with the event and the history line; contacted_at stays (as in the app)");
    // Chasing + a follow-up change, then moved again by someone → undo refused
    db = world2();
    ({ row } = await proposeOk(db, "jwt-manager", "move_lead_stage", { lead_id: UID(2), stage: "Chasing", follow_up: "2026-10-22" }));
    await confirm(db, row.id, "jwt-manager");
    eq([contact(db, 2).chasing_since, contact(db, 2).chase_round, contact(db, 2).chase_alert_done, contact(db, 2).next_follow_up], [new Date(T0).toISOString(), 1, false, "2026-10-22"], "Chasing starts the chase; the follow-up day is set");
    eq(acts(db), ['Follow-up date changed from "2026-10-20" to "2026-10-22" (via Acme Ops)', 'Stage changed from "Quoted" to "Chasing" (via Acme Ops)'], "a follow-up change gets its own history line");
    contact(db, 2).status = "Booked"; contact(db, 2).stage_changed_at = "2026-10-15T17:00:00.000Z";
    c = await undo(db, row.id, "jwt-manager");
    eq([c.status, c.body.code, c.body.reason, lastChange(db).status], [409, "changed_since", "Quinn Quoted was moved again after this (now Booked), so it can't be put back.", "confirmed"], "undo after another move → refused, stays confirmed");
    // stale: moved by someone else between propose and confirm
    db = world2();
    ({ row } = await proposeOk(db, "jwt-manager", "move_lead_stage", { lead: "Demo Lead", stage: "Chasing" }));
    contact(db, 1).status = "Quoted";
    c = await confirm(db, row.id, "jwt-manager");
    eq([c.status, c.body.code, c.body.reason, contact(db, 1).status, db.T.activity_log.length], [409, "changed_since", "Demo Lead was changed after this was suggested (now in Quoted), so nothing was changed.", "Quoted", 0], "moved by someone else before Confirm → failed, nothing written");
  }

  // ── 9. a note on a lead ──
  {
    let db = world2();
    const N = async (input: any) => errText(db, await toolCall(db, "jwt-va", "add_lead_note", input)).replace(/^The tool failed: /, "");
    eq(await N({ lead: "Demo Lead", text: "   " }), "The note is empty.", "note: empty");
    eq(await N({ lead: "Demo Lead", text: "x".repeat(2001) }), "Keep the note to 2,000 characters.", "note: over 2,000 characters");
    eq(await N({ text: "Hello" }), "Say which lead: its name or phone number (or its lead_id).", "note: which lead?");
    const long = "A".repeat(95);
    let { row } = await proposeOk(db, "jwt-va", "add_lead_note", { lead: "0491-570-006", text: long });
    eq(row.summary, `Add a note to Demo Lead: "${"A".repeat(90)}…"`, "found by phone digits; the summary shortens at 90 (addLeadNote's rule)");
    contact(db, 1).customer_notes.push({ id: "n-other", text: "Someone else's", by: "Max Manager", at: "2026-10-15T16:00:10.000Z" });
    let c = await confirm(db, row.id, "jwt-va");
    const notes = contact(db, 1).customer_notes, mine = notes[2];
    eq([c.status, notes.length, notes[0].id, notes[1].id, mine.text, mine.by, mine.at], [200, 3, "n0", "n-other", long, "Vera Vance", new Date(T0).toISOString()], "the note is appended; the others stay");
    ok(/^id[0-9a-z]+$/.test(mine.id), "… with the app's kind of id");
    eq(acts(db), [`Note added: "${"A".repeat(90)}…" (via Acme Ops)`], "history: 'Note added' with the first 90 characters");
    eq(lastChange(db).after.note, mine, "after = the stored note");
    contact(db, 1).customer_notes.push({ id: "n-later", text: "Later", by: "Max Manager", at: "2026-10-15T17:00:00.000Z" });
    c = await undo(db, row.id, "jwt-va");
    eq([c.status, contact(db, 1).customer_notes.map((n: any) => n.id)], [200, ["n0", "n-other", "n-later"], ], "undo removes exactly that note");
    eq(acts(db).slice(-1)[0], `Note deleted: "${"A".repeat(90)}…" (via Acme Ops)`, "… and says so");
    db = world2();
    ({ row } = await proposeOk(db, "jwt-va", "add_lead_note", { lead_id: UID(1), text: "Short one" }));
    await confirm(db, row.id, "jwt-va");
    contact(db, 1).customer_notes = contact(db, 1).customer_notes.filter((n: any) => n.text !== "Short one");
    c = await undo(db, row.id, "jwt-va");
    eq([c.status, c.body.code, c.body.reason], [409, "changed_since", "That note was already deleted or changed."], "undo after the note was deleted in the app → 409");
  }

  // ── 10. the lead resolver ──
  {
    const db = world2();
    const R = async (jwt: string, input: any) => errText(db, await toolCall(db, jwt, "add_lead_note", { ...input, text: "Hi" })).replace(/^The tool failed: /, "");
    eq(await R("jwt-va", { lead_id: UID(9) }), "No lead with that id that you can see.", "a lead the person can't see (RLS) …");
    eq(await R("jwt-va", { lead_id: "10000000-0000-4000-8000-000000009999" }), "No lead with that id that you can see.", "… reads exactly like a missing one");
    eq(await R("jwt-va", { lead: "Hidden Hal" }), "No lead matches that you can see.", "a hidden lead isn't found by name either");
    const amb = await R("jwt-va", { lead: "Ann" });
    const list = JSON.parse(amb.slice(amb.indexOf("[")));
    eq(list, [{ lead_id: UID(7), name: "Ann Alpha", stage: "New lead", received: "14 Oct" }, { lead_id: UID(8), name: "Ann Beta", stage: "Lost", received: "13 Oct" }], "two matches → the candidates (id, name, stage, day), newest first");
    ok(!/@example|0491|private office notes/.test(amb), "… no phone, email or notes");
    eq(leadQueryOf(`Ann),status.eq.Won,(full_name.ilike.*`), "Ann status.eq.Won full_name.ilike.", "filter characters are stripped from the or() text");
    eq([leadPhoneClause("call 12345"), leadPhoneClause("0491 570 006")], ["", ',phone.match."9[^0-9]*1[^0-9]*5[^0-9]*7[^0-9]*0[^0-9]*0[^0-9]*0[^0-9]*6"'], "phone matched only from 6 digits (the last 8 in a row, any separators)");
    eq(await R("jwt-va", { lead: "Nobody At All" }), "No lead matches that you can see.", "no match");
  }

  // ── 11. confirm guards ──
  {
    let db = world2();
    let { row } = await proposeOk(db, "jwt-va", "add_lead_note", { lead: "Demo Lead", text: "One" });
    let c = await confirm(db, row.id, "jwt-manager");
    eq([c.status, c.body.code], [403, "not_yours"], "only the person who asked confirms");
    const [a, b] = await Promise.all([confirm(db, row.id, "jwt-va"), confirm(db, row.id, "jwt-va")]);
    eq([[a.status, b.status].sort(), contact(db, 1).customer_notes.length], [[200, 409], 2], "two confirms at once → applied exactly once");
    c = await confirm(db, row.id, "jwt-va");
    eq([c.status, c.body.code], [409, "not_proposed"], "already confirmed → 409");
    db = world2();
    ({ row } = await proposeOk(db, "jwt-va", "add_task", { title: "Twice", assignees: ["Gabe"] }));
    await Promise.all([confirm(db, row.id, "jwt-va"), confirm(db, row.id, "jwt-va")]);
    eq(db.T.tasks.length, 1, "a double click adds one task");
    db = world2();
    ({ row } = await proposeOk(db, "jwt-va", "add_lead_note", { lead: "Demo Lead", text: "Old" }));
    NOW = T0 + 8 * 24 * 3600e3;
    c = await confirm(db, row.id, "jwt-va");
    eq([c.status, c.body.code, lastChange(db).status], [409, "expired", "cancelled"], "older than 7 days → expired, cancelled");
    for (const [over, code] of [[{ kill_switch: true }, "off"], [{ roles_enabled: { va: false } }, "role_off"]] as [any, string][]) {
      db = world2();
      ({ row } = await proposeOk(db, "jwt-va", "add_lead_note", { lead: "Demo Lead", text: "Off" }));
      Object.assign(db.T.ai_settings[0], over);
      c = await confirm(db, row.id, "jwt-va");
      eq([c.status, c.body.code, lastChange(db).status], [403, code, "proposed"], `confirm refused when ${code}`);
    }
    db = world2();
    ({ row } = await proposeOk(db, "jwt-owner", "change_office_hours", { days: [{ day: "sunday", open: true }] }));
    db.T.profiles.find((p: any) => p.id === "u-owner").role = "manager";
    c = await confirm(db, row.id, "jwt-owner");
    eq([c.status, c.body.code, "hours" in db.T.settings[0].catalog], [403, "not_allowed", false], "an owner made a manager since proposing → office hours refused");
    // cancel
    db = world2();
    ({ row } = await proposeOk(db, "jwt-va", "add_lead_note", { lead: "Demo Lead", text: "Cancel me" }));
    c = await manage(db, { step: "cancel_change", id: row.id }, "jwt-manager");
    eq([c.status, c.body.code], [403, "not_yours"], "cancel: someone else's → refused");
    c = await manage(db, { step: "cancel_change", id: row.id }, "jwt-va");
    eq([c.status, c.body.change.status, c.body.change.can_confirm, contact(db, 1).customer_notes.length], [200, "cancelled", false, 1], "cancel: own → cancelled, nothing written");
  }

  // ── 12. undo permissions ──
  {
    const made = async (jwt: string) => { const d = world2(); const x = await proposeOk(d, jwt, "add_lead_note", { lead: "Demo Lead", text: "Undo test" }); await confirm(d, x.row.id, jwt); return { d, id: x.row.id }; };
    let x = await made("jwt-va");
    let c = await undo(x.d, x.id, "jwt-va");
    eq([c.status, c.body.change.status, c.body.change.undone_by.id], [200, "undone", "u-va"], "a VA undoes their own change");
    x = await made("jwt-manager");
    c = await undo(x.d, x.id, "jwt-va");
    eq([c.status, c.body.code], [403, "not_yours"], "a VA can't undo a manager's change");
    x = await made("jwt-va");
    UJ.length = 0;
    x.d.T.ai_settings[0].kill_switch = true;
    c = await undo(x.d, x.id, "jwt-owner");
    eq([c.status, lastChange(x.d).undone_by, UJ], [200, "u-owner", ["jwt-owner"]], "an owner undoes a VA's change with the OWNER's token, even with the kill switch on");
    c = await undo(x.d, x.id, "jwt-owner");
    eq([c.status, c.body.code], [409, "not_confirmed"], "undo of an undone change → 409");
    const d = world2();
    const p = await proposeOk(d, "jwt-va", "add_lead_note", { lead: "Demo Lead", text: "Never confirmed" });
    c = await undo(d, p.row.id, "jwt-va");
    eq([c.status, c.body.code], [409, "not_confirmed"], "undo of a proposed change → 409");
    x = await made("jwt-va");
    x.d.T.profiles.find((q: any) => q.id === "u-va").permissions = { tasks: true };
    c = await undo(x.d, x.id, "jwt-va");
    eq([c.status, c.body.code, lastChange(x.d).status], [403, "not_allowed", "confirmed"], "someone whose CRM access was taken away can't undo their lead change");
  }

  // ── 13. the change log ──
  {
    const db = world2();
    for (const [jwt, text] of [["jwt-va", "one"], ["jwt-manager", "two"], ["jwt-va", "three"]]) { NOW += 1000; await proposeOk(db, jwt, "add_lead_note", { lead: "Demo Lead", text }); }
    await confirm(db, db.T.ai_changes[0].id, "jwt-va");
    let c = await manage(db, { step: "list_changes", scope: "all" }, "jwt-va");
    eq(c.body.changes.map((x: any) => x.by.name), ["Vera Vance", "Vera Vance"], "a VA asking for 'all' still gets only their own");
    c = await manage(db, { step: "list_changes", scope: "all" }, "jwt-owner");
    eq(c.body.changes.map((x: any) => [x.by.name, x.summary]), [["Vera Vance", 'Add a note to Demo Lead: "three"'], ["Max Manager", 'Add a note to Demo Lead: "two"'], ["Vera Vance", 'Add a note to Demo Lead: "one"']], "an owner gets everyone's, newest first, with names");
    const first = c.body.changes[2];
    ok(Array.isArray(first.display.rows) && first.display.rows[0].after === "one" && !("conversation_id" in first) && first.can_undo === true && first.can_confirm === false, "rows carry the display, no link into someone else's chat; the owner can undo");
    ok(!JSON.stringify(c.body).includes("[mock:tool"), "never the chat's text");
    c = await manage(db, { step: "list_changes" }, "jwt-va");
    ok(c.body.changes.every((x: any) => "conversation_id" in x), "the asker's own rows link to their chat");
    c = await manage(db, { step: "list_changes", scope: "all", limit: 2 }, "jwt-owner");
    const c2 = await manage(db, { step: "list_changes", scope: "all", limit: 2, before: c.body.next }, "jwt-owner");
    eq([c.body.changes.length, c2.body.changes.length, c2.body.next, c2.body.changes[0].summary], [2, 1, null, 'Add a note to Demo Lead: "one"'], "paging with before / next");
    c = await manage(db, { step: "list_changes", limit: 500 }, "jwt-owner");
    eq(c.status, 200, "a limit over 50 is capped");
    c = await manage(db, { step: "list_changes", before: "yesterday-ish" }, "jwt-owner");
    eq([c.status, c.body.code], [400, "bad_request"], "a bad 'before' → 400");
  }

  // ── 14. the model hears what became of its proposals (in the next turn's context message) ──
  {
    const db = world2();
    const r = await toolCall(db, "jwt-va", "add_lead_note", { lead: "Demo Lead", text: "Context check" });
    const row = lastChange(db);
    await confirm(db, row.id, "jwt-va");
    const r2 = await chat(db, { text: "did it work?", conversation_id: convOf(r) }, "jwt-va");
    eq(r2.status, 200, "the conversation continues");
    const rows = msgs(db, convOf(r)), ctxRow = rows.filter((m: any) => m.role === "system").slice(-1)[0];
    ok(ctxRow.content[0].text.includes(`- Changes suggested in this chat (newest first):\n  - ${row.id} (Lead note): confirmed and saved`), "the context message lists the change as confirmed");
    ok(!ctxRow.content[0].text.includes("Context check") && !ctxRow.content[0].text.includes("Demo Lead"), "… by id and kind only (no customer text in a system message)");
    const toolResults = rows.filter((m: any) => m.role === "user" && Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_result"));
    ok(toolResults.every((m: any) => !JSON.stringify(m.content).includes("confirmed and saved")), "never inside a tool_result");
    const hist = buildHistory(rows, { systemMessages: true });
    eq(hist.slice(-2).map((m: any) => m.role), ["system", "assistant"], "replayed as a system message right before the reply");
    eq(changesContextLines([{ id: "c1", kind: "lead_note", status: "proposed", created_at: new Date(T0 - 8 * 24 * 3600e3).toISOString() }, { id: "c2", kind: "task_add", status: "failed", created_at: new Date(T0).toISOString() }], T0),
      ["- Changes suggested in this chat (newest first):", "  - c1 (Lead note): expired, never confirmed", "  - c2 (New task): not made (it could not be saved)"], "status words, expiry");
  }

  // ── 15. read tools ──
  {
    const db = world2();
    const r = await chat(db, { text: "who am i" }, "jwt-va");
    const w = JSON.parse(resultOf(db, r).content);
    eq(w, { name: "Vera Vance", role: "va", roleLabel: "Virtual Assistant", pages: Object.keys(SECTION_LABEL).filter((k) => APP.canViewSection(P(VA), k)).map((k) => APP.SECTION_LABEL[k]), canPropose: Object.values(CHANGE_KINDS).filter((k) => k.allow(P(VA))).map((k) => k.label), assistantName: "Acme Ops", businessName: "Acme Home Services", timeZone: TZ, today: "2026-10-15" }, "whoami: own facts only, the pages the app would show");
    for (const p of [OWNER, MANAGER, VA, TECH, MKT, { ...VA, permissions: {} }]) for (const s of Object.keys(APP.SECTION_LABEL)) if (canViewSection(P(p), s) !== APP.canViewSection(P(p), s)) eq([p.role, s, canViewSection(P(p), s)], [p.role, s, APP.canViewSection(P(p), s)], "canViewSection parity");
    eq(SECTION_LABEL, APP.SECTION_LABEL, "SECTION_LABEL = the app's");
    for (const d of ["2026-10-16", "2026-01-01", "2026-12-31"]) eq(fmtDateShort(d), APP.fmtDateShort(d), `fmtDateShort = the app's (${d})`);
    eq([fmtDateShort(""), APP.fmtDateShort("")], ["—", "—"], "fmtDateShort of nothing");
    ok(/^id[0-9a-z]+$/.test(uid()) && /^id[0-9a-z]+$/.test(APP.uid()), "uid: the app's shape");
    const cat = { region: { timeZone: TZ, country: "US", state: "NY" }, holidays: { region: "US-NY", days: { "2026-10-12": "Columbus Day", "2026-11-11": "Veterans Day", "2026-11-26": "Thanksgiving Day", "2026-12-25": "Christmas Day" } }, hours: { publicOn: true, holidayOff: ["thanksgiving day"], extra: [{ date: "2026-12-24", name: "Party" }] } };
    const db2 = world2({ catalog: cat });
    const r2 = await chat(db2, { text: "office hours" }, "jwt-mkt");
    const h = JSON.parse(resultOf(db2, r2).content);
    eq([h.publicHolidaysOff, h.publicHolidaysNext, h.extraDaysOff], [true, [{ date: "2026-11-11", name: "Veterans Day" }, { date: "2026-12-25", name: "Christmas Day" }], [{ date: "2026-12-24", name: "Party" }]], "read_office_hours: upcoming holidays off (switched-off ones left out), extra days");
    const db3 = world2({ catalog: { ...cat, region: { timeZone: TZ, country: "US", state: "TX" } } });
    const h3 = JSON.parse(resultOf(db3, await chat(db3, { text: "office hours" }, "jwt-mkt")).content);
    eq(h3.publicHolidaysNext, [], "… none when the stored list is for another region");
  }

  // ── 16. the test provider's change scripts, end to end (propose → confirm → undo) ──
  {
    const run = async (text: string, jwt: string, check: (db: any) => boolean, name: string) => {
      const db = world2();
      const r = await chat(db, { text }, jwt);
      const prop = evs(r, "proposal")[0];
      if (!prop) { eq(errText(db, r), "", `${name}: proposed`); return; }
      const c = await confirm(db, prop.change.id, jwt);
      const applied = check(db);
      const u = await undo(db, prop.change.id, jwt);
      eq([c.status, applied, u.status, lastChange(db).status, done(r).stop], [200, true, 200, "undone", "ok"], `mock '${text}': proposal → confirm → undo`);
      return r.text;
    };
    await run("open saturday 9 to 1", "jwt-owner", (d) => d.T.settings[0].catalog.hours.days[6].on === true, "office hours");
    await run("add a task", "jwt-owner", (d) => d.T.tasks.length === 1 && d.T.tasks[0].assignees[0] === "Olivia Owner" && d.T.tasks[0].due === "2026-10-16", "task (assigned to the person, due tomorrow)");
    await run("add a task for Gabe", "jwt-va", (d) => d.T.tasks[0].assignees[0] === "Gabe Tech", "task for someone");
    await run("move lead to quoted", "jwt-manager", (d) => contact(d, 1).status === "Quoted" && contact(d, 1).next_follow_up === "2026-10-17", "stage");
    await run("mark lead lost", "jwt-manager", (d) => contact(d, 1).status === "Lost" && contact(d, 1).lost_reason === "tooExpensive", "lost");
    const t1 = await run("add a note", "jwt-va", (d) => contact(d, 1).customer_notes.length === 2, "note");
    const t2 = await run("add a note", "jwt-va", (d) => contact(d, 1).customer_notes.length === 2, "note");
    const norm = (s: any) => String(s).replace(/id[0-9a-z]{8,}/g, "<uid>");
    ok(!!t1 && norm(t1) === norm(t2), "the scripts are deterministic (same SSE transcript, apart from the note's random id)");
    const db = world2();
    const r = await chat(db, { text: "move lead to won" }, "jwt-manager");
    eq([errText(db, r), db.T.ai_changes.length, evs(r, "tool").slice(-1)[0].status], ["The tool failed: Won is set automatically once the customer has a job in Jobs & Commissions", 0, "error"], "mock 'move lead to won': is_error, nothing proposed");
  }

  io.userClient = G1_USER_CLIENT;
});
