-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- round3-stage1.sql · group B-region (Ofek 14 Oct, T1.2 time zone + T1.3 public holidays). NOT APPLIED.
-- B1 public.business_tz() / public.business_today(): the business's time zone from Settings → Region and format
--    (settings.catalog.region.timeZone; Australia/Sydney while it is not set or not a zone Postgres knows).
-- B2 shift_events.day default → public.business_today() (only when the live default is the expected Sydney one).
-- B3 auto_end_va_shifts(): the live G7 version (.claude/sql/settings-round2-phase1.sql lines 20–81) in the business's
--    time zone: only the four 'Australia/Sydney' literals become the tz variable. Tomer's Stage 3 ('On vacation') changes the
--    same function: whichever is applied second must be merged onto the other's body, never overwrite it.
-- B4 settings.catalog.holidays: the stored public holidays of the default region (AU-NSW, 2026–2028, from date-holidays@3.37.0;
--    2026–27 identical to the NSW_HOLIDAYS lists the app, automations and conversations had written in), so the app and the
--    functions keep the same days off from the first minute. Only added when nothing is stored yet.
-- B5 public.set_catalog_holidays(jsonb): the automations timer saves a freshly worked-out holiday list (only that key).
-- Idempotent. No secrets. No new tables (everything stays in settings.catalog), so no RLS change.
--
-- ORDER (staging first, then live): 1. this SQL  2. deploy the functions (automations, backup, conversations, push,
-- review-requests, voice, ingest-ads-stats, contractor-sign)  3. push the app. The SQL MUST go first: it stores
-- catalog.holidays, and without it the new code treats a saved hours.nsw = true as "no public holidays" (the office would
-- look open on public holidays until an owner opens the app).
--
-- Read-only checks BEFORE applying (they change nothing). Save the first two outputs to
-- .claude/backups/round3-b-region.live_<date>.sql. If either differs from what this file expects, STOP and update the
-- block and its ROLLBACK first:
--   select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
--     where d.adrelid = 'public.shift_events'::regclass and a.attname = 'day';
--       -- expected: ((now() AT TIME ZONE 'Australia/Sydney'::text))::date
--   select pg_get_functiondef('public.auto_end_va_shifts()'::regprocedure);
--       -- expected: the G7 body of .claude/sql/settings-round2-phase1.sql (lines 20–81)
--   select timezone from public.automation_settings;                                   -- expected: Australia/Sydney
--   select catalog->'region', catalog->'hours'->'nsw', catalog ? 'holidays' from public.settings where id = 1;
--       -- expected: null (no region yet), the saved switch, false
--   select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public' and pg_get_functiondef(p.oid) ilike '%Australia/Sydney%';
--       -- every OTHER SQL function still on Sydney (expect set_phone_duty, set_phone_break, mark_logout,
--       -- ack_forgot_logout…). They write profiles.on_duty_date / forgot_logout_on / shift_events.day in Sydney's day,
--       -- while B2/B3, the app and the functions read the business's day. Their live definitions are NOT in the repo, so
--       -- they are not converted here: save each pg_get_functiondef output to .claude/backups/ and convert them in a
--       -- separate group (each with its exact ROLLBACK). Until that group is applied the app only lets an owner save
--       -- Australia/Sydney as the time zone (TZ_ALLOWED in index.html), so business_tz() stays Sydney and B2/B3 behave
--       -- exactly like today. Do NOT set catalog.region.timeZone to another zone by hand (not even on staging) before then.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
begin;

-- B1. The business's time zone and today in it. A name Postgres doesn't know falls back to Sydney.
create or replace function public.business_tz()
 returns text
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare tz text;
begin
  select nullif(btrim(s.catalog->'region'->>'timeZone'), '') into tz from public.settings s where s.id = 1;
  if tz is null then return 'Australia/Sydney'; end if;
  perform now() at time zone tz;   -- an unknown zone raises here
  return tz;
exception when others then
  return 'Australia/Sydney';
end $function$;

create or replace function public.business_today()
 returns date
 language sql
 stable
 set search_path to 'public'
