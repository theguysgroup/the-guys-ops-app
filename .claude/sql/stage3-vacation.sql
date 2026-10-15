-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Stage 3 · People status "On vacation" (Ofek 14 Oct; spec .claude/plans/stage3-spec.md §2/§4). STAGING FIRST
-- (wblsrpmjiqwuxmrmuklc); never run here on LIVE without the owner. Safe to run again (idempotent). Additive: one new table,
-- helper functions and two triggers. It does NOT touch auto_end_va_shifts() (stage 1 B3 owns it): people on vacation can't
-- start a shift, and the app acknowledges a "forgot to log out" for someone away by itself (vaSessionStart).
--
-- A vacation is data, never a change of employees.status (it stays 'Active' | 'Inactive'). "On vacation today" is worked
-- out from the rows, the same way in the app (vacationOnDay), the functions (vacOnDay) and here (vacation_in_force):
--   options (jsonb, the checklist): autoBack is ON unless it is the boolean false; every other key (noNotify, notAssignable,
--   standIn, flagOpen, badge, noCalls, payroll, remind) is ON only when it is the boolean true; pay = 'paid' | 'unpaid'.
--   starts_on = the first day away, ends_on = the LAST day away (back on ends_on + 1). In force on a day when not cancelled,
--   from starts_on, before the business day it was ended on (ended_at), and up to ends_on unless autoBack is off (then until
--   someone ends it). The business day is in the business's time zone: stage 1's public.business_tz() (Settings → Region
--   and format, settings.catalog.region.timeZone; an unknown zone = Australia/Sydney).
-- One vacation at a time per person: the planned days (shortened by an early end) of two vacations may not touch.
-- Everyone signed in reads the rows (the badge is for everyone); only owners and managers add or change them; nobody deletes
-- (a mistake is cancelled: cancelled_at). employee_name / stand_in_name are copies kept by the triggers, so people who can't
-- read the employees table can still see whose vacation it is. The free-text note (it may hold a medical reason) is in its
-- own table, employee_vacation_notes, that only owners and managers read and write (main builder review 1.C.1).
--
-- Read-only checks BEFORE applying (they change nothing):
--   select data_type from information_schema.columns where table_schema = 'public' and table_name = 'employees' and column_name = 'id';  -- expect uuid
--   select proname from pg_proc where proname = 'is_owner_or_manager';                                -- expect 1 row
--   select to_regprocedure('public.business_tz()') is not null;                                       -- expect true (stage 1, round3-stage1.sql B1)
--   select to_regclass('public.employee_vacations');                                                  -- null before the first run
--   select public.business_tz();                                                                      -- the business's zone
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
begin;

-- 1. The vacations.
create table if not exists public.employee_vacations (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  employee_id uuid not null references public.employees(id) on delete cascade,
  employee_name text not null default '',             -- copy of employees.name (trigger), for people who can't read employees
  starts_on date not null,
  ends_on date not null,                               -- the last day away
  stand_in_id uuid references public.employees(id) on delete set null,
  stand_in_name text,                                  -- copy of the stand-in's name (trigger)
  options jsonb not null default '{}'::jsonb,          -- the checklist (see the header)
  created_by uuid default auth.uid(),                  -- set by the guard trigger (the signed-in person), never by the app
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz,                                -- ended by hand (early, or "Back?" when autoBack is off)
  cancelled_at timestamptz,                            -- a mistake: never counts
  reminded_at timestamptz,                             -- the day-before-return reminder went (push scan, service role only; push_sent is the once-guard)
  constraint employee_vacations_dates check (ends_on >= starts_on and ends_on - starts_on <= 366),
  constraint employee_vacations_stand_in check (stand_in_id is null or stand_in_id <> employee_id),
  constraint employee_vacations_options check (jsonb_typeof(options) = 'object' and (not (options ? 'pay') or options->>'pay' in ('paid', 'unpaid')))
);
create index if not exists employee_vacations_employee on public.employee_vacations (employee_id, starts_on);
-- the app loads the current ones and about the last year (ends_on), never the whole history
create index if not exists employee_vacations_ends on public.employee_vacations (ends_on);

