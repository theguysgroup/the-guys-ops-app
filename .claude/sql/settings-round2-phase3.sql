-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Settings round 2, PHASE 3 (Data/backup + Face ID). SHARED FILE: each group of phase 3 writes ONE clearly delimited,
-- self-contained section below (its own begin/commit, its own read-only checks and its own commented ROLLBACK block).
-- Run each section on its own in the Supabase SQL editor (project dszlllazwmllmoklzjwl), in the order the build notes give.
-- Nothing in this file has been run by the builder: the owner runs it.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════


-- ===================================================================================================
-- G-faceid (settings round 2, phase 3; plan item 6, P4, M6 answers 3-5): server-checked Face ID /
-- fingerprint (passkeys) and the 30-minute Security "step-up".
-- Run in the Supabase SQL editor (project dszlllazwmllmoklzjwl) BEFORE deploying the passkey function and
-- BEFORE uploading the app. Safe to run twice (idempotent). Rollback block at the end (commented).
--
-- What it does:
--   passkeys            each person's Face ID / fingerprint keys (one row per device). Written ONLY by the passkey
--                       function (service role). A person sees their own; removes their own only while Security is
--                       unlocked.
--   step_up             "Security is unlocked" for ONE sign-in session until a time (30 minutes). Written ONLY by
--                       the passkey function after a passkey, password (+code) or fresh Google check.
--   passkey_challenges  one-time WebAuthn challenges (5 minutes). Function only.
--   step_up_fails       wrong-password counter (5 tries per 15 minutes). Function only. Each try is counted in ONE
--                       step (step_up_fail_reserve) BEFORE the password is checked, so tries sent at the same time
--                       can't get past the limit; step_up_fail_release gives a try back (right password, code to come).
--   has_step_up()       true when THIS session (JWT session_id) is unlocked now.
--   activity_log        Settings history rows (record_kind 'settings') are readable only while unlocked
--                       (an extra RESTRICTIVE rule; the existing read rules are left exactly as they are).
--                       Writing a history row (insert) is unchanged, so every settings change is still logged.
--   settings trigger    a change to settings.catalog.security from the app without an unlocked session is
--                       ignored (the old value is kept), so every other settings save keeps working.
--
-- Read-only checks you can run first (optional):
--   select data_type from information_schema.columns where table_schema='public' and table_name='settings' and column_name='catalog';  -- expect jsonb
--   select policyname, permissive, cmd from pg_policies where schemaname='public' and tablename='activity_log';
-- ===================================================================================================
begin;

