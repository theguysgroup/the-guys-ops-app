-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- STAGE 2 — Part 1 STAGING checks (design §7 G1.3, §8.2 items 25–26, §9.2 risk 3). STAGING ONLY (ops-staging), after
-- .claude/sql/stage2-automations.sql Part 1 ran there and before Part 1 goes live.
-- How to run: paste the whole file into the SQL editor of the STAGING project and run it. Every check is one DO block
-- that writes its own test rows, checks them and then UNDOES everything it wrote (it ends by raising '__undo__' inside
-- its own sub-block, which rolls the sub-block back, and only then prints "PASS …"). So the script leaves the database
-- exactly as it found it, also when a check fails. A failing check stops the script with "FAIL <n>: …".
-- Expected output: the notices "PASS 1" … "PASS 13" (and possibly "NOTE …" lines), then 'stage2 Part 1 staging checks done'.
-- It needs the staging demo data (staging-seed-demo.sql): at least one contact. Nothing here sends anything (no function
-- is called; the capture triggers only write automation_events rows, which are undone).
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- 1. The phase-4 claim still claims exactly once (the wrapper over _v2), the cap holds, a step row never blocks a
--    claim, each Go-to pass claims once, and phase 4's plain insert of a second action row of a (run, step) still fails.
do $$
declare a uuid; r1 uuid; r2 uuid; x text; y text; z text; v text; w text; w2 text; n integer;
begin
  begin
    insert into public.automations (name, enabled, trigger, steps)
    values ('stage2 check 1', false, '{"type":"newLead","params":{}}', '[{"id":"e1","kind":"action","type":"email","subject":"x","body":"y"}]')
    returning id into a;
    insert into public.automation_runs (automation_id, automation_version, event_key, event_type, event_at, record_kind, record_id, anchor_at, due_at)
    values (a, 1, 'stage2-check-1a', 'newLead', now(), 'contact', 'stage2-check', now(), now()) returning id into r1;
    insert into public.automation_runs (automation_id, automation_version, event_key, event_type, event_at, record_kind, record_id, anchor_at, due_at)
    values (a, 1, 'stage2-check-1b', 'newLead', now(), 'contact', 'stage2-check', now(), now()) returning id into r2;
    x := public.automation_claim_customer('default', r1, 'e1', a, 'stage2 check 1', 'email', 'contact', 'stage2-check', null,
                                          array['stage2-check-1@example.invalid'], now() - interval '1 day', 5, now());
    y := public.automation_claim_customer('default', r1, 'e1', a, 'stage2 check 1', 'email', 'contact', 'stage2-check', null,
                                          array['stage2-check-1@example.invalid'], now() - interval '1 day', 5, now());
    if x not like 'claimed:%' or y <> 'done' then raise exception 'FAIL 1a: the phase-4 claim gave % then % (want claimed:<id> then done)', x, y; end if;
    select count(*) into n from public.automation_log l where l.run_id = r1;
    if n <> 1 then raise exception 'FAIL 1b: % log rows after two claims (want 1)', n; end if;
    select count(*) into n from public.automation_log l where l.run_id = r1 and l.row_kind = 'action' and l."loop" = 0 and l.status = 'sending';
    if n <> 1 then raise exception 'FAIL 1c: the claimed row is not an action row of loop 0'; end if;
    z := public.automation_claim_customer('default', r2, 'e1', a, 'stage2 check 1', 'email', 'contact', 'stage2-check', null,
                                          array['stage2-check-1@example.invalid'], now() - interval '1 day', 1, now());
    if z <> 'capped' then raise exception 'FAIL 1d: a second message to the same address under cap 1 gave % (want capped)', z; end if;
    insert into public.automation_log (business_id, run_id, step_id, row_kind, status, automation_name, at)
    values ('default', r2, 'e2', 'step', 'waiting', 'stage2 check 1', now());
    v := public.automation_claim_customer_v2('default', r2, 'e2', a, 'stage2 check 1', 'email', 'contact', 'stage2-check', null,
                                             array['stage2-check-1-other@example.invalid'], now() - interval '1 day', 5, now(), 0);
    if v not like 'claimed:%' then raise exception 'FAIL 1e: a step row blocked the claim (%)', v; end if;
    w := public.automation_claim_customer_v2('default', r1, 'e1', a, 'stage2 check 1', 'email', 'contact', 'stage2-check', null,
                                             array['stage2-check-1@example.invalid'], now() - interval '1 day', 5, now(), 1);
    w2 := public.automation_claim_customer_v2('default', r1, 'e1', a, 'stage2 check 1', 'email', 'contact', 'stage2-check', null,
                                              array['stage2-check-1@example.invalid'], now() - interval '1 day', 5, now(), 1);
    if w not like 'claimed:%' or w2 <> 'done' then raise exception 'FAIL 1f: Go-to pass 1 gave % then % (want claimed then done)', w, w2; end if;
    begin
      insert into public.automation_log (business_id, run_id, step_id, status, channel, audience, automation_name, at)
      values ('default', r1, 'e1', 'sending', 'email', 'customer', 'stage2 check 1', now());
      raise exception 'FAIL 1g: a second action row of the same (run, step, loop 0) was accepted';
    exception when unique_violation then null;
    end;
    if exists (select 1 from pg_constraint where conrelid = 'public.automation_log'::regclass and conname = 'automation_log_once') then
      raise exception 'FAIL 1h: automation_log_once still exists';
    end if;
    if (select prosrc from pg_proc where proname = 'automation_claim_customer' and pronamespace = 'public'::regnamespace) !~ 'automation_claim_customer_v2\(' then
      raise exception 'FAIL 1i: automation_claim_customer is not the wrapper over automation_claim_customer_v2';
    end if;
    raise exception '__undo__';
  exception when others then
    if sqlerrm <> '__undo__' then raise; end if;
  end;
  raise notice 'PASS 1 — the phase-4 claim claims once (wrapper over _v2), cap, step rows, Go-to passes, the unique swap';
end $$;

