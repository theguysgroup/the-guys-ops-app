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
--   ai_messages       the chat's turns exactly as sent to the model (only that person reads them; content_raw = the JSON text)
-- Already ran G1 before the review fixes of 15 Oct? Run it again (idempotent): it adds ai_conversations.prefix_hash and
-- ai_messages.content_raw, which the gateway writes from then on.
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
  busy_until timestamptz,
  prefix_hash text check (prefix_hash is null or char_length(prefix_hash) <= 64)   -- system + tools fingerprint ('mixed' once it changed)
);
-- Review fixes (15 Oct): for a G1 that already ran, the columns added since (no-ops on a new table).
alter table public.ai_conversations add column if not exists prefix_hash text;
alter table public.ai_conversations drop constraint if exists ai_conversations_prefix_hash_check;
alter table public.ai_conversations add constraint ai_conversations_prefix_hash_check check (prefix_hash is null or char_length(prefix_hash) <= 64);
create index if not exists ai_conversations_user_idx on public.ai_conversations (user_id, last_message_at desc);
create index if not exists ai_conversations_prune_idx on public.ai_conversations (last_message_at);

create table if not exists public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  seq integer not null,
  role text not null check (role in ('user', 'assistant', 'system')),
  content jsonb not null default '[]'::jsonb check (jsonb_typeof(content) = 'array'),   -- API blocks (for queries; jsonb re-sorts keys)
  content_raw text,                                                                   -- the same blocks as the exact JSON sent: what is replayed
  text text,                                                                          -- what the person sees (null = hidden turn)
  visible boolean not null default true,
  replay boolean not null default true,                                               -- false = display-only (a notice, a refused turn), never sent to the model
  meta jsonb not null default '{}'::jsonb check (jsonb_typeof(meta) = 'object'),
  created_at timestamptz not null default now(),
  unique (conversation_id, seq)
);
alter table public.ai_messages add column if not exists content_raw text;   -- review fixes (15 Oct), for a G1 that already ran
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
--   select table_name, column_name from information_schema.columns where table_schema = 'public'
--    and column_name in ('prefix_hash', 'content_raw') order by 1;                     -- ai_conversations.prefix_hash, ai_messages.content_raw
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


