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
  'JOB_TYPES', 'LEAD_DIVISIONS', 'LEAD_SOURCES', 'LEAD_SOURCE_COLOR', 'AIRCON_TYPE_TAGS', 'META_PLATFORM_TAGS', 'LOST_REASONS', 'lostReasonOf', 'SUB_DIVISIONS', 'SUB_SOURCES', 'LEAD_TAGS', 'leadTagOn', 'DIVISION_COLOR', 'divColor', 'leadSubDivisions', 'leadSubSource', 'visibleTags', 'subSourceOptions', 'LEAD_SOURCE_LABEL', 'sourceLabel', 'splitLeadRequestEvent', 'LEAD_STATUSES', 'LEAD_STAGE_LABEL', 'stageLabel', 'STAGES_NEED_DATE', 'PIPELINE_RULES_FROM', 'JOB_CACHE', 'jobIndex', 'leadLatestJobDate', 'leadWonByJob', 'leadStage', 'followupDue', 'leadRulesApply', 'leadNeedsFutureDate', 'isWorkday', 'chaseCounter', 'sydneyWall', 'chaseAlertDue',
  // CRM / attribution
  'findContactByName', 'contactForJob', 'jobAttributionTags', 'computeCrmStats',
  // financial rollups
  'commissionEligibleTechnicianNames', 'computeWeek',
  // business performance
  'blankPerfBucket', 'addToPerfBucket', 'finalizePerfBucket', 'computeProfitByWeekInRange', 'computeBusinessPerformance',
  'contactHasJob',
  // reminders
  'fmtDateShort', 'computeReminders', 'TECH_REMINDER_TYPES', 'OWNER_REMINDER_TYPES', 'remindersFor', 'EMP_DOCS', 'EMP_DOC_WARN_DAYS', 'fmtDateYear', 'employeeDocExpiry', 'abnValid', 'employeeMissing',
  // payroll + net profit
  'PAYROLL_HOURLY_RATE', 'PAYROLL_BOOKING_BONUS', 'PAYROLL_HEBREW_NAMES', 'payCatalog', 'payTiersOk', 'payHourlyFor', 'payHebrewNames', 'bookingBonus', 'nextBookingTier',
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
  // message templates (12 Oct)
  'TECH_JOB_TYPES', 'jobTypesForTech',
  'EQUIPMENT_CATEGORY_DEFAULTS', 'equipmentCategories', 'equipmentCategoryOf', 'contractorDealAmount', 'contractorDealLine', 'contractorDealNote', 'contractorStatusFromPrivate', 'contractorAgreementHtml', 'contractorAgreementInputs', 'ROLE_LABEL', 'roleLabel', 'peopleList', 'personActive', 'personRoles', 'personInGroup', 'ownerLoginsWithoutCard',
  'ORG_CTR', 'orgExpectedCtr', 'ORG_CLEAN_FROM', 'orgPath', 'orgWindow', 'orgIsLead', 'orgLeadStats', 'ORG_EV_LABEL', 'orgEvidenceText',
  'PHONE_MENU_DEFAULT', 'phoneMenuOf', 'phoneMenuText', 'phoneSayDefault', 'phoneRingSeconds', 'phoneE164', 'phonePretty', 'PHONE_BACKUP_DAY', 'phoneBackupHours', 'phoneBackupDayOk', 'phonePersonKeyFor',
  'REVIEW_TPL_VARS', 'CHAT_TPL_VARS', 'MSG_TEMPLATES', 'msgTemplateText', 'fillTemplate', 'SMS_GSM', 'smsParts', 'templateProblems',
  // review requests (5 Oct)
  'reviewInvoiceKey', 'reviewNeed', 'REVIEW_DEFAULTS', 'reviewCfg', 'reviewDefaultFor', 'reviewLinkFor',
  // one "Ask automatically" switch, the Closings box and the message preview (13 Oct)
  'reviewAutoOn', 'closingShowsNoAsk', 'TPL_EXAMPLE', 'tplPreviewHtml', 'reviewPreviewValues',
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
  'parseShownNumber', 'formatShownNumber', 'checkPhone', 'checkEmail', 'toastKind', 'NSW_HOLIDAYS', 'OFFICE', 'officeHoursFor', 'nextOfficeDay', 'hhmmToMins', 'minsToHhmm', 'officeHoursText', 'catalogHours', 'catalogObject', 'brandName', 'RULES', 'ACTIVE', 'DIV_LABEL', 'CATALOG', 'LEAD_STAGE_PICKABLE', 'LEAD_STATUS_COLOR', 'LEAD_STATUS_INK', 'stageColor', 'stageInk', 'replaceArr', 'divLabel', 'activeOnly', 'inkFor', 'catalogBase', 'catalogId', 'catalogList', 'catalogRules', 'lostReasonLabel', 'lostReasonCanDelete', 'catalogShown', 'catalogFindByName', 'SOURCE_HOSTS', 'sourceHost', 'sourceSetupSteps', 'sourceLeadStats', 'applyCatalog', 'STAGE_CORE', 'stageOn', 'stagesPickable', 'stagesShown', 'stagesInProgress', 'stageIsBuiltin', 'stageLeadsIn', 'stageStoredOnly', 'stageMovePlan', 'stageListWithNew', 'STAGE_RULE_TEXT', 'CAT_SWATCHES', 'tagColor', 'sameLiveRow', 'sameValue', 'LOCAL_WRITES', 'noteLocalWrite', 'settleLocalWrites',
  'LEAD_CHECK_DAYS', 'leadPhoneKey', 'leadCheckOpen', 'leadCheckLatest', 'leadDivisionFromSubject', 'adsEmailCheck',
  // Settings round 2, small fixes (13 Oct)
  'mfaStaleFactors', 'mfaFriendlyName', 'pushCanTest', 'phoneBarMode',
  // Region and format, business details (14 Oct)
  'DAY_NAMES', 'WEEK_RULES_MEMO', 'weekRules', 'weekRulesNow', 'weekBounds', 'weekStartDay', 'weekDaysName', 'weekOneOff', 'weekKeysInRange', 'weekChangePlan',
  'fyStartMonth', 'financialYearOf', 'DATE_FORMATS', 'dateFormatOf', 'fmtDateNumeric', 'invDate', 'invWeek', 'AU_STATES', 'businessAddress', 'BIZ_INSURANCE', 'businessInsuranceStatus',
  // Settings → Notifications as cards (14 Oct)
  'BIZ_INSURANCE_WARN_DAYS', 'hourLabel', 'NOTIFY_OFFICE_KINDS', 'notifyOn', 'notifyPeopleText', 'notifyCards',
  // VA automatic log-out, per person (13 Oct)
  'VA_SHIFT_DEFAULT', 'vaShiftTimes', 'vaShiftTimeProblem', 'vaEndTimeText',
  // Settings → People with tabs: pages, role defaults, pay (14 Oct)
  'ALL_SECTIONS', 'SECTION_ORDER', 'defaultPermissionsFor', 'PAGE_PICK', 'roleDefaultPages', 'pagesDiff', 'cleanPages', 'newProfilePermissions', 'listJoin', 'OLD_SETTINGS_PAGES', 'settingsPageKey', 'hhmm12',
  'payHourlyList', 'payHourlyNext', 'payHourlyBase', 'payHourlyKey', 'payHourlyUpsert', 'payHourlyHistory', 'payServicesFor', 'personPayKind', 'missingRates', 'divName', 'empRatesHtml',
  // Branding + colour picker (14 Oct)
  'normHex', 'hexRgb', 'rgbHex', 'mixHex', 'hexHsl', 'hslHex', 'relLum', 'contrastRatio', 'BRAND_INK', 'bestInk', 'liftColor', 'BRAND_ORIGINAL', 'BRAND_MARK', 'BRAND_MARK_NAME', 'BRAND_BASE',
  'brandBgTokens', 'brandSideTokens', 'brandSecTokens', 'brandOverrides', 'brandTokens', 'brandCssText', 'brandChecks', 'THEME_OPTS', 'themeChoice', 'productName', 'brandLogoKind', 'brandLogoFile',
  'joinLinkText', 'SEC_SWATCHES', 'BG_SWATCHES', 'CAT_PALETTE', 'palChosenHtml',
  // Settings → Connectors (14 Oct)
  'freshTone', 'CONN_HOW', 'CONN_HOW_ORDER', 'CONN_LATE_HOURS', 'CONN_ACCOUNTS', 'CONNECTORS', 'CONN_ADDONS', 'CONN_GUIDE_LINKS', 'connCfgOf', 'connItemOn', 'connAccountOn', 'connPatched',
  'connSourceDef', 'connDefs', 'connState', 'connIsLive', 'SOURCE_HOW', 'sourceRowInfo', 'connFreshItems', 'connOldest', 'connTone', 'connGhlArchiveText', 'connStepsFor', 'connNextStep', 'connHows', 'connMatches',
  'connStopsAll', 'connPendingReaders', 'fmtAdsAccount', 'connDayName', 'connSydDay', 'connWhen', 'connAddonsShown', 'CONN_LOG_SRC', 'connLogRows',
  // Settings → Security: Face ID / fingerprint (passkeys), the 30-minute lock, Settings history (14 Oct)
  'CAT_NAMES', 'setBlock', 'SEC_LOCK_MINUTES', 'bytesToB64url', 'b64urlToBytes', 'pkCreationOptions', 'pkRequestOptions', 'pkAttestationJSON', 'pkAssertionJSON', 'pkDeviceInfo', 'bioIcoFor', 'secMethodWord',
  'secUnlockMethods', 'lockedBackupLinkOpen', 'SEC_INTENTS', 'secGoogleParse', 'PAY_SETTING_NAMES', 'secLeft', 'secWhen', 'settingsHistParts', 'settingsHistFilter', 'secHistChips', 'secRecentCount', 'secReasonText',
  // Settings → Data: the full backup, the weekly locked backup and "Open a locked backup" (14 Oct)
  'BACKUP_DAY_ORDER', 'BACKUP_TABLE_LABELS', 'BACKUP_BUCKET_LABELS', 'backupEmailOk', 'backupDayLabel', 'backupWhenText', 'backupDateText', 'backupSizeText', 'backupStatusView',
  'backupParseHeader', 'backupReadPack', 'backupDecrypt', 'backupGunzipText', 'backupZipPath', 'backupReasonText',
  // Settings → Data: Export to Excel (14 Oct)
  'pill', 'jsStr', 'EXPORT_AREAS', 'exportDefaultSelection', 'EXPORT_SECRET_COL', 'EXPORT_SENS_COL', 'exportHiddenColumn', 'EXPORT_UPPER_WORDS', 'exportHeader', 'EXPORT_CELL_MAX', 'EXPORT_FILE_TEXT', 'exportCell',
  'exportActivityText', 'exportSheetAoa', 'exportColWidths', 'exportSheetName', 'settingsExportRows', 'payRateRows', 'ownerSalaryRows', 'countWord', 'exportCountText', 'exportFileName', 'exportSummaryHtml', 'exportFetchAll', 'exportCardHtml',
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
    return source.slice(source.slice(fnIdx - 6, fnIdx)==='async ' ? fnIdx - 6 : fnIdx, i);   // keeps "async" on an async function
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
  assertEqual(sb.visibleTags(oldLead), ['Returning customer'], 'Tags shows only the four tags (not the sub-division, sub-source or lost reason), whatever the spelling');
  assertEqual(sb.visibleTags({ tags:['Refunded','facebook','Callback','duct system','Complaint','Returning customer'] }), ['Returning customer','Callback','Complaint','Refunded'], 'the four tags, in their fixed order; nothing else');
  assertEqual(sb.visibleTags({}), [], 'no tags');
  assertEqual(['Aircon','Chimney','Pressure Washing','Other'].map(sb.divColor), ['var(--div-aircon)','var(--div-chimney)','var(--div-pw)','var(--div-other)'], 'each division has its own colour (Aircon blue, Chimney orange, Pressure Washing purple)');
  assertEqual(['Chimney Sweep','pressure washing','Air Con','',undefined].map(sb.divColor), ['var(--div-chimney)','var(--div-pw)','var(--div-aircon)','var(--div-other)','var(--div-other)'], 'an odd job-type spelling still gets its division colour');
  const newLead = { division:'Aircon', source:'Meta Ads', subDivisions:['Duct System'], subSource:'Facebook', tags:['Split System','Instagram'] };
  assertEqual([sb.leadSubDivisions(newLead), sb.leadSubSource(newLead)], [['Duct System'], 'Facebook'], 'the fields win over any leftover tag');
  assertEqual(sb.leadSubSource({ source:'Google Ads', tags:['Instagram'] }), '', 'a platform tag on a non-Meta lead is not its sub-source');
  assertEqual(sb.subSourceOptions('Google Ads', [{ source:'Google Ads', subSource:'Brand Search' }, { source:'Meta Ads', subSource:'Instagram' }]).slice(-1), ['Brand Search'], 'a campaign already on a lead becomes a choice');
  assertEqual(sb.subSourceOptions('Organic', []), [], 'no sub-source list for Organic');
  sb.STATE.data.contacts = [{ fullName:'Pat Field', division:'Aircon', source:'Meta Ads', subDivisions:['Split System'], subSource:'Instagram', tags:[] }];
  assertEqual(sb.jobAttributionTags({ customerName:'Pat Field', jobType:'Aircon' }), { airconType:'Split System', metaPlatform:'Instagram' }, 'jobs attribute to the sub-division and sub-source fields');
}

