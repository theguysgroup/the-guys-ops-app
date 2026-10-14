-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Settings round 2, PHASE 4 (the automation engine + builder). SHARED FILE: each group of phase 4 writes ONE clearly
-- delimited, self-contained section below (its own begin/commit, its own read-only checks and its own commented ROLLBACK
-- block). Run each section on its own in the Supabase SQL editor (project dszlllazwmllmoklzjwl), in the order the build
-- notes give. Nothing in this file has been run by the builder: the owner runs it.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Group H-engine: the automation engine (settings round 2, phase 4; plan items 11a/11b/11c, 8b, P2, P3; SaaS rule 14 Oct)
-- Run BEFORE deploying the automations function. Safe to run again (idempotent).
-- NOTHING here sends anything: no automation rows are created; an automation that writes to customers (email / text) is
-- always stored OFF when it is created or duplicated; texts wait for the business phone (no Twilio code in the engine).
-- NO secret is written here: the timer reads 'automations_cron_secret' from Vault (added by the owner, see owner steps).
-- Check before (read-only):
--   select to_regclass('public.automations'), to_regclass('public.automation_runs'), to_regclass('public.automation_log'),
--          to_regclass('public.automation_settings'), to_regclass('public.customer_opt_outs'), to_regclass('public.automation_state');
--   select column_name, data_type, is_nullable, column_default from information_schema.columns
--    where table_schema = 'public' and table_name = 'jobs' and column_name = 'created_at';          -- 0 rows = will be added (NULL for old jobs)
--   select column_name from information_schema.columns where table_schema = 'public' and table_name = 'lead_messages'
--    and column_name in ('subject', 'email', 'auto', 'status');                                       -- expect 4
--   select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.lead_messages'::regclass and contype = 'c';  -- channel must allow 'email'
--   select proname from pg_proc where proname in ('is_owner_or_manager', 'can_view_section');       -- expect both
--   select count(*) from cron.job where jobname = 'automations-tick';
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
begin;

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 1. When a job was entered. Existing jobs stay NULL on purpose: they can never count as a newly closed job.
alter table public.jobs add column if not exists created_at timestamptz;
alter table public.jobs alter column created_at set default now();
create index if not exists jobs_created_at_idx on public.jobs (created_at);
create index if not exists contacts_stage_changed_idx on public.contacts (stage_changed_at);

-- 2. The business's guard-rail values (one row per business; values are settings, the rails themselves always apply).
create table if not exists public.automation_settings (
  business_id text primary key default 'default',
  timezone text not null default 'Australia/Sydney',
  customer_days smallint[] not null default '{0,1,2,3,4,5,6}',   -- 0 = Sunday … 6 = Saturday
  customer_from text not null default '08:00' check (customer_from ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  customer_until text not null default '20:00' check (customer_until ~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'),
  customer_daily_cap smallint not null default 1 check (customer_daily_cap between 1 and 10),
  respect_dont_ask boolean not null default true,
  dont_contact_tags text[] not null default '{}',
  ignore_test_records boolean not null default true,
  test_tags text[] not null default '{test}',
  max_late_hours integer not null default 24 check (max_late_hours between 1 and 720),
  lookback_hours integer not null default 6 check (lookback_hours between 1 and 48),
  email_signer text check (email_signer is null or char_length(email_signer) <= 60),
  email_footer text check (email_footer is null or char_length(email_footer) <= 300),   -- the way out under every automatic email; null = the engine's default
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint automation_settings_hours check (customer_from < customer_until)
);
alter table public.automation_settings add column if not exists email_footer text;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.automation_settings'::regclass and conname = 'automation_settings_footer_len') then
    alter table public.automation_settings add constraint automation_settings_footer_len check (email_footer is null or char_length(email_footer) <= 300);
  end if;
end $$;
insert into public.automation_settings (business_id) values ('default') on conflict (business_id) do nothing;

-- 3. The automations themselves. trigger = { type, params }; steps = ordered [ wait | window | if | action ] (the form
--    editor and the flow view edit the same array). audience is derived here from the steps.
create table if not exists public.automations (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  name text not null check (char_length(name) between 1 and 120),
  description text check (description is null or char_length(description) <= 500),
  template_key text,                                   -- the ready-made it came from ("back to the default"); null = made by the business
  enabled boolean not null default false,
  armed_at timestamptz,                                -- last switched on: events before this never fire it
  trigger jsonb not null default '{}'::jsonb,
  steps jsonb not null default '[]'::jsonb,
  audience text not null default 'team' check (audience in ('team', 'customer')),
  version integer not null default 1,
  created_by uuid,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint automations_trigger_obj check (jsonb_typeof(trigger) = 'object'),
  constraint automations_steps_arr check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) <= 30)
);
create index if not exists automations_enabled_idx on public.automations (business_id) where enabled;