-- 2. The note: owners and managers only (it may hold a medical reason). One row per vacation, gone with it.
create table if not exists public.employee_vacation_notes (
  vacation_id uuid primary key references public.employee_vacations(id) on delete cascade,
  business_id text not null default 'default',
  note text,
  updated_at timestamptz not null default now(),
  constraint employee_vacation_notes_note check (note is null or char_length(note) <= 500)
);
-- An earlier version of this file kept the note on employee_vacations, where everyone signed in could read it: copy any
-- notes across, then drop that column.
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_vacations' and column_name = 'note') then
    execute 'insert into public.employee_vacation_notes (vacation_id, business_id, note)
               select id, business_id, note from public.employee_vacations where note is not null
             on conflict (vacation_id) do nothing';
    alter table public.employee_vacations drop column note;
  end if;
end $$;

-- 3. Is a vacation in force on a day? (the app's vacationOnDay, the functions' vacOnDay)
create or replace function public.vacation_in_force(p_starts date, p_ends date, p_options jsonb, p_ended timestamptz, p_cancelled timestamptz, p_day date)
 returns boolean
 language sql
 stable
 set search_path to 'public'
as $function$
  select p_cancelled is null and p_starts <= p_day
    and (p_ended is null or p_day < (p_ended at time zone public.business_tz())::date)
    and (coalesce(p_options->'autoBack', 'true'::jsonb) = 'false'::jsonb or p_day <= p_ends)
$function$;

