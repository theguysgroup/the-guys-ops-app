-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Round 3, T1.2 follow-up (15 Oct 2026): the office's shift clock follows the business's time zone.
-- set_phone_duty, set_phone_break and mark_logout wrote Sydney dates (today := now() at time zone 'Australia/Sydney').
-- They now use public.business_today() (round3-stage1.sql B1), like shift_events.day and auto_end_va_shifts() already do.
-- Only that one line changes in each body. ack_forgot_logout() has no date in it and stays as it is.
-- After this file the app can drop TZ_ALLOWED (any time zone).
--
-- Run as ONE block in the SQL editor: staging first, then live. Needs round3-stage1.sql (business_today()).
-- Idempotent: a function that already uses business_today() is skipped by the pre-check and rewritten to the same text.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
begin;

-- 0. Pre-check: each body is exactly the one read on 15 Oct (md5 of pg_get_functiondef), or already converted.
do $$
declare r record; cur text; src text;
begin
  if to_regprocedure('public.business_today()') is null then
    raise exception 'public.business_today() is missing: apply round3-stage1.sql first';
  end if;
  for r in select * from (values
      ('mark_logout',     'e3ee50cc1f13d1e1478f292cf55e64fd'),
      ('set_phone_break', '0d4b181ff627897ffd1f3b5cf92bc844'),
      ('set_phone_duty',  '77474e822211d358ee8f645b3a3d5e6e')) v(name, md5)
  loop
    select md5(pg_get_functiondef(p.oid)), p.prosrc into cur, src
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = r.name;
    if cur is null then raise exception '% is missing', r.name; end if;
    if position('business_today()' in src) > 0 then continue; end if;   -- already done
    if cur is distinct from r.md5 then
      raise exception '% changed since 15 Oct (md5 %): back it up and update this file and its ROLLBACK first', r.name, cur;
    end if;
  end loop;
end $$;

-- 1. Backup of the current bodies (only the not-yet-converted ones; a re-run keeps the first copy).
create schema if not exists backup;
create table if not exists backup.defs_before_t12_2026_10_15 (proname text primary key, def text not null, md5 text not null, saved_at timestamptz not null default now());
alter table backup.defs_before_t12_2026_10_15 enable row level security;
insert into backup.defs_before_t12_2026_10_15 (proname, def, md5)
select p.proname, pg_get_functiondef(p.oid), md5(pg_get_functiondef(p.oid))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('mark_logout', 'set_phone_break', 'set_phone_duty')
   and position('business_today()' in p.prosrc) = 0
on conflict (proname) do nothing;

-- 2. The three functions, each with its Sydney line replaced by the business's day.
CREATE OR REPLACE FUNCTION public.mark_logout()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare on_shift boolean; today date := public.business_today();
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select on_duty and on_duty_date = today into on_shift from public.profiles where id = auth.uid();
  if coalesce(on_shift, false) then perform public.set_phone_duty(false); end if;
  update public.profiles set last_logout_at = now() where id = auth.uid();
end $function$;

