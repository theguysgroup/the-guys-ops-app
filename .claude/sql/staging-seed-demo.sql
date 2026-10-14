-- ═══ Staging demo data — round 3, stage 0 (14 Oct 2026). A FAKE business with FAKE people only. ═══
-- Run ONLY in the staging project (ops-staging). Phone numbers come from the ACMA fictional ranges; emails are @example.com.
-- Dates are relative to today, so the data always looks recent. Re-running is refused once contacts or jobs exist.
do $$ begin
  if exists (select 1 from public.contacts) or exists (select 1 from public.jobs) then
    raise exception 'This database already has contacts or jobs. Demo data goes only into the EMPTY staging project; nothing was changed.';
  end if;
end $$;

-- business singletons
insert into public.settings (id, company_name, legal_name, abn, catalog) values (1, 'Demo Home Services', 'Demo Home Services Pty Ltd', '', '{}')
  on conflict (id) do update set company_name = excluded.company_name, legal_name = excluded.legal_name, abn = excluded.abn, catalog = excluded.catalog;
insert into public.cash_status (id, amount) values (1, 0) on conflict do nothing;
insert into public.owner_settings (id) values (1) on conflict do nothing;
insert into public.backup_settings (id, email) values (1, 'demo-owner@example.com') on conflict (id) do update set email = excluded.email;
insert into public.backup_state (id) values (1) on conflict do nothing;
insert into public.automation_settings (business_id) values ('default') on conflict do nothing;
insert into public.automation_state (business_id) values ('default') on conflict do nothing;

-- people
insert into public.employees (name, roles, status, employment_type, phone, email, start_date, working_days) values
  ('Sam Carter',    '{Owner}',      'Active',   'Owner',      '0491 570 156', 'sam.carter@example.com',    '2024-02-01', '{1,2,3,4,5}'),
  ('Jordan Lee',    '{Manager}',    'Active',   'Full-time',  '0491 570 157', 'jordan.lee@example.com',    '2024-05-13', '{1,2,3,4,5}'),
  ('Chris Novak',   '{Technician}', 'Active',   'Contractor', '0491 570 158', 'chris.novak@example.com',   '2024-08-05', '{1,2,3,4,5,6}'),
  ('Taylor Brooks', '{Technician}', 'Active',   'Contractor', '0491 570 159', 'taylor.brooks@example.com', '2025-01-20', '{1,2,3,4,5}'),
  ('Morgan Diaz',   '{Technician}', 'Inactive', 'Contractor', '0491 570 110', 'morgan.diaz@example.com',   '2024-03-04', '{1,2,3,4,5}'),
  ('Riley Ortiz',   '{VA}',         'Active',   'Part-time',  '0491 570 313', 'riley.ortiz@example.com',   '2025-06-02', '{1,2,3,4,5}');
insert into public.commission_rates (technician_name, rates) values
  ('Chris Novak',   '{"Aircon":30,"Chimney":30,"Pressure Washing":35,"Other":30}'),
  ('Taylor Brooks', '{"Aircon":27.5,"Chimney":27.5,"Pressure Washing":35,"Other":27.5}');

-- 60 leads over the last ~75 days, every pipeline stage
with names as (
  select array['Olivia','Liam','Charlotte','Noah','Amelia','Jack','Isla','William','Mia','Henry','Ava','Leo','Grace','Lucas','Chloe','Thomas','Zoe','James','Ruby','Oscar'] fn,
         array['Smith','Nguyen','Brown','Wilson','Taylor','Johnson','White','Martin','Anderson','Thompson','Walker','Harris','Clarke','Kelly','Murphy','Young','King','Wright','Scott','Hughes'] ln,
         array['0491 570 006','0491 570 737','0491 571 266','0491 571 491','0491 571 804','0491 572 549','0491 572 665','0491 572 983','0491 573 770','0491 573 087','0491 574 118','0491 574 632',
               '0491 575 254','0491 575 789','0491 576 398','0491 576 801','0491 577 426','0491 577 644','0491 578 957','0491 578 148','0491 578 888','0491 579 212','0491 579 760','0491 579 455'] ph,
         array['2000','2010','2026','2031','2040','2060','2065','2088','2099','2110','2121','2135','2150','2170','2200','2216','2232','2250'] pc
), g as (
  select i, n.fn, n.ln, n.ph, n.pc,
    (array['Aircon','Aircon','Aircon','Chimney','Chimney','Pressure Washing','Other'])[1 + (i*3) % 7] as division,
    (array['Google Ads','Google Ads','Meta Ads','Google Maps','Organic','Unknown'])[1 + (i*5) % 6] as source,
    case when i < 4 then 'New' when i < 8 then 'Chasing' when i < 12 then 'Quoted' when i < 15 then 'Follow-up' when i < 20 then 'Booked'
         when i % 5 = 0 then 'Lost' else 'Won' end as status,
    (current_date - (i * 5 / 4))::date as created
  from generate_series(0, 59) i cross join names n
)
insert into public.contacts (full_name, phone, email, postcode, division, source, status, created_at, job_description, estimated_value,
  sales_value, lost_reason, stage_changed_at, booked_for, tags, notes, contacted_at)
