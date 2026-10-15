-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- Stage 6: the AI assistant foundation (product name from branding; the gateway is supabase/functions/ai-gateway).
-- SHARED FILE: each group writes ONE clearly delimited, self-contained section (its own begin/commit, read-only checks
-- and commented ROLLBACK). Run each section on its own in the Supabase SQL editor, STAGING first (wblsrpmjiqwuxmrmuklc),
-- G1 first. Nothing in this file has been run by the builder: the owner / main builder runs it.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- Group G1-gateway: every stage-6 table, the gateway's helper functions and the 90-day chat prune timer.
-- Run BEFORE deploying ai-gateway. Safe to run again (idempotent). business_id on every table (SaaS rule 14 Oct).
--   ai_settings       one row per business: on/off, kill switch, roles, model per task, prices, cap, limits, provider
--   ai_usage          one row per chat turn (tokens + cost; NEVER message text)
--   ai_conversations  a person's chats (only that person reads them; owners too only their own)
--   ai_messages       the chat's turns exactly as sent to the model (only that person reads them)
--   ai_changes        proposed / confirmed / undone changes (owners read all, others their own)
-- Writes: ai_settings by owners from the app (RLS, listed columns only); everything else only by the gateway
-- (service role). A person may delete (and rename) their own conversations; messages go with them.
-- No secret is written here. ANTHROPIC_API_KEY is an Edge Function secret Ofek adds later; until then the
-- gateway runs on the built-in test provider ('mock').
-- Check before (read-only):
--   select to_regclass('public.ai_settings'), to_regclass('public.ai_usage'), to_regclass('public.ai_conversations'),
--          to_regclass('public.ai_messages'), to_regclass('public.ai_changes');                  -- all null the first time
--   select extname from pg_extension where extname = 'pg_cron';                                  -- 1 row
--   select jobname from cron.job where jobname = 'ai-prune-90d';                                 -- 0 rows the first time
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
begin;

create extension if not exists pg_cron;

-- 1. Settings, one row per business (seeded below; the app only updates it).
create table if not exists public.ai_settings (
  business_id text primary key default 'default',
  enabled boolean not null default true,
  kill_switch boolean not null default false,
  roles_enabled jsonb not null default '{"owner":true,"manager":true,"va":true,"technician":true,"marketing":true}'::jsonb
    check (jsonb_typeof(roles_enabled) = 'object'),
  model_per_task jsonb not null default '{"assistant":"claude-haiku-5-5","heavy":"claude-sonnet-5-5"}'::jsonb
    check (jsonb_typeof(model_per_task) = 'object'),
  prices jsonb not null default '{}'::jsonb check (jsonb_typeof(prices) = 'object'),   -- overrides over the gateway's PRICE_DEFAULTS (USD per MTok)
  monthly_cap_usd numeric(10,2) not null default 20 check (monthly_cap_usd >= 0 and monthly_cap_usd <= 10000),
  daily_user_limit integer not null default 50 check (daily_user_limit between 0 and 10000),
  max_tokens integer not null default 4096 check (max_tokens between 256 and 32000),
  alert_80_sent_month text check (alert_80_sent_month is null or alert_80_sent_month ~ '^[0-9]{4}-[0-9]{2}$'),
  provider text not null default 'mock' check (provider in ('anthropic', 'mock')),
  assistant_name text check (assistant_name is null or char_length(btrim(assistant_name)) between 1 and 40),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
insert into public.ai_settings (business_id) values ('default') on conflict (business_id) do nothing;

create or replace function public.ai_settings_touch() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.updated_at := now();
  if auth.uid() is not null then new.updated_by := auth.uid(); end if;
  return new;
end $$;
drop trigger if exists ai_settings_touch on public.ai_settings;
create trigger ai_settings_touch before update on public.ai_settings for each row execute function public.ai_settings_touch();

-- 2. Conversations and their messages. model is pinned when the chat starts (settings changes apply to new chats).
create table if not exists public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  user_id uuid not null references auth.users(id) on delete cascade,
  mode text not null default 'assistant' check (mode ~ '^[a-z][a-z0-9_]{0,40}$'),
  model text not null check (char_length(model) between 1 and 80),
  title text not null default '' check (char_length(title) <= 80),
  context jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object'),
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  message_count integer not null default 0,
  last_prompt_tokens integer not null default 0,
  busy_until timestamptz
);
create index if not exists ai_conversations_user_idx on public.ai_conversations (user_id, last_message_at desc);
create index if not exists ai_conversations_prune_idx on public.ai_conversations (last_message_at);

