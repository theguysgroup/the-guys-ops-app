-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- G7 · item 3 + P10 (Ofek 13 Oct): the office assistant's automatic log-out, PER PERSON.
-- Replaces the live public.auto_end_va_shifts() (exact live copy: .claude/backups/auto_end_va_shifts.live_2026-10-12.sql,
-- repeated in the ROLLBACK block below). Same signature, same pg_cron job (every 10 minutes); no table changes.
--
-- Settings (written by the app, Settings → People → a VA's card): settings.catalog.myday.people[<profile id>] = { "logoutAt": "HH:MM", "endAt": "HH:MM" }.
--   logoutAt: their own → the old office-wide catalog.myday.autoLogout → 22:00; never later than 23:30 (the last runs are 23:40/23:50).
--   endAt:    their own → 17:30; never later than logoutAt.
-- Recorded end = the later of endAt and the VA's OWN last action today, never later than now. Their own actions only:
--   shift_events (profile_id); activity_log rows whose actor is their full name (the app writes the signed-in user's name, and
--   View-as / Presentation mode can't write); lead_messages they sent (author_id, not automatic); outbound calls from their
--   browser phone (calls.created_by = 'office-<id>', by calls.started_at). Answered inbound calls are not per person, so they are not used.
-- Safe every 10 minutes and idempotent: a VA is handled once (on_duty becomes false; the update re-checks it).
-- An optional source that can't be read only logs a warning; the log-out still happens (as before, from the shift clock).
--
-- Read-only checks for Ofek BEFORE applying (they change nothing):
--   select schedule, command from cron.job where command ilike '%auto_end_va_shifts%';   -- expect */10 * * * *
--   select catalog->'myday' from public.settings where id = 1;                           -- an old autoLogout here is the fallback
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.auto_end_va_shifts()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  r record; n integer := 0;
  today date := (now() at time zone 'Australia/Sydney')::date;
  now_wall time := (now() at time zone 'Australia/Sydney')::time;
  day_start timestamptz := (today + time '00:00') at time zone 'Australia/Sydney';
  hhmm constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
  myday jsonb := coalesce((select s.catalog->'myday' from public.settings s where s.id = 1), '{}'::jsonb);
  office_logout time; person jsonb; logout_at time; end_at time;
  last_at timestamptz; t timestamptz; cut timestamptz;
begin
  -- the old office-wide time (Settings → Security until 13 Oct) for anyone without their own, else 22:00
  office_logout := case when myday->>'autoLogout' ~ hhmm then (myday->>'autoLogout')::time else time '22:00' end;
  for r in select * from public.profiles where role = 'va' and on_duty and on_duty_date = today loop
    person := case when jsonb_typeof(myday->'people'->(r.id::text)) = 'object' then myday->'people'->(r.id::text) else '{}'::jsonb end;
    logout_at := least(case when person->>'logoutAt' ~ hhmm then (person->>'logoutAt')::time else office_logout end, time '23:30');
    end_at := least(case when person->>'endAt' ~ hhmm then (person->>'endAt')::time else time '17:30' end, logout_at);
    continue when now_wall < logout_at;

    -- the VA's OWN last action today (never someone else's)
    select max(e.at) into last_at from public.shift_events e where e.profile_id = r.id and e.day = today;
    begin
      -- by name (P10); skipped when another profile has the same name, so nobody else's action can count
      if coalesce(btrim(r.full_name), '') <> ''
         and not exists (select 1 from public.profiles o where o.id <> r.id and o.full_name = r.full_name) then
        select max(a.at) into t from public.activity_log a
          where a.actor = r.full_name and a.at >= day_start and a.at <= now();
        last_at := greatest(last_at, t);
      end if;
    exception when others then raise warning 'auto_end_va_shifts: activity_log skipped for %: %', r.id, sqlerrm;
    end;
    begin
      select max(m.at) into t from public.lead_messages m
        where m.author_id::text = r.id::text and m.direction = 'out' and m.auto is not true and m.at >= day_start and m.at <= now();
      last_at := greatest(last_at, t);
    exception when others then raise warning 'auto_end_va_shifts: lead_messages skipped for %: %', r.id, sqlerrm;
    end;
    begin
      -- calls has started_at (no created_at column: checked against the live schema 13 Oct)
      select max(c.started_at) into t from public.calls c
        where c.direction = 'outbound' and c.created_by = 'office-' || r.id::text and c.started_at >= day_start and c.started_at <= now();
      last_at := greatest(last_at, t);
    exception when others then raise warning 'auto_end_va_shifts: calls skipped for %: %', r.id, sqlerrm;
    end;

    -- greatest() ignores nulls: with no action today the end is their set time
    cut := least(greatest((today + end_at) at time zone 'Australia/Sydney', last_at), now());
    update public.profiles set on_duty = false, on_break = false, on_break_since = null, on_duty_changed_at = now(),
      last_logout_at = cut, forgot_logout_on = today
      where id = r.id and on_duty and on_duty_date = today;
    continue when not found;  -- they logged out themselves in the meantime
    if r.on_break then insert into public.shift_events(profile_id, kind, at, day) values (r.id, 'break_end', cut, today); end if;
    insert into public.shift_events(profile_id, kind, at, day) values (r.id, 'shift_end', cut, today);
    n := n + 1;
  end loop;
  return n;
end $function$;

-- ROLLBACK (G7): restores the live version of 12 Oct exactly (one office-wide time, 20:00 default, end 17:30) ──────────
-- CREATE OR REPLACE FUNCTION public.auto_end_va_shifts()
--  RETURNS integer
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public'
-- AS $function$
-- declare r record; n integer := 0; today date := (now() at time zone 'Australia/Sydney')::date; cut timestamptz; last_at timestamptz;
--   -- the office's automatic log-out time: Settings → Security (settings.catalog.myday.autoLogout, "HH:MM"), 20:00 when not set
--   logout_at time := coalesce((select case when s.catalog->'myday'->>'autoLogout' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then (s.catalog->'myday'->>'autoLogout')::time end from public.settings s where s.id = 1), time '20:00');
-- begin
--   if (now() at time zone 'Australia/Sydney')::time < logout_at then return 0; end if;
--   for r in select * from public.profiles where role = 'va' and on_duty and on_duty_date = today loop
--     select max(at) into last_at from public.shift_events where profile_id = r.id and day = today;
--     cut := greatest((today + time '17:30') at time zone 'Australia/Sydney', coalesce(last_at, '-infinity'::timestamptz));
--     if r.on_break then insert into public.shift_events(profile_id, kind, at, day) values (r.id, 'break_end', cut, today); end if;
--     insert into public.shift_events(profile_id, kind, at, day) values (r.id, 'shift_end', cut, today);
--     update public.profiles set on_duty = false, on_break = false, on_break_since = null, on_duty_changed_at = now(),
--       last_logout_at = cut, forgot_logout_on = today where id = r.id;
--     n := n + 1;
--   end loop;
--   return n;
-- end $function$;
-- ═══ end G7 ═══