CREATE OR REPLACE FUNCTION public.set_phone_break(p_on boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare on_shift boolean; was_break boolean; today date := public.business_today();
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select on_duty and on_duty_date = today, on_break into on_shift, was_break from public.profiles where id = auth.uid();
  if p_on and not coalesce(on_shift, false) then raise exception 'start your shift first'; end if;
  if p_on is not distinct from coalesce(was_break, false) then return; end if;
  update public.profiles set on_break = p_on, on_break_since = case when p_on then now() else null end where id = auth.uid();
  insert into public.shift_events(profile_id, kind) values (auth.uid(), case when p_on then 'break_start' else 'break_end' end);
end $function$;

CREATE OR REPLACE FUNCTION public.set_phone_duty(p_on boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare was_on boolean; was_break boolean; was_day date; today date := public.business_today();
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select on_duty and on_duty_date = today, on_break into was_on, was_break from public.profiles where id = auth.uid();
  if not p_on and coalesce(was_break, false) then
    insert into public.shift_events(profile_id, kind) values (auth.uid(), 'break_end');
  end if;
  update public.profiles set on_duty = p_on, on_duty_date = today, on_duty_changed_at = now(),
    on_break = case when p_on then on_break and coalesce(was_on,false) else false end,
    on_break_since = case when p_on and coalesce(was_on,false) then on_break_since else null end
  where id = auth.uid();
  if p_on is distinct from coalesce(was_on, false) then
    insert into public.shift_events(profile_id, kind) values (auth.uid(), case when p_on then 'shift_start' else 'shift_end' end);
  end if;
end $function$;

commit;

-- 3. Checks (read-only). Expect: 3 rows, uses_business_today = true, sydney = false; the backup has 3 rows.
-- select p.proname, position('business_today()' in p.prosrc) > 0 as uses_business_today, p.prosrc ilike '%Australia/Sydney%' as sydney
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname in ('mark_logout', 'set_phone_break', 'set_phone_duty') order by 1;
-- select proname, md5, saved_at from backup.defs_before_t12_2026_10_15 order by 1;
-- And nothing else in public still says Sydney except business_tz()'s fallback and automation_settings.timezone's default:
-- select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosrc ilike '%Australia/Sydney%';

-- ROLLBACK (exact 15 Oct bodies; also kept in backup.defs_before_t12_2026_10_15). Run as one block; then put TZ_ALLOWED back
-- in index.html (const TZ_ALLOWED = [REGION_DEFAULTS.timeZone];) BEFORE anyone picks another zone.
-- begin;
-- CREATE OR REPLACE FUNCTION public.mark_logout()
--  RETURNS void
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public'
-- AS $function$
-- declare on_shift boolean; today date := (now() at time zone 'Australia/Sydney')::date;
-- begin
--   if auth.uid() is null then raise exception 'not signed in'; end if;
--   select on_duty and on_duty_date = today into on_shift from public.profiles where id = auth.uid();
--   if coalesce(on_shift, false) then perform public.set_phone_duty(false); end if;
--   update public.profiles set last_logout_at = now() where id = auth.uid();
-- end $function$;
-- CREATE OR REPLACE FUNCTION public.set_phone_break(p_on boolean)
--  RETURNS void
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public'
-- AS $function$
-- declare on_shift boolean; was_break boolean; today date := (now() at time zone 'Australia/Sydney')::date;
-- begin
--   if auth.uid() is null then raise exception 'not signed in'; end if;
--   select on_duty and on_duty_date = today, on_break into on_shift, was_break from public.profiles where id = auth.uid();
--   if p_on and not coalesce(on_shift, false) then raise exception 'start your shift first'; end if;
--   if p_on is not distinct from coalesce(was_break, false) then return; end if;
--   update public.profiles set on_break = p_on, on_break_since = case when p_on then now() else null end where id = auth.uid();
--   insert into public.shift_events(profile_id, kind) values (auth.uid(), case when p_on then 'break_start' else 'break_end' end);
-- end $function$;
-- CREATE OR REPLACE FUNCTION public.set_phone_duty(p_on boolean)
--  RETURNS void
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public'
-- AS $function$
-- declare was_on boolean; was_break boolean; was_day date; today date := (now() at time zone 'Australia/Sydney')::date;
-- begin
--   if auth.uid() is null then raise exception 'not signed in'; end if;
--   select on_duty and on_duty_date = today, on_break into was_on, was_break from public.profiles where id = auth.uid();
--   if not p_on and coalesce(was_break, false) then
--     insert into public.shift_events(profile_id, kind) values (auth.uid(), 'break_end');
--   end if;
--   update public.profiles set on_duty = p_on, on_duty_date = today, on_duty_changed_at = now(),
--     on_break = case when p_on then on_break and coalesce(was_on,false) else false end,
--     on_break_since = case when p_on and coalesce(was_on,false) then on_break_since else null end
--   where id = auth.uid();
--   if p_on is distinct from coalesce(was_on, false) then
--     insert into public.shift_events(profile_id, kind) values (auth.uid(), case when p_on then 'shift_start' else 'shift_end' end);
--   end if;
-- end $function$;
-- commit;
