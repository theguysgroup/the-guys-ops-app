-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- Stage 5: the private connector (MCP), both directions. SHARED FILE: each group writes ONE clearly delimited,
-- self-contained section below (its own begin/commit, its own read-only checks and its own commented ROLLBACK block).
-- Run each section on its own in the Supabase SQL editor, STAGING first (project wblsrpmjiqwuxmrmuklc), in the order
-- the build notes give. Nothing in this file has been run by the builder: the owner runs it.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- Group M1-server: every stage-5 table, the external server secret helpers (Vault), the catalog.mcp writer, the
-- access-log prune and the hourly import timer (stage 5 spec §2; SaaS rule 14 Oct: business_id on every new table).
-- Run BEFORE deploying the mcp function. Safe to run again (idempotent).
--   mcp_tokens       personal read-only keys (only a sha256 hash is stored; the key itself is shown once)
--   mcp_access_log   one row per tool call (ok / denied / error / rate_limited)
--   mcp_servers      a business's own MCP servers (OPS as a client; the secret lives only in Vault)
--   mcp_import_rules what to import from them (contacts / jobs / tasks), manual or hourly
--   mcp_import_runs  each import, with the ids it inserted (so it can be undone)
-- Every write goes through the mcp function (service role); the app only reads, under RLS. Settings need no column:
-- settings.catalog.mcp = { rateLimitPerMin, logKeepDays, importSource } (defaults in the function); who may make keys
-- is permissions.mcp on profiles (owners and managers always).
-- NO secret is written here. The owner adds, in Vault: 'mcp_cron_secret' (a long random value, also the Edge Function
-- secret MCP_CRON_SECRET) and 'mcp_project_url' (this project's https://<ref>.supabase.co). Until both exist the hourly
-- timer posts nothing / the function refuses it.
-- Check before (read-only):
--   select to_regclass('public.mcp_tokens'), to_regclass('public.mcp_access_log'), to_regclass('public.mcp_servers'),
--          to_regclass('public.mcp_import_rules'), to_regclass('public.mcp_import_runs');          -- all null the first time
--   select column_name, data_type from information_schema.columns
--    where table_schema = 'public' and table_name = 'settings' and column_name = 'catalog';       -- jsonb
--   select extname from pg_extension where extname in ('pg_cron', 'pg_net', 'supabase_vault');     -- expect 3
--   select jobname from cron.job where jobname in ('mcp-import-hourly', 'mcp-log-prune');           -- 0 rows the first time
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
begin;

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 1. Personal keys. The key is 'ops_mcp_' + 43 url-safe characters; only its sha256 (hex) is kept, plus the first 12
--    characters to recognise it on screen. No expiry (Ofek 14 Oct): a key works until it is revoked.
create table if not exists public.mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  token_prefix text not null check (char_length(token_prefix) = 12),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] not null default '{read}',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null
);
create index if not exists mcp_tokens_user_idx on public.mcp_tokens (user_id, created_at desc);

-- 2. Every tool call made with a key (also refused ones). The log outlives a key (token_id is cleared, user_id stays).
create table if not exists public.mcp_access_log (
  id bigserial primary key,
  business_id text not null default 'default',
  token_id uuid references public.mcp_tokens(id) on delete set null,
  user_id uuid,
  tool text not null check (char_length(tool) <= 64),
  args_summary text check (args_summary is null or char_length(args_summary) <= 400),
  rows_returned integer not null default 0,
  status text not null check (status in ('ok', 'denied', 'error', 'rate_limited')),
  at timestamptz not null default now()
);
create index if not exists mcp_access_log_token_at_idx on public.mcp_access_log (token_id, at desc);
create index if not exists mcp_access_log_user_at_idx on public.mcp_access_log (user_id, at desc);
create index if not exists mcp_access_log_at_idx on public.mcp_access_log (at);

-- 3. A business's own MCP servers (OPS as a client). https only (the function also blocks private addresses). The
--    secret (e.g. a bearer token) is only in Vault: secret_id points at it, and the app only ever sees has_secret.
create table if not exists public.mcp_servers (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  name text not null check (char_length(btrim(name)) between 1 and 80),
  url text not null check (url ~ '^https://' and char_length(url) <= 500),
  auth_header text check (auth_header is null or auth_header ~ '^[A-Za-z0-9-]{1,64}$'),
  secret_id uuid,
  has_secret boolean generated always as (secret_id is not null) stored,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_test_at timestamptz,
  last_test_ok boolean,
  last_tools jsonb
);

