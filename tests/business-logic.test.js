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
  'jobGst', 'jobTotalCollected', 'amountExGst', 'employeeByName', 'commissionDeductsParts', 'jobCommissionBase', 'jobCommissionAmount', 'commissionRateFor',
  // constants the functions below key off of
  'JOB_TYPES', 'LEAD_DIVISIONS', 'LEAD_SOURCES', 'LEAD_SOURCE_COLOR', 'AIRCON_TYPE_TAGS', 'META_PLATFORM_TAGS', 'LOST_REASONS', 'lostReasonOf', 'SUB_DIVISIONS', 'SUB_SOURCES', 'SYSTEM_TAGS', 'leadSubDivisions', 'leadSubSource', 'visibleTags', 'subSourceOptions', 'LEAD_STATUSES', 'LEAD_STAGE_LABEL', 'stageLabel', 'STAGES_NEED_DATE', 'PIPELINE_RULES_FROM', 'JOB_CACHE', 'jobIndex', 'leadLatestJobDate', 'leadWonByJob', 'leadStage', 'followupDue', 'leadRulesApply', 'leadNeedsFutureDate', 'isWorkday', 'chaseCounter', 'sydneyWall', 'chaseAlertDue',
  // CRM / attribution
  'findContactByName', 'contactForJob', 'jobAttributionTags', 'computeCrmStats',
  // financial rollups
  'commissionEligibleTechnicianNames', 'computeWeek',
  // business performance
  'blankPerfBucket', 'addToPerfBucket', 'finalizePerfBucket', 'computeProfitByWeekInRange', 'computeBusinessPerformance',
  'contactHasJob',
  // reminders
  'fmtDateShort', 'computeReminders',
  // payroll + net profit
  'PAYROLL_HOURLY_RATE', 'PAYROLL_BOOKING_BONUS', 'PAYROLL_HEBREW_NAMES', 'bookingBonus', 'nextBookingTier',
  'salesLogBookings', 'salesLogPay', 'payrollWeekOf', 'shiftPayrollWeek', 'payrollRangeText', 'payMoney', 'jobPaidDate',
  'computePayrollCommission', 'computePayrollHourly', 'buildCommissionPayMessage', 'buildHourlyPayMessage', 'shiftDays',
  'PAYROLL_REMINDERS_FROM', 'payrollStatus', 'payrollCommissionPeople', 'payrollHourlyPeople', 'paymentTermDays', 'jobDaysWaiting', 'jobIsLate',
  'computeNetProfit',
  // dashboard
  'localDay', 'GOOGLE_ADS_AIRCON_ACCOUNT', 'callDivision', 'summarizeCalls', 'DASH_RANGES', 'resolveDashboardRange',
  // sales automations + My Day
  'fmtMoney', 'workClockDue', 'sydneyNowPast', 'NEW_LEAD_ALERT_FROM', 'leadArrivedAt', 'newLeadUnhandled', 'chaseTooLong', 'quoteStale', 'bookedNoJob', 'MY_DAY_NEW_DAYS', 'myDayLists',
  // My Day counters (3 Oct)
  'esc', 'quoteDueReason', 'shiftDaySummary', 'latePaymentDue', 'latePaymentDoneToday', 'reofferDue', 'assigneeNames', 'taskAssignedTo', 'myTaskDue', 'teamTaskDue', 'MD_BUBBLES', 'MD_HE', 'mdTaskLines', 'DIV_HE', 'MD_FROM_HE', 'mdBookingLinesHe', 'mdPeriodBubbles', 'mdCounts', 'mdStoredCounts', 'mdWeekCounts', 'mdBookingsTable', 'chasingLostStats',
  // review requests (5 Oct)
  'reviewInvoiceKey', 'reviewNeed',
  // Jobs & Commissions period (6 Oct)
  'JOBS_RANGES', 'jobsRangeBounds',
  // equipment & materials paid back with the weekly pay (6 Oct)
  'equipReimbursedFor', 'partsRefundFor', 'partsRefundPatch', 'materialsGst', 'payrollMaterialItems', 'computePayrollMaterials', 'computeGstSummary', 'profitSteps', 'techWeekStats',
  // Payroll periods (6 Oct)
  'payrollPeriod', 'techPeriodStats', 'hourlyPeriodStats',
  // Tasks views + Expenses & receipts (7 Oct)
  'boardForAssignees', 'tasksInView', 'taskPeople', 'SPEND_CATEGORIES', 'expenseRows', 'filterExpenseRows', 'supplierNames', 'KNOWN_STORES', 'storeWords', 'storeWordMatch', 'findStoreInText',
  // The technician's weekly invoices, made by the app (7 Oct)
  'payrollInvoiceNumber', 'buildPayrollInvoice', 'payrollInvoiceMissing', 'fmtAbn',
  // Bonuses, invoice edits (7 Oct)
  'payrollBonusesFor', 'payrollInvoiceTotals', 'payrollInvoiceLineEdited',
  // Google Ads: real leads vs Google's count, tracking problems (9 Oct)
  'adsConvKind', 'adsConvShortName', 'adsTracking',
  // The nightly lead check: info@ emails vs the app (9 Oct)
  'LEAD_CHECK_DAYS', 'leadPhoneKey', 'leadCheckOpen', 'leadCheckLatest', 'leadDivisionFromSubject', 'adsEmailCheck',
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


function testSubDivisionAndSource(sb){
  console.log('\nSub-division and sub-source (their own fields since 10 Oct)');
  const oldLead = { division:'Aircon', source:'Meta Ads', tags:['Split System','Duct System','Instagram','Too expensive','returning customer'] };
  assertEqual([sb.leadSubDivisions(oldLead), sb.leadSubSource(oldLead)], [['Split System','Duct System'], 'Instagram'], 'a lead saved before the change still reads its old tags');
  assertEqual(sb.visibleTags(oldLead), ['returning customer'], 'Tags shows only the free tags (not the sub-division, sub-source or lost reason)');
  const newLead = { division:'Aircon', source:'Meta Ads', subDivisions:['Duct System'], subSource:'Facebook', tags:['Split System','Instagram'] };
  assertEqual([sb.leadSubDivisions(newLead), sb.leadSubSource(newLead)], [['Duct System'], 'Facebook'], 'the fields win over any leftover tag');
  assertEqual(sb.leadSubSource({ source:'Google Ads', tags:['Instagram'] }), '', 'a platform tag on a non-Meta lead is not its sub-source');
  assertEqual(sb.subSourceOptions('Google Ads', [{ source:'Google Ads', subSource:'Brand Search' }, { source:'Meta Ads', subSource:'Instagram' }]).slice(-1), ['Brand Search'], 'a campaign already on a lead becomes a choice');
  assertEqual(sb.subSourceOptions('Organic', []), [], 'no sub-source list for Organic');
  sb.STATE.data.contacts = [{ fullName:'Pat Field', division:'Aircon', source:'Meta Ads', subDivisions:['Split System'], subSource:'Instagram', tags:[] }];
  assertEqual(sb.jobAttributionTags({ customerName:'Pat Field', jobType:'Aircon' }), { airconType:'Split System', metaPlatform:'Instagram' }, 'jobs attribute to the sub-division and sub-source fields');
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
  assertEqual(perf.lossReasons, { noReason:1, noAnswer:0, outsideArea:1, spam:0, wrongNumber:1, wrongDetails:0, tooExpensive:1, notInterested:0 }, 'lossReasons: Not Relevant leads classified into the fixed Lost-reason list');
  assertEqual(perf.outcome, { leads:7, won:1, lost:4, open:2 }, 'outcome: leads in / won (has a job) / lost / still open');
  assertEqual(perf.byChannel.Organic.closeRate, 14, 'closeRate: won (1) out of ALL leads (7), not out of decided ones');
  assertEqual(sb.lostReasonOf({ tags:['not interested - price'] }), 'tooExpensive', 'lostReasonOf: price wins over not interested');
  assertEqual(sb.lostReasonOf({ tags:['no answer ac'] }), 'noAnswer', 'lostReasonOf: no answer');
  // Pipeline stages (2026-09-27): legacy Not Relevant reads as Lost, a customer with a job is Won, a chosen reason wins over tags.
  sb.STATE.data.jobs = [{ id:'j1', customerName:'Zed', contactId:'c-won' }];
  assertEqual(sb.leadStage({ id:'x', fullName:'Nobody', status:'Not Relevant' }), 'Lost', 'leadStage: Not Relevant = Lost');
  assertEqual(sb.leadStage({ id:'c-won', fullName:'Someone', status:'Chasing' }), 'Won', 'leadStage: job linked by id = Won');
  assertEqual(sb.leadStage({ id:'y', fullName:'zed', status:'New' }), 'Won', 'leadStage: job by customer name = Won');
  assertEqual(sb.leadStage({ id:'z', fullName:'Q', status:'Quoted' }), 'Quoted', 'leadStage: new stages kept');
  assertEqual(sb.lostReasonOf({ lostReason:'spam', tags:['not interested - price'] }), 'spam', 'lostReasonOf: chosen reason beats tags');
  // Chasing call-back time: 3h later, pushed to the next working morning (Mon–Fri 08:00–17:00 Sydney).
  assertEqual(sb.chaseAlertDue('2026-09-22T00:00:00Z'), { day:'2026-09-22', mins:780 }, 'chaseAlertDue: Tue 10:00 -> 13:00 same day');
  assertEqual(sb.chaseAlertDue('2026-09-25T06:00:00Z'), { day:'2026-09-28', mins:480 }, 'chaseAlertDue: Fri 16:00 -> Mon 08:00');
  assertEqual(sb.chaseAlertDue('2026-09-21T13:30:00Z'), { day:'2026-09-22', mins:480 }, 'chaseAlertDue: Mon 23:30 -> Tue 08:00');
  const k = sb.chaseCounter({ createdAt:'2026-09-21', chaseCalls:['2026-09-20','2026-09-21','2026-09-23'] }, new Date('2026-09-25T02:00:00Z'));
  assertEqual([k.x, k.y, k.calledToday], [2, 5, false], 'chaseCounter: 2 called out of 5 workdays since the lead came in');
  assertEqual(perf.speedToLead.sampleSize, 2, 'speedToLead: only counts contacts with >=2 messages and a non-event reply');
  // Alice: 5 min = 0.0833h, Grace: 30 min = 0.5h -> avg 0.2917 (rounds to 0.29), median (upper of the two) 0.5
  assertClose(perf.speedToLead.avgHours, 0.29, 'speedToLead: avgHours across both replies', 0.01);
  assertClose(perf.speedToLead.medianHours, 0.5, 'speedToLead: medianHours', 0.01);
  // 29 Sep: the first action on a lead (contactedAt) counts as first contact; the website's own "returning customer"
  // message (auto) never does.
  sb.STATE.data.contacts = [
    { fullName:'Hana', source:'Organic', status:'Chasing', createdAt:'2026-09-06', contactedAt:'2026-09-06T01:12:00Z',
      messages:[{kind:'event',at:'2026-09-06T01:00:00Z'}] },   // 12 min to the first action
    { fullName:'Ivan', source:'Organic', status:'New', createdAt:'2026-09-06',
      messages:[{kind:'event',at:'2026-09-06T01:00:00Z'},{kind:'message',direction:'in',auto:true,at:'2026-09-06T02:00:00Z'}] },   // nobody acted
  ];
  sb.STATE.data.jobs = [];
  const perf2 = sb.computeBusinessPerformance(sb.STATE.data, '2026-09-01', '2026-09-10');
  assertEqual([perf2.speedToLead.sampleSize, perf2.speedToLead.medianHours], [1, 0.2], 'speedToLead: contactedAt counts, an auto message does not');
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
  // Weeks run Sunday–Saturday (same as Payroll). 5 Sep is a Saturday, 6 Sep a Sunday.
  // Week of 30 Aug–5 Sep: job1 (profit 1000-190-50=760; commission is 20% of 1000-50) = 760.
  // Week of 6–12 Sep: job2 (500-100-0=400) + job4 (200-40-0=160) + job5 (150-45-0=105) = 665.
  assertEqual(weeks.length, 2, 'computeProfitByWeekInRange: buckets the range into the 2 weeks it spans');
  assertEqual(weeks[0].revenue, 760, 'computeProfitByWeekInRange: first week profit (property is named "revenue" to match renderSparkline\'s expected shape)');
  assertEqual(weeks[1].revenue, 665, 'computeProfitByWeekInRange: second week profit');
}