select fn[1 + (i*7) % 20] || ' ' || ln[1 + (i*11) % 20],
  ph[1 + i % 24],
  lower(fn[1 + (i*7) % 20]) || '.' || lower(ln[1 + (i*11) % 20]) || i || '@example.com',
  pc[1 + (i*3) % 18], division, source, status, created,
  case division when 'Aircon' then 'Split system clean, 2 units' when 'Chimney' then 'Chimney sweep and inspection'
                when 'Pressure Washing' then 'Driveway and patio wash' else 'General enquiry' end,
  case division when 'Aircon' then 320 when 'Chimney' then 380 when 'Pressure Washing' then 450 else 200 end,
  case when status = 'Won' then case division when 'Aircon' then 340 when 'Chimney' then 395 when 'Pressure Washing' then 480 else 220 end else 0 end,
  case when status = 'Lost' then (array['noAnswer','tooExpensive','outsideArea','notInterested'])[1 + i % 4] end,
  created::timestamptz + interval '1 day',
  case when status = 'Booked' then current_date + (i % 6) + 1 end,
  case when i % 9 = 0 then array['vip'] else '{}'::text[] end,
  'Demo lead (fictional customer).',
  case when status <> 'New' then created::timestamptz + interval '2 hours' end
from g;

-- a job for every won lead, linked both ways
with won as (
  select id, full_name, division, created_at, row_number() over (order by created_at desc) rn from public.contacts where status = 'Won'
), ins as (
  insert into public.jobs (customer_name, invoice_number, date, technician, job_type, commission_percent, amount, includes_gst, payment_status,
    payment_method, date_paid, paid_to_technician, entered_by, review_taken, contact_id, notes, parts_cost)
  select full_name, 'INV-' || (2000 + rn), created_at + 3, case when rn % 2 = 0 then 'Chris Novak' else 'Taylor Brooks' end,
    division, case when rn % 2 = 0 then 30 else 27.5 end,
    case division when 'Aircon' then 340 when 'Chimney' then 395 when 'Pressure Washing' then 480 else 220 end, true,
    case when rn % 6 = 0 then 'Unpaid' else 'Paid' end, (array['Card','Bank transfer','Cash'])[1 + rn % 3],
    case when rn % 6 = 0 then null else created_at + 4 end,
    case when rn % 3 = 0 then 'Paid' else 'Not Paid' end, 'Riley Ortiz', rn % 4 = 0, id, 'Demo job.', case when rn % 5 = 0 then 45 else 0 end
  from won returning id, contact_id
)
update public.contacts c set linked_job_id = ins.id from ins where c.id = ins.contact_id;

-- quotes for the quoted / follow-up leads
insert into public.quotes (customer, date, amount, status, notes, email, address, service_types, sent, technician_quoted, next_action)
select full_name, created_at, estimated_value + 150, 'In Discussion', 'Demo quote.', email, postcode, array[division], true, 'Chris Novak', 'Follow up by phone'
from public.contacts where status in ('Quoted', 'Follow-up');

-- tasks: the office board and the technicians' boards
insert into public.tasks (board, title, status, due, notes, client, priority, assigned_to, assignees, created_by, category, contact_id)
select case when i % 3 = 2 then w.who else 'ron' end,
  (array['Call back about the quote','Send the invoice reminder','Confirm tomorrow''s booking','Order replacement filters',
         'Check the review request went out','Update the customer address'])[1 + i % 6],
  (array['Not Started','In Progress','Waiting on Response','Done'])[1 + i % 4],
  current_date + (i % 7) - 2, 'Demo task.', c.full_name, (array['High','Medium','Low'])[1 + i % 3],
  case when i % 3 = 2 then w.who else 'Riley Ortiz' end,
  array[case when i % 3 = 2 then w.who else 'Riley Ortiz' end],
  'Jordan Lee', 'Client-related', c.id
