#!/usr/bin/env node
// Regression tests for the pure calculation functions inside index.html — everything that turns raw
// jobs/contacts/ad_spend rows into the numbers shown on the CRM Overview, Financial Summary, and
// Business Performance pages. index.html is one big inline <script>, so there's no module system to
// `require()` from; instead this file re-extracts the named functions/constants straight out of the
// live index.html source (see extractDecl below) and evals them into a sandbox before every run. That
// means these tests always exercise the CURRENT code, not a stale copy — if someone edits a formula in
// index.html, this file picks it up automatically without needing to be kept in sync by hand.
//
// Run: node tests/business-logic.test.js
// Exits 1 (and prints which assertion failed) on any failure, 0 when everything passes — safe to wire
// into a pre-push hook or CI later if this project ever gets one.
//
// Adding a new function to test: add its name to DECLS below (functions and consts both work), then
// write assertions against it in one of the test*() functions — see the existing ones for the pattern
// (build a small STATE.data fixture, call the function, assert on the shape you already worked out by
// hand). Keep fixtures small and the expected numbers hand-computed in a comment, the same way the
// existing tests do — a fixture whose expected values were computed by *running* the code proves nothing.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const INDEX_HTML_PATH = path.join(__dirname, '..', 'index.html');

const DECLS = [
  // date/money primitives
  'MONTHS', 'MONTHS_FULL', 'pad2', 'parseLocalDate', 'fmtLocal', 'daysBetween', 'round2', 'todayStr',
  'weekOf', 'monthOf', 'currentWeekKey',
  'jobGst', 'jobTotalCollected', 'employeeByName', 'commissionDeductsParts', 'jobCommissionBase', 'jobCommissionAmount', 'commissionRateFor',
  // constants the functions below key off of
  'JOB_TYPES', 'LEAD_DIVISIONS', 'LEAD_SOURCES', 'LEAD_SOURCE_COLOR', 'AIRCON_TYPE_TAGS', 'META_PLATFORM_TAGS',
  // CRM / attribution
  'findContactByName', 'jobAttributionTags', 'computeCrmStats',
  // financial rollups
  'commissionEligibleTechnicianNames', 'computeWeek', 'computeMonth',
  // business performance
  'blankPerfBucket', 'addToPerfBucket', 'finalizePerfBucket', 'computeProfitByWeekInRange', 'computeBusinessPerformance',
  'contactHasJob',
  // reminders
  'fmtDateShort', 'computeReminders',
  // payroll + net profit
  'PAYROLL_HOURLY_RATE', 'PAYROLL_BOOKING_BONUS', 'PAYROLL_HEBREW_NAMES', 'bookingBonus', 'nextBookingTier',
  'salesLogBookings', 'salesLogPay', 'payrollWeekOf', 'shiftPayrollWeek', 'payrollRangeText', 'payMoney', 'jobPaidDate',
  'computePayrollCommission', 'computePayrollHourly', 'buildCommissionPayMessage', 'buildHourlyPayMessage', 'shiftDays',
  'computeNetProfit',
];

function extractDecl(source, name){
  const fnIdx = source.indexOf(`function ${name}(`);
  const constIdx = source.search(new RegExp(`\\bconst ${name}\\s*=`));
  if (fnIdx === -1 && constIdx === -1) throw new Error(`extractDecl: "${name}" not found in index.html — was it renamed?`);
  if (fnIdx !== -1 && (constIdx === -1 || fnIdx < constIdx)) {
    const braceStart = source.indexOf('{', fnIdx);
    let depth = 1, i = braceStart + 1;
    while (depth > 0) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') depth--;
      i++;
    }
    return source.slice(fnIdx, i);
  }
  // const NAME = <expr>; — scan for the statement-ending ";" outside any (), [], {}
  let i = constIdx, depth = 0;
  const start = i;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 0) { i++; break; }
  }
  return source.slice(start, i);
}

function loadSandbox(){
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const src = DECLS.map(name => extractDecl(script, name)).join('\n\n');
  const sandbox = {
    STATE: { data: { settings: { gstRatePercent: 10 }, contacts: [], jobs: [], adSpend: [], quotes: [], equipmentSpend: [], employees: [] } },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'index.html (extracted)' });
  // Top-level `const`/`let` in a vm-executed script don't become properties of the sandbox object (only
  // `function`/`var` do) — functions defined in the same script still see them via closure (that's all
  // the extracted functions above need), but this test file itself needs a couple of the constants by
  // name too, so re-read them explicitly in the same context.
  DECLS.forEach(name => { if (sandbox[name] === undefined) sandbox[name] = vm.runInContext(name, sandbox); });
  return sandbox;
}