function testRepeatServiceReminder(sb){
  // Re-offer a year later (Ofek 10 Sep, moved to a My Day bubble on 5 Oct): due from 358 days after the job (a week
  // before the year) until Ron marks it — unless the customer already has a newer job. No longer a Reminder.
  const today = '2026-09-10';
  const daysBefore = n => sb.shiftDays(today, -n);
  const jobs = [
    { id:'due-today', customerName:'Chen Family', jobType:'Aircon', date: daysBefore(358), paymentStatus:'Paid' },
    { id:'past', customerName:'Nguyen', jobType:'Chimney', date: daysBefore(370), paymentStatus:'Paid' },
    { id:'too-soon', customerName:'Okafor', jobType:'Aircon', date: daysBefore(357), paymentStatus:'Paid' },
    { id:'done', customerName:'Lee', jobType:'Aircon', date: daysBefore(360), paymentStatus:'Paid', reofferDoneAt:'2026-09-09T01:00:00Z' },
    { id:'came-back-old', customerName:'Patel', jobType:'Aircon', date: daysBefore(365), paymentStatus:'Paid' },
    { id:'came-back-new', customerName:'patel ', jobType:'Aircon', date: daysBefore(20), paymentStatus:'Paid' },
  ];
  sb.STATE.data.jobs = jobs; sb.STATE.data.contacts = []; sb.JOB_CACHE.index = null;
  const due = jobs.filter(j => sb.reofferDue(j, jobs, today)).map(j => j.id);
  assertEqual(due, ['due-today', 'past'], 'reofferDue: from 358 days on, until handled; not before, not when done, not when the customer has a newer job');
  Object.assign(sb.STATE.data, { equipmentSpend:[], quotes:[], manualReminders:[], dismissedReminders:[], readReminders:[] });
  assertEqual(sb.computeReminders(sb.STATE.data, sb.parseLocalDate(today)).filter(it => it.type==='repeat-service').length, 0, 'computeReminders: the re-offer is a My Day bubble now, not a Reminder');
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

  // Net profit = revenue - commissions - job expenses (parts) - marketing - Ron - owners (prorated per day).
  sb.STATE.data.jobs = [
    { technician:'Guy', date:'2026-09-14', amount:1000, partsCost:100, commissionPercent:30 },        // commission 270
    { technician:'Alessandro', date:'2026-09-16', amount:500, partsCost:50, commissionPercent:50 },   // commission 250
  ];
  sb.STATE.data.equipmentSpend = [{ date:'2026-09-15', cost:60 }, { date:'2026-09-25', cost:999 }];
  sb.STATE.data.adSpend = [{ date:'2026-09-14', channel:'Google Ads', spend:200 }, { date:'2026-09-14', channel:'Meta Ads', spend:100 }];
  sb.STATE.data.salesLogs = [{ person:'Ron', date:'2026-09-14', hours:8, bookingsAircon:5, bookingsChimney:0, bookingsPw:0 }]; // 90
  sb.STATE.data.settings = { gstRatePercent:10, ownerSalaries:{ Ofek:1200, Noam:1200 } };
  const np = sb.computeNetProfit(sb.STATE.data, '2026-09-13', '2026-09-19', new Date(2026, 8, 22));
  // Equipment bought in the week comes off too, without the GST the business claims back (Ofek 6 Oct): $60 incl. GST
  // = $54.55. The $999 bought on 25 Sep is outside the week. 1500 - 520 - 150 - 54.55 - 300 - 90 - 2400 = -2014.55
  assertEqual([np.revenue, np.commission, np.parts, np.equipment, np.marketing, np.hourlyStaff, np.owners, np.net].join(','), '1500,520,150,54.55,300,90,2400,-2014.55', 'netProfit: full week breakdown, equipment excl. GST');
  const npCapped = sb.computeNetProfit(sb.STATE.data, '2026-09-13', '2026-09-19', new Date(2026, 8, 15));
  // capped at 15 Sep: 3 days of owner salary (2400*3/7 = 1028.57); the 16 Sep job is not counted yet
  assertEqual([npCapped.days, npCapped.owners, npCapped.revenue].join(','), '3,1028.57,1000', 'netProfit: range capped at today');
  sb.STATE.data.settings = { gstRatePercent:10 };
}

function testDashboard(sb){
  // localDay: a UTC timestamp becomes the LOCAL calendar day; plain dates pass through.
  assertEqual(sb.localDay('2026-09-22'), '2026-09-22', 'localDay: plain date unchanged');
  assertEqual(sb.localDay(new Date(2026, 8, 22, 23, 30).toISOString()), '2026-09-22', 'localDay: late-evening timestamp stays on its local day');
  assertEqual(sb.localDay(null), '', 'localDay: empty');

  // A lead created (full timestamp) on the LAST day of the range must be counted.
  sb.STATE.data.contacts = [
    { id:'c1', fullName:'A', source:'Organic', status:'New', division:'Aircon', createdAt: new Date(2026, 8, 22, 15, 0).toISOString(), tags:[] },
    { id:'c2', fullName:'B', source:'Organic', status:'New', division:'Aircon', createdAt: new Date(2026, 8, 23, 9, 0).toISOString(), tags:[] },
  ];
  const perf = sb.computeBusinessPerformance(sb.STATE.data, '2026-09-20', '2026-09-22');
  assertEqual(perf.totalLeads, 1, 'bizPerformance: timestamped lead on the end date is counted, next day is not');

  // callDivision / summarizeCalls
  assertEqual(sb.callDivision({ account:'6569440597', campaign:'PMax' }), 'Aircon', 'callDivision: aircon account');
  assertEqual(sb.callDivision({ account:'3782562798', campaign:'Chimney Sweep - Search' }), 'Chimney', 'callDivision: chimney campaign');
  assertEqual(sb.callDivision({ account:'3782562798', campaign:'Pressure Washing Sydney' }), 'Pressure Washing', 'callDivision: pressure washing campaign');
  const cs = sb.summarizeCalls([
    { account:'6569440597', status:'RECEIVED', durationSeconds:95 },
    { account:'6569440597', status:'MISSED', durationSeconds:0 },
    { account:'3782562798', campaign:'Chimney', status:'RECEIVED', durationSeconds:29 },
  ]);
  assertEqual([cs.total, cs.answered, cs.missed, cs.over30s, cs.byDivision.Aircon, cs.byDivision.Chimney].join(','), '3,2,1,1,2,1', 'summarizeCalls: counts');

  // resolveDashboardRange — Tue 22 Sep 2026
  const now = new Date(2026, 8, 22, 10, 0);
  const R = (range, extra) => { const r = sb.resolveDashboardRange(Object.assign({ range }, extra||{}), now); return [r.start, r.effEnd, r.prevStart, r.prevEnd].join(' '); };
  assertEqual(R('week'), '2026-09-20 2026-09-22 2026-09-13 2026-09-15', 'dashRange: this week (Sun-Sat, to date) vs same days last week');
  assertEqual(R('lastWeek'), '2026-09-13 2026-09-19 2026-09-06 2026-09-12', 'dashRange: last week');
  assertEqual(R('month'), '2026-09-01 2026-09-22 2026-08-01 2026-08-22', 'dashRange: this month to date vs same days last month');
  assertEqual(R('lastMonth'), '2026-08-01 2026-08-31 2026-07-01 2026-07-31', 'dashRange: last month');
  assertEqual(R('30d'), '2026-08-24 2026-09-22 2026-07-25 2026-08-23', 'dashRange: last 30 days');
  assertEqual(R('custom', { customFrom:'2026-09-10', customTo:'2026-09-01' }), '2026-09-01 2026-09-10 2026-08-22 2026-08-31', 'dashRange: custom (reversed dates are swapped)');
  const r2 = sb.resolveDashboardRange({ range:'lastMonth' }, new Date(2026, 3, 10));
  assertEqual([r2.start, r2.effEnd, r2.prevStart, r2.prevEnd].join(' '), '2026-03-01 2026-03-31 2026-02-01 2026-02-28', 'dashRange: previous period never overlaps (March vs February)');
}

function testJobCustomerLink(sb){
  // A job is tied to its CRM customer by contactId; the name is only a fallback. Names here deliberately do NOT match.
  sb.STATE.data.contacts = [
    { id:'c-google', fullName:'Vianney Hunter', source:'Google Ads', status:'Booked', createdAt:'2026-09-03', tags:['Split System'] },
    { id:'c-meta', fullName:'Neslihan', source:'Meta Ads', status:'Booked', createdAt:'2026-09-14', tags:[] },
    { id:'c-none', fullName:'Nobody Yet', source:'Organic', status:'New', createdAt:'2026-09-05', tags:[] },
  ];
  sb.STATE.data.jobs = [
    { id:'j1', customerName:'James', contactId:'c-google', jobType:'Aircon', date:'2026-09-07', amount:400, commissionPercent:30, partsCost:0, paymentStatus:'Paid', datePaid:'2026-09-08', technician:'Guy', reviewTaken:false },
    { id:'j2', customerName:'Neslihan B', contactId:'c-meta', jobType:'Aircon', date:'2026-09-08', amount:600, commissionPercent:30, partsCost:0, paymentStatus:'Unpaid', technician:'Guy', reviewTaken:false },
    { id:'j3', customerName:'Vianney Hunter', contactId:null, jobType:'Aircon', date:'2026-09-09', amount:100, commissionPercent:30, partsCost:0, paymentStatus:'Paid', datePaid:'2026-09-09', technician:'Guy', reviewTaken:false },
    { id:'j4', customerName:'Somebody Else', contactId:null, jobType:'Chimney', date:'2026-09-09', amount:50, commissionPercent:30, partsCost:0, paymentStatus:'Paid', datePaid:'2026-09-09', technician:'Guy', reviewTaken:false },
  ];
  sb.STATE.data.adSpend = []; sb.STATE.data.quotes = []; sb.STATE.data.employees = [{ name:'Guy', roles:['Technician'] }];
  assertEqual((sb.contactForJob(sb.STATE.data.jobs[0])||{}).id, 'c-google', 'contactForJob: linked id wins even when the names differ');
  assertEqual((sb.contactForJob(sb.STATE.data.jobs[2])||{}).id, 'c-google', 'contactForJob: unlinked job falls back to the exact name');
  assertEqual(sb.contactForJob(sb.STATE.data.jobs[3]), null, 'contactForJob: no link and no name match gives null');
  const perf = sb.computeBusinessPerformance(sb.STATE.data, '2026-09-01', '2026-09-30');
  assertEqual(perf.byChannel['Google Ads'].revenue, 500, 'channel revenue: linked job (400) + name-matched job (100) both credited to Google Ads');
  assertEqual(perf.byChannel['Meta Ads'].revenue, 600, 'channel revenue: job with a different name is credited through its link');
  assertEqual(perf.byChannel['Organic'].revenue, 0, 'channel revenue: an unlinked, unmatched job is not credited to any channel');
  assertEqual(sb.contactHasJob({ id:'c-meta', fullName:'Neslihan' }, sb.STATE.data.jobs), true, 'contactHasJob: true through the link even if names differ');
  assertEqual(sb.contactHasJob({ id:'c-none', fullName:'Nobody Yet' }, sb.STATE.data.jobs), false, 'contactHasJob: false with no link and no name');
  assertEqual(sb.contactHasJob('Somebody Else', sb.STATE.data.jobs), true, 'contactHasJob: a plain name still works');
}