as $function$ select (now() at time zone public.business_tz())::date $function$;

-- B2. shift_events.day: the business's day, not always Sydney's. Changed only from the expected Sydney expression,
--     so the ROLLBACK below is exact; anything else stops the whole file.
do $$
declare cur text;
begin
  select pg_get_expr(d.adbin, d.adrelid) into cur
    from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = 'public.shift_events'::regclass and a.attname = 'day';
  if cur in ('business_today()', 'public.business_today()') then return; end if;   -- already done
  if cur is distinct from '((now() AT TIME ZONE ''Australia/Sydney''::text))::date' then
    raise exception 'shift_events.day default is %, not the expected Sydney expression: back it up and update B2 and its ROLLBACK first', coalesce(cur, '(none)');
  end if;
  alter table public.shift_events alter column day set default public.business_today();
end $$;

-- B3. The office's automatic log-out (G7, per person), in the business's time zone. Only the four
--     'Australia/Sydney' literals change (now the tz variable); everything else is the live G7 text.
create or replace function public.auto_end_va_shifts()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  r record; n integer := 0;
  tz text := public.business_tz();
  today date := (now() at time zone tz)::date;
  now_wall time := (now() at time zone tz)::time;
  day_start timestamptz := (today + time '00:00') at time zone tz;
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
    cut := least(greatest((today + end_at) at time zone tz, last_at), now());
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