-- The shape of a list of steps: each step's id, kind and type, in order. A change of the shape (a step added, removed,
-- moved or turned into another kind) is a new version; a change of words, numbers, hours, conditions or recipients is not
-- (waiting runs go on with the new words).
create or replace function public.automation_steps_shape(steps jsonb) returns jsonb
language sql immutable set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(e.s ->> 'id', e.s ->> 'kind', e.s ->> 'type') order by e.o), '[]'::jsonb)
    from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(steps) = 'array' then steps else '[]'::jsonb end) with ordinality as e(s, o)
$$;

-- Guard (runs as the caller, so auth.uid() / current_user are the real person):
--   * audience is computed from the steps; a NEW automation (or a duplicate) that writes to customers is always OFF;
--   * version goes up when what starts it (trigger) or the shape of its steps changes; waiting runs of the old version stop;
--   * armed_at is set when it is switched on AND again whenever a new version is saved while it is on, so an edited
--     automation only acts on what happens after the edit (never retroactively on the last hours); cleared when off;
--   * business_id, created_by and created_at never change after insert.
create or replace function public.automations_guard() returns trigger
language plpgsql security invoker set search_path = ''
as $$
declare customer boolean;
begin
  customer := exists (select 1 from pg_catalog.jsonb_array_elements(new.steps) s
                       where s->>'kind' = 'action' and s->>'type' in ('email', 'text'));
  new.audience := case when customer then 'customer' else 'team' end;
  new.updated_at := now();
  if auth.uid() is not null then new.updated_by := auth.uid(); end if;
  if tg_op = 'INSERT' then
    if auth.uid() is not null then new.created_by := auth.uid(); end if;
    new.created_at := now();
    new.version := 1;
    if customer then new.enabled := false; end if;
    new.armed_at := case when new.enabled then now() else null end;
  else
    if new.business_id is distinct from old.business_id then raise exception 'business_id cannot change'; end if;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.version := case when new.trigger is distinct from old.trigger
                          or public.automation_steps_shape(new.steps) is distinct from public.automation_steps_shape(old.steps)
                        then old.version + 1 else old.version end;
    if new.enabled and (not old.enabled or new.version <> old.version) then new.armed_at := now();
    elsif not new.enabled then new.armed_at := null;
    else new.armed_at := old.armed_at; end if;
  end if;
  return new;
end $$;
drop trigger if exists automations_guard on public.automations;
create trigger automations_guard before insert or update on public.automations
  for each row execute function public.automations_guard();

-- 4. One run per automation per event (the idempotency key) — also the queue of delayed steps.
create table if not exists public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  automation_id uuid not null references public.automations(id) on delete cascade,
  automation_version integer not null,
  event_key text not null check (char_length(event_key) <= 200),
  event_type text not null,
  event_at timestamptz not null,
  record_kind text not null check (record_kind in ('contact', 'job', 'call', 'chat')),
  record_id text not null,
  contact_id uuid,
  status text not null default 'waiting' check (status in ('waiting', 'running', 'done', 'skipped', 'cancelled', 'failed')),
  step_index smallint not null default 0,
  anchor_at timestamptz not null,
  due_at timestamptz not null,
  lease_until timestamptz,
  attempts smallint not null default 0,
  context jsonb not null default '{}'::jsonb,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint automation_runs_once unique (automation_id, event_key)
);
create index if not exists automation_runs_due_idx on public.automation_runs (business_id, due_at) where status in ('waiting', 'running');
create index if not exists automation_runs_record_idx on public.automation_runs (record_kind, record_id);
create index if not exists automation_runs_finished_idx on public.automation_runs (finished_at) where finished_at is not null;

