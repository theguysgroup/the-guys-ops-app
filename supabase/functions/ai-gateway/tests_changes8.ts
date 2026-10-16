// Tests for stage 8's change kinds (step C): task_update (update_task) and lead_follow_up (set_lead_follow_up):
// propose → confirm → undo with the person's own client, the compare-and-set refusals on confirm and on undo, who may,
// the app's rules (a New lead's follow-up date is a stage move; a day after today), the vacation lines, the ai_changes
// rows and the history lines. Appended to tests.ts by run_tests.sh; it only pushes a suite, so it shares tests.ts's
// helpers (fakeDb, eq, ok, chat, manage, …) and APP.
// deno-lint-ignore-file no-explicit-any

SUITES.push(async () => {
  const BEFORE_USER_CLIENT = io.userClient;
  const clone = (v: any) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const canon = (v: any): string => JSON.stringify(v ?? null, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
  const jeq = (a: any, b: any) => canon(a ?? null) === canon(b ?? null);
  const LID = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const TID = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  // ── the five roles (the app's default pages per role), leads, tasks, employees ──
  const prof = (id: string, full_name: string, role: string, technician_name: string | null = null, extra: any = {}) =>
    ({ id, full_name, role, permissions: { ...APP.defaultPermissionsFor(role), ...extra }, technician_name });
  const OW = prof("c8-owner", "Olivia Owner", "owner"), MG = prof("c8-manager", "Max Manager", "manager");
  const VA8 = prof("c8-va", "Vera Vance", "va", null, { crm: true, tasks: true });
  const TE = prof("c8-tech", "Tia Tech", "technician", "Tia", { tasks: true }), TN = prof("c8-techn", "Tom Noname", "technician", null, { tasks: true });
  const MK = prof("c8-mkt", "Mia Marketing", "marketing");
  const JWT8: Record<string, string> = { "j8-owner": OW.id, "j8-manager": MG.id, "j8-va": VA8.id, "j8-tech": TE.id, "j8-techn": TN.id, "j8-mkt": MK.id };
  const CAT = { region: { timeZone: TZ }, branding: { appName: "Acme Ops" } };
  const lead = (n: number, over: any) => ({
    id: LID(n), full_name: "", phone: "", status: "New", stage_changed_at: "2026-10-01T00:00:00.000Z", next_follow_up: null, chasing_since: null,
    chase_alert_done: false, chase_round: 0, lost_reason: "", booked_for: null, reopened_at: null, contacted_at: "2026-10-15T15:30:00.000Z",
    created_at: "2026-10-15T15:00:00.000Z", messages: [{ id: "m" + n, kind: "in", text: "Hi", at: "2026-10-15T15:00:00.000Z" }], customer_notes: [], ...over,
  });
  const LEADS = () => [
    lead(1, { full_name: "Demo Lead", phone: "0491 570 006", stage_changed_at: null, contacted_at: null }),
    lead(2, { full_name: "Quinn Quoted", status: "Quoted", next_follow_up: "2026-10-20" }),
    lead(3, { full_name: "Bob Booked", status: "Booked", booked_for: "2026-10-17", contacted_at: null }),
    lead(4, { full_name: "Legacy Quote", status: "Quoted", stage_changed_at: null, created_at: "2026-09-01T15:00:00.000Z" }),
    lead(5, { full_name: "Nora Chasing", status: "Chasing", chasing_since: "2026-10-12T00:00:00.000Z", chase_round: 2 }),
  ];
  const task = (n: number, over: any) => ({ id: TID(n), title: "", board: "ron", status: "Not Started", due: null, priority: "", assignees: [], assigned_to: null, notes: "", ...over });
  const TASKS = () => [
    task(1, { title: "Call the supplier", due: "2026-10-16", assignees: ["Kim Lane"] }),
    task(2, { title: "Clean the van", board: "Tia", status: "In Progress", assignees: ["Tia Tech"] }),
    task(3, { title: "Order filters", board: "Gabe Tech", status: "Stuck", due: "2026-10-20", assignees: ["Gabe Tech"] }),
    task(4, { title: "Order parts", board: "Gabe Tech", assignees: ["Gabe Tech", "Tia"] }),
    task(5, { title: "Call the bank", status: "Done", assignees: ["Vera Vance"] }),
  ];
  const EMPLOYEES = () => [
    { id: "e1", name: "Kim Lane", status: "Active", roles: ["VA"] }, { id: "e2", name: "Sam Lee", status: "Active", roles: [] },
    { id: "e3", name: "Gabe Tech", status: "Active", roles: ["Technician"] }, { id: "e4", name: "Tia Tech", status: "Active", roles: ["Technician"] },
  ];

  // ── the database's row-level security, as assumed (tasks: the Tasks page; a technician changes only his own board's
  // tasks or one assigned to him; contacts: the CRM page) ──
  const isOM = (u: any) => u.role === "owner" || u.role === "manager";
  const techMay = (u: any, r: any) => r.board === u.technician_name || (Array.isArray(r.assignees) && (r.assignees.includes(u.full_name) || (!!u.technician_name && r.assignees.includes(u.technician_name))));
  const RLS = {
    select: (t: string, _r: any, u: any) => (t === "contacts" ? isOM(u) || !!u.permissions.crm : t === "tasks" ? isOM(u) || !!u.permissions.tasks : true),
    update: (t: string, r: any, u: any) => (t === "contacts" ? isOM(u) || !!u.permissions.crm : t === "tasks" ? isOM(u) || (!!u.permissions.tasks && (u.role !== "technician" || techMay(u, r))) : false),
    insert: (t: string) => t === "activity_log",
  };
  const CONTACT_OK = ["status", "stage_changed_at", "next_follow_up", "chasing_since", "chase_alert_done", "chase_round", "lost_reason", "booked_for", "contacted_at"];
  // ai_contact_cas (stage6-cobra.sql G2-changes) and ai_task_cas (stage8-assistant.sql S8-changes) as plain code: the row
  // is locked only when the person can see AND update it.
  function casRpc(db: any, u: any, name: string, a: any) {
    const T = db.T, res = (data: any) => ({ data, error: null }), err = (message: string) => ({ data: null, error: { message } });
    if (name === "ai_task_cas") {
      for (const k of Object.keys(a.p_patch || {})) if (!["status", "due"].includes(k)) return err(`ai_task_cas: ${k} is not a field the assistant changes`);
      for (const k of Object.keys(a.p_expected || {})) if (!["status", "due", "title", "board"].includes(k)) return err(`ai_task_cas: ${k} is not a compared field`);
      const row = (T.tasks || []).find((r: any) => r.id === a.p_id);
      if (!row || !u || !RLS.select("tasks", row, u) || !RLS.update("tasks", row, u)) return res({ ok: false, code: "gone" });
      for (const [k, v] of Object.entries(a.p_expected || {})) if (!jeq(row[k], v)) return res({ ok: false, code: "changed", field: k, now: clone(row[k] ?? null) });
      Object.assign(row, clone(a.p_patch || {}));
      return res({ ok: true, row: { id: row.id, status: row.status ?? null, due: row.due ?? null } });
    }
    if (name === "ai_contact_cas") {
      for (const k of Object.keys({ ...(a.p_patch || {}), ...(a.p_expected || {}) })) if (!CONTACT_OK.includes(k)) return err(`ai_contact_cas: ${k} is not a field the assistant changes`);
      const row = (T.contacts || []).find((r: any) => r.id === a.p_id);
      if (!row || !u || !RLS.select("contacts", row, u) || !RLS.update("contacts", row, u)) return res({ ok: false, code: "gone" });
      for (const [k, v] of Object.entries(a.p_expected || {})) if (!jeq(row[k], v)) return res({ ok: false, code: "changed", field: k, now: clone(row[k] ?? null) });
      Object.assign(row, clone(a.p_patch || {}));
      if (a.p_event) row.messages = [...(row.messages || []), clone(a.p_event)];
      const out: any = { id: row.id }; for (const k of CONTACT_OK) out[k] = clone(row[k] ?? null);
      return res({ ok: true, row: out });
    }
    return err("no such function");
  }
  const UW: string[] = [], UJ: string[] = [];
  function userClient8(jwt: string) {
    UJ.push(jwt);
    const db = CUR, u = (db.T.profiles || []).find((p: any) => p.id === JWT8[jwt]);
    return {
      __jwt: jwt,
      from(t: string) {
        const b = db.from(t).where((r: any) => !!u && RLS.select(t, r, u));
        let denied = false;
        const ins = b.insert, upd = b.update, then = b.then;
        b.insert = (p: any) => { UW.push(t + ".insert"); if (!u || !RLS.insert(t)) denied = true; return ins(p); };
        b.update = (p: any) => { UW.push(t + ".update"); denied = true; return upd(p); };   // every write goes through a CAS function
        b.then = (ok2: any, no: any) => (denied ? Promise.resolve({ data: null, error: { code: "42501", message: `row-level security policy for table "${t}"` } }).then(ok2, no) : then(ok2, no));
        return b;
      },
      rpc: async (name: string, a: any) => { UW.push("rpc:" + name); return casRpc(db, u, name, a); },
    };
  }
  function world(o: { catalog?: any; seed?: Record<string, any[]> } = {}) {
    NOW = T0; UW.length = 0; UJ.length = 0;
    const db = fakeDb({
      profiles: [OW, MG, VA8, TE, TN, MK].map(clone),
      settings: [{ id: 1, company_name: "Acme Home Services", catalog: clone(o.catalog ?? CAT) }],
      ai_settings: [AI_ROW()], ai_usage: [], ai_conversations: [], ai_messages: [], ai_changes: [], activity_log: [],
      tasks: TASKS(), contacts: LEADS(), jobs: [], employees: EMPLOYEES(), employee_vacations: [],
      app_keys: [{ name: "vapid", value: { publicKey: "pk", privateKey: "sk" } }], push_subscriptions: [],
      ...(o.seed || {}),
    }, { jwts: JWT8 });
    CUR = db;
    return db;
  }
  io.userClient = (jwt: string) => userClient8(jwt);
  const toolCall = (db: any, jwt: string, tool: string, input: any) => chat(db, { text: `[mock:tool ${tool} ${JSON.stringify(input)}]` }, jwt);
  const resultOf = (db: any, r: any) => {
    const tr = msgs(db, convOf(r)).find((m: any) => m.role === "user" && Array.isArray(m.content) && m.content[0] && m.content[0].type === "tool_result");
    return tr ? tr.content[0] : null;
  };
  const errText = (db: any, r: any) => { const b = resultOf(db, r); return b && b.is_error ? String(b.content) : ""; };
  const lastChange = (db: any) => db.T.ai_changes[db.T.ai_changes.length - 1];
  const taskOf = (db: any, n: number) => db.T.tasks.find((t: any) => t.id === TID(n));
  const contact = (db: any, n: number) => db.T.contacts.find((c: any) => c.id === LID(n));
  const acts = (db: any) => db.T.activity_log.map((a: any) => [a.record_kind, a.record_id, a.text]);
  const propose = async (db: any, jwt: string, tool: string, input: any) => { const r = await toolCall(db, jwt, tool, input); return { r, e: errText(db, r).replace(/^The tool failed: /, ""), row: lastChange(db) }; };
  const confirm = (db: any, id: string, jwt: string) => manage(db, { step: "confirm_change", id }, jwt);
  const undo = (db: any, id: string, jwt: string) => manage(db, { step: "undo_change", id }, jwt);
  const P = (x: any) => appProfile(x);
  const VIA = "(via Acme Ops)";
  const NEW8 = ["set_lead_follow_up", "update_task"];

  // ── 1. registry, schemas and who gets the tools ──
  {
    eq([CHANGE_KINDS.task_update.label, CHANGE_KINDS.lead_follow_up.label], ["Task change", "Follow-up date"], "the two stage 8 kinds are registered");
    for (const n of NEW8) {
      const t = TOOLS[n];
      eq([t.kind, t.modes, strictSchemaProblems(t.input_schema)], ["change", ["assistant"], []], `${n}: a change tool of the assistant mode with a strict schema`);
      eq(toOpenAiTools(apiTools([t]))[0].function.parameters, t.input_schema, `${n}: the same schema as an OpenAI-style function`);
      ok(/Nothing changes until the person presses Confirm/.test(t.description) && /never say it is done/.test(t.description) && t.description.length <= 400, `${n}: the description says it only proposes`);
      ok(!/\d{4}-\d{2}|Olivia|Acme|Demo Lead/.test(t.description), `${n}: no dates or names in the description (cache-stable)`);
    }
    eq(TOOLS.update_task.input_schema.properties.status.enum, APP.TASK_STATUSES, "update_task's statuses = the app's TASK_STATUSES");
    const names = (p: any) => toolsFor("assistant", P(p)).map((t) => t.name).filter((n) => NEW8.includes(n));
    eq([names(OW), names(MG), names(VA8)], [NEW8, NEW8, NEW8], "owner, manager and a VA with CRM + Tasks: both");
    eq([names(TE), names(TN), names(MK)], [["update_task"], [], []], "a technician: update_task only (none without his own board); marketing: neither");
    eq(names({ ...VA8, permissions: { crmOverview: true } }), [], "Leads & Marketing alone: read-only");
  }

  // ── 2. a task: propose → confirm → undo ──
  {
    let db = world();
    let { e, row } = await propose(db, "j8-owner", "update_task", { task: "supplier", status: "Done" });
    eq([e, row.kind, row.user_id, row.status, row.target, row.before, row.after], ["", "task_update", OW.id, "proposed", { table: "tasks", id: TID(1), label: "Call the supplier" },
      { cols: { status: "Not Started", due: "2026-10-16" } }, { cols: { status: "Done", due: "2026-10-16" } }], "mark it done (by title words): the proposal row");
    eq([row.summary, row.display], ['Set the task "Call the supplier" to Done', { title: 'Set the task "Call the supplier" to Done', rows: [{ label: "Status", before: "Not Started", after: "Done" }] }], "… summary and card");
    eq([taskOf(db, 1).status, db.T.activity_log.length, UW.filter((w) => w !== "tasks.select")], ["Not Started", 0, []], "proposing writes nothing");
    NOW = T0 + 60000;
    let c = await confirm(db, row.id, "j8-owner");
    eq([c.status, c.body.change.status, taskOf(db, 1).status, taskOf(db, 1).due, lastChange(db).after.cols], [200, "confirmed", "Done", "2026-10-16", { status: "Done", due: "2026-10-16" }], "confirm: written through ai_task_cas");
    eq(acts(db), [["task", TID(1), `Status changed from "Not Started" to "Done" ${VIA}`]], "history: the app's words, via the assistant");
    ok(UW.includes("rpc:ai_task_cas") && UJ.length > 0 && UJ.every((j) => j === "j8-owner"), "with the person's own token");
    let u = await undo(db, row.id, "j8-owner");
    eq([u.status, lastChange(db).status, taskOf(db, 1).status], [200, "undone", "Not Started"], "undo: back as it was");
    eq(acts(db)[1], ["task", TID(1), `Status changed from "Done" to "Not Started" (undone, via Acme Ops)`], "… with its own history line");
    // the due date, by id, by a VA; the business's own word for Done
    db = world({ catalog: { ...CAT, keys: { done: "Complete" } } });
    ({ e, row } = await propose(db, "j8-va", "update_task", { task_id: TID(1), status: "Done", due: "2026-10-19" }));
    eq([e, row.after.cols, row.summary, row.display.rows], ["", { status: "Complete", due: "2026-10-19" }, 'Set the task "Call the supplier" to Complete, due 19 Oct',
      [{ label: "Status", before: "Not Started", after: "Complete" }, { label: "Due", before: "16 Oct", after: "19 Oct" }]], "both fields; Done as the business calls it");
    c = await confirm(db, row.id, "j8-va");
    eq([c.status, taskOf(db, 1).status, taskOf(db, 1).due], [200, "Complete", "2026-10-19"], "… confirmed");
    eq(acts(db).map((a: any) => a[2]), [`Status changed from "Not Started" to "Complete" ${VIA}`, `Due date changed from "2026-10-16" to "2026-10-19" ${VIA}`], "… one history line per field");
    u = await undo(db, row.id, "j8-va");
    eq([u.status, taskOf(db, 1).status, taskOf(db, 1).due], [200, "Not Started", "2026-10-16"], "… undone, both fields");
    // a due date on a task with none
    db = world();
    ({ e, row } = await propose(db, "j8-manager", "update_task", { task: "van", due: "2026-10-23" }));
    eq([e, row.before.cols, row.display.rows], ["", { status: "In Progress", due: null }, [{ label: "Due", before: "—", after: "23 Oct" }]], "no due date before");
    await confirm(db, row.id, "j8-manager");
    eq(acts(db).map((a: any) => a[2]), [`Due date changed from "—" to "2026-10-23" ${VIA}`], "… history from —");
    await undo(db, row.id, "j8-manager");
    eq(taskOf(db, 2).due, null, "… undo takes the date away again");
  }

  // ── 3. changed since: on confirm and on undo (the optimistic lock) ──
  {
    let db = world();
    let { row } = await propose(db, "j8-owner", "update_task", { task_id: TID(1), status: "Done" });
    taskOf(db, 1).status = "In Progress";   // someone else, in the app, meanwhile
    let c = await confirm(db, row.id, "j8-owner");
    eq([c.status, c.body.code, c.body.reason, lastChange(db).status, taskOf(db, 1).status, db.T.activity_log.length],
      [409, "changed_since", "The task was changed after this was suggested (status is now In Progress), so nothing was changed.", "failed", "In Progress", 0], "changed before Confirm → failed, nothing written");
    db = world();
    ({ row } = await propose(db, "j8-owner", "update_task", { task_id: TID(1), due: "2026-10-21" }));
    await confirm(db, row.id, "j8-owner");
    taskOf(db, 1).due = "2026-10-22";
    c = await undo(db, row.id, "j8-owner");
    eq([c.status, c.body.code, c.body.reason, lastChange(db).status, taskOf(db, 1).due], [409, "changed_since", "The task was changed again after this (due date is now 2026-10-22), so it can't be put back.", "confirmed", "2026-10-22"], "changed after Confirm → undo refused, stays confirmed");
    db = world();
    ({ row } = await propose(db, "j8-owner", "update_task", { task_id: TID(1), due: "2026-10-21" }));
    db.T.tasks = db.T.tasks.filter((t: any) => t.id !== TID(1));
    c = await confirm(db, row.id, "j8-owner");
    eq([c.status, c.body.code, lastChange(db).status], [409, "gone", "failed"], "deleted meanwhile → gone");
  }

  // ── 4. who may change which task ──
  {
    let db = world();
    let x = await propose(db, "j8-tech", "update_task", { task_id: TID(3), status: "Done" });
    eq([x.e, db.T.ai_changes.length], ["That task isn't on your board or assigned to you, so you can't change it.", 0], "a technician, a task on another board → not allowed, no proposal");
    x = await propose(db, "j8-tech", "update_task", { task: "filters", status: "Done" });
    eq([x.e, db.T.ai_changes.length], ["No task matches that you can see.", 0], "… by title: not among his tasks");
    x = await propose(db, "j8-tech", "update_task", { task: "Order", status: "Done" });
    eq([x.e, x.row && x.row.target.id], ["", TID(4)], "… by title: only the one assigned to him (on another board) matches");
    let c = await confirm(db, x.row.id, "j8-tech");
    eq([c.status, taskOf(db, 4).status], [200, "Done"], "… and he may change it (the database's rule)");
    db = world();
    x = await propose(db, "j8-tech", "update_task", { task: "van", due: "2026-10-19" });
    c = await confirm(db, x.row.id, "j8-tech");
    eq([x.e, c.status, taskOf(db, 2).due], ["", 200, "2026-10-19"], "his own board's task: proposed and saved");
    db = world();
    x = await propose(db, "j8-mkt", "update_task", { task: "van", status: "Done" });
    ok(/^Unknown tool update_task/.test(errText(db, x.r)) && db.T.ai_changes.length === 0, "marketing: not offered, refused");
    x = await propose(db, "j8-techn", "update_task", { task: "van", status: "Done" });
    ok(/^Unknown tool update_task/.test(errText(db, x.r)), "a technician without his own board: not offered");
    // a role taken away between propose and confirm
    db = world();
    x = await propose(db, "j8-va", "update_task", { task_id: TID(1), status: "Stuck" });
    db.T.profiles.find((p: any) => p.id === VA8.id).permissions = { crm: true };
    c = await confirm(db, x.row.id, "j8-va");
    eq([c.status, c.body.code, taskOf(db, 1).status], [403, "not_allowed", "Not Started"], "Tasks page taken away before Confirm → not allowed");
  }

  // ── 5. the task's own checks ──
  {
    const db = world();
    const E = async (input: any, jwt = "j8-owner") => (await propose(db, jwt, "update_task", input)).e;
    eq(await E({ status: "Done" }), "Say which task: words from its title (or its task_id).", "no task named");
    eq(await E({ task: "supplier" }), "Say what changes: the status, the due date or both.", "nothing to change asked");
    eq(await E({ task: "bank", status: "Done" }), '"Call the bank" already has that status (Done).', "already that status");
    eq(await E({ task: "supplier", due: "2026-10-16" }), '"Call the supplier" already has that due date (16 Oct).', "already that due date");
    eq(await E({ task: "supplier", status: "Not Started", due: "2026-10-16" }), '"Call the supplier" already has that status and due date.', "already both");
    eq(await E({ task: "supplier", due: "2029-01-01" }), "Pick a due date within two years of today.", "a due date years away");
    ok(/^Invalid input/.test(await E({ task: "supplier", status: "Finished" })), "a status that isn't the app's → invalid input");
    ok(/^Invalid input/.test(await E({ task: "supplier", due: "2026-02-30" })), "not a real date → invalid input");
    eq(await E({ task: "x".repeat(81), status: "Done" }), "task must be at most 80 characters.", "a long title query");
    const many = await E({ task: "call", status: "Done" });
    ok(many.startsWith("More than one task matches. Ask the person which one, then call again with its task_id: ") && /"task_id":"5000.*"board":"Office Tasks"/.test(many), "two match → which one? (ids, titles, boards)");
    eq(await E({ task: "nothing like it", status: "Done" }), "No task matches that you can see.", "no match");
    eq(db.T.ai_changes.length, 0, "no refused change left a proposal");
  }

  // ── 6. a due date moved onto someone's vacation: the app's question as lines on the card ──
  {
    const vac = { id: "v1", business_id: "default", employee_id: "e1", employee_name: "Kim Lane", starts_on: "2026-10-19", ends_on: "2026-10-24", stand_in_id: "e2", stand_in_name: "Sam Lee",
      options: { notAssignable: true, standIn: true }, ended_at: null, cancelled_at: null };
    let db = world({ seed: { employee_vacations: [clone(vac)] } });
    let x = await propose(db, "j8-owner", "update_task", { task: "supplier", due: "2026-10-20" });
    eq(x.row.display.warnings, ["Kim Lane is on vacation then (On vacation until 24 Oct).", "Or assign Sam Lee instead."], "moved into Kim's vacation: the line and the stand-in");
    eq(JSON.parse(String(resultOf(db, x.r).content)).warnings, x.row.display.warnings, "… told to the model too");
    eq([taskOf(db, 1).due, x.row.status], ["2026-10-16", "proposed"], "… a warning, never a block");
    db = world({ seed: { employee_vacations: [clone(vac)] } });
    x = await propose(db, "j8-owner", "update_task", { task: "supplier", due: "2026-10-25" });
    eq("warnings" in x.row.display, false, "back by then → no lines");
    db = world({ seed: { employee_vacations: [clone(vac)] } });
    x = await propose(db, "j8-owner", "update_task", { task: "supplier", status: "Stuck" });
    eq("warnings" in x.row.display, false, "only the status changes → no lines");
  }

  // ── 7. a lead's follow-up date ──
  {
    let db = world();
    let { e, row } = await propose(db, "j8-manager", "set_lead_follow_up", { lead: "Quinn", follow_up: "2026-10-22" });
    eq([e, row.kind, row.target, row.before, row.after], ["", "lead_follow_up", { table: "contacts", id: LID(2), label: "Quinn Quoted" }, { cols: { next_follow_up: "2026-10-20" } },
      { cols: { next_follow_up: "2026-10-22" }, from: "2026-10-20", to: "2026-10-22" }], "a Quoted lead: only the date");
    eq([row.summary, row.display.rows], ["Set Quinn Quoted's follow-up to 22 Oct (was 20 Oct)", [{ label: "Follow-up", before: "20 Oct", after: "22 Oct" }]], "… summary and card");
    eq([contact(db, 2).next_follow_up, db.T.activity_log.length], ["2026-10-20", 0], "proposing writes nothing");
    NOW = T0 + 60000;
    let c = await confirm(db, row.id, "j8-manager");
    eq([c.status, contact(db, 2).next_follow_up, contact(db, 2).status, contact(db, 2).contacted_at], [200, "2026-10-22", "Quoted", "2026-10-15T15:30:00.000Z"], "confirm: the date only (already contacted)");
    eq(acts(db), [["contact", LID(2), `Follow-up date changed from "2026-10-20" to "2026-10-22" ${VIA}`]], "history: the app's words");
    ok(UW.includes("rpc:ai_contact_cas") && UJ.every((j) => j === "j8-manager"), "with the person's own token");
    let u = await undo(db, row.id, "j8-manager");
    eq([u.status, contact(db, 2).next_follow_up, acts(db)[1][2]], [200, "2026-10-20", `Follow-up date change undone ${VIA}`], "undo: the old date back, a history line");
    // a Booked lead nobody acted on yet: the date, and it counts as contacted
    db = world();
    ({ e, row } = await propose(db, "j8-va", "set_lead_follow_up", { lead: "Bob", follow_up: "2026-10-30" }));
    eq([e, row.kind, row.display.rows], ["", "lead_follow_up", [{ label: "Follow-up", before: "—", after: "30 Oct" }]], "a Booked lead: only the date");
    c = await confirm(db, row.id, "j8-va");
    eq([c.status, contact(db, 3).next_follow_up, contact(db, 3).contacted_at], [200, "2026-10-30", new Date(T0).toISOString()], "… saved; marked contacted (the app's markLeadContacted)");
    await undo(db, row.id, "j8-va");
    eq([contact(db, 3).next_follow_up, contact(db, 3).contacted_at], [null, new Date(T0).toISOString()], "… undo: no date again (contacted stays, as a stage undo)");
    // a New or Chasing lead with Follow up on → the stage move to Follow up (a lead_stage proposal)
    db = world();
    ({ e, row } = await propose(db, "j8-manager", "set_lead_follow_up", { lead: "Demo Lead", follow_up: "2026-10-19" }));
    eq([e, row.kind, row.summary, row.display.rows], ["", "lead_stage", "Move Demo Lead from New lead to Follow up", [{ label: "Stage", before: "New lead", after: "Follow up" }, { label: "Follow-up", before: "—", after: "19 Oct" }]], "a New lead → becomes a lead_stage proposal (the app's setLeadFollowupDate)");
    c = await confirm(db, row.id, "j8-manager");
    eq([c.status, contact(db, 1).status, contact(db, 1).next_follow_up], [200, "Follow-up", "2026-10-19"], "… confirmed: in Follow up with the date");
    db = world();
    ({ e, row } = await propose(db, "j8-manager", "set_lead_follow_up", { lead: "Nora", follow_up: "2026-10-19" }));
    eq([e, row.kind, row.after.cols.status], ["", "lead_stage", "Follow-up"], "a Chasing lead → the same");
    db = world({ catalog: { ...CAT, stages: [{ key: "Follow-up", label: "Follow up", active: false }] } });
    ({ e, row } = await propose(db, "j8-manager", "set_lead_follow_up", { lead: "Demo Lead", follow_up: "2026-10-19" }));
    eq([e, row.kind], ["", "lead_follow_up"], "Follow up switched off → a New lead just gets the date");
    // the day must be after today (the business's: Thursday 15 Oct)
    const E = async (input: any, cat?: any) => { const d = world(cat ? { catalog: cat } : {}); const x = await propose(d, "j8-manager", "set_lead_follow_up", input); return [x.e, d.T.ai_changes.length]; };
    eq(await E({ lead: "Demo Lead", follow_up: "2026-10-15" }), ["Pick a follow-up day after today.", 0], "today, a New lead → invalid");
    eq(await E({ lead: "Quinn", follow_up: "2026-10-15" }), ["A lead in Quoted needs a follow-up day after today.", 0], "today, a Quoted lead → the stage's rule");
    eq(await E({ lead: "Legacy", follow_up: "2026-10-01" }), ["Pick a follow-up day after today.", 0], "a lead from before the rules (leadRulesApply false) → still after today");
    eq(await E({ lead: "Bob", follow_up: "2026-10-14" }), ["Pick a follow-up day after today.", 0], "the past, a Booked lead → invalid");
    eq(await E({ lead: "Quinn", follow_up: "2026-10-20" }), ["Quinn Quoted's follow-up is already 20 Oct.", 0], "the same day → nothing to change");
    eq(await E({ follow_up: "2026-10-20" }), ["Say which lead: its name or phone number (or its lead_id).", 0], "no lead named");
    // changed since: on confirm and on undo
    db = world();
    ({ row } = await propose(db, "j8-manager", "set_lead_follow_up", { lead: "Quinn", follow_up: "2026-10-22" }));
    contact(db, 2).next_follow_up = "2026-10-25";
    c = await confirm(db, row.id, "j8-manager");
    eq([c.status, c.body.code, c.body.reason, lastChange(db).status, contact(db, 2).next_follow_up, db.T.activity_log.length],
      [409, "changed_since", "Quinn Quoted's follow-up date was changed after this was suggested (now 25 Oct), so nothing was changed.", "failed", "2026-10-25", 0], "changed before Confirm → failed, nothing written");
    db = world();
    ({ row } = await propose(db, "j8-manager", "set_lead_follow_up", { lead: "Quinn", follow_up: "2026-10-22" }));
    await confirm(db, row.id, "j8-manager");
    contact(db, 2).next_follow_up = null;
    c = await undo(db, row.id, "j8-manager");
    eq([c.status, c.body.code, c.body.reason, lastChange(db).status], [409, "changed_since", "Quinn Quoted's follow-up date was changed again after this (now none), so it can't be put back.", "confirmed"], "changed after Confirm → undo refused, stays confirmed");
    // who
    db = world();
    let x = await propose(db, "j8-tech", "set_lead_follow_up", { lead: "Quinn", follow_up: "2026-10-22" });
    ok(/^Unknown tool set_lead_follow_up/.test(errText(db, x.r)) && db.T.ai_changes.length === 0, "a technician: not offered");
    x = await propose(db, "j8-mkt", "set_lead_follow_up", { lead: "Quinn", follow_up: "2026-10-22" });
    ok(/^Unknown tool set_lead_follow_up/.test(errText(db, x.r)) && db.T.ai_changes.length === 0, "marketing: not offered");
    // a technician with the CRM: only the jobs he can see make a lead Won (the app's leadWonByJob over his filtered
    // jobs), so the kind of proposal never gives away another technician's job
    const TC = prof("c8-techc", "Tia Crm", "technician", "Tia", { tasks: true, crm: true, jobs: true });
    JWT8["j8-techc"] = TC.id;
    const gabeJob = { id: "jx", date: "2026-10-15", technician: "Gabe", customer_name: "Demo Lead", contact_id: LID(1) };
    db = world({ seed: { profiles: [OW, MG, VA8, TE, TN, MK, TC].map(clone), jobs: [gabeJob] } });
    ({ e, row } = await propose(db, "j8-techc", "set_lead_follow_up", { lead: "Demo Lead", follow_up: "2026-10-19" }));
    eq([e, row && row.kind, row && row.summary], ["", "lead_stage", "Move Demo Lead from New lead to Follow up"], "a technician with the CRM, the lead's only job is another technician's: New (as his app shows it) → the stage move");
    db = world({ seed: { jobs: [gabeJob] } });
    ({ e, row } = await propose(db, "j8-manager", "set_lead_follow_up", { lead: "Demo Lead", follow_up: "2026-10-19" }));
    eq([e, row && row.kind], ["", "lead_follow_up"], "… a manager sees that job: Won, so only the date");
  }

  // ── 8. the ai_changes rows, and nothing but them written with the service role ──
  {
    const db = world();
    const a = await propose(db, "j8-owner", "update_task", { task: "supplier", status: "Stuck" });
    const b = await propose(db, "j8-owner", "set_lead_follow_up", { lead: "Quinn", follow_up: "2026-10-23" });
    await confirm(db, a.row.id, "j8-owner"); await confirm(db, b.row.id, "j8-owner");
    await undo(db, b.row.id, "j8-owner");
    eq(db.T.ai_changes.map((r: any) => [r.kind, r.status, r.business_id, r.user_id, !!r.confirmed_at, r.undone_by || null]),
      [["task_update", "confirmed", "default", OW.id, true, null], ["lead_follow_up", "undone", "default", OW.id, true, OW.id]], "one row per change, its status and who");
    const left = UW.filter((w) => !w.startsWith("rpc:"));
    ok(db.ctl.writes.filter((w: string) => { const i = left.indexOf(w); if (i >= 0) { left.splice(i, 1); return false; } return true; }).every((w: string) => /^ai_/.test(w)), "the service role wrote only ai_* rows");
    const l = await manage(db, { step: "list_changes" }, "j8-owner");
    eq(l.body.changes.map((x: any) => x.label).sort(), ["Follow-up date", "Task change"], "the change log shows the kinds' labels");
  }

  // ── 9. the app's rules, parity with index.html ──
  {
    eq(PIPELINE_RULES_FROM, APP.PIPELINE_RULES_FROM, "PIPELINE_RULES_FROM = the app's");
    APP.STATE.data.settings.catalog = { region: { timeZone: TZ } };
    const cases = [{ s: "2026-10-01T00:00:00Z", c: "2026-01-01T00:00:00Z" }, { s: null, c: "2026-09-27T12:00:00Z" }, { s: null, c: "2026-09-26T12:00:00Z" },
      { s: null, c: "2026-09-27T02:00:00Z" }, { s: null, c: "2026-09-28" }, { s: null, c: null }];
    eq(cases.map((x) => leadRulesApply({ stage_changed_at: x.s, created_at: x.c }, TZ)), cases.map((x) => APP.leadRulesApply({ stageChangedAt: x.s, createdAt: x.c })), "leadRulesApply = the app's (business day of created_at)");
    APP.STATE.data.settings.catalog = {};
    const stageCats: [any, any][] = [[{}, null], [{ stages: [{ key: "Follow-up", label: "Follow up", active: false }] }, ["New", "Chasing", "Quoted", "Booked", "Won", "Lost"]]];
    for (const [cat, active] of stageCats) {
      APP.ACTIVE.stages = active ? new Set(active) : null;
      eq(["New", "Follow-up", "Quoted", "Won"].map((k) => stageOn(cat, k)), ["New", "Follow-up", "Quoted", "Won"].map((k) => APP.stageOn(k)), `stageOn = the app's (${active ? "Follow up off" : "nothing saved"})`);
    }
    APP.ACTIVE.stages = null;
  }

  io.userClient = BEFORE_USER_CLIENT;
});