-- 4. Is this login's person on vacation on that day (with that option ticked, when one is given)? The login is the employee
--    whose name is its Jobs & Commissions name, else its full name (the app's peopleList).
create or replace function public.profile_on_vacation(p_profile uuid, p_day date, p_option text default null)
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select exists (
    select 1
      from public.profiles p
      cross join lateral (select coalesce(
        (select e.id from public.employees e where p.technician_name is not null and e.name = p.technician_name order by e.id limit 1),
        (select e.id from public.employees e where e.name = p.full_name order by e.id limit 1)) as employee_id) m
      join public.employee_vacations v on v.employee_id = m.employee_id
     where p.id = p_profile
       and public.vacation_in_force(v.starts_on, v.ends_on, v.options, v.ended_at, v.cancelled_at, p_day)
       and (p_option is null or case when p_option = 'autoBack' then v.options->'autoBack' is distinct from 'false'::jsonb
                                     else v.options->p_option = 'true'::jsonb end))
$function$;
revoke all on function public.profile_on_vacation(uuid, date, text) from public, anon;
grant execute on function public.profile_on_vacation(uuid, date, text) to authenticated, service_role;

-- 5. Names, times and one vacation at a time per person (the app shows the same message before saving).
create or replace function public.employee_vacations_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  tz text := public.business_tz();
  last_new date; clash record;
begin
  new.employee_name := coalesce((select e.name from public.employees e where e.id = new.employee_id), '');
  new.stand_in_name := (select e.name from public.employees e where e.id = new.stand_in_id);
  -- who made it, the business, the reminder stamp and the end/cancel times are the database's: a signed-in person can't
  -- set them (the push scan writes reminded_at with the service role, which has no auth.uid()). "End now" and "Cancel" take
  -- the database's clock, never the browser's: the functions treat a row with ended_at as over, the app and this file read
  -- ended_at as a business day, and a fast or slow laptop clock would make them disagree (ended means ended_at <= now()).
  if tg_op = 'INSERT' then
    new.created_by := auth.uid(); new.created_at := now(); new.updated_at := now();
    if auth.uid() is not null then new.reminded_at := null; new.ended_at := null; new.cancelled_at := null; end if;
  else
    new.updated_at := now(); new.created_at := old.created_at; new.created_by := old.created_by; new.business_id := old.business_id;
    if auth.uid() is not null then
      new.reminded_at := old.reminded_at;
      new.ended_at := case when new.ended_at is null then null when old.ended_at is null then now() else old.ended_at end;
      new.cancelled_at := case when new.cancelled_at is null then null when old.cancelled_at is null then now() else old.cancelled_at end;
    end if;
  end if;
  if new.cancelled_at is not null then return new; end if;
  -- two saves for the same person at the same moment wait for each other
  perform pg_advisory_xact_lock(hashtextextended('employee_vacations:' || new.employee_id::text, 0));
  last_new := case when new.ended_at is null then new.ends_on else least(new.ends_on, (new.ended_at at time zone tz)::date - 1) end;
  if last_new < new.starts_on then return new; end if;   -- ended before it began: blocks nothing
  select v.starts_on, v.ends_on into clash
    from public.employee_vacations v
   where v.employee_id = new.employee_id and v.id <> new.id and v.cancelled_at is null
     and v.starts_on <= last_new
     and (case when v.ended_at is null then v.ends_on else least(v.ends_on, (v.ended_at at time zone tz)::date - 1) end) >= new.starts_on
   limit 1;
  if found then
    raise exception 'Already on vacation from % to %', to_char(clash.starts_on, 'FMDD Mon'), to_char(clash.ends_on, 'FMDD Mon') using errcode = '23P01';
  end if;
  return new;
end $function$;
drop trigger if exists employee_vacations_guard on public.employee_vacations;
create trigger employee_vacations_guard before insert or update on public.employee_vacations
  for each row execute function public.employee_vacations_guard();

-- 6. A renamed employee: their vacations (and the ones they stand in for) show the new name.
create or replace function public.employee_vacations_names()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if new.name is distinct from old.name then
    update public.employee_vacations set employee_name = new.name where employee_id = new.id;
    update public.employee_vacations set stand_in_name = new.name where stand_in_id = new.id;
  end if;
  return new;
end $function$;
drop trigger if exists employees_vacation_names on public.employees;
create trigger employees_vacation_names after update of name on public.employees
  for each row execute function public.employee_vacations_names();

-- 7. Who may see and change them.
alter table public.employee_vacations enable row level security;
drop policy if exists "employee_vacations: signed-in read" on public.employee_vacations;
create policy "employee_vacations: signed-in read" on public.employee_vacations for select to authenticated using (true);
drop policy if exists "employee_vacations: owners and managers add" on public.employee_vacations;
create policy "employee_vacations: owners and managers add" on public.employee_vacations for insert
  with check (is_owner_or_manager() and business_id = 'default');
drop policy if exists "employee_vacations: owners and managers update" on public.employee_vacations;
create policy "employee_vacations: owners and managers update" on public.employee_vacations for update
  using (is_owner_or_manager()) with check (is_owner_or_manager());
-- No delete policy: a vacation is cancelled (cancelled_at), never deleted from the app.
alter table public.employee_vacation_notes enable row level security;
drop policy if exists "employee_vacation_notes: owners and managers read" on public.employee_vacation_notes;
create policy "employee_vacation_notes: owners and managers read" on public.employee_vacation_notes for select to authenticated
  using (is_owner_or_manager());
drop policy if exists "employee_vacation_notes: owners and managers add" on public.employee_vacation_notes;
create policy "employee_vacation_notes: owners and managers add" on public.employee_vacation_notes for insert
  with check (is_owner_or_manager() and business_id = 'default');
drop policy if exists "employee_vacation_notes: owners and managers update" on public.employee_vacation_notes;
create policy "employee_vacation_notes: owners and managers update" on public.employee_vacation_notes for update
  using (is_owner_or_manager()) with check (is_owner_or_manager() and business_id = 'default');
-- The note's business, vacation and time are the database's.
create or replace function public.employee_vacation_notes_guard()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then new.business_id := old.business_id; new.vacation_id := old.vacation_id; end if;
  return new;
end $function$;
drop trigger if exists employee_vacation_notes_guard on public.employee_vacation_notes;
create trigger employee_vacation_notes_guard before insert or update on public.employee_vacation_notes
  for each row execute function public.employee_vacation_notes_guard();

-- 8. Live updates in the app (badges, pickers) like the other lists.
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'employee_vacations') then
    alter publication supabase_realtime add table public.employee_vacations;
  end if;
end $$;

-- 9. An earlier version of this file added business_timezone() (it read region.timezone, lowercase: always Sydney). Stage 1's
--    business_tz() replaces it everywhere; nothing calls it any more.
drop function if exists public.business_timezone();

commit;