-- 5. Every action attempt (each fire: automation, record, when, channel, result). Unique per run + step = never twice.
create table if not exists public.automation_log (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  run_id uuid references public.automation_runs(id) on delete set null,
  automation_id uuid,                                   -- no FK: the log outlives a deleted automation
  automation_name text not null,
  step_id text not null,
  channel text not null check (channel in ('push', 'task', 'email', 'text')),
  audience text not null check (audience in ('team', 'customer')),
  record_kind text,
  record_id text,
  contact_id uuid,
  recipient text,
  status text not null check (status in ('sending', 'sent', 'queued', 'waiting_phone', 'skipped', 'failed')),
  reason text,
  ref_id text,
  at timestamptz not null default now(),
  constraint automation_log_once unique (run_id, step_id)
);
create index if not exists automation_log_cap_idx on public.automation_log (contact_id, channel, at);
create index if not exists automation_log_automation_idx on public.automation_log (automation_id, at desc);
create index if not exists automation_log_queued_idx on public.automation_log (at) where status = 'queued';
create index if not exists automation_log_recipient_idx on public.automation_log (recipient, at) where audience = 'customer';

-- 6. Customers who asked not to get automatic messages (email, text or all), by card and/or address. Written from the
--    lead card ("Stop automatic messages": one row per address of the card). An address outlives its card: deleting a
--    card only clears contact_id (on delete set null), so a new card with the same email or phone is still left alone.
create table if not exists public.customer_opt_outs (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  contact_id uuid references public.contacts(id) on delete set null,
  channel text not null check (channel in ('email', 'text', 'all')),
  value_key text,                                       -- lower-case email, or the last 9 digits of the phone
  reason text check (reason is null or char_length(reason) <= 200),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
-- (An earlier draft cascaded the delete and had a check/unique index that a cleared card would break: replaced.)
alter table public.customer_opt_outs drop constraint if exists customer_opt_outs_target;
alter table public.customer_opt_outs drop constraint if exists customer_opt_outs_contact_id_fkey;
alter table public.customer_opt_outs add constraint customer_opt_outs_contact_id_fkey foreign key (contact_id) references public.contacts(id) on delete set null;
drop index if exists public.customer_opt_outs_once;
create index if not exists customer_opt_outs_key_idx on public.customer_opt_outs (business_id, value_key);
create index if not exists customer_opt_outs_contact_idx on public.customer_opt_outs (contact_id);
-- On insert: the address is filled in from the card when it is missing (email for email/all, else the phone's last 9
-- digits), stored lower-case; a row with neither a card nor an address is refused.
create or replace function public.customer_opt_outs_fill() returns trigger
language plpgsql security invoker set search_path = ''
as $$
declare em text; ph text;
begin
  if new.value_key is null and new.contact_id is not null then
    select pg_catalog.lower(pg_catalog.btrim(c.email)), pg_catalog.regexp_replace(coalesce(c.phone, ''), '\D', '', 'g')
      into em, ph from public.contacts c where c.id = new.contact_id;
    if new.channel in ('email', 'all') and coalesce(em, '') <> '' then new.value_key := em;
    elsif new.channel in ('text', 'all') and pg_catalog.length(coalesce(ph, '')) >= 8 then new.value_key := pg_catalog.right(ph, 9);
    end if;
  end if;
  if new.value_key is not null then new.value_key := pg_catalog.lower(pg_catalog.btrim(new.value_key)); end if;
  if new.contact_id is null and coalesce(new.value_key, '') = '' then raise exception 'an opt-out needs a card or an address'; end if;
  return new;
end $$;
drop trigger if exists customer_opt_outs_fill on public.customer_opt_outs;
create trigger customer_opt_outs_fill before insert on public.customer_opt_outs
  for each row execute function public.customer_opt_outs_fill();

-- 7. The engine's own state (timer lease, last tick, daily prune). Function only.
create table if not exists public.automation_state (
  business_id text primary key default 'default',
  tick_lease_until timestamptz,
  last_tick_at timestamptz,
  pruned_on date
);
insert into public.automation_state (business_id) values ('default') on conflict (business_id) do nothing;

create or replace function public.automation_tick_lock(p_business text, p_now timestamptz, p_seconds integer)
returns boolean language plpgsql volatile security definer set search_path = ''
as $$
declare got boolean;
begin
  insert into public.automation_state (business_id) values (p_business) on conflict (business_id) do nothing;
  update public.automation_state
     set tick_lease_until = p_now + make_interval(secs => greatest(p_seconds, 10)), last_tick_at = p_now
   where business_id = p_business and (tick_lease_until is null or tick_lease_until < p_now)
  returning true into got;
  return coalesce(got, false);
end $$;

create or replace function public.automation_claim_due(p_business text, p_now timestamptz, p_limit integer, p_lease_seconds integer)
returns setof public.automation_runs language sql volatile security definer set search_path = ''
as $$
  update public.automation_runs r
     set status = 'running', lease_until = p_now + make_interval(secs => greatest(p_lease_seconds, 30)),
         attempts = r.attempts + 1, updated_at = p_now
   where r.id in (
     select x.id from public.automation_runs x
      where x.business_id = p_business
        and ((x.status = 'waiting' and x.due_at <= p_now) or (x.status = 'running' and x.lease_until < p_now))
      order by x.due_at
      limit least(greatest(p_limit, 1), 50)
      for update skip locked)
  returning r.*;
$$;
-- A customer message's claim, atomic per customer: a lock on the card and on each of its addresses (taken in sorted
-- order, so two calls never wait on each other in a circle), then the count of this engine's customer messages of the
-- last 24 hours to the card or any of the addresses (including ones being sent right now), then the 'sending' row only
-- under the cap. → 'claimed:<log id>' | 'capped' | 'done' (this run's step was claimed before: never twice).
create or replace function public.automation_claim_customer(p_business text, p_run uuid, p_step text, p_automation uuid, p_name text,
  p_channel text, p_record_kind text, p_record_id text, p_contact uuid, p_recipients text[], p_since timestamptz, p_cap integer, p_now timestamptz)
returns text language plpgsql volatile security definer set search_path = ''
as $$
declare k text; n integer; got uuid;
begin
  for k in select distinct x from pg_catalog.unnest(pg_catalog.array_append(coalesce(p_recipients, '{}'::text[]), coalesce(p_contact::text, ''))) as u(x)
            where x <> '' order by 1 loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('automation-customer:' || p_business || ':' || k, 0));
  end loop;
  if exists (select 1 from public.automation_log l where l.run_id = p_run and l.step_id = p_step) then return 'done'; end if;
  select count(*) into n from public.automation_log l
   where l.business_id = p_business and l.audience = 'customer' and l.status in ('sending', 'sent', 'queued') and l.at >= p_since
     and ((p_contact is not null and l.contact_id = p_contact) or l.recipient = any(coalesce(p_recipients, '{}'::text[])));
  if n >= greatest(coalesce(p_cap, 1), 1) then return 'capped'; end if;
  insert into public.automation_log (business_id, run_id, step_id, status, channel, audience, automation_id, automation_name,
                                     record_kind, record_id, contact_id, recipient, at)
  values (p_business, p_run, p_step, 'sending', p_channel, 'customer', p_automation, p_name, p_record_kind, p_record_id, p_contact,
          (coalesce(p_recipients, '{}'::text[]))[1], p_now)
  on conflict on constraint automation_log_once do nothing
  returning id into got;
  return case when got is null then 'done' else 'claimed:' || got::text end;
