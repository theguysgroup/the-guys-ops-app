// Writes the fixtures next to it (supabase/functions/automations/fixtures/*.json), read by tests.ts (and, from phase 4,
// by tests/business-logic.test.js for the app copies). Every expected code / doc below is written by hand here (never
// computed by the engine), so the tests compare against an independent statement. Run: node fixtures/make.js
const fs = require("fs");
const OUT = __dirname;
fs.mkdirSync(OUT, { recursive: true });
const clone = (x) => JSON.parse(JSON.stringify(x));
// one case per line (small, diff-friendly); other keys pretty
const write = (name, data) => {
  const { cases: list, ...rest } = data;
  const head = JSON.stringify(rest, null, 1).replace(/\n}$/, "");
  const body = list ? `,\n "cases": [\n${list.map((c) => "  " + JSON.stringify(c)).join(",\n")}\n ]\n}` : "\n}";
  fs.writeFileSync(`${OUT}/${name}`, head + body + "\n");
};

// ── shared pieces ──
const G23 = { phone: false, xero: false, gbp: false, reviews: false, ai: false, teamEmail: false, assignee: false, atomicTags: true };   // today + G2.3
const NOW = { ...G23, atomicTags: false };                                                                                              // today
const EMPTY_F = () => ({ match: "all", segments: [{ match: "all", rules: [] }] });
const T = (id, type, x = {}) => ({ id, type, filters: EMPTY_F(), ...x });
const R = (field, op, x = {}) => ({ field, op, ...x });
const F = (...rules) => ({ match: "all", segments: [{ match: "all", rules }] });
const W = (...rules) => ({ match: "any", segments: [{ match: "all", rules }] });
const push = (next = null, x = {}) => ({ kind: "action", type: "internal_notification", config: { channel: "push", to: { roles: ["owner"] }, title: "New lead: {name}", ...x }, out: { next } });
const pushPlain = (next = null) => push(next, { title: "Check the office" });
const email = (next = null, x = {}) => ({ kind: "action", type: "send_email", config: { subject: "Your quote", body: "Hi {first_name}", ...x }, out: { next } });
const period = (next, n = 10, unit = "minutes") => ({ kind: "wait", type: "period", config: { n, unit }, out: { next } });
const ifel = (bid, when, yes, none = null, x = {}) => ({ kind: "if_else", type: "if_else", config: { branches: [{ id: bid, name: "Yes", when }], noneName: "None", ...x }, out: { [bid]: yes, none } });
const goto = (target) => ({ kind: "goto", type: "goto", config: { target }, out: {} });
const BASE = { schema: 2, seq: 3, entry: "n1", triggers: [T("t1", "newLead")], nodes: { n1: period("n2"), n2: push() } };
const CANON = {
  schema: 2, seq: 9, entry: "n1",
  triggers: [
    { id: "t1", type: "stage", name: "Moved to Quoted", filters: F(R("stage", "is", { v: "quoted" })) },
    { id: "t2", type: "contact_tag", name: "Tagged quote-sent", filters: F(R("trigger.tag", "is", { v: "quote-sent" }), R("trigger.action", "is", { v: "added" })) },
  ],
  nodes: {
    n1: { kind: "wait", type: "period", name: "Wait 2 days", config: { n: 2, unit: "days", resume: { days: [1, 2, 3, 4, 5], from: "09:00", until: "17:00" } }, out: { next: "n2" } },
    n2: { kind: "if_else", type: "if_else", name: "Still quoted?", config: { branches: [{ id: "b3", name: "Still quoted", when: W(R("stage", "is", { v: "quoted" }), R("has_email", "true")) }], noneName: "None" }, out: { b3: "n4", none: null } },
    n4: { kind: "action", type: "send_email", name: "Quote follow-up", config: { subject: "Your {service} quote", body: "Hi {first_name}, just checking you got our quote…" }, out: { next: "n5" } },
    n5: { kind: "wait", type: "reply", name: "Wait for a reply", config: { channels: ["email", "chat"], timeout: { n: 3, unit: "days" } }, out: { next: "n6", timeout: "n7" } },
    n6: { kind: "action", type: "internal_notification", config: { channel: "push", to: { roles: ["va"] }, title: "{name} replied about the quote" }, out: { next: null } },
    n7: { kind: "goal", type: "stage_reached", name: "Booked?", config: { stages: ["booked"], ifNotMet: "continue" }, out: { next: "n8" } },
    n8: { kind: "action", type: "manual_call", config: { title: "Call {name} about the quote" }, out: { next: null } },
  },
};
const UP3 = { schema: 2, seq: 4, entry: "s1",
  triggers: [{ id: "t1", type: "newLead", name: "Contact created", filters: EMPTY_F() }],
  nodes: {
    s1: { kind: "wait", type: "period", config: { n: 10, unit: "minutes" }, out: { next: "s2" } },
    s2: { kind: "if_else", type: "if_else", config: { gate: true, noneName: "None", branches: [{ id: "s2_yes", name: "Yes", when: W(R("has_email", "true")) }] }, out: { s2_yes: "s3", none: null } },
    s3: { kind: "wait", type: "recurring", config: { mode: "window", window: { use: "office", outside: "next" } }, out: { next: "s4" } },
    s4: { kind: "action", type: "send_email", config: { subject: "Thanks {first_name}", templateKey: "my_ab12cd34" }, out: { next: null } },
  } };
const MIGRATED = { reentry: "legacy_always", perRecord: true, stopOnResponse: false, timezone: "business", window: { on: false }, sender: { fromName: null }, markRead: false };

// ── workflows.json: validator parity cases (codes are exact; schema = does the generated JSON Schema accept it) ──
const cases = [];
const add = (name, doc, errors, warnings, x = {}) => cases.push({ name, scope: x.scope || "both", builder: x.builder || "standard", avail: x.avail || G23, ...(x.catalog ? { catalog: x.catalog } : {}),
  ...(x.stored ? { stored: x.stored } : {}), ...(x.maxSteps ? { maxSteps: x.maxSteps } : {}), ...(x.settings ? { settings: x.settings } : {}), ...(x.schemaMode ? { schemaMode: x.schemaMode } : {}),
  doc, errors: errors.sort(), warnings: warnings.sort(), ...(x.schema !== undefined ? { schema: x.schema } : {}) });
const mut = (base, fn) => { const d = clone(base); fn(d); return d; };

add("canonical-1", CANON, [], [], { schema: true });
add("canonical-1 before G2.3: the tag trigger is greyed", CANON, ["E_UNAVAILABLE"], [], { avail: NOW, schema: false });
add("upgrade-3 (migrated, legacy gate)", UP3, [], [], { settings: MIGRATED, schema: true, schemaMode: "accept" });
add("upgrade-3: the generation schema has no legacy gate", UP3, [], [], { settings: MIGRATED, schema: false });
add("base", BASE, [], [], { schema: true });
add("empty workflow", { schema: 2, seq: 0, entry: null, triggers: [], nodes: {} }, ["E_NO_ACTION"], ["E_NO_TRIGGER"], { schema: true });
add("no trigger", mut(BASE, (d) => { d.triggers = []; }), [], ["E_NO_TRIGGER"], { schema: true });
add("only a disabled trigger", mut(BASE, (d) => { d.triggers[0].disabled = true; }), [], ["E_NO_TRIGGER"], { schema: true });
add("only a wait", { schema: 2, seq: 1, entry: "n1", triggers: [T("t1", "newLead")], nodes: { n1: period(null) } }, ["E_NO_ACTION"], ["W_LAST_NOT_ACTION"], { schema: true });
const ADV = mut(BASE, (d) => { d.triggers.push(T("t2", "stage", { goto: "n2" })); });
add("advanced: trigger Go to", ADV, [], [], { builder: "advanced", schema: true });
add("standard: trigger Go to needs Advanced", ADV, ["E_ADVANCED_ONLY"], [], { schema: false });
add("advanced: trigger Go to a missing step", mut(ADV, (d) => { d.triggers[1].goto = "zz"; }), ["E_GOTO_TARGET"], [], { builder: "advanced", schema: true });
const DELINK = mut(BASE, (d) => { d.nodes.n3 = pushPlain(); });
add("advanced: a delinked step", DELINK, [], ["W_DELINKED"], { builder: "advanced", schema: true });
add("standard: a delinked step", DELINK, ["E_ADVANCED_ONLY"], [], { schema: true });
const SPLIT = { schema: 2, seq: 5, entry: "n1", triggers: [T("t1", "newLead")], nodes: {
  n1: { kind: "split", type: "split", config: { paths: [{ id: "p1", name: "A", percent: 50 }, { id: "p2", name: "B", percent: 50 }] }, out: { p1: "n2", p2: "n3" } }, n2: push(), n3: pushPlain() } };