-- 2. Capture triggers: silent while nothing is wanted; a forced capture failure NEVER blocks the contacts UPDATE (the
--    save goes through, the failure is counted); events when wanted; the cause is stamped; INSERT tags; opt-out DELETE
--    reads OLD.
do $$
declare c uuid; e0 integer; e1 integer; n integer; pc text; o uuid; r uuid := gen_random_uuid(); a uuid := gen_random_uuid(); ev record;
begin
  begin
    select id into c from public.contacts order by created_at desc nulls last limit 1;
    if c is null then raise exception 'FAIL 2: staging has no contacts (run staging-seed-demo.sql first)'; end if;
    insert into public.automation_state (business_id) values ('default') on conflict (business_id) do nothing;
    select capture_errors into e0 from public.automation_state where business_id = 'default';
    delete from public.automation_wanted where business_id = 'default';
    update public.contacts set full_name = coalesce(full_name, '') || ' x' where id = c;
    select count(*) into n from public.automation_events where contact_id = c and at = now();   -- written by this check (its transaction's time)
    if n <> 0 then raise exception 'FAIL 2a: a capture wrote % events while nothing was wanted', n; end if;
    insert into public.automation_wanted (business_id, event_type)
    values ('default', 'contact_changed'), ('default', 'contact_tag'), ('default', 'contact_dnd'), ('default', 'lead_status');
    perform set_config('automation.capture_test_error', 'on', true);
    update public.contacts set postcode = 'S2C9' where id = c;
    get diagnostics n = row_count;
    select postcode into pc from public.contacts where id = c;
    if n <> 1 or pc is distinct from 'S2C9' then raise exception 'FAIL 2b: a forced capture failure blocked the contacts update (rows %, postcode %)', n, pc; end if;
    select capture_errors into e1 from public.automation_state where business_id = 'default';
    if e1 <> e0 + 1 then raise exception 'FAIL 2c: capture_errors went from % to % (want +1)', e0, e1; end if;
    if exists (select 1 from public.automation_events where contact_id = c and at = now()) then raise exception 'FAIL 2d: the failed capture still wrote an event'; end if;
    perform set_config('automation.capture_test_error', 'off', true);
    update public.contacts set full_name = 'Stage2 Check', tags = array_append(array_remove(coalesce(tags, '{}'::text[]), 'stage2-check'), 'stage2-check')
     where id = c;
    select * into ev from public.automation_events where contact_id = c and at = now() and type = 'contact_changed' and ctx ->> 'field' = 'full_name';
    if ev.id is null or ev.event_key not like c::text || ':chg:full_name:%' or ev.source <> 'capture' or ev.chain_depth <> 0
       or ev.cause_run_id is not null or ev.ctx ->> 'new' <> 'Stage2 Check' then
      raise exception 'FAIL 2e: the full_name change event is wrong: %', row_to_json(ev);
    end if;
    if not exists (select 1 from public.automation_events where contact_id = c and at = now() and type = 'contact_tag'
                    and event_key like c::text || ':tag:+:stage2-check:%' and ctx ->> 'action' = 'added') then
      raise exception 'FAIL 2f: no "tag added" event';
    end if;
    perform set_config('automation.cause', r::text || ':2:' || a::text, true);
    update public.contacts set postcode = 'S2C8' where id = c;
    perform set_config('automation.cause', '', true);
    select * into ev from public.automation_events where contact_id = c and at = now() and type = 'contact_changed' and ctx ->> 'new' = 'S2C8';
    if ev.id is null or ev.cause_run_id is distinct from r or ev.cause_automation_id is distinct from a or ev.chain_depth <> 3 then
      raise exception 'FAIL 2g: a workflow''s write was not stamped with its cause (depth 2 → event depth 3): %', row_to_json(ev);
    end if;
    insert into public.customer_opt_outs (contact_id, channel, value_key) values (c, 'email', 'stage2-check-2@example.invalid') returning id into o;
    delete from public.customer_opt_outs where id = o;
    select count(*) into n from public.automation_events where type = 'contact_dnd' and event_key in (o::text || ':on', o::text || ':off') and contact_id = c and at = now();
    if n <> 2 then raise exception 'FAIL 2h: the opt-out on/off events are % (want 2: INSERT and the DELETE reading OLD)', n; end if;
    select count(*) into n from public.automation_events where contact_id = c and at = now() and available_at <> at;
    if n <> 0 then raise exception 'FAIL 2i: a captured event of a non-settling type has available_at <> at'; end if;
    -- a new card that already has a tag: "tag added" on INSERT (a copy of the demo card with a new id; skipped with a note
    -- if this staging schema refuses a copy, e.g. a unique phone or email)
    begin
      insert into public.contacts
      select (jsonb_populate_record(null::public.contacts, to_jsonb(x) || jsonb_build_object('id', gen_random_uuid(), 'tags', array['stage2-ins'],
              'email', 'stage2-check-ins@example.invalid', 'phone', '0491570000'))).*
        from public.contacts x where x.id = c
      returning id into o;
      if not exists (select 1 from public.automation_events where contact_id = o and type = 'contact_tag' and event_key like o::text || ':tag:+:stage2-ins:%') then
        raise exception 'FAIL 2j: a card inserted with a tag gave no "tag added" event';
      end if;
    exception when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      raise notice 'NOTE 2: the INSERT-with-tags case was skipped (%): staging refused a copied card', left(sqlerrm, 120);
    end;
    raise exception '__undo__';
  exception when others then
    if sqlerrm <> '__undo__' then raise; end if;
  end;
  raise notice 'PASS 2 — capture: silent when not wanted, a forced failure never blocks the save, events, cause stamp, tags, opt-out on/off';
end $$;

-- 3. RLS: a VA, a technician, a signed-in person with no profile and anon read NOTHING from the engine tables and the
--    read RPCs (the wanted list is readable by anyone signed in, by design); an owner reads the same rows (control).
do $$
declare a uuid; f uuid; r uuid; hk uuid; who text; uid uuid; t text; n integer; seen integer; owner_id uuid; obj jsonb;
  tabs text[] := array['automation_folders', 'automation_versions', 'automation_notes', 'automation_events', 'automation_trigger_log',
    'automation_trigger_daily', 'automation_enrollment_keys', 'automation_pauses', 'automation_hooks', 'automation_hook_secrets',
    'automation_custom_values', 'automation_templates', 'automation_reviews', 'automation_system_meta', 'system_claims',
    'automation_runs', 'automation_log'];
begin
  begin
    -- one row in every table (as the owner of the tables: RLS does not apply to it)
    insert into public.automations (name, enabled, trigger, steps) values ('stage2 check 3', false, '{"type":"newLead","params":{}}', '[]') returning id into a;
    insert into public.automation_folders (name) values ('stage2 check 3') returning id into f;
    insert into public.automation_versions (automation_id, version_no, revision, version, status, reason, name) values (a, 1, 1, 1, 'draft', 'create', 'stage2 check 3');
    insert into public.automation_notes (automation_id, body) values (a, 'stage2 check 3');
    insert into public.automation_events (type, event_key, at, available_at, source) values ('newLead', 'stage2-check-3', now(), now(), 'app');
    insert into public.automation_wanted (business_id, event_type) values ('default', 'stage2_check') on conflict do nothing;
    insert into public.automation_trigger_log (automation_id, trigger_id, event_key, event_type, matched) values (a, 't1', 'stage2-check-3', 'newLead', true);
    insert into public.automation_trigger_daily (automation_id, trigger_id, day, attempted) values (a, 't1', current_date, 1);
    insert into public.automation_enrollment_keys (automation_id, enrollment_key) values (a, 'stage2-check-3');
    insert into public.automation_pauses (start_wall, end_wall, automation_ids) values ('2031-01-05T09:00', '2031-01-06T09:00', array[a]);
    insert into public.automation_hooks (automation_id, trigger_id) values (a, 't1') returning id into hk;
    insert into public.automation_hook_secrets (hook_id, token_hash) values (hk, repeat('ab', 32));
    insert into public.automation_custom_values (key, value) values ('stage2_check', 'x');
    insert into public.automation_templates (key, name, definition) values ('stage2_check', 'stage2 check 3', '{"schema":2,"seq":0,"entry":null,"triggers":[],"nodes":{}}');
    insert into public.automation_reviews (automation_id, acked_until) values (a, now() - interval '40 days');
    insert into public.automation_system_meta (base, folder_id) values ('stage2check', f);
    insert into public.system_claims (key) values ('stage2-check-3');
    insert into public.automation_runs (automation_id, automation_version, event_key, event_type, event_at, record_kind, record_id, anchor_at, due_at, status)
    values (a, 1, 'stage2-check-3', 'newLead', now(), 'contact', 'stage2-check', now(), now(), 'failed') returning id into r;
    insert into public.automation_log (run_id, step_id, status, channel, audience, automation_id, automation_name, at)
    values (r, 'p1', 'failed', 'push', 'team', a, 'stage2 check 3', now());
    -- the people to sign in as (a made-up id = someone signed in with no profile)
    for who in select unnest(array['va', 'technician', 'nobody', 'anon']) loop
      uid := null;
      if who in ('va', 'technician') then
        begin
          execute 'select id from public.profiles where role = $1 order by id limit 1' into uid using who;
        exception when others then uid := null;
        end;
        if uid is null then raise notice 'NOTE 3: no % profile on staging; checked as someone signed in with no profile instead', who; end if;
      end if;
      uid := coalesce(uid, gen_random_uuid());
      begin
        if who = 'anon' then
          perform set_config('request.jwt.claims', '{"role":"anon"}', true);
          perform set_config('request.jwt.claim.sub', '', true);
          execute 'set local role anon';
        else
          perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
          perform set_config('request.jwt.claim.sub', uid::text, true);
          execute 'set local role authenticated';
        end if;
        foreach t in array tabs loop
          begin
            execute format('select count(*) from public.%I', t) into n;
          exception when insufficient_privilege then n := 0;
          end;
          if n <> 0 then raise exception 'FAIL 3a: % reads % rows of %', who, n, t; end if;
        end loop;
        begin
          execute 'select count(*) from public.automation_wanted' into n;
        exception when insufficient_privilege then n := 0;
        end;
        if who <> 'anon' and n = 0 then raise exception 'FAIL 3b: % (signed in) cannot read the wanted list', who; end if;
        if who = 'anon' and n <> 0 then raise exception 'FAIL 3c: anon reads the wanted list'; end if;
        if who <> 'anon' then
          obj := public.automation_list_stats(now() - interval '30 days');
          if obj <> '{}'::jsonb then raise exception 'FAIL 3d: % gets list stats %', who, obj; end if;
          select count(*) into n from public.automation_needs_review();
          if n <> 0 then raise exception 'FAIL 3e: % sees Needs review rows', who; end if;
          select count(*) into n from public.automation_execution_log(a, now() - interval '1 day', now() + interval '1 day');
          if n <> 0 then raise exception 'FAIL 3f: % reads the execution log', who; end if;
          begin
            insert into public.automation_folders (name) values ('stage2 check 3 by ' || who);
            raise exception 'FAIL 3g: % added a folder', who;
          exception when insufficient_privilege then null;
          end;
          begin
            insert into public.automation_events (type, event_key, at, available_at, source) values ('newLead', 'stage2-check-3-' || who, now(), now(), 'app');
            raise exception 'FAIL 3h: % wrote an event', who;
          exception when insufficient_privilege then null;
          end;
        end if;
        raise exception '__role_undo__';
      exception when others then
        if sqlerrm <> '__role_undo__' then raise; end if;
      end;
    end loop;
    -- control: an owner sees the rows (so the zeros above mean something)
    begin
      execute 'select id from public.profiles where role = ''owner'' order by id limit 1' into owner_id;
    exception when others then owner_id := null;
    end;
    if owner_id is null then
      raise notice 'NOTE 3: no owner profile on staging; the owner control was skipped';
    else
      begin
        perform set_config('request.jwt.claims', json_build_object('sub', owner_id, 'role', 'authenticated')::text, true);
        perform set_config('request.jwt.claim.sub', owner_id::text, true);
        execute 'set local role authenticated';
        seen := 0;
        foreach t in array array['automation_folders', 'automation_versions', 'automation_notes', 'automation_events', 'automation_trigger_log',
                                 'automation_trigger_daily', 'automation_pauses', 'automation_hooks', 'automation_custom_values', 'automation_templates',
                                 'automation_reviews', 'automation_system_meta', 'automation_runs', 'automation_log'] loop
          execute format('select count(*) from public.%I', t) into n;
          if n = 0 then raise exception 'FAIL 3i: the owner reads nothing from %', t; end if;
          seen := seen + 1;
        end loop;
        foreach t in array array['automation_enrollment_keys', 'automation_hook_secrets', 'system_claims'] loop
          begin
            execute format('select count(*) from public.%I', t) into n;
            raise exception 'FAIL 3j: the owner can read % (service role only)', t;
          exception when insufficient_privilege then null;
          end;
        end loop;
        select count(*) into n from public.automation_needs_review() x where x.automation_id = a;
        if n <> 1 then raise exception 'FAIL 3k: the owner does not see the failed run in Needs review'; end if;
        if public.automation_mark_reviewed(a) is null then raise exception 'FAIL 3l: Mark as reviewed did nothing'; end if;
        select count(*) into n from public.automation_needs_review() x where x.automation_id = a;
        if n <> 0 then raise exception 'FAIL 3m: still in Needs review after Mark as reviewed'; end if;
        raise exception '__role_undo__';
      exception when others then
        if sqlerrm <> '__role_undo__' then raise; end if;
      end;
    end if;
    raise exception '__undo__';
  exception when others then
    if sqlerrm <> '__undo__' then raise; end if;
  end;
  raise notice 'PASS 3 — RLS: VA / technician / no profile / anon read nothing (wanted list: signed-in only); owner control';
end $$;

-- 4. Table, column and function privileges (read-only).
do $$
declare t text; bad text := '';
begin
  foreach t in array array['automation_events', 'automation_versions', 'automation_trigger_log', 'automation_trigger_daily', 'automation_wanted',
                           'automation_hooks', 'automation_templates', 'automation_runs', 'automation_log'] loop
    if has_table_privilege('authenticated', 'public.' || t, 'INSERT') or has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || t, 'DELETE') then bad := bad || ' authenticated writes ' || t || ';'; end if;
  end loop;
  foreach t in array array['automation_enrollment_keys', 'automation_hook_secrets', 'system_claims'] loop
    if has_table_privilege('authenticated', 'public.' || t, 'SELECT') then bad := bad || ' authenticated reads ' || t || ';'; end if;
  end loop;
  foreach t in array array['automation_folders', 'automation_versions', 'automation_notes', 'automation_events', 'automation_wanted', 'automation_trigger_log',
                           'automation_trigger_daily', 'automation_enrollment_keys', 'automation_pauses', 'automation_hooks', 'automation_hook_secrets',
                           'automation_custom_values', 'automation_templates', 'automation_reviews', 'automation_system_meta', 'system_claims'] loop
    if has_table_privilege('anon', 'public.' || t, 'SELECT') or has_table_privilege('anon', 'public.' || t, 'INSERT') then bad := bad || ' anon on ' || t || ';'; end if;
    if not (select c.relrowsecurity from pg_class c where c.oid = ('public.' || t)::regclass) then bad := bad || ' RLS off on ' || t || ';'; end if;
  end loop;
  if has_column_privilege('authenticated', 'public.automation_log', 'row_kind', 'UPDATE') then bad := bad || ' log.row_kind updatable;'; end if;
  if has_column_privilege('authenticated', 'public.automation_log', 'loop', 'INSERT') then bad := bad || ' log.loop insertable;'; end if;
  if has_column_privilege('authenticated', 'public.automation_runs', 'active_lock', 'UPDATE') then bad := bad || ' runs.active_lock updatable;'; end if;
  if has_column_privilege('authenticated', 'public.automation_runs', 'status', 'UPDATE') then bad := bad || ' runs.status updatable;'; end if;
  if not has_column_privilege('authenticated', 'public.automation_hooks', 'token_hint', 'SELECT') then bad := bad || ' hooks.token_hint not readable;'; end if;
  foreach t in array array[
      'public.automation_enroll(text, uuid, integer, integer, text, text, text, timestamptz, text, text, uuid, text, text, text, text, jsonb, text, integer, uuid, uuid, boolean, timestamptz, timestamptz)',
      'public.automation_claim_events(text, timestamptz, integer, integer, uuid, text, text)', 'public.automation_wake(text, uuid, text[], timestamptz)',
      'public.automation_stop_on_reply(text, uuid, timestamptz, timestamptz)', 'public.automation_apply(text, text, text, text, jsonb)',
      'public.automation_prune(text, timestamptz, integer)', 'public.automation_trigger_daily_add(text, jsonb)',
      'public.automation_capture_put(text, text, text, text, text, uuid, jsonb)',
      'public.automation_claim_customer_v2(text, uuid, text, uuid, text, text, text, text, uuid, text[], timestamptz, integer, timestamptz, integer)',
      'public.automation_claim_customer(text, uuid, text, uuid, text, text, text, text, uuid, text[], timestamptz, integer, timestamptz)'] loop
    if has_function_privilege('authenticated', t, 'EXECUTE') or has_function_privilege('anon', t, 'EXECUTE') then bad := bad || ' callable by the app: ' || t || ';'; end if;
    if not has_function_privilege('service_role', t, 'EXECUTE') then bad := bad || ' not callable by the function: ' || t || ';'; end if;
  end loop;
  foreach t in array array['public.automation_list_stats(timestamptz)', 'public.automation_trigger_stats(uuid, date, date)',
      'public.automation_trigger_evals(uuid, text, timestamptz, timestamptz, boolean, uuid, timestamptz, uuid, integer)',
      'public.automation_unmatch_reasons(uuid, text, date, date)', 'public.automation_step_stats(uuid, timestamptz)',
      'public.automation_enrollments(uuid, timestamptz, timestamptz, text[], text, text, text[], uuid, timestamptz, uuid, integer)',
      'public.automation_execution_log(uuid, timestamptz, timestamptz, text[], text[], uuid, uuid, timestamptz, uuid, integer)',
      'public.automation_log_steps(uuid, timestamptz, timestamptz)', 'public.automation_needs_review()', 'public.automation_mark_reviewed(uuid)'] loop
    if not has_function_privilege('authenticated', t, 'EXECUTE') then bad := bad || ' read RPC not callable: ' || t || ';'; end if;
    if has_function_privilege('anon', t, 'EXECUTE') then bad := bad || ' read RPC callable by anon: ' || t || ';'; end if;
    if (select p.prosecdef from pg_proc p where p.oid = t::regprocedure) then bad := bad || ' read RPC is security definer: ' || t || ';'; end if;
  end loop;
  if bad <> '' then raise exception 'FAIL 4:%', bad; end if;
  raise notice 'PASS 4 — table, column and function privileges';