-- 4. What to import from a server: a tool + its arguments, where the list sits in the result, how each field maps,
--    which fields find a duplicate. New rules are OFF and never start customer automations unless switched on.
create table if not exists public.mcp_import_rules (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  server_id uuid not null references public.mcp_servers(id) on delete cascade,
  kind text not null check (kind in ('contacts', 'jobs', 'tasks')),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  tool text not null check (char_length(tool) between 1 and 128),
  tool_args jsonb not null default '{}'::jsonb check (jsonb_typeof(tool_args) = 'object'),
  items_path text not null default '' check (char_length(items_path) <= 200),
  mapping jsonb not null default '{}'::jsonb check (jsonb_typeof(mapping) = 'object'),
  dedupe jsonb not null default '{}'::jsonb check (jsonb_typeof(dedupe) = 'object'),   -- { fields: [...], match: 'any' | 'all' }
  mode text not null default 'manual' check (mode in ('manual', 'hourly')),
  enabled boolean not null default false,
  run_automations boolean not null default false,
  last_run_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists mcp_import_rules_server_idx on public.mcp_import_rules (server_id);
create index if not exists mcp_import_rules_hourly_idx on public.mcp_import_rules (business_id, last_run_at) where enabled and mode = 'hourly';

-- 5. Each import. inserted_ids = exactly the records it made, so Undo deletes those and nothing else.
create table if not exists public.mcp_import_runs (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  rule_id uuid references public.mcp_import_rules(id) on delete set null,
  kind text not null check (kind in ('contacts', 'jobs', 'tasks')),
  source text not null default 'manual' check (source in ('manual', 'hourly')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'done', 'partial', 'failed')),
  fetched integer not null default 0,
  inserted integer not null default 0,
  duplicates integer not null default 0,
  errors jsonb not null default '[]'::jsonb,
  inserted_ids text[] not null default '{}',
  undone_at timestamptz,
  undone_by uuid references auth.users(id) on delete set null
);
create index if not exists mcp_import_runs_rule_idx on public.mcp_import_runs (rule_id, started_at desc);

-- 6. An external server's secret, in Vault only (the function, service role, calls these; the browser never can).
--    An empty secret removes it. Returns whether a secret is now saved.
create or replace function public.mcp_server_secret_set(p_server uuid, p_secret text) returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare sid uuid; nm text := 'mcp_server_' || p_server::text;
begin
  select s.secret_id into sid from public.mcp_servers s where s.id = p_server for update;
  if not found then raise exception 'mcp server % not found', p_server; end if;
  if coalesce(p_secret, '') = '' then
    if sid is not null then delete from vault.secrets where id = sid; end if;
    update public.mcp_servers set secret_id = null where id = p_server;
    return false;
  end if;
  if sid is not null and exists (select 1 from vault.secrets where id = sid) then
    perform vault.update_secret(sid, p_secret);
  else
    delete from vault.secrets where name = nm;   -- a leftover from an earlier, interrupted save
    sid := vault.create_secret(p_secret, nm, 'OPS private connector: an external MCP server''s secret');
    update public.mcp_servers set secret_id = sid where id = p_server;
  end if;
  return true;
end $$;

create or replace function public.mcp_server_secret_get(p_server uuid) returns text
language sql stable security definer set search_path = ''
as $$
  select d.decrypted_secret from public.mcp_servers s join vault.decrypted_secrets d on d.id = s.secret_id where s.id = p_server
$$;

-- Deleting a server deletes its secret too.
create or replace function public.mcp_servers_drop_secret() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.secret_id is not null then delete from vault.secrets where id = old.secret_id; end if;
  return old;
end $$;
drop trigger if exists mcp_servers_drop_secret on public.mcp_servers;
create trigger mcp_servers_drop_secret after delete on public.mcp_servers
  for each row execute function public.mcp_servers_drop_secret();

-- 7. settings.catalog.mcp, written in one statement (the rest of the catalog is never touched).
create or replace function public.mcp_set_catalog(p_mcp jsonb) returns jsonb
language sql volatile security definer set search_path = ''
as $$
  update public.settings
     set catalog = pg_catalog.jsonb_set(coalesce(catalog, '{}'::jsonb), '{mcp}', p_mcp, true)
   where id = 1
  returning catalog -> 'mcp'
$$;

-- 8. The access log keeps catalog.mcp.logKeepDays days (7 to 3650; 90 when missing or not a number).
create or replace function public.mcp_prune_access_log() returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare raw text; keep integer := 90; n integer;
begin
  select s.catalog -> 'mcp' ->> 'logKeepDays' into raw from public.settings s where s.id = 1;
  if raw ~ '^[0-9]{1,5}$' then keep := least(greatest(raw::integer, 7), 3650); end if;
  delete from public.mcp_access_log where at < now() - make_interval(days => keep);
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.mcp_server_secret_set(uuid, text) from public, anon, authenticated;
revoke all on function public.mcp_server_secret_get(uuid) from public, anon, authenticated;
revoke all on function public.mcp_servers_drop_secret() from public, anon, authenticated;
revoke all on function public.mcp_set_catalog(jsonb) from public, anon, authenticated;
revoke all on function public.mcp_prune_access_log() from public, anon, authenticated;
grant execute on function public.mcp_server_secret_set(uuid, text) to service_role;
grant execute on function public.mcp_server_secret_get(uuid) to service_role;
grant execute on function public.mcp_set_catalog(jsonb) to service_role;
grant execute on function public.mcp_prune_access_log() to service_role;