end $$;

revoke all on function public.automation_tick_lock(text, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.automation_claim_due(text, timestamptz, integer, integer) from public, anon, authenticated;
revoke all on function public.automation_claim_customer(text, uuid, text, uuid, text, text, text, text, uuid, text[], timestamptz, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.automation_tick_lock(text, timestamptz, integer) to service_role;
grant execute on function public.automation_claim_due(text, timestamptz, integer, integer) to service_role;
grant execute on function public.automation_claim_customer(text, uuid, text, uuid, text, text, text, text, uuid, text[], timestamptz, integer, timestamptz) to service_role;

-- 8. Access. Owners and managers build and read automations; only the function (service role, which skips RLS) writes
--    runs, log and state. Opt-outs: anyone with CRM access.
alter table public.automation_settings enable row level security;
alter table public.automations enable row level security;
alter table public.automation_runs enable row level security;
alter table public.automation_log enable row level security;
alter table public.customer_opt_outs enable row level security;
alter table public.automation_state enable row level security;

drop policy if exists "automation_settings: owners and managers read" on public.automation_settings;
create policy "automation_settings: owners and managers read" on public.automation_settings for select using (is_owner_or_manager());
drop policy if exists "automation_settings: owners and managers update" on public.automation_settings;
create policy "automation_settings: owners and managers update" on public.automation_settings for update
  using (is_owner_or_manager()) with check (is_owner_or_manager());

drop policy if exists "automations: owners and managers read" on public.automations;
create policy "automations: owners and managers read" on public.automations for select using (is_owner_or_manager());
drop policy if exists "automations: owners and managers add" on public.automations;
create policy "automations: owners and managers add" on public.automations for insert
  with check (is_owner_or_manager() and business_id = 'default');
drop policy if exists "automations: owners and managers change" on public.automations;
create policy "automations: owners and managers change" on public.automations for update
  using (is_owner_or_manager()) with check (is_owner_or_manager());
drop policy if exists "automations: owners and managers delete" on public.automations;
create policy "automations: owners and managers delete" on public.automations for delete using (is_owner_or_manager());

drop policy if exists "automation_runs: owners and managers read" on public.automation_runs;
create policy "automation_runs: owners and managers read" on public.automation_runs for select using (is_owner_or_manager());
drop policy if exists "automation_log: owners and managers read" on public.automation_log;
create policy "automation_log: owners and managers read" on public.automation_log for select using (is_owner_or_manager());

drop policy if exists "customer_opt_outs: CRM read" on public.customer_opt_outs;
create policy "customer_opt_outs: CRM read" on public.customer_opt_outs for select using (is_owner_or_manager() or can_view_section('crm'));
drop policy if exists "customer_opt_outs: CRM add" on public.customer_opt_outs;
create policy "customer_opt_outs: CRM add" on public.customer_opt_outs for insert
  with check ((is_owner_or_manager() or can_view_section('crm')) and business_id = 'default');
drop policy if exists "customer_opt_outs: CRM remove" on public.customer_opt_outs;
create policy "customer_opt_outs: CRM remove" on public.customer_opt_outs for delete using (is_owner_or_manager() or can_view_section('crm'));

revoke insert, delete on public.automation_settings from anon, authenticated;
revoke insert, update, delete on public.automation_runs, public.automation_log from anon, authenticated;
revoke update on public.customer_opt_outs from anon, authenticated;
revoke all on public.automation_state from anon, authenticated;

-- 9. The timer: every minute (delays, time windows, catch-up of events the app did not report). The secret header comes
--    from Vault ('automations_cron_secret', added by the owner); until it exists the header is empty and the function
--    refuses the call.
do $$ begin
  if exists (select 1 from cron.job where jobname = 'automations-tick') then
    perform cron.unschedule('automations-tick');
  end if;
end $$;
select cron.schedule('automations-tick', '* * * * *', $job$
  select net.http_post(
    url := 'https://dszlllazwmllmoklzjwl.supabase.co/functions/v1/automations',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-automations-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'automations_cron_secret' limit 1), '')),
    body := '{"step":"tick"}'::jsonb,
    timeout_milliseconds := 10000)