end $$;

-- 5. automation_enroll: enrolled / already_enrolled / reentry_off / duplicate_event / not_found; the lock clears when the
--    run ends; one ledger row; enrolled_total; one enroll log row; another business's call touches nothing.
do $$
declare a uuid; x text; rid uuid; n integer; tot bigint;
begin
  begin
    insert into public.automations (name, enabled, trigger, steps) values ('stage2 check 5', false, '{"type":"newLead","params":{}}', '[]') returning id into a;
    x := public.automation_enroll('default', a, 1, 1, 't1', 'k1', 'newLead', now(), 'contact', 'c5', null, 'c5', 'c5', 'off', 'n1', '{}', 'trigger', 0, null, null, false, now());
    if x not like 'enrolled:%' then raise exception 'FAIL 5a: first enrol gave %', x; end if;
    rid := substr(x, 10)::uuid;
    if not exists (select 1 from public.automation_runs r where r.id = rid and r.status = 'waiting' and r.active_lock = 'c5' and r.cursor_step = 'n1'
                    and r.enrollment_key = 'c5' and r.due_at = r.event_at and r.trigger_id = 't1' and r.source = 'trigger') then
      raise exception 'FAIL 5b: the enrolled run is not as expected';
    end if;
    x := public.automation_enroll('default', a, 1, 1, 't1', 'k2', 'newLead', now(), 'contact', 'c5', null, 'c5', 'c5', 'after_exit', 'n1', '{}', 'trigger', 0, null, null, false, now());
    if x <> 'already_enrolled' then raise exception 'FAIL 5c: while active gave % (want already_enrolled)', x; end if;
    update public.automation_runs set status = 'done', finished_at = now() where id = rid;
    if (select active_lock from public.automation_runs where id = rid) is not null then raise exception 'FAIL 5d: the lock did not clear when the run ended'; end if;
    x := public.automation_enroll('default', a, 1, 1, 't1', 'k3', 'newLead', now(), 'contact', 'c5', null, 'c5', 'c5', 'off', 'n1', '{}', 'trigger', 0, null, null, false, now());
    if x <> 'reentry_off' then raise exception 'FAIL 5e: re-entry off gave % (want reentry_off)', x; end if;
    x := public.automation_enroll('default', a, 1, 1, 't1', 'k3', 'newLead', now(), 'contact', 'c5', null, 'c5', 'c5', 'after_exit', 'n1', '{}', 'trigger', 0, null, null, false, now());
    if x not like 'enrolled:%' then raise exception 'FAIL 5f: re-entry after exit gave %', x; end if;
    x := public.automation_enroll('default', a, 1, 1, 't1', 'k3', 'newLead', now(), 'contact', 'c5', null, 'c5', null, 'legacy_always', 'n1', '{}', 'trigger', 0, null, null, false, now());
    if x <> 'duplicate_event' then raise exception 'FAIL 5g: the same event again gave % (want duplicate_event)', x; end if;
    x := public.automation_enroll('other', a, 1, 1, 't1', 'k9', 'newLead', now(), 'contact', 'c5', null, 'c9', 'c9', 'off', 'n1', '{}', 'trigger', 0, null, null, false, now());
    if x <> 'not_found' then raise exception 'FAIL 5h: another business enrolled into this workflow (%)', x; end if;
    select runs into n from public.automation_enrollment_keys where automation_id = a and enrollment_key = 'c5';
    select enrolled_total into tot from public.automations where id = a;
    if n <> 2 or tot <> 2 then raise exception 'FAIL 5i: ledger runs % / enrolled_total % (want 2 / 2)', n, tot; end if;
    select count(*) into n from public.automation_log where automation_id = a and row_kind = 'enroll' and status = 'added';
    if n <> 2 then raise exception 'FAIL 5j: % enroll log rows (want 2)', n; end if;
    select count(*) into n from public.automation_runs where automation_id = a;
    if n <> 2 then raise exception 'FAIL 5k: % runs (want 2)', n; end if;
    raise exception '__undo__';
  exception when others then
    if sqlerrm <> '__undo__' then raise; end if;
  end;
  raise notice 'PASS 5 — automation_enroll outcomes, the lock clears on finish, ledger, total, enroll rows, business scoping';