function testSalesAutomations(sb){
  // Sydney is UTC+10 until daylight saving starts on 4 Oct 2026. Work hours Mon–Fri 08:00–17:00.
  const due = iso => JSON.stringify(sb.workClockDue(iso, 15));
  assertEqual(due('2026-09-29T00:00:00Z'), JSON.stringify({ day:'2026-09-29', mins:615 }), 'workClockDue: Tue 10:00 + 15 min = 10:15 same day');
  assertEqual(due('2026-09-28T21:00:00Z'), JSON.stringify({ day:'2026-09-29', mins:495 }), 'workClockDue: 07:00 before opening counts from 08:00 → 08:15');
  assertEqual(due('2026-10-02T06:50:00Z'), JSON.stringify({ day:'2026-10-05', mins:485 }), 'workClockDue: Fri 16:50 uses 10 min Friday, 5 min Monday → Mon 08:05');
  assertEqual(due('2026-10-03T00:00:00Z'), JSON.stringify({ day:'2026-10-05', mins:495 }), 'workClockDue: a Saturday lead starts Monday 08:00 → 08:15');

  sb.STATE.data.jobs = [];
  const arrived = '2026-09-29T00:00:00Z';   // Tue 29 Sep, 10:00 Sydney
  const lead = extra => Object.assign({ id:'n1', fullName:'Fresh Lead', status:'New', createdAt:'2026-09-29', messages:[{ kind:'event', text:'Form', at:arrived }] }, extra||{});
  const at = iso => new Date(iso);
  assertEqual(sb.newLeadUnhandled(lead(), at('2026-09-29T00:16:00Z')), true, 'newLeadUnhandled: New, nobody touched it, 16 working minutes → alert');
  assertEqual(sb.newLeadUnhandled(lead(), at('2026-09-29T00:14:00Z')), false, 'newLeadUnhandled: only 14 minutes → not yet');
  assertEqual(sb.newLeadUnhandled(lead({ lastReadAt:'2026-09-29T00:05:00Z' }), at('2026-09-29T00:30:00Z')), false, 'newLeadUnhandled: marked read (or bubble closed) → handled');
  assertEqual(sb.newLeadUnhandled(lead({ messages:[{ kind:'event', at:arrived }, { kind:'message', direction:'out', at:'2026-09-29T00:10:00Z' }] }), at('2026-09-29T00:30:00Z')), false, 'newLeadUnhandled: a reply was logged → handled');
  assertEqual(sb.newLeadUnhandled(lead({ status:'Chasing' }), at('2026-09-29T00:30:00Z')), false, 'newLeadUnhandled: moved out of New → handled');
  assertEqual(sb.newLeadUnhandled(lead({ contactedAt:'2026-09-29T00:20:00Z' }), at('2026-09-29T00:30:00Z')), false, 'newLeadUnhandled: someone acted on it (tag, note, follow-up…) → gone for everyone');
  assertEqual(sb.newLeadUnhandled(lead({ contactedAt:'2026-09-20T00:20:00Z', reopenedAt:arrived }), at('2026-09-29T00:30:00Z')), true, 'newLeadUnhandled: an action from before the customer came back does not count');
  assertEqual(sb.newLeadUnhandled(lead({ messages:[{ kind:'event', at:'2026-09-20T00:00:00Z' }] }), at('2026-09-29T00:30:00Z')), false, 'newLeadUnhandled: leads from before the go-live day never alert');
  assertEqual(sb.newLeadUnhandled(lead({ lastReadAt:'2026-09-01T00:00:00Z', reopenedAt:arrived }), at('2026-09-29T00:30:00Z')), true, 'newLeadUnhandled: a returning customer read long ago but enquiring again → alert');

  const chase = since => ({ id:'ch', fullName:'Chased', status:'Chasing', chasingSince:since, createdAt:'2026-09-01' });
  assertEqual(sb.chaseTooLong(chase('2026-09-01T02:00:00Z'), at('2026-09-22T02:00:00Z')), true, 'chaseTooLong: 21 days in Chasing → decide');
  assertEqual(sb.chaseTooLong(chase('2026-09-01T02:00:00Z'), at('2026-09-21T02:00:00Z')), false, 'chaseTooLong: 20 days → not yet');
  const quote = changed => ({ id:'q', fullName:'Quoted Q', status:'Quoted', stageChangedAt:changed, createdAt:'2026-09-01', division:'Aircon', estimatedValue:450 });
  assertEqual(sb.quoteStale(quote('2026-09-08T02:00:00Z'), at('2026-09-22T02:00:00Z')), true, 'quoteStale: 14 days untouched → red');
  assertEqual(sb.quoteStale(quote('2026-09-08T02:00:00Z'), at('2026-09-21T02:00:00Z')), false, 'quoteStale: 13 days → fine');

  // Booked with no job: 2 days after the job date (Sydney), and only while the lead is still Booked (a job makes it Won).
  const booked = d => ({ id:'bk', fullName:'Booked B', status:'Booked', bookedFor:d, createdAt:'2026-09-01', division:'Aircon' });
  assertEqual(sb.bookedNoJob(booked('2026-09-20'), at('2026-09-22T02:00:00Z')), true, 'bookedNoJob: 2 days after the job date → check');
  assertEqual(sb.bookedNoJob(booked('2026-09-21'), at('2026-09-22T02:00:00Z')), false, 'bookedNoJob: 1 day after → not yet');
  assertEqual(sb.bookedNoJob(booked(''), at('2026-09-22T02:00:00Z')), false, 'bookedNoJob: no job date (old Booked leads) → never');
  sb.STATE.data.jobs = [{ id:'bj', contactId:'bk', customerName:'Booked B', date:'2026-09-20' }]; sb.JOB_CACHE.index = null;
  assertEqual(sb.bookedNoJob(booked('2026-09-20'), at('2026-09-22T02:00:00Z')), false, 'bookedNoJob: the job was entered → Won, no alert');
  sb.STATE.data.jobs = []; sb.JOB_CACHE.index = null;

  sb.STATE.data.contacts = [chase('2026-09-01T02:00:00Z'), quote('2026-09-08T02:00:00Z'), booked('2026-09-20')];
  Object.assign(sb.STATE.data, { equipmentSpend:[], manualReminders:[], dismissedReminders:[], readReminders:[], employees:[] });
  const items = sb.computeReminders(sb.STATE.data, at('2026-09-22T02:00:00Z'));
  // (5 Oct, Ofek: no duplicates) chasing 21+, idle quotes, lead follow-ups and late payments are My Day bubbles now.
  assertEqual(items.filter(i => ['chase-long','stale-quote','booked-no-job','followup','unpaid'].includes(i.type)).length, 0, 'computeReminders: lead and payment items are not Reminders any more (they are My Day bubbles)');

  // My Day lists: the 21-day lead goes to "decide", not the daily call list; quotes due and follow-ups each keep to their own stage.
  sb.STATE.data.contacts.push(lead(), lead({ id:'old', fullName:'Backlog', createdAt:'2026-06-15', messages:[{ kind:'event', at:'2026-06-15T02:00:00Z' }] }),
    { id:'qd', fullName:'Quote Due', status:'Quoted', nextFollowUp:'2026-09-28', createdAt:'2026-09-01' },
    { id:'ql', fullName:'Quote Later', status:'Quoted', nextFollowUp:'2026-10-05', createdAt:'2026-09-01' },
    { id:'fu', fullName:'Follow Up', status:'Follow-up', nextFollowUp:'2026-09-29', createdAt:'2026-09-01' });
  const L = sb.myDayLists(sb.STATE.data, at('2026-09-29T00:30:00Z'));
  assertEqual([L.chaseDecide.length, L.chaseToCall.length, L.quotesDue.map(c=>c.id), L.followups.map(c=>c.id)], [1, 0, ['qd'], ['fu']], 'myDayLists: 21+ days chasing is in "decide"; a due quote is in Quotes due only, a Follow-up lead in Follow-ups only');
  assertEqual([L.fresh.map(c=>c.id), L.backlog.map(c=>c.id), L.unhandled.map(c=>c.id)], [['n1'], ['old'], ['n1']], 'myDayLists: this week\'s New lead is listed and flagged, the June one is backlog');
  assertEqual(L.prevWorkday, '2026-09-28', 'myDayLists: previous working day of a Tuesday is Monday');

  assertEqual(sb.quoteDueReason({ nextFollowUp:'2026-09-27' }, '2026-09-29'), 'Follow-up date 27 Sep has come (2 days late): call, then set the next date or move the stage', 'quoteDueReason: says what to do and how late');
  assertEqual(sb.quoteDueReason({ nextFollowUp:'2026-09-29' }, '2026-09-29'), 'Follow-up date 29 Sep has come (today): call, then set the next date or move the stage', 'quoteDueReason: due today');
  // Shift clock: 08:00–17:00 with a 12:30–13:15 break = 9h on shift; the break is listed only (Ofek 3/10: it changes nothing)
  const E = (kind, hm) => ({ kind, at: `2026-09-29T${hm}:00+10:00` });
  const day1 = sb.shiftDaySummary([E('shift_start','08:00'), E('break_start','12:30'), E('break_end','13:15'), E('shift_end','17:00')], 0, false);
  assertEqual([day1.workedMins, day1.breakMins, day1.hours, day1.open, day1.breaks.length], [540, 45, 9, false, 1], 'shiftDaySummary: the whole shift counts, the break is only listed');
  // still on a break at 13:00 today: 08:00–13:00 = 5h on shift so far, break 12:30–now listed
  const now13 = Date.parse('2026-09-29T13:00:00+10:00');
  const day2 = sb.shiftDaySummary([E('shift_start','08:00'), E('break_start','12:30')], now13, true);
  assertEqual([day2.workedMins, day2.breakMins, day2.onBreak, day2.open], [300, 30, true, true], 'shiftDaySummary: an open shift and break run to now');
  // a past day nobody ended: counted up to the last event, flagged open
  const day3 = sb.shiftDaySummary([E('shift_start','08:00'), E('break_start','12:00'), E('break_end','12:30')], 0, false);
  assertEqual([day3.workedMins, day3.open], [270, true], 'shiftDaySummary: a forgotten shift counts to its last event and is flagged');
  // Late payments (Ofek 5/10): every day until paid, unless Ron set a follow-up date; done today = called / later date / paid
  const unpaid = (extra) => Object.assign({ id:'lp', paymentStatus:'Unpaid', date:'2026-09-20', paymentContacts:[] }, extra||{});
  assertEqual([sb.latePaymentDue(unpaid(), '2026-09-27', 7), sb.latePaymentDue(unpaid(), '2026-09-28', 7)], [false, true], 'latePaymentDue: only after 7 days');
  assertEqual(sb.latePaymentDue(unpaid({ paymentFollowup:'2026-10-02' }), '2026-09-30', 7), false, 'latePaymentDue: waits for the follow-up date Ron set');
  assertEqual(sb.latePaymentDue(unpaid({ paymentFollowup:'2026-10-02' }), '2026-10-02', 7), true, 'latePaymentDue: back on the follow-up date');
  assertEqual(sb.latePaymentDue(unpaid({ paymentStatus:'Paid' }), '2026-10-02', 7), false, 'latePaymentDue: a paid job is never late');
  assertEqual([sb.latePaymentDoneToday(unpaid({ paymentContacts:['2026-09-30'] }), '2026-09-30'), sb.latePaymentDoneToday(unpaid({ paymentContacts:['2026-09-29'] }), '2026-09-30'), sb.latePaymentDoneToday(unpaid({ paymentFollowup:'2026-10-05' }), '2026-09-30')], [true, false, true], 'latePaymentDoneToday: called today, or a later date set; yesterday\'s call does not count');
  // Tasks (Ofek 5/10): mine = assigned to me, due today/late or from the heads-up; team = someone else's, due today/late or heads-up day
  const ron = { fullName:'Ron', technicianName:'Ron' };
  const task = (extra) => Object.assign({ id:'t', status:'Not Started', assignees:['Ron'], board:'ron', due:'2026-10-05', headsUp:'' }, extra||{});
  assertEqual([sb.myTaskDue(task(), ron, '2026-10-05'), sb.myTaskDue(task({ due:'2026-10-08' }), ron, '2026-10-05'), sb.myTaskDue(task({ due:'2026-10-08', headsUp:'2026-10-04' }), ron, '2026-10-05'), sb.myTaskDue(task({ status:'Done' }), ron, '2026-10-05')], [true, false, true, false], 'myTaskDue: due today, not before (unless heads-up), never when Done');
  assertEqual([sb.teamTaskDue(task({ assignees:['Guy'], board:'Guy' }), ron, '2026-10-05'), sb.teamTaskDue(task(), ron, '2026-10-05'), sb.teamTaskDue(task({ assignees:['Ofek'], board:'Ofek' }), ron, '2026-10-05'), sb.teamTaskDue(task({ assignees:['Guy'], board:'Guy', due:'2026-10-09', headsUp:'2026-10-05' }), ron, '2026-10-05')], [true, false, true, true], 'teamTaskDue: other people\'s tasks (the owners\' too, 7 Oct), never Ron\'s own, due today or on the heads-up day');
  // My Day counters: done / total per bubble, the day's % = everything done ÷ everything (Ofek 3/10).
  const K = sb.mdCounts({ new: [{done:true},{done:true},{done:true},{done:true},{done:true},{done:true},{done:false},{done:false},{done:false},{done:false}], chasing: Array.from({length:30}, () => ({done:true})) });
  // new 6/10, chasing 30/30 → 36 of 40 = 90%
  assertEqual([K.by.new, K.by.chasing, K.by.quotes, K.done, K.total, K.percent], [{done:6,total:10}, {done:30,total:30}, {done:0,total:0}, 36, 40, 90], 'mdCounts: done/total per bubble, % = all done ÷ all tasks');
  assertEqual(sb.mdCounts({}).percent, null, 'mdCounts: a day with no tasks has no % (left out of averages)');
  // Lunch-break / daily-report lines: % then done/total per bubble that had tasks
  assertEqual(sb.mdTaskLines(K, 'רון השלים'), ['רון השלים 90% מהמשימות (36 מתוך 40)', '• לידים חדשים: 6/10', '• מרדף: 30/30'], 'mdTaskLines: the % and each bubble with tasks');
  const dayRow = { day:'2026-09-29', items: { new: { a:{ a:'t', d:'t2', div:'Aircon' }, b:{ a:'t', d:null, div:'Chimney' } }, quotes: { q:{ a:'t', d:'t3', div:'Aircon' } } }, bookings: [{ c:'a', div:'Aircon', from:'new' }, { c:'z', div:'Aircon', from:'other' }] };
  const SK = sb.mdStoredCounts(dayRow);
  assertEqual([SK.by.new, SK.by.quotes, SK.percent], [{done:1,total:2}, {done:1,total:1}, 67], 'mdStoredCounts: a stored day counts its items (2 of 3 = 67%)');
  // week: days of 67% and 100% → average 84% (rounded from 83.5), bubbles summed
  const W = sb.mdWeekCounts([dayRow, { day:'2026-09-30', items:{}, totals:{ by:{ new:{done:4,total:4} }, done:4, total:4, percent:100 } }]);
  assertEqual([W.by.new, W.percent, W.days], [{done:5,total:6}, 84, 2], 'mdWeekCounts: bubbles summed, % = average of the days');
  assertEqual(sb.mdBookingLinesHe(dayRow), ['• מזגנים 2 – 1 מתוך 1 לידים חדשים, 1 משלבים אחרים'], 'mdBookingLinesHe: bookings per division and where they were closed from, in Hebrew');
  // Dashboard per task (Ofek 5/10): the average of each day's % — 10 new leads a day, all handled, is 100%.
  const dayOf = (day, b) => ({ day, closed_at:'x', totals:{ by:b } });
  const PB = sb.mdPeriodBubbles([
    dayOf('2026-09-28', { new:{done:10,total:10}, chasing:{done:3,total:4} }),
    dayOf('2026-09-29', { new:{done:10,total:10} }),
    dayOf('2026-09-30', { new:{done:10,total:10}, quotes:{done:0,total:0} }),
  ]);
  assertEqual([PB.new.percent, PB.new.days, PB.new.done, PB.new.total], [100, 3, 30, 30], 'mdPeriodBubbles: 10 a day, all done, every day → 100%');
  assertEqual([PB.chasing.percent, PB.chasing.days, PB.quotes.percent, PB.quotes.days], [75, 1, null, 0], 'mdPeriodBubbles: only days with tasks count; a task never due shows no %');
  const PB2 = sb.mdPeriodBubbles([dayOf('2026-09-28', { new:{done:10,total:10} }), dayOf('2026-09-29', { new:{done:1,total:2} })]);
  assertEqual(PB2.new.percent, 75, 'mdPeriodBubbles: the average of the days (100% and 50%), not the total 11 of 12');
  const BT = sb.mdBookingsTable([dayRow]);
  assertEqual([/1 of 1 from New leads/.test(BT), /1 from other stages/.test(BT), /<td class="num">2<\/td>/.test(BT)], [true, true, true], 'mdBookingsTable: aircon booked 2 — 1 of its 1 new aircon lead, 1 from other stages');
  // Chasing → Lost (no answer): only leads that were chasing; days called counted inside the chase.
  const lostLead = (id, calls, extra) => Object.assign({ id, fullName:id, status:'Lost', lostReason:'noAnswer', chasingSince:'2026-09-01T00:00:00Z', stageChangedAt:'2026-09-22T00:00:00Z', chaseCalls: calls, createdAt:'2026-09-01' }, extra||{});
  const twelve = Array.from({length:12}, (_, i) => '2026-09-' + String(2+i).padStart(2,'0'));
  const CL = sb.chasingLostStats({ contacts: [lostLead('few', ['2026-09-02','2026-09-03']), lostLead('many', twelve), lostLead('notChasing', [], { chasingSince:null }), lostLead('price', [], { lostReason:'price' }), lostLead('later', [], { stageChangedAt:'2026-10-20T00:00:00Z' })] }, '2026-09-01', '2026-09-30');
  assertEqual([CL.total, CL.under.map(x => x.c.id + ':' + x.days)], [2, ['few:2']], 'chasingLostStats: counts chasing → lost (no answer) in the period; lists only those called on fewer than 10 days');

  // Returning customer: an old job keeps them Won until they enquire again; a job from the new enquiry makes them Won again.
  sb.STATE.data.jobs = [{ id:'oldjob', contactId:'rc', customerName:'Return Cust', date:'2026-03-01' }];
  sb.JOB_CACHE.index = null;
  const rc = { id:'rc', fullName:'Return Cust', status:'Won', createdAt:'2026-02-20', messages:[] };
  assertEqual(sb.leadStage(rc), 'Won', 'leadStage: a customer with a job is Won');
  const back = Object.assign({}, rc, { status:'New', reopenedAt:'2026-09-29T00:00:00Z' });
  assertEqual(sb.leadStage(back), 'New', 'leadStage: a returning customer is New again — the March job belongs to the old enquiry');
  sb.STATE.data.jobs = sb.STATE.data.jobs.concat([{ id:'newjob', contactId:'rc', customerName:'Return Cust', date:'2026-10-02' }]);
  sb.JOB_CACHE.index = null;
  assertEqual(sb.leadStage(back), 'Won', 'leadStage: a job from the new enquiry makes them Won again');
  assertEqual(sb.leadLatestJobDate({ id:'x', fullName:'Return Cust' }), '2026-10-02', 'leadLatestJobDate: same-name match finds the latest job');
  sb.STATE.data.jobs = [{ id:'oldjob', contactId:'rc', customerName:'Return Cust', date:'2026-03-01' }];
  sb.JOB_CACHE.index = null;
  assertEqual(sb.newLeadUnhandled(Object.assign({}, back, { messages:[{ kind:'message', direction:'in', auto:true, at:'2026-09-29T00:00:00Z' }] }), at('2026-09-29T00:30:00Z')), true, 'newLeadUnhandled: the website\'s own "new enquiry" message does not count as handled');
}