-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- Group G2-changes: the assistant's compare-and-set writers (stage 6 spec §3) and the change card's display column.
-- The ai-gateway function calls these with the SIGNED-IN PERSON'S token (a Supabase client carrying their Authorization
-- header), and they are SECURITY INVOKER, so every RLS rule on settings / contacts / tasks applies exactly as when the
-- person edits in the app. Each one locks the row, compares the fields the change touches with what the person was
-- shown (the optimistic lock: these tables have no updated_at), then writes atomically (a lead's messages / notes are
-- appended or filtered in place, so a customer message or another note arriving meanwhile is never lost). Only fixed
-- sections / columns can be written: catalog 'hours'; a lead's stage fields and contacted_at; deleting a task.
-- Run AFTER the G1-gateway section, STAGING first (wblsrpmjiqwuxmrmuklc). Safe to run again (create or replace).
-- Check before (read-only):
--   select table_name, column_name, data_type from information_schema.columns where table_schema = 'public'
--     and ((table_name = 'contacts' and column_name in ('id','status','stage_changed_at','next_follow_up','chasing_since',
--            'chase_alert_done','chase_round','lost_reason','booked_for','contacted_at','messages','customer_notes'))
--       or (table_name = 'tasks' and column_name in ('id','title','status','due','board','assignees','priority','notes',
--            'subtasks','updates','contact_id','heads_up'))
--       or (table_name = 'settings' and column_name in ('id','catalog')))
--    order by 1, 2;   -- expect: contacts.id / tasks.id uuid, messages / customer_notes / subtasks / updates jsonb,
--                     -- settings.catalog jsonb (if an id is not uuid, change p_id's type below to match before running)
--   select tablename, policyname, cmd, roles, qual, with_check from pg_policies
--    where schemaname = 'public' and tablename in ('settings','contacts','tasks','activity_log') order by 1, 3;
--                     -- the rules the assistant's writes run under (copy them into the PR)
--   select to_regclass('public.ai_changes');   -- not null (G1 ran)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
begin;

-- 0. What the change card shows ({ title, rows: [{ label, before, after }] }, display strings), written with the proposal.
alter table public.ai_changes add column if not exists display jsonb;
alter table public.ai_changes drop constraint if exists ai_changes_display_check;
alter table public.ai_changes add constraint ai_changes_display_check check (display is null or jsonb_typeof(display) = 'object');

-- 1. One catalog section (only 'hours' in stage 6), replaced only if it is still what the person was shown.
--    p_value null = remove the key (back to the app's defaults).
--    Returns {ok, value} | {ok:false, code:'changed', now} | {ok:false, code:'denied'}.
create or replace function public.ai_catalog_cas(p_section text, p_expected jsonb, p_value jsonb) returns jsonb
language plpgsql volatile security invoker set search_path = ''
as $$
declare cur jsonb; n integer;
begin
  if p_section is distinct from 'hours' then
    raise exception 'ai_catalog_cas: % is not a section the assistant changes', p_section;
  end if;
  if p_expected = 'null'::jsonb then p_expected := null; end if;
  if p_value = 'null'::jsonb then p_value := null; end if;
  select s.catalog -> p_section into cur from public.settings s where s.id = 1 for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'denied'); end if;
  if cur = 'null'::jsonb then cur := null; end if;
  if cur is distinct from p_expected then
    return jsonb_build_object('ok', false, 'code', 'changed', 'now', cur);
  end if;
  update public.settings s
     set catalog = case when p_value is null then coalesce(s.catalog, '{}'::jsonb) - p_section
                        else pg_catalog.jsonb_set(coalesce(s.catalog, '{}'::jsonb), array[p_section], p_value, true) end
   where s.id = 1;
  get diagnostics n = row_count;
  if n = 0 then return jsonb_build_object('ok', false, 'code', 'denied'); end if;
  return jsonb_build_object('ok', true, 'value', p_value);
end $$;

-- 2. A lead: the stage fields (and contacted_at) only, plus an appended thread event and an added / removed note.
--    p_expected: the columns as the person was shown them (compared after casting to the column types; a key left out
--    is not compared). Returns {ok, row: the allowlisted columns + id} | {ok:false, code:'gone'|'changed'|'denied',
--    field?, now?}.
create or replace function public.ai_contact_cas(p_id uuid, p_expected jsonb, p_patch jsonb,
  p_event jsonb default null, p_note_add jsonb default null, p_note_remove jsonb default null) returns jsonb
language plpgsql volatile security invoker set search_path = ''
as $$
declare
  allowed constant text[] := array['status','stage_changed_at','next_follow_up','chasing_since','chase_alert_done',
                                   'chase_round','lost_reason','booked_for','contacted_at'];
  cur jsonb; base jsonb; exp jsonb; k text; n integer; out_row jsonb;
begin
  if p_patch = 'null'::jsonb then p_patch := null; end if;
  if p_expected = 'null'::jsonb then p_expected := null; end if;
  if p_event = 'null'::jsonb then p_event := null; end if;
  if p_note_add = 'null'::jsonb then p_note_add := null; end if;
  if p_note_remove = 'null'::jsonb then p_note_remove := null; end if;
  if jsonb_typeof(coalesce(p_patch, '{}'::jsonb)) <> 'object' or jsonb_typeof(coalesce(p_expected, '{}'::jsonb)) <> 'object' then
    raise exception 'ai_contact_cas: patch and expected must be objects';
  end if;
  for k in select pg_catalog.jsonb_object_keys(coalesce(p_patch, '{}'::jsonb) || coalesce(p_expected, '{}'::jsonb)) loop
    if not (k = any(allowed)) then raise exception 'ai_contact_cas: % is not a field the assistant changes', k; end if;
  end loop;
  select to_jsonb(c) into cur from public.contacts c where c.id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'gone'); end if;
  exp := to_jsonb(pg_catalog.jsonb_populate_record(null::public.contacts, coalesce(p_expected, '{}'::jsonb)));
  for k in select pg_catalog.jsonb_object_keys(coalesce(p_expected, '{}'::jsonb)) loop
    if (cur -> k) is distinct from (exp -> k) then
      return jsonb_build_object('ok', false, 'code', 'changed', 'field', k, 'now', cur -> k);
    end if;
  end loop;
  if p_note_remove is not null and not exists (
       select 1 from pg_catalog.jsonb_array_elements(case when jsonb_typeof(cur -> 'customer_notes') = 'array'
                                                          then cur -> 'customer_notes' else '[]'::jsonb end) e
        where e = p_note_remove) then
    return jsonb_build_object('ok', false, 'code', 'changed', 'field', 'customer_notes');
  end if;
  -- only the allowlisted columns go through jsonb_populate_record (the others are never parsed or written)
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into base from pg_catalog.jsonb_each(cur) e where e.key = any(allowed);
  base := base || coalesce(p_patch, '{}'::jsonb);
  update public.contacts c set
    (status, stage_changed_at, next_follow_up, chasing_since, chase_alert_done, chase_round, lost_reason, booked_for, contacted_at) =
      (select r.status, r.stage_changed_at, r.next_follow_up, r.chasing_since, r.chase_alert_done, r.chase_round,
              r.lost_reason, r.booked_for, r.contacted_at
         from pg_catalog.jsonb_populate_record(null::public.contacts, base) r),
    messages = case when p_event is null then c.messages
                    else (case when jsonb_typeof(c.messages) = 'array' then c.messages else '[]'::jsonb end) || jsonb_build_array(p_event) end,
    customer_notes = case
      when p_note_add is not null then
        (case when jsonb_typeof(c.customer_notes) = 'array' then c.customer_notes else '[]'::jsonb end) || jsonb_build_array(p_note_add)
      when p_note_remove is not null then
        (select coalesce(jsonb_agg(x.e order by x.i), '[]'::jsonb)
           from pg_catalog.jsonb_array_elements(c.customer_notes) with ordinality x(e, i) where x.e <> p_note_remove)
      else c.customer_notes end
  where c.id = p_id
  returning to_jsonb(c.*) into out_row;
  get diagnostics n = row_count;
  if n = 0 then return jsonb_build_object('ok', false, 'code', 'denied'); end if;
  return jsonb_build_object('ok', true, 'row',
    (select jsonb_object_agg(e.key, e.value) from pg_catalog.jsonb_each(out_row) e where e.key = any(allowed || array['id'])));