add("split 50/50", SPLIT, [], [], { schema: true });
add("split adds up to 90", mut(SPLIT, (d) => { d.nodes.n1.config.paths[1].percent = 40; }), ["E_SPLIT_PCT"], [], { schema: true });
add("split with one path", mut(SPLIT, (d) => { d.nodes.n1.config.paths = [{ id: "p1", name: "A", percent: 100 }]; d.nodes.n1.out = { p1: "n2" }; delete d.nodes.n3; }), ["E_SCHEMA", "E_SPLIT_PCT"], [], { schema: false });
add("split with a 0% path", mut(SPLIT, (d) => { d.nodes.n1.config.paths = [{ id: "p1", percent: 100 }, { id: "p2", percent: 0 }]; }), [], [], { schema: true });
add("weekly loop with a wait", { schema: 2, seq: 3, entry: "n1", triggers: [T("t1", "newLead")], nodes: { n1: period("n2", 7, "days"), n2: push("n3"), n3: goto("n1") } }, [], [], { schema: true });
add("tight loop without a wait", { schema: 2, seq: 2, entry: "n1", triggers: [T("t1", "newLead")], nodes: { n1: push("n2"), n2: goto("n1") } }, ["E_LOOP_NO_WAIT"], [], { schema: true });
add("loop with a reply wait without timeout", { schema: 2, seq: 3, entry: "n1", triggers: [T("t1", "newLead")], nodes: {
  n1: email("n2"), n2: { kind: "wait", type: "reply", config: { channels: ["email"] }, out: { next: "n3" } }, n3: goto("n1") } }, ["E_LOOP_NO_WAIT"], ["W_LOOP_CUSTOMER"], { schema: true });
add("loop with a reply wait with timeout", { schema: 2, seq: 3, entry: "n1", triggers: [T("t1", "newLead")], nodes: {
  n1: email("n2"), n2: { kind: "wait", type: "reply", config: { channels: ["email"], timeout: { n: 2, unit: "days" } }, out: { next: null, timeout: "n3" } }, n3: goto("n1") } }, [], ["W_LOOP_CUSTOMER"], { schema: true });