function testReviewNeed(sb){
  // "Ask for a review" bubble (Ofek 5 Oct): ask the ones not asked; one reminder for a customer asked yesterday or before
  // who still hasn't left a review (the nightly routine marks the ones who did); nothing for taken / don't ask.
  const today = '2026-10-06';
  const j = (x) => Object.assign({ id:'j', invoiceNumber:'2500', date:'2026-10-05' }, x);
  const sent = (day, n) => ({ status:'sent', sent_at: day + 'T01:00:00Z', ask_count: n });   // 12:00 Sydney that day
  const N = (job, r, auto) => sb.reviewNeed(job, r, today, !!auto);
  assertEqual(N(j({}), null), 'ask', 'reviewNeed: never asked → ask');
  assertEqual(N(j({ reviewTaken:true }), null), null, 'reviewNeed: review taken → nothing');
  assertEqual(N(j({ reviewDoNotAsk:true }), sent('2026-10-04', 1)), null, "reviewNeed: don't ask → nothing, even when asked before");
  assertEqual(N(j({ invoiceNumber:'' }), null), null, 'reviewNeed: no invoice number → nothing');
  assertEqual(N(j({}), { status:'waiting' }), null, 'reviewNeed: waiting to go → nothing');
  assertEqual(N(j({}), sent('2026-10-06', 1)), null, 'reviewNeed: asked today → check again tomorrow');
  assertEqual(N(j({}), sent('2026-10-05', 1)), 'again', 'reviewNeed: asked yesterday, no review → ask again');
  assertEqual(N(j({}), sent('2026-10-05', null)), 'again', 'reviewNeed: older request rows count as asked once');
  assertEqual(N(j({}), sent('2026-10-05', 2)), null, 'reviewNeed: already asked twice → nothing more');
  assertEqual(N(j({}), sent('2026-09-21', 1)), null, 'reviewNeed: asked more than 2 weeks ago → no reminder');
  assertEqual(N(j({}), sent('2026-09-22', 1)), 'again', 'reviewNeed: asked exactly 2 weeks ago → still one reminder');
  assertEqual(N(j({}), { status:'error' }), 'ask', 'reviewNeed: the request failed → ask');
  assertEqual(N(j({}), { status:'skipped', reason:'same customer already asked or waiting (6 months)' }), 'ask', 'reviewNeed: by hand (switched off), an old skipped one is still to ask');
  // Automatic mode (switched on at go-live)
  assertEqual(N(j({ date:'2026-10-06' }), null, true), null, 'reviewNeed auto: a new job with no request yet is left to the system');
  assertEqual(N(j({ date:'2026-10-03' }), null, true), 'ask', 'reviewNeed auto: no request 3 days later → the office asks');
  assertEqual(N(j({}), { status:'skipped', reason:'no customer card in the CRM for this job' }, true), 'ask', "reviewNeed auto: couldn't go (no card) → the office fixes and asks");
  assertEqual(N(j({}), { status:'skipped', reason:'no mobile or email on the customer card' }, true), 'ask', "reviewNeed auto: couldn't go (no mobile/email) → ask");
  assertEqual(N(j({}), { status:'skipped', reason:'same customer already asked or waiting (6 months)' }, true), null, 'reviewNeed auto: asked for another job lately → nothing');
  assertEqual(N(j({}), sent('2026-10-05', 1), true), 'again', 'reviewNeed auto: sent automatically yesterday, no review → ask again');
}