-- 9. Access. Keys and the log: your own rows, owners every row. Servers, rules and runs: owners only. Nobody writes
--    from the app (the function uses the service role). The key hash and the Vault id are never readable by the app.
alter table public.mcp_tokens enable row level security;
alter table public.mcp_access_log enable row level security;
alter table public.mcp_servers enable row level security;
alter table public.mcp_import_rules enable row level security;
alter table public.mcp_import_runs enable row level security;

drop policy if exists "mcp_tokens: own or owner read" on public.mcp_tokens;
create policy "mcp_tokens: own or owner read" on public.mcp_tokens for select to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner'));
drop policy if exists "mcp_access_log: own or owner read" on public.mcp_access_log;
create policy "mcp_access_log: own or owner read" on public.mcp_access_log for select to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner'));
drop policy if exists "mcp_servers: owners read" on public.mcp_servers;
create policy "mcp_servers: owners read" on public.mcp_servers for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner'));
drop policy if exists "mcp_import_rules: owners read" on public.mcp_import_rules;
create policy "mcp_import_rules: owners read" on public.mcp_import_rules for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner'));
drop policy if exists "mcp_import_runs: owners read" on public.mcp_import_runs;
create policy "mcp_import_runs: owners read" on public.mcp_import_runs for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner'));

revoke all on public.mcp_tokens, public.mcp_access_log, public.mcp_servers, public.mcp_import_rules, public.mcp_import_runs from anon;
revoke all on public.mcp_tokens, public.mcp_access_log, public.mcp_servers, public.mcp_import_rules, public.mcp_import_runs from authenticated;
revoke all on sequence public.mcp_access_log_id_seq from anon, authenticated;
grant select (id, business_id, user_id, name, token_prefix, scopes, created_at, last_used_at, revoked_at, revoked_by)
  on public.mcp_tokens to authenticated;
grant select (id, business_id, name, url, auth_header, has_secret, created_by, created_at, last_test_at, last_test_ok, last_tools)
  on public.mcp_servers to authenticated;
grant select on public.mcp_access_log, public.mcp_import_rules, public.mcp_import_runs to authenticated;
grant all on public.mcp_tokens, public.mcp_access_log, public.mcp_servers, public.mcp_import_rules, public.mcp_import_runs to service_role;
grant usage, select on sequence public.mcp_access_log_id_seq to service_role;

-- 10. Timers. The log prune runs daily at 03:41 UTC. The hourly import runs at minute 17: it posts to this project's mcp
--     function (its address from Vault 'mcp_project_url', nothing hard-coded) with the header from Vault
--     'mcp_cron_secret'; while the address is missing nothing is posted, while the secret is missing the function refuses.
do $$ begin
  if exists (select 1 from cron.job where jobname = 'mcp-log-prune') then perform cron.unschedule('mcp-log-prune'); end if;
  if exists (select 1 from cron.job where jobname = 'mcp-import-hourly') then perform cron.unschedule('mcp-import-hourly'); end if;
end $$;
select cron.schedule('mcp-log-prune', '41 3 * * *', $job$ select public.mcp_prune_access_log() $job$);
select cron.schedule('mcp-import-hourly', '17 * * * *', $job$
  select net.http_post(
    url := u.base || '/functions/v1/mcp/cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-mcp-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'mcp_cron_secret' limit 1), '')),
    body := '{"step":"import_hourly"}'::jsonb,
    timeout_milliseconds := 10000)
  from (select rtrim(btrim(decrypted_secret), '/') as base from vault.decrypted_secrets where name = 'mcp_project_url' limit 1) u
  where u.base ~ '^https://[a-z0-9]+\.supabase\.co$'
$job$);
-- The address is tidied first (spaces and a trailing '/' dropped). One that still isn't https://<ref>.supabase.co makes
-- the timer post nothing while cron still reports 'succeeded', so say so now.
do $$ begin
  if exists (select 1 from vault.decrypted_secrets where name = 'mcp_project_url'
             and rtrim(btrim(decrypted_secret), '/') !~ '^https://[a-z0-9]+\.supabase\.co$') then
    raise notice 'Vault mcp_project_url is not https://<project-ref>.supabase.co: the hourly import will not run until it is.';
  end if;
end $$;

commit;
select 'M1-server ok';