add("Go to a missing step", { schema: 2, seq: 2, entry: "n1", triggers: [T("t1", "newLead")], nodes: { n1: push("n2"), n2: goto("zz") } }, ["E_GOTO_TARGET"], [], { schema: true });
add("Go to with no target", { schema: 2, seq: 2, entry: "n1", triggers: [T("t1", "newLead")], nodes: { n1: push("n2"), n2: goto(null) } }, ["E_GOTO_TARGET"], [], { schema: true });
add("Go to with a step after it", { schema: 2, seq: 3, entry: "n1", triggers: [T("t1", "newLead")], nodes: { n1: period("n2"), n2: { ...goto("n1"), out: { next: "n3" } }, n3: push() } }, ["E_ADVANCED_ONLY", "E_GOTO_NOT_LAST"], [], { schema: false });
add("Remove from this workflow ends the path", { schema: 2, seq: 2, entry: "n1", triggers: [T("t1", "newLead")], nodes: { n1: push("n2"), n2: { kind: "workflow", type: "remove_from_workflow", config: { scope: "current" }, out: { next: null } } } }, ["E_GOTO_NOT_LAST"], [], { schema: true });
add("Remove from another workflow continues", { schema: 2, seq: 3, entry: "n1", triggers: [T("t1", "newLead")], nodes: { n1: { kind: "workflow", type: "remove_from_workflow", config: { scope: "another", workflowId: "w-1" }, out: { next: "n2" } }, n2: push() } }, [], [], { schema: true });
add("Remove from another workflow needs the workflow", { schema: 2, seq: 3, entry: "n1", triggers: [T("t1", "newLead")], nodes: { n1: { kind: "workflow", type: "remove_from_workflow", config: { scope: "another" }, out: { next: "n2" } }, n2: push() } }, ["E_SCHEMA"], [], { schema: true });
add("Add to workflow", { schema: 2, seq: 2, entry: "n1", triggers: [T("t1", "newLead")], nodes: { n1: { kind: "workflow", type: "add_to_workflow", config: { workflowId: "w-2", passTriggerData: true }, out: { next: "n2" } }, n2: push() } }, [], [], { schema: true });
add("a trigger id used by a step", mut(BASE, (d) => { d.triggers[0].id = "n1"; }), ["E_DUP_ID"], [], { schema: true });
add("a branch id used by a step", { schema: 2, seq: 3, entry: "n1", triggers: [T("t1", "newLead")], nodes: { n1: ifel("n2", W(R("has_email", "true")), "n2"), n2: push() } }, ["E_DUP_ID"], [], { schema: true });
add("a bad step id", { schema: 2, seq: 2, entry: "n1", triggers: [T("t1", "newLead")], nodes: { n1: period("bad-id"), "bad-id": push() } }, ["E_BAD_ID"], [], { schema: false });
add("an extra out key", mut(BASE, (d) => { d.nodes.n2.out = { next: null, other: null }; }), ["E_PORTS"], [], { schema: false });
add("If / else without None", { schema: 2, seq: 3, entry: "n1", triggers: [T("t1", "newLead")], nodes: { n1: { ...ifel("b1", W(R("has_email", "true")), "n2"), out: { b1: "n2" } }, n2: push() } }, ["E_PORTS"], [], { schema: false });
add("a reply wait with a timeout but no timeout path", { schema: 2, seq: 3, entry: "n1", triggers: [T("t1", "newLead")], nodes: { n1: email("n2"), n2: { kind: "wait", type: "reply", config: { channels: ["email"], timeout: { n: 1, unit: "days" } }, out: { next: "n3" } }, n3: push() } }, ["E_PORTS"], [], { schema: true });
add("an edge to a missing step", mut(BASE, (d) => { d.nodes.n2.out.next = "zz"; }), ["E_SCHEMA"], [], { schema: true });
add("a step with two parents", mut(BASE, (d) => { d.nodes.n3 = period("n2"); }), ["E_EDGE_TWO_PARENTS"], ["W_DELINKED"], { builder: "advanced", schema: true });
add("an edge cycle", { schema: 2, seq: 2, entry: "n1", triggers: [T("t1", "newLead")], nodes: { n1: push("n2"), n2: pushPlain("n1") } }, ["E_CYCLE", "E_ENTRY_NOT_HEAD"], [], { builder: "advanced", schema: true });
add("entry is a missing step", mut(BASE, (d) => { d.entry = "zz"; }), ["E_ENTRY_NOT_HEAD"], ["W_DELINKED"], { builder: "advanced", schema: true });
add("no entry but steps", mut(BASE, (d) => { d.entry = null; }), ["E_ENTRY_NOT_HEAD"], ["W_DELINKED"], { builder: "advanced", schema: true });
add("more steps than the business allows", mut(BASE, (d) => { d.nodes.n2.out.next = "n3"; d.nodes.n3 = pushPlain(); }), ["E_MAX_NODES"], [], { maxSteps: 2, schema: true });
add("an unknown action", mut(BASE, (d) => { d.nodes.n2.type = "send_fax"; }), ["E_UNKNOWN_TYPE"], [], { schema: false });
add("an unknown trigger", mut(BASE, (d) => { d.triggers[0].type = "birthday"; }), ["E_UNKNOWN_TYPE"], [], { schema: false });
add("a v1 alias is not a stored key", mut(BASE, (d) => { d.nodes.n2.type = "push"; }), ["E_UNKNOWN_TYPE"], [], { schema: false });
add("a paused If / else", { schema: 2, seq: 3, entry: "n1", triggers: [T("t1", "newLead")], nodes: { n1: { ...ifel("b1", W(R("has_email", "true")), "n2"), disabled: true }, n2: push() } }, ["E_DISABLED_BRANCHING"], [], { schema: true });
add("a paused action", mut(BASE, (d) => { d.nodes.n2.disabled = true; }), [], [], { schema: true });
const LOCKED = { schema: 2, seq: 3, entry: "n1", triggers: [T("t1", "newLead")], nodes: { n1: { ...ifel("b1", W(R("dont_ask", "true", { lock: true }), R("has_email", "true")), "n2"), locked: false }, n2: { ...email(), locked: true } } };
add("a locked step removed", mut(LOCKED, (d) => { delete d.nodes.n2; d.nodes.n1.out.b1 = null; d.nodes.n1.out.b1 = "n3"; d.nodes.n3 = pushPlain(); }), ["E_LOCKED"], [], { stored: LOCKED, schema: true });
add("a locked step edited", mut(LOCKED, (d) => { d.nodes.n2.config.subject = "Changed"; }), ["E_LOCKED"], [], { stored: LOCKED, schema: true });
add("a locked step renamed is fine", mut(LOCKED, (d) => { d.nodes.n2.name = "Renamed"; }), [], [], { stored: LOCKED, schema: true });
add("a locked condition removed", mut(LOCKED, (d) => { d.nodes.n1.config.branches[0].when = W(R("has_email", "true")); }), ["E_LOCKED"], [], { stored: LOCKED, schema: true });
add("a text before the phone line", mut(BASE, (d) => { d.nodes.n2 = { kind: "action", type: "send_sms", config: { body: "Hi {first_name}" }, out: { next: null } }; }), ["E_UNAVAILABLE"], [], { schema: false });
const SMS = mut(BASE, (d) => { d.nodes.n2 = { kind: "action", type: "send_sms", config: { body: "Hi {first_name}" }, out: { next: null } }; });
add("a text already in the saved workflow (existingOnly)", SMS, [], ["E_UNAVAILABLE"], { stored: SMS, schema: true });
add("a text with the phone line", SMS, [], [], { avail: { ...G23, phone: true }, schema: true });
add("a notification by team email (greyed)", mut(BASE, (d) => { d.nodes.n2.config.channel = "email"; }), ["E_UNAVAILABLE"], [], { schema: false });
add("a reply wait on SMS (greyed)", { schema: 2, seq: 3, entry: "n1", triggers: [T("t1", "newLead")], nodes: { n1: email("n2"), n2: { kind: "wait", type: "reply", config: { channels: ["sms"] }, out: { next: "n3" } }, n3: push() } }, ["E_UNAVAILABLE"], [], { schema: false });
add("a user-reply wait for the assigned user (greyed)", { schema: 2, seq: 2, entry: "n1", triggers: [T("t1", "newLead")], nodes: { n1: { kind: "wait", type: "user_reply", config: { channels: ["chat"], users: "assigned", timeout: { n: 1, unit: "hours" } }, out: { next: "n2", timeout: null } }, n2: push() } }, ["E_UNAVAILABLE"], [], { schema: false });
add("turn automatic messages back on (greyed)", mut(BASE, (d) => { d.nodes.n2.out.next = "n3"; d.nodes.n3 = { kind: "action", type: "dnd", config: { mode: "disable", channel: "all" }, out: { next: null } }; }), ["E_UNAVAILABLE"], [], { schema: false });
add("a wait in seconds (greyed)", mut(BASE, (d) => { d.nodes.n1.config = { n: 30, unit: "seconds" }; }), ["E_UNAVAILABLE"], [], { schema: false });
add("a lead tag trigger before G2.3", mut(BASE, (d) => { d.triggers[0] = T("t1", "contact_tag"); }), ["E_UNAVAILABLE"], [], { avail: NOW, schema: false });
add("a built-in trigger", { schema: 2, seq: 1, entry: "n1", triggers: [T("t1", "doc_expiring")], nodes: { n1: pushPlain() } }, ["E_UNAVAILABLE"], ["W_HIDDEN_TYPE"], { schema: false });
add("Invoice needs Xero", { schema: 2, seq: 1, entry: "n1", triggers: [T("t1", "invoice")], nodes: { n1: pushPlain() } }, ["E_UNAVAILABLE"], [], { schema: false });
add("a field only one trigger knows", { schema: 2, seq: 3, entry: "n1", triggers: [T("t1", "newLead"), T("t2", "jobClosed")], nodes: { n1: ifel("b1", W(R("unpaid", "true")), "n2"), n2: pushPlain() } }, ["E_FIELD_NOT_FOR_ALL_TRIGGERS"], [], { schema: true });
add("branch per trigger with trigger.id", { schema: 2, seq: 3, entry: "n1", triggers: [T("t1", "newLead"), T("t2", "jobClosed")], nodes: { n1: ifel("b1", W(R("trigger.id", "is", { v: "t2" })), "n2"), n2: pushPlain() } }, [], [], { schema: true });
add("a filter field the trigger doesn't have", mut(BASE, (d) => { d.triggers[0].filters = F(R("job.amount", "gt", { n: 500 })); }), ["E_FIELD_NOT_FOR_ALL_TRIGGERS"], [], { schema: false });
add("trigger filters with a value", mut(BASE, (d) => { d.triggers[0].filters = F(R("service", "in", { v: ["Aircon", "Gutters"] }), R("lead.created", "within_last", { n: 2, unit: "days" })); }), [], [], { schema: true });
add("an unknown blank", mut(BASE, (d) => { d.nodes.n2.config.title = "Hi {nonsense}"; }), ["E_MERGE_FIELD"], [], { schema: true });
add("a blank one trigger can't fill", mut(BASE, (d) => { d.triggers.push(T("t2", "jobClosed")); d.nodes.n2.config.title = "Job of {technician}"; }), [], ["W_MERGE_FIELD"], { schema: true });
add("custom and trigger blanks", mut(BASE, (d) => { d.triggers = [T("t1", "inbound_webhook")]; d.nodes.n2.config.title = "{custom.office_line} {trigger.order_no}"; }), [], [], { schema: true });
add("money to people who are not owners", { schema: 2, seq: 1, entry: "n1", triggers: [T("t1", "jobClosed")], nodes: { n1: { kind: "action", type: "internal_notification", config: { channel: "push", to: { roles: ["va"] }, title: "Job done: {amount}" }, out: { next: null } } } }, [], ["W_MONEY_TO_NON_OWNER"], { schema: true });
add("money to owners only", { schema: 2, seq: 1, entry: "n1", triggers: [T("t1", "jobClosed")], nodes: { n1: { kind: "action", type: "internal_notification", config: { channel: "push", to: { roles: ["owner"] }, title: "Job done: {amount}" }, out: { next: null } } } }, [], [], { schema: true });
add("a customer message with no lead", { schema: 2, seq: 1, entry: "n1", triggers: [T("t1", "scheduler", { config: { freq: "daily", at: "09:00" } })], nodes: { n1: email(null, { body: "Hello" }) } }, ["E_CUSTOMER_NO_CONTACT"], [], { schema: true });
add("a customer message when one trigger has no lead", { schema: 2, seq: 1, entry: "n1", triggers: [T("t1", "newLead"), T("t2", "scheduler", { config: { freq: "weekly", days: [1], at: "09:00" } })], nodes: { n1: email(null, { body: "Hello" }) } }, [], ["W_CUSTOMER_IN_CONTACTLESS"], { schema: true });
add("a scheduler without its time", { schema: 2, seq: 1, entry: "n1", triggers: [T("t1", "scheduler", { config: { freq: "daily" } })], nodes: { n1: pushPlain() } }, ["E_SCHEMA"], [], { schema: false });
add("a message template that no longer exists", mut(BASE, (d) => { d.nodes.n2 = email(null, { templateKey: "gone", body: undefined }); delete d.nodes.n2.config.body; }), ["E_TEMPLATE_MISSING"], [], { catalog: { templates: { welcome: "Hi" } }, schema: true });
add("a message template that exists", mut(BASE, (d) => { d.nodes.n2 = email(null, { templateKey: "welcome" }); delete d.nodes.n2.config.body; }), [], [], { catalog: { templates: { welcome: "Hi" } }, schema: true });
add("an email with no words", mut(BASE, (d) => { d.nodes.n2 = email(); delete d.nodes.n2.config.body; }), ["E_SCHEMA"], [], { schema: false });
const HOOK = (url, headers) => mut(BASE, (d) => { d.nodes.n2 = { kind: "action", type: "webhook", config: { url, method: "POST", fields: ["name", "service"], ...(headers ? { headers } : {}) }, out: { next: null } }; });
add("a webhook", HOOK("https://hooks.example.com/in"), [], ["W_SENDS_OUTSIDE"], { schema: true });
add("a webhook over http", HOOK("http://hooks.example.com/in"), ["E_WEBHOOK_URL"], ["W_SENDS_OUTSIDE"], { scope: "server", schema: true });
add("a webhook to a private address", HOOK("https://192.168.1.10/in"), ["E_WEBHOOK_URL"], ["W_SENDS_OUTSIDE"], { scope: "server", schema: true });
add("a webhook to localhost", HOOK("https://localhost/in"), ["E_WEBHOOK_URL"], ["W_SENDS_OUTSIDE"], { scope: "server", schema: true });
add("a webhook with a secret header", HOOK("https://hooks.example.com/in", [{ name: "Authorization", value: "Bearer x" }]), ["E_SECRET_HEADER"], ["W_SENDS_OUTSIDE"], { scope: "server", schema: true });
add("a reply wait with nothing sent before", { schema: 2, seq: 2, entry: "n1", triggers: [T("t1", "newLead")], nodes: { n1: { kind: "wait", type: "reply", config: { channels: ["chat"] }, out: { next: "n2" } }, n2: push() } }, [], ["W_REPLY_NO_SEND"], { schema: true });
add("the last step is a wait", mut(BASE, (d) => { d.nodes.n2.out.next = "n3"; d.nodes.n3 = period(null, 1, "days"); }), [], ["W_LAST_NOT_ACTION"], { schema: true });
add("a goal last", mut(BASE, (d) => { d.nodes.n2.out.next = "n3"; d.nodes.n3 = { kind: "goal", type: "stage_reached", config: { stages: ["Booked"], ifNotMet: "end" }, out: { next: null } }; }), [], ["W_LAST_NOT_ACTION"], { schema: true });
add("a goal in the middle", mut(BASE, (d) => { d.nodes.n1 = { kind: "goal", type: "payment", config: { ifNotMet: "wait" }, out: { next: "n2" } }; d.triggers = [T("t1", "jobClosed")]; }), [], [], { schema: true });
add("a tracking goal (greyed)", mut(BASE, (d) => { d.nodes.n1 = { kind: "goal", type: "email_event", config: { ifNotMet: "end" }, out: { next: "n2" } }; }), ["E_UNAVAILABLE"], [], { schema: false });
add("the stop-if-moved gate in an any group", { schema: 2, seq: 2, entry: "n1", triggers: [T("t1", "stage")], nodes: { n1: ifel("b1", { match: "any", segments: [{ match: "any", rules: [R("stage_unchanged", "true"), R("has_email", "true")] }] }, "n2"), n2: pushPlain() } }, [], ["W_GATE_MOVED"], { schema: true });
add("a rule without its value", mut(BASE, (d) => { d.triggers[0].filters = F(R("service", "is")); }), ["rule_value_missing"], [], { schema: false });
add("a list rule with one string", mut(BASE, (d) => { d.triggers[0].filters = F(R("service", "in", { v: "Aircon" })); }), ["rule_value_type"], [], { schema: false });
add("a date rule with words", mut(BASE, (d) => { d.triggers[0].filters = F(R("lead.created", "before", { v: "tomorrow" })); }), ["rule_value_type"], [], { schema: false });
add("a between rule without its end", mut(BASE, (d) => { d.triggers = [T("t1", "jobClosed", { filters: F(R("job.amount", "between", { n: 100 })) })]; d.nodes.n2.config.title = "Job"; }), ["rule_value_missing"], [], { schema: false });
add("an op the field doesn't take", mut(BASE, (d) => { d.triggers[0].filters = F(R("has_email", "is", { v: "yes" })); }), ["E_SCHEMA"], [], { schema: false });
add("an unknown field", mut(BASE, (d) => { d.triggers[0].filters = F(R("shoe_size", "is", { v: "9" })); }), ["E_UNKNOWN_TYPE"], [], { schema: false });
add("asked for a review without the months", { schema: 2, seq: 2, entry: "n1", triggers: [T("t1", "jobClosed")], nodes: { n1: ifel("b1", W(R("asked_within_months", "true")), "n2"), n2: pushPlain() } }, ["rule_value_missing"], [], { schema: true });
add("asked for a review in 6 months", { schema: 2, seq: 2, entry: "n1", triggers: [T("t1", "jobClosed")], nodes: { n1: ifel("b1", W(R("asked_within_months", "true", { n: 6 })), "n2"), n2: pushPlain() } }, [], [], { schema: true });
add("a dynamic value on money", { schema: 2, seq: 2, entry: "n1", triggers: [T("t1", "jobClosed")], nodes: { n1: ifel("b1", W(R("job.amount", "gt", { ref: "lead.quote_amount" })), "n2"), n2: pushPlain() } }, [], [], { schema: true });
add("a dynamic value on text", { schema: 2, seq: 2, entry: "n1", triggers: [T("t1", "newLead")], nodes: { n1: ifel("b1", W(R("lead.name", "is", { ref: "lead.email" })), "n2"), n2: pushPlain() } }, ["rule_value_type"], [], { schema: true });
add("a value not in the choices", { schema: 2, seq: 2, entry: "n1", triggers: [T("t1", "call_details")], nodes: { n1: ifel("b1", W(R("call.status", "is", { v: "ringing" })), "n2"), n2: pushPlain() } }, ["rule_value_type"], [], { schema: true });
add("a system-only field", { schema: 2, seq: 2, entry: "n1", triggers: [T("t1", "stage")], nodes: { n1: ifel("b1", W(R("stage_move_stands", "true")), "n2"), n2: pushPlain() } }, [], ["W_HIDDEN_TYPE"], { schema: false });
add("an assigned-user rule (greyed)", mut(BASE, (d) => { d.triggers[0].filters = F(R("lead.assigned_user", "is_empty")); }), ["E_UNAVAILABLE"], [], { schema: false });
add("a wait over 1,440 minutes", mut(BASE, (d) => { d.nodes.n1.config.n = 2000; }), ["E_SCHEMA"], [], { schema: false });
add("a wait over 168 hours", mut(BASE, (d) => { d.nodes.n1.config = { n: 200, unit: "hours" }; }), ["E_SCHEMA"], [], { schema: true });
add("a period wait with a resume window", mut(BASE, (d) => { d.nodes.n1.config = { n: 1, unit: "days", resume: { days: [1, 2, 3, 4, 5], from: "09:00", until: "17:00" } }; }), [], [], { schema: true });
add("a notification to nobody", mut(BASE, (d) => { d.nodes.n2.config.to = {}; }), ["E_SCHEMA"], [], { schema: true });
add("move a lead to Won", mut(BASE, (d) => { d.nodes.n2.out.next = "n3"; d.nodes.n3 = { kind: "action", type: "move_stage", config: { stage: "Won" }, out: { next: null } }; }), ["E_SCHEMA"], [], { schema: true });
add("a date wait that goes to a step when passed", mut(BASE, (d) => { d.nodes.n1 = { kind: "wait", type: "date", config: { at: "2026-12-01T09:00", when: "on", ifPassed: "goto", gotoStep: "n2" }, out: { next: "n2" } }; }), [], [], { schema: true });
add("a date wait that goes nowhere when passed", mut(BASE, (d) => { d.nodes.n1 = { kind: "wait", type: "date", config: { at: "2026-12-01T09:00", when: "on", ifPassed: "goto" }, out: { next: "n2" } }; }), ["E_GOTO_TARGET"], [], { schema: true });
add("a date wait with a date and a field", mut(BASE, (d) => { d.nodes.n1 = { kind: "wait", type: "date", config: { at: "2026-12-01T09:00", ref: "lead.booked_for", when: "on", ifPassed: "continue" }, out: { next: "n2" } }; }), ["E_SCHEMA"], [], { schema: true });
add("a recurring window with no day", mut(BASE, (d) => { d.nodes.n1 = { kind: "wait", type: "recurring", config: { mode: "window", window: { use: "custom", days: [], from: "09:00", until: "17:00", outside: "next" } }, out: { next: "n2" } }; }), ["E_SCHEMA"], [], { schema: false });
add("a weekly recurring wait", mut(BASE, (d) => { d.nodes.n1 = { kind: "wait", type: "recurring", config: { mode: "times", freq: "weekly", days: [2], at: "10:00" }, out: { next: "n2" } }; }), [], [], { schema: true });
add("a conditions wait with a timeout", mut(BASE, (d) => { d.nodes.n1 = { kind: "wait", type: "conditions", config: { when: W(R("tag", "has", { v: "VIP" })), timeout: { n: 7, unit: "days" } }, out: { next: "n2", timeout: null } }; }), [], [], { schema: true });
add("a scheduled wait on the invoice due date (greyed)", mut(BASE, (d) => { d.nodes.n1 = { kind: "wait", type: "scheduled", config: { anchor: "invoice.due", when: "before", offset: { n: 1, unit: "days" }, ifPassed: "continue" }, out: { next: "n2" } }; }), ["E_UNAVAILABLE"], [], { schema: false });
add("a scheduled wait that goes to a step when passed", mut(BASE, (d) => { d.triggers = [T("t1", "jobClosed")]; d.nodes.n1 = { kind: "wait", type: "scheduled", config: { anchor: "job.date", when: "before", offset: { n: 1, unit: "days" }, ifPassed: "goto", gotoStep: "n2" }, out: { next: "n2" } }; }), [], [], { schema: true });
add("a scheduled wait that goes nowhere when passed", mut(BASE, (d) => { d.nodes.n1 = { kind: "wait", type: "scheduled", config: { anchor: "lead.booked_for", when: "at", ifPassed: "goto", gotoStep: "zz" }, out: { next: "n2" } }; }), ["E_GOTO_TARGET"], [], { schema: true });
add("a scheduled wait on a date its trigger doesn't give", mut(BASE, (d) => { d.nodes.n1 = { kind: "wait", type: "scheduled", config: { anchor: "job.date", when: "before", offset: { n: 1, unit: "days" }, ifPassed: "continue" }, out: { next: "n2" } }; }), ["E_FIELD_NOT_FOR_ALL_TRIGGERS"], [], { schema: true });
add("a date wait on a date one of its triggers doesn't give", mut(BASE, (d) => { d.triggers = [T("t1", "newLead"), T("t2", "jobClosed")]; d.nodes.n1 = { kind: "wait", type: "date", config: { ref: "job.date", when: "on", ifPassed: "continue" }, out: { next: "n2" } }; }), ["E_FIELD_NOT_FOR_ALL_TRIGGERS"], [], { schema: true });
add("ids that look like JavaScript names are only ids", { schema: 2, seq: 2, entry: "constructor", triggers: [T("toString", "newLead")], nodes: { constructor: period("hasOwnProperty"), hasOwnProperty: push() } }, [], [], { schema: true });
add("an edge to a JavaScript name that is not a step", mut(BASE, (d) => { d.nodes.n2.out.next = "constructor"; }), ["E_SCHEMA"], [], { schema: true });
add("a trigger name over 120 characters", mut(BASE, (d) => { d.triggers[0].name = "x".repeat(121); }), ["E_SCHEMA"], [], { schema: false });
add("eleven triggers", mut(BASE, (d) => { d.triggers = Array.from({ length: 11 }, (_, i) => T(`t${i + 1}`, "newLead")); d.seq = 11; }), ["E_SCHEMA"], [], { schema: false });
add("schema 1", mut(BASE, (d) => { d.schema = 1; }), ["E_SCHEMA"], [], { schema: false });
add("a stale-leads trigger without days", { schema: 2, seq: 1, entry: "n1", triggers: [T("t1", "stale")], nodes: { n1: push() } }, ["E_SCHEMA"], [], { schema: false });
add("a stale-leads trigger", { schema: 2, seq: 1, entry: "n1", triggers: [T("t1", "stale", { config: { days: 14 } })], nodes: { n1: push() } }, [], [], { schema: true });
write("workflows.json", { about: "Validator parity cases (design §6.2). errors/warnings = exact sorted unique codes of validateDoc; schema = whether jsonSchema (mode generate unless schemaMode) accepts {definition: doc, settings}. scope both = app and engine must agree.", cases });