-- Read-only checks AFTER applying:
--   select public.vacation_in_force('2026-10-20', '2026-10-24', '{}'::jsonb, null, null, '2026-10-24');                       -- true
--   select public.vacation_in_force('2026-10-20', '2026-10-24', '{}'::jsonb, null, null, '2026-10-25');                       -- false
--   select public.vacation_in_force('2026-10-20', '2026-10-24', '{"autoBack":false}'::jsonb, null, null, '2026-10-30');       -- true
--   select public.vacation_in_force('2026-10-20', '2026-10-24', '{}'::jsonb, '2026-10-21 13:30+00', null, '2026-10-22');      -- false (ended 22 Oct 00:30 Sydney)
--   select polname from pg_policy where polrelid = 'public.employee_vacations'::regclass;                                     -- read, add, update
--   select polname from pg_policy where polrelid = 'public.employee_vacation_notes'::regclass;                                -- read, add, update (owners and managers)
--   select count(*) from information_schema.columns where table_name = 'employee_vacations' and column_name = 'note';         -- 0 (moved to employee_vacation_notes)
--   select position('business_tz' in prosrc) > 0 from pg_proc where proname = 'vacation_in_force';                             -- true
--   select to_regprocedure('public.business_timezone()');                                                                     -- null (dropped)
--   -- as a signed-in owner/manager: update ... set ended_at = '2000-01-01' → the saved ended_at is now(), not the browser's time
--   select position('profile_on_vacation' in prosrc) > 0 from pg_proc where proname = 'auto_end_va_shifts';                   -- false (stage 1's own body)

-- ROLLBACK (stage 3 vacations): run as one block, in this order. Removes everything added above (the vacation rows and
-- their notes are lost: export them first if they matter). auto_end_va_shifts() and business_tz() are stage 1's and stay.
-- begin;
-- drop trigger if exists employee_vacation_notes_guard on public.employee_vacation_notes;
-- drop function if exists public.employee_vacation_notes_guard();
-- drop table if exists public.employee_vacation_notes;
-- drop trigger if exists employees_vacation_names on public.employees;
-- drop function if exists public.employee_vacations_names();
-- drop trigger if exists employee_vacations_guard on public.employee_vacations;
-- drop function if exists public.employee_vacations_guard();
-- drop function if exists public.profile_on_vacation(uuid, date, text);
-- drop function if exists public.vacation_in_force(date, date, jsonb, timestamptz, timestamptz, date);
-- do $$ begin
--   if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'employee_vacations') then
--     alter publication supabase_realtime drop table public.employee_vacations;
--   end if;
-- end $$;
-- drop table if exists public.employee_vacations;
-- commit;
-- ═══ end stage 3 vacations ═══



-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Stage 3 follow-ups (Ofek 15 Oct, stage4-review §3 items 2, 3, 4).
-- STAGING FIRST (wblsrpmjiqwuxmrmuklc). Two parts, each safe to run again:
--   PART A: run BEFORE deploying the app of this change (the app writes employee_vacation_notes.pay and listens to it live).
--   PART B: run AFTER the app of this change is live. Until then the app that is live now reads paid / unpaid leave only from
--           employee_vacations.options.pay: moving it out first would show every vacation as "Unpaid leave" on its payroll
--           board. The new app reads the private pay when there is one and falls back to options.pay, so it is right on
--           both sides of part B. Ask the owners to reload any open tab before payroll is reviewed.
--   2. Paid or unpaid leave is private: it moves from employee_vacations.options.pay (every signed-in person reads it) to
--      employee_vacation_notes.pay (owners and managers only, like the note). The guard moves a pay an app from before this
--      change still sends; the notes' foreign key is made deferrable so the guard can write that row while the vacation is
--      being inserted. The notes join the realtime publication, so another owner's change shows at once (realtime applies
--      the read policy: owners and managers only). The person's History lines ("Vacation set: …") no longer say paid or
--      unpaid; part B takes it out of the lines written since stage 3 (activity_log is read by every signed-in person).
--   3. Defense in depth, as stage 5 did: nothing for anon, no delete / truncate / references / trigger for signed-in people,
--      and the add / update policies are for signed-in people only.
--   4. A rename (employee_vacations_names), the push scan's reminded_at or a pay moved out of options re-ran the clash check
--      on every row of that person, and could fail with "Already on vacation" after a time-zone change. The guard now skips
--      the check when nothing that decides a clash changed.
-- Check before (read-only):
--   select count(*) from public.employee_vacations where options ? 'pay';                                    -- the rows step 6 copies
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'employee_vacation_notes' and column_name = 'pay';      -- 0 rows the first time
--   select conname, condeferrable from pg_constraint
--    where conrelid = 'public.employee_vacation_notes'::regclass and contype = 'f';                          -- 1 row, false the first time
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_schema = 'public' and table_name in ('employee_vacations', 'employee_vacation_notes')
--      and grantee in ('anon', 'authenticated') order by 1, 2;                                                -- Supabase's defaults: all of them
--   select polname, polroles::regrole[] from pg_policy
--    where polrelid in ('public.employee_vacations'::regclass, 'public.employee_vacation_notes'::regclass); -- add / update: {-} (= PUBLIC)
--   select tablename from pg_publication_tables
--    where pubname = 'supabase_realtime' and tablename in ('employee_vacations', 'employee_vacation_notes'); -- employee_vacations only
--   select count(*) from public.activity_log
--    where record_kind = 'employee' and text ~ '^Vacation (set|changed): ' and text ~ ' · (paid|unpaid) leave$';  -- the lines step 8 cleans
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- ── PART A: before the app ──────────────────────────────────────────────────────────────────────────────────────
begin;