end $$;

-- 3. Undo of a task the assistant added: deleted only if it is still exactly as it was added.
--    Returns {ok} | {ok:false, code:'gone'|'changed'|'denied', field?, now?}.
create or replace function public.ai_task_delete_cas(p_id uuid, p_expected jsonb) returns jsonb
language plpgsql volatile security invoker set search_path = ''
as $$
declare
  allowed constant text[] := array['title','status','due','board','assignees','priority','notes','subtasks','updates',
                                   'contact_id','heads_up'];
  cur jsonb; exp jsonb; k text; n integer;
begin
  if p_expected = 'null'::jsonb then p_expected := null; end if;
  if jsonb_typeof(coalesce(p_expected, '{}'::jsonb)) <> 'object' then raise exception 'ai_task_delete_cas: expected must be an object'; end if;
  for k in select pg_catalog.jsonb_object_keys(coalesce(p_expected, '{}'::jsonb)) loop
    if not (k = any(allowed)) then raise exception 'ai_task_delete_cas: % is not a compared field', k; end if;
  end loop;
  select to_jsonb(t) into cur from public.tasks t where t.id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'gone'); end if;
  exp := to_jsonb(pg_catalog.jsonb_populate_record(null::public.tasks, coalesce(p_expected, '{}'::jsonb)));
  for k in select pg_catalog.jsonb_object_keys(coalesce(p_expected, '{}'::jsonb)) loop
    if (cur -> k) is distinct from (exp -> k) then
      return jsonb_build_object('ok', false, 'code', 'changed', 'field', k, 'now', cur -> k);
    end if;
  end loop;
  delete from public.tasks t where t.id = p_id;
  get diagnostics n = row_count;
  if n = 0 then return jsonb_build_object('ok', false, 'code', 'denied'); end if;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.ai_catalog_cas(text, jsonb, jsonb) from public, anon;
revoke all on function public.ai_contact_cas(uuid, jsonb, jsonb, jsonb, jsonb, jsonb) from public, anon;
revoke all on function public.ai_task_delete_cas(uuid, jsonb) from public, anon;
-- Invoker functions: a signed-in person can only do through them what their RLS already lets them do through the API.
grant execute on function public.ai_catalog_cas(text, jsonb, jsonb) to authenticated;
grant execute on function public.ai_contact_cas(uuid, jsonb, jsonb, jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.ai_task_delete_cas(uuid, jsonb) to authenticated;

commit;
select 'G2-changes ok';

-- Check after (read-only):
--   select proname, prosecdef from pg_proc where proname in ('ai_catalog_cas','ai_contact_cas','ai_task_delete_cas');
--     -- 3 rows, prosecdef = false (SECURITY INVOKER)
--   select column_name, data_type from information_schema.columns where table_name = 'ai_changes' and column_name = 'display';   -- jsonb
--   The RLS proof runs from the app / the gateway (the SQL editor runs as postgres and bypasses RLS): an owner's
--   ai_catalog_cas('hours', <current hours>, <current hours>) → {"ok": true, ...} and nothing changes; a non-owner's →
--   {"ok": false, "code": "denied"} (when settings UPDATE is owners-only; see the pg_policies check above).

-- ── ROLLBACK (G2-changes; run by hand only) ──────────────────────────────────────────────────────────────────
-- Data the assistant already changed stays as it is (ordinary rows); the change log keeps its rows.
-- begin;
-- drop function if exists public.ai_task_delete_cas(uuid, jsonb);
-- drop function if exists public.ai_contact_cas(uuid, jsonb, jsonb, jsonb, jsonb, jsonb);
-- drop function if exists public.ai_catalog_cas(text, jsonb, jsonb);
-- alter table public.ai_changes drop constraint if exists ai_changes_display_check;
-- alter table public.ai_changes drop column if exists display;
-- commit;
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- END G2-changes
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