function testSplitLeadRequestEvent(sb){
  console.log('\nThe website opening line, split into arrival + request');
  assertEqual(sb.splitLeadRequestEvent('Lead created automatically from the website form (Meta Ads) — 2 units a small apt quotation please'),
    { label:'New lead from the website form · Meta Ads', request:'2 units a small apt quotation please', note:'' }, 'a form lead: the arrival line and only what they asked for');
  assertEqual(sb.splitLeadRequestEvent('Lead created automatically from the website chat (Organic) — Hi — I need a quote. Thanks'),
    { label:'New lead from the website chat · Organic web', request:'Hi — I need a quote. Thanks', note:'' }, 'a chat lead; a dash inside the message stays in the message');
  assertEqual(sb.splitLeadRequestEvent('Lead created automatically from the website form (Google Ads)'), { label:'New lead from the website form · Google Ads', request:'', note:'' }, 'no message: only the arrival line');
  assertEqual(sb.splitLeadRequestEvent('Sent the website form again (Meta Ads) — Cassette type aircon. Name on the form: Chris.'),
    { label:'Sent the website form again · Meta Ads', request:'Cassette type aircon', note:'Name on the form: Chris.' }, 'a repeat send: the name on the form goes under the request');
  assertEqual(sb.splitLeadRequestEvent('Sent the website form again (Organic) — Hi. Need two units.'), { label:'Sent the website form again · Organic web', request:'Hi. Need two units', note:'' }, 'a full stop inside the message stays');
  const ret = t => sb.splitLeadRequestEvent('🔁 Returning customer — new enquiry from the website ' + t);
  assertEqual(ret('form (Meta Ads) — Cassette type aircon.'), { returning:true, label:'Returning customer · new enquiry from the website form · Meta Ads', request:'Cassette type aircon', note:'' }, 'a returning customer: one card, the request highlighted');
  assertEqual(ret('form (Meta Ads). Name on the form: Praneel prasad.'), { returning:true, label:'Returning customer · new enquiry from the website form · Meta Ads', request:'', note:'Name on the form: Praneel prasad.' }, 'a returning customer with no message');
  assertEqual(ret('chat (Google Ads) — Hi,\n\nThe unit is dripping. Please call.\n0400 000 000. Name on the form: Jo Smith. Before: Chimney.'),
    { returning:true, label:'Returning customer · new enquiry from the website chat · Google Ads', request:'Hi,\n\nThe unit is dripping. Please call.\n0400 000 000', note:'Name on the form: Jo Smith. · Before: Chimney.' }, 'a long returning message: lines kept, the name and the earlier division under it');
  assertEqual(sb.splitLeadRequestEvent('Stage changed from "New lead" to "Chasing"'), null, 'other events are left alone');
  assertEqual(sb.splitLeadRequestEvent('Lead created automatically from job #2437 — Aircon, $369.00'), null, 'a lead made from a job is not a customer request');
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
  // A key that isn't a date never loops forever (found by the 13 Oct differential test): no days, total 0.
  assertEqual(['', 'garbage'].map(k => { const x = sb.computePayrollHourly(sb.STATE.data, 'Ron', k); return [x.days.length, x.total]; }), [[0, 0], [0, 0]], 'payroll hourly: a bad week key gives an empty week, not an endless loop');
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
  assertEqual(sb.supplierNames(data), ['BP','Bunnings','Bunnings Warehouse'], 'supplierNames: used ones first (the same name in any case once); the Contractors list is not shops, so not suggested (13 Oct)');

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

function testCountingNumbers(sb){
  console.log('\nCounting numbers: what is read off the screen and how it is written while it runs');
  const p = t => { const r = sb.parseShownNumber(t); return r && [r.value, r.decimals, r.commas, r.pre, r.post]; };
  assertEqual([p('$21,355.63 '), p('53 '), p('99%'), p('$13.6k'), p('29 days'), p('—')],
    [[21355.63, 2, true, '$', ' '], [53, 0, false, '', ' '], [99, 0, false, '', '%'], [13.6, 1, false, '$', 'k'], [29, 0, false, '', ' days'], null], 'parseShownNumber: money, counts, %, k, units; a dash is not a number');
  assertEqual([p('8 Oct'), p('00:42:12'), p('Oct 2026')], [null, null, null], 'parseShownNumber: a date or a time never counts');
  const f = (v, t) => sb.formatShownNumber(v, sb.parseShownNumber(t));
  assertEqual([f(0, '$21,355.63'), f(1234.5, '$21,355.63'), f(999.4, '$21,355.63'), f(6.66, '$13.6k'), f(12.4, '53 leads')], ['$0.00', '$1,234.50', '$999.40', '$6.7k', '12 leads'], 'formatShownNumber: keeps the $, decimals, thousands commas and the words around it');
}

function testFieldChecks(sb){
  console.log('\nPhone and email checked while typing');
  const ok = v => sb.checkPhone(v)==='';
  assertEqual(['0412 345 678', '+61 412 345 678', '61412345678', '02 9876 5432', '1300 123 456', '131 234', '+972 50 123 4567', ''].map(ok), [true, true, true, true, true, true, true, true], 'checkPhone: mobiles, landlines, 1300/13, overseas in full form, empty');
  assertEqual(['0412 345 67', '0412345678 9', '04a12', '9876 5432'].map(ok), [false, false, false, false], 'checkPhone: a digit short or extra, letters, no area code');
  assertEqual(['ofek@theguys.com.au', 'a@b.co', '', 'name@gmail', 'bad email@x.com'].map(v => sb.checkEmail(v)===''), [true, true, true, false, false], 'checkEmail: real addresses pass, a missing domain or a space does not');
}

function testLiveRowsAndStageMemo(sb){
  console.log('\nLive updates that change nothing, and the remembered stage');
  const local = { id:'a', status:'Chasing', stageChangedAt:'2026-10-12T08:00:00.000Z', tags:['Callback'], nextFollowUp:'', activityLog:[1] };
  assertEqual(sb.sameLiveRow(local, { id:'a', status:'Chasing', stageChangedAt:'2026-10-12T08:00:00+00:00', tags:['Callback'], nextFollowUp:'' }), true, 'sameLiveRow: the echo of a change made here (time written differently by the database) is the same');
  assertEqual(sb.sameLiveRow(local, { id:'a', status:'Quoted', stageChangedAt:'2026-10-12T08:00:00+00:00', tags:['Callback'], nextFollowUp:'' }), false, 'sameLiveRow: another stage is a change');
  assertEqual(sb.sameLiveRow(local, { id:'a', status:'Chasing', stageChangedAt:'2026-10-12T08:00:01+00:00', tags:['Callback'], nextFollowUp:'' }), false, 'sameLiveRow: another moment is a change');
  assertEqual(sb.sameLiveRow(local, { id:'a', status:'Chasing', tags:['Callback', 'Complaint'] }), false, 'sameLiveRow: a new tag is a change');
  assertEqual(sb.sameLiveRow({ id:'a' }, { id:'a', email:'' }), false, 'sameLiveRow: a field this screen does not have yet is a change');
  assertEqual(sb.sameLiveRow(undefined, { id:'a' }), false, 'sameLiveRow: a lead this screen does not have is new');
  assertEqual(sb.sameLiveRow({ messages:[{ id:'m', kind:'event', text:'x', at:'2026-10-12T08:00:00.000Z', author:undefined }] }, { messages:[{ at:'2026-10-12T08:00:00.000Z', id:'m', kind:'event', text:'x' }] }), true, 'sameLiveRow: a history entry the database stored with its fields in another order is the same');
  // A stage change saved in three steps comes back as three live rows; the first two still hold the older history.
  const lead = { id:'s1', status:'Chasing', contactedAt:'2026-10-12T08:00:01.000Z', messages:[{ id:'e1', text:'old' }, { id:'e2', text:'Stage changed' }] };
  sb.noteLocalWrite('contacts', 's1', { status:'Chasing' }); sb.noteLocalWrite('contacts', 's1', { contactedAt: lead.contactedAt }); sb.noteLocalWrite('contacts', 's1', { messages: lead.messages });
  const echo = extra => ({ id:'s1', status:'Chasing', contactedAt:null, messages:[{ text:'old', id:'e1' }], ...extra });
  const steps = [echo({}), echo({ contactedAt:'2026-10-12T08:00:01+00:00' }), echo({ contactedAt:'2026-10-12T08:00:01+00:00', messages:[{ text:'old', id:'e1' }, { text:'Stage changed', id:'e2' }] })]
    .map(row => { sb.settleLocalWrites('contacts', 's1', row, lead); return sb.sameLiveRow(lead, row); });
  assertEqual([steps, sb.LOCAL_WRITES.has('contacts:s1')], [[true, true, true], false], 'settleLocalWrites: the three echoes of a move made here change nothing on screen, and nothing is left waiting');
  sb.noteLocalWrite('contacts', 's2', { status:'Quoted' });
  const other = { id:'s2', status:'Quoted', tags:[] }, theirs = { id:'s2', status:'Quoted', tags:['Complaint'] };
  sb.settleLocalWrites('contacts', 's2', theirs, other);
  assertEqual([sb.sameLiveRow(other, theirs), theirs.tags], [false, ['Complaint']], 'settleLocalWrites: someone else\'s change to another field still shows');
  sb.STATE.data.jobs = []; sb.JOB_CACHE.index = null;
  const c = { id:'m1', fullName:'Memo Person', status:'New' };
  const first = sb.leadStage(c); c.status = 'Chasing'; const second = sb.leadStage(c);
  sb.STATE.data.jobs.push({ id:'j1', contactId:'m1', customerName:'Memo Person', date:'2026-10-01' }); const third = sb.leadStage(c);
  c.status = 'Not Relevant'; sb.STATE.data.jobs = []; sb.JOB_CACHE.index = null; const fourth = sb.leadStage(c);
  assertEqual([first, second, third, fourth], ['New', 'Chasing', 'Won', 'Lost'], 'leadStage: the remembered stage follows a new status and a new job');
}

function testToastKinds(sb){
  console.log('\nThe kind of each message at the bottom of the screen');
  const k = sb.toastKind;
  assertEqual(['Note added', 'Shy Barnes → Chasing', 'Day finished. See you tomorrow!', 'Password reset email sent — check your inbox', 'Test sent to 2 devices'].map(k), ['ok', 'ok', 'ok', 'ok', 'ok'], 'toastKind: things that worked');
  assertEqual(['Could not save lead: timeout', 'Not saved: network', 'Not sent: unknown error', 'The bonus was not saved: x', 'Reminder not deleted: x', 'Not deleted (job): x', 'Lead created, but the link to the GHL archive was not saved: x'].map(k), ['error', 'error', 'error', 'error', 'error', 'error', 'error'], 'toastKind: things that failed');
  assertEqual(['Pick a day first', 'Hours must be between 0 and 24', 'Simon already has a job, so the lead stays Won', "They're all in Chasing already", 'Presentation mode is on, changes are not saved', 'Notifications were not allowed on this device. You can allow them in the phone settings.', 'Won is set automatically once the customer has a job in Jobs & Commissions', 'None of them has "Callback"'].map(k), ['warn', 'warn', 'warn', 'warn', 'warn', 'warn', 'warn', 'warn'], 'toastKind: things that need a look (read-only mode is not a failure)');
  assertEqual(['New text from Simon', 'Email to a@b.co goes from info@ within a minute', 'Uploading…'].map(k), ['info', 'info', 'info'], 'toastKind: news');
}

function testCatalog(sb){
  console.log('\nThe business\'s own lists (Settings, stage 2)');
  sb.STATE.data.jobs = []; sb.STATE.data.settings = { catalog: {} };
  sb.applyCatalog();
  const before = [sb.LEAD_DIVISIONS.slice(), sb.stageLabel('New'), sb.divLabel('Aircon'), sb.STAGES_NEED_DATE.slice(), sb.RULES.chaseDecideDays];
  assertEqual(before, [['Aircon', 'Chimney', 'Pressure Washing', 'Other'], 'New lead', 'Aircon', ['Quoted', 'Follow-up'], 21], 'applyCatalog: nothing saved = the lists the app ships with');
  sb.STATE.data.settings.catalog = {
    services: [{ key: 'Aircon', label: 'Air conditioning', color: '#16a34a', active: true, subs: ['Split System', 'Duct System'] }, { key: 'Solar', label: 'Solar', color: '#c99a06', active: true, subs: [] }, { key: 'Other', label: 'Other', color: null, active: false, subs: [] }],
    stages: [{ key: 'New', label: 'Fresh lead', color: '#d03b5c' }],
    tags: [{ tag: 'Complaint', hint: 'Complained', color: '#a5473f', active: false }],
    rules: { needDate: false, quoteIdleDays: 10, chaseDecideDays: 30 },
  };
  sb.applyCatalog();
  assertEqual(sb.LEAD_DIVISIONS.slice(), ['Aircon', 'Solar', 'Other', 'Chimney', 'Pressure Washing'], 'applyCatalog: the saved order, a new service, and the services it did not mention kept at the end');
  assertEqual([sb.divLabel('Aircon'), sb.divColor('Aircon'), sb.SUB_DIVISIONS.Aircon], ['Air conditioning', '#16a34a', ['Split System', 'Duct System']], 'applyCatalog: a service renamed and recoloured, its sub-services as saved');
  assertEqual([sb.activeOnly(sb.LEAD_DIVISIONS, sb.ACTIVE.divisions), sb.activeOnly(sb.LEAD_DIVISIONS, sb.ACTIVE.divisions, 'Other')], [['Aircon', 'Solar', 'Chimney', 'Pressure Washing'], ['Aircon', 'Solar', 'Other', 'Chimney', 'Pressure Washing']], 'activeOnly: a switched-off service leaves the forms, but a lead that has it still shows it');
  assertEqual([sb.stageLabel('New'), sb.stageColor('New'), sb.stageInk('New'), sb.LEAD_STATUSES.length, sb.leadStage({ id: 'x', fullName: 'X', status: 'New' })], ['Fresh lead', '#d03b5c', '#fff', 7, 'New'], 'applyCatalog: a stage renamed and recoloured keeps its key, so leads keep their stage');
  assertEqual([sb.ACTIVE.tags.has('Complaint'), sb.LEAD_TAGS.some(t => t.tag==='Complaint'), sb.tagColor('Complaint')], [false, true, '#a5473f'], 'applyCatalog: a switched-off tag stays on the leads that have it');
  assertEqual([sb.RULES.quoteIdleDays, sb.RULES.chaseDecideDays, sb.STAGES_NEED_DATE.slice()], [10, 30, []], 'applyCatalog: the pipeline rules');
  sb.STATE.data.settings.catalog = {};
  sb.applyCatalog();
  assertEqual([sb.LEAD_DIVISIONS.slice(), sb.divLabel('Aircon'), sb.divColor('Aircon'), sb.stageLabel('New'), sb.stageInk('New'), sb.STAGES_NEED_DATE.slice(), sb.RULES.chaseDecideDays], [['Aircon', 'Chimney', 'Pressure Washing', 'Other'], 'Aircon', 'var(--div-aircon)', 'New lead', '#1c1917', ['Quoted', 'Follow-up'], 21], 'applyCatalog: back to nothing saved = back to the app\'s own lists');
  assertEqual([sb.inkFor('#f2c94c'), sb.inkFor('#1f66c9')], ['#1c1917', '#fff'], 'inkFor: dark text on a light colour, white on a dark one');
}

// Look and branding (14 Oct): colour maths, the tokens made from two colours, the theme choice, names, logo, picker text.
function testBranding(sb){
  console.log('\nLook and branding + the colour picker (14 Oct)');
  assertEqual([sb.normHex('#ABC'), sb.normHex('c31f2b'), sb.normHex(' #C31F2B '), sb.normHex('red'), sb.normHex('#12345'), sb.normHex(''), sb.normHex(null)], ['#aabbcc', '#c31f2b', '#c31f2b', null, null, null, null], 'normHex: 3 or 6 digits, # optional, lowercase; anything else is not a colour');
  assertEqual([Math.round(sb.contrastRatio('#ffffff', '#000000') * 10) / 10, sb.contrastRatio('#777777', '#777777'), sb.contrastRatio('#1f66c9', '#f2f0eb')===sb.contrastRatio('#f2f0eb', '#1f66c9')], [21, 1, true], 'contrastRatio: white on black is 21, a colour on itself 1, either order the same');
  assertEqual([sb.hslHex(0, 0, 93), sb.hexHsl('#ff0000'), sb.rgbHex([300, -4, 15.6]), sb.mixHex('#ffffff', '#000000', .5)], ['#ededed', [0, 100, 50], '#ff0010', '#808080'], 'hsl: 93% grey is #ededed (0.93 × 255 = 237), pure red is 0° 100% 50%; rgbHex clamps and rounds; mixHex halfway');
  assertEqual([sb.bestInk('#f2c230'), sb.bestInk('#1f66c9'), sb.bestInk('#ffffff')], ['#1c1917', '#ffffff', '#1c1917'], 'bestInk: black on yellow and white, white on blue');
  // The text on a button is the better of the two inks; with only black and white the worst case (a mid-tone) is about 4.2.
  const inks = [];
  sb.SEC_SWATCHES.forEach(([c]) => ['light', 'dark'].forEach(mode => { const t = sb.brandTokens(null, c, mode), other = t['on-primary']==='#ffffff' ? '#1c1917' : '#ffffff';
    if (c===sb.BRAND_ORIGINAL || (sb.contrastRatio(t['on-primary'], t.primary) >= sb.contrastRatio(other, t.primary) && sb.contrastRatio(t['on-primary'], t.primary) >= 4.1)) return; inks.push(`${c} ${mode}`); }));
  assertEqual(inks, [], 'buttons: for every suggested buttons colour, in both modes, the button text is the more readable ink (at least 4.1 : 1)');
  const lifted = sb.liftColor('#ffff00', '#ffffff', 3);
  assertEqual([sb.contrastRatio(lifted, '#ffffff') >= 3, sb.liftColor('#1f66c9', '#ffffff', 3)], [true, '#1f66c9'], 'liftColor: a pale yellow is darkened until it stands out on white; a colour that already does is unchanged');
  // The original crimson gives exactly today's values.
  assertEqual(sb.brandSecTokens(sb.BRAND_ORIGINAL, 'light', sb.BRAND_BASE.light, false), { primary: '#c31f2b', 'primary-strong': '#8c1620', 'primary-soft': '#fbe4e2', 'on-primary': '#fff8f6', 'focus-ring': '0 0 0 3px rgba(195,31,43,.4)', 'sidebar-accent': '#e2454f', 'sidebar-bg-active': '#3c1015' }, 'brandSecTokens: the original crimson in light mode is the app as it ships');
  assertEqual(sb.brandSecTokens(sb.BRAND_ORIGINAL, 'dark', sb.BRAND_BASE.dark, false), { primary: '#e2555f', 'primary-strong': '#f0838a', 'primary-soft': '#3a1518', 'on-primary': '#1c0c0d', 'focus-ring': '0 0 0 3px rgba(226,85,95,.5)', 'sidebar-accent': '#e2454f', 'sidebar-bg-active': '#3c1015' }, 'brandSecTokens: the original crimson in dark mode is the app as it ships');
  const css = sb.brandCssText('#5b6b82', sb.BRAND_ORIGINAL);
  assertEqual([sb.brandCssText('', ''), sb.brandCssText(null, sb.BRAND_ORIGINAL), css.includes('--paper:'), css.includes('--sidebar-bg:'), css.includes(':root[data-theme="dark"]{'), css.includes('@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){')], ['', '', true, true, true, true], 'brandCssText: nothing chosen = no CSS at all; a background colour tints the page and the menu in both modes');
  const blue = sb.brandCssText(null, '#1f66c9');
  assertEqual([blue.includes('--primary:#1f66c9;'), blue.includes('--paper:'), blue.includes('--sidebar-bg:')], [true, false, false], 'brandCssText: only a buttons colour changes only the buttons tokens');
  assertEqual([sb.brandBgTokens(null, 'light'), sb.brandBgTokens('#ffffff', 'light').paper, sb.brandBgTokens('#ffffff', 'light').surface, sb.brandSideTokens(null)], [{}, '#ededed', '#ffffff', {}], 'background: none = nothing changes; white has no colour, so a plain grey page (93% = #ededed) with white cards');
  const menus = sb.BG_SWATCHES.filter(([c]) => c).map(([c, n]) => { const t = sb.brandSideTokens(c)['sidebar-bg']; return sb.relLum(t) < .02 && sb.contrastRatio('#ece9e2', t) >= 12 ? '' : n; }).filter(Boolean);
  assertEqual(menus, [], 'background: with every suggested background colour the side menu stays dark and its text easy to read');
  const tinted = sb.brandTokens('#5b6b82', '#f2c230', 'dark');
  assertEqual([tinted['sidebar-bg']===sb.brandSideTokens('#5b6b82')['sidebar-bg'], sb.contrastRatio(tinted['sidebar-accent'], tinted['sidebar-bg']) >= 3], [true, true], 'background + buttons: the line on the open menu item stays visible on the tinted menu');
  // The base tokens are the CSS's own :root values (a drift guard).
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const vars = block => { const o = {}; block.replace(/--([a-z0-9-]+):\s*([^;]+);/g, (m, k, v) => { o[k] = v.trim(); }); return o; };
  const lightCss = vars(html.match(/:root \{([\s\S]*?)\n\}/)[1]), darkCss = vars(html.match(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/)[1]);
  const keys = ['ink', 'paper', 'surface', 'surface-2', 'line', 'primary', 'primary-strong', 'primary-soft', 'on-primary', 'focus-ring', 'accent', 'good', 'bad'];
  assertEqual(keys.concat(['sidebar-bg', 'sidebar-bg-active', 'sidebar-accent', 'sidebar-line']).filter(k => sb.BRAND_BASE.light[k]!==lightCss[k]), [], 'BRAND_BASE.light matches the :root block of index.html');
  assertEqual(keys.filter(k => sb.BRAND_BASE.dark[k]!==darkCss[k]), [], 'BRAND_BASE.dark matches the :root[data-theme="dark"] block of index.html');
  const yellow = sb.brandChecks(sb.brandTokens(null, '#ffff00', 'light'), 'light'), orig = sb.brandChecks(sb.brandTokens(null, sb.BRAND_ORIGINAL, 'light'), 'light');
  assertEqual([yellow.find(c => c.label==='Buttons and selected chips').lv, orig.map(c => c.label), orig.every(c => c.lv==='good')], ['bad', ['Text on the buttons', 'Buttons and selected chips', 'Links', 'Line on the open menu item', 'The open menu item'], true], 'brandChecks: yellow almost disappears on white cards; the original crimson passes all 5 checks');
  // The theme: this device's choice, else the business default, else the device.
  assertEqual([sb.themeChoice(null, ''), sb.themeChoice(null, 'dark'), sb.themeChoice('light', 'dark'), sb.themeChoice('system', 'dark'), sb.themeChoice('bogus', 'light'), sb.themeChoice(null, 'bogus')], ['system', 'dark', 'light', 'system', 'light', 'system'], 'themeChoice: my own choice wins (Follow the device included), else the business default, else the device');
  assertEqual(sb.THEME_OPTS.map(x => x[0]), ['light', 'dark', 'system'], 'THEME_OPTS: one order everywhere');
  // Names and logo.
  assertEqual([sb.productName({}), sb.productName({ appName: '  Acme ' }), sb.productName(undefined)], ['OPS Service', 'Acme', 'OPS Service'], 'productName: OPS Service unless an app name is set');
  sb.STATE.data.settings = { companyName: 'X Pty' };
  const named = sb.brandName();
  sb.STATE.data.settings = {};
  assertEqual([named, sb.brandName()], ['X Pty', 'The Guys Service Group'], 'brandName: the business\'s trading name, for the menu');
  const up = 'https://abc.supabase.co/storage/v1/object/public/branding/logo-1.png';
  assertEqual([sb.brandLogoKind({}), sb.brandLogoKind({ logo: '' }), sb.brandLogoKind({ logo: 'ops-mark' }), sb.brandLogoKind({ logo: up }), sb.brandLogoKind({ logo: 'https://evil.com/x.png' })],
    [{ kind: 'legacy', src: 'logo.png' }, { kind: 'legacy', src: 'logo.png' }, { kind: 'mark' }, { kind: 'upload', src: up }, { kind: 'legacy', src: 'logo.png' }], 'brandLogoKind: nothing = logo.png (as before), the OPS mark, an upload only from the branding bucket');
  assertEqual([sb.brandLogoFile({}), sb.brandLogoFile({ logo: 'ops-mark' }), sb.brandLogoFile({ logo: up })], ['logo.png', sb.BRAND_MARK_NAME, 'logo-1.png'], 'brandLogoFile: the name shown next to the logo');
  assertEqual([sb.joinLinkText('Ron Cruz', 'L', 'join', 'OPS Service'), sb.joinLinkText('Ron Cruz', 'L', 'password', 'OPS Service')], ['Hi Ron, here is your link to join the OPS Service app: L', 'Hi Ron, here is a link to set a new password for the OPS Service app: L'], 'joinLinkText: the product name in the join and new-password messages');
  // The picker's "Chosen:" line.
  const P = sb.palChosenHtml;
  assertEqual([P('sec', '#c31f2b', sb.SEC_SWATCHES), P('sec', '#123456', sb.SEC_SWATCHES), P('bg', null, sb.BG_SWATCHES), P('bg', '#5b6b82', sb.BG_SWATCHES), P('tag', null, sb.CAT_PALETTE), P('cat', null, sb.CAT_PALETTE), P('tag', '#1f66c9', sb.CAT_PALETTE, true), P('sec', '#123456', [['#123456', '<b>']])],
    ['Chosen: <b>Original crimson</b>', 'Chosen: <b>Your own colour #123456</b>', 'Chosen: <b>Original stone</b>: the app as it is today', 'Chosen: <b>Slate</b>: a light tint in light mode, a deep shade in dark mode', 'Chosen: <b>Default</b>: follows the buttons colour', 'Chosen: <b>Default</b>', '<b>Blue</b>', 'Chosen: <b>&lt;b&gt;</b>'], 'palChosenHtml: a named colour, your own colour, the defaults, a peek, and a name escaped');
  const lists = [].concat(sb.SEC_SWATCHES, sb.BG_SWATCHES.filter(([c]) => c), sb.CAT_PALETTE).filter(([c]) => sb.normHex(c)!==c).map(x => x[1]);
  assertEqual([lists, sb.BG_SWATCHES[0], sb.CAT_SWATCHES], [[], [null, 'Original stone'], ['#1f66c9', '#2b6cc4', '#0e8a8a', '#16a34a', '#c99a06', '#c4580f', '#d03b5c', '#7746c9', '#a5473f', '#776e64']], 'swatches: every suggested colour is a clean code; CAT_SWATCHES (the automatic colour of new rows) is unchanged');
}

// Message templates (Settings, 12 Oct): the app's originals are the server functions' own words, letter for letter,
// and the preview fills blanks exactly as the server does.
// Google review rules as settings (13 Oct): nothing saved = the original rules; saved ones are used and checked.
function testReviewSettings(sb){
  console.log('\nGoogle review rules (Settings)');
  sb.STATE.data.settings = { catalog: {} };
  const c0 = sb.reviewCfg();
  assertEqual([c0.sendFrom, c0.sendUntil, c0.morning, c0.askAgainMonths, c0.remindAfterDays, c0.remindWithinDays], [8, 20, 10, 6, 1, 14], 'reviews: no settings = the original rules');
  assertEqual(sb.reviewLinkFor('Chimney').result, 'Enjoy your clean, safe fireplace!', 'reviews: the original thank-you line');
  const job = { invoiceNumber: '2701', date: '2026-10-01' }, today = '2026-10-10';
  const sent = d => ({ status: 'sent', sent_at: d + 'T01:00:00Z', ask_count: 1 });
  assertEqual([sb.reviewNeed(job, sent('2026-10-09'), today, false), sb.reviewNeed(job, sent('2026-10-10'), today, false), sb.reviewNeed(job, sent('2026-09-25'), today, false)], ['again', null, null], 'reviews: reminder from 1 day, until 14 days (original)');
  assertEqual([sb.reviewLinkFor('Ducted aircon').result, sb.reviewLinkFor('Roof cleaning').result, sb.reviewLinkFor('Gutters').link], ['Enjoy the fresh, clean air!', 'Enjoy your fresh, clean outdoor area!', ''], 'reviews: a new service gets the original that the server would use');
  sb.STATE.data.settings = { catalog: { reviews: { remindAfterDays: 3, remindWithinDays: 30, sendFrom: 9, sendUntil: 7, links: { Chimney: { link: 'https://g.page/r/x/review', result: '' } } } } };
  assertEqual([sb.reviewNeed(job, sent('2026-10-09'), today, false), sb.reviewNeed(job, sent('2026-10-07'), today, false), sb.reviewNeed(job, sent('2026-09-15'), today, false)], [null, 'again', 'again'], 'reviews: reminder from 3 days until 30 when set');
  const c1 = sb.reviewCfg();
  assertEqual([c1.sendFrom, c1.sendUntil, sb.reviewLinkFor('Chimney').link, sb.reviewLinkFor('Chimney').result], [8, 20, 'https://g.page/r/x/review', 'Enjoy your clean, safe fireplace!'], 'reviews: impossible hours fall back; a saved link with an empty line keeps the original line');
}
// One "Ask automatically" switch (13 Oct): the Closings "Don't ask" box only while it is on, and the Reviews page's
// preview of the request is the service's own link and line in the Message templates words.
function testReviewPreview(sb){
  console.log('\nGoogle reviews: one switch and the message preview');
  assertEqual([sb.closingShowsNoAsk('owner', true), sb.closingShowsNoAsk('va', true), sb.closingShowsNoAsk('manager', true), sb.closingShowsNoAsk('technician', true), sb.closingShowsNoAsk('owner', false), sb.closingShowsNoAsk('owner', undefined)],
    [true, true, true, false, false, false], 'reviews: the Closings "Don\'t ask" box shows only while asking is automatic, never for a technician');
  sb.STATE.data.settings = { reviewRequestsAuto: true };
  const on = sb.reviewAutoOn();
  sb.STATE.data.settings = {};
  assertEqual([on, sb.reviewAutoOn()], [true, false], 'reviews: the switch is review_requests_auto');
  sb.STATE.data.settings = { catalog: {} };
  const a = sb.reviewPreviewValues('Aircon'), g = sb.reviewPreviewValues('Gutters');
  assertEqual([a.hasLink, a.vars.first_name, a.vars.technician, a.vars.today, a.vars.result, a.vars.review_link], [true, 'Sarah', 'Guy', ' today', 'Enjoy the fresh, clean air!', 'https://search.google.com/local/writereview?placeid=ChIJx33jOtfwSSgRs09ybCNrVbU'], 'reviews preview: nothing saved = the original aircon link and line');
  assertEqual([g.hasLink, g.vars.review_link], [false, ''], 'reviews preview: a service without a link can\'t be asked');
  const chimney = { Chimney: { link: 'https://g.page/r/x/review', result: 'Warm and safe!' } };
  sb.STATE.data.settings = { catalog: { reviews: { links: chimney } } };
  const c = sb.reviewPreviewValues('Chimney');
  assertEqual([c.vars.result, c.vars.review_link, sb.reviewPreviewValues('Pressure Washing').vars.result], ['Warm and safe!', 'https://g.page/r/x/review', 'Enjoy your fresh, clean outdoor area!'], 'reviews preview: the saved link and line; nothing saved = the original');
  const mT = sb.MSG_TEMPLATES.find(m => m.id==='reviewText'), mE = sb.MSG_TEMPLATES.find(m => m.id==='reviewEmail');
  const VT = { reviewSms: sb.msgTemplateText('reviewSms') }, VE = { reviewEmailSubject: sb.msgTemplateText('reviewEmailSubject'), reviewEmailBody: sb.msgTemplateText('reviewEmailBody') };
  assertEqual(sb.tplPreviewHtml(mT, VT, c.vars).includes('<div class="tpl-bubble">Hi Sarah, Guy from The Guys Service Group here - thanks for having us today! Warm and safe! Our team works really hard and would truly appreciate a quick Google review: https://g.page/r/x/review Thank you!</div>'), true, 'reviews preview: the text with the service\'s link and line');
  const mail = sb.tplPreviewHtml(mE, VE, c.vars);
  assertEqual([mail.includes('<span>Subject</span>A quick favour, Sarah?'), mail.includes('Warm and safe!'), mail.includes('tpl-mail-btn')], [true, true, true], 'reviews preview: the email with the subject, the line and the button');
  assertEqual([sb.tplPreviewHtml(mT, VT) === sb.tplPreviewHtml(mT, VT, sb.TPL_EXAMPLE), sb.tplPreviewHtml(mE, VE) === sb.tplPreviewHtml(mE, VE, sb.TPL_EXAMPLE)], [true, true], 'reviews preview: Message templates (no details given) still shows the example');
  sb.STATE.data.settings = { catalog: { reviews: { links: chimney }, templates: { reviewSms: 'Thanks {first_name}! {result} {review_link}' } } };
  assertEqual(sb.tplPreviewHtml(mT, { reviewSms: sb.msgTemplateText('reviewSms') }, sb.reviewPreviewValues('Chimney').vars).includes('Thanks Sarah! Warm and safe! https://g.page/r/x/review'), true, 'reviews preview: edited words from Message templates are used');
  // A waiting automatic request skipped because the switch went off is the office's to ask (the server's own reason).
  const fn = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'review-requests', 'index.ts'), 'utf8');
  const offReason = fn.match(/const AUTO_OFF_REASON = "(.*)";/)[1];
  const j = { id: 'j', invoiceNumber: '2500', date: '2026-10-05' }, r = { status: 'skipped', reason: offReason };
  assertEqual([offReason, sb.reviewNeed(j, r, '2026-10-06', true), sb.reviewNeed(j, r, '2026-10-06', false)], ['automatic asking is off', 'ask', 'ask'], 'reviews: skipped because the switch went off → the office asks');
  sb.STATE.data.settings = { gstRatePercent: 10 };
}
function testMessageTemplates(sb){
  console.log('\nMessage templates (Settings, stage 3b)');
  const fnSrc = f => fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', f, 'index.ts'), 'utf8');
  const constOf = (src, name) => JSON.parse(src.match(new RegExp(`^const ${name} = (".*");$`, 'm'))[1]);
  const orig = key => sb.MSG_TEMPLATES.flatMap(m => m.fields).find(f => f.key===key).text;
  const voice = fnSrc('voice'), conv = fnSrc('conversations');
  assertEqual([orig('missedCall'), orig('missedCallClosed')], [constOf(voice, 'SMS_MISSED'), constOf(voice, 'SMS_CLOSED')], 'templates: missed-call originals are the voice function\'s words');
  assertEqual([orig('phoneGreeting'), orig('phoneClosed'), orig('phoneMissed')], [constOf(voice, 'NOTICE'), constOf(voice, 'CLOSED'), constOf(voice, 'MISSED')], 'templates: spoken phone originals are the voice function\'s words');
  assertEqual([orig('chatOpen'), orig('chatClosed'), orig('chatIntro')], [constOf(conv, 'SMS_OPEN'), constOf(conv, 'SMS_CLOSED'), constOf(conv, 'INTRO')], 'templates: chat originals are the conversations function\'s words');
  const V = { hi: 'Hi Sarah', first_name: 'Sarah', technician: 'Guy', result: 'Enjoy the fresh, clean air!', review_link: 'https://g.page/r/x/review', today: ' today' };
  assertEqual(sb.fillTemplate(orig('reviewSms'), V), "Hi Sarah, Guy from The Guys Service Group here - thanks for having us today! Enjoy the fresh, clean air! Our team works really hard and would truly appreciate a quick Google review: https://g.page/r/x/review Thank you!", 'templates: review text original fills to the approved text');
  assertEqual([sb.fillTemplate(orig('reviewEmailSubject'), V), sb.fillTemplate(orig('reviewEmailSubject'), { ...V, first_name: '' }), sb.fillTemplate('Hi {first_name}, {x}', { first_name: '' })],
    ['A quick favour, Sarah?', 'A quick favour?', 'Hi, {x}'], 'templates: an empty blank takes its comma; an unknown blank stays');
  sb.STATE.data.settings = { catalog: { templates: { missedCall: 'Edited words', chatOpen: '   ' } } };
  assertEqual([sb.msgTemplateText('missedCall'), sb.msgTemplateText('chatOpen'), sb.msgTemplateText('chatIntro')], ['Edited words', orig('chatOpen'), orig('chatIntro')], 'templates: saved words win; blank or none = the original');
  assertEqual([sb.smsParts('a'.repeat(160)), sb.smsParts('a'.repeat(161)), sb.smsParts('It\u2019s ' + 'a'.repeat(70)), sb.smsParts('[]')],
    [{ chars: 160, parts: 1, unicode: false }, { chars: 161, parts: 2, unicode: false }, { chars: 75, parts: 2, unicode: true }, { chars: 4, parts: 1, unicode: false }], 'templates: texts counted like the phone networks do (curly quote → 70 a text)');
  const m = id => sb.MSG_TEMPLATES.find(x => x.id===id);
  assertEqual([sb.templateProblems(m('reviewText'), { reviewSms: orig('reviewSms') }).length, sb.templateProblems(m('reviewText'), { reviewSms: 'Thanks {first_name}!' }).length,
    sb.templateProblems(m('missedCall'), { missedCall: 'Hi {first_name}' }).length, sb.templateProblems(m('chatOpen'), { chatOpen: ' ' }).length],
    [0, 1, 1, 1], 'templates: the original saves; no review link, a blank it can\'t fill, or empty words are stopped');
}
function testOrganicBoard(sb){
  console.log('\nOrganic board (13 Oct)');
  const fn = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'ingest-ads-stats', 'index.ts'), 'utf8');
  const table = JSON.parse(fn.match(/const t: \[number, number\]\[\] = (\[.*?\]);/)[1]);
  assertEqual(sb.ORG_CTR, table, 'organic: the usual click rate by position is the same table as the nightly rules');
  assertEqual([sb.orgExpectedCtr(1), sb.orgExpectedCtr(13.8), sb.orgExpectedCtr(30)], [0.25, 0.012, 0.004], 'organic: usual click rate by position');
  assertEqual(sb.ORG_CLEAN_FROM, fn.match(/ORGANIC_CLEAN_FROM = "([\d-]+)"/)[1], 'organic: the app and the nightly digest use the same "comparable from" day');
  assertEqual([sb.orgPath('https://theguyservicegroup.com/services/air-conditioning-cleaning'), sb.orgPath('/x/?a=1')], ['/services/air-conditioning-cleaning/', '/x/'], 'organic: pages compare by path');
  assertEqual(sb.orgWindow('28d', '2026-10-12'), { start:'2026-09-15', end:'2026-10-12', prevStart:'2026-08-18', prevEnd:'2026-09-14' }, 'organic: a 28-day window and the 28 days before');
  assertEqual(sb.orgWindow('7d', '2026-10-12'), { start:'2026-10-06', end:'2026-10-12', prevStart:'2026-09-29', prevEnd:'2026-10-05' }, 'organic: a 7-day window and the 7 days before');
  const contacts = [
    { id:'a', source:'Organic', createdAt:'2026-10-10T02:00:00Z', division:'Aircon' },
    { id:'b', source:'Google Maps', subSource:'Chimney profile', createdAt:'2026-10-01T02:00:00Z', division:'Chimney' },
    { id:'c', source:'Google Ads', createdAt:'2026-10-02T02:00:00Z', division:'Aircon' },
    { id:'d', source:'Google Maps', subSource:'', createdAt:'2026-09-01T02:00:00Z', division:'Aircon' } ];
  const jobs = [{ id:1, contactId:'b', amount:400 }, { id:2, contactId:'c', amount:300 }, { id:3, contactId:'b', amount:100 }];
  const st = sb.orgLeadStats(contacts, jobs, '2026-09-15', '2026-10-12', j => contacts.find(c => c.id===j.contactId));
  assertEqual([st.leads.map(c => c.id), st.web, st.maps, st.jobs.length, st.revenue, st.groups.map(g => [g.key, g.leads.length, g.jobs.length, g.revenue]), st.services.map(g => [g.key, g.leads.length])],
    [['a','b'], 1, 1, 2, 500, [['Organic web', 1, 0, 0], ['Google Maps · Chimney profile', 1, 2, 500]], [['Aircon', 1], ['Chimney', 1]]], 'organic: leads from Organic web and Google Maps in the window, their jobs and revenue, by profile and service (Google Ads leads and older leads left out)');
  assertEqual(sb.orgEvidenceText({ window:'28 days', impressions:2000, ctr_pct:0.2, note:'', named_instead:['A Grade','Coolguys'], competitors:[{ name:'Eco Aircon', reviews:181 }] }), 'Period: 28 days · Shown: 2,000 · Click rate %: 0.2 · Named instead: A Grade, Coolguys · Competitors: Eco Aircon 181', 'organic: the evidence line, in words');
}
function testPeopleContractorsEquipment(sb){
  console.log('\nPeople, Contractors, Equipment (13 Oct)');
  // People: one card per person, the employee card and the login merged by Jobs & Commissions name or full name.
  const employees = [{ id:'e1', name:'Guy', roles:['Technician','Sales'], status:'Active' }, { id:'e2', name:'Dolev', roles:['Technician'], status:'Inactive' }, { id:'e3', name:'Ofek', roles:['Owner','Technician'], status:'Active' }, { id:'e4', name:'Ron', roles:['VA'], status:'Active' }];
  const profiles = [{ id:'p1', fullName:'Guy Galili', role:'technician', technicianName:'Guy' }, { id:'p2', fullName:'Ofek', role:'owner', technicianName:'Ofek' }, { id:'p3', fullName:'Manuel Baez', role:'marketing', technicianName:'' }, { id:'p4', fullName:'Ron', role:'va', technicianName:'' }];
  const L = sb.peopleList(employees, profiles);
  assertEqual(L.map(x => [x.key, x.name, x.prof ? x.prof.id : null]), [['e:e1','Guy Galili','p1'], ['e:e2','Dolev',null], ['e:e3','Ofek','p2'], ['e:e4','Ron','p4'], ['p:p3','Manuel Baez','p3']], 'people: employee and login merged (by Jobs name or full name); a login with no card and a card with no login each get a card');
  const g = f => L.filter(x => sb.personInGroup(x, f)).map(x => x.key);
  assertEqual([g('active').length, g('tech'), g('office'), g('owners'), g('inactive')], [4, ['e:e1','e:e3'], ['e:e4','p:p3'], ['e:e3'], ['e:e2']], 'people: the filters (office = VA and Marketing, as in the approved mockup: a technician who also sells is not office; not active only under Not active)');
  const mgr = sb.peopleList([{ id:'m1', name:'Mia', roles:['Manager'], status:'Active' }], [{ id:'pm', fullName:'Max', role:'manager' }]);
  assertEqual(mgr.map(x => sb.personInGroup(x, 'office')), [false, false], 'people: a manager is not under Office (the approved mockup leaves managers out)');
  // An owner login no employee card is joined to (the names differ) still has a place for the weekly wage (P: owner salary).
  const loose = sb.peopleList([{ id:'n1', name:'Noam', roles:['Owner','Technician'], status:'Active' }, { id:'e9', name:'Guy', roles:['Technician'], status:'Active' }],
    [{ id:'pn', fullName:'Noam Gal', role:'owner', technicianName:'' }, { id:'po', fullName:'Ofek', role:'owner' }, { id:'pg', fullName:'Guy', role:'technician' }, { id:'pk', fullName:'Kim', role:'va' }]);
  assertEqual([sb.ownerLoginsWithoutCard(loose).map(p => p.id), sb.ownerLoginsWithoutCard([]), sb.ownerLoginsWithoutCard(null), sb.personPayKind(loose[0])], [['pn', 'po'], [], [], 'ownerNoLogin'], 'people: owner logins with no card joined (their wage is set from their own card or an unjoined owner card)');
  // Contractors: the deal line, the agreement text and when it is out of date.
  const c = { id:'s1', name:'Spark <Line> Electrical', contactPerson:'Jake', services:['Electrical'], paymentTerms:'7 days', deal:{ type:'commission', amount:10, note:'Only jobs we pass on.' } };
  assertEqual([sb.contractorDealLine(c), sb.contractorDealLine({ ...c, deal:{ type:'fixed', amount:50 } }), sb.contractorDealLine({ ...c, deal:{ type:'other', note:'A swap of jobs.' } }), sb.contractorDealLine({ ...c, deal:{ type:'commission', amount:null } })],
    ['We get 10% of every job we pass to Spark <Line> Electrical.', 'We get $50 for every job we pass to Spark <Line> Electrical.', 'A swap of jobs.', 'Nothing agreed yet.'], 'contractors: what we agreed, in one sentence');
  const html = sb.contractorAgreementHtml(c, { abn:'51 824 753 556' });
  assertEqual([html.includes('Spark &lt;Line&gt; Electrical'), html.includes('<Line>'), html.includes('<mark>10%</mark> of the job price before GST, within <mark>7 days</mark>'), html.includes('ABN <mark>51 824 753 556</mark>'), html.includes('Also agreed: <mark>Only jobs we pass on.</mark>'), (html.match(/<h4>/g) || []).length],
    [true, false, true, true, true, 9], 'contractors: the agreement is filled in (escaped), with the money clause, the ABN and the note; 9 sections');
  const noAmt = { ...c, deal:{ type:'commission', amount:'', note:'10% of the first job only.' } }, h2 = sb.contractorAgreementHtml(noAmt, {});
  assertEqual([sb.contractorDealLine(noAmt), sb.contractorDealNote(noAmt), sb.contractorDealNote(c), h2.includes('Also agreed'), (h2.match(/10% of the first job only\./g) || []).length, sb.contractorDealAmount({ type:'fixed', amount:'abc' }), sb.contractorDealAmount({ type:'other', amount:5 })],
    ['10% of the first job only.', '', 'Only jobs we pass on.', false, 1, null, null], 'contractors: with no amount the note is the deal, shown once (not again as "also agreed")');
  assertEqual([{}, { agreement:{} }, { agreement:{ html:'x', state:'ready' } }, { agreement:{ html:'x', state:'opened' } }, { agreement:{ html:'x', state:'signed' } }, { agreement:{ html:'x' } }].map(sb.contractorStatusFromPrivate),
    ['none', 'none', 'ready', 'opened', 'signed', 'ready'], 'contractors: the card status comes from the private agreement when the two differ');
  const k = sb.contractorAgreementInputs(c, { abn:'1' });
  assertEqual([k===sb.contractorAgreementInputs({ ...c }, { abn:'1' }), k===sb.contractorAgreementInputs({ ...c, deal:{ ...c.deal, amount:12 } }, { abn:'1' }), k===sb.contractorAgreementInputs(c, { abn:'2' }), k===sb.contractorAgreementInputs({ ...c, phone:'0412' }, { abn:'1' })],
    [true, false, false, true], 'contractors: the agreement goes out of date when the deal or the ABN changes, not the phone');
  assertEqual(k===sb.contractorAgreementInputs({ ...c, deal:{ note:'Only jobs we pass on.', type:'commission', amount:10 } }, { abn:'1' }), true, 'contractors: the same deal read back from the database (keys in another order) is not a change');
  // Equipment: the categories (nothing saved = four), an old "Consumable" item belongs to "Consumables".
  sb.STATE.data.settings = { catalog: {} };
  assertEqual(sb.equipmentCategories().map(x => x.name), ['Tools','Chemicals','Consumables','Safety gear'], 'equipment: the default categories');
  sb.STATE.data.settings = { catalog: { equipmentCategories: [{ name:' Pumps ', color:'#123456' }, { name:'' }, { name:'Hoses', color:'red' }] } };
  assertEqual(sb.equipmentCategories(), [{ name:'Pumps', color:'#123456' }, { name:'Hoses', color:'#776e64' }], 'equipment: saved categories (blank dropped, a bad colour replaced)');
  assertEqual([sb.equipmentCategoryOf({ category:'Consumable' }), sb.equipmentCategoryOf({ category:'Tools' }), sb.equipmentCategoryOf({})], ['Consumables', 'Tools', ''], 'equipment: an old Consumable item counts as Consumables');
  sb.STATE.data.settings = { gstRatePercent: 10 };
}
function testPaySettings(sb){
  console.log('\nPay settings (Settings, 13 Oct)');
  const log = (date, hours, n) => ({ date, hours, bookingsAircon: n, bookingsChimney: 0, bookingsPw: 0 });
  sb.STATE.data.settings = { catalog: {} };
  assertEqual([sb.salesLogPay(log('2026-10-01', 8, 9)), sb.bookingBonus(5, '2026-10-01'), sb.jobTypesForTech('Alessandro'), sb.payHebrewNames().Guy], [95, 10, ['Pressure Washing'], 'גיא'], 'pay: nothing saved = $10/hour, the original bonus, job types and Hebrew names');
  sb.STATE.data.settings = { catalog: { pay: { hourly: [{ from: '2026-10-13', rate: 12, tiers: [{ min: 6, bonus: 20 }, { min: 10, bonus: 40 }] }],
    hebrew: { Dolev: 'דולב' }, jobTypes: { Guy: ['Aircon'], Omri: ['Nope'] } } } };
  assertEqual([sb.salesLogPay(log('2026-10-12', 8, 9)), sb.salesLogPay(log('2026-10-13', 8, 9)), sb.salesLogPay(log('2026-10-14', 8, 5)), sb.salesLogPay(log('2026-10-14', 8, 12))], [95, 116, 96, 136], 'pay: a new rate and bonus count from their day on; the days before keep the old ones');
  assertEqual([sb.nextBookingTier(7, '2026-10-14'), sb.nextBookingTier(3, '2026-10-01')], [{ needed: 3, bonus: 40 }, { needed: 2, bonus: 10 }], 'pay: the next bonus follows the day\'s tiers');
  assertEqual([!!sb.payHebrewNames().Guy, sb.payHebrewNames().Dolev], [false, 'דולב'], 'pay: the saved Hebrew list replaces the original one');
  assertEqual([sb.jobTypesForTech('Guy'), sb.jobTypesForTech('Omri'), sb.jobTypesForTech('Someone new')], [['Aircon'], ['Aircon', 'Chimney', 'Other'], ['Aircon', 'Chimney', 'Pressure Washing', 'Other']], 'pay: saved job types win; an unusable list keeps the original');
  sb.STATE.data.settings = { catalog: { pay: { hourly: [{ from: '2026-10-13', rate: 'x', tiers: [] }] } } };
  assertEqual([sb.salesLogPay(log('2026-10-14', 8, 12)), sb.payTiersOk([{ min: 5, bonus: 10 }, { min: 5, bonus: 20 }, { min: 0, bonus: 5 }])], [80, [{ min: 5, bonus: 10 }]], 'pay: a bad rate keeps $10; no tiers = no bonus; duplicate or zero tiers are dropped');
  sb.STATE.data.settings = { gstRatePercent: 10 };
}
function testPhoneSettings(sb){
  console.log('\nPhone settings (Settings, 13 Oct)');
  assertEqual(sb.phoneMenuText(sb.phoneMenuOf({})), 'For air conditioning, press 1. For chimney, press 2. For pressure washing, press 3.', 'phone: nothing saved = the original menu, word for word');
  assertEqual(sb.phoneMenuOf({ menu: [{ key: 'Chimney', say: ' chimney sweeping ' }, { key: '', say: 'x' }, { key: 'Aircon' }] }), [{ key: 'Chimney', say: 'chimney sweeping' }], 'phone: a saved menu keeps only rows with a service and words');
  assertEqual(sb.phoneMenuOf({ menu: Array.from({ length: 12 }, (_, i) => ({ key: 'S' + i, say: 's' + i })) }).length, 9, 'phone: at most 9 services (one key each)');
  assertEqual([sb.phoneRingSeconds(30), sb.phoneRingSeconds(3), sb.phoneRingSeconds(300), sb.phoneRingSeconds('x')], [30, 20, 20, 20], 'phone: ring times 5–60 seconds, otherwise 20 (as the voice function)');
  assertEqual([sb.phoneE164('0412 345 678'), sb.phoneE164('1300 380 090'), sb.phoneE164('+611300380090'), sb.phoneE164('12')], ['+61412345678', '+611300380090', '+611300380090', ''], 'phone: numbers read like the voice function');
  assertEqual([sb.phonePretty('+611300380090'), sb.phonePretty('0412345678'), sb.phonePretty('+61298765432')], ['1300 380 090', '0412 345 678', '02 9876 5432'], 'phone: numbers shown the usual way');
  const voice = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'voice', 'index.ts'), 'utf8');
  const def = JSON.parse(voice.match(/^const DEFAULT_MENU = (\[.*\]);$/m)[1].replace(/(\w+):/g, '"$1":'));
  assertEqual(sb.PHONE_MENU_DEFAULT, def, 'phone: the app and the voice function start from the same menu');
  // Backup hours per weekday (Ofek 13 Oct), read with the voice function's rules (backupDay).
  const D = (on, from, to) => ({ on, from, to }), all = x => [0, 1, 2, 3, 4, 5, 6].map(() => x);
  assertEqual(Object.values(sb.phoneBackupHours({}).days), all(D(true, '08:00', '20:00')), 'phone backup: nothing saved = every day 08:00–20:00, as the voice function');
  assertEqual(Object.values(sb.phoneBackupHours({ backupHours: { from: '09:00', to: '17:00', days: [1, 2, 3, 4, 5] } }).days), [D(false, '09:00', '17:00'), D(true, '09:00', '17:00'), D(true, '09:00', '17:00'), D(true, '09:00', '17:00'), D(true, '09:00', '17:00'), D(true, '09:00', '17:00'), D(false, '09:00', '17:00')], 'phone backup: the old shape is read day by day');
  assertEqual([Object.values(sb.phoneBackupHours({ backupHours: { from: '08:00', to: '20:00', days: [] } }).days).map(x => x.on), Object.values(sb.phoneBackupHours({ backupHours: { from: '08:00', to: '20:00' } }).days).map(x => x.on)], [all(false), all(false)], 'phone backup: as before, no days ticked = no backup');
  const nd = sb.phoneBackupHours({ backupHours: { days: { 6: { on: false }, 1: { from: '07:00' } } } }).days;
  assertEqual([nd[6], nd[1], nd[3]], [D(false, '08:00', '20:00'), D(true, '07:00', '20:00'), D(true, '08:00', '20:00')], 'phone backup: per day, a missing day or field takes the default');
  const a = sb.phoneBackupHours({ backupHours: { from: '09:00', to: '17:00', days: [1] } });
  assertEqual(sb.phoneBackupHours(JSON.parse(JSON.stringify({ backupHours: a }))), a, 'phone backup: saved per day and read back the same (string keys from JSON too)');
  const R0 = { backupHours: { from: '09:00', to: '17:00', days: [1] } }, before = JSON.stringify(R0); sb.phoneBackupHours(R0);
  assertEqual(JSON.stringify(R0), before, 'phone backup: reading never changes the saved settings');
  assertEqual(Object.values(sb.phoneBackupHours({ backupHours: 'x' }).days).map(x => x.on), all(false), 'phone backup: odd data = no backup, as the voice function');
  // A day only counts with both times set and the end after the start (backupDay in the voice function); an empty time
  // must not pass (null < 1200 is true in JS).
  assertEqual([D(true, '08:00', '20:00'), D(true, '', '20:00'), D(true, '09:00', ''), D(true, '', ''), D(true, '20:00', '08:00'), D(true, '09:00', '09:00'), D(true, 'x', '20:00'), null].map(sb.phoneBackupDayOk),
    [true, false, false, false, false, false, false, false], 'phoneBackupDayOk: both times real, end after start');
  const half = sb.phoneBackupHours({ backupHours: { days: [1, 2, 3] } }).days[1];
  assertEqual([half, sb.phoneBackupDayOk(half)], [D(true, '', ''), false], 'phoneBackupDayOk: an old saved range with no times is not a usable day');
  // Which backup phone is the signed-in owner or manager (the sidebar switch).
  const R = { people: { ofek: { name: 'Ofek', mobile: '+61418638552', available: true }, noam: { name: 'Noam', mobile: '0407 735 994', available: true } } };
  const profiles = [{ id: 'o', fullName: 'Ofek Shamir', role: 'owner' }, { id: 'n', fullName: 'Noam Gal', role: 'owner' }, { id: 'r', fullName: 'Ron', role: 'va' }];
  const pk = (p, r = R, emps = [], profs = profiles) => sb.phonePersonKeyFor(r, p, emps, profs);
  assertEqual([pk(profiles[1]), pk(profiles[0]), pk({ id: 'x', fullName: 'Ofek', role: 'manager' })], ['noam', 'ofek', 'ofek'], 'phone switch: an owner or manager is found by name');
  assertEqual([pk(profiles[2]), pk({ id: 'y', fullName: 'Ofek', role: 'va' }), pk({ id: 'd', fullName: 'Dana Levi', role: 'manager' }), pk(null), sb.phonePersonKeyFor(undefined, profiles[0], [], profiles)], [null, null, null, null, null], 'phone switch: nobody else, and no guess');
  const R2 = { people: { boss: { name: 'The boss', mobile: '0412 345 678' } } }, dana = { id: 'd', fullName: 'Dana Levi', role: 'manager' };
  assertEqual([pk(dana, R2, [{ name: 'Dana Levi', phone: '+61412345678' }], [dana]), pk(dana, R2, [{ name: 'Dana Levi', phone: '0499 999 999' }], [dana])], ['boss', null], 'phone switch: else by the mobile on their employee card');
  const R3 = { people: { a: { name: 'Noam Gal' }, b: { name: 'Noam Cohen' } } };
  assertEqual([pk({ id: 'n', fullName: 'Noam', role: 'owner' }, R3, [], []), pk({ id: 'n2', fullName: 'noam  COHEN', role: 'owner' }, R3, [], [])], [null, 'b'], 'phone switch: two backup phones with the first name = no switch; the full name still matches');
  const twins = [{ id: '1', fullName: 'Noam Gal', role: 'owner' }, { id: '2', fullName: 'Noam Levi', role: 'manager' }], R4 = { people: { noam: { name: 'Noam' } } };
  assertEqual([pk(twins[0], R4, [], twins), pk(twins[1], R4, [], twins)], [null, null], 'phone switch: two owners/managers with the same first name = no switch');
  // The first name alone only matches a backup phone named with just that first name, and only when no other person of
  // any role (profile or employee card) has that first name.
  const omri = { id: 'm', fullName: 'Omri Cohen', role: 'manager' }, R5 = { people: { noam: { name: 'Noam Gal' }, omri: { name: 'Omri Levi' } } };
  assertEqual(pk(omri, R5, [], [omri]), null, 'phone switch: "Omri Levi" (someone else) never matches Omri Cohen');
  const R6 = { people: { omri: { name: 'Omri' } } };
  assertEqual([pk(omri, R6, [], [omri]), pk(omri, R6, [], [omri, { id: 't', fullName: 'Omri Levi', role: 'technician' }]), pk(omri, R6, [{ name: 'Omri Levi' }], [omri]), pk(omri, R6, [{ name: 'Omri Cohen' }], [omri])],
    ['omri', null, null, 'omri'], 'phone switch: "Omri" matches only when no technician, VA or employee is also called Omri (their own card is fine)');
  const solo = { id: 'n', fullName: 'Noam Gal', role: 'owner' };
  assertEqual(pk(solo, { people: { noam: { mobile: '0407735994' } } }, [], [solo]), 'noam', 'phone switch: a backup phone with no name goes by its key');
  // The business number is never written into the page (it's SaaS): it comes from the settings.
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const fnText = name => { const i = html.indexOf(`function ${name}(`); return i < 0 ? '' : html.slice(i, html.indexOf('\n}\n', i)); };
  assertEqual([fnText('renderPhoneSettings').includes("'Who answers the business phone'"), fnText('renderPhoneSettings').includes('1300 380 090'), fnText('setPhoneCallerId').includes('1300 380 090'), fnText('setPhoneCallerId').length > 0], [true, false, false, true], 'phone: the business number comes from the settings, never written in');
}
function testOfficeHours(sb){
  console.log('\nOffice hours and days off (Settings, stage 3)');
  sb.STATE.data.jobs = []; sb.STATE.data.settings = { catalog: { hours: { days: { 6: { on: true, from: '09:00', to: '13:00' } }, nsw: true, extra: [{ date: '2026-10-20', name: 'Team day' }] } } };
  sb.applyCatalog();
  assertEqual([sb.isWorkday('2026-10-10'), sb.officeHoursFor('2026-10-10'), sb.isWorkday('2026-10-05'), sb.isWorkday('2026-10-20'), sb.officeHoursText()],
    [true, { from: 540, to: 780 }, false, false, 'Mon–Fri 8:00–17:00, Sat 9:00–13:00'], 'office hours: Saturday mornings on, Labour Day (NSW) and an own day off closed');
  // Friday 9 Oct 16:50 Sydney (05:50 UTC): 10 working minutes left that day, the other 20 on Saturday from 9:00
  assertEqual(sb.workClockDue('2026-10-09T05:50:00Z', 30), { day: '2026-10-10', mins: 560 }, 'workClockDue: runs on into Saturday\'s hours');
  // Friday 15:30 Sydney + 3 hours is after closing: the next office morning is Saturday 9:00
  assertEqual(sb.chaseAlertDue('2026-10-09T04:30:00Z'), { day: '2026-10-10', mins: 540 }, 'chaseAlertDue: the next office morning, Saturday');
  sb.STATE.data.settings.catalog = {};
  sb.applyCatalog();
  assertEqual([sb.isWorkday('2026-10-10'), sb.isWorkday('2026-10-05'), sb.workClockDue('2026-10-09T05:50:00Z', 30), sb.officeHoursText()],
    [false, true, { day: '2026-10-12', mins: 500 }, 'Mon–Fri 8:00–17:00'], 'office hours: nothing saved = Monday to Friday 8–17 and no days off, as before');
}