function testClosingTotalInclGst(sb){
  // Closings take the total the customer paid, GST included (Ofek 6 Oct). The job keeps the amount before GST, and
  // every technician calculation (commission, payroll) uses that — never the GST.
  sb.STATE.data.settings = { gstRatePercent:10 };
  sb.STATE.data.employees = [
    { name:'Guy', roles:['Technician'], status:'Active', employmentType:'Freelance-commission' },
    { name:'Alessandro', roles:['Technician'], status:'Active', employmentType:'Independent Contractor' },
  ];
  assertEqual(sb.amountExGst(383.90, true), 349, 'amountExGst: $383.90 paid incl. GST = $349 before GST (the ducted price + GST)');
  assertEqual(sb.amountExGst(330, true), 300, 'amountExGst: $330 incl. GST = $300');
  assertEqual(sb.amountExGst(250, false), 250, 'amountExGst: no GST (cash) → the total is the amount');
  const j400 = { technician:'Guy', amount: sb.amountExGst(400, true), includesGST:true, partsCost:0, commissionPercent:30 };
  assertEqual([j400.amount, sb.jobGst(j400), sb.jobTotalCollected(j400)], [363.6364, 36.36, 400], 'amountExGst: $400 → $363.6364 + $36.36 GST adds back to exactly $400');
  // Every whole-dollar total from $1 to $5,000 adds back exactly (whole cents would miss by a cent on ~1 in 11).
  let off = 0; for (let d = 1; d <= 5000; d++) { const job = { amount: sb.amountExGst(d, true), includesGST:true }; if (sb.jobTotalCollected(job) !== d) off++; }
  assertEqual(off, 0, 'amountExGst: amount + GST always equals the total paid');
  // Commission is on the amount before GST, minus parts for employees (Ofek's model).
  const j440 = { technician:'Guy', amount: sb.amountExGst(440, true), includesGST:true, partsCost:40, commissionPercent:30 };
  assertEqual(sb.jobCommissionAmount(j440), 108, 'commission: $440 paid incl. GST → 30% of ($400 − $40 parts) = $108, no GST in it');
  const jAl = { technician:'Alessandro', amount: sb.amountExGst(550, true), includesGST:true, partsCost:50, commissionPercent:50 };
  assertEqual(sb.jobCommissionAmount(jAl), 250, 'commission: contractor $550 paid incl. GST → 50% of $500, no GST, parts not deducted');
  const jCash = { technician:'Guy', amount: sb.amountExGst(300, false), includesGST:false, partsCost:0, commissionPercent:30 };
  assertEqual([sb.jobGst(jCash), sb.jobCommissionAmount(jCash)], [0, 90], 'cash, no GST: commission on the full $300');
}

function testJobsRange(sb){
  // Jobs & Commissions period (Ofek 6 Oct): All, Today, This week (Sun–Sat), This month, Custom. By the job date.
  const today = '2026-10-06';   // a Tuesday
  const R = (range, from, to) => sb.jobsRangeBounds({ range, customFrom: from || '', customTo: to || '' }, today);
  assertEqual(R('all'), null, 'jobsRange: All = no date limit');
  assertEqual(R('today'), { start:'2026-10-06', end:'2026-10-06' }, 'jobsRange: Today');
  assertEqual(R('week'), { start:'2026-10-04', end:'2026-10-10' }, 'jobsRange: This week = Sunday to Saturday, like Payroll');
  assertEqual(R('month'), { start:'2026-10-01', end:'2026-10-31' }, 'jobsRange: This month = the calendar month');
  assertEqual(R('custom', '2026-09-27', '2026-10-02'), { start:'2026-09-27', end:'2026-10-02' }, 'jobsRange: Custom from–to');
  assertEqual(R('custom', '2026-10-02', '2026-09-27'), { start:'2026-09-27', end:'2026-10-02' }, 'jobsRange: Custom picked backwards still works');
  assertEqual(R('custom', '2026-10-01', ''), { start:'2026-10-01', end:'9999-12-31' }, 'jobsRange: Custom with only a start = from that day on');
  assertEqual(R('custom', '', ''), null, 'jobsRange: Custom with no dates yet = everything');
  assertEqual(sb.JOBS_RANGES.map(r => r[1]), ['All','Today','This week','This month','Custom'], 'jobsRange: the five choices, in order');
}

function testMaterialsPayback(sb){
  // Equipment & materials a technician paid for himself (Ofek 6 Oct): paid back in full (GST included) with his weekly
  // pay, on a second invoice next to the commission one; it lands in the week it was ENTERED; a week already marked
  // paid takes nothing new. Bought by the business = an expense only.
  sb.STATE.data.settings = { gstRatePercent:10 };
  assertEqual([sb.equipReimbursedFor('Business'), sb.equipReimbursedFor('Guy'), sb.equipReimbursedFor('Guy', 'Reimbursed'), sb.equipReimbursedFor('Guy', 'N/A')], ['N/A','Pending','Reimbursed','Pending'], 'equipReimbursedFor: business = nothing to pay back; a technician = waiting, unless already paid back');
  assertEqual(sb.partsRefundFor({ partsCost:40, partsPaidBy:'Guy' }), 'Pending Refund', 'partsRefundFor: parts the technician paid for wait to be paid back');
  assertEqual([sb.partsRefundFor({ partsCost:40, partsPaidBy:'Business' }), sb.partsRefundFor({ partsCost:0, partsPaidBy:'Guy' }), sb.partsRefundFor({ partsCost:40, partsPaidBy:'' })], ['N/A','N/A','N/A'], 'partsRefundFor: business-paid, no parts, or nobody = nothing to pay back');
  assertEqual(sb.partsRefundFor({ partsCost:40, partsPaidBy:'Guy', partsRefundStatus:'Refunded' }), 'Refunded', 'partsRefundFor: a refund already done stays done');
  const pp = sb.partsRefundPatch(null, { partsCost:40, partsPaidBy:'Guy' });
  assertEqual([pp.partsRefundStatus, !!pp.partsPendingAt, pp.partsRefundWeek], ['Pending Refund', true, null], 'partsRefundPatch: a new job with the technician\'s parts starts waiting now');
  assertEqual(sb.partsRefundPatch({ partsCost:40, partsPaidBy:'Guy', partsRefundStatus:'Pending Refund' }, { partsCost:50, partsPaidBy:'Guy' }), {}, 'partsRefundPatch: still waiting after a cost change = no change (keeps its entered date)');
  assertEqual(sb.materialsGst(110), 10, 'materialsGst: $110 incl. GST has $10 GST in it');

  const W = '2026-10-04', PREV = '2026-09-27';   // Sun 4 Oct week, and the week before
  sb.STATE.data.employees = [{ name:'Guy', roles:['Technician'], status:'Active', employmentType:'Freelance-commission' }];
  sb.STATE.data.payrollWeeks = [{ weekKey: PREV, person:'Guy', salaryPaid:true, salaryPaidAmount:500 }];
  sb.STATE.data.equipmentSpend = [
    { id:'e1', date:'2026-10-02', createdAt:'2026-10-05T01:00:00Z', item:'Ladder', technician:'Guy', paidBy:'Guy', cost:110, reimbursed:'Pending' },        // bought last week, ENTERED this week
    { id:'e2', date:'2026-10-05', createdAt:'2026-10-05T02:00:00Z', item:'Vacuum', technician:'Guy', paidBy:'Business', cost:330, reimbursed:'N/A' },     // the business paid: expense only
    { id:'e3', date:'2026-09-29', createdAt:'2026-09-30T01:00:00Z', item:'Drill', technician:'Guy', paidBy:'Guy', cost:55, reimbursed:'Pending' },          // entered in a week already paid → moves on
    { id:'e4', date:'2026-09-28', createdAt:'2026-09-28T01:00:00Z', item:'Gloves', technician:'Guy', paidBy:'Guy', cost:22, reimbursed:'Reimbursed', reimbursedWeek: PREV }, // paid back last week
    { id:'e5', date:'2026-10-05', createdAt:'2026-10-05T03:00:00Z', item:'Hose', technician:'Dolev', paidBy:'Dolev', cost:44, reimbursed:'Pending' },        // someone else's
  ];
  sb.STATE.data.jobs = [
    { id:'j1', invoiceNumber:'2500', customerName:'Sarah', technician:'Guy', date:'2026-10-05', amount:349, includesGST:true, partsCost:44, partsPaidBy:'Guy', partsRefundStatus:'Pending Refund', partsPendingAt:'2026-10-06T01:00:00Z', partsDescription:'Filter', partsReceiptFile:'sb:j1/parts-receipt-1.jpg', commissionPercent:30, paymentStatus:'Paid', datePaid:'2026-10-05', paidToTechnician:'Not Paid' },
    { id:'j2', invoiceNumber:'2501', customerName:'Tom', technician:'Guy', date:'2026-10-05', amount:200, includesGST:true, partsCost:20, partsPaidBy:'Guy', partsRefundStatus:'N/A', commissionPercent:30, paymentStatus:'Unpaid' }, // old row, never marked waiting
  ];
  const m = sb.computePayrollMaterials(sb.STATE.data, 'Guy', W);
  assertEqual(m.lines.map(l => l.label + ':' + l.amount), ['Drill:55', 'Ladder:110', 'Parts for job #2500 · Sarah:44'], 'materials: by the week entered (the ladder bought last week counts this week), the drill moves on from a paid week, not the business purchase, not someone else\'s');
  assertEqual([m.total, m.gst], [209, 19], 'materials: $209 paid back in full, $19 GST in it');
  const partsLine = m.lines.find(l => l.kind==='parts');
  assertEqual([partsLine.desc, partsLine.receipt], ['Filter', 'sb:j1/parts-receipt-1.jpg'], 'materials: what the parts were and the receipt go with the line');
  const mPrev = sb.computePayrollMaterials(sb.STATE.data, 'Guy', PREV);
  assertEqual(mPrev.lines.map(l => l.label), ['Gloves'], 'materials: a paid week shows what was paid back in it, nothing new');
  const c = sb.computePayrollCommission(sb.STATE.data, 'Guy', W);
  // commission: 30% of (349 - 44) = 91.50; materials 209 → total 300.50
  assertEqual([c.total, c.materials.total, c.grandTotal], [91.5, 209, 300.5], 'payroll: commission and equipment & materials separately, then the total');
  const msg = sb.buildCommissionPayMessage(c);
  assertEqual(msg.includes('ציוד וחומרים שקנית (חשבונית נפרדת):') && msg.includes('* Ladder (2/10): $110.00') && msg.includes('* חלקים לעבודה #2500 - Filter (5/10): $44.00') && msg.includes('עמלה: $91.50') && msg.includes('ציוד וחומרים: $209.00 (מתוך זה GST: $19.00)') && msg.includes('סה"כ לתשלום: $300.50'), true, 'pay message (Guy gets Hebrew): both amounts, the GST in the materials, and the total');
  const plain = sb.buildCommissionPayMessage(sb.computePayrollCommission(sb.STATE.data, 'Guy', '2026-10-11'));
  assertEqual(plain.includes('ציוד'), false, 'pay message: nothing about equipment in a week without any');
  sb.STATE.data.payrollWeeks = []; sb.STATE.data.equipmentSpend = []; sb.STATE.data.jobs = [];
}

