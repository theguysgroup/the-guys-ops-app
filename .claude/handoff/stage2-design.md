# STAGE 2 — Automations = a faithful copy of GHL Workflows — BUILD-READY DESIGN (merged, 15 Oct 2026)

Status: design only. Nothing here is built or applied. This file merges the three area designs (engine-data, builders-ui,
pages-logs) and resolves every critique of them. Each resolution is in the body, and every critique is listed with its outcome in
**Appendix A**. Where the area designs disagreed, this file decides; the area texts are superseded.

Binding inputs: `MASTER-TASKS.md` §3 (rules), §4 (verification), §7 (stage 2), §11 (Cobra / Workflow AI);
`automations-ghl-copy-2026-10-14.md` (§1–§9, Ofek's answers §9); `research/ghl-account-scan-2026-10-14.md`;
`research/ghl-public-research-2026-10-14.md`; the phase-4 engine `supabase/functions/automations/index.ts` (TRIGGERS ~L540,
CONDITIONS ~L668, ACTIONS ~L750, customerGuard ~L1008, claimLog ~L1118, planDefer ~L1151, advance ~L1170, enqueue ~L1282,
reconcile ~L1322, tick ~L1363); `.claude/sql/settings-round2-phase4.sql`; the app builder in `index.html` (renderAutomationsPage,
autoEditorHtml, flow*, autoReadyRows, renderNotificationsPage, notifyCards). Line numbers are approximate: always `grep -n` first.
Stage-1 helpers to reuse: `bizTz`, `bizWall`, `bizDayOf`, `moneyText`, `taxName`, `officeLabel`, holidays in the catalog.

Words: "lead" = a contacts row; "record" = whatever a trigger is about (lead, job, call, chat, task, supplier, employee, none).
"Engine" = the `automations` edge function. "App" = `index.html`. "Doc" = a workflow definition (JSON, §2.2).

---------------------------------------------------------------------------------------------------------------------------

## 1. Goals, Ofek's decisions, non-negotiables

### 1.1 Goal
Replace the phase-4 automations builder, flow view, list and Notifications page with a faithful copy of GHL Workflows: GHL's
structure, look and exact English labels, with our nouns. The result is one Automation page, two builders on one data model, an
engine v2 that runs a branching graph, and full history, logs, stats, versions and a dry-run test. It also has to be the board that
stage 7 (Workflow AI) generates and edits.

### 1.2 Ofek's decisions (quoted from MASTER §7 and plan §9)
- "REPLACE the current builder + flow view; copy GHL's exact English labels."
- "BOTH builders (Standard vertical + Advanced free canvas, per-workflow dropdown, default in Global Workflow Settings)."
  "Same step tree underneath; switching back to Standard requires removing Advanced-only items (as in GHL)."
- "unavailable items greyed WITH the reason (e.g. 'Needs the phone line (Twilio)', 'Needs Xero', 'Coming with Workflow AI')."
- "our nouns (Lead / Job / Quote / Invoice) inside GHL's structure words."
- "'Test workflow' = dry run on a real record (nothing sent, path lights up)."
- "ready-made automations = 'System' badge, moved into the engine one by one."
- "Notifications page + Message templates & Automations merge into ONE Automation page, default CARDS view with a toggle to the GHL
  table (remembered)."
- Plan §1a: "Auto save: we keep explicit Save + undo."
- Phase-4 folds: "cancel if lead moved stage" → Goal / If-else; "ran N times in 30 days" → Stats view; "money alert to non-owners
  stays a WARNING"; "email signature → Workflow Settings sender details".
- MASTER §11: "Workflow AI output is ALWAYS a Draft … user publishes (customer workflows never self-enable)." "Greyed/unavailable
  actions are never generated (or flagged with the reason)."

### 1.3 Non-negotiables (each has tests, §8)
1. **SaaS.** Everything is per business. Every new table has `business_id text not null default public.current_business_id()` and
   RLS. Every RPC filters by `public.current_business_id()`, a new SQL function that returns `'default'` today; it is the single
   switch point for the SaaS stage. Option lists are registries (engine) and catalog values, never inline constants. Ready-made
   workflows are editable templates (rows, not code).
2. **Customer safety rails of phase 4 are kept word for word:**
   - customer messages go only from Published workflows (checked at run start, before each step and right before each customer
     action, by re-reading the row);
   - customer days and hours (with public holidays), the daily cap (advisory-locked claim RPC), opt-outs per channel, the don't-ask
     mark, test tags and test records, do-not-contact tags, unfilled blanks;
   - `armed_at`: an event older than the moment of publishing never enrols;
   - a version bump (shape change) cancels waiting runs;
   - idempotency: one run per (automation, event key); one action claim per (run, step, visit);
   - `max_late_hours`; the stage-move settle and Undo; the NO_CARD wait;
   - new and duplicated customer workflows are stored Draft (database guard); adding a customer channel to a Published workflow
     switches it to Draft.
   New rails added by this stage: chain-depth guard on engine-made events, Go To visit cap, per-run step budget, outgoing-webhook
   SSRF guard and Draft rule, Stop on response, the per-workflow time window, global pause ranges.
3. **Unavailable items are shown greyed with the reason**, everywhere (pickers, wait cards, settings, menus, templates). Unavailable
   items are never generated by the AI schema (§6).
4. **No render loops.** Every async read is a memoised single-flight loader keyed only by stored state (never `Date.now()` in a key).
   Loaders redraw at most once, only if their screen is still showing. The builder has its own paint scheduler and is never painted
   by `render()`. Idle renders = 0 on every screen (MASTER §4).
5. **Free plan.** Every list read is paged with `.range()` or is an aggregate RPC returning one JSON object; the minute cron keeps its
   40-second budget; no new cron jobs; housekeeping is budgeted per tick.
6. **Everything is verifiable by tests** (pure tests, engine tests with the fake DB, SQL check blocks on staging, the builder harness,
   the live-origin browser check).
7. **Rule 7.** The agent never publishes a customer workflow and never contacts customers. Customer System workflows move into the
   engine only with Ofek's explicit OK.

---------------------------------------------------------------------------------------------------------------------------

## 2. Data model

### 2.1 Decision: one graph, stored as a flat node map with named ports
The engine-data area proposed nested sequences; the builders-ui area proposed a flat node map. **The stored form is the flat node
map with named output ports** (a forest: every node has at most one incoming edge; loops only through a `goto` node). Reasons:
- both builders, delinking and re-connecting in Advanced, and undo with structural sharing are simple on a map;
- the engine indexes nodes by id anyway (`compile()`), and logs, stats, notes and contact paths are all keyed by step id;
- "terminal last in sequence" rules become structural (a node with branches has no `next` port; a `goto` has no ports), so a whole
  class of validation errors cannot be written;
- migrated v1 workflows have no nesting-depth problem (Appendix A, E29/E61);
- an LLM writes `"out": {"next": "n3"}` reliably; the validator returns exact codes; patch ops accept temp ids (§6).

Execution data, looks and settings are separate:
- `automations.definition` — the doc (§2.2); the only thing the executor reads, with `settings`;
- `automations.settings` — per-workflow settings (§2.6);
- `automations.layout` — Advanced positions and sticky notes (§2.7); never read by the engine or by the list;
- `automations.builder` — `standard | advanced`; UI only.
Dragging a tile or adding a sticky never changes the shape, the version or waiting runs.

### 2.2 The doc (`definition`, schema 2)

```ts
type Id = string;   // ^[A-Za-z][A-Za-z0-9_]{0,39}$ ; unique across triggers, nodes, branch ids, path ids. v1 ids ("s3") stay valid.
type Doc = {
  schema: 2;
  seq: number;                       // monotonic id counter; never decreases; new ids are t{seq}, n{seq}, b{seq}, p{seq}
  entry: Id | null;                  // first node. Standard: the only head. Advanced: the "Default Path" head.
  triggers: Trigger[];               // 0..10
  nodes: Record<Id, Node>;           // ≤ catalog.automations.maxSteps (default 100, hard ceiling 200)
};
type Trigger = {
  id: Id; type: string;              // TRIGGERS key (canonical table §2.4)
  name?: string;                     // ≤120 ("WORKFLOW TRIGGER NAME"); empty = the type label
  disabled?: boolean;
  filters: Condition;                // GHL "FILTERS": one segment, match "all" by default; fields limited per trigger type
  config?: Record<string, unknown>;  // non-filter knobs only (scheduler times, custom-date offset, stale days, hook match keys)
  goto?: Id | null;                  // Advanced only: trigger Go-To. null/absent = entry
};
type Node = {
  kind: "action" | "if_else" | "wait" | "goal" | "split" | "goto" | "workflow";   // structural class (fixed in code)
  type: string;                      // registry key within the kind (§2.4)
  name?: string;                     // ≤120 ("Action name"); default = type label
  note?: string;                     // ≤2000, a short description (step NOTES threads live in automation_notes)
  disabled?: boolean;                // not allowed on nodes with more than one port
  locked?: boolean;                  // System/template guard node: cannot be removed or edited (E_LOCKED)
  config: Record<string, unknown>;   // validated by the registry schema of (kind, type)
  out: Record<string, Id | null>;    // keys must equal ports(node) exactly, in order; null = END
};
type Condition = { match: "any" | "all"; segments: { match: "all" | "any"; rules: Rule[] }[] };   // segments 1..5, rules 1..10 each
type Rule = { field: string; op: string; v?: string | string[]; n?: number; v2?: number | string;
              unit?: "minutes" | "hours" | "days" | "weeks" | "months"; ref?: string; lock?: boolean };
```

Ports (`ports(node)`, in drawing order) and the port that existing downstream steps attach to on a mid-chain insert:

| kind | ports | insert port | notes |
|---|---|---|---|
| action | `next` | next | |
| goal | `next` | next | |
| workflow (`add_to_workflow`, `remove_from_workflow` scope `another`/`all_except_current`) | `next` | next | `remove_from_workflow` scope `current`/`all` → `[]` (terminal) |
| wait | `next`, or `next` + `timeout` when `config.timeout` is set | next | labels from the registry: reply waits "Replied"/"Timed out"; conditions "Conditions met"/"Timed out" |
| if_else | `config.branches[].id` …, then `none` | first branch | first true branch wins; `none` always last |
| split | `config.paths[].id` | first path | 2–5 paths, integer % summing to 100, 0 allowed |
| goto | `[]` | — | terminal; may only be placed on an END slot (E_GOTO_NOT_LAST) |

Condition semantics (shared by If/else branches, trigger filters and "Until specific conditions are met"):
- a segment is true when its rules joined by the segment's `match` are true; the condition is true when its segments joined by the
  outer `match` are true. Default: segments `any` (GHL "+ Add Segment" = an alternative), rules `all`;
- **gate rules** (`FIELDS[f].gate`, today only `stage_unchanged`) are pulled out and AND-ed in front of the whole condition,
  wherever they sit (phase-4 `evalConds` rule). The validator warns `W_GATE_MOVED` when a gate rule sits in an `any` group;
- `ref` = GHL "Dynamic Value": compare with another field's value (numeric, date, select, money only).

Rule arguments are fixed per operator by the **OPS registry** (§2.5): the JSON Schema is a `oneOf` discriminated by `op`, so a
model cannot write a rule that `applyOp` misreads (Appendix A, E20/E51).

Example — a valid, canonical doc (this exact JSON is fixture `canonical-1` and the example in the AI prompt):

```json
{
  "schema": 2, "seq": 9, "entry": "n1",
  "triggers": [
    { "id": "t1", "type": "stage", "name": "Moved to Quoted",
      "filters": { "match": "all", "segments": [ { "match": "all", "rules": [ { "field": "stage", "op": "is", "v": "quoted" } ] } ] } },
    { "id": "t2", "type": "contact_tag", "name": "Tagged quote-sent",
      "filters": { "match": "all", "segments": [ { "match": "all", "rules": [
        { "field": "trigger.tag", "op": "is", "v": "quote-sent" }, { "field": "trigger.action", "op": "is", "v": "added" } ] } ] } }
  ],
  "nodes": {
    "n1": { "kind": "wait", "type": "period", "name": "Wait 2 days",
            "config": { "n": 2, "unit": "days", "resume": { "days": [1,2,3,4,5], "from": "09:00", "until": "17:00" } }, "out": { "next": "n2" } },
    "n2": { "kind": "if_else", "type": "if_else", "name": "Still quoted?",
            "config": { "branches": [ { "id": "b3", "name": "Still quoted",
                          "when": { "match": "any", "segments": [ { "match": "all", "rules": [
                            { "field": "stage", "op": "is", "v": "quoted" }, { "field": "has_email", "op": "true" } ] } ] } } ],
                        "noneName": "None" },
            "out": { "b3": "n4", "none": null } },
    "n4": { "kind": "action", "type": "send_email", "name": "Quote follow-up",
            "config": { "subject": "Your {service} quote", "body": "Hi {first_name}, just checking you got our quote…" }, "out": { "next": "n5" } },
    "n5": { "kind": "wait", "type": "reply", "name": "Wait for a reply",
            "config": { "channels": ["email", "chat"], "timeout": { "n": 3, "unit": "days" } }, "out": { "next": "n6", "timeout": "n7" } },
    "n6": { "kind": "action", "type": "internal_notification", "config": { "channel": "push", "to": { "roles": ["va"] }, "title": "{name} replied about the quote" }, "out": { "next": null } },
    "n7": { "kind": "goal", "type": "stage_reached", "name": "Booked?", "config": { "stages": ["booked"], "ifNotMet": "continue" }, "out": { "next": "n8" } },
    "n8": { "kind": "action", "type": "manual_call", "config": { "title": "Call {name} about the quote" }, "out": { "next": null } }
  }
}
```

Example — a migrated phase-4 automation (fixture `upgrade-3`). v1 input:
`trigger {type:"newLead", params:{}}`, `steps [{id:"s1",kind:"wait",n:10,unit:"minutes"}, {id:"s2",kind:"if",match:"all",
conds:[{field:"has_email",op:"true"}]}, {id:"s3",kind:"window",mode:"office",outside:"next"}, {id:"s4",kind:"action",type:"email",
subject:"Thanks {first_name}",templateKey:"my_ab12cd34"}]`. Output of `upgradeV1` (ids kept):

```json
{ "schema": 2, "seq": 4, "entry": "s1",
  "triggers": [ { "id": "t1", "type": "newLead", "name": "Contact created", "filters": { "match": "all", "segments": [ { "match": "all", "rules": [] } ] } } ],
  "nodes": {
    "s1": { "kind": "wait", "type": "period", "config": { "n": 10, "unit": "minutes" }, "out": { "next": "s2" } },
    "s2": { "kind": "if_else", "type": "if_else", "config": { "gate": true, "noneName": "None",
            "branches": [ { "id": "s2_yes", "name": "Yes", "when": { "match": "any", "segments": [ { "match": "all", "rules": [ { "field": "has_email", "op": "true" } ] } ] } } ] },
            "out": { "s2_yes": "s3", "none": null } },
    "s3": { "kind": "wait", "type": "recurring", "config": { "mode": "window", "window": { "use": "office", "outside": "next" } }, "out": { "next": "s4" } },
    "s4": { "kind": "action", "type": "send_email", "config": { "subject": "Thanks {first_name}", "templateKey": "my_ab12cd34" }, "out": { "next": null } }
  } }
```
plus `settings = {reentry:"legacy_always", perRecord:true, stopOnResponse:false, timezone:"business", window:{on:false},
sender:{fromName:null}, markRead:false}`. `seq` = the highest numeric suffix of v1 ids (or the count) so new ids never collide.
`if_else.config.gate:true` means: an empty `none` branch ends the run with status `skipped` and reason `condition: <field>` (phase-4
parity; on a normal If/else, an empty `none` means END = `done`). `gate` is legacy-only (accepted on migrated rows, never in the
generation schema).

### 2.3 Wait types (GHL's 8 cards, in GHL order; picker reorders "Until the lead replies" to the top after a Send step)

| type | GHL card (exact) | our card | config | status |
|---|---|---|---|---|
| `period` | For a set period of time | same | `{n, unit: minutes\|hours\|days, resume?: {days, from, until}}` ("Advance window"; its "Additional Filter" day/month/year is greyed "Coming later") | ✓; unit seconds greyed "The timer runs once a minute"; max minutes 1440, hours 168, days 365 |
| `date` | Until a specific date/time | same | `{at?: "YYYY-MM-DDTHH:MM" (business wall clock) \| ref?: date field, dayTime: "HH:MM", when: on\|before\|after, offset?: {n,unit}, ifPassed: continue\|end\|goto\|skip_comms, gotoStep?: Id}` | + (`gotoStep` is a node reference, §2.5 `x-ref`) |
| `recurring` | Until a recurring window opens | same | `{mode:"times", freq: weekly\|monthly\|yearly, days?, monthDays?, nth?, months?, date?, at}` or `{mode:"window", window: {use: office\|outsideOffice\|custom, days?, from?, until?, outside: next\|at\|end, at?}}` | ✓ (`mode:"window"` = phase-4 "Only on"; `outside:"end"` ends the run with status `skipped`, reason "outside the allowed days and hours" — phase-4 `skip` parity) |
| `scheduled` | Until a scheduled date/time | same | `{anchor: job.date\|lead.booked_for\|lead.next_follow_up\|invoice.due, when: at\|before\|after, offset?, dayTime, ifPassed}` | + (`invoice.due` greyed "Needs Xero") |
| `reply` | Until the contact replies | **Until the lead replies** | `{channels: (chat\|email\|sms)[], timeout?: {n,unit}}` | + (`sms` greyed "Needs the phone line (Twilio)"; warning `W_REPLY_NO_SEND` when no customer send is upstream) |
| `user_reply` | Until a user replies | same | `{channels, users: "any"\|"assigned"\|profileId[], timeout?}` | + (`assigned` greyed unless the lead "Assigned to" field exists, Q6) |
| `action` | Until the contact takes a specific action | Until the lead takes a specific action | — | ✗ greyed "Needs link and email-open tracking (not in OPS)" |
| `conditions` | Until specific conditions are met | same | `{when: Condition, timeout?}` | + |

There is no separate `window` kind (Appendix A, E51): the phase-4 window is the `recurring` card in window mode.

### 2.4 Canonical keys (one table; used by upgradeV1, the SQL guards, the app registry mirror, log back-mapping and parity tests)

Stored keys are the **engine keys** below; GHL's words live only in labels (`ghl`, `label`). Existing trigger keys stay unchanged
(the app's emit check and event keys depend on them).

Triggers:

| key | GHL label (exact) | our label | category | record | source | event key (byte-pinned by tests) | availability |
|---|---|---|---|---|---|---|---|
| `newLead` | Contact created | Lead created | Contact | contact | scan `contacts` | `${id}:${reopened_at\|\|"new"}` (phase 4) | ✓ |
| `contact_changed` | Contact changed | Lead changed | Contact | contact | capture (whitelisted columns) | `${id}:chg:${field}:${txid}` | ✓ |
| `contact_tag` | Contact tag | Lead tag | Contact | contact | capture (tags diff, also on INSERT) | `${id}:tag:${+\|-}:${tag}:${txid}` | ✓ after G2.3 atomic tag edits |
| `custom_date` | Custom date reminder | Custom date reminder | Contact | contact/job | time | `${field}:${id}:${date}:${offsetKey}` | ✓ |
| `note_added` | Note added | Note added | Contact | contact | capture | `${id}:note:${noteId}` | ✓ after G2.3 atomic notes |
| `task_added` / `task_completed` / `task_reminder` | Task added / Task completed / Task reminder | same | Contact | task | capture / capture / time | `${id}:added` / `${id}:done:${txid}` / `${id}:due:${due}:${n}` | ✓ |
| `contact_dnd` | Contact DND | Lead DND | Contact | contact | capture `customer_opt_outs` (INSERT/DELETE; uses `old` on DELETE) | `${optout_id}:${on\|off}` | ✓ |
| `inbound_webhook` | Inbound webhook | Inbound webhook | Events | hook/contact | hook | `hook:${hookId}:${requestId}` | ✓ |
| `scheduler` | Scheduler | Scheduler | Events | none | time | `sched:${wfId}:${triggerId}:${localISO}` | ✓ |
| `call_details` (alias `missedCall`) | Call details | Call details | Events | call | scan `calls` | `${call.id}` (phase-4 missed key unchanged); answered/outbound `${call.id}:${status}` | ✓ |
| `customer_replied` | Customer replied | Lead replied | Events | contact | capture `lead_messages` in | `msg:${id}` | ✓ (sms greyed) |
| `user_replied` | User replied | User replied (description: "Someone in the office replied") | Events | contact | capture `lead_messages` out, auto=false | `msg:${id}` | ✓ |
| `form_submitted` | Form submitted | Website form submitted | Events | contact | scan (same pass as newLead) | `${id}:form:${reopened_at\|\|"new"}` | ✓ |
| `chat` | Conversations SLA | Conversations SLA | **Communication** | chat | scan `chat_sessions` | `${session.id}` (phase 4) | ✓ |
| `job_booked` | Customer booked appointment | Customer booked a job | Appointments→Jobs | contact | capture | `${id}:booked:${booked_for}` | ✓ |
| `booking_status` | Appointment status | Job booking status | Appointments→Jobs | contact | capture | `${id}:bk:${status}:${txid}` | ✓ |
| `jobClosed` | (ours) | Job closed | Appointments→Jobs | job | scan `jobs` | `${job.id}` (phase 4) | ✓ |
| `stage` | Pipeline stage changed | Pipeline stage changed | Opportunities→Pipeline | contact | scan, settle 30 s; also written by `automation_apply` with the identical key | `${id}:${status}:${stage_changed_at ISO ms}` (phase 4) | ✓ |
| `lead_status` | Opportunity status changed | Lead status changed | Opportunities→Pipeline | contact | capture | `${id}:st:${status}:${txid}` | ✓ |
| `stale` | Stale opportunities | Stale leads | Opportunities→Pipeline | contact | time (narrow window) | `${id}:stale:${stage_changed_at}:${N}` | ✓ |
| `invoice` | Invoice | Invoice | Payments | job | — | — | greyed "Needs Xero" |
| `commission_invoice` (alias of the mirror `invoice`) | — (ours) | Commission invoice received | Ours | none | capture `payroll_weeks` [verify column at build] | `inv:${week}:${person}` | System today |
| `payment_received` | Payment received | Payment received (job paid) | Payments | job | capture `jobs.payment_status` → the catalog's paid key | `${id}:paid:${txid}` | ✓ |
| `estimates` | Estimates | Quote status | Payments | contact | capture (Q5 decides the meaning) | `${id}:quote:${txid}` | ✓ |
| `documents_contracts` | Documents & contracts | Contractor agreement signed | Payments | supplier | capture `suppliers.agreement_status` | `sup:${id}:signed:${agreement_signed_at}` | ✓ |
| `review_received` (alias `googleReview`) | New review received | New Google review | Events | none | — | `rev:${reviewId}` | greyed "Needs the Google Business Profile connector" |
| `doc_expiring` (alias `docExpiry`) | — (ours) | Employee document expiring | Ours | employee | time | `doc:${emp}:${doc}:${expiry}:${days}` | System today |
| `insurance_expiring` (alias `bizInsurance`) | — (ours) | Business insurance expiring | Ours | none | time | `ins:${kind}:${expiry}:${days}` | System today |

Mirror aliases keep `autoReadyRows`/`template_key` mapping working (Appendix A, E18). "Not in OPS" triggers (Birthday, Note changed,
Engagement score, Email events, Inbound email, Trigger link clicked, Survey, Quiz, social lead forms and comments, Funnel pageview,
Video, WhatsApp, Affiliate, Courses, Communities, Ecommerce, Certificates, IVR, Client portal, Events management, Opportunity
created/changed) are absent; a picker search for them shows "Not in OPS". `alwaysReenter` (re-enter even with re-entry off, as GHL
does for appointment and invoice triggers): `job_booked`, `booking_status`, `jobClosed`, `payment_received`, `custom_date`,
`task_reminder`, `scheduler`, `stale`.

Actions (`kind:"action"` unless noted; v1 aliases in brackets):

| key | GHL label | our label | category | audience | availability |
|---|---|---|---|---|---|
| `update_field` | Update contact field | Update lead field | Contact | internal | ✓ |
| `add_tag` / `remove_tag` | Add contact tag / Remove contact tag | Add lead tag / Remove lead tag | Contact | internal | ✓ after G2.3 |
| `assign_user` (alias `assign_owner`, GHL "Add owner to opportunity") / `remove_assigned_user` | Assign to user / Remove assigned user | same | Contact | internal | greyed "Needs 'Assigned to' on the lead card" until Q6 |
| `dnd` | Enable/disable DND | Stop automatic messages | Contact | internal | enable ✓; disable greyed "Only a person can turn automatic messages back on" |
| `add_note` | Add to notes | Add to notes | Contact | internal | ✓ after G2.3 |
| `add_task` (`task`) | Add task | Add task | Contact | team | ✓ |
| `edit_conversation` | Edit conversation | Edit conversation (description: "Marks the lead's conversation as read") | Contact | internal | ✓ |
| `send_email` (`email`) | Send email | Send email | Communication | customer | ✓ |
| `send_sms` (`text`) | Send SMS | Send SMS | Communication | customer | greyed "Needs the phone line (Twilio)"; existing steps keep running and log `waiting_phone` |
| `internal_notification` (`push`) | Send internal notification | Send internal notification | Communication | team | `channel: push` ✓; `email` greyed "Needs a team email sender" (Q7); `sms` greyed (Twilio) |
| `send_review_request` | Send review request | Send review request | Communication | customer | ✓ when Google reviews are on, else greyed "Turn on Google reviews first" [verify the review_requests insert contract] |
| `send_live_chat` | Send live chat message | Send live chat message | Communication | customer | ✓ [verify the widget shows auto rows] |
| `manual_call` / `manual_sms` | Manual action to call / Manual action to SMS | same | Communication | team | ✓ / greyed (Twilio) |
| `internal_comment` | Add internal comments | Add internal comment | Communication | internal | ✓ |
| `move_stage` | Create/update opportunity | Move lead to pipeline stage | Pipeline | internal | ✓ (`Won` refused) |
| `mark_lost` | (Opportunity status) | Mark lead lost | Pipeline | internal | ✓; "Mark won" greyed "A lead is won when its job is entered" (deviation from plan §3, listed in the stage summary) |
| `send_invoice` / `send_estimate` | Send invoice / Send estimate | Send invoice / Send quote | Payments | customer | greyed "Needs Xero" |
| `webhook` | Webhook | Webhook | Send data | **external** | ✓, owners only to add (§3.12) |
| `update_custom_value` | Update custom value | same | Internal | internal | ✓ |
| `math` | Math operation | same | Internal | — | greyed "Coming later" |
| `ai_agent`, `ai_decision`, `ai_summarize` | AI Agent / AI decision maker / AI summarize | same | Workflow AI | — | greyed "Coming with Workflow AI" |
| kind `if_else` `if_else` · kind `wait` (§2.3) · kind `goal` (§3.6) · kind `split` `split` · kind `goto` `goto` · kind `workflow` `add_to_workflow` / `remove_from_workflow` | If / else, Wait, Goal event, Split, Go to, Add to workflow, Remove from workflow | same | Internal | internal | ✓ |

Absent: Google Sheets, Slack, audiences, Meta CAPI, Stripe, courses, communities, affiliates, IVR, Eliza, Custom code, Drip,
formatters, Create/Find/Delete/Merge contact, followers. "Guarded" types (drive the Draft rules): customer audience + `webhook`.

### 2.5 Registries (engine = single source of truth; exported, never copied as constants into the app)

Every entry: `key, ghl, label, description, category, icon, keywords, help, aliases?, available(ctx) → {ok, reason}`, a declarative
`fields` schema, and (actions) `audience, channel, needsContact, outbound`, `execute`, `preview`, (triggers) `recordKind, source,
filters (FIELDS keys), settleMs, alwaysReenter, contactless`, `scan`/`fromRecord` (scan and time sources only).

- **OPS registry** `{op, label (GHL), valueTypes[], args: JSON-Schema}`:
  - text: `is, is_not, contains, not_contains, contains_any, contains_none, starts_with, in, not_in, is_empty, is_not_empty`
    (labels "Is", "Is not", "Contains", "Does not contain", "Contains any of", "Does not contain any of", "Starts with",
    "Is any of", "Is none of", "Is empty", "Is not empty");
  - enum: `is, is_not, in, not_in, is_empty, is_not_empty`; tags: `has, has_not, has_any, has_none, is_empty, is_not_empty`;
  - number/money: `eq, neq, gt, gte, lt, lte, between, is_empty, is_not_empty`; date: `before, after, on, within_last,
    within_next, more_than_ago, is_empty, is_not_empty`; bool: `true, false`; people: `is, in, is_empty, is_not_empty`.
  - args: `is/is_not/contains/not_contains/starts_with` → `v: string` (or `ref`); `in/not_in/has_any/has_none/contains_any/
    contains_none` → `v: string[] (minItems 1)`; `has/has_not` → `v: string`; `eq…lte` → `n` (or `ref`); `between` → `n` + `v2`;
    `within_last/within_next/more_than_ago` → `n` + `unit`; `before/after/on` → `v: "YYYY-MM-DD"` or `ref`; `is_empty/
    is_not_empty/true/false` → none. Validator codes `rule_value_missing`, `rule_value_type`. Phase-4 keys keep their meaning.
- **FIELDS registry** (phase-4 CONDITIONS keys kept): `key, label, group (Lead|Job|Call|Chat|Task|Trigger|Now|Smart), valueType,
  ops, source (catalog list), recordKinds, triggers?, gate?, wakeOn (event types that can change it), timeRelative?, sensitivity?
  (money|private), value(f)`. New: `trigger.id` and `trigger.type` (enum of this workflow's triggers — branch per trigger),
  `trigger.*` payload keys, `now.day_of_week`, `now.day_of_month`.
- **MERGE_FIELDS** (syntax `{key}`, regex extended to `/\{([a-z_]+(?:\.[a-z0-9_]+)?)\}/`): phase-4 keys plus `{task_title}`,
  `{due_date}`, `{quote_amount}` (moneyText), `{booked_date}`, `{follow_up_date}`, `{lost_reason}`, `{assigned_user}`,
  `{custom.<key>}`, `{trigger.<key>}`. Each has `recordKinds`, `triggers`, `sensitivity`. `{trigger.*}` values are HTML-escaped when
  filled into emails.
- **REASONS** (code → label): `filter:<field>` "Filter not matched - <label> - Received value: <x>, Expected value: <y>" (GHL
  format), `before_published`, `test_record`, `loop_guard`, `own_change`, `reentry_off`, `already_enrolled`, `duplicate_event`,
  `no_contact`, `unavailable`, `paused_step`, `too_late`, `opted_out`, `capped`, `outside_hours`, `missing_details`, `skip_comms`,
  `removed_by_action` "Removed by Workflow Action", `removed_by_external_action` "Removed by External Workflow Action",
  `end_of_workflow` "Removed by - End Of Workflow", `replied` "Stopped: the lead replied", `automation_changed`, `switched_off`,
  `deleted`, `wrong_kind`.
- **x-ref**: every field that points at a node (`goto.target`, `date.gotoStep`) carries `"x-ref": "node"`; `x-source` names a
  business list (`catalog.stages|services|sources|tags|templates|people|workflows`) which the export resolves to `enum` +
  `x-enumLabels`.
- **Export DTO** (`step:"registry"`): `{key, ghl, label, description, category, icon, keywords, fields (resolved), ops, availability
  {ok, reason}, narration templates per field/op ("{field} {opLabel} {values}"), aliases, engine:true|false}`. Mirror-only System
  types are `engine:false` ("Built-in only for now"). Cached in the app by `availCtxHash + catalogRev`.
- **availCtx(T)**: `phone` = `settings.phoneEnabled`; `xero` = `catalog.connectors.xero.connected`; `gbp`/`reviews` = GBP connector /
  Google reviews on; `ai` = stage-6 `ai_settings.enabled` AND the Workflow AI toggle (false until stage 6 exists); `teamEmail` = Q7;
  `assignee` = `catalog.features.leadAssignee`; `atomicTags` = G2.3 shipped.

### 2.6 Per-workflow settings (`automations.settings`)

```json
{ "reentry": "off",                // "off" (GHL "Allow re-entry" off) | "after_exit" (on) | "legacy_always" (migrated rows only)
  "perRecord": true,               // "Allow multiple jobs" (GHL "Allow multiple opportunities"): one run per job/call/chat, else per lead
  "stopOnResponse": false,         // "Stop on response"
  "timezone": "business",          // "business" (Region and format) | "contact" greyed "Leads have no time zone yet"
  "window": { "on": false, "days": [1,2,3,4,5], "from": "08:00", "until": "17:00" },   // "Time window" → "Specific time"
  "sender": { "fromName": null },  // fromEmail greyed "Emails go from your connected mailbox"; fromNumber greyed (Twilio)
  "markRead": false }              // "Conversations: Mark as read"
```
- `normWfSettings(raw, prev)` clamps (pure, identical in app and engine). `wfSettingsProblems(s, prev, availCtx)` rejects
  unavailable options (`timezone:"contact"`) and accepts `legacy_always` only when `prev` already has it.
- New workflows: GHL defaults above. Migrated: `{reentry:"legacy_always", perRecord:true}` (exact phase-4 behaviour).
- Enrollment key = `perRecord` ? record key (`job:<id>`, `call:<id>`, `chat:<id>`, contact id for lead triggers) : `contact_id`
  (fallback record key; contactless = event key). Active lock: one waiting/running run per enrollment key, except `legacy_always`.
- `timezone`, `window` and `reentry` are part of the **arm key** (§2.8): changing them while Published re-arms.

### 2.7 Layout (`automations.layout`, builder only)
`{ v:1, adv: { "<id>": [x, y] }, stickies: [{id, x, y, w, h, color, title, body, anchor, hidden}], collapsed: [] }`
- stickies ≤ 50; title ≤ 80; body ≤ 2,000 chars of markdown-lite (`**b**`, `*i*`, `__u__`, `- `, `[t](https://…)`), rendered by
  `wfStickyMd` (escape first, https only, `rel=noopener`); colours `yellow|pink|peach|green|blue|purple` (tokens §5.10);
  `anchor` = node id (Standard stickies are anchored; deleting the anchor re-anchors to its parent or entry in the same commit).
- Zoom/pan per user in localStorage, never stored.

### 2.8 Shape and arm key (two keys, one definition each, canonical JSON)
- **`defShape(doc)`** → decides `version` bump + cancelling waiting runs. Includes: `entry`; per node `[id, kind, type, out pairs in
  port order, branch id order, path id order, wait type, timeout present, goto target, date.gotoStep]`. Excludes: names, notes,
  `disabled`, `locked`, all other config (messages, numbers, conditions, percents), layout, settings.
- **`armKey(doc, settings)`** → re-arm (`armed_at := now()`) when it changes while Published, no cancel. Includes the full
  `triggers[]` (id, type, filters, config, goto, disabled), `entry`, `settings.reentry`, `settings.timezone`, `settings.window`.
  This closes the "widened filter re-fires the last 6 hours" hole (Appendix A, B23).
- Both serialise with recursively **sorted object keys** (arrays keep order) and are compared as strings in JS and as `jsonb` values
  in SQL. JS `defShape`/`armKey` (engine and app copies) and SQL `automation_def_shape`/`automation_arm_key` share hand-written
  fixtures `fixtures/shape.json` (≥14 cases incl. key reordering, disabled toggle, goto retarget, branch reorder, filter edit).

### 2.9 Tables and columns (SQL file `.claude/sql/stage2-automations.sql`, three parts, each with checks before/after and ROLLBACK)

**Part 1 — additive, safe while phase 4 runs** (applied in phase 1, staging then live):
- `public.current_business_id()` (stable, `search_path=''`, returns `'default'`).
- `automations` new columns: `definition jsonb` (null = not migrated; check object, `schema=2`, ≤256 KB), `settings jsonb not null
  default '{}'`, `layout jsonb not null default '{"v":1}'` (≤128 KB), `builder text not null default 'standard'` check,
  `folder_id uuid` → `automation_folders` on delete set null, `deleted_at`, `deleted_by`, `deleted_by_name`, `origin text default
  'user'` check in (`user, copy, template, system, ai, migration`), `revision int not null default 1`, `published_at`,
  `published_by`, `system_key text` (unique per business where not null and not deleted), `system_handover_at timestamptz`,
  `enrolled_total bigint not null default 0`, `updated_by_name text`, `list_summary jsonb not null default '{}'` (trigger types,
  action types, audience, step count — written by `automation_save` so the list never downloads definitions). Drop nothing yet.
- `automation_folders` (id, business_id, parent_id on delete restrict, name 1–60, unique per parent case-insensitive, created_by,
  timestamps). Guard trigger: same business, depth(parent) + 1 + height(subtree of new.id) ≤ 5, no cycle.
- `automation_versions` (id, business_id, automation_id cascade, `version_no int` unique per automation, `revision int`, `version
  int`, status draft|published, reason in (`create, save, save_version, publish, unpublish, restore, ai, migration, duplicate,
  system_move`), name, definition, settings, layout, builder, content_hash, created_by, created_by_name, created_at). Index
  `(created_at)`.
- `automation_notes` (id, business_id, automation_id cascade, node_id null = workflow level, body 1–2000, created_by,
  created_by_name, created_at, edited_by_name, edited_at, deleted_at). Index `(automation_id, node_id)`.
- `automation_events` (id, business_id, type, event_key ≤200, record_kind, record_id, contact_id, at, available_at, ctx ≤ 8 KB,
  source scan|capture|time|hook|app|engine, cause_run_id, cause_automation_id, chain_depth, status new|processing|done|error,
  lease_until, attempts, processed_at, error, created_at; unique `(business_id, type, event_key)`). Indexes: due `(business_id,
  available_at) where status in ('new','processing')`; `(record_kind, record_id) where status='new'`; `(processed_at) where
  status='done'`; `(created_at) where status='error'`.
- `automation_wanted (business_id, event_type, pk both)`; RLS select `business_id = current_business_id()`.
- `automation_trigger_log` (details: matched rows + first 200 unmatched per trigger per day; unique `(automation_id, trigger_id,
  event_key)`; index `(automation_id, trigger_id, at desc)`, `(at)`) and `automation_trigger_daily (business_id, automation_id,
  trigger_id, day, attempted, matched, enrolled, reasons jsonb, pk (automation_id, trigger_id, day))`.
- `automation_enrollment_keys` (the re-entry ledger; never pruned while the workflow exists): `(business_id, automation_id cascade,
  enrollment_key, first_at, last_at, splits jsonb default '{}', pk (automation_id, enrollment_key))`.
- `automation_pauses` (id, business_id, start_wall text `YYYY-MM-DDTHH:MM`, end_wall, annually bool, automation_ids uuid[]
  `cardinality ≥ 1`, created_by, created_at). BEFORE trigger: ≤15 rows per business; end > start; ≤15 days; ids exist in the
  business and are not deleted; no workflow in two overlapping ranges (annual rows compared at year shifts −1/0/+1, Feb 29 → 28,
  ranges across New Year handled; parsing with regex + `make_timestamp`, so the check is immutable). AFTER trigger: wakes only the
  held runs of the automation ids in the old/new symmetric difference or whose range end changed.
- `automation_hooks` (id, business_id, automation_id cascade, trigger_id, token_hint, sample jsonb (last 3 payloads' keys/types),
  created_by, created_at, revoked_at, last_used_at, window_start, window_count) and `automation_hook_secrets (hook_id pk cascade,
  token_hash unique)` with RLS on and **no policies**.
- `automation_custom_values (business_id, key ^[a-z][a-z0-9_]{0,39}$, value ≤500, updated_at, updated_by)`.
- `automation_templates` (id, business_id, key, name, description, category, definition, settings, origin `system|user`,
  source_automation_id, created_by(_name), timestamps, deleted_at). Seeded by the `migrate` step from registry seed data
  (Appendix A, E19). Validated through the function only (insert/update revoked from authenticated).
- `automation_reviews (automation_id pk, business_id, acked_until, acked_by, acked_at)`.
- `automation_system_meta (business_id, base, folder_id, pk (business_id, base))` — folder placement of virtual System rows (not in
  the catalog; Appendix A, P7).
- `system_claims (business_id, key pk, at)` — shared exact claims for customer System bases (`chatText:<session>`,
  `missedText:<call>`, `review:<job>`) used by legacy functions and the engine.
- `automation_settings` new columns: `default_builder` (`standard|advanced`), `error_notify jsonb` (validated by
  `automation_error_notify_ok`), `smart_lists jsonb` (≤10, validated by `automation_smart_lists_ok`).
- `automation_state` new columns: `capture_errors int not null default 0`, `capture_error_last text`, `wanted_hash`,
  `scan_marks jsonb`, `housekeeping jsonb` (cursor + day), `v2_migrated_at`, `error_notice_at`, `phase4_compat bool`.
- `automation_runs` new columns: `trigger_id, cursor_step, loop smallint, visits jsonb, steps_done int, steps_today int,
  steps_day date, enrollment_key, active_lock, chain_depth, cause_run_id, parent_run_id, source (trigger|manual|workflow),
  watch text[], recheck boolean, stop_on_reply, first_sent_at, exit_reason, remove_requested bool, revision int`. Widen checks:
  `record_kind` adds task|supplier|employee|hook|none; `status` adds removed|stopped. Partial unique `(automation_id, active_lock)
  where active_lock is not null`; indexes `(business_id, contact_id) where status='waiting'`, `(automation_id, created_at desc)`,
  `(automation_id, status)`, `(status, recheck, due_at) where status='waiting'`. BEFORE UPDATE trigger clears `active_lock` when
  status leaves waiting/running.
- `automation_log` becomes the execution log: new columns `row_kind (enroll|step|action|exit) default 'action'`, `step_type`,
  `step_name`, `loop smallint default 0`, `seq int`, `version`, `revision`, `trigger_id`, `detail jsonb` (no secrets, no headers,
  body preview ≤500), `next_at`. `channel` and `audience` become nullable; channel adds `chat, review, webhook, record`; status adds
  `added, executed, waiting, wait_finished, branch, jumped, finished, removed, stopped`. **In the same transaction:** create
  `automation_log_action_once (run_id, step_id, loop) where row_kind='action'`, drop constraint `automation_log_once`, and replace
  `automation_claim_customer` (old signature) with a wrapper over `automation_claim_customer_v2(..., p_loop)` whose `exists` check
  and cap count filter `row_kind='action'` (and `loop = p_loop` for the exists). Existing rows are all `action`/loop 0, so the
  swap is equivalent for phase 4 (Appendix A, E2/E36). Indexes `(run_id, seq)`, `(automation_id, step_id, at)`,
  `(automation_id, at) where status='failed'`.
- `contacts.assigned_user_id uuid` — only if Q6 = add now.
- RPCs (all `set search_path=''`; service-role only unless noted): `automation_claim_events(p_business, p_now, p_limit,
  p_lease_s, p_id default null, p_record_kind default null, p_record_id default null)` (always `available_at <= p_now`);
  `automation_enroll(...)` (§3.3); `automation_claim_customer_v2`; `automation_apply(p_business, p_cause, p_kind, p_id, p_ops)`
  (§3.9); `automation_wake`; `automation_stop_on_reply`; `automation_save(...)` (§3.13); `automation_prune(p_business, p_now,
  p_budget)`. Read RPCs (**security invoker**, granted to authenticated, `business_id = current_business_id()`, stable, paged ≤100):
  `automation_list_stats(p_since)` → ONE jsonb object keyed by automation id; `automation_trigger_stats`; `automation_trigger_evals`;
  `automation_unmatch_reasons`; `automation_step_stats`; `automation_enrollments`; `automation_execution_log`;
  `automation_log_steps(p_automation, p_from, p_to)` (distinct step id + name for the "Older steps" filter);
  `automation_needs_review`; `automation_mark_reviewed(p_automation)` (sets `acked_until = now()` server-side).
- Capture triggers (silent until `automation_wanted` has rows): contacts AFTER INSERT/UPDATE, tasks AFTER INSERT/UPDATE,
  lead_messages AFTER INSERT, customer_opt_outs AFTER INSERT/DELETE (`case tg_op when 'DELETE' then old else new end`, `return
  null`), jobs AFTER UPDATE OF payment_status, suppliers AFTER UPDATE OF agreement_status, payroll_weeks [verify]. Body: whitelisted
  columns compared directly (`new.phone is distinct from old.phone`, generated statically — no `to_jsonb(new)`), values clipped to
  200 chars; **reads `automation.cause`** (`'<run>:<depth>:<automation>'`) and stamps `cause_run_id/cause_automation_id/
  chain_depth` into the event instead of going silent (Appendix A, E12); available_at = at + per-type settle. The whole body is in
  `begin … exception when others then begin update automation_state set capture_errors = capture_errors+1, capture_error_last =
  left(sqlerrm,200) …; exception when others then null; end; end;` — a capture failure can never roll back the app's save
  (Appendix A, E1/E37). Before writing: verify `contacts.tags` is `text[]` (else `jsonb_array_elements_text`).
- RLS: `enable row level security` on every new table. Owners/managers `for all` on folders, notes (insert by business; update/
  delete by author or owner), custom values, reviews, system_meta; select-only on versions, trigger log/daily, events, hooks
  (column grant excludes nothing secret: secrets are in the separate table); no policy (service role) on enrollment keys, hook
  secrets, system_claims, team_email_outbox. `revoke insert, update, delete` on engine tables from anon/authenticated.

**Part 2 — switch the guards to the doc** (phase 2, right after deploying the function that can save and migrate):
1. `automation_guarded_channels(def jsonb)` (immutable; walks `nodes.*.type` over **all** nodes incl. disabled, delinked and
   unknown — unknown counts as customer) using `automation_action_audience(type)` (explicit map generated from the registry; a test
   reads the SQL text and compares with `ACTIONS` where audience ∈ customer|external; legacy v1 rows still read `steps`).
2. `automations_guard` v2 (BEFORE INSERT/UPDATE, security invoker):
   - INSERT: `enabled := false` always; `origin` limited to `user|copy` unless `automation.via='fn'`; `revision := 1`;
     `enrolled_total := 0`.
   - UPDATE: `version := old.version + 1` and `armed_at := now()` when `automation_def_shape` changed; `armed_at := now()` when
     `automation_arm_key` changed while enabled; `enabled := false` when guarded channels grew; `enabled := false` when `deleted_at`
     set; `revision := old.revision + 1` when name/definition/settings/layout/builder changed (never on enabled, folder, armed);
     pins `origin, revision, published_at/by, enrolled_total, system_key, system_handover_at` to OLD unless `automation.via='fn'`;
     `deleted_by := auth.uid()` when deleted_at goes from null to set; migration GUC (`automation.migrating='on'`) keeps `version,
     armed_at, enabled, audience` and sets `revision := old.revision + 1`.
   - legacy write guard: an update that changes `trigger`/`steps` on a row whose `definition` is not null is refused
     ("This workflow was upgraded: reload the app").
3. `automations_after` (AFTER UPDATE, **security definer**, owned by postgres): when `version` changed, `enabled` went false or
   `deleted_at` was set → set-based `update automation_runs set status='cancelled', exit_reason=<automation_changed|switched_off|
   deleted>, active_lock=null where automation_id=new.id and status='waiting'`, insert one `exit` log row per cancelled run, delete
   the enrollment keys of those runs that no other run of the workflow used (Appendix A, E6/E55). Running runs are caught by the
   executor's own stale check.
4. Snapshots are written only by `automation_save`/function steps (not by a trigger), so they run as the service role; on conflict
   `(automation_id, version_no)` do nothing.

**Part 3 — lock direct writes** (phase 3, after the new app is live and the old editor saves through the function):
- `revoke insert, update, delete on public.automations from authenticated; grant update (name, description, folder_id, deleted_at)
  on public.automations to authenticated;` (rename, move, soft delete, restore from Deleted). Column-level revokes do nothing while a
  table grant exists, hence table revoke + column grants (Appendix A, E4/E34). Check-after:
  `has_column_privilege('authenticated','public.automations','enabled','UPDATE') = false`.
- drop policy "automations: owners and managers delete" (hard delete only in housekeeping; Appendix A, E54/P5).
- Direct owner/manager writes stay allowed (and are validated server-side) for: `automation_settings.error_notify`, `smart_lists`,
  `default_builder` (CHECK functions), `automation_pauses` (its BEFORE trigger), `automation_folders` (its guard),
  `automation_notes`, `automation_reviews` (through `automation_mark_reviewed`).

Cron: unchanged (`automations-tick`, every minute). Retention (housekeeping, §3.15): events done 7 d / error 30 d; trigger-log
details 30 d, daily 35 d; runs finished **180 d** (= the log; GHL screens never lose a run before its log rows); log 180 d;
versions ≤10 or ≤30 d, hard cap 50; soft-deleted automations hard-deleted after 30 d **except rows with `system_key`**; revoked
hooks 30 d; team_email_outbox 30 d.

---------------------------------------------------------------------------------------------------------------------------

## 3. Engine (`supabase/functions/automations/index.ts`, one deployable file, Verify JWT OFF)

Code layout inside the single file (section markers keep build groups disjoint): `// ==== REGISTRY`, `// ==== DOC`
(types, upgradeV1, defShape, armKey, compile, ports, refs), `// ==== VALIDATE`, `// ==== CONDITIONS`, `// ==== WAITS`,
`// ==== EXECUTOR`, `// ==== EVENTS` (scanners, matcher), `// ==== ACTIONS`, `// ==== HOOKS`, `// ==== API`,
`// ==== HOUSEKEEPING`. Kept from phase 4 as is: region/time helpers (bizTzOf, zoneParts, zoneToUtc, inWindow, nextAllowed, nextAt,
nextInBoth, planWait, holidays), normSettings, customerGuard, recentAutoMessages, customerKeys, mergeVars/fillMerge/unfilled
(extended), signatureOf/bizOf/officeOf/agentOf/emailAuthor/emailBody, boardFor/pushRecipients/taskPeople, reconcile, sendTo/
vapidKeys, sameSecret, caller.

### 3.1 Endpoints (`POST {step}`)

| step | caller | does |
|---|---|---|
| `tick` | cron (secret header) | §3.2 |
| `event` `{type, id}` | app (owners, managers, office with permission; `canEmit`) | scan/time types: build with `fromRecord`, insert (source app), claim by id, match, advance ≤10. Capture types: never build; claim that record's pending captured events (`p_record_kind/p_record_id`) and process them (Appendix A, E43). Always respects `available_at` → returns `settling` like today |
| `hook` | public; token in header `x-hook-token` or path segment `/hook/<token>` (stripped before any log) | §3.11 |
| `registry` / `schema` | owners, managers (+ ai-gateway service role) | §2.5 / §6 |
| `validate` `{definition, settings, automation_id?, base_revision?, generate?}` | owners, managers | `{errors[], warnings[], shapeChanged, armChanged, idsRemoved[], waitingRunsAffected}` (`generate:true` also checks the generation JSON Schema: Workflow AI's build) |
| `patch` `{automation_id, base_revision, ops[], builder?, ai_edited?}` or `{automation_id, ops:[], outline:true}` | owners, managers (Workflow AI calls it with the person's token) | **Read-only** (runs on `readOnlySb`, never writes, never publishes): applies ≤ 60 `wfApplyPatch` ops (§6.3) to the stored doc at `base_revision` and runs the same checks as `validate` → `{definition, settings, name, idMap, errors[], warnings[], idsRemoved[], changedIds[], triggersRemoved[], settingsChanged[] (the settings keys), entryChanged, shapeChanged, willDraft, waitingRunsAffected, revision}`; 422 `errors` = the ops' own errors (`E_PATCH_*`, with `opIndex`), 409 `conflict` = stale revision, 409 `not_upgraded` = a phase-4 row, 404 gone. `outline:true` → `{revision, name, enabled, outline}`: the compact outline `read_workflow` sends the model (a webhook's url only by its host). The edit is saved only by a later `save` with `ai_edited:true` (always a Draft). |
| `save` `{automation_id\|null, expected_revision, name, definition, settings, layout, builder, template_drafts?, ai_edited?, reason?}` | owners, managers | §3.13 |
| `publish` `{automation_id, on, confirm?}` | owners, managers | §3.13 |
| `duplicate` `{automation_id\|version_id\|template_id}` | owners, managers | new Draft, origin copy, `system_key` stripped, template words copied to new keys |
| `test` `{automation_id?, definition, settings, trigger_id?, record:{kind,id}?, assume?}` | owners, managers | dry run §3.14 |
| `preview` | old app | alias of `test` mapped to the phase-4 response shape (removed in phase 7) |
| `enroll` `{automation_id, record, start_at?, request_id}` / `unenroll` `{run_id}` / `record_runs` `{record}` | Q2 decides roles | §4.9 |
| `restore` `{automation_id, version_no, expected_revision?}` / `copy_version` | owners, managers | §4.7; with `expected_revision` (Workflow AI's undo), 409 `conflict` when it was saved since |
| `hook_create` / `hook_revoke` / `hook_sample` | owners, managers | token = 32 random bytes base64url shown once; sha-256 stored |
| `migrate` | owners (one time, idempotent) | §3.16 |
| `system_move` / `system_unmove` / `system_activate` | owners | §4.10 |

### 3.2 Tick pipeline (40 s budget; `automation_tick_lock` unchanged)
1. `loadContext` + `availCtx` + holidays (unchanged).
2. Cheap list `select id, revision, version, enabled, armed_at, deleted_at, settings` of published, non-deleted workflows (paged);
   re-read `definition` only for ids whose `revision` changed since the cached `compile()` (cache key `id:revision`; Appendix A,
   B35). Compute `wanted` = enabled trigger types ∪ goal/field `wakeOn` of compiled docs ∪ `customer_replied` (reply waits or
   stopOnResponse) ∪ `user_replied`; rewrite `automation_wanted` when its hash changes.
3. **Produce** (budget ≤ 8 s): scan and time sources of wanted types. Each scanner reads only `[mark − lookback, now]` from its
   watermark in `automation_state.scan_marks` (phase-4 scanners keep their filters and keys; the watermark only narrows the window),
   pages with `.range()`, upserts `on conflict do nothing`. Time scanners query only the due window: `stale` → for each distinct N,
   `stage_changed_at between now − N d − lookback and now − N d`; `custom_date`/`task_reminder` → date column = business day of
   (now ∓ offset) and due time ≤ now; `scheduler` → slots between the mark and now; a slot older than `lookback_hours` after an
   outage is skipped and logged once. A scanner failure is isolated. Indexes on `contacts(stage_changed_at)`,
   `contacts(next_follow_up)`, `contacts(booked_for)`, `jobs(date)`, `tasks(due)` are added in Part 1.
4. **Match** (stop at 20 s elapsed): `automation_claim_events(…, 300, 120)`; prefetch facts for all contacts of the batch in one
   `.in()`; per event, oldest first: wake (`automation_wake(contact, watchFor(type))`), stop-on-reply (`customer_replied`), evaluate
   every published trigger of that type (§3.3), write trigger-log details (bulk insert, on conflict do nothing) and upsert the daily
   aggregate, enrol matches, mark done (error after 5 attempts). On the time guard, unprocessed claimed events go back to `new` with
   `attempts − 1`.
5. **Execute** (≥15 s reserved): `automation_claim_due(…, 25, 120)` ordered `(recheck, due_at)` — heartbeat rechecks come last and
   at most 10 per tick (Appendix A, E8) → `advanceV2` each; out-of-time hand-back as phase 4.
6. `reconcile` (unchanged).
7. Housekeeping with the remaining time (§3.15).

### 3.3 Trigger evaluation and enrolment
Per event × enabled trigger of that type (first failing reason is recorded):
1. `ev.at < armed_at` → no log row (`before_published` only counted in the daily aggregate).
2. Test record and `S.ignore_test_records` → `test_record`.
3. `ev.chain_depth > MAX_CHAIN (3)` → `loop_guard`; `ev.cause_automation_id = a.id` → `own_change`.
4. Filters (`evalCondition` on lazily loaded facts/ctx) → `filter:<field>` with received/expected values.
5. Matched → `automation_enroll(p_business, p_automation, p_version, p_revision, p_trigger, p_event_key, p_event_type, p_event_at,
   p_record_kind, p_record_id, p_contact, p_enroll_key, p_lock_key, p_reentry, p_start, p_context, p_source, p_chain, p_cause,
   p_parent, p_stop_on_reply, p_now)` — one transaction under `pg_advisory_xact_lock(hashtext(automation_id||enroll_key))`:
   active lock held → `already_enrolled`; `reentry='off'` and the ledger has the key and the trigger is not `alwaysReenter` →
   `reentry_off`; else upsert the ledger, insert the run (`due_at = event_at`, `cursor_step = start`), violation of
   `automation_runs_once` → `duplicate_event`; increment `automations.enrolled_total`; insert the `enroll` log row →
   `enrolled:<run>`.
Start node = `trigger.goto ?? entry`. Trigger implicit conditions (stage move stands, chat unanswered) stay run-time gates as in
phase 4. [Phase-2 build, 15/10: the stage gate is ALSO checked at match time (EV_MATCH_GATES) — an undone move is dropped as
`move_undone`, never enrolled; for upgraded rows (reentry legacy_always) a stage event must still be the lead's current stage at
match time, else `moved_on` (phase-4 parity); native v2 docs fire on every move (GHL).] Multi-trigger rule (Appendix A, E21/B3): a field or merge blank used at a node is valid only if **every** trigger that can
reach that node provides it (`reachingTriggers(doc)` = Standard: all enabled triggers; Advanced: via trigger goto, out edges and
goto refs); otherwise `E_FIELD_NOT_FOR_ALL_TRIGGERS` naming the trigger. Branch per trigger with the field `trigger.id`.

### 3.4 Executor `advanceV2(sb, run, T, now, fx)`
```
a  = T.autos.get(run.automation_id) ?? fx.readAutomation()       // cached per tick
gone = stale(a, run)                // phase-4 stale + deleted_at + version mismatch + not enabled
if gone → end('cancelled', gone)
C  = compile(a)                     // node index: parent, port, reachable, downstreamGoals(id), refs, first(triggerId)
if validateStructure(a) has errors → end('failed', 'invalid: …')   // availability problems never fail a run (E49)
f  = loadFactsV2(run)               // contact/job/call/chat/task/supplier/employee; contactless → {}
if record gone → end('cancelled', 'record deleted')
if run.attempts > 5 → end('failed', 'kept failing')               // writes ONE failed log row for the run (P34)
cur = run.cursor_step ?? legacyCursor(run, a) ?? C.first(run.trigger_id)   // v1 in-flight: steps[step_index].id
budget = 50                         // nodes per advance call, then yield (status waiting, due_at = now)
while cur:
  g = goalAhead(C, cur, f)          // a met goal downstream of cur (out-edges only, not via goto)
  if g → log('jumped', {to:g, skipped:[ids]}); cur = g; continue
  n = C.node(cur)
  if moved to a new node id: run.steps_done++, run.steps_today++ (reset per business day)
     if run.steps_today > 200 or visitsSinceHold(cur) > LOOP_MAX_VISITS(10) → end('failed', 'loop guard')
  if n.disabled → log('skipped','paused_step'); cur = n.out.next ?? END; continue
  switch n.kind: wait → §3.5 · if_else → §3.6 · split → §3.6 · goal → §3.6 · goto → §3.6 · workflow → §3.7 · action → §3.8
  a hold (wait, deferral, pause, window, NO_CARD retry) writes status waiting + due_at + watch (§3.5) and resets visitsSinceHold
if cur == END → end('done', 'end_of_workflow') + exit row
```
Every log row carries `seq` = `run.steps_done`, `loop` = the visit number of that node in this run, `version`, `revision`,
`trigger_id`, `step_type`, `step_name` (the name at the time). Step counters move only when the cursor reaches a new node or a goto
fires — never on a heartbeat recheck of the same held wait (Appendix A, E40/E15).

### 3.5 Holds, waits, watches, heartbeats
- On the first entry into a wait: `ctx.w = {id, loop, startedAt, until, timeoutAt}`, one `waiting` row with `next_at`. On release:
  `wait_finished` with `detail.outcome` (`time|met|timeout|passed`) and `detail.resumed_by`.
- **watch** for every hold = `waitWatch(kind)` ∪ `wakeOn` of `C.downstreamGoals(cur)` (later goals on the out-path, including goals
  inside descendant branches) ∪ `['customer_replied']` if stopOnResponse. Non-wait holds (customer-hours deferral, time window,
  pause, NO_CARD) get only the goal/stop watches. `automation_wake` sets `due_at = now` for matching waiting runs; on wake,
  `goalAhead` is checked before the wait is re-evaluated (Appendix A, E7/E42).
- **heartbeat**: `due_at = min(target, now + 60 min)` with `recheck = true` for `reply`, `user_reply`, `conditions`, goal-wait and
  date/scheduled (record date may move). Conditions on time-relative fields compute the next moment the result can change and use it
  when earlier. Rechecks are claimed last (§3.2).
- `period`: `until = planWait(anchor, n, unit, tz)`, then `nextAllowed(until, resume)` if set; on release `anchor = until`
  (phase-4 anchor semantics).
- `recurring` `mode:"window"`: phase-4 window logic as is (including `ctx._pass` and `outside next|at|end`); `mode:"times"`:
  `nextRecurrence(now, cfg, tz)` (pure; weekly, monthly days/nth/last, yearly incl. Feb 29 → Feb 28).
- `date` / `scheduled`: resolve the target from fresh facts (date-only values use `dayTime`, default 09:00), apply `when`/`offset`;
  already passed → `ifPassed`: continue / end / goto (`cur = gotoStep`) / `skip_comms` (outbound actions skipped until the next
  wait, reason `skip_comms`).
- `reply`: met = an inbound `lead_messages` row on the channels for this contact with `at > startedAt`; checked once more at the
  moment the `waiting` row is written (closes the race where the reply lands while the run is leased; Appendix A, E60).
- `user_reply`: outbound, `auto=false`, users filter [verify the author field]. `conditions`: evaluate `when` on fresh facts.
- With `timeout`: met → port `next`, timeout → port `timeout`. Without: wait until met (heartbeat continues).

### 3.6 Logic nodes
- **If / else**: gates first (implicit trigger conds first, as phase 4), then branches in order; the first true wins; else `none`.
  Logs `branch` with `detail {branch_id, branch_name, conds:[{label, received, expected, ok}]}`. Migrated gate if → empty `none`
  ends `skipped` (`condition: <field>`).
- **Split**: bucket = `hash32(a.id + ':' + n.id + ':' + enrollment_key) % 100` (independent per split step); the chosen path id is
  stored in the ledger `splits[n.id]` and reused on re-entry while that path still exists with percent > 0 (GHL "keeps its path";
  Appendix A, E14). Logs `branch` with `{path_id, percent}`.
- **Goal** (`goal` kind; types `tag_added`, `tag_removed`, `stage_reached`, `lead_status`, `appointment`, `payment`, `form`,
  `user_replied`, `task`, `document`; `email_event`, `trigger_link`, `review_clicked` greyed "Needs tracking (not in OPS)"):
  met → `executed`, next. Not met → `ifNotMet`: `end` (done, "goal not met") | `continue` | `wait` (hold with the goal's wakeOn +
  heartbeat). Reaching a goal by jump logs the skipped node ids.
- **Go to**: `visitsSinceHold[target] ≥ 10` → `end('failed', 'loop guard: Go to ran 10 times without waiting')`; else `run.loop++`,
  log `jumped {to, visits}`, `cur = target`. Validator: every goto cycle must contain a wait that holds (period, date, recurring,
  scheduled, or reply/user_reply/conditions **with a timeout**) → else `E_LOOP_NO_WAIT` (blocks publish); a customer send inside a
  cycle → `W_LOOP_CUSTOMER` (the daily cap applies). A weekly loop runs indefinitely; a tight loop fails at 10 (Appendix A, E15/B10).

### 3.7 Workflow nodes
- **Add to workflow** `{workflowId, passTriggerData}`: target must be published (else log `skipped` "target is a Draft");
  `automation_enroll(target, source 'workflow', parent run, chain + 1, event_key "wf:<run>:<node>:<loop>", start = target's entry)`;
  chain > MAX_CHAIN → skipped `loop_guard`. Next.
- **Remove from workflow** `{scope: current|another|all_except_current|all, workflowId?}`: other runs are matched by `contact_id`
  (not enrollment key; Appendix A, E56): `update … set status='removed', exit_reason='removed_by_external_action' where
  status='waiting'`; running ones get `remove_requested = true`, which `advanceV2`'s write (`.eq('status','running')`) honours.
  `current` and `all` are terminal: the current run ends `removed` with `removed_by_action`.

### 3.8 Action nodes (order kept from phase 4 where it existed)
1. Registry lookup; unavailable → `send_sms` logs `waiting_phone` (phase 4); others log `skipped` `unavailable: <reason>`.
2. `needsContact` and no contact: customer action and event younger than `NO_CARD_WAIT_MS` → hold 2 min; else `skipped no_contact`.
3. Trigger implicit conditions fail → end `skipped` (phase 4).
4. `now − due_at > max_late_hours` → claim `skipped too_late`, next.
5. Already claimed for `(run, node, loop)` → next.
6. A global pause covers now for this workflow → hold until it ends (reason `paused until <ISO>`; enrolment continues;
   `max_late_hours` counts from the pause end).
7. `ctx.skipComms` and outbound → `skipped skip_comms`.
8. Time window (`settings.window.on`) applies to **every action** (GHL "Execute actions if the current time falls in this window");
   outside → `planDeferTree`. Logic nodes and waits are exempt.
9. Customer action: re-read the automation (stale → cancelled); Stop on response (replied after `first_sent_at`) → end `stopped`;
   no email signer → skipped (phase 4); `customerGuard` with the hours intersected with the window: defer → `planDeferTree`, skip →
   claim skipped, ok → `claimCustomer_v2(loop)` (capped → skipped; done → next) → execute → update the log row → set
   `first_sent_at`; then `markRead` applies op `read` when on.
10. External action (`webhook`) that carries a lead: opt-out (`all`) and test-tag checks of customerGuard (no hours, no cap); then
    claim → execute.
11. Team/internal action: claim → execute (engine writes via `fx.apply`) → update the log row.

`planDeferTree(C, cur, at)` = phase-4 `planDefer` on the node map: walk parent pointers back over actions and if_else (re-evaluated
then), stop at split or wait-with-timeout parents or before any other wait; at a `recurring/window` wait take `nextInBoth` and set
`ctx._pass`; ≤20 hops. On a migrated straight workflow it returns exactly the phase-4 `{at, back}` (parity tests).

Action effects (each through `automation_apply` unless noted): `update_field` (`set`, column whitelist = the `contact_changed`
whitelist minus phone/email), `add_tag`/`remove_tag` (`tags`), `add_note` (`note`, `{id, text, by:"Automation: <name>", at}`),
`dnd` (`optout`), `edit_conversation` (`read`), `move_stage`/`mark_lost` (`stage`, only when `status is distinct from` the target;
`Won` refused; lost reason from the catalog), `assign_user` (`set assigned_user_id`), `add_task`/`manual_call`/`manual_sms` (`task`,
`boardFor`, categories from the catalog's task categories), `internal_comment` (activity_log), `send_email` (queued `lead_messages`
row as phase 4; `body` inline or `templateKey`), `send_live_chat` (latest chat session ≤24 h, else skipped "no open chat"),
`send_review_request` (insert `review_requests` waiting/automation; claim `system_claims review:<job>`), `internal_notification`
(push `sendTo`), `update_custom_value` (upsert), `webhook` (§3.12). Record values (paid, done, lost) come from catalog keys, never
literals (Appendix A, E33).

### 3.9 Engine record writes and chained events
`automation_apply(p_business, p_cause, p_kind, p_id, p_ops)` sets `automation.cause` locally, applies ops in order with typed casts
on a per-table whitelist, writes `activity_log` rows (`Automation: <name>`), and **inside the same transaction**: capture triggers
fire and stamp the cause; for the scan type `stage` it inserts the `stage` event itself with the scanner's exact key
(`to_char(stage_changed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`, pinned by a JS↔SQL fixture), cause stamped, so
the scanner's later insert of the same key is a no-op (Appendix A, E38). A workflow therefore never re-fires itself, and chains stop
at depth 3.

App tag/note edits switch to atomic RPCs (`contact_tags_edit(p_id, p_add, p_remove)`, `contact_note_add(p_id, p_note)`, security
invoker) in G2.3, so an open card's whole-array save cannot erase an engine tag or emit a false "tag removed" (Appendix A, E53).
Until then `contact_tag`, `note_added`, `add_tag`, `remove_tag`, `add_note` are greyed "Coming with the new lead card".

### 3.10 Stop on response, time window, timezone, sender, pause
- Stop on response: the run copies the setting; a `customer_replied` event → `automation_stop_on_reply` (`stopped`, `replied`) for
  waiting runs with `first_sent_at < reply.at`; the executor rechecks before every customer step.
- Timezone: always `bizTzOf(cat)`. Sender: `fromName` overrides `S.email_signer`, then `created_by_name`; the signature still comes
  from Business details (`signatureOf`). Pause: `pauseUntil(pauses, automationId, now, tz)` (pure, identical in app and engine).

### 3.11 Inbound webhook (`hook`)
- Per-isolate per-IP throttle (30/min) before any DB call; token from header or path only; `sha256(token)` → active hook. Draft
  workflow: store only `sample` (flattened keys and types of the last 3 payloads; values ≤200 chars) for the builder's "Fetch
  sample request" button; no enrolment. Published: rate limit 60/min per hook (atomic `window_count`), 429 over.
- Body ≤32 KB JSON, flattened to ≤50 keys normalised to `^[a-z0-9_]{1,40}$` (lowercase, dots → underscores, deduped), values ≤150
  chars, keys dropped until `ctx` ≤ 7 KB (Appendix A, E45/E24). Lead match by trigger `config.match {phone, email}` via `phoneKey`/
  `cleanEmail`; no match → contactless run. Response `{ok:true}`; unknown token → 404 (same as "no hook").

### 3.12 Outgoing webhook
`https://` only; refused: IP literals, localhost, `*.local`, `*.internal`, `*.supabase.co/.in`, private/link-local/CGNAT (also on
resolved A/AAAA when `Deno.resolveDns` exists); `redirect:"manual"`; 10 s timeout; 1 retry on 5xx/network; body = chosen merge fields
or a JSON template with JSON-escaped blanks (≤16 KB); log status and ms only. Headers that look secret are refused at validation
(secret references come in a later step). Audience `external`: new rows start Draft (guard), adding one to a Published workflow
switches it to Draft, only owners can add it, the Publish confirm lists "Sends lead details to <host>", validator warning
`W_SENDS_OUTSIDE` (Appendix A, E13/E52).

### 3.13 Save and publish (the only content write paths)
- `step:"save"`: verify role; `validateStructure` + `validateAvailability` + semantic checks; a **Published** workflow refuses
  errors (422 with the list; GHL "publish blocked while errors"), a Draft may be saved with errors. Returns 409 when
  `expected_revision ≠ revision` (with `updated_by_name`, `updated_at`). Writes `template_drafts` first (catalog templates, keys
  minted with `autoLibKey`, idempotent), then calls `automation_save` RPC (security definer; sets `automation.via='fn'`,
  `automation.reason`; updates with the revision check; returns `{revision, version, enabled, armed_at, shapeChanged, armChanged}`).
  `ai_edited` or origin ai on a Published row → saved as Draft (MASTER §11; Appendix A, E3/B32). Snapshot rule: a version row is
  written when the reason is `save|save_version|ai|restore|create|duplicate|migration` and `content_hash(definition, settings,
  name)` differs from the last snapshot; layout-only saves never snapshot (Appendix A, E48/B50).
- `step:"publish" {on}`: on → validation (errors → 422), overlap check against active System rows (blocking, "Turn off the
  ready-made <name> first, or it sends twice"), guarded-type confirm required in the request (`confirm:true`), set `enabled`,
  `published_at/by`, snapshot reason publish (always), recompute `wanted`; a `system_key` row also calls `system_activate` (§4.10).
  Off → `enabled=false`, snapshot reason unpublish; the AFTER trigger cancels waiting runs. Publishing never bumps `revision`; the
  response returns the current revision so an open builder stays in sync (Appendix A, B45).
- With 0 enabled triggers publishing is allowed with the warning "Only manual add or Add to workflow can start it".

### 3.14 Dry run (`step:"test"`, Test workflow)
- One executor, two adapters: `realFx = {readAutomation, claimLog, claimCustomer, execute, apply, enroll, removeRuns, writeRun,
  now}`; `simFx` replaces every write with a recorder that returns "would execute" and `execute` with `ACTIONS[t].preview` (filled
  message, recipients, board, subject, signature). `test` also runs on `readOnlySb(sb)` (select-only `from`, allow-listed stable
  RPCs); a write attempt throws `SimulationWriteError`, which becomes `{ok:false, reason:'internal: write attempted'}`, never a step
  verdict (Appendix A, P36).
- Virtual clock jumps to each wait's `until`. Deterministic rules: Split uses the real sticky hash; reply/user-reply/conditions
  waits and goals follow `assume[nodeId]` (`met|timeout`, `met|not_met`), default: a reply that already exists counts, else
  `timeout` if a timeout port exists, else stop with "Would wait for a reply"; conditions/goals are evaluated on the record now;
  Go To uses the engine visit cap; total ≤200 path entries → `ended:'loop_guard'|'step_limit'`.
- Trigger not matched → `trigger.matched=false` + reason, and the path continues "as if it matched". Guard verdicts (opt-out, cap,
  test record, customer hours) are reported per step in `guard` and the path continues "as if it went".
- Works on unsaved drafts and contactless triggers; "Run test" is greyed only for `E_*` errors on reachable nodes.
- Response `{ok, problems, trigger, path:[{stepId, kind, type, would, at, until?, branchId?, pathId?, outcome?, target?, guard?,
  preview?, why?}], ended, notes}`; `branchId` is mandatory for if_else, split and waits with a timeout port.

### 3.15 Housekeeping, needs review, error digest
- Runs once per business day in leftover tick time, in batches of ≤1,000 ids, looping until done or out of time; the cursor in
  `automation_state.housekeeping` carries over to the next tick (Appendix A, E11). Calls `automation_prune` (one SQL function per
  table, `delete … returning` in one statement).
- Needs review = unacknowledged `failed` log rows in 30 days (counted as distinct runs; a retried attempt that later succeeds writes
  no failed row; a run that ends `failed` writes exactly one) or a stored validation problem (an action became unavailable, a
  catalog key vanished) found by the daily `validateAvailability` sweep.
- Error digest: at most once per 24 h, counting failures since `coalesce(error_notice_at, now − 7 d)`; recipients resolved at send
  time to profiles that still are owners/managers (fallback: owners). Push now; email per Q7.

### 3.16 Migration and back-compat
- Order: SQL Part 1 → deploy v2 function in **compat mode** (phase 1: reads v1 rows through `upgradeV1`, keeps the phase-4
  scanners + enqueue, executes with `advanceV2`) → differential gate (§8.3) → phase 2: event store + new nodes deployed → SQL Part 2
  → `step:"migrate"` → app adapter → phase 3: SQL Part 3 → phase 7: drop `trigger`/`steps` 30 days later after a backup.
- `migrate`: for every row with `definition is null`: `automation_migrate_row(id, upgradeV1(...), settings)` under the migration GUC
  (keeps version, armed_at, enabled, audience; revision +1; snapshot reason migration); seeds `automation_templates` from registry
  seed data; sets `v2_migrated_at`. Idempotent.
- In-flight runs: `cursor_step null` → `steps[step_index].id`, which exists in the map with the same id; `ctx._pass` keeps working
  (the window keeps its id). The five phase-4 event-key formats are reused byte for byte (test-pinned), so nothing re-fires.
- **Rollback**: redeploy the committed `automations-phase4-compat` build (phase-4 code with `.eq('row_kind','action')` in its prior
  check and channel mapping) — prepared and committed in phase 1. The ROLLBACK block sets `enabled=false` and lists every row where
  `definition is not null and (trigger = '{}'::jsonb or revision > <migration snapshot revision> or updated_at >
  v2_migrated_at)` — anything created or edited in v2 — so phase 4 never runs stale words (Appendix A, E17/E39/B19). Definitions are
  backed up to `.claude/backups/automations.before_stage2_<date>.sql` before migrate.

---------------------------------------------------------------------------------------------------------------------------
## 4. Automation page, Global settings, per-workflow Settings, history / logs / path / stats / versions / test screens

### 4.1 Navigation and shell
- One Settings page replaces two: remove the `templates` ("Message templates & Automations") and `notifications` entries from the
  `renderSettings` pages registry; add `{group:'Customers', id:'automation', icon:'zap', title:'Automation', desc:'Workflows: what
  happens by itself, the notifications the team gets and the words customers get.', keywords:'automations workflows notifications
  templates triggers actions wait pause logs history', bare: () => !!WF_UI.open, body: () => renderAutomationPage()}`. Location is
  Q1 (default: inside Settings, the builder opens full-width).
- `OLD_SETTINGS_PAGES` gains `notifications:'automation'`, `templates:'automation'` (a `templates` deep link sets the Message
  templates tab). `openAutoPage` stays as a one-line shim to `openAutomation({tab, key, wfTab})` until phase 7.
- `setSettingsPage` reload invalidation → `if (id==='automation') wfInvalidate('list','stats','settings')`.
- Deep links: `START_LINK` parses `wf` (uuid or `^ready:(review|chatText|missedText|team:[A-Za-z]{2,30})$`), `wfTab`
  (`builder|settings|enroll|logs`), `run` (uuid), `listTab` (`all|review|deleted`) into `START_LINK.wf*` with their own flag
  `START_LINK.wfUsed` (the existing `used` flag is spent at boot; Appendix A, P42). `wfLink(id, wfTab, extra)` exists in app and
  engine (parity test); the engine reads the app URL from a per-business setting, never a constant.
- Header "Automation"; tabs "Workflows" | "Global Workflow Settings" | "Message templates" (`.seg`). No "What's new".
- `WF_UI` (serialisable; stage 4 pushes it to history): `{tab, listTab, view ('cards'|'table', localStorage 'ops.wfListView'),
  folder, q, filter, sort, page, pageSize (default 10, GHL), sel[], statsOpen[], open:{key, tab, mode, versionId, runId,
  contactId, enroll:{fromDay,toDay,event,status,q,page}, logs:{…}, stats:{fromDay,toDay}}}`.

### 4.2 Loaders (render-loop safe)
- `wfEnsure(bucket, key, fetcher, showingFn)`: one promise per key (loading/ok/error entries are never started twice); on settle,
  `renderKeepingInput()` once, only if `showingFn()` (the same `WF_UI.open` key and tab). `wfInvalidate(...buckets)` from Refresh and
  successful writes, followed by one `render()`.
- **Keys contain only stored values.** Every date range is resolved once, when a screen opens or a filter is applied, into
  `{fromDay, toDay}` business-tz day strings in `WF_UI`; `fromIso/toIso` and keys derive from those strings; `render` never calls
  `Date.now()` for a key (Appendix A, P1/P25). The list RPC's `p_since` is rounded to the day the same way.
- Maps are capped at 30 keys (oldest evicted) and cleared when leaving the page. Search typing redraws only its container;
  server searches debounce 300 ms (one timeout per keystroke, never a loop).
- In read-only modes (presentation, view-as) the read endpoints in `READ_ONLY_CALLS = {rpc:['automation_list_stats',
  'automation_trigger_stats','automation_trigger_evals','automation_unmatch_reasons','automation_step_stats',
  'automation_enrollments','automation_execution_log','automation_log_steps','automation_needs_review'], fn:['registry','schema',
  'validate','test','record_runs']}` are let through; a test proves each listed SQL function is `stable` + invoker and each listed
  function step writes nothing (static scan). Everything else shows the real reason ("Presentation mode: …"), never "Can't reach"
  (Appendix A, B28).

### 4.3 Workflows tab
- Top: `phoneNotificationsBar('settings')`, shown when any System team row is on **or** any Published engine workflow has a push
  action; `checkPhoneNotifications` uses `page==='automation' && WF_UI.tab==='workflows' && !WF_UI.open`; the Payroll copy says
  "Settings → Automation" (Appendix A, P12/P38).
- "Workflows list" with "Create folder" (outline), "Build using AI" (purple outline, greyed "Coming with Workflow AI"), "+ Create
  workflow ▾": "Start from scratch" (opens an unsaved Draft — nothing is inserted until the first Save), "Build using AI" (greyed),
  "Select from template".
- Sub-tabs "All workflows" | "Needs review (N)" | "Deleted" | saved smart lists | "+ New smart list" (+ right "Customize list").
  Toolbar: "Advanced filters" (count badge), Cards/Table toggle (`aria-pressed`, remembered), "Search". Breadcrumb "Home / …".
- Data: `automations` paged in 1,000s with an explicit column list (no `definition`/`layout` in the list: a generated summary
  `list_summary jsonb` with trigger types, action types, audience — maintained by `automation_save`); folders (≤200); stats via
  `automation_list_stats(p_since)` (one jsonb object; Total enrolled = `enrolled_total`, Active = waiting+running, Paused, open
  errors, channel counts over 180 days); settings row; virtual System rows. `wfItem(row, stats, settings, ctx)` (pure) →
  `WfItem` (§6.4). Status pill from `wfStatusOf`: Published (green outline), Draft (grey), Paused (amber "Paused until 2 Jan"),
  System gate pills ("Off until go-live", "Waits for the business phone").
- **Cards (default)**: folders first, then one `.ncard`-style card per workflow (today's Notifications look):
  icon tile by first action category; "When <trigger narration>" (2+ triggers: "When a new lead comes in, or 2 more"); name with
  badges (System, Paused, "3 errors →", gate); one-sentence summary; "Goes to:" chips; "14 enrolled · 2 active · Updated Oct 12";
  "Edit", "⋯", and the Draft⬤Publish toggle. **Virtual** System team cards keep their inline legacy controls (wait minutes, hours,
  days, Office chip, "Send a test"); moved System rows render from their definition like any workflow (Appendix A, P8).
- **Table (GHL)**: ☐ | Name (+ open in new tab, System badge) | Status | Total enrolled (link → Enrollment history) | Active
  enrolled (link, status=active) | Last updated | Created on | Stats ⓘ › | ⋮. Folder rows leave counts blank; virtual System rows
  "—" with tooltip "Runs on the built-in system; its history starts when it moves into the engine". "Stats ›" accordion: Email
  (Sent, Failed, Skipped), Notifications (Sent, Failed), Tasks (Added), SMS greyed "Needs the phone line (Twilio)", Opened/Clicked
  greyed "Email opens and clicks are not tracked"; footer "Stats are kept for the last 180 days". The table scrolls inside its own
  container on phones. Pager "Previous 1 2 3 … Next" + "10 / page" (10, 25, 50).
- **Row ⋮** (GHL order): "Upload to Template Library", "Edit workflow", "Rename workflow", "Open in new tab", "Publish"/"Draft
  workflow", "Move to folder", "Duplicate workflow", "Test workflow" (greyed "Comes with the new builder" until phase 6), "Delete workflow", greyed "Copy To Sub-Account" ("Comes with
  multi-business accounts"). System rows add "Move into the engine" (owners; greyed with the reason until movable), "Move back to
  the built-in system" (moved rows), "Open its old settings" (virtual). Folder ⋮: "Rename folder", "Move to folder", "Delete folder",
  greyed "Manage permissions" ("Only owners and managers can edit workflows").
- `wfSetPublished(key, on)` (toggle, menu, bulk): virtual System → legacy setter (`autoReadyAct`); engine rows → `step:"publish"`
  with confirms: customer/external sentence + "This sends to real customers. Publish it?"; Draft with active runs "N records waiting
  in this workflow will stop"; a moved System row going Draft "<name> stops completely: the built-in one is off since the move".
- **Duplicate** → `step:"duplicate"` (Draft, same folder, "<name> (copy)", `system_key` stripped, opens in the builder).
  **Delete** → modal "Type the workflow name to delete it" → soft delete (`deleted_at`; the guard forces Draft; waiting runs
  cancelled at once). A moved System row cannot be deleted ("Move it back to the built-in system first"). **Move to folder** modal
  with breadcrumb, "New folder", "Move here" (cycles refused in the UI and by the guard; virtual System rows write
  `automation_system_meta`).
- **Bulk**: "Select all ▾" (All workflows, All folders, Published, Draft); bar "Publish/Draft", "Move", "Delete".
  `wfBulkPlan(items, action, ctx)` (pure) → `{go, ask, skip:[{key, why}]}` with: folders not publishable; virtual System rows "Runs
  on the built-in system: use its switch"; deleted rows; "Has errors"; customer/external → `ask` (one unticked checkbox each, "I
  checked its words and timing"); overlap with an active System row → `ask` with the reason; moved System rows: delete skipped with
  the reason; locked System rows skipped with `lockedLine`; System hides go through `wfSystemHidePlan` — ONE catalog write for all
  (Appendix A, P39). Sequential execution of ≤200; then one toast, one invalidate, one render ("The first 200 were done; run it again
  for the rest" when more).
- **Templates** ("Select from template"): modal with chips All, Leads, Jobs, Customers, Team notifications, Reviews, Mine; search;
  cards (name, description, "Uses:" chips, greyed reason when something is unavailable) with "Preview" (read-only canvas when the
  builder exists, else `flowSentence`) and "Choose template". Source: `automation_templates` rows (System seeds + the business's own
  under "Mine", with Rename/Delete). Choose → builder unsaved, Draft, `template_key='tpl:<key>'`; a template derived from a System
  base carries `legacyClaim` and cannot be published while its System row is on.
- **Needs review**: rows with open errors or a stored validation problem; columns Name | Status | Errors | Last error | "Review" (→
  Execution logs, status Failed, since the acknowledgement); "Mark as reviewed" → `automation_mark_reviewed`.
- **Deleted**: engine rows deleted in the last 30 days + hidden System rows; Name | Deleted on | Deleted by | Days left |
  "Restore" (engine: `deleted_at=null`, root folder, Draft, toast "Restored as a Draft"; System: `autoRestoreReady`).
- **Advanced filters / smart lists**: rows `[field][operator][value][trash]`, "+ And condition"/"Or condition", "Apply", then
  "Save", "Save as new smart list", "Discard changes". `WF_LIST_FILTERS` registry with a `valueType` per field (`enum`, `isoDay`,
  `isoDayRange`, `profileId`, `triggerType`, `actionType`): status, trigger, action, audience, system, updated, updatedBy.
  `wfFilterMatch` and `wfFilterProblems` (pure; SQL twin `automation_smart_lists_ok`). Smart lists are optional (last group of
  phase 3).

### 4.4 Global Workflow Settings tab (cards, each with its own Save; saving never jumps)
1. **"Notifications"**: toggle "Email notification" + GHL help text; "Select users" (owners/managers; default all owners), "Other
   email addresses" (≤10, email-checked). Note per Q7 (default: push digest to the selected users now; email part greyed "Needs a
   team email sender" until the info@ outbox is verified). Stored in `error_notify`.
2. **"Pause workflow"**: help "Temporarily pause selected workflows during a specified time period. Records still enter; they wait at
   their next step until the pause ends." (deliberately not GHL's "draft state", because our Draft cancels waiting runs). Rows: Start
   date and time → End date and time (`datetime-local`, business wall clock), "Select workflows" (Published engine workflows; virtual
   System rows greyed "Runs on the built-in system until it moves into the engine"), "Annually", copy, delete; "+ Add date", "Pause
   dates: n / 15"; GHL notes "Maximum allowed difference between the start and end date is 15 days." and "A workflow should not be
   part of two or more date ranges that are overlapping." `wfPauseProblems` (pure, same rules as the DB trigger) shows problems
   inline; the table trigger is the authority. Held customer messages still keep customer hours and the cap after the pause.
3. **"Default builder"**: "Default builder for new workflows" radios "Standard builder" / "Advanced builder" (Advanced greyed
   "Coming with the Advanced builder" until phase 5). Greyed "Who can switch between builders" ("Only owners and managers can edit
   workflows").
4. **"Workflow AI"**: "AI Builder" toggle with GHL help, greyed "Coming with Workflow AI"; stores nothing until stage 6 (it becomes
   a view of `ai_settings`; Appendix A, P50).
5. **"Customer message safety"** (ours): today's `autoSafetyHtml` + `autoSafety*` moved unchanged, plus "These limits always apply on
   top of each workflow's own time window."
6. Greyed "Auto save" ("We keep Save with undo").

### 4.5 Message templates tab
`renderTemplatesPage()` reused: "Sent by <automation>" links → `openAutomation({key})`; status pills from `wfStatusOf`; users counted
over engine workflows (`autoTplUsers` over `WF_DATA.list`). Storage unchanged (`catalog.templates`, `catalog.msgTemplates`).

### 4.6 Per-workflow "Settings" tab (part of the builder draft: saved with the top Save, in undo and the local draft)
- Card "Lead" (GHL "Contact"): "Allow re-entry" (GHL help with "lead"; migrated rows show on + hint "Also while still in it (kept
  from before). Switch off and on to use the standard rule."), "Allow multiple jobs" ("Lets a lead with several jobs go through this
  workflow once per job. Off: once per lead."), "Stop on response" (GHL help; "Replies by text count once the phone line (Twilio) is
  connected.").
- Card "Communication": "Timezone" ("Business timezone (<label>)" | "Lead timezone" greyed "Leads have no time zone yet"; GHL help),
  "Time window" toggle "Specific time" (Start/End 15-min selects, "Include days"; GHL help; note "Customer messages also keep the
  business's customer hours (Global Workflow Settings)."), "Sender details" (From name ≤60; From email greyed; Signature read-only
  preview from Business details with a link; From number greyed), "Conversations: Mark as read".
- "Pause workflow" read-only section when a current or future range includes the workflow, linking to Global settings.
- Validation `wfSettingsProblems` (pure, identical in engine). The GHL re-entry exception for appointment/invoice triggers is
  implemented through `alwaysReenter` and noted in the help text.

### 4.7 Version history (left rail ⇧V; content owned by this area)
- "Version history — Version history is kept for 30 days, or the last 10 versions if older." Filter by editor. "Current version"
  card (name, `v<version_no>`, avatar + date, Draft/Published pill, GHL link "Save Version" = `save` with reason `save_version`);
  "Previous versions" paged (`.range(0,49)`), each with "Restore" and ⋮ "Create new workflow from version".
- Opening one loads its snapshot read-only with the yellow banner "This Version is in View Only Mode"; tabs shrink to "Builder |
  Settings" (Settings read-only from the snapshot); "Back to builder".
- "Restore" follows GHL: enabled only while the workflow is Draft (waiting runs are already cancelled by then) and the builder has no
  unsaved changes; otherwise greyed "Switch to Draft first, or create a new workflow from this version". It writes the snapshot back
  as a Draft (reason restore). "Create new workflow from version" → `copy_version` (Draft, `system_key` stripped).

### 4.8 Enrollment history, Execution logs, View details, See contact path, Stats view, Test workflow
- **Enrollment history**: "View a history of all the leads that have entered this workflow" (job wording for job-only triggers);
  filters: date range (default last 30 days, max 180, presets), "All events" (triggers by name, "Added manually", "Added by another
  workflow"), "All statuses" (Active, Waiting, Paused, Finished, Ended, Removed, Stopped, Failed), "Search lead", refresh. Data:
  `automation_enrollments` RPC with **keyset paging** (`created_at`, `id` tie-break; Appendix A, P47). Search via the pure
  `wfRecordSearchFilter(term)` (phone clause only with ≥3 digits, values in PostgREST double quotes, `% _ \ " *` escaped/dropped;
  jobs matched through `customer_name`/`invoice_number` on `record_id`; "Showing the first 50 matching leads; type more to narrow
  it"). Columns: Record | Enrollment reason (trigger name from the run's revision snapshot; "Added manually by X"; "Added by workflow
  Y"; "Removed trigger") | Date enrolled (business tz short offset, e.g. "AEDT +11:00") | Current action | Current status pill
  (`WF_RUN_STATUS`: Waiting; Paused (amber) when held by a pause; Executing; Finished; Ended; Removed with tooltip "Removed by Kim" /
  "Removed by Workflow Action" / "Removed by External Workflow Action" / "Workflow changed" / "Switched to Draft"; Stopped "The lead
  replied"; Failed) | Next execution on ("Not available") | Actions: clock "View lead history" (the Enrollment switcher), path
  "Highlight lead path", open-card icon.
- **Execution logs**: "View a history and details of all executions performed by this workflow"; filters date range (default 30 d,
  max 180), "All actions" (current steps, then "Older steps" from `automation_log_steps`), "All statuses" (Added To Workflow,
  Executed, Waiting, Wait Finished, Skipped, Failed, Finished, Removed), "Search lead", refresh. Rows from `automation_execution_log`
  (keyset): Record | Action (icon + `step_name` at the time; system rows "Add to workflow"/"Removed by - End Of Workflow"/"Removed by -
  <reason>") | Status (`WF_LOG_STATUS`) | Executed on | Actions: "View details" (red when failed), clock, person, "Go to action"
  (greyed "No longer in the workflow"). Failed rows tinted. Per-lead view: header card with "See contact path" ("See lead path"),
  breadcrumb "Logs / <name> / Execution ID - <8 chars>", "Enrollment" switcher (the lead's runs here, ≤50). "Mark as reviewed" when
  the filter shows failures.
- **View details** drawer: the log row + `detail` rendered by `WF_DETAIL_LABELS` (unknown keys as escaped JSON), message preview as
  escaped text; nothing fetched from outside.
- **See contact path**: read-only canvas of the run's definition: snapshot with `revision ≤ run.revision`, latest; pruned →
  current definition + banner "This run used an older version that is no longer kept; showing the current one."; steps not on the
  canvas listed "N steps of this run are no longer in the workflow". Info box: Lead ID, Lead details, Execution ID, Enrollment date,
  "Workflow version when execution started: v<version_no>". A pruned run falls back to its `enroll` log row. `wfPathFromLog(def,
  rows)` (pure) → `{entered, visited, failed, skipped, waitingAt, branchTaken, edges, gotoEdges, missing}`; canvas styles: visited
  green border + halo, dashed green edges, failed red, skipped grey dashed, waiting pulsing amber dot (reduced-motion safe), "Entered"
  badge. "← Back" replaces "← Workflows list".
- **Stats view** (canvas mode, ⌘⇧S): yellow pill "Stats view", banner "Workflow is not editable in Stats view. Note: Stats are only
  available for the last 30 days."; triggers show Attempted / Matched / Unmatched and "View Detailed Stats >"; action nodes widen
  with executed/sent/skipped/failed/waiting; split/if/timeout headers show per-branch counts. Modal "Stats: <trigger>": KPI cards
  (Attempted, Matched %, Unmatched %), date range ≤30 d, "Select Contact" ("Select lead"), tabs "Stats Data" | "Top Reasons for
  Unmatch", table Record | Phone or email | Date/Time | Match Status | Reason for unmatch, footer "Data is stored for last 30 days" ·
  "10 / page". Unmatched detail rows beyond the daily cap are summarised ("+N more unmatched that day, counted in the totals").
- **Test workflow**: top-right "Test workflow" → right panel "Run a test for lead" ("…for job/call/chat" per the reaching trigger's
  record kind; all four kinds supported): "Test as if" [trigger ▾] when triggers differ, "Select lead to test this workflow" (paged
  server search), per-node "Assume" chips for reply/conditions waits and goals, "Run test". Sends the **current unsaved** draft.
  Results → synthetic log rows via the full mapping (execute→executed; wait→wait_finished + `resumed_by` + `branch_id`; branch→
  branch + `branch_id`/`path_id`; goal→executed + `met`; goto→jumped + `target_step_id`; stop→removed + reason; skip→skipped;
  not_reached→ignored) → `wfPathFromLog`, so the canvas lights exactly like See contact path, with the amber banner "Test result:
  nothing was sent". The panel lists each step's verdict chip and the escaped preview (Appendix A, P13/B6).

### 4.9 Manual "Add to workflow" (lead card)
- Lead card Details tab, after Tags: block "Automation" (`#lm-workflows`) rendered synchronously from `WF_DATA.lead.get(contactId)`
  on every modal build; fetched only on a cache miss, after add/remove, or Refresh (Appendix A, P22). Shows "Active workflows" (name,
  "Waiting until …"/"At: <step>", "Remove"), "Recent" (last 5), "Add to workflow".
- Picker from `record_runs` (returns `{runs, enrollable:[{id, name, why}]}` so roles without automations RLS see the list): Draft
  greyed "Publish it first", virtual System greyed "Runs on the built-in system", job/call/chat-only triggers greyed "Starts from a
  job, not a lead", workflows using merge fields outside the manual (lead) set greyed "Uses details only its trigger has (e.g.
  {call_time})"; "Start": "Now" | "At a date and time" (≤30 days); "Add".
- `enroll`: Published, not deleted, System moved or not system; record exists, not a test record; `wrong_kind` refused; re-entry
  per settings; event key `manual:<request_id>` (double click harmless); `trigger_id null`; start = entry (`defaultStart`), due =
  start_at; context `{manual:true, by, byName}`; facts and merge fields are the lead's only (`fieldsFor('manual')`); no trigger
  implicit conditions. `unenroll` (waiting only; running → `busy`). Activity lines on the lead. Who may do it: Q2.

### 4.10 System workflows (ready-made mirrors) — no behaviour change until each is moved
- `autoReadyRows` → `wfSystemRows(all)` (alias kept until phase 7), same 11 rows (review, chatText, missedText, 8 `team:<id>`),
  plus `system`, `virtual`, `def` (via `upgradeV1`), `card`, `folderId` (from `automation_system_meta`), `movable`, `movedTo`.
  A parity test pins `key/base/on/gate/toggle/locked` against today's `autoReadyRows` on stored fixtures.
- Virtual rows: read-only canvas (or `flowSentence` before phase 4) with banner "System workflow · runs on the built-in system" +
  "Duplicate to edit" + "Move into the engine" (owners, when movable). Their history tabs show the greyed note "Runs on the built-in
  system. Its history starts when it moves into the engine." Locked guard conditions of ready-made defs become `lock:true` rules
  (cannot be removed by people or AI: `E_LOCKED`).
- `WF_SYSTEM` registry (engine): per base `legacy`, `audience`, `claim` (exact legacy key formula), `overlapMinutes` (≥ the legacy
  function's longest delay: leadWaiting = lookback + waitMinutes; unpaid/docExpiry/bizInsurance = 24 h; others 30 min), `movable`.
  `movable` flips per base in a release only after: engine supports its trigger/actions; parity test (engine `test` decision,
  recipients, words and claim key = legacy) passes; customer bases: Ofek's OK.
- **Move** (`system_move`, owners, idempotent on `system_key`): the function builds the definition server-side
  (`systemDefinition(base, S, catalog)`), inserts the row (Draft by the guard), origin `system`. For team bases `armed_at` is set
  back by `lookback_hours + overlap` (safe: the engine claims the legacy key, e.g. `push_sent lead:${id}:${at}`, before sending).
  Nothing changes for the legacy function yet.
- **Handover = Publish** (`system_activate`, called by publish of a `system_key` row): sets `system_handover_at = now()`. Legacy
  functions (push, review-requests, conversations, voice text) skip kind k only when a row with `system_key=k`, `enabled`, not
  deleted, has `system_handover_at < now − overlapMinutes` — they read the automations table, never the catalog (Appendix A,
  P2/P7/P26/P27). Shared claims (`push_sent` for team, `system_claims` for chatText/missedText/review) make whichever side comes
  first send, so the overlap never doubles (Appendix A, P29). Unpublishing the moved row brings the legacy back after a confirm;
  `system_unmove` clears the handover and soft-deletes the engine row's link. Moved rows: delete refused, purge skipped.
- Phase 7 moves team bases (newLead, leadWaiting, unpaid, docExpiry, bizInsurance; invoice when the app stops calling
  `notifyOwnersInvoice`), one per release with its legacy-function change; missedCall after Twilio; googleReview after its connector;
  customer bases only with Ofek's OK.
- The 8 notification cards become System team cards; "New team alert" becomes "+ Create workflow → Select from template → Team
  notifications". Storage of `catalog.notify` is unchanged.

---------------------------------------------------------------------------------------------------------------------------

## 5. Standard builder + Advanced builder

### 5.1 Mounting and shell
- New root `<div id="wf-root" hidden>` between `#app` and `#modal-root`; builder CSS `z-index: 90`. Builder dialogs use their own
  `#wf-modal` layer (z 95); `confirmAction`/`showToast` stay above. `openModal` is never used by the builder (it replaces
  `#modal-root` and would cancel a pending confirm; Appendix A, B48).
- While open: `#app` gets `inert` + `aria-hidden`; `body.wf-open` hides `#chase-bubbles` and moves `#phone-widget` above the
  minimap on the right (calls stay visible); the zoom stack sits at `bottom: max(16px, var(--phone-widget-h))`.
- `wfAppDataChanged()` runs at the **top** of `render()` (in a try/finally so early returns can't skip it): if `AUTH.status !==
  'ready'`, the profile changed, or `!canViewSection(profile,'settings')`, it writes the local draft, `wfClose({force:true})` and
  toasts "Signed out: your unsaved changes are kept on this device" (Appendix A, B40). It bumps `ctxRev` when the catalog
  reference, phoneEnabled, connectors or the registry change.
- Layout (grid): top bar 48 px ("← Workflows list" | panel toggle | name ✎ | presence avatars (Supabase Realtime presence channel
  `wf:<id>`, no table) | "Recent changes" | ↶ ↷ | "Save"/"Saved"); second bar 44 px (builder ▾ | "Builder · Settings · Enrollment
  history · Execution logs" | "Test workflow" | "Draft ⬤ Publish"); body = rail 48 px | left drawer 0/320–520 | viewport | right
  drawer 0/40%.
- Viewport contents: `.wf-world` (ONE element with `transform: translate(x,y) scale(k)`) holding stickies (DOM), one SVG for edges
  (keyed `<path data-e>`), node cards (DOM; `dir="auto"` names); screen-space marquee, bottom-left controls (Standard: hand · + ·
  100% · − · fit; Advanced: select · hand · fit · − · + · Tidy up), top-left keyboard button (K), top-right "+ Add ▾" ("Add trigger"/
  "Add action"), yellow/green mode pills, bottom-right minimap `<canvas>` (DPR-aware, hidden < 900 px). Grid = CSS background
  following the view (fades at k < 0.4). `.lod-far` at k < 0.45 hides text lines and "+" buttons.
- One delegated listener per event type on `#wf-root`, routed by `data-act/data-id/data-port`; every interpolated string `esc()`d;
  ids regex-checked.

### 5.2 State, paint scheduler, no render loops
- `WF` (never in `UI`): `{token, id, systemKey, name, status, audience, doc, layout, builder, settings, tplDrafts, base:{doc,
  layout, builder, settings, name, rev, tplDrafts}, docRev, layoutRev, ctxRev, regRev, mode ('edit'|'stats'|'version'|'path'|
  'test'|'system'), ro, tab, sel:Set, focus, drawer, picker, rail, view, tool, hist:{past, future}, dirtyParts, raf, painting,
  gesture, saving, derived}`. No `hover` in state: hover/focus-within are CSS only (Appendix A, B13/B46).
- `wfInvalidate(...parts)` ORs flags (`chrome, canvas, view, drawer, rail, mini`) and requests ONE rAF. `wfPaint()` increments
  `window.__wfp`, reads `wfDerived()` memoised on `${docRev}:${layoutRev}:${builder}:${mode}:${regRev}:${ctxRev}` → `{layout,
  issues, order, narration, reaching}`, and patches only flagged parts. `wfSyncNodes` keys each card by `name|type|summary|noteCount|
  statsText|verdictText`; selection, issue level and path verdict are class/attribute toggles on the existing element, so focus
  survives. An invalidate during paint is deferred and counted in `__wfPaintReentry` (asserted 0).
- Loaders (`wfLoad`, `wfLoadRegistry`, `wfLoadStats`, `wfLoadVersions`, `wfLoadVersion`, `wfLoadNotes`, `wfLoadRecords`,
  `wfValidateRemote`) use the memoised `.p` pattern, start only from user actions, and paint once on resolution if `WF.token` is
  unchanged. `wfValidateRemote` is keyed by the draft hash and debounced; errors set loaded=true so it never retries in a loop.
- `wfGuardEdit()` blocks mutators only in stats/version/path/test/system modes. Presentation mode and view-as allow local editing,
  undo and Test; `wfGuardWrite()` blocks Save, Publish, notes, template writes (Appendix A, B12).

### 5.3 Model (pure; all in `tests/business-logic.test.js` DECLS)
- `wfNewDoc`, `wfMintId(doc, prefix)` (from `doc.seq`; never reuses), `wfPorts`, `wfParents`, `wfChildren`, `wfSubtree`,
  `wfIsAncestor`, `wfClusters`, `wfReachable(doc, {viaRefs})` (W_DELINKED uses viaRefs:true; Standard blockers/layout use false;
  Appendix A, B43), `wfRefs(node, reg)` (all `x-ref` paths), `wfReachingTriggers`, `wfTailOf`, `wfOrder`.
- Mutators (return a new doc with structural sharing; input deep-equal before/after): `wfInsert` (multi-port nodes take the old
  downstream on their insert port with the toast "The steps below moved into <Branch>"; `goto` and terminal workflow nodes only on
  END slots), `wfMove` (`one` re-links parent → child; multi-port moves its subtree; never into its own subtree), `wfDelete`
  (`one`/`fromHere`; multi-port `one` needs `keepPort` — Q4; refs to the deleted id → null + `E_GOTO_TARGET`; locked refused),
  `wfConnect` (1:1 overwrite; ancestor refused "Loops are made with a Go to step"), `wfDisconnect` (makes a cluster), `wfSetNode`
  (reconciles `out` when ports change: new port → null; removed port with steps → `E_PORT_HAS_STEPS` unless `dropPorts`),
  `wfSetTrigger` (type change asks "Remove N filters that don't fit <type>?" as one undo entry), `wfAddTrigger`, `wfRemoveTrigger`,
  `wfDuplicateTrigger`, `wfSetEntry` (heads only), `wfSetGoto`, `wfToggleDisabled` (not on multi-port nodes: "A step with branches
  can't be paused").
- Clipboard: `wfCopy(doc, ids|'one'|'fromHere')` → `{v, biz, at, head, nodes, layout, tplDrafts}` in `localStorage wf.clip.<biz>`
  (15 min; try/catch; memory fallback); `wfRemapIds` mints fresh ids, remaps internal refs, nulls external refs with the toast "Go to
  target cleared: pick it again" (Appendix A, B24); paste refuses unknown/unavailable/hidden/`engine:false` types, other business,
  and missing capacity ("Pasting needs N free steps"); pasted template drafts get new keys.
- `wfApplyPatch(doc, ops)` (atomic; returns `{doc, errors:[{code, path, opIndex}], idMap}`; §6.3). `wfFromV1` = the app copy of
  `upgradeV1` (parity test with the engine). `wfShape`/`wfArmKey` = app copies of `defShape`/`armKey` (shared fixtures).
- Validation: `wfSchemaCheck` (JSON-Schema subset incl. `oneOf`, `const`, `additionalProperties:false`, `x-requireOne`) against the
  **server registry schemas** (`wfLoadRegistry`; `WF_REG` only as an offline fallback; a snapshot `tests/fixtures/wf-registry.json`
  written by tests.ts is deep-compared with `WF_REG` ignoring UI-only keys; Appendix A, B27); `wfValidate` = structural + schema +
  semantic checks with the engine's codes for `scope:"both"` fixtures; server-only checks come from `wfValidateRemote`;
  `wfStandardBlockers` (`trigger_goto`, `delinked`, `entry_not_head`).
- Text: `wfTriggerNarration` (≤3 lines + "+N more"), `wfNodeSummary`, `wfBranchSummary`, `wfNodeAria`, `wfStickyMd`, from the
  registry narration templates (missing catalog key → "(removed)"). Phrase helpers `flowWaitPhrase`, `flowClock`, `flowDaysText`,
  `flowWindowPhrase`, `flowCondPhrase`, `flowValueLabel`, `flowSafe`, `flowCap`, `flowLc` are renamed `wf*`.
- Find: `wfFind`, `wfReplace` (modes "Text", "Tags", "Custom values" with the hint "your {fields}"; replace for Tags and Custom
  values only; templates used only by this workflow are searched/replaced, shared ones are listed "used by N workflows — not changed").

### 5.4 Layout (pure, deterministic, no DOM measurement)
- Fixed sizes from data: action card 290×64; trigger card 330 × (52 + 18 per narration line ≤3 + 22 "+N more" + 36 footer); branch
  header 220×56; END pill 56×24; Advanced tile 72×72 + 36 px label band.
- `wfLayoutStandard(doc, reg)`: tree from `entry` in port order; post-order `subtreeW` (multi-port: Σ column widths + 40 gaps);
  pre-order x; rows 56 px apart; condition card → 24 px stem → bus → rounded drops (r 12) → header cards → per-column "+" and END;
  triggers side by side (gap 24) over the root with the dashed "+ Add new trigger" last; merge elbows r 12; `goto` = dashed stub +
  jump pill "↪ <target>" (click pans). O(n), 200 nodes < 15 ms in Node.
- `wfLayoutAdvanced(doc, layout, reg)` + `wfTidy(doc, reg, onlyIds?)`: clusters (entry cluster first), x = depth × 220, tidy tree on
  y (leaf rows 110 apart), clusters stacked 140 apart, triggers at x = −240 at their target's y (shared targets spread ±90); new nodes
  at parent.x + 220 at the port row with collision nudges. Tidy is one undo entry, FLIP 220 ms (none under reduced motion).
- Edges: Standard `wfPathOrtho(points, 12)`; Advanced cubic béziers with arrowheads, trigger Go-To dashed, backward edges loop
  around; midpoint via `wfBezierAt(0.5)` for the "+"/trash buttons. `wfFit` clamps k to [0.2, 1]; zoom range [0.2, 2]; view per
  workflow in `localStorage wf.view.<biz>.<id>` when the revision is unchanged. Culling: none (200 nodes is within budget; the dead
  `WF_CULL_FROM` path is not built; Appendix A, B51).

### 5.5 Interactions
- Gesture state machine `WF.gesture` (pan, pinch, node, palette, connect, marquee, sticky-move, sticky-resize, minimap,
  drawer-resize): pointer capture, document listeners added on start and removed in ONE cleanup, 4 px tap threshold, Esc/
  pointercancel/blur/visibilitychange cancel and restore transforms, nothing re-renders during a gesture (transforms + incident edge
  `d` only), one commit at the end. Wheel: ctrl/meta zooms around the cursor (`k·exp(−dy·0.0015)`), else pans (`passive:false`).
  Space-hold = hand. Two-pointer pinch; iOS `gesturestart` prevented. Auto-pan within 48 px of edges (≤12 px/frame).
- **Standard**: slots `{src, port}` (`@entry` = trunk). "+" opens the Actions picker; drag from the picker shows ghost + "• Wait"
  placeholder on the hovered slot; "Quick paste" beside each "+" while a clipboard exists. Hover (CSS): blue border, ⋮⋮ handle,
  Disable/Enable and Notes buttons above the top-right corner (Notes stays visible with a count). "⋯" popover "Actions": "Notes >",
  "Copy >" (Copy action / Copy all actions from here), "Paste below", "Move >" (Move action / Move all actions from here → move
  mode, Esc cancels, arrows + Enter choose a slot), "Delete >" (Delete action / Delete all actions from here). Delete on a multi-port
  node → Q4 dialog "Keep which path?" (each port with its step count + "Delete all paths"). Every delete → Undo toast; nodes that
  Go To steps point at warn first ("2 Go to steps point here"). Trigger cards: tinted icon + type label (blue) + user name;
  narration; footer copy ("Copy of <name>"), trash, "Stats". "+ Add new trigger" shows "● New Trigger". If/else: "Condition" card →
  bus → branch headers (purple 3 px underline, fork icon, name, summary; None last); split headers "Path A 50%"; timeout headers
  "Replied"/"Timed out". Disabled nodes greyed with a "Disabled" tag.
- **Advanced**: tiles with labels below; trigger right dot only; multi-port tiles stack one dot per port with tiny labels; every chain
  ends in "[+]". Drag-to-connect (rubber-band bézier; drop on a tile = `wfConnect`; drop on empty canvas = picker, node placed there);
  palette drops on "[+]", on the last tile (append) or on an edge midpoint (insert). Trigger Go-To by dragging from a trigger dot
  (dashed). Edge hover: trash (delink → cluster) and "+". Cluster heads not reached get "Not connected" + `W_DELINKED` (does not
  block publish). Default Path via the branch icon on a head ("(Default Path)" label). Marquee (Select tool or Shift-drag); bulk bar
  "Enable/Disable", "Format selection", "Add sticky note", Copy, Delete. Right-click "Quick actions" (ours: Copy, Paste here,
  Duplicate, Enable/Disable, Set as Default Path, Add sticky note, Notes, Connect to…, Delete, Tidy up; long-press 400 ms on touch).
  Sticky groups: title-band drag moves the tiles fully inside; Alt-drag moves the sticky alone; resize handle; colour menu; double-
  click edits with a markdown-lite toolbar.
- **Pickers** (`wfPickerOpen('trigger'|'action', slot)`): right panel 540 px (expand → 960 px modal), "Add trigger"/"Actions",
  grid icon + "Search triggers"/"Search actions" (autofocus), tabs "Triggers | Apps" / "Actions | Apps" (Apps = Connectors items;
  not connected → greyed "Connect <app> in Settings → Connectors"). Body from the pure `wfPickerRows(reg, kind, q, ctx, recent,
  pins, slotCtx)`: "Recent triggers"/"Recent actions", "Pinned", then categories (separate `triggerOrder`/`actionOrder`, GHL order).
  Rows: 32 px tinted tile + label + badges + ">"; unavailable rows greyed with the reason as a second line (`aria-disabled`; click
  shows the reason), including slot-context reasons ("Only for <trigger>", "Not available for the <trigger> trigger", "Go to must be
  the last step of its path"). Keyboard ↑/↓/Enter/→/Esc. Recent/pins in localStorage (convenience only).
- **Drawer** (`wfDrawerOpen`): right, 40% default (380 px–70%, resizable, persisted, expandable). Header ^/v (reading order), "Learn
  more" (registry help), expand, ×. Identity block (tile, title, one-line description). Body: "Action name" / "WORKFLOW TRIGGER NAME" +
  "CHOOSE A WORKFLOW TRIGGER"; fields generated by `wfFieldsHtml(schema, draft, ctxAt(node))`; trigger "FILTERS" rows + "⊕ Add
  filters". Footer: "Delete" | "Cancel" | "Save action"/"Save trigger" (enabled when dirty). The drawer edits a draft copy: typing
  patches only drawer parts; Save = one undo entry; Cancel/×/^v with changes asks "Discard changes?". While the drawer is dirty, undo/
  redo are refused ("Save or cancel the step first"); if an undo removes the drawer's node, the drawer closes (Appendix A, B44).
  Per kind: If/else ("SCENARIO RECIPE" default "Build Your Own", "BRANCHES" cards with name + counter, ⋮ Duplicate/Delete, drag
  handle, AND/OR rows, "+ Add Segment", "+ Add Branch" (≤10), "Reorder Branches", "None Branch" "When no condition is met");
  Wait ("Selected wait type" + "Change type" → "How do you want to wait?" + greyed "✦ Set up with AI", 8 cards with "Ex:" lines;
  timeout off with steps on it asks "Delete the N steps on the Timeout path?"; number fields' "⋮" Standard/Dynamic greyed "Dynamic
  values come later"; "Advance window" sub-form reuses `autoWindowFieldsHtml`); Split ("Distribution Type: Random Split" read-only,
  2–5 paths, % steppers, "Total 100%"); Goal ("Select type of goal", "If contact reaches this goal without meeting conditions": End
  this workflow / Continue anyway / Wait until the goal is met); Go to ("Go to step" list in reading order + "Pick on canvas").
  Reused widgets (adapted to `{type, config}` and taking `tplDrafts` as a parameter instead of reading `AUTO_ED`): `autoMsgEditorHtml`,
  `autoActionPreviewHtml`, `autoPreviewHtml`, `autoInsField`, `autoTplWords`/`autoTplName`/`autoLibKey`, `autoWhoChipsHtml`,
  `autoTaskFieldsHtml`, `autoWaitFieldsHtml`, `autoWindowFieldsHtml`, `autoCondValues`, `autoCondFits`, `autoValueLabel`. Email/text
  steps accept an inline body or a template (`x-requireOne: ['body','templateKey']`).
- **Left rail**: Notes ⇧C (workflow + step notes from `automation_notes`; disabled "Save the workflow first" / "Save first to add
  notes to a new step"), Errors ⌘⇧E (grouped, "Open step", per-error "How to fix" greyed "Coming with Workflow AI"; empty "No errors
  found. All good."; red count), Stats view ⌘⇧S, Sticky notes ⇧S, Workflow switcher ⇧W (search, recent, "+", "Open in new tab", ⋮
  Duplicate/Delete reusing the list functions; asks first when dirty), Find and replace ⌥F, Version history ⇧V (§4.7), Workflow AI ⇧A
  (greyed "Coming with Workflow AI"; hook `wfAiApply`).
- **Undo/redo**: `wfCommit(label, fn, {coalesce, origin})` snapshots `{doc, layout, builder, settings, name, tplDrafts, sel}` (cap
  100; coalescing within 800 ms for nudges); ⌘Z/⌘⇧Z/⌘Y ignored in text fields; "Recent changes" lists labels with times; resets on
  reload, restore, switching workflow. Notes and publish are not in undo.
- **Save** (`wfSave`, button or ⌘S) → `step:"save"`: Published with errors refused ("Fix the errors first: this workflow is
  published", opens Errors); the response's `shapeChanged`/`armChanged` drive the confirms before the real write (a validate-first
  call): shape → "Start it afresh? N leads waiting will be stopped"; arm → "It only acts on what happens after you save"; guarded
  channel added → "saved as a Draft"; AI-origin commits since base on a Published row → "Workflow AI changes are saved as a Draft.
  Publish when you have checked them." 409 → conflict modal "This workflow was changed by <name> at <time>." with "Load their
  version" / "Save mine as a copy" / "Cancel" (enabled-only changes never conflict because they don't bump revision). New
  workflows are inserted on first Save only.
- **Local draft**: debounced 1.5 s to `localStorage wf.draft.<biz>.<id|new>.<tabSession>` (`{baseRev, name, doc, layout, builder,
  settings, tplDrafts, at}`; skipped > 1 MB; cleared on Save/Discard); on open, newest matching draft offers "Restore / Discard" (or
  "Restore as a copy" when baseRev differs).
- **Leaving**: in-app leaves (← list, switcher, tab change, popstate) → modal "Unsaved changes" Save / Discard / Cancel; popstate
  first `pushState`s back to the builder layer, then asks; `beforeunload` writes the local draft synchronously and shows the native
  prompt only (Appendix A, B17/B49).
- **Publish toggle**: `wfPublishGate()` (errors → "Workflow can't be published yet" + "Review issues"; overlap with an active System
  row; paused range → greyed "Paused until <date> (Global Workflow Settings)"); dirty → "Save and publish". Unpublish immediate.
- **Builder switching** `wfSwitchBuilder(to)`: Standard → Advanced always (missing positions via `wfTidy`, fit, one undo entry);
  Advanced → Standard only when `wfStandardBlockers` is empty, else modal "Remove these first to switch to the Standard builder" with
  "Show" per item; free stickies re-anchored to the nearest node. Draft/Published is independent of the builder.

### 5.6 Keyboard (registry `WF_KEYS`, matched on `e.code`, capture phase, only while open)
- First line of `wfKeydown`: return when `#modal-root`/`#wf-modal` has children, the target is inside them or `#toast-stack`, or a
  builder menu owns focus; every consumed key calls `stopImmediatePropagation()`; the app's own Esc handlers return early under
  `body.wf-open` (Appendix A, B14/B47).
- Bindings (GHL §2.9): ⌘C/⌘X/⌘V; ⌘⇧C/⌘⇧X (from here); Del/Backspace; ⌘Del (all from here); ⌘A; Std ⌘⇧A (all actions), ⌘⌥A (all
  triggers); + / − / 0 / 1 / 2 (Tidy, Advanced); Std ↓/↑ next/previous, ←/→ sibling; Adv →/← next/previous, ↑/↓ sibling;
  Shift+arrows extend; ⌘S; ⇧W ⌥F ⇧C ⌘⇧E ⌘⇧S ⇧S ⇧V ⇧A; ours: Enter (open drawer), Shift+F10/ContextMenu (menu), M (move mode),
  Space-hold (hand), Esc (close top layer / cancel gesture / clear selection), **A** (Action panel) and **T** (Trigger panel) — GHL's
  Tab/Shift+Tab are listed in the K overlay as "GHL: Tab" but native Tab is kept (no keyboard trap; Appendix A, B16). A test asserts
  no duplicate `{code, mods}` per builder and no `Tab` binding.
- `wfNavigate(dir)`: spatial navigation over layout boxes (smallest distance in the 90° cone).

### 5.7 Mobile (≤760 px or coarse pointer < 900 px) — scope per Q3 (default: view + full step editing + add/delete via menus, no
drag and no line-connecting)
- Full screen with safe-area insets; top bar collapses to back, name, ⋯ (Undo, Redo, Recent changes, Builder ▾, Test workflow), Save;
  second bar becomes a scrollable tab strip with the Publish toggle; the rail becomes a "Tools" bottom sheet; drawer and pickers are
  bottom sheets (92dvh); minimap hidden; 40 px targets.
- One finger pans, two pinch; move = the menu's "Move action" (move mode, tap a slot); Advanced on phones opens read-only with "Edit
  steps from the list" (connect needs a larger screen) unless Q3 = full.
- Stage 4: `wfOpen` pushes `{wf:id}`; drawer/picker/rail push `{wfLayer}`; `popstate` closes the top layer first; the edge swipe
  starts only ≤20 px from the left edge.

### 5.8 Accessibility
Canvas = `role="tree"` "Workflow steps"; triggers `role="group"`; nodes `treeitem` with level/setsize/posinset/selected; branch headers
are treeitems whose children are their columns; Advanced clusters are top-level treeitems ("Group 2 (Default Path)"). Roving
tabindex (one Tab stop); edges `aria-hidden`. `aria-label` per node ("Step 4 of 12: Send email … Next: Wait 1 day. 1 note.
Disabled."), verdicts and counts appended in path/test/stats modes (text tags, never colour only). `#wf-live` polite announcements.
Drawer focuses its first field and returns focus; pickers focus search; menus `role="menu"`. Drag alternatives: menu Move + keyboard
move mode, "Connect to…" list, zoom buttons (WCAG 2.5.7). Targets ≥24 px (40 px invisible hit areas on coarse pointers).
`prefers-reduced-motion` disables FLIP/fit/zoom animations.

### 5.9 Performance budget (asserted in the browser check)
Open a 200-node fixture < 150 ms (layout + first paint); pan/zoom 0 layout work, < 4 ms per frame; node drag < 4 ms per frame;
selection change patches only changed elements; idle `__wfp = 0` and `__rc = 0` over 3 s; hovering across 50 cards → `__wfp`
unchanged; no long task > 50 ms during scripted pan/zoom/drag.

### 5.10 Theme tokens
Add `--wf-*` tokens (canvas, grid, edge, edge-hi, sel, sel-soft, add, category tones, path ok/fail/skip/wait, stats, ro, sticky
colours) to the three token blocks (light, `prefers-color-scheme: dark` under `:root:not([data-theme="light"])`, `[data-theme="dark"]`);
no hex outside them. Category tones per GHL: Contact, Payments, Opportunity, Appointments/Jobs = blue; Communication = green;
Internal/logic = purple; AI = purple-pink; Send data = grey. Tile tint `color-mix(in srgb, var(--tone) 14%, var(--surface))`. Chrome
buttons keep the brand `--primary`; only canvas accents copy GHL blue. A test checks every token exists in all three blocks and the
contrast pairs (≥4.5:1 text, ≥3:1 glyphs/borders).

### 5.11 Edge cases (each has a test or a browser step)
Unknown kind/type (newer app or removed type): grey "Unknown step" card, not movable/editable/pasteable, kept byte for byte, publish
blocked only if reachable. A type becomes unavailable: warning badge with the reason (customer channel = Error). Go To target
deleted → "Pick a step to go to"; a trigger goto to a deleted node resets to Default Path with an undoable toast. Deleting `entry` →
its insert-port child or null. Empty workflow: Save allowed (Draft), Publish blocked (`E_NO_TRIGGER`/`E_NO_ACTION`, or the 0-trigger
warning). Read-only modes refuse mutators with the reason; pan/zoom/select/find/copy still work. Two editors: revision conflict +
presence avatars; notes append-safe. Long/Hebrew names: `dir="auto"`, 2-line clamp, full text in title/aria. Removed catalog values
→ "(removed)" + warning. Hidden types already used: editable with `W_HIDDEN_TYPE`, hidden only in pickers/paste. Unmigrated rows
(phase 3 before migrate is impossible by order; defensive): `wfFromV1` fallback.

---------------------------------------------------------------------------------------------------------------------------

## 6. AI-readiness (the contract stage 7 "Workflow AI" targets)

### 6.1 Schema
- `step:"schema"` returns a JSON Schema (draft 2020-12) **generated from the registries** for this business:
  - `Doc` with `additionalProperties:false` everywhere; `Node` = `oneOf` discriminated by `kind`+`type` (`const`), each `config` from
    the entry's `fields`; `Rule` = `oneOf` discriminated by `op` with the OPS `args`; `Trigger.filters.rules[].field` limited per
    trigger type; `x-source` lists resolved into `enum` + `x-enumLabels` (stages, services, sources, tags, templates, people,
    workflows) in a separate small `$defs/business` block so the static part stays prompt-cacheable;
  - `settings` (§2.6) is included; `x-requireOne: ['body','templateKey']` on message actions (also as `anyOf` of `required`);
  - **unavailable items and legacy-only constructs are omitted** from the generation branch: unavailable types, `if_else.config.gate`,
    `reentry:"legacy_always"`, `timezone:"contact"`; Advanced-only constructs (`trigger.goto`, delinked clusters, a non-head entry)
    only when `builder = advanced`;
  - `$defs/existingOnly`: unavailable types that already exist in the stored doc are accepted only when the same id with the same
    type is in the stored definition (so "edit a migrated SMS workflow" round-trips; Appendix A, E50).
- The export compiles as an Anthropic tool `input_schema` (test).

### 6.2 Validator (one implementation of each check; codes are stable strings)
- `validateStructure(doc)` (fatal at run time): `E_SCHEMA` (path), `E_DUP_ID`, `E_BAD_ID`, `E_PORTS` (out keys ≠ ports),
  `E_EDGE_TWO_PARENTS`, `E_CYCLE` (edge cycle), `E_ENTRY_NOT_HEAD`, `E_GOTO_TARGET`, `E_GOTO_NOT_LAST`, `E_SPLIT_PCT`,
  `E_MAX_NODES`, `E_TOO_BIG`, `E_UNKNOWN_TYPE`, `E_DISABLED_BRANCHING`, `E_LOCKED`.
- `validateAvailability(doc, availCtx)` (blocks publish and AI output; at run time the step only skips): `E_UNAVAILABLE`
  (with the reason), `E_ADVANCED_ONLY` (in Standard).
- Semantic: `E_NO_TRIGGER` (warning variant when 0 triggers), `E_NO_ACTION`, `E_LOOP_NO_WAIT`, `W_LOOP_CUSTOMER`,
  `E_FIELD_NOT_FOR_ALL_TRIGGERS`, `E_MERGE_FIELD` (unknown blank) / `W_MERGE_FIELD` (blank empty for some trigger),
  `E_CUSTOMER_NO_CONTACT`, `rule_value_missing`, `rule_value_type`, `E_TEMPLATE_MISSING`, `E_WEBHOOK_URL`, `E_SECRET_HEADER`,
  `W_REPLY_NO_SEND`, `W_DELINKED`, `W_LAST_NOT_ACTION`, `W_HIDDEN_TYPE`, `W_GATE_MOVED`, `W_SENDS_OUTSIDE`,
  `W_MONEY_TO_NON_OWNER` (a team/external action whose recipients include a non-owner role and whose text uses a `money`/`private`
  merge field — phase-4 "stays a WARNING"; Appendix A, E57), `W_CUSTOMER_IN_CONTACTLESS`.
- Issue shape: `{code, severity:'error'|'warning', path (JSON pointer), nodeId?, triggerId?, text}`.
- Parity: one fixture file `supabase/functions/automations/fixtures/workflows.json` (≥60 cases, each with `scope:"both"|"server"`)
  run by `tests.ts` and `tests/business-logic.test.js` with identical expected codes for `both`.

### 6.3 Edit contract (patches) and AI rules
- `wfApplyPatch(doc, ops)` exists in the app and the engine (shared fixtures). Ops: `addTrigger{trigger}`, `setTrigger{id, patch}`,
  `removeTrigger{id}`, `addNode{node, slot}`, `setNode{id, patch, dropPorts?}`, `removeNode{id, mode:'one'|'fromHere', keepPort?}`
  (`E_KEEP_PORT` when missing for multi-port `one`), `moveNode{id, slot, mode}`, `connect{from, port, to}`, `disconnect{from, port}`,
  `setEntry{id}`, `setSettings{patch}`, `rename{name}`. Atomic: any error → doc unchanged + errors with `opIndex`. Temp ids `"$1"`
  resolve to minted ids and come back as `idMap`; AI-supplied ids are always remapped.
- `step:"validate"` with `base_revision` returns `{shapeChanged, idsRemoved[], waitingRunsAffected}`; the AI prompt requires keeping
  ids of unchanged steps; a proposal that removes > 30% of existing ids with waiting runs needs the user's explicit confirm.
- Output is ALWAYS a Draft: AI saves go through `step:"save"` with `ai_edited:true` → enabled=false (DB guard + function), reason
  `ai`, one undo entry "Workflow AI: <summary>", purple halo on changed nodes until the next commit. Positions are never generated
  (auto layout).
- "Describe this workflow" is deterministic from the registry narration templates; AI only polishes.
- Prompt material: the static registry export + `canonical-1` (valid) + three negative fixtures with their codes for the repair
  loop; catalog enums from `$defs/business`.

### 6.4 Other AI-readable shapes (each with a pure validator in app + engine and parity tests)
`WfItem` (list row; gate `null|'golive'|'phone'`, paused `{until}|null`), list filter (`valueType` per field), pause range, error
notify, workflow settings, template (`{key, name, category, description, definition, settings}` validated by `validateStructure`),
test request/response (§3.14), enroll/unenroll/record_runs. Ids for these are server-assigned when missing.

---------------------------------------------------------------------------------------------------------------------------

## 7. BUILD PLAN

Seven phases, each = one workflow run with full review (re-read 3× + manager review), `check_all.sh` ALL GREEN, the MASTER §4
real-browser check where the app changes, and a live deploy (SQL with backup + ROLLBACK, staging first; function via dashboard
editor + fingerprint; app via branch → live-origin check → fast-forward main). Groups inside a phase touch disjoint code (separate
file sections or files) and are built in parallel, then merged and reviewed together. **Total ≈ 15 h.**

Shared conventions for every group: tests first for pure logic; fixtures in `supabase/functions/automations/fixtures/*.json` read by
both test suites; new app functions named `wf*` and added to DECLS; every SQL change in `.claude/sql/stage2-automations.sql` (parts)
with check-before/after and ROLLBACK; log each deploy in MASTER §13.

### Phase 1 — Engine v2 core, compat cutover (2.5 h)
Live result: SQL Part 1 applied; v2 function deployed in compat mode; existing automations behave identically (differential gate).
- **G1.1 Doc + registries + validator (pure)** — `index.ts` sections REGISTRY, DOC, VALIDATE, CONDITIONS. Types; canonical key table;
  TRIGGERS/ACTIONS/FIELDS/OPS/MERGE_FIELDS/REASONS/WAIT/GOAL registries with `ghl`, `label`, `available`, fields; export DTO +
  `jsonSchema()`; `validateStructure`/`validateAvailability`/semantic checks; `upgradeV1`; `defShape`/`armKey` (canonical JSON);
  `compile` (ports, parents, refs, downstreamGoals, reachingTriggers); `evalCondition` + extended `applyOp`; `wfApplyPatch` (engine
  copy). Tests: fixtures `workflows.json` (≥60), `shape.json` (≥14), `upgrade.json` (every phase-4 shape incl. window modes, outside
  variants, 12 ifs in a row, all four actions, three trigger params), OPS × value types, registry GHL-label fixture copied from the
  account scan. Accept: all codes produced; `defShape(upgradeV1(x))` stable; schema validates every valid fixture and rejects every
  invalid one.
- **G1.2 Executor + waits + dry-run core** — sections EXECUTOR, WAITS. `advanceV2` with `Fx` (`realFx`, `simFx`), `planDeferTree`,
  `period`/`recurring` (window + times)/`date`/`scheduled` waits, legacy cursor, step counters, holds/watch/heartbeat, log row
  fields; `claimLog`/`claimCustomer` with `loop`/`row_kind`. Tests: the whole phase-4 suite re-pointed at v1 inputs through
  `upgradeV1` + `advanceV2` (customer guard, cap, deferrals, NO_CARD, too-late, settle, undo, armed_at, version cancel, reconcile);
  `planDeferTree` = `planDefer` parity table; DST (Sydney Apr/Oct) for period+resume; recurring next-5; `simFx` path = `realFx` path on
  the same fixture with a clock stub; the fake DB byte-identical after a dry run; `fetch` never called.
- **G1.3 SQL Part 1 + fake DB** — `.claude/sql/stage2-automations.sql` Part 1 (tables, columns, constraint swap + `_v2` + wrapper in
  one transaction, capture triggers silent, RPCs `automation_enroll`, `claim_events`, `apply`, `wake`, `stop_on_reply`, `prune`,
  read RPCs, RLS, indexes); `tests.ts` fake DB: new UNIQUE keys and partial indexes. SQL checks on staging: phase-4 RPC still claims
  once; capture trigger with a forced exception never blocks a contacts UPDATE; RLS as VA/technician reads nothing; column
  privileges. Backup `.claude/backups/automation-schema.before_stage2.sql`.
- **G1.4 Compat deploy + differential gate** — compat switch in `tick` (phase-4 scanners + `enqueue` → runs executed by
  `advanceV2`); prepare and commit the `automations-phase4-compat` rollback build; run the differential (§8.3) on staging and a
  read-only shadow on live; deploy; watch two hours of live ticks (log rows, sends, cap) against the phase-4 baseline.
- Hours: G1.1 0.8, G1.2 0.8, G1.3 0.5, G1.4 0.4.

### Phase 2 — Event store, new nodes and actions, save/publish API, migration (2.5 h)
Live result: v2 engine full; SQL Part 2; all rows migrated; the old editor reads/writes through the adapter.
- **G2.1 Events + matcher** — sections EVENTS. `automation_events` producer (scan watermarks, time scanners in narrow windows,
  scheduler catch-up), capture-type wiring (`wanted`), settle (`available_at`), matcher with time guard, bulk trigger-log + daily
  aggregate + unmatched cap, enrolment via RPC, `event` step (capture types claim pending events), wake, stop-on-reply.
  Tests: matcher reasons; one log row per (workflow, trigger, event); app poke + capture = one run; settle (t+10 s not matched,
  t+31 s matched); 2,500 stale leads give each event once; second scan of the same minute inserts 0; concurrent enrol → one run
  (fake DB) + staging PostgREST `Promise.all` check.
- **G2.2 Logic nodes + settings** — sections EXECUTOR/WAITS. If/else, Split (sticky ledger), Goal (+ wake), Go to (visit caps),
  Add/Remove workflow, `reply`/`user_reply`/`conditions` waits, Stop on response, time window, pauses, re-entry ledger + perRecord
  lock, `markRead`. Tests: §8.1 items 14–17.
- **G2.3 Record actions + hooks + webhook** — sections ACTIONS, HOOKS. `automation_apply` ops (stage event inserted inside apply
  with the scanner key), atomic `contact_tags_edit`/`contact_note_add` RPCs **and the app switch of tag/note edits to them**
  (index.html: the lead card's tag and note writers — grep `contactPatchToRow`), all new actions, inbound hook (draft sample, header/
  path token, throttle, normalisation), outgoing webhook (SSRF, external audience), custom values. Tests: apply ops emit the same
  events as the app's equivalent writes, each with the cause; self-trigger impossible; chain stops at 3; SSRF refusals; payload
  50×500 stored truncated; 404/429.
- **G2.4 API, guards, migration, app adapter** — sections API, HOUSEKEEPING; SQL Part 2; index.html adapter: the old editor opens
  `wfToFlat(definition)` (straight chains) and saves through `step:"save"` (`wfFromFlat`), the toggle uses `step:"publish"`, the
  app's emit check reads `automation_wanted` (`autoSyncEvents` removed). Steps `save`, `publish`, `duplicate`, `validate`, `schema`,
  `registry` (v2 DTO), `migrate`, `restore`, `copy_version`; snapshots; templates seeding; Needs-review sweep; housekeeping with
  cursor. Tests: SQL test 24 cases (§8.2), wfToFlat/wfFromFlat round-trip, migrate idempotent, rollback block lists edited rows.
  Live order: backup definitions → deploy → Part 2 → `migrate` → app adapter push → verify.
- Hours: G2.1 0.7, G2.2 0.7, G2.3 0.6, G2.4 0.5.

### Phase 3 — Automation page, Global Workflow Settings, System rows, lock direct writes (2 h)
Live result: one Automation page (cards default + table), Notifications page and old list removed; SQL Part 3.
- **G3.1 List** — index.html: page shell + nav merge + deep links; `WF_UI`, `wfEnsure`; cards/table, folders, tabs (All, Needs
  review, Deleted), search, breadcrumb, paging, ⋮ menu, toggle via `wfSetPublished`, duplicate/delete/move, bulk (`wfBulkPlan`),
  list stats. Pure tests: `wfItem`, `wfStatusOf`, `wfSortPage`, `wfBulkPlan`, `wfFolderCanMove`, `wfLink`/START_LINK parser,
  escaping of every rendered string.
- **G3.2 Global settings + Message templates tab** — Notifications card, Pause workflow (table + `wfPauseProblems`), Default
  builder, Workflow AI (greyed), Customer message safety (moved), greyed Auto save; templates tab links. App copies of `bizToUtc`,
  `cleanEmail`, `signatureOf` + parity tests; `pauseOccurrences`/`pauseUntil` parity. SQL tests: pause trigger (overlap, 15 rows,
  15 days, deleted ids, annual across New Year, Feb 29).
- **G3.3 System rows + templates + notifications merge** — `wfSystemRows` (parity with `autoReadyRows`), virtual cards with legacy
  controls, `wfSystemHidePlan`, template library on `automation_templates`, phone bar condition, interim fallbacks (no canvas yet:
  `flowSentence`; branching templates greyed "Opens in the new builder (phase 4)"; "Go to action" greyed). Advanced filters + smart
  lists last (optional).
- **G3.4 SQL Part 3 + RLS proof** — revoke/grant, drop delete policy, check-after queries, read-only test additions. Applied only
  after the G3.1 build is live (old cached tabs get the clear "reload" error).
- Hours: G3.1 0.8, G3.2 0.4, G3.3 0.5, G3.4 0.3.

### Phase 4 — Standard builder (3.5 h)
Live result: the new builder replaces the old editor for every engine workflow (old editor still reachable only for rollback, removed
in phase 7).
- **G4.1 Model + layout + text (pure)** — all §5.3 functions, `wfLayoutStandard`, edges, fit, narration, find/replace, picker rows,
  key registry. Tests: mutators, seeded random op sequences (500 ops × 20 seeds: ≤1 parent, no edge cycles, ports = out keys, ids
  unique, entry a head, nothing lost unless deleted), clipboard, layout determinism/no overlaps/< 15 ms, narration strings, keys.
- **G4.2 Shell + paint + canvas + gestures** — `#wf-root`, chrome, paint scheduler, sync of nodes/edges, view, minimap, LOD,
  gestures, keyboard, a11y tree, mobile shell, tokens. Browser: idle `__wfp=0`, performance budget, mobile 375×812 and 768 px.
- **G4.3 Pickers + drawer + forms** — pickers with greyed reasons and slot context, drawer with draft/cancel, per-kind forms, reused
  widgets refactored to take `tplDrafts`, trigger filters UI, wait chooser, If/else branches, split, goal, go to.
- **G4.4 Rail + save + undo** — Notes (`automation_notes`), Errors (+ remote validate), Find and replace, Workflow switcher,
  Sticky notes (Standard anchoring), undo/redo/Recent changes, Save/conflict/local draft/leave guards, Publish gate, System
  read-only mode, open from the list. Builder harness (`.claude/builder-harness/`, `fake-sb.js` extended: revision 409 semantics,
  RPC/function stubs for registry/validate/save/publish/test) runs the full write-path click-through.
- Hours: G4.1 1.0, G4.2 1.0, G4.3 0.8, G4.4 0.7.

### Phase 5 — Advanced builder (1.75 h)
- **G5.1 Advanced layout (pure)** — `wfLayoutAdvanced`, `wfTidy`, béziers, reachability `viaRefs`, `wfStandardBlockers`. Tests:
  parent x < child x after Tidy, deterministic, no overlaps.
- **G5.2 Tiles + connect + clusters + stickies** — tiles, dots, drag-to-connect, palette drops on "[+]"/last tile/edge, trigger
  Go-To, delink, Default Path, marquee, bulk bar, Quick actions, sticky groups, Connect mode (accessible alternative).
- **G5.3 Switching + default builder** — `wfSwitchBuilder`, blockers modal, sticky re-anchoring, Global "Default builder" Advanced
  radio enabled, browser click-through both ways.
- Hours: G5.1 0.5, G5.2 0.9, G5.3 0.35.

### Phase 6 — History, logs, path, stats, versions, test, manual add (2 h)
- **G6.1 Engine steps** — `test` complete (assume, trigger unmatched, guard verdicts, `readOnlySb`), `enroll`/`unenroll`/
  `record_runs` (+ enrollable list), stats RPC final shapes, error digest (push). Tests: zero writes; every `would` kind; role matrix
  per Q2; re-entry; double click = one run; `wrong_kind`; `busy`.
- **G6.2 Settings tab + Enrollment history + Execution logs + details** — index.html, keyset paging, `wfRecordSearchFilter`, status
  registries, View details drawer, Mark as reviewed.
- **G6.3 Canvas modes** — See contact path (`wfPathFromLog`), Stats view + "Stats: <trigger>" modal, Version history panel + view
  mode + Restore/Copy, Test workflow panel + synthetic rows. Tests: `wfPathFromLog` (straight, if/none, split, go-to loop, waiting,
  failed, missing, older version); test→rows mapping; real run vs test of the same fixture give equal paths.
- **G6.4 Lead card block** — `#lm-workflows` from cache, picker, add/remove, activity lines.
- Hours: G6.1 0.6, G6.2 0.5, G6.3 0.6, G6.4 0.3.

### Phase 7 — Cleanup and first System moves (0.75 h)
- **G7.1 Remove old code** — flow view (`FLOW_*`, `flow*`), old editor (`openAutoEditor` … `autoEd*`, `autoTry*`), `AUTO_TRIGGERS`/
  `AUTO_CONDS`/`AUTO_ACTIONS`/`AUTO_FIELDS`/`AUTO_WAIT_UNITS`/`AUTO_MIRROR_TRIGGERS`, `loadAutoRunCounts`, shims, `.flow*`/
  `.auto-ed*` CSS, engine `preview` alias, `enqueue`, `audienceOf`, compat switch; DECLS updated. Plan (not yet run) the drop of
  `trigger`/`steps` 30 days after migrate.
- **G7.2 System moves (team)** — `WF_SYSTEM` parity tests per base; legacy-function changes (push skip by handover; one base per
  release); flip `movable` for `team:newLead` first, then the others as their parity passes. Customer bases stay virtual until Ofek's
  OK.
- Hours: G7.1 0.4, G7.2 0.35.

Totals: 2.5 + 2.5 + 2 + 3.5 + 1.75 + 2 + 0.75 = **15 h**.

---------------------------------------------------------------------------------------------------------------------------

## 8. Test strategy and differential plan

### 8.1 Engine (deno `tests.ts`, fake DB)
1. Validator fixtures (both test suites, identical codes for `scope:"both"`).
2. `upgradeV1` for every phase-4 shape; ids preserved; 12 ifs migrate and validate; `outside:'skip'` → `recurring/window end` ends
   `skipped` with the phase-4 reason.
3. `defShape`/`armKey` fixtures (incl. key reordering, disabled toggle = same shape, goto retarget = new shape, branch reorder = new
   shape, filter edit = same shape / new arm key); same fixtures in the SQL check-after.
4. `compile`, `goalAhead` (incl. goals inside later branches), `planDeferTree` parity with `planDefer`.
5. Waits: period+resume across DST; date `ifPassed` (all four); recurring weekly/monthly nth/last/yearly Feb 29; scheduled before/
   after a date-only job date; window (phase-4 tests unchanged); reply met vs timeout (woken by an event within one tick); reply that
   lands while leased; conditions with heartbeat; a 7-day conditions wait finishes with `steps_done` < 20.
6. `evalCondition`/`applyOp`: every op × value type, `ref`, gate pull-out, OR/AND segments.
7. Split: 10k keys within ±2% of 50/50; two consecutive splits independent (≈25% per leaf); stickiness after a % edit; 0% never.
8. Registry: every entry has `ghl`, `label`, a reason when greyed; GHL labels equal the scan fixture; schema validates valid fixtures,
   omits unavailable, compiles as a tool input schema; guarded-type list = SQL `automation_action_audience` (file-text parity).
9. Merge: dotted keys, `{custom.x}`, `{trigger.x}` escaped in emails, unknown blanks block sending.
10. `normWfSettings`/`wfSettingsProblems`: defaults, clamps, availability, `legacy_always` only when already set.
11. Matcher (G2.1 list). 12. Enrolment: re-entry off/after_exit/legacy; `alwaysReenter`; perRecord; ledger survives pruning;
    version-bump cancel deletes keys so the lead re-enters at once; concurrent enrol → one run.
13. **Phase-4 regression** (the whole existing suite through `upgradeV1` + `advanceV2`).
14. Tree executor: if/else first match + None; gate None → skipped; goal jump during a period wait within one tick; goal ifNotMet
    end/continue/wait; goto visit cap; weekly loop runs 20 times; tight loop fails at 10; per-advance budget yields; disabled skipped;
    delinked cluster reachable only via trigger goto; a migrated `text` step still logs `waiting_phone` (availability never fails a run).
15. Stop on response (reply after first send stops; before does not). 16. Time window applies to all actions; customer action waits
    for window ∩ customer hours; pause holds actions not waits; pause wake only for affected ids.
17. Add/remove workflow: chain limit, self-cycle, parent run, every remove scope + a concurrent running run (`remove_requested`).
18. Engine writes: each apply op = the app's equivalent events with the cause; stage workflow never re-enrols itself through the
    scanner path; chain stops at 3.
19. Idempotency: crash after the claim never sends twice; goto loops create distinct `loop` claims; a `step` row never blocks a claim.
20. Dry run: `simFx` vs `realFx` same path; zero writes; `SimulationWriteError` surfaces as `ok:false`.
21. Hook (404, 429, normalisation, matching, contactless, draft sample). 22. Webhook out (SSRF, timeout, nothing logged).
23. Housekeeping: version retention (≤10 or ≤30 d, cap 50, hash skip), event/trigger-log pruning, a 20k backlog drains over ticks
    under the 1,000-row cap; trigger-log rows bounded on a 10k-event fixture.

### 8.2 SQL (check-after blocks in transactions with rollback, staging first)
24. Guards: insert → Draft always; adding a guarded channel (customer or webhook, incl. a disabled or delinked node) to a Published
    row → Draft; shape change → version+1, armed_at moved, waiting runs cancelled + `exit` rows + keys deleted; filter-only change while
    Published → armed_at moved, version unchanged; wording change → neither; migration GUC keeps version; legacy write on an upgraded
    row refused; soft delete → Draft; client INSERT with enabled=true → Draft; after Part 3 a client update of `enabled`/`definition`
    fails and DELETE affects 0 rows; origin/revision/published_* pinned.
25. `automation_enroll` outcomes (enrolled, already_enrolled, reentry_off, duplicate_event) + lock cleared on finish; capture
    triggers: write only when wanted, stamp the cause, never block a save (forced exception), DELETE on opt-outs, INSERT with tags.
26. RLS as VA/technician/manager/owner (`set local role authenticated` + jwt claims); hook secrets unreadable;
    `has_column_privilege(...,'enabled','UPDATE') = false`; a second business's rows untouched by every RPC.
27. Stats RPCs equal hand counts on seeded rows; `automation_list_stats` returns one object; folder guard (cycle, 6th level, subtree
    height); pause trigger rules; `system_claims`/handover scenarios.

### 8.3 Differential plan — existing automations behave identically after migration
1. **Fixture differential (CI)**: a recorded corpus of every live automation definition (backup in phase 1) × synthetic event
   scenarios (in hours / outside hours / opted out / test record / capped / stage undone within 30 s / NO_CARD / late) is run through
   (a) the phase-4 `advance` + `enqueue` (vendored copy `tests/phase4-reference.ts`) and (b) `upgradeV1` + matcher + `advanceV2`. The
   comparison covers: action log rows (`row_kind='action'`: step id, channel, status, reason, recipient), run end status and reason,
   every `due_at`, sent message text. Must be identical (step/enroll/exit rows ignored).
2. **Shadow on live (read-only)** before the compat deploy: for each live automation and its last 20 matching records, phase-4
   `preview` (deployed) vs v2 `test` (staging function pointed read-only at a live snapshot copy, or local deno against a JSON export)
   — verdicts must match.
3. **Post-deploy watch**: for 2 hours after each engine deploy, compare per-automation counts of claimed actions, skipped reasons and
   cap usage with the same hours of the previous days; any new reason class or a difference > 0 in sends for an unchanged workflow
   triggers the rollback build.
4. **Migration check**: after `migrate`, for every row: `defShape(definition)` equals `defShape(upgradeV1(trigger, steps))`,
   `version`/`armed_at`/`enabled`/`audience` unchanged, waiting runs untouched (count before = after), and the next tick produces no
   new runs for events older than the migration.
5. **Event-key pin**: the five phase-4 trigger key formats and the apply-written stage key are asserted byte for byte against
   recorded live examples.

### 8.4 App
- `tests/business-logic.test.js`: every pure `wf*` function (model, clipboard, patch, validation codes, shape/arm parity, layout,
  narration, find/replace, pickers, keys, list functions, filters, bulk plan, pause functions, settings validator, status registries,
  `wfPathFromLog`, test→rows mapping, record search filter, START_LINK parser, `wfSystemRows` parity, cache-key stability: two
  renders with no user action give identical `wfEnsure` keys), escaping of every rendered name/reason/detail.
- `tests/read-only.test.js`: every new select/RPC on staging returns without error within row caps; `READ_ONLY_CALLS` static scan.
- Builder harness (`.claude/builder-harness/`, `fake-sb.js` extended) for every write path: save, 409 conflict, publish gate,
  overlap, restore, notes, template drafts, AI-origin save as Draft.
- Live-origin browser check (MASTER §4) per app phase: all 13 nav pages + every settings page incl. Automation tabs and sub-tabs,
  the builder (empty, migrated, System, 50/200-node fixtures via document.write with fixture data in presentation mode), Stats view,
  Enrollment history, Execution logs, Version view, Test workflow (read-only allow-list), the lead card block; idle `__rc = 0`,
  `__wfp = 0`, `__wfPaintReentry = 0`; no errors; keyboard-only pass; mobile 375×812 and 768 px; dark and light; reduced motion; old
  `?page=notifications`/`?page=templates` links land on Automation; presentation mode reset to '0'.

---------------------------------------------------------------------------------------------------------------------------

## 9. Open questions for Ofek (only truly missing decisions; each has a default that the build follows if unanswered) + risks

### 9.1 Open questions (Hebrew, for Ofek)
- **Q1 — מיקום עמוד "Automation":** (א) בתוך הגדרות, במקום שני העמודים של היום, ובונה התהליכים נפתח על כל רוחב המסך (מומלץ; ברירת
  מחדל) (ב) פריט נפרד בתפריט הראשי, כמו ב-GHL (ג) גם וגם: בהגדרות ועוד קיצור בתפריט לבעלים ולמנהלים.
- **Q2 — מי יכול להוסיף ליד לתהליך ביד מכרטיס הליד:** (א) רק בעלים ומנהלים (מומלץ; ברירת מחדל) (ב) גם עוזר המשרד עם גישה ל-CRM
  (ג) עוזר המשרד רק לתהליכים שלא שולחים כלום ללקוח.
- **Q3 — בונה התהליכים בטלפון:** (א) הכול כמו במחשב (ב) צפייה, עריכת כל צעד, הוספה ומחיקה דרך התפריט, בלי גרירה ובלי חיבור קווים
  (מומלץ; ברירת מחדל) (ג) צפייה בלבד.
- **Q4 — מחיקת צעד If/else או Split שיש מתחתיו צעדים בכמה ענפים:** (א) לשאול איזה ענף להשאיר, השאר נמחקים (מומלץ; ברירת מחדל)
  (ב) למחוק תמיד את כל הענפים, עם Undo (ג) לא לאפשר עד שהענפים ריקים.
- **Q5 — מתי נחשב "הצעת מחיר נשלחה" (טריגר Quote status):** (א) כשממלאים לראשונה את הסכום המשוער בכרטיס (מומלץ; ברירת מחדל)
  (ב) כשהליד עובר לשלב Quoted — ואז אין צורך בטריגר נפרד (ג) שניהם.
- **Q6 — "Assign to user":** (א) להוסיף עכשיו שדה "אחראי" בכרטיס הליד (מומלץ) (ב) להשאיר את הפעולה באפור עם הסבר (ברירת מחדל עד
  תשובה).
- **Q7 — התראות על שגיאות בתהליכים:** (א) להתחיל בהתראה לטלפון, פעם ביום לכל היותר, למי שתבחר; מייל יתווסף אחרי שנבדוק שתיבת
  info@ יודעת לשלוח מיילים לצוות (מומלץ; ברירת מחדל) (ב) לחכות עם הפיצ'ר עד שיהיה גם מייל.

### 9.2 Risks (with mitigations)
1. **Capture triggers on hot tables** (contacts, tasks, lead_messages, jobs, suppliers) run on every app save. Mitigation:
   exception-swallowing body with a nested handler, early exit when nothing is wanted, static column compares, forced-exception SQL
   test, `capture_errors` read by the nightly data check.
2. **Event-key drift** would re-fire phase-4 customer automations after cutover. Mitigation: scanners reused unchanged, keys pinned
   against recorded live examples, the apply-written stage key pinned JS↔SQL, the differential gate.
3. **Constraint swap in Part 1** must be one transaction with the wrapper; otherwise the phase-4 claim RPC fails. Mitigation: staging
   rehearsal, check-after "phase-4 claim still claims once", exact ROLLBACK.
4. **Rollback after v2 edits**: phase 4 would run stale words. Mitigation: the rollback build + ROLLBACK block disables and lists every
   row created or edited in v2.
5. **Single-file engine grows to ~5,000 lines**: heavier dashboard deploys, easier partial pastes. Mitigation: mandatory
   fingerprint + length check; section markers; groups merge before deploy.
6. **index.html grows by ~6–8k lines** before phase 7 removes ~2.5k; parse time and maintainability. Mitigation: phase 7 deletion is
   mandatory; performance budget asserted.
7. **Free-plan load** (rechecks, trigger log, events). Mitigation: event-driven wakes, 60-min heartbeats claimed last, daily aggregates
   + capped details, watermarks, narrow time scanners, budgeted housekeeping, Needs-review notice when due runs > 100.
8. **System handover** gaps or doubles. Mitigation: handover at Publish, per-base overlap ≥ the legacy delay, backdated `armed_at` for
   team bases, shared exact claims, per-base parity tests, customer bases only with Ofek's OK.
9. **Behaviour that differs from GHL on purpose** (a shape edit on a Published workflow cancels waiting runs; Pause holds instead of
   drafting; Restore only in Draft; migrated workflows keep "legacy_always" re-entry). Mitigation: confirms with waiting counts, help
   texts, a list in the end-of-stage summary.
10. **Unverified contracts** to check at build: `contacts.tags` type, `payroll_weeks` invoice columns, `review_requests` insert
    contract, chat widget showing auto rows, `lead_messages` author field and inbound email rows, `Deno.resolveDns` availability, the
    app's tag/note writers. Each is a first task of its group; a failing one greys its item with a reason instead of blocking.
11. **Staging has no functions**: deploy `automations` there with fake secrets in phase 1; live checks of Stats/Test rely on the
    read-only allow-list.
12. **Touch gestures on real phones** (pan vs long-press vs Stage-4 back swipe vs Safari zoom) need a real iPhone check; mobile scope
    reduced by Q3's default.
13. **Old cached app tabs** after Part 2/3 get refusals. Mitigation: clear "reload the app" messages; Part 3 only after the new app
    has been live.

---------------------------------------------------------------------------------------------------------------------------

## Appendix A — Critique ledger (every critique of the three area designs and what this design does)

"Applied" = the fix is in the body (section given). "Changed" = resolved differently from the suggested fix, with the reason.
"Dup" = same issue as an earlier entry.

### A.1 engine-data critiques (E1–E64, in the order received)
| # | issue (short) | outcome |
|---|---|---|
| E1 | capture handler updates a missing `capture_errors` column → blocks app saves | Applied: column added in Part 1, nested handler, tags type verified (§2.9) |
| E2 | `automation_log_once` dropped too late; phase-4 claim body ignores row_kind/loop | Applied: swap + `_v2` + wrapper in Part 1 in one transaction (§2.9) |
| E3 | edits to Published rows and client INSERTs skip validation; AI edits go live | Changed (stronger): every content write goes through `step:"save"`; INSERT always Draft; AI → Draft (§3.13, §2.9 Part 2/3) |
| E4 | column-level REVOKE ineffective | Applied: table revoke + column grants; hook secrets in a separate no-policy table (§2.9) |
| E5 | snapshot trigger runs as the user | Changed: snapshots are written by the function (service role), no snapshot trigger (§2.9 Part 2.4) |
| E6 | stale `active_lock` blocks re-enrolment; inflated active counts | Applied: eager cancel in a security-definer AFTER trigger + key deletion (§2.9 Part 2.3) |
| E7 | goal jumps only when the run advances | Applied: downstream goals' wakeOn in every hold's watch (§3.5) |
| E8 | polling waits starve the 25-run claim | Applied: event-driven wakes, 60-min heartbeats claimed last, ≤10 rechecks per tick (§3.2, §3.5) |
| E9 | matcher has no time budget | Applied: 20 s guard, bulk log, batch prefetch, release unprocessed (§3.2) |
| E10 | time scanners rescan everything; missing indexes; scheduler catch-up | Applied (§3.2, §2.9 indexes) |
| E11 | pruning budget too small; missing indexes | Applied: cursor loop over ticks, indexes (§3.15, §2.9) |
| E12 | event diffs implemented twice (SQL + TS) | Applied: capture triggers stay active under the cause GUC and stamp it (§2.9, §3.9) |
| E13 | outgoing webhook skips customer rails | Applied: audience external, guarded type, owners only, opt-out/test checks, confirm (§3.12) |
| E14 | split correlated and not sticky | Applied: step id in the hash + ledger assignment (§3.6) |
| E15 | loop guards kill long loops; reply-with-timeout loops rejected | Applied: counters reset on a real hold, 200 steps/day, timed reply waits count (§3.4, §3.6) |
| E16 | migration revision reset collides; folder rule contradiction | Applied: revision +1 on migrate; folder never bumps revision; on conflict do nothing (§2.9) |
| E17 | rollback ignores rows edited in v2 | Applied: rollback build + ROLLBACK disables and lists every v2-created/edited row (§3.16) |
| E18 | System move contradicts "same on/off"; mirror keys renamed | Applied: handover at Publish; old keys kept as aliases (§4.10, §2.4) |
| E19 | TEMPLATES as a code constant | Applied: `automation_templates` rows seeded by migrate (§2.9, §4.3) |
| E20 | Rule has no per-op contract | Applied: OPS registry args, `oneOf` by op, rule codes (§2.5, §6.1) |
| E21 | multi-trigger semantics undefined | Applied: intersection rule + `trigger.id` field (§3.3, §2.5) |
| E22 | AI edit contract missing; invalid example | Applied: id-churn report, canonical valid example, legacy-only excluded (§6.3, §2.2) |
| E23 | no inline message text | Applied: `body` or `templateKey` (`x-requireOne`) (§2.4, §5.5) |
| E24 | inbound hook: no draft sample, token in URL, keys not normalised | Applied (§3.11) |
| E25 | GHL label fidelity slips | Applied: exact casing, "User replied", "Edit conversation", Communication category, contains_any/none, scan fixture test (§2.4, §2.5) |
| E26 | Total enrolled not all-time; run version vs revision | Applied: `enrolled_total`, `automation_runs.revision` (§2.9, §4.8) |
| E27 | Restore differs from GHL | Applied: Restore only in Draft (§4.7) |
| E28 | remove scope `all` not terminal; GHL exit reasons | Applied (§3.7, §2.5 REASONS) |
| E29 | `upgradeV1` nesting exceeds depth | Changed: the flat node map has no nesting depth (§2.1) |
| E30 | defShape underspecified | Applied: explicit include/exclude list, disabled excluded, guarded detection counts disabled nodes (§2.8, Part 2) |
| E31 | registry export not implementable; parity; narration | Applied: DTO, narration templates, `scope` fixtures, single-flight remote validate (§2.5, §5.2, §6.2) |
| E32 | markRead, window scope, pause ids, AI toggle sources | Applied: markRead applied; window on all actions (GHL); pause checks; AI = ai_settings AND toggle (§3.8, §2.9, §4.4) |
| E33 | manual start time, 0 triggers, wanted RLS, origin, claim-by-id settle, hard-coded values | Applied (§4.9, §3.13, §2.9, §3.1, §3.8) |
| E34 | dup of E4 | Applied (E4) |
| E35 | direct save to a Published row | Applied (E3) |
| E36 | dup of E2 + `audience` NOT NULL | Applied: channel/audience nullable in Part 1 (§2.9) |
| E37 | dup of E1 | Applied (E1) |
| E38 | engine writes lose the cause; stage self-fire | Applied: events written inside `automation_apply` with the scanner key; stage op only when distinct (§3.9) |
| E39 | dup of E17 | Applied (E17) |
| E40 | step counter counts heartbeats | Applied: counts only on cursor moves (§3.4) |
| E41 | dup of E14 | Applied (E14) |
| E42 | dup of E7 + non-wait holds | Applied (§3.5) |
| E43 | app poke duplicates captured events | Applied: capture types are claimed, never rebuilt (§3.1) |
| E44 | settle/Undo not wired | Applied: `available_at = at + settleMs` everywhere (§2.9, §3.2) |
| E45 | hook payload exceeds ctx limit | Applied: normalised and clipped to ≤7 KB (§3.11) |
| E46 | trigger log too big for the free plan | Applied: daily aggregates + capped details (§2.9) |
| E47 | time scanners hit the 1,000 cap | Applied: due windows + paging + watermarks (§3.2) |
| E48 | version history grows; contact path version wrong | Applied: reason-based snapshots, hash skip, cap 50, runs.revision (§3.13, §2.9) |
| E49 | availability errors fail runs | Applied: structure vs availability split (§3.4, §6.2) |
| E50 | AI cannot round-trip greyed steps | Applied: `$defs/existingOnly` (§6.1) |
| E51 | rule shapes loose; duplicate window kind | Applied: OPS args; `window` merged into `recurring` mode window; settings in the schema (§2.3, §6.1) |
| E52 | dup of E13 | Applied (E13) |
| E53 | engine/app array-write race on tags and notes | Applied: atomic RPCs + app switch in G2.3; greyed until then (§3.9) |
| E54 | delete policy bypasses soft delete | Applied: dropped in Part 3 (§2.9) |
| E55 | re-entry off + version cancel locks leads out | Applied: keys deleted on change-cancel (§2.9 Part 2.3) |
| E56 | remove-from-workflow matching and races | Applied: by contact_id, waiting only, `remove_requested` (§3.7) |
| E57 | money alert to non-owners warning missing | Applied: `W_MONEY_TO_NON_OWNER` + field sensitivity (§6.2, §2.5) |
| E58 | Invoice mapping, Assign owner, Advance-window filter, wait order | Applied: Invoice greyed + commission under Ours; `assign_owner` alias; filter greyed; reorder after Send (§2.3, §2.4) |
| E59 | capture details: DELETE uses old, jsonb diffs, INSERT tags | Applied (§2.9) |
| E60 | match budget; reply race; long heartbeat | Applied (§3.2, §3.5) |
| E61 | dup of E29 + `outside:end` status | Applied: ends `skipped` with the phase-4 reason (§2.3) |
| E62 | client can set origin/revision/published | Applied: guard pins them (§2.9 Part 2) |
| E63 | RLS not enabled everywhere; concurrency proven only in the fake DB | Applied: RLS on every table; staging `Promise.all` check (§2.9, §7 G2.1) |
| E64 | hook token in the URL; probing cost | Applied: header/path token, per-IP throttle (§3.11) |

### A.2 builders-ui critiques (B1–B53)
| # | issue (short) | outcome |
|---|---|---|
| B1 | SQL guards read only `steps` | Applied: guards over `definition` (§2.9 Part 2) |
| B2 | type/op keys don't exist in the engine | Applied: canonical key table, engine keys stored, GHL words only in labels (§2.4) |
| B3 | multi-trigger context per node | Applied: `reachingTriggers`, slot context in pickers, intersection codes (§3.3, §5.5) |
| B4 | message-template drafts lost | Applied: `tplDrafts` in state/undo/local draft; saved by `step:"save"` before the row (§3.13, §5.2) |
| B5 | System overlap, mirror types, removed page links | Applied: overlap is a publish blocker; `engine:false`; virtual cards keep their controls on the merged page (§3.13, §2.5, §4.3) |
| B6 | dry run non-determinism | Applied: deterministic rules + `assume` (§3.14) |
| B7 | revision false conflicts; 0-row ambiguity | Applied: revision only on content; 409 from the function with who/when (§2.9, §3.13) |
| B8 | node ids reused | Applied: `doc.seq` (§2.2) |
| B9 | shape omits goto target / branch order | Applied (§2.8) |
| B10 | Go To vs idempotency; runaway loops | Applied: `(run, step, loop)` claims; `E_LOOP_NO_WAIT`, `W_LOOP_CUSTOMER` (§3.6) |
| B11 | window migration; gate in `any` | Applied: recurring window mode with `outside next|at|end`; gate pull-out rule + warning (§2.2, §2.3) |
| B12 | verification plan not executable | Applied: edit vs write guards, builder harness with extended fake-sb, read-only allow-list (§5.2, §8.4, §4.2) |
| B13 | hover/selection rewrite innerHTML; memo key misses context | Applied: CSS hover, class toggles, `ctxRev` (§5.2) |
| B14 | capture-phase keydown steals dialog keys | Applied (§5.6) |
| B15 | doc/patch not AI-generatable | Applied: filters only for trigger semantics, temp ids, resolved enums, `oneOf`/`const`/`x-requireOne`, `setSettings`, server patch copy (§2.2, §6) |
| B16 | Tab keyboard trap | Applied: native Tab kept; A/T keys (§5.6) |
| B17 | `beforeunload` cannot show a custom modal | Applied (§5.5) |
| B18 | notes RLS needs a business function | Applied: `current_business_id()` (§1.3, §2.9) |
| B19 | rollback with doc-only writes | Changed: instead of a v1 projection, the ROLLBACK disables and lists every v2-edited row (simpler, covers non-expressible docs too) (§3.16) |
| B20 | Stats modal fidelity | Applied: evals + reasons RPCs, exact labels (§4.8) |
| B21 | missing GHL labels/controls | Applied: greyed AI controls, number ⋮, Distribution Type, Custom values label, separate category orders, GHL tones, Save Version, switcher ⋮ (§5.5, §4.7, §5.10) |
| B22 | small edge cases (sticky anchor, paused publish, two tabs, hidden types, trigger change) | Applied (§2.7, §5.5, §5.11, §5.3) |
| B23 | filter widening re-fires old events | Applied: separate arm key (§2.8) |
| B24 | node refs hidden in config | Applied: `x-ref`, `wfRefs`, remap/null on paste and delete (§2.5, §5.3) |
| B25 | dup of B10 | Applied |
| B26 | dup of B2 | Applied |
| B27 | client/server schema drift | Applied: engine schemas only; snapshot fixture compare (§5.3) |
| B28 | live checks can't call RPCs in presentation mode | Applied: `READ_ONLY_CALLS` + real reasons (§4.2) |
| B29 | per-workflow settings missing from the save model | Applied (§2.6, §5.2, §5.5) |
| B30 | message editing in the save model; find/replace on shared templates | Applied: helpers take drafts; shared templates not changed (§5.3, §5.5) |
| B31 | guarded-channel detection over the doc incl. disabled/delinked/unknown | Applied (§2.9 Part 2.1) |
| B32 | AI edits to Published go live on Save | Applied: AI-origin commits save as Draft, server-enforced (§3.13, §6.3) |
| B33 | dup of B3 | Applied |
| B34 | key order breaks shape compare | Applied: canonical sorted JSON; jsonb compare in SQL (§2.8) |
| B35 | free-plan egress of doc/layout | Applied: explicit columns, revision-keyed cache, `list_summary` (§3.2, §4.3) |
| B36 | dup of B6 | Applied |
| B37 | locked guard conditions lost; mirror-only types | Applied: `lock`/`locked`, `E_LOCKED`, `engine:false` (§2.2, §4.10) |
| B38 | inserting a goto mid-chain loses steps | Applied: END slots only, `E_GOTO_NOT_LAST` (§2.2, §5.3) |
| B39 | trigger stats inflated by rescans; RPC security | Applied: each event matched once; invoker RPCs with business filter (§3.2, §2.9) |
| B40 | lost session strands the builder | Applied (§5.1) |
| B41 | AI patch ops incomplete | Applied (§6.3) |
| B42 | dup of B8 | Applied |
| B43 | reachability has two meanings | Applied: `viaRefs` (§5.3) |
| B44 | dirty drawer vs undo | Applied (§5.5) |
| B45 | publish self-conflicts | Applied: publish never bumps revision and returns it (§3.13) |
| B46 | dup of B13 | Applied |
| B47 | app Esc handlers fire under the builder | Applied: `stopImmediatePropagation` + early returns (§5.6) |
| B48 | phone widget, staging badge, openModal clash | Applied: `#wf-modal` layer, widget moved (§5.1) |
| B49 | popstate cannot be cancelled | Applied: push back then ask (§5.5) |
| B50 | layout-only saves fill version history | Applied (E48) + "Save Version" link (§4.7) |
| B51 | maxNodes vs maxSteps; dead culling | Applied: reuse `catalog.automations.maxSteps` (clamp 200), old ≤30 check replaced in Part 2; no culling (§2.2, §5.4) |
| B52 | GHL fidelity gaps (presence, stats modal, How to fix, Advance window, path markers, reply without send) | Applied (§5.1, §4.8, §5.5, §2.3, §6.2) |
| B53 | test picker kinds; window skip semantics | Applied: all four record kinds; `outside:end` (§4.8, §2.3) |

Note on B51: Part 2 replaces the phase-4 check `automations_steps_arr` (≤30) with a check on `definition` node count ≤ 200; the
business limit (`maxSteps`) is enforced by the validator.

### A.3 pages-logs critiques (P1–P50)
| # | issue (short) | outcome |
|---|---|---|
| P1 | time-based cache keys → fetch/render loop | Applied: stored day strings, key-stability test (§4.2) |
| P2 | customer System handover stops legacy while Draft | Applied: handover at Publish (`system_handover_at`) (§4.10) |
| P3 | `autoSyncEvents` breaks with the new list | Changed: removed; the engine computes `automation_wanted`, the app reads it (§3.2, G2.4) |
| P4 | definer RPCs ignore the tenant | Applied: `current_business_id()` everywhere; pauses are a table with a trigger (§2.9) |
| P5 | soft delete bypass | Applied (E54) |
| P6 | delayed legacy kinds dropped at handover | Applied: per-base overlap + backdated armed_at for team bases (§4.10) |
| P7 | catalog lost-update of move state | Applied: move state on the automations row, folders in `automation_system_meta` (§2.9, §4.10) |
| P8 | moved rows keep legacy controls | Applied: only virtual rows show them (§4.3) |
| P9 | overlap protection dropped; copies keep system_key | Applied (§3.13, §4.3) |
| P10 | 2B ships before 2C needs | Applied: interim fallbacks in G3.3; the old editor via the adapter until phase 4 (§7) |
| P11 | VA picker empty under RLS; wrong kind | Applied: `record_runs` returns the enrollable list; `wrong_kind` (§4.9) |
| P12 | phone notifications bar disappears | Applied (§4.3) |
| P13 | test results cannot light the same path | Applied: full mapping (§4.8) |
| P14 | prune counter not atomic; retention mismatch | Changed: `enrolled_total` counter at enrolment (no prune counting); runs kept 180 d like the log; fallback to the enroll row (§2.9, §4.8) |
| P15 | lead search bug | Applied: `wfRecordSearchFilter` (§4.8) |
| P16 | stale digest recipients | Applied: resolved at send time (§3.15) |
| P17 | GHL labels | Applied: "Upload to Template Library" first, lead wording, "View lead history", "Highlight lead path", 10/page (§4.3, §4.8) |
| P18 | non-copied items hidden | Applied: greyed with reasons (§4.3, §4.4) |
| P19 | AI-untyped shapes | Applied: `valueType`, gate enum, validators, schemas (§4.3, §6.4) |
| P20 | RPC row cap on list stats | Applied: one jsonb object (§2.9) |
| P21 | helpers missing in the app | Applied: app copies + parity (G3.2) |
| P22 | lead-card block refill | Applied (§4.9) |
| P23 | pause rules only in the RPC | Applied: table trigger is the authority (§2.9) |
| P24 | re-entry "never" ends after 90 days; restore deviation; Save Version | Applied: permanent ledger; GHL restore rule; Save Version (§2.9, §4.7) |
| P25 | dup of P1 | Applied |
| P26 | dup of P2 (+ activate RPC) | Applied: `system_activate` on publish (§4.10) |
| P27 | dup of P7 | Applied |
| P28 | dup of P6 | Applied |
| P29 | text bases lack a shared claim; copies of System bases | Applied: `system_claims`, `legacyClaim` on derived copies, publish blocked while the System row is on (§4.10, §4.3) |
| P30 | delete/draft/purge of a moved System row | Applied (§4.3, §2.9 retention) |
| P31 | lazy cancel | Applied (E6) |
| P32 | dup of P14 | Changed (P14) |
| P33 | re-entry race | Applied: advisory lock in `automation_enroll` (§3.3) |
| P34 | Needs review misses run failures; client-time ack | Applied (§3.15, `automation_mark_reviewed`) |
| P35 | pauses RPC tenant/bypass/wake-all | Applied: table + trigger, targeted wake (§2.9) |
| P36 | dry-run net reports failures | Applied: `simFx` + `SimulationWriteError` (§3.14) |
| P37 | manual enrolment context | Applied (§4.9) |
| P38 | dup of P12 | Applied |
| P39 | bulk delete of System rows | Applied: `wfSystemHidePlan`, one write (§4.3) |
| P40 | dup of P19 | Applied |
| P41 | validators allow unavailable options | Applied (§2.6, §4.4) |
| P42 | deep-link flag already spent | Applied: `wfUsed` (§4.1) |
| P43 | dup of P21 | Applied |
| P44 | folder depth ignores subtree | Applied (§2.9) |
| P45 | copies carry system_key | Applied (§3.1, §4.7) |
| P46 | digest window; outbox prune | Applied: since last notice capped at 7 d; outbox pruned (§3.15, §2.9) |
| P47 | search/paging gaps | Applied: keyset paging, job search, escaping, "first 50" note (§4.8) |
| P48 | dup of P17 + removed reasons | Applied (§2.5 REASONS, §4.8) |
| P49 | cache growth | Applied: Maps capped at 30 and cleared on leave (§4.2) |
| P50 | two sources for the Workflow AI switch | Applied: view of `ai_settings`, nothing stored now (§4.4) |

### A.4 Cross-area conflicts resolved here
- Nested tree (engine) vs node map (builders) → node map (§2.1).
- `automation_step_log` table (pages) vs extended `automation_log` (engine) → extended `automation_log` with `row_kind` (one table,
  one retention, channel counts filter `row_kind='action'`).
- `pause_ranges` jsonb column (pages) vs `automation_pauses` table (engine) → table with a validating trigger.
- `automation_counters` (pages) vs `enrolled_total` (engine critique) → `enrolled_total`.
- System move as a client RPC with a client-built definition (pages) → function step building the definition server-side (§4.10).
- `revision` meaning (optimistic lock vs version number) → one `revision` (content counter + lock) and a separate `version_no` for
  "vN" display (§2.9).
- Wait `window` kind (engine) vs GHL's 8 cards → `recurring` with a window mode (§2.3).
- Settings vocabularies (`reentry` bool + `parallel` vs `never|after_exit|always` + `multipleJobs`) → `reentry off|after_exit|
  legacy_always` + `perRecord` (§2.6).

## 10. Ofek's answers (15 Oct morning) — binding, override §9.1 defaults where different
- Q1 Automation page inside Settings (default). Q2 manual add: owners + managers only (default). Q3 phone: everything except drag
  / line-drawing (default). Q4 deleting a branching step: ask which branch to keep (default).
- **Q5 CHANGED:** "quote sent" = the lead moves to the Quoted pipeline stage → NO separate Quote-status trigger (use Pipeline stage
  changed); remove/hide the quote_status trigger (do not grey it).
- **Q6 CHANGED:** add the "Assigned to" (owner) field to the lead card NOW (contacts column + lead card UI + filters), and make the
  "Assign to user" / "Remove assigned user" actions available (not greyed).
- Q7 error alerts: phone push at most once a day to chosen people; email later (default).