// ── shape.json: shape key / arm key pairs (design §2.8) ──
const shapes = [];
const sh = (name, a, b, sameShape, sameArm, sa = {}, sb = sa) => shapes.push({ name, a: { doc: a, settings: sa }, b: { doc: b, settings: sb }, sameShape, sameArm });
const reorder = (x) => Array.isArray(x) ? x.map(reorder) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).reverse().map((k) => [k, reorder(x[k])])) : x;
sh("identical", CANON, clone(CANON), true, true);
sh("keys in another order at every level", CANON, reorder(CANON), true, true);
sh("names and notes", CANON, mut(CANON, (d) => { d.nodes.n4.name = "Other"; d.nodes.n4.note = "A note"; }), true, true);
sh("pause a step (disabled)", CANON, mut(CANON, (d) => { d.nodes.n4.disabled = true; }), true, true);
sh("lock a step", CANON, mut(CANON, (d) => { d.nodes.n4.locked = true; }), true, true);
sh("message words", CANON, mut(CANON, (d) => { d.nodes.n4.config.body = "New words"; }), true, true);
sh("wait length", CANON, mut(CANON, (d) => { d.nodes.n1.config.n = 3; }), true, true);
sh("branch condition", CANON, mut(CANON, (d) => { d.nodes.n2.config.branches[0].when = W(R("has_email", "false")); }), true, true);
const LOOP = { schema: 2, seq: 4, entry: "n1", triggers: [T("t1", "newLead")], nodes: { n1: period("n2", 1, "days"), n2: push("n3"), n3: goto("n1") } };
sh("Go to retarget", LOOP, mut(LOOP, (d) => { d.nodes.n3.config.target = "n2"; }), false, true);
const TWO = { schema: 2, seq: 6, entry: "n1", triggers: [T("t1", "newLead")], nodes: { n1: { kind: "if_else", type: "if_else", config: { branches: [{ id: "b1", when: W(R("has_email", "true")) }, { id: "b2", when: W(R("has_mobile", "true")) }] }, out: { b1: "n2", b2: "n3", none: null } }, n2: push(), n3: pushPlain() } };
sh("branch order", TWO, mut(TWO, (d) => { d.nodes.n1.config.branches.reverse(); d.nodes.n1.out = { b2: "n3", b1: "n2", none: null }; }), false, true);
sh("trigger filter", CANON, mut(CANON, (d) => { d.triggers[0].filters.segments[0].rules[0].v = "booked"; }), true, false);
sh("trigger switched off", CANON, mut(CANON, (d) => { d.triggers[1].disabled = true; }), true, false);
sh("trigger added", CANON, mut(CANON, (d) => { d.triggers.push(T("t9", "newLead")); }), true, false);
sh("trigger name", CANON, mut(CANON, (d) => { d.triggers[0].name = "Other"; }), true, true);
sh("a step added at the end", CANON, mut(CANON, (d) => { d.nodes.n8.out.next = "n9"; d.nodes.n9 = pushPlain(); }), false, true);
sh("a step's type", CANON, mut(CANON, (d) => { d.nodes.n4.type = "send_live_chat"; d.nodes.n4.config = { body: "Hi" }; }), false, true);
sh("a reply wait loses its timeout", CANON, mut(CANON, (d) => { delete d.nodes.n5.config.timeout; d.nodes.n5.out = { next: "n6" }; d.nodes.n6.out.next = "n7"; }), false, true);
sh("split percents", SPLIT, mut(SPLIT, (d) => { d.nodes.n1.config.paths[0].percent = 70; d.nodes.n1.config.paths[1].percent = 30; }), true, true);
sh("entry moves", BASE, mut(BASE, (d) => { d.entry = "n2"; d.nodes.n2.out.next = "n1"; d.nodes.n1.out.next = null; }), false, false);
const DATEW = mut(BASE, (d) => { d.nodes.n1 = { kind: "wait", type: "date", config: { at: "2026-12-01T09:00", when: "on", ifPassed: "goto", gotoStep: "n2" }, out: { next: "n2" } }; d.nodes.n2.out.next = "n3"; d.nodes.n3 = pushPlain(); });
sh("a date wait's go-to step", DATEW, mut(DATEW, (d) => { d.nodes.n1.config.gotoStep = "n3"; }), false, true);
const SCHEDW = mut(DATEW, (d) => { d.nodes.n1 = { kind: "wait", type: "scheduled", config: { anchor: "lead.booked_for", when: "at", ifPassed: "goto", gotoStep: "n2" }, out: { next: "n2" } }; });
sh("a scheduled wait's go-to step", SCHEDW, mut(SCHEDW, (d) => { d.nodes.n1.config.gotoStep = "n3"; }), false, true);
sh("a scheduled wait's offset", SCHEDW, mut(SCHEDW, (d) => { d.nodes.n1.config.offset = { n: 2, unit: "hours" }; }), true, true);
sh("re-entry setting", CANON, CANON, true, false, { reentry: "off" }, { reentry: "after_exit" });
sh("time window hours while it is off", CANON, CANON, true, true, { window: { on: false, from: "08:00", until: "17:00" } }, { window: { on: false, from: "07:00", until: "18:00" } });
sh("time window switched on", CANON, CANON, true, false, { window: { on: false } }, { window: { on: true, days: [1, 2, 3, 4, 5], from: "08:00", until: "17:00" } });
sh("mark as read and stop on response", CANON, CANON, true, true, {}, { markRead: true, stopOnResponse: true, sender: { fromName: "Kim" } });
sh("settings left out = defaults", CANON, CANON, true, true, {}, { reentry: "off", timezone: "business", window: { on: false } });
write("shape.json", { about: "defShape / armKey pairs (design §2.8). The SQL automation_def_shape / automation_arm_key check-after uses the same pairs.", cases: shapes });