end $$;

-- 6. automation_claim_events: a settling event waits for available_at; a lease is taken and only an expired one is
--    taken again; one record's events only; done events never.
do $$
declare n integer; ids uuid[];
begin
  begin
    insert into public.automation_events (type, event_key, record_kind, record_id, at, available_at, source)
    values ('stage', 'stage2-check-6a', 'contact', 'r6', now(), now() + interval '30 seconds', 'scan'),
           ('newLead', 'stage2-check-6b', 'contact', 'r6', now(), now(), 'scan'),
           ('newLead', 'stage2-check-6c', 'contact', 'r6other', now(), now(), 'scan');
    insert into public.automation_events (type, event_key, record_kind, record_id, at, available_at, source, status)
    values ('newLead', 'stage2-check-6d', 'contact', 'r6', now(), now(), 'scan', 'done');
    select array_agg(e.id) into ids from public.automation_claim_events('default', now(), 50, 60, null, 'contact', 'r6') e;
    if coalesce(cardinality(ids), 0) <> 1 or not exists (select 1 from public.automation_events where id = ids[1] and event_key = 'stage2-check-6b' and status = 'processing') then
      raise exception 'FAIL 6a: one record''s due events = only 6b (got %)', ids;
    end if;
    select count(*) into n from public.automation_claim_events('default', now() + interval '10 seconds', 50, 60, null, 'contact', 'r6');
    if n <> 0 then raise exception 'FAIL 6b: a leased or settling event was claimed again (%)', n; end if;
    select count(*) into n from public.automation_claim_events('default', now() + interval '31 seconds', 50, 60, null, 'contact', 'r6');
    if n <> 1 then raise exception 'FAIL 6c: the settled stage event was not claimed after 30 s (%)', n; end if;
    select count(*) into n from public.automation_claim_events('default', now() + interval '2 minutes', 50, 60, null, 'contact', 'r6');
    if n <> 2 then raise exception 'FAIL 6d: expired leases were not claimed again (% of 2)', n; end if;
    select count(*) into n from public.automation_claim_events('other', now() + interval '1 hour', 50, 60);
    if n <> 0 then raise exception 'FAIL 6e: another business claimed this business''s events'; end if;
    -- housekeeping: a done event older than 7 days goes, only for its own business
    insert into public.automation_events (type, event_key, at, available_at, source, status, processed_at, created_at)
    values ('newLead', 'stage2-check-6old', now() - interval '9 days', now() - interval '9 days', 'scan', 'done', now() - interval '8 days', now() - interval '9 days');
    perform public.automation_prune('other', now(), 1000);
    if not exists (select 1 from public.automation_events where event_key = 'stage2-check-6old') then raise exception 'FAIL 6f: another business''s prune deleted this business''s event'; end if;
    perform public.automation_prune('default', now(), 1000);
    if exists (select 1 from public.automation_events where event_key = 'stage2-check-6old') then raise exception 'FAIL 6g: a done event older than 7 days was not pruned'; end if;
    raise exception '__undo__';
  exception when others then
    if sqlerrm <> '__undo__' then raise; end if;
  end;
  raise notice 'PASS 6 — automation_claim_events: settle, leases, one record, done never, business scoping; prune';