function testChaseCountSetting(sb){
  console.log('\nChasing calls: office days only, or every day (Settings → Pipeline, 13 Oct)');
  sb.STATE.data.jobs = []; sb.STATE.data.settings = { catalog: {} }; sb.applyCatalog();
  // Lead in Mon 21 Sep; called Mon 21, Sat 26 and Mon 28; it is Mon 28 Sep, 12:00 Sydney.
  const lead = { createdAt: '2026-09-21', chaseCalls: ['2026-09-21', '2026-09-26', '2026-09-28'] }, mon = new Date('2026-09-28T02:00:00Z');
  assertEqual([sb.RULES.chaseOfficeDays, sb.chaseCounter(lead, mon)], [true, { x: 2, y: 6, calledToday: true }], 'chaseCounter: office days: Sat 26 not counted, 6 workdays 21–25 + 28');
  sb.STATE.data.settings.catalog = { rules: { chaseDecideDays: 30 } }; sb.applyCatalog();
  assertEqual([sb.RULES.chaseOfficeDays, sb.catalogRules().chaseOfficeDays, sb.chaseCounter(lead, mon)], [true, true, { x: 2, y: 6, calledToday: true }], 'chaseCounter: rules saved before the switch existed still count office days only');
  sb.STATE.data.settings.catalog = { rules: { chaseOfficeDays: false } }; sb.applyCatalog();
  assertEqual([sb.RULES.chaseOfficeDays, sb.chaseCounter(lead, mon)], [false, { x: 3, y: 8, calledToday: true }], 'chaseCounter: switched off: 21..28 = 8 days, Saturday\'s call counts');
  // 'Decide after 21 days' stays calendar days either way: 7 Sep → 28 Sep = 21 days, 8 Sep → 20.
  const tooLong = () => [sb.chaseTooLong({ id:'t', fullName:'T', status:'Chasing', chasingSince:'2026-09-07', createdAt:'2026-09-07' }, mon), sb.chaseTooLong({ id:'t2', fullName:'T2', status:'Chasing', chasingSince:'2026-09-08', createdAt:'2026-09-08' }, mon)];
  assertEqual(tooLong(), [true, false], 'chaseTooLong: switch off: still 21 calendar days');
  sb.STATE.data.settings.catalog = { rules: { chaseOfficeDays: true } }; sb.applyCatalog();
  assertEqual(tooLong(), [true, false], 'chaseTooLong: switch on: the same 21 calendar days');
  sb.STATE.data.settings.catalog = {}; sb.applyCatalog();
  assertEqual(sb.RULES.chaseOfficeDays, true, 'chaseCounter: nothing saved = office days only, as before');
}

function testLostReasonDelete(sb){
  console.log('\nLost reasons can be deleted (13 Oct)');
  sb.STATE.data.jobs = [];
  sb.STATE.data.settings = { catalog: { lostReasons: [{ key:'noAnswer', label:'No answer', active:true }, { key:'spam', label:'Spam', active:true, deleted:true, deletedAt:'2026-10-14T00:00:00Z' }, { key:'rabc', label:'Went with a friend', active:true }] } };
  sb.applyCatalog();
  assertEqual(sb.LOST_REASONS.map(r => r.key), ['noAnswer', 'spam', 'rabc', 'outsideArea', 'wrongNumber', 'wrongDetails', 'tooExpensive', 'notInterested'], 'LOST_REASONS: a deleted reason is kept (for history); built-ins missing from the saved list come back at the end, as before');
  assertEqual([sb.ACTIVE.lost.has('spam'), sb.ACTIVE.lost.has('rabc'), sb.ACTIVE.lost.has('outsideArea')], [false, true, true], 'ACTIVE.lost: a deleted reason is not offered');
  assertEqual(sb.catalogShown('lostReasons').map(x => x.key), ['noAnswer', 'rabc', 'outsideArea', 'wrongNumber', 'wrongDetails', 'tooExpensive', 'notInterested'], 'catalogShown: Settings does not list a deleted reason');
  assertEqual([sb.lostReasonLabel('spam'), sb.lostReasonLabel('noAnswer'), sb.lostReasonLabel('rabc'), sb.lostReasonLabel('zzz')], ['Spam (deleted reason)', 'No answer', 'Went with a friend', 'No reason given'], 'lostReasonLabel: a deleted reason keeps its name, with a note');
  assertEqual([sb.lostReasonOf({ lostReason:'spam' }), sb.lostReasonOf({ lostReason:'rabc' }), sb.lostReasonOf({ tags:['SPAM lead'] }), sb.lostReasonOf({ tags:['not interested - price'] })], ['spam', 'rabc', 'spam', 'tooExpensive'], 'lostReasonOf: a deleted built-in still classifies old GHL tags');
  // Dashboard: A and C were spam (C by its old tag), B went with a friend.
  sb.STATE.data.contacts = [
    { fullName:'A', status:'Lost', lostReason:'spam', createdAt:'2026-10-02', source:'Organic', division:'Aircon' },
    { fullName:'B', status:'Lost', lostReason:'rabc', createdAt:'2026-10-03', source:'Organic', division:'Aircon' },
    { fullName:'C', status:'Lost', tags:['spam lead'], createdAt:'2026-10-04', source:'Organic', division:'Aircon' } ];
  sb.JOB_CACHE.index = null;
  const reasons = () => sb.computeBusinessPerformance(sb.STATE.data, '2026-10-01', '2026-10-31').lossReasons;
  assertEqual(reasons(), { noReason:0, noAnswer:0, spam:2, rabc:1, outsideArea:0, wrongNumber:0, wrongDetails:0, tooExpensive:0, notInterested:0 }, 'Dashboard: leads with a deleted reason still count under it');
  sb.STATE.data.settings.catalog.lostReasons.push({ key:'rnew', label:'Booked elsewhere', active:true });
  sb.applyCatalog();
  const r2 = reasons();
  assertEqual([r2.rnew, r2.spam], [0, 2], 'Dashboard: a new reason is there straight after the save, with no reload');
  sb.LOST_REASONS.splice(sb.LOST_REASONS.findIndex(r => r.key==='tooExpensive'), 1);
  assertEqual(sb.lostReasonOf({ tags:['price'] }), 'noReason', 'lostReasonOf: a reason missing from the list does not throw');
  sb.applyCatalog();
  assertEqual([sb.lostReasonCanDelete([{ key:'a', active:true }, { key:'b', active:false }, { key:'c', active:true, deleted:true }], 'a'), sb.lostReasonCanDelete([{ key:'a', active:true }, { key:'d', active:true }], 'a')],
    [false, true], 'lostReasonCanDelete: the last reason switched on cannot be deleted');
  const found = sb.catalogFindByName(sb.catalogList('lostReasons'), ' spam ');
  assertEqual([found && found.key, found && found.deleted, sb.catalogFindByName(sb.catalogList('lostReasons'), ''), sb.catalogFindByName(sb.catalogList('lostReasons'), 'nothing like it')],
    ['spam', true, null, null], 'catalogFindByName: finds a deleted reason by name (so adding it again brings it back)');
  sb.STATE.data.settings.catalog = { lostReasons: [{ key:'noAnswer', label:'No answer', active:false }] };
  sb.applyCatalog();
  assertEqual([sb.LOST_REASONS.length, sb.LOST_REASONS.every(r => r.deleted===false), sb.ACTIVE.lost.has('noAnswer'), sb.ACTIVE.lost.size], [7, true, false, 6], 'lost reasons saved before delete existed read as before');
  sb.STATE.data.settings.catalog = {};
  sb.applyCatalog();
  assertEqual([sb.LOST_REASONS.map(r => r.label), sb.ACTIVE.lost.size], [['No answer', 'Outside service area', 'Spam', 'Wrong number', 'Wrong details', 'Too expensive', 'Not interested'], 7], 'lost reasons: nothing saved = the 7 shipped ones');
  assertEqual(sb.toastKind('At least one reason must be switched on: a lost lead always needs one'), 'warn', 'the "last reason" message is a warning');
}