// ── upgrade.json: every phase-4 shape → the doc (design §2.2 upgrade-3, §3.16) ──
const ups = [];
const up = (name, trigger, steps, doc, idMap = {}) => ups.push({ name, v1: { trigger, steps }, expect: { doc, settings: MIGRATED, idMap } });
const tg = (type, name, rules = [], config) => ({ id: "t1", type, name, filters: { match: "all", segments: [{ match: "all", rules }] }, ...(config ? { config } : {}) });
const PUSH1 = { id: "p1", kind: "action", type: "push", to: { roles: ["owner"] }, title: "New lead: {name}", body: "{service} from {source}" };
up("upgrade-3 (design example)", { type: "newLead", params: {} }, [{ id: "s1", kind: "wait", n: 10, unit: "minutes" }, { id: "s2", kind: "if", match: "all", conds: [{ field: "has_email", op: "true" }] }, { id: "s3", kind: "window", mode: "office", outside: "next" }, { id: "s4", kind: "action", type: "email", subject: "Thanks {first_name}", templateKey: "my_ab12cd34" }], UP3);
up("new lead → push", { type: "newLead", params: {} }, [PUSH1], { schema: 2, seq: 1, entry: "p1", triggers: [tg("newLead", "Contact created")], nodes: { p1: { kind: "action", type: "internal_notification", config: { channel: "push", to: { roles: ["owner"] }, title: "New lead: {name}", body: "{service} from {source}" }, out: { next: null } } } });
up("stage with a stage", { type: "stage", params: { stage: "Quoted" } }, [{ id: "s1", kind: "action", type: "email", subject: "Your quote", body: "{hi}" }],
  { schema: 2, seq: 1, entry: "s1", triggers: [tg("stage", "Pipeline stage changed", [{ field: "trigger.stage", op: "is", v: "Quoted" }])], nodes: { s1: { kind: "action", type: "send_email", config: { subject: "Your quote", body: "{hi}" }, out: { next: null } } } });