create table if not exists public.passkeys (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  credential_id text not null unique,                 -- base64url, as the browser reports it
  public_key    text not null,                        -- base64url COSE public key (public, not a secret)
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  device_name   text not null default '',
  device_kind   text not null default '',             -- 'Face ID' | 'Fingerprint' | 'Windows Hello'
  device_type   text,                                 -- 'singleDevice' | 'multiDevice'
  backed_up     boolean not null default false,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index if not exists passkeys_user_id_idx on public.passkeys (user_id);
alter table public.passkeys enable row level security;
revoke all on public.passkeys from anon;
revoke insert, update on public.passkeys from authenticated;
grant select, delete on public.passkeys to authenticated;

create table if not exists public.step_up (
  user_id    uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null,
  until      timestamptz not null,
  method     text not null check (method in ('passkey', 'password', 'password+code', 'google')),
  created_at timestamptz not null default now(),
  primary key (user_id, session_id)
);
alter table public.step_up enable row level security;
revoke all on public.step_up from anon;
revoke insert, update, delete on public.step_up from authenticated;
grant select on public.step_up to authenticated;

create table if not exists public.passkey_challenges (
  user_id    uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null,
  kind       text not null check (kind in ('reg', 'auth')),
  challenge  text not null,
  expires_at timestamptz not null,
  primary key (user_id, session_id, kind)
);
alter table public.passkey_challenges enable row level security;
revoke all on public.passkey_challenges from anon, authenticated;

create table if not exists public.step_up_fails (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  n        integer not null default 0,
  first_at timestamptz not null default now()
);
alter table public.step_up_fails enable row level security;
revoke all on public.step_up_fails from anon, authenticated;

-- One try, counted atomically: the count in the window after it (a window older than p_window_minutes starts again at 1).
-- In "on conflict do update", f.* is the row as it was, so both lines read the same old values.
create or replace function public.step_up_fail_reserve(p_user uuid, p_window_minutes integer) returns integer
language sql volatile security definer set search_path = '' as $$
  insert into public.step_up_fails as f (user_id, n, first_at) values (p_user, 1, now())
  on conflict (user_id) do update set
    n        = case when f.first_at < now() - make_interval(mins => p_window_minutes) then 1 else f.n + 1 end,
    first_at = case when f.first_at < now() - make_interval(mins => p_window_minutes) then now() else f.first_at end
  returning n;
$$;
-- Gives one try back; the row goes when nothing is left.
create or replace function public.step_up_fail_release(p_user uuid) returns void
language sql volatile security definer set search_path = '' as $$
  with gone as (delete from public.step_up_fails where user_id = p_user and n <= 1 returning 1)
  update public.step_up_fails set n = n - 1 where user_id = p_user and n > 1;
$$;
revoke all on function public.step_up_fail_reserve(uuid, integer) from public, anon, authenticated;
revoke all on function public.step_up_fail_release(uuid) from public, anon, authenticated;
grant execute on function public.step_up_fail_reserve(uuid, integer) to service_role;
grant execute on function public.step_up_fail_release(uuid) to service_role;

-- Is THIS sign-in session unlocked right now? (bound to the JWT's session_id, so unlocking on the laptop never
-- unlocks the phone)
create or replace function public.has_step_up() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.step_up s
    where s.user_id = auth.uid()
      and s.session_id::text = coalesce(auth.jwt() ->> 'session_id', '')
      and s.until > now()
  );
$$;
revoke all on function public.has_step_up() from public, anon;
grant execute on function public.has_step_up() to authenticated, service_role;

drop policy if exists "passkeys: own rows" on public.passkeys;
create policy "passkeys: own rows" on public.passkeys
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "passkeys: remove own while Security is unlocked" on public.passkeys;
create policy "passkeys: remove own while Security is unlocked" on public.passkeys
  for delete to authenticated using (user_id = auth.uid() and (select public.has_step_up()));

drop policy if exists "step_up: own rows" on public.step_up;
create policy "step_up: own rows" on public.step_up
  for select to authenticated using (user_id = auth.uid());

-- Settings history needs Security unlocked. RESTRICTIVE = added on top of the existing read rules (AND),
-- whatever their names are; every other kind of history row is unaffected. Service role (functions, crons) bypasses RLS.
drop policy if exists "activity_log: settings history needs Security unlocked" on public.activity_log;
create policy "activity_log: settings history needs Security unlocked" on public.activity_log
  as restrictive for select to authenticated
  using (record_kind <> 'settings' or (select public.has_step_up()));

-- The security part of the settings (catalog.security) changes only from an unlocked session. Runs as the caller
-- (security invoker), so current_user is 'authenticated' for the app and 'service_role'/'postgres' for functions and SQL.
create or replace function public.settings_security_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if (new.catalog -> 'security') is distinct from (old.catalog -> 'security') and not public.has_step_up() then
    if old.catalog ? 'security' then
      new.catalog := jsonb_set(coalesce(new.catalog, '{}'::jsonb), '{security}', old.catalog -> 'security', true);
    else
      new.catalog := coalesce(new.catalog, '{}'::jsonb) - 'security';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists settings_security_guard on public.settings;
create trigger settings_security_guard
  before update on public.settings
  for each row execute function public.settings_security_guard();

commit;
select 'G-faceid ok';