end $$;

-- 7. automation_wake / automation_stop_on_reply: only this lead's waiting runs whose watch matches / that sent before
--    the reply; one exit row per stopped run; another business's call touches nothing.
do $$
declare a uuid; c uuid := gen_random_uuid(); n integer; later timestamptz := now() + interval '3 days';
begin
  begin
    insert into public.automations (name, enabled, trigger, steps) values ('stage2 check 7', false, '{"type":"newLead","params":{}}', '[]') returning id into a;
    insert into public.automation_runs (automation_id, automation_version, event_key, event_type, event_at, record_kind, record_id, contact_id,
                                        anchor_at, due_at, status, watch, stop_on_reply, first_sent_at)
    values (a, 1, 'w1', 'newLead', now(), 'contact', c::text, c, now(), later, 'waiting', array['customer_replied'], true, now() - interval '1 hour'),
           (a, 1, 'w2', 'newLead', now(), 'contact', c::text, c, now(), later, 'waiting', array['stage'], true, now() + interval '1 hour'),
           (a, 1, 'w3', 'newLead', now(), 'contact', c::text, c, now(), later, 'done', array['customer_replied'], true, now() - interval '1 hour');
    if public.automation_wake('other', c, array['customer_replied'], now()) <> 0 then raise exception 'FAIL 7a: another business woke this lead''s runs'; end if;
    n := public.automation_wake('default', c, array['customer_replied'], now());
    if n <> 1 or (select due_at from public.automation_runs where automation_id = a and event_key = 'w1') > now()
       or (select due_at from public.automation_runs where automation_id = a and event_key = 'w2') <> later then
      raise exception 'FAIL 7b: wake touched % runs (want only w1)', n;
    end if;
    if public.automation_stop_on_reply('other', c, now(), now()) <> 0 then raise exception 'FAIL 7c: another business stopped this lead''s runs'; end if;
    n := public.automation_stop_on_reply('default', c, now(), now());
    if n <> 1 or (select status from public.automation_runs where automation_id = a and event_key = 'w1') <> 'stopped'
       or (select status from public.automation_runs where automation_id = a and event_key = 'w2') <> 'waiting' then
      raise exception 'FAIL 7d: stop on reply stopped % runs (want only w1: w2 sent after the reply)', n;
    end if;
    select count(*) into n from public.automation_log where automation_id = a and row_kind = 'exit' and status = 'stopped' and reason = 'Stopped: the lead replied';
    if n <> 1 then raise exception 'FAIL 7e: % exit rows (want 1)', n; end if;
    raise exception '__undo__';
  exception when others then
    if sqlerrm <> '__undo__' then raise; end if;
  end;
  raise notice 'PASS 7 — automation_wake and automation_stop_on_reply';