from generate_series(0, 11) i
cross join lateral (select case when i % 2 = 0 then 'Chris Novak' else 'Taylor Brooks' end as who) w
cross join lateral (select id, full_name from public.contacts order by created_at desc, id offset i limit 1) c;

-- phone calls over the last few days (some missed)
insert into public.calls (call_sid, direction, from_number, to_number, contact_id, status, answered_by, duration, missed, started_at, ended_at, division)
select 'CA_demo_' || i, case when i % 4 = 3 then 'outbound' else 'inbound' end,
  case when i % 4 = 3 then '1300 975 707' else c.phone end, case when i % 4 = 3 then c.phone else '1300 975 707' end,
  c.id, case when i % 5 = 1 then 'no-answer' else 'completed' end, case when i % 5 = 1 then null else 'Riley Ortiz' end,
  case when i % 5 = 1 then 0 else 60 + (i * 37) % 400 end, i % 5 = 1,
  now() - (i * interval '7 hours'), now() - (i * interval '7 hours') + interval '3 minutes', c.division
from generate_series(0, 19) i
cross join lateral (select id, phone, division from public.contacts order by created_at desc, id offset (i % 25) limit 1) c;

-- a short text conversation on the newest leads
insert into public.lead_messages (contact_id, channel, direction, body, author, auto, phone, status, at)
select c.id, 'sms', d.dir, d.body, case when d.dir = 'out' then 'Riley Ortiz' end, false, c.phone, case when d.dir = 'out' then 'delivered' end,
  c.created_at::timestamptz + d.off
from (select id, phone, created_at from public.contacts order by created_at desc, id limit 6) c
cross join (values ('in', 'Hi, can I get a price for cleaning 2 split systems?', interval '9 hours'),
                   ('out', 'Hi! Thanks for reaching out. Two units are $340 incl. GST. Would Thursday suit?', interval '10 hours')) d(dir, body, off);

-- suppliers / contractors and equipment
insert into public.suppliers (name, supply_type, contact_person, phone, email, address_website, payment_terms, services) values
  ('Coolparts Wholesale',       'Parts supplier', 'Dana Price', '0491 570 006', 'orders@coolparts.example.com', 'coolparts.example.com', '30 days',    '{}'),
  ('Peak Ladder Hire',          'Equipment hire', 'Alex Grant', '0491 570 737', 'hire@peakladders.example.com', 'peakladders.example.com', 'On account', '{}'),
  ('Sparkle Exterior Cleaning', 'Contractor',     'Jamie Fox',  '0491 571 266', 'jamie@sparkle.example.com',    'sparkle.example.com',   '7 days',     '{"Pressure Washing"}');
insert into public.equipment_catalog (name, other_source, price, category, description) values
  ('Coil cleaning spray (6 pack)', 'Coolparts Wholesale', 54,  'Consumables', 'Demo item'),
  ('Wet/dry vacuum',               'Coolparts Wholesale', 289, 'Tools',       'Demo item'),
  ('Chimney brush kit',            'Online',              145, 'Tools',       'Demo item'),
  ('Surface cleaner 20 inch',      'Online',              410, 'Tools',       'Demo item');

-- reminders, closings, the office daily log, ad spend
insert into public.manual_reminders (contact_id, contact_name, title, date, note)
select id, full_name, 'Follow up on the quote', current_date + 1, 'Demo reminder' from public.contacts where status = 'Follow-up' limit 3;
insert into public.closings (technician_name, date, customer_name, invoice_number, job_type, amount, includes_gst, payment_status, payment_method, notes, posted_by)
select technician, date, customer_name, invoice_number, job_type, amount, true, payment_status, payment_method, 'Demo closing', technician
from public.jobs order by date desc limit 6;
insert into public.sales_daily_log (person, date, hours, bookings_aircon, bookings_chimney, bookings_pw, updated_by)
select 'Riley Ortiz', current_date - i, 7.5, (i*3) % 4, (i*5) % 2, (i*7) % 2, 'Riley Ortiz'
from generate_series(1, 14) i where extract(dow from current_date - i) between 1 and 5;
insert into public.ad_spend (date, channel, spend, leads_reported)
select current_date - i, ch, round((40 + (i*13) % 60)::numeric, 2), i % 3
from generate_series(1, 30) i cross join (values ('Google Ads'), ('Meta Ads')) v(ch);

select (select count(*) from public.contacts) contacts, (select count(*) from public.jobs) jobs, (select count(*) from public.quotes) quotes,
       (select count(*) from public.tasks) tasks, (select count(*) from public.calls) calls, (select count(*) from public.employees) employees;