$job$);

commit;
select 'H-engine ok';

-- Check after:
--   select count(*) from public.automations;                                                    -- 0 (nothing created)
--   select * from public.automation_settings;                                                   -- one row 'default', 08:00–20:00, cap 1
--   select column_name, is_nullable, column_default from information_schema.columns
--    where table_schema = 'public' and table_name = 'jobs' and column_name = 'created_at';      -- YES, now()
--   select count(*) from public.jobs where created_at is not null;                              -- only jobs entered after the SQL (or the ones that already had it)
--   select tablename, policyname, cmd from pg_policies where tablename in ('automations','automation_runs','automation_log','automation_settings','customer_opt_outs') order by 1, 2;
--   select jobname, schedule from cron.job where jobname = 'automations-tick';                  -- * * * * *
--   select count(*) from vault.decrypted_secrets where name = 'automations_cron_secret';        -- 1 after the owner step
--   select status, return_message from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'automations-tick') order by start_time desc limit 3;
--   select last_tick_at from public.automation_state;                                           -- within a minute once the function is deployed
--   Guard test (in a transaction, then roll back):
--   begin; insert into public.automations (name, enabled, trigger, steps) values ('guard test', true, '{"type":"newLead"}',
--     '[{"id":"a1","kind":"action","type":"email","subject":"x","body":"y"}]'); select enabled, audience from public.automations where name = 'guard test'; rollback;   -- false | customer
--   Re-arm test (an edit of what starts it, or of the steps' shape, while ON moves armed_at; a wording edit doesn't):
--   begin;
--   insert into public.automations (name, enabled, trigger, steps) values ('arm test', true, '{"type":"stage","params":{"stage":"Lost"}}',
--     '[{"id":"p1","kind":"action","type":"push","to":{"roles":["owner"]},"title":"x"}]');
--   alter table public.automations disable trigger automations_guard;   -- (only to pretend it was armed last week; rolled back below)
--   update public.automations set armed_at = now() - interval '7 days' where name = 'arm test';
--   alter table public.automations enable trigger automations_guard;
--   update public.automations set steps = '[{"id":"p1","kind":"action","type":"push","to":{"roles":["owner"]},"title":"new words"}]' where name = 'arm test';
--   select version, armed_at < now() - interval '1 day' as kept from public.automations where name = 'arm test';   -- 1 | true (wording: same version, same armed_at)
--   update public.automations set trigger = '{"type":"stage","params":{"stage":"Quoted"}}' where name = 'arm test';
--   select version, armed_at >= now() - interval '1 minute' as rearmed from public.automations where name = 'arm test';   -- 2 | true
--   rollback;
--   Opt-out test: begin; insert into public.customer_opt_outs (channel, value_key) values ('email', ' Sam@Example.COM ');
--     select value_key from public.customer_opt_outs order by created_at desc limit 1; rollback;      -- sam@example.com

