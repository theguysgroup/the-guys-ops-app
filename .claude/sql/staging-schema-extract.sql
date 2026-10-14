-- Read-only: builds the DDL of the live public schema (no data) as ONE text value, for the staging project (round 3, stage 0).
-- Skips: the "backup" schema (copies of live data), cron jobs and vault (re-created per environment), auth/storage internals.
with parts as (
  select 1 ord, 'set check_function_bodies = off;' ddl
  union all
  select 2, string_agg(format('create extension if not exists %I;', e.extname), E'\n' order by e.extname)
    from pg_extension e where e.extname not in ('plpgsql','supabase_vault','pg_stat_statements')
  union all
  select 3, string_agg(format('create sequence if not exists public.%I;', s.sequencename), E'\n')
    from pg_sequences s join pg_class c on c.relname=s.sequencename join pg_namespace n on n.oid=c.relnamespace and n.nspname='public'
    where s.schemaname='public' and not exists (select 1 from pg_depend d where d.objid=c.oid and d.deptype='i')
  union all
  select 4, string_agg(x, E'\n' order by relname) from (
    select t.relname, format('create table if not exists public.%I (%s);', t.relname,
      string_agg(format('%I %s%s%s', a.attname, format_type(a.atttypid, a.atttypmod),
        case when a.attidentity in ('a','d') then ' generated '||case a.attidentity when 'a' then 'always' else 'by default' end||' as identity'
             when a.attgenerated='s' then ' generated always as ('||pg_get_expr(ad.adbin, ad.adrelid)||') stored'
             when ad.adbin is not null then ' default '||pg_get_expr(ad.adbin, ad.adrelid) else '' end,
        case when a.attnotnull then ' not null' else '' end), ', ' order by a.attnum)) x
    from pg_class t join pg_namespace n on n.oid=t.relnamespace
    join pg_attribute a on a.attrelid=t.oid and a.attnum>0 and not a.attisdropped
    left join pg_attrdef ad on ad.adrelid=t.oid and ad.adnum=a.attnum
    where n.nspname='public' and t.relkind in ('r','p') group by t.relname) s
  union all
  select 5, string_agg(format('alter table public.%I add constraint %I %s;', rel.relname, con.conname, pg_get_constraintdef(con.oid)), E'\n'
      order by case con.contype when 'p' then 1 when 'u' then 2 when 'x' then 3 when 'c' then 4 else 5 end, rel.relname, con.conname)
    from pg_constraint con join pg_class rel on rel.oid=con.conrelid join pg_namespace n on n.oid=rel.relnamespace
    where n.nspname='public' and con.contype in ('p','u','x','c')
  union all
  select 6, string_agg(pg_get_functiondef(p.oid)||';', E'\n\n' order by p.proname)
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind in ('f','p') and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')
  union all
  select 7, string_agg(format('alter table public.%I add constraint %I %s;', rel.relname, con.conname, pg_get_constraintdef(con.oid)), E'\n' order by rel.relname, con.conname)
    from pg_constraint con join pg_class rel on rel.oid=con.conrelid join pg_namespace n on n.oid=rel.relnamespace
    where n.nspname='public' and con.contype='f'
  union all
  select 8, string_agg(regexp_replace(i.indexdef, '^CREATE (UNIQUE )?INDEX ', 'CREATE \1INDEX IF NOT EXISTS ')||';', E'\n' order by i.indexname)
    from pg_indexes i join pg_namespace n on n.nspname=i.schemaname join pg_class ic on ic.relname=i.indexname and ic.relnamespace=n.oid
    where i.schemaname='public' and not exists (select 1 from pg_constraint c where c.conindid=ic.oid)
  union all
  select 9, string_agg(format('create or replace view public.%I%s as %s', c.relname,
      case when c.reloptions is not null then ' with ('||array_to_string(c.reloptions, ', ')||')' else '' end, pg_get_viewdef(c.oid)), E'\n' order by c.relname)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='v'
  union all
  select 10, string_agg(pg_get_triggerdef(t.oid)||';', E'\n' order by c.relname, t.tgname)
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where not t.tgisinternal and n.nspname='public'
  union all
  select 11, string_agg(format('alter table public.%I enable row level security;', c.relname), E'\n' order by c.relname)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity
  union all
  select 12, string_agg(format('create policy %I on %I.%I as %s for %s to %s%s%s;', policyname, schemaname, tablename, permissive, cmd,
      array_to_string(roles, ', '), coalesce(' using ('||qual||')',''), coalesce(' with check ('||with_check||')','')), E'\n' order by schemaname, tablename, policyname)
    from pg_policies where schemaname in ('public','storage')
  union all
  select 13, string_agg(x, E'\n') from (
    select format('revoke all on function public.%I(%s) from public, anon, authenticated;', p.proname, pg_get_function_identity_arguments(p.oid)) ||
      coalesce((select string_agg(format(' grant execute on function public.%I(%s) to %s;', p.proname, pg_get_function_identity_arguments(p.oid),
        case when a.grantee=0 then 'public' else quote_ident(r.rolname) end), '')
        from aclexplode(p.proacl) a left join pg_roles r on r.oid=a.grantee where a.privilege_type='EXECUTE' and (a.grantee=0 or r.rolname in ('anon','authenticated','service_role'))), '') x
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proacl is not null and p.prokind in ('f','p') and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')) s
  union all
  select 14, string_agg(x, E'\n') from (
    select format('revoke all on table public.%I from anon, authenticated;', c.relname) ||
      coalesce((select string_agg(format(' grant %s on table public.%I to %s;', a.privilege_type, c.relname, quote_ident(r.rolname)), '')
        from aclexplode(c.relacl) a join pg_roles r on r.oid=a.grantee where r.rolname in ('anon','authenticated')), '') x
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v') and c.relacl is not null) s
  union all
  select 15, string_agg(format('insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values (%L, %L, %L, %s, %L) on conflict (id) do nothing;',
      id, name, public, coalesce(file_size_limit::text, 'null'), allowed_mime_types), E'\n' order by id) from storage.buckets
  union all
  select 16, string_agg(format('alter publication supabase_realtime add table public.%I;', tablename), E'\n' order by tablename)
    from pg_publication_tables where pubname='supabase_realtime' and schemaname='public'
)
select string_agg('-- part '||ord||E'\n'||ddl, E'\n\n' order by ord) from parts where ddl is not null;
