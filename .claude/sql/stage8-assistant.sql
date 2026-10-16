-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- Stage 8: the general assistant (the gateway is supabase/functions/ai-gateway; stage 6's SQL stays in stage6-cobra.sql).
-- Each section is ONE clearly delimited, self-contained block (its own begin/commit, read-only checks and commented
-- ROLLBACK). Run each section on its own in the Supabase SQL editor, STAGING first (wblsrpmjiqwuxmrmuklc).
-- Nothing in this file has been run by the builder: the owner / main builder runs it.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- Section S8-changes: the compare-and-set writer for the change kind task_update (a task's status and / or due date).
-- The ai-gateway function calls it with the SIGNED-IN PERSON'S token, and it is SECURITY INVOKER, so every RLS rule on
-- tasks applies exactly as when the person edits the task in the app (a technician: his own board or a task assigned
-- to him). The ai_contact_cas pattern (stage6-cobra.sql G2-changes): lock the row, compare the fields the person was
-- shown (the optimistic lock: tasks have no updated_at), write only status and due. The other new kind,
-- lead_follow_up, writes through ai_contact_cas (next_follow_up and contacted_at are already allowlisted). No new
-- table (so no business_id question); ai_changes.kind's check already accepts the new kinds.
-- Run AFTER stage6-cobra.sql's G2-changes section, STAGING first (wblsrpmjiqwuxmrmuklc). Safe to run again (create or
-- replace).
-- Check before (read-only):
--   select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = 'tasks'
--      and column_name in ('id','status','due','title','board','assignees') order by 1;
--                     -- expect: id uuid, status text, due date, title text, board text, assignees jsonb (or an array);
--                     -- if id is not uuid, change p_id's type below to match before running
--   select policyname, cmd, roles, qual, with_check from pg_policies where schemaname = 'public' and tablename = 'tasks'
--    order by cmd;    -- the rules the assistant's writes run under (copy them into the PR)
--   select to_regclass('public.ai_changes');   -- not null (stage 6 G1 ran)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
begin;

-- A task: status and due only. p_expected: the columns as the person was shown them (compared after casting to the
-- column types; a key left out is not compared). Returns {ok, row: {id, status, due}} |
-- {ok:false, code:'gone'|'changed'|'denied', field?, now?}.
create or replace function public.ai_task_cas(p_id uuid, p_expected jsonb, p_patch jsonb) returns jsonb
language plpgsql volatile security invoker set search_path = ''
as $$
declare
  allowed constant text[] := array['status','due'];
  compared constant text[] := array['status','due','title','board'];
  cur jsonb; base jsonb; exp jsonb; k text; n integer; out_row jsonb;
begin
  if p_patch = 'null'::jsonb then p_patch := null; end if;
  if p_expected = 'null'::jsonb then p_expected := null; end if;
  if jsonb_typeof(coalesce(p_patch, '{}'::jsonb)) <> 'object' or jsonb_typeof(coalesce(p_expected, '{}'::jsonb)) <> 'object' then
    raise exception 'ai_task_cas: patch and expected must be objects';
  end if;
  for k in select pg_catalog.jsonb_object_keys(coalesce(p_patch, '{}'::jsonb)) loop
    if not (k = any(allowed)) then raise exception 'ai_task_cas: % is not a field the assistant changes', k; end if;
  end loop;
  for k in select pg_catalog.jsonb_object_keys(coalesce(p_expected, '{}'::jsonb)) loop
    if not (k = any(compared)) then raise exception 'ai_task_cas: % is not a compared field', k; end if;
  end loop;
  select to_jsonb(t) into cur from public.tasks t where t.id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'gone'); end if;
  exp := to_jsonb(pg_catalog.jsonb_populate_record(null::public.tasks, coalesce(p_expected, '{}'::jsonb)));
  for k in select pg_catalog.jsonb_object_keys(coalesce(p_expected, '{}'::jsonb)) loop
    if (cur -> k) is distinct from (exp -> k) then
      return jsonb_build_object('ok', false, 'code', 'changed', 'field', k, 'now', cur -> k);
    end if;
  end loop;
  -- only the allowlisted columns go through jsonb_populate_record (the others are never parsed or written)
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into base from pg_catalog.jsonb_each(cur) e where e.key = any(allowed);
  base := base || coalesce(p_patch, '{}'::jsonb);
  update public.tasks t set (status, due) =
      (select r.status, r.due from pg_catalog.jsonb_populate_record(null::public.tasks, base) r)
   where t.id = p_id
  returning to_jsonb(t.*) into out_row;
  get diagnostics n = row_count;
  if n = 0 then return jsonb_build_object('ok', false, 'code', 'denied'); end if;
  return jsonb_build_object('ok', true, 'row',
    (select jsonb_object_agg(e.key, e.value) from pg_catalog.jsonb_each(out_row) e where e.key = any(allowed || array['id'])));
end $$;

revoke all on function public.ai_task_cas(uuid, jsonb, jsonb) from public, anon;
-- An invoker function: a signed-in person can only do through it what their RLS already lets them do through the API.
grant execute on function public.ai_task_cas(uuid, jsonb, jsonb) to authenticated;

commit;
select 'S8-changes ok';

-- Check after (read-only):
--   select proname, prosecdef from pg_proc where proname = 'ai_task_cas';   -- 1 row, prosecdef = false (SECURITY INVOKER)
--   The RLS proof runs from the app / the gateway (the SQL editor runs as postgres and bypasses RLS): a technician's
--   ai_task_cas(<a task on another board, not his>, '{}', '{}') → {"ok": false, "code": "gone"} (the row is not his to
--   lock); an owner's ai_task_cas(<id>, {"status": <its status>}, {}) → {"ok": true, ...} and nothing changes.

-- ── ROLLBACK (S8-changes; run by hand only) ──────────────────────────────────────────────────────────────────
-- Tasks the assistant already changed stay as they are (ordinary rows); the change log keeps its rows.
-- begin;
-- drop function if exists public.ai_task_cas(uuid, jsonb, jsonb);
-- commit;
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- END S8-changes
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