create table if not exists public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  seq integer not null,
  role text not null check (role in ('user', 'assistant', 'system')),
  content jsonb not null default '[]'::jsonb check (jsonb_typeof(content) = 'array'),   -- API blocks, replayed unchanged
  text text,                                                                          -- what the person sees (null = hidden turn)
  visible boolean not null default true,
  replay boolean not null default true,                                               -- false = display-only notice, never sent to the model
  meta jsonb not null default '{}'::jsonb check (jsonb_typeof(meta) = 'object'),
  created_at timestamptz not null default now(),
  unique (conversation_id, seq)
);
create index if not exists ai_messages_user_idx on public.ai_messages (user_id, created_at desc);

-- 3. Usage: one row per chat turn. No message text, ever.
create table if not exists public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  user_id uuid references auth.users(id) on delete set null,
  conversation_id uuid references public.ai_conversations(id) on delete set null,
  task text not null check (char_length(task) between 1 and 40),
  mode text not null default 'assistant' check (char_length(mode) between 1 and 40),
  model text not null check (char_length(model) between 1 and 80),
  provider text not null check (provider in ('anthropic', 'mock')),
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_creation_input_tokens integer not null default 0,
  cache_read_input_tokens integer not null default 0,
  cost_usd numeric(12,6) not null default 0 check (cost_usd >= 0),
  steps integer not null default 0,
  status text not null default 'running' check (status in ('running', 'ok', 'refusal', 'max_tokens', 'step_limit', 'cap', 'error', 'aborted')),
  at timestamptz not null default now()
);
create index if not exists ai_usage_business_at_idx on public.ai_usage (business_id, at);
create index if not exists ai_usage_user_at_idx on public.ai_usage (user_id, at);

-- 4. Changes the assistant proposed. Applied / undone by the gateway WITH THE PERSON'S OWN TOKEN (RLS applies).
create table if not exists public.ai_changes (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  user_id uuid references auth.users(id) on delete set null,
  conversation_id uuid references public.ai_conversations(id) on delete set null,
  kind text not null check (kind ~ '^[a-z][a-z0-9_]{0,40}$'),
  target jsonb not null default '{}'::jsonb check (jsonb_typeof(target) = 'object'),
  before jsonb,
  after jsonb,
  summary text not null check (char_length(summary) between 1 and 300),
  status text not null default 'proposed' check (status in ('proposed', 'confirmed', 'undone', 'cancelled', 'failed')),
  error text check (error is null or char_length(error) <= 300),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  undone_at timestamptz,
  undone_by uuid references auth.users(id) on delete set null
);
create index if not exists ai_changes_business_idx on public.ai_changes (business_id, created_at desc);
create index if not exists ai_changes_user_idx on public.ai_changes (user_id, created_at desc);
create index if not exists ai_changes_conversation_idx on public.ai_changes (conversation_id);

-- 5. Gateway helpers (service role only).
-- Starts a turn: counts the person's turns since the start of their business day and, under that person's lock, adds
-- the 'running' row only while they are below the limit (null = limit reached). The lock makes two taps count right.
create or replace function public.ai_usage_begin(p_business text, p_user uuid, p_conversation uuid, p_task text, p_mode text,
  p_model text, p_provider text, p_day_start timestamptz, p_limit integer) returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare n integer; new_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('ai_usage_begin:' || p_user::text, 0));
  select count(*) into n from public.ai_usage u where u.business_id = p_business and u.user_id = p_user and u.at >= p_day_start;
  if n >= greatest(coalesce(p_limit, 0), 0) then return null; end if;
  insert into public.ai_usage (business_id, user_id, conversation_id, task, mode, model, provider, status)
  values (p_business, p_user, p_conversation, p_task, p_mode, p_model, p_provider, 'running')
  returning id into new_id;
  return new_id;