up("stage with any stage", { type: "stage", params: { stage: "" } }, [{ id: "s1", kind: "if", match: "all", conds: [{ field: "stage_unchanged", op: "true" }] }, { id: "s2", kind: "action", type: "task", title: "Call {name}" }],
  { schema: 2, seq: 2, entry: "s1", triggers: [tg("stage", "Pipeline stage changed")], nodes: {
    s1: { kind: "if_else", type: "if_else", config: { gate: true, noneName: "None", branches: [{ id: "s1_yes", name: "Yes", when: W({ field: "stage_unchanged", op: "true" }) }] }, out: { s1_yes: "s2", none: null } },
    s2: { kind: "action", type: "add_task", config: { title: "Call {name}" }, out: { next: null } } } });
up("job closed with a job age", { type: "jobClosed", params: { maxJobAgeDays: 14 } }, [{ id: "s1", kind: "wait", n: 2, unit: "days" }, { id: "s2", kind: "action", type: "task", title: "Ask for a review", notes: "{name}", due_days: 1, assignees: ["e-1"], priority: "High" }],
  { schema: 2, seq: 2, entry: "s1", triggers: [tg("jobClosed", "Job closed", [], { maxJobAgeDays: 14 })], nodes: {
    s1: { kind: "wait", type: "period", config: { n: 2, unit: "days" }, out: { next: "s2" } },
    s2: { kind: "action", type: "add_task", config: { title: "Ask for a review", notes: "{name}", due_days: 1, assignees: ["e-1"], priority: "High" }, out: { next: null } } } });
up("job closed, default age", { type: "jobClosed", params: {} }, [{ id: "s1", kind: "wait", n: 3, unit: "hours" }, { id: "s2", kind: "action", type: "push", to: { people: ["u-1"] }, title: "Done" }],
  { schema: 2, seq: 2, entry: "s1", triggers: [tg("jobClosed", "Job closed")], nodes: {
    s1: { kind: "wait", type: "period", config: { n: 3, unit: "hours" }, out: { next: "s2" } },
    s2: { kind: "action", type: "internal_notification", config: { channel: "push", to: { people: ["u-1"] }, title: "Done" }, out: { next: null } } } });
up("missed call → text", { type: "missedCall", params: {} }, [{ id: "m1", kind: "action", type: "text", body: "Sorry we missed you" }],
  { schema: 2, seq: 1, entry: "m1", triggers: [tg("call_details", "Call details", [{ field: "call.status", op: "is", v: "missed" }])], nodes: { m1: { kind: "action", type: "send_sms", config: { body: "Sorry we missed you" }, out: { next: null } } } });
up("chat with a locked condition (ready-made)", { type: "chat", params: {} }, [{ id: "c1", kind: "wait", n: 5, unit: "minutes" }, { id: "c2", kind: "if", match: "all", conds: [{ field: "has_mobile", op: "true", lock: true }, { field: "chat_age_hours", op: "lte", n: 4 }] }, { id: "c3", kind: "action", type: "text", templateKey: "chatText", lock: true }],
  { schema: 2, seq: 3, entry: "c1", triggers: [tg("chat", "Conversations SLA")], nodes: {
    c1: { kind: "wait", type: "period", config: { n: 5, unit: "minutes" }, out: { next: "c2" } },
    c2: { kind: "if_else", type: "if_else", config: { gate: true, noneName: "None", branches: [{ id: "c2_yes", name: "Yes", when: W({ field: "has_mobile", op: "true", lock: true }, { field: "chat_age_hours", op: "lte", n: 4 }) }] }, out: { c2_yes: "c3", none: null } },
    c3: { kind: "action", type: "send_sms", config: { templateKey: "chatText" }, out: { next: null }, locked: true } } });
const WIN = (w, extra = {}) => ({ id: "w1", kind: "window", ...w, ...extra });
const winCase = (name, w, cfg) => up(name, { type: "newLead", params: {} }, [WIN(w), { ...PUSH1, id: "p2" }],
  { schema: 2, seq: 2, entry: "w1", triggers: [tg("newLead", "Contact created")], nodes: {
    w1: { kind: "wait", type: "recurring", config: { mode: "window", window: cfg }, out: { next: "p2" } },
    p2: { kind: "action", type: "internal_notification", config: { channel: "push", to: { roles: ["owner"] }, title: "New lead: {name}", body: "{service} from {source}" }, out: { next: null } } } });
winCase("window: custom days, next", { days: [1, 2, 3, 4, 5], from: "09:00", until: "17:00", outside: "next" }, { use: "custom", days: [1, 2, 3, 4, 5], from: "09:00", until: "17:00", outside: "next" });
winCase("window: custom, at a time", { days: [1, 3], from: "08:00", until: "12:00", outside: "at", at: "09:30" }, { use: "custom", days: [1, 3], from: "08:00", until: "12:00", outside: "at", at: "09:30" });
winCase("window: custom, skip → end", { days: [6, 0], from: "10:00", until: "14:00", outside: "skip" }, { use: "custom", days: [6, 0], from: "10:00", until: "14:00", outside: "end" });
winCase("window: office hours, next", { mode: "office", outside: "next" }, { use: "office", outside: "next" });
winCase("window: office hours, at", { mode: "office", outside: "at", at: "08:30" }, { use: "office", outside: "at", at: "08:30" });
winCase("window: office hours, skip → end", { mode: "office", outside: "skip" }, { use: "office", outside: "end" });
winCase("window: outside office hours, next", { mode: "outsideOffice", outside: "next" }, { use: "outsideOffice", outside: "next" });
winCase("window: outside office hours, skip → end", { mode: "outsideOffice", outside: "skip" }, { use: "outsideOffice", outside: "end" });
// 12 ifs in a row, then an email
{
  const steps = [], nodes = {};
  for (let i = 1; i <= 12; i++) {
    const c = i % 2 ? { field: "has_email", op: "true" } : { field: "service", op: "in", v: ["Aircon"] };
    steps.push({ id: `s${i}`, kind: "if", match: i % 3 ? "all" : "any", conds: [c] });
    nodes[`s${i}`] = { kind: "if_else", type: "if_else", config: { gate: true, noneName: "None", branches: [{ id: `s${i}_yes`, name: "Yes", when: { match: "any", segments: [{ match: i % 3 ? "all" : "any", rules: [c] }] } }] }, out: { [`s${i}_yes`]: `s${i + 1}`, none: null } };
  }
  steps.push({ id: "s13", kind: "action", type: "email", subject: "Hi", body: "{hi}" });
  nodes.s13 = { kind: "action", type: "send_email", config: { subject: "Hi", body: "{hi}" }, out: { next: null } };
  up("12 ifs in a row", { type: "newLead", params: {} }, steps, { schema: 2, seq: 13, entry: "s1", triggers: [tg("newLead", "Contact created")], nodes });
}
up("all four actions and all wait units", { type: "newLead", params: {} }, [
  { id: "s1", kind: "wait", n: 30, unit: "minutes" }, { id: "s2", kind: "action", type: "push", to: { roles: ["va"] }, title: "T" },
  { id: "s3", kind: "wait", n: 4, unit: "hours" }, { id: "s4", kind: "action", type: "task", title: "Call" },
  { id: "s5", kind: "wait", n: 1, unit: "days" }, { id: "s6", kind: "action", type: "email", subject: "S", body: "B" }, { id: "s7", kind: "action", type: "text", body: "T" }],
  { schema: 2, seq: 7, entry: "s1", triggers: [tg("newLead", "Contact created")], nodes: {
    s1: { kind: "wait", type: "period", config: { n: 30, unit: "minutes" }, out: { next: "s2" } },
    s2: { kind: "action", type: "internal_notification", config: { channel: "push", to: { roles: ["va"] }, title: "T" }, out: { next: "s3" } },
    s3: { kind: "wait", type: "period", config: { n: 4, unit: "hours" }, out: { next: "s4" } },
    s4: { kind: "action", type: "add_task", config: { title: "Call" }, out: { next: "s5" } },
    s5: { kind: "wait", type: "period", config: { n: 1, unit: "days" }, out: { next: "s6" } },
    s6: { kind: "action", type: "send_email", config: { subject: "S", body: "B" }, out: { next: "s7" } },
    s7: { kind: "action", type: "send_sms", config: { body: "T" }, out: { next: null } } } });
