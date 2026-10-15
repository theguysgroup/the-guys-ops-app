-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- STAGE 2 — Automations = a faithful copy of GHL Workflows (design: .claude/plans/stage2-design.md §2.9, §3, §8.2).
-- SHARED FILE, three parts, each its own section with its own begin/commit, read-only checks before/after and an exact
-- commented ROLLBACK block. Run each part on its own in the Supabase SQL editor, STAGING FIRST, in this order:
--   Part 1 (this section)  → phase 1, BEFORE the v2 function is deployed in compat mode (additive, safe while phase 4 runs)
--   Part 2 (switch the guards to the doc) → phase 2, right after the function that can save and migrate is deployed
--   Part 3 (lock direct writes)           → phase 3, after the new app is live
-- Nothing in this file has been run by the builder: the owner (or the main builder, staging first) runs it.
-- NO secret is written anywhere in this file. Nothing here sends a message or switches an automation on.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — tables, columns, the constraint swap + automation_claim_customer_v2 + wrapper, silent capture triggers,
-- the engine RPCs and the read RPCs, RLS, indexes, privileges (design §2.9 Part 1; group G1.3).
-- Safe to run again (idempotent). ONE transaction: the swap of automation_log_once for automation_log_action_once,
-- the new automation_claim_customer_v2 and the phase-4 automation_claim_customer turned into a wrapper over it are
-- applied together or not at all (design §9.2 risk 3), so the phase-4 engine claims exactly as before at every moment.
-- What phase 4 sees after this part: the same tables with extra columns (all with defaults), the same claim results
-- ('claimed:<id>' | 'capped' | 'done'), a plain insert of a second action row of a (run, step) still fails with 23505
-- (the partial unique index, every phase-4 row is row_kind 'action', loop 0). The capture triggers write NOTHING until
-- public.automation_wanted has rows (the v2 engine writes it in phase 2), and a capture failure never stops a save.
--
-- BACKUP FIRST (read-only; save the output as .claude/backups/automation-schema.before_stage2.sql):
--   select string_agg(x, E'\n\n') from (
--     select pg_get_functiondef(p.oid) || ';' x from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--      where n.nspname = 'public' and p.proname in ('automation_claim_customer', 'automation_claim_due', 'automation_tick_lock',
--            'automations_guard', 'automations_customer_off_guard', 'automation_steps_shape', 'customer_opt_outs_fill')
--     union all
--     select format('alter table public.%I add constraint %I %s;', c.conrelid::regclass::text, c.conname, pg_get_constraintdef(c.oid))
--       from pg_constraint c where c.conrelid in ('public.automation_runs'::regclass, 'public.automation_log'::regclass,
--            'public.automations'::regclass, 'public.automation_settings'::regclass, 'public.automation_state'::regclass)
--     union all
--     select format('-- %s.%s %s%s default %s', table_name, column_name, data_type, case when is_nullable = 'NO' then ' not null' else '' end, coalesce(column_default, 'none'))
--       from information_schema.columns where table_schema = 'public'
--        and table_name in ('automations', 'automation_runs', 'automation_log', 'automation_settings', 'automation_state')
--     union all
--     select indexdef || ';' from pg_indexes where schemaname = 'public'
--        and tablename in ('automations', 'automation_runs', 'automation_log', 'contacts', 'jobs', 'tasks')) s;
--
-- Check before (read-only):
--   select to_regclass('public.automations'), to_regclass('public.automation_runs'), to_regclass('public.automation_log'),
--          to_regclass('public.automation_settings'), to_regclass('public.automation_state'), to_regclass('public.customer_opt_outs');
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid in ('public.automation_runs'::regclass, 'public.automation_log'::regclass) order by 1;
--     -- expected (phase 4): automation_log_once UNIQUE (run_id, step_id); automation_log_channel_check, automation_log_audience_check,
--     -- automation_log_status_check; automation_runs_once; automation_runs_record_kind_check; automation_runs_status_check
--     -- (other names → this part refuses to run and changes nothing; adjust the names below first)
--   select format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'public.contacts'::regclass and attname = 'tags';   -- text[]
--   select table_name, column_name, data_type from information_schema.columns where table_schema = 'public'
--    and (table_name, column_name) in (('contacts','next_follow_up'), ('contacts','booked_for'), ('contacts','estimated_value'),
--         ('contacts','stage_changed_at'), ('contacts','last_read_at'), ('tasks','due'), ('tasks','contact_id'), ('jobs','contact_id'),
--         ('jobs','date'), ('suppliers','agreement_signed_at'));                                     -- the types the triggers / apply cast to
--   select proname from pg_proc where proname in ('is_owner_or_manager', 'my_role', 'can_view_section');   -- all three
--   select indexname from pg_indexes where schemaname = 'public' and tablename in ('contacts', 'jobs', 'tasks') order by 1;
--   select count(*) from public.automation_log;  select count(*) from public.automation_runs;      -- note both (unchanged after)
--   select count(*) from (select run_id, step_id from public.automation_log group by 1, 2 having count(*) > 1) d;   -- 0
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
begin;
set local lock_timeout = '5s';          -- never queue behind a long app transaction: fail and run again instead
set local statement_timeout = '120s';

-- 0. What this part needs (a missing piece stops it here, before anything changes).
do $$
declare t text; k text[];
begin
  foreach t in array array['automations', 'automation_runs', 'automation_log', 'automation_settings', 'automation_state', 'customer_opt_outs',
                           'contacts', 'tasks', 'lead_messages', 'jobs', 'suppliers', 'settings', 'activity_log'] loop
    if to_regclass('public.' || t) is null then raise exception 'Stage 2 Part 1 needs public.% (run settings-round2-phase4.sql first)', t; end if;
  end loop;
  foreach t in array array['is_owner_or_manager', 'my_role'] loop
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = t) then
      raise exception 'Stage 2 Part 1 needs public.%()', t;
    end if;
  end loop;
  -- the columns the capture triggers and automation_apply read or write (a trigger body is only checked when it runs)
  foreach t in array array['contacts.id', 'contacts.full_name', 'contacts.phone', 'contacts.email', 'contacts.postcode', 'contacts.division',
      'contacts.source', 'contacts.status', 'contacts.tags', 'contacts.next_follow_up', 'contacts.booked_for', 'contacts.estimated_value',
      'contacts.lost_reason', 'contacts.stage_changed_at', 'contacts.last_read_at', 'contacts.notes', 'tasks.id', 'tasks.title', 'tasks.status',
      'tasks.due', 'tasks.contact_id', 'tasks.board', 'tasks.assignees', 'tasks.assigned_to', 'tasks.category', 'tasks.priority', 'tasks.notes',
      'tasks.client', 'tasks.created_by', 'lead_messages.id', 'lead_messages.contact_id', 'lead_messages.channel', 'lead_messages.direction',
      'lead_messages.auto', 'lead_messages.author', 'lead_messages.author_id', 'lead_messages.at', 'jobs.id', 'jobs.payment_status',
      'jobs.contact_id', 'jobs.date', 'suppliers.id', 'suppliers.agreement_status', 'suppliers.agreement_signed_at', 'customer_opt_outs.id',
      'customer_opt_outs.contact_id', 'customer_opt_outs.channel', 'activity_log.record_kind', 'activity_log.record_id', 'activity_log.actor',
      'activity_log.text', 'activity_log.manual', 'settings.id', 'settings.catalog'] loop
    k := string_to_array(t, '.');
    if not exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = k[1] and c.column_name = k[2]) then
      raise exception 'Stage 2 Part 1 needs the column public.%', t;
    end if;
  end loop;
  -- the tag diff compares text arrays (design §2.9: verify before writing)
  if (select format_type(a.atttypid, a.atttypmod) from pg_attribute a
       where a.attrelid = 'public.contacts'::regclass and a.attname = 'tags' and not a.attisdropped) is distinct from 'text[]' then
    raise exception 'contacts.tags is not text[]: the tag capture must be rewritten (jsonb_array_elements_text) before this part runs';
  end if;
  -- the quote capture compares the amount with 0
  if (select format_type(a.atttypid, a.atttypmod) from pg_attribute a
       where a.attrelid = 'public.contacts'::regclass and a.attname = 'estimated_value' and not a.attisdropped)
     !~ '^(numeric|integer|bigint|smallint|real|double precision)' then
    raise exception 'contacts.estimated_value is not a number: the quote capture must be rewritten before this part runs';
  end if;
end $$;

-- 1. The business of the signed-in person (one business today; every new table carries business_id).
create or replace function public.current_business_id() returns text
language sql stable set search_path = ''
as $$ select 'default'::text $$;

-- A record value the business can rename lives in settings.catalog.keys.<name>; nothing saved = today's word.
-- (jobPaid → 'Paid', taskDone → 'Done', stageWon → 'Won', stageLost → 'Lost'.) Never a literal in the engine's SQL.
create or replace function public.automation_catalog_key(p_name text, p_default text) returns text
language sql stable security definer set search_path = ''
as $$
  select coalesce(nullif(pg_catalog.btrim((select s.catalog -> 'keys' ->> p_name from public.settings s order by s.id limit 1)), ''), p_default)
$$;