-- Owner steps (after this section; values are made by the owner, never written in a file):
--   select vault.create_secret('<a long random value>', 'mcp_cron_secret');            -- the same value as Edge secret MCP_CRON_SECRET
--   select vault.create_secret('https://wblsrpmjiqwuxmrmuklc.supabase.co', 'mcp_project_url');   -- staging; live uses its own address
-- Check after (read-only):
--   select table_name from information_schema.tables where table_schema = 'public' and table_name like 'mcp\_%' order by 1;   -- 5 tables
--   select tablename, policyname, cmd from pg_policies where tablename like 'mcp\_%' order by 1, 2;                         -- 5 select policies
--   select relname, relrowsecurity from pg_class where relname like 'mcp\_%' and relkind = 'r';                              -- all true
--   select grantee, privilege_type, column_name from information_schema.column_privileges
--    where table_name = 'mcp_tokens' and grantee = 'authenticated' order by column_name;                                    -- no token_hash
--   select has_function_privilege('authenticated', 'public.mcp_server_secret_get(uuid)', 'execute');                       -- false
--   select jobname, schedule from cron.job where jobname in ('mcp-import-hourly', 'mcp-log-prune');                          -- 17 * * * * | 41 3 * * *
--   select count(*) from vault.decrypted_secrets where name in ('mcp_cron_secret', 'mcp_project_url');                      -- 2 after the owner steps
--   select rtrim(btrim(decrypted_secret), '/') ~ '^https://[a-z0-9]+\.supabase\.co$' from vault.decrypted_secrets
--    where name = 'mcp_project_url';                                                                                       -- true (else nothing is posted)
--   select public.mcp_prune_access_log();                                                                                  -- 0 on a new log
--   Vault test (in a transaction, then roll back):
--   begin; insert into public.mcp_servers (name, url) values ('vault test', 'https://example.com/mcp') returning id \gset
--     select public.mcp_server_secret_set((select id from public.mcp_servers where name = 'vault test'), 'abc');           -- true
--     select has_secret, public.mcp_server_secret_get(id) from public.mcp_servers where name = 'vault test';                -- true | abc
--     delete from public.mcp_servers where name = 'vault test';
--     select count(*) from vault.secrets where name like 'mcp_server_%';                                                    -- 0
--   rollback;

-- ── ROLLBACK (M1-server; run by hand only) ─────────────────────────────────────────────────────────────────────
-- Undo any imports in the app first: imported contacts, jobs and tasks are ordinary rows and stay after this rollback.
-- select cron.unschedule('mcp-import-hourly');
-- select cron.unschedule('mcp-log-prune');
-- begin;
-- delete from vault.secrets where id in (select secret_id from public.mcp_servers where secret_id is not null);
-- drop trigger if exists mcp_servers_drop_secret on public.mcp_servers;
-- drop function if exists public.mcp_servers_drop_secret();
-- drop function if exists public.mcp_server_secret_set(uuid, text);
-- drop function if exists public.mcp_server_secret_get(uuid);
-- drop function if exists public.mcp_set_catalog(jsonb);
-- drop function if exists public.mcp_prune_access_log();
-- drop table if exists public.mcp_import_runs;
-- drop table if exists public.mcp_import_rules;
-- drop table if exists public.mcp_servers;
-- drop table if exists public.mcp_access_log;
-- drop table if exists public.mcp_tokens;
-- -- Optional (harmless to keep): the settings and the per-person switch.
-- -- update public.settings set catalog = catalog - 'mcp' where id = 1;
-- -- update public.profiles set permissions = permissions - 'mcp' where permissions ? 'mcp';
-- commit;
-- delete from vault.secrets where name in ('mcp_cron_secret', 'mcp_project_url');
-- And remove the Edge Function secret MCP_CRON_SECRET and the 'mcp' function in the Dashboard.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- END M1-server
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- Group M2-client: OPS as an MCP CLIENT of a business's own private MCP server (stage 5 spec §2/§3; owners only).
-- STAGING FIRST (wblsrpmjiqwuxmrmuklc). Run AFTER the M1-server section. Safe to run again (idempotent).
-- M1-server already made public.mcp_servers and its Vault helpers; this section does NOT define them a second time.
-- The mcp function (service role) uses exactly these, and nothing else, for a server's secret:
--   public.mcp_server_secret_set(p_server uuid, p_secret text) → boolean   set / replace; null or '' removes it
--   public.mcp_server_secret_get(p_server uuid) → text                     only for the outbound request
--   trigger mcp_servers_drop_secret (after delete)                         a deleted server takes its secret with it
-- The browser NEVER gets a secret: it lives only in Supabase Vault (vault.secrets, name 'mcp_server_<id>'); the table
-- keeps its Vault id, which the app can't read either (owners read the other columns, and has_secret).
-- This section only adds what M2 needs on top: the column guarantees, a check that last_tools is a list, an index by
-- business, and it re-asserts who may run the secret helpers (service role only) and that nobody writes from the app.
-- NO secret is written by this file.
-- Check before (read-only):
--   select to_regclass('public.mcp_servers');                                                         -- not null (M1 ran)
--   select extname from pg_extension where extname = 'supabase_vault';                               -- 1 row
--   select p.proname, pg_get_function_identity_arguments(p.oid) from pg_proc p
--    where p.proname in ('mcp_server_secret_set', 'mcp_server_secret_get', 'mcp_servers_drop_secret');   -- 3 rows (p_server uuid …)
--   select conname from pg_constraint where conrelid = 'public.mcp_servers'::regclass and conname = 'mcp_servers_tools_arr';   -- 0 rows the first time
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
begin;