up("an any-of if with the stop-if-moved gate", { type: "stage", params: { stage: "Quoted" } }, [{ id: "s1", kind: "if", match: "any", conds: [{ field: "stage_unchanged", op: "true" }, { field: "tag", op: "has", v: "VIP" }] }, { id: "s2", kind: "action", type: "push", to: { roles: ["owner"] }, title: "VIP" }],
  { schema: 2, seq: 2, entry: "s1", triggers: [tg("stage", "Pipeline stage changed", [{ field: "trigger.stage", op: "is", v: "Quoted" }])], nodes: {
    s1: { kind: "if_else", type: "if_else", config: { gate: true, noneName: "None", branches: [{ id: "s1_yes", name: "Yes", when: { match: "any", segments: [{ match: "any", rules: [{ field: "stage_unchanged", op: "true" }, { field: "tag", op: "has", v: "VIP" }] }] } }] }, out: { s1_yes: "s2", none: null } },
    s2: { kind: "action", type: "internal_notification", config: { channel: "push", to: { roles: ["owner"] }, title: "VIP" }, out: { next: null } } } });
up("ids that are not v2 ids get fresh ones", { type: "newLead", params: {} }, [{ id: "a-1", kind: "wait", n: 1, unit: "minutes" }, { id: "2x", kind: "action", type: "push", to: { roles: ["owner"] }, title: "X" }],
  { schema: 2, seq: 4, entry: "s3", triggers: [tg("newLead", "Contact created")], nodes: {
    s3: { kind: "wait", type: "period", config: { n: 1, unit: "minutes" }, out: { next: "s4" } },
    s4: { kind: "action", type: "internal_notification", config: { channel: "push", to: { roles: ["owner"] }, title: "X" }, out: { next: null } } } }, { "a-1": "s3", "2x": "s4" });
up("the same id twice", { type: "newLead", params: {} }, [{ id: "s1", kind: "wait", n: 1, unit: "minutes" }, { id: "s1", kind: "action", type: "push", to: { roles: ["owner"] }, title: "X" }],
  { schema: 2, seq: 3, entry: "s1", triggers: [tg("newLead", "Contact created")], nodes: {
    s1: { kind: "wait", type: "period", config: { n: 1, unit: "minutes" }, out: { next: "s3" } },
    s3: { kind: "action", type: "internal_notification", config: { channel: "push", to: { roles: ["owner"] }, title: "X" }, out: { next: null } } } }, { s1: "s3" });
up("a step id t1 moves the trigger id", { type: "newLead", params: {} }, [{ id: "t1", kind: "action", type: "push", to: { roles: ["owner"] }, title: "X" }],
  { schema: 2, seq: 2, entry: "t1", triggers: [{ ...tg("newLead", "Contact created"), id: "t2" }], nodes: { t1: { kind: "action", type: "internal_notification", config: { channel: "push", to: { roles: ["owner"] }, title: "X" }, out: { next: null } } } });
up("no steps", { type: "newLead", params: {} }, [], { schema: 2, seq: 0, entry: null, triggers: [tg("newLead", "Contact created")], nodes: {} });
up("an unknown step kind is kept for the validator", { type: "newLead", params: {} }, [{ id: "s1", kind: "teleport", to: "mars" }],
  { schema: 2, seq: 1, entry: "s1", triggers: [tg("newLead", "Contact created")], nodes: { s1: { kind: "teleport", type: "teleport", config: { to: "mars" }, out: { next: null } } } });
write("upgrade.json", { about: "upgradeV1 of every phase-4 shape (window modes, outside variants, 12 ifs, all four actions, the three trigger params). expect = exact output.", cases: ups });

// ── patch.json: wfApplyPatch (design §6.3) ──
const patches = [];
const pt = (name, doc, ops, expect) => { const { doc: result, ...rest } = expect; patches.push({ name, doc, ops, ...(result ? { result } : {}), ...rest }); };
const CHAIN = { schema: 2, seq: 3, entry: "n1", triggers: [T("t1", "newLead")], nodes: { n1: period("n2"), n2: push("n3"), n3: pushPlain() } };
pt("add a step at the end", CHAIN, [{ op: "addNode", node: { kind: "action", type: "add_task", config: { title: "Call" } }, slot: { src: "n3" } }],
  { doc: mut(CHAIN, (d) => { d.seq = 4; d.nodes.n3.out.next = "n4"; d.nodes.n4 = { kind: "action", type: "add_task", config: { title: "Call" }, out: { next: null } }; }), idMap: {} });
pt("add a step in the middle", CHAIN, [{ op: "addNode", node: { id: "$1", kind: "wait", type: "period", config: { n: 1, unit: "hours" } }, slot: { src: "n1" } }],
  { doc: mut(CHAIN, (d) => { d.seq = 4; d.nodes.n1.out.next = "n4"; d.nodes.n4 = { kind: "wait", type: "period", config: { n: 1, unit: "hours" }, out: { next: "n2" } }; }), idMap: { $1: "n4" } });
pt("add an If / else mid-chain: the steps below go into its first branch", CHAIN, [{ op: "addNode", node: { id: "$i", kind: "if_else", type: "if_else", config: { branches: [{ id: "$b", name: "Has email", when: W(R("has_email", "true")) }] } }, slot: { src: "n1" } }],
  { doc: mut(CHAIN, (d) => { d.seq = 5; d.nodes.n1.out.next = "n4"; d.nodes.n4 = { kind: "if_else", type: "if_else", config: { branches: [{ id: "b5", name: "Has email", when: W(R("has_email", "true")) }] }, out: { b5: "n2", none: null } }; }), idMap: { $b: "b5", $i: "n4" } });
pt("add at the top", CHAIN, [{ op: "addNode", node: { kind: "action", type: "edit_conversation", config: {} }, slot: { src: "@entry" } }],
  { doc: mut(CHAIN, (d) => { d.seq = 4; d.entry = "n4"; d.nodes.n4 = { kind: "action", type: "edit_conversation", config: {}, out: { next: "n1" } }; }), idMap: {} });
pt("a Go to only on an END slot", CHAIN, [{ op: "addNode", node: { kind: "goto", type: "goto", config: { target: "n1" } }, slot: { src: "n1" } }], { errors: ["E_GOTO_NOT_LAST"] });
pt("a Go to at the end, then a temp id refers to it", CHAIN, [{ op: "addNode", node: { id: "$g", kind: "goto", type: "goto", config: { target: "n1" } }, slot: { src: "n3" } }, { op: "setNode", id: "$g", patch: { name: "Again" } }],
  { doc: mut(CHAIN, (d) => { d.seq = 4; d.nodes.n3.out.next = "n4"; d.nodes.n4 = { kind: "goto", type: "goto", config: { target: "n1" }, out: {}, name: "Again" }; }), idMap: { $g: "n4" } });