function testPipelineStages(sb){
  console.log('\nPipeline stages: add, delete, switch off (13 Oct, item 17 + P7)');
  sb.STATE.data.jobs = [{ id:'j1', customerName:'Zed', contactId:'c-won', date:'2026-10-01' }];
  sb.STATE.data.settings = { catalog: { stages: [{ key:'Chasing', label:'Chasing', color:null, active:false }, { key:'sx1', label:'Site visit', color:'#7746c9', active:true }] } };
  sb.JOB_CACHE.index = null;
  sb.applyCatalog();
  assertEqual(sb.LEAD_STATUSES.slice(), ['Chasing', 'sx1', 'New', 'Quoted', 'Follow-up', 'Booked', 'Won', 'Lost'], 'applyCatalog: the saved order first, then the built-in stages it did not mention (a switched-off one stays in the list)');
  assertEqual(sb.LEAD_STAGE_PICKABLE.slice(), ['Chasing', 'sx1', 'New', 'Quoted', 'Follow-up', 'Booked', 'Lost'], 'LEAD_STAGE_PICKABLE: every stage but Won');
  assertEqual([sb.stageLabel('sx1'), sb.stageColor('sx1'), sb.stageInk('sx1')], ['Site visit', '#7746c9', '#fff'], 'a custom stage: its name, colour and text colour');
  assertEqual([sb.stageOn('Chasing'), sb.stageOn('sx1'), sb.stageOn('New'), sb.stageOn('Quoted')], [false, true, true, true], 'stageOn: Chasing switched off, the others on');
  assertEqual([sb.leadStage({ id:'h', fullName:'H', status:'Chasing' }), sb.leadStage({ id:'k', fullName:'K', status:'sx1' }), sb.leadStage({ id:'d', fullName:'D', status:'sGONE' })], ['Chasing', 'sx1', 'New'], 'leadStage: a lead keeps a switched-off stage, reads a custom one, and a deleted custom stage reads as New');
  assertEqual(sb.stagesPickable(), ['sx1', 'New', 'Quoted', 'Follow-up', 'Booked', 'Lost'], 'stagesPickable: the menus leave out a switched-off stage');
  assertEqual(sb.stagesPickable('Chasing'), ['Chasing', 'sx1', 'New', 'Quoted', 'Follow-up', 'Booked', 'Lost'], 'stagesPickable: but a lead still in it sees its own stage');
  assertEqual(sb.stagesShown({}), ['sx1', 'New', 'Quoted', 'Follow-up', 'Booked', 'Won', 'Lost'], 'stagesShown: an empty switched-off stage has no column');
  assertEqual(sb.stagesShown({ Chasing: 2 }), ['Chasing', 'sx1', 'New', 'Quoted', 'Follow-up', 'Booked', 'Won', 'Lost'], 'stagesShown: one with leads keeps its column, so no lead is hidden');
  assertEqual(sb.stagesInProgress(), ['Chasing', 'sx1', 'Quoted', 'Follow-up', 'Booked'], 'stagesInProgress: every stage but New, Won and Lost, custom ones included');
  assertEqual([sb.stageIsBuiltin('Chasing'), sb.stageIsBuiltin('Won'), sb.stageIsBuiltin('sx1')], [true, true, false], 'stageIsBuiltin');
  const contacts = [{ id:'a', fullName:'A', status:'sx1' }, { id:'c-won', fullName:'B', status:'sx1' }, { id:'c', fullName:'C', status:'New' }];
  assertEqual(sb.stageLeadsIn(contacts, 'sx1').map(c => c.id), ['a'], 'stageLeadsIn: a lead with a job is Won, not in the stage');
  assertEqual([sb.stageStoredOnly(contacts, 'sx1').map(c => c.id), sb.stageStoredOnly(contacts, 'New'), sb.stageStoredOnly(null, 'sx1')], [['c-won'], [], []], 'stageStoredOnly: the Won-by-job lead that still stores the stage (moved even when the stage has no lead)');
  assertEqual(sb.stageMovePlan(contacts.filter(c => c.id==='c-won'), 'sx1', 'New', {}, 'T', '2026-10-14'), [{ id:'c-won', patch:{ status:'New' }, quiet:true }], 'stageMovePlan: an empty stage: its stored-only lead moves to New quietly');
  const before = JSON.stringify(contacts);
  assertEqual(sb.stageMovePlan(contacts, 'sx1', 'Chasing', {}, 'T', '2026-10-14'),
    [{ id:'a', patch:{ status:'Chasing', stageChangedAt:'T', chasingSince:'T', chaseAlertDone:false, chaseRound:1, lostReason:'' }, quiet:false }, { id:'c-won', patch:{ status:'Chasing' }, quiet:true }],
    'stageMovePlan: to Chasing starts the counter; a Won lead only gets its stored value moved, quietly');
  assertEqual(JSON.stringify(contacts), before, 'stageMovePlan: the leads themselves are not changed');
  assertEqual(sb.stageMovePlan([{ id:'a', fullName:'A', status:'sx1', nextFollowUp:'2026-10-20' }], 'sx1', 'Lost', { lostReason:'tooExpensive' }, 'T', '2026-10-14')[0].patch,
    { status:'Lost', stageChangedAt:'T', nextFollowUp:'', lostReason:'tooExpensive' }, 'stageMovePlan: to Lost clears the follow-up date and keeps the reason');
  assertEqual(sb.stageMovePlan([{ id:'a', fullName:'A', status:'sx1' }, { id:'b', fullName:'B2', status:'sx1', bookedFor:'2026-10-18' }], 'sx1', 'Booked', { bookedFor:'2026-10-20' }, 'T', '2026-10-14').map(p => p.patch),
    [{ status:'Booked', stageChangedAt:'T', nextFollowUp:'', lostReason:'', bookedFor:'2026-10-20' }, { status:'Booked', stageChangedAt:'T', nextFollowUp:'', lostReason:'' }], 'stageMovePlan: to Booked: an existing booked day is kept');
  // Lost can't be switched off, even when saved off; nor can New or Won.
  sb.STATE.data.settings.catalog = { stages: [{ key:'New', active:false }, { key:'Won', active:false }, { key:'Lost', active:false }, { key:'Quoted', active:false }] };
  sb.applyCatalog();
  assertEqual([sb.stageOn('New'), sb.stageOn('Won'), sb.stageOn('Lost'), sb.stageOn('Quoted')], [true, true, true, false], 'New, Won and Lost are always on, even when saved off');
  // Saved before stages could be switched off: everything on.
  sb.STATE.data.settings.catalog = { stages: [{ key:'New', label:'Fresh lead', color:'#d03b5c' }] };
  sb.applyCatalog();
  assertEqual([sb.LEAD_STATUSES.length, sb.LEAD_STATUSES.every(sb.stageOn), sb.stageLabel('New')], [7, true, 'Fresh lead'], 'stages saved in the old shape (no on/off) are all on');
  sb.STATE.data.settings.catalog = {};
  sb.applyCatalog();
  assertEqual(sb.LEAD_STATUSES.every(sb.stageOn), true, 'nothing saved: every stage on');
  sb.JOB_CACHE.index = null;
  assertEqual(sb.stageMovePlan([{ id:'a', fullName:'A', status:'Quoted', nextFollowUp:'2026-10-30' }, { id:'b', fullName:'B2', status:'Quoted', nextFollowUp:'2026-10-01' }], 'Quoted', 'Follow-up', { nextFollowUp:'2026-10-21' }, 'T', '2026-10-14').map(p => p.patch),
    [{ status:'Follow-up', stageChangedAt:'T', lostReason:'' }, { status:'Follow-up', stageChangedAt:'T', lostReason:'', nextFollowUp:'2026-10-21' }], 'stageMovePlan: to Follow up: a later date is kept, a past one gets the new day');
  const list = sb.catalogList('stages'), added = sb.stageListWithNew(list, 'Site visit', 1000);
  assertEqual(added.map(x => x.key), ['New', 'Chasing', 'Quoted', 'Follow-up', 'Booked', 'srs', 'Won', 'Lost'], 'stageListWithNew: a new stage goes before Won and Lost, with a made-up key');
  assertEqual([added[5], list.length], [{ key:'srs', label:'Site visit', color:'#7746c9', active:true }, 7], 'stageListWithNew: its name and colour; the list it was given is not changed');
  assertEqual(sb.stageListWithNew([{ key:'New' }], 'X', 1000).map(x => x.key), ['New', 'srs'], 'stageListWithNew: at the end when there is no Won or Lost');
  assertEqual([sb.STAGE_RULE_TEXT('New'), sb.STAGE_RULE_TEXT('Won'), sb.STAGE_RULE_TEXT('sx9')], ['Always on: every new lead lands here', 'Always on: set automatically when the lead has a job', 'Your own stage: no automatic rules'], 'STAGE_RULE_TEXT: the always-on stages and a custom one');
  assertEqual([/decide after 21 days/.test(sb.STAGE_RULE_TEXT('Chasing')), /office days/.test(sb.STAGE_RULE_TEXT('Chasing')), /Needs a follow-up date/.test(sb.STAGE_RULE_TEXT('Quoted'))], [true, true, true], 'STAGE_RULE_TEXT: Chasing and Quoted follow the rules');
  sb.STATE.data.settings.catalog = { rules: { needDate: false, chaseOfficeDays: false } };
  sb.applyCatalog();
  assertEqual([/Needs a follow-up date/.test(sb.STAGE_RULE_TEXT('Quoted')), /every day/.test(sb.STAGE_RULE_TEXT('Chasing'))], [false, true], 'STAGE_RULE_TEXT: with the date rule off, Quoted no longer says it needs one; Chasing says every day');
  sb.STATE.data.settings.catalog = {};
  sb.applyCatalog();
  assertEqual([sb.LEAD_STATUSES.length, sb.ACTIVE.stages.size], [7, 7], 'back to nothing saved: the 7 shipped stages, all on');
}

function testConnectedSources(sb){
  console.log('\nConnected lead sources (13 Oct)');
  assertEqual([sb.sourceHost('ChatGPT'), sb.sourceHost('Chat GPT'), sb.sourceHost('Perplexity AI'), sb.sourceHost('Bing Copilot'), sb.sourceHost('Local Newsletter')],
    ['chatgpt.com', 'chatgpt.com', 'perplexity.ai', 'copilot.microsoft.com', 'localnewsletter'], 'sourceHost: known AI sites by name; anything else becomes its own utm value');
  const g = sb.sourceSetupSteps('ChatGPT');
  assertEqual([g.length, g[0].includes('utm_source=chatgpt.com'), g[0].includes('chatgpt.com as the site'), g[2].includes('"ChatGPT"'), g[3].includes('?utm_source=chatgpt.com')], [4, true, true, true, true], 'sourceSetupSteps: the four steps for ChatGPT');
  assertEqual(sb.sourceSetupSteps('Car Magnet')[0].startsWith('Links you share for Car Magnet need "utm_source=carmagnet"'), true, 'sourceSetupSteps: an unknown source gets a tagged link');
  assertEqual([sb.sourceLeadStats('ChatGPT', [{ source:'ChatGPT', createdAt:'2026-10-02' }, { source:'ChatGPT', createdAt:'2026-10-09', messages:[{ at:'2026-10-10' }] }, { source:'Organic', createdAt:'2026-10-11' }]), sb.sourceLeadStats('ChatGPT', [])],
    [{ count:2, last:'2026-10-10' }, { count:0, last:'' }], 'sourceLeadStats: its leads and the day the last one arrived');
  sb.STATE.data.jobs = [];
  sb.STATE.data.settings = { catalog: { sources: [{ key:'ChatGPT', label:'ChatGPT', color:'#1f66c9', active:true, subs:[], kind:'connected' }] } };
  sb.applyCatalog();
  const src = sb.catalogList('sources');
  assertEqual([sb.LEAD_SOURCES.includes('ChatGPT'), src.find(x => x.key==='ChatGPT').kind, src.filter(x => x.key!=='ChatGPT').every(x => x.kind===undefined)], [true, 'connected', true], 'sources: a connected source is saved with kind; the built-in ones have none (manual)');
  sb.STATE.data.settings.catalog = {};
  sb.applyCatalog();
}

function testEmployeeCard(sb){
  console.log('\nThe employee card: ABN check, document expiry, missing details, reminders');
  assertEqual(['51 824 753 556', '51824753556', '51824753557', '1234', ''].map(sb.abnValid), [true, true, false, false, false], 'abnValid: the ATO check (a one-digit typo fails)');
  const today = '2026-10-10';
  const x = d => { const r = sb.employeeDocExpiry(d, today); return r && [r.tone, r.days]; };
  assertEqual([x({ expiry:'2026-10-01' }), x({ expiry:'2026-10-10' }), x({ expiry:'2026-11-09' }), x({ expiry:'2026-11-10' }), x({ file:'doc:a' }), x(null)],
    [['bad', -9], ['warn', 0], ['warn', 30], ['good', 31], null, null], 'employeeDocExpiry: expired, due within 30 days, fine after that, nothing without a date');
  const guy = { name:'Guy', status:'Active', roles:['Technician'], employmentType:'Freelance-commission', abn:'', bankBsb:'062-000', bankAccount:'', documents:{}, emergencyName:'', emergencyPhone:'' };
  assertEqual(sb.employeeMissing(guy), ['ABN', 'bank', 'licence', 'emergency contact'], 'employeeMissing: a commission technician needs an ABN, bank, licence and emergency contact');
  assertEqual(sb.employeeMissing({ ...guy, abn:'51824753556', bankAccount:'12345678', documents:{ license:{ file:'doc:x' } }, emergencyPhone:'0400' }), [], 'employeeMissing: nothing once they are in');
  assertEqual(sb.employeeMissing({ name:'Ron', status:'Active', roles:['VA'], employmentType:'Hourly', documents:{}, emergencyName:'Mum' }), [], 'employeeMissing: an hourly VA needs no ABN, bank or licence');
  assertEqual(sb.employeeMissing({ ...guy, status:'Inactive' }), [], 'employeeMissing: nothing is asked of someone inactive');
  Object.assign(sb.STATE.data, { jobs:[], contacts:[], equipmentSpend:[], quotes:[], manualReminders:[], dismissedReminders:['empdoc:e2:passport:2026-10-20'], readReminders:[],
    employees:[
      { id:'e1', name:'Guy', status:'Active', roles:['Technician'], documents:{ license:{ file:'doc:l', expiry:'2026-10-05' }, visa:{ expiry:'2026-11-01' }, passport:{ expiry:'2030-01-01' } } },
      { id:'e2', name:'Omri', status:'Active', roles:['Technician'], documents:{ passport:{ expiry:'2026-10-20' } } },
      { id:'e3', name:'Old', status:'Inactive', roles:[], documents:{ visa:{ expiry:'2026-10-01' } } } ] });
  sb.JOB_CACHE.index = null;
  const items = sb.computeReminders(sb.STATE.data, sb.parseLocalDate(today)).filter(it => it.type==='employee-doc');
  assertEqual(items.map(it => [it.title, it.severity]), [["Guy's driver licence has expired", 'bad'], ["Guy's visa expires in 22 days", 'warn']], 'computeReminders: expired and soon-to-expire documents of active people, not one that was dismissed, not an inactive person');
}

function testRegionAndWeeks(sb){
  console.log('\nRegion and format: weeks, financial year, date format (14 Oct)');
  // A NEW settings object every time: weekRulesNow() remembers the rules by the region object's identity.
  const setRegion = region => { sb.STATE.data.settings = { gstRatePercent: 10, catalog: region===undefined ? {} : { region } }; };
  // Nothing saved = Sunday → Saturday, exactly as before.
  setRegion();
  assertEqual(sb.weekRules(null), [{ weekStart:0, from:'' }], 'weekRules: nothing saved = Sunday since forever');
  assertEqual(sb.payrollWeekOf('2026-10-13'), { key:'2026-10-11', start:'2026-10-11', end:'2026-10-17' }, 'default: payrollWeekOf is Sunday → Saturday');
  assertEqual(sb.weekOf('2026-10-13').label, '11 Oct – 17 Oct', 'default: weekOf label');
  assertEqual([sb.shiftPayrollWeek('2026-10-11', 1), sb.shiftPayrollWeek('2026-10-11', -2)], ['2026-10-18', '2026-09-27'], 'default: shiftPayrollWeek steps 7 days');
  assertEqual(sb.weekBounds('2026-10-13').days, 7, 'default: a week has 7 days');
  assertEqual([sb.weekDaysName('2026-10-13'), sb.weekDaysName('2026-10-13', ' → '), sb.weekStartDay('2026-10-13'), sb.weekOneOff('2026-10-13')], ['Sunday to Saturday', 'Sunday → Saturday', 0, ''], 'default: the week is named Sunday to Saturday, not a one-off');
  // Bad saved data is ignored; two changes from the same day = the last one.
  assertEqual(sb.weekRules({ weeks:[{ weekStart:7, from:'2026-10-18' }, { weekStart:'1', from:'2026-10-18' }, { weekStart:2, from:'x' }, null, { weekStart:3, from:'2026-11-01' }, { weekStart:4, from:'2026-11-01' }] }),
    [{ weekStart:0, from:'' }, { weekStart:4, from:'2026-11-01' }], 'weekRules: bad entries ignored, the last change of a day wins');

  // Monday from Sunday 18 Oct: one long 8-day week (18–25 Oct), then Monday → Sunday. Past weeks untouched (P6).
  setRegion({ weeks:[{ weekStart:1, from:'2026-10-18' }] });
  assertEqual(sb.payrollWeekOf('2026-09-19').start, '2026-09-13', 'Monday change: a week long before keeps its Sunday');
  assertEqual(sb.payrollWeekOf('2026-10-17'), { key:'2026-10-11', start:'2026-10-11', end:'2026-10-17' }, 'Monday change: the week before the change is untouched');
  assertEqual([sb.payrollWeekOf('2026-10-18'), sb.payrollWeekOf('2026-10-25')], [{ key:'2026-10-18', start:'2026-10-18', end:'2026-10-25' }, { key:'2026-10-18', start:'2026-10-18', end:'2026-10-25' }], 'Monday change: one 8-day transition week');
  assertEqual([sb.payrollWeekOf('2026-10-26').end, sb.payrollWeekOf('2026-11-02').start, sb.payrollWeekOf('2026-11-08').start], ['2026-11-01', '2026-11-02', '2026-11-02'], 'Monday change: then Monday → Sunday');
  assertEqual([sb.shiftPayrollWeek('2026-10-11', 1), sb.shiftPayrollWeek('2026-10-11', 2), sb.shiftPayrollWeek('2026-11-02', -2), sb.shiftPayrollWeek('2026-11-02', -3)],
    ['2026-10-18', '2026-10-26', '2026-10-18', '2026-10-11'], 'Monday change: shiftPayrollWeek walks real weeks (the long week is one step)');
  assertEqual([sb.weekStartDay('2026-10-17'), sb.weekStartDay('2026-10-18')], [0, 1], 'weekStartDay: by the rule in force that day');
  assertEqual([sb.weekDaysName('2026-10-26', ' → '), sb.weekDaysName('2026-10-20'), sb.weekDaysName('2026-10-17')], ['Monday → Sunday', 'Monday to Sunday', 'Sunday to Saturday'], 'weekDaysName: the rule in force, also during the 8-day transition week (not "Sunday to Sunday")');
  assertEqual([sb.weekOneOff('2026-10-20'), sb.weekOneOff('2026-10-25'), sb.weekOneOff('2026-10-26'), sb.weekOneOff('2026-10-17')], ['a one-off 8-day week (18 Oct – 25 Oct)', 'a one-off 8-day week (18 Oct – 25 Oct)', '', ''], 'weekOneOff: only the transition week is noted');
  // Thursday from Sunday 18 Oct: a short 4-day week (18–21 Oct) named by the new rule, not "Sunday to Wednesday".
  setRegion({ weeks:[{ weekStart:4, from:'2026-10-18' }] });
  assertEqual([sb.weekDaysName('2026-10-19'), sb.weekOneOff('2026-10-19'), sb.weekOneOff('2026-10-22')], ['Thursday to Wednesday', 'a one-off 4-day week (18 Oct – 21 Oct)', ''], 'weekDaysName / weekOneOff: a short transition week');
  setRegion({ weeks:[{ weekStart:1, from:'2026-10-18' }] });
  assertEqual(sb.weekKeysInRange('2026-10-01', '2026-11-03'), ['2026-09-27', '2026-10-04', '2026-10-11', '2026-10-18', '2026-10-26', '2026-11-02'], 'weekKeysInRange: every week, across the change');
  assertEqual(sb.weekOf('2026-10-20').label, '18 Oct – 25 Oct', 'weekOf: the transition week label');
  // Ron's hours over the 8-day week: both Sundays count.
  const h = sb.computePayrollHourly({ salesLogs:[{ person:'Ron', date:'2026-10-18', hours:8, bookingsAircon:0, bookingsChimney:0, bookingsPw:0 }, { person:'Ron', date:'2026-10-25', hours:8, bookingsAircon:0, bookingsChimney:0, bookingsPw:0 }] }, 'Ron', '2026-10-18');
  assertEqual([h.days.length, h.days[0].date, h.days[7].date, h.hours, h.total], [8, '2026-10-18', '2026-10-25', 16, 160], 'computePayrollHourly: every day of an 8-day week ($10 an hour)');
  // The week before a new week is the transition week, compared over the same number of days.
  const P = ui => { const p = sb.payrollPeriod(ui, '2026-11-05'); return [p.start, p.effEnd, p.prevStart, p.prevEnd]; };
  assertEqual(P({ mode:'week', week:'2026-10-26' }), ['2026-10-26', '2026-11-01', '2026-10-18', '2026-10-24'], 'payrollPeriod: previous week = the transition week, same 7 days');
  const D = r => { const x = sb.resolveDashboardRange({ range:r }, new Date(2026, 10, 4)); return [x.start, x.end, x.prevStart, x.prevEnd]; };
  assertEqual(D('week'), ['2026-11-02', '2026-11-08', '2026-10-26', '2026-10-28'], 'resolveDashboardRange: this week vs the same days of last week');
  assertEqual(D('lastWeek').slice(0, 2), ['2026-10-26', '2026-11-01'], 'resolveDashboardRange: last week');

  // Saturday from 18 Oct: one short 6-day week (18–23 Oct) that a +7 day step would have skipped.
  setRegion({ weeks:[{ weekStart:6, from:'2026-10-18' }] });
  assertEqual([sb.weekBounds('2026-10-20'), sb.weekBounds('2026-10-24')], [{ start:'2026-10-18', end:'2026-10-23', days:6 }, { start:'2026-10-24', end:'2026-10-30', days:7 }], 'Saturday change: one 6-day week, then Saturday → Friday');
  assertEqual(sb.weekKeysInRange('2026-10-17', '2026-10-31'), ['2026-10-11', '2026-10-18', '2026-10-24', '2026-10-31'], 'weekKeysInRange: the short week is not skipped');
  sb.STATE.data.equipmentSpend = []; sb.STATE.data.employees = [];
  sb.STATE.data.jobs = [{ date:'2026-10-20', amount:100, partsCost:0, commissionPercent:0, technician:'X', paymentStatus:'Paid' }];
  const pw = sb.computeProfitByWeekInRange(sb.STATE.data, '2026-10-17', '2026-10-31');
  assertEqual([pw.map(w => w.label), pw.map(w => w.revenue)], [['11 Oct – 17 Oct', '18 Oct – 23 Oct', '24 Oct – 30 Oct', '31 Oct – 6 Nov'], [0, 100, 0, 0]], 'computeProfitByWeekInRange: the short week has its own bar');
  sb.STATE.data.jobs = [];

  // Planning a change (P6): it starts the day after this week; a change not started yet is replaced or cancelled.
  const plan = (region, today, ws) => sb.weekChangePlan(region, today, ws);
  assertEqual(plan({}, '2026-10-13', 1), { weeks:[{ weekStart:1, from:'2026-10-18' }], from:'2026-10-18', first:{ start:'2026-10-18', end:'2026-10-25', days:8 } }, 'weekChangePlan: Monday from next week, one 8-day week');
  assertEqual([plan({}, '2026-10-13', 3).first, plan({}, '2026-10-13', 4).first.days, plan({}, '2026-10-13', 4).first.end, plan({}, '2026-10-13', 6).first.end, plan({}, '2026-10-13', 6).first.days],
    [{ start:'2026-10-18', end:'2026-10-27', days:10 }, 4, '2026-10-21', '2026-10-23', 6], 'weekChangePlan: the first week is 4 to 10 days, never 1 to 3');
  assertEqual([plan({}, '2026-10-13', 0), plan({}, '2026-10-13', 7), plan({}, '2026-10-13', 'x')], [null, null, null], 'weekChangePlan: the same day or a bad day = nothing to do');
  const pend = { weeks:[{ weekStart:1, from:'2026-10-18' }] };
  const p2 = plan(pend, '2026-10-13', 2);
  assertEqual([p2.weeks, p2.first.end, p2.first.days], [[{ weekStart:2, from:'2026-10-18' }], '2026-10-26', 9], 'weekChangePlan: a change not started yet is replaced');
  assertEqual([plan(pend, '2026-10-13', 0), plan(pend, '2026-10-13', 1)], [{ weeks:[], from:null, first:null }, null], 'weekChangePlan: picking the old day again cancels it; the same new day is nothing');
  const p3 = plan(pend, '2026-10-20', 3);
  assertEqual([p3.weeks, p3.first], [[{ weekStart:1, from:'2026-10-18' }, { weekStart:3, from:'2026-10-26' }], { start:'2026-10-26', end:'2026-11-03', days:9 }], 'weekChangePlan: during the transition week, the next change starts after it');
  assertEqual(plan(pend, '2026-10-20', 1), null, 'weekChangePlan: the day in force = nothing to do');

  // Financial year.
  assertEqual([sb.fyStartMonth({}), sb.fyStartMonth({ fyStart:13 }), sb.fyStartMonth({ fyStart:4 }), sb.fyStartMonth(null)], [7, 7, 4, 7], 'fyStartMonth: 1 July unless a month 1–12 is saved');
  assertEqual(sb.financialYearOf('2026-10-13', 7), { start:'2026-07-01', end:'2027-06-30', label:'FY 2026–27' }, 'financialYearOf: July year');
  assertEqual(sb.financialYearOf('2026-06-30', 7), { start:'2025-07-01', end:'2026-06-30', label:'FY 2025–26' }, 'financialYearOf: the last day of the year');
  assertEqual(sb.financialYearOf('2026-10-13', 1), { start:'2026-01-01', end:'2026-12-31', label:'FY 2026' }, 'financialYearOf: a calendar year');

  // Date format: full dates only; the default prints exactly as before.
  setRegion();
  assertEqual([sb.fmtDateYear('2026-10-05'), sb.fmtDateYear(''), sb.invDate('2026-09-05')], ['5 Oct 2026', '—', '5 Sep 2026'], 'date format default: unchanged');
  assertEqual(sb.fmtDateYear('2026-09-05'), new Date(2026, 8, 5).toLocaleDateString('en-AU', { day:'numeric', month:'short', year:'numeric' }), 'date format default: fmtDateYear is byte-identical to before');
  assertEqual([sb.dateFormatOf({ dateFormat:'yyyy-mm-dd' }), sb.dateFormatOf(null)], ['d mmm yyyy', 'd mmm yyyy'], 'dateFormatOf: an unknown format = the default');
  setRegion({ dateFormat:'dd/mm/yyyy' });
  assertEqual([sb.fmtDateYear('2026-10-05'), sb.invDate('2026-10-05'), sb.fmtDateShort('2026-10-05'), sb.fmtDateNumeric('2026-01-09')], ['05/10/2026', '05/10/2026', '5 Oct', '09/01/2026'], 'date format dd/mm/yyyy: full dates only; short dates stay');
  setRegion();
  assertEqual([sb.invWeek({ weekStart:'2026-10-04', weekEnd:'2026-10-10' }), sb.invWeek({ weekStart:'2026-10-18', weekEnd:'2026-10-25' }), sb.invWeek({ weekStart:'2026-10-26', weekEnd:'2026-11-01' })],
    ['Sun 4 Oct – Sat 10 Oct 2026', 'Sun 18 Oct – Sun 25 Oct 2026', 'Mon 26 Oct – Sun 1 Nov 2026'], 'invWeek: the real first and last day');
}

