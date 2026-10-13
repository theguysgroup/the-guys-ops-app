-- Organic dashboard (Ofek 13 Oct, plan E). Additive only: two new tables, no change to existing data.
-- organic_stats: Search Console / GA4 numbers per window (replaced every night) and the weekly map / AI check (kept per week).
-- seo_suggestions: improvement suggestions from the nightly rules and the SEO chat, with status.
-- Written by the ingest-ads-stats function (service role); read by owners and managers in the app.

create table if not exists public.organic_stats (
  id bigserial primary key,
  source text not null check (source in ('gsc', 'ga4', 'serp')),
  win text not null,
  level text not null,
  item text not null default '',
  item2 text not null default '',
  clicks numeric not null default 0,
  impressions numeric not null default 0,
  position numeric,
  extra jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists organic_stats_source_win_level on public.organic_stats (source, win, level);
alter table public.organic_stats enable row level security;
drop policy if exists "organic_stats: owners and managers read" on public.organic_stats;
create policy "organic_stats: owners and managers read" on public.organic_stats for select using (is_owner_or_manager());

create table if not exists public.seo_suggestions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  source text not null default 'seo_chat' check (source in ('nightly', 'seo_chat', 'owner')),
  dedupe_key text unique,
  surface text not null default 'search' check (surface in ('search', 'local', 'ai', 'site', 'content', 'tech')),
  page_url text,
  query text,
  issue_type text not null default 'other',
  title text not null,
  evidence jsonb not null default '{}'::jsonb,
  proposed_action text not null default '',
  expected_impact text,
  priority text not null default 'P2' check (priority in ('P0', 'P1', 'P2', 'P3')),
  status text not null default 'open' check (status in ('open', 'in_progress', 'done', 'rejected', 'resolved')),
  owner text,
  done_at timestamptz,
  done_by text,
  note text
);
create index if not exists seo_suggestions_status on public.seo_suggestions (status, priority);
alter table public.seo_suggestions enable row level security;
drop policy if exists "seo_suggestions: owners and managers read" on public.seo_suggestions;
create policy "seo_suggestions: owners and managers read" on public.seo_suggestions for select using (is_owner_or_manager());
drop policy if exists "seo_suggestions: owners and managers add" on public.seo_suggestions;
create policy "seo_suggestions: owners and managers add" on public.seo_suggestions for insert with check (is_owner_or_manager());
drop policy if exists "seo_suggestions: owners and managers update" on public.seo_suggestions;
create policy "seo_suggestions: owners and managers update" on public.seo_suggestions for update using (is_owner_or_manager()) with check (is_owner_or_manager());
-- No delete policy: a suggestion is closed with a status (done / not relevant), never deleted from the app.

-- Added after the first run (13 Oct): the upload function (service role) needs the row counter of organic_stats
-- (bigserial). ads_stats uses an identity column, which needs no such grant.
grant usage, select on sequence public.organic_stats_id_seq to service_role;