function testGstSummary(sb){
  // GST for a period (Ofek 6 Oct): collected on paid jobs, minus what we get back from purchases (equipment + parts on
  // jobs, both incl. GST), = what we pay. Ads are not in it yet.
  sb.STATE.data.settings = { gstRatePercent:10 };
  const data = {
    jobs: [
      { date:'2026-10-05', amount:349, includesGST:true, paymentStatus:'Paid', partsCost:44 },    // GST 34.90; parts GST 4
      { date:'2026-10-06', amount:300, includesGST:true, paymentStatus:'Unpaid', partsCost:0 },   // not paid: no GST collected yet
      { date:'2026-10-06', amount:250, includesGST:false, paymentStatus:'Paid', partsCost:22 },   // cash, no GST; parts GST 2
      { date:'2026-09-20', amount:1000, includesGST:true, paymentStatus:'Paid', partsCost:110 },  // outside the period
    ],
    equipmentSpend: [{ date:'2026-10-04', cost:330 }, { date:'2026-09-01', cost:999 }],          // 30 in the period
  };
  const g = sb.computeGstSummary(data, '2026-10-04', '2026-10-10');
  assertEqual([g.collected, g.backEquipment, g.backParts, g.back, g.toPay], [34.9, 30, 6, 36, -1.1], 'GST: collected 34.90, back 30 (equipment) + 6 (parts) = 36, to pay −1.10');
  data.jobs[0].paymentMethod = 'Cash';
  const g2 = sb.computeGstSummary(data, '2026-10-04', '2026-10-10');
  assertEqual([g2.collectedCash, g2.collectedOther], [34.9, 0], 'GST: collected on cash jobs shown apart from card + transfer');
}

function testDashboardMoneyVisuals(sb){
  // Net profit step by step (Ofek 6 Oct): revenue, each cost taken off the running total, then what is left.
  const np = { revenue:1000, commission:300, parts:50, equipment:50, marketing:100, hourlyStaff:80, owners:600, days:7, net:-180 };
  const p = sb.profitSteps(np);
  assertEqual(p.steps.map(x => [x.from, x.to]), [[0,1000],[700,1000],[650,700],[600,650],[500,600],[420,500],[-180,420],[-180,0]], 'profitSteps: each cost starts where the running total was; a loss goes below zero');
  assertEqual([p.lo, p.hi, p.steps[7].kind, p.steps[7].value], [-180, 1000, 'loss', -180], 'profitSteps: scale from the lowest point to revenue; the last step is the loss');
  // A technician's week (moved from Financial Summary): jobs done that week by job date, daily average, job types.
  sb.STATE.data.settings = { gstRatePercent:10 };
  const data = { jobs: [
    { technician:'Guy', date:'2026-10-05', amount:400, partsCost:40, jobType:'Aircon', paymentStatus:'Paid' },
    { technician:'Guy', date:'2026-10-05', amount:300, partsCost:0, jobType:'Aircon', paymentStatus:'Unpaid' },
    { technician:'Guy', date:'2026-10-07', amount:500, partsCost:20, jobType:'Chimney', paymentStatus:'Paid' },
    { technician:'Guy', date:'2026-10-11', amount:999, partsCost:0, jobType:'Aircon', paymentStatus:'Paid' },   // next week
    { technician:'Dolev', date:'2026-10-05', amount:200, partsCost:0, jobType:'Aircon', paymentStatus:'Paid' }, // someone else
  ] };
  const st = sb.techWeekStats(data, 'Guy', '2026-10-04');
  // net = (400-40) + 300 + (500-20) = 1140 over 2 days = 570
  assertEqual([st.totalJobs, st.paidCount, st.unpaidCount, st.daysWorked, st.dailyAvg], [3, 2, 1, 2, 570], 'techWeekStats: 3 jobs done this week, 2 paid, 2 days, $570 a day');
  assertEqual([st.types.Aircon.count, st.types.Aircon.total, st.types.Chimney.count, st.types.Chimney.total], [2, 700, 1, 500], 'techWeekStats: by job type');
}

function testPayrollPeriods(sb){
  // Payroll period (Ofek 6 Oct): week / month / custom, compared with the matching period before (same number of days).
  const today = '2026-10-06';   // Tuesday
  const P = ui => { const p = sb.payrollPeriod(ui, today); return [p.start, p.effEnd, p.prevStart, p.prevEnd]; };
  assertEqual(P({ mode:'week' }), ['2026-10-04','2026-10-06','2026-09-27','2026-09-29'], 'payrollPeriod: this week so far vs the same days of the week before');
  assertEqual(P({ mode:'week', week:'2026-09-27' }), ['2026-09-27','2026-10-03','2026-09-20','2026-09-26'], 'payrollPeriod: a finished week vs the whole week before');
  assertEqual(P({ mode:'month' }), ['2026-10-01','2026-10-06','2026-09-01','2026-09-06'], 'payrollPeriod: this month so far vs the same days of last month');
  assertEqual(P({ mode:'month', month:'2026-09' }), ['2026-09-01','2026-09-30','2026-08-01','2026-08-31'], 'payrollPeriod: a finished month vs the whole month before');
  assertEqual(P({ mode:'month', month:'2026-03' }), ['2026-03-01','2026-03-31','2026-02-01','2026-02-28'], 'payrollPeriod: March vs all of February, never past its end');
  assertEqual(P({ mode:'custom', from:'2026-09-01', to:'2026-09-30' }), ['2026-09-01','2026-09-30','2026-08-02','2026-08-31'], 'payrollPeriod: custom 30 days vs the 30 days before');
  assertEqual(P({ mode:'custom', from:'2026-09-30', to:'2026-09-01' }), ['2026-09-01','2026-09-30','2026-08-02','2026-08-31'], 'payrollPeriod: custom picked backwards still works');
  sb.STATE.data.employees = [{ name:'Guy', roles:['Technician'], status:'Active', employmentType:'Freelance-commission' }];
  const data = { jobs: [
    { technician:'Guy', date:'2026-10-01', amount:400, partsCost:40, commissionPercent:30 },
    { technician:'Guy', date:'2026-10-01', amount:200, partsCost:0, commissionPercent:30 },
    { technician:'Guy', date:'2026-10-03', amount:300, partsCost:0, commissionPercent:30 },
    { technician:'Guy', date:'2026-09-20', amount:999, partsCost:0, commissionPercent:30 },
  ], salesLogs: [{ person:'Ron', date:'2026-10-02', hours:8, bookingsAircon:5, bookingsChimney:0, bookingsPw:0 }, { person:'Ron', date:'2026-09-02', hours:4, bookingsAircon:0, bookingsChimney:0, bookingsPw:0 }] };
  const st = sb.techPeriodStats(data, 'Guy', '2026-10-01', '2026-10-06');
  // revenue 900 over 3 jobs = 300 avg; commission 30% of (360 + 200 + 300) = 258; 2 days; daily (900 − 40) / 2 = 430
  assertEqual([st.count, st.revenue, st.avgJob, st.commission, st.daysWorked, st.dailyAvg], [3, 900, 300, 258, 2, 430], 'techPeriodStats: jobs, revenue, average job, commission, days, daily average');
  assertEqual(sb.techPeriodStats(data, 'Guy', '2026-09-01', '2026-09-06').avgJob, null, 'techPeriodStats: no jobs = no average');
  const h = sb.hourlyPeriodStats(data, 'Ron', '2026-10-01', '2026-10-06');
  assertEqual([h.hours, h.bookings], [8, 5], 'hourlyPeriodStats: hours and bookings in the range only');
}