-- 2. Folders (≤ 5 levels; a name once per parent, any case).
create table if not exists public.automation_folders (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  parent_id uuid references public.automation_folders(id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  created_by uuid default auth.uid(),
  created_by_name text check (created_by_name is null or char_length(created_by_name) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists automation_folders_name_once on public.automation_folders
  (business_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)));
create index if not exists automation_folders_parent_idx on public.automation_folders (parent_id);

-- Same business as the parent; never inside itself; depth of the parent + this folder's own subtree height ≤ 5.
create or replace function public.automation_folders_guard() returns trigger
language plpgsql security invoker set search_path = ''
as $$
declare d integer := 0; h integer := 1; p uuid; pb text;
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    if new.business_id is distinct from old.business_id then raise exception 'business_id cannot change'; end if;
    new.created_by := old.created_by; new.created_at := old.created_at;
  elsif auth.uid() is not null then
    new.created_by := auth.uid();
  end if;
  if new.parent_id is not null then
    select f.business_id into pb from public.automation_folders f where f.id = new.parent_id;
    if pb is distinct from new.business_id then raise exception 'The parent folder is not in this business'; end if;
    p := new.parent_id;
    while p is not null loop
      if p = new.id then raise exception 'A folder cannot go inside itself'; end if;
      d := d + 1;
      if d >= 5 then raise exception 'Folders go at most 5 levels deep'; end if;
      select f.parent_id into p from public.automation_folders f where f.id = p;
    end loop;
  end if;
  if tg_op = 'UPDATE' then
    with recursive sub(id, lvl) as (
      select new.id, 1
      union all
      select f.id, s.lvl + 1 from public.automation_folders f join sub s on f.parent_id = s.id where s.lvl < 6)
    select max(sub.lvl) into h from sub;
  end if;
  if d + h > 5 then raise exception 'Folders go at most 5 levels deep'; end if;
  return new;
end $$;
drop trigger if exists automation_folders_guard on public.automation_folders;
create trigger automation_folders_guard before insert or update on public.automation_folders
  for each row execute function public.automation_folders_guard();

-- 3. automations: the doc and the workflow's own settings next to the phase-4 trigger + steps (dropped in phase 7).
alter table public.automations
  add column if not exists definition jsonb,                                  -- null = not migrated yet (phase 4 reads trigger + steps)
  add column if not exists settings jsonb not null default '{}'::jsonb,
  add column if not exists layout jsonb not null default '{"v":1}'::jsonb,   -- Advanced positions + sticky notes; never read by the engine
  add column if not exists builder text not null default 'standard',
  add column if not exists folder_id uuid,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid,
  add column if not exists deleted_by_name text,
  add column if not exists origin text not null default 'user',
  add column if not exists revision integer not null default 1,
  add column if not exists published_at timestamptz,
  add column if not exists published_by uuid,
  add column if not exists system_key text,
  add column if not exists system_handover_at timestamptz,
  add column if not exists enrolled_total bigint not null default 0,
  add column if not exists updated_by_name text,
  add column if not exists list_summary jsonb not null default '{}'::jsonb;  -- written by automation_save: the list never downloads definitions
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.automations'::regclass and conname = 'automations_definition_doc') then
    alter table public.automations add constraint automations_definition_doc check (definition is null or (jsonb_typeof(definition) = 'object'
      and definition ->> 'schema' = '2' and octet_length(definition::text) <= 262144));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.automations'::regclass and conname = 'automations_settings_obj') then
    alter table public.automations add constraint automations_settings_obj check (jsonb_typeof(settings) = 'object' and octet_length(settings::text) <= 16384);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.automations'::regclass and conname = 'automations_layout_obj') then
    alter table public.automations add constraint automations_layout_obj check (jsonb_typeof(layout) = 'object' and octet_length(layout::text) <= 131072);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.automations'::regclass and conname = 'automations_builder_kind') then
    alter table public.automations add constraint automations_builder_kind check (builder in ('standard', 'advanced'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.automations'::regclass and conname = 'automations_origin_kind') then
    alter table public.automations add constraint automations_origin_kind check (origin in ('user', 'copy', 'template', 'system', 'ai', 'migration'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.automations'::regclass and conname = 'automations_list_summary_obj') then
    alter table public.automations add constraint automations_list_summary_obj check (jsonb_typeof(list_summary) = 'object' and octet_length(list_summary::text) <= 8192);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.automations'::regclass and conname = 'automations_system_key_len') then
    alter table public.automations add constraint automations_system_key_len check (system_key is null or char_length(system_key) between 1 and 80);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.automations'::regclass and conname = 'automations_folder_fk') then
    alter table public.automations add constraint automations_folder_fk foreign key (folder_id) references public.automation_folders(id) on delete set null;
  end if;
end $$;
create unique index if not exists automations_system_key_once on public.automations (business_id, system_key)
  where system_key is not null and deleted_at is null;
create index if not exists automations_folder_idx on public.automations (folder_id) where folder_id is not null;
create index if not exists automations_deleted_idx on public.automations (deleted_at) where deleted_at is not null;
-- The v2-only columns stay out of the app's reach until Part 2 (guards on the doc) and Part 3 (the column lock): the
-- phase-4 policies let owners and managers INSERT / UPDATE public.automations directly, and the phase-4 guards
-- (automations_customer_off_guard, automations_guard) read only `steps`, while the v2 engine runs `definition` when it is a
-- schema-2 doc. So a direct write by the app's roles (authenticated / anon, as PostgREST runs them) never sets them: on
-- INSERT they get their defaults, on UPDATE they keep the stored values (silently, so a phase-4 app that sends the whole
-- row still saves). The service role (the function: migrate, save, enrolled_total) and the SQL editor are not touched;
-- neither is a security-definer RPC (current_user is then its owner). Named so it runs FIRST (triggers of one table run
-- in name order: automations_a_v2_pin < automations_customer_off_guard < automations_guard).
create or replace function public.automations_v2_pin() returns trigger
language plpgsql security invoker set search_path = ''
as $$
begin
  if current_user::text not in ('authenticated', 'anon') then return new; end if;
  if tg_op = 'INSERT' then
    new.definition := null; new.settings := '{}'::jsonb; new.origin := 'user'; new.revision := 1;
    new.published_at := null; new.published_by := null; new.enrolled_total := 0; new.system_key := null;
    new.system_handover_at := null; new.list_summary := '{}'::jsonb;
  else
    new.definition := old.definition; new.settings := old.settings; new.origin := old.origin; new.revision := old.revision;
    new.published_at := old.published_at; new.published_by := old.published_by; new.enrolled_total := old.enrolled_total;
    new.system_key := old.system_key; new.system_handover_at := old.system_handover_at; new.list_summary := old.list_summary;
  end if;
  return new;
end $$;
drop trigger if exists automations_a_v2_pin on public.automations;
create trigger automations_a_v2_pin before insert or update on public.automations
  for each row execute function public.automations_v2_pin();
revoke all on function public.automations_v2_pin() from public, anon, authenticated;

-- 4. Version snapshots (written only by the function, as the service role) and step / workflow notes.
create table if not exists public.automation_versions (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  automation_id uuid not null references public.automations(id) on delete cascade,
  version_no integer not null check (version_no >= 1),
  revision integer not null,
  version integer not null,
  status text not null check (status in ('draft', 'published')),
  reason text not null check (reason in ('create', 'save', 'save_version', 'publish', 'unpublish', 'restore', 'ai', 'migration', 'duplicate', 'system_move')),
  name text not null check (char_length(name) between 1 and 120),
  definition jsonb check (definition is null or (jsonb_typeof(definition) = 'object' and octet_length(definition::text) <= 262144)),
  settings jsonb not null default '{}'::jsonb,
  layout jsonb not null default '{"v":1}'::jsonb,
  builder text not null default 'standard' check (builder in ('standard', 'advanced')),
  content_hash text check (content_hash is null or char_length(content_hash) <= 128),
  created_by uuid,
  created_by_name text,
  created_at timestamptz not null default now(),
  constraint automation_versions_no_once unique (automation_id, version_no)
);
create index if not exists automation_versions_created_idx on public.automation_versions (created_at);

create table if not exists public.automation_notes (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  automation_id uuid not null references public.automations(id) on delete cascade,
  node_id text check (node_id is null or node_id ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$'),   -- null = about the whole workflow
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_by uuid default auth.uid(),
  created_by_name text check (created_by_name is null or char_length(created_by_name) <= 120),
  created_at timestamptz not null default now(),
  edited_by_name text check (edited_by_name is null or char_length(edited_by_name) <= 120),
  edited_at timestamptz,
  deleted_at timestamptz
);
create index if not exists automation_notes_node_idx on public.automation_notes (automation_id, node_id);
-- who wrote it, when and where never change after the note is added
create or replace function public.automation_notes_guard() returns trigger
language plpgsql security invoker set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    new.business_id := old.business_id; new.automation_id := old.automation_id; new.node_id := old.node_id;
    new.created_by := old.created_by; new.created_by_name := old.created_by_name; new.created_at := old.created_at;
  else
    if auth.uid() is not null then new.created_by := auth.uid(); end if;
    new.created_at := now();
  end if;
  return new;
end $$;
drop trigger if exists automation_notes_guard on public.automation_notes;
create trigger automation_notes_guard before insert or update on public.automation_notes
  for each row execute function public.automation_notes_guard();

-- 5. The event store: one row per thing that happened (scan / capture / time / hook / app / engine), once per key.
create table if not exists public.automation_events (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  type text not null check (type ~ '^[A-Za-z_]{1,40}$'),
  event_key text not null check (char_length(event_key) between 1 and 200),
  record_kind text check (record_kind is null or record_kind in ('contact', 'job', 'call', 'chat', 'task', 'supplier', 'employee', 'hook', 'none')),
  record_id text check (record_id is null or char_length(record_id) <= 100),
  contact_id uuid,
  at timestamptz not null,
  available_at timestamptz not null,                     -- at + the type's settle time (stage: 30 s for the app's Undo)
  ctx jsonb not null default '{}'::jsonb check (jsonb_typeof(ctx) = 'object' and octet_length(ctx::text) <= 8192),
  source text not null check (source in ('scan', 'capture', 'time', 'hook', 'app', 'engine')),
  cause_run_id uuid,                                     -- written by a workflow (automation.cause): its run, workflow and chain depth
  cause_automation_id uuid,
  chain_depth smallint not null default 0 check (chain_depth between 0 and 100),
  status text not null default 'new' check (status in ('new', 'processing', 'done', 'error')),
  lease_until timestamptz,
  attempts smallint not null default 0,
  processed_at timestamptz,
  error text check (error is null or char_length(error) <= 500),
  created_at timestamptz not null default now(),
  constraint automation_events_once unique (business_id, type, event_key)
);
create index if not exists automation_events_due_idx on public.automation_events (business_id, available_at) where status in ('new', 'processing');
create index if not exists automation_events_record_idx on public.automation_events (record_kind, record_id) where status = 'new';
create index if not exists automation_events_done_idx on public.automation_events (processed_at) where status = 'done';
create index if not exists automation_events_error_idx on public.automation_events (created_at) where status = 'error';

-- The event types some published workflow wants (written by the engine; the capture triggers and the app's "look now"
-- read it). Empty = every capture trigger is silent.
create table if not exists public.automation_wanted (
  business_id text not null default 'default',
  event_type text not null check (event_type ~ '^[A-Za-z_]{1,40}$'),
  updated_at timestamptz not null default now(),
  primary key (business_id, event_type)
);

-- Trigger evaluation log (matched rows + the first 200 unmatched per trigger per day) and the daily totals.
create table if not exists public.automation_trigger_log (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  automation_id uuid not null references public.automations(id) on delete cascade,
  trigger_id text not null check (char_length(trigger_id) between 1 and 40),
  event_id uuid,
  event_key text not null check (char_length(event_key) between 1 and 200),
  event_type text not null check (char_length(event_type) <= 40),
  record_kind text,
  record_id text,
  contact_id uuid,
  at timestamptz not null default now(),
  matched boolean not null,
  reason text check (reason is null or char_length(reason) <= 300),
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 4096),
  run_id uuid,
  constraint automation_trigger_log_once unique (automation_id, trigger_id, event_key)
);
create index if not exists automation_trigger_log_list_idx on public.automation_trigger_log (automation_id, trigger_id, at desc);
create index if not exists automation_trigger_log_at_idx on public.automation_trigger_log (at);

create table if not exists public.automation_trigger_daily (
  business_id text not null default 'default',
  automation_id uuid not null references public.automations(id) on delete cascade,
  trigger_id text not null check (char_length(trigger_id) between 1 and 40),
  day date not null,
  attempted integer not null default 0,
  matched integer not null default 0,
  enrolled integer not null default 0,
  reasons jsonb not null default '{}'::jsonb check (jsonb_typeof(reasons) = 'object' and octet_length(reasons::text) <= 8192),   -- {code: count}
  primary key (automation_id, trigger_id, day)
);
create index if not exists automation_trigger_daily_day_idx on public.automation_trigger_daily (day);

-- The re-entry ledger: every enrolment key that ever entered a workflow (never pruned while the workflow exists) and
-- the Split paths it took (a lead keeps its path on re-entry).
create table if not exists public.automation_enrollment_keys (
  business_id text not null default 'default',
  automation_id uuid not null references public.automations(id) on delete cascade,
  enrollment_key text not null check (char_length(enrollment_key) between 1 and 200),
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  runs integer not null default 1,
  splits jsonb not null default '{}'::jsonb check (jsonb_typeof(splits) = 'object'),
  primary key (automation_id, enrollment_key)
);

-- 6. Pause workflow date ranges (Global Workflow Settings): ≤ 15 per business, ≤ 15 days each, a workflow in at most
--    one range at any moment (annual ranges compared one year back, the same year and one year on).
create table if not exists public.automation_pauses (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  start_wall text not null check (start_wall ~ '^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$'),   -- business wall clock
  end_wall text not null check (end_wall ~ '^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$'),
  annually boolean not null default false,
  automation_ids uuid[] not null check (cardinality(automation_ids) between 1 and 500),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
-- 'YYYY-MM-DDTHH:MM' → timestamp, moved by whole years; 29 February in a year without one = 28 February.
create or replace function public.automation_wall_ts(p_wall text, p_shift_years integer default 0) returns timestamp
language plpgsql immutable set search_path = ''
as $$
declare m text[]; y integer; mo integer; d integer;
begin
  m := pg_catalog.regexp_match(coalesce(p_wall, ''), '^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$');
  if m is null then raise exception 'A pause date must look like 2026-12-24T17:00'; end if;
  y := m[1]::integer + coalesce(p_shift_years, 0); mo := m[2]::integer; d := m[3]::integer;
  if mo = 2 and d = 29 and not ((y % 4 = 0 and y % 100 <> 0) or y % 400 = 0) then d := 28; end if;
  return pg_catalog.make_timestamp(y, mo, d, m[4]::integer, m[5]::integer, 0);   -- refuses 30 February and the like
end $$;
create or replace function public.automation_pauses_guard() returns trigger
language plpgsql security invoker set search_path = ''
as $$
declare s timestamp; e timestamp; q record; qs timestamp; qe timestamp; ns timestamp; ne timestamp; base integer; k integer; n integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('automation-pauses:' || new.business_id, 0));
  if tg_op = 'UPDATE' then
    if new.business_id is distinct from old.business_id then raise exception 'business_id cannot change'; end if;
    new.created_by := old.created_by; new.created_at := old.created_at;
  else
    select count(*) into n from public.automation_pauses p where p.business_id = new.business_id;
    if n >= 15 then raise exception 'At most 15 pause dates'; end if;
    if auth.uid() is not null then new.created_by := auth.uid(); end if;
    new.created_at := now();
  end if;
  new.automation_ids := array(select distinct u.x from pg_catalog.unnest(new.automation_ids) as u(x) where u.x is not null order by 1);
  if coalesce(pg_catalog.cardinality(new.automation_ids), 0) < 1 then raise exception 'Choose at least one workflow to pause'; end if;
  s := public.automation_wall_ts(new.start_wall); e := public.automation_wall_ts(new.end_wall);
  if e <= s then raise exception 'The end must be after the start'; end if;
  if e - s > interval '15 days' then raise exception 'Maximum allowed difference between the start and end date is 15 days.'; end if;
  select count(*) into n from public.automations a
   where a.id = any(new.automation_ids) and a.business_id = new.business_id and a.deleted_at is null;
  if n <> pg_catalog.cardinality(new.automation_ids) then raise exception 'A chosen workflow does not exist (or was deleted)'; end if;
  for q in select p.start_wall, p.end_wall, p.annually from public.automation_pauses p
            where p.business_id = new.business_id and p.id <> new.id and p.automation_ids && new.automation_ids loop
    base := pg_catalog.date_part('year', s)::integer - pg_catalog.left(q.start_wall, 4)::integer;
    for k in -1..1 loop
      continue when k <> 0 and not (new.annually or q.annually);
      if q.annually then          -- the other range, moved to this one's year (−1 / 0 / +1)
        qs := public.automation_wall_ts(q.start_wall, base + k); qe := public.automation_wall_ts(q.end_wall, base + k); ns := s; ne := e;
      elsif new.annually then     -- this range, moved to the other one's year
        qs := public.automation_wall_ts(q.start_wall); qe := public.automation_wall_ts(q.end_wall);
        ns := public.automation_wall_ts(new.start_wall, k - base); ne := public.automation_wall_ts(new.end_wall, k - base);
      else
        qs := public.automation_wall_ts(q.start_wall); qe := public.automation_wall_ts(q.end_wall); ns := s; ne := e;
      end if;
      if ns < qe and qs < ne then raise exception 'A workflow should not be part of two or more date ranges that are overlapping.'; end if;
    end loop;
  end loop;
  return new;
end $$;
drop trigger if exists automation_pauses_guard on public.automation_pauses;
create trigger automation_pauses_guard before insert or update on public.automation_pauses
  for each row execute function public.automation_pauses_guard();
-- A changed or removed range lets the runs it held go on at once: only waiting runs whose hold watches 'pause' (the
-- engine puts 'pause' in the watch of a pause hold), only of the workflows in the old/new symmetric difference, or all
-- of them when the range itself moved. A new range holds nothing yet (runs meet it at their next action).
create or replace function public.automation_pauses_after() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare ids uuid[];
begin
  if tg_op = 'DELETE' then
    ids := old.automation_ids;
  elsif new.start_wall is distinct from old.start_wall or new.end_wall is distinct from old.end_wall or new.annually is distinct from old.annually then
    ids := array(select distinct u.x from pg_catalog.unnest(old.automation_ids || new.automation_ids) as u(x));
  else
    ids := array((select u.x from pg_catalog.unnest(old.automation_ids) as u(x) except select v.x from pg_catalog.unnest(new.automation_ids) as v(x))
                 union (select v.x from pg_catalog.unnest(new.automation_ids) as v(x) except select u.x from pg_catalog.unnest(old.automation_ids) as u(x)));
  end if;
  if coalesce(pg_catalog.cardinality(ids), 0) > 0 then
    update public.automation_runs r set due_at = now(), updated_at = now()
     where r.business_id = old.business_id and r.status = 'waiting' and r.automation_id = any(ids) and r.due_at > now() and 'pause' = any(r.watch);
  end if;
  return null;
end $$;
drop trigger if exists automation_pauses_after on public.automation_pauses;
create trigger automation_pauses_after after update or delete on public.automation_pauses
  for each row execute function public.automation_pauses_after();

-- 7. Inbound webhooks (the token itself is never stored: its sha-256 is, in a table nobody but the function reads),
--    custom values, templates, Needs-review acknowledgements, System-row folders, shared exact claims.
create table if not exists public.automation_hooks (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  automation_id uuid not null references public.automations(id) on delete cascade,
  trigger_id text not null check (char_length(trigger_id) between 1 and 40),
  token_hint text check (token_hint is null or char_length(token_hint) <= 8),
  sample jsonb not null default '[]'::jsonb check (jsonb_typeof(sample) = 'array' and octet_length(sample::text) <= 16384),   -- last 3 payloads' keys/types
  created_by uuid,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_used_at timestamptz,
  window_start timestamptz,
  window_count integer not null default 0
);
create index if not exists automation_hooks_automation_idx on public.automation_hooks (automation_id);
create index if not exists automation_hooks_revoked_idx on public.automation_hooks (revoked_at) where revoked_at is not null;
create table if not exists public.automation_hook_secrets (
  hook_id uuid primary key references public.automation_hooks(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$')
);

create table if not exists public.automation_custom_values (
  business_id text not null default 'default',
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  value text not null default '' check (char_length(value) <= 500),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (business_id, key)
);

create table if not exists public.automation_templates (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,59}$'),
  name text not null check (char_length(name) between 1 and 120),
  description text check (description is null or char_length(description) <= 500),
  category text check (category is null or char_length(category) <= 60),
  definition jsonb not null check (jsonb_typeof(definition) = 'object' and definition ->> 'schema' = '2' and octet_length(definition::text) <= 262144),
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  origin text not null default 'user' check (origin in ('system', 'user')),
  source_automation_id uuid references public.automations(id) on delete set null,
  created_by uuid,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists automation_templates_key_once on public.automation_templates (business_id, key) where deleted_at is null;

create table if not exists public.automation_reviews (
  automation_id uuid primary key references public.automations(id) on delete cascade,
  business_id text not null default 'default',
  acked_until timestamptz,
  acked_by uuid,
  acked_at timestamptz
);

create table if not exists public.automation_system_meta (
  business_id text not null default 'default',
  base text not null check (base ~ '^[A-Za-z][A-Za-z0-9_:-]{0,79}$'),
  folder_id uuid references public.automation_folders(id) on delete set null,
  primary key (business_id, base)
);

-- chatText:<session>, missedText:<call>, review:<job>: claimed once by whoever sends first (legacy function or engine).
create table if not exists public.system_claims (
  business_id text not null default 'default',
  key text not null check (char_length(key) between 1 and 200),
  at timestamptz not null default now(),
  primary key (business_id, key)
);

-- 8. Global Workflow Settings: default builder, error notifications, smart lists (validated here; the app checks the same).
alter table public.automation_settings
  add column if not exists default_builder text not null default 'standard',
  add column if not exists error_notify jsonb not null default '{}'::jsonb,
  add column if not exists smart_lists jsonb not null default '[]'::jsonb;
-- {on?: bool, push?: bool, users?: uuid[] (≤ 50), emails?: email[] (≤ 10)}; nothing else.
create or replace function public.automation_error_notify_ok(v jsonb) returns boolean
language plpgsql immutable set search_path = ''
as $$
declare k text; x jsonb;
begin
  if v is null or pg_catalog.jsonb_typeof(v) <> 'object' or pg_catalog.octet_length(v::text) > 4096 then return false; end if;
  for k in select pg_catalog.jsonb_object_keys(v) loop
    if k not in ('on', 'push', 'users', 'emails') then return false; end if;
  end loop;
  if v ? 'on' and pg_catalog.jsonb_typeof(v -> 'on') <> 'boolean' then return false; end if;
  if v ? 'push' and pg_catalog.jsonb_typeof(v -> 'push') <> 'boolean' then return false; end if;
  if v ? 'users' then
    if pg_catalog.jsonb_typeof(v -> 'users') <> 'array' or pg_catalog.jsonb_array_length(v -> 'users') > 50 then return false; end if;
    for x in select e.value from pg_catalog.jsonb_array_elements(v -> 'users') as e loop
      if pg_catalog.jsonb_typeof(x) <> 'string' or (x #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
    end loop;
  end if;
  if v ? 'emails' then
    if pg_catalog.jsonb_typeof(v -> 'emails') <> 'array' or pg_catalog.jsonb_array_length(v -> 'emails') > 10 then return false; end if;
    for x in select e.value from pg_catalog.jsonb_array_elements(v -> 'emails') as e loop
      if pg_catalog.jsonb_typeof(x) <> 'string' or pg_catalog.char_length(x #>> '{}') > 254
         or (x #>> '{}') !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' then return false; end if;
    end loop;
  end if;
  return true;
end $$;
-- [{id, name, filter}] (≤ 10): id like a step id, name 1–60, filter an object ≤ 4 KB; nothing else.
create or replace function public.automation_smart_lists_ok(v jsonb) returns boolean
language plpgsql immutable set search_path = ''
as $$
declare x jsonb; k text;
begin
  if v is null or pg_catalog.jsonb_typeof(v) <> 'array' or pg_catalog.jsonb_array_length(v) > 10 then return false; end if;
  for x in select e.value from pg_catalog.jsonb_array_elements(v) as e loop
    if pg_catalog.jsonb_typeof(x) <> 'object' then return false; end if;
    for k in select pg_catalog.jsonb_object_keys(x) loop
      if k not in ('id', 'name', 'filter') then return false; end if;
    end loop;
    if pg_catalog.jsonb_typeof(x -> 'id') is distinct from 'string' or (x ->> 'id') !~ '^[A-Za-z][A-Za-z0-9_]{0,39}$' then return false; end if;
    if pg_catalog.jsonb_typeof(x -> 'name') is distinct from 'string' or pg_catalog.char_length(pg_catalog.btrim(x ->> 'name')) not between 1 and 60 then return false; end if;
    if pg_catalog.jsonb_typeof(x -> 'filter') is distinct from 'object' or pg_catalog.octet_length((x -> 'filter')::text) > 4096 then return false; end if;
  end loop;
  return true;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.automation_settings'::regclass and conname = 'automation_settings_builder_kind') then
    alter table public.automation_settings add constraint automation_settings_builder_kind check (default_builder in ('standard', 'advanced'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.automation_settings'::regclass and conname = 'automation_settings_error_notify') then
    alter table public.automation_settings add constraint automation_settings_error_notify check (public.automation_error_notify_ok(error_notify));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.automation_settings'::regclass and conname = 'automation_settings_smart_lists') then
    alter table public.automation_settings add constraint automation_settings_smart_lists check (public.automation_smart_lists_ok(smart_lists));
  end if;
end $$;

-- 9. The engine's own state: capture failures (read by the nightly data check), watermarks, housekeeping cursor.
alter table public.automation_state
  add column if not exists capture_errors integer not null default 0,
  add column if not exists capture_error_last text,
  add column if not exists capture_error_at timestamptz,
  add column if not exists wanted_hash text,
  add column if not exists scan_marks jsonb not null default '{}'::jsonb,
  add column if not exists housekeeping jsonb not null default '{}'::jsonb,
  add column if not exists v2_migrated_at timestamptz,
  add column if not exists error_notice_at timestamptz,
  add column if not exists phase4_compat boolean not null default true;   -- true = phase-1 compat mode (phase-4 scanners + enqueue)

-- 10. automation_runs: where a run is in the step tree, its counters, re-entry lock, chain, watch, stop on reply.
alter table public.automation_runs
  add column if not exists trigger_id text,
  add column if not exists cursor_step text,                              -- null on a phase-4 run: steps[step_index].id
  add column if not exists "loop" smallint not null default 0,           -- Go to passes so far (one action claim per run, step, loop)
  add column if not exists visits jsonb not null default '{}'::jsonb,
  add column if not exists steps_done integer not null default 0,
  add column if not exists steps_today integer not null default 0,
  add column if not exists steps_day date,
  add column if not exists enrollment_key text,
  add column if not exists active_lock text,                              -- = enrollment key while waiting/running; null = no lock (legacy_always)
  add column if not exists chain_depth smallint not null default 0,
  add column if not exists cause_run_id uuid,
  add column if not exists parent_run_id uuid,
  add column if not exists source text not null default 'trigger',
  add column if not exists watch text[],                                  -- event types that wake this held run ('pause' for a pause hold)
  add column if not exists recheck boolean not null default false,       -- a heartbeat recheck: claimed after the due runs
  add column if not exists stop_on_reply boolean not null default false,
  add column if not exists first_sent_at timestamptz,
  add column if not exists exit_reason text,
  add column if not exists remove_requested boolean not null default false,
  add column if not exists revision integer;
-- The widened checks (new record kinds and end states). The phase-4 inline checks have PostgreSQL's default names.
alter table public.automation_runs drop constraint if exists automation_runs_record_kind_check;
alter table public.automation_runs drop constraint if exists automation_runs_record_kind_v2;
alter table public.automation_runs add constraint automation_runs_record_kind_v2
  check (record_kind in ('contact', 'job', 'call', 'chat', 'task', 'supplier', 'employee', 'hook', 'none'));
alter table public.automation_runs drop constraint if exists automation_runs_status_check;
alter table public.automation_runs drop constraint if exists automation_runs_status_v2;
alter table public.automation_runs add constraint automation_runs_status_v2
  check (status in ('waiting', 'running', 'done', 'skipped', 'cancelled', 'failed', 'removed', 'stopped'));
alter table public.automation_runs drop constraint if exists automation_runs_source_kind;
alter table public.automation_runs add constraint automation_runs_source_kind check (source in ('trigger', 'manual', 'workflow'));
alter table public.automation_runs drop constraint if exists automation_runs_v2_lengths;
alter table public.automation_runs add constraint automation_runs_v2_lengths check (
  (trigger_id is null or char_length(trigger_id) <= 40) and (cursor_step is null or char_length(cursor_step) <= 40)
  and (enrollment_key is null or char_length(enrollment_key) <= 200) and (active_lock is null or char_length(active_lock) <= 200)
  and (exit_reason is null or char_length(exit_reason) <= 60) and (watch is null or cardinality(watch) <= 50));
do $$ begin
  -- no other check on these columns may be left (it would refuse the new values): stop here instead of half-working
  if exists (select 1 from pg_constraint where conrelid = 'public.automation_runs'::regclass and contype = 'c'
              and conname not in ('automation_runs_record_kind_v2', 'automation_runs_status_v2', 'automation_runs_source_kind', 'automation_runs_v2_lengths')
              and pg_get_constraintdef(oid) ~ '\m(record_kind|status)\M') then
    raise exception 'automation_runs has another check on record_kind/status (see the check-before query): rename it in this part first';
  end if;
end $$;
-- one waiting/running run per workflow and enrolment key (the re-entry lock), and what the engine and screens look up
create unique index if not exists automation_runs_active_lock on public.automation_runs (automation_id, active_lock) where active_lock is not null;
create index if not exists automation_runs_contact_waiting_idx on public.automation_runs (business_id, contact_id) where status = 'waiting';
create index if not exists automation_runs_list_idx on public.automation_runs (automation_id, created_at desc);
create index if not exists automation_runs_status_idx on public.automation_runs (automation_id, status);
create index if not exists automation_runs_recheck_idx on public.automation_runs (status, recheck, due_at) where status = 'waiting';
-- A run that is no longer waiting or running gives its lock back (whoever ends it: engine, Remove, a cancel).
create or replace function public.automation_runs_lock_clear() returns trigger
language plpgsql security invoker set search_path = ''
as $$
begin
  if new.active_lock is not null and new.status not in ('waiting', 'running') then new.active_lock := null; end if;
  return new;
end $$;
drop trigger if exists automation_runs_lock_clear on public.automation_runs;
create trigger automation_runs_lock_clear before insert or update on public.automation_runs
  for each row execute function public.automation_runs_lock_clear();

-- 11. automation_log becomes the execution log (enroll / step / action / exit rows). Every phase-4 row is an 'action'
--     row of loop 0, so the swap below is equivalent for phase 4 (design Appendix A, E2/E36).
alter table public.automation_log
  add column if not exists row_kind text not null default 'action',
  add column if not exists step_type text,
  add column if not exists step_name text,
  add column if not exists "loop" smallint not null default 0,
  add column if not exists seq integer,
  add column if not exists version integer,
  add column if not exists revision integer,
  add column if not exists trigger_id text,
  add column if not exists detail jsonb,                                  -- no secrets, no headers; a message preview ≤ 500 chars
  add column if not exists next_at timestamptz;
alter table public.automation_log alter column channel drop not null;   -- step / exit / enroll rows have no channel or audience
alter table public.automation_log alter column audience drop not null;
alter table public.automation_log drop constraint if exists automation_log_channel_check;
alter table public.automation_log drop constraint if exists automation_log_channel_v2;
alter table public.automation_log add constraint automation_log_channel_v2
  check (channel in ('push', 'task', 'email', 'text', 'chat', 'review', 'webhook', 'record'));
alter table public.automation_log drop constraint if exists automation_log_status_check;
alter table public.automation_log drop constraint if exists automation_log_status_v2;
alter table public.automation_log add constraint automation_log_status_v2
  check (status in ('sending', 'sent', 'queued', 'waiting_phone', 'skipped', 'failed',
                    'added', 'executed', 'waiting', 'wait_finished', 'branch', 'jumped', 'finished', 'removed', 'stopped'));
alter table public.automation_log drop constraint if exists automation_log_row_kind;
alter table public.automation_log add constraint automation_log_row_kind check (row_kind in ('enroll', 'step', 'action', 'exit'));
alter table public.automation_log drop constraint if exists automation_log_action_channel;   -- an action row always has both (the cap counts them)
alter table public.automation_log add constraint automation_log_action_channel check (row_kind <> 'action' or (channel is not null and audience is not null));
alter table public.automation_log drop constraint if exists automation_log_v2_sizes;
alter table public.automation_log add constraint automation_log_v2_sizes check (
  (detail is null or (jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 16384))
  and (step_type is null or char_length(step_type) <= 60) and (step_name is null or char_length(step_name) <= 120)
  and (trigger_id is null or char_length(trigger_id) <= 40));
do $$ begin
  if exists (select 1 from pg_constraint where conrelid = 'public.automation_log'::regclass and contype = 'c'
              and conname not in ('automation_log_channel_v2', 'automation_log_status_v2', 'automation_log_row_kind', 'automation_log_action_channel',
                                  'automation_log_v2_sizes', 'automation_log_audience_check')
              and pg_get_constraintdef(oid) ~ '\m(channel|status|audience)\M') then
    raise exception 'automation_log has another check on channel/status/audience (see the check-before query): rename it in this part first';
  end if;
end $$;
-- THE SWAP (same transaction as the two functions below): one ACTION row per (run, step, Go-to pass).
create unique index if not exists automation_log_action_once on public.automation_log (run_id, step_id, "loop") where row_kind = 'action';
alter table public.automation_log drop constraint if exists automation_log_once;
create index if not exists automation_log_run_seq_idx on public.automation_log (run_id, seq);
create index if not exists automation_log_step_idx on public.automation_log (automation_id, step_id, at);
create index if not exists automation_log_failed_idx on public.automation_log (automation_id, at) where status = 'failed';

-- A customer message's claim (phase 4's, per Go-to pass): the same per-customer advisory locks in sorted order; 'done'
-- when an ACTION row of (run, step, loop) exists (step rows never block it); the 24-hour cap counts ACTION rows only;
-- the claimed row is an action row of that loop. → 'claimed:<log id>' | 'capped' | 'done'.
create or replace function public.automation_claim_customer_v2(p_business text, p_run uuid, p_step text, p_automation uuid, p_name text,
  p_channel text, p_record_kind text, p_record_id text, p_contact uuid, p_recipients text[], p_since timestamptz, p_cap integer, p_now timestamptz, p_loop integer)
returns text language plpgsql volatile security definer set search_path = ''
as $$
declare k text; n integer; got uuid; lp smallint := coalesce(p_loop, 0)::smallint;
begin
  for k in select distinct x from pg_catalog.unnest(pg_catalog.array_append(coalesce(p_recipients, '{}'::text[]), coalesce(p_contact::text, ''))) as u(x)
            where x <> '' order by 1 loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('automation-customer:' || p_business || ':' || k, 0));
  end loop;
  if exists (select 1 from public.automation_log l where l.run_id = p_run and l.step_id = p_step and l.row_kind = 'action' and l."loop" = lp) then return 'done'; end if;
  select count(*) into n from public.automation_log l
   where l.business_id = p_business and l.row_kind = 'action' and l.audience = 'customer' and l.status in ('sending', 'sent', 'queued') and l.at >= p_since
     and ((p_contact is not null and l.contact_id = p_contact) or l.recipient = any(coalesce(p_recipients, '{}'::text[])));
  if n >= greatest(coalesce(p_cap, 1), 1) then return 'capped'; end if;
  insert into public.automation_log (business_id, run_id, step_id, row_kind, "loop", status, channel, audience, automation_id, automation_name,
                                     record_kind, record_id, contact_id, recipient, at)
  values (p_business, p_run, p_step, 'action', lp, 'sending', p_channel, 'customer', p_automation, p_name, p_record_kind, p_record_id, p_contact,
          (coalesce(p_recipients, '{}'::text[]))[1], p_now)
  on conflict (run_id, step_id, "loop") where row_kind = 'action' do nothing
  returning id into got;
  return case when got is null then 'done' else 'claimed:' || got::text end;
end $$;
-- The phase-4 signature stays (the deployed phase-4 function calls it until the v2 function replaces it): loop 0.
create or replace function public.automation_claim_customer(p_business text, p_run uuid, p_step text, p_automation uuid, p_name text,
  p_channel text, p_record_kind text, p_record_id text, p_contact uuid, p_recipients text[], p_since timestamptz, p_cap integer, p_now timestamptz)
returns text language sql volatile security definer set search_path = ''
as $$
  select public.automation_claim_customer_v2(p_business, p_run, p_step, p_automation, p_name, p_channel, p_record_kind, p_record_id, p_contact,
                                             p_recipients, p_since, p_cap, p_now, 0)
$$;

-- 12. Capture triggers (design §2.9): silent while nothing is wanted; whitelisted columns compared directly (no
--     to_jsonb(new)); values clipped to 200 chars; a write made by a workflow (automation.cause = '<run>:<depth>:<automation>',
--     set by automation_apply) is stamped with that cause, so a workflow never re-fires itself and chains stop at depth 3.
--     The whole body sits in an exception block whose handler only counts the failure (with its own nested handler):
--     a capture failure can NEVER roll back the app's save (Appendix A, E1/E37). The failure counter never WAITS: it
--     takes the one automation_state row with SKIP LOCKED, so while another transaction holds that row (an earlier
--     failing capture of a longer transaction, or the engine) this failure is simply not counted (the other one is), and
--     the save is never held up or cancelled by statement_timeout (query_canceled is not caught by WHEN OTHERS).
--     The GUC automation.capture_test_error = 'on' forces that failure (the staging check uses it; nothing else sets it).
-- Settle time per type in seconds (stage: the app's 30-second Undo; = the engine registry's settleMs, test-pinned).
create or replace function public.automation_settle_seconds(p_type text) returns integer
language sql immutable set search_path = ''
as $$ select case p_type when 'stage' then 30 else 0 end $$;
-- One captured event (on conflict do nothing: the same key twice is one event).
create or replace function public.automation_capture_put(p_business text, p_type text, p_key text, p_kind text, p_id text, p_contact uuid, p_ctx jsonb)
returns void language plpgsql volatile security definer set search_path = ''
as $$
declare m text[]; run uuid; aut uuid; depth integer := 0;
begin
  m := pg_catalog.regexp_match(coalesce(pg_catalog.current_setting('automation.cause', true), ''),
         '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9]{1,3}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');
  if m is not null then run := m[1]::uuid; depth := least(m[2]::integer + 1, 100); aut := m[3]::uuid; end if;
  insert into public.automation_events (business_id, type, event_key, record_kind, record_id, contact_id, at, available_at, ctx, source,
                                        cause_run_id, cause_automation_id, chain_depth)
  values (p_business, p_type, pg_catalog.left(p_key, 200), p_kind, pg_catalog.left(p_id, 100), p_contact, now(),
          now() + pg_catalog.make_interval(secs => public.automation_settle_seconds(p_type)), coalesce(p_ctx, '{}'::jsonb), 'capture', run, aut, depth)
  on conflict (business_id, type, event_key) do nothing;
end $$;

-- contacts: Lead changed (the engine's CONTACT_CHANGED_FIELDS; estimated_value is the field "quote_amount"), Lead tag
-- (also on INSERT), Customer booked a job + Job booking status (booked_for: booked / rescheduled / cancelled), Lead
-- status changed (won / lost / open by the catalog's keys), Quote status (Q5 default: the quote amount is first filled).
create or replace function public.automation_capture_contacts() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare b text; w text[]; tx text; id text; chg jsonb := '[]'::jsonb; x jsonb; t text; bk text; st text;
begin
  begin
    if pg_catalog.current_setting('automation.capture_test_error', true) = 'on' then raise exception 'forced capture error (staging check)'; end if;
    b := public.current_business_id();
    select pg_catalog.array_agg(wt.event_type) into w from public.automation_wanted wt where wt.business_id = b;
    if w is null then return null; end if;
    tx := pg_catalog.txid_current()::text; id := new.id::text;
    if tg_op = 'UPDATE' and 'contact_changed' = any(w) then
      if new.full_name is distinct from old.full_name then chg := chg || pg_catalog.jsonb_build_object('field', 'full_name', 'old', pg_catalog.left(old.full_name::text, 200), 'new', pg_catalog.left(new.full_name::text, 200)); end if;
      if new.phone is distinct from old.phone then chg := chg || pg_catalog.jsonb_build_object('field', 'phone', 'old', pg_catalog.left(old.phone::text, 200), 'new', pg_catalog.left(new.phone::text, 200)); end if;
      if new.email is distinct from old.email then chg := chg || pg_catalog.jsonb_build_object('field', 'email', 'old', pg_catalog.left(old.email::text, 200), 'new', pg_catalog.left(new.email::text, 200)); end if;
      if new.postcode is distinct from old.postcode then chg := chg || pg_catalog.jsonb_build_object('field', 'postcode', 'old', pg_catalog.left(old.postcode::text, 200), 'new', pg_catalog.left(new.postcode::text, 200)); end if;
      if new.division is distinct from old.division then chg := chg || pg_catalog.jsonb_build_object('field', 'division', 'old', pg_catalog.left(old.division::text, 200), 'new', pg_catalog.left(new.division::text, 200)); end if;
      if new.source is distinct from old.source then chg := chg || pg_catalog.jsonb_build_object('field', 'source', 'old', pg_catalog.left(old.source::text, 200), 'new', pg_catalog.left(new.source::text, 200)); end if;
      if new.next_follow_up is distinct from old.next_follow_up then chg := chg || pg_catalog.jsonb_build_object('field', 'next_follow_up', 'old', pg_catalog.left(old.next_follow_up::text, 200), 'new', pg_catalog.left(new.next_follow_up::text, 200)); end if;
      if new.booked_for is distinct from old.booked_for then chg := chg || pg_catalog.jsonb_build_object('field', 'booked_for', 'old', pg_catalog.left(old.booked_for::text, 200), 'new', pg_catalog.left(new.booked_for::text, 200)); end if;
      if new.estimated_value is distinct from old.estimated_value then chg := chg || pg_catalog.jsonb_build_object('field', 'quote_amount', 'old', pg_catalog.left(old.estimated_value::text, 200), 'new', pg_catalog.left(new.estimated_value::text, 200)); end if;
      if new.lost_reason is distinct from old.lost_reason then chg := chg || pg_catalog.jsonb_build_object('field', 'lost_reason', 'old', pg_catalog.left(old.lost_reason::text, 200), 'new', pg_catalog.left(new.lost_reason::text, 200)); end if;
      for x in select e.value from pg_catalog.jsonb_array_elements(chg) as e loop
        perform public.automation_capture_put(b, 'contact_changed', id || ':chg:' || (x ->> 'field') || ':' || tx, 'contact', id, new.id, x);
      end loop;
    end if;
    if 'contact_tag' = any(w) then
      for t in select a.x from pg_catalog.unnest(coalesce(new.tags, '{}'::text[])) as a(x) where a.x is not null and a.x <> ''
               except select o.x from pg_catalog.unnest(case when tg_op = 'UPDATE' then coalesce(old.tags, '{}'::text[]) else '{}'::text[] end) as o(x) loop
        perform public.automation_capture_put(b, 'contact_tag', id || ':tag:+:' || pg_catalog.left(t, 100) || ':' || tx, 'contact', id, new.id,
                                              pg_catalog.jsonb_build_object('tag', pg_catalog.left(t, 100), 'action', 'added'));
      end loop;
      if tg_op = 'UPDATE' then
        for t in select o.x from pg_catalog.unnest(coalesce(old.tags, '{}'::text[])) as o(x) where o.x is not null and o.x <> ''
                 except select a.x from pg_catalog.unnest(coalesce(new.tags, '{}'::text[])) as a(x) loop
          perform public.automation_capture_put(b, 'contact_tag', id || ':tag:-:' || pg_catalog.left(t, 100) || ':' || tx, 'contact', id, new.id,
                                                pg_catalog.jsonb_build_object('tag', pg_catalog.left(t, 100), 'action', 'removed'));
        end loop;
      end if;
    end if;
    if tg_op = 'INSERT' then bk := case when new.booked_for is not null then 'booked' end;
    elsif new.booked_for is distinct from old.booked_for then
      bk := case when old.booked_for is null then 'booked' when new.booked_for is null then 'cancelled' else 'rescheduled' end;
    end if;
    if bk = 'booked' and 'job_booked' = any(w) then
      perform public.automation_capture_put(b, 'job_booked', id || ':booked:' || (pg_catalog.to_jsonb(new.booked_for) #>> '{}'), 'contact', id, new.id,
                                            pg_catalog.jsonb_build_object('booked_for', pg_catalog.to_jsonb(new.booked_for) #>> '{}'));
    end if;
    if bk is not null and 'booking_status' = any(w) then
      perform public.automation_capture_put(b, 'booking_status', id || ':bk:' || bk || ':' || tx, 'contact', id, new.id,
        pg_catalog.jsonb_build_object('status', bk, 'booked_for', pg_catalog.to_jsonb(new.booked_for) #>> '{}',
                                      'old_booked_for', case when tg_op = 'UPDATE' then pg_catalog.to_jsonb(old.booked_for) #>> '{}' end));
    end if;
    if tg_op = 'UPDATE' and new.status is distinct from old.status and 'lead_status' = any(w) then
      st := case when new.status::text = public.automation_catalog_key('stageWon', 'Won') then 'won'
                 when new.status::text = public.automation_catalog_key('stageLost', 'Lost') then 'lost' else 'open' end;
      perform public.automation_capture_put(b, 'lead_status', id || ':st:' || pg_catalog.left(coalesce(new.status::text, ''), 60) || ':' || tx, 'contact', id, new.id,
        pg_catalog.jsonb_build_object('stage', pg_catalog.left(new.status::text, 200), 'from', pg_catalog.left(old.status::text, 200), 'status', st));
    end if;
    if 'estimates' = any(w) and coalesce(new.estimated_value, 0) > 0
       and (tg_op = 'INSERT' or coalesce(old.estimated_value, 0) <= 0) then
      perform public.automation_capture_put(b, 'estimates', id || ':quote:' || tx, 'contact', id, new.id, pg_catalog.jsonb_build_object('status', 'sent'));
    end if;
  exception when others then
    begin
      update public.automation_state set capture_errors = capture_errors + 1, capture_error_last = pg_catalog.left(tg_table_name || ': ' || sqlerrm, 200),
             capture_error_at = now()
       where business_id = (select z.business_id from public.automation_state z where z.business_id = coalesce(b, public.current_business_id())
                              for update skip locked);
    exception when others then null;
    end;
  end;
  return null;
end $$;

-- tasks: Task added (INSERT), Task completed (status becomes the catalog's done key).
create or replace function public.automation_capture_tasks() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare b text; w text[]; id text; cid uuid;
begin
  begin
    if pg_catalog.current_setting('automation.capture_test_error', true) = 'on' then raise exception 'forced capture error (staging check)'; end if;
    b := public.current_business_id();
    select pg_catalog.array_agg(wt.event_type) into w from public.automation_wanted wt where wt.business_id = b;
    if w is null then return null; end if;
    id := new.id::text; cid := nullif(new.contact_id::text, '')::uuid;
    if tg_op = 'INSERT' and 'task_added' = any(w) then
      perform public.automation_capture_put(b, 'task_added', id || ':added', 'task', id, cid,
        pg_catalog.jsonb_build_object('title', pg_catalog.left(new.title::text, 200), 'due', pg_catalog.to_jsonb(new.due) #>> '{}'));
    end if;
    if tg_op = 'UPDATE' and new.status is distinct from old.status and 'task_completed' = any(w)
       and new.status::text = public.automation_catalog_key('taskDone', 'Done') then
      perform public.automation_capture_put(b, 'task_completed', id || ':done:' || pg_catalog.txid_current()::text, 'task', id, cid,
        pg_catalog.jsonb_build_object('title', pg_catalog.left(new.title::text, 200), 'status', pg_catalog.left(new.status::text, 60)));
    end if;
  exception when others then
    begin
      update public.automation_state set capture_errors = capture_errors + 1, capture_error_last = pg_catalog.left(tg_table_name || ': ' || sqlerrm, 200),
             capture_error_at = now()
       where business_id = (select z.business_id from public.automation_state z where z.business_id = coalesce(b, public.current_business_id())
                              for update skip locked);
    exception when others then null;
    end;
  end;
  return null;
end $$;

-- lead_messages: Lead replied (inbound), User replied (outbound, written by a person: auto = false).
create or replace function public.automation_capture_messages() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare b text; w text[];
begin
  begin
    if pg_catalog.current_setting('automation.capture_test_error', true) = 'on' then raise exception 'forced capture error (staging check)'; end if;
    b := public.current_business_id();
    select pg_catalog.array_agg(wt.event_type) into w from public.automation_wanted wt where wt.business_id = b;
    if w is null or new.contact_id is null then return null; end if;
    if new.direction = 'in' and 'customer_replied' = any(w) then
      perform public.automation_capture_put(b, 'customer_replied', 'msg:' || new.id::text, 'contact', new.contact_id::text, new.contact_id,
        pg_catalog.jsonb_build_object('channel', new.channel, 'message_id', new.id::text, 'at', pg_catalog.to_jsonb(new.at) #>> '{}'));
    elsif new.direction = 'out' and coalesce(new.auto, false) = false and 'user_replied' = any(w) then
      perform public.automation_capture_put(b, 'user_replied', 'msg:' || new.id::text, 'contact', new.contact_id::text, new.contact_id,
        pg_catalog.jsonb_build_object('channel', new.channel, 'message_id', new.id::text, 'at', pg_catalog.to_jsonb(new.at) #>> '{}',
                                      'author', pg_catalog.left(new.author, 80), 'author_id', new.author_id::text));
    end if;
  exception when others then
    begin
      update public.automation_state set capture_errors = capture_errors + 1, capture_error_last = pg_catalog.left(tg_table_name || ': ' || sqlerrm, 200),
             capture_error_at = now()
       where business_id = (select z.business_id from public.automation_state z where z.business_id = coalesce(b, public.current_business_id())
                              for update skip locked);
    exception when others then null;
    end;
  end;
  return null;
end $$;

-- customer_opt_outs: Lead DND on (INSERT) / off (DELETE, which reads OLD).
create or replace function public.automation_capture_optouts() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare b text; w text[]; r public.customer_opt_outs; onoff text;
begin
  begin
    if pg_catalog.current_setting('automation.capture_test_error', true) = 'on' then raise exception 'forced capture error (staging check)'; end if;
    b := public.current_business_id();
    select pg_catalog.array_agg(wt.event_type) into w from public.automation_wanted wt where wt.business_id = b;
    if w is null or not ('contact_dnd' = any(w)) then return null; end if;
    if tg_op = 'DELETE' then r := old; onoff := 'off'; else r := new; onoff := 'on'; end if;
    if r.contact_id is null then return null; end if;
    perform public.automation_capture_put(b, 'contact_dnd', r.id::text || ':' || onoff, 'contact', r.contact_id::text, r.contact_id,
                                          pg_catalog.jsonb_build_object('action', onoff, 'channel', r.channel));
  exception when others then
    begin
      update public.automation_state set capture_errors = capture_errors + 1, capture_error_last = pg_catalog.left(tg_table_name || ': ' || sqlerrm, 200),
             capture_error_at = now()
       where business_id = (select z.business_id from public.automation_state z where z.business_id = coalesce(b, public.current_business_id())
                              for update skip locked);
    exception when others then null;
    end;
  end;
  return null;
end $$;

-- jobs: Payment received (payment_status becomes the catalog's paid key).
create or replace function public.automation_capture_jobs() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare b text; w text[];
begin
  begin
    if pg_catalog.current_setting('automation.capture_test_error', true) = 'on' then raise exception 'forced capture error (staging check)'; end if;
    b := public.current_business_id();
    select pg_catalog.array_agg(wt.event_type) into w from public.automation_wanted wt where wt.business_id = b;
    if w is null or not ('payment_received' = any(w)) then return null; end if;
    if new.payment_status is distinct from old.payment_status and new.payment_status::text = public.automation_catalog_key('jobPaid', 'Paid') then
      perform public.automation_capture_put(b, 'payment_received', new.id::text || ':paid:' || pg_catalog.txid_current()::text, 'job', new.id::text,
        nullif(new.contact_id::text, '')::uuid, pg_catalog.jsonb_build_object('status', pg_catalog.left(new.payment_status::text, 60)));
    end if;
  exception when others then
    begin
      update public.automation_state set capture_errors = capture_errors + 1, capture_error_last = pg_catalog.left(tg_table_name || ': ' || sqlerrm, 200),
             capture_error_at = now()
       where business_id = (select z.business_id from public.automation_state z where z.business_id = coalesce(b, public.current_business_id())
                              for update skip locked);
    exception when others then null;
    end;
  end;
  return null;
end $$;

-- suppliers: Contractor agreement signed ('signed' is the contractor-sign function's own value).
create or replace function public.automation_capture_suppliers() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare b text; w text[];
begin
  begin
    if pg_catalog.current_setting('automation.capture_test_error', true) = 'on' then raise exception 'forced capture error (staging check)'; end if;
    b := public.current_business_id();
    select pg_catalog.array_agg(wt.event_type) into w from public.automation_wanted wt where wt.business_id = b;
    if w is null or not ('documents_contracts' = any(w)) then return null; end if;
    if new.agreement_status is distinct from old.agreement_status and new.agreement_status = 'signed' then
      perform public.automation_capture_put(b, 'documents_contracts',
        'sup:' || new.id::text || ':signed:' || coalesce(pg_catalog.to_jsonb(new.agreement_signed_at) #>> '{}', pg_catalog.txid_current()::text),
        'supplier', new.id::text, null, pg_catalog.jsonb_build_object('status', 'signed'));
    end if;
  exception when others then
    begin
      update public.automation_state set capture_errors = capture_errors + 1, capture_error_last = pg_catalog.left(tg_table_name || ': ' || sqlerrm, 200),
             capture_error_at = now()
       where business_id = (select z.business_id from public.automation_state z where z.business_id = coalesce(b, public.current_business_id())
                              for update skip locked);
    exception when others then null;
    end;
  end;
  return null;
end $$;

drop trigger if exists automation_capture on public.contacts;
create trigger automation_capture after insert or update on public.contacts for each row execute function public.automation_capture_contacts();
drop trigger if exists automation_capture on public.tasks;
create trigger automation_capture after insert or update on public.tasks for each row execute function public.automation_capture_tasks();
drop trigger if exists automation_capture on public.lead_messages;
create trigger automation_capture after insert on public.lead_messages for each row execute function public.automation_capture_messages();
drop trigger if exists automation_capture on public.customer_opt_outs;
create trigger automation_capture after insert or delete on public.customer_opt_outs for each row execute function public.automation_capture_optouts();
drop trigger if exists automation_capture on public.jobs;
create trigger automation_capture after update of payment_status on public.jobs for each row execute function public.automation_capture_jobs();
drop trigger if exists automation_capture on public.suppliers;
create trigger automation_capture after update of agreement_status on public.suppliers for each row execute function public.automation_capture_suppliers();

-- 13. Engine RPCs (service role only).
-- Enrolment (design §3.3), one transaction under a lock on (workflow, enrolment key):
--   an active lock held → 'already_enrolled'; p_reentry 'off' (the EFFECTIVE rule: the engine passes 'after_exit' for an
--   alwaysReenter trigger) and the key already in the ledger → 'reentry_off'; the same event twice → 'duplicate_event';
--   else the run (due_at = p_due or the event's time, cursor_step = p_start), the ledger, enrolled_total + 1 and one
--   'enroll' log row → 'enrolled:<run id>'. A workflow that is not in p_business or is deleted → 'not_found'.
create or replace function public.automation_enroll(p_business text, p_automation uuid, p_version integer, p_revision integer, p_trigger text,
  p_event_key text, p_event_type text, p_event_at timestamptz, p_record_kind text, p_record_id text, p_contact uuid, p_enroll_key text,
  p_lock_key text, p_reentry text, p_start text, p_context jsonb, p_source text, p_chain integer, p_cause uuid, p_parent uuid,
  p_stop_on_reply boolean, p_now timestamptz, p_due timestamptz default null)
returns text language plpgsql volatile security definer set search_path = ''
as $$
declare rid uuid; nm text; cn text; due timestamptz := coalesce(p_due, p_event_at);
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('automation-enroll:' || p_automation::text || ':' || coalesce(p_enroll_key, p_event_key), 0));
  select a.name into nm from public.automations a where a.id = p_automation and a.business_id = p_business and a.deleted_at is null;
  if nm is null then return 'not_found'; end if;
  if p_lock_key is not null and exists (select 1 from public.automation_runs r where r.automation_id = p_automation and r.active_lock = p_lock_key) then
    return 'already_enrolled';
  end if;
  if p_reentry = 'off' and p_enroll_key is not null
     and exists (select 1 from public.automation_enrollment_keys k where k.automation_id = p_automation and k.enrollment_key = p_enroll_key) then
    return 'reentry_off';
  end if;
  begin
    insert into public.automation_runs (business_id, automation_id, automation_version, revision, trigger_id, event_key, event_type, event_at,
      record_kind, record_id, contact_id, status, step_index, anchor_at, due_at, context, cursor_step, enrollment_key, active_lock,
      chain_depth, cause_run_id, parent_run_id, source, stop_on_reply)
    values (p_business, p_automation, p_version, p_revision, p_trigger, p_event_key, p_event_type, p_event_at,
      p_record_kind, p_record_id, p_contact, 'waiting', 0, due, due, coalesce(p_context, '{}'::jsonb), p_start, p_enroll_key, p_lock_key,
      least(greatest(coalesce(p_chain, 0), 0), 100), p_cause, p_parent, coalesce(p_source, 'trigger'), coalesce(p_stop_on_reply, false))
    returning id into rid;
  exception when unique_violation then
    get stacked diagnostics cn = constraint_name;
    return case when cn = 'automation_runs_once' then 'duplicate_event' else 'already_enrolled' end;
  end;
  if p_enroll_key is not null then
    insert into public.automation_enrollment_keys as k (business_id, automation_id, enrollment_key, first_at, last_at, runs)
    values (p_business, p_automation, p_enroll_key, p_now, p_now, 1)
    on conflict (automation_id, enrollment_key) do update set last_at = excluded.last_at, runs = k.runs + 1;
  end if;
  update public.automations set enrolled_total = enrolled_total + 1 where id = p_automation;
  insert into public.automation_log (business_id, run_id, step_id, row_kind, status, automation_id, automation_name, record_kind, record_id,
                                     contact_id, trigger_id, version, revision, seq, "loop", detail, at)
  values (p_business, rid, coalesce(p_trigger, coalesce(p_source, 'trigger')), 'enroll', 'added', p_automation, nm, p_record_kind, p_record_id,
          p_contact, p_trigger, p_version, p_revision, 0, 0,
          pg_catalog.jsonb_build_object('source', coalesce(p_source, 'trigger'), 'event_type', p_event_type, 'event_key', pg_catalog.left(p_event_key, 200),
                                        'start', p_start, 'parent_run_id', p_parent), p_now);
  return 'enrolled:' || rid::text;
end $$;

-- The matcher's claim: due events (available_at ≤ now: a settling stage move waits), new or with an expired lease, oldest
-- first, optionally one event or one record's pending events (the app's "look now" on a capture type).
create or replace function public.automation_claim_events(p_business text, p_now timestamptz, p_limit integer, p_lease_s integer,
  p_id uuid default null, p_record_kind text default null, p_record_id text default null)
returns setof public.automation_events language sql volatile security definer set search_path = ''
as $$
  update public.automation_events e
     set status = 'processing', lease_until = p_now + pg_catalog.make_interval(secs => greatest(p_lease_s, 30)), attempts = e.attempts + 1
   where e.id in (
     select x.id from public.automation_events x
      where x.business_id = p_business and x.available_at <= p_now
        and (x.status = 'new' or (x.status = 'processing' and x.lease_until < p_now))
        and (p_id is null or x.id = p_id)
        and (p_record_kind is null or (x.record_kind = p_record_kind and x.record_id = p_record_id))
      order by x.available_at, x.at, x.id
      limit least(greatest(p_limit, 1), 500)
      for update skip locked)
  returning e.*;
$$;

-- An event that may release held runs of this lead: their watch has one of these types → due now.
create or replace function public.automation_wake(p_business text, p_contact uuid, p_types text[], p_now timestamptz)
returns integer language sql volatile security definer set search_path = ''
as $$
  with w as (
    update public.automation_runs r set due_at = p_now, updated_at = p_now
     where r.business_id = p_business and r.contact_id = p_contact and r.status = 'waiting' and r.due_at > p_now
       and r.watch && coalesce(p_types, '{}'::text[])
    returning 1)
  select count(*)::integer from w;
$$;

-- Stop on response: the lead replied after this run's first customer message → the waiting run stops (one exit row).
create or replace function public.automation_stop_on_reply(p_business text, p_contact uuid, p_reply_at timestamptz, p_now timestamptz)
returns integer language sql volatile security definer set search_path = ''
as $$
  with s as (
    update public.automation_runs r
       set status = 'stopped', exit_reason = 'replied', reason = 'Stopped: the lead replied', finished_at = p_now, updated_at = p_now,
           lease_until = null, watch = null, recheck = false
     where r.business_id = p_business and r.contact_id = p_contact and r.status = 'waiting' and r.stop_on_reply
       and r.first_sent_at is not null and r.first_sent_at < p_reply_at
    returning r.id, r.automation_id, r.record_kind, r.record_id, r.contact_id, r.cursor_step, r.trigger_id, r.automation_version, r.revision, r.steps_done, r."loop"),
  l as (
    insert into public.automation_log (business_id, run_id, step_id, row_kind, status, reason, automation_id, automation_name, record_kind, record_id,
                                       contact_id, trigger_id, version, revision, seq, "loop", detail, at)
    select p_business, s.id, coalesce(s.cursor_step, 'end'), 'exit', 'stopped', 'Stopped: the lead replied', s.automation_id, coalesce(a.name, 'automation'),
           s.record_kind, s.record_id, s.contact_id, s.trigger_id, s.automation_version, s.revision, s.steps_done, s."loop",
           pg_catalog.jsonb_build_object('exit_reason', 'replied', 'reply_at', p_reply_at), p_now
      from s left join public.automations a on a.id = s.automation_id
    returning 1)
  select count(*)::integer from l;
$$;

-- The matcher's daily totals, added atomically: [{automation_id, trigger_id, day, attempted, matched, enrolled, reasons {code: n}}].
create or replace function public.automation_trigger_daily_add(p_business text, p_rows jsonb)
returns integer language plpgsql volatile security definer set search_path = ''
as $$
declare r jsonb; n integer := 0;
begin
  for r in select e.value from pg_catalog.jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as e loop
    insert into public.automation_trigger_daily as d (business_id, automation_id, trigger_id, day, attempted, matched, enrolled, reasons)
    values (p_business, (r ->> 'automation_id')::uuid, r ->> 'trigger_id', (r ->> 'day')::date, coalesce((r ->> 'attempted')::integer, 0),
            coalesce((r ->> 'matched')::integer, 0), coalesce((r ->> 'enrolled')::integer, 0), coalesce(r -> 'reasons', '{}'::jsonb))
    on conflict (automation_id, trigger_id, day) do update set
      attempted = d.attempted + excluded.attempted, matched = d.matched + excluded.matched, enrolled = d.enrolled + excluded.enrolled,
      reasons = (select coalesce(pg_catalog.jsonb_object_agg(z.key, z.cnt), '{}'::jsonb)
                   from (select u.key, sum(u.value::bigint) as cnt
                           from (select * from pg_catalog.jsonb_each_text(d.reasons) union all select * from pg_catalog.jsonb_each_text(excluded.reasons)) as u
                          group by u.key) as z);
    n := n + 1;
  end loop;
  return n;
end $$;

-- A workflow's record writes (design §3.9), in ONE transaction with automation.cause set, so the capture triggers stamp
-- the cause on every event they write. p_cause = '<run id>:<chain depth>:<automation id>'. Ops, applied in order, each
-- on its own (a failing op is listed in "skipped" with the reason; the others still apply):
--   {op:'set', field, value}          a lead field from the whitelist (= the engine's UPDATE_FIELD_COLUMNS), typed cast
--   {op:'tags', add:[], remove:[]}    {op:'note', text}    {op:'optout', channel?}    {op:'read'}
--   {op:'stage', to, lost_reason?}    only when the lead is not already there; never the catalog's won key; writes the
--                                     'stage' event itself with the scanner's exact key (to_jsonb of the stored stage_changed_at)
--   {op:'task', board, title, due?, status?, notes?, assignees?, assigned_to?, category?, priority?}
--   {op:'comment', text}              {op:'custom', key, value}
-- → {ok, applied:[{i, op}], skipped:[{i, op, reason}]} | {ok:false, reason}. One activity_log line per applied op.
create or replace function public.automation_apply(p_business text, p_cause text, p_kind text, p_id text, p_ops jsonb)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  m text[]; run uuid; aut uuid; depth integer; nm text; actor text; op jsonb; o text; i integer := 0; line text;
  applied jsonb := '[]'::jsonb; skipped jsonb := '[]'::jsonb; cid uuid; cur record; col text; typ text; v text; addt text[]; remt text[];
  tgt text; sct text; tid text; ch text; stamp text;
  allowed constant text[] := array['full_name', 'postcode', 'division', 'source', 'next_follow_up', 'booked_for', 'quote_amount', 'lost_reason'];
begin
  m := pg_catalog.regexp_match(coalesce(p_cause, ''),
         '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9]{1,3}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');
  if m is null then raise exception 'automation_apply needs p_cause = <run>:<depth>:<automation>'; end if;
  run := m[1]::uuid; depth := m[2]::integer; aut := m[3]::uuid;
  if pg_catalog.jsonb_typeof(p_ops) is distinct from 'array' or pg_catalog.jsonb_array_length(p_ops) > 20 then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'ops must be a list of at most 20');
  end if;
  select a.name into nm from public.automations a where a.id = aut and a.business_id = p_business;
  if nm is null then return pg_catalog.jsonb_build_object('ok', false, 'reason', 'automation not found'); end if;
  actor := pg_catalog.left('Automation: ' || nm, 120);
  perform pg_catalog.set_config('automation.cause', p_cause, true);
  if p_kind = 'contact' then
    cid := p_id::uuid;
    select c.id, c.status into cur from public.contacts c where c.id = cid for update;
    if not found then return pg_catalog.jsonb_build_object('ok', false, 'reason', 'record deleted'); end if;
  end if;
  for op in select e.value from pg_catalog.jsonb_array_elements(p_ops) as e loop
    i := i + 1; o := coalesce(op ->> 'op', ''); line := null;
    begin
      if o in ('set', 'tags', 'note', 'optout', 'read', 'stage', 'task') and cid is null then
        skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'wrong_kind'); continue;
      end if;
      if o = 'set' then
        col := op ->> 'field';
        if col is null or not (col = any(allowed)) then
          skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'field not allowed'); continue;
        end if;
        if col = 'quote_amount' then col := 'estimated_value'; end if;
        select pg_catalog.format_type(a.atttypid, a.atttypmod) into typ from pg_catalog.pg_attribute a
         where a.attrelid = 'public.contacts'::regclass and a.attname = col and not a.attisdropped;
        v := nullif(pg_catalog.left(op ->> 'value', 500), '');
        execute pg_catalog.format('update public.contacts set %I = cast($1 as %s) where id = $2', col, typ) using v, cid;
        line := 'Changed ' || (op ->> 'field') || ' to "' || coalesce(pg_catalog.left(v, 80), '') || '"';
      elsif o = 'tags' then
        addt := array(select pg_catalog.left(pg_catalog.btrim(x), 60) from pg_catalog.jsonb_array_elements_text(coalesce(op -> 'add', '[]'::jsonb)) as x where pg_catalog.btrim(x) <> '');
        remt := array(select pg_catalog.btrim(x) from pg_catalog.jsonb_array_elements_text(coalesce(op -> 'remove', '[]'::jsonb)) as x);
        update public.contacts t set tags = array(
            select u.x from pg_catalog.unnest(coalesce(t.tags, '{}'::text[]) || addt) with ordinality as u(x, n)
             where u.x is not null and not (u.x = any(remt)) group by u.x order by min(u.n))
         where t.id = cid;
        line := 'Tags' || case when pg_catalog.cardinality(addt) > 0 then ' added: ' || pg_catalog.array_to_string(addt, ', ') else '' end
                       || case when pg_catalog.cardinality(remt) > 0 then ' removed: ' || pg_catalog.array_to_string(remt, ', ') else '' end;
      elsif o = 'note' then
        v := pg_catalog.left(pg_catalog.btrim(coalesce(op ->> 'text', '')), 1000);
        if v = '' then skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'empty note'); continue; end if;
        update public.contacts t set notes = case when coalesce(t.notes, '') = '' then v else t.notes || E'\n' || v end where t.id = cid;
        line := 'Note added: ' || pg_catalog.left(v, 200);
      elsif o = 'optout' then
        ch := coalesce(nullif(op ->> 'channel', ''), 'all');
        if not exists (select 1 from public.customer_opt_outs x where x.contact_id = cid and x.channel = ch) then
          insert into public.customer_opt_outs (business_id, contact_id, channel, reason) values (p_business, cid, ch, actor);
        end if;
        line := 'Automatic messages stopped (' || ch || ')';
      elsif o = 'read' then
        select pg_catalog.format_type(a.atttypid, a.atttypmod) into typ from pg_catalog.pg_attribute a
         where a.attrelid = 'public.contacts'::regclass and a.attname = 'last_read_at' and not a.attisdropped;
        stamp := case when typ in ('text', 'character varying') then 'to_char(now() at time zone ''UTC'', ''YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'')' else 'now()' end;
        execute pg_catalog.format('update public.contacts set last_read_at = %s where id = $1', stamp) using cid;
        line := 'Conversation marked as read';
      elsif o = 'stage' then
        tgt := nullif(pg_catalog.btrim(coalesce(op ->> 'to', '')), '');
        if tgt is null then skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'no stage'); continue; end if;
        if tgt = public.automation_catalog_key('stageWon', 'Won') then
          skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'A lead is won when its job is entered'); continue;
        end if;
        if cur.status::text is not distinct from tgt then
          skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'already in that stage'); continue;
        end if;
        select pg_catalog.format_type(a.atttypid, a.atttypmod) into typ from pg_catalog.pg_attribute a
         where a.attrelid = 'public.contacts'::regclass and a.attname = 'stage_changed_at' and not a.attisdropped;
        stamp := case when typ in ('text', 'character varying') then 'to_char(now() at time zone ''UTC'', ''YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'')' else 'now()' end;
        execute pg_catalog.format('update public.contacts set status = $1, stage_changed_at = %s, lost_reason = case when $1 = $3 and $4 is not null then $4 else lost_reason end'
                                  || ' where id = $2 returning to_jsonb(stage_changed_at) #>> ''{}''', stamp)
          into sct using tgt, cid, public.automation_catalog_key('stageLost', 'Lost'), nullif(pg_catalog.left(op ->> 'lost_reason', 200), '');
        if exists (select 1 from public.automation_wanted wt where wt.business_id = p_business and wt.event_type = 'stage') then
          insert into public.automation_events (business_id, type, event_key, record_kind, record_id, contact_id, at, available_at, ctx, source,
                                                cause_run_id, cause_automation_id, chain_depth)
          values (p_business, 'stage', pg_catalog.left(cid::text || ':' || tgt || ':' || sct, 200), 'contact', cid::text, cid, now(),
                  now() + pg_catalog.make_interval(secs => public.automation_settle_seconds('stage')), pg_catalog.jsonb_build_object('stage', tgt),
                  'engine', run, aut, least(depth + 1, 100))
          on conflict (business_id, type, event_key) do nothing;
        end if;
        cur.status := tgt;
        line := 'Moved to ' || tgt;
      elsif o = 'task' then
        if nullif(pg_catalog.btrim(coalesce(op ->> 'title', '')), '') is null or nullif(op ->> 'board', '') is null then
          skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'missing details'); continue;
        end if;
        insert into public.tasks (board, title, status, due, notes, client, contact_id, assignees, assigned_to, category, priority, created_by)
        select op ->> 'board', pg_catalog.left(op ->> 'title', 200), coalesce(nullif(op ->> 'status', ''), 'Not Started'), nullif(op ->> 'due', '')::date,
               nullif(pg_catalog.left(op ->> 'notes', 2000), ''), c.full_name, cid,
               array(select pg_catalog.jsonb_array_elements_text(coalesce(op -> 'assignees', '[]'::jsonb))), nullif(op ->> 'assigned_to', ''),
               nullif(op ->> 'category', ''), nullif(op ->> 'priority', ''), actor
          from public.contacts c where c.id = cid
        returning id::text into tid;
        line := 'Task added: ' || pg_catalog.left(op ->> 'title', 120);
      elsif o = 'comment' then
        v := pg_catalog.left(pg_catalog.btrim(coalesce(op ->> 'text', '')), 1000);
        if v = '' then skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'empty comment'); continue; end if;
        insert into public.activity_log (record_kind, record_id, actor, text, manual) values (p_kind, p_id, actor, v, false);
      elsif o = 'custom' then
        insert into public.automation_custom_values as cv (business_id, key, value, updated_at)
        values (p_business, op ->> 'key', coalesce(pg_catalog.left(op ->> 'value', 500), ''), now())
        on conflict (business_id, key) do update set value = excluded.value, updated_at = excluded.updated_at;
      else
        skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'unknown op'); continue;
      end if;
      if line is not null then
        insert into public.activity_log (record_kind, record_id, actor, text, manual) values (p_kind, p_id, actor, pg_catalog.left(line, 300), false);
      end if;
      applied := applied || pg_catalog.jsonb_build_object('i', i, 'op', o);
    exception when others then
      skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', pg_catalog.left(sqlerrm, 200));
    end;
  end loop;
  return pg_catalog.jsonb_build_object('ok', true, 'applied', applied, 'skipped', skipped);
end $$;

-- Housekeeping (design §2.9 retention, §3.15): at most p_budget (≤ 1,000) rows per table per call, oldest rule first;
-- the engine calls again while a count equals the budget. Never: the re-entry ledger, system_claims, System rows.
create or replace function public.automation_prune(p_business text, p_now timestamptz, p_budget integer)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare b integer := least(greatest(coalesce(p_budget, 1000), 1), 1000); res jsonb := '{}'::jsonb; n integer;
begin
  delete from public.automation_events e where e.id in (select x.id from public.automation_events x where x.business_id = p_business
     and ((x.status = 'done' and coalesce(x.processed_at, x.created_at) < p_now - interval '7 days') or (x.status = 'error' and x.created_at < p_now - interval '30 days'))
     limit b);
  get diagnostics n = row_count; res := res || pg_catalog.jsonb_build_object('events', n);
  delete from public.automation_trigger_log t where t.id in (select x.id from public.automation_trigger_log x
     where x.business_id = p_business and x.at < p_now - interval '30 days' limit b);
  get diagnostics n = row_count; res := res || pg_catalog.jsonb_build_object('trigger_log', n);
  delete from public.automation_trigger_daily t where (t.automation_id, t.trigger_id, t.day) in (select x.automation_id, x.trigger_id, x.day
     from public.automation_trigger_daily x where x.business_id = p_business and x.day < (p_now - interval '35 days')::date limit b);
  get diagnostics n = row_count; res := res || pg_catalog.jsonb_build_object('trigger_daily', n);
  delete from public.automation_runs r where r.id in (select x.id from public.automation_runs x where x.business_id = p_business
     and x.status not in ('waiting', 'running') and x.finished_at < p_now - interval '180 days' limit b);
  get diagnostics n = row_count; res := res || pg_catalog.jsonb_build_object('runs', n);
  delete from public.automation_log l where l.id in (select x.id from public.automation_log x where x.business_id = p_business
     and x.at < p_now - interval '180 days' limit b);
  get diagnostics n = row_count; res := res || pg_catalog.jsonb_build_object('log', n);
  -- versions: the newest 10, or newer than 30 days, and never more than 50 a workflow
  delete from public.automation_versions v where v.id in (select y.id from (
       select x.id, x.created_at, pg_catalog.row_number() over (partition by x.automation_id order by x.version_no desc) as rk
         from public.automation_versions x where x.business_id = p_business) as y
     where y.rk > 50 or (y.rk > 10 and y.created_at < p_now - interval '30 days') limit b);
  get diagnostics n = row_count; res := res || pg_catalog.jsonb_build_object('versions', n);
  delete from public.automation_hooks h where h.id in (select x.id from public.automation_hooks x where x.business_id = p_business
     and x.revoked_at < p_now - interval '30 days' limit b);
  get diagnostics n = row_count; res := res || pg_catalog.jsonb_build_object('hooks', n);
  -- Deleted workflows: gone for good after 30 days (their runs, ledger, notes go with them; the log stays), never a System row
  delete from public.automations a where a.id in (select x.id from public.automations x where x.business_id = p_business
     and x.deleted_at < p_now - interval '30 days' and x.system_key is null limit least(b, 50));
  get diagnostics n = row_count; res := res || pg_catalog.jsonb_build_object('automations', n);
  return res;
end $$;

-- 14. Read RPCs for the Automation page (security INVOKER: the caller's RLS applies, so a VA or a technician gets
--     nothing; stable; this business only; lists paged ≤ 100 with keyset paging on (time, id)).
-- The list: ONE object keyed by automation id {enrolled (since p_since), active, last_at, failed (distinct runs since)}.
create or replace function public.automation_list_stats(p_since timestamptz)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_object_agg(s.automation_id::text, pg_catalog.jsonb_build_object('enrolled', s.enrolled, 'active', s.active,
           'last_at', s.last_at, 'failed', coalesce(f.failed, 0))), '{}'::jsonb)
    from (select r.automation_id, count(*) filter (where r.created_at >= p_since) as enrolled,
                 count(*) filter (where r.status in ('waiting', 'running')) as active, max(r.created_at) as last_at
            from public.automation_runs r where r.business_id = public.current_business_id() group by r.automation_id) as s
    left join (select l.automation_id, count(distinct l.run_id) as failed from public.automation_log l
                where l.business_id = public.current_business_id() and l.status = 'failed' and l.at >= p_since group by l.automation_id) as f
      on f.automation_id = s.automation_id
$$;
create or replace function public.automation_trigger_stats(p_automation uuid, p_from date, p_to date)
returns table (trigger_id text, attempted bigint, matched bigint, enrolled bigint)
language sql stable security invoker set search_path = ''
as $$
  select d.trigger_id, sum(d.attempted)::bigint, sum(d.matched)::bigint, sum(d.enrolled)::bigint
    from public.automation_trigger_daily d
   where d.business_id = public.current_business_id() and d.automation_id = p_automation and d.day between p_from and p_to
   group by d.trigger_id order by d.trigger_id
$$;
create or replace function public.automation_trigger_evals(p_automation uuid, p_trigger text, p_from timestamptz, p_to timestamptz,
  p_matched boolean default null, p_contact uuid default null, p_before_at timestamptz default null, p_before_id uuid default null, p_limit integer default 10)
returns setof public.automation_trigger_log language sql stable security invoker set search_path = ''
as $$
  select l.* from public.automation_trigger_log l
   where l.business_id = public.current_business_id() and l.automation_id = p_automation and l.trigger_id = p_trigger and l.at >= p_from and l.at < p_to
     and (p_matched is null or l.matched = p_matched) and (p_contact is null or l.contact_id = p_contact)
     and (p_before_at is null or (l.at, l.id) < (p_before_at, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
   order by l.at desc, l.id desc
   limit least(greatest(coalesce(p_limit, 10), 1), 100)
$$;
create or replace function public.automation_unmatch_reasons(p_automation uuid, p_trigger text, p_from date, p_to date)
returns table (reason text, n bigint) language sql stable security invoker set search_path = ''
as $$
  select e.key, sum(e.value::bigint)::bigint
    from public.automation_trigger_daily d, pg_catalog.jsonb_each_text(d.reasons) as e
   where d.business_id = public.current_business_id() and d.automation_id = p_automation and d.trigger_id = p_trigger and d.day between p_from and p_to
   group by e.key order by 2 desc, 1 limit 20
$$;
-- Per step: status counts, and per branch / path / wait outcome (Stats view).
create or replace function public.automation_step_stats(p_automation uuid, p_since timestamptz)
returns table (step_id text, status text, branch text, n bigint) language sql stable security invoker set search_path = ''
as $$
  select l.step_id, l.status, coalesce(l.detail ->> 'branch_id', l.detail ->> 'path_id', l.detail ->> 'outcome'), count(*)::bigint
    from public.automation_log l
   where l.business_id = public.current_business_id() and l.automation_id = p_automation and l.at >= p_since and l.row_kind in ('step', 'action')
   group by 1, 2, 3 order by 1, 2, 3 limit 2000
$$;
create or replace function public.automation_enrollments(p_automation uuid, p_from timestamptz, p_to timestamptz, p_status text[] default null,
  p_source text default null, p_trigger text default null, p_record_ids text[] default null, p_contact uuid default null,
  p_before_created timestamptz default null, p_before_id uuid default null, p_limit integer default 50)
returns setof public.automation_runs language sql stable security invoker set search_path = ''
as $$
  select r.* from public.automation_runs r
   where r.business_id = public.current_business_id() and r.automation_id = p_automation and r.created_at >= p_from and r.created_at < p_to
     and (p_status is null or r.status = any(p_status)) and (p_source is null or r.source = p_source) and (p_trigger is null or r.trigger_id = p_trigger)
     and (p_record_ids is null or r.record_id = any(p_record_ids)) and (p_contact is null or r.contact_id = p_contact)
     and (p_before_created is null or (r.created_at, r.id) < (p_before_created, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
   order by r.created_at desc, r.id desc
   limit least(greatest(coalesce(p_limit, 50), 1), 100)
$$;
create or replace function public.automation_execution_log(p_automation uuid, p_from timestamptz, p_to timestamptz, p_steps text[] default null,
  p_status text[] default null, p_run uuid default null, p_contact uuid default null, p_before_at timestamptz default null,
  p_before_id uuid default null, p_limit integer default 50)
returns setof public.automation_log language sql stable security invoker set search_path = ''
as $$
  select l.* from public.automation_log l
   where l.business_id = public.current_business_id() and l.automation_id = p_automation and l.at >= p_from and l.at < p_to
     and (p_steps is null or l.step_id = any(p_steps)) and (p_status is null or l.status = any(p_status))
     and (p_run is null or l.run_id = p_run) and (p_contact is null or l.contact_id = p_contact)
     and (p_before_at is null or (l.at, l.id) < (p_before_at, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
   order by l.at desc, l.id desc
   limit least(greatest(coalesce(p_limit, 50), 1), 100)
$$;
-- The "Older steps" filter: every step id this workflow logged in the range, with its latest name.
create or replace function public.automation_log_steps(p_automation uuid, p_from timestamptz, p_to timestamptz)
returns table (step_id text, step_name text, last_at timestamptz) language sql stable security invoker set search_path = ''
as $$
  select distinct on (l.step_id) l.step_id, l.step_name, l.at
    from public.automation_log l
   where l.business_id = public.current_business_id() and l.automation_id = p_automation and l.at >= p_from and l.at < p_to
     and l.row_kind in ('step', 'action')
   order by l.step_id, l.at desc
   limit 500
$$;
-- Needs review: failed runs of the last 30 days not yet acknowledged, per workflow.
create or replace function public.automation_needs_review()
returns table (automation_id uuid, failed_runs bigint, last_failed_at timestamptz) language sql stable security invoker set search_path = ''
as $$
  select l.automation_id, count(distinct l.run_id)::bigint, max(l.at)
    from public.automation_log l left join public.automation_reviews v on v.automation_id = l.automation_id
   where l.business_id = public.current_business_id() and l.automation_id is not null and l.status = 'failed'
     and l.at >= now() - interval '30 days' and (v.acked_until is null or l.at > v.acked_until)
   group by l.automation_id
$$;
create or replace function public.automation_mark_reviewed(p_automation uuid)
returns timestamptz language sql volatile security invoker set search_path = ''
as $$
  insert into public.automation_reviews (automation_id, business_id, acked_until, acked_by, acked_at)
  select a.id, a.business_id, now(), auth.uid(), now() from public.automations a
   where a.id = p_automation and a.business_id = public.current_business_id()
  on conflict (automation_id) do update set acked_until = excluded.acked_until, acked_by = excluded.acked_by, acked_at = excluded.acked_at
  returning acked_until
$$;

-- 15. Access. RLS on every new table. Owners/managers manage folders, notes, custom values, reviews, System-row folders
--     and pauses; they READ versions, trigger log/totals, events, hooks and templates (the function writes those); the
--     wanted list is readable by anyone signed in (the app's "look now" check); the re-entry ledger, hook secrets and
--     shared claims have NO policy (service role only). Engine tables lose insert/update/delete for anon and authenticated.
alter table public.automation_folders enable row level security;
alter table public.automation_versions enable row level security;
alter table public.automation_notes enable row level security;
alter table public.automation_events enable row level security;
alter table public.automation_wanted enable row level security;
alter table public.automation_trigger_log enable row level security;
alter table public.automation_trigger_daily enable row level security;
alter table public.automation_enrollment_keys enable row level security;
alter table public.automation_pauses enable row level security;
alter table public.automation_hooks enable row level security;
alter table public.automation_hook_secrets enable row level security;
alter table public.automation_custom_values enable row level security;
alter table public.automation_templates enable row level security;
alter table public.automation_reviews enable row level security;
alter table public.automation_system_meta enable row level security;
alter table public.system_claims enable row level security;

drop policy if exists "automation_folders: owners and managers" on public.automation_folders;
create policy "automation_folders: owners and managers" on public.automation_folders for all
  using (public.is_owner_or_manager() and business_id = public.current_business_id())
  with check (public.is_owner_or_manager() and business_id = public.current_business_id());
drop policy if exists "automation_custom_values: owners and managers" on public.automation_custom_values;
create policy "automation_custom_values: owners and managers" on public.automation_custom_values for all
  using (public.is_owner_or_manager() and business_id = public.current_business_id())
  with check (public.is_owner_or_manager() and business_id = public.current_business_id());
drop policy if exists "automation_reviews: owners and managers" on public.automation_reviews;
create policy "automation_reviews: owners and managers" on public.automation_reviews for all
  using (public.is_owner_or_manager() and business_id = public.current_business_id())
  with check (public.is_owner_or_manager() and business_id = public.current_business_id());
drop policy if exists "automation_system_meta: owners and managers" on public.automation_system_meta;
create policy "automation_system_meta: owners and managers" on public.automation_system_meta for all
  using (public.is_owner_or_manager() and business_id = public.current_business_id())
  with check (public.is_owner_or_manager() and business_id = public.current_business_id());
drop policy if exists "automation_pauses: owners and managers" on public.automation_pauses;
create policy "automation_pauses: owners and managers" on public.automation_pauses for all
  using (public.is_owner_or_manager() and business_id = public.current_business_id())
  with check (public.is_owner_or_manager() and business_id = public.current_business_id());

drop policy if exists "automation_notes: owners and managers read" on public.automation_notes;
create policy "automation_notes: owners and managers read" on public.automation_notes for select
  using (public.is_owner_or_manager() and business_id = public.current_business_id());
drop policy if exists "automation_notes: owners and managers add" on public.automation_notes;
create policy "automation_notes: owners and managers add" on public.automation_notes for insert
  with check (public.is_owner_or_manager() and business_id = public.current_business_id() and created_by = auth.uid());
drop policy if exists "automation_notes: author or owner change" on public.automation_notes;
create policy "automation_notes: author or owner change" on public.automation_notes for update
  using (public.is_owner_or_manager() and business_id = public.current_business_id() and (created_by = auth.uid() or public.my_role() = 'owner'))
  with check (public.is_owner_or_manager() and business_id = public.current_business_id());
drop policy if exists "automation_notes: author or owner delete" on public.automation_notes;
create policy "automation_notes: author or owner delete" on public.automation_notes for delete
  using (public.is_owner_or_manager() and business_id = public.current_business_id() and (created_by = auth.uid() or public.my_role() = 'owner'));

drop policy if exists "automation_versions: owners and managers read" on public.automation_versions;
create policy "automation_versions: owners and managers read" on public.automation_versions for select
  using (public.is_owner_or_manager() and business_id = public.current_business_id());
drop policy if exists "automation_trigger_log: owners and managers read" on public.automation_trigger_log;
create policy "automation_trigger_log: owners and managers read" on public.automation_trigger_log for select
  using (public.is_owner_or_manager() and business_id = public.current_business_id());
drop policy if exists "automation_trigger_daily: owners and managers read" on public.automation_trigger_daily;
create policy "automation_trigger_daily: owners and managers read" on public.automation_trigger_daily for select
  using (public.is_owner_or_manager() and business_id = public.current_business_id());
drop policy if exists "automation_events: owners and managers read" on public.automation_events;
create policy "automation_events: owners and managers read" on public.automation_events for select
  using (public.is_owner_or_manager() and business_id = public.current_business_id());
drop policy if exists "automation_hooks: owners and managers read" on public.automation_hooks;
create policy "automation_hooks: owners and managers read" on public.automation_hooks for select
  using (public.is_owner_or_manager() and business_id = public.current_business_id());
drop policy if exists "automation_templates: owners and managers read" on public.automation_templates;
create policy "automation_templates: owners and managers read" on public.automation_templates for select
  using (public.is_owner_or_manager() and business_id = public.current_business_id());
drop policy if exists "automation_wanted: signed-in read" on public.automation_wanted;
create policy "automation_wanted: signed-in read" on public.automation_wanted for select
  using (auth.uid() is not null and business_id = public.current_business_id());

revoke all on public.automation_folders, public.automation_versions, public.automation_notes, public.automation_events, public.automation_wanted,
  public.automation_trigger_log, public.automation_trigger_daily, public.automation_enrollment_keys, public.automation_pauses, public.automation_hooks,
  public.automation_hook_secrets, public.automation_custom_values, public.automation_templates, public.automation_reviews,
  public.automation_system_meta, public.system_claims from anon;
revoke all on public.automation_enrollment_keys, public.automation_hook_secrets, public.system_claims from authenticated;
revoke insert, update, delete, truncate, references, trigger on public.automation_versions, public.automation_events, public.automation_wanted,
  public.automation_trigger_log, public.automation_trigger_daily, public.automation_hooks, public.automation_templates from authenticated;
revoke truncate, references, trigger on public.automation_folders, public.automation_notes, public.automation_pauses,
  public.automation_custom_values, public.automation_reviews, public.automation_system_meta from authenticated;
grant select on public.automation_versions, public.automation_events, public.automation_wanted, public.automation_trigger_log,
  public.automation_trigger_daily, public.automation_hooks, public.automation_templates to authenticated;
grant select, insert, update, delete on public.automation_folders, public.automation_notes, public.automation_pauses,
  public.automation_custom_values, public.automation_reviews, public.automation_system_meta to authenticated;
-- the engine-written columns of the phase-4 tables stay read-only for the app (phase 4 already revoked insert/update/delete
-- on automation_runs and automation_log; checked after)

-- functions: engine RPCs → service role only; read RPCs → signed-in (their RLS decides what comes back)
revoke all on function public.automation_claim_customer_v2(text, uuid, text, uuid, text, text, text, text, uuid, text[], timestamptz, integer, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.automation_claim_customer(text, uuid, text, uuid, text, text, text, text, uuid, text[], timestamptz, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.automation_enroll(text, uuid, integer, integer, text, text, text, timestamptz, text, text, uuid, text, text, text, text, jsonb, text, integer, uuid, uuid, boolean, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.automation_claim_events(text, timestamptz, integer, integer, uuid, text, text) from public, anon, authenticated;
revoke all on function public.automation_wake(text, uuid, text[], timestamptz) from public, anon, authenticated;
revoke all on function public.automation_stop_on_reply(text, uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.automation_trigger_daily_add(text, jsonb) from public, anon, authenticated;
revoke all on function public.automation_apply(text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.automation_prune(text, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.automation_capture_put(text, text, text, text, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.automation_catalog_key(text, text) from public, anon, authenticated;
revoke all on function public.automation_capture_contacts() from public, anon, authenticated;
revoke all on function public.automation_capture_tasks() from public, anon, authenticated;
revoke all on function public.automation_capture_messages() from public, anon, authenticated;
revoke all on function public.automation_capture_optouts() from public, anon, authenticated;
revoke all on function public.automation_capture_jobs() from public, anon, authenticated;
revoke all on function public.automation_capture_suppliers() from public, anon, authenticated;
revoke all on function public.automation_pauses_after() from public, anon, authenticated;
grant execute on function public.automation_claim_customer_v2(text, uuid, text, uuid, text, text, text, text, uuid, text[], timestamptz, integer, timestamptz, integer) to service_role;
grant execute on function public.automation_claim_customer(text, uuid, text, uuid, text, text, text, text, uuid, text[], timestamptz, integer, timestamptz) to service_role;
grant execute on function public.automation_enroll(text, uuid, integer, integer, text, text, text, timestamptz, text, text, uuid, text, text, text, text, jsonb, text, integer, uuid, uuid, boolean, timestamptz, timestamptz) to service_role;
grant execute on function public.automation_claim_events(text, timestamptz, integer, integer, uuid, text, text) to service_role;
grant execute on function public.automation_wake(text, uuid, text[], timestamptz) to service_role;
grant execute on function public.automation_stop_on_reply(text, uuid, timestamptz, timestamptz) to service_role;
grant execute on function public.automation_trigger_daily_add(text, jsonb) to service_role;
grant execute on function public.automation_apply(text, text, text, text, jsonb) to service_role;
grant execute on function public.automation_prune(text, timestamptz, integer) to service_role;
grant execute on function public.automation_capture_put(text, text, text, text, text, uuid, jsonb) to service_role;
grant execute on function public.automation_catalog_key(text, text) to service_role;
revoke all on function public.automation_list_stats(timestamptz) from public, anon;
revoke all on function public.automation_trigger_stats(uuid, date, date) from public, anon;
revoke all on function public.automation_trigger_evals(uuid, text, timestamptz, timestamptz, boolean, uuid, timestamptz, uuid, integer) from public, anon;
revoke all on function public.automation_unmatch_reasons(uuid, text, date, date) from public, anon;
revoke all on function public.automation_step_stats(uuid, timestamptz) from public, anon;
revoke all on function public.automation_enrollments(uuid, timestamptz, timestamptz, text[], text, text, text[], uuid, timestamptz, uuid, integer) from public, anon;
revoke all on function public.automation_execution_log(uuid, timestamptz, timestamptz, text[], text[], uuid, uuid, timestamptz, uuid, integer) from public, anon;
revoke all on function public.automation_log_steps(uuid, timestamptz, timestamptz) from public, anon;
revoke all on function public.automation_needs_review() from public, anon;
revoke all on function public.automation_mark_reviewed(uuid) from public, anon;
grant execute on function public.automation_list_stats(timestamptz) to authenticated, service_role;
grant execute on function public.automation_trigger_stats(uuid, date, date) to authenticated, service_role;
grant execute on function public.automation_trigger_evals(uuid, text, timestamptz, timestamptz, boolean, uuid, timestamptz, uuid, integer) to authenticated, service_role;
grant execute on function public.automation_unmatch_reasons(uuid, text, date, date) to authenticated, service_role;
grant execute on function public.automation_step_stats(uuid, timestamptz) to authenticated, service_role;
grant execute on function public.automation_enrollments(uuid, timestamptz, timestamptz, text[], text, text, text[], uuid, timestamptz, uuid, integer) to authenticated, service_role;
grant execute on function public.automation_execution_log(uuid, timestamptz, timestamptz, text[], text[], uuid, uuid, timestamptz, uuid, integer) to authenticated, service_role;
grant execute on function public.automation_log_steps(uuid, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.automation_needs_review() to authenticated, service_role;
grant execute on function public.automation_mark_reviewed(uuid) to authenticated, service_role;

-- 16. The narrow time scanners' indexes on the busy tables (contacts(stage_changed_at) exists since phase 4).
create index if not exists contacts_next_follow_up_idx on public.contacts (next_follow_up);
create index if not exists contacts_booked_for_idx on public.contacts (booked_for);
create index if not exists jobs_date_idx on public.jobs (date);
create index if not exists tasks_due_idx on public.tasks (due);

commit;
select 'stage2 Part 1 ok';

-- Check after (read-only; run on staging the full check script .claude/sql/stage2-part1-staging-checks.sql as well):
--   select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.automation_log'::regclass order by 1;
--     -- automation_log_once is GONE; automation_log_channel_v2 / _status_v2 / _row_kind / _action_channel / _v2_sizes present
--   select indexdef from pg_indexes where indexname = 'automation_log_action_once';
--     -- CREATE UNIQUE INDEX ... (run_id, step_id, "loop") WHERE (row_kind = 'action'::text)
--   select prosrc from pg_proc where proname = 'automation_claim_customer';      -- calls automation_claim_customer_v2(..., 0)
--   select count(*) from public.automation_log where row_kind <> 'action' or "loop" <> 0;   -- 0 (nothing written yet)
--   select count(*) from public.automation_log;  select count(*) from public.automation_runs;   -- = the counts noted before
--   select count(*) from public.automation_events;  select count(*) from public.automation_wanted;   -- 0 and 0: the capture is silent
--   select capture_errors, capture_error_last from public.automation_state;                    -- 0, null
--   select tgrelid::regclass, tgname from pg_trigger where tgname = 'automation_capture' order by 1;
--     -- contacts, customer_opt_outs, jobs, lead_messages, suppliers, tasks
--   select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'
--      and (c.relname like 'automation%' or c.relname = 'system_claims') and not c.relrowsecurity;   -- 0 rows (RLS everywhere)
--   select has_table_privilege('authenticated', 'public.automation_events', 'INSERT'),
--          has_table_privilege('authenticated', 'public.automation_hook_secrets', 'SELECT'),
--          has_table_privilege('authenticated', 'public.automation_enrollment_keys', 'SELECT'),
--          has_column_privilege('authenticated', 'public.automation_log', 'row_kind', 'UPDATE'),
--          has_function_privilege('authenticated', 'public.automation_enroll(text, uuid, integer, integer, text, text, text, timestamptz, text, text, uuid, text, text, text, text, jsonb, text, integer, uuid, uuid, boolean, timestamptz, timestamptz)', 'EXECUTE'),
--          has_function_privilege('authenticated', 'public.automation_list_stats(timestamptz)', 'EXECUTE');
--     -- false, false, false, false, false, true
--   select phase4_compat from public.automation_state;   -- true
--   select tgname from pg_trigger where tgrelid = 'public.automations'::regclass and not tgisinternal order by tgname;
--     -- automations_a_v2_pin, automations_customer_off_guard, automations_guard (the pin first)
--   select count(*) from pg_proc where proname like 'automation_capture_%' and prosrc ~* 'for update skip locked';   -- 6

-- ── ROLLBACK (Part 1; run by hand only, AFTER rolling back Part 2 if it ran). Restores the phase-4 schema exactly as
-- settings-round2-phase4.sql (H-engine + I-builder) left it. Rows only the v2 engine writes go first (enroll / step /
-- exit log rows, Go-to passes, new channels, the new run states and record kinds): phase 4 has no place for them.
-- begin;
-- set local lock_timeout = '5s';
-- drop trigger if exists automation_capture on public.contacts;
-- drop trigger if exists automation_capture on public.tasks;
-- drop trigger if exists automation_capture on public.lead_messages;
-- drop trigger if exists automation_capture on public.customer_opt_outs;
-- drop trigger if exists automation_capture on public.jobs;
-- drop trigger if exists automation_capture on public.suppliers;
-- drop function if exists public.automation_capture_contacts();
-- drop function if exists public.automation_capture_tasks();
-- drop function if exists public.automation_capture_messages();
-- drop function if exists public.automation_capture_optouts();
-- drop function if exists public.automation_capture_jobs();
-- drop function if exists public.automation_capture_suppliers();
-- drop function if exists public.automation_capture_put(text, text, text, text, text, uuid, jsonb);
-- drop function if exists public.automation_settle_seconds(text);
-- drop function if exists public.automation_list_stats(timestamptz);
-- drop function if exists public.automation_trigger_stats(uuid, date, date);
-- drop function if exists public.automation_trigger_evals(uuid, text, timestamptz, timestamptz, boolean, uuid, timestamptz, uuid, integer);
-- drop function if exists public.automation_unmatch_reasons(uuid, text, date, date);
-- drop function if exists public.automation_step_stats(uuid, timestamptz);
-- drop function if exists public.automation_enrollments(uuid, timestamptz, timestamptz, text[], text, text, text[], uuid, timestamptz, uuid, integer);
-- drop function if exists public.automation_execution_log(uuid, timestamptz, timestamptz, text[], text[], uuid, uuid, timestamptz, uuid, integer);
-- drop function if exists public.automation_log_steps(uuid, timestamptz, timestamptz);
-- drop function if exists public.automation_needs_review();
-- drop function if exists public.automation_mark_reviewed(uuid);
-- drop function if exists public.automation_enroll(text, uuid, integer, integer, text, text, text, timestamptz, text, text, uuid, text, text, text, text, jsonb, text, integer, uuid, uuid, boolean, timestamptz, timestamptz);
-- drop function if exists public.automation_claim_events(text, timestamptz, integer, integer, uuid, text, text);
-- drop function if exists public.automation_wake(text, uuid, text[], timestamptz);
-- drop function if exists public.automation_stop_on_reply(text, uuid, timestamptz, timestamptz);
-- drop function if exists public.automation_trigger_daily_add(text, jsonb);
-- drop function if exists public.automation_apply(text, text, text, text, jsonb);
-- drop function if exists public.automation_prune(text, timestamptz, integer);
-- -- the execution log back to the phase-4 action log
-- delete from public.automation_log where row_kind <> 'action' or "loop" <> 0 or channel not in ('push', 'task', 'email', 'text');
-- create or replace function public.automation_claim_customer(p_business text, p_run uuid, p_step text, p_automation uuid, p_name text,
--   p_channel text, p_record_kind text, p_record_id text, p_contact uuid, p_recipients text[], p_since timestamptz, p_cap integer, p_now timestamptz)
-- returns text language plpgsql volatile security definer set search_path = ''
-- as $$
-- declare k text; n integer; got uuid;
-- begin
--   for k in select distinct x from pg_catalog.unnest(pg_catalog.array_append(coalesce(p_recipients, '{}'::text[]), coalesce(p_contact::text, ''))) as u(x)
--             where x <> '' order by 1 loop
--     perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('automation-customer:' || p_business || ':' || k, 0));
--   end loop;
--   if exists (select 1 from public.automation_log l where l.run_id = p_run and l.step_id = p_step) then return 'done'; end if;
--   select count(*) into n from public.automation_log l
--    where l.business_id = p_business and l.audience = 'customer' and l.status in ('sending', 'sent', 'queued') and l.at >= p_since
--      and ((p_contact is not null and l.contact_id = p_contact) or l.recipient = any(coalesce(p_recipients, '{}'::text[])));
--   if n >= greatest(coalesce(p_cap, 1), 1) then return 'capped'; end if;
--   insert into public.automation_log (business_id, run_id, step_id, status, channel, audience, automation_id, automation_name,
--                                      record_kind, record_id, contact_id, recipient, at)
--   values (p_business, p_run, p_step, 'sending', p_channel, 'customer', p_automation, p_name, p_record_kind, p_record_id, p_contact,
--           (coalesce(p_recipients, '{}'::text[]))[1], p_now)
--   on conflict on constraint automation_log_once do nothing
--   returning id into got;
--   return case when got is null then 'done' else 'claimed:' || got::text end;
-- end $$;
-- ...the function above references automation_log_once, which must exist before it is CALLED (not before it is created):
-- alter table public.automation_log add constraint automation_log_once unique (run_id, step_id);
-- drop index if exists public.automation_log_action_once;
-- drop function if exists public.automation_claim_customer_v2(text, uuid, text, uuid, text, text, text, text, uuid, text[], timestamptz, integer, timestamptz, integer);
-- revoke all on function public.automation_claim_customer(text, uuid, text, uuid, text, text, text, text, uuid, text[], timestamptz, integer, timestamptz) from public, anon, authenticated;
-- grant execute on function public.automation_claim_customer(text, uuid, text, uuid, text, text, text, text, uuid, text[], timestamptz, integer, timestamptz) to service_role;
-- alter table public.automation_log drop constraint if exists automation_log_channel_v2;
-- alter table public.automation_log drop constraint if exists automation_log_status_v2;
-- alter table public.automation_log drop constraint if exists automation_log_row_kind;
-- alter table public.automation_log drop constraint if exists automation_log_action_channel;
-- alter table public.automation_log drop constraint if exists automation_log_v2_sizes;
-- alter table public.automation_log add constraint automation_log_channel_check check (channel in ('push', 'task', 'email', 'text'));
-- alter table public.automation_log add constraint automation_log_status_check check (status in ('sending', 'sent', 'queued', 'waiting_phone', 'skipped', 'failed'));
-- alter table public.automation_log alter column channel set not null;
-- alter table public.automation_log alter column audience set not null;
-- drop index if exists public.automation_log_run_seq_idx;
-- drop index if exists public.automation_log_step_idx;
-- drop index if exists public.automation_log_failed_idx;
-- alter table public.automation_log drop column if exists row_kind, drop column if exists step_type, drop column if exists step_name,
--   drop column if exists "loop", drop column if exists seq, drop column if exists version, drop column if exists revision,
--   drop column if exists trigger_id, drop column if exists detail, drop column if exists next_at;
-- -- runs back to the phase-4 queue
-- update public.automation_runs set status = 'cancelled' where status in ('removed', 'stopped');
-- delete from public.automation_runs where record_kind not in ('contact', 'job', 'call', 'chat');
-- drop trigger if exists automation_runs_lock_clear on public.automation_runs;
-- drop function if exists public.automation_runs_lock_clear();
-- drop index if exists public.automation_runs_active_lock;
-- drop index if exists public.automation_runs_contact_waiting_idx;
-- drop index if exists public.automation_runs_list_idx;
-- drop index if exists public.automation_runs_status_idx;
-- drop index if exists public.automation_runs_recheck_idx;
-- alter table public.automation_runs drop constraint if exists automation_runs_record_kind_v2;
-- alter table public.automation_runs drop constraint if exists automation_runs_status_v2;
-- alter table public.automation_runs drop constraint if exists automation_runs_source_kind;
-- alter table public.automation_runs drop constraint if exists automation_runs_v2_lengths;
-- alter table public.automation_runs add constraint automation_runs_record_kind_check check (record_kind in ('contact', 'job', 'call', 'chat'));
-- alter table public.automation_runs add constraint automation_runs_status_check check (status in ('waiting', 'running', 'done', 'skipped', 'cancelled', 'failed'));
-- alter table public.automation_runs drop column if exists trigger_id, drop column if exists cursor_step, drop column if exists "loop",
--   drop column if exists visits, drop column if exists steps_done, drop column if exists steps_today, drop column if exists steps_day,
--   drop column if exists enrollment_key, drop column if exists active_lock, drop column if exists chain_depth, drop column if exists cause_run_id,
--   drop column if exists parent_run_id, drop column if exists source, drop column if exists watch, drop column if exists recheck,
--   drop column if exists stop_on_reply, drop column if exists first_sent_at, drop column if exists exit_reason,
--   drop column if exists remove_requested, drop column if exists revision;
-- -- state and settings
-- alter table public.automation_state drop column if exists capture_errors, drop column if exists capture_error_last,
--   drop column if exists capture_error_at, drop column if exists wanted_hash, drop column if exists scan_marks,
--   drop column if exists housekeeping, drop column if exists v2_migrated_at, drop column if exists error_notice_at, drop column if exists phase4_compat;
-- alter table public.automation_settings drop constraint if exists automation_settings_builder_kind;
-- alter table public.automation_settings drop constraint if exists automation_settings_error_notify;
-- alter table public.automation_settings drop constraint if exists automation_settings_smart_lists;
-- alter table public.automation_settings drop column if exists default_builder, drop column if exists error_notify, drop column if exists smart_lists;
-- drop function if exists public.automation_error_notify_ok(jsonb);
-- drop function if exists public.automation_smart_lists_ok(jsonb);
-- -- the new tables (children first), then the automations columns
-- drop table if exists public.automation_pauses;
-- drop function if exists public.automation_pauses_guard();
-- drop function if exists public.automation_pauses_after();
-- drop function if exists public.automation_wall_ts(text, integer);
-- drop table if exists public.automation_hook_secrets;
-- drop table if exists public.automation_hooks;
-- drop table if exists public.automation_custom_values;
-- drop table if exists public.automation_templates;
-- drop table if exists public.automation_reviews;
-- drop table if exists public.automation_system_meta;
-- drop table if exists public.system_claims;
-- drop table if exists public.automation_trigger_daily;
-- drop table if exists public.automation_trigger_log;
-- drop table if exists public.automation_enrollment_keys;
-- drop table if exists public.automation_wanted;
-- drop table if exists public.automation_events;
-- drop table if exists public.automation_notes;
-- drop function if exists public.automation_notes_guard();
-- drop table if exists public.automation_versions;
-- drop trigger if exists automations_a_v2_pin on public.automations;
-- drop function if exists public.automations_v2_pin();
-- drop index if exists public.automations_system_key_once;
-- drop index if exists public.automations_folder_idx;
-- drop index if exists public.automations_deleted_idx;
-- alter table public.automations drop constraint if exists automations_folder_fk;
-- alter table public.automations drop constraint if exists automations_definition_doc;
-- alter table public.automations drop constraint if exists automations_settings_obj;
-- alter table public.automations drop constraint if exists automations_layout_obj;
-- alter table public.automations drop constraint if exists automations_builder_kind;
-- alter table public.automations drop constraint if exists automations_origin_kind;
-- alter table public.automations drop constraint if exists automations_list_summary_obj;
-- alter table public.automations drop constraint if exists automations_system_key_len;
-- alter table public.automations drop column if exists definition, drop column if exists settings, drop column if exists layout,
--   drop column if exists builder, drop column if exists folder_id, drop column if exists deleted_at, drop column if exists deleted_by,
--   drop column if exists deleted_by_name, drop column if exists origin, drop column if exists revision, drop column if exists published_at,
--   drop column if exists published_by, drop column if exists system_key, drop column if exists system_handover_at,
--   drop column if exists enrolled_total, drop column if exists updated_by_name, drop column if exists list_summary;
-- drop table if exists public.automation_folders;
-- drop function if exists public.automation_folders_guard();
-- drop function if exists public.automation_catalog_key(text, text);
-- drop function if exists public.current_business_id();
-- drop index if exists public.contacts_next_follow_up_idx;
-- drop index if exists public.contacts_booked_for_idx;
-- drop index if exists public.jobs_date_idx;
-- drop index if exists public.tasks_due_idx;
-- commit;
-- Then redeploy the committed automations-phase4-compat build (or the phase-4 function) — design §3.16.
-- The live order, backups, the 2-hour watch and both rollbacks (function only / with this block): .claude/sql/stage2-part1-RUNBOOK.md.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- END PART 1
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — switch the guards to the doc (automation_guarded_channels, automations_guard v2, automations_after,
-- automation_save / _publish / _migrate_row; PART 2 · G2.4 below), switch the event store on (STEP E, group G2.1) and the lead card's
-- atomic tag / note edits + the stage-2 record writes + the inbound link counter (G2.3). Each step is
-- its own section with its own begin/commit, checks before/after and ROLLBACK; the live order is in the phase-2 RUNBOOK
-- (.claude/sql/stage2-part1-RUNBOOK.md, section 9).
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- PART 2 · STEP E (group G2.1) — the event store starts the runs: automation_state.phase4_compat = false.
-- Needs: Part 1 applied, and the phase-2 function (the one with the EVENTS section) deployed and ticking in compat mode
-- (function log "automations engine: v2 executor in compat mode …"). Nothing else in Part 2 depends on it, and it
-- depends on nothing else in Part 2. No new table, column, function or privilege: Part 1 made them all.
-- From the next tick the function: lists the ON workflows (a cheap list; a full row only when it changed), writes
-- public.automation_wanted (= the trigger types of the ON workflows + the events their held runs listen for — from then
-- on the capture triggers write those types into automation_events), scans the scan and time sources from their
-- watermarks (automation_state.scan_marks), claims the due events (automation_claim_events), wakes and stops held runs
-- (automation_wake / automation_stop_on_reply), checks every trigger and enrols through automation_enroll, and writes
-- automation_trigger_log + automation_trigger_daily. The phase-4 scanners and their five event-key formats are reused byte
-- for byte, so an event the compat producer (phase 4's enqueue) already started gives 'duplicate_event' — never a second
-- run. The offline differential replays every scenario with this switch on, switched on mid-way and switched back:
-- identical to phase 4 (supabase/functions/automations/differential, the "ev" engine).
--
-- Check before (read-only):
--   select business_id, phase4_compat, wanted_hash, scan_marks, capture_errors from public.automation_state;
--     -- one row 'default': phase4_compat = true, wanted_hash null, scan_marks {}
--   select count(*) from public.automation_wanted;                               -- 0: the capture triggers are silent
--   select status, count(*) from public.automation_events group by 1;            -- nothing (or only rows of the staging checks: none left)
--   select to_regprocedure('public.automation_claim_events(text, timestamptz, integer, integer, uuid, text, text)') is not null,
--          to_regprocedure('public.automation_wake(text, uuid, text[], timestamptz)') is not null,
--          to_regprocedure('public.automation_stop_on_reply(text, uuid, timestamptz, timestamptz)') is not null,
--          to_regprocedure('public.automation_trigger_daily_add(text, jsonb)') is not null;      -- all true (Part 1)
--   select count(*) filter (where status in ('waiting', 'running')) as active, count(*) as runs from public.automation_runs;   -- note both
--   The function log shows the compat line for the last ticks (Dashboard → Edge Functions → automations → Logs).
-- ────────────────────────────────────────────────────────────────────────────────────────────────────────────
begin;
set local lock_timeout = '5s';
do $$
begin
  if to_regprocedure('public.automation_claim_events(text, timestamptz, integer, integer, uuid, text, text)') is null
     or to_regprocedure('public.automation_enroll(text, uuid, integer, integer, text, text, text, timestamptz, text, text, uuid, text, text, text, text, jsonb, text, integer, uuid, uuid, boolean, timestamptz, timestamptz)') is null
     or to_regprocedure('public.automation_wake(text, uuid, text[], timestamptz)') is null
     or to_regprocedure('public.automation_stop_on_reply(text, uuid, timestamptz, timestamptz)') is null
     or to_regprocedure('public.automation_trigger_daily_add(text, jsonb)') is null
     or to_regclass('public.automation_wanted') is null or to_regclass('public.automation_trigger_log') is null then
    raise exception 'Part 2 step E needs Part 1 (the event-store tables and RPCs): run Part 1 first';
  end if;
  if not exists (select 1 from public.automation_state where business_id = public.current_business_id()) then
    raise exception 'Part 2 step E: no automation_state row for this business (the timer has never run here)';
  end if;
end $$;
update public.automation_state set phase4_compat = false where business_id = public.current_business_id();
commit;
-- Check after (read-only):
--   right away:  select phase4_compat from public.automation_state;                  -- false
--   after the next minute's tick:
--     function log: "automations engine: v2 executor with the event store (producers, captured events, matcher)" (once)
--     select event_type from public.automation_wanted order by 1;                    -- the trigger types of the ON workflows (+ watched types)
--     select wanted_hash, scan_marks from public.automation_state;                    -- = that list joined by ','; one mark per producer that ran, ≈ the tick
--                                                                                     --   (+ "_next": the producer the next tick starts with, when 2+ are wanted)
--     select type, source, status, count(*) from public.automation_events group by 1, 2, 3 order by 1, 2, 3;   -- scan rows of the last hours, 'done'
--     select count(*) from public.automation_events where status = 'error';         -- 0
--     select a.name, l.trigger_id, l.matched, l.reason, count(*) from public.automation_trigger_log l join public.automations a on a.id = l.automation_id
--      where l.at > now() - interval '15 minutes' group by 1, 2, 3, 4 order by 1, 2, 3, 4;
--       -- the first tick re-checks the last lookback_hours: the events phase 4 already started show 'duplicate_event' (no run)
--     select count(*) from public.automation_runs where created_at > now() - interval '15 minutes' and source = 'trigger'
--        and not exists (select 1 from public.automation_log l where l.run_id = automation_runs.id and l.row_kind = 'enroll');   -- 0: every new run came through automation_enroll
--   then the 2-hour watch of the RUNBOOK (W3–W8: per workflow the same actions, reasons and cap use as the compat hours).
--
-- ROLLBACK (step E only; run by hand). The compat producer (phase 4's scanners + enqueue) starts the runs again from the
-- next tick, with the same event keys: nothing fires twice. The capture list is emptied at once (the compat tick would
-- also do it), and the events nobody will claim are closed, so switching the event store on again later never acts on
-- an old capture. The rows themselves are pruned by housekeeping (done: 7 days).
-- begin;
-- update public.automation_state set phase4_compat = true, wanted_hash = null where business_id = public.current_business_id();
-- delete from public.automation_wanted where business_id = public.current_business_id();
-- update public.automation_events set status = 'done', processed_at = now(), lease_until = null, error = 'event store switched off (step E rolled back)'
--  where business_id = public.current_business_id() and status in ('new', 'processing');
-- commit;
-- Check after the rollback: select phase4_compat, wanted_hash from public.automation_state;  -- true, null
--   select count(*) from public.automation_wanted;  -- 0;  the function log says "v2 executor in compat mode …" at the next tick.
-- ────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- END PART 2 · STEP E

-- ────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- PART 2 · G2.2 (logic steps + per-workflow settings) — NOTHING TO RUN. The engine's If / else, Split, Goal, Go to, Add to /
-- Remove from workflow, the reply / user-reply / conditions waits, Stop on response, the time window, pauses, the
-- re-entry ledger and "Mark as read" use only what Part 1 made: automation_enroll (p_trigger null, p_source 'workflow',
-- p_parent / p_cause, p_due), automation_enrollment_keys.splits (the Split path, written by the service role),
-- automation_runs.remove_requested / exit_reason / stop_on_reply / first_sent_at / watch ('pause' for a pause hold),
-- automation_pauses (+ its AFTER trigger's wake), automation_apply op 'read', lead_messages (direction, channel, auto,
-- author_id, at) and automation_events (the event goals). Proof on staging: .claude/sql/stage2-part1-staging-checks.sql
-- check 16 (PASS 16). No ROLLBACK: nothing changes in the database; rolling G2.2 back = redeploying the previous function.
-- ────────────────────────────────────────────────────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- PART 2 · G2.3 (record actions, inbound webhook) — atomic tag and note edits for the lead card, the stage-2 record
-- writes of automation_apply, "Note added" capture and the inbound webhook's per-link rate limit.
-- Needs: Part 1 applied. Independent of step E and of G2.4's guards. Run it BEFORE the app that calls
-- contact_tags_edit / contact_note_add / contact_note_remove goes live (that app falls back to its old whole-list save while
-- these functions are missing, so the order is safe either way; with them, an open lead card can no longer erase a tag or
-- a note a workflow added, nor make a false "tag removed" event — design §3.9, Appendix A E53).
-- What it does (one transaction):
--   contact_tags_merge(tags, add, remove)   pure: remove (any case), then add the ones not there (any case), order kept
--   contact_notes_append(list, note, max)    pure: one {id, text, by, at} more (text cut to max; null = whole; a given
--                                            time kept as it is, none = now), nothing when that id is there already
--                                            (any id up to 128 characters, no control characters); a value that is not
--                                            a list is returned as it is
--   contact_tags_edit(p_id, p_add, p_remove) the lead card's tag click / bulk tags / Undo: ONE update of that lead's tags
--   contact_note_add(p_id, p_note)           the lead card's "Add note" / Undo of a delete: one note more
--   contact_note_remove(p_id, p_note_id)     the lead card's note delete: that note out, the others kept
--     (security invoker: the signed-in person's own rights on contacts (RLS) decide, exactly as the app's direct update)
--   automation_apply (replaced; same signature): 'tags' = contact_tags_merge (any case, as the card); 'note' = a
--     customer_notes note {id, text ≤ 2000, by 'Automation: <name>', at} (Part 1 appended to the old notes text); 'task'
--     also without a lead (a Scheduler / unmatched webhook workflow: the team's task); activity lines only on a lead or a
--     job (and 'comment' only there); everything else as Part 1
--   automation_capture_contacts (replaced): + "Note added" (a new note id in customer_notes, also on a new lead)
--   automation_hook_hit(p_business, p_hook, p_now, p_limit)   the inbound link's calls this minute (atomic), -1 = no link
--
-- Check before (read-only):
--   select format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'public.contacts'::regclass and attname in ('tags', 'customer_notes') order by attname;
--     -- customer_notes: jsonb; tags: text[]  (the block below stops if not)
--   select to_regprocedure('public.automation_apply(text, text, text, text, jsonb)') is not null,
--          to_regclass('public.automation_hooks') is not null;                      -- true, true (Part 1)
--   select count(*) from public.contacts where customer_notes is not null and jsonb_typeof(customer_notes) <> 'array';   -- 0 (else: those cards' notes
--     are left alone by the new functions — the card's add / delete answers with an error, a workflow's "Add note" is
--     skipped with the reason — read them first and turn them into a list by hand if they matter)
--   select pg_get_functiondef('public.automation_apply(text, text, text, text, jsonb)'::regprocedure) ~ 'set notes = case';   -- true (Part 1's version)
-- ────────────────────────────────────────────────────────────────────────────────────────────────────────────
begin;
set local lock_timeout = '5s';
do $$
begin
  if to_regprocedure('public.automation_apply(text, text, text, text, jsonb)') is null or to_regclass('public.automation_hooks') is null
     or to_regprocedure('public.automation_capture_put(text, text, text, text, text, uuid, jsonb)') is null then
    raise exception 'Part 2 G2.3 needs Part 1 (automation_apply, automation_hooks, the capture functions): run Part 1 first';
  end if;
  if (select format_type(a.atttypid, a.atttypmod) from pg_attribute a
       where a.attrelid = 'public.contacts'::regclass and a.attname = 'customer_notes' and not a.attisdropped) is distinct from 'jsonb' then
    raise exception 'contacts.customer_notes is not jsonb: the note functions must be rewritten before this part runs';
  end if;
  if (select format_type(a.atttypid, a.atttypmod) from pg_attribute a
       where a.attrelid = 'public.contacts'::regclass and a.attname = 'tags' and not a.attisdropped) is distinct from 'text[]' then
    raise exception 'contacts.tags is not text[]: contact_tags_edit must be rewritten before this part runs';
  end if;
end $$;

-- The lead card's tag rule (toggleLeadTag / bulkTag): a tag is the same tag in any case. Removed first (every case),
-- then each added tag that is not there yet (trimmed, ≤ 60 characters, empty ones ignored); the order is kept.
create or replace function public.contact_tags_merge(p_tags text[], p_add text[], p_remove text[]) returns text[]
language sql immutable set search_path = ''
as $$
  with rem as (select pg_catalog.lower(pg_catalog.btrim(r.r)) as r from pg_catalog.unnest(coalesce(p_remove, '{}'::text[])) as r(r) where r.r is not null),
  kept as (select u.x, u.n from pg_catalog.unnest(coalesce(p_tags, '{}'::text[])) with ordinality as u(x, n)
            where u.x is not null and u.x <> '' and not exists (select 1 from rem where rem.r = pg_catalog.lower(u.x))),
  adds as (select pg_catalog.left(pg_catalog.btrim(v.y), 60) as x, v.k as n from pg_catalog.unnest(coalesce(p_add, '{}'::text[])) with ordinality as v(y, k)
            where v.y is not null and pg_catalog.btrim(v.y) <> ''),
  added as (select a.x, a.n from adds a
             where not exists (select 1 from kept where pg_catalog.lower(kept.x) = pg_catalog.lower(a.x))
               and not exists (select 1 from adds a2 where a2.n < a.n and pg_catalog.lower(a2.x) = pg_catalog.lower(a.x)))
  select array(select z.x from (select kept.x, 0 as part, kept.n from kept union all select added.x, 1, added.n from added) as z order by z.part, z.n)
$$;

-- One note more ({id, text, by, at}; the id a short word of letters, digits, _ or -), nothing when that id is there.
-- The text is cut to p_max characters (a workflow's note: 2000; the lead card's own note: null = kept whole, as its old
-- whole-list save kept it). A value that is not a list (a string, an object) is left exactly as it is.
-- (stable, not immutable: a note without its time gets now())
drop function if exists public.contact_notes_append(jsonb, jsonb);
create or replace function public.contact_notes_append(p_list jsonb, p_note jsonb, p_max integer default 2000) returns jsonb
language sql stable set search_path = ''
as $$
  select case
    when p_list is not null and pg_catalog.jsonb_typeof(p_list) <> 'array' then p_list
    when pg_catalog.jsonb_typeof(p_note) is distinct from 'object' or coalesce(p_note ->> 'id', '') = ''
         or pg_catalog.char_length(p_note ->> 'id') > 128 or (p_note ->> 'id') ~ '[[:cntrl:]]'
         or pg_catalog.btrim(coalesce(p_note ->> 'text', '')) = '' then coalesce(p_list, '[]'::jsonb)
    when exists (select 1 from pg_catalog.jsonb_array_elements(coalesce(p_list, '[]'::jsonb)) as e where e.value ->> 'id' = p_note ->> 'id') then p_list
    else coalesce(p_list, '[]'::jsonb)
         || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id', p_note ->> 'id',
              'text', case when p_max is null then pg_catalog.btrim(p_note ->> 'text') else pg_catalog.left(pg_catalog.btrim(p_note ->> 'text'), p_max) end,
              'by', pg_catalog.left(coalesce(p_note ->> 'by', ''), 120),
              -- a given time is kept as it is (the Undo of a note that had none, ''); no time at all = now
              'at', case when pg_catalog.jsonb_typeof(p_note -> 'at') = 'string' then p_note ->> 'at' else pg_catalog.to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end))
  end
$$;

-- The lead card's tag edit: one statement, so a tag added meanwhile (by a workflow, another tab) is never lost and no
-- false "tag removed" comes out of a whole-list save. → the lead's tags now (an error when the lead is not there for you).
create or replace function public.contact_tags_edit(p_id uuid, p_add text[], p_remove text[]) returns text[]
language plpgsql volatile security invoker set search_path = ''
as $$
declare res text[];
begin
  if pg_catalog.cardinality(coalesce(p_add, '{}'::text[])) > 10 or pg_catalog.cardinality(coalesce(p_remove, '{}'::text[])) > 10 then
    raise exception 'at most 10 tags at a time';
  end if;
  update public.contacts t set tags = public.contact_tags_merge(t.tags, p_add, p_remove) where t.id = p_id returning t.tags into res;
  if not found then raise exception 'lead not found'; end if;
  return coalesce(res, '{}'::text[]);
end $$;

-- The lead card's note: one more, kept even when someone (or a workflow) added another meanwhile; its text whole (the
-- card's old whole-list save kept any length, so a long note and the Undo of a deleted long note stay whole). Its id: any
-- non-empty one up to 128 characters without control characters (the card's own are uid()s; the Undo of a deleted
-- imported note, e.g. 'ghl:123/x', puts it back as it was). Notes that are not a list are never touched (an error).
-- → the notes now.
create or replace function public.contact_note_add(p_id uuid, p_note jsonb) returns jsonb
language plpgsql volatile security invoker set search_path = ''
as $$
declare res jsonb;
begin
  if pg_catalog.jsonb_typeof(p_note) is distinct from 'object' or coalesce(p_note ->> 'id', '') = ''
     or pg_catalog.char_length(p_note ->> 'id') > 128 or (p_note ->> 'id') ~ '[[:cntrl:]]'
     or pg_catalog.btrim(coalesce(p_note ->> 'text', '')) = '' then
    raise exception 'a note needs an id and some text';
  end if;
  update public.contacts t set customer_notes = public.contact_notes_append(t.customer_notes, p_note, null)
   where t.id = p_id and (t.customer_notes is null or pg_catalog.jsonb_typeof(t.customer_notes) = 'array') returning t.customer_notes into res;
  if not found then
    if exists (select 1 from public.contacts t where t.id = p_id) then raise exception 'this lead''s notes are not a list: they were left as they are'; end if;
    raise exception 'lead not found';
  end if;
  return coalesce(res, '[]'::jsonb);
end $$;

-- The lead card's note delete: that note out, every other kept (notes that are not a list: never touched, an error).
-- → the notes now.
create or replace function public.contact_note_remove(p_id uuid, p_note_id text) returns jsonb
language plpgsql volatile security invoker set search_path = ''
as $$
declare res jsonb;
begin
  update public.contacts t set customer_notes = coalesce((select pg_catalog.jsonb_agg(e.value order by e.n) from pg_catalog.jsonb_array_elements(
           coalesce(t.customer_notes, '[]'::jsonb)) with ordinality as e(value, n)
         where e.value ->> 'id' is distinct from p_note_id), '[]'::jsonb)
   where t.id = p_id and (t.customer_notes is null or pg_catalog.jsonb_typeof(t.customer_notes) = 'array') returning t.customer_notes into res;
  if not found then
    if exists (select 1 from public.contacts t where t.id = p_id) then raise exception 'this lead''s notes are not a list: they were left as they are'; end if;
    raise exception 'lead not found';
  end if;
  return coalesce(res, '[]'::jsonb);
end $$;

-- An inbound webhook link's calls this minute, counted in one statement (design §3.11: 60 a minute per link; the
-- function answers 429 above p_limit). -1 = no such link (revoked, another business).
create or replace function public.automation_hook_hit(p_business text, p_hook uuid, p_now timestamptz, p_limit integer)
returns integer language plpgsql volatile security definer set search_path = ''
as $$
declare n integer;
begin
  update public.automation_hooks h
     set window_count = case when h.window_start is null or h.window_start <= p_now - interval '1 minute' then 1 else h.window_count + 1 end,
         window_start = case when h.window_start is null or h.window_start <= p_now - interval '1 minute' then p_now else h.window_start end,
         last_used_at = p_now
   where h.id = p_hook and h.business_id = p_business and h.revoked_at is null
  returning h.window_count into n;
  if n is null then return -1; end if;
  return n;
end $$;

create or replace function public.automation_apply(p_business text, p_cause text, p_kind text, p_id text, p_ops jsonb)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  m text[]; run uuid; aut uuid; depth integer; nm text; actor text; op jsonb; o text; i integer := 0; line text;
  applied jsonb := '[]'::jsonb; skipped jsonb := '[]'::jsonb; cid uuid; cur record; col text; typ text; v text; addt text[]; remt text[];
  tgt text; sct text; tid text; ch text; stamp text;
  allowed constant text[] := array['full_name', 'postcode', 'division', 'source', 'next_follow_up', 'booked_for', 'quote_amount', 'lost_reason'];
begin
  m := pg_catalog.regexp_match(coalesce(p_cause, ''),
         '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9]{1,3}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');
  if m is null then raise exception 'automation_apply needs p_cause = <run>:<depth>:<automation>'; end if;
  run := m[1]::uuid; depth := m[2]::integer; aut := m[3]::uuid;
  if pg_catalog.jsonb_typeof(p_ops) is distinct from 'array' or pg_catalog.jsonb_array_length(p_ops) > 20 then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'ops must be a list of at most 20');
  end if;
  select a.name into nm from public.automations a where a.id = aut and a.business_id = p_business;
  if nm is null then return pg_catalog.jsonb_build_object('ok', false, 'reason', 'automation not found'); end if;
  actor := pg_catalog.left('Automation: ' || nm, 120);
  perform pg_catalog.set_config('automation.cause', p_cause, true);
  if p_kind = 'contact' then
    cid := p_id::uuid;
    select c.id, c.status into cur from public.contacts c where c.id = cid for update;
    if not found then return pg_catalog.jsonb_build_object('ok', false, 'reason', 'record deleted'); end if;
  end if;
  for op in select e.value from pg_catalog.jsonb_array_elements(p_ops) as e loop
    i := i + 1; o := coalesce(op ->> 'op', ''); line := null;
    begin
      if o in ('set', 'tags', 'note', 'optout', 'read', 'stage') and cid is null then
        skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'wrong_kind'); continue;
      end if;
      if o = 'set' then
        col := op ->> 'field';
        if col is null or not (col = any(allowed)) then
          skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'field not allowed'); continue;
        end if;
        if col = 'quote_amount' then col := 'estimated_value'; end if;
        select pg_catalog.format_type(a.atttypid, a.atttypmod) into typ from pg_catalog.pg_attribute a
         where a.attrelid = 'public.contacts'::regclass and a.attname = col and not a.attisdropped;
        v := nullif(pg_catalog.left(op ->> 'value', 500), '');
        execute pg_catalog.format('update public.contacts set %I = cast($1 as %s) where id = $2', col, typ) using v, cid;
        line := 'Changed ' || (op ->> 'field') || ' to "' || coalesce(pg_catalog.left(v, 80), '') || '"';
      elsif o = 'tags' then
        addt := array(select pg_catalog.left(pg_catalog.btrim(x), 60) from pg_catalog.jsonb_array_elements_text(coalesce(op -> 'add', '[]'::jsonb)) as x where pg_catalog.btrim(x) <> '');
        remt := array(select pg_catalog.btrim(x) from pg_catalog.jsonb_array_elements_text(coalesce(op -> 'remove', '[]'::jsonb)) as x);
        -- the lead card's own rule (contact_tags_merge = contact_tags_edit): a tag is the same tag in any case
        update public.contacts t set tags = public.contact_tags_merge(t.tags, addt, remt) where t.id = cid;
        line := 'Tags' || case when pg_catalog.cardinality(addt) > 0 then ' added: ' || pg_catalog.array_to_string(addt, ', ') else '' end
                       || case when pg_catalog.cardinality(remt) > 0 then ' removed: ' || pg_catalog.array_to_string(remt, ', ') else '' end;
      elsif o = 'note' then
        v := pg_catalog.left(pg_catalog.btrim(coalesce(op ->> 'text', '')), 2000);
        if v = '' then skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'empty note'); continue; end if;
        -- one more note on the card ({id, text, by, at}: the lead card's own shape, contact_note_add's rule)
        update public.contacts t set customer_notes = public.contact_notes_append(t.customer_notes, pg_catalog.jsonb_build_object(
            'id', 'wf' || pg_catalog.replace(gen_random_uuid()::text, '-', ''), 'text', v, 'by', actor,
            'at', pg_catalog.to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
         where t.id = cid and (t.customer_notes is null or pg_catalog.jsonb_typeof(t.customer_notes) = 'array');
        -- notes that are not a list (an old string or object) are never replaced
        if not found then skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'the notes on this card are not a list'); continue; end if;
        line := 'Note added: ' || pg_catalog.left(v, 200);
      elsif o = 'optout' then
        ch := coalesce(nullif(op ->> 'channel', ''), 'all');
        if not exists (select 1 from public.customer_opt_outs x where x.contact_id = cid and x.channel = ch) then
          insert into public.customer_opt_outs (business_id, contact_id, channel, reason) values (p_business, cid, ch, actor);
        end if;
        line := 'Automatic messages stopped (' || ch || ')';
      elsif o = 'read' then
        select pg_catalog.format_type(a.atttypid, a.atttypmod) into typ from pg_catalog.pg_attribute a
         where a.attrelid = 'public.contacts'::regclass and a.attname = 'last_read_at' and not a.attisdropped;
        stamp := case when typ in ('text', 'character varying') then 'to_char(now() at time zone ''UTC'', ''YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'')' else 'now()' end;
        execute pg_catalog.format('update public.contacts set last_read_at = %s where id = $1', stamp) using cid;
        line := 'Conversation marked as read';
      elsif o = 'stage' then
        tgt := nullif(pg_catalog.btrim(coalesce(op ->> 'to', '')), '');
        if tgt is null then skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'no stage'); continue; end if;
        if tgt = public.automation_catalog_key('stageWon', 'Won') then
          skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'A lead is won when its job is entered'); continue;
        end if;
        if cur.status::text is not distinct from tgt then
          skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'already in that stage'); continue;
        end if;
        select pg_catalog.format_type(a.atttypid, a.atttypmod) into typ from pg_catalog.pg_attribute a
         where a.attrelid = 'public.contacts'::regclass and a.attname = 'stage_changed_at' and not a.attisdropped;
        stamp := case when typ in ('text', 'character varying') then 'to_char(now() at time zone ''UTC'', ''YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'')' else 'now()' end;
        execute pg_catalog.format('update public.contacts set status = $1, stage_changed_at = %s, lost_reason = case when $1 = $3 and $4 is not null then $4 else lost_reason end'
                                  || ' where id = $2 returning to_jsonb(stage_changed_at) #>> ''{}''', stamp)
          into sct using tgt, cid, public.automation_catalog_key('stageLost', 'Lost'), nullif(pg_catalog.left(op ->> 'lost_reason', 200), '');
        if exists (select 1 from public.automation_wanted wt where wt.business_id = p_business and wt.event_type = 'stage') then
          insert into public.automation_events (business_id, type, event_key, record_kind, record_id, contact_id, at, available_at, ctx, source,
                                                cause_run_id, cause_automation_id, chain_depth)
          values (p_business, 'stage', pg_catalog.left(cid::text || ':' || tgt || ':' || sct, 200), 'contact', cid::text, cid, now(),
                  now() + pg_catalog.make_interval(secs => public.automation_settle_seconds('stage')), pg_catalog.jsonb_build_object('stage', tgt),
                  'engine', run, aut, least(depth + 1, 100))
          on conflict (business_id, type, event_key) do nothing;
        end if;
        cur.status := tgt;
        line := 'Moved to ' || tgt;
      elsif o = 'task' then
        if nullif(pg_catalog.btrim(coalesce(op ->> 'title', '')), '') is null or nullif(op ->> 'board', '') is null then
          skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'missing details'); continue;
        end if;
        -- a task of a lead, or (a workflow with no lead: a Scheduler, an inbound webhook nobody matched) the team's own
        insert into public.tasks (board, title, status, due, notes, client, contact_id, assignees, assigned_to, category, priority, created_by)
        values (op ->> 'board', pg_catalog.left(op ->> 'title', 200), coalesce(nullif(op ->> 'status', ''), 'Not Started'), nullif(op ->> 'due', '')::date,
                nullif(pg_catalog.left(op ->> 'notes', 2000), ''), (select c.full_name from public.contacts c where c.id = cid), cid,
                array(select pg_catalog.jsonb_array_elements_text(coalesce(op -> 'assignees', '[]'::jsonb))), nullif(op ->> 'assigned_to', ''),
                nullif(op ->> 'category', ''), nullif(op ->> 'priority', ''), actor)
        returning id::text into tid;
        line := 'Task added: ' || pg_catalog.left(op ->> 'title', 120);
      elsif o = 'comment' then
        v := pg_catalog.left(pg_catalog.btrim(coalesce(op ->> 'text', '')), 1000);
        if v = '' then skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'empty comment'); continue; end if;
        if p_kind not in ('contact', 'job') then
          skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'wrong_kind'); continue;
        end if;
        insert into public.activity_log (record_kind, record_id, actor, text, manual) values (p_kind, p_id, actor, v, false);
      elsif o = 'custom' then
        insert into public.automation_custom_values as cv (business_id, key, value, updated_at)
        values (p_business, op ->> 'key', coalesce(pg_catalog.left(op ->> 'value', 500), ''), now())
        on conflict (business_id, key) do update set value = excluded.value, updated_at = excluded.updated_at;
      else
        skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'unknown op'); continue;
      end if;
      if line is not null and p_kind in ('contact', 'job') then
        insert into public.activity_log (record_kind, record_id, actor, text, manual) values (p_kind, p_id, actor, pg_catalog.left(line, 300), false);
      end if;
      applied := applied || pg_catalog.jsonb_build_object('i', i, 'op', o);
    exception when others then
      skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', pg_catalog.left(sqlerrm, 200));
    end;
  end loop;
  return pg_catalog.jsonb_build_object('ok', true, 'applied', applied, 'skipped', skipped);
end $$;

create or replace function public.automation_capture_contacts() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare b text; w text[]; tx text; id text; chg jsonb := '[]'::jsonb; x jsonb; t text; bk text; st text;
begin
  begin
    if pg_catalog.current_setting('automation.capture_test_error', true) = 'on' then raise exception 'forced capture error (staging check)'; end if;
    b := public.current_business_id();
    select pg_catalog.array_agg(wt.event_type) into w from public.automation_wanted wt where wt.business_id = b;
    if w is null then return null; end if;
    tx := pg_catalog.txid_current()::text; id := new.id::text;
    if tg_op = 'UPDATE' and 'contact_changed' = any(w) then
      if new.full_name is distinct from old.full_name then chg := chg || pg_catalog.jsonb_build_object('field', 'full_name', 'old', pg_catalog.left(old.full_name::text, 200), 'new', pg_catalog.left(new.full_name::text, 200)); end if;
      if new.phone is distinct from old.phone then chg := chg || pg_catalog.jsonb_build_object('field', 'phone', 'old', pg_catalog.left(old.phone::text, 200), 'new', pg_catalog.left(new.phone::text, 200)); end if;
      if new.email is distinct from old.email then chg := chg || pg_catalog.jsonb_build_object('field', 'email', 'old', pg_catalog.left(old.email::text, 200), 'new', pg_catalog.left(new.email::text, 200)); end if;
      if new.postcode is distinct from old.postcode then chg := chg || pg_catalog.jsonb_build_object('field', 'postcode', 'old', pg_catalog.left(old.postcode::text, 200), 'new', pg_catalog.left(new.postcode::text, 200)); end if;
      if new.division is distinct from old.division then chg := chg || pg_catalog.jsonb_build_object('field', 'division', 'old', pg_catalog.left(old.division::text, 200), 'new', pg_catalog.left(new.division::text, 200)); end if;
      if new.source is distinct from old.source then chg := chg || pg_catalog.jsonb_build_object('field', 'source', 'old', pg_catalog.left(old.source::text, 200), 'new', pg_catalog.left(new.source::text, 200)); end if;
      if new.next_follow_up is distinct from old.next_follow_up then chg := chg || pg_catalog.jsonb_build_object('field', 'next_follow_up', 'old', pg_catalog.left(old.next_follow_up::text, 200), 'new', pg_catalog.left(new.next_follow_up::text, 200)); end if;
      if new.booked_for is distinct from old.booked_for then chg := chg || pg_catalog.jsonb_build_object('field', 'booked_for', 'old', pg_catalog.left(old.booked_for::text, 200), 'new', pg_catalog.left(new.booked_for::text, 200)); end if;
      if new.estimated_value is distinct from old.estimated_value then chg := chg || pg_catalog.jsonb_build_object('field', 'quote_amount', 'old', pg_catalog.left(old.estimated_value::text, 200), 'new', pg_catalog.left(new.estimated_value::text, 200)); end if;
      if new.lost_reason is distinct from old.lost_reason then chg := chg || pg_catalog.jsonb_build_object('field', 'lost_reason', 'old', pg_catalog.left(old.lost_reason::text, 200), 'new', pg_catalog.left(new.lost_reason::text, 200)); end if;
      for x in select e.value from pg_catalog.jsonb_array_elements(chg) as e loop
        perform public.automation_capture_put(b, 'contact_changed', id || ':chg:' || (x ->> 'field') || ':' || tx, 'contact', id, new.id, x);
      end loop;
    end if;
    if 'contact_tag' = any(w) then
      for t in select a.x from pg_catalog.unnest(coalesce(new.tags, '{}'::text[])) as a(x) where a.x is not null and a.x <> ''
               except select o.x from pg_catalog.unnest(case when tg_op = 'UPDATE' then coalesce(old.tags, '{}'::text[]) else '{}'::text[] end) as o(x) loop
        perform public.automation_capture_put(b, 'contact_tag', id || ':tag:+:' || pg_catalog.left(t, 100) || ':' || tx, 'contact', id, new.id,
                                              pg_catalog.jsonb_build_object('tag', pg_catalog.left(t, 100), 'action', 'added'));
      end loop;
      if tg_op = 'UPDATE' then
        for t in select o.x from pg_catalog.unnest(coalesce(old.tags, '{}'::text[])) as o(x) where o.x is not null and o.x <> ''
                 except select a.x from pg_catalog.unnest(coalesce(new.tags, '{}'::text[])) as a(x) loop
          perform public.automation_capture_put(b, 'contact_tag', id || ':tag:-:' || pg_catalog.left(t, 100) || ':' || tx, 'contact', id, new.id,
                                                pg_catalog.jsonb_build_object('tag', pg_catalog.left(t, 100), 'action', 'removed'));
        end loop;
      end if;
    end if;
    if tg_op = 'INSERT' then bk := case when new.booked_for is not null then 'booked' end;
    elsif new.booked_for is distinct from old.booked_for then
      bk := case when old.booked_for is null then 'booked' when new.booked_for is null then 'cancelled' else 'rescheduled' end;
    end if;
    if bk = 'booked' and 'job_booked' = any(w) then
      perform public.automation_capture_put(b, 'job_booked', id || ':booked:' || (pg_catalog.to_jsonb(new.booked_for) #>> '{}'), 'contact', id, new.id,
                                            pg_catalog.jsonb_build_object('booked_for', pg_catalog.to_jsonb(new.booked_for) #>> '{}'));
    end if;
    if bk is not null and 'booking_status' = any(w) then
      perform public.automation_capture_put(b, 'booking_status', id || ':bk:' || bk || ':' || tx, 'contact', id, new.id,
        pg_catalog.jsonb_build_object('status', bk, 'booked_for', pg_catalog.to_jsonb(new.booked_for) #>> '{}',
                                      'old_booked_for', case when tg_op = 'UPDATE' then pg_catalog.to_jsonb(old.booked_for) #>> '{}' end));
    end if;
    if tg_op = 'UPDATE' and new.status is distinct from old.status and 'lead_status' = any(w) then
      st := case when new.status::text = public.automation_catalog_key('stageWon', 'Won') then 'won'
                 when new.status::text = public.automation_catalog_key('stageLost', 'Lost') then 'lost' else 'open' end;
      perform public.automation_capture_put(b, 'lead_status', id || ':st:' || pg_catalog.left(coalesce(new.status::text, ''), 60) || ':' || tx, 'contact', id, new.id,
        pg_catalog.jsonb_build_object('stage', pg_catalog.left(new.status::text, 200), 'from', pg_catalog.left(old.status::text, 200), 'status', st));
    end if;
    -- Note added (G2.3): a note id on the card that was not there before (the lead card and automation_apply both add
    -- {id, text, by, at} to customer_notes through contact_notes_append; a new lead's first note counts too)
    if 'note_added' = any(w) then
      for x in select e.value from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(new.customer_notes) = 'array' then new.customer_notes else '[]'::jsonb end) as e
                where pg_catalog.jsonb_typeof(e.value) = 'object' and coalesce(e.value ->> 'id', '') <> ''
                  and not exists (select 1 from pg_catalog.jsonb_array_elements(case when tg_op = 'UPDATE' and pg_catalog.jsonb_typeof(old.customer_notes) = 'array'
                                                                                     then old.customer_notes else '[]'::jsonb end) as o2
                                   where o2.value ->> 'id' = e.value ->> 'id') loop
        perform public.automation_capture_put(b, 'note_added', id || ':note:' || pg_catalog.left(x ->> 'id', 128), 'contact', id, new.id,
          pg_catalog.jsonb_build_object('note_id', pg_catalog.left(x ->> 'id', 128), 'text', pg_catalog.left(x ->> 'text', 200), 'by', pg_catalog.left(x ->> 'by', 120)));
      end loop;
    end if;
    if 'estimates' = any(w) and coalesce(new.estimated_value, 0) > 0
       and (tg_op = 'INSERT' or coalesce(old.estimated_value, 0) <= 0) then
      perform public.automation_capture_put(b, 'estimates', id || ':quote:' || tx, 'contact', id, new.id, pg_catalog.jsonb_build_object('status', 'sent'));
    end if;
  exception when others then
    begin
      update public.automation_state set capture_errors = capture_errors + 1, capture_error_last = pg_catalog.left(tg_table_name || ': ' || sqlerrm, 200),
             capture_error_at = now()
       where business_id = (select z.business_id from public.automation_state z where z.business_id = coalesce(b, public.current_business_id())
                              for update skip locked);
    exception when others then null;
    end;
  end;
  return null;
end $$;

revoke all on function public.contact_tags_merge(text[], text[], text[]) from public, anon;
revoke all on function public.contact_notes_append(jsonb, jsonb, integer) from public, anon;
revoke all on function public.contact_tags_edit(uuid, text[], text[]) from public, anon;
revoke all on function public.contact_note_add(uuid, jsonb) from public, anon;
revoke all on function public.contact_note_remove(uuid, text) from public, anon;
grant execute on function public.contact_tags_merge(text[], text[], text[]) to authenticated, service_role;
grant execute on function public.contact_notes_append(jsonb, jsonb, integer) to authenticated, service_role;
grant execute on function public.contact_tags_edit(uuid, text[], text[]) to authenticated, service_role;
grant execute on function public.contact_note_add(uuid, jsonb) to authenticated, service_role;
grant execute on function public.contact_note_remove(uuid, text) to authenticated, service_role;
revoke all on function public.automation_hook_hit(text, uuid, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.automation_hook_hit(text, uuid, timestamptz, integer) to service_role;
revoke all on function public.automation_apply(text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.automation_apply(text, text, text, text, jsonb) to service_role;
revoke all on function public.automation_capture_contacts() from public, anon, authenticated;
commit;
-- Check after (read-only; the staging checks 17–18 do the writes, all undone):
--   select public.contact_tags_merge(array['VIP', 'Callback'], array['vip', 'Complaint'], array['callback']);   -- {VIP,Complaint}
--   select p.proname, p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
--    and p.proname in ('contact_tags_edit', 'contact_note_add', 'contact_note_remove', 'automation_hook_hit') order by 1;
--     -- three contact_* false (security invoker), automation_hook_hit true
--   select has_function_privilege('authenticated', 'public.contact_tags_edit(uuid, text[], text[])', 'EXECUTE'),
--          has_function_privilege('anon', 'public.contact_tags_edit(uuid, text[], text[])', 'EXECUTE'),
--          has_function_privilege('authenticated', 'public.automation_hook_hit(text, uuid, timestamptz, integer)', 'EXECUTE');   -- true, false, false
--   select pg_get_functiondef('public.automation_apply(text, text, text, text, jsonb)'::regprocedure) ~ 'contact_notes_append';   -- true
--   select pg_get_functiondef('public.automation_capture_contacts()'::regprocedure) ~ 'note_added';                        -- true
--   select capture_errors from public.automation_state;   -- unchanged (no new capture failures after an app save)
--
-- ROLLBACK (G2.3 only; run by hand). Part 1's automation_apply and automation_capture_contacts come back exactly as Part 1
-- wrote them (copied below from PART 1 of this file), the new functions go. The app that calls contact_tags_edit /
-- contact_note_add / contact_note_remove falls back to its whole-list save by itself when they are missing.
-- begin;
-- create or replace function public.automation_apply(p_business text, p_cause text, p_kind text, p_id text, p_ops jsonb)
-- returns jsonb language plpgsql volatile security definer set search_path = ''
-- as $$
-- declare
--   m text[]; run uuid; aut uuid; depth integer; nm text; actor text; op jsonb; o text; i integer := 0; line text;
--   applied jsonb := '[]'::jsonb; skipped jsonb := '[]'::jsonb; cid uuid; cur record; col text; typ text; v text; addt text[]; remt text[];
--   tgt text; sct text; tid text; ch text; stamp text;
--   allowed constant text[] := array['full_name', 'postcode', 'division', 'source', 'next_follow_up', 'booked_for', 'quote_amount', 'lost_reason'];
-- begin
--   m := pg_catalog.regexp_match(coalesce(p_cause, ''),
--          '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9]{1,3}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');
--   if m is null then raise exception 'automation_apply needs p_cause = <run>:<depth>:<automation>'; end if;
--   run := m[1]::uuid; depth := m[2]::integer; aut := m[3]::uuid;
--   if pg_catalog.jsonb_typeof(p_ops) is distinct from 'array' or pg_catalog.jsonb_array_length(p_ops) > 20 then
--     return pg_catalog.jsonb_build_object('ok', false, 'reason', 'ops must be a list of at most 20');
--   end if;
--   select a.name into nm from public.automations a where a.id = aut and a.business_id = p_business;
--   if nm is null then return pg_catalog.jsonb_build_object('ok', false, 'reason', 'automation not found'); end if;
--   actor := pg_catalog.left('Automation: ' || nm, 120);
--   perform pg_catalog.set_config('automation.cause', p_cause, true);
--   if p_kind = 'contact' then
--     cid := p_id::uuid;
--     select c.id, c.status into cur from public.contacts c where c.id = cid for update;
--     if not found then return pg_catalog.jsonb_build_object('ok', false, 'reason', 'record deleted'); end if;
--   end if;
--   for op in select e.value from pg_catalog.jsonb_array_elements(p_ops) as e loop
--     i := i + 1; o := coalesce(op ->> 'op', ''); line := null;
--     begin
--       if o in ('set', 'tags', 'note', 'optout', 'read', 'stage', 'task') and cid is null then
--         skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'wrong_kind'); continue;
--       end if;
--       if o = 'set' then
--         col := op ->> 'field';
--         if col is null or not (col = any(allowed)) then
--           skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'field not allowed'); continue;
--         end if;
--         if col = 'quote_amount' then col := 'estimated_value'; end if;
--         select pg_catalog.format_type(a.atttypid, a.atttypmod) into typ from pg_catalog.pg_attribute a
--          where a.attrelid = 'public.contacts'::regclass and a.attname = col and not a.attisdropped;
--         v := nullif(pg_catalog.left(op ->> 'value', 500), '');
--         execute pg_catalog.format('update public.contacts set %I = cast($1 as %s) where id = $2', col, typ) using v, cid;
--         line := 'Changed ' || (op ->> 'field') || ' to "' || coalesce(pg_catalog.left(v, 80), '') || '"';
--       elsif o = 'tags' then
--         addt := array(select pg_catalog.left(pg_catalog.btrim(x), 60) from pg_catalog.jsonb_array_elements_text(coalesce(op -> 'add', '[]'::jsonb)) as x where pg_catalog.btrim(x) <> '');
--         remt := array(select pg_catalog.btrim(x) from pg_catalog.jsonb_array_elements_text(coalesce(op -> 'remove', '[]'::jsonb)) as x);
--         update public.contacts t set tags = array(
--             select u.x from pg_catalog.unnest(coalesce(t.tags, '{}'::text[]) || addt) with ordinality as u(x, n)
--              where u.x is not null and not (u.x = any(remt)) group by u.x order by min(u.n))
--          where t.id = cid;
--         line := 'Tags' || case when pg_catalog.cardinality(addt) > 0 then ' added: ' || pg_catalog.array_to_string(addt, ', ') else '' end
--                        || case when pg_catalog.cardinality(remt) > 0 then ' removed: ' || pg_catalog.array_to_string(remt, ', ') else '' end;
--       elsif o = 'note' then
--         v := pg_catalog.left(pg_catalog.btrim(coalesce(op ->> 'text', '')), 1000);
--         if v = '' then skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'empty note'); continue; end if;
--         update public.contacts t set notes = case when coalesce(t.notes, '') = '' then v else t.notes || E'\n' || v end where t.id = cid;
--         line := 'Note added: ' || pg_catalog.left(v, 200);
--       elsif o = 'optout' then
--         ch := coalesce(nullif(op ->> 'channel', ''), 'all');
--         if not exists (select 1 from public.customer_opt_outs x where x.contact_id = cid and x.channel = ch) then
--           insert into public.customer_opt_outs (business_id, contact_id, channel, reason) values (p_business, cid, ch, actor);
--         end if;
--         line := 'Automatic messages stopped (' || ch || ')';
--       elsif o = 'read' then
--         select pg_catalog.format_type(a.atttypid, a.atttypmod) into typ from pg_catalog.pg_attribute a
--          where a.attrelid = 'public.contacts'::regclass and a.attname = 'last_read_at' and not a.attisdropped;
--         stamp := case when typ in ('text', 'character varying') then 'to_char(now() at time zone ''UTC'', ''YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'')' else 'now()' end;
--         execute pg_catalog.format('update public.contacts set last_read_at = %s where id = $1', stamp) using cid;
--         line := 'Conversation marked as read';
--       elsif o = 'stage' then
--         tgt := nullif(pg_catalog.btrim(coalesce(op ->> 'to', '')), '');
--         if tgt is null then skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'no stage'); continue; end if;
--         if tgt = public.automation_catalog_key('stageWon', 'Won') then
--           skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'A lead is won when its job is entered'); continue;
--         end if;
--         if cur.status::text is not distinct from tgt then
--           skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'already in that stage'); continue;
--         end if;
--         select pg_catalog.format_type(a.atttypid, a.atttypmod) into typ from pg_catalog.pg_attribute a
--          where a.attrelid = 'public.contacts'::regclass and a.attname = 'stage_changed_at' and not a.attisdropped;
--         stamp := case when typ in ('text', 'character varying') then 'to_char(now() at time zone ''UTC'', ''YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'')' else 'now()' end;
--         execute pg_catalog.format('update public.contacts set status = $1, stage_changed_at = %s, lost_reason = case when $1 = $3 and $4 is not null then $4 else lost_reason end'
--                                   || ' where id = $2 returning to_jsonb(stage_changed_at) #>> ''{}''', stamp)
--           into sct using tgt, cid, public.automation_catalog_key('stageLost', 'Lost'), nullif(pg_catalog.left(op ->> 'lost_reason', 200), '');
--         if exists (select 1 from public.automation_wanted wt where wt.business_id = p_business and wt.event_type = 'stage') then
--           insert into public.automation_events (business_id, type, event_key, record_kind, record_id, contact_id, at, available_at, ctx, source,
--                                                 cause_run_id, cause_automation_id, chain_depth)
--           values (p_business, 'stage', pg_catalog.left(cid::text || ':' || tgt || ':' || sct, 200), 'contact', cid::text, cid, now(),
--                   now() + pg_catalog.make_interval(secs => public.automation_settle_seconds('stage')), pg_catalog.jsonb_build_object('stage', tgt),
--                   'engine', run, aut, least(depth + 1, 100))
--           on conflict (business_id, type, event_key) do nothing;
--         end if;
--         cur.status := tgt;
--         line := 'Moved to ' || tgt;
--       elsif o = 'task' then
--         if nullif(pg_catalog.btrim(coalesce(op ->> 'title', '')), '') is null or nullif(op ->> 'board', '') is null then
--           skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'missing details'); continue;
--         end if;
--         insert into public.tasks (board, title, status, due, notes, client, contact_id, assignees, assigned_to, category, priority, created_by)
--         select op ->> 'board', pg_catalog.left(op ->> 'title', 200), coalesce(nullif(op ->> 'status', ''), 'Not Started'), nullif(op ->> 'due', '')::date,
--                nullif(pg_catalog.left(op ->> 'notes', 2000), ''), c.full_name, cid,
--                array(select pg_catalog.jsonb_array_elements_text(coalesce(op -> 'assignees', '[]'::jsonb))), nullif(op ->> 'assigned_to', ''),
--                nullif(op ->> 'category', ''), nullif(op ->> 'priority', ''), actor
--           from public.contacts c where c.id = cid
--         returning id::text into tid;
--         line := 'Task added: ' || pg_catalog.left(op ->> 'title', 120);
--       elsif o = 'comment' then
--         v := pg_catalog.left(pg_catalog.btrim(coalesce(op ->> 'text', '')), 1000);
--         if v = '' then skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'empty comment'); continue; end if;
--         insert into public.activity_log (record_kind, record_id, actor, text, manual) values (p_kind, p_id, actor, v, false);
--       elsif o = 'custom' then
--         insert into public.automation_custom_values as cv (business_id, key, value, updated_at)
--         values (p_business, op ->> 'key', coalesce(pg_catalog.left(op ->> 'value', 500), ''), now())
--         on conflict (business_id, key) do update set value = excluded.value, updated_at = excluded.updated_at;
--       else
--         skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', 'unknown op'); continue;
--       end if;
--       if line is not null then
--         insert into public.activity_log (record_kind, record_id, actor, text, manual) values (p_kind, p_id, actor, pg_catalog.left(line, 300), false);
--       end if;
--       applied := applied || pg_catalog.jsonb_build_object('i', i, 'op', o);
--     exception when others then
--       skipped := skipped || pg_catalog.jsonb_build_object('i', i, 'op', o, 'reason', pg_catalog.left(sqlerrm, 200));
--     end;
--   end loop;
--   return pg_catalog.jsonb_build_object('ok', true, 'applied', applied, 'skipped', skipped);
-- end $$;
-- create or replace function public.automation_capture_contacts() returns trigger
-- language plpgsql security definer set search_path = ''
-- as $$
-- declare b text; w text[]; tx text; id text; chg jsonb := '[]'::jsonb; x jsonb; t text; bk text; st text;
-- begin
--   begin
--     if pg_catalog.current_setting('automation.capture_test_error', true) = 'on' then raise exception 'forced capture error (staging check)'; end if;
--     b := public.current_business_id();
--     select pg_catalog.array_agg(wt.event_type) into w from public.automation_wanted wt where wt.business_id = b;
--     if w is null then return null; end if;
--     tx := pg_catalog.txid_current()::text; id := new.id::text;
--     if tg_op = 'UPDATE' and 'contact_changed' = any(w) then
--       if new.full_name is distinct from old.full_name then chg := chg || pg_catalog.jsonb_build_object('field', 'full_name', 'old', pg_catalog.left(old.full_name::text, 200), 'new', pg_catalog.left(new.full_name::text, 200)); end if;
--       if new.phone is distinct from old.phone then chg := chg || pg_catalog.jsonb_build_object('field', 'phone', 'old', pg_catalog.left(old.phone::text, 200), 'new', pg_catalog.left(new.phone::text, 200)); end if;
--       if new.email is distinct from old.email then chg := chg || pg_catalog.jsonb_build_object('field', 'email', 'old', pg_catalog.left(old.email::text, 200), 'new', pg_catalog.left(new.email::text, 200)); end if;
--       if new.postcode is distinct from old.postcode then chg := chg || pg_catalog.jsonb_build_object('field', 'postcode', 'old', pg_catalog.left(old.postcode::text, 200), 'new', pg_catalog.left(new.postcode::text, 200)); end if;
--       if new.division is distinct from old.division then chg := chg || pg_catalog.jsonb_build_object('field', 'division', 'old', pg_catalog.left(old.division::text, 200), 'new', pg_catalog.left(new.division::text, 200)); end if;
--       if new.source is distinct from old.source then chg := chg || pg_catalog.jsonb_build_object('field', 'source', 'old', pg_catalog.left(old.source::text, 200), 'new', pg_catalog.left(new.source::text, 200)); end if;
--       if new.next_follow_up is distinct from old.next_follow_up then chg := chg || pg_catalog.jsonb_build_object('field', 'next_follow_up', 'old', pg_catalog.left(old.next_follow_up::text, 200), 'new', pg_catalog.left(new.next_follow_up::text, 200)); end if;
--       if new.booked_for is distinct from old.booked_for then chg := chg || pg_catalog.jsonb_build_object('field', 'booked_for', 'old', pg_catalog.left(old.booked_for::text, 200), 'new', pg_catalog.left(new.booked_for::text, 200)); end if;
--       if new.estimated_value is distinct from old.estimated_value then chg := chg || pg_catalog.jsonb_build_object('field', 'quote_amount', 'old', pg_catalog.left(old.estimated_value::text, 200), 'new', pg_catalog.left(new.estimated_value::text, 200)); end if;
--       if new.lost_reason is distinct from old.lost_reason then chg := chg || pg_catalog.jsonb_build_object('field', 'lost_reason', 'old', pg_catalog.left(old.lost_reason::text, 200), 'new', pg_catalog.left(new.lost_reason::text, 200)); end if;
--       for x in select e.value from pg_catalog.jsonb_array_elements(chg) as e loop
--         perform public.automation_capture_put(b, 'contact_changed', id || ':chg:' || (x ->> 'field') || ':' || tx, 'contact', id, new.id, x);
--       end loop;
--     end if;
--     if 'contact_tag' = any(w) then
--       for t in select a.x from pg_catalog.unnest(coalesce(new.tags, '{}'::text[])) as a(x) where a.x is not null and a.x <> ''
--                except select o.x from pg_catalog.unnest(case when tg_op = 'UPDATE' then coalesce(old.tags, '{}'::text[]) else '{}'::text[] end) as o(x) loop
--         perform public.automation_capture_put(b, 'contact_tag', id || ':tag:+:' || pg_catalog.left(t, 100) || ':' || tx, 'contact', id, new.id,
--                                               pg_catalog.jsonb_build_object('tag', pg_catalog.left(t, 100), 'action', 'added'));
--       end loop;
--       if tg_op = 'UPDATE' then
--         for t in select o.x from pg_catalog.unnest(coalesce(old.tags, '{}'::text[])) as o(x) where o.x is not null and o.x <> ''
--                  except select a.x from pg_catalog.unnest(coalesce(new.tags, '{}'::text[])) as a(x) loop
--           perform public.automation_capture_put(b, 'contact_tag', id || ':tag:-:' || pg_catalog.left(t, 100) || ':' || tx, 'contact', id, new.id,
--                                                 pg_catalog.jsonb_build_object('tag', pg_catalog.left(t, 100), 'action', 'removed'));
--         end loop;
--       end if;
--     end if;
--     if tg_op = 'INSERT' then bk := case when new.booked_for is not null then 'booked' end;
--     elsif new.booked_for is distinct from old.booked_for then
--       bk := case when old.booked_for is null then 'booked' when new.booked_for is null then 'cancelled' else 'rescheduled' end;
--     end if;
--     if bk = 'booked' and 'job_booked' = any(w) then
--       perform public.automation_capture_put(b, 'job_booked', id || ':booked:' || (pg_catalog.to_jsonb(new.booked_for) #>> '{}'), 'contact', id, new.id,
--                                             pg_catalog.jsonb_build_object('booked_for', pg_catalog.to_jsonb(new.booked_for) #>> '{}'));
--     end if;
--     if bk is not null and 'booking_status' = any(w) then
--       perform public.automation_capture_put(b, 'booking_status', id || ':bk:' || bk || ':' || tx, 'contact', id, new.id,
--         pg_catalog.jsonb_build_object('status', bk, 'booked_for', pg_catalog.to_jsonb(new.booked_for) #>> '{}',
--                                       'old_booked_for', case when tg_op = 'UPDATE' then pg_catalog.to_jsonb(old.booked_for) #>> '{}' end));
--     end if;
--     if tg_op = 'UPDATE' and new.status is distinct from old.status and 'lead_status' = any(w) then
--       st := case when new.status::text = public.automation_catalog_key('stageWon', 'Won') then 'won'
--                  when new.status::text = public.automation_catalog_key('stageLost', 'Lost') then 'lost' else 'open' end;
--       perform public.automation_capture_put(b, 'lead_status', id || ':st:' || pg_catalog.left(coalesce(new.status::text, ''), 60) || ':' || tx, 'contact', id, new.id,
--         pg_catalog.jsonb_build_object('stage', pg_catalog.left(new.status::text, 200), 'from', pg_catalog.left(old.status::text, 200), 'status', st));
--     end if;
--     if 'estimates' = any(w) and coalesce(new.estimated_value, 0) > 0
--        and (tg_op = 'INSERT' or coalesce(old.estimated_value, 0) <= 0) then
--       perform public.automation_capture_put(b, 'estimates', id || ':quote:' || tx, 'contact', id, new.id, pg_catalog.jsonb_build_object('status', 'sent'));
--     end if;
--   exception when others then
--     begin
--       update public.automation_state set capture_errors = capture_errors + 1, capture_error_last = pg_catalog.left(tg_table_name || ': ' || sqlerrm, 200),
--              capture_error_at = now()
--        where business_id = (select z.business_id from public.automation_state z where z.business_id = coalesce(b, public.current_business_id())
--                               for update skip locked);
--     exception when others then null;
--     end;
--   end;
--   return null;
-- end $$;
-- revoke all on function public.automation_apply(text, text, text, text, jsonb) from public, anon, authenticated;
-- grant execute on function public.automation_apply(text, text, text, text, jsonb) to service_role;
-- revoke all on function public.automation_capture_contacts() from public, anon, authenticated;
-- drop function if exists public.automation_hook_hit(text, uuid, timestamptz, integer);
-- drop function if exists public.contact_note_remove(uuid, text);
-- drop function if exists public.contact_note_add(uuid, jsonb);
-- drop function if exists public.contact_tags_edit(uuid, text[], text[]);
-- drop function if exists public.contact_notes_append(jsonb, jsonb, integer);
-- drop function if exists public.contact_tags_merge(text[], text[], text[]);
-- commit;
-- Check after the rollback: select to_regprocedure('public.contact_tags_edit(uuid, text[], text[])') is null;   -- true
--   select pg_get_functiondef('public.automation_apply(text, text, text, text, jsonb)'::regprocedure) ~ 'set notes = case';   -- true
-- ────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- END PART 2 · G2.3

-- ────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- PART 2 · G2.4 (the guards on the doc; save, publish and migrate through the function) — design §2.9 Part 2, §3.13,
-- §3.16, §8.2 item 24. Needs: Part 1 applied, and the phase-2 function WITH THE API SECTION deployed first (it is the
-- only writer of definition / settings / publish from now on; the old editor saves through it once the app adapter is
-- pushed). Independent of step E and of G2.3 (any order among them; the RUNBOOK §12 order is the safe one).
-- What it does (one transaction):
--   automation_action_audience(type)      the audience of every action type (= the engine's WF_ACTIONS; a test compares)
--   automation_guarded_channels(def)      the guarded types a doc uses: customer + external actions, and every type or
--                                         kind this database does not know (counted as customer) — on EVERY node, also a
--                                         paused or unconnected one
--   automation_guarded_channels_v1(steps) the same for a phase-4 row (email → send_email, text → send_sms)
--   automation_node_ports / automation_def_shape / automation_arm_key   the shape key and the arm key (design §2.8; the
--                                         engine's defShape / armKey, compared as jsonb; the staging check runs every
--                                         fixtures/shape.json pair through them)
--   automations_guard (replaced)          v2 rules (below); the phase-4 rules are kept for rows without a doc
--   automations_customer_off_guard        its TRIGGER dropped (the v2 guard does the same for both kinds of row)
--   automations_after (new AFTER UPDATE)  a new version, a switch-off or a delete stops what waits at once: status
--                                         cancelled + exit_reason, one 'exit' log row each, their re-entry keys deleted
--                                         when no other run of the workflow used them (design E6/E55)
--   automation_save / automation_publish / automation_migrate_row   the function's only content writes (security
--                                         definer, service role only; they set automation.via = 'fn')
--   automation_needs_review (replaced)    + the problem codes the daily sweep keeps in list_summary.review
-- The v2 guard (BEFORE INSERT / UPDATE, the caller's rights):
--   INSERT: always a Draft (enabled false, armed_at null); version 1, revision 1, enrolled_total 0; origin only user / copy
--     unless the function writes (automation.via = 'fn'); audience from the guarded types.
--   UPDATE: business_id never changes; created_by / created_at kept; a write of trigger / steps on an UPGRADED row (a doc
--     is there) is refused ("This workflow was upgraded: reload the app"); origin, published_at / _by, enrolled_total,
--     system_key, system_handover_at kept unless the function or the SQL editor writes (current_user is not the app's
--     role: automation_enroll's counter keeps counting); revision + 1 when the name or the content (definition,
--     settings, layout, builder) changed — never on a switch, a folder or a re-arm; the migration GUC
--     (automation.migrating = 'on', set by automation_migrate_row only) keeps version, armed_at, enabled, audience and
--     updated_at; otherwise: deleted → Draft (+ deleted_by); more guarded types while Published → Draft; a new shape →
--     version + 1 (on an upgraded row, re-entry legacy_always, also any trigger change: phase 4's rule); armed_at =
--     now() when switched on, on a new version or a new arm key while Published (null when off); switched_on_at = now()
--     only when switched on or on a new version (a re-arm keeps it: what waits goes on);
--     updated_at moves only when something a person changes changed (never on the engine's counters).
--
-- Check before (read-only):
--   select to_regprocedure('public.automations_guard()') is not null, to_regclass('public.automation_versions') is not null,
--          to_regprocedure('public.automation_save(text, uuid, integer, text, jsonb, jsonb, jsonb, text, text, text, boolean, jsonb, uuid, text)') is null;   -- true, true, true
--   select tgname from pg_trigger where tgrelid = 'public.automations'::regclass and not tgisinternal order by 1;
--     -- automations_a_v2_pin, automations_customer_off_guard, automations_guard
--   select count(*) as rows, count(*) filter (where definition is not null) as with_doc, count(*) filter (where enabled) as published,
--          count(*) filter (where deleted_at is not null) as deleted from public.automations;               -- with_doc = 0 before migrate
--   select pg_get_functiondef('public.automations_guard()'::regprocedure) ~ 'automation_steps_shape';    -- true (phase 4's guard)
--   select status, count(*) from public.automation_runs where status in ('waiting', 'running') group by 1;   -- note (unchanged after)
--   The live function answers step "migrate" with 403 for a manager (the API section is deployed): RUNBOOK §12.
-- ────────────────────────────────────────────────────────────────────────────────────────────────────────────
begin;
set local lock_timeout = '5s';
do $$
begin
  if to_regclass('public.automation_versions') is null or to_regclass('public.automation_enrollment_keys') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'automations' and column_name = 'definition')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'automation_state' and column_name = 'v2_migrated_at') then
    raise exception 'Part 2 · G2.4 needs Part 1 (definition, automation_versions, v2_migrated_at): run Part 1 first';
  end if;
  if to_regprocedure('public.automations_guard()') is null or to_regprocedure('public.automation_steps_shape(jsonb)') is null then
    raise exception 'Part 2 · G2.4 replaces phase 4''s automations_guard: it is not there (run settings-round2-phase4.sql first)';
  end if;
end $$;

-- 0. switched_on_at: the last switch-on or new version (the guard keeps it; null while off). The engine's "switched off
--    and on again since then" reads it instead of armed_at, which also moves on a re-arm (design §2.8: no cancel). A row
--    on before this has null until its next write (the guard then takes its armed_at, the moment it was switched on).
alter table public.automations add column if not exists switched_on_at timestamptz;

-- 1. The audience of each action type: the engine's registry (WF_ACTIONS), one line each. Unknown → null (= guarded).
create or replace function public.automation_action_audience(p_type text) returns text
language sql immutable set search_path = ''
as $$
  select case p_type
    when 'update_field' then 'internal'
    when 'add_tag' then 'internal'
    when 'remove_tag' then 'internal'
    when 'assign_user' then 'internal'
    when 'remove_assigned_user' then 'internal'
    when 'dnd' then 'internal'
    when 'add_note' then 'internal'
    when 'add_task' then 'team'
    when 'edit_conversation' then 'internal'
    when 'send_email' then 'customer'
    when 'send_sms' then 'customer'
    when 'internal_notification' then 'team'
    when 'send_review_request' then 'customer'
    when 'send_live_chat' then 'customer'
    when 'manual_call' then 'team'
    when 'manual_sms' then 'team'
    when 'internal_comment' then 'internal'
    when 'move_stage' then 'internal'
    when 'mark_lost' then 'internal'
    when 'send_invoice' then 'customer'
    when 'send_estimate' then 'customer'
    when 'webhook' then 'external'
    when 'update_custom_value' then 'internal'
    when 'math' then 'none'
    when 'ai_agent' then 'none'
    when 'ai_decision' then 'none'
    when 'ai_summarize' then 'none'
    else null end
$$;

-- 2. The guarded types of a doc (every node, also paused / unconnected; an unknown type or kind counts) and of a phase-4 row.
create or replace function public.automation_guarded_channels(def jsonb) returns text[]
language sql immutable set search_path = ''
as $$
  select coalesce(pg_catalog.array_agg(x.g order by x.g), '{}'::text[]) from (
    select distinct case
             when n.value ->> 'kind' = 'action' then
               case when coalesce(public.automation_action_audience(n.value ->> 'type'), 'customer') in ('customer', 'external') then coalesce(n.value ->> 'type', '') end
             when coalesce(n.value ->> 'kind', '') in ('if_else', 'wait', 'goal', 'split', 'goto', 'workflow') then null
             else coalesce(pg_catalog.nullif(n.value ->> 'type', ''), n.value ->> 'kind', '') end as g
      from pg_catalog.jsonb_each(case when pg_catalog.jsonb_typeof(def -> 'nodes') = 'object' then def -> 'nodes' else '{}'::jsonb end) as n) x
   where x.g is not null
$$;
create or replace function public.automation_guarded_channels_v1(steps jsonb) returns text[]
language sql immutable set search_path = ''
as $$
  select coalesce(pg_catalog.array_agg(x.g order by x.g), '{}'::text[]) from (
    select distinct case s ->> 'type' when 'email' then 'send_email' else 'send_sms' end as g
      from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(steps) = 'array' then steps else '[]'::jsonb end) as s
     where s ->> 'kind' = 'action' and s ->> 'type' in ('email', 'text')) x
$$;

-- 3. The shape key and the arm key (design §2.8; the engine's wfPorts / defShape / armKey).
create or replace function public.automation_node_ports(n jsonb) returns text[]
language sql immutable set search_path = ''
as $$
  select case n ->> 'kind'
    when 'if_else' then coalesce((select pg_catalog.array_agg(b.v ->> 'id' order by b.o) from pg_catalog.jsonb_array_elements(
                          case when pg_catalog.jsonb_typeof(n -> 'config' -> 'branches') = 'array' then n -> 'config' -> 'branches' else '[]'::jsonb end) with ordinality as b(v, o)), '{}'::text[]) || array['none']
    when 'split' then coalesce((select pg_catalog.array_agg(p.v ->> 'id' order by p.o) from pg_catalog.jsonb_array_elements(
                          case when pg_catalog.jsonb_typeof(n -> 'config' -> 'paths') = 'array' then n -> 'config' -> 'paths' else '[]'::jsonb end) with ordinality as p(v, o)), '{}'::text[])
    when 'goto' then '{}'::text[]
    when 'wait' then case when coalesce(n -> 'config' -> 'timeout', 'null'::jsonb) <> 'null'::jsonb and n ->> 'type' in ('reply', 'user_reply', 'conditions')
                          then array['next', 'timeout'] else array['next'] end
    when 'workflow' then case when n ->> 'type' = 'remove_from_workflow' and n -> 'config' ->> 'scope' in ('current', 'all') then '{}'::text[] else array['next'] end
    else array['next'] end
$$;
create or replace function public.automation_def_shape(def jsonb) returns jsonb
language sql immutable set search_path = ''
as $$
  select pg_catalog.jsonb_build_object('entry', coalesce(def -> 'entry', 'null'::jsonb), 'nodes', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(e.key, coalesce(e.value -> 'kind', 'null'::jsonb), coalesce(e.value -> 'type', 'null'::jsonb),
             coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(p.port, coalesce(e.value -> 'out' -> p.port, 'null'::jsonb)) order by p.o)
                         from pg_catalog.unnest(public.automation_node_ports(e.value)) with ordinality as p(port, o)), '[]'::jsonb),
             case when e.value ->> 'kind' = 'if_else' and pg_catalog.jsonb_typeof(e.value -> 'config' -> 'branches') = 'array'
                  then coalesce((select pg_catalog.jsonb_agg(coalesce(b.v -> 'id', 'null'::jsonb) order by b.o) from pg_catalog.jsonb_array_elements(e.value -> 'config' -> 'branches') with ordinality as b(v, o)), '[]'::jsonb)
                  else 'null'::jsonb end,
             case when e.value ->> 'kind' = 'split' and pg_catalog.jsonb_typeof(e.value -> 'config' -> 'paths') = 'array'
                  then coalesce((select pg_catalog.jsonb_agg(coalesce(p.v -> 'id', 'null'::jsonb) order by p.o) from pg_catalog.jsonb_array_elements(e.value -> 'config' -> 'paths') with ordinality as p(v, o)), '[]'::jsonb)
                  else 'null'::jsonb end,
             case when e.value ->> 'kind' = 'wait' then pg_catalog.to_jsonb(coalesce(e.value -> 'config' -> 'timeout', 'null'::jsonb) <> 'null'::jsonb) else 'null'::jsonb end,
             case when e.value ->> 'kind' = 'goto' then coalesce(e.value -> 'config' -> 'target', 'null'::jsonb) else 'null'::jsonb end,
             case when e.value ->> 'kind' = 'wait' and e.value ->> 'type' in ('date', 'scheduled') then coalesce(e.value -> 'config' -> 'gotoStep', 'null'::jsonb) else 'null'::jsonb end)
           order by e.key collate "C")
      from pg_catalog.jsonb_each(case when pg_catalog.jsonb_typeof(def -> 'nodes') = 'object' then def -> 'nodes' else '{}'::jsonb end) as e), '[]'::jsonb))
$$;
-- settings as the function stores them (normWfSettings: the app's roles can't write settings, Part 1's pin)
create or replace function public.automation_arm_key(def jsonb, settings jsonb) returns jsonb
language sql immutable set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'triggers', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', coalesce(t.v -> 'id', 'null'::jsonb), 'type', coalesce(t.v -> 'type', 'null'::jsonb),
                   'filters', coalesce(t.v -> 'filters', 'null'::jsonb),
                   'config', case when coalesce(t.v -> 'config', 'null'::jsonb) = 'null'::jsonb then '{}'::jsonb else t.v -> 'config' end,
                   'goto', coalesce(t.v -> 'goto', 'null'::jsonb), 'disabled', pg_catalog.to_jsonb(coalesce(t.v -> 'disabled', 'false'::jsonb) = 'true'::jsonb)) order by t.o)
                 from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(def -> 'triggers') = 'array' then def -> 'triggers' else '[]'::jsonb end) with ordinality as t(v, o)), '[]'::jsonb),
    'entry', coalesce(def -> 'entry', 'null'::jsonb),
    'reentry', pg_catalog.to_jsonb(case when settings ->> 'reentry' in ('off', 'after_exit', 'legacy_always') then settings ->> 'reentry' else 'off' end),
    'timezone', pg_catalog.to_jsonb(case when settings ->> 'timezone' = 'contact' then 'contact' else 'business' end),
    'window', case when settings -> 'window' -> 'on' = 'true'::jsonb then settings -> 'window' else '{"on":false}'::jsonb end)
$$;

-- 4. The guard v2 (replaces phase 4's automations_guard; the same trigger, before insert or update). The phase-4 rules
--    stay for a row without a doc (version on another trigger or step shape; the customer-channel switch-off).
create or replace function public.automations_guard() returns trigger
language plpgsql security invoker set search_path = ''
as $$
declare
  via_fn boolean := coalesce(pg_catalog.current_setting('automation.via', true), '') = 'fn';
  trusted boolean := via_fn or current_user::text not in ('authenticated', 'anon');
  migrating boolean := via_fn and coalesce(pg_catalog.current_setting('automation.migrating', true), '') = 'on';
  g_new text[]; g_old text[]; content boolean; shape_changed boolean; arm_changed boolean;
begin
  g_new := case when new.definition is not null then public.automation_guarded_channels(new.definition) else public.automation_guarded_channels_v1(new.steps) end;
  if auth.uid() is not null then new.updated_by := auth.uid(); end if;
  if tg_op = 'INSERT' then
    if auth.uid() is not null then new.created_by := auth.uid(); end if;
    new.created_at := now();
    new.updated_at := now();
    new.version := 1;
    new.revision := 1;
    new.enrolled_total := 0;
    new.enabled := false;                -- always a Draft: switching on is a Publish (the function, with its checks)
    new.armed_at := null;
    new.switched_on_at := null;
    new.published_at := null;
    new.published_by := null;
    if not via_fn and new.origin not in ('user', 'copy') then new.origin := 'user'; end if;
    new.audience := case when pg_catalog.cardinality(g_new) > 0 then 'customer' else 'team' end;
    return new;
  end if;
  if new.business_id is distinct from old.business_id then raise exception 'business_id cannot change'; end if;
  if old.definition is not null and (new.trigger is distinct from old.trigger or new.steps is distinct from old.steps) then
    raise exception 'This workflow was upgraded: reload the app';
  end if;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  if not trusted then
    new.origin := old.origin; new.published_at := old.published_at; new.published_by := old.published_by;
    new.enrolled_total := old.enrolled_total; new.system_key := old.system_key; new.system_handover_at := old.system_handover_at;
  end if;
  content := (new.name, new.definition, new.settings, new.layout, new.builder) is distinct from (old.name, old.definition, old.settings, old.layout, old.builder);
  new.revision := old.revision + case when content then 1 else 0 end;
  if migrating then
    new.version := old.version; new.armed_at := old.armed_at; new.enabled := old.enabled; new.audience := old.audience; new.updated_at := old.updated_at;
    new.switched_on_at := old.switched_on_at;
    return new;
  end if;
  if old.deleted_at is null and new.deleted_at is not null then new.enabled := false; new.deleted_by := auth.uid(); end if;
  g_old := case when old.definition is not null then public.automation_guarded_channels(old.definition) else public.automation_guarded_channels_v1(old.steps) end;
  if new.enabled and not (g_new <@ g_old) then new.enabled := false; end if;
  if new.definition is not null or old.definition is not null then
    -- a new shape; on an upgraded workflow (re-entry legacy_always: it runs as phase 4) also any trigger change, as
    -- phase 4's guard made a new version then (what waited stops, "automation changed"; the engine's versionChanged)
    shape_changed := public.automation_def_shape(new.definition) is distinct from public.automation_def_shape(old.definition)
                     or (old.definition is not null and new.definition is not null and old.settings ->> 'reentry' = 'legacy_always'
                         and (public.automation_arm_key(new.definition, new.settings) -> 'triggers')
                             is distinct from (public.automation_arm_key(old.definition, old.settings) -> 'triggers'));
    arm_changed := public.automation_arm_key(new.definition, new.settings) is distinct from public.automation_arm_key(old.definition, old.settings);
  else
    shape_changed := new.trigger is distinct from old.trigger
                     or public.automation_steps_shape(new.steps) is distinct from public.automation_steps_shape(old.steps);
    arm_changed := false;
  end if;
  new.version := old.version + case when shape_changed then 1 else 0 end;
  -- armed_at = the enrolment gate (moves on a switch-on, a new version and a re-arm); switched_on_at = the last
  -- switch-on or new version only (the engine's "switched off and on again since then": a re-arm never stops a run)
  if not new.enabled then new.armed_at := null; new.switched_on_at := null;
  elsif not old.enabled or shape_changed then new.armed_at := now(); new.switched_on_at := now();
  elsif arm_changed then new.armed_at := now(); new.switched_on_at := coalesce(old.switched_on_at, old.armed_at);
  else new.armed_at := old.armed_at; new.switched_on_at := coalesce(old.switched_on_at, old.armed_at); end if;
  new.audience := case when pg_catalog.cardinality(g_new) > 0 then 'customer' else 'team' end;
  new.updated_at := case when content or (new.enabled, new.deleted_at, new.trigger, new.steps, new.description, new.folder_id, new.template_key)
                                         is distinct from (old.enabled, old.deleted_at, old.trigger, old.steps, old.description, old.folder_id, old.template_key)
                         then now() else old.updated_at end;
  return new;
end $$;
revoke all on function public.automations_guard() from public, anon, authenticated;
-- the v2 guard switches a workflow off when it gets a new customer channel, for both kinds of row
drop trigger if exists automations_customer_off_guard on public.automations;

-- 5. What waits stops at once on a new version, a switch-off or a delete (design §2.9 Part 2.3). Running runs are caught
--    by the executor's own check (staleV2). The words are phase 4's, the codes the design's.
create or replace function public.automations_after() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare why text; words text;
begin
  if new.version is distinct from old.version then why := 'automation_changed'; words := 'automation changed';
  elsif old.deleted_at is null and new.deleted_at is not null then why := 'deleted'; words := 'automation deleted';   -- (a delete also switches it off)
  elsif old.enabled and not new.enabled then why := 'switched_off'; words := 'switched off';
  else return null; end if;
  with c as (
    update public.automation_runs r set status = 'cancelled', exit_reason = why, reason = words, active_lock = null, lease_until = null,
           finished_at = now(), updated_at = now()
     where r.automation_id = new.id and r.status = 'waiting'
    returning r.id, r.business_id, r.cursor_step, r.record_kind, r.record_id, r.contact_id, r.trigger_id, r.automation_version, r.revision,
              r.steps_done, r."loop", r.enrollment_key
  ), l as (
    insert into public.automation_log (business_id, run_id, step_id, row_kind, status, reason, automation_id, automation_name, record_kind, record_id,
                                       contact_id, trigger_id, version, revision, seq, "loop", detail, at)
    select c.business_id, c.id, coalesce(c.cursor_step, 'end'), 'exit', 'removed', words, new.id, new.name, c.record_kind, c.record_id,
           c.contact_id, c.trigger_id, c.automation_version, c.revision, coalesce(c.steps_done, 0), coalesce(c."loop", 0),
           pg_catalog.jsonb_build_object('exit_reason', why), now()
      from c
    returning 1
  )
  delete from public.automation_enrollment_keys k
   where k.automation_id = new.id and k.enrollment_key in (select c.enrollment_key from c where c.enrollment_key is not null)
     and not exists (select 1 from public.automation_runs r where r.automation_id = new.id and r.enrollment_key = k.enrollment_key
                       and r.id not in (select c.id from c));
  return null;
end $$;
revoke all on function public.automations_after() from public, anon, authenticated;
drop trigger if exists automations_after on public.automations;
create trigger automations_after after update on public.automations for each row execute function public.automations_after();

-- 6. The function's content writes (service role only). Each sets automation.via = 'fn' for its own transaction.
-- save: a new Draft (p_id null) or the row at p_expected revision (else 'conflict' with who saved); p_draft = switch to
-- Draft (an AI edit). → {ok, id, revision, version, enabled, armed_at, created, shape_changed, arm_changed}
create or replace function public.automation_save(p_business text, p_id uuid, p_expected integer, p_name text, p_definition jsonb, p_settings jsonb,
  p_layout jsonb, p_builder text, p_origin text, p_reason text, p_draft boolean, p_summary jsonb, p_actor uuid, p_actor_name text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare r public.automations%rowtype; o public.automations%rowtype;
begin
  perform pg_catalog.set_config('automation.via', 'fn', true);
  perform pg_catalog.set_config('automation.reason', coalesce(p_reason, 'save'), true);
  if p_definition is null or pg_catalog.jsonb_typeof(p_definition) <> 'object' or p_definition ->> 'schema' is distinct from '2' then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'definition must be a workflow (schema 2)');
  end if;
  if p_id is null then
    insert into public.automations (business_id, name, enabled, trigger, steps, definition, settings, layout, builder, origin, list_summary,
                                    created_by, created_by_name, updated_by, updated_by_name)
    values (p_business, p_name, false, '{}'::jsonb, '[]'::jsonb, p_definition, coalesce(p_settings, '{}'::jsonb), coalesce(p_layout, '{"v":1}'::jsonb),
            coalesce(p_builder, 'standard'), case when p_origin in ('user', 'copy', 'template', 'ai') then p_origin else 'user' end,
            coalesce(p_summary, '{}'::jsonb), p_actor, p_actor_name, p_actor, p_actor_name)
    returning * into r;
    return pg_catalog.jsonb_build_object('ok', true, 'id', r.id, 'revision', r.revision, 'version', r.version, 'enabled', r.enabled, 'armed_at', r.armed_at,
                                         'created', true, 'shape_changed', false, 'arm_changed', false);
  end if;
  select * into o from public.automations a where a.id = p_id and a.business_id = p_business and a.deleted_at is null for update;
  if not found then return pg_catalog.jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if o.revision is distinct from p_expected then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'conflict', 'revision', o.revision, 'updated_by_name', o.updated_by_name, 'updated_at', o.updated_at);
  end if;
  update public.automations a set name = p_name, definition = p_definition, settings = coalesce(p_settings, '{}'::jsonb), layout = coalesce(p_layout, a.layout),
         builder = coalesce(p_builder, a.builder), list_summary = coalesce(p_summary, a.list_summary), updated_by = p_actor, updated_by_name = p_actor_name,
         enabled = case when coalesce(p_draft, false) then false else a.enabled end
   where a.id = p_id
  returning * into r;
  return pg_catalog.jsonb_build_object('ok', true, 'id', r.id, 'revision', r.revision, 'version', r.version, 'enabled', r.enabled, 'armed_at', r.armed_at,
    'created', false, 'shape_changed', r.version <> o.version,
    'arm_changed', public.automation_arm_key(r.definition, r.settings) is distinct from public.automation_arm_key(o.definition, o.settings));
end $$;
-- publish: on (published_at / _by) or off. Never touches the content (revision unchanged). p_expected = the revision the
-- function checked (a save in between → 'conflict', nothing changes); null = any (a switch-off).
drop function if exists public.automation_publish(text, uuid, boolean, uuid, text);
create or replace function public.automation_publish(p_business text, p_id uuid, p_on boolean, p_expected integer, p_actor uuid, p_actor_name text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare r public.automations%rowtype; o public.automations%rowtype;
begin
  perform pg_catalog.set_config('automation.via', 'fn', true);
  perform pg_catalog.set_config('automation.reason', case when p_on then 'publish' else 'unpublish' end, true);
  select * into o from public.automations a where a.id = p_id and a.business_id = p_business and a.deleted_at is null for update;
  if not found then return pg_catalog.jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if p_expected is not null and o.revision is distinct from p_expected then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'conflict', 'revision', o.revision, 'updated_by_name', o.updated_by_name, 'updated_at', o.updated_at);
  end if;
  update public.automations a set enabled = coalesce(p_on, false),
         published_at = case when p_on then now() else a.published_at end, published_by = case when p_on then p_actor else a.published_by end,
         updated_by = p_actor, updated_by_name = p_actor_name
   where a.id = p_id
  returning * into r;
  return pg_catalog.jsonb_build_object('ok', true, 'enabled', r.enabled, 'armed_at', r.armed_at, 'revision', r.revision, 'version', r.version,
                                       'published_at', r.published_at);
end $$;
-- migrate one row (design §3.16): only a row without a doc whose trigger / steps are still the ones the doc was made
-- from (p_trigger / p_steps: compare-and-set, an old app tab's write in between is never replaced); version, armed_at,
-- enabled, audience and updated_at kept (the migration GUC), revision + 1. → {migrated, revision, version, enabled}
drop function if exists public.automation_migrate_row(text, uuid, jsonb, jsonb, jsonb);
create or replace function public.automation_migrate_row(p_business text, p_id uuid, p_trigger jsonb, p_steps jsonb, p_definition jsonb, p_settings jsonb, p_summary jsonb)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare r record; got boolean;
begin
  if p_definition is null or pg_catalog.jsonb_typeof(p_definition) <> 'object' or p_definition ->> 'schema' is distinct from '2' then
    return pg_catalog.jsonb_build_object('migrated', false, 'reason', 'definition must be a workflow (schema 2)');
  end if;
  perform pg_catalog.set_config('automation.via', 'fn', true);
  perform pg_catalog.set_config('automation.reason', 'migration', true);
  perform pg_catalog.set_config('automation.migrating', 'on', true);
  update public.automations a set definition = p_definition, settings = coalesce(p_settings, '{}'::jsonb), list_summary = coalesce(p_summary, a.list_summary)
   where a.id = p_id and a.business_id = p_business and a.definition is null
     and a.trigger is not distinct from p_trigger and a.steps is not distinct from p_steps
  returning a.revision, a.version, a.enabled into r;
  got := found;
  perform pg_catalog.set_config('automation.migrating', 'off', true);
  if not got then return pg_catalog.jsonb_build_object('migrated', false); end if;
  return pg_catalog.jsonb_build_object('migrated', true, 'revision', r.revision, 'version', r.version, 'enabled', r.enabled);
end $$;
revoke all on function public.automation_save(text, uuid, integer, text, jsonb, jsonb, jsonb, text, text, text, boolean, jsonb, uuid, text) from public, anon, authenticated;
revoke all on function public.automation_publish(text, uuid, boolean, integer, uuid, text) from public, anon, authenticated;
revoke all on function public.automation_migrate_row(text, uuid, jsonb, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.automation_save(text, uuid, integer, text, jsonb, jsonb, jsonb, text, text, text, boolean, jsonb, uuid, text) to service_role;
grant execute on function public.automation_publish(text, uuid, boolean, integer, uuid, text) to service_role;
grant execute on function public.automation_migrate_row(text, uuid, jsonb, jsonb, jsonb, jsonb, jsonb) to service_role;

-- 7. Needs review = failed runs since the acknowledgement OR the problem codes the daily sweep keeps (list_summary.review:
--    an action that became unavailable, a list value or template that is gone). One more column: the codes.
drop function if exists public.automation_needs_review();
create function public.automation_needs_review()
returns table (automation_id uuid, failed_runs bigint, last_failed_at timestamptz, problems jsonb) language sql stable security invoker set search_path = ''
as $$
  with f as (
    select l.automation_id, count(distinct l.run_id)::bigint as n, max(l.at) as last_at
      from public.automation_log l left join public.automation_reviews v on v.automation_id = l.automation_id
     where l.business_id = public.current_business_id() and l.automation_id is not null and l.status = 'failed'
       and l.at >= now() - interval '30 days' and (v.acked_until is null or l.at > v.acked_until)
     group by l.automation_id
  ), p as (
    select a.id as automation_id, a.list_summary -> 'review' -> 'codes' as codes
      from public.automations a left join public.automation_reviews v on v.automation_id = a.id
     where a.business_id = public.current_business_id() and a.deleted_at is null
       and pg_catalog.jsonb_typeof(a.list_summary -> 'review' -> 'codes') = 'array' and pg_catalog.jsonb_array_length(a.list_summary -> 'review' -> 'codes') > 0
       and (v.acked_until is null or (a.list_summary -> 'review' ->> 'at')::timestamptz > v.acked_until)
  )
  select coalesce(f.automation_id, p.automation_id), coalesce(f.n, 0), f.last_at, coalesce(p.codes, '[]'::jsonb)
    from f full join p on p.automation_id = f.automation_id
$$;
revoke all on function public.automation_needs_review() from public, anon;
grant execute on function public.automation_needs_review() to authenticated, service_role;

revoke all on function public.automation_action_audience(text) from public, anon;
revoke all on function public.automation_guarded_channels(jsonb) from public, anon;
revoke all on function public.automation_guarded_channels_v1(jsonb) from public, anon;
revoke all on function public.automation_node_ports(jsonb) from public, anon;
revoke all on function public.automation_def_shape(jsonb) from public, anon;
revoke all on function public.automation_arm_key(jsonb, jsonb) from public, anon;
grant execute on function public.automation_action_audience(text) to authenticated, service_role;
grant execute on function public.automation_guarded_channels(jsonb) to authenticated, service_role;
grant execute on function public.automation_guarded_channels_v1(jsonb) to authenticated, service_role;
grant execute on function public.automation_node_ports(jsonb) to authenticated, service_role;
grant execute on function public.automation_def_shape(jsonb) to authenticated, service_role;
grant execute on function public.automation_arm_key(jsonb, jsonb) to authenticated, service_role;
commit;
-- Check after (read-only):
--   select tgname from pg_trigger where tgrelid = 'public.automations'::regclass and not tgisinternal order by 1;
--     -- automations_a_v2_pin, automations_after, automations_guard   (automations_customer_off_guard gone)
--   select public.automation_guarded_channels('{"nodes":{"a":{"kind":"action","type":"send_email"},"b":{"kind":"action","type":"webhook","disabled":true},
--          "c":{"kind":"action","type":"internal_notification"},"d":{"kind":"teleport"},"e":{"kind":"wait","type":"period"}}}'::jsonb);
--     -- {send_email,teleport,webhook}
--   select public.automation_guarded_channels_v1('[{"kind":"action","type":"text"},{"kind":"action","type":"push"}]'::jsonb);   -- {send_sms}
--   select count(*) as rows, count(*) filter (where definition is not null) as with_doc, count(*) filter (where enabled) as published from public.automations;
--     -- the same counts as before (nothing migrated yet: the function's step "migrate" does it, RUNBOOK §12)
--   select status, count(*) from public.automation_runs where status in ('waiting', 'running') group by 1;   -- unchanged
--   then the staging checks PASS 19–21 (.claude/sql/stage2-part1-staging-checks.sql), on staging, before this goes live.
--
-- After step "migrate" (RUNBOOK §12, design §8.3 #4), read-only:
--   select count(*) filter (where definition is null) as left, count(*) as rows from public.automations;      -- left = 0
--   select a.name, a.version, a.enabled, a.armed_at, a.audience, a.revision from public.automations a order by a.name;   -- = the backup, revision + 1
--   select reason, count(*) from public.automation_versions group by 1;                                       -- migration = rows
--   select key, origin from public.automation_templates order by key;                                         -- the 5 ready-made templates, system
--   select v2_migrated_at from public.automation_state;                                                        -- set
--
-- ROLLBACK (G2.4 only; run by hand, staging first). The ORDER matters (a save through the adapter writes only the
-- doc: the row's trigger / steps still hold the words from before the migration, and an older build that reads
-- trigger / steps — the rollback build R-A always — would run those stale steps):
--   1. With THIS build still deployed, part (a) alone: the rows created or edited in stage 2 are switched off (this build
--      stops their waiting runs at once, "switched off"), so no older build ever runs the old words of a workflow
--      someone changed since the migration (design §3.16, Appendix A E17/E39). The list is printed first: keep it (they
--      are switched on again by hand after checking each one's phase-4 steps). Nobody switches anything on until step 3.
--   2. The function back to the G2.3 build (or the rollback build, RUNBOOK §7 R-A) and the app back to the commit
--      before the adapter (its old editor writes trigger / steps directly again).
--   3. Then, in ONE transaction, (b) phase 4's guard and its customer switch-off trigger come back exactly as
--      settings-round2-phase4.sql wrote them; (c) Part 1's automation_needs_review; (d) the G2.4 functions go.
-- The docs stay in `definition` and switched_on_at stays (Part 1's rollback drops definition, if ever needed); the
-- phase-4 engine reads trigger / steps only. A plain function rollback (R-A) WITHOUT step 1 is unsafe once any row was
-- saved after v2_migrated_at (the list below is not empty).
--
-- The rows step 1 switches off (read-only; run it first and keep the output):
-- select a.id, a.name, a.enabled, a.revision, m.rev as migrated_revision, a.updated_at, s.v2_migrated_at,
--        (a.trigger = '{}'::jsonb) as made_in_stage2
--   from public.automations a
--   cross join (select z.v2_migrated_at from public.automation_state z where z.business_id = public.current_business_id()) s
--   left join lateral (select max(v.revision) as rev from public.automation_versions v where v.automation_id = a.id and v.reason = 'migration') m on true
--  where a.business_id = public.current_business_id() and a.definition is not null and a.deleted_at is null
--    and (a.trigger = '{}'::jsonb or m.rev is null or a.revision > m.rev or s.v2_migrated_at is null or a.updated_at > s.v2_migrated_at)
--  order by a.name;
-- Step 1 (this build still deployed):
-- begin;
-- set local lock_timeout = '5s';
-- update public.automations a set enabled = false
--   from (select z.v2_migrated_at from public.automation_state z where z.business_id = public.current_business_id()) s
--  where a.business_id = public.current_business_id() and a.definition is not null and a.deleted_at is null and a.enabled
--    and (a.trigger = '{}'::jsonb or s.v2_migrated_at is null or a.updated_at > s.v2_migrated_at
--         or a.revision > coalesce((select max(v.revision) from public.automation_versions v where v.automation_id = a.id and v.reason = 'migration'), -1));
-- commit;
-- Check: the list query again with "and a.enabled" → no rows; their waiting runs ended (exit_reason 'switched_off').
-- Step 2: the function and the app (above). Step 3:
-- begin;
-- set local lock_timeout = '5s';
-- create or replace function public.automations_guard() returns trigger
-- language plpgsql security invoker set search_path = ''
-- as $$
-- declare customer boolean;
-- begin
--   customer := exists (select 1 from pg_catalog.jsonb_array_elements(new.steps) s
--                        where s->>'kind' = 'action' and s->>'type' in ('email', 'text'));
--   new.audience := case when customer then 'customer' else 'team' end;
--   new.updated_at := now();
--   if auth.uid() is not null then new.updated_by := auth.uid(); end if;
--   if tg_op = 'INSERT' then
--     if auth.uid() is not null then new.created_by := auth.uid(); end if;
--     new.created_at := now();
--     new.version := 1;
--     if customer then new.enabled := false; end if;
--     new.armed_at := case when new.enabled then now() else null end;
--   else
--     if new.business_id is distinct from old.business_id then raise exception 'business_id cannot change'; end if;
--     new.created_by := old.created_by;
--     new.created_at := old.created_at;
--     new.version := case when new.trigger is distinct from old.trigger
--                           or public.automation_steps_shape(new.steps) is distinct from public.automation_steps_shape(old.steps)
--                         then old.version + 1 else old.version end;
--     if new.enabled and (not old.enabled or new.version <> old.version) then new.armed_at := now();
--     elsif not new.enabled then new.armed_at := null;
--     else new.armed_at := old.armed_at; end if;
--   end if;
--   return new;
-- end $$;
-- revoke all on function public.automations_guard() from public, anon, authenticated;
-- drop trigger if exists automations_customer_off_guard on public.automations;
-- create trigger automations_customer_off_guard before update on public.automations
--   for each row execute function public.automations_customer_off_guard();
-- drop trigger if exists automations_after on public.automations;
-- drop function if exists public.automations_after();
-- drop function if exists public.automation_needs_review();
-- create or replace function public.automation_needs_review()
-- returns table (automation_id uuid, failed_runs bigint, last_failed_at timestamptz) language sql stable security invoker set search_path = ''
-- as $$
--   select l.automation_id, count(distinct l.run_id)::bigint, max(l.at)
--     from public.automation_log l left join public.automation_reviews v on v.automation_id = l.automation_id
--    where l.business_id = public.current_business_id() and l.automation_id is not null and l.status = 'failed'
--      and l.at >= now() - interval '30 days' and (v.acked_until is null or l.at > v.acked_until)
--    group by l.automation_id
-- $$;
-- revoke all on function public.automation_needs_review() from public, anon;
-- grant execute on function public.automation_needs_review() to authenticated, service_role;
-- drop function if exists public.automation_save(text, uuid, integer, text, jsonb, jsonb, jsonb, text, text, text, boolean, jsonb, uuid, text);
-- drop function if exists public.automation_publish(text, uuid, boolean, integer, uuid, text);
-- drop function if exists public.automation_migrate_row(text, uuid, jsonb, jsonb, jsonb, jsonb, jsonb);
-- drop function if exists public.automation_arm_key(jsonb, jsonb);
-- drop function if exists public.automation_def_shape(jsonb);
-- drop function if exists public.automation_node_ports(jsonb);
-- drop function if exists public.automation_guarded_channels_v1(jsonb);
-- drop function if exists public.automation_guarded_channels(jsonb);
-- drop function if exists public.automation_action_audience(text);
-- commit;
-- Check after the rollback: select pg_get_functiondef('public.automations_guard()'::regprocedure) ~ 'automation_steps_shape'
--   and to_regprocedure('public.automation_save(text, uuid, integer, text, jsonb, jsonb, jsonb, text, text, text, boolean, jsonb, uuid, text)') is null;   -- true
--   select tgname from pg_trigger where tgrelid = 'public.automations'::regclass and not tgisinternal order by 1;
--     -- automations_a_v2_pin, automations_customer_off_guard, automations_guard
-- ────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- END PART 2 · G2.4


-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — lock direct writes on public.automations (table revoke + column grants). Written in phase 3. Nothing to run yet.
-- (Part 1's automations_a_v2_pin keeps the app's roles away from definition & co. until then; Part 3 decides whether the
-- column grants replace it.)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