-- B4. The stored public holidays of the default region (39 days; only when none are stored yet). Used only while
--     catalog.hours.publicOn (or the old catalog.hours.nsw) is on and the region is still AU-NSW. The app works the list
--     out again by itself (an owner's session) when it covers under a year or the region changes.
update public.settings
   set catalog = jsonb_set(coalesce(catalog, '{}'::jsonb), '{holidays}', $json${"region":"AU-NSW","source":"date-holidays@3.37.0","generatedAt":"2026-10-15T00:00:00.000Z","from":"2026-01-01","to":"2028-12-31","days":{"2026-01-01":"New Year's Day","2026-01-26":"Australia Day","2026-04-03":"Good Friday","2026-04-04":"Easter Saturday","2026-04-05":"Easter Sunday","2026-04-06":"Easter Monday","2026-04-25":"Anzac Day","2026-04-27":"Anzac Day (additional day)","2026-06-08":"King's Birthday","2026-10-05":"Labour Day","2026-12-25":"Christmas Day","2026-12-26":"Boxing Day","2026-12-28":"Boxing Day (additional day)","2027-01-01":"New Year's Day","2027-01-26":"Australia Day","2027-03-26":"Good Friday","2027-03-27":"Easter Saturday","2027-03-28":"Easter Sunday","2027-03-29":"Easter Monday","2027-04-25":"Anzac Day","2027-04-26":"Anzac Day (additional day)","2027-06-14":"King's Birthday","2027-10-04":"Labour Day","2027-12-25":"Christmas Day","2027-12-26":"Boxing Day","2027-12-27":"Christmas Day (additional day)","2027-12-28":"Boxing Day (additional day)","2028-01-01":"New Year's Day","2028-01-03":"New Year's Day","2028-01-26":"Australia Day","2028-04-14":"Good Friday","2028-04-15":"Easter Saturday","2028-04-16":"Easter Sunday","2028-04-17":"Easter Monday","2028-04-25":"Anzac Day","2028-06-12":"King's Birthday","2028-10-02":"Labour Day","2028-12-25":"Christmas Day","2028-12-26":"Boxing Day"}}$json$::jsonb, true)
 where id = 1 and not (coalesce(catalog, '{}'::jsonb) ? 'holidays');

-- B5. The automations timer keeps the stored holidays up to date when no owner opens the app (T1.3): it saves ONLY
--     catalog.holidays, so an owner's other settings are never overwritten. New function (nothing to back up); only the
--     service role (the edge function) may run it.
create or replace function public.set_catalog_holidays(p_holidays jsonb)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if jsonb_typeof(p_holidays) is distinct from 'object' or jsonb_typeof(p_holidays->'days') is distinct from 'object'
     or coalesce(p_holidays->>'region', '') = '' then
    raise exception 'set_catalog_holidays: not a holiday list';
  end if;
  update public.settings set catalog = jsonb_set(coalesce(catalog, '{}'::jsonb), '{holidays}', p_holidays, true) where id = 1;
end $function$;
revoke all on function public.set_catalog_holidays(jsonb) from public, anon, authenticated;
grant execute on function public.set_catalog_holidays(jsonb) to service_role;

commit;

-- Read-only checks AFTER applying:
--   select public.business_tz(), public.business_today();                                   -- Australia/Sydney, Sydney's date
--   select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
--     where d.adrelid = 'public.shift_events'::regclass and a.attname = 'day';               -- business_today()
--   select catalog->'holidays'->>'region', (select count(*) from jsonb_object_keys(catalog->'holidays'->'days'))
--     from public.settings where id = 1;                                                     -- AU-NSW, 39
--   select has_function_privilege('authenticated', 'public.set_catalog_holidays(jsonb)', 'execute');   -- false
--   select public.auto_end_va_shifts();   -- ONLY if Ofek agrees: it can log a VA out (same as the 10-minute cron would)

-- ROLLBACK (B-region), in this order ───────────────────────────────────────────────────────────────────────────────
-- 1. shift_events.day back to Sydney (B2 only ran when the live default was exactly this):
-- alter table public.shift_events alter column day set default ((now() AT TIME ZONE 'Australia/Sydney'::text))::date;
--
-- 2. auto_end_va_shifts() back to the live G7 text (.claude/sql/settings-round2-phase1.sql lines 20–81):
-- create or replace function public.auto_end_va_shifts()
--  returns integer
--  language plpgsql
--  security definer
--  set search_path to 'public'
-- as $function$
-- declare
--   r record; n integer := 0;
--   today date := (now() at time zone 'Australia/Sydney')::date;
--   now_wall time := (now() at time zone 'Australia/Sydney')::time;
--   day_start timestamptz := (today + time '00:00') at time zone 'Australia/Sydney';
--   hhmm constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
--   myday jsonb := coalesce((select s.catalog->'myday' from public.settings s where s.id = 1), '{}'::jsonb);
--   office_logout time; person jsonb; logout_at time; end_at time;
--   last_at timestamptz; t timestamptz; cut timestamptz;
-- begin
--   -- the old office-wide time (Settings → Security until 13 Oct) for anyone without their own, else 22:00
--   office_logout := case when myday->>'autoLogout' ~ hhmm then (myday->>'autoLogout')::time else time '22:00' end;
--   for r in select * from public.profiles where role = 'va' and on_duty and on_duty_date = today loop
--     person := case when jsonb_typeof(myday->'people'->(r.id::text)) = 'object' then myday->'people'->(r.id::text) else '{}'::jsonb end;
--     logout_at := least(case when person->>'logoutAt' ~ hhmm then (person->>'logoutAt')::time else office_logout end, time '23:30');
--     end_at := least(case when person->>'endAt' ~ hhmm then (person->>'endAt')::time else time '17:30' end, logout_at);
--     continue when now_wall < logout_at;
--
--     -- the VA's OWN last action today (never someone else's)
--     select max(e.at) into last_at from public.shift_events e where e.profile_id = r.id and e.day = today;
--     begin
--       -- by name (P10); skipped when another profile has the same name, so nobody else's action can count
--       if coalesce(btrim(r.full_name), '') <> ''
--          and not exists (select 1 from public.profiles o where o.id <> r.id and o.full_name = r.full_name) then
--         select max(a.at) into t from public.activity_log a
--           where a.actor = r.full_name and a.at >= day_start and a.at <= now();
--         last_at := greatest(last_at, t);
--       end if;
--     exception when others then raise warning 'auto_end_va_shifts: activity_log skipped for %: %', r.id, sqlerrm;
--     end;
--     begin
--       select max(m.at) into t from public.lead_messages m
--         where m.author_id::text = r.id::text and m.direction = 'out' and m.auto is not true and m.at >= day_start and m.at <= now();
--       last_at := greatest(last_at, t);
--     exception when others then raise warning 'auto_end_va_shifts: lead_messages skipped for %: %', r.id, sqlerrm;
--     end;
--     begin
--       -- calls has started_at (no created_at column: checked against the live schema 13 Oct)
--       select max(c.started_at) into t from public.calls c
--         where c.direction = 'outbound' and c.created_by = 'office-' || r.id::text and c.started_at >= day_start and c.started_at <= now();
--       last_at := greatest(last_at, t);
--     exception when others then raise warning 'auto_end_va_shifts: calls skipped for %: %', r.id, sqlerrm;
--     end;
--
--     -- greatest() ignores nulls: with no action today the end is their set time
--     cut := least(greatest((today + end_at) at time zone 'Australia/Sydney', last_at), now());
--     update public.profiles set on_duty = false, on_break = false, on_break_since = null, on_duty_changed_at = now(),
--       last_logout_at = cut, forgot_logout_on = today
--       where id = r.id and on_duty and on_duty_date = today;
--     continue when not found;  -- they logged out themselves in the meantime
--     if r.on_break then insert into public.shift_events(profile_id, kind, at, day) values (r.id, 'break_end', cut, today); end if;
--     insert into public.shift_events(profile_id, kind, at, day) values (r.id, 'shift_end', cut, today);
--     n := n + 1;
--   end loop;
--   return n;
-- end $function$;
--
-- 3. Only after 1 and 2 (nothing else uses them):
-- drop function if exists public.business_today();
-- drop function if exists public.business_tz();
-- drop function if exists public.set_catalog_holidays(jsonb);   -- B5 (new; the old automations code never calls it)
--
-- 4. The seeded holidays, only if they are still the seeded copy (the app may have replaced them since):
-- update public.settings set catalog = catalog - 'holidays'
--  where id = 1 and catalog->'holidays'->>'generatedAt' = '2026-10-15T00:00:00.000Z';
-- ═══ end B-region ═══

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- round3-stage1.sql · group C-names (Ofek 14 Oct, T1.7 the office's name + T1.9 generic names). NOT APPLIED.
-- DATA ONLY: no table, column, function, trigger, policy or cron change (so no RLS change and no definition to back up).
-- The words the code used to have written in (the business's name, phone and website, the three brands and Google review
-- links, who does which job, the Hebrew pay names, who gets the cash, the people's colours and names in the owners'
-- reports) are put into this business's own settings (public.settings row id = 1), so the app and the functions show
-- exactly the same words once the code no longer has them. Only what is MISSING or blank is filled: a value already
-- saved is never overwritten. Safe to run again. Runs ONLY on this business's row (company name empty or 'The Guys
-- Service Group'); on any other business (e.g. the staging demo, 'Demo Home Services') it changes nothing and says so.
-- NOT filled on purpose: catalog.labels.office (nothing saved = "Office": the decided rename of "Ron", T1.7).
-- The settings_security_guard trigger (settings-round2-phase3.sql) only guards catalog.security, which is not touched.
--
-- ORDER: run this BEFORE pushing the app and BEFORE deploying conversations / automations / voice / review-requests /
-- contractor-sign / ingest-ads-stats. The code before this change reads the same values (the same words), so running it early is harmless;
-- after the new code without it, review links, brands, job types, Hebrew pay messages and colours would be missing.
--
-- Read-only checks BEFORE applying — SAVE THE OUTPUT as .claude/backups/settings.before_round3_C-names.json (the
-- before-image, needed for ROLLBACK (a)):
--   select id, company_name, legal_name, catalog from public.settings where id = 1;
--   select jsonb_typeof(catalog) from public.settings where id = 1;                       -- expect object (or null)
--   select catalog->'business', catalog->'brands', catalog#>'{reviews,links}', catalog->'pay', catalog->'people', catalog->'labels'
--     from public.settings where id = 1;
--       -- look at pay.jobTypes: a saved list with no usable service (e.g. ["Nope"]) used to fall back to the built-in
--       -- list and now means every job type; fix it in Settings → People → Pay if there is one.
--   select tgname from pg_trigger where tgrelid = 'public.settings'::regclass and not tgisinternal;
--       -- expect settings_security_guard only
--   select catalog->'brands' from public.settings where id = 1;
--       -- if null or missing any of Aircon / Chimney / Pressure Washing: STOP and ask Ofek first. Until now the chat, texts
--       -- and app filled a missing brand from the code, but the automations engine wrote the BUSINESS NAME for {brand}
--       -- ("The Guys Service Group"). Once step 2 below saves the brands, automation messages with {brand} for those
--       -- services say "The AC Cleaning Guys" etc. instead. If Ofek wants the business name kept there, remove those
--       -- words from the automations' messages first (or skip step 2 for the brands he names).
--   select legal_name from public.settings where id = 1;
--       -- if blank: invoices keep saying the company name (as today), but a NEW contractor agreement now says the company
--       -- name too, where the old code always wrote "The Guys Service Group Pty Ltd". Tell Ofek: filling Legal name in
--       -- Business details brings "Pty Ltd" back on agreements AND puts it on technician invoices ("Bill to") — his choice.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
begin;

do $$
declare
  s record;
  cat jsonb; x jsonb; y jsonb; l jsonb; k text; v jsonb;
  c_brands constant jsonb := '{"Aircon": "The AC Cleaning Guys", "Chimney": "The Chimney Guys", "Pressure Washing": "The Pressure Washing Guys"}';
  c_links constant jsonb := '{"Aircon": {"link": "https://search.google.com/local/writereview?placeid=ChIJx33jOtfwSSgRs09ybCNrVbU", "result": "Enjoy the fresh, clean air!"},
                              "Chimney": {"link": "https://g.page/r/CZUuKFAccuR4EBM/review", "result": "Enjoy your clean, safe fireplace!"},
                              "Pressure Washing": {"link": "https://g.page/r/CZjy0MO5zKE7EBM/review", "result": "Enjoy your fresh, clean outdoor area!"}}';
  c_job_types constant jsonb := '{"Guy": ["Aircon", "Chimney", "Other"], "Dolev": ["Aircon", "Chimney", "Other"], "Omri": ["Aircon", "Chimney", "Other"], "Alessandro": ["Pressure Washing"]}';
  c_hebrew constant jsonb := '{"Guy": "גיא", "Dolev": "דולב", "Omri": "עומרי"}';
  c_people constant jsonb := '{"Guy": {"color": "person-1"}, "Dolev": {"color": "person-2"}, "Noam": {"color": "person-3"},
                               "Ofek": {"color": "person-4", "reportName": "אופק"}, "Ron": {"reportName": "רון"}}';