let pass = 0, fail = 0;
function assertEqual(actual, expected, label){
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`);
}
function assertClose(actual, expected, label, eps){
  eps = eps===undefined ? 0.01 : eps;
  if (typeof actual === 'number' && typeof expected === 'number' && Math.abs(actual-expected) <= eps) { pass++; return; }
  fail++;
  console.error(`FAIL: ${label}\n  expected ~${expected}\n  actual:   ${actual}`);
}

function testJobAttributionTags(sb){
  sb.STATE.data.contacts = [
    { fullName:'Lynette Trotter', source:'Meta Ads', tags:['Duct System','Instagram'] },
    { fullName:'Split Sam', source:'Google Ads', tags:['Split System'] },
    { fullName:'No Match', source:'Organic', tags:[] },
  ];
  assertEqual(sb.jobAttributionTags({ customerName:'Lynette Trotter', jobType:'Aircon' }), { airconType:'Duct System', metaPlatform:'Instagram' }, 'jobAttributionTags: Aircon + Meta Ads lead carries both tags');
  assertEqual(sb.jobAttributionTags({ customerName:'Split Sam', jobType:'Aircon' }), { airconType:'Split System', metaPlatform:null }, 'jobAttributionTags: Google Ads lead never gets a platform tag');
  assertEqual(sb.jobAttributionTags({ customerName:'Lynette Trotter', jobType:'Chimney' }), { airconType:null, metaPlatform:'Instagram' }, 'jobAttributionTags: airconType only applies to Aircon jobType');
  assertEqual(sb.jobAttributionTags({ customerName:'Nobody Here', jobType:'Aircon' }), { airconType:null, metaPlatform:null }, 'jobAttributionTags: no matching contact -> both null');
}

function testComputeMonth(sb){
  sb.STATE.data.jobs = [
    { id:'1', customerName:'Lynette Trotter', jobType:'Aircon', date:'2026-09-05', amount:1000, commissionPercent:20, partsCost:50, paymentStatus:'Paid', technician:'Guy' },
    { id:'2', customerName:'Split Sam', jobType:'Aircon', date:'2026-09-06', amount:500, commissionPercent:20, partsCost:0, paymentStatus:'Unpaid', technician:'Guy' },
  ];
  sb.STATE.data.contacts = [
    { fullName:'Lynette Trotter', source:'Meta Ads', tags:['Duct System','Instagram'] },
    { fullName:'Split Sam', source:'Google Ads', tags:['Split System'] },
  ];
  sb.STATE.data.employees = [{ name:'Guy', roles:['Technician'] }];
  const m = sb.computeMonth(sb.STATE.data, '2026-09');
  // Hand-computed: revenue = 1000+500 = 1500; commission = 200+100 = 300; parts = 50
  assertEqual(m.revenue, 1500, 'computeMonth: revenue sums job.amount');
  // Pay model (Sep 2026): commission is taken AFTER the job's expenses. job1: (1000-50)*20% = 190; job2: 500*20% = 100.
  assertEqual(m.commission, 290, 'computeMonth: commission is 20% of (job.amount - partsCost)');
  assertEqual(m.parts, 50, 'computeMonth: parts sums job.partsCost');
  // Duct System (Lynette) = 1000; Split System (Split Sam) = 500; Instagram (Lynette) = 1000; Facebook = 0
  assertEqual(m.airconTypeRevenue, { 'Split System':500, 'Duct System':1000 }, 'computeMonth: airconTypeRevenue splits by tag');
  assertEqual(m.metaPlatformRevenue, { Facebook:0, Instagram:1000 }, 'computeMonth: metaPlatformRevenue splits by tag');
  // additive invariant: sub-division revenue never exceeds the parent total
  const airconSum = Object.values(m.airconTypeRevenue).reduce((s,v)=>s+v,0);
  if (airconSum > m.revenue) { fail++; console.error(`FAIL: computeMonth additive invariant — airconTypeRevenue sum (${airconSum}) exceeds total revenue (${m.revenue})`); } else pass++;
}

function testComputeBusinessPerformance(sb){
  sb.STATE.data.contacts = [
    { fullName:'Lynette Trotter', source:'Meta Ads', status:'Booked', createdAt:'2026-09-02', tags:['Duct System','Instagram'] },
    { fullName:'Split Sam', source:'Google Ads', status:'Booked', createdAt:'2026-09-03', tags:['Split System'] },
    { fullName:'FB Fiona', source:'Meta Ads', status:'Not Relevant', createdAt:'2026-09-04', tags:['Facebook'] },
    { fullName:'No Tag Nick', source:'Meta Ads', status:'Booked', createdAt:'2026-09-05', tags:[] },
    { fullName:'Organic Olly', source:'Organic', status:'New', createdAt:'2026-09-06', tags:[] },
  ];
  sb.STATE.data.jobs = [
    { id:'1', customerName:'Lynette Trotter', jobType:'Aircon', date:'2026-09-05', amount:1000, commissionPercent:20, partsCost:50, paymentStatus:'Paid', datePaid:'2026-09-08', technician:'Guy', reviewTaken:true },
    { id:'2', customerName:'Split Sam', jobType:'Aircon', date:'2026-09-06', amount:500, commissionPercent:20, partsCost:0, paymentStatus:'Unpaid', technician:'Guy', reviewTaken:false },
    { id:'4', customerName:'No Tag Nick', jobType:'Aircon', date:'2026-09-08', amount:200, commissionPercent:20, partsCost:0, paymentStatus:'Paid', datePaid:'2026-09-09', technician:'Dolev', reviewTaken:true },
    { id:'5', customerName:'Unmatched Customer', jobType:'Chimney', date:'2026-09-09', amount:150, commissionPercent:30, partsCost:0, paymentStatus:'Paid', datePaid:'2026-09-09', technician:'Dolev', reviewTaken:false },
  ];
  sb.STATE.data.adSpend = [
    { date:'2026-09-05', channel:'Meta Ads', spend:100 },
    { date:'2026-09-06', channel:'Meta Ads', spend:120 },
    { date:'2026-09-05', channel:'Google Ads', spend:80 },
  ];
  sb.STATE.data.quotes = [
    { date:'2026-09-03', status:'Approved' },
    { date:'2026-09-04', status:'Rejected' },
    { date:'2026-09-05', status:'In Discussion' }, // still open — must not count toward conversion
  ];
  sb.STATE.data.employees = [{ name:'Guy', roles:['Technician'] }, { name:'Dolev', roles:['Technician'] }];

  const perf = sb.computeBusinessPerformance(sb.STATE.data, '2026-09-01', '2026-09-10');

  // Hand-computed exactly as verified live against the deployed app on 2026-09-10 (see chat history) —
  // this fixture is the same one, kept here so a future edit can be checked against a known-good answer.
  assertEqual(perf.totalRevenue, 1850, 'computeBusinessPerformance: totalRevenue = sum of all job amounts');
  // job1 profit is now 1000 - 190 (20% of 1000-50) - 50 = 760 (was 750 before commission moved after expenses) -> 1415 + 10.
  assertEqual(perf.totalProfit, 1425, 'computeBusinessPerformance: totalProfit = sum of division profits');
  assertEqual(perf.totalLeads, 5, 'computeBusinessPerformance: totalLeads = contacts created in range');
  assertEqual(perf.overallCloseRate, 75, 'computeBusinessPerformance: overallCloseRate = booked / (booked+notRelevant)');
  assertEqual(perf.reviewRate, 50, 'computeBusinessPerformance: reviewRate = jobs with reviewTaken / all jobs');
  assertEqual(perf.byDivision.Aircon.profit, 1320, 'computeBusinessPerformance: byDivision.Aircon.profit');
  assertEqual(perf.byChannel['Google Ads'].roas, 6.25, 'computeBusinessPerformance: Google Ads ROAS = revenue/spend');
  assertEqual(perf.byChannel['Meta Ads'].costPerLead, 73.33, 'computeBusinessPerformance: Meta Ads cost/lead = spend/leads');
  assertEqual(perf.byChannel['Google Maps'].spend, null, 'computeBusinessPerformance: a channel with no ad_spend rows stays null, not 0');
  assertEqual(perf.quoteConversionRate, 50, 'computeBusinessPerformance: quoteConversionRate ignores still-open quotes');
  // job1: 09-05 -> 09-08 = 3 days; job4: 09-08 -> 09-09 = 1 day; job5: 09-09 -> 09-09 = 0 days.
  // (3+1+0)/3 = 1.33, rounded to the nearest whole day by the function itself -> 1.
  assertEqual(perf.avgDaysToPayment, 1, 'computeBusinessPerformance: avgDaysToPayment averages (datePaid - date) across paid jobs with a datePaid, rounded');
  assertEqual(perf.outstanding, 500, 'computeBusinessPerformance: outstanding = sum of unpaid job amounts');
  assertEqual(perf.profitMargin, Math.round((1425/1850)*100), 'computeBusinessPerformance: profitMargin = totalProfit/totalRevenue');

  // additive invariant, same as testComputeMonth: no sub-slice may exceed its parent total
  const channelRevenueSum = sb.LEAD_SOURCES.reduce((s,c)=>s+perf.byChannel[c].revenue, 0);
  if (channelRevenueSum > perf.totalRevenue + 0.01) { fail++; console.error(`FAIL: computeBusinessPerformance additive invariant — channel revenue sum (${channelRevenueSum}) exceeds totalRevenue (${perf.totalRevenue})`); } else pass++;
}

function testFunnelLossReasonsSpeedToLead(sb){
  // Added 2026-09-10 after the GHL 90-day import surfaced real loss-reason tags (19 price / 32
  // outside-area / 7 wrong-number / 117 untagged, out of 175 Not Relevant) and Ofek asked for a
  // lead->job funnel and speed-to-lead metric built from data that already exists (no new fields).
  sb.STATE.data.contacts = [
    { fullName:'Alice', source:'Organic', status:'Booked', createdAt:'2026-09-02', tags:['not interested - price'], estimatedValue:500,
      messages:[{kind:'event',at:'2026-09-02T10:00:00Z'},{kind:'outbound',at:'2026-09-02T10:05:00Z'}] }, // 5 min reply
    { fullName:'Bob', source:'Organic', status:'Not Relevant', createdAt:'2026-09-03', tags:['not interested - price'] },
    { fullName:'Carol', source:'Organic', status:'Not Relevant', createdAt:'2026-09-03', tags:['outside service area'] },
    { fullName:'Dave', source:'Organic', status:'Not Relevant', createdAt:'2026-09-04', tags:['wrong number'] },
    { fullName:'Eve', source:'Organic', status:'Not Relevant', createdAt:'2026-09-04', tags:[] },
    { fullName:'Frank', source:'Organic', status:'New', createdAt:'2026-09-05', tags:[] },
    { fullName:'Grace', source:'Organic', status:'Follow-up', createdAt:'2026-09-05', tags:[],
      messages:[{kind:'event',at:'2026-09-05T09:00:00Z'},{kind:'outbound',at:'2026-09-05T09:30:00Z'}] }, // 30 min reply
  ];
  sb.STATE.data.jobs = [
    { id:'1', customerName:'Alice', jobType:'Aircon', date:'2026-09-05', amount:500, commissionPercent:20, partsCost:0, paymentStatus:'Paid', technician:'Guy' },
  ];
  sb.STATE.data.quotes = [ { customer:'Alice', date:'2026-09-03', status:'Approved' } ];
  sb.STATE.data.adSpend = [];
  sb.STATE.data.employees = [{ name:'Guy', roles:['Technician'] }];

  const perf = sb.computeBusinessPerformance(sb.STATE.data, '2026-09-01', '2026-09-10');

  assertEqual(perf.funnel, { leads:7, contacted:6, priceGiven:1, booked:1, jobDone:1 }, 'funnel: leads/contacted(status!=New)/priceGiven(estimatedValue>0)/booked/jobDone(by name)');
  assertEqual(perf.lossReasons, { price:1, outsideArea:1, wrongNumber:1, noReasonGiven:1 }, 'lossReasons: first-match-wins tag classification of Not Relevant leads');
  assertEqual(perf.speedToLead.sampleSize, 2, 'speedToLead: only counts contacts with >=2 messages and a non-event reply');
  // Alice: 5 min = 0.0833h, Grace: 30 min = 0.5h -> avg 0.2917 (rounds to 0.29), median (upper of the two) 0.5
  assertClose(perf.speedToLead.avgHours, 0.29, 'speedToLead: avgHours across both replies', 0.01);
  assertClose(perf.speedToLead.medianHours, 0.5, 'speedToLead: medianHours', 0.01);
}

function testComputeProfitByWeekInRange(sb){
  // computeProfitByWeekInRange goes through computeWeek(), which (unlike computeMonth/
  // computeBusinessPerformance above) also touches data.equipmentSpend — this fixture caught a real
  // gap when the Business Performance page was first verified live: computeWeek() threw on
  // `data.equipmentSpend.filter` when a fixture forgot the field. Every production data object always
  // has it (loadFromSupabase defaults it to []), so this is fixture hygiene, not a real-world case —
  // but that's exactly why it's worth a dedicated test: the next fixture that forgets it should fail
  // here, not get discovered by hand in the browser again.
  sb.STATE.data.equipmentSpend = [];
  sb.STATE.data.employees = [{ name:'Guy', roles:['Technician'] }, { name:'Dolev', roles:['Technician'] }];
  sb.STATE.data.jobs = [
    { id:'1', customerName:'Lynette Trotter', jobType:'Aircon', date:'2026-09-05', amount:1000, commissionPercent:20, partsCost:50, paymentStatus:'Paid', technician:'Guy' },
    { id:'2', customerName:'Split Sam', jobType:'Aircon', date:'2026-09-06', amount:500, commissionPercent:20, partsCost:0, paymentStatus:'Unpaid', technician:'Guy' },
    { id:'4', customerName:'No Tag Nick', jobType:'Aircon', date:'2026-09-08', amount:200, commissionPercent:20, partsCost:0, paymentStatus:'Paid', technician:'Dolev' },
    { id:'5', customerName:'Unmatched Customer', jobType:'Chimney', date:'2026-09-09', amount:150, commissionPercent:30, partsCost:0, paymentStatus:'Paid', technician:'Dolev' },
  ];
  const weeks = sb.computeProfitByWeekInRange(sb.STATE.data, '2026-09-01', '2026-09-10');
  // Week of 31 Aug–6 Sep: job1 (profit 1000-190-50=760; commission is 20% of 1000-50) + job2 (profit 500-100-0=400) = 1160.
  // Week of 7 Sep–13 Sep: job4 (profit 200-40-0=160) + job5 (profit 150-45-0=105) = 265.
  assertEqual(weeks.length, 2, 'computeProfitByWeekInRange: buckets the range into the 2 weeks it spans');
  assertEqual(weeks[0].revenue, 1160, 'computeProfitByWeekInRange: first week profit (property is named "revenue" to match renderSparkline\'s expected shape)');
  assertEqual(weeks[1].revenue, 265, 'computeProfitByWeekInRange: second week profit');
}

function testRepeatServiceReminder(sb){
  // Added 2026-09-10 per Ofek's spec: a job that's exactly 358 days old (365 minus a 7-day lead time)
  // should surface a "call to re-offer the service" reminder for that one day only. Since
  // computeReminders is recomputed fresh on every render (never persisted), the 24h window falls out
  // naturally from the date math — no expiry field or cron needed. Fixed `now` so the fixture doesn't
  // drift with the calendar.
  const now = new Date(2026, 8, 10); // 10 Sep 2026
  const dateNDaysBefore = (n) => { const d = new Date(now); d.setDate(d.getDate()-n); return sb.fmtLocal(d); };
  sb.STATE.data.jobs = [
    { id:'due-today', customerName:'Chen Family', jobType:'Aircon', date: dateNDaysBefore(358), technician:'Guy', paymentStatus:'Paid', paidToTechnician:'Paid', partsCost:0 },
    { id:'yesterday', customerName:'Nguyen', jobType:'Chimney', date: dateNDaysBefore(359), technician:'Guy', paymentStatus:'Paid', paidToTechnician:'Paid', partsCost:0 },
    { id:'tomorrow', customerName:'Okafor', jobType:'Aircon', date: dateNDaysBefore(357), technician:'Guy', paymentStatus:'Paid', paidToTechnician:'Paid', partsCost:0 },
  ];
  sb.STATE.data.equipmentSpend = [];
  sb.STATE.data.quotes = [];
  sb.STATE.data.contacts = [];
  sb.STATE.data.manualReminders = [];
  sb.STATE.data.dismissedReminders = [];
  sb.STATE.data.readReminders = [];

  const items = sb.computeReminders(sb.STATE.data, now);
  const repeatItems = items.filter(it => it.type === 'repeat-service');
  assertEqual(repeatItems.length, 1, 'computeReminders: only the job exactly 358 days old fires the repeat-service reminder');
  assertEqual(repeatItems[0]?.key, 'repeat-service:due-today', 'computeReminders: repeat-service reminder keyed to the matching job');
  assertEqual(repeatItems[0]?.title.includes('Chen Family') && repeatItems[0]?.title.includes('Aircon'), true, 'computeReminders: repeat-service title names the customer and job type');

  // Dismissing it (same mechanism as every other reminder) hides it even though the date still matches.
  sb.STATE.data.dismissedReminders = ['repeat-service:due-today'];
  const itemsAfterDismiss = sb.computeReminders(sb.STATE.data, now);
  assertEqual(itemsAfterDismiss.filter(it => it.type === 'repeat-service').length, 0, 'computeReminders: repeat-service reminder respects the normal dismissed-reminders set');
}

function testPayroll(sb){
  // Pay model given by Ofek (Sep 2026). Employees drive the "who deducts expenses" rule.
  sb.STATE.data.employees = [
    { name:'Guy', roles:['Technician','Sales'], status:'Active', employmentType:'Freelance-commission' },
    { name:'Alessandro', roles:['Technician'], status:'Active', employmentType:'Independent Contractor' },
    { name:'Ron', roles:['VA'], status:'Active', employmentType:'Hourly' },
  ];
  // Ofek's own example: $1,000, $100 of parts, Guy at 30% -> 30% of $900 = $270.
  assertEqual(sb.jobCommissionAmount({ technician:'Guy', amount:1000, partsCost:100, commissionPercent:30 }), 270, 'commission: Guy 30% of (1000 - 100 parts) = 270');
  // Alessandro pays his own expenses -> 50% of the full ex-GST amount, parts NOT deducted.
  assertEqual(sb.jobCommissionAmount({ technician:'Alessandro', amount:1000, partsCost:100, commissionPercent:50 }), 500, 'commission: independent contractor = 50% of full amount, parts not deducted');
  assertEqual(sb.jobCommissionAmount({ technician:'Guy', amount:100, partsCost:300, commissionPercent:30 }), 0, 'commission: never negative when expenses exceed the amount');

  // Weeks are Sunday -> Saturday.
  assertEqual(sb.payrollWeekOf('2026-09-19').start, '2026-09-13', 'payrollWeekOf: Saturday belongs to the week starting the Sunday before');
  assertEqual(sb.payrollWeekOf('2026-09-13').start, '2026-09-13', 'payrollWeekOf: Sunday starts its own week');
  assertEqual(sb.payrollWeekOf('2026-09-20').start, '2026-09-20', 'payrollWeekOf: next Sunday starts a new week');
  assertEqual(sb.payrollRangeText('2026-08-23', '2026-08-29'), '23-29/8', 'payrollRangeText: same month');
  assertEqual(sb.payrollRangeText('2026-08-30', '2026-09-05'), '30/8-5/9', 'payrollRangeText: across months');

  // Week 13-19 Sep 2026, Guy at 30%. Commission lands in the week the job was PAID.
  sb.STATE.data.jobs = [
    { id:'a', technician:'Guy', invoiceNumber:'3001', customerName:'A', date:'2026-09-14', datePaid:'2026-09-14', paymentStatus:'Paid', paymentMethod:'Credit Card', amount:700, partsCost:0, commissionPercent:30, includesGST:true },   // 210
    { id:'b', technician:'Guy', invoiceNumber:'3002', customerName:'B', date:'2026-09-10', datePaid:'2026-09-15', paymentStatus:'Paid', paymentMethod:'Bank Transfer', amount:1000, partsCost:100, commissionPercent:30, includesGST:true }, // late, last week: 270
    { id:'c', technician:'Guy', invoiceNumber:'3003', customerName:'C', date:'2026-09-02', datePaid:'2026-09-16', paymentStatus:'Paid', paymentMethod:'Credit Card', amount:500, partsCost:0, commissionPercent:30, includesGST:true },   // late, 2 weeks back: 150
    { id:'d', technician:'Guy', invoiceNumber:'3004', customerName:'D', date:'2026-09-16', datePaid:'2026-09-16', paymentStatus:'Paid', paymentMethod:'Cash', amount:350, partsCost:0, commissionPercent:30, includesGST:false },         // cash: 105, $350 cash
    { id:'e', technician:'Guy', invoiceNumber:'3005', customerName:'E', date:'2026-09-17', paymentStatus:'Unpaid', paymentMethod:'', amount:400, partsCost:0, commissionPercent:30, includesGST:true },                             // expected 120
    { id:'f', technician:'Guy', invoiceNumber:'3006', customerName:'F', date:'2026-09-20', paymentStatus:'Unpaid', paymentMethod:'', amount:900, partsCost:0, commissionPercent:30, includesGST:true },                             // next week: excluded
    { id:'g', technician:'Guy', invoiceNumber:'3007', customerName:'G', date:'2026-09-12', datePaid:'2026-09-12', paymentStatus:'Paid', paymentMethod:'Credit Card', amount:800, partsCost:0, commissionPercent:30, includesGST:true },   // paid last week: excluded
    { id:'h', technician:'Alessandro', invoiceNumber:'3008', customerName:'H', date:'2026-09-14', datePaid:'2026-09-14', paymentStatus:'Paid', paymentMethod:'Credit Card', amount:600, partsCost:40, commissionPercent:50, includesGST:true }, // someone else
  ];
  const c = sb.computePayrollCommission(sb.STATE.data, 'Guy', '2026-09-13');
  assertEqual(c.lines.map(l=>l.job.id).join(','), 'c,b,a,d', 'payroll: paid-this-week jobs only, oldest job first');
  assertEqual(c.total, 735, 'payroll: total = 210 + 270 + 150 + 105');
  assertEqual(c.lines.find(l=>l.job.id==='b').fromLastWeek, true, 'payroll: job from last week flagged fromLastWeek');
  assertEqual(c.lines.find(l=>l.job.id==='c').fromLastWeek, false, 'payroll: job from 2 weeks back is late but not "last week"');
  assertEqual(c.lines.find(l=>l.job.id==='c').late, true, 'payroll: job from 2 weeks back is late');
  assertEqual(c.unpaid.length, 1, 'payroll: unpaid = jobs done by week end still unpaid (next week excluded)');
  assertEqual(c.expected, 120, 'payroll: expected commission of the unpaid job');
  assertEqual(c.cash, 350, 'payroll: cash to collect = cash jobs paid this week (no GST on this one)');
  assertEqual(c.percent, 30, 'payroll: single rate shown in the message header');
  const msg = sb.buildCommissionPayMessage(c);
  const expectedMsg = [
    'היי גיא 👋',
    'סיכום שכר שבועי (13-19/9):',
    'עמלה על עבודות השבוע (30%):',
    '* #3003 (נסגרה מ-2/9): $150.00',
    '* #3002 (נסגרה משבוע שעבר): $270.00',
    '* #3001: $210.00',
    '* #3004: $105.00',
    '',
    '💰 סה"כ לתשלום: $735.00',
    '⚠️ עבודה אחת עדיין לא שולמה - תיכנס לשבוע שבו תיסגר (עמלה צפויה: $120.00)',
    'מזומן שנאסף השבוע: $350.00 - צריך להעביר לאופק',
    'שבוע טוב!',
  ].join('\n');
  assertEqual(msg, expectedMsg, 'payroll: Hebrew pay message for Guy matches Ofek\'s format');
  const aMsg = sb.buildCommissionPayMessage(sb.computePayrollCommission(sb.STATE.data, 'Alessandro', '2026-09-13'));
  assertEqual(aMsg.split('\n')[0], 'Hi Alessandro 👋', 'payroll: Alessandro gets his message in English');
  assertEqual(aMsg.includes('💰 Total to pay: $300.00'), true, 'payroll: Alessandro 50% of 600 (parts not deducted) = 300');

  // Ron: $10/h + daily bonus on that day's bookings (5-7 -> $10, 8-11 -> $15, 12+ -> $25).
  assertEqual([4,5,7,8,11,12,30].map(n=>sb.bookingBonus(n)).join(','), '0,10,10,15,15,25,25', 'bookingBonus tiers');
  assertEqual(sb.nextBookingTier(3), { needed:2, bonus:10 }, 'nextBookingTier: 3 bookings -> 2 more for $10');
  assertEqual(sb.nextBookingTier(12), null, 'nextBookingTier: top tier reached');
  sb.STATE.data.salesLogs = [
    { person:'Ron', date:'2026-09-14', hours:8,   bookingsAircon:3, bookingsChimney:1, bookingsPw:1 },  // 5 -> $10, pay 90
    { person:'Ron', date:'2026-09-15', hours:8.5, bookingsAircon:6, bookingsChimney:2, bookingsPw:0 },  // 8 -> $15, pay 100
    { person:'Ron', date:'2026-09-16', hours:8,   bookingsAircon:9, bookingsChimney:2, bookingsPw:1 },  // 12 -> $25, pay 105
    { person:'Ron', date:'2026-09-17', hours:7.5, bookingsAircon:4, bookingsChimney:0, bookingsPw:0 },  // 4 -> $0, pay 75
    { person:'Ron', date:'2026-09-18', hours:8,   bookingsAircon:5, bookingsChimney:1, bookingsPw:1 },  // 7 -> $10, pay 90
    { person:'Ron', date:'2026-09-21', hours:8,   bookingsAircon:9, bookingsChimney:9, bookingsPw:9 },  // next week: excluded
  ];
  const h = sb.computePayrollHourly(sb.STATE.data, 'Ron', '2026-09-13');
  assertEqual(h.hours, 40, 'hourly: hours this week');
  assertEqual(h.bookings, 36, 'hourly: bookings this week');
  assertEqual(h.bonuses, 60, 'hourly: bonuses 10+15+25+0+10');
  assertEqual(h.total, 460, 'hourly: 40h x $10 + $60 bonuses');
  assertEqual(sb.buildHourlyPayMessage(h), 'Hi Ron 👋\nYour salary this week (14-18/9) + bonuses is $460.00.\nPlease upload your receipt to Dext.\nHave a good week!', 'hourly: Ron\'s English message uses the days he worked');

  // Net profit = revenue - commissions - job expenses - equipment - marketing - Ron - owners (prorated per day).
  sb.STATE.data.jobs = [
    { technician:'Guy', date:'2026-09-14', amount:1000, partsCost:100, commissionPercent:30 },        // commission 270
    { technician:'Alessandro', date:'2026-09-16', amount:500, partsCost:50, commissionPercent:50 },   // commission 250
  ];
  sb.STATE.data.equipmentSpend = [{ date:'2026-09-15', cost:60 }, { date:'2026-09-25', cost:999 }];
  sb.STATE.data.adSpend = [{ date:'2026-09-14', channel:'Google Ads', spend:200 }, { date:'2026-09-14', channel:'Meta Ads', spend:100 }];
  sb.STATE.data.salesLogs = [{ person:'Ron', date:'2026-09-14', hours:8, bookingsAircon:5, bookingsChimney:0, bookingsPw:0 }]; // 90
  sb.STATE.data.settings = { gstRatePercent:10, ownerSalaries:{ Ofek:1200, Noam:1200 } };
  const np = sb.computeNetProfit(sb.STATE.data, '2026-09-13', '2026-09-19', new Date(2026, 8, 22));
  // 1500 - 520 - 150 - 60 - 300 - 90 - 2400 = -2020
  assertEqual([np.revenue, np.commission, np.parts, np.equipment, np.marketing, np.hourlyStaff, np.owners, np.net].join(','), '1500,520,150,60,300,90,2400,-2020', 'netProfit: full week breakdown');
  const npCapped = sb.computeNetProfit(sb.STATE.data, '2026-09-13', '2026-09-19', new Date(2026, 8, 15));
  // capped at 15 Sep: 3 days of owner salary (2400*3/7 = 1028.57); the 16 Sep job is not counted yet
  assertEqual([npCapped.days, npCapped.owners, npCapped.revenue].join(','), '3,1028.57,1000', 'netProfit: range capped at today');
  sb.STATE.data.settings = { gstRatePercent:10 };
}

testJobAttributionTags(loadSandbox());
testComputeMonth(loadSandbox());
testComputeBusinessPerformance(loadSandbox());
testFunnelLossReasonsSpeedToLead(loadSandbox());
testComputeProfitByWeekInRange(loadSandbox());
testRepeatServiceReminder(loadSandbox());
testPayroll(loadSandbox());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