-- ── ROLLBACK (H-engine; run by hand only) ──────────────────────────────────────────────────────────────────────
-- select cron.unschedule('automations-tick');
-- begin;
-- drop function if exists public.automation_claim_customer(text, uuid, text, uuid, text, text, text, text, uuid, text[], timestamptz, integer, timestamptz);
-- drop function if exists public.automation_claim_due(text, timestamptz, integer, integer);
-- drop function if exists public.automation_tick_lock(text, timestamptz, integer);
-- drop table if exists public.automation_log;
-- drop table if exists public.automation_runs;
-- drop trigger if exists automations_guard on public.automations;
-- drop function if exists public.automations_guard();
-- drop function if exists public.automation_steps_shape(jsonb);
-- drop table if exists public.automations;
-- drop trigger if exists customer_opt_outs_fill on public.customer_opt_outs;
-- drop function if exists public.customer_opt_outs_fill();
-- drop table if exists public.customer_opt_outs;
-- drop table if exists public.automation_settings;
-- drop table if exists public.automation_state;
-- drop index if exists public.contacts_stage_changed_idx;
-- drop index if exists public.jobs_created_at_idx;
-- -- jobs.created_at is kept (harmless; other code may start reading it). To remove it too:
-- -- alter table public.jobs drop column if exists created_at;
-- commit;
-- delete from vault.secrets where name = 'automations_cron_secret';
-- And remove the Edge Function secret AUTOMATIONS_CRON_SECRET and the 'automations' function in the Dashboard.
-- Note: emails already queued by the engine are ordinary lead_messages rows (auto = true) and stay in the customer's thread.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- END H-engine
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Group J: flow view (phase 4; the drag-and-drop view of the automation editor, owner request 13–14 Oct)
-- NOTHING TO RUN: the flow view adds no table, no column, no function and no secret. It edits the same
-- public.automations.steps array as the form editor (made by H-engine above), and that array already has its guard
-- rail there: constraint automations_steps_arr (a JSON array of at most 30 steps). The business's own limit is a
-- setting, settings.catalog.automations.maxSteps (default 20, between 1 and that 30), read by the app, not the database.
-- (The planned 'automations.definition' column was never made: H-engine stores trigger and steps as two columns.)
-- Check (read-only, after H-engine):
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.automations'::regclass and conname = 'automations_steps_arr';   -- ... <= 30
--   select max(jsonb_array_length(steps)) from public.automations;                            -- 30 or less
-- ── ROLLBACK (J): nothing to undo. ──
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- END J
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Group I-builder: the automation builder in Settings → Message templates & Automations
-- (settings round 2, phase 4; plan items 11, 8b, 9, 12; P2, P3; mockup M5; SaaS rule 14 Oct)
-- Run AFTER the H-engine section above (it makes public.automations and its guard). Safe to run again (idempotent).
-- NO secret is written here. Nothing here sends a message or switches anything on.
-- What it adds: one more guard rail on public.automations. H-engine's guard already stores a NEW automation that
-- messages customers OFF; this one also switches an automation OFF when an edit ADDS a customer CHANNEL it did not have
-- (an email where there was only a text, which only waits for the phone, or the other way round) to one that is on,
-- so every customer channel is only ever switched on by its own, separate switch-on (the builder asks the owner first). The builder needs no new column: it uses H's trigger, steps, template_key (the ready-made it was
-- duplicated from) and created_by_name. Templates of your own live in settings.catalog (msgTemplates + templates).
-- Check before (read-only):
--   select to_regclass('public.automations');                                                     -- not null (H-engine ran)
--   select tgname from pg_trigger where tgrelid = 'public.automations'::regclass and not tgisinternal;   -- automations_guard
--   select count(*) as all_rows, count(*) filter (where enabled) as switched_on from public.automations;
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
begin;