pt("remove one step re-links", CHAIN, [{ op: "removeNode", id: "n2", mode: "one" }], { doc: mut(CHAIN, (d) => { delete d.nodes.n2; d.nodes.n1.out.next = "n3"; }), idMap: {} });
pt("remove from here", CHAIN, [{ op: "removeNode", id: "n2", mode: "fromHere" }], { doc: mut(CHAIN, (d) => { delete d.nodes.n2; delete d.nodes.n3; d.nodes.n1.out.next = null; }), idMap: {} });
pt("remove the first step", CHAIN, [{ op: "removeNode", id: "n1", mode: "one" }], { doc: mut(CHAIN, (d) => { delete d.nodes.n1; d.entry = "n2"; }), idMap: {} });
pt("remove an If / else needs the path to keep", TWO, [{ op: "removeNode", id: "n1", mode: "one" }], { errors: ["E_KEEP_PORT"] });
pt("remove an If / else keeping a path", TWO, [{ op: "removeNode", id: "n1", mode: "one", keepPort: "b2" }], { doc: mut(TWO, (d) => { delete d.nodes.n1; delete d.nodes.n2; d.entry = "n3"; }), idMap: {} });
pt("removing a Go to's target clears the Go to", LOOP, [{ op: "removeNode", id: "n1", mode: "one" }], { doc: mut(LOOP, (d) => { delete d.nodes.n1; d.entry = "n2"; d.nodes.n3.config.target = null; }), idMap: {} });
pt("a locked step can't be removed", mut(CHAIN, (d) => { d.nodes.n2.locked = true; }), [{ op: "removeNode", id: "n2", mode: "one" }], { errors: ["E_LOCKED"] });
pt("a locked step can't be removed with its parent", mut(CHAIN, (d) => { d.nodes.n3.locked = true; }), [{ op: "removeNode", id: "n2", mode: "fromHere" }], { errors: ["E_LOCKED"] });
pt("a locked condition can't be dropped", LOCKED, [{ op: "setNode", id: "n1", patch: { config: { branches: [{ id: "b1", name: "Yes", when: W(R("has_email", "true")) }] } } }], { errors: ["E_LOCKED"] });
pt("set a step: a removed branch with steps needs dropPorts", TWO, [{ op: "setNode", id: "n1", patch: { config: { branches: [{ id: "b1", when: W(R("has_email", "true")) }] } } }], { errors: ["E_PORT_HAS_STEPS"] });
pt("set a step: drop the branch and its steps", TWO, [{ op: "setNode", id: "n1", patch: { config: { branches: [{ id: "b1", when: W(R("has_email", "true")) }] } }, dropPorts: true }],
  { doc: mut(TWO, (d) => { d.nodes.n1.config.branches = [{ id: "b1", when: W(R("has_email", "true")) }]; d.nodes.n1.out = { b1: "n2", none: null }; delete d.nodes.n3; }), idMap: {} });
pt("set a step: a new branch gets an id and an empty path", TWO, [{ op: "setNode", id: "n1", patch: { config: { branches: [{ id: "b1", when: W(R("has_email", "true")) }, { id: "b2", when: W(R("has_mobile", "true")) }, { id: "$new", when: W(R("tag", "has", { v: "VIP" })) }] } } }],
  { doc: mut(TWO, (d) => { d.seq = 7; d.nodes.n1.config.branches.push({ id: "b7", when: W(R("tag", "has", { v: "VIP" })) }); d.nodes.n1.out = { b1: "n2", b2: "n3", b7: null, none: null }; }), idMap: { $new: "b7" } });
pt("pause a branching step is refused", TWO, [{ op: "setNode", id: "n1", patch: { disabled: true } }], { errors: ["E_DISABLED_BRANCHING"] });
pt("move one step", CHAIN, [{ op: "moveNode", id: "n1", slot: { src: "n3" }, mode: "one" }], { doc: mut(CHAIN, (d) => { d.entry = "n2"; d.nodes.n1.out.next = null; d.nodes.n3.out.next = "n1"; }), idMap: {} });
pt("move into its own path is refused", CHAIN, [{ op: "moveNode", id: "n1", slot: { src: "n2" }, mode: "fromHere" }], { errors: ["E_SLOT"] });
pt("connect and disconnect (Advanced)", mut(CHAIN, (d) => { d.nodes.n2.out.next = null; }), [{ op: "connect", from: "n1", port: "next", to: "n3" }],
  { doc: mut(CHAIN, (d) => { d.nodes.n2.out.next = null; d.nodes.n1.out.next = "n3"; }), idMap: {} });
pt("connect to an ancestor is refused", CHAIN, [{ op: "connect", from: "n3", port: "next", to: "n1" }], { errors: ["E_CONNECT_LOOP"] });
pt("set the entry to a step with a parent is refused", CHAIN, [{ op: "setEntry", id: "n2" }], { errors: ["E_ENTRY_NOT_HEAD"] });
pt("triggers: add, set, remove", CHAIN, [{ op: "addTrigger", trigger: { id: "$t", type: "stage", filters: F(R("trigger.stage", "is", { v: "Quoted" })) } }, { op: "setTrigger", id: "$t", patch: { name: "Quoted" } }, { op: "removeTrigger", id: "t1" }],
  { doc: mut(CHAIN, (d) => { d.seq = 4; d.triggers = [{ id: "t4", type: "stage", filters: F(R("trigger.stage", "is", { v: "Quoted" })), name: "Quoted" }]; }), idMap: { $t: "t4" } });
pt("atomic: a later error leaves the doc unchanged", CHAIN, [{ op: "removeNode", id: "n3", mode: "one" }, { op: "removeNode", id: "zz", mode: "one" }], { errors: ["E_PATCH_ID"], errorOpIndex: 1 });
pt("an unknown step type is refused", CHAIN, [{ op: "addNode", node: { kind: "action", type: "send_fax", config: {} }, slot: { src: "n3" } }], { errors: ["E_UNKNOWN_TYPE"] });
pt("settings and name", CHAIN, [{ op: "setSettings", patch: { reentry: "after_exit" } }, { op: "rename", name: "  Follow-up  " }], { doc: CHAIN, idMap: {}, settings: { reentry: "after_exit" }, newName: "Follow-up" });
write("patch.json", { about: "wfApplyPatch (design §6.3): doc + ops → result (exact) + idMap (+ settings / name), or errors = the codes with the doc unchanged.", cases: patches });

// ── ghl-labels.json: GHL's exact words from the account scan (research/ghl-account-scan-2026-10-14.md, 14 Oct) ──
write("ghl-labels.json", {
  about: "Copied by hand from .claude/plans/research/ghl-account-scan-2026-10-14.md (trigger picker, actions picker, wait cards). registry.ghl must equal these.",
  triggers: { newLead: "Contact created", contact_changed: "Contact changed", contact_tag: "Contact tag", custom_date: "Custom date reminder", note_added: "Note added",
    task_added: "Task added", task_completed: "Task completed", task_reminder: "Task reminder", contact_dnd: "Contact DND", inbound_webhook: "Inbound webhook", scheduler: "Scheduler",
    call_details: "Call details", customer_replied: "Customer replied", user_replied: "User replied", form_submitted: "Form submitted", chat: "Conversations SLA",
    job_booked: "Customer booked appointment", booking_status: "Appointment status", stage: "Pipeline stage changed", lead_status: "Opportunity status changed",
    stale: "Stale opportunities", invoice: "Invoice", payment_received: "Payment received", estimates: "Estimates", documents_contracts: "Documents & contracts", review_received: "New review received" },
  actions: { update_field: "Update contact field", add_tag: "Add contact tag", remove_tag: "Remove contact tag", assign_user: "Assign to user", remove_assigned_user: "Remove assigned user",
    dnd: "Enable/disable DND", add_note: "Add to notes", add_task: "Add task", edit_conversation: "Edit conversation", send_email: "Send email", send_sms: "Send SMS",
    internal_notification: "Send internal notification", send_review_request: "Send review request", send_live_chat: "Send live chat message", manual_call: "Manual action to call",
    manual_sms: "Manual action to SMS", internal_comment: "Add internal comments", move_stage: "Create/update opportunity", send_invoice: "Send invoice", send_estimate: "Send estimate",
    webhook: "Webhook", update_custom_value: "Update custom value", math: "Math operation", ai_agent: "AI Agent", ai_decision: "AI decision maker", ai_summarize: "AI summarize" },
  logic: { if_else: "If / else", split: "Split", goto: "Go to", add_to_workflow: "Add to workflow", remove_from_workflow: "Remove from workflow" },
  waits: { period: "For a set period of time", date: "Until a specific date/time", recurring: "Until a recurring window opens", scheduled: "Until a scheduled date/time",
    reply: "Until the contact replies", user_reply: "Until a user replies", action: "Until the contact takes a specific action", conditions: "Until specific conditions are met" },
});
console.log("workflows", cases.length, "shape", shapes.length, "upgrade", ups.length, "patch", patches.length);
