CREATE OR REPLACE FUNCTION public.auto_end_va_shifts()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; n integer := 0; today date := (now() at time zone 'Australia/Sydney')::date; cut timestamptz; last_at timestamptz;
  -- the office's automatic log-out time: Settings → Security (settings.catalog.myday.autoLogout, "HH:MM"), 20:00 when not set
  logout_at time := coalesce((select case when s.catalog->'myday'->>'autoLogout' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then (s.catalog->'myday'->>'autoLogout')::time end from public.settings s where s.id = 1), time '20:00');
begin
  if (now() at time zone 'Australia/Sydney')::time < logout_at then return 0; end if;
  for r in select * from public.profiles where role = 'va' and on_duty and on_duty_date = today loop
    select max(at) into last_at from public.shift_events where profile_id = r.id and day = today;
    cut := greatest((today + time '17:30') at time zone 'Australia/Sydney', coalesce(last_at, '-infinity'::timestamptz));
    if r.on_break then insert into public.shift_events(profile_id, kind, at, day) values (r.id, 'break_end', cut, today); end if;
    insert into public.shift_events(profile_id, kind, at, day) values (r.id, 'shift_end', cut, today);
    update public.profiles set on_duty = false, on_break = false, on_break_since = null, on_duty_changed_at = now(),
      last_logout_at = cut, forgot_logout_on = today where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $function$;