function testNotificationCards(sb){
  console.log('\nSettings → Notifications as cards (14 Oct)');
  assertEqual([0, 8, 11, 12, 13, 20, 23, 24].map(sb.hourLabel), ['12 am', '8 am', '11 am', '12 pm', '1 pm', '8 pm', '11 pm', 'midnight'], 'hourLabel: am / pm, noon, midnight');
  assertEqual(sb.NOTIFY_OFFICE_KINDS, ['newLead', 'leadWaiting', 'missedCall'], 'NOTIFY_OFFICE_KINDS: only these can go to the office');
  // notifyOn: off unless switched on; the invoice one on unless switched off; the business insurance follows the document switch.
  const on = sb.notifyOn;
  assertEqual(['newLead', 'leadWaiting', 'missedCall', 'unpaid', 'docExpiry', 'invoice', 'bizInsurance', 'googleReview'].map(k => on({}, k)),
    [false, false, false, false, false, true, false, false], 'notifyOn: nothing saved');
  assertEqual([on({ invoice: { on: false } }, 'invoice'), on({ invoice: { on: true } }, 'invoice'), on(undefined, 'invoice'), on(null, 'newLead')], [false, true, true, false], 'notifyOn: the invoice switch; nothing saved at all');
  assertEqual([on({ docExpiry: { on: true } }, 'bizInsurance'), on({ docExpiry: { on: false } }, 'bizInsurance'), on({ docExpiry: { on: true }, bizInsurance: { on: false } }, 'bizInsurance'), on({ docExpiry: { on: false }, bizInsurance: { on: true } }, 'bizInsurance'), on({ docExpiry: { on: true }, bizInsurance: { on: 'yes' } }, 'bizInsurance'), on({ docExpiry: { on: false }, bizInsurance: { office: true } }, 'bizInsurance')],
    [true, false, false, true, true, false], 'notifyOn: the business insurance follows the document switch until it has its own true / false');
  assertEqual(on({ googleReview: { on: true } }, 'googleReview'), false, 'notifyOn: a Google review cannot be on before its connector');
  // Who Owners and Office are, in words.
  const team = [{ role:'owner', fullName:'Ofek Shamir' }, { role:'owner', fullName:'Noam Gal' }, { role:'va', fullName:'Ron' }, { role:'manager', fullName:'Omri X' }, { role:'technician', fullName:'Guy' }];
  assertEqual(sb.notifyPeopleText(team), { owners:'Ofek and Noam', office:'Ron and any manager' }, 'notifyPeopleText: first names, the mockup\'s words');
  assertEqual(sb.notifyPeopleText(team.filter(p => p.role!=='va')).office, 'any manager', 'notifyPeopleText: no VA = any manager');
  assertEqual(sb.notifyPeopleText([{ role:'owner', fullName:'A x' }, { role:'owner', fullName:'B' }, { role:'owner', fullName:' C  y ' }]).owners, 'A, B and C', 'notifyPeopleText: three owners');
  assertEqual([sb.notifyPeopleText([]), sb.notifyPeopleText(undefined), sb.notifyPeopleText([{ role:'owner', fullName:'' }, { role:'va' }])], [{ owners:'the owners', office:'any manager' }, { owners:'the owners', office:'any manager' }, { owners:'the owners', office:'any manager' }], 'notifyPeopleText: nobody named');
  // The cards.
  const R = { waitMinutes: 15, from: 8, until: 20, docDays: 30, unpaidDays: 7 };
  const cards = sb.notifyCards({}, R, { phoneEnabled: false });
  assertEqual(cards.map(c => c.id), ['newLead', 'leadWaiting', 'missedCall', 'unpaid', 'invoice', 'docExpiry', 'bizInsurance', 'googleReview'], 'notifyCards: 8 cards in the mockup\'s order');
  // hand count: nothing saved = only the invoice one on (1 of 8); documents on = invoice, documents and insurance (3 of 8)
  assertEqual([cards.filter(c => c.on).map(c => c.id), sb.notifyCards({ docExpiry: { on: true } }, R, {}).filter(c => c.on).map(c => c.id)],
    [['invoice'], ['invoice', 'docExpiry', 'bizInsurance']], 'notifyCards: how many are on');
  const R2 = { waitMinutes: 45, from: 8, until: 20, docDays: 60, unpaidDays: 10 }, named = sb.notifyCards({}, R2, {});
  const nm = id => named.find(c => c.id===id).name;
  assertEqual([nm('leadWaiting'), nm('unpaid'), nm('docExpiry'), nm('bizInsurance')],
    ['A new lead nobody picked up for 45 minutes', 'A job is 10 days unpaid', 'An employee document expires within 60 days', 'Business insurance expires within 30 days'], 'notifyCards: the names carry the numbers; the insurance always 30');
  const N = { newLead: { on: true, office: true }, missedCall: { on: false, office: true }, unpaid: { on: true, office: true }, docExpiry: { on: true, office: true }, googleReview: { on: true, office: true } };
  const off = sb.notifyCards(N, R, {});
  assertEqual(off.filter(c => c.office).map(c => c.id), ['newLead', 'missedCall'], 'notifyCards: office only on cards that allow it (an unpaid job saved with office stays owners only), never on the locked one');
  assertEqual(off.filter(c => !c.officeOk).map(c => [c.id, c.only]), [['unpaid', 'money'], ['invoice', 'pay'], ['docExpiry', 'private details'], ['bizInsurance', 'business insurance']], 'notifyCards: owners-only cards say why');
  const g = off.find(c => c.id==='googleReview');
  assertEqual([g.locked, g.on, g.office, g.lockedLine, g.flags], [true, false, false, 'Turns on once Google Business Profile is connected.', [{ tone:'neutral', text:'Comes with the Google Business Profile connector' }]], 'notifyCards: the Google review card waits for its connector');
  const flags = (o, id) => sb.notifyCards({}, R, o).find(c => c.id===id).flags;
  assertEqual([flags({ phoneEnabled: false }, 'missedCall'), flags({ phoneEnabled: true }, 'missedCall'), flags(undefined, 'missedCall').length], [[{ tone:'warn', text:'Starts when the business phone is connected' }], [], 1], 'notifyCards: the missed-call card says the phone is not connected yet');
  assertEqual([flags({}, 'bizInsurance'), flags({}, 'newLead'), off.find(c => c.id==='newLead').locked, off.find(c => c.id==='leadWaiting').hasWhen], [[{ tone:'neutral', text:'New' }], [], false, 'leadWaiting'], 'notifyCards: the insurance card is new; the rest have defaults');
  // The insurance warns 30 days before, whatever the document days; other documents keep the passed / default window.
  const today = '2026-10-10';
  assertEqual([sb.employeeDocExpiry({ expiry:'2026-11-19' }, today, 30).tone, sb.employeeDocExpiry({ expiry:'2026-11-19' }, today, 60).tone, sb.employeeDocExpiry({ expiry:'2026-11-19' }, today).tone, sb.employeeDocExpiry({ expiry:'2026-11-09' }, today).tone],
    ['good', 'warn', 'good', 'warn'], 'employeeDocExpiry: 40 days out is fine at 30, due at 60; without a window it uses 30');
  assertEqual([sb.businessInsuranceStatus({ expiry:'2026-11-04' }, today).text, sb.businessInsuranceStatus({ expiry:'2026-11-14' }, today).text], ['Expires in 25 days', 'Valid until 14 Nov 2026'], 'businessInsuranceStatus: always 30 days');
  // Reminders follow the fixed 30 days too, even with other document days saved.
  sb.STATE.data = { jobs:[], contacts:[], equipmentSpend:[], quotes:[], manualReminders:[], employees:[], readReminders:[], dismissedReminders:[], settings: { gstRatePercent:10, catalog: { notify: { rules: { docDays: 60 } }, business: { insurance: { workers: { expiry:'2026-11-04' }, liability: { expiry:'2026-11-14' } } } } } };
  sb.JOB_CACHE.index = null;
  assertEqual(sb.computeReminders(sb.STATE.data, sb.parseLocalDate(today)).filter(it => it.type==='business-insurance').map(it => it.title), ['Workers compensation insurance expires in 25 days'], 'computeReminders: business insurance 25 days out is a reminder, 35 days out is not');
}

function testBusinessDetails(sb){
  console.log('\nBusiness details: address and insurance (14 Oct)');
  assertEqual(sb.businessAddress({ address:'12 Smith St, Parramatta NSW 2150' }), { street:'12 Smith St, Parramatta NSW 2150', suburb:'', state:'', postcode:'', line:'12 Smith St, Parramatta NSW 2150' }, 'businessAddress: the old one-line address reads as the street');
  assertEqual(sb.businessAddress({ street:'12 Smith St', suburb:'Parramatta', state:'NSW', postcode:'2150', address:'old' }).line, '12 Smith St, Parramatta NSW 2150', 'businessAddress: the parts make the line');
  const part = sb.businessAddress({ street:'', suburb:'Parramatta', address:'old line' });
  assertEqual([part.street, part.line], ['', 'Parramatta'], 'businessAddress: a saved address in parts never brings the old line back');
  assertEqual(sb.businessAddress(null), { street:'', suburb:'', state:'', postcode:'', line:'' }, 'businessAddress: nothing saved');
  assertEqual(sb.AU_STATES.length, 8, 'AU_STATES: 8 states and territories');
  const today = '2026-10-10';
  assertEqual([sb.businessInsuranceStatus(undefined, today), sb.businessInsuranceStatus({ insurer:'QBE' }, today)], [{ tone:'neutral', text:'Not on file' }, { tone:'neutral', text:'No expiry date' }], 'businessInsuranceStatus: nothing / no date');
  assertEqual([sb.businessInsuranceStatus({ expiry:'2026-10-01' }, today), sb.businessInsuranceStatus({ expiry:'2026-10-11' }, today), sb.businessInsuranceStatus({ expiry:'2026-11-09' }, today), sb.businessInsuranceStatus({ expiry:'2026-11-10' }, today)],
    [{ tone:'bad', text:'Expired 1 Oct 2026' }, { tone:'warn', text:'Expires in 1 day' }, { tone:'warn', text:'Expires in 30 days' }, { tone:'good', text:'Valid until 10 Nov 2026' }], 'businessInsuranceStatus: expired, due within 30 days, fine after that');
  // Reminders: the business's insurance like an employee document.
  const base = { jobs:[], contacts:[], equipmentSpend:[], quotes:[], manualReminders:[], employees:[], readReminders:[], dismissedReminders:[] };
  const rem = (ins, extra) => { sb.STATE.data = Object.assign({}, base, { settings: { gstRatePercent:10, catalog: ins ? { business: { insurance: ins } } : undefined } }, extra || {}); if (!ins) delete sb.STATE.data.settings.catalog; sb.JOB_CACHE.index = null;
    return sb.computeReminders(sb.STATE.data, sb.parseLocalDate(today)).filter(it => it.type==='business-insurance').map(it => [it.title, it.severity]); };
  assertEqual(rem({ workers:{ expiry:'2026-10-20' }, liability:{ expiry:'2027-01-01' } }), [['Workers compensation insurance expires in 10 days', 'warn']], 'computeReminders: business insurance due soon');
  assertEqual(rem({ workers:{ expiry:'2026-10-20' } }, { dismissedReminders:['bizins:workers:2026-10-20'] }), [], 'computeReminders: a dismissed one stays away');
  assertEqual(rem({ workers:{ expiry:'2026-10-01' } }), [['Workers compensation insurance has expired', 'bad']], 'computeReminders: expired business insurance');
  assertEqual(rem(null), [], 'computeReminders: nothing saved = nothing');
  // Owners only (settings.catalog is readable by every role, and a Delete would hide it from the owners too).
  rem({ workers:{ expiry:'2026-10-20' } });
  const forRole = role => sb.remindersFor({ role }, sb.STATE.data, sb.parseLocalDate(today)).filter(it => it.type==='business-insurance').length;
  assertEqual(['owner', 'manager', 'va', 'technician'].map(forRole), [1, 0, 0, 0], 'remindersFor: business insurance shows to owners only');
}

function testSettingsRound2Small(sb){
  console.log('\nSettings round 2, small fixes (13 Oct)');
  // Two-step sign-in: a cancelled setup leaves an unverified factor; it is removed, and every new setup gets its own name.
  assertEqual(sb.mfaStaleFactors([{ id:'a', factor_type:'totp', status:'verified', friendly_name:'OPS 2026-10-12' }, { id:'b', factor_type:'totp', status:'unverified', friendly_name:'OPS 2026-10-13' }, { id:'c', factor_type:'phone', status:'unverified' }, { id:'d', factor_type:'webauthn', status:'unverified' }]).map(f => f.id),
    ['b'], '2FA: only half-finished authenticator-app setups are cleaned up; verified, phone and passkey factors are kept');
  assertEqual([sb.mfaStaleFactors(undefined), sb.mfaStaleFactors(null), sb.mfaStaleFactors([null])], [[], [], []], '2FA: nothing to clean up when the list is missing');
  const t = Date.UTC(2026, 9, 13, 9, 5, 7);
  assertEqual([sb.mfaFriendlyName(t, []), sb.mfaFriendlyName(t, ['OPS 2026-10-13']), sb.mfaFriendlyName(t, undefined)],
    ['OPS 2026-10-13 09:05:07', 'OPS 2026-10-13 09:05:07', 'OPS 2026-10-13 09:05:07'], '2FA: the name has the time, so an old-style name from the same day does not clash (the bug)');
  assertEqual([sb.mfaFriendlyName(t, ['OPS 2026-10-13 09:05:07']), sb.mfaFriendlyName(t, ['OPS 2026-10-13 09:05:07', 'OPS 2026-10-13 09:05:07 (2)'])],
    ['OPS 2026-10-13 09:05:07 (2)', 'OPS 2026-10-13 09:05:07 (3)'], '2FA: a name already taken gets a number');
  // Phone notifications: who can send a test, and what the bar shows.
  assertEqual([sb.pushCanTest({ role:'owner' }), sb.pushCanTest({ role:'manager' }), sb.pushCanTest({ role:'va' }), sb.pushCanTest({ role:'technician' }), sb.pushCanTest(null)],
    [true, true, false, false, false], 'notifications: only owners and managers can send a test');
  const M = sb.phoneBarMode;
  assertEqual([M('payroll', { checked:false, on:false }, false, true), M('payroll', { checked:false, on:false }, true, true), M('settings', { checked:false, on:false }, true, true)],
    ['off', 'hide', 'off'], 'notifications: before the device check, a tested device does not flash "Turn on" on Payroll');
  assertEqual([M('payroll', { checked:true, on:false }, true, true), M('payroll', { checked:true, on:true }, false, true), M('payroll', { checked:true, on:true }, true, true), M('payroll', { checked:true, on:true }, false, false), M('settings', { checked:true, on:true }, true, true), M('payroll', null, false, true)],
    ['off', 'on', 'hide', 'hide', 'on', 'off'], 'notifications: Payroll hides the bar once tested (or when there is nothing to offer); Settings keeps Send a test; a lost subscription offers Turn on again');
  assertEqual([sb.toastKind('Notifications are on for this device. A test was sent to 1 device.'), sb.toastKind('Notifications are on for this device')], ['ok', 'ok'], 'notifications: the turned-on message is a success');
  // What is gone and what stays (read from the page's own code).
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8'), script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assertEqual([script.includes('mfaReminderHtml'), script.includes('setRequireMfa'), script.includes('requireMfa'), script.includes('Job types follow the services')],
    [false, false, false, false], 'settings: no "require two-step sign-in" switch, no reminder, no "Job types" row');
  const shell = extractDecl(script, 'renderShell');
  assertEqual([shell.includes('openViewAsModal()'), shell.includes('exitViewAs()'), shell.includes('togglePresentationMode'), shell.includes('Presentation mode: ON')],
    [false, true, false, false], 'main menu (item 4): no View as start, no Presentation mode at all (it would show the viewer of a demo); View as keeps its way back out');
  // Since 14 Oct (Face ID / fingerprint) these sit on the unlocked Security page, behind the lock.
  assertEqual(extractDecl(script, 'renderSecurityUnlocked').includes('togglePresentationMode()'), true, 'Settings → Security still turns Presentation mode on and off');
  const sec = extractDecl(script, 'renderSecurityUnlocked');
  assertEqual([sec.includes('togglePresentationMode()'), sec.includes('openViewAsModal()'), sec.includes('startMfaEnroll()'), sec.includes('turnOffMfa()')],
    [true, true, true, true], 'Security keeps Showing the app and the per-person two-step sign-in');
  const enroll = extractDecl(script, 'startMfaEnroll');
  assertEqual([enroll.includes('data.all'), enroll.includes('mfaStaleFactors('), enroll.includes('mfaFriendlyName(')], [true, true, true], '2FA: setup looks in all factors, cleans up and picks a unique name');
  assertEqual([extractDecl(script, 'enablePhoneNotifications').includes("step:'test'"), extractDecl(script, 'sendTestNotification').includes('markPushTestedHere()'), extractDecl(script, 'keepListScroll').includes('.set-nav')],
    [true, true, true], 'notifications: a test goes out by itself and is remembered; the Settings menu keeps its scroll');
  assertEqual([/\.set-nav \{[^}]*position: sticky[^}]*max-height:[^}]*overflow-y: auto/.test(html), html.includes('.set-layout.show-page .set-nav { display: none; }')],
    [true, true], 'settings menu: its own scroll on a wide screen; still list → page on a phone');
}

function testConnectors(sb){
  console.log('\nSettings → Connectors (14 Oct)');
  const D = id => sb.CONNECTORS.find(d => d.id===id);
  // Lead sources rows (approved mockup): the tag, how leads are recognised, and the connector each one opens.
  const SR = (x, cat, n) => { const r = sb.sourceRowInfo(x, cat || {}, n || 0); return [r.type, r.conn, r.gone]; };
  assertEqual([SR({ key:'Google Ads' }), SR({ key:'Meta Ads' }), SR({ key:'Google Maps' }), SR({ key:'Organic' }), SR({ key:'Referral' }), SR({ key:'Unknown' })],
    [['conn','gads',false], ['conn','meta',false], ['conn','web',false], ['conn','web',false], ['manual',null,false], ['manual',null,false]], 'lead sources: the built-in ones open their connector; the rest are picked by hand');
  assertEqual([SR({ key:'ChatGPT', kind:'connected' }), SR({ key:'ChatGPT', kind:'connected' }, {}, 3), SR({ key:'ChatGPT', kind:'connected', active:false }), SR({ key:'ChatGPT', kind:'connected' }, { connectors:{ 'src:ChatGPT': { removed:true } } }), SR({ key:'Google Ads' }, { connectors:{ gads: { removed:true } } })],
    [['guide','src:ChatGPT',false], ['conn','src:ChatGPT',false], ['guide',null,false], ['guide','src:ChatGPT',true], ['conn','gads',true]], 'lead sources: a connected one is "Setting up" until its first lead; switched off it has no connector page; a removed connector is said');
  assertEqual([sb.sourceRowInfo({ key:'Google Ads' }, {}, 0).how, sb.sourceRowInfo({ key:'Referral' }, {}, 0).how, sb.sourceRowInfo({ key:'Unknown' }, {}, 0).how], ['Recognised by the ad\'s click code', 'Manual: the office picks it on the lead', 'When nobody knows where the lead came from'], 'lead sources: the line under each source, as in the mockup');
  assertEqual(Object.values(sb.SOURCE_HOW).every(([id]) => !!D(id)) && Object.keys(sb.SOURCE_HOW).every(k => sb.LEAD_SOURCES.includes(k)), true, 'lead sources: every built-in source maps to a real connector');
  const cfg = (e, id) => sb.connCfgOf({ connectors: e }, id);
  const empty = { off:{}, accountsOff:{}, auto:{}, disconnected:false, removed:false, formSent:'' };
  assertEqual([sb.connCfgOf(undefined, 'gads'), sb.connCfgOf({ connectors: { gads: 'x' } }, 'gads'), sb.connCfgOf({ connectors: null }, 'gads'), sb.connCfgOf({ connectors: { gads: { off: [1] } } }, 'gads')], [empty, empty, empty, empty], 'connCfgOf: nothing saved (or something broken) = everything on');
  const cat = { connectors: { gads: { off: { stats: true } } } }, c1 = sb.connCfgOf(cat, 'gads');
  c1.off.conv = true;
  assertEqual(cat.connectors.gads.off, { stats: true }, 'connCfgOf: a copy, so changing it never changes the saved catalog');
  // the saved shape: only what is off
  const p1 = sb.connPatched({}, 'gads', c => { c.off = { stats: true }; });
  assertEqual(p1, { gads: { off: { stats: true } } }, 'connPatched: an item switched off is saved as off:{item:true}');
  assertEqual([sb.connPatched(p1, 'gads', c => { c.off.stats = false; }), sb.connPatched(p1, 'gads', c => { delete c.off.stats; })], [{}, {}], 'connPatched: switched back on = nothing saved (pruned)');
  const both = { meta: { off: { ads: true } }, gads: { off: { stats: true } } }, before = JSON.stringify(both);
  assertEqual([sb.connPatched(both, 'gads', c => { c.disconnected = true; }), JSON.stringify(both)===before], [{ meta: { off: { ads: true } }, gads: { off: { stats: true }, disconnected: true } }, true], 'connPatched: other connectors untouched, the input not changed');
  assertEqual([sb.connPatched({}, 'meta', c => { c.accountsOff = { '*': true }; }), sb.connPatched({ gbp: { formSent: '2026-10-14' } }, 'gbp', c => { c.removed = false; c.disconnected = 'yes'; })], [{ meta: { accountsOff: { '*': true } } }, { gbp: { formSent: '2026-10-14' } }], "connPatched: '*' kept; only a real true is saved for disconnected / removed");
  assertEqual([sb.connItemOn(cfg({ gads: { off: { stats: true } } }, 'gads'), 'stats'), sb.connItemOn(cfg({ gads: { off: { stats: true } } }, 'gads'), 'conv'), sb.connAccountOn(cfg({ meta: { accountsOff: { '*': true } } }, 'meta'), 'act_1'), sb.connAccountOn(cfg({}, 'gads'), '6569440597'), sb.connAccountOn(cfg({ gads: { accountsOff: { '6569440597': true } } }, 'gads'), '3782562798')],
    [false, true, false, true, true], "connItemOn / connAccountOn: an item off; '*' = every account; anything missing is on");
  // the state of each connector
  const st = (id, e, ctx) => sb.connState(D(id), cfg(e || {}, id), ctx || {});
  const src0 = sb.connSourceDef({ key: 'ChatGPT', label: 'ChatGPT', kind: 'connected' }, { count: 0 }), src3 = sb.connSourceDef({ key: 'ChatGPT', label: 'ChatGPT', kind: 'connected' }, { count: 3, last: '2026-10-12' });
  assertEqual([st('gads'), st('gads', { gads: { disconnected: true } }), st('ghl', { ghl: { disconnected: true } }), st('gbp'), st('gbp', { gbp: { formSent: '2026-10-14' } }), st('xero'), st('wp'), st('twilio', {}, { phoneEnabled: false }), st('twilio', {}, { phoneEnabled: true }), sb.connState(src0, cfg({}, src0.id), {}), sb.connState(src3, cfg({}, src3.id), {})],
    ['ok', 'disc', 'legacy', 'notstarted', 'wait', 'setup', 'setup', 'off', 'ok', 'guide', 'ok'], 'connState: working, paused, GoHighLevel (never paused), GBP before / after the form, set up needed, Twilio off / on, a source before / after its first lead');
  assertEqual(['ok', 'legacy', 'disc', 'guide', 'off'].map(sb.connIsLive), [true, true, false, false, false], 'connIsLive: working and GoHighLevel count as connected');
  // freshness: a connector is as fresh as its oldest part that is on (now = 14 Oct 00:00 UTC)
  vm.runInContext("Date.now = () => Date.parse('2026-10-14T00:00:00Z')", sb);
  const F = { google: '2026-10-13T22:00:00Z', calls: '2026-10-13T23:00:00Z', gadsStats: '2026-10-12T18:00:00Z' };
  const gc = cfg({}, 'gads'), gOff = cfg({ gads: { off: { stats: true, conv: true } } }, 'gads');
  assertEqual([sb.connTone(D('gads'), gc, F), sb.connOldest(D('gads'), gc, F), sb.connTone(D('gads'), gOff, F), sb.connOldest(D('gads'), gOff, F)], ['warn', '2026-10-12T18:00:00Z', 'good', '2026-10-13T22:00:00Z'], 'connTone / connOldest: stats 30 h old = Late; with stats and conversions off it is Working again');
  assertEqual([sb.connTone(D('gads'), gc, { ...F, calls: null }), sb.connOldest(D('gads'), gc, { ...F, calls: null })], ['bad', null], 'connTone / connOldest: a part that never updated = Not updating');
  assertEqual([sb.connTone(D('web'), cfg({}, 'web'), { lead: '2026-10-10T16:00:00Z' }), sb.connTone(D('meta'), cfg({}, 'meta'), { meta: '2026-10-10T16:00:00Z', metaStats: '2026-10-13T20:00:00Z' })], ['warn', 'bad'], 'connTone: leads use 72 / 168 hours (80 h = Late); the morning runs 26 / 50 (80 h = Not updating)');
  assertEqual([sb.connTone(D('xero'), cfg({}, 'xero'), F), sb.connOldest(D('xero'), cfg({}, 'xero'), F), sb.connTone(src3, cfg({}, src3.id), {}), sb.connTone(src0, cfg({}, src0.id), {})], [null, undefined, 'good', null], 'connTone: nothing to measure = null; a source with leads is working');
  // guides
  const twSteps = D('twilio').steps.map((x, i) => ({ ...x, st: i < 2 ? 'done' : i===2 ? 'now' : 'todo' }));
  assertEqual([sb.connNextStep(sb.connStepsFor(D('xero'), cfg({}, 'xero'))), sb.connNextStep(sb.connStepsFor(src0, cfg({}, src0.id))), sb.connNextStep(twSteps), sb.connNextStep(twSteps.map(x => ({ ...x, st: 'done' }))), sb.connNextStep(undefined)],
    ['Step 1 of 6 is yours', "Step 3 of 4 is Claude's", 'Step 3 of 4: you and Claude', '', ''], 'connNextStep: whose step is next');
  assertEqual([sb.connStepsFor(D('gbp'), cfg({}, 'gbp')).map(x => x.st), sb.connStepsFor(D('gbp'), cfg({ gbp: { formSent: '2026-10-14' } }, 'gbp')).map(x => x.st), sb.connStepsFor(D('ghl'), cfg({}, 'ghl'), 'removal').map(x => x.st), sb.connStepsFor(D('gads'), cfg({}, 'gads'))],
    [['now', 'todo', 'todo', 'todo'], ['done', 'now', 'todo', 'todo'], ['now', 'todo', 'todo', 'todo'], []], "connStepsFor: GBP's first step is done once the form is marked as sent; GoHighLevel's removal steps; no guide for a live connector");
  assertEqual([sb.connStepsFor(D('ghl'), cfg({}, 'ghl'), 'removal', 4602)[1].d.includes('including the 4,602 already kept as an archive'), sb.connStepsFor(D('ghl'), cfg({}, 'ghl'), 'removal', 0)[1].d.startsWith('All of them, including the ones already kept as an archive.')], [true, true], 'the GoHighLevel archive step uses the live count (or no number)');
  // tags, search, what stops
  assertEqual([sb.connHows(D('gads')), sb.connHows(D('email')), sb.connHows(D('ghl')), sb.connHows(D('xero'))], [['routine'], ['routine', 'script'], ['out'], ['api', 'webhook']], 'connHows: every way the items come in, in the legend order');
  assertEqual([sb.connMatches(D('gads'), 'keyword'), sb.connMatches(D('xero'), 'PROFIT AND LOSS'), sb.connMatches(D('gbp'), 'zzz'), sb.connMatches(D('gbp'), '  ')], [true, true, false, true], 'connMatches: name, description and item names, any case');
  const gStops = sb.connStopsAll(D('gads'), cfg({ gads: { off: { stats: true } } }, 'gads'));
  assertEqual([gStops.length, gStops.some(t => t.includes('keywords, search terms and ads stay')), sb.connStopsAll(D('gads'), cfg({}, 'gads')).length], [7, false, 8], 'connStopsAll: what stops with the whole connector, without the parts already off');
  assertEqual([sb.connPendingReaders(D('gads'), cfg({}, 'gads')), sb.connPendingReaders(D('gads'), cfg({}, 'gads'), ['stats']), sb.connPendingReaders(D('nightly'), cfg({}, 'nightly'), ['assess', 'real']), sb.connPendingReaders(D('xero'), cfg({}, 'xero'))],
    [['the 7:00 morning run'], [], ['the 7:50 nightly check'], []], 'connPendingReaders: who still has to read a switch (not the parts ingest-ads-stats already honours)');
  // connected lead sources
  const cg = src0, cm = sb.connSourceDef({ key: 'Car Magnet', label: 'Car Magnet', kind: 'connected' }, { count: 0 });
  assertEqual([cg.id, cg.logo, cg.items.map(i => i.k), cg.note.includes('arrives from chatgpt.com') && cg.note.includes('utm_source=chatgpt.com'), cg.steps[2].who, cg.steps[0].t],
    ['src:ChatGPT', 'AI', ['ref', 'utm'], true, 'Claude', 'Add "ChatGPT" as a lead source'], 'connSourceDef: ChatGPT is recognised by the site it comes from or its link tag');
  assertEqual([cm.logo, cm.items.map(i => i.k), cm.note.includes('utm_source=carmagnet') && cm.note.includes('Add it to the links you share for Car Magnet'), cm.items[0].stops[0]], ['CM', ['utm'], true, 'New Car Magnet leads arrive as "Organic web".'], 'connSourceDef: another source needs the tag on its links');
  const defs = sb.connDefs([{ key: 'ChatGPT', label: 'ChatGPT', kind: 'connected', active: true }, { key: 'Off', kind: 'connected', active: false }, { key: 'Gone', kind: 'connected', deleted: true }, { key: 'Referral', label: 'Referral', active: true }],
    [{ source: 'ChatGPT', createdAt: '2026-10-02' }, { source: 'ChatGPT', createdAt: '2026-10-09' }, { source: 'Organic', createdAt: '2026-10-11' }]);
  assertEqual([defs.length, defs.slice(-1)[0].id, defs.slice(-1)[0].leads, defs.slice(-1)[0].last], [sb.CONNECTORS.length + 1, 'src:ChatGPT', 2, '2026-10-09'], 'connDefs: the built-in connectors and each connected source that is on (not off, deleted or manual)');
  // accounts, times
  assertEqual([sb.fmtAdsAccount('6569440597'), sb.fmtAdsAccount('*'), sb.fmtAdsAccount(3782562798)], ['656-944-0597', '*', '378-256-2798'], 'fmtAdsAccount: 10 digits as Google writes them');
  const NOW = Date.parse('2026-10-13T21:30:00Z');   // Wed 14 Oct, 8:30 am in Sydney
  assertEqual([sb.connWhen('2026-10-13T20:52:00Z', NOW), sb.connWhen('2026-10-12T20:51:00Z', NOW), sb.connWhen('2026-10-13T03:05:00Z', NOW), sb.connWhen('2026-10-11T20:51:00Z', NOW), sb.connWhen('', NOW), sb.connWhen('garbage', NOW), sb.connDayName('2026-10-12')],
    ['Today 7:52 am', 'Yesterday 7:51 am', 'Yesterday 2:05 pm', 'Mon 12 Oct 7:51 am', '', '', 'Mon 12 Oct'], 'connWhen: today, yesterday or the date, in Sydney time');
  // add-ons
  const ad = (c, f, q) => sb.connAddonsShown(c, sb.CONNECTORS, f, q);
  assertEqual([ad({}, 'All', '').length, ad({}, 'Money', '').length, ad({}, 'All', 'xero').map(a => a.name), ad(undefined, 'Lead sources', 'ZZZ').length], [12, 4, ['QuickBooks'], 0], 'connAddonsShown: 12 add-ons, by category and by the search words (descriptions too)');
  const rem = ad({ gads: { removed: true } }, 'All', '');
  assertEqual([rem.length, rem[0].id, rem[0].cat, rem[0].act, ad({ gads: { removed: true } }, 'Money', '').length], [13, 'gads', 'Removed connectors', 'connect', 4], 'connAddonsShown: a removed connector comes first, to connect again');
  // the list itself
  const ids = sb.CONNECTORS.map(d => d.id);
  assertEqual([ids, new Set(ids).size], [['gads', 'meta', 'organic', 'nightly', 'email', 'web', 'sheet', 'twilio', 'ghl', 'gbp', 'xero', 'wp'], 12], 'CONNECTORS: the 12 connectors in the mockup order, each once');
  const bad = sb.CONNECTORS.flatMap(d => d.items.filter(i => !i.k || !i.n || !i.freq || !i.feeds || !(i.how===null || sb.CONN_HOW[i.how]) || typeof i.reader!=='string').map(i => d.id + '.' + i.k));
  assertEqual(bad, [], 'CONNECTORS: every item has a key, name, how (a known tag or none), how often, what it feeds and who reads its switch');
  assertEqual(sb.CONNECTORS.flatMap(d => d.items.filter(i => i.reader==='fn').map(i => d.id + '.' + i.k)).sort(), ['email.check', 'gads.conv', 'gads.kw', 'gads.stats', 'meta.ads', 'nightly.assess', 'organic.ai', 'organic.ga4', 'organic.gsc'], "CONNECTORS: the switches ingest-ads-stats honours are exactly the server's list");
  assertEqual([D('ghl').items.filter(i => i.lock).map(i => i.k), D('xero').items.filter(i => i.auto).map(i => i.k), D('web').bg, sb.CONN_ACCOUNTS.gads.map(a => a.key)], [['chat', 'chatmail'], ['inv'], 'var(--primary)', ['6569440597', '3782562798']], 'GoHighLevel: the chat parts are locked (P1); Xero invoices have "Send automatically"; the two Google accounts');
  // recent syncs
  const log = { insights: [{ platform: 'google', created_at: '2026-10-13T20:52:00Z' }, { platform: 'meta', created_at: '2026-10-12T20:45:00Z' }],
    checks: [{ day: '2026-10-13', checked_at: '2026-10-13T20:53:00Z', emails: 5, matched: 4 }, { day: '2026-10-12', checked_at: '2026-10-13T20:53:00Z', emails: 3, matched: 3 }] };
  assertEqual(sb.connLogRows('gads', log, NOW), [['Today 7:52 am', 'good', 'OK', 'Assessment written'], ['Tue 13 Oct', 'bad', "Didn't run", 'Nothing came in.'], ['Mon 12 Oct', 'bad', "Didn't run", 'Nothing came in.'], ['Sun 11 Oct', 'bad', "Didn't run", 'Nothing came in.']], 'connLogRows: the last 4 Sydney days, today first');
  assertEqual([sb.connLogRows('meta', log, NOW)[0], sb.connLogRows('meta', log, NOW).length, sb.connLogRows('meta', log, Date.parse('2026-10-14T00:30:00Z'))[0]], [['Yesterday 7:45 am', 'good', 'OK', 'Assessment written'], 3, ['Wed 14 Oct', 'bad', "Didn't run", 'Nothing came in.']], "connLogRows: today shows \"Didn't run\" only after 10 am");
  assertEqual([sb.connLogRows('email', log, NOW)[0], sb.connLogRows('nightly', log, NOW)[0][3], sb.connLogRows('web', log, NOW), sb.connLogRows('gads', null, NOW)], [['Today 7:53 am', 'good', 'OK', '5 emails checked, 4 in the CRM'], 'Assessment written (google)', [], []], 'connLogRows: the lead check names its numbers; connectors with no daily trace have no log');
}