-- ===== ROLLBACK (G-faceid) — run only to undo this section. Removing the tables deletes every registered
-- Face ID / fingerprint key (each device would need setting up again).
-- begin;
-- drop policy if exists "activity_log: settings history needs Security unlocked" on public.activity_log;
-- drop trigger if exists settings_security_guard on public.settings;
-- drop function if exists public.settings_security_guard();
-- drop policy if exists "passkeys: remove own while Security is unlocked" on public.passkeys;
-- drop policy if exists "passkeys: own rows" on public.passkeys;
-- drop policy if exists "step_up: own rows" on public.step_up;
-- drop function if exists public.has_step_up();
-- drop function if exists public.step_up_fail_release(uuid);
-- drop function if exists public.step_up_fail_reserve(uuid, integer);
-- drop table if exists public.step_up_fails;
-- drop table if exists public.passkey_challenges;
-- drop table if exists public.step_up;
-- drop table if exists public.passkeys;
-- commit;
-- ===================================================================================================
-- END G-faceid
-- ===================================================================================================


-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Group F-backup: weekly automatic encrypted backup (settings round 2, phase 3; Ofek 13–14 Oct: P5 + M6 answer 2)
-- Run AFTER the G-faceid section (the backup function reads public.step_up for "Download full backup" and for a new
-- weekly address), BEFORE deploying the backup function. Safe to run again (idempotent).
-- NO secret is written here: the timer reads its secret from Supabase Vault (the owner adds it, see the owner steps), and
-- BACKUP_PASSWORD is an Edge Function secret that only the owner sets.
-- Check before:  select to_regclass('public.backup_runs'), (select count(*) from storage.buckets where id = 'backups'),
--                       (select count(*) from cron.job where jobname = 'backup-weekly-check');
-- And (read-only) the storage rules there are today. Any line whose qual / with_check does NOT name a bucket_id applies
-- to every bucket; the rule "backups: no direct access" below shuts those out of 'backups' whatever they say:
--   select policyname, permissive, roles, cmd, qual, with_check from pg_policies where schemaname = 'storage' and tablename = 'objects';
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
begin;

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 1. A PRIVATE bucket for the locked backups. Only the backup function (service role, which skips these rules) reads and
--    writes it, and people get time-limited download links. 50 MB = the free plan's cap.
insert into storage.buckets (id, name, public, file_size_limit)
values ('backups', 'backups', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;
--    An explicit "no": a RESTRICTIVE rule is ANDed with every other storage rule, so even a rule that names no bucket
--    (e.g. "signed-in people may read") never reaches 'backups' (listing, download, upload, overwrite or delete).
--    Every other bucket is unaffected (bucket_id <> 'backups' is true for them).
drop policy if exists "backups: no direct access" on storage.objects;
create policy "backups: no direct access" on storage.objects
  as restrictive for all to anon, authenticated
  using (bucket_id <> 'backups') with check (bucket_id <> 'backups');

-- 2. Where and when the weekly backup goes (one row). Owners can read it; only the backup function writes it, so a
--    new address needs Face ID / password, checked there. day: 0 = Sunday … 6 = Saturday, Sydney time.
create table if not exists public.backup_settings (
  id smallint primary key default 1 check (id = 1),
  email text not null default 'info@theguyservicegroup.com',
  send_day smallint not null default 0 check (send_day between 0 and 6),
  send_time text not null default '03:00' check (send_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into public.backup_settings (id) values (1) on conflict (id) do nothing;
alter table public.backup_settings enable row level security;
drop policy if exists "backup_settings: owners read" on public.backup_settings;
create policy "backup_settings: owners read" on public.backup_settings for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner'));

-- 3. Each backup: the weekly ones (one per Sydney slot, up to 3 attempts) and each "Download full backup".
--    email_body holds the 7-day download links: owners only.
create table if not exists public.backup_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('weekly', 'download')),
  slot timestamptz,
  attempt smallint not null default 1,
  status text not null check (status in ('running', 'done', 'failed', 'waiting_password', 'no_email')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  lease_until timestamptz,
  by_name text,
  progress jsonb not null default '{}'::jsonb,
  counts jsonb not null default '{}'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  files_total integer,
  files_bytes bigint,
  data_path text,
  data_bytes bigint,
  packs text[] not null default '{}',
  email_to text,
  email_status text check (email_status in ('queued', 'sent')),
  email_subject text,
  email_body text,
  email_queued_at timestamptz,
  email_sent_at timestamptz,
  links_expire_at timestamptz,
  error text,
  errors smallint not null default 0
);
create unique index if not exists backup_runs_slot_idx on public.backup_runs (slot, attempt) where kind = 'weekly';
create index if not exists backup_runs_started_idx on public.backup_runs (started_at desc);
create index if not exists backup_runs_email_idx on public.backup_runs (email_queued_at) where email_status = 'queued';
alter table public.backup_runs enable row level security;
drop policy if exists "backup_runs: owners read" on public.backup_runs;
create policy "backup_runs: owners read" on public.backup_runs for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner'));

-- 4. Which uploaded file is in which locked pack (files never change once uploaded, so each is packed once).
--    Function only: RLS on, no policies.
create table if not exists public.backup_files (
  bucket text not null,
  path text not null,
  size bigint not null,
  type text,
  pack text not null,
  pack_offset bigint not null,
  key_id text not null,
  packed_at timestamptz not null default now(),
  primary key (bucket, path)
);
create index if not exists backup_files_pack_idx on public.backup_files (pack);
alter table public.backup_files enable row level security;

-- 5. The function's own state (key salt and password check, when the password was first seen, last timer tick).
--    Function only: RLS on, no policies.
create table if not exists public.backup_state (
  id smallint primary key default 1 check (id = 1),
  salt text,
  verifier text,
  iterations integer,
  password_seen_at timestamptz,
  last_tick_at timestamptz
);
insert into public.backup_state (id) values (1) on conflict (id) do nothing;
alter table public.backup_state enable row level security;

-- The app (signed-in people) never writes these; only the function (service role) does.
revoke insert, update, delete on public.backup_settings, public.backup_runs from anon, authenticated;
revoke all on public.backup_files, public.backup_state from anon, authenticated;

-- 6. Every table in public with the columns to page by (the primary key, else every orderable column), so tables
--    added later are backed up too. The backup function (service role) only.
create or replace function public.backup_tables()
returns table (table_name text, order_cols text[])
language sql stable security definer set search_path = ''
as $$
  select c.relname::text,
    coalesce(
      (select array_agg(a.attname::text order by array_position(i.indkey::int2[], a.attnum))
         from pg_catalog.pg_index i
         join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = c.oid and i.indisprimary),
      (select array_agg(a.attname::text order by a.attnum)
         from pg_catalog.pg_attribute a
         join pg_catalog.pg_type t on t.oid = a.atttypid
        where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
          and t.typname not in ('json', 'xml', 'point', 'polygon', 'line', 'lseg', 'box', 'path', 'circle')),
      '{}'::text[])
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
  order by 1;
$$;
revoke all on function public.backup_tables() from public, anon, authenticated;
grant execute on function public.backup_tables() to service_role;

-- 7. Every uploaded file (all buckets except the backups themselves). Paged by the function with range().
create or replace function public.backup_objects()
returns table (bucket_id text, name text, size bigint, mimetype text, updated_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select o.bucket_id, o.name, coalesce((o.metadata->>'size')::bigint, 0), o.metadata->>'mimetype', o.updated_at
  from storage.objects o
  where o.bucket_id <> 'backups' and o.name is not null and o.name not like '%.emptyFolderPlaceholder'
  order by o.bucket_id, o.name;
$$;
revoke all on function public.backup_objects() from public, anon, authenticated;
grant execute on function public.backup_objects() to service_role;

-- 8. The timer: every 15 minutes the function checks whether this week's Sydney day and time (Settings → Data) has
--    come; it does nothing otherwise (pg_cron runs in UTC and Sydney has daylight saving, so a fixed weekly cron would
--    drift by an hour twice a year). The secret header comes from Vault ('backup_cron_secret', added by the owner);
--    until it exists the header is empty and the function refuses the call.
do $$ begin
  if exists (select 1 from cron.job where jobname = 'backup-weekly-check') then
    perform cron.unschedule('backup-weekly-check');
  end if;
end $$;
select cron.schedule('backup-weekly-check', '*/15 * * * *', $job$
  select net.http_post(
    url := 'https://dszlllazwmllmoklzjwl.supabase.co/functions/v1/backup',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-backup-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'backup_cron_secret' limit 1), '')),
    body := '{"step":"tick"}'::jsonb,
    timeout_milliseconds := 10000)
$job$);

