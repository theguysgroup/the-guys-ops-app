# Stage 2 phase 1 — live deploy runbook (SQL Part 1 + the v2 function in compat mode)

For the MAIN BUILDER. Design: `.claude/plans/stage2-design.md` §3.16, §7 Phase 1 (G1.4), §8.2, §8.3. Nothing in this file has
been run: every step below is done by the main builder (with Ofek's OK where the rules or the safety classifier ask for it).
Every SQL here is read-only except step 5 (Part 1 itself, in `.claude/sql/stage2-automations.sql`) and the rollback steps.

What goes live in phase 1 (and nothing more):

| piece | file | effect |
|---|---|---|
| SQL Part 1 | `.claude/sql/stage2-automations.sql`, section PART 1 | additive: new tables/columns (all with defaults), the `automation_log_once` → `automation_log_action_once` swap together with `automation_claim_customer_v2` and the phase-4 `automation_claim_customer` as a wrapper (one transaction), silent capture triggers, RPCs, RLS, indexes. The phase-4 function keeps working on it. |
| the v2 function | `supabase/functions/automations/index.ts` (pasted into the existing `automations` function) | **compat mode**: the phase-4 scanners + `enqueue` start the runs exactly as today (same five event-key formats); every claimed run is executed by `advanceV2` (a phase-4 row read through `upgradeV1`, phase-4 step ids kept in every log row, claim and window mark). Before Part 1 is in, the same build runs phase 4's own `advance` (it reads `automation_state.phase4_compat`; a missing column = phase-4 executor), so a wrong order is safe. |
| the rollback build (prepared, NOT deployed) | `supabase/functions/automations-phase4-compat/index.ts` | the phase-4 function of commit 7ae5b19 + 2 code edits (action-rows-only "already done" check, readable on both schemas; soft delete = delete) + a header. **Never deploy this folder by name.** It is pasted into `automations` only for a rollback. |

The function log says which engine runs, once per instance and on every change:
`automations engine: v2 executor in compat mode (phase-4 scanners + enqueue, runs by advanceV2)` — or, before Part 1,
`automations engine: phase-4 executor (stage 2 SQL Part 1 not applied yet)`.

---

## 0. Preconditions (all must hold; otherwise stop)

1. **Stage 1 is live** (MASTER §13): `round3-stage1.sql` applied and the stage-1 functions deployed, the live `automations`
   function = commit `7ae5b19`. Check: copy the live source from the dashboard editor into a file and fingerprint it (below):
   it must be **`689178985/112594`** (= `git show 7ae5b19:supabase/functions/automations/index.ts`). If it is not, stop: the
   rollback build and the differential baseline are built on 7ae5b19.
2. The stage-2 phase-1 groups G1.1–G1.4 are merged and **committed** by the main builder; `bash .claude/check_all.sh` prints
   `ALL GREEN` on that commit.
3. The offline differential is IDENTICAL on that commit (step 3 below, built-in corpus first).
4. A quiet hour (not 08:00–09:00 or 17:00–19:00 Sydney, when most customer messages go) with 2.5 hours of attention.

Fingerprint (MASTER rule 9; the same formula everywhere):

```bash
node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8");let x=0;for(let i=0;i<s.length;i++)x=(x+s.charCodeAt(i)*(i%97+1))%1000000007;console.log(x+"/"+s.length)' FILE
```

Reference values at the time of writing (recompute from the commit — any later edit changes them):
v2 `automations/index.ts` `255545541/309668` (3,800 lines) · rollback build `802813866/114905` (1,596 lines) · phase 4 (7ae5b19)
`689178985/112594`.

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
`selftest/`), with the phase-4 source vendored as `tests/phase4-reference.ts` (run.sh checks it is 7ae5b19 byte for byte
whenever git can show that commit). `check_all.sh` runs the built-in corpus every time (through the automations
`run_tests.sh`), so ALL GREEN includes `DIFFERENTIAL: IDENTICAL`. Below, `run.sh` = `bash supabase/functions/automations/differential/run.sh`
run from the repo root; the live exports go in the session scratchpad (never in the repo) and are passed by path.
It builds three engines from source — old = 7ae5b19, new = the worktree's v2 function, rb = the rollback build — and replays
every scenario on the tests' in-memory database (Part-1 shaped) through old, new, rb, the new build deployed before Part 1
(its phase-4 fallback, which must write no v2 rows) and the cutovers old→new (deploy), new→rb and new→old (rollback),
new→rb→new (redeploy after a rollback), new/rb alternating every tick, and before-Part-1→Part-1. Compared: action log
rows (step id, channel, audience, status, reason, recipient, time), every run's end status/reason/step_index and every due_at,
pushes, tasks and emails (exact text). It also proves the rollback build = 7ae5b19 + its header + the 2 edits, nothing else.