testJobAttributionTags(loadSandbox());
testSubDivisionAndSource(loadSandbox());
testSplitLeadRequestEvent(loadSandbox());
testComputeBusinessPerformance(loadSandbox());
testFunnelLossReasonsSpeedToLead(loadSandbox());
testComputeProfitByWeekInRange(loadSandbox());
function testVaAutoLogout(sb){
  console.log('\nVA automatic log-out, per person (Settings → People, 13 Oct)');
  const cat = c => { sb.STATE.data.settings = { catalog: c }; };
  const D = { logoutAt: '22:00', endAt: '17:30', logoutFrom: 'default' };
  cat({});
  assertEqual(sb.vaShiftTimes('p1'), D, 'va log-out: nothing saved = 22:00, and 17:30 recorded when they forget');
  cat({ myday: { autoLogout: '20:30' } });
  assertEqual(sb.vaShiftTimes('p1'), { logoutAt: '20:30', endAt: '17:30', logoutFrom: 'office' }, 'va log-out: the old office-wide setting (Security) still reads');
  cat({ myday: { autoLogout: '20:30', people: { p1: { logoutAt: '21:15', endAt: '18:00' } } } });
  assertEqual([sb.vaShiftTimes('p1'), sb.vaShiftTimes('p2')], [{ logoutAt: '21:15', endAt: '18:00', logoutFrom: 'person' }, { logoutAt: '20:30', endAt: '17:30', logoutFrom: 'office' }], 'va log-out: per person; the others keep the fallback');
  cat({ myday: { autoLogout: 'x', people: { p1: { logoutAt: '25:00', endAt: '5pm' } } } });
  assertEqual(sb.vaShiftTimes('p1'), D, 'va log-out: bad saved values fall back');
  cat({ myday: { people: { p1: { logoutAt: '23:55' }, p2: { logoutAt: '19:00', endAt: '20:00' } } } });
  assertEqual([sb.vaShiftTimes('p1').logoutAt, sb.vaShiftTimes('p2').endAt], ['23:30', '19:00'], 'va log-out: capped before midnight; the end is never after the log-out');
  const odd = [{ myday: { people: ['x'] } }, { myday: { people: { p1: 'oops' } } }, { myday: { people: null } }].map(c => { cat(c); try { return sb.vaShiftTimes('p1'); } catch (e) { return 'threw: ' + e.message; } });
  assertEqual(odd, [D, D, D], 'va log-out: odd saved shapes read as the default, no error');
  const cur = { logoutAt: '22:00', endAt: '17:30' }, P = (f, v) => sb.vaShiftTimeProblem(f, v, cur);
  assertEqual([P('logoutAt', '21:00'), P('endAt', '18:15'), P('logoutAt', ''), P('logoutAt', '23:45'), P('logoutAt', '17:30'), P('endAt', '22:00')],
    ['', '', 'Pick a time', 'Pick a time by 23:30, so the day is closed before midnight', 'Pick a time after 17:30, the end time recorded when they forget', 'Pick a time before 22:00, when they are logged out'], 'va log-out: which times can be saved, and why not');
  // Sydney is AEDT (+11) on 13 Oct 2026 and AEST (+10) in June.
  const E = sb.vaEndTimeText;
  assertEqual([E('2026-10-13', '2026-10-13T06:30:00Z'), E('2026-10-13', '2026-10-13T07:42:00Z'), E('2026-10-13', '2026-10-12T13:05:00Z'), E('2026-06-15', '2026-06-15T07:30:00Z')], ['5:30pm', '6:42pm', '12:05am', '5:30pm'], 'va log-out: the recorded end time shown in Sydney time');
  assertEqual([E('2026-10-13', '2026-10-12T06:30:00Z'), E('2026-10-13', null), E('2026-10-13', 'garbage')], ['', '', ''], 'va log-out: no time shown when it is another day or missing');
  // The SQL (Ofek applies it) and the app use the same defaults and the same settings keys.
  const sql = fs.readFileSync(path.join(__dirname, '..', '.claude', 'sql', 'settings-round2-phase1.sql'), 'utf8');
  const fnSql = (sql.match(/create or replace function public\.auto_end_va_shifts\(\)[\s\S]*?\$function\$;/i) || [''])[0];
  const V = sb.VA_SHIFT_DEFAULT;
  assertEqual([`time '${V.logoutAt}'`, `time '${V.endAt}'`, `time '${V.latest}'`, "'people'", "'logoutAt'", "'endAt'", "'autoLogout'"].filter(x => !fnSql.includes(x)), [], 'va log-out: the SQL reads the same keys with the same defaults as the app');
  assertEqual([V.logoutAt, V.endAt, V.latest], ['22:00', '17:30', '23:30'], 'va log-out: defaults 22:00 / 17:30, latest 23:30');
  assertEqual(/^-- ROLLBACK \(G7\)/m.test(sql) && /^-- .*time '20:00'/m.test(sql.slice(sql.indexOf('-- ROLLBACK (G7)'))) && !/time '20:00'/.test(fnSql), true, 'va log-out: the SQL keeps a commented rollback to the live 20:00 version');
}
function testPeopleTabs(sb){
  console.log('\nSettings → People with tabs (14 Oct)');
  const keys = sb.PAGE_PICK.map(x => x[0]);
  const on = m => keys.filter(k => m[k]);
  // The pages a person can be given: every page but Settings, in the menu's order.
  assertEqual([keys, keys.length], [['crm','crmOverview','adsGoogle','closings','jobs','payroll','outstanding','reminders','openItems','tasks','reference'], 11], 'pages: the 11 pages that can be given, in the menu order');
  assertEqual(sb.ALL_SECTIONS.filter(k => k!=='settings').slice().sort(), keys.slice().sort(), 'pages: the same pages as ALL_SECTIONS without Settings');
  assertEqual(keys.slice().sort((a, b) => sb.SECTION_ORDER.indexOf(a) - sb.SECTION_ORDER.indexOf(b)), keys, 'pages: in SECTION_ORDER order');
  // Role defaults: nothing saved = the built-in defaults; a saved map wins; an empty or odd one falls back.
  const R = (r, saved) => sb.roleDefaultPages(r, saved);
  assertEqual([on(R('technician', {})), on(R('va', {})), on(R('marketing', {})), on(R('manager', {}))],
    [['payroll','reminders','tasks'], ['crm','closings','jobs','payroll','outstanding','reminders','openItems','tasks','reference'], ['adsGoogle'], ['crm','crmOverview','closings','jobs','payroll','outstanding','reminders','openItems','tasks','reference']], 'role defaults: the built-in pages per role');
  assertEqual([Object.keys(R('technician', {})), 'settings' in R('owner', {}), Object.keys(R('owner', {})).length], [keys, false, 11], 'role defaults: always the 11 pages in order, never Settings');
  assertEqual(on(R('technician', { technician: { crm: true, settings: true } })), ['crm'], 'role defaults: a saved map wins; pages it leaves out are off; Settings is never given');
  assertEqual([on(R('technician', { technician: {} })), on(R('va', { va: 'x' })), on(R('va', { va: ['crm'] })), on(R('technician', null))], [['payroll','reminders','tasks'], on(R('va', {})), on(R('va', {})), ['payroll','reminders','tasks']], 'role defaults: an empty or odd saved value falls back to the built-in pages');
  assertEqual(sb.pagesDiff({ crm: true, payroll: false, reminders: true, tasks: true }, R('technician', {})), { add: ['crm'], off: ['payroll'] }, 'pages: what differs from the role defaults (added, taken away)');
  assertEqual(sb.pagesDiff(R('va', {}), R('va', {})), { add: [], off: [] }, 'pages: the same as the defaults');
  const c = sb.cleanPages({ crm: 1, settings: true, x: true });
  assertEqual([sb.cleanPages(null), sb.cleanPages([1]), sb.cleanPages('x'), Object.keys(c), c.crm, on(c)], [null, null, null, keys, true, ['crm']], 'pages: cleanPages keeps the 11 pages as true/false, nothing else');
  assertEqual([sb.listJoin([]), sb.listJoin(['A']), sb.listJoin(['A', 'B']), sb.listJoin(['A', 'B', 'C']), sb.listJoin(['A', '', null, 'B'])], ['', 'A', 'A and B', 'A, B and C', 'A and B'], 'listJoin: names in a sentence');
  assertEqual([sb.settingsPageKey('pay'), sb.settingsPageKey('access'), sb.settingsPageKey('roles'), sb.settingsPageKey('profile'), sb.settingsPageKey('people')], ['people', 'people', 'people', 'profile', 'people'], 'settings: the old Pay, Access and Roles pages open People');
  assertEqual([sb.hhmm12('17:30'), sb.hhmm12('00:05'), sb.hhmm12('12:00'), sb.hhmm12('23:59'), sb.hhmm12('bad'), sb.hhmm12('24:00'), sb.hhmm12(null)], ['5:30pm', '12:05am', '12:00pm', '11:59pm', '', '', ''], 'hhmm12: 24-hour time in words');
  // Hourly pay over time: a change saved for a later day is the editor's starting point, but is not paid until its day.
  const t1 = [{ min: 5, bonus: 10 }, { min: 8, bonus: 15 }];
  sb.STATE.data.settings = { catalog: { pay: { hourly: [{ from: '2026-10-20', rate: 12, tiers: [{ min: 6, bonus: 20 }] }, { from: '2026-10-01', rate: 10, tiers: t1 }, { from: 'nope', rate: 99 }] } } };
  assertEqual(sb.payHourlyList().map(x => x.from), ['2026-10-01', '2026-10-20'], 'hourly: saved entries oldest first, a bad date left out');
  assertEqual([sb.payHourlyNext('2026-10-14').from, sb.payHourlyBase('2026-10-14').rate, sb.payHourlyFor('2026-10-14').rate, sb.payHourlyFor('2026-10-20').rate, sb.payHourlyNext('2026-10-20'), sb.payHourlyBase('2026-10-21').rate],
    ['2026-10-20', 12, 10, 12, null, 12], 'hourly: a change saved for the 20th is edited from, but paid only from the 20th');
  assertEqual(sb.payHourlyKey({ rate: 10, tiers: [{ min: 8, bonus: 15 }, { min: 5, bonus: 10 }] })===sb.payHourlyKey({ rate: '10', tiers: t1 }), true, 'hourly: the same pay whatever order the bonuses are in');
  assertEqual(sb.payHourlyKey({ rate: 10, tiers: t1 })===sb.payHourlyKey({ rate: 10.5, tiers: t1 }), false, 'hourly: a new rate is a change');
  const list = [{ from: '2026-10-01', rate: 10, tiers: t1 }], before = JSON.stringify(list);
  const up1 = sb.payHourlyUpsert(list, '2026-10-01', 11, t1), up2 = sb.payHourlyUpsert(list, '2026-09-01', 9, []);
  assertEqual([up1.map(x => [x.from, x.rate]), up2.map(x => [x.from, x.rate]), JSON.stringify(list)===before, up1[0].tiers], [[['2026-10-01', 11]], [['2026-09-01', 9], ['2026-10-01', 10]], true, [{ min: 8, bonus: 15 }, { min: 5, bonus: 10 }]], 'hourly: a change on the same day replaces it, another day is added in date order; the list passed in is unchanged');
  const H = sb.payHourlyHistory([{ from: '2026-10-01', rate: 10, tiers: t1 }, { from: '2026-10-20', rate: 12, tiers: [] }, { from: '2026-08-04', rate: 9, tiers: [] }], '2026-10-14');
  assertEqual(H.map(x => [x.from, x.state]), [['2026-10-20', 'next'], ['2026-10-01', 'now'], ['2026-08-04', 'past']], 'hourly: pay over time, newest first (next, now, past)');
  assertEqual([sb.payHourlyHistory([{ from: '2026-11-01', rate: 12, tiers: [] }], '2026-10-14').map(x => [x.from, x.state, x.rate]), sb.payHourlyHistory([], '2026-10-14').map(x => [x.from, x.state, x.rate])],
    [[['2026-11-01', 'next', 12], [null, 'now', 10]], [[null, 'now', 10]]], 'hourly: with nothing paid from a saved entry yet, the built-in $10 is paid now');
  // The services on someone's Pay tab: every active one, plus a switched-off one they do or have a rate for.
  const types = ['Aircon', 'Chimney', 'Pressure Washing', 'Other', 'Solar'], active = new Set(['Aircon', 'Pressure Washing', 'Other', 'Solar']);
  assertEqual(sb.payServicesFor(types, active, ['Aircon', 'Chimney'], { Aircon: 30, 'Pressure Washing': null }).map(x => [x.key, x.active, x.does, x.rate]),
    [['Aircon', true, true, 30], ['Chimney', false, true, null], ['Pressure Washing', true, false, null], ['Other', true, false, null], ['Solar', true, false, null]], 'pay tab: every active service, and a switched-off one they still do');
  assertEqual(sb.payServicesFor(types, active, ['Aircon'], { Aircon: 30 }).map(x => x.key), ['Aircon', 'Pressure Washing', 'Other', 'Solar'], 'pay tab: a switched-off service they don\'t do and have no rate for is left out');
  assertEqual(sb.payServicesFor(types, active, ['Aircon'], { Chimney: 25 }).map(x => x.key), types, 'pay tab: a switched-off service with a saved rate still shows');
  sb.STATE.data.settings = { catalog: { pay: { jobTypes: { Guy: ['Aircon', 'Other'] } } } };
  assertEqual([sb.missingRates('Guy', { Aircon: 30 }), sb.missingRates('Guy', { Aircon: 30, Other: 0 }), sb.missingRates('Alessandro', {}), sb.missingRates('Guy', null)], [['Other'], [], ['Pressure Washing'], ['Aircon', 'Other']], 'pay tab: the services they do with no rate yet (0% is a rate)');
  const html = sb.empRatesHtml({ Aircon: 30, Other: 25, Chimney: 40 }, ['Aircon', 'Other']);
  assertEqual([html.includes('Aircon 30%'), html.includes('Other 25%'), html.includes('Chimney'), sb.empRatesHtml({ 'Pressure Washing': 50 }).includes('Pressure W. 50%'), sb.empRatesHtml({}), sb.empRatesHtml(null)], [true, true, false, true, '', ''], 'cards: rates for the services they do, Other included (it used to be left out)');
  sb.STATE.data.settings = { gstRatePercent: 10 };
  // Who is paid how: the same rules as Payroll (payrollCommissionPeople / payrollHourlyPeople).
  const E = (roles, employmentType, status) => ({ name: roles.join('') + employmentType, roles, employmentType, status: status || 'Active' });
  const fx = [
    { emp: null, prof: { role: 'marketing' } },
    { emp: E(['Owner', 'Technician'], 'Salaried'), prof: { role: 'owner', fullName: 'Ofek' } },
    { emp: E(['Owner'], 'Salaried'), prof: null },
    { emp: E(['Technician', 'Sales'], 'Freelance-commission'), prof: { role: 'technician' } },
    { emp: E(['VA'], 'Hourly'), prof: { role: 'va' } },
    { emp: E(['Manager'], 'Salaried'), prof: { role: 'manager' } },
  ];
  assertEqual(fx.map(sb.personPayKind), ['none', 'owner', 'ownerNoLogin', { hourly: false, commission: true, other: false }, { hourly: true, commission: false, other: false }, { hourly: false, commission: false, other: true }], 'pay tab: owner wage (only with the owner login), commission, hourly or neither');
  const data = { employees: fx.filter(x => x.emp).map(x => x.emp) };
  assertEqual([sb.payrollCommissionPeople(data), sb.payrollHourlyPeople(data)], [[fx[3].emp.name], [fx[4].emp.name]], 'pay tab: the same people Payroll pays by commission and by the hour');
  // The team server function starts from the same pages (P9).
  const team = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'team', 'index.ts'), 'utf8');
  const pages = Function('return ' + team.match(/export const PAGES = (\[[^\]]*\]);/)[1])();
  const defs = Function('return ' + team.match(/export const ROLE_DEFAULTS: [^=]+= (\{[\s\S]*?\n\});/)[1])();
  assertEqual(pages, keys, 'team function: the same pages as the app');
  // A new technician's profile also gets finance (not a page): the database lets them read their own jobs and rates by it.
  assertEqual([sb.newProfilePermissions('technician', R('technician', {})), sb.newProfilePermissions('va', { crm: true, finance: true }), sb.newProfilePermissions('technician', null), sb.newProfilePermissions('technician', { finance: false })],
    [{ ...R('technician', {}), finance: true }, sb.cleanPages({ crm: true }), null, { ...sb.cleanPages({}), finance: true }], 'new profile: the pages ticked, plus finance for a technician only (as defaultPermissionsFor)');
  assertEqual(sb.defaultPermissionsFor('technician').finance, true, 'new profile: the built-in technician permissions have finance too');
  assertEqual(/newProfilePermissions\(st && st\.catalog/.test(team) && /role === "technician" \? \{ \.\.\.pages, finance: true \}/.test(team), true, 'team function: a new technician gets finance as well');
  assertEqual(['manager', 'va', 'technician', 'marketing'].map(r => JSON.stringify(defs[r])===JSON.stringify(R(r, {}))), [true, true, true, true], 'team function: the same built-in pages per role as the app');
  // The three old Settings pages are gone; every function lives on in People.
  const html2 = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const fnText = n => { const i = html2.search(new RegExp(`function ${n}\\(`)); if (i < 0) return ''; let j = html2.indexOf('{', i) + 1, d = 1; while (d) { if (html2[j]==='{') d++; else if (html2[j]==='}') d--; j++; } return html2.slice(i, j); };
  const settingsFn = fnText('renderSettings');
  assertEqual([/id: 'pay'/.test(settingsFn), /id: 'access'/.test(settingsFn), /id: 'roles'/.test(settingsFn), /id: 'people'/.test(settingsFn), /settingsPageKey\(ui\.page\)/.test(settingsFn)], [false, false, false, true, true], 'settings: Pay and commissions, Access for each person and Roles and access are gone; an old page key opens People');
  assertEqual(['renderTechnicianSettingsCard', 'renderRolesPage', 'renderHourlyPaySettings', 'renderEmployeePanel', 'setPayRate', 'addPayTier'].filter(n => fnText(n)), [], 'settings: the old page renderers are deleted');
  assertEqual([fnText('openEmployeeModal').includes('em-aircon'), /commissionRates\.set\(name, rates\)/.test(fnText('saveEmployeeModal')), /getElementById\('em-(aircon|chimney|pw|other)'\)/.test(fnText('saveEmployeeModal'))], [false, false, false], 'edit window: no rate inputs, so saving it never rewrites (or wipes) a commission rate');
  assertEqual((html2.match(/db\.commissionRates\.set\(/g) || []).length, 2, 'commission rates are written in two places only: one rate on the Pay tab, and the move on a rename');
}

function testSecurityFaceId(sb){
  console.log('\nSettings → Security: Face ID / fingerprint and the 30-minute lock (14 Oct)');
  const fnSrc = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'passkey', 'index.ts'), 'utf8');
  const stepUp = /export const STEP_UP_MINUTES = (\d+);/.exec(fnSrc);
  assertEqual([sb.SEC_LOCK_MINUTES, stepUp && Number(stepUp[1])], [30, 30], 'lock: the app re-locks after 30 minutes, the same as the server (M6-5), so both lock together');
  assertEqual((fnSrc.match(/console\.[^\n]*/g) || []), ['console.error("passkey failed:", (e as Error).message);'], 'passkey function: its only log line prints the error message, never the request (which can hold the password)');
  assertEqual(/@simplewebauthn\/server@13\.3\.3"/.test(fnSrc) && /RP_ID = "theguysgroup\.github\.io"/.test(fnSrc), true, 'passkey function: the WebAuthn library is pinned to 13.3.3; the site is the app\'s');

  // base64url: the same as the server's (and Node's own), with no atob / btoa / TextEncoder.
  const B = sb.bytesToB64url, D = sb.b64urlToBytes, U = a => Array.from(a);
  const all = Array.from({ length: 256 }, (_, i) => i);
  assertEqual(U(D(B(new Uint8Array(all)))), all, 'b64url: a round trip of every byte value');
  assertEqual([B(new Uint8Array([104, 101, 108, 108, 111])), B(new Uint8Array([251, 255])), B(new Uint8Array([])), B(new Uint8Array([1, 2, 3]).buffer), B(new Uint8Array([9, 1, 2, 3]).subarray(1)), B(undefined)],
    ['aGVsbG8', '-_8', '', 'AQID', 'AQID', ''], 'bytesToB64url: the server\'s vectors, an ArrayBuffer, a part of a bigger buffer, nothing');
  assertEqual([U(D('aGVsbG8')), U(D('-_8')), U(D('aGVsbG8=')), U(D('+/8')), U(D(''))], [[104, 101, 108, 108, 111], [251, 255], [104, 101, 108, 108, 111], [251, 255], []], 'b64urlToBytes: the vectors back; padding and plain base64 are read too');
  let same = true; for (let n = 0; n < 40; n++) { const a = Array.from({ length: n }, (_, i) => (i * 37 + n * 11) % 256); if (B(new Uint8Array(a)) !== Buffer.from(a).toString('base64url')) same = false; }
  assertEqual(same, true, 'bytesToB64url: the same as Node\'s base64url for every length 0..39');

  // The server's JSON options → what the browser wants (bytes), everything else untouched.
  const isBytes = x => Object.prototype.toString.call(x)==='[object Uint8Array]';
  const regJson = { challenge: 'AQID', rp: { id: 'theguysgroup.github.io', name: 'OPS Service' }, user: { id: 'aGVsbG8', name: 'o@x.com', displayName: 'Ofek' }, pubKeyCredParams: [{ alg: -7, type: 'public-key' }], excludeCredentials: [{ id: '-_8', type: 'public-key', transports: ['internal'] }], authenticatorSelection: { userVerification: 'required' }, timeout: 60000 };
  const co = sb.pkCreationOptions(regJson);
  assertEqual([isBytes(co.challenge), U(co.challenge), isBytes(co.user.id), U(co.user.id), co.user.name, co.user.displayName, isBytes(co.excludeCredentials[0].id), U(co.excludeCredentials[0].id), co.excludeCredentials[0].transports, co.rp, co.pubKeyCredParams, co.authenticatorSelection, co.timeout],
    [true, [1, 2, 3], true, [104, 101, 108, 108, 111], 'o@x.com', 'Ofek', true, [251, 255], ['internal'], regJson.rp, regJson.pubKeyCredParams, regJson.authenticatorSelection, 60000], 'pkCreationOptions: the challenge, user id and key ids become bytes; the rest stays');
  assertEqual([regJson.challenge, regJson.user.id, regJson.excludeCredentials[0].id], ['AQID', 'aGVsbG8', '-_8'], 'pkCreationOptions: the server\'s options are not changed');
  const ro = sb.pkRequestOptions({ challenge: 'AQID', rpId: 'theguysgroup.github.io', allowCredentials: [{ id: '-_8', type: 'public-key', transports: ['internal', 'hybrid'] }], userVerification: 'required', timeout: 60000 });
  assertEqual([U(ro.challenge), U(ro.allowCredentials[0].id), ro.allowCredentials[0].transports, ro.rpId, ro.userVerification], [[1, 2, 3], [251, 255], ['internal', 'hybrid'], 'theguysgroup.github.io', 'required'], 'pkRequestOptions: the challenge and key ids become bytes');
  assertEqual(sb.pkRequestOptions({ challenge: 'AQID' }).allowCredentials, undefined, 'pkRequestOptions: no key list stays no key list');

  // What the browser gives back → JSON for the server.
  const buf = a => new Uint8Array(a).buffer;
  const made = { id: 'cid', rawId: buf([1, 2, 3]), type: 'public-key', authenticatorAttachment: 'platform', response: { clientDataJSON: buf([104, 101, 108, 108, 111]), attestationObject: buf([251, 255]), getTransports(){ return ['internal', 'hybrid']; } }, getClientExtensionResults(){ return { credProps: { rk: true } }; } };
  assertEqual(sb.pkAttestationJSON(made), { id: 'cid', rawId: 'AQID', type: 'public-key', response: { clientDataJSON: 'aGVsbG8', attestationObject: '-_8', transports: ['internal', 'hybrid'] }, clientExtensionResults: { credProps: { rk: true } }, authenticatorAttachment: 'platform' }, 'pkAttestationJSON: every part as base64url, with its transports');
  const bare = sb.pkAttestationJSON({ id: 'c2', rawId: buf([1]), type: 'public-key', response: { clientDataJSON: buf([]), attestationObject: buf([]) } });
  assertEqual([bare.response.transports, bare.clientExtensionResults, bare.authenticatorAttachment], [[], {}, undefined], 'pkAttestationJSON: a browser without getTransports / extensions still works');
  const signed = { id: 'cid', rawId: buf([1, 2, 3]), type: 'public-key', response: { clientDataJSON: buf([104, 101, 108, 108, 111]), authenticatorData: buf([9]), signature: buf([251, 255]), userHandle: buf([104, 101, 108, 108, 111]) }, getClientExtensionResults(){ return {}; } };
  assertEqual(sb.pkAssertionJSON(signed), { id: 'cid', rawId: 'AQID', type: 'public-key', response: { clientDataJSON: 'aGVsbG8', authenticatorData: 'CQ', signature: '-_8', userHandle: 'aGVsbG8' }, clientExtensionResults: {} }, 'pkAssertionJSON: every part as base64url');
  const noHandle = sb.pkAssertionJSON({ ...signed, response: { ...signed.response, userHandle: null }, getClientExtensionResults: undefined });
  assertEqual(['userHandle' in noHandle.response, noHandle.response.userHandle, noHandle.clientExtensionResults], [true, undefined, {}], 'pkAssertionJSON: no user handle → left out; no extensions → {}');

  // This device.
  const I = (ua, t) => { const d = sb.pkDeviceInfo(ua, t); return [d.name, d.kind, d.icon]; };
  assertEqual([
    I('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 5),
    I('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 5),
    I('Mozilla/5.0 (iPad; CPU OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1', 5),
    I('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36', 0),
    I('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0', 0),
    I('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36', 5),
    I('Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36', 5),
    I('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36', 0),
    I('curl/8.4', 0), I(undefined, undefined),
  ], [['iPhone', 'Face ID', 'mobile'], ['iPad', 'Face ID', 'mobile'], ['iPad', 'Face ID', 'mobile'], ['Mac', 'Fingerprint', 'laptop'], ['Windows computer', 'Windows Hello', 'laptop'], ['Android phone', 'Fingerprint', 'mobile'], ['Android tablet', 'Fingerprint', 'mobile'], ['Chromebook', 'Fingerprint', 'laptop'], ['This device', 'Fingerprint', 'laptop'], ['This device', 'Fingerprint', 'laptop']],
    'pkDeviceInfo: iPhone, an iPad (also one that says Macintosh), a Mac, Windows, Android phone and tablet, a Chromebook, anything else');
  assertEqual([sb.bioIcoFor('Face ID'), sb.bioIcoFor('Fingerprint'), sb.bioIcoFor('Windows Hello')], ['face', 'finger', 'finger'], 'bioIcoFor: a face for Face ID, a fingerprint otherwise');
  assertEqual([sb.secMethodWord('passkey', 'Face ID'), sb.secMethodWord('passkey', 'Fingerprint'), sb.secMethodWord('passkey', 'Windows Hello'), sb.secMethodWord('password', 'Face ID'), sb.secMethodWord('password+code', 'Face ID'), sb.secMethodWord('google', 'Face ID'), sb.secMethodWord('', 'Face ID')],
    ['Face ID', 'your fingerprint', 'Windows Hello', 'your password', 'your password and code', 'Google', 'your password'], 'secMethodWord: "Unlocked with …" for every way in');

  // Which ways the lock offers.
  const M = (providers, hasKey, googleOn, webauthn) => { const m = sb.secUnlockMethods({ providers, hasKey, googleOn, webauthn }); return [m.first, m.passkey, m.password, m.google]; };
  assertEqual([M(['email'], true, false, true), M(['email'], false, false, true), M(['google'], false, true, true), M(['google'], false, false, true), M(['email', 'google'], false, true, true), M(['email', 'google'], true, true, true), M(['email'], true, false, false), M([], false, false, true), M(undefined, true, false, true)],
    [['prompt', true, true, false], ['pw', false, true, false], ['google', false, false, true], ['pw', false, false, false], ['pw', false, true, false], ['prompt', true, true, false], ['pw', false, true, false], ['pw', false, true, false], ['prompt', true, true, false]],
    'secUnlockMethods: a set-up device starts with Face ID; no key → password; Google-only → Google; a password AND Google → never the Google way (M6-3: one tap on a phone signed in to Google); no WebAuthn → password');

  // "Continue with Google" leaves the page: what the lock was opened for comes back (10 minutes at most).
  const GP = (v, now) => sb.secGoogleParse(typeof v === 'string' ? v : JSON.stringify(v), now);
  const T = 1_800_000_000_000;
  assertEqual([GP({ at: T - 1000, page: 'data', after: { action: 'download', page: 'data' } }, T), GP({ at: T - 1000, page: 'data', after: { action: 'email', page: 'data', email: 'me@x.com' } }, T), GP({ at: T - 1000, page: 'security' }, T), GP(String(T - 5000), T)],
    [{ used: false, page: 'data', after: { action: 'download', page: 'data', email: '' } }, { used: false, page: 'data', after: { action: 'email', page: 'data', email: 'me@x.com' } }, { used: false, page: 'security', after: null }, { used: false, page: '', after: null }],
    'secGoogleParse: the page and the action come back (also the first build\'s plain time)');
  assertEqual([GP({ at: T - 10 * 60e3 }, T), GP({ at: T + 5 * 60e3 }, T), GP('junk', T), GP('', T), GP('[1]', T), GP({ at: T - 1000, page: '<img>', after: { action: 'delete-all', page: 'data' } }, T)],
    [null, null, null, null, null, { used: false, page: '', after: null }], 'secGoogleParse: too old, in the future, junk → nothing; an unknown action or a strange page is dropped');
  assertEqual(sb.SEC_INTENTS, ['download', 'sens', 'email', 'password'], 'SEC_INTENTS: the four things a lock is opened for');
  assertEqual(['?open=backup', '?tab=settings&open=backup', '?open=Backup', '?open=', '', undefined].map(sb.lockedBackupLinkOpen), [true, true, false, false, false, false], 'lockedBackupLinkOpen: the weekly email\'s link (?open=backup) only');
  {
    const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8'), script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    assertEqual([extractDecl(script, 'renderLogin').includes('onclick="openLockedBackup()"'), /if \(lockedBackupLinkOpen\(location\.search\)\) window\.addEventListener\('load'/.test(script), ['openLockedBackup', 'openLockedBackupFiles', 'renderLockedResult'].some(n => /\bsb\.|backupFetch|passkeyCall|getSession/.test(extractDecl(script, n)))], [true, true, false], 'Open a locked backup works without signing in: on the sign-in page and from the email link, and it never calls Supabase');
  }
  {
    const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8'), script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const meth = extractDecl(script, 'secMethods'), unl = extractDecl(script, 'secUnlockPasskey'), reg = extractDecl(script, 'secRegisterPasskey'), fin = extractDecl(script, 'secGoogleFinish'), goo = extractDecl(script, 'secUnlockGoogle');
    assertEqual([meth.includes("SEC.anyKey===true"), meth.includes("secProviders().includes('google')"), unl.includes('secKeepKeyHere(cred); secOpen(out)'), extractDecl(script, 'secKeepKeyHere').includes("authenticatorAttachment!=='cross-platform'")], [true, true, true, true], 'Face ID is offered when the server has a key (a synced one too); a Google sign-in proves Google works; a key that worked here becomes this device\'s key');
    assertEqual([reg.includes("e.name==='InvalidStateError'") && reg.includes("secAdoptPasskey()"), extractDecl(script, 'secAdoptPasskey').includes("secKeepKeyHere(cred)")], [true, true], 'setting up on a device that already holds the key uses that key instead of failing');
    assertEqual([goo.includes("after: SEC.after ? SEC.afterIntent || null : null"), fin.includes("after ? after.page || g.page : g.page || 'security'"), fin.includes('secReplay(after)')], [true, true, true], 'back from Google: the page the lock was opened from, and what it was opened for is done');
    const cp = extractDecl(script, 'openChangePasswordModal'), dcp = extractDecl(script, 'doChangePassword');
    assertEqual([cp.includes("secEnsureUnlocked('Change my password', openChangePasswordForm"), dcp.indexOf('secUnlocked()') < dcp.indexOf('updateUser'), dcp.includes('updateUser')], [true, true, true], 'Change password asks for the Security step-up first (the lock can\'t be passed by setting a new password)');
  }

  assertEqual([sb.secLeft(30 * 60e3, 0), sb.secLeft(61e3, 0), sb.secLeft(5e3, 0), sb.secLeft(0, 1000), sb.secLeft(29 * 60e3 + 59400, 0)], ['30:00', '1:01', '0:05', '0:00', '29:59'], 'secLeft: m:ss, never below 0:00');
  const now = Date.parse('2026-10-14T08:00:00Z');   // 7 pm in Sydney (daylight time, UTC+11)
  assertEqual([sb.secWhen('2026-10-14T05:20:00Z', now), sb.secWhen('2026-10-13T05:20:00Z', now), sb.secWhen('2026-10-12T09:40:00Z', now), sb.secWhen('2026-10-13T14:30:00Z', now), sb.secWhen('2025-12-31T01:00:00Z', now), sb.secWhen('', now), sb.secWhen('junk', now)],
    ['Today, 4:20 pm', 'Yesterday, 4:20 pm', '12 Oct, 8:40 pm', 'Today, 1:30 am', '31 Dec 2025, 12:00 pm', '', ''], 'secWhen: today, yesterday, an older day, a UTC date that is already the next day in Sydney, another year');

  // Settings history: where, what, search, people.
  const P = t => { const x = sb.settingsHistParts(t); return [x.where, x.what]; };
  assertEqual([P('Pipeline stages: Quotes idle for 7 days'), P('People: invited Ron (VA)'), P('Granted "Payroll" access for Ron'), P('Note: call the bank'), P('Look and branding: background colour #5b6b82'), P('Security: Face ID / fingerprint added on Ofek\'s Mac'), P('Google review requests: asking 2 days after the job'), P('Role defaults: Ron gets Jobs'), P(null), P('Lead sources:no space')],
    [['Pipeline stages', 'Quotes idle for 7 days'], ['People', 'invited Ron (VA)'], ['Settings', 'Granted "Payroll" access for Ron'], ['Settings', 'Note: call the bank'], ['Look and branding', 'background colour #5b6b82'], ['Security', 'Face ID / fingerprint added on Ofek\'s Mac'], ['Google review requests', 'asking 2 days after the job'], ['Role defaults', 'Ron gets Jobs'], ['Settings', ''], ['Settings', 'Lead sources:no space']],
    'settingsHistParts: a known page name before ": " is where; anything else is Settings');
  const H = [
    { actor: 'Ofek Shamir', where: 'Pipeline stages', what: 'Quotes idle for 7 days', at: '2026-10-14T01:00:00Z' },
    { actor: 'Noam Gal', where: 'People', what: 'invited Ron (VA)', at: '2026-10-13T01:00:00Z' },
    { actor: 'Ofek Shamir', where: 'Settings', what: 'Granted "Payroll" access for Ron', at: '2026-10-01T01:00:00Z' },
    { actor: 'Ron', where: 'Tags', what: 'Callback colour', at: '2026-09-01T01:00:00Z' },
    { actor: 'Noam Gal', where: 'Security', what: 'turned on two-step sign-in', at: '2026-10-14T02:00:00Z' },
    { actor: 'Ofek Shamir', where: 'Look and branding', what: 'background colour', at: '2026-10-14T03:00:00Z' },
    { actor: 'Ron', where: 'Tags', what: 'x', at: 'junk' },
    { actor: 'Dolev', where: 'Tags', what: 'y', at: '2026-10-14T03:00:00Z' },
  ];
  const F = (q, who) => sb.settingsHistFilter(H, q, who).map(r => r.what);
  assertEqual([F('', 'all'), F('PEOPLE', 'all'), F('noam', 'all'), F('ron', 'all'), F('', 'Noam Gal'), F('ron', 'Noam Gal'), F('nothing like it', 'all'), F('  ', undefined).length],
    [H.map(r => r.what), ['invited Ron (VA)'], ['invited Ron (VA)', 'turned on two-step sign-in'], ['invited Ron (VA)', 'Granted "Payroll" access for Ron', 'Callback colour', 'x'], ['invited Ron (VA)', 'turned on two-step sign-in'], ['invited Ron (VA)'], [], 8],
    'settingsHistFilter: searches what, where and who (any case); the person chip keeps that person only');
  assertEqual([sb.secHistChips(H), sb.secHistChips([]), sb.secHistChips([{ actor: '' }, { actor: 'Zed' }, { actor: 'Amy' }])], [['Ofek Shamir', 'Noam Gal', 'Ron'], [], ['Amy', 'Zed']], 'secHistChips: the 3 people with the most changes, a tie by name, no empty name');
  const rn = Date.parse('2026-10-14T12:00:00Z');
  assertEqual(sb.secRecentCount([{ at: new Date(rn - 14 * 864e5).toISOString() }, { at: new Date(rn - 14 * 864e5 - 1000).toISOString() }, { at: new Date(rn - 3600e3).toISOString() }, { at: 'junk' }, {}], rn), 2, 'secRecentCount: changes in the last 14 days (the boundary counts)');
  assertEqual(['wrong-password', 'wrong-code', 'too-many', 'not-fresh', 'expired', 'not-verified', 'not-found', 'no-passkey', 'locked', 'already', 'server', undefined].map(sb.secReasonText),
    ['That password didn\'t work.', 'That code didn\'t work. Try the new one the app shows.', 'Too many tries. Wait 15 minutes and try again.', 'Signing in with Google again didn\'t finish in time. Try again.', 'That took too long. Try again.', 'Face ID / fingerprint couldn\'t be checked. Try again, or use your password.', 'This device\'s Face ID / fingerprint was removed. Use your password, then set it up again.', 'This device\'s Face ID / fingerprint was removed. Use your password, then set it up again.', 'Security locked again. Unlock it first.', 'Face ID / fingerprint is already set up on this device.', 'Something went wrong. Try again.', 'Something went wrong. Try again.'],
    'secReasonText: a plain sentence for every answer of the server');

  // setBlock: the new right-hand slot, and the old markup exactly when it isn't used.
  assertEqual(sb.setBlock('Signing in', '', '<x>'), '<div class="set-block"><div class="set-block-head"><h3>Signing in</h3></div><x></div>', 'setBlock: without a right-hand part the markup is as before');
  assertEqual(sb.setBlock('Settings history', 'Who & when', '<x>', '<span class="hint">3 changes</span>'), '<div class="set-block"><div class="set-block-head has-right"><div><h3>Settings history</h3><p>Who &amp; when</p></div><span class="hint">3 changes</span></div><x></div>', 'setBlock: a right-hand part sits in the head');

  // The page wiring (read from the page's own code).
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8'), script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const settingsFn = extractDecl(script, 'renderSettings'), page = extractDecl(script, 'renderSecurityPage'), unlocked = extractDecl(script, 'renderSecurityUnlocked');
  assertEqual([script.includes('openSettingsActivityModal'), /Settings history has moved to <a href="#" onclick="setSettingsPage\('security'\)/.test(settingsFn), /titleExtra: \(\) => secUnlocked\(\) \? pill\('good', 'Unlocked'\) : pill\('neutral', 'Locked'\)/.test(settingsFn), settingsFn.includes("${cur.titleExtra ? ' ' + cur.titleExtra() : ''}")],
    [false, true, true, true], 'Settings history moved from Data to Security; the Security title says Locked / Unlocked');
  assertEqual([/return secUnlocked\(\) \? renderSecurityUnlocked\(\) : renderSecurityLock\('page'\);/.test(page), (script.match(/renderSecurityUnlocked\(/g) || []).length], [true, 2], 'Security: nothing of the unlocked page is drawn unless this session is unlocked');
  assertEqual(['secLockNow()', 'openPasskeySetup()', 'removePasskey(', 'openChangePasswordModal()', 'signOutEverywhere()', 'togglePresentationMode()', 'openViewAsModal()', 'secHistInput(this.value)', "setSettingsPage('people')"].filter(x => !unlocked.includes(x)), [], 'Security, unlocked: lock now, set up / remove a key, signing in, showing the app, the history and the People note');
  assertEqual([unlocked.includes("The office assistant\\'s automatic log-out"), extractDecl(script, 'renderShell').includes('openViewAsModal()')], [false, false], 'Security: the auto log-out row became the note to People; View as is still not in the main menu');
  // "Export everything" (the old JSON of the screen's data) was replaced by Export to Excel + Full backup (group E, 14 Oct).
  assertEqual([script.includes('exportDataAsJson'), script.includes('exportDataFile'), extractDecl(script, 'logSettingsActivity').includes('SEC.hist.unshift')], [false, false, true], 'the old Export everything is gone; a new change shows in the open history at once');
  assertEqual([extractDecl(script, 'turnOffMfa').includes("title: 'Turn off two-step sign-in?'"), extractDecl(script, 'turnOffMfa').includes('readOnlyReason()')], [true, true], 'two-step off: the approved wording, and not in a read-only mode');
}

// Settings → Data (14 Oct, approved mockup round2-data-security): the Full backup block's states, and opening a locked
// weekly backup in the browser. The locked files here are made with node:crypto from the format text (not by the app's
// own code), so these tests prove the format.
// Settings → Data → Export to Excel (14 Oct, item 5, M6 answers 1 and 6): the areas, the sensitive columns, the cells
// and sheets Excel accepts, the counts on the cards, and reading big tables 1,000 rows at a time.
async function testDataExport(sb){
  console.log('\nSettings → Data: Export to Excel');
  const A = Array.from(sb.EXPORT_AREAS);
  assertEqual(A.map(a => a.id), ['leads', 'jobs', 'closings', 'payroll', 'employees', 'contractors', 'expenses', 'tasks', 'convos', 'shifts', 'reviews', 'ads', 'organic', 'settings', 'ghl'], 'EXPORT_AREAS: the 15 areas, in the mockup\'s order');
  assertEqual(new Set(A.map(a => a.id)).size, 15, 'EXPORT_AREAS: ids are unique');
  assertEqual(A.filter(a => a.name.length > 31 || /[:\\/?*[\]]/.test(a.name)).map(a => a.name), [], 'EXPORT_AREAS: every name is a valid sheet name (31 characters at most, none of : \\ / ? * [ ])');
  assertEqual(A.filter(a => a.off).map(a => a.id), ['ghl'], 'EXPORT_AREAS: only the GHL archive is off by default');
  assertEqual(A.filter(a => a.sens).map(a => [a.id, a.sens]), [['payroll', 'owner salaries'], ['employees', 'bank, ABN'], ['contractors', 'bank, ABN']], 'EXPORT_AREAS: the sensitive labels (no TFN: the app stores none)');
  const parts = A.flatMap(a => a.parts.map(p => ({ ...p, area: a.id })));
  assertEqual(parts.filter(p => p.sensOnly).map(p => p.title), ['Owner salaries'], 'EXPORT_AREAS: owner salaries is the only sensitive-only part');
  assertEqual(parts.filter(p => p.table && !(Array.isArray(p.keys) && p.keys.length)).length, 0, 'EXPORT_AREAS: every table part has paging keys');
  assertEqual(parts.filter(p => p.sensCols).map(p => [p.table, p.sensCols]), [['contractor_private', ['agreement']]], 'EXPORT_AREAS: the agreement text (it names the ABN) is left out without the sensitive tick');
  assertEqual([...sb.exportDefaultSelection()], ['leads', 'jobs', 'closings', 'payroll', 'employees', 'contractors', 'expenses', 'tasks', 'convos', 'shifts', 'reviews', 'ads', 'organic', 'settings'], 'exportDefaultSelection: 14 areas, not the GHL archive');

  // Columns: secrets never, bank / ABN / TFN only with the sensitive tick.
  const H = sb.exportHiddenColumn;
  assertEqual(['token_hash', 'ip_hash', 'sign_token', 'sign_token_expires', 'password'].map(c => [H(c, false), H(c, true)]), [[true, true], [true, true], [true, true], [true, true], [true, true]], 'exportHiddenColumn: token and hash columns are never exported');
  assertEqual(['bank_account', 'bank_bsb', 'bank_name', 'bank_details', 'abn', 'tfn'].map(c => [H(c, false), H(c, true)]), Array(6).fill([true, false]), 'exportHiddenColumn: bank, ABN and TFN only with the sensitive tick');
  assertEqual(['banking_notes', 'full_name', 'hashtag'].map(c => [H(c, false), H(c, true)]), Array(3).fill([false, false]), 'exportHiddenColumn: look-alike names stay');
  assertEqual(['full_name', 'utm_source', 'id', 'includes_gst', 'bank_bsb', 'ga4_sessions'].map(sb.exportHeader), ['Full name', 'UTM source', 'ID', 'Includes GST', 'Bank BSB', 'GA4 sessions'], 'exportHeader');

  // Cells.
  const C = sb.exportCell;
  assertEqual([C(null), C(undefined), C(true), C(false), C(12.5), C(0), C(['a', 'b']), C({ x: 1 })], ['', '', 'Yes', 'No', 12.5, 0, 'a, b', '{"x":1}'], 'exportCell: empty, yes/no, numbers, lists, objects');
  assertEqual([C('data:image/png;base64,AAA'), C({ sig: 'data:image/png;base64,AAA' })], ['[file, in the full backup]', '{"sig":"[file, in the full backup]"}'], 'exportCell: a file inside the data is named, not copied');
  const long = C('x'.repeat(40000));
  assertEqual([long.length <= 32767, long.endsWith('(cut: too long for one Excel cell; whole in the full backup)')], [true, true], 'exportCell: a cell is cut to what Excel holds, with a note');
  assertEqual(C('=HYPERLINK("x")'), '=HYPERLINK("x")', 'exportCell: text that looks like a formula stays text');
  assertEqual(sb.exportActivityText([{ at: '2026-10-02T10:00:00Z', actor: 'Ofek', text: 'Booked' }, { at: '2026-10-01T09:05:12Z', actor: 'Ron', text: 'Called' }]), '2026-10-01 09:05 · Ron · Called\n2026-10-02 10:00 · Ofek · Booked', 'exportActivityText: oldest first, one line each');
  assertEqual(sb.exportActivityText([]), '', 'exportActivityText: no lines');

  // Sheets.
  const rows = [{ id: 1, full_name: 'Sarah', bank_account: '123' }, { id: 2, full_name: 'Tom', bank_account: '456' }];
  assertEqual(sb.exportSheetAoa([{ table: 'employees', rows }], false), [['ID', 'Full name'], [1, 'Sarah'], [2, 'Tom']], 'exportSheetAoa: one section, bank left out');
  assertEqual(sb.exportSheetAoa([{ table: 'employees', rows }], true), [['ID', 'Full name', 'Bank account'], [1, 'Sarah', '123'], [2, 'Tom', '456']], 'exportSheetAoa: with the sensitive tick the bank is in');
  assertEqual(sb.exportSheetAoa([{ table: 't', rows: [{ a: 1 }, { b: 2, a: 3 }] }], false), [['A', 'B'], [1, ''], [3, 2]], 'exportSheetAoa: every column, in first-seen order, empty where a row has none');
  assertEqual(sb.exportSheetAoa([{ title: 'Tasks', table: 'tasks', rows: [{ id: 1 }] }, { title: 'Reminders', table: 'manual_reminders', rows: [] }], false), [['Tasks'], ['ID'], [1], [], ['Reminders'], ['(nothing yet)'], []], 'exportSheetAoa: several sections, each with its title; an empty one says so');
  assertEqual(sb.exportSheetAoa([{ table: 'jobs', rows: [] }], false), [['(nothing yet)']], 'exportSheetAoa: an empty area');
  assertEqual(sb.exportSheetAoa([{ title: 'Agreements', table: 'contractor_private', sensCols: ['agreement'], rows: [{ supplier_id: 's1', agreement: { html: 'ABN 1' }, sign_token: 'x' }] }], false), [['Supplier ID'], ['s1']], 'exportSheetAoa: the agreement and the signing link are left out without the tick');
  assertEqual(sb.exportSheetAoa([{ rows: [{ Setting: 'ABN', Value: '12 345' }] }], false), [['Setting', 'Value'], ['ABN', '12 345']], 'exportSheetAoa: the Settings rows keep their own headings (and the business ABN)');
  const w = sb.exportColWidths([['ID', 'x'.repeat(100)], [1, 'abc'], ['line one\nmuch longer second line']]);
  assertEqual(w.map(x => x.wch), [23, 60], 'exportColWidths: the longest line, between 8 and 60');
  assertEqual(sb.exportColWidths([['a']]).map(x => x.wch), [8], 'exportColWidths: at least 8');
  { const used = []; assertEqual([sb.exportSheetName('a/b:c', used), sb.exportSheetName('x'.repeat(40), used), sb.exportSheetName('Jobs', used), sb.exportSheetName('jobs', used), sb.exportSheetName('JOBS', used)], ['abc', 'x'.repeat(31), 'Jobs', 'jobs (2)', 'JOBS (3)'], 'exportSheetName: bad characters dropped, 31 characters, no duplicate in any case'); }
  { const used = []; const a = sb.exportSheetName('y'.repeat(31), used), b = sb.exportSheetName('y'.repeat(31), used); assertEqual([a.length, b.length <= 31, b.endsWith(' (2)')], [31, true, true], 'exportSheetName: a 31-character duplicate stays within 31 with its number'); }

  // The Settings, pay and owner salary rows.
  const set = sb.settingsExportRows({ id: 1, owner_salaries: { Ofek: 1200 }, abn: '12 345', company_name: 'X', catalog: { pay: { hourly: [{ from: '2026-10-01', rate: 10 }], hebrew: { Guy: true }, jobTypes: { Guy: ['Aircon'] }, extraKey: 3 }, tags: [{ tag: 'Complaint' }], connectors: {} } });
  assertEqual(set.map(r => r.Setting), ['ABN', 'Company name', 'Pay: job types per technician', 'Pay: extra key', 'Tags', 'Connectors'], 'settingsExportRows: no ID, owner salaries or pay figures; the other pay settings (job types per technician) are kept; the business ABN stays');
  assertEqual(set.map(r => r.Value), ['12 345', 'X', '{"Guy":["Aircon"]}', 3, '[{"tag":"Complaint"}]', '{}'], 'settingsExportRows: the values (no hourly rate anywhere in the sheet)');
  assertEqual(sb.settingsExportRows({ catalog: { pay: 'junk' } }), [], 'settingsExportRows: a broken pay setting adds nothing');
  assertEqual(sb.payRateRows({ hourly: [{ from: '2026-10-05', rate: 12, tiers: [{ min: 8, bonus: 15 }] }, { from: '2026-09-01', rate: 10 }], hebrew: { Guy: 'גיא' } }),
    [{ From: '2026-09-01', 'Rate per hour': 10, 'Booking bonus': '' }, { From: '2026-10-05', 'Rate per hour': 12, 'Booking bonus': '8+ bookings: $15' }, { From: 'Hebrew pay messages', 'Rate per hour': '', 'Booking bonus': 'Guy' }], 'payRateRows: oldest first, the numbers kept, then who gets Hebrew');
  assertEqual([sb.payRateRows(undefined), sb.payRateRows({})], [[], []], 'payRateRows: nothing saved');
  assertEqual(sb.ownerSalaryRows({ Ofek: 1200, Noam: '1200' }), [{ Owner: 'Ofek', 'Weekly salary': 1200 }, { Owner: 'Noam', 'Weekly salary': 1200 }], 'ownerSalaryRows');
  assertEqual(sb.ownerSalaryRows(null), [], 'ownerSalaryRows: none');

  // The cards' count lines, the file name and the summary.
  assertEqual([sb.countWord(1, 'job', 'jobs'), sb.countWord(1438, 'card', 'cards'), sb.countWord(0, 'job', 'jobs')], ['1 job', '1,438 cards', '0 jobs'], 'countWord');
  const data = { contacts: [{ activityLog: [1, 2, 3] }, { activityLog: [1] }], payrollWeeks: [{ weekKey: '2026-10-04' }, { weekKey: '2026-10-04' }, { weekKey: '2026-10-11' }], salesLogs: [{}], jobs: [{}], employees: [{}, {}], suppliers: [{}], equipmentSpend: [], equipmentCatalog: [{}], tasks: [{}], manualReminders: [], adSpend: [{}, {}], adCalls: [{}] };
  const T = (id, counts) => sb.exportCountText(id, data, counts);
  assertEqual([T('leads', null), T('payroll', null), T('jobs', null), T('employees', null), T('expenses', null), T('tasks', null), T('settings', null)], ['2 cards · 4 activity lines', '2 weeks · 1 sales log', '1 job', '2 people', '0 expenses · 1 item', '1 task · 0 reminders', 'One row per setting'], 'exportCountText: from what the app holds');
  assertEqual([T('convos', null), T('convos', { chat_sessions: null, lead_messages: 5 }), T('convos', { chat_sessions: 2, lead_messages: 1 }), T('ghl', { ghl_archive: 4602 }), T('ads', { ads_stats: 10 }), T('ads', { ads_stats: null })], ['Counting…', '', '2 conversations · 1 message', '4,602 contacts', '13 rows', ''], 'exportCountText: from the counts; still counting; could not be read');
  sb.STATE.data.settings.companyName = 'The Guys Service Group';
  assertEqual(sb.exportFileName('export', '2026-10-14'), 'the-guys-service-group-export-2026-10-14.xlsx', 'exportFileName: the business name');
  sb.STATE.data.settings.companyName = '';
  assertEqual(/^[a-z0-9]+(-[a-z0-9]+)*-export-2026-10-14\.xlsx$/.test(sb.exportFileName('export', '2026-10-14')), true, 'exportFileName: no name saved still gives a clean name');
  sb.STATE.data.settings.companyName = '!!!';
  assertEqual(sb.exportFileName('export', '2026-10-14'), 'ops-service-export-2026-10-14.xlsx', 'exportFileName: a name with no letters');
  sb.STATE.data.settings.companyName = 'The Guys Service Group';
  assertEqual([sb.exportSummaryHtml(0, false), sb.exportSummaryHtml(1, false), sb.exportSummaryHtml(3, true)], ['Tick at least one area.', '<b>One Excel file</b>, 1 sheet, one per area.', '<b>One Excel file</b>, 3 sheets, one per area, with sensitive details.'], 'exportSummaryHtml');

  // A card.
  const emp = A.find(a => a.id === 'employees'), ghl = A.find(a => a.id === 'ghl');
  const off = sb.exportCardHtml(emp, true, false, '2 people'), on = sb.exportCardHtml(emp, true, true, '2 people'), g = sb.exportCardHtml(ghl, sb.exportDefaultSelection().has('ghl'), false, '');
  assertEqual([off.includes('<span class="pill neutral">Left out: bank, ABN</span>'), on.includes('<span class="pill warn">Includes bank, ABN</span>'), off.includes(`onchange="setExportArea('employees', this.checked)"`), off.includes(' checked'), g.includes(' checked'), g.includes('class="ex-card"')], [true, true, true, true, false, true], 'exportCardHtml: the sensitive pill, the handler, the GHL card unticked');
  { const cv = sb.exportCardHtml(A.find(a => a.id === 'convos'), false, false, ''); assertEqual([/<span class="ex-note">Chats answered in GHL aren.{1,6}t here until the website chat moves to OPS\.<\/span>/.test(cv), cv.includes(' checked')], [true, false], 'exportCardHtml: the note on Conversations; an unticked card'); }

  // Reading big tables page by page.
  const fake = (total, failAt) => {
    const log = [];
    return { log, from(t){ const ops = []; const q = {
      select(){ ops.push('select'); return q; }, eq(c, v){ ops.push(`eq:${c}=${v}`); return q; }, order(k, o){ ops.push(`order:${k}:${o && o.ascending}`); return q; },
      range(a, z){ log.push({ t, a, z, ops: ops.slice() }); if (log.length === failAt) return Promise.resolve({ data: null, error: { message: 'boom' } });
        const n = Math.max(0, Math.min(z, total - 1) - a + 1); return Promise.resolve({ data: Array.from({ length: n }, (_, i) => ({ id: a + i })), error: null }); } }; return q; } };
  };
  { const c = fake(2350); const r = await sb.exportFetchAll(c, 'organic_stats', ['at', 'profile_id'], ['record_kind', 'contact']);
    assertEqual([r.data.length, r.error, c.log.map(x => [x.a, x.z])], [2350, null, [[0, 999], [1000, 1999], [2000, 2999]]], 'exportFetchAll: 2,350 rows in 3 pages');
    assertEqual(c.log.every(x => JSON.stringify(x.ops) === JSON.stringify(['select', 'eq:record_kind=contact', 'order:at:true', 'order:profile_id:true'])), true, 'exportFetchAll: the filter and each order key on every page, in order'); }
  { const c = fake(5000, 2); const r = await sb.exportFetchAll(c, 'x', ['id']); assertEqual([r.data.length, r.error && r.error.message, c.log.length], [1000, 'boom', 2], 'exportFetchAll: an error on page 2 returns the first 1,000 and the error'); }
  { const c = fake(1000); const r = await sb.exportFetchAll(c, 'x', ['id']); assertEqual([r.data.length, c.log.length], [1000, 2], 'exportFetchAll: exactly 1,000 rows asks once more, gets none, and stops'); }

  // The page wiring (read from the page's own code).
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8'), script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const page = extractDecl(script, 'renderDataPage'), block = extractDecl(script, 'renderExportBlock');
  assertEqual([page.indexOf('There are no automatic daily backups') < page.indexOf('renderExportBlock()'), page.indexOf('renderExportBlock()') < page.indexOf('renderFullBackupBlock()')], [true, true], 'Data page: the note, then Export to Excel, then the Full backup');
  assertEqual(['Select all', 'Clear', 'areas ticked', 'Include sensitive details (bank, ABN, owner salaries)', 'It unticks itself after each download.', 'For this download only: the Excel will have bank details, ABN and owner salaries.', 'Download Excel (one sheet per area)', "'ex-block'", 'id="dx-go"'].filter(x => !block.includes(x)), [], 'Export to Excel: the mockup\'s controls and wording');
  assertEqual([/TFN/.test(block), /const XLSX_SCRIPT = 'https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/xlsx\/0\.18\.5\/xlsx\.mini\.min\.js'/.test(script), extractDecl(script, 'ensureXlsx').includes('XLSX_LIB = null')], [false, true, true], 'no TFN in the wording; SheetJS 0.18.5 from cdnjs, loaded when needed and retried after a failure');
  const dl = extractDecl(script, 'downloadDataExcel');
  assertEqual([dl.indexOf('readOnlyReason()') < dl.indexOf('ensureXlsx()'), dl.includes('DATA_EXPORT.sens = false; render();\n    secEnsureUnlocked('), /finally \{[^}]*DATA_EXPORT\.sens = false/.test(dl), dl.includes("logSettingsActivity(")], [true, true, true, true], 'the download: read-only check first, the step-up again when it ran out, the tick unticks after every download, one history line');
  assertEqual([extractDecl(script, 'setSettingsPage').includes("if (id!=='data') DATA_EXPORT.sens = false;"), extractDecl(script, 'closeSettingsPage').includes('DATA_EXPORT.sens = false'), extractDecl(script, 'render').includes('if (DATA_EXPORT.sens && !dataPageOpen()) DATA_EXPORT.sens = false;')], [true, true, true], 'leaving Data unticks the sensitive details (also through the main menu: every render off Data clears it)');
  assertEqual(sb.setBlock('A', '', '<x>', '', 'ex-block'), '<div class="set-block ex-block"><div class="set-block-head"><h3>A</h3></div><x></div>', 'setBlock: an extra class on the block');
}

async function testFullBackup(sb){
  console.log('\nSettings → Data: the full backup and "Open a locked backup"');
  const nodeCrypto = require('crypto'), zlib = require('zlib');
  Object.assign(sb, { crypto: globalThis.crypto, TextEncoder, TextDecoder, Response, Blob, DecompressionStream });
  assertEqual(['info@theguyservicegroup.com', 'a.b-c@x.co'].map(sb.backupEmailOk), [true, true], 'backupEmailOk: real addresses');
  assertEqual(['', 'a@b', 'a b@c.com', 'x'.repeat(250) + '@b.co', null].map(sb.backupEmailOk), [false, false, false, false, false], 'backupEmailOk: empty, no dot, a space, 255 characters');
  assertEqual(Array.from(sb.BACKUP_DAY_ORDER).map(sb.backupDayLabel), ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'], 'the day list runs Monday to Sunday');
  assertEqual([sb.backupWhenText('2026-10-10T16:00:00Z'), sb.backupWhenText('2026-10-19T02:30:00Z'), sb.backupDateText('2026-10-25T16:07:00Z'), sb.backupWhenText('x')], ['Sunday 11 Oct, 3:00 am', 'Monday 19 Oct, 1:30 pm', 'Monday 26 Oct', ''], 'backupWhenText (Sydney time)');
  assertEqual([0, 900, 2048, 3.2 * 1024 * 1024, 2.5 * 1024 ** 3].map(sb.backupSizeText), ['0 B', '900 B', '2 KB', '3.2 MB', '2.50 GB'], 'backupSizeText');
  assertEqual([sb.BACKUP_TABLE_LABELS.contacts, sb.BACKUP_TABLE_LABELS.ghl_archive, sb.BACKUP_BUCKET_LABELS['job-attachments']], ['Leads & customers', 'GHL archive (old contacts)', 'Job files and receipts'], 'labels for the areas and the uploaded files');
  assertEqual(sb.backupZipPath('job-attachments', '/../a/./b/../c.png'), 'files/job-attachments/a/b/c.png', 'a storage path stays inside the zip');

  const NOW = Date.parse('2026-10-18T05:00:00Z');
  const cfg = { email: 'info@theguyservicegroup.com', day: 0, time: '03:00', updated_at: '2026-10-01T00:00:00Z' };
  const view = st => sb.backupStatusView(st, NOW);
  const L = v => [v.head.tone, v.head.label, v.pw.tone, v.pw.label, v.last.tone, v.last.label, v.last.desc];
  assertEqual(L(view(null)).slice(0, 2).concat([view({ loading: true }).inputsOff]), ['neutral', 'Checking…', true], 'loading: Checking…, the boxes are off');
  const nsu = view({ error: 'not_set_up' });
  assertEqual([nsu.head.label, nsu.last.desc, nsu.inputsOff, nsu.downloadOff], ['Not set up yet', 'The weekly backup isn\'t switched on yet.', true, true], 'not set up: says so, boxes and download off');
  const np = view({ ok: true, passwordSet: false, timerOk: true, config: cfg, nextAt: '2026-10-24T16:00:00Z', last: null });
  assertEqual(L(np), ['warn', 'Waiting for your password', 'warn', 'Waiting for you', 'neutral', 'Not yet', 'Nothing yet. The first one goes out on the first Sunday after the password is set.'], 'password not set: the mockup\'s words');
  assertEqual(np.pw.desc, 'Your step: add a secret called BACKUP_PASSWORD in Supabase (Edge Functions, then Secrets). We never see it. Nothing is sent until it is set.', 'password not set: the owner step');
  const ps = view({ ok: true, passwordSet: true, timerOk: true, config: cfg, nextAt: '2026-10-24T16:00:00Z', last: null });
  assertEqual(L(ps), ['good', 'Weekly email on', 'good', 'Password set', 'neutral', 'Not yet', 'Nothing yet. The first one goes out on Sunday 25 Oct, 3:00 am.'], 'password set, nothing sent yet');
  assertEqual([ps.pw.desc, ps.timerNote, ps.inputsOff], ['With the password you set in Supabase (we never see it). Keep it in your password manager: without it the file can\'t be opened.', '', false], 'password set: the mockup\'s description');
  const nt = view({ ok: true, passwordSet: true, timerOk: false, config: cfg, nextAt: null, last: null });
  assertEqual([nt.head.tone, nt.head.label, nt.timerNote], ['warn', 'Weekly timer not running', ' The weekly timer isn\'t running yet: it needs the backup timer secret (owner step).'], 'timer not running: a warning and the owner step');
  const done = { status: 'done', started_at: '2026-10-17T16:00:00Z', finished_at: '2026-10-17T16:07:00Z', email_to: 'owner@example.com', email_status: 'sent', email_queued_at: '2026-10-17T16:07:00Z', links_expire_at: '2026-10-24T16:07:00Z' };
  assertEqual(L(view({ ok: true, passwordSet: true, timerOk: true, config: cfg, last: done })).slice(4), ['good', 'Sent', 'Sunday 18 Oct, 3:07 am, to owner@example.com · download link sent (works until Sunday 25 Oct).'], 'sent: the link wording (not "attached")');
  assertEqual(L(view({ ok: true, passwordSet: true, timerOk: true, config: cfg, last: { ...done, email_status: 'queued', email_queued_at: new Date(NOW - 3600e3).toISOString() } })).slice(4, 6), ['neutral', 'Sending'], 'queued under 2 hours: Sending');
  assertEqual(L(view({ ok: true, passwordSet: true, timerOk: true, config: cfg, last: { ...done, email_status: 'queued' } })).slice(4), ['warn', 'Not sent yet', 'Sunday 18 Oct, 3:07 am, to owner@example.com · the email hasn\'t gone out yet: the info@ sender may be stopped.'], 'queued over 2 hours: warns');
  assertEqual(L(view({ ok: true, passwordSet: true, timerOk: true, config: cfg, last: { status: 'failed', started_at: '2026-10-17T16:00:00Z', finished_at: '2026-10-17T17:00:00Z', error: 'database down' } })).slice(4), ['bad', 'Failed', 'The last one didn\'t finish (Sunday 18 Oct, 4:00 am): database down. It tries again by itself.'], 'failed');
  assertEqual(L(view({ ok: true, passwordSet: true, timerOk: true, config: cfg, last: { status: 'running', started_at: '2026-10-17T16:00:00Z' } })).slice(4), ['neutral', 'In progress', 'Being made now (started Sunday 18 Oct, 3:00 am).'], 'running');
  assertEqual(view({ ok: true, passwordSet: true, timerOk: true, config: { ...cfg, day: 3, time: '23:30' }, last: null }).when, { email: 'info@theguyservicegroup.com', day: 3, time: '23:30' }, 'the saved day, time and address');

  // Locked files made with node:crypto, straight from the format text.
  const PW = 'a long backup passphrase', ITER = 100000;
  const seal = (kind, plain, pw, salt) => {
    const iv = nodeCrypto.randomBytes(12), header = Buffer.alloc(40);
    header.write('TGBKUP', 0, 'ascii'); header[6] = 1; header[7] = kind; header.writeUInt32BE(ITER, 8); salt.copy(header, 12); iv.copy(header, 28);
    const key = nodeCrypto.pbkdf2Sync(Buffer.from(pw, 'utf8'), salt, ITER, 32, 'sha256');
    const c = nodeCrypto.createCipheriv('aes-256-gcm', key, iv); c.setAAD(header);
    return new Uint8Array(Buffer.concat([header, c.update(plain), c.final(), c.getAuthTag()]));
  };
  const salt = nodeCrypto.randomBytes(16);
  const dataObj = { format: 'the-guys-backup', version: 1, kind: 'weekly', created_sydney: 'Sunday 18 Oct 2026, 3:07 am', files: [], tables: { contacts: [{ id: 'c1', full_name: '<b>Sarah</b>' }] }, counts: { contacts: 1 } };
  const lockedData = seal(1, zlib.gzipSync(Buffer.from(JSON.stringify(dataObj))), PW, salt);
  const head = Buffer.from(JSON.stringify({ v: 1, id: '20261018-abcd1234', files: [{ bucket: 'job-attachments', path: 'r/a.png', type: 'image/png', size: 3, offset: 0 }, { bucket: 'branding', path: 'logo.svg', type: 'image/svg+xml', size: 2, offset: 3 }] }));
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(head.length, 0);
  const packPlain = Buffer.concat([lenBuf, head, Buffer.from([1, 2, 3, 9, 8])]);
  const lockedPack = seal(2, packPlain, PW, salt);
  const h = sb.backupParseHeader(lockedData);
  assertEqual([h.kind, h.iterations, Buffer.from(h.salt).equals(salt), h.iv.length, h.header.length, sb.backupParseHeader(lockedPack).kind], [1, ITER, true, 12, 40, 2], 'backupParseHeader reads a node:crypto locked file');
  assertEqual([sb.backupParseHeader(new TextEncoder().encode(JSON.stringify(dataObj))), sb.backupParseHeader(new Uint8Array(10))], [null, null], 'a plain JSON file or a tiny file is not a locked backup');
  { const low = lockedData.slice(); new DataView(low.buffer).setUint32(8, 1000, false); assertEqual(sb.backupParseHeader(low), null, 'iterations outside 100,000-10,000,000 are refused'); }
  const cache = {};
  const plainData = await sb.backupDecrypt(PW, lockedData, cache);
  assertEqual(JSON.parse(await sb.backupGunzipText(plainData)), dataObj, 'backupDecrypt + gunzip give the same JSON');
  assertEqual(Object.keys(cache).length, 1, 'the key is made once for the salt');
  const plainPack = await sb.backupDecrypt(PW, lockedPack, cache);
  assertEqual(Object.keys(cache).length, 1, 'the second file with the same salt reuses the key');
  const pk = sb.backupReadPack(plainPack);
  assertEqual([pk.id, pk.files.map(f => [f.path, f.offset, f.size]), Array.from(plainPack.subarray(pk.start + 3, pk.start + 5))], ['20261018-abcd1234', [['r/a.png', 0, 3], ['logo.svg', 3, 2]], [9, 8]], 'backupReadPack: the files and their offsets');
  let wrong = 'no error';
  try { await sb.backupDecrypt('not the password', lockedData, {}); } catch (e) { wrong = 'rejected'; }
  assertEqual(wrong, 'rejected', 'the wrong password is rejected');
  let tamper = 'no error';
  try { const t = lockedData.slice(); t[7] = 2; await sb.backupDecrypt(PW, t, {}); } catch (e) { tamper = 'rejected'; }
  assertEqual(tamper, 'rejected', 'a changed header byte is rejected (authenticated)');
  { const bad = new Uint8Array(packPlain); new DataView(bad.buffer).setUint32(0, 99999, false); assertEqual(sb.backupReadPack(bad), null, 'a pack header length beyond the buffer → null'); }
  assertEqual(sb.backupReadPack(new Uint8Array(packPlain).slice(0, packPlain.length - 1)), null, 'a file running past the end → null');

  // The page wiring (read from the page's own code).
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8'), script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const page = extractDecl(script, 'renderDataPage'), block = extractDecl(script, 'renderFullBackupBlock'), dl = extractDecl(script, 'downloadFullBackup'), em = extractDecl(script, 'saveBackupEmail'), when = extractDecl(script, 'saveBackupWhen');
  assertEqual([page.indexOf('There are no automatic daily backups') < page.indexOf('renderFullBackupBlock()'), page.indexOf('renderFullBackupBlock()') < page.indexOf('No restore button, on purpose.')], [true, true], 'Data page: the note, the Full backup block, the no-restore note, in that order');
  assertEqual(['Download a full backup now', 'Send it to', 'Day and time', 'Locked with a password', 'Last sent', 'Open a locked backup', 'aria-label="Send the weekly backup to"', 'aria-label="Day"', 'aria-label="Time"', 'openLockedBackup()', "setBlock('Full backup'"].filter(x => !block.includes(x)), [], 'Full backup: the mockup\'s rows and controls, plus Open a locked backup');
  assertEqual([/restore/i.test(block), ['renderDataPage', 'renderFullBackupBlock', 'openLockedBackup', 'renderLockedResult'].some(n => /onclick="[^"]*restore/i.test(extractDecl(script, n))), /function \w*[Rr]estoreBackup/.test(script)], [false, false, false], 'no restore control anywhere on Data or in the open tool');
  assertEqual([dl.includes("backupWithStepUp('Download a full backup'"), em.includes("backupWithStepUp('Change where the weekly backup goes'"), when.includes('backupWithStepUp')], [true, true, false], 'the download and a new address ask for the step-up; day and time don\'t');
  assertEqual([/if \(!f \|\| typeof f\.url!=='string' \|\| !\/\^https:/.test(dl) && dl.indexOf("(no download link)") < dl.indexOf('await fetch(f.url)'), dl.includes('obj.files_missing')], [true, true], 'the download: a file without a link is listed in files-missing.txt and never fetched (fetch(\'\') would save this page)');
  assertEqual([dl.includes('the-guys-full-backup-${day}.zip'), dl.includes('the-guys-full-backup-${day}.json'), extractDecl(script, 'ensureJsZip').includes('JSZIP_SRC'), /const JSZIP_SRC = 'https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/jszip\/3\.10\.1\/jszip\.min\.js'/.test(script)], [true, true, true, true], 'the download: one .zip (or .json without files), JSZip 3.10.1 from cdnjs, loaded when needed');
}

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
testEmployeeCard(loadSandbox());
testCountingNumbers(loadSandbox());
testFieldChecks(loadSandbox());
testLiveRowsAndStageMemo(loadSandbox());
testToastKinds(loadSandbox());
testCatalog(loadSandbox());
testOfficeHours(loadSandbox());
testChaseCountSetting(loadSandbox());
testLostReasonDelete(loadSandbox());
testPipelineStages(loadSandbox());
testConnectedSources(loadSandbox());
testMessageTemplates(loadSandbox());
testReviewSettings(loadSandbox());
testReviewPreview(loadSandbox());
testPhoneSettings(loadSandbox());
testPaySettings(loadSandbox());
testPeopleContractorsEquipment(loadSandbox());
testOrganicBoard(loadSandbox());
testSettingsRound2Small(loadSandbox());
testRegionAndWeeks(loadSandbox());
testBusinessDetails(loadSandbox());
testVaAutoLogout(loadSandbox());
testPeopleTabs(loadSandbox());
testBranding(loadSandbox());
testNotificationCards(loadSandbox());
testConnectors(loadSandbox());
testSecurityFaceId(loadSandbox());

(async () => {
  await testFullBackup(loadSandbox());
  await testDataExport(loadSandbox());
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('business-logic tests crashed:', e); process.exit(1); });