do $$
begin
  if to_regclass('public.automations') is null then
    raise exception 'Run the H-engine section of this file first (public.automations is missing)';
  end if;
end $$;

-- Does this list of steps message a customer? (the engine's shape: {"kind":"action","type":"email"|"text"})
create or replace function public.automation_has_customer_action(steps jsonb) returns boolean
language sql immutable set search_path = ''
as $$
  select exists (
    select 1 from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(steps) = 'array' then steps else '[]'::jsonb end) s
    where s ->> 'kind' = 'action' and s ->> 'type' in ('email', 'text')
  )
$$;

-- The customer channels a list of steps uses ('email', 'text'), sorted.
create or replace function public.automation_customer_channels(steps jsonb) returns text[]
language sql immutable set search_path = ''
as $$
  select coalesce(pg_catalog.array_agg(distinct s ->> 'type' order by s ->> 'type'), '{}'::text[])
    from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(steps) = 'array' then steps else '[]'::jsonb end) s
   where s ->> 'kind' = 'action' and s ->> 'type' in ('email', 'text')
$$;

-- Before H's guard (triggers of one table run in name order: automations_customer_off_guard < automations_guard), so
-- H's guard then clears armed_at as for any switch-off.
create or replace function public.automations_customer_off_guard() returns trigger
language plpgsql security invoker set search_path = ''
as $$
begin
  if new.enabled
     and not (public.automation_customer_channels(new.steps) <@ public.automation_customer_channels(old.steps)) then
    new.enabled := false;
  end if;
  return new;
end $$;
drop trigger if exists automations_customer_off_guard on public.automations;
create trigger automations_customer_off_guard before update on public.automations
  for each row execute function public.automations_customer_off_guard();

commit;
select 'I-builder ok';

-- Check after (read-only):
--   select tgname from pg_trigger where tgrelid = 'public.automations'::regclass and not tgisinternal order by tgname;
--     -- automations_customer_off_guard, automations_guard
--   select public.automation_has_customer_action('[{"id":"s1","kind":"action","type":"email"}]'::jsonb);   -- true
--   select public.automation_has_customer_action('[{"id":"s1","kind":"action","type":"push"}]'::jsonb);    -- false
--   select public.automation_customer_channels('[{"id":"s1","kind":"action","type":"text"},{"id":"s2","kind":"action","type":"email"}]'::jsonb);   -- {email,text}
--   select count(*) filter (where enabled) from public.automations;                                       -- unchanged by this section
--   Guard test (in a transaction, then roll back):
--   begin;
--   insert into public.automations (name, enabled, trigger, steps) values ('guard test I', true, '{"type":"newLead"}',
--     '[{"id":"s1","kind":"action","type":"push","to":{"roles":["owner"]},"title":"x"}]');
--   update public.automations set steps = steps || '[{"id":"s2","kind":"action","type":"email","subject":"x","body":"y"}]'::jsonb
--     where name = 'guard test I';
--   select enabled, audience, armed_at from public.automations where name = 'guard test I';   -- false | customer | null
--   update public.automations set enabled = true where name = 'guard test I';   -- the owner's own switch-on: stays on
--   update public.automations set steps = '[{"id":"s3","kind":"action","type":"text","body":"y"}]'::jsonb where name = 'guard test I';
--   select enabled from public.automations where name = 'guard test I';   -- false (an email automation that now texts: off again)
--   rollback;

-- ===== ROLLBACK (I-builder) — run only to undo this section. It never deletes or switches on an automation.
-- begin;
-- drop trigger if exists automations_customer_off_guard on public.automations;
-- drop function if exists public.automations_customer_off_guard();
-- drop function if exists public.automation_customer_channels(jsonb);
-- drop function if exists public.automation_has_customer_action(jsonb);
-- commit;
-- Templates of your own (settings.catalog.msgTemplates and their words in settings.catalog.templates) are app data:
-- this rollback leaves them; the review, phone and chat functions never read those keys (only the engine does).
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- END I-builder
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