end $$;

-- 8. Pause ranges: ≤ 15 days; no workflow in two overlapping ranges (also annual across New Year and 29 February);
--    ≤ 15 per business; a changed range wakes only the runs it held.
do $$
declare a uuid; b uuid; p uuid; i integer;
begin
  begin
    insert into public.automations (name, enabled, trigger, steps) values ('stage2 check 8a', false, '{"type":"newLead","params":{}}', '[]') returning id into a;
    insert into public.automations (name, enabled, trigger, steps) values ('stage2 check 8b', false, '{"type":"newLead","params":{}}', '[]') returning id into b;
    begin
      insert into public.automation_pauses (start_wall, end_wall, automation_ids) values ('2031-03-01T09:00', '2031-03-17T09:00', array[a]);
      raise exception 'FAIL 8a: a 16-day pause was accepted';
    exception when raise_exception then if sqlerrm not like 'Maximum allowed difference%' then raise; end if;
    end;
    insert into public.automation_pauses (start_wall, end_wall, annually, automation_ids) values ('2030-12-24T17:00', '2031-01-02T08:00', true, array[a]) returning id into p;
    begin   -- the same workflow, a later year, inside the annual range across New Year
      insert into public.automation_pauses (start_wall, end_wall, automation_ids) values ('2033-12-31T10:00', '2034-01-01T10:00', array[a, b]);
      raise exception 'FAIL 8b: an overlap with an annual range across New Year was accepted';
    exception when raise_exception then if sqlerrm not like 'A workflow should not be part of two%' then raise; end if;
    end;
    insert into public.automation_pauses (start_wall, end_wall, automation_ids) values ('2033-12-31T10:00', '2034-01-01T10:00', array[b]);   -- another workflow: fine
    insert into public.automation_pauses (start_wall, end_wall, annually, automation_ids) values ('2032-02-29T09:00', '2032-03-01T09:00', true, array[b]);   -- 29 Feb, annual
    begin
      insert into public.automation_pauses (start_wall, end_wall, automation_ids) values ('2033-02-28T12:00', '2033-02-28T13:00', array[b]);
      raise exception 'FAIL 8c: 28 Feb 2033 inside an annual 29 Feb range was accepted';
    exception when raise_exception then if sqlerrm not like 'A workflow should not be part of two%' then raise; end if;
    end;
    begin
      insert into public.automation_pauses (start_wall, end_wall, automation_ids) values ('2031-02-30T09:00', '2031-03-01T09:00', array[b]);
      raise exception 'FAIL 8d: 30 February was accepted';
    exception when others then if sqlerrm like 'FAIL%' then raise; end if;
    end;
    for i in 1..12 loop   -- 3 rows exist; 12 more = 15
      insert into public.automation_pauses (start_wall, end_wall, automation_ids)
      values (format('2040-%s-10T09:00', lpad(i::text, 2, '0')), format('2040-%s-11T09:00', lpad(i::text, 2, '0')), array[a]);
    end loop;
    begin
      insert into public.automation_pauses (start_wall, end_wall, automation_ids) values ('2041-01-01T09:00', '2041-01-02T09:00', array[a]);
      raise exception 'FAIL 8e: a 16th pause date was accepted';
    exception when raise_exception then if sqlerrm not like 'At most 15%' then raise; end if;
    end;
    -- a run held by the pause (watch 'pause') wakes when the range changes; one that is not held does not
    insert into public.automation_runs (automation_id, automation_version, event_key, event_type, event_at, record_kind, record_id, anchor_at, due_at, status, watch)
    values (a, 1, 'p1', 'newLead', now(), 'contact', 'r8', now(), now() + interval '9 days', 'waiting', array['pause']),
           (a, 1, 'p2', 'newLead', now(), 'contact', 'r8', now(), now() + interval '9 days', 'waiting', array['stage']);
    update public.automation_pauses set end_wall = '2031-01-01T08:00' where id = p;
    if (select due_at from public.automation_runs where automation_id = a and event_key = 'p1') > now()
       or (select due_at from public.automation_runs where automation_id = a and event_key = 'p2') <= now() + interval '8 days' then
      raise exception 'FAIL 8f: a changed range did not wake exactly the held run';
    end if;
    raise exception '__undo__';
  exception when others then
    if sqlerrm <> '__undo__' then raise; end if;
  end;
  raise notice 'PASS 8 — pause ranges: 15 days, overlaps (annual, New Year, 29 Feb), 15 per business, wake on change';