end $$;

-- This month's spend (p_from = the start of the business's month, worked out by the gateway in the business time zone).
create or replace function public.ai_month_spend(p_business text, p_from timestamptz) returns numeric
language sql stable security definer set search_path = ''
as $$ select coalesce(sum(u.cost_usd), 0) from public.ai_usage u where u.business_id = p_business and u.at >= p_from $$;

-- The 80% alert, once a month: true only for the one call that marks this month (it then sends the notification).
create or replace function public.ai_claim_alert_80(p_business text, p_month text) returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare n integer;
begin
  update public.ai_settings set alert_80_sent_month = p_month
   where business_id = p_business and alert_80_sent_month is distinct from p_month;
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- Chats auto-delete 90 days after their last message (their messages go with them; usage rows and the change log stay,
-- their conversation_id cleared).
create or replace function public.ai_prune_conversations() returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare n integer;
begin
  delete from public.ai_conversations where last_message_at < now() - interval '90 days';
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.ai_settings_touch() from public, anon, authenticated;
revoke all on function public.ai_usage_begin(text, uuid, uuid, text, text, text, text, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.ai_month_spend(text, timestamptz) from public, anon, authenticated;
revoke all on function public.ai_claim_alert_80(text, text) from public, anon, authenticated;
revoke all on function public.ai_prune_conversations() from public, anon, authenticated;
grant execute on function public.ai_usage_begin(text, uuid, uuid, text, text, text, text, timestamptz, integer) to service_role;
grant execute on function public.ai_month_spend(text, timestamptz) to service_role;
grant execute on function public.ai_claim_alert_80(text, text) to service_role;
grant execute on function public.ai_prune_conversations() to service_role;

-- 6. Access.
--   ai_settings      owners read and change (listed columns only); everyone else asks the gateway (status step)
--   ai_usage         owners every row (the meter), others their own
--   ai_conversations ONLY the person's own: read, rename, delete (owners included: never other people's chats)
--   ai_messages      ONLY the person's own: read
--   ai_changes       owners every row (the change log), others their own
alter table public.ai_settings enable row level security;
alter table public.ai_usage enable row level security;
alter table public.ai_conversations enable row level security;
alter table public.ai_messages enable row level security;
alter table public.ai_changes enable row level security;

drop policy if exists "ai_settings: owners read" on public.ai_settings;
create policy "ai_settings: owners read" on public.ai_settings for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner'));
drop policy if exists "ai_settings: owners update" on public.ai_settings;
create policy "ai_settings: owners update" on public.ai_settings for update to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner'));
drop policy if exists "ai_usage: own or owner read" on public.ai_usage;
create policy "ai_usage: own or owner read" on public.ai_usage for select to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner'));
drop policy if exists "ai_conversations: own read" on public.ai_conversations;
create policy "ai_conversations: own read" on public.ai_conversations for select to authenticated using (user_id = auth.uid());
drop policy if exists "ai_conversations: own rename" on public.ai_conversations;
create policy "ai_conversations: own rename" on public.ai_conversations for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "ai_conversations: own delete" on public.ai_conversations;
create policy "ai_conversations: own delete" on public.ai_conversations for delete to authenticated using (user_id = auth.uid());
drop policy if exists "ai_messages: own read" on public.ai_messages;
create policy "ai_messages: own read" on public.ai_messages for select to authenticated using (user_id = auth.uid());
drop policy if exists "ai_changes: own or owner read" on public.ai_changes;
create policy "ai_changes: own or owner read" on public.ai_changes for select to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner'));

