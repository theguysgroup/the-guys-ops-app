-- conversations: tables for the website chat and customer texts (3 Oct 2026). Safe to run again.
create table if not exists public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null,
  contact_id uuid references public.contacts(id) on delete set null,
  first_name text, full_name text, phone text not null,
  service_key text, brand text, service_text text, first_message text, details text, page text,
  test boolean not null default false, ip_hash text,
  created_at timestamptz not null default now(),
  last_visitor_at timestamptz, last_staff_at timestamptz,
  alert_sent_at timestamptz, auto_sms_at timestamptz, auto_sms_kind text, auto_sms_skip text
);
create index if not exists chat_sessions_phone_idx on public.chat_sessions (phone, created_at);
create index if not exists chat_sessions_contact_idx on public.chat_sessions (contact_id, created_at);
create index if not exists chat_sessions_ip_idx on public.chat_sessions (ip_hash, created_at);
create index if not exists chat_sessions_due_idx on public.chat_sessions (created_at) where auto_sms_at is null and auto_sms_skip is null;
alter table public.chat_sessions enable row level security;
drop policy if exists "chat sessions: read if CRM" on public.chat_sessions;
create policy "chat sessions: read if CRM" on public.chat_sessions for select using (is_owner_or_manager() or can_view_section('crm'));

create table if not exists public.lead_messages (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references public.contacts(id) on delete cascade,
  session_id uuid references public.chat_sessions(id) on delete set null,
  channel text not null check (channel in ('chat', 'sms')),
  direction text not null check (direction in ('in', 'out')),
  body text not null,
  author text, author_id uuid,
  auto boolean not null default false,
  phone text, status text, provider_sid text, error text,
  at timestamptz not null default now()
);
create index if not exists lead_messages_contact_idx on public.lead_messages (contact_id, at);
create index if not exists lead_messages_session_idx on public.lead_messages (session_id, at);
create index if not exists lead_messages_phone_idx on public.lead_messages (phone, at);
create index if not exists lead_messages_sid_idx on public.lead_messages (provider_sid);
alter table public.lead_messages enable row level security;
drop policy if exists "lead messages: read if CRM" on public.lead_messages;
create policy "lead messages: read if CRM" on public.lead_messages for select using (is_owner_or_manager() or can_view_section('crm'));

create table if not exists public.sms_opt_outs (
  phone_key text primary key,
  phone text,
  at timestamptz not null default now(),
  source text
);
alter table public.sms_opt_outs enable row level security;
drop policy if exists "sms opt-outs: read if CRM" on public.sms_opt_outs;
create policy "sms opt-outs: read if CRM" on public.sms_opt_outs for select using (is_owner_or_manager() or can_view_section('crm'));

alter table public.settings add column if not exists chat_auto_sms boolean not null default false;
alter table public.chat_sessions add column if not exists alert_subject text;
alter table public.chat_sessions add column if not exists alert_body text;
alter table public.settings add column if not exists chat_tick_at timestamptz;

-- Ron's app sees new chat messages and texts live.
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'lead_messages') then
    alter publication supabase_realtime add table public.lead_messages;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'chat_sessions') then
    alter publication supabase_realtime add table public.chat_sessions;
  end if;
end $$;

-- The automatic-text check, every minute (pg_cron + pg_net). Does nothing while settings.chat_auto_sms is off.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('conversations-tick', '* * * * *', $job$select net.http_post(url := 'https://dszlllazwmllmoklzjwl.supabase.co/functions/v1/conversations?step=tick', headers := '{"Content-Type": "application/json"}'::jsonb, body := '{}'::jsonb)$job$);