end $$;

-- 9. Folders: at most 5 levels (also when a subtree moves), never inside itself, a name once per parent.
do $$
declare f1 uuid; f2 uuid; f3 uuid; f4 uuid; f5 uuid; g1 uuid; g2 uuid;
begin
  begin
    insert into public.automation_folders (name) values ('s2c L1') returning id into f1;
    insert into public.automation_folders (name, parent_id) values ('s2c L2', f1) returning id into f2;
    insert into public.automation_folders (name, parent_id) values ('s2c L3', f2) returning id into f3;
    insert into public.automation_folders (name, parent_id) values ('s2c L4', f3) returning id into f4;
    insert into public.automation_folders (name, parent_id) values ('s2c L5', f4) returning id into f5;
    begin
      insert into public.automation_folders (name, parent_id) values ('s2c L6', f5);
      raise exception 'FAIL 9a: a 6th level was accepted';
    exception when raise_exception then if sqlerrm not like 'Folders go at most 5 levels deep%' then raise; end if;
    end;
    begin
      update public.automation_folders set parent_id = f3 where id = f1;
      raise exception 'FAIL 9b: a folder went inside its own subfolder';
    exception when raise_exception then if sqlerrm not like 'A folder cannot go inside itself%' and sqlerrm not like 'Folders go at most%' then raise; end if;
    end;
    insert into public.automation_folders (name) values ('s2c G1') returning id into g1;
    insert into public.automation_folders (name, parent_id) values ('s2c G2', g1) returning id into g2;
    begin   -- a 2-level subtree under level 4 would make 6 levels
      update public.automation_folders set parent_id = f4 where id = g1;
      raise exception 'FAIL 9c: moving a subtree made 6 levels';
    exception when raise_exception then if sqlerrm not like 'Folders go at most 5 levels deep%' then raise; end if;
    end;
    begin
      insert into public.automation_folders (name, parent_id) values ('S2C l2 ', f1);
      raise exception 'FAIL 9d: the same name twice under one parent was accepted';
    exception when unique_violation then null;
    end;
    raise exception '__undo__';
  exception when others then
    if sqlerrm <> '__undo__' then raise; end if;
  end;
  raise notice 'PASS 9 — folders: 5 levels, subtree moves, no cycles, unique names';
end $$;

-- 10. The schema state of the swap and the new checks (read-only).
do $$
declare d text;
begin
  select pg_get_indexdef(i.indexrelid) into d from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = 'automation_log_action_once';
  if d is null or d !~ 'UNIQUE' or d !~ 'run_id, step_id, "?loop"?' or d !~ 'row_kind = ''action''' then raise exception 'FAIL 10a: automation_log_action_once is %', d; end if;
  select pg_get_indexdef(i.indexrelid) into d from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = 'automation_runs_active_lock';
  if d is null or d !~ 'UNIQUE' or d !~ 'active_lock IS NOT NULL' then raise exception 'FAIL 10b: automation_runs_active_lock is %', d; end if;
  if (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'automation_log' and column_name = 'channel') <> 'YES'
     or (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'automation_log' and column_name = 'audience') <> 'YES' then
    raise exception 'FAIL 10c: automation_log.channel / audience are still NOT NULL';
  end if;
  if exists (select 1 from public.automation_log where row_kind <> 'action' or "loop" <> 0) then
    raise notice 'NOTE 10: automation_log already has v2 rows (fine once the v2 function runs on staging)';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'automation_capture' and tgrelid = 'public.contacts'::regclass)
     or (select count(*) from pg_trigger where tgname = 'automation_capture') <> 6 then
    raise exception 'FAIL 10d: the six capture triggers are not all there';
  end if;
  raise notice 'PASS 10 — the swap, the partial unique indexes, nullable channel/audience, the six capture triggers';
end $$;