-- 1. The pay column (owners and managers only, with the note).
alter table public.employee_vacation_notes add column if not exists pay text;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.employee_vacation_notes'::regclass and conname = 'employee_vacation_notes_pay') then
    alter table public.employee_vacation_notes add constraint employee_vacation_notes_pay check (pay is null or pay in ('paid', 'unpaid'));
  end if;
end $$;

-- 2. The notes' foreign key is checked at commit, so the guard (a BEFORE INSERT trigger of the vacation) can write the
--    private row of a vacation that is not in the table yet.
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'public.employee_vacation_notes'::regclass and contype = 'f'
     and confrelid = 'public.employee_vacations'::regclass and not condeferrable
   limit 1;
  if c is not null then
    execute format('alter table public.employee_vacation_notes alter constraint %I deferrable initially deferred', c);
  end if;
end $$;

-- 3. Who may do what (item 3). Referential actions (an employee deleted → their vacations and notes) run as the table
--    owner, so revoking delete here does not stop them.
revoke all on public.employee_vacations, public.employee_vacation_notes from anon;
revoke delete, truncate, references, trigger on public.employee_vacations, public.employee_vacation_notes from authenticated;
drop policy if exists "employee_vacations: owners and managers add" on public.employee_vacations;
create policy "employee_vacations: owners and managers add" on public.employee_vacations for insert to authenticated
  with check (is_owner_or_manager() and business_id = 'default');
drop policy if exists "employee_vacations: owners and managers update" on public.employee_vacations;
create policy "employee_vacations: owners and managers update" on public.employee_vacations for update to authenticated
  using (is_owner_or_manager()) with check (is_owner_or_manager());
drop policy if exists "employee_vacation_notes: owners and managers add" on public.employee_vacation_notes;
create policy "employee_vacation_notes: owners and managers add" on public.employee_vacation_notes for insert to authenticated
  with check (is_owner_or_manager() and business_id = 'default');
drop policy if exists "employee_vacation_notes: owners and managers update" on public.employee_vacation_notes;
create policy "employee_vacation_notes: owners and managers update" on public.employee_vacation_notes for update to authenticated
  using (is_owner_or_manager()) with check (is_owner_or_manager() and business_id = 'default');
-- (the read policies are already "to authenticated")

-- 4. The notes (note and paid / unpaid leave) live: realtime sends each change only to who may read the row (owners and
--    managers), so another owner's open payroll board shows a pay change at once.
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'employee_vacation_notes') then
    alter publication supabase_realtime add table public.employee_vacation_notes;
  end if;
end $$;

commit;
select 'stage3-followups part A ok';

-- ── PART B: after the app of this change is live ────────────────────────────────────────────────────────────────
begin;

-- 5. The guard: section 5, plus the pay move (item 2) and no clash check when nothing that decides one changed (item 4).
create or replace function public.employee_vacations_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  tz text := public.business_tz();
  last_new date; clash record;
  v_pay text;