revoke all on public.ai_settings, public.ai_usage, public.ai_conversations, public.ai_messages, public.ai_changes from anon;
revoke all on public.ai_settings, public.ai_usage, public.ai_conversations, public.ai_messages, public.ai_changes from authenticated;
grant select on public.ai_settings, public.ai_usage, public.ai_conversations, public.ai_messages, public.ai_changes to authenticated;
grant update (enabled, kill_switch, roles_enabled, model_per_task, prices, monthly_cap_usd, daily_user_limit, max_tokens, provider, assistant_name)
  on public.ai_settings to authenticated;
grant update (title) on public.ai_conversations to authenticated;
grant delete on public.ai_conversations to authenticated;
grant all on public.ai_settings, public.ai_usage, public.ai_conversations, public.ai_messages, public.ai_changes to service_role;

-- 7. Timer: the 90-day chat prune, daily at 03:23 UTC.
do $$ begin
  if exists (select 1 from cron.job where jobname = 'ai-prune-90d') then perform cron.unschedule('ai-prune-90d'); end if;
end $$;
select cron.schedule('ai-prune-90d', '23 3 * * *', $job$ select public.ai_prune_conversations() $job$);

commit;
select 'G1-gateway ok';

-- Check after (read-only):
--   select table_name from information_schema.tables where table_schema = 'public' and table_name like 'ai\_%' order by 1;   -- 5 tables
--   select relname, relrowsecurity from pg_class where relname like 'ai\_%' and relkind = 'r';                               -- all true
--   select tablename, policyname, cmd from pg_policies where tablename like 'ai\_%' order by 1, 2;                           -- 9 policies
--   select business_id, enabled, provider, monthly_cap_usd, daily_user_limit from public.ai_settings;                       -- default | t | mock | 20.00 | 50
--   select column_name from information_schema.column_privileges where table_name = 'ai_settings' and grantee = 'authenticated'
--    and privilege_type = 'UPDATE' order by 1;                                                                             -- 10 columns, no alert_80_sent_month
--   select has_function_privilege('authenticated', 'public.ai_month_spend(text, timestamptz)', 'execute');                 -- false
--   select jobname, schedule from cron.job where jobname = 'ai-prune-90d';                                                   -- 23 3 * * *
--   select public.ai_prune_conversations();                                                                                 -- 0 on new tables
--   RLS proof on staging (two test users A and B, as each in the SQL editor's "run as" / or from the app):
--     as B: select count(*) from public.ai_messages where user_id = '<A>';            -- 0 (owners too)
--     as B: select count(*) from public.ai_conversations where user_id = '<A>';       -- 0 (owners too)
--     as owner: select count(*) from public.ai_changes;                                 -- every change; as B only B's
--     as B (not owner): update public.ai_settings set monthly_cap_usd = 999;            -- 0 rows

-- ── ROLLBACK (G1-gateway; run by hand only) ────────────────────────────────────────────────────────────────
-- Changes already confirmed stay: they are ordinary rows in their own tables.
-- select cron.unschedule('ai-prune-90d');
-- begin;
-- drop function if exists public.ai_prune_conversations();
-- drop function if exists public.ai_claim_alert_80(text, text);
-- drop function if exists public.ai_month_spend(text, timestamptz);
-- drop function if exists public.ai_usage_begin(text, uuid, uuid, text, text, text, text, timestamptz, integer);
-- drop trigger if exists ai_settings_touch on public.ai_settings;
-- drop function if exists public.ai_settings_touch();
-- drop table if exists public.ai_changes;
-- drop table if exists public.ai_usage;
-- drop table if exists public.ai_messages;
-- drop table if exists public.ai_conversations;
-- drop table if exists public.ai_settings;
-- commit;
-- And remove the 'ai-gateway' function (and the ANTHROPIC_API_KEY secret, if added) in the Dashboard.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- END G1-gateway
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