-- 11. automation_apply: a typed field write, tags, Won refused, a stage move writes the 'stage' event with the scanner's
--     exact key (the stored stage_changed_at as PostgREST shows it) and every captured event carries the cause.
do $$
declare a uuid; c uuid; r uuid := gen_random_uuid(); res jsonb; k text; st text; tgt text; n integer;
begin
  begin
    select id, status into c, st from public.contacts order by created_at desc nulls last limit 1;
    if c is null then raise exception 'FAIL 11: staging has no contacts'; end if;
    -- a stage this business already uses (a check on contacts.status, if any, accepts it), not the lead's own, not the won key
    select x.status into tgt from public.contacts x where x.status is distinct from st and x.status <> public.automation_catalog_key('stageWon', 'Won')
     group by x.status order by count(*) desc limit 1;
    if tgt is null then raise exception 'FAIL 11: the demo contacts have only one stage'; end if;
    insert into public.automations (name, enabled, trigger, steps) values ('stage2 check 11', false, '{"type":"newLead","params":{}}', '[]') returning id into a;
    insert into public.automation_wanted (business_id, event_type) values ('default', 'stage'), ('default', 'contact_changed'), ('default', 'contact_tag')
      on conflict do nothing;
    res := public.automation_apply('default', r::text || ':0:' || a::text, 'contact', c::text, jsonb_build_array(
      jsonb_build_object('op', 'set', 'field', 'postcode', 'value', 'S2C11'),
      jsonb_build_object('op', 'set', 'field', 'phone', 'value', '000'),
      jsonb_build_object('op', 'tags', 'add', jsonb_build_array('stage2-apply')),
      jsonb_build_object('op', 'stage', 'to', public.automation_catalog_key('stageWon', 'Won')),
      jsonb_build_object('op', 'stage', 'to', tgt)));
    if (res ->> 'ok')::boolean is not true or jsonb_array_length(res -> 'applied') <> 3 or jsonb_array_length(res -> 'skipped') <> 2 then
      raise exception 'FAIL 11a: apply gave % (want 3 applied: postcode, tags, stage; 2 skipped: phone, Won)', res;
    end if;
    if (select postcode from public.contacts where id = c) <> 'S2C11' or not ('stage2-apply' = any((select tags from public.contacts where id = c))) then
      raise exception 'FAIL 11b: the field / tag writes did not land';
    end if;
    select c::text || ':' || status || ':' || (to_jsonb(stage_changed_at) #>> '{}') into k from public.contacts where id = c;
    if not exists (select 1 from public.automation_events where type = 'stage' and event_key = k and source = 'engine' and cause_run_id = r and chain_depth = 1) then
      raise exception 'FAIL 11c: no stage event with the scanner key % and the cause', k;
    end if;
    select count(*) into n from public.automation_events where contact_id = c and at = now() and type in ('contact_changed', 'contact_tag') and cause_run_id is distinct from r;
    if n <> 0 then raise exception 'FAIL 11d: % captured events without the cause', n; end if;
    select count(*) into n from public.activity_log where record_kind = 'contact' and record_id = c::text and actor = 'Automation: stage2 check 11';
    if n <> 3 then raise exception 'FAIL 11e: % activity lines (want 3)', n; end if;
    res := public.automation_apply('other', r::text || ':0:' || a::text, 'contact', c::text, jsonb_build_array(jsonb_build_object('op', 'set', 'field', 'postcode', 'value', 'S2C12')));
    if (res ->> 'ok')::boolean or (select postcode from public.contacts where id = c) <> 'S2C11' then raise exception 'FAIL 11f: another business''s apply wrote (%)', res; end if;
    begin
      perform public.automation_apply('default', 'no cause', 'contact', c::text, '[]'::jsonb);
      raise exception 'FAIL 11g: apply ran without a cause';
    exception when raise_exception then if sqlerrm not like 'automation_apply needs p_cause%' then raise; end if;
    end;
    raise exception '__undo__';
  exception when others then
    if sqlerrm <> '__undo__' then raise; end if;
  end;
  raise notice 'PASS 11 — automation_apply: typed write, whitelist, tags, Won refused, stage event with the scanner key, cause on every event';
end $$;

-- 12. The v2-only columns are out of the app's reach (automations_a_v2_pin): an owner signed in through the app inserts
--     an enabled automation with a customer doc in `definition` → the doc is dropped (null) and phase 4's guards see only
--     the steps; an UPDATE of `definition` / `enrolled_total` / `system_key` keeps the stored values. Control: the table
--     owner (SQL editor) can still write them.
do $$
declare a uuid; b uuid; owner_id uuid; d jsonb; n bigint; k text; doc jsonb :=
  '{"schema":2,"seq":1,"entry":"s1","triggers":[{"id":"t1","type":"newLead","filters":{"match":"all","segments":[{"match":"all","rules":[]}]}}],"nodes":{"s1":{"kind":"action","type":"send_email","config":{"subject":"x","body":"y"},"out":{"next":null}}}}';
begin
  begin
    insert into public.automations (name, enabled, trigger, steps, definition) values ('stage2 check 12 control', false, '{"type":"newLead","params":{}}', '[]', doc)
    returning id, definition into a, d;
    if d is null then raise exception 'FAIL 12a: the table owner could not write definition (the pin must leave the SQL editor and the service role alone)'; end if;
    update public.automations set definition = null where id = a;
    begin
      execute 'select id from public.profiles where role = ''owner'' order by id limit 1' into owner_id;
    exception when others then owner_id := null;
    end;
    if owner_id is null then
      raise notice 'NOTE 12: no owner profile on staging; the signed-in part was skipped';
    else
      begin
        perform set_config('request.jwt.claims', json_build_object('sub', owner_id, 'role', 'authenticated')::text, true);
        perform set_config('request.jwt.claim.sub', owner_id::text, true);
        execute 'set local role authenticated';
        insert into public.automations (name, enabled, trigger, steps, definition, enrolled_total, system_key, origin)
        values ('stage2 check 12', true, '{"type":"newLead","params":{}}', '[{"id":"p1","kind":"action","type":"push","to":{"roles":["owner"]},"title":"x"}]', doc, 99, 'stage2-check-12', 'system')
        returning id into b;
        select definition, enrolled_total, system_key into d, n, k from public.automations where id = b;
        if d is not null or n <> 0 or k is not null then raise exception 'FAIL 12b: an app INSERT set the v2-only columns (definition %, enrolled_total %, system_key %)', d is not null, n, k; end if;
        update public.automations set definition = doc, enrolled_total = 7, system_key = 'stage2-check-12b', settings = '{"stopOnResponse":true}' where id = b;
        select definition, enrolled_total, system_key into d, n, k from public.automations where id = b;
        if d is not null or n <> 0 or k is not null then raise exception 'FAIL 12c: an app UPDATE changed the v2-only columns (definition %, enrolled_total %, system_key %)', d is not null, n, k; end if;
        if not (select enabled from public.automations where id = b) then raise exception 'FAIL 12d: the ignored doc switched the team automation off (it should simply be ignored)'; end if;
        update public.automations set name = 'stage2 check 12 renamed' where id = a;   -- the control row: RLS lets the owner change it
        if (select definition from public.automations where id = a) is not null then raise exception 'FAIL 12e: an app UPDATE of another column touched definition'; end if;
        raise exception '__role_undo__';
      exception when others then
        if sqlerrm <> '__role_undo__' then raise; end if;
      end;
    end if;
    raise exception '__undo__';
  exception when others then
    if sqlerrm <> '__undo__' then raise; end if;
  end;
  raise notice 'PASS 12 — the app''s roles never write definition & the other v2-only columns (INSERT: defaults; UPDATE: kept); the SQL editor still can';
end $$;

-- 13. The capture failure counter never waits (read-only here): all six capture functions take the automation_state row
--     with FOR UPDATE SKIP LOCKED. The two-session case (one SQL editor tab can't hold a lock for another) is checked BY
--     HAND on staging, in two SQL editor tabs:
--       tab A:  begin; select * from public.automation_state where business_id = 'default' for update;   -- keep it open
--       tab B:  select set_config('automation.capture_test_error', 'on', false);
--               insert into public.automation_wanted (business_id, event_type) values ('default', 'contact_changed') on conflict do nothing;
--               update public.contacts set postcode = postcode where id = (select id from public.contacts limit 1);
--               -- → returns AT ONCE (UPDATE 1); then: select set_config('automation.capture_test_error', 'off', false);
--               delete from public.automation_wanted where business_id = 'default' and event_type = 'contact_changed';
--       tab A:  rollback;
do $$
declare n integer;
begin
  select count(*) into n from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'automation\_capture\_%'
     and p.prorettype = 'trigger'::regtype and p.prosrc ~* 'for update skip locked';
  if n <> 6 then raise exception 'FAIL 13: % of the six capture functions count failures without waiting (want 6)', n; end if;
  raise notice 'PASS 13 — the capture failure counter takes the state row with SKIP LOCKED (two-tab check: by hand, see above)';
end $$;

select 'stage2 Part 1 staging checks done';