do $$ begin
  if to_regclass('public.mcp_servers') is null
     or to_regprocedure('public.mcp_server_secret_set(uuid, text)') is null
     or to_regprocedure('public.mcp_server_secret_get(uuid)') is null
     or to_regprocedure('public.mcp_servers_drop_secret()') is null then
    raise exception 'Run the M1-server section of stage5-mcp.sql first.';
  end if;
end $$;

-- 1. Every column the client steps use (all made by M1; these are no-ops there, and keep a hand-made table right).
alter table public.mcp_servers add column if not exists business_id text not null default 'default';
alter table public.mcp_servers add column if not exists auth_header text;
alter table public.mcp_servers add column if not exists secret_id uuid;
alter table public.mcp_servers add column if not exists created_by uuid;
alter table public.mcp_servers add column if not exists created_at timestamptz not null default now();
alter table public.mcp_servers add column if not exists last_test_at timestamptz;
alter table public.mcp_servers add column if not exists last_test_ok boolean;
alter table public.mcp_servers add column if not exists last_tools jsonb;
-- (https only, at most 500 characters, and the header-name rule are M1's checks on the table itself.)
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.mcp_servers'::regclass and conname = 'mcp_servers_tools_arr') then
    alter table public.mcp_servers add constraint mcp_servers_tools_arr check (last_tools is null or jsonb_typeof(last_tools) = 'array');
  end if;
end $$;
create index if not exists mcp_servers_business_idx on public.mcp_servers (business_id);

-- 2. Access, re-asserted: owners read (M1's policy and column grant, which leaves out secret_id); nobody writes from
--    the app (the mcp function uses the service role, which skips RLS); only the service role runs the secret helpers.
alter table public.mcp_servers enable row level security;
revoke all on public.mcp_servers from anon;
revoke insert, update, delete, truncate, references, trigger on public.mcp_servers from authenticated;
grant all on public.mcp_servers to service_role;
revoke all on function public.mcp_server_secret_set(uuid, text) from public, anon, authenticated;
revoke all on function public.mcp_server_secret_get(uuid) from public, anon, authenticated;
revoke all on function public.mcp_servers_drop_secret() from public, anon, authenticated;
grant execute on function public.mcp_server_secret_set(uuid, text) to service_role;
grant execute on function public.mcp_server_secret_get(uuid) to service_role;

commit;
select 'M2-client ok';

-- Check after (read-only):
--   select tablename, policyname, cmd from pg_policies where tablename = 'mcp_servers';             -- one SELECT policy (owners)
--   select privilege_type from information_schema.role_table_grants
--    where table_schema = 'public' and table_name = 'mcp_servers' and grantee in ('anon', 'authenticated');   -- 0 rows (column grant only)
--   select column_name from information_schema.column_privileges
--    where table_name = 'mcp_servers' and grantee = 'authenticated' order by 1;                         -- no secret_id
--   select p.proname, has_function_privilege('authenticated', p.oid, 'execute') as app_can,
--          has_function_privilege('service_role', p.oid, 'execute') as function_can
--     from pg_proc p where p.proname in ('mcp_server_secret_set', 'mcp_server_secret_get');            -- false | true for both
--   Vault round trip (in a transaction, then rolled back; a fake value):
--   begin;
--   insert into public.mcp_servers (name, url) values ('vault test', 'https://example.com/mcp');
--   select public.mcp_server_secret_set((select id from public.mcp_servers where name = 'vault test'), 'fake-test-value');   -- true
--   select public.mcp_server_secret_get((select id from public.mcp_servers where name = 'vault test')) = 'fake-test-value';    -- true
--   delete from public.mcp_servers where name = 'vault test';
--   select count(*) from vault.secrets where name like 'mcp_server_%'
--     and name not in (select 'mcp_server_' || id::text from public.mcp_servers);                     -- 0 (no orphan)
--   rollback;

-- ── ROLLBACK (M2-client; run by hand only) ─────────────────────────────────────────────────────────────────────
-- Removes only what this section added. The table, its secrets and the helpers are M1-server's (see its rollback,
-- which also deletes every saved server's Vault secret).
-- begin;
-- alter table public.mcp_servers drop constraint if exists mcp_servers_tools_arr;
-- drop index if exists public.mcp_servers_business_idx;
-- commit;
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- END M2-client
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════



-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Group M4-import: import from a business's own MCP server into contacts, jobs and tasks (stage 5, spec §2/§3).
-- STAGING FIRST (wblsrpmjiqwuxmrmuklc). Run AFTER the M1 and M2 sections above (public.mcp_servers must exist).
-- Safe to run again (idempotent): tables are created if missing, every column is added if missing, the named checks
-- are dropped and re-added, and policies are dropped and re-created. It also brings a database where an EARLIER draft
-- of the M1 section ran up to date (runs.mode → runs.source, dedupe as an object), so no column exists twice.
-- NOTHING here imports anything: no rule is created; every rule starts OFF and with run_automations OFF.
-- The hourly timer 'mcp-import-hourly' (minute 17, header x-mcp-cron-secret from Vault 'mcp_cron_secret', posted to
-- this project's own address from Vault 'mcp_project_url', so no project is hard-coded) is scheduled by the M1
-- section; this section only checks that it is there. The function ignores the body and answers 202 at once.
-- NO secret is written here. Owner steps (staging values are fake/test):
--   1. make a long random value; store it in Vault:  select vault.create_secret('<the value>', 'mcp_cron_secret');
--      and this project's address:  select vault.create_secret('https://wblsrpmjiqwuxmrmuklc.supabase.co', 'mcp_project_url');
--   2. set the same value as the Edge Function secret MCP_CRON_SECRET of the 'mcp' function (Verify JWT OFF).
--   Until both exist the timer posts nothing (no address) or the function refuses the call (401).
-- Check before (read-only):
--   select to_regclass('public.mcp_servers'), to_regclass('public.mcp_import_rules'), to_regclass('public.mcp_import_runs');
--   select extname from pg_extension where extname in ('pg_cron', 'pg_net');
--   select count(*) from cron.job where jobname = 'mcp-import-hourly';                          -- 1 (made by M1)
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'mcp_import_runs' and column_name in ('mode', 'source');
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
begin;

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if to_regclass('public.mcp_servers') is null then
    raise exception 'Run the M2 section of this file first (public.mcp_servers is missing)';
  end if;
end $$;

-- 1. Import rules: what to pull from which server, how its fields map onto a contact / job / task, which fields find a
--    duplicate, and whether it runs by hand or every hour. Owners read them; only the mcp function (service role) writes.
create table if not exists public.mcp_import_rules (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default'
);
alter table public.mcp_import_rules add column if not exists business_id text not null default 'default';
alter table public.mcp_import_rules add column if not exists server_id uuid;
alter table public.mcp_import_rules add column if not exists kind text;
alter table public.mcp_import_rules add column if not exists name text;
alter table public.mcp_import_rules add column if not exists tool text;
alter table public.mcp_import_rules add column if not exists tool_args jsonb not null default '{}'::jsonb;
alter table public.mcp_import_rules add column if not exists items_path text not null default '';
alter table public.mcp_import_rules add column if not exists mapping jsonb not null default '{}'::jsonb;
alter table public.mcp_import_rules add column if not exists dedupe jsonb not null default '{}'::jsonb;
alter table public.mcp_import_rules add column if not exists mode text not null default 'manual';
alter table public.mcp_import_rules add column if not exists enabled boolean not null default false;
alter table public.mcp_import_rules add column if not exists run_automations boolean not null default false;
alter table public.mcp_import_rules add column if not exists last_run_at timestamptz;
alter table public.mcp_import_rules add column if not exists created_by uuid;
alter table public.mcp_import_rules add column if not exists created_at timestamptz not null default now();
alter table public.mcp_import_rules add column if not exists updated_at timestamptz not null default now();
alter table public.mcp_import_rules alter column server_id set not null;
alter table public.mcp_import_rules alter column kind set not null;
alter table public.mcp_import_rules alter column name set not null;
alter table public.mcp_import_rules alter column tool set not null;
alter table public.mcp_import_rules alter column run_automations set default false;   -- imports never message customers unless switched on per rule
-- dedupe is { fields: [...], match: 'any' | 'all' } (an earlier M1 draft checked for a list; json_shapes below checks it now).
alter table public.mcp_import_rules drop constraint if exists mcp_import_rules_dedupe_check;
alter table public.mcp_import_rules alter column dedupe set default '{}'::jsonb;

alter table public.mcp_import_rules drop constraint if exists mcp_import_rules_server_id_fkey;
alter table public.mcp_import_rules add constraint mcp_import_rules_server_id_fkey
  foreign key (server_id) references public.mcp_servers(id) on delete cascade;
alter table public.mcp_import_rules drop constraint if exists mcp_import_rules_kind_check;
alter table public.mcp_import_rules add constraint mcp_import_rules_kind_check check (kind in ('contacts', 'jobs', 'tasks'));
alter table public.mcp_import_rules drop constraint if exists mcp_import_rules_mode_check;
alter table public.mcp_import_rules add constraint mcp_import_rules_mode_check check (mode in ('manual', 'hourly'));
alter table public.mcp_import_rules drop constraint if exists mcp_import_rules_name_check;
alter table public.mcp_import_rules add constraint mcp_import_rules_name_check check (char_length(name) between 1 and 80);
alter table public.mcp_import_rules drop constraint if exists mcp_import_rules_tool_check;
alter table public.mcp_import_rules add constraint mcp_import_rules_tool_check check (char_length(tool) between 1 and 120);
alter table public.mcp_import_rules drop constraint if exists mcp_import_rules_items_path_check;
alter table public.mcp_import_rules add constraint mcp_import_rules_items_path_check check (char_length(items_path) <= 200);
alter table public.mcp_import_rules drop constraint if exists mcp_import_rules_json_shapes;
alter table public.mcp_import_rules add constraint mcp_import_rules_json_shapes check (
  jsonb_typeof(tool_args) = 'object' and jsonb_typeof(mapping) = 'object' and jsonb_typeof(dedupe) = 'object'
  and pg_column_size(tool_args) <= 8192 and pg_column_size(mapping) <= 16384);

create index if not exists mcp_import_rules_server_idx on public.mcp_import_rules (server_id);
create index if not exists mcp_import_rules_hourly_idx on public.mcp_import_rules (business_id, last_run_at) where enabled and mode = 'hourly';

-- 2. Each import (by hand or by the hourly timer): what was fetched, inserted, found duplicate or refused, and exactly
--    which rows it inserted (inserted_ids), so Undo deletes those rows and nothing else. A run outlives its rule
--    (rule_id is cleared, rule_name stays), so an import can still be undone after its rule is deleted.
create table if not exists public.mcp_import_runs (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default'
);
-- An earlier M1 draft called the source column 'mode': renamed (kept, never duplicated).
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'mcp_import_runs' and column_name = 'mode')
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'mcp_import_runs' and column_name = 'source') then
    alter table public.mcp_import_runs rename column mode to source;
  end if;
end $$;
alter table public.mcp_import_runs drop constraint if exists mcp_import_runs_mode_check;
alter table public.mcp_import_runs add column if not exists business_id text not null default 'default';
alter table public.mcp_import_runs add column if not exists rule_id uuid;
alter table public.mcp_import_runs add column if not exists rule_name text;
alter table public.mcp_import_runs add column if not exists kind text;
alter table public.mcp_import_runs add column if not exists source text not null default 'manual';
alter table public.mcp_import_runs add column if not exists run_automations boolean not null default false;
alter table public.mcp_import_runs add column if not exists started_by uuid;
alter table public.mcp_import_runs add column if not exists started_at timestamptz not null default now();
alter table public.mcp_import_runs add column if not exists finished_at timestamptz;
alter table public.mcp_import_runs add column if not exists status text not null default 'running';
alter table public.mcp_import_runs add column if not exists fetched integer not null default 0;
alter table public.mcp_import_runs add column if not exists inserted integer not null default 0;
alter table public.mcp_import_runs add column if not exists duplicates integer not null default 0;
alter table public.mcp_import_runs add column if not exists errors jsonb not null default '[]'::jsonb;
alter table public.mcp_import_runs add column if not exists inserted_ids text[] not null default '{}';
alter table public.mcp_import_runs add column if not exists undone_at timestamptz;
alter table public.mcp_import_runs add column if not exists undone_by uuid;
alter table public.mcp_import_runs add column if not exists undo_deleted integer;
alter table public.mcp_import_runs add column if not exists undo_kept integer;
alter table public.mcp_import_runs alter column kind set not null;

alter table public.mcp_import_runs drop constraint if exists mcp_import_runs_rule_id_fkey;
alter table public.mcp_import_runs add constraint mcp_import_runs_rule_id_fkey
  foreign key (rule_id) references public.mcp_import_rules(id) on delete set null;
alter table public.mcp_import_runs drop constraint if exists mcp_import_runs_kind_check;
alter table public.mcp_import_runs add constraint mcp_import_runs_kind_check check (kind in ('contacts', 'jobs', 'tasks'));
alter table public.mcp_import_runs drop constraint if exists mcp_import_runs_source_check;
alter table public.mcp_import_runs add constraint mcp_import_runs_source_check check (source in ('manual', 'hourly'));
alter table public.mcp_import_runs drop constraint if exists mcp_import_runs_status_check;
alter table public.mcp_import_runs add constraint mcp_import_runs_status_check check (status in ('running', 'done', 'partial', 'failed'));
alter table public.mcp_import_runs drop constraint if exists mcp_import_runs_errors_arr;
alter table public.mcp_import_runs add constraint mcp_import_runs_errors_arr check (jsonb_typeof(errors) = 'array');

create index if not exists mcp_import_runs_rule_idx on public.mcp_import_runs (rule_id, started_at desc);
create index if not exists mcp_import_runs_started_idx on public.mcp_import_runs (business_id, started_at desc);
-- One import of a rule at a time (the timer and an owner's Import button can never both insert the same rows).
create unique index if not exists mcp_import_runs_one_running on public.mcp_import_runs (rule_id) where status = 'running';

-- 3. Access: owners read both (Settings → Connectors → Imports); nobody writes from the browser.
alter table public.mcp_import_rules enable row level security;
alter table public.mcp_import_runs enable row level security;
drop policy if exists "mcp_import_rules: owners read" on public.mcp_import_rules;
create policy "mcp_import_rules: owners read" on public.mcp_import_rules for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner'));
drop policy if exists "mcp_import_runs: owners read" on public.mcp_import_runs;
create policy "mcp_import_runs: owners read" on public.mcp_import_runs for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner'));
revoke insert, update, delete on public.mcp_import_rules, public.mcp_import_runs from anon, authenticated;

-- 4. The hourly timer is M1's (step 10 above, the project's address from Vault): only checked here, never scheduled
--    again with a fixed address (a fixed staging address applied on LIVE would point LIVE's timer at staging).
do $$ begin
  if not exists (select 1 from cron.job where jobname = 'mcp-import-hourly') then
    raise notice 'mcp-import-hourly is not scheduled: run the M1-server section of this file first';
  end if;
end $$;

commit;
select 'M4-import ok';

-- Check after (read-only):
--   select count(*) from public.mcp_import_rules;                                             -- 0 (nothing created)
--   select column_name, data_type, column_default from information_schema.columns
--    where table_schema = 'public' and table_name in ('mcp_import_rules', 'mcp_import_runs') order by table_name, ordinal_position;   -- no 'mode' on runs
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid in ('public.mcp_import_rules'::regclass, 'public.mcp_import_runs'::regclass) order by conname;   -- no dedupe_check
--   select indexname, indexdef from pg_indexes where tablename = 'mcp_import_runs';            -- mcp_import_runs_one_running ... WHERE status = 'running'
--   select tablename, policyname, cmd from pg_policies where tablename in ('mcp_import_rules', 'mcp_import_runs');   -- select only
--   select jobname, schedule from cron.job where jobname = 'mcp-import-hourly';                -- 17 * * * *
--   select count(*) from vault.decrypted_secrets where name in ('mcp_cron_secret', 'mcp_project_url');   -- 2 after the owner step
--   select status, return_message from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'mcp-import-hourly') order by start_time desc limit 3;
--   One-running test (in a transaction, then roll back; needs one rule):
--   begin; insert into public.mcp_import_runs (rule_id, kind) select id, kind from public.mcp_import_rules limit 1;
--     insert into public.mcp_import_runs (rule_id, kind) select id, kind from public.mcp_import_rules limit 1;   -- ERROR duplicate key (expected)
--   rollback;

-- ── ROLLBACK (M4-import; run by hand only) ──────────────────────────────────────────────────────────────────────
-- Undo imports in the app FIRST: the list of what each import inserted lives only in mcp_import_runs.inserted_ids, and
-- rows already imported stay in contacts / jobs / tasks after any rollback.
-- What this section added on top of M1's tables:
-- begin;
-- drop index if exists public.mcp_import_runs_one_running;
-- drop index if exists public.mcp_import_runs_started_idx;
-- alter table public.mcp_import_rules drop constraint if exists mcp_import_rules_json_shapes;
-- alter table public.mcp_import_runs drop constraint if exists mcp_import_runs_errors_arr;
-- alter table public.mcp_import_rules drop column if exists created_by;
-- alter table public.mcp_import_rules drop column if exists updated_at;
-- alter table public.mcp_import_runs drop column if exists rule_name;
-- alter table public.mcp_import_runs drop column if exists run_automations;
-- alter table public.mcp_import_runs drop column if exists started_by;
-- alter table public.mcp_import_runs drop column if exists undo_deleted;
-- alter table public.mcp_import_runs drop column if exists undo_kept;
-- commit;
-- Everything import-related (the M1 rollback does the same and more):
-- select cron.unschedule('mcp-import-hourly');
-- begin;
-- drop table if exists public.mcp_import_runs;
-- drop table if exists public.mcp_import_rules;
-- commit;
-- delete from vault.secrets where name = 'mcp_cron_secret';
-- And remove the Edge Function secret MCP_CRON_SECRET of the 'mcp' function in the Dashboard.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- END M4-import
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