function testTasksAndExpenses(sb){
  // Tasks: All / Just mine / a person (a person = assigned to them, or still on their board).
  sb.STATE.profiles = [{ role:'va', fullName:'Ron', technicianName:null }];
  const T = (id, assignees, board) => ({ id, assignees, board, status:'Not Started' });
  const tasks = [T('t1', ['Ron'], 'ron'), T('t2', ['Ofek','Ron'], 'Ofek'), T('t3', ['Guy'], 'Guy'), T('t4', ['Omri'], 'Omri'), T('t5', [], 'Noam')];
  const ids = list => list.map(t => t.id);
  const ofek = { fullName:'Ofek', technicianName:'Ofek' }, omri = { fullName:'Omri Gurna', technicianName:'Omri' }, ron = { fullName:'Ron', technicianName:null };
  assertEqual(ids(sb.tasksInView(tasks, 'all', ofek)), ['t1','t2','t3','t4','t5'], 'tasksInView: All = everyone');
  assertEqual([ids(sb.tasksInView(tasks, 'me', ofek)), ids(sb.tasksInView(tasks, 'me', omri)), ids(sb.tasksInView(tasks, 'me', ron))], [['t2'], ['t4'], ['t1','t2']], 'tasksInView: Just mine = assigned to whoever is logged in (shared tasks too)');
  assertEqual([ids(sb.tasksInView(tasks, 'Ron', ofek)), ids(sb.tasksInView(tasks, 'Noam', ofek))], [['t1','t2'], ['t5']], 'tasksInView: a person = assigned to them, or on their board');
  const emp = (name, roles, status) => ({ name, roles, status: status || 'Active' });
  assertEqual(sb.taskPeople({ employees: [emp('Guy',['Technician']), emp('Noam',['Owner','Technician']), emp('Ron',['VA']), emp('Old',['Technician'],'Inactive'), emp('Ofek',['Owner','Technician'])] }), ['Ron','Noam','Ofek','Guy'], 'taskPeople: Ron, then the owners, then the rest; active only');

  // Expenses & receipts: equipment purchases + parts for jobs, newest first; parts only when they cost something.
  const data = {
    equipmentSpend: [
      { id:'e1', date:'2026-10-02', item:'Ladder', category:'Tools', supplier:'Bunnings', technician:'Guy', paidBy:'Guy', cost:330, reimbursed:'Pending', receiptFile:'sb:x' },
      { id:'e2', date:'2026-09-20', item:'Rags', category:'', supplier:'BP', technician:'Omri', paidBy:'Business', cost:12.5, reimbursed:'N/A' },
    ],
    jobs: [
      { id:'j1', date:'2026-10-04', invoiceNumber:'1008', customerName:'Sam', partsCost:55, partsDescription:'Filter', partsSupplier:'Bunnings Warehouse', technician:'Guy', partsPaidBy:'Guy', partsRefundStatus:'Pending Refund' },
      { id:'j2', date:'2026-10-03', invoiceNumber:'1009', partsCost:0, technician:'Guy' },
    ],
    suppliers: [{ name:'Actrol' }, { name:'bunnings' }],
  };
  const rows = sb.expenseRows(data);
  assertEqual(rows.map(r => [r.id, r.category, r.amount]), [['j1','Job parts',55], ['e1','Tools',330], ['e2','',12.5]], 'expenseRows: job parts + purchases, newest first, no $0 parts');
  assertEqual([rows[0].item, rows[0].job, rows[0].refund], ['Filter', 'Job #1008 · Sam', 'Pending Refund'], 'expenseRows: a parts row says what and which job');
  const f = x => sb.filterExpenseRows(rows, x).map(r => r.id);
  assertEqual([f({ start:'2026-10-01', end:'2026-10-07' }), f({ supplier:' bUNn ' }), f({ category:'none' }), f({ tech:'Guy', category:'Tools' }), f({ category:'Job parts' })],
    [['j1','e1'], ['j1','e1'], ['e2'], ['e1'], ['j1']], 'filterExpenseRows: dates, supplier (any part, any case), not set, technician + category, job parts');
  assertEqual(sb.supplierNames(data), ['BP','Bunnings','Bunnings Warehouse','Actrol'], 'supplierNames: used ones first (the same name in any case once), then the Suppliers list');

  // The store on a receipt.
  const find = (text, extra) => sb.findStoreInText(text, [...sb.KNOWN_STORES, ...(extra||[])]);
  assertEqual([
    find('BUNNlNGS WAREHOUSE\nTAX INVOICE\nABN 26 008 672 179'),
    find('BUNNlNGS WAREHOUSE\nTAX INVOICE', ['Bunnings Warehouse']),
    find('Welcome to\nAMP0L Foodary Kings Park\nUnleaded 91\nMobile: 0412 345 678'),
    find('SHELF BRACKET x2\nThanks'),
    find('Coles Express\nShell V-Power'),
    find('SUPERCHEAPAUTO\nRECEIPT'),
    find('7-ELEVEN #2231'),
    find('Visit www.bpwebsite.com'),
    find(''),
  ], ['Bunnings', 'Bunnings Warehouse', 'Ampol', null, 'Coles Express', 'Supercheap Auto', '7-Eleven', null, null],
  'findStoreInText: one misread letter, 0 read as O, MOBILE is not Mobil, SHELF is not Shell, top line + longer name wins, run-together words, no store inside other words');
}

function testPayrollInvoices(sb){
  // Guy (commission on the amount before GST minus parts), pay week Sun 27 Sep – Sat 3 Oct 2026.
  sb.STATE.data.employees = [{ name:'Guy', employmentType:'Freelance-commission' }, { name:'Alessandro', employmentType:'Independent Contractor' }];
  const data = {
    payrollWeeks: [], employees: sb.STATE.data.employees,
    jobs: [
      { id:'j1', technician:'Guy', date:'2026-09-28', amount:349, partsCost:0, commissionPercent:30, paymentStatus:'Paid', datePaid:'2026-09-28', invoiceNumber:'1012', customerName:'Sarah M.', jobType:'Aircon', partsRefundStatus:'N/A' },
      { id:'j2', technician:'Guy', date:'2026-09-29', amount:549, partsCost:45, commissionPercent:30, paymentStatus:'Paid', datePaid:'2026-09-30', invoiceNumber:'1015', customerName:'David K.', jobType:'Aircon',
        partsPaidBy:'Guy', partsRefundStatus:'Pending Refund', partsPendingAt:'2026-09-29T02:00:00Z', partsDescription:'Filter', partsSupplier:'Bunnings', partsReceiptFile:'sb:x' },
      { id:'j3', technician:'Guy', date:'2026-10-01', amount:420, partsCost:0, commissionPercent:30, paymentStatus:'Unpaid', invoiceNumber:'1019', jobType:'Chimney', partsRefundStatus:'N/A' },
      { id:'j4', technician:'Alessandro', date:'2026-09-29', amount:400, partsCost:50, commissionPercent:50, paymentStatus:'Paid', datePaid:'2026-09-29', invoiceNumber:'2001', jobType:'Pressure Washing', partsPaidBy:'Alessandro', partsRefundStatus:'N/A' },
    ],
    equipmentSpend: [{ id:'e1', date:'2026-10-02', createdAt:'2026-10-02T01:00:00Z', item:'Extension ladder', category:'Tools', supplier:'Total Tools', technician:'Guy', paidBy:'Guy', cost:330, reimbursed:'Pending', receiptFile:'sb:y' }],
  };
  const parties = { from:{ name:'Guy', legalName:'Guy Galili', abn:'' }, to:{ legalName:'The Guys Service Group Pty Ltd', abn:'51 695 019 339', acn:'695 019 339' } };
  const c = sb.buildPayrollInvoice(data, 'Guy', '2026-09-27', 'salary', parties, '2026-10-04');
  // 349 × 30% = 104.70; (549 − 45) × 30% = 151.20; the unpaid job is not on it
  assertEqual([c.number, c.weekStart, c.weekEnd, c.lines.map(l => [l.invoice, l.amount, l.parts, l.rate, l.commission]), c.total, c.gst, c.deductsParts],
    ['GUY-260927-C', '2026-09-27', '2026-10-03', [['1012', 349, 0, 30, 104.7], ['1015', 549, 45, 30, 151.2]], 255.9, 0, true], 'buildPayrollInvoice: commission = the jobs paid that week, parts taken off, no GST');
  const e = sb.buildPayrollInvoice(data, 'Guy', '2026-09-27', 'expenses', parties, '2026-10-04');
  // parts $45 (GST 4.09) and the ladder $330 (GST 30.00): paid back $375, GST inside 34.09
  assertEqual([e.number, e.lines.map(l => [l.label, l.detail, l.supplier, l.receipt, l.gst, l.amount]), e.total, e.gst],
    ['GUY-260927-E', [['Filter', 'Job parts · job #1015', 'Bunnings', true, 4.09, 45], ['Extension ladder', 'Tools', 'Total Tools', true, 30, 330]], 375, 34.09], 'buildPayrollInvoice: expenses = what he paid for himself, with supplier, receipt and the GST inside');
  const a = sb.buildPayrollInvoice(data, 'Alessandro', '2026-09-27', 'salary', parties, '2026-10-04');
  assertEqual([a.number, a.deductsParts, a.lines.map(l => [l.parts, l.commission]), a.total], ['ALESSANDRO-260927-C', false, [[0, 200]], 200], 'buildPayrollInvoice: an independent contractor gets the rate on the full amount (parts not taken off)');
  assertEqual([sb.payrollInvoiceMissing(c), sb.payrollInvoiceMissing({ from:{ abn:'51 695 019 339' } })], [['ABN'], []], 'payrollInvoiceMissing: no ABN, no invoice');
  assertEqual([sb.fmtAbn('51695019339'), sb.fmtAbn('51 695 019 339'), sb.fmtAbn('123')], ['51 695 019 339', '51 695 019 339', '123'], 'fmtAbn: 11 digits in the usual groups');

  // Bonuses the owners add (7 Oct): on that week's pay, a line on the commission invoice, off the net profit.
  data.payrollBonuses = [
    { id:'b1', weekKey:'2026-09-27', person:'Guy', amount:100, reason:'5-star week', createdAt:'2026-10-03T01:00:00Z' },
    { id:'b2', weekKey:'2026-09-27', person:'Ofek', amount:250, reason:'', createdAt:'2026-10-03T02:00:00Z' },
    { id:'b3', weekKey:'2026-09-20', person:'Guy', amount:40, reason:'old week', createdAt:'2026-09-25T01:00:00Z' },
  ];
  assertEqual([sb.payrollBonusesFor(data, 'Guy', '2026-09-27').total, sb.payrollBonusesFor(data, 'Guy', '2026-09-20').total, sb.payrollBonusesFor(data, 'Dolev', '2026-09-27').total], [100, 40, 0], 'payrollBonusesFor: only that person and that week');
  const pc = sb.computePayrollCommission(data, 'Guy', '2026-09-27');
  // 255.90 commission + 375 equipment & materials + 100 bonus = 730.90
  assertEqual([pc.total, pc.bonus.total, pc.grandTotal], [255.9, 100, 730.9], 'computePayrollCommission: the bonus is added to the week\'s total to pay');
  const msg = sb.buildCommissionPayMessage(pc);
  assertEqual([/5-star week: \$100/.test(msg), /\$730\.9/.test(msg)], [true, true], 'pay message: lists the bonus and pays the total with it');
  const cb = sb.buildPayrollInvoice(data, 'Guy', '2026-09-27', 'salary', parties, '2026-10-04');
  assertEqual([cb.lines.map(l => [l.kind, l.label, l.value]), cb.total, cb.computedTotal],
    [[['job', '#1012 · Sarah M.', 104.7], ['job', '#1015 · David K.', 151.2], ['bonus', 'Bonus · 5-star week', 100]], 355.9, 355.9], 'buildPayrollInvoice: the bonus is its own line on the commission invoice');
  // Changes made on one invoice only: a commission changed, a line added; the system's figures stay as they were.
  // 110 + 151.20 + 100 + 12.50 = 373.70
  cb.lines[0].value = 110; cb.lines.push({ kind:'extra', label:'Tolls', value:12.5 });
  assertEqual([sb.payrollInvoiceTotals(cb).total, cb.lines.map(l => sb.payrollInvoiceLineEdited(l)), cb.computedTotal, sb.computePayrollCommission(data, 'Guy', '2026-09-27').total],
    [373.7, [true, false, false, true], 355.9, 255.9], 'payrollInvoiceTotals: an edited invoice adds up its own lines; changed and added lines are marked; the payroll is not changed');
  const eb = sb.buildPayrollInvoice(data, 'Guy', '2026-09-27', 'expenses', parties, '2026-10-04');
  eb.lines[1].value = 220; eb.lines.push({ kind:'extra', label:'Parking', value:20 });
  // 45 + 220 + 20 = 285; GST only inside store receipts: 4.09 + 20.00 = 24.09 (nothing on the added line)
  assertEqual([sb.payrollInvoiceTotals(eb).total, sb.payrollInvoiceTotals(eb).gst], [285, 24.09], 'payrollInvoiceTotals: expenses GST follows the changed amounts, none on an added line');
  sb.STATE.data.settings = { gstRatePercent:10 };
  const npB = sb.computeNetProfit({ jobs: [], payrollBonuses: data.payrollBonuses, settings: { ownerSalaries:{} } }, '2026-09-27', '2026-10-03', new Date(2026, 9, 10));
  assertEqual([npB.bonuses, npB.net], [350, -350], 'netProfit: the week\'s bonuses (owners\' too) come off');
  const steps = sb.profitSteps(npB).steps.map(x => x.label);
  assertEqual(steps.includes('Bonuses'), true, 'profitSteps: a Bonuses step when there are bonuses');
}