begin
  new.employee_name := coalesce((select e.name from public.employees e where e.id = new.employee_id), '');
  new.stand_in_name := (select e.name from public.employees e where e.id = new.stand_in_id);
  -- who made it, the business, the reminder stamp and the end/cancel times are the database's: a signed-in person can't
  -- set them (the push scan writes reminded_at with the service role, which has no auth.uid()). "End now" and "Cancel" take
  -- the database's clock, never the browser's: the functions treat a row with ended_at as over, the app and this file read
  -- ended_at as a business day, and a fast or slow laptop clock would make them disagree (ended means ended_at <= now()).
  if tg_op = 'INSERT' then
    new.created_by := auth.uid(); new.created_at := now(); new.updated_at := now();
    if auth.uid() is not null then new.reminded_at := null; new.ended_at := null; new.cancelled_at := null; end if;
  else
    new.updated_at := now(); new.created_at := old.created_at; new.created_by := old.created_by; new.business_id := old.business_id;
    if auth.uid() is not null then
      new.reminded_at := old.reminded_at;
      new.ended_at := case when new.ended_at is null then null when old.ended_at is null then now() else old.ended_at end;
      new.cancelled_at := case when new.cancelled_at is null then null when old.cancelled_at is null then now() else old.cancelled_at end;
    end if;
  end if;
  -- Paid or unpaid leave is private (employee_vacation_notes.pay, owners and managers only). An app from before this change
  -- still sends options.pay: it is moved there and never kept on the row everyone reads. 'unpaid' is that app's default, so
  -- on an edit it never overwrites a private value (a deliberate paid → unpaid from that app is lost: reload the app).
  if new.options ? 'pay' then
    v_pay := new.options->>'pay';
    new.options := new.options - 'pay';
    if v_pay in ('paid', 'unpaid') then
      insert into public.employee_vacation_notes as n (vacation_id, business_id, pay) values (new.id, new.business_id, v_pay)
      on conflict (vacation_id) do update
        set pay = case when tg_op = 'UPDATE' and excluded.pay = 'unpaid' and n.pay is not null then n.pay else excluded.pay end;
    end if;
  end if;
  if new.cancelled_at is not null then return new; end if;
  -- A rename (employee_vacations_names), the push scan's reminded_at or a pay moved out of options changes nothing that
  -- decides a clash: no clash check (an old row touching another after a time-zone change can't block them). After the
  -- ended_at / cancelled_at lines above, so these are the values the database keeps.
  if tg_op = 'UPDATE' and new.employee_id = old.employee_id and new.starts_on = old.starts_on and new.ends_on = old.ends_on
     and new.ended_at is not distinct from old.ended_at and new.cancelled_at is not distinct from old.cancelled_at
     and (new.options - 'pay') = (old.options - 'pay') then
    return new;
  end if;
  -- two saves for the same person at the same moment wait for each other
  perform pg_advisory_xact_lock(hashtextextended('employee_vacations:' || new.employee_id::text, 0));
  last_new := case when new.ended_at is null then new.ends_on else least(new.ends_on, (new.ended_at at time zone tz)::date - 1) end;
  if last_new < new.starts_on then return new; end if;   -- ended before it began: blocks nothing
  select v.starts_on, v.ends_on into clash
    from public.employee_vacations v
   where v.employee_id = new.employee_id and v.id <> new.id and v.cancelled_at is null
     and v.starts_on <= last_new
     and (case when v.ended_at is null then v.ends_on else least(v.ends_on, (v.ended_at at time zone tz)::date - 1) end) >= new.starts_on
   limit 1;
  if found then
    raise exception 'Already on vacation from % to %', to_char(clash.starts_on, 'FMDD Mon'), to_char(clash.ends_on, 'FMDD Mon') using errcode = '23P01';
  end if;
  return new;
end $function$;
-- (the trigger itself is section 5's, unchanged)

-- 6. Copy the pays there are now (a private value already there wins).
insert into public.employee_vacation_notes as n (vacation_id, business_id, pay)
  select id, business_id, options->>'pay' from public.employee_vacations where options->>'pay' in ('paid', 'unpaid')
on conflict (vacation_id) do update set pay = coalesce(n.pay, excluded.pay);

-- 7. Strip them from the rows everyone reads. The guard above skips the clash check for these rows (only pay differs), so an
--    old row whose dates touch another after a time-zone change can't stop this.
update public.employee_vacations set options = options - 'pay' where options ? 'pay';

-- 8. The History lines written since stage 3 ("Vacation set: 20 Oct – 24 Oct · paid leave") lose the pay (always their
--    last words). ONE-WAY: the pay itself is kept in employee_vacation_notes, only these words go. A tab of the old app
--    still open can write one more: running part B again later (say the next day) takes it out too.
update public.activity_log set text = regexp_replace(text, ' · (paid|unpaid) leave$', '')
 where record_kind = 'employee' and text ~ '^Vacation (set|changed): ' and text ~ ' · (paid|unpaid) leave$';

commit;
select 'stage3-followups part B ok';

-- Check after (read-only; part A's lines hold after part A, the rest after part B):
--   select data_type, is_nullable from information_schema.columns
--    where table_schema = 'public' and table_name = 'employee_vacation_notes' and column_name = 'pay';      -- text, YES
--   select conname from pg_constraint
--    where conrelid = 'public.employee_vacation_notes'::regclass and conname = 'employee_vacation_notes_pay';  -- 1 row
--   select conname, condeferrable, condeferred from pg_constraint
--    where conrelid = 'public.employee_vacation_notes'::regclass and contype = 'f';                          -- 1 row: true, true
--   select tablename from pg_publication_tables
--    where pubname = 'supabase_realtime' and tablename in ('employee_vacations', 'employee_vacation_notes'); -- both
--   -- part B:
--   select count(*) from public.employee_vacations where options ? 'pay';                                    -- 0
--   select count(*) from public.activity_log
--    where record_kind = 'employee' and text ~ '^Vacation (set|changed): ' and text ~ ' · (paid|unpaid) leave$';  -- 0
--   select count(*) from public.employee_vacation_notes where pay is not null;                               -- the count before, or more
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_schema = 'public' and table_name in ('employee_vacations', 'employee_vacation_notes')
--      and grantee in ('anon', 'authenticated') order by 1, 2;            -- no anon rows; authenticated: SELECT, INSERT, UPDATE on both
--   select polname, polroles::regrole[] from pg_policy
--    where polrelid in ('public.employee_vacations'::regclass, 'public.employee_vacation_notes'::regclass);  -- every row {authenticated}
--   select position('v_pay' in prosrc) > 0, position('is not distinct from old.ended_at' in prosrc) > 0
--     from pg_proc where proname = 'employee_vacations_guard';                                               -- true, true
--   -- signed in as an owner/manager, each in begin; … rollback;
--   --   (a) update public.employee_vacations set options = options || '{"pay":"paid"}' where id = '<a vacation>';
--   --       → that row's options has no pay; employee_vacation_notes.pay = 'paid' for it
--   --   (b) update public.employees set name = name || ' x' where id = '<a person whose vacations touch each other>';
--   --       → no "Already on vacation"

-- ── ROLLBACK (stage 3 follow-ups; run by hand only) ─────────────────────────────────────────────────────────────
-- Redeploy the previous app FIRST (this one reads and writes employee_vacation_notes.pay). Part B's step 8 (the pay taken
-- out of the History lines) is ONE-WAY: those words are not put back.
-- begin;
-- -- the notes off the realtime publication (part A, step 4)
-- do $$ begin
--   if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'employee_vacation_notes') then
--     alter publication supabase_realtime drop table public.employee_vacation_notes;
--   end if;
-- end $$;
-- -- pay back on the rows, without the guard (it would move it out again)
-- alter table public.employee_vacations disable trigger employee_vacations_guard;
-- update public.employee_vacations v set options = v.options || jsonb_build_object('pay', n.pay)
--   from public.employee_vacation_notes n where n.vacation_id = v.id and n.pay is not null;
-- alter table public.employee_vacations enable trigger employee_vacations_guard;
-- -- the guard of section 5, as it was
-- create or replace function public.employee_vacations_guard()
--  returns trigger
--  language plpgsql
--  security definer
--  set search_path to 'public'
-- as $function$
-- declare
--   tz text := public.business_tz();
--   last_new date; clash record;
-- begin
--   new.employee_name := coalesce((select e.name from public.employees e where e.id = new.employee_id), '');
--   new.stand_in_name := (select e.name from public.employees e where e.id = new.stand_in_id);
--   -- who made it, the business, the reminder stamp and the end/cancel times are the database's: a signed-in person can't
--   -- set them (the push scan writes reminded_at with the service role, which has no auth.uid()). "End now" and "Cancel" take
--   -- the database's clock, never the browser's: the functions treat a row with ended_at as over, the app and this file read
--   -- ended_at as a business day, and a fast or slow laptop clock would make them disagree (ended means ended_at <= now()).
--   if tg_op = 'INSERT' then
--     new.created_by := auth.uid(); new.created_at := now(); new.updated_at := now();
--     if auth.uid() is not null then new.reminded_at := null; new.ended_at := null; new.cancelled_at := null; end if;
--   else
--     new.updated_at := now(); new.created_at := old.created_at; new.created_by := old.created_by; new.business_id := old.business_id;
--     if auth.uid() is not null then
--       new.reminded_at := old.reminded_at;
--       new.ended_at := case when new.ended_at is null then null when old.ended_at is null then now() else old.ended_at end;
--       new.cancelled_at := case when new.cancelled_at is null then null when old.cancelled_at is null then now() else old.cancelled_at end;
--     end if;
--   end if;
--   if new.cancelled_at is not null then return new; end if;
--   -- two saves for the same person at the same moment wait for each other
--   perform pg_advisory_xact_lock(hashtextextended('employee_vacations:' || new.employee_id::text, 0));
--   last_new := case when new.ended_at is null then new.ends_on else least(new.ends_on, (new.ended_at at time zone tz)::date - 1) end;
--   if last_new < new.starts_on then return new; end if;   -- ended before it began: blocks nothing
--   select v.starts_on, v.ends_on into clash
--     from public.employee_vacations v
--    where v.employee_id = new.employee_id and v.id <> new.id and v.cancelled_at is null
--      and v.starts_on <= last_new
--      and (case when v.ended_at is null then v.ends_on else least(v.ends_on, (v.ended_at at time zone tz)::date - 1) end) >= new.starts_on
--    limit 1;
--   if found then
--     raise exception 'Already on vacation from % to %', to_char(clash.starts_on, 'FMDD Mon'), to_char(clash.ends_on, 'FMDD Mon') using errcode = '23P01';
--   end if;
--   return new;
-- end $function$;
-- alter table public.employee_vacation_notes drop constraint if exists employee_vacation_notes_pay;
-- alter table public.employee_vacation_notes drop column if exists pay;
-- do $$
-- declare c text;
-- begin
--   select conname into c from pg_constraint
--    where conrelid = 'public.employee_vacation_notes'::regclass and contype = 'f'
--      and confrelid = 'public.employee_vacations'::regclass and condeferrable
--    limit 1;
--   if c is not null then
--     execute format('alter table public.employee_vacation_notes alter constraint %I not deferrable', c);
--   end if;
-- end $$;
-- -- Supabase's default grants
-- grant all on public.employee_vacations, public.employee_vacation_notes to anon;
-- grant delete, truncate, references, trigger on public.employee_vacations, public.employee_vacation_notes to authenticated;
-- -- the add / update policies as section 7 made them (no "to authenticated")
-- drop policy if exists "employee_vacations: owners and managers add" on public.employee_vacations;
-- create policy "employee_vacations: owners and managers add" on public.employee_vacations for insert
--   with check (is_owner_or_manager() and business_id = 'default');
-- drop policy if exists "employee_vacations: owners and managers update" on public.employee_vacations;
-- create policy "employee_vacations: owners and managers update" on public.employee_vacations for update
--   using (is_owner_or_manager()) with check (is_owner_or_manager());
-- drop policy if exists "employee_vacation_notes: owners and managers add" on public.employee_vacation_notes;
-- create policy "employee_vacation_notes: owners and managers add" on public.employee_vacation_notes for insert
--   with check (is_owner_or_manager() and business_id = 'default');
-- drop policy if exists "employee_vacation_notes: owners and managers update" on public.employee_vacation_notes;
-- create policy "employee_vacation_notes: owners and managers update" on public.employee_vacation_notes for update
--   using (is_owner_or_manager()) with check (is_owner_or_manager() and business_id = 'default');
-- commit;
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- END stage 3 follow-ups
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