1. Built-in corpus (23 recorded-style rows mirroring the ready-made and builder shapes, incl. two long runs of 21–22 steps
   above an email + the 24 `upgrade.json` v1 shapes ×
   17 scenarios: in hours, outside hours, the night before DST, public holiday, weekend, opted out, test records, capped,
   stage undone within 30 s, stage moved on, no customer card, card linked later, 30-hour outage (late), no signer, picked
   up + chat answered, don't ask + asked lately + paid, the app's "look now"):
   `run.sh` → must end `DIFFERENTIAL: IDENTICAL` (at the time of writing: 816 cases, 10,608 worlds, 17 s).
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
2. **5 minutes with the phase-4 function on the new schema** (still 7ae5b19): W1 shows ticks every minute; W3 shows actions
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
1. Dashboard → `automations` → editor: paste `supabase/functions/automations-phase4-compat/index.ts` from the committed
   stage-2 commit (GitHub raw). Verify JWT **OFF**. Deploy. Fingerprint the deployed code = the commit file
   (`802813866/114905` at the time of writing). Never `supabase functions deploy automations-phase4-compat`, never "deploy all".
2. Check: from the rollback time no new `step` / `exit` rows (W2 with `:deploy` = rollback time → only `action`); W1 ticks;
   W3 actions continue; waiting runs go on from `step_index` (the v2 executor kept it in step; tested both ways, including a
   later redeploy).
3. In phase 1 the plain phase-4 file (7ae5b19) also runs correctly on the Part-1 schema (differential "new → old"), but the
   rollback build is the one to use: only it ignores v2 step rows in its "already done" check and treats a soft delete as a
   delete, which matters from phase 2 on.

**R-B — also the schema (only if Part 1 itself misbehaves, e.g. capture errors or a lock problem).**
1. R-A first (the rollback build runs on both schemas).
2. Run the commented ROLLBACK block of PART 1 in `.claude/sql/stage2-automations.sql` (one transaction). It deletes the rows only
   the v2 engine writes (enroll / step / exit log rows, Go-to passes, new channels) and restores `automation_log_once` and the
   phase-4 `automation_claim_customer`. Then the schema check of step 1.1 again and compare with the backup.
3. Keep the rollback build deployed (tested on the phase-4 schema: the whole phase-4 suite) or redeploy 7ae5b19.

After any rollback: watch 30 minutes (W1, W3, W6, W8), log it in MASTER §13 and tell Ofek in Hebrew what happened and why.
Before deploying v2 again: fix, `check_all.sh` ALL GREEN, the differential IDENTICAL (it covers rollback → redeploy).

## 8. Notes for later phases (found while building G1.4)

- **Phase-4 step ids that are not v2 ids** (step 2 query): compat mode maps node ids back to the phase-4 id for log rows,
  claims and the window pass (`advanceV2`, `sid`), so phase 1 is exact. `step:"migrate"` (G2.4) must not silently re-id them:
  either keep the old id in the doc, or store the id map and translate claims — otherwise an action claimed before the
  migration could be claimed again under its new id.
- The rollback build's correctness after phase 2 also depends on the Part-2 ROLLBACK disabling every row created or edited
  in v2 (design §3.16) — phase 4 cannot run a doc-only workflow.
