# Stage 2 phase 1 — live deploy runbook (SQL Part 1 + the v2 function in compat mode; phase 2 from section 9)

For the MAIN BUILDER. Design: `.claude/plans/stage2-design.md` §3.16, §7 Phase 1 (G1.4), §8.2, §8.3. Nothing in this file has
been run: every step below is done by the main builder (with Ofek's OK where the rules or the safety classifier ask for it).
Every SQL here is read-only except step 5 (Part 1 itself, in `.claude/sql/stage2-automations.sql`) and the rollback steps.

What goes live in phase 1 (and nothing more):

| piece | file | effect |
|---|---|---|
| SQL Part 1 | `.claude/sql/stage2-automations.sql`, section PART 1 | additive: new tables/columns (all with defaults), the `automation_log_once` → `automation_log_action_once` swap together with `automation_claim_customer_v2` and the phase-4 `automation_claim_customer` as a wrapper (one transaction), silent capture triggers, RPCs, RLS, indexes. The phase-4 function keeps working on it. |
| the v2 function | `supabase/functions/automations/index.ts` (pasted into the existing `automations` function) | **compat mode**: the phase-4 scanners + `enqueue` start the runs exactly as today (same five event-key formats); every claimed run is executed by `advanceV2` (a phase-4 row read through `upgradeV1`, phase-4 step ids kept in every log row, claim and window mark). Before Part 1 is in, the same build runs phase 4's own `advance` (it reads `automation_state.phase4_compat`; a missing column = phase-4 executor), so a wrong order is safe. |
| the rollback build (prepared, NOT deployed) | `supabase/functions/automations-phase4-compat/index.ts` | the phase-4 function of commit a8c6d2d (live since 15 Oct: phase 4 + stage 5's quiet imports + stage 3's vacations) + 2 code edits (action-rows-only "already done" check, readable on both schemas; soft delete = delete) + a header. **Never deploy this folder by name.** It is pasted into `automations` only for a rollback. |

The function log says which engine runs, once per instance and on every change:
`automations engine: v2 executor in compat mode (phase-4 scanners + enqueue, runs by advanceV2)` — or, before Part 1,
`automations engine: phase-4 executor (stage 2 SQL Part 1 not applied yet)`.

---

## 0. Preconditions (all must hold; otherwise stop)

1. **Stage 1 is live** (MASTER §13): `round3-stage1.sql` applied and the stage-1 functions deployed, the live `automations`
   function = commit `a8c6d2d` (stages 3 and 5 merged into stage 2 on 15 Oct; before that the baseline was 7ae5b19,
   `689178985/112594`). Check: copy the live source from the dashboard editor into a file and fingerprint it (below):
   it must be **`732447356/123206`** (= `git show a8c6d2d:supabase/functions/automations/index.ts`). If it is not, stop: the
   rollback build and the differential baseline are built on a8c6d2d. The v2 build reads stage 5's `import_quiet` columns
   and stage 3's `employee_vacations` (as the live function does), so `stage5-mcp.sql` and `stage3-vacation.sql` are in.
2. The stage-2 phase-1 groups G1.1–G1.4 are merged and **committed** by the main builder; `bash .claude/check_all.sh` prints
   `ALL GREEN` on that commit.
3. The offline differential is IDENTICAL on that commit (step 3 below, built-in corpus first).
4. A quiet hour (not 08:00–09:00 or 17:00–19:00 Sydney, when most customer messages go) with 2.5 hours of attention.

Fingerprint (MASTER rule 9; the same formula everywhere):

```bash
node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8");let x=0;for(let i=0;i<s.length;i++)x=(x+s.charCodeAt(i)*(i%97+1))%1000000007;console.log(x+"/"+s.length)' FILE
```

Reference values at the time of writing (recompute from the commit — any later edit changes them):
v2 `automations/index.ts` `816032735/539155` (6,527 lines, the merge of main a8c6d2d, before its commit) · rollback build
`840260018/125603` (1,736 lines) · phase 4 (a8c6d2d) `732447356/123206`.

## 1. Backups (read-only; save each output under `.claude/backups/`)

1. Schema: the BACKUP query at the top of PART 1 in `.claude/sql/stage2-automations.sql` →
   `.claude/backups/automation-schema.before_stage2.sql`.
2. Rows (definitions, settings, state):
   ```sql
   select json_build_object(
     'automations', (select coalesce(json_agg(a order by a.created_at), '[]') from public.automations a),
     'automation_settings', (select coalesce(json_agg(s), '[]') from public.automation_settings s),
     'automation_state', (select coalesce(json_agg(t), '[]') from public.automation_state t),
     'waiting_runs', (select count(*) from public.automation_runs where status in ('waiting', 'running')));
   ```
   → `.claude/backups/automations.before_stage2_<YYYY-MM-DD>.json`.
3. The live function source (from the dashboard editor) → `.claude/backups/automations-function.before_stage2.ts` and its
   fingerprint (precondition 1).
4. The watch baseline: run W3–W8 (section 6) with `:deploy` = the planned deploy time; the `days_ago` 1–7 rows are the
   baseline. Save the output → `.claude/backups/automation-watch-baseline.<YYYY-MM-DD>.txt`.

## 2. Pre-checks (read-only, live)

```sql
-- the check-before block of PART 1 (constraint names, contacts.tags type, column types, helper functions, counts)
-- …plus: phase-4 step ids that are not valid v2 ids (upgradeV1 gives them fresh node ids; compat mode keeps the
-- phase-4 id in every log row and claim, so phase 1 is safe — but list them: the phase-2 migrate must handle them)
select a.id, a.name, s->>'id' as step_id
  from public.automations a, jsonb_array_elements(a.steps) s
 where not coalesce(s->>'id', '') ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$';
-- waiting / running runs now (unchanged by Part 1; they continue under the v2 executor from step_index)
select status, count(*) from public.automation_runs group by 1;
```

## 3. Offline differential + read-only shadow (design §8.3 #1–#2)

The harness is in the repo: `supabase/functions/automations/differential/` (`run.sh`, `harness.ts`, `corpus/builtin.json`,
`selftest/`), with the phase-4 source vendored as `tests/phase4-reference.ts` (run.sh checks it is a8c6d2d byte for byte
whenever git can show that commit). `check_all.sh` runs the built-in corpus every time (through the automations
`run_tests.sh`), so ALL GREEN includes `DIFFERENTIAL: IDENTICAL`. Below, `run.sh` = `bash supabase/functions/automations/differential/run.sh`
run from the repo root; the live exports go in the session scratchpad (never in the repo) and are passed by path.
It builds three engines from source — old = a8c6d2d, new = the worktree's v2 function, rb = the rollback build — and replays
every scenario on the tests' in-memory database (Part-1 shaped) through old, new, rb, the new build deployed before Part 1
(its phase-4 fallback, which must write no v2 rows) and the cutovers old→new (deploy), new→rb and new→old (rollback),
new→rb→new (redeploy after a rollback), new/rb alternating every tick, and before-Part-1→Part-1. Compared: action log
rows (step id, channel, audience, status, reason, recipient, time), every run's end status/reason/step_index and every due_at,
pushes, tasks and emails (exact text). It also proves the rollback build = a8c6d2d + its header + the 2 edits, nothing else.

1. Built-in corpus (23 recorded-style rows mirroring the ready-made and builder shapes, incl. two long runs of 21–22 steps
   above an email + the 25 `upgrade.json` v1 shapes ×
   23 scenarios: in hours, outside hours, the night before DST, public holiday, weekend, opted out, test records, capped,
   stage undone within 30 s, stage moved on, stage moved on within 30 s, no customer card, card linked later, 30-hour outage (late), no signer, picked
   up + chat answered, don't ask + asked lately + paid, the app's "look now", and (main a8c6d2d) a quiet imported lead + its
   "look now", a quiet lead reopened later, a quiet imported job, vacations with stand-ins (push + task), every owner away
   (skipped: on vacation) — each of the last five also checks phase 4 really did what it is for):
   `run.sh` → must end `DIFFERENTIAL: IDENTICAL` (at the time of writing: 1,150 cases, 26,979 worlds, 65 s).
2. Live definitions (read-only export, save as `live-automations.json` in the scratchpad):
   ```sql
   select json_agg(a) from (select id, name, enabled, armed_at, version, created_by_name, trigger, steps
                              from public.automations where business_id = 'default' order by created_at) a;
   ```
   `run.sh --corpus <scratchpad>/live-automations.json` → IDENTICAL. (Every live row runs as if ON, so Draft customer rows are covered.)
3. Live shadow (read-only export of the last 30 days, no message bodies; save as `live-records.json`):
   ```sql
   select json_build_object(
     'contacts', (select coalesce(json_agg(c), '[]') from (
        select id, full_name, phone, email, postcode, division, source, status, tags, created_at, contacted_at, last_read_at, reopened_at,
               jsonb_build_array(messages->0) as messages, stage_changed_at, linked_job_id
          from public.contacts
         where created_at::text >= to_char(now() - interval '30 days', 'YYYY-MM-DD') or stage_changed_at > now() - interval '30 days'
            or reopened_at > now() - interval '30 days'
            or id in (select contact_id from public.jobs where created_at > now() - interval '30 days')) c),
     'jobs', (select coalesce(json_agg(j), '[]') from (select id, customer_name, invoice_number, date, job_type, technician, amount, payment_status,
        review_do_not_ask, contact_id, created_at from public.jobs where created_at > now() - interval '30 days') j),
     'calls', (select coalesce(json_agg(k), '[]') from (select id, from_number, to_number, direction, missed, started_at, created_at, division, contact_id,
        status, duration from public.calls where started_at > now() - interval '30 days') k),
     'chat_sessions', (select coalesce(json_agg(s), '[]') from (select id, contact_id, phone, first_name, full_name, service_key, brand, service_text,
        test, created_at from public.chat_sessions where created_at > now() - interval '30 days') s),
     'lead_messages', (select coalesce(json_agg(m), '[]') from (select id, contact_id, session_id, channel, direction, auto, status, at
        from public.lead_messages where at > now() - interval '31 days') m),
     'customer_opt_outs', (select coalesce(json_agg(o), '[]') from (select id, business_id, contact_id, channel, value_key from public.customer_opt_outs) o),
     'review_requests', (select coalesce(json_agg(r), '[]') from (select id, status, phone, email, created_at, sent_at from public.review_requests
        where created_at > now() - interval '36 months') r),
     'settings', (select json_agg(x) from (select company_name, catalog from public.settings limit 1) x),
     'automation_settings', (select json_agg(x) from public.automation_settings x),
     'profiles', (select json_agg(x) from (select id, full_name, role, on_duty, on_duty_date, technician_name from public.profiles) x),
     'employees', (select json_agg(x) from (select id, name, status, roles from public.employees) x));
   ```
   `run.sh --corpus <scratchpad>/live-automations.json --records <scratchpad>/live-records.json` → IDENTICAL (each live automation × its last 20
   matching records, each record alone at the moment of its event).
   **Delete both exports afterwards** (customer data): `rm live-automations.json live-records.json`.

Any difference → stop, read `report.json` (its path is printed; `findings[]`: scenario, automation, engine/cutover, first differing path), fix,
re-run `check_all.sh` and the differential.

## 4. Staging first

1. Staging SQL editor: PART 1 (same text), then `.claude/sql/stage2-part1-staging-checks.sql` — every check as documented.
2. Staging has no Edge Functions (design risk 11). If an `automations` function exists there, deploy the v2 build with
   Verify JWT OFF and fake secrets and confirm one tick logs `automations engine: v2 executor in compat mode …`; otherwise the
   offline differential (step 3) is the function gate.

## 5. Live — order (one step at a time, each verified before the next)

1. **SQL Part 1 on live**: run the check-before queries, then the whole PART 1 section (one transaction; `lock_timeout 5s` —
   on a lock timeout simply run it again). Run the check-after block. Expect `select 'stage2 Part 1 ok'`.
2. **5 minutes with the phase-4 function on the new schema** (still a8c6d2d): W1 shows ticks every minute; W3 shows actions
   as usual; the function log has no new errors; W9 = silent (0 events, 0 wanted, 0 capture errors). Anything wrong here →
   Part 1 ROLLBACK (section 7, R-B) — the function was never touched.
3. **Deploy the v2 function**: dashboard → Edge Functions → `automations` → editor, prefilled from the GitHub raw file of the
   committed stage-2 phase-1 commit; Verify JWT **OFF**; Deploy. Copy the deployed code back out and fingerprint it: it must
   equal the commit file. Note the deploy time = `:deploy` (UTC) for the watch.
4. **First tick** (≤ 1 minute): function log `automations engine: v2 executor in compat mode (phase-4 scanners + enqueue,
   runs by advanceV2)`. If it says `phase-4 executor (stage 2 SQL Part 1 not applied yet)`, Part 1 is not in place — the
   function is safe (it runs phase 4's advance) but stop and check step 1.
5. **Watch two hours** (section 6) at +5, +15, +30, +60, +90 and +120 minutes.
6. **Log it** in MASTER §13 (time, commit, fingerprints, watch result) and tell Ofek in Hebrew.

## 6. The 2-hour watch (read-only; `:deploy` = the deploy time, e.g. `'2026-10-16 03:10:00+00'`)

Each query compares the window since the deploy with the same two hours of each of the previous 7 days (`days_ago` 1–7 =
baseline saved in step 1.4).

```sql
-- W1 the timer is alive (every minute; the lease is given back)
select last_tick_at, now() - last_tick_at as since_last_tick, tick_lease_until from public.automation_state where business_id = 'default';

-- W2 the v2 executor really runs (step / exit rows appear once runs move; none before the deploy)
select row_kind, count(*) from public.automation_log where at >= :deploy group by 1;

-- W3 actions per automation × channel × status × reason, now vs the same 2 hours of the last 7 days
with w as (select d, tstzrange(:deploy - make_interval(days => d), :deploy - make_interval(days => d) + interval '2 hours') r from generate_series(0, 7) d)
select w.d as days_ago, l.automation_name, l.channel, l.status, coalesce(l.reason, '') as reason, count(*)
  from w join public.automation_log l on l.at <@ w.r and l.row_kind = 'action'
 group by 1, 2, 3, 4, 5 order by 2, 3, 4, 5, 1;

-- W4 a NEW reason class (action skips/failures and run endings never seen in the last 30 days) → expect 0 rows
(select 'action' as kind, coalesce(reason, '') as reason from public.automation_log where row_kind = 'action' and at >= :deploy
 except select 'action', coalesce(reason, '') from public.automation_log where row_kind = 'action' and at >= :deploy - interval '30 days' and at < :deploy)
union all
(select 'run', coalesce(reason, '') from public.automation_runs where finished_at >= :deploy
 except select 'run', coalesce(reason, '') from public.automation_runs where finished_at >= :deploy - interval '30 days' and finished_at < :deploy);

-- W5 event-key drift: old events started again (the scanners look back 6 hours; a changed key would re-start them all)
with w as (select d, tstzrange(:deploy - make_interval(days => d), :deploy - make_interval(days => d) + interval '2 hours') r from generate_series(0, 7) d)
select w.d as days_ago, r.event_type, count(*) as runs, count(*) filter (where r.created_at - r.event_at > interval '15 minutes') as late_starts
  from w join public.automation_runs r on r.created_at <@ w.r group by 1, 2 order by 2, 1;
select automation_id, record_kind, record_id, array_agg(event_key order by created_at) as keys
  from public.automation_runs where created_at >= :deploy - interval '6 hours'
 group by 1, 2, 3 having count(*) > 1 and max(created_at) >= :deploy;            -- inspect each: a second real event, or drift?

-- W6 never twice, never over the cap → expect 0 rows each
select coalesce(contact_id::text, recipient) as who, count(*) from public.automation_log
 where row_kind = 'action' and audience = 'customer' and status in ('sending', 'sent', 'queued') and at >= :deploy - interval '24 hours'
 group by 1 having count(*) > (select customer_daily_cap from public.automation_settings where business_id = 'default')
                   and max(at) >= :deploy;
select run_id, step_id, "loop", count(*) from public.automation_log where row_kind = 'action' and at >= :deploy group by 1, 2, 3 having count(*) > 1;
select l.automation_id, l.record_id, l.step_id, count(*) from public.automation_log l
 where l.row_kind = 'action' and l.status in ('sending', 'sent', 'queued', 'waiting_phone') and l.at >= :deploy - interval '24 hours'
 group by 1, 2, 3 having count(*) > 1 and max(l.at) >= :deploy;                  -- inspect: a reopened lead is legitimate

-- W7 failures, now vs baseline
with w as (select d, tstzrange(:deploy - make_interval(days => d), :deploy - make_interval(days => d) + interval '2 hours') r from generate_series(0, 7) d)
select w.d as days_ago, r.status, coalesce(r.reason, '') as reason, count(*)
  from w join public.automation_runs r on r.finished_at <@ w.r where r.status in ('failed', 'cancelled', 'skipped')
 group by 1, 2, 3 order by 2, 3, 1;

-- W8 nothing stuck, no backlog → expect 0 / 0
select count(*) filter (where status = 'running' and lease_until < now() - interval '5 minutes') as stuck,
       count(*) filter (where status = 'waiting' and due_at < now() - interval '10 minutes') as overdue
  from public.automation_runs;

-- W9 Part 1 stays silent in phase 1 → 0, 0, 0
select (select count(*) from public.automation_events) as events, (select count(*) from public.automation_wanted) as wanted,
       (select capture_errors from public.automation_state where business_id = 'default') as capture_errors;
```

Also read the function log for `automation run failed:` / `automations tick failed:` lines (baseline: none).

**Roll back at once (section 7, R-A) on any of:** a duplicate action (W6 second query > 0, or a third-query row that is not a
second real event), a customer over the cap (W6 first query), event-key drift (W5 late starts or repeated keys after the
deploy that the baseline does not have), a new reason class that stopped or changed sends (W4), more failed runs/actions than
any baseline day (W7, W3 `failed`), ticks stopping (W1 > 3 min) or a backlog (W8). A new reason class that is harmless (e.g. a
new record's `missing details: x`) is noted, not a rollback.

## 7. Rollback

**R-A — function only (the default; Part 1 stays, it is additive and silent).**
⚠ Once PART 2 · G2.4 is live and the migration ran, R-A alone is UNSAFE as soon as any row was saved after
`v2_migrated_at` (the G2.4 ROLLBACK's read-only list is not empty): the adapter's saves write only the doc, so that row's
`trigger` / `steps` still hold the old words and R-A would run them. Then follow section 12.2 (switch those rows off
FIRST, with the stage-2 build still deployed), never R-A on its own.
1. Dashboard → `automations` → editor: paste `supabase/functions/automations-phase4-compat/index.ts` from the committed
   stage-2 commit (GitHub raw). Verify JWT **OFF**. Deploy. Fingerprint the deployed code = the commit file
   (`840260018/125603` at the time of writing). Never `supabase functions deploy automations-phase4-compat`, never "deploy all".
2. Check: from the rollback time no new `step` / `exit` rows (W2 with `:deploy` = rollback time → only `action`); W1 ticks;
   W3 actions continue; waiting runs go on from `step_index` (the v2 executor kept it in step; tested both ways, including a
   later redeploy).
3. In phase 1 the plain phase-4 file (a8c6d2d) also runs correctly on the Part-1 schema (differential "new → old"), but the
   rollback build is the one to use: only it ignores v2 step rows in its "already done" check and treats a soft delete as a
   delete, which matters from phase 2 on.

**R-B — also the schema (only if Part 1 itself misbehaves, e.g. capture errors or a lock problem).**
1. R-A first (the rollback build runs on both schemas).
2. Run the commented ROLLBACK block of PART 1 in `.claude/sql/stage2-automations.sql` (one transaction). It deletes the rows only
   the v2 engine writes (enroll / step / exit log rows, Go-to passes, new channels) and restores `automation_log_once` and the
   phase-4 `automation_claim_customer`. Then the schema check of step 1.1 again and compare with the backup.
3. Keep the rollback build deployed (tested on the phase-4 schema: the whole phase-4 suite) or redeploy a8c6d2d.

After any rollback: watch 30 minutes (W1, W3, W6, W8), log it in MASTER §13 and tell Ofek in Hebrew what happened and why.
Before deploying v2 again: fix, `check_all.sh` ALL GREEN, the differential IDENTICAL (it covers rollback → redeploy).

## 8. Notes for later phases (found while building G1.4)

- **Phase-4 step ids that are not v2 ids** (step 2 query): compat mode maps node ids back to the phase-4 id for log rows,
  claims and the window pass (`advanceV2`, `sid`), so phase 1 is exact. `step:"migrate"` (G2.4) must not silently re-id them:
  either keep the old id in the doc, or store the id map and translate claims — otherwise an action claimed before the
  migration could be claimed again under its new id. **Done in G2.4**: while the row keeps its phase-4 steps (until phase
  7), an unedited upgraded row runs those very steps (`wfRunRow`), and a doc row maps an old id to its node again
  (`runDocOf` idMap), so every claim and log row of before the migration still matches.
- The rollback build's correctness after phase 2 also depends on the Part-2 ROLLBACK disabling every row created or edited
  in v2 (design §3.16) — phase 4 cannot run a doc-only workflow.

## 9. Phase 2 · G2.1 — the event store (SQL Part 2 step E)

What changes: `automation_state.phase4_compat = false` (PART 2 · STEP E in `.claude/sql/stage2-automations.sql`). From the
next tick the function starts runs through the event store instead of phase 4's `enqueue`: it writes `automation_wanted`
(the capture triggers start writing those types), scans the scan and time sources from their watermarks
(`automation_state.scan_marks`; a scanner looks back 30 minutes before its mark, never more than `lookback_hours`; at least one
producer runs every tick and they take turns when 8 seconds are not enough, `scan_marks._next` = the one to start with next), claims the
due events (at least one a tick), wakes held runs that watch them, stops the runs a reply ends (Stop on response), checks every trigger
(a stage move undone within its 30-second settle time is dropped here as `move_undone`, never enrolled; for an upgraded
workflow a move the lead had already left again is dropped as `moved_on`, as phase 4 never saw it — native v2 docs fire on
every move) and enrols
through `automation_enroll`, and writes `automation_trigger_log` (matched rows always, unmatched ones the first 200 a trigger
a day) and `automation_trigger_daily`. The phase-4 scanners and their five event keys are reused byte for byte: an event the
compat producer already started gives `duplicate_event`, never a second run. The function log line becomes
`automations engine: v2 executor with the event store (producers, captured events, matcher)`.

Upgraded rows (re-entry `legacy_always`) start exactly as phase 4 did (no lock, the executor's test-record guard). The
offline differential proves it: the `ev` engine (step E on), `new → ev` after tick 1 and mid-way, `ev → new` / `ev → rb`
(rolled back) and alternating every tick are all IDENTICAL to phase 4 on the built-in corpus and on the live shadow
(`bash supabase/functions/automations/differential/run.sh` — and with `--corpus` / `--records` on the live exports of
section 3 before the live step).

### 9.1 Order (one step at a time)

1. Preconditions: Part 1 live; the phase-2 function (with the EVENTS section) deployed and ticking in compat mode for at least
   15 minutes (W1–W8 clean); `check_all.sh` ALL GREEN and the differential IDENTICAL on the deployed commit (with the live
   exports of section 3, fresh).
2. Staging: `.claude/sql/stage2-part1-staging-checks.sql` again (PASS 1 … 15), then the concurrent-enrolment check (9.2).
3. Live: run the STEP E check-before queries, then the STEP E block (one short transaction). Note the time = `:stepE`.
4. First tick (≤ 1 minute): the log line above (once); STEP E check-after queries. The first tick re-checks the last
   `lookback_hours` of scan events: expect `duplicate_event` rows in the trigger log for everything phase 4 already started,
   and **no** new runs for them (E1 below).
5. Watch two hours with section 6 (`:deploy` = `:stepE`) plus E1–E4 below; same roll-back triggers as section 6.
6. Log it in MASTER §13 and tell Ofek in Hebrew.

### 9.2 Staging: two enrolments at the same moment through PostgREST (design §8.1 #12)

The fake database runs one call at a time; this proves the advisory lock + partial unique index under real concurrency.
On the STAGING project only, from a terminal (the staging URL and service key from the staging project's settings, typed
into the shell, never saved in a file):

```bash
export SB_URL="https://<staging-ref>.supabase.co" SB_KEY="<staging service_role key>"   # staging ONLY
node --input-type=module -e '
const h = { apikey: process.env.SB_KEY, Authorization: "Bearer " + process.env.SB_KEY, "Content-Type": "application/json", Prefer: "return=representation" };
const R = (p, b) => fetch(process.env.SB_URL + p, { method: "POST", headers: h, body: JSON.stringify(b) }).then(r => r.json());
const [a] = await R("/rest/v1/automations", { name: "stage2 concurrency check", enabled: false, trigger: { type: "newLead", params: {} }, steps: [] });
const now = new Date().toISOString();
const p = (key) => ({ p_business: "default", p_automation: a.id, p_version: 1, p_revision: 1, p_trigger: "t1", p_event_key: key, p_event_type: "contact_changed",
  p_event_at: now, p_record_kind: "contact", p_record_id: "conc-1", p_contact: null, p_enroll_key: "conc-1", p_lock_key: "conc-1", p_reentry: "off", p_start: "n1",
  p_context: {}, p_source: "trigger", p_chain: 0, p_cause: null, p_parent: null, p_stop_on_reply: false, p_now: now });
const got = await Promise.all(Array.from({ length: 8 }, (_, i) => R("/rest/v1/rpc/automation_enroll", p("k" + (i % 3)))));
const runs = await fetch(process.env.SB_URL + "/rest/v1/automation_runs?select=id&automation_id=eq." + a.id, { headers: h }).then(r => r.json());
console.log(got, "runs:", runs.length);   // expect exactly one "enrolled:<id>", the rest "already_enrolled" / "duplicate_event"; runs: 1
await fetch(process.env.SB_URL + "/rest/v1/automations?id=eq." + a.id, { method: "DELETE", headers: h });   // its runs and ledger go with it (cascade)
'
unset SB_URL SB_KEY
```

### 9.3 Extra watch queries after step E (read-only; `:stepE` = the step-E time)

```sql
-- E1 nothing started twice: every run since step E came through automation_enroll, one per (workflow, event key)
select count(*) filter (where not exists (select 1 from public.automation_log l where l.run_id = r.id and l.row_kind = 'enroll')) as without_enroll_row,
       count(*) as runs
  from public.automation_runs r where r.created_at >= :stepE and r.source = 'trigger';             -- without_enroll_row = 0
select automation_id, record_kind, record_id, count(*) from public.automation_runs
 where created_at >= :stepE - interval '6 hours' group by 1, 2, 3 having count(*) > 1 and max(created_at) >= :stepE;   -- inspect each (W5)

-- E2 the event store keeps up: nothing due waits, nothing gives up
select status, count(*), min(available_at) filter (where status = 'new') as oldest_new, max(attempts) from public.automation_events group by 1;
-- 'new' older than 2 minutes = a backlog; any 'error' row → read its error (5 attempts failed)

-- E3 what the triggers decided (matched vs reasons per workflow and trigger, today)
select a.name, d.trigger_id, d.attempted, d.matched, d.enrolled, d.reasons from public.automation_trigger_daily d
  join public.automations a on a.id = d.automation_id where d.day = (now() at time zone 'Australia/Sydney')::date order by 1, 2;

-- E4 the capture triggers are on and never fail a save
select (select string_agg(event_type, ',' order by event_type) from public.automation_wanted) as wanted,
       capture_errors, capture_error_last, capture_error_at, scan_marks from public.automation_state where business_id = 'default';
```

W9 of section 6 no longer applies after step E (events and wanted are expected now); `capture_errors` must stay 0.

### 9.4 Roll back step E

The commented ROLLBACK of PART 2 · STEP E (one transaction): `phase4_compat = true`, the capture list emptied, the events
nobody will claim closed. The next tick logs `v2 executor in compat mode …` and the compat producer starts the runs again with
the same keys (differential `ev → new` / `ev → rb`: identical). Roll back on the section-6 triggers, on E1 > 0, on an E2 backlog
that does not drain within 10 minutes, or on any `capture_errors` growth. A function rollback (section 7, R-A) also works with
step E still on: the rollback build ignores `phase4_compat` and the event store — but then also run the step-E rollback, so the
capture triggers stop writing events nobody reads.

## 10. Phase 2 · G2.2 — logic steps and per-workflow settings (no SQL)

What changes: only the function. `advanceV2` now runs every step kind of a stage-2 workflow: If / else (first true branch,
None), Split (bucket = hash of workflow + step + enrolment key; the path kept in `automation_enrollment_keys.splits` and taken
again on re-entry while it still has > 0%), Goal (met → on; not met → end / continue / wait; a goal met ahead is jumped to as
soon as its event wakes the held run), Go to (a new pass: actions claim again; 10 visits of the target without a hold = failed
"loop guard: Go to ran 10 times without waiting"), Add to workflow (a run of a published target through `automation_enroll`,
source `workflow`, parent + chain + 1, event key `wf:<run>:<step>:<pass>`, stops at chain depth 3), Remove from workflow (the
lead's other runs by contact: waiting → `removed` + exit row, running → `remove_requested`, ended at its next write; `current` /
`all` end this run `removed`), the reply / user-reply / conditions waits (hourly recheck, woken by their events, the
"Timed out" branch), Stop on response before every customer message, the workflow's time window for every action (customer
messages: window ∩ customer hours), Global "Pause workflow" ranges (actions held until the end, waits go on; the pause list
wakes only its workflows' held runs) and "Conversations: Mark as read" (`automation_apply` op `read` after a sent message).

Phase-4 rows (compat and migrated) are untouched: no stage-2 step kinds, migrated settings (no time window, no Stop on
response, no Mark as read), and a pause only when the owner adds one. The offline differential stays IDENTICAL.

### 10.1 Order

1. `check_all.sh` ALL GREEN on the commit (the automations suite has section 32 for G2.2; the differential IDENTICAL).
2. Staging: `.claude/sql/stage2-part1-staging-checks.sql` again → PASS 1 … 16 and `stage2 phase 2 · G2.2 staging checks done`.
3. Deploy the function (dashboard editor, fingerprint); nothing to run in SQL.
4. Watch (read-only) for an hour after the deploy, together with section 6 and 9.3:

```sql
-- L1 the new end states and reasons (stage-2 workflows only; phase-4 rows show none of these)
select status, exit_reason, count(*) from public.automation_runs where updated_at >= :deploy and exit_reason in
  ('removed_by_action', 'removed_by_external_action', 'replied', 'goal_not_met', 'loop_guard') group by 1, 2;
-- L2 runs asked to stop while moving that never ended (want 0 after 5 minutes)
select count(*) from public.automation_runs where remove_requested and status in ('waiting', 'running') and updated_at < now() - interval '5 minutes';
-- L3 held runs by what they wait for (rechecks are claimed last; 'pause' = held by a pause range)
select unnest(watch) as watches, recheck, count(*) from public.automation_runs where status = 'waiting' group by 1, 2 order by 3 desc;
-- L4 Add to workflow chains (depth ≤ 3) and their parents
select chain_depth, source, count(*) from public.automation_runs where created_at >= :deploy group by 1, 2 order by 1, 2;
```

### 10.2 Roll back

Redeploy the previous function build (the G2.1 one). Nothing in the database needs undoing: runs a G2.2 step put on hold keep
their `cursor_step` and context and go on when a build that knows the step runs again; a run at a stage-2 step under the
older build fails "not supported yet" (only stage-2 workflows have such steps, and none exist until G2.4's save / migrate).


## 11. Phase 2 · G2.3 — record actions, the inbound and outgoing webhooks, custom values (SQL Part 2 · G2.3 + app)

What changes:
- **Function**: a stage-2 workflow's record actions (Update lead field, Add / Remove lead tag, Add to notes, Stop automatic
  messages, Edit conversation, Move to stage, Mark lost, Add internal comment, Update custom value, Add task, Manual action
  to call) are ONE `automation_apply` call each with the run's cause (`<run>:<depth>:<workflow>`), so every event the
  write makes carries it: a workflow never starts itself again (`own_change`) and a chain stops at depth 3 (`loop_guard`).
  New customer actions: Send live chat message (into the lead's open chat of the last 24 hours) and Send review request
  (one row in the Google reviews queue; the review-requests function sends it; claim `system_claims review:<job>`), both
  with the full customer guard and the daily cap. The outgoing Webhook (https only; never an IP, localhost, `*.local`,
  `*.internal`, Supabase, or a name that resolves to a private / link-local / CGNAT address; no redirects; 10 s; one more
  try on a 5xx; the log keeps the host, the status and the time only). Stage-2 words: `{quote_amount}`, `{custom.<key>}`,
  `{trigger.<key>}` (HTML-escaped in emails), an unknown blank stops a customer message. The inbound webhook: POST to
  `…/functions/v1/automations/hook/<token>` (or header `x-hook-token`); `hook_create` / `hook_revoke` / `hook_sample`
  steps for owners and managers. Phase-4 rows are untouched (their actions keep phase 4's execute): the differential stays
  IDENTICAL.
- **SQL** (PART 2 · G2.3, one transaction): `contact_tags_merge`, `contact_notes_append`, `contact_tags_edit`,
  `contact_note_add`, `contact_note_remove` (security invoker, signed-in), `automation_hook_hit` (service role),
  `automation_apply` and `automation_capture_contacts` replaced (notes on the card as `{id, text, by, at}`, the card's tag
  rule, a team task with no lead, "Note added" captured). A note id is any non-empty one up to 128 characters without
  control characters, so the Undo of a deleted imported note (e.g. `ghl:123/x`) puts it back as it was (a time it had,
  even none, is kept).
- **App**: the lead card's tag click, bulk tags (+ Undo), note add and note delete (+ Undo) call the three atomic functions;
  while they are missing (SQL not in yet, or rolled back) the app falls back to its old whole-list save by itself.

### 11.1 Order (one step at a time)

1. `check_all.sh` ALL GREEN on the commit (automations section 33; app `testLeadAtomicEdits`; differential IDENTICAL).
2. Staging: PART 2 · G2.3 (check-before → block → check-after), then `.claude/sql/stage2-part1-staging-checks.sql` → PASS 1 … 18
   and `stage2 phase 2 · G2.3 staging checks done`.
3. Live: PART 2 · G2.3 check-before, the block, check-after. Note the time = `:g23`.
4. Deploy the function (dashboard editor, fingerprint).
5. App: branch → live-origin check (tag click, bulk tag + Undo, note add / delete + Undo on a test lead; network tab shows
   `rpc/contact_tags_edit` etc. with 200) → fast-forward main.
6. Watch (read-only) for an hour, with section 6 and 9.3:

```sql
-- G1 the lead card's saves never fail on the new functions (the app shows "Could not save" otherwise) and capture stays clean
select capture_errors, capture_error_last from public.automation_state;                       -- unchanged since :g23
-- G2 note and tag events have the expected keys; a workflow's carry its cause
select type, (cause_automation_id is not null) as by_workflow, max(chain_depth), count(*) from public.automation_events
 where at >= :g23 and type in ('contact_tag', 'note_added') group by 1, 2 order by 1, 2;
-- G3 the record actions' rows (stage-2 workflows only; nothing until G2.4 lets one be saved)
select step_type, status, reason, count(*) from public.automation_log where at >= :g23 and row_kind = 'action'
   and step_type in ('update_field', 'add_tag', 'remove_tag', 'add_note', 'dnd', 'edit_conversation', 'move_stage', 'mark_lost', 'internal_comment',
                     'update_custom_value', 'add_task', 'manual_call', 'webhook', 'send_live_chat', 'send_review_request') group by 1, 2, 3 order by 1, 2;
-- G4 inbound links in use (calls this minute, last call), never the token
select h.automation_id, h.trigger_id, h.token_hint, h.window_count, h.last_used_at, h.revoked_at from public.automation_hooks h order by h.last_used_at desc nulls last limit 20;
```

### 11.2 Roll back

- Function: redeploy the G2.2 build (nothing in the database needs undoing for that).
- SQL: the commented ROLLBACK of PART 2 · G2.3 (one transaction) puts Part 1's `automation_apply` and
  `automation_capture_contacts` back byte for byte and drops the new functions. The app needs no change: it falls back to
  its whole-list save when the functions are missing (`PGRST202`). Roll back on any `capture_errors` growth, any "Could not
  save" report on tags or notes, or a G2 row with a cause on a card edit nobody's workflow made.


## 12. Phase 2 · G2.4 — the API, the guards on the doc, migration, the app adapter (SQL Part 2 · G2.4 + function + app)

What changes:
- **Function** (sections API and HOUSEKEEPING): the steps `save`, `publish`, `duplicate`, `validate`, `schema`, `registry`
  (now the stage-2 DTO: `v: 2`, GHL words, availability), `migrate` (owners only), `restore` (Draft only), `copy_version`;
  version snapshots (one per save whose name / doc / settings changed; always on publish / unpublish; never for a layout-only
  save); the 5 ready-made templates seeded by `migrate`; housekeeping instead of phase 4's prune once Part 1 is in (once a
  business day, `automation_prune` 1,000 rows a round, the cursor in `automation_state.housekeeping`: runs and log 180 days,
  events done 7 / error 30 days, versions ≤ 10 or ≤ 30 days and never more than 50) and the Needs-review sweep (each
  Published workflow checked again; problem codes in `list_summary.review`). An upgraded row whose doc is still a phase-4
  workflow with the upgraded settings runs **exactly as phase 4** (`wfRunRow`: its own phase-4 steps while the doc is
  unchanged, else the doc's steps via `wfToFlat`): the differential's `ev+mg` worlds (every row migrated, from the start
  / mid-way / then rolled back) and `doc only` worlds are IDENTICAL to phase 4.
- **SQL** (PART 2 · G2.4, one transaction): the guard v2 on `public.automations` (an insert is always a Draft; more
  customer / external steps while Published → Draft, also a paused or unconnected one; a new shape → version + 1 + re-arm;
  a filter / re-entry / time window change while Published → re-arm only (what waits goes on; on an UPGRADED row, still
  run as phase 4, any trigger change is a new version as in phase 4: what waits stops, "automation changed"); words → neither; a write of trigger / steps on an
  upgraded row is refused: "This workflow was upgraded: reload the app"), `automations_after` (a new version, a switch-off
  or a delete stops what waits at once: cancelled + exit row + its re-entry key), `automation_save` / `automation_publish`
  / `automation_migrate_row` (service role), the SQL shape / arm keys, Needs review with the sweep's codes. Phase 4's
  customer switch-off trigger is dropped (the guard v2 does it for both kinds of row).
- **App** (the old builder's adapter): it opens a workflow's doc as its phase-4 steps (`wfToFlat`; one with stage-2 steps
  is listed and switched but not opened), saves through `step: "save"` (`wfFromFlat`; a 409 says someone else saved), the
  switch is `step: "publish"`, and the "look now" check reads `automation_wanted` (once a minute) — `autoSyncEvents`
  (the settings copy) is gone. An EMPTY `automation_wanted` counts as "not known", never "nothing": in compat mode (step E
  not applied, or rolled back per 9.4, which empties it) the app still tells the phase-4 starts (new lead, stage, job
  closed) at once, as before. A switch-on asks the function first and shows its own words (what it sends to customers,
  where lead details go) before the yes; the editor publishes only when its switch was moved there, switches off BEFORE
  saving new content, and sends the revision it showed. Template words are still written by the app first (one
  settings write), as before.
- An inbound webhook call to a Published workflow while the event store is off (compat mode) is refused with 503 (the
  caller tries again) instead of piling up to act late when step E comes back.
- New workflows made in the old builder get GHL's settings (re-entry off: a lead goes through a workflow once); upgraded
  ones keep phase 4's (`legacy_always`).

### 12.1 Order (one step at a time; design §7 G2.4: backup definitions → deploy → Part 2 → migrate → app adapter push → verify)

1. `check_all.sh` ALL GREEN on the commit (automations section 34; app `testWorkflowAdapter`, `testAutomationEventsGate`;
   the differential IDENTICAL with the `ev+mg` / `doc only` worlds), and with the live export of section 3 (fresh):
   `run.sh --corpus <scratchpad>/live-automations.json --records <scratchpad>/live-records.json` → IDENTICAL.
   Phase-4 step ids that are not v2 ids (section 2 query): none expected (the app makes `s<n>`); any → they keep working
   while the phase-4 steps are stored (claims map back), but list them in MASTER §13. A `NOTE <name>: phase 4 runs it, but
   a save / switch-on needs this fixed first` line names a live row whose doc has an error (e.g. a deleted template): it
   keeps running as phase 4 did, but the old builder's save and the switch-on are refused until it is fixed — tell Ofek.
2. Staging: PART 2 · G2.4 (check-before → block → check-after), then `.claude/sql/stage2-part1-staging-checks.sql` →
   PASS 1 … 21 and `stage2 phase 2 · G2.4 staging checks done` (PASS 21 runs every `fixtures/shape.json` pair through the SQL
   keys). If the staging function exists: deploy this build there, call `migrate` once as the staging owner and save /
   publish one workflow from the localhost copy (stage 0) — network: `POST …/functions/v1/automations` `save` 200.
3. **Backup the definitions** (live, read-only; save the output as `.claude/backups/automations.before_stage2_<YYYY-MM-DD>.sql`):
   ```sql
   select string_agg(format('update public.automations set name = %L, enabled = %L, armed_at = %L, version = %s, audience = %L, trigger = %L::jsonb, steps = %L::jsonb, definition = %L::jsonb, settings = %L::jsonb where id = %L;',
            name, enabled, armed_at, version, audience, trigger, steps, definition, settings, id), E'\n' order by created_at)
     from public.automations where business_id = 'default';
   select status, count(*) from public.automation_runs where status in ('waiting', 'running') group by 1;   -- note
   ```
   Restoring these lines: either after the G2.4 ROLLBACK (under phase 4's guard, which takes `enabled` from the lines
   and recomputes `version` / `armed_at` / `audience`), or — while the guard v2 is on — with the guard bypassed
   explicitly, in ONE transaction (the guard v2 would otherwise keep the CURRENT enabled / armed_at / version /
   audience under the migration settings and silently ignore the backup's):
   ```sql
   begin;
   set local lock_timeout = '5s';
   alter table public.automations disable trigger automations_guard;
   -- the backup's update lines here
   alter table public.automations enable trigger automations_guard;
   commit;
   ```
   `automations_after` still fires: a line that switches a row off or changes its version stops what waits (as any
   switch-off). Compare `enabled` / `version` / `armed_at` with the backup afterwards.
4. **Deploy the function** (dashboard editor, Verify JWT OFF, fingerprint = the commit file). Safe before the SQL: nobody
   calls the new steps yet (the old app doesn't), and `wfRunRow` changes nothing while no row has a doc. Check: the next
   tick runs (W1); a call of `migrate` by a manager → 403 (owners only), `registry` by an owner → `"v":2`.
5. **SQL Part 2 · G2.4** (live): check-before, the block, check-after. Note the time = `:g24`. From now until step 7 the
   old app still writes directly: a new automation it makes is saved off (a Draft) — tell Ofek not to edit automations
   between steps 5 and 7 (≈ 15 minutes).
6. **Migrate** (Ofek, signed in as the owner, in the live app's browser console — the session is his, nothing is typed into
   a file):
   ```js
   const { data } = await sb.auth.getSession();
   await (await fetch(SUPABASE_URL + '/functions/v1/automations', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY,
     Authorization: 'Bearer ' + data.session.access_token }, body: JSON.stringify({ step: 'migrate' }) })).json();
   // → { ok: true, migrated: <rows>, left: 0, templates: 5, failed: [] }   (again → migrated 0, templates 0: idempotent)
   ```
   Then the migration check (design §8.3 #4), read-only:
   ```sql
   select count(*) filter (where definition is null) as left, count(*) as rows from public.automations;          -- left = 0
   select reason, count(*) from public.automation_versions group by 1;                                           -- migration = rows
   select status, count(*) from public.automation_runs where status in ('waiting', 'running') group by 1;        -- = step 3
   -- version / armed_at / enabled / audience unchanged: compare with the step-3 backup
   select id, name, version, armed_at, enabled, audience, revision from public.automations order by created_at;
   select v2_migrated_at, housekeeping from public.automation_state;
   ```
   and offline: export again WITH the doc (`select json_agg(a) from (select id, name, enabled, armed_at, version,
   created_by_name, trigger, steps, definition, settings from public.automations where business_id = 'default' order by
   created_at) a;` → `<scratchpad>/live-automations-after-migrate.json`), then
   `run.sh --corpus <scratchpad>/live-automations-after-migrate.json` → `migration check: N live rows with a doc; … : 0` and
   IDENTICAL; delete the export afterwards. The first tick after the migration starts no run for an old event (W5 / E1).
7. **App adapter push**: branch → live-origin check (MASTER §4): Settings → Automations: open a workflow (its steps show),
   change only words → Save (network: `POST …/functions/v1/automations` `{"step":"save"…}` 200, no new version in W3's
   sense, no waiting run stops); switch a team workflow off and on (`"step":"publish"`); a new automation is saved off;
   a stage move on a test lead calls `step: "event"` only when `automation_wanted` lists `stage`; no request to
   `settings` for `automationEvents`. Then fast-forward main.
8. Watch (read-only) for an hour, with section 6 (`:deploy` = `:g24`) and 9.3:

```sql
-- M1 the content writes since :g24 (save / publish / migration / restore …) and who
select reason, status, created_by_name, count(*) from public.automation_versions where created_at >= :g24 group by 1, 2, 3 order by 1;
-- M2 what the after trigger stopped (a new version, a switch-off, a delete) — each one a person's change
select r.exit_reason, a.name, count(*) from public.automation_runs r join public.automations a on a.id = r.automation_id
 where r.finished_at >= :g24 and r.exit_reason in ('automation_changed', 'switched_off', 'deleted') group by 1, 2 order by 3 desc;
-- M3 no phase-4 write was refused for a reason other than an old open tab ("reload the app" in the function / app logs)
-- M4 housekeeping ran today and finished; Needs review
select housekeeping from public.automation_state;                       -- {"day": today, "stage": "done", "pruned": {...}}
select * from public.automation_needs_review();                         -- as the owner (SQL editor: set role authenticated + claims) or via the app later
-- M5 rows with a doc that no longer run as phase 4 (edited with stage-2 settings / steps): expected none until the new builder
select id, name, settings ->> 'reentry' as reentry from public.automations where definition is not null and settings ->> 'reentry' <> 'legacy_always';
```

### 12.2 Roll back

In THIS order (an adapter save writes only the doc: an edited row's `trigger` / `steps` are stale, and an older build
that reads them — R-A always — would run the old words until those rows are off):

1. **SQL step 1, with the stage-2 build still deployed**: the commented ROLLBACK of PART 2 · G2.4 — first its read-only
   list (rows made in stage 2: no trigger; edited after the migration: a later revision than the 'migration' version, or
   changed after `v2_migrated_at`); keep the output; then its step-1 transaction: those rows switched off (this build
   stops their waiting runs at once). Check: the list with `and a.enabled` → no rows. Tell Ofek not to switch anything on.
2. **Function**: the G2.3 build (or the rollback build, section 7 R-A). **App**: back to the commit before the adapter
   (its old editor writes `trigger` / `steps` itself again).
3. **SQL step 3** (one transaction): phase 4's guard and its customer switch-off trigger back byte for byte, Part 1's
   Needs review back, the G2.4 functions dropped. The docs stay in `definition` (phase 4 never reads it).
4. Switch the listed rows on again only after checking each one's phase-4 steps (or re-make them in the old builder).
- Roll back on: any customer message the watch (W3 / W6) can't explain, a waiting run stopped that nobody changed (M2), a
  migration check difference, "reload the app" refusals after the app push, or a save / switch error in the app.

## 13. Phase 3 · G3.1 — the Automation page (list) and the list's counts per channel (SQL Part 3 · G3.1 + app)

What changes:
- **App**: Settings → **Automation** (Ofek's Q1: inside Settings) replaces "Message templates & Automations" and
  "Notifications": tabs Workflows | Global Workflow Settings | Message templates. Old links and saved pages
  (`?page=notifications`, `?page=templates`) open it (a `templates` link on its Message templates tab). The Workflows list:
  cards (default) or the GHL table (remembered per device), folders with a breadcrumb, All workflows / Needs review (N) /
  Deleted, Search, paging (10 / 25 / 50), the ⋮ menu in GHL's order (greyed items say why), Draft ⬤ Publish through the
  function's `publish` (customer / outside-system workflows ask first), Duplicate (`duplicate`: a Draft copy), Delete =
  Deleted for 30 days as a Draft (type the name), Restore (a Draft), Move to folder (cycles and a 6th level refused),
  bulk Publish / Draft / Move / Delete with a plan (what goes, what asks with an unticked "I checked its words and
  timing", what is skipped and why; ≤ 200 at a time). The built-in System rows show as cards with their own switches.
  New deep links: `?tab=settings&page=automation&wf=<id>&wfTab=…&listTab=…` (`wfLink`; the engine has the same, tested
  against `supabase/functions/automations/fixtures/links.json`). In Presentation mode / View as only the reads in
  `READ_ONLY_CALLS` reach the database or the function (the list counts and the registry); every write says why not.
- **SQL** (PART 3 · G3.1, one transaction, additive): `automation_list_stats` gains `ch` per workflow ("channel:status" →
  count over the action rows since `p_since`); the rest of its object is unchanged. The table's "Stats ›" reads it; until
  it is applied the accordion says "Counts per channel come with the next database update".
- Customer guard rails unchanged: nothing here switches a customer workflow on by itself (the function's `publish` and the
  guard decide, the app only asks first); a duplicate is always a Draft; a deleted workflow is a Draft at once (guard v2).

### 13.1 Order (one step at a time)

1. `check_all.sh` ALL GREEN on the commit (app: `testWfList`; read-only: the READ_ONLY_CALLS checks; automations: the
   `wfLink` parity block).
2. Staging: PART 3 · G3.1 (check-before → block → check-after), then `.claude/sql/stage2-part1-staging-checks.sql` →
   PASS 1 … 22 and `stage2 phase 3 · G3.1 staging checks done`.
3. Live: PART 3 · G3.1 (check-before → block → check-after: the same ids and numbers as before, each with `ch`).
4. App: branch → the live-origin browser check (MASTER §4): Settings → Automation, all three tabs, cards and table, a
   folder, Needs review, Deleted, the ⋮ menu, the bulk window, Search keeps its caret, idle `__rc = 0`; phone 375×812 (no
   page-wide scroll: the table scrolls in its own box, the ⋮ menu is a sheet from the bottom) and 768 px; dark and light;
   old `?page=notifications` / `?page=templates` links land on Automation; Presentation mode: the list and its counts
   load, every switch / menu write says "Presentation mode …". Then fast-forward main.

### 13.2 Roll back

- **App**: back to the commit before G3.1 (the two old pages return; nothing in the data changed shape: folders, deleted
  rows and the System folders stay where they are; the old list hides deleted rows as before).
- **SQL**: the commented ROLLBACK of PART 3 · G3.1 (the Part 1 definition back, byte for byte). The app without `ch`
  shows "—" and the note.
- Roll back on: the list not loading for an owner or manager, a switch / bulk action changing a row it did not list, or
  any idle redraw on the page.

## 14. Phase 3 · G3.2 — Global Workflow Settings and the Message templates tab's links (app only; SQL Part 3 · G3.2 = checks)

What changes:
- **App**: Settings → Automation → **Global Workflow Settings** gets GHL's cards in GHL's order, each with its own Save
  (saving one card never touches another's draft):
  - **Notifications** — "Phone notification" (Ofek's Q7: at most once a day, a phone alert to the selected users when
    workflows have errors; nothing saved = on, to every owner), "Email notification" + "Other email addresses" (≤ 10)
    greyed "Needs a team email sender" until the registry says the business has one, "Select users" (owners and managers).
    Stored in `automation_settings.error_notify` (Part 1's CHECK). The engine sends the alert from G6.1: until its registry
    says `features.errorDigest = true` the card says "Phone alerts start with the next engine update".
  - **Pause workflow** — rows Start date and time → End date and time (business wall clock), Select workflows (Published
    engine workflows; built-in System rows greyed "Runs on the built-in system until it moves into the engine"), Annually,
    copy, delete, "+ Add date", "Pause dates: n / 15", GHL's two notes. Problems show on the row before Save in the
    trigger's own words (`wfPauseProblems`); `automation_pauses_guard` stays the authority. Save writes removed rows,
    then changed ones, then new ones (a write refused only because another one of the same Save had not happened yet is
    tried once more); whatever is still refused is said and the pause dates are read again.
  - **Default builder** (Standard; Advanced greyed until phase 5; "Who can switch between builders" greyed), **Workflow
    AI** (greyed "Coming with Workflow AI"; stores nothing), **Customer message safety** (moved unchanged) and **Auto
    save** (greyed "We keep Save with undo").
  - The Workflows list's "Paused until …" now follows the engine's own rule in the business's zone (`wfPausedInfo` =
    `pauseUntil`), also for a pause starting inside a daylight-saving jump.
  - **Message templates** tab: "Sent by <workflow>" opens it on the Automation page (`openAutomation`), with the list's
    status pills (Published / Draft / Paused until … / a System row's gate); "used by" also counts workflows of the new
    builder (`wfTplUsers`: a doc node's `config.templateKey`), so a template such a workflow uses can't be deleted.
- **Engine** (with the next automations deploy; nothing in it changes what runs today): `wallMs` (pause dates) uses
  `bizToUtc` like the app (a start inside a daylight-saving jump = the time after it); the registry gains
  `features: { errorDigest: false }`. The offline differential stays IDENTICAL.
- **SQL**: PART 3 · G3.2 is read-only checks (no schema change). Staging check "PASS 23" proves the pause rules
  (overlap, 15 dates, 15 days, end after start, real dates, deleted / unknown workflows, annual across New Year,
  29 February) and the targeted wake.
- Customer guard rails unchanged: no card switches a workflow on; a pause only holds actions (customer messages held by
  it still keep the customer hours and the daily cap after it ends).

### 14.1 Order (one step at a time)

1. `check_all.sh` ALL GREEN (app: `testWfGlobalSettings`; read-only: the three Saves and `wfGsDraft` check the mode;
   automations: block 36 = `fixtures/global-settings.json`, the staging file has PASS 23).
2. Staging: PART 3 · G3.2 "check before" lines all true, then `.claude/sql/stage2-part1-staging-checks.sql` → PASS 1 … 23
   and `stage2 phase 3 · G3.2 staging checks done`.
3. Live: the same "check before" lines (read-only).
4. App: branch → the live-origin browser check (MASTER §4): Settings → Automation → Global Workflow Settings: every card
   loads; Notifications: tick / untick a user, Save, reload → kept (then put back); Pause workflow: + Add date, an
   overlapping second row shows the overlap note and Save stays greyed, Cancel; a valid date on a Draft test workflow →
   Save → the list shows "Paused until …" only for Published ones → delete it → Save; Default builder / Workflow AI /
   Auto save greyed with their words; Message templates: a "Sent by" link opens the Automation page; idle `__rc = 0`;
   phone 375×812 (the two dates stack, chips wrap, no page-wide scroll) and 768 px; dark and light; Presentation mode:
   every input locked, every Save says "Presentation mode …". Then fast-forward main.
5. Automations function (with the next engine deploy, dashboard editor + fingerprint): `wallMs` + `features`.

### 14.2 Roll back

- **App**: back to the commit before G3.2 (the tab shows only Customer message safety again; saved `error_notify`,
  `default_builder` and pause dates stay in the database and keep working in the engine).
- **SQL**: nothing to undo (PART 3 · G3.2 changed nothing). Saved settings can be put back with the two commented lines
  under its ROLLBACK, only if asked.
- **Engine**: the previous function build (pause dates inside a daylight-saving jump then start up to an hour earlier,
  as before).
- Roll back on: a card not loading for an owner or manager, a Save writing to another card, a pause that holds a
  workflow it doesn't list, or any idle redraw.

## 15. Phase 3 · G3.3 — System rows, the template library, the Notifications page merged in (app + engine steps; SQL Part 3 · G3.3 = checks)

What changes:
- **App**: Settings → Automation → Workflows becomes the one place for the notifications too (Ofek's Q1):
  - **System rows** (`wfSystemRows`, the old `autoReadyRows` kept as an alias until phase 7): the same 11 ready-made rows
    with the same switch, gate and lock (pinned by `fixtures/system-rows.json`, taken from the phase-4 code), plus
    System / virtual, a stage-2 doc (`wfFromFlat`), their folder (`automation_system_meta`), `movable` (false: nothing
    moves before phase 7) and `movedTo`. Each card's summary is its steps in one sentence (`flowSentence`; no canvas yet).
  - The 8 **team notification cards** are System cards in the list with their old controls kept (the numbers in the
    sentence, Office, Send a test — each through its old setter) plus the list's tick, ⋮ and Draft ⬤ Publish.
  - **Notifications page and the old "Message templates & Automations" list are removed** (old `?page=notifications` /
    `templates` links already land on Automation since G3.1). "New team alert" = "+ Create workflow → Select from
    template → Team notifications".
  - **Phone bar** on top of Workflows only while a System team notification is on or a Published workflow sends a phone
    notification; the device check redraws only while Workflows shows.
  - **Template library** ("+ Create workflow → Select from template"): chips All, Leads, Jobs, Customers, Team
    notifications, Reviews, Mine; search; cards with "Uses", Preview (one sentence) and "Choose template" (→ a **Draft**
    copy through the function's `duplicate`, opened in the editor). Greyed with the reason when a start or step isn't
    available yet, and "Opens in the new builder (phase 4)" when its steps branch. Mine: Rename / Delete in place.
    ⋮ → "Upload to Template Library" on a workflow (name, description, category).
  - Taking System rows off the list (a row's Delete, bulk Delete, the old editor's "Remove from my list") is one plan
    (`wfSystemHidePlan`) and ONE catalog write.
  - A System setter that asks first (the review request's go-live switch) redraws the open editor again (restored on the
    new page).
- **Engine** (next automations deploy): steps `template_upload`, `template_rename`, `template_delete` (owners and managers;
  only templates of origin user are renamed or deleted; a workflow with problems can't be uploaded). Nothing that runs
  changes; the offline differential stays IDENTICAL.
- **SQL**: PART 3 · G3.3 is read-only checks (no schema change). Staging "PASS 24" proves the template table's rules.
- Customer guard rails unchanged: nothing here switches a workflow on; a template always becomes a Draft.

### 15.1 Order (one step at a time)

1. `check_all.sh` ALL GREEN (app: `testWfSystemRows`, `testWfTemplatesWindow`; read-only: the library's writes check the
   mode, the app never writes `automation_templates`; automations: the template steps' tests).
2. Staging: PART 3 · G3.3 "check before" lines all true, then `.claude/sql/stage2-part1-staging-checks.sql` → PASS 1 … 24
   and `stage2 phase 3 · G3.3 staging checks done`.
3. Automations function first (dashboard editor + fingerprint): the template steps (the app's Upload / Rename / Delete
   say "unknown step" until then; Choose works with the function already live).
4. Live: the same "check before" lines (read-only).
5. App: branch → the live-origin browser check (MASTER §4): Workflows shows the 8 team cards with their numbers, Office
   and Send a test (change a number → saved, no jump; Office on / off; a test arrives); the phone bar shows while one is on;
   Select from template opens, chips and search work, Preview shows the sentence, the quote follow-up is greyed "Opens in
   the new builder (phase 4)", Choose on "Tell the team about a new lead" makes a Draft and opens it (then delete it);
   Upload a Draft test workflow → it is under Mine → Rename → Delete; a team card's ⋮ → Delete → it is in Deleted →
   Restore; idle `__rc = 0`; phone 375×812 (cards and the template window wrap, no page-wide scroll) and 768 px; dark and
   light; Presentation mode: every write says "Presentation mode …". Then fast-forward main.

### 15.2 Roll back

- **App**: back to the commit before G3.3 (the list shows the plain System rows again; nothing in the data changed
  shape: catalog.notify, hiddenReady and automation_system_meta are read the same way).
- **Engine**: the previous function build (the template steps answer "unknown step"; templates already uploaded stay).
- **SQL**: nothing to undo (PART 3 · G3.3 changed nothing). The business's own templates can be taken out with the
  commented line under its ROLLBACK, only if asked.
- Roll back on: a team card's number or switch saving to the wrong notification, a template making anything but a Draft,
  the phone bar redrawing in a loop, or any idle redraw.

## 16. Phase 3 · G3.5 — Ofek's answers Q5 + Q6 and quiet imports (SQL Part 3 · G3.5 + engine + app)

What changes:
- **Q5 — no "Quote status" trigger.** "Quote sent" = the lead moves to the Quoted stage, so a workflow uses **Pipeline
  stage changed** (to Quoted); the ready-made "Quote follow-up" template already does. The trigger is **removed** (not
  greyed): not in the registry, the picker, the filters or the capture; a doc that still names `estimates` is refused as
  an unknown type (none was ever published). The quote amount stays a lead field ("Quote amount", Lead changed sees it)
  and the `{quote_amount}` blank.
- **Q6 — the lead's "Assigned to".** `contacts.assigned_user_id` (→ profiles, on delete set null, indexed):
  - **App**: an "Assigned to" picker on the lead (CRM inbox details and the Full profile, under Stage), a column in the
    CRM table, and an "Assigned to" filter in the CRM filter bar (All leads (any assignee) / Assigned to someone / Assigned to me / Nobody assigned /
    each person) that the table, the pipeline board and the inbox all follow. Owners and managers pick anyone; everyone
    else only themselves or Nobody (the database says the same: `contacts_assignee_guard`). Each change writes one line
    on the lead's history ("Assigned to Max Manager" / "Assigned user removed"); it does not count as contacting the lead.
    The team's names come from `team_people()` (names only; a VA's own profile rules show only them). Until the SQL ran,
    the picker says "Comes with the next database update" and the column / filter are not shown.
  - **Engine**: Assign to user / Remove assigned user (a fixed person; automation_apply op `assign`, with the history
    line), the "Assigned to" filter, `{lead.assigned_to}` / `{lead.assigned_to_first_name}`, "Until a user replies: the
    assigned user" and "Lead changed: field assigned_user" are available (nothing greyed any more).
- **Quiet imports.** `import_quiet boolean not null default false` on contacts, jobs and tasks — **stage 5's columns**
  (`.claude/sql/stage5-mcp.sql` M5, live since 15 Oct 14:20: its MCP import writes them, its push function reads them).
  On live they already exist and G3.5's `add column if not exists` does nothing; G3.5 never drops them. A row written with `import_quiet = true` never starts an automation by arriving:
  - capture triggers: no event for its INSERT (tags, notes, booking, Task added) nor for the import's own updates — the
    update that turns `import_quiet` on, or any write of a transaction that says it is the import
    (`set_config('automation.import', 'on', true)` in an RPC, or the PostgREST request header `x-ops-import: 1`);
  - engine scans / timers: no new lead, website form, arrival stage (nor a stale lead in it), job closed or reminder of
    the job's imported date for it (G3.5 keeps that date in `jobs.import_quiet_date`, stage 2's own column, set by the
    trigger `jobs_import_quiet_date` on the import's writes; a person rescheduling the job starts its reminders);
  - a later change by a person (a tag, a field, a stage move, a reopen, marking paid) counts as usual.
  **Tell the import's builder:** write every imported row with `import_quiet = true`; a re-sync that updates rows already
  imported must send the `x-ops-import: 1` header (or run in an RPC that sets `automation.import`), else its changes
  count as a person's.
- Customer guard rails unchanged: nothing here switches a workflow on.

### 16.1 Order (one step at a time)

1. `check_all.sh` ALL GREEN (app: `testLeadAssignee`; read-only: the picker checks the mode; automations: section 37 —
   assign / remove through automation_apply, the blanks, quiet scans / timers / look now / capture, the SQL text and its
   exact ROLLBACK; the offline differential IDENTICAL).
2. Staging: PART 3 · G3.5 "check before" lines, then the block, then its "check after" lines; then
   `.claude/sql/stage2-part1-staging-checks.sql` → PASS 1 … 25 and `stage2 phase 3 · G3.5 staging checks done`.
3. Live: the same "check before" lines (read-only), then **SQL PART 3 · G3.5 first** (additive: the live app and function
   never read the new columns), then its "check after" lines.
4. Automations function (dashboard editor + fingerprint). It also works before step 3 (it reads again without the new
   columns), but run the SQL first.
5. App: branch → the live-origin browser check (MASTER §4): open a lead (inbox and Full profile) → Assigned to → pick a
   person → the CRM table column shows them, a history line is there, the filter "Assigned to me" / a person / "Nobody
   assigned" narrows the table, the pipeline and the inbox; as a VA (View as is read-only, so a real VA login on staging)
   only "Nobody" and themselves can be picked; Presentation mode: the picker says "Presentation mode …"; idle `__rc = 0`;
   phone 375×812 (the filter folds under Filters, the table scrolls inside its box, no page-wide scroll) and 768 px; dark
   and light. Then fast-forward main.

### 16.2 Roll back

- **App**: back to the commit before G3.5 (no picker, column or filter; the column is simply not read).
- **Engine**: the previous function build (Assign to user greyed again; nothing else reads the new columns).
- **SQL**: the ROLLBACK under PART 3 · G3.5 (G2.3's automation_apply / contacts capture and Part 1's tasks / jobs
  captures back byte for byte; the guard, `team_people`, `automation_import_write`, `jobs_import_quiet_date`, the index, `assigned_user_id` and
  `jobs.import_quiet_date` go;
  **`import_quiet` stays** — it is stage 5's, and stage 5's import and push function and the engine's quiet-import
  drops keep reading it). Save who each lead was assigned to first (the commented line there).
- Roll back on: a lead's save refused for anyone who is not changing Assigned to, an imported row starting an
  automation, the capture error counter (`automation_state.capture_errors`) rising after the SQL, or any idle redraw.

## 17. Phase 3 · G3.4 — the lock on direct writes (SQL PART 3 · G3.4) and the whole Part-3 live order

What changes:
- **SQL** (PART 3 · G3.4, one transaction, idempotent, the LAST block of Part 3):
  - the app's roles (`anon`, `authenticated`) lose INSERT / UPDATE / DELETE / TRUNCATE / REFERENCES / TRIGGER on
    `public.automations`; `authenticated` gets UPDATE on exactly four columns: `name, description, folder_id,
    deleted_at` (rename, Move to folder, Delete to Deleted, Restore). Switching on / off (Publish / Draft), the doc,
    settings, a new workflow and a copy go only through the automations function (service role) and its checks. A
    column revoke would do nothing under a table grant, hence the table revoke + column grants (design E4/E34).
  - the policy "automations: owners and managers delete" is dropped (a hard delete is housekeeping's only, 30 days after
    the soft delete; never a System row) — design E54/P5.
  - the read / change policies are scoped to this business (`business_id = current_business_id()`; today every row is
    'default', so nobody sees anything different).
  - Part 1's pin (`automations_v2_pin`, the app's roles only) also stamps a soft delete with now() (a hand-made back-dated
    `deleted_at` can't skip the 30 days; a deleted row's date never moves) and refuses a folder of another business.
  - checks before stop the block (Part 2 · G2.4 missing, unexpected column grants, policies that are not phase 4's); a
    proof inside the transaction rolls everything back if the lock did not take; the previous table grants are saved in
    `backup.automations_grants_before_part3` for the exact ROLLBACK.
- **App / engine**: nothing new to deploy for G3.4 itself. The G3.1+ app writes the automations table only through those
  four columns (tests/read-only.test.js `testAutomationsLock` scans every write); the one write that was outside them —
  the old editor's `template_key` on a copy of a ready-made — now goes with the function's `save` (`template_key`, kept
  on a new workflow only; automations tests "save: template_key kept on a new one"). So the function with that change
  must be live before G3.4.
- **Old cached tabs** (opened before the G3.1 app went live): Postgres checks privileges before any trigger, so they no
  longer reach the guard's "This workflow was upgraded: reload the app". Their switch / save / delete shows "Not saved:
  permission denied for table automations" (a phase-2 tab: "Not deleted: …") and nothing changes; a reload fixes it.
  That is why G3.4 runs last and only after the new app has been live for a while.
- Customer guard rails unchanged: nothing here switches anything on; the function's publish and the guard still decide.

### 17.1 Order — the whole of Part 3, live (one step at a time; staging first for each SQL block)

1. `check_all.sh` ALL GREEN on the commit (read-only: `testAutomationsLock`; automations: the template_key save test, the
   staging-check count 26; the offline differential IDENTICAL).
2. Staging, in this order: PART 3 · G3.5 → PART 3 · G3.1 → the G3.2 / G3.3 "check before" lines → PART 3 · G3.4 (check
   before → block → check after), then `.claude/sql/stage2-part1-staging-checks.sql` → PASS 1 … 26 (checks 12 and 19
   print "NOTE 12: PART 3 · G3.4 is applied …" and "NOTE 19: PART 3 · G3.4 is applied …") and `stage2 phase 3 · G3.4 staging checks done`. On staging also: sign in as
   the owner in the staging app (G3.1+ build) → rename, move, Delete, Restore, Publish / Draft a test workflow → all work.
3. Live: **PART 3 · G3.5 first** (additive; §16.1 step 3).
4. Live: **PART 3 · G3.1** (additive; §13.1 step 3).
5. Live: the G3.2 and G3.3 "check before" lines (read-only; §14.1, §15.1).
6. **Automations function** (dashboard editor + fingerprint) with G3.1–G3.5 (incl. `template_key` on save).
7. **App** (G3.1 … G3.5): branch → the live-origin browser check of §13.1 / §14.1 / §15.1 / §16.1 → fast-forward main.
8. Wait **≥ 24 h** with the new app live. Ask Ofek and Noam to reload every open tab of the app (phone and computer).
   Read-only check that nothing odd is writing the table directly meanwhile:
   `select id, name, updated_at, updated_by_name from public.automations where updated_at > now() - interval '24 hours' order by updated_at desc;`
   (each change should be one somebody made in the new app or through the function).
9. Live: **PART 3 · G3.4** — its "check before" lines (read-only, note the output: the grants and the three phase-4
   policies), then the block, then its "check after" lines (every line as written there; the RLS-proof query of every
   stage-2 table shows the expected pattern).
10. Right after: in the live app as an owner, rename a test Draft, move it into a folder and back, Delete it (it shows in
    Deleted), Restore it, switch a team workflow Publish → Draft → back (through the function) — all work; idle `__rc = 0`.

### 17.2 Roll back

- **SQL**: the commented ROLLBACK under PART 3 · G3.4 (one transaction): the four column grants go, the saved table
  grants come back from `backup.automations_grants_before_part3` (checked equal before the backup is dropped), phase 4's
  delete / read / change policies and Part 1's pin come back word for word. Then its "check after the rollback" lines.
- **App / engine**: nothing to roll back for G3.4 (the G3.1+ app and the function work the same with or without the lock).
  Roll the SQL back only to let an older app write again (e.g. the app itself is rolled back past G3.1).
- Roll back on: an owner or manager unable to rename / move / delete / restore in the new app, the function's save or
  publish failing with a permission error (it would mean the service role lost a grant — the block's proof checks it),
  or the lead card / any other page failing after the block.

## 18. Phase 4 · G4.2 — the builder's shell, paint, canvas and gestures (app only; no SQL)

What changes:
- **App**: a new root `#wf-root` (between `#app` and `#modal-root`) holds the Standard builder's frame: the top bar
  ("← Workflows list", panel toggle, the name ✎, Recent changes, ↶ ↷, Save / Saved), the second bar (Standard builder ▾,
  "Builder · Settings · Enrollment history · Execution logs", Test workflow, Draft ⬤ Publish), the left rail (Notes,
  Errors with its count, Stats view, Sticky notes, Workflow switcher, Find and replace, Version history, Workflow AI),
  the canvas (trigger cards, "Add New Trigger", step cards, branch headers, END, Go to jump pills, a "+" and Quick paste
  per place), the zoom stack (hand · + · % · − · fit), the K overlay, "+ Add ▾", the minimap (≥ 900 px) and the mode pill.
  Its own paint (`wfDirty` → one frame → `wfPaint`; `window.__wfp` counts paints, `__wfPaintReentry` stays 0), its own
  keys (capture listener while open), gestures (pan, pinch, drag a step onto a "+", minimap, drawer width), the step's
  "Actions" menu (Notes, Copy, Paste below, Move, Disable, Delete; Q4 "Keep which path?"), move mode (arrows + Enter, or a
  tap: the phone's way, Q3), undo (100 steps, Undo on every delete toast), the tree for screen readers, the phone shell
  (375 px: back / name / ⋯ / Save, tabs + Publish, Tools sheet, no drag handles, no minimap). New `--wf-*` tokens in the
  three token blocks (contrast tested). The app's own Esc and ⌘K step aside while it is open; `render()` asks it first
  (`wfAppDataChanged`: signed out / another profile → it closes).
- Nothing opens it yet: G4.4 wires "Edit workflow" on the list. Pickers / the step drawer (G4.3), the rail panels, Save,
  Publish and the leave guard (G4.4) and the other tabs (phase 6) plug into `WF_HOOKS`; until then their buttons are
  greyed "Comes with the next part of the builder". Stage 4's page history plugs into `wfNavHooks` (no-ops now).
- **SQL / engine**: none.

### 18.1 Order (with phase 4's live push, after G4.3 and G4.4)

1. `check_all.sh` ALL GREEN (app: `testWfShellPure`, `testWfShellWords`, `testWfShellTokens`, `testWfShellStatic`,
   `testWfShellRuntime` — the fake-DOM run: one paint on open, no frame while idle, a selection / pan patches only what
   changed, an edit rewrites one card, 200 steps open < 150 ms and pan < 4 ms, closing removes every listener).
2. App: branch → the live-origin browser check (MASTER §4) with the builder opened on the empty, a migrated, a System and
   the 50 / 200-step fixtures (document.write, presentation mode): `window.__wfp = 0`, wait 3 s → still 0 and `__rc = 0`;
   hover across 50 cards → `__wfp` unchanged; `__wfPaintReentry = 0`; Performance panel: open 200 steps < 150 ms, a
   scripted pan / zoom / drag with no long task > 50 ms and < 4 ms a frame; keyboard only (Tab reaches the canvas once,
   arrows walk it, Enter / Shift+F10 / M / Delete / ⌘Z, K shows the keys, Esc closes each layer); phone 375×812 (no
   sideways scroll, one finger pans, two pinch, long-press opens the menu, Move action → "Move here" works) and 768 px;
   dark and light; reduced motion (fit / zoom jump); the phone widget sits above the minimap. Then fast-forward main.

### 18.2 Roll back

- **App**: back to the commit before phase 4 (the list's "Edit workflow" opens the phase-4 editor again; nothing was
  saved by the shell itself — saving is G4.4's).
- Roll back on: any idle repaint (`__wfp` rising with nothing happening), the app behind staying inert after closing, the
  list's ⋯ menu or any other page losing a key or Esc, or a page-wide sideways scroll on a phone.

## 19. Phase 4 · G4.3 — the pickers, the step drawer and its forms (app only; no SQL)

What changes:
- **App**: the "+", "+ Add ▾", "Add New Trigger", A / T open the right panel's picker — "Actions" / "Add trigger", "Search
  actions" / "Search triggers", tabs "Actions | Apps" / "Triggers | Apps", Recent, Pinned, then GHL's categories. A greyed row
  says why on a second line and on click, including the "+"'s own reasons ("Go to must be the last step of its path", "Not
  available for the Scheduler trigger", "Only owners can add a webhook"). Q5: there is no quote trigger anywhere (a search for
  "estimates" / "quote sent" finds Pipeline stage changed; the stage trigger's drawer says "a quote is sent when the lead
  moves to the Quoted stage"). Q6: Assign to user / Remove assigned user are offered.
- Picking opens the **step drawer** on a NEW step: nothing is added until "Save action" / "Save trigger" (GHL). A step or a
  trigger clicked opens the same drawer: ^ / v (reading order), "Learn more", expand, ×; "Action name" / "CHOOSE A WORKFLOW
  TRIGGER" + "WORKFLOW TRIGGER NAME" + "FILTERS" (⊕ Add filters); the step's own problems on top; footer "Delete" | "Cancel" |
  "Save action". The drawer edits a draft: typing never repaints (Save, counters, the Split total and the message preview
  are patched in place), Save = ONE undo entry, Cancel / × / Esc with changes asks "Discard changes?", undo is refused while
  the drawer has typing in it, a step deleted under it closes it. Per kind: If / else (SCENARIO RECIPE "Build Your Own",
  BRANCHES with name + counter, Duplicate / Delete, "+ Add Branch" ≤ 10, "Reorder Branches", AND / OR rows, "+ Add Segment",
  the None Branch "When no condition is met"); Wait ("Selected wait type" + "Change type" → "How do you want to wait?", "✦ Set
  up with AI" greyed, the eight cards with "Ex:" lines, "Until the lead replies" first after a message; "Time period" with
  its ⋮ greyed "Dynamic values come later", "Advance window", Timeout switches); Split ("Distribution Type: Random Split",
  2–5 paths, % steppers, "Total 100%"); Goal ("Select type of goal", "End this workflow / Continue anyway / Wait until the
  goal is met"); Go to ("Go to step" in reading order + "Pick on canvas"); messages (written here or a saved template, "+
  Write a new one", "Copy a built-in message…", "What the lead gets"); notifications (who chips + "On their phone"); tasks.
  Q4: the drawer's Delete on a step with branches asks "Keep which path?"; removing a branch, a timeout or a wait type
  whose path still has steps asks "Delete the N steps on the … path?" before the same Save.
- **People on vacation** (stage 3 + Q6): the lead card's "Assigned to" greys whoever is away today with "Not assignable"
  ticked ("Name · On vacation until …"); picking them asks "Assign anyway?" with "Assign <stand-in> instead" (only when the
  stand-in has a login and you may assign to them). The builder's Assign to user, notification chips and "Until a user
  replies" people say the same.
- The old editor's widgets (message template list / words / name / new key, who chips, task fields, wait and window fields,
  the preview) now take the template drafts and their bindings as parameters; without them they behave as before.
- **SQL / engine**: none.

### 19.1 Order (with phase 4's live push, after G4.4)

1. `check_all.sh` ALL GREEN (app: `testWfPickDrawerPure`, `testWfPickDrawerWords`, `testWfPickDrawerRuntime` — pick → drawer →
   typing with no paint → Save as one undo entry → undo; a branch added; a branch with steps asked then dropped in one edit;
   a dirty drawer refusing undo and asking before closing; a trigger with a filter; read-only drawers; idle = no paint).
2. App: branch → the live-origin browser check (MASTER §4): every action / trigger picked once (greyed ones say why), each
   drawer kind saved and undone, typing in a long message (focus stays, no paint while typing: `__wfp` unchanged), Esc / Cancel
   with changes, Pick on canvas, Delete on an If / else (Keep which path?), a lead's Assigned to with someone on vacation
   (warn + stand-in); phone 375×812 (picker and drawer as bottom sheets, no sideways scroll) and 768 px; dark and light.

### 19.2 Roll back

- **App**: back to the commit before G4.3 (the "+" and the cards say "Comes with the next part of the builder" again; nothing
  is written by the drawer itself — Save to the server is G4.4's).
- Roll back on: typing in the drawer losing focus or repainting, a Save that is more than one undo entry, a picker row that
  adds something greyed, or the lead card's Assigned to failing to save.

## 20. Phase 4 · G4.4 — the rail, Save, undo, leaving, Publish and opening from the list (app + function; no new SQL)

What changes:
- **App — opening**: the list's "Edit" / the card's name / "Edit workflow", a link's `?wf=…`, Duplicate, "Start from scratch"
  and "Select from template" (branching templates too) now open the **new builder** (`wfEdit` reads the row's doc and
  revision). A System row opens **read-only** with the yellow "System workflow · view only" pill and the banner "System
  workflow · runs on the built-in system" + "Duplicate to edit" (an unsaved copy; built-in words copied into templates of
  the business's own) + "Open its old settings" (rows with a page) + "Move into the engine" (greyed with the reason). The
  old editor stays only for a rollback: `localStorage.setItem('ops.wfOldEditor', '1')` in that browser (and `removeItem`
  to go back).
- **App — Save** (button / ⌘S): through the function only. A Published workflow is checked first (step `validate`):
  "Start it afresh?" (N leads waiting will be stopped), "It only acts on what happens after you save", a new customer
  step or Workflow AI's change → "Save as a Draft?"; a Published one with errors is refused ("Fix the errors first: this
  workflow is published", Errors opens). 409 → "This workflow was changed by <name> at <time>." with Load their version /
  Save mine as a copy / Cancel. A new one is inserted on its first Save only (template_key, its folder, its template words
  → the catalog). Every save says `editor: "builder"` (see Function below). Toast: "Workflow has been saved."
- **App — Publish** (Draft ⬤ Publish): read-only views and Presentation mode refuse with the reason; errors → "Workflow
  can't be published yet" + Review issues (opens Errors); a pause → greyed "Paused until … (Global Workflow Settings)";
  unsaved → "Save and publish?"; then **the phase-3 check (`wfPublishFix`: the old editor's blocks for a row the new
  builder never saved — customer safety, unchanged)**, the customer / System questions (`wfPublishAsk`), then the function's
  publish (which checks everything again, 409 "confirm" asked again). Draft is immediate.
- **App — the rail**: Notes (⇧C; workflow and step notes in `automation_notes`: Created by / on, Edited by / on, search,
  Edit / Delete for the author or an owner; "Save the workflow first", "Save first to add notes to a new step"; the cards
  show their count), Errors (⌘⇧E; this device's check + the server's `validate`, grouped by step with "Open step", "How
  to fix" greyed "Coming with Workflow AI", "No errors found. All good.", the red count), Sticky notes (⇧S; beside a step,
  markdown-lite, GHL's colours, Show / Hide; a deleted step's notes move to the step above it in the same undo entry),
  Workflow switcher (⇧W; search, Recent, "+", Open in new tab, ⋮ Duplicate / Delete; asks first when unsaved), Find and
  replace (⌥F; Text / Tags / Custom values, Previous / Next pans to each, Replace / Replace All for Tags and Custom values
  only, shared templates "not changed"). Stats view and Version history stay greyed (phase 6); Workflow AI greyed (hook
  `wfAiApply`: its changes are one undo entry and save a Published workflow as a Draft).
- **App — undo / leaving**: "Recent changes" (this session's changes with times; pick one to go back to just after it).
  Unsaved work is written to this device 1.5 s after each change (`wf.draft.<business>.<id|new>.<tab>`, skipped above
  1 MB) and offered back on opening ("Unsaved changes found": Restore / Discard, or "Restore as a copy" when the workflow
  was saved since); Save and Discard clear it. Leaving (← Workflows list, the switcher) with unsaved changes asks Save /
  Discard / Cancel; closing the tab writes the draft and shows the browser's own prompt; signing out keeps it.
- **Function (automations)**: step `save` with `editor: "builder"` stores `layout.editor = "builder"`; a save without a
  layout (the old editor's) takes it off; `v1EditorView` returns null for a row with the mark, so **publish judges a
  workflow the new builder saved last by the v2 checks only** (a 25-step workflow made in the builder is no longer refused
  "At most 20 steps."); a phase-4 row saved by the old editor keeps its old blocks (`E_EDITOR_BLOCK`). The app's
  `wfPublishBlock` / `toggleAutomation` follow the same mark (`autoNormalize(...).builderMade`).
- **SQL**: none (PART 3 · G4.4 in `stage2-automations.sql` is read-only checks; staging check 27 = the notes as owner /
  manager / VA).

### 20.1 Order (phase 4's live push: G4.1–G4.4 together)

1. `check_all.sh` ALL GREEN (engine: "editor mark" cases in test 38; app: `testWfRailPure`, `testWfRailWords`,
   `testWfSaveRuntime` — the fake-DOM write path against a fake function with revision 409 semantics and a fake notes
   table; the template window's Choose → builder).
2. Staging: the PART 3 · G4.4 "check before" lines; `stage2-part1-staging-checks.sql` → "PASS 27".
3. Function: deploy `automations` (dashboard editor + fingerprint, as before) BEFORE the app — the old app never sends
   `editor`, so nothing changes for it.
4. App: build the harness (`node .claude/builder-harness/build.js`), serve the repo root (`python3 -m http.server 8743`),
   open `/.claude/builder-harness/`, run `await __wfClickThrough()` in the console → "N passed, 0 failed" (Edit opens the
   new builder, Save + revision, 409 + Save mine as a copy, the publish gate + Review issues, customer publish with the
   yes, Workflow AI → Draft, 25 steps publish, a note, template words into the catalog, the local draft offered back,
   leave → Discard, System → Duplicate to edit, idle 3 s). Then the live-origin browser check (MASTER §4) as in §18.1 and
   §19.1 plus: Notes / Errors / Sticky notes / Switcher / Find on 375×812 (bottom sheets, no sideways scroll) and 768 px,
   dark and light; Presentation mode (Save / Publish / notes greyed with the reason, editing still local). Then
   fast-forward main.

### 20.2 Roll back

- **App**: back to the commit before phase 4 (the list's Edit opens the old editor again). Or, per browser, without a
  deploy: `localStorage.setItem('ops.wfOldEditor', '1')` → Edit / Create / templates / System Duplicate use the old editor.
  Rows the builder saved keep `layout.editor = "builder"` (judged by the v2 checks, as made); the old editor's save takes
  the mark off. To take every mark off at once: PART 3 · G4.4's ROLLBACK lines.
- **Function**: redeploy the previous build (the mark is then ignored: the old editor's blocks apply to every straight
  workflow again, as in phase 3).
- Roll back on: a Save that loses changes or saves over someone else's (no 409), a Publish that skips the customer
  question or the phase-3 check, a builder that repaints while idle, a draft offered for the wrong workflow, or notes
  visible to a VA / technician.