begin
  select id, company_name, legal_name, catalog into s from public.settings where id = 1 for update;
  if not found then raise notice 'C-names: there is no settings row 1, nothing changed'; return; end if;
  if coalesce(btrim(s.company_name), '') not in ('', 'The Guys Service Group') then
    raise notice 'C-names: settings row 1 belongs to "%", nothing changed', s.company_name; return;
  end if;
  cat := case when jsonb_typeof(s.catalog) = 'object' then s.catalog else '{}'::jsonb end;

  -- 1. Business details: main phone, website, the short name used in chats and texts about no particular service
  --    (the old built-in "The Guys Group"); the signature, the connector texts and the chat use them.
  x := case when jsonb_typeof(cat->'business') = 'object' then cat->'business' else '{}'::jsonb end;
  if coalesce(btrim(x->>'phone'), '') = '' then x := x || jsonb_build_object('phone', '1300 380 090'); end if;
  if coalesce(btrim(x->>'website'), '') = '' then x := x || jsonb_build_object('website', 'theguyservicegroup.com'); end if;
  if coalesce(btrim(x->>'shortName'), '') = '' then x := x || jsonb_build_object('shortName', 'The Guys Group'); end if;
  --    The page the aircon Google Business Profile links to and that profile's word, for the nightly organic suggestions
  --    and digest (ingest-ads-stats; the code had them written in until 14 Oct).
  if coalesce(btrim(x->>'gbpLinkedPage'), '') = '' then x := x || jsonb_build_object('gbpLinkedPage', '/services/air-conditioning-cleaning/'); end if;
  if coalesce(btrim(x->>'gbpLinkedLabel'), '') = '' then x := x || jsonb_build_object('gbpLinkedLabel', 'aircon'); end if;
  cat := jsonb_set(cat, '{business}', x, true);

  -- 2. The brand of each service (Settings → Website chat and texts); a cleared brand meant "the original" = this.
  x := case when jsonb_typeof(cat->'brands') = 'object' then cat->'brands' else '{}'::jsonb end;
  for k, v in select * from jsonb_each(c_brands) loop
    if coalesce(btrim(x->>k), '') = '' then x := x || jsonb_build_object(k, v); end if;
  end loop;
  cat := jsonb_set(cat, '{brands}', x, true);

  -- 3. Google review link + thank-you line per service; a blank saved field meant "the original" = this.
  x := case when jsonb_typeof(cat->'reviews') = 'object' then cat->'reviews' else '{}'::jsonb end;
  y := case when jsonb_typeof(x->'links') = 'object' then x->'links' else '{}'::jsonb end;
  for k, v in select * from jsonb_each(c_links) loop
    l := case when jsonb_typeof(y->k) = 'object' then y->k else '{}'::jsonb end;
    if coalesce(btrim(l->>'link'), '') = '' then l := l || jsonb_build_object('link', v->'link'); end if;
    if coalesce(btrim(l->>'result'), '') = '' then l := l || jsonb_build_object('result', v->'result'); end if;
    y := y || jsonb_build_object(k, l);
  end loop;
  x := jsonb_set(x, '{links}', y, true);
  cat := jsonb_set(cat, '{reviews}', x, true);

  -- 4. Pay: the jobs each technician does (only names with no list saved), the Hebrew pay messages (only if no list was
  --    ever saved: a saved list, even an empty one, already replaced the original), and who technicians hand cash to.
  x := case when jsonb_typeof(cat->'pay') = 'object' then cat->'pay' else '{}'::jsonb end;
  y := case when jsonb_typeof(x->'jobTypes') = 'object' then x->'jobTypes' else '{}'::jsonb end;
  for k, v in select * from jsonb_each(c_job_types) loop
    -- (the CASE in brackets: PL/pgSQL would otherwise end the IF condition at the CASE's own THEN)
    if (case when jsonb_typeof(y->k) = 'array' then jsonb_array_length(y->k) = 0 else true end) then
      y := y || jsonb_build_object(k, v);
    end if;
  end loop;
  x := jsonb_set(x, '{jobTypes}', y, true);
  if jsonb_typeof(x->'hebrew') is distinct from 'object' then x := x || jsonb_build_object('hebrew', c_hebrew); end if;
  if coalesce(btrim(x->>'cashTo'), '') = '' then x := x || jsonb_build_object('cashTo', 'Ofek'); end if;
  cat := jsonb_set(cat, '{pay}', x, true);

  -- 5. People: today's colours (CSS --person-1..4 = the old --guy/--dolev/--noam/--ofek) and names in the owners'
  --    reports; a field already saved for a person wins.
  x := case when jsonb_typeof(cat->'people') = 'object' then cat->'people' else '{}'::jsonb end;
  for k, v in select * from jsonb_each(c_people) loop
    y := case when jsonb_typeof(x->k) = 'object' then x->k else '{}'::jsonb end;
    x := x || jsonb_build_object(k, v || y);
  end loop;
  cat := jsonb_set(cat, '{people}', x, true);

  -- legal_name is NOT filled: until 14 Oct a blank legal name meant the company name on technician invoices ("Bill to")
  -- and in the setup checklist, and the app still falls back to it (bizLegalName, payrollInvoiceParties).
  update public.settings set
    company_name = coalesce(nullif(btrim(company_name), ''), 'The Guys Service Group'),
    catalog = cat
  where id = 1;
  raise notice 'C-names: the missing names and words are now in the settings';
end $$;

commit;

-- Read-only checks AFTER applying:
--   select company_name, catalog->'business' as business, catalog->'brands' as brands,
--          catalog#>'{reviews,links}' as review_links, catalog#>'{pay,jobTypes}' as job_types, catalog#>'{pay,hebrew}' as hebrew,
--          catalog#>>'{pay,cashTo}' as cash_to, catalog->'people' as people, catalog->'labels' as labels
--     from public.settings where id = 1;            -- labels: still null (Office is the default)

-- ROLLBACK (C-names) — run by hand only. Not needed to roll back the CODE: the code before this change reads these same
-- values (the same words) and ignores the new keys (business.shortName, business.gbpLinkedPage/gbpLinkedLabel, pay.cashTo, people). There is no definition to
-- restore (no function / trigger / table was changed). Two ways back:
-- (a) the exact old state, from the before-image saved above (this ALSO undoes any settings change made in the app since):
-- update public.settings set company_name = '<saved company_name>', catalog = '<saved catalog json>'::jsonb where id = 1;
-- (b) remove only what this section added, where it still has the value this section put there:
-- begin;
-- do $$
-- declare cat jsonb; k text;
-- begin
--   select catalog into cat from public.settings where id = 1 for update;
--   if cat#>>'{business,phone}' = '1300 380 090' then cat := cat #- '{business,phone}'; end if;
--   if cat#>>'{business,website}' = 'theguyservicegroup.com' then cat := cat #- '{business,website}'; end if;
--   if cat#>>'{business,shortName}' = 'The Guys Group' then cat := cat #- '{business,shortName}'; end if;
--   if cat#>>'{business,gbpLinkedPage}' = '/services/air-conditioning-cleaning/' then cat := cat #- '{business,gbpLinkedPage}'; end if;
--   if cat#>>'{business,gbpLinkedLabel}' = 'aircon' then cat := cat #- '{business,gbpLinkedLabel}'; end if;
--   if cat#>>'{brands,Aircon}' = 'The AC Cleaning Guys' then cat := cat #- '{brands,Aircon}'; end if;
--   if cat#>>'{brands,Chimney}' = 'The Chimney Guys' then cat := cat #- '{brands,Chimney}'; end if;
--   if cat#>>'{brands,Pressure Washing}' = 'The Pressure Washing Guys' then cat := cat #- '{brands,Pressure Washing}'; end if;
--   foreach k in array array['Aircon', 'Chimney', 'Pressure Washing'] loop
--     if cat#>>array['reviews','links',k,'link'] in ('https://search.google.com/local/writereview?placeid=ChIJx33jOtfwSSgRs09ybCNrVbU',
--        'https://g.page/r/CZUuKFAccuR4EBM/review', 'https://g.page/r/CZjy0MO5zKE7EBM/review') then cat := cat #- array['reviews','links',k]; end if;
--   end loop;
--   if cat#>'{pay,hebrew}' = '{"Guy": "גיא", "Dolev": "דולב", "Omri": "עומרי"}'::jsonb then cat := cat #- '{pay,hebrew}'; end if;
--   if cat#>>'{pay,cashTo}' = 'Ofek' then cat := cat #- '{pay,cashTo}'; end if;
--   foreach k in array array['Guy', 'Dolev', 'Omri'] loop
--     if cat#>array['pay','jobTypes',k] = '["Aircon", "Chimney", "Other"]'::jsonb then cat := cat #- array['pay','jobTypes',k]; end if;
--   end loop;
--   if cat#>'{pay,jobTypes,Alessandro}' = '["Pressure Washing"]'::jsonb then cat := cat #- '{pay,jobTypes,Alessandro}'; end if;
--   cat := cat - 'people';   -- only C-names (and the new People → Details fields) write catalog.people; check nobody edited it since
--   update public.settings set catalog = cat where id = 1;
-- end $$;
-- commit;
--   (company_name is left as it is: if it was empty, this filled it with 'The Guys Service Group', the name the old code
--    showed for an empty one; set it back with (a) if needed. legal_name is never changed by this section.)
-- ═══ end C-names ═══