function testLeadEmailCheck(sb){
  console.log('\nThe nightly lead check (info@ emails vs the app)');
  assertEqual([sb.leadPhoneKey('0412 052 478'), sb.leadPhoneKey('+61412052478'), sb.leadPhoneKey('61412052478'), sb.leadPhoneKey('2042')], ['412052478', '412052478', '412052478', ''], 'leadPhoneKey: the same number written three ways, a postcode is not a phone');
  const checks = [
    { day:'2026-10-08', emails:4, matched:2, missing:[
      { id:'m1', at:'2026-10-08T09:53:33Z', name:'Jackie Kettley', phone:'0433682592', email:'jacks@hotmail.com', subject:'New Lead from "The Guys Group"', hint:'' },
      { id:'m2', at:'2026-10-08T11:00:14Z', name:'Rose', phone:'+61413610769', email:'', subject:'New message from AC Duct LP Cleaning Form', hint:'Meta Ads' },
      { id:'m3', at:'2026-10-08T12:00:00Z', name:'Spam', phone:'', email:'spam@x.com', subject:'New message from Careers', hint:'' } ] },
    { day:'2026-09-20', emails:1, matched:0, missing:[{ id:'old', at:'2026-09-20T01:00:00Z', name:'Too old', phone:'0400111222', email:'', subject:'x', hint:'' }] },
    { day:'2026-10-07', emails:2, matched:2, missing:[] },
  ];
  const contacts = [{ phone:'0413 610 769', email:'' }, { phone:'', email:'SOMEONE@else.com' }];
  const open = sb.leadCheckOpen(checks, contacts, new Set(['leadmail:m3']), '2026-10-09');
  assertEqual(open.map(m => [m.id, m.day]), [['m1', '2026-10-08']], 'leadCheckOpen: Rose has a card now (phone written differently), the spam was marked Not a lead, a check older than a week is left out');
  assertEqual(sb.leadCheckOpen(checks, [...contacts, { phone:'', email:'Jacks@Hotmail.com ' }], new Set(['leadmail:m3']), '2026-10-09').length, 0, 'leadCheckOpen: a card made by hand with the same email clears it');
  assertEqual(sb.leadCheckLatest(checks).day, '2026-10-08', 'leadCheckLatest: the newest checked day');
  assertEqual(sb.leadCheckLatest([]), null, 'leadCheckLatest: no check yet');
  assertEqual(['New message from AC Duct LP Cleaning Form', 'New message from Pressure Washing Landing Page #Del', 'Chimney form', 'New Lead from "The Guys Group"', 'New website chat lead - Vivienne'].map(sb.leadDivisionFromSubject),
    ['Aircon', 'Pressure Washing', 'Chimney', 'Other', 'Other'], 'leadDivisionFromSubject: the service from the form name');
  const ok = sb.adsEmailCheck([{ day:'2026-10-08', emails:9, matched:9, google_emails:2, google_matched:2 }, { day:'2026-10-07', emails:5, matched:5, google_emails:1, google_matched:1 }]);
  assertEqual([ok.tone, ok.missing, /all 3 Google leads reached the app, and all 14 lead emails/.test(ok.text)], ['good', 0, true], 'adsEmailCheck: every Google lead email has a card');
  const bad = sb.adsEmailCheck([{ day:'2026-10-08', emails:9, matched:8, google_emails:2, google_matched:1 }]);
  assertEqual([bad.tone, bad.missing, /1 of 2 Google leads/.test(bad.text)], ['bad', 1, true], 'adsEmailCheck: a Google lead email with no card is a problem the agency sees');
  const other = sb.adsEmailCheck([{ day:'2026-10-08', emails:9, matched:8, google_emails:2, google_matched:2 }]);
  assertEqual([other.tone, /lead emails from every source/.test(other.text)], ['good', false], 'adsEmailCheck: a missing non-Google lead is not the agency\'s problem (and not claimed as all fine)');
  assertEqual(sb.adsEmailCheck([]), null, 'adsEmailCheck: nothing until the first check has run');
}

function testAdsTracking(sb){
  const P = 'The Guys Group - Main Website Sydney (web) ';
  assertEqual(['Calls from ads', 'Call (1300 380 090)', P+'phone_click_sr', 'Click to call', P+'main_forms_sr', P+'split_system_cleaning_form_sr', P+'aircon_general_form_sr', P+'join_our_newsletter_sr', P+'email_click_sr', 'The Guys Group (web) Thank_you_conversion', P+'chat_lead_aircon_sr'].map(sb.adsConvKind),
    ['call', 'call', 'tap', 'tap', 'form', 'form', 'form', 'other', 'other', 'other', 'chat'], 'adsConvKind: forms and calls are leads; phone taps, newsletter, email clicks, thank-you views are not');
  const G = 'General Air Con Cleaning', X = 'PMax Air Con', D = 'Ducted & Split System';
  const act = (campaign, item, conversions) => ({ campaign, item, conversions });
  const set = (item, primary, counting) => ({ item, extra: { primary, inConversions: primary, counting } });
  const idx = { '30d': { conv_action: [act(G, 'The Guys Group (web) Thank_you_conversion', 0), act(G, P+'main_forms_sr', 8.9912), act(G, P+'phone_click_sr', 1), act(G, P+'split_system_cleaning_form_sr', 16),
      act(X, 'Call (1300 380 090)', 3), act(X, P+'aircon_general_form_sr', 1), act(X, P+'join_our_newsletter_sr', 1), act(X, P+'main_forms_sr', 5), act(X, P+'phone_click_sr', 8), act(X, P+'split_system_cleaning_form_sr', 1),
      act(D, P+'duct_cleaning_form_sr', 1), act(D, P+'main_forms_sr', 0.0088), act(D, P+'phone_click_sr', 0)] },
    now: { conv_setting: [set(P+'phone_click_sr', true, 'ONE_PER_CLICK'), set(P+'aircon_general_form_sr', true, 'MANY_PER_CLICK'), set(P+'main_forms_sr', true, 'ONE_PER_CLICK'), set(P+'join_our_newsletter_sr', false, 'MANY_PER_CLICK')] } };
  const real = [{ win:'30d', kind:'form', campaign:G, n:15 }, { win:'30d', kind:'form', campaign:X, n:5 }, { win:'30d', kind:'form', campaign:D, n:1 }, { win:'30d', kind:'form', campaign:'', n:3 },
    { win:'30d', kind:'call60', campaign:G, n:5 }, { win:'30d', kind:'call60', campaign:X, n:1 }, { win:'30d', kind:'call_short', campaign:G, n:3 }, { win:'30d', kind:'call_short', campaign:X, n:2 }, { win:'7d', kind:'form', campaign:'', n:1 }];
  const t = sb.adsTracking(idx, real, '30d');
  // forms 8.9912 + 16 + 1 + 5 + 1 + 1 + 0.0088 = 33; calls 3; taps 1 + 8 = 9; other (newsletter) 1 → 46
  assertEqual([t.google, t.gTotal], [{ form:33, call:3, chat:0, tap:9, other:1 }, 46], 'adsTracking: Google conversions sorted into forms, calls, taps and others');
  // real: forms 15 + 5 + 1 + 3 = 24, calls of a minute+ 5 + 1 = 6 (5 shorter calls left out) → 30
  assertEqual([t.got.form, t.got.call60, t.got.call_short, t.realTotal], [24, 6, 5, 30], 'adsTracking: real leads = CRM forms + Google ad calls of a minute or more');
  assertEqual(t.campaigns.map(c => [c.campaign, c.gLeads, c.gNot, c.real]), [[G, 25, 1, 20], [X, 10, 9, 6], [D, 1, 0, 1], ['', 0, 0, 3]], 'adsTracking: per campaign, Google leads / not leads / real leads');
  assertEqual(t.issues.map(i => i.tone), ['bad', 'warn', 'warn', 'warn'], 'adsTracking: phone taps primary (bad), newsletter counted, a form counting every submission, Google counts more forms than reached us');
  assertEqual([/phone_click_sr.*9 of the 46/.test(t.issues[0].text), /join_our_newsletter_sr/.test(t.issues[1].text), /aircon_general_form_sr/.test(t.issues[2].text), /33 form leads.*24 reached us/.test(t.issues[3].text)], [true, true, true, true], 'adsTracking: each problem names the action and the numbers');
  assertEqual(sb.adsTracking({}, [], '30d').noData, true, 'adsTracking: nothing loaded yet = no problems claimed');
}

testJobAttributionTags(loadSandbox());
testSubDivisionAndSource(loadSandbox());
testComputeBusinessPerformance(loadSandbox());
testFunnelLossReasonsSpeedToLead(loadSandbox());
testComputeProfitByWeekInRange(loadSandbox());
testRepeatServiceReminder(loadSandbox());
testPayroll(loadSandbox());
testDashboard(loadSandbox());
testJobCustomerLink(loadSandbox());
testSalesAutomations(loadSandbox());
testReviewNeed(loadSandbox());
testClosingTotalInclGst(loadSandbox());
testJobsRange(loadSandbox());
testMaterialsPayback(loadSandbox());
testGstSummary(loadSandbox());
testDashboardMoneyVisuals(loadSandbox());
testPayrollPeriods(loadSandbox());
testTasksAndExpenses(loadSandbox());
testPayrollInvoices(loadSandbox());
testAdsTracking(loadSandbox());
testLeadEmailCheck(loadSandbox());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
