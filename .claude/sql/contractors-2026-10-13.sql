-- Contractors (Ofek 13 Oct, approved mockup): the suppliers table becomes "Contractors" in the app. Additive only.
-- Everyday details (services, what we agreed, insurance, agreement status) stay in suppliers, readable by everyone with
-- the Resources page (as today). ABN, bank and the agreement itself (text, signature, signing link) go in a new table
-- that only owners and managers can read, like the employees table.

alter table public.suppliers add column if not exists services text[] not null default '{}';
alter table public.suppliers add column if not exists deal jsonb not null default '{}'::jsonb;
alter table public.suppliers add column if not exists insurance jsonb not null default '{}'::jsonb;
alter table public.suppliers add column if not exists agreement_status text not null default 'none';
alter table public.suppliers add column if not exists agreement_signed_at timestamptz;
alter table public.suppliers add column if not exists agreement_signer text;
alter table public.suppliers add column if not exists created_at timestamptz not null default now();

create table if not exists public.contractor_private (
  supplier_id uuid primary key references public.suppliers(id) on delete cascade,
  legal_name text not null default '',
  abn text not null default '',
  bank_name text not null default '',
  bank_bsb text not null default '',
  bank_account text not null default '',
  agreement jsonb not null default '{}'::jsonb,
  sign_token text unique,
  sign_token_expires timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.contractor_private enable row level security;
create policy "contractor_private: owners and managers" on public.contractor_private for all
  using (is_owner_or_manager()) with check (is_owner_or_manager());
-- The signing page reaches this table only through the contractor-sign function (service role), by the link's token.