commit;
select 'F-backup ok';

-- Check after:
--   select id, public from storage.buckets where id = 'backups';                         -- expect backups | false
--   select policyname, permissive from pg_policies where schemaname = 'storage' and policyname = 'backups: no direct access';  -- RESTRICTIVE
--   select * from public.backup_settings;                                                 -- one row, info@…, 0, 03:00
--   select count(*) from public.backup_tables();                                          -- every public table
--   select jobname, schedule from cron.job where jobname = 'backup-weekly-check';         -- */15 * * * *
--   select count(*) from vault.decrypted_secrets where name = 'backup_cron_secret';       -- 1 after the owner step
--   select status, return_message from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'backup-weekly-check') order by start_time desc limit 3;
--   select last_tick_at from public.backup_state;                                         -- within 15 min once the function is deployed

-- ── ROLLBACK (F-backup; run by hand only; the stored backups are kept until the bucket is emptied) ──────────────
-- select cron.unschedule('backup-weekly-check');
-- drop policy if exists "backups: no direct access" on storage.objects;
-- drop function if exists public.backup_objects();
-- drop function if exists public.backup_tables();
-- drop table if exists public.backup_files;
-- drop table if exists public.backup_state;
-- drop table if exists public.backup_runs;
-- drop table if exists public.backup_settings;
-- delete from vault.secrets where name = 'backup_cron_secret';
-- The bucket itself is NOT removed with SQL (Supabase refuses direct deletes on its storage tables): in the Dashboard,
-- Storage → backups → Empty bucket, then Delete bucket.
-- And remove the Edge Function secrets BACKUP_CRON_SECRET (and BACKUP_PASSWORD if no longer wanted).
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- END F-backup
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Group E: Settings → Data → Export to Excel (plan item 5; M6 answers 1 and 6). 14 Oct 2026.
-- NO DATABASE CHANGE in this group. The Excel is built in the owner's browser from tables the owner can already read
-- under today's RLS (Settings is owners-only), 1,000 rows per request. No table, column, policy, bucket, function or
-- cron is added, changed or removed here. "Download full backup" calls the backup function (group F) after the step-up
-- (group G); their SQL is in their own sections of this file.
--
-- READ-ONLY CHECK before the app is uploaded (Ofek runs it in the SQL editor; it changes nothing).
-- The export pages through each table ordered by these columns, so each set must be the table's primary key:
--   shift_events (at, profile_id, kind) · myday_days (day) · commission_rates (technician_name)
--   contractor_private (supplier_id) · every other table below: id
-- If a line differs, tell Claude before the upload (the keys are set in EXPORT_AREAS in index.html).
--
-- select c.relname as table_name,
--        string_agg(a.attname, ', ' order by k.ord) as primary_key
-- from pg_index i
-- join pg_class c on c.oid = i.indrelid
-- join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
-- cross join lateral unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
-- join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
-- where i.indisprimary
--   and c.relname in ('contacts', 'activity_log', 'jobs', 'closings', 'payroll_weeks', 'payroll_bonuses',
--                     'sales_daily_log', 'commission_rates', 'employees', 'profiles', 'suppliers', 'contractor_private',
--                     'equipment_spend', 'equipment_catalog', 'tasks', 'manual_reminders', 'chat_sessions',
--                     'lead_messages', 'shift_events', 'myday_days', 'review_requests', 'ads_stats', 'ad_spend',
--                     'ad_calls', 'organic_stats', 'ghl_archive', 'settings', 'owner_settings')
-- group by c.relname
-- order by 1;
--
-- ROLLBACK (group E): nothing to roll back; this group creates no database objects.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- END E-export
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
