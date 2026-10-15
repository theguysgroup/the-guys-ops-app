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
  // Region and format: time zone, money, tax name, place, public holidays (T1.2/T1.3, 14 Oct)
  'REGION_DEFAULTS', 'TAX_NAMES', 'BIZ_NUMBER_LABELS', 'MONEY_FORMATS', 'TZ_ALLOWED', 'TZ_FALLBACK', 'TZ_VALID', 'REGION_NONE', 'REGION_MEMO', 'BIZ_WALL', 'BIZ_DAY_MEMO', 'regionNow', 'tzValid', 'regionMemo', 'bizTz', 'bizWall', 'bizDayOf', 'bizDayMemo',
  'bizNowPast', 'bizTzLabel', 'regionCountry', 'regionState', 'regionKeyOf', 'countryName', 'regionPlaceName', 'regionPlaceShort', 'regionWord', 'regionLabels', 'taxName', 'bizNumberLabel', 'currencySymbolOf', 'currencyDecimalsOf', 'moneyCfg', 'moneyText', 'curSym',
  'HOLIDAY_LIB_URL', 'HOLIDAY_SOURCE', 'HOLIDAY_WORDING', 'holidayKey', 'holidaysFromLib', 'holidayDaysOf', 'holidaysStale', 'bizNumberHint', 'invMoney', 'fmtSignedMoney',
  'weekOf', 'monthOf', 'currentWeekKey',
  'jobGst', 'jobTotalCollected', 'amountExGst', 'employeeByName', 'commissionDeductsParts', 'jobCommissionBase', 'jobCommissionAmount', 'commissionRateFor',
  // constants the functions below key off of
  'JOB_TYPES', 'LEAD_DIVISIONS', 'LEAD_SOURCES', 'LEAD_SOURCE_COLOR', 'AIRCON_TYPE_TAGS', 'META_PLATFORM_TAGS', 'LOST_REASONS', 'lostReasonOf', 'SUB_DIVISIONS', 'SUB_SOURCES', 'LEAD_TAGS', 'leadTagOn', 'DIVISION_COLOR', 'divColor', 'leadSubDivisions', 'leadSubSource', 'visibleTags', 'subSourceOptions', 'LEAD_SOURCE_LABEL', 'sourceLabel', 'splitLeadRequestEvent', 'LEAD_STATUSES', 'LEAD_STAGE_LABEL', 'stageLabel', 'STAGES_NEED_DATE', 'PIPELINE_RULES_FROM', 'JOB_CACHE', 'jobIndex', 'leadLatestJobDate', 'leadWonByJob', 'leadStage', 'followupDue', 'leadRulesApply', 'leadNeedsFutureDate', 'isWorkday', 'chaseCounter', 'chaseAlertDue',
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
  'PAYROLL_HOURLY_RATE', 'PAYROLL_BOOKING_BONUS', 'payCatalog', 'payTiersOk', 'payHourlyFor', 'payHebrewNames', 'bookingBonus', 'nextBookingTier',
  'salesLogBookings', 'salesLogPay', 'payrollWeekOf', 'shiftPayrollWeek', 'payrollRangeText', 'payMoney', 'jobPaidDate',
  'computePayrollCommission', 'computePayrollHourly', 'buildCommissionPayMessage', 'buildHourlyPayMessage', 'shiftDays',
  'PAYROLL_REMINDERS_FROM', 'payrollStatus', 'payrollCommissionPeople', 'payrollHourlyPeople', 'paymentTermDays', 'jobDaysWaiting', 'jobIsLate',
  'computeNetProfit',
  // dashboard
  'localDay', 'GOOGLE_ADS_AIRCON_ACCOUNT', 'callDivision', 'summarizeCalls', 'DASH_RANGES', 'resolveDashboardRange',
  // sales automations + My Day
  'fmtMoney', 'workClockDue', 'NEW_LEAD_ALERT_FROM', 'leadArrivedAt', 'newLeadUnhandled', 'chaseTooLong', 'quoteStale', 'bookedNoJob', 'MY_DAY_NEW_DAYS', 'myDayLists',
  // My Day counters (3 Oct)
  'esc', 'quoteDueReason', 'shiftDaySummary', 'latePaymentDue', 'latePaymentDoneToday', 'reofferDue', 'assigneeNames', 'taskAssignedTo', 'myTaskDue', 'teamTaskDue', 'MD_BUBBLES', 'MD_HE', 'mdTaskLines', 'DIV_HE', 'MD_FROM_HE', 'mdBookingLinesHe', 'mdPeriodBubbles', 'mdCounts', 'mdStoredCounts', 'mdWeekCounts', 'mdBookingsTable', 'chasingLostStats',
  // message templates (12 Oct)
  'jobTypesForTech',
  'EQUIPMENT_CATEGORY_DEFAULTS', 'equipmentCategories', 'equipmentCategoryOf', 'contractorDealAmount', 'contractorDealLine', 'contractorDealNote', 'contractorStatusFromPrivate', 'contractorAgreementHtml', 'contractorAgreementInputs', 'ROLE_LABEL', 'roleLabel', 'peopleList', 'personActive', 'personRoles', 'personInGroup', 'ownerLoginsWithoutCard',
  'ORG_CTR', 'orgExpectedCtr', 'ORG_CLEAN_FROM', 'orgPath', 'orgWindow', 'orgIsLead', 'orgLeadStats', 'ORG_EV_LABEL', 'orgEvidenceText',
  'PHONE_MENU_DEFAULT', 'phoneMenuOf', 'phoneMenuText', 'phoneSayDefault', 'phoneRingSeconds', 'phoneE164', 'phonePretty', 'PHONE_BACKUP_DAY', 'phoneBackupHours', 'phoneBackupDayOk', 'phonePersonKeyFor',
  'BIZ_TPL_VAR', 'REVIEW_TPL_VARS', 'CHAT_TPL_VARS', 'MSG_TEMPLATES', 'msgTemplateText', 'fillTemplate', 'SMS_GSM', 'smsParts', 'templateProblems',
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
  'adsConvKind', 'adsOwnNames', 'adsConvShortName', 'adsTracking',
  // The nightly lead check: info@ emails vs the app (9 Oct)
  'parseShownNumber', 'formatShownNumber', 'checkPhone', 'checkEmail', 'toastKind', 'OFFICE', 'officeHoursFor', 'nextOfficeDay', 'hhmmToMins', 'minsToHhmm', 'officeHoursText', 'catalogHours', 'catalogObject', 'brandName', 'RULES', 'ACTIVE', 'DIV_LABEL', 'CATALOG', 'LEAD_STAGE_PICKABLE', 'LEAD_STATUS_COLOR', 'LEAD_STATUS_INK', 'stageColor', 'stageInk', 'replaceArr', 'divLabel', 'activeOnly', 'inkFor', 'catalogBase', 'catalogId', 'catalogList', 'catalogRules', 'lostReasonLabel', 'lostReasonCanDelete', 'catalogShown', 'catalogFindByName', 'SOURCE_HOSTS', 'sourceHost', 'sourceSetupSteps', 'sourceLeadStats', 'applyCatalog', 'STAGE_CORE', 'stageOn', 'stagesPickable', 'stagesShown', 'stagesInProgress', 'stageIsBuiltin', 'stageLeadsIn', 'stageStoredOnly', 'stageMovePlan', 'stageListWithNew', 'STAGE_RULE_TEXT', 'CAT_SWATCHES', 'tagColor', 'sameLiveRow', 'sameValue', 'LOCAL_WRITES', 'noteLocalWrite', 'settleLocalWrites',
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
  'connStopsAll', 'connPendingReaders', 'fmtAdsAccount', 'connDayName', 'connWhen', 'connAddonsShown', 'CONN_LOG_SRC', 'connLogRows',
  // Settings > Connectors > Private connector (MCP), stage 5
  'canUseMcp', 'MCP_SETTINGS_DEFAULTS', 'mcpSettingsOf', 'MCP_SETTING_LIMITS', 'mcpSettingProblem', 'mcpUrls', 'mcpTokenLooksRight', 'mcpWhen', 'mcpKeyLists', 'mcpKeyMeta', 'MCP_LOG_STATUS', 'mcpLogStatus',
  'MCP_TOOL_NAMES', 'mcpHostBlocked', 'MCP_RESERVED_HEADERS', 'mcpServerProblems', 'MCP_IMPORT_KINDS', 'MCP_IMPORT_FIELDS', 'MCP_IMPORT_REQUIRED', 'mcpFieldLabel', 'mcpMappingRows', 'mcpMappingFromRows', 'mcpDedupeDefault',
  'mcpPathOk', 'mcpRuleProblems', 'mcpParseArgs', 'mcpArgsTemplate', 'mcpResultData', 'mcpItemsAt', 'mcpSamplePaths', 'mcpPreviewCounts', 'mcpPreviewColumns', 'mcpPreviewText', 'mcpRunLine', 'mcpCanUndo',
  'mcpReasonText', 'mcpLoadErrorText', 'mcpServerMeta', 'mcpRuleMeta',
  // Settings → Security: Face ID / fingerprint (passkeys), the 30-minute lock, Settings history (14 Oct)
  'CAT_NAMES', 'setBlock', 'SEC_LOCK_MINUTES', 'bytesToB64url', 'b64urlToBytes', 'pkCreationOptions', 'pkRequestOptions', 'pkAttestationJSON', 'pkAssertionJSON', 'pkDeviceInfo', 'bioIcoFor', 'secMethodWord',
  'secUnlockMethods', 'lockedBackupLinkOpen', 'SEC_INTENTS', 'secGoogleParse', 'PAY_SETTING_NAMES', 'secLeft', 'secWhen', 'settingsHistParts', 'settingsHistFilter', 'secHistChips', 'secRecentCount', 'secReasonText',
  // Settings → Data: the full backup, the weekly locked backup and "Open a locked backup" (14 Oct)
  'BACKUP_DAY_ORDER', 'BACKUP_TABLE_LABELS', 'BACKUP_BUCKET_LABELS', 'backupEmailOk', 'backupDayLabel', 'backupWhenText', 'backupDateText', 'backupSizeText', 'backupStatusView',
  'backupParseHeader', 'backupReadPack', 'backupDecrypt', 'backupGunzipText', 'backupZipPath', 'backupReasonText',
  // Settings → Data: Export to Excel (14 Oct)
  'pill', 'jsStr', 'EXPORT_AREAS', 'exportDefaultSelection', 'EXPORT_SECRET_COL', 'EXPORT_SENS_COL', 'exportHiddenColumn', 'EXPORT_UPPER_WORDS', 'exportHeader', 'EXPORT_CELL_MAX', 'EXPORT_FILE_TEXT', 'exportCell',
  'exportActivityText', 'exportSheetAoa', 'exportColWidths', 'exportSheetName', 'settingsExportRows', 'payRateRows', 'ownerSalaryRows', 'countWord', 'exportCountText', 'exportFileName', 'exportSummaryHtml', 'exportFetchAll', 'exportCardHtml',
  // the automation engine's "look now" from the app (settings round 2, phase 4)
  'automationEventBody',
  // Automations: the flow view (phase 4, group J)
  'ICONS', 'ico', 'FLOW_MAX_STEPS_DEFAULT', 'FLOW_MAX_STEPS_CEILING', 'FLOW_STEP_KINDS', 'flowRegs', 'flowSafe', 'flowLc', 'flowCap', 'flowLocked', 'flowStepId', 'flowCanMove', 'flowMove',
  'flowInsert', 'flowRemove', 'flowDropIndex', 'flowFormSlots', 'flowIsFormShaped', 'flowCompact', 'flowMaxSteps', 'flowWaitPhrase', 'flowClock', 'flowDaysText', 'flowOfficeWindow', 'flowWindowPhrase',
  'flowValueLabel', 'flowCondPhrase', 'flowIfPhrase', 'flowActionPhrase', 'flowTriggerPhrase', 'flowStepSummary', 'flowSentence', 'flowStepLook', 'flowAvailable', 'flowProblems', 'flowAddMenuItems',
  'flowViewPref', 'setFlowViewPref', 'flowMoveLabel', 'flowViewToggleHtml', 'flowOpenInnerHtml', 'flowMsgHtml', 'flowCanvasHtml', 'flowMoreStepsHtml', 'flowFormSetSlot', 'flowFormSetAction',
  // Automations builder (14 Oct, phase 4)
  'chatRulesApp', 'notifyRulesApp', 'notifyCardsNow', 'setRows', 'setToggle',
  'AUTO_TABLE', 'AUTO_BUSINESS_ID', 'AUTO_TRIGGERS', 'AUTO_MIRROR_TRIGGERS', 'AUTO_CONDS', 'AUTO_OP_WORDS', 'AUTO_ACTIONS', 'AUTO_FIELDS', 'AUTO_WAIT_UNITS', 'AUTO_DUE', 'AUTO_LIMITS', 'AUTO_PUSH_DEFAULT', 'AUTO_TPL_MIRROR',
  'autoTrig', 'autoValueLabel', 'autoCondValues', 'autoCondFits', 'autoFieldsFor', 'autoDefaultPush', 'autoHm', 'autoHhmm', 'autoAndList', 'autoIsCustomerStep', 'autoHasCustomer', 'autoAudience', 'autoCleanStep', 'autoNormalize',
  'autoPeopleText', 'autoTaskWho', 'autoDueText', 'autoHoursShort', 'autoDoShort', 'autoFlowChips', 'autoWhenShort', 'autoSentence', 'autoBadBlanks', 'autoStepIssues', 'autoStepProblems', 'autoProblems', 'autoTriggersOn', 'autoMatches', 'autoTplUsers', 'autoPreviewHtml',
  'autoReadyRows', 'autoGatePill', 'autoStatusPill', 'autoRowHtml', 'autoListsHtml',
  // the 14 Oct review: safety settings, opt-outs, "Try it", versions, ready-mades off the list
  'AUTO_SAFETY_DEFAULTS', 'AUTO_EMAIL_FOOTER_DEFAULT', 'autoSafetyNorm', 'autoSafetyProblems', 'autoSafetyPatch', 'autoTzLabel', 'autoSafetyLine', 'autoEmailSigner',
  'autoCustomerChannels', 'autoNewVersion', 'autoTryRecords', 'autoTryWhen', 'autoTryResultHtml', 'autoRemovedHtml', 'optOutKeys', 'optOutRowsFor', 'optOutInserts', 'optOutControlHtml',
  // Names and labels (round 3, C-names)
  'officeLabel', 'officePossessive', 'bizShortName', 'ownerNamesText', 'officeAgentName', 'officeAssignee', 'taskBoardLabel', 'PERSON_COLORS', 'techColor', 'personReportName', 'payCashTo',
  'brandCacheRead', 'brandSource', 'tplExample', 'brandOf', 'contractorServices', 'CONTRACTOR_TRADES', 'REVIEW_FAMILIES', 'AU_STATE_NAMES', 'COUNTRY_ADJ', 'agreementPlace', 'bizLegalName', 'connWordsIn', 'connWordsNow', 'contractorServiceColor', 'CONTRACTOR_SERVICE_COLOR',
  // Deleting services, People details in place, Pipeline settings as columns (round 3, D-settings)
  'DIV_DELETED', 'serviceDeleted', 'liveDivisions', 'SERVICE_CATCH_ALL', 'serviceDeleteProblem', 'serviceUsage', 'serviceUseText', 'serviceMovePlan', 'phoneMenuWithout',
  'EMP_ROLES', 'empRolesNext', 'empNameProblem', 'empRolesForLogin', 'empTypeForRole', 'empRoleLabel', 'EMP_FIELD_LABEL',
  'stageColStyle', 'pipeHeadHtml', 'stageCounts', 'catalogReorder', 'stageMoveBy', 'stageRowCtl', 'stageColumnHtml',
  // Saving keeps the place, the settings search, drag & drop on every upload (round 3, A-ux: T1.8, T1.10, T1.1)
  'motionPageKey', 'renderViewKey', 'renderScrollPlan', 'settingsNavText', 'settingsNavMatch',
  'RECEIPT_TYPES', 'MAX_FILE_MB', 'DROP_RULES', 'dropFileType', 'dropAccepts', 'dropCheck', 'dropRoutePlan', 'dropZoneAttrs',
  // Stage 5 review fixes after the rebase: the tax field's label, an undo still running
  'mcpShownLabel', 'MCP_UNDO_STALE_MS', 'mcpUndoPending',
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
// This business's names as the C-names SQL saves them in settings.catalog (round 3: no names in the code). Fixtures that
// check today's words use these, so the words are the same as before.
const TODAY_NAMES = {
  pay: { hebrew: { Guy:'גיא', Dolev:'דולב', Omri:'עומרי' }, cashTo: 'Ofek',
    jobTypes: { Guy:['Aircon','Chimney','Other'], Dolev:['Aircon','Chimney','Other'], Omri:['Aircon','Chimney','Other'], Alessandro:['Pressure Washing'] } },
  people: { Guy:{ color:'person-1' }, Dolev:{ color:'person-2' }, Noam:{ color:'person-3' }, Ofek:{ color:'person-4', reportName:'אופק' }, Ron:{ reportName:'רון' } },
  brands: { Aircon:'The AC Cleaning Guys', Chimney:'The Chimney Guys', 'Pressure Washing':'The Pressure Washing Guys' },
  business: { phone:'1300 380 090', website:'theguyservicegroup.com', shortName:'The Guys Group' },
  reviews: { links: {
    Aircon: { link:'https://search.google.com/local/writereview?placeid=ChIJx33jOtfwSSgRs09ybCNrVbU', result:'Enjoy the fresh, clean air!' },
    Chimney: { link:'https://g.page/r/CZUuKFAccuR4EBM/review', result:'Enjoy your clean, safe fireplace!' },
    'Pressure Washing': { link:'https://g.page/r/CZjy0MO5zKE7EBM/review', result:'Enjoy your fresh, clean outdoor area!' } } },
};
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
  const keepSettings = sb.STATE.data.settings;
  sb.STATE.data.settings = { ...keepSettings, catalog: { ...(keepSettings.catalog || {}), pay: TODAY_NAMES.pay, people: TODAY_NAMES.people } };   // today's names, from the settings
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
  // Who the cash goes to (round 3, T1.9): the person set in Tax and payments (their name in the owners' reports in Hebrew), else the owners.
  assertEqual([sb.payCashTo(false), sb.payCashTo(true)], ['Ofek', 'אופק'], 'payCashTo: the saved person, in Hebrew by their report name');
  assertEqual(aMsg.includes('please transfer to Ofek') || !aMsg.includes('Cash collected'), true, 'payroll: the English message names the same person');
  sb.STATE.data.settings = { ...keepSettings, catalog: {} };
  assertEqual([sb.payCashTo(false), sb.payCashTo(true), JSON.stringify(sb.payHebrewNames())], ['the owners', 'בעלים', '{}'], 'payCashTo: nothing saved = the owners; nobody gets Hebrew');
  sb.STATE.data.settings = { ...keepSettings, catalog: { pay: { hebrew: TODAY_NAMES.pay.hebrew } } };
  assertEqual(sb.buildCommissionPayMessage(c).split('\n').slice(-2)[0], 'מזומן שנאסף השבוע: $350.00 - צריך להעביר לבעלים', 'payroll: Hebrew message with no cash person = to the owners');
  sb.STATE.data.settings = { ...keepSettings, catalog: { pay: { cashTo: 'Ofek' } } };
  assertEqual([sb.buildCommissionPayMessage(c).split('\n').slice(-2)[0], sb.payCashTo(true)], ['Cash collected this week: $350.00 - please transfer to Ofek', 'Ofek'], 'payroll: English message names the person; no report name = their first name');
  sb.STATE.data.settings = { ...keepSettings, catalog: {} };
  assertEqual(sb.buildCommissionPayMessage(c).split('\n').slice(-2)[0], 'Cash collected this week: $350.00 - please transfer to the owners', 'payroll: English message with no cash person = to the owners');
  sb.STATE.data.settings = keepSettings;

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
  sb.STATE.data.settings = { gstRatePercent:10, catalog: { pay: TODAY_NAMES.pay, people: TODAY_NAMES.people } };   // Guy's message in Hebrew (today's settings)
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
  assertEqual([named, sb.brandName()], ['X Pty', 'OPS Service'], 'brandName: the business\'s trading name, for the menu; none = the product\'s name (no business name in the code)');
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
  assertEqual([sb.reviewLinkFor('Chimney'), sb.reviewDefaultFor('Ducted')], [{ link: '', result: '', custom: false }, {}], 'reviews: nothing saved = no link and no line (no links in the code)');
  sb.STATE.data.settings = { catalog: { reviews: TODAY_NAMES.reviews } };
  assertEqual(sb.reviewLinkFor('Chimney').result, 'Enjoy your clean, safe fireplace!', 'reviews: today\'s saved thank-you line');
  const job = { invoiceNumber: '2701', date: '2026-10-01' }, today = '2026-10-10';
  const sent = d => ({ status: 'sent', sent_at: d + 'T01:00:00Z', ask_count: 1 });
  assertEqual([sb.reviewNeed(job, sent('2026-10-09'), today, false), sb.reviewNeed(job, sent('2026-10-10'), today, false), sb.reviewNeed(job, sent('2026-09-25'), today, false)], ['again', null, null], 'reviews: reminder from 1 day, until 14 days (original)');
  assertEqual([sb.reviewLinkFor('Ducted aircon').result, sb.reviewLinkFor('Roof cleaning').result, sb.reviewLinkFor('Gutters').link], ['Enjoy the fresh, clean air!', 'Enjoy your fresh, clean outdoor area!', ''], 'reviews: a new service gets the saved one of its kind, as the server does');
  sb.STATE.data.settings = { catalog: { reviews: { links: { Aircon: { link: 'https://a/x', result: 'R' } } } } };
  assertEqual([sb.reviewLinkFor('Ducted clean').link, sb.reviewLinkFor('Chimney').link, sb.reviewLinkFor('Aircon').custom, sb.reviewLinkFor('Ducted clean').custom], ['https://a/x', '', true, false], 'reviews: only Aircon saved: a ducted service gets its link, a chimney none');
  sb.STATE.data.settings = { catalog: { reviews: { links: { Aircon: { link: 'javascript:x', result: '' }, Ducted: { link: 'https://d/x', result: 'D' } } } } };
  assertEqual([sb.reviewLinkFor('Aircon').link, sb.reviewLinkFor('Aircon').result], ['https://d/x', 'D'], 'reviews: a bad saved link is never used (another of its kind instead)');
  sb.STATE.data.settings = { catalog: { reviews: { remindAfterDays: 3, remindWithinDays: 30, sendFrom: 9, sendUntil: 7, links: { ...TODAY_NAMES.reviews.links, Chimney: { link: 'https://g.page/r/x/review', result: '' } } } } };
  assertEqual([sb.reviewNeed(job, sent('2026-10-09'), today, false), sb.reviewNeed(job, sent('2026-10-07'), today, false), sb.reviewNeed(job, sent('2026-09-15'), today, false)], [null, 'again', 'again'], 'reviews: reminder from 3 days until 30 when set');
  const c1 = sb.reviewCfg();
  assertEqual([c1.sendFrom, c1.sendUntil, sb.reviewLinkFor('Chimney').link, sb.reviewLinkFor('Chimney').result], [8, 20, 'https://g.page/r/x/review', ''], 'reviews: impossible hours fall back; a saved link with an empty line has no line (no built-in lines)');
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
  assertEqual(sb.reviewPreviewValues('Aircon').hasLink, false, 'reviews preview: nothing saved = no link (none in the code)');
  sb.STATE.data.settings = { companyName: 'The Guys Service Group', catalog: { reviews: TODAY_NAMES.reviews } };
  const a = sb.reviewPreviewValues('Aircon'), g = sb.reviewPreviewValues('Gutters');
  assertEqual([a.hasLink, a.vars.first_name, a.vars.technician, a.vars.today, a.vars.result, a.vars.review_link, a.vars.business_name], [true, 'Sarah', 'Sam', ' today', 'Enjoy the fresh, clean air!', 'https://search.google.com/local/writereview?placeid=ChIJx33jOtfwSSgRs09ybCNrVbU', 'The Guys Service Group'], 'reviews preview: today\'s saved aircon link and line, the business name');
  assertEqual([g.hasLink, g.vars.review_link], [false, ''], 'reviews preview: a service without a link can\'t be asked');
  const chimney = { Chimney: { link: 'https://g.page/r/x/review', result: 'Warm and safe!' } };
  sb.STATE.data.settings = { companyName: 'The Guys Service Group', catalog: { reviews: { links: { ...TODAY_NAMES.reviews.links, ...chimney } } } };
  const c = sb.reviewPreviewValues('Chimney');
  assertEqual([c.vars.result, c.vars.review_link, sb.reviewPreviewValues('Pressure Washing').vars.result], ['Warm and safe!', 'https://g.page/r/x/review', 'Enjoy your fresh, clean outdoor area!'], 'reviews preview: the changed link and line; the others as saved');
  const mT = sb.MSG_TEMPLATES.find(m => m.id==='reviewText'), mE = sb.MSG_TEMPLATES.find(m => m.id==='reviewEmail');
  const VT = { reviewSms: sb.msgTemplateText('reviewSms') }, VE = { reviewEmailSubject: sb.msgTemplateText('reviewEmailSubject'), reviewEmailBody: sb.msgTemplateText('reviewEmailBody') };
  assertEqual(sb.tplPreviewHtml(mT, VT, c.vars).includes('<div class="tpl-bubble">Hi Sarah, Sam from The Guys Service Group here - thanks for having us today! Warm and safe! Our team works really hard and would truly appreciate a quick Google review: https://g.page/r/x/review Thank you!</div>'), true, 'reviews preview: the text with the service\'s link and line');
  const mail = sb.tplPreviewHtml(mE, VE, c.vars);
  assertEqual([mail.includes('<span>Subject</span>A quick favour, Sarah?'), mail.includes('Warm and safe!'), mail.includes('tpl-mail-btn')], [true, true, true], 'reviews preview: the email with the subject, the line and the button');
  assertEqual([sb.tplPreviewHtml(mT, VT) === sb.tplPreviewHtml(mT, VT, sb.tplExample()), sb.tplPreviewHtml(mE, VE) === sb.tplPreviewHtml(mE, VE, sb.tplExample())], [true, true], 'reviews preview: Message templates (no details given) shows the example with this business\'s words');
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
  const V = { hi: 'Hi Sarah', first_name: 'Sarah', technician: 'Guy', result: 'Enjoy the fresh, clean air!', review_link: 'https://g.page/r/x/review', today: ' today', business_name: 'The Guys Service Group' };
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
  // Names come from the settings (round 3, T1.7/T1.9): {business_name} and {agent} instead of the business's and Ron's names.
  assertEqual(sb.MSG_TEMPLATES.filter(t => sb.templateProblems(t, Object.fromEntries(t.fields.map(f => [f.key, f.text]))).length).map(t => t.id), [], 'templates: every original passes its own checks ({business_name} and {agent} included)');
  assertEqual([sb.fillTemplate(orig('chatOpen'), { hi: 'Hi Sarah', agent: 'Ron', brand: 'The Chimney Guys', service: 'chimney cleaning' }), sb.fillTemplate(orig('chatIntro'), { hi: 'Hi Sarah', agent: 'Ron', brand: 'The Chimney Guys', service: 'chimney cleaning' })],
    ["Hi Sarah, Ron here from The Chimney Guys. I saw your message about chimney cleaning - I'm just finishing up another call and will get back to you very shortly. Feel free to reply here in the meantime.",
     "Hi Sarah, it's Ron from The Chimney Guys. You sent us a message on our website chat about chimney cleaning. I'll give you a call shortly, or you can reply here."], 'templates: with today\'s office person and brand, the chat texts are the approved words exactly');
  assertEqual([sb.fillTemplate(orig('missedCall'), { business_name: 'The Guys Service Group' }), sb.fillTemplate(orig('phoneGreeting'), { business_name: 'The Guys Service Group' })],
    ["Hi, it's The Guys Service Group. Sorry we missed your call! We'll call you back shortly. If it's easier, reply here with what you need and your suburb.", 'Thanks for calling The Guys Service Group. This call may be recorded for quality and training.'], 'templates: with today\'s business name, the phone words are the approved words exactly');
  assertEqual([sb.templateProblems(m('missedCall'), { missedCall: 'Hi from {business_name}' }), sb.templateProblems(m('chatOpen'), { chatOpen: '{agent} from {brand}' })], [[], []], 'templates: {business_name} and {agent} can be used where they are filled');
  assertEqual(sb.fillTemplate(orig('reviewEmailBody'), { ...V, review_button: '[button]' }).endsWith('Thank you!\nGuy\nThe Guys Service Group'), true, 'templates: the review email is signed with the business name');
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
  assertEqual([sb.salesLogPay(log('2026-10-01', 8, 9)), sb.bookingBonus(5, '2026-10-01'), sb.jobTypesForTech('Alessandro'), JSON.stringify(sb.payHebrewNames())], [95, 10, ['Aircon', 'Chimney', 'Pressure Washing', 'Other'], '{}'], 'pay: nothing saved = $10/hour, the original bonus, every job type and nobody in Hebrew (no names in the code)');
  sb.STATE.data.settings = { catalog: { pay: TODAY_NAMES.pay } };
  assertEqual([sb.jobTypesForTech('Alessandro'), sb.jobTypesForTech('Guy'), sb.payHebrewNames().Guy], [['Pressure Washing'], ['Aircon', 'Chimney', 'Other'], 'גיא'], 'pay: today\'s saved job types and Hebrew names give the same as before');
  sb.STATE.data.settings = { catalog: { pay: { hourly: [{ from: '2026-10-13', rate: 12, tiers: [{ min: 6, bonus: 20 }, { min: 10, bonus: 40 }] }],
    hebrew: { Dolev: 'דולב' }, jobTypes: { Guy: ['Aircon'], Omri: ['Nope'] } } } };
  assertEqual([sb.salesLogPay(log('2026-10-12', 8, 9)), sb.salesLogPay(log('2026-10-13', 8, 9)), sb.salesLogPay(log('2026-10-14', 8, 5)), sb.salesLogPay(log('2026-10-14', 8, 12))], [95, 116, 96, 136], 'pay: a new rate and bonus count from their day on; the days before keep the old ones');
  assertEqual([sb.nextBookingTier(7, '2026-10-14'), sb.nextBookingTier(3, '2026-10-01')], [{ needed: 3, bonus: 40 }, { needed: 2, bonus: 10 }], 'pay: the next bonus follows the day\'s tiers');
  assertEqual([!!sb.payHebrewNames().Guy, sb.payHebrewNames().Dolev], [false, 'דולב'], 'pay: the saved Hebrew list replaces the original one');
  assertEqual([sb.jobTypesForTech('Guy'), sb.jobTypesForTech('Omri'), sb.jobTypesForTech('Someone new')], [['Aircon'], ['Aircon', 'Chimney', 'Pressure Washing', 'Other'], ['Aircon', 'Chimney', 'Pressure Washing', 'Other']], 'pay: saved job types win; an unusable list = every job type');
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
  // The public holidays come from the stored list (catalog.holidays, seeded by round3-stage1.sql B4), not a list in the code.
  sb.STATE.data.jobs = []; sb.STATE.data.settings = { catalog: { hours: { days: { 6: { on: true, from: '09:00', to: '13:00' } }, nsw: true, extra: [{ date: '2026-10-20', name: 'Team day' }] },
    holidays: { region: 'AU-NSW', days: { '2026-10-05': 'Labour Day' } } } };
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
  // the switch on but Labour Day switched off (an office day every year); the old switch with no stored list = no holidays
  sb.STATE.data.settings.catalog = { hours: { publicOn: true, holidayOff: ['labour day'] }, holidays: { region: 'AU-NSW', days: { '2026-10-05': 'Labour Day', '2026-12-25': 'Christmas Day' } } };
  sb.applyCatalog();
  assertEqual([sb.isWorkday('2026-10-05'), sb.isWorkday('2026-12-25')], [true, false], 'office hours: a public holiday switched off is an office day; the others stay off');
  sb.STATE.data.settings.catalog = { hours: { nsw: true } };
  sb.applyCatalog();
  assertEqual(sb.isWorkday('2026-10-05'), true, 'office hours: the old NSW switch with no stored list = no public holidays (the SQL stores the list before the app ships)');
}

// ── Region and format: time zone, money, tax name, place (T1.2, Ofek 14 Oct) ──
function testRegionCore(sb){
  console.log('\nRegion and format: the business\'s time zone, money and words (T1.2)');
  const setRegion = r => { sb.STATE.data.settings = { gstRatePercent: 10, catalog: r ? { region: r } : {} }; };
  setRegion(null);
  assertEqual(sb.bizTz(), 'Australia/Sydney', 'bizTz: nothing saved = Sydney');
  setRegion({ timeZone: 'America/Chicago' });
  assertEqual(sb.bizTz(), 'America/Chicago', 'bizTz: the saved zone');
  setRegion({ timeZone: 'Mars/Base' });
  assertEqual([sb.bizTz(), sb.tzValid('Mars/Base'), sb.tzValid(''), sb.tzValid('UTC')], ['Australia/Sydney', false, false, true], 'bizTz: a zone the browser doesn\'t know counts as not set');
  // the memo follows a NEW catalog.region object (catalogSave always saves a fresh copy)
  setRegion({ timeZone: 'America/Chicago' }); const a = sb.bizTz();
  sb.STATE.data.settings.catalog = { region: { timeZone: 'Europe/London' } };
  assertEqual([a, sb.bizTz()], ['America/Chicago', 'Europe/London'], 'bizTz: never stale after the region is saved again');
  // 2026-10-14T03:00Z = 14:00 Wed in Sydney, 22:00 Tue in Chicago
  const t = new Date('2026-10-14T03:00:00Z');
  setRegion(null);
  assertEqual([sb.todayStr(t), sb.bizWall(t), sb.bizDayOf('2026-10-14T03:00:00Z'), sb.localDay('2026-10-14T03:00:00Z'), sb.localDay('2026-10-14'), sb.bizDayOf(''), sb.bizDayOf('nonsense')],
    ['2026-10-14', { day: '2026-10-14', hour: 14, minute: 0, dow: 'Wed' }, '2026-10-14', '2026-10-14', '2026-10-14', '', ''], 'business day and wall clock: Sydney by default; plain dates pass through');
  setRegion({ timeZone: 'America/Chicago' });
  assertEqual([sb.todayStr(t), sb.bizWall(t), sb.bizDayOf(t.getTime()), sb.localDay('2026-10-14T03:00:00Z'), sb.bizTzLabel()],
    ['2026-10-13', { day: '2026-10-13', hour: 22, minute: 0, dow: 'Tue' }, '2026-10-13', '2026-10-13', 'Chicago time'], 'business day and wall clock: Chicago when the region says so (the device zone doesn\'t matter)');
  // the remembered days: the same answers, emptied when the zone changes (the Chicago line above already re-read a text
  // Sydney had remembered), and today without an instant = the wall clock now
  { const memo = sb.BIZ_DAY_MEMO; assertEqual([memo.tz, memo.days.get('2026-10-14T03:00:00Z'), sb.todayStr(), sb.todayStr()===sb.bizWall(new Date()).day],
      ['America/Chicago', '2026-10-13', sb.bizWall(new Date()).day, true], 'bizDayOf / todayStr: remembered per zone, the same answers');
    setRegion(null); assertEqual([sb.localDay('2026-10-14T03:00:00Z'), memo.tz, memo.days.size], ['2026-10-14', 'Australia/Sydney', 1], 'bizDayOf: a new zone forgets what the old one remembered'); }
  // Sydney moves to summer time on Sunday 4 Oct 2026 at 02:00 → 03:00
  setRegion(null);
  assertEqual([sb.bizWall(new Date('2026-10-03T15:59:00Z')).hour, sb.bizWall(new Date('2026-10-03T16:00:00Z')).hour, sb.bizWall(new Date('2026-10-03T16:00:00Z')).day],
    [1, 3, '2026-10-04'], 'bizWall: across the 4 Oct 2026 summer-time change');
  // bizNowPast keeps the old sydneyNowPast rule
  const due = { day: '2026-10-14', mins: 14 * 60 };
  assertEqual([sb.bizNowPast(due, new Date('2026-10-14T02:59:00Z')), sb.bizNowPast(due, new Date('2026-10-14T03:00:00Z')), sb.bizNowPast(due, new Date('2026-10-15T00:00:00Z')), sb.bizNowPast({ day: '2026-10-15', mins: 0 }, t)],
    [false, true, true, false], 'bizNowPast: before / at / a later day / an earlier day');
  // money: today's texts byte for byte (hand-checked), then 200 values against the old formulas
  assertEqual([0, 5, -5, 0.5, 12.345, 1234, 1234.5, 1e6].map(sb.fmtMoney), ['$0', '$5', '$-5', '$0.50', '$12.35', '$1,234', '$1,234.50', '$1,000,000'], 'fmtMoney: default output exactly as before');
  assertEqual(sb.fmtSignedMoney(-12), '−$12', 'fmtSignedMoney: as before');
  assertEqual([sb.payMoney(0), sb.payMoney(1234.5), sb.payMoney(-1234.56), sb.invMoney(1234567.891), sb.invMoney(999.999)], ['$0.00', '$1,234.50', '$-1,234.56', '$1,234,567.89', '$1,000.00'], 'payMoney / invMoney: default output exactly as before');
  const oldFmt = n => { n = sb.round2(n); const isInt = Math.abs(n-Math.round(n)) < 1e-9; return '$' + n.toLocaleString('en-US', { minimumFractionDigits:isInt?0:2, maximumFractionDigits:2 }); };
  const oldPay = n => '$' + sb.round2(n).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
  const oldInv = n => '$' + sb.round2(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const vals = Array.from({ length: 200 }, (_, i) => (i % 2 ? -1 : 1) * ((i * 7919.37) % 250000) / (i % 3 ? 1 : 100));
  assertEqual(vals.filter(v => sb.fmtMoney(v)!==oldFmt(v) || sb.payMoney(v)!==oldPay(v) || sb.invMoney(v)!==oldInv(v)), [], 'money: 200 amounts written exactly as the old formulas did');
  assertEqual([sb.curSym(), sb.moneyText(480, 'plain')], ['$', '$480'], 'money: the symbol and an amount as it comes');
  setRegion({ currency: 'USD' }); assertEqual(sb.fmtMoney(1234.5), '$1,234.50', 'money: USD');
  setRegion({ currency: 'GBP' }); assertEqual([sb.fmtMoney(1234.5), sb.curSym()], ['£1,234.50', '£'], 'money: GBP');
  setRegion({ currency: 'EUR', moneyFormat: '1.234,56', symbolAfter: true }); assertEqual([sb.fmtMoney(1234.5), sb.curSym()], ['1.234,50 €', '€'], 'money: EUR written 1.234,56 with the symbol after');
  setRegion({ currency: 'USD', currencySymbol: 'US$' }); assertEqual(sb.fmtMoney(1234.5), 'US$1,234.50', 'money: an own symbol');
  setRegion({ currency: 'EUR', moneyFormat: '1 234,56', symbolAfter: true }); assertEqual(sb.payMoney(1234.5), '1 234,50 €', 'money: spaces between thousands');
  setRegion({ currencySymbol: '<b>' }); assertEqual(sb.curSym(), 'b', 'money: an own symbol never carries HTML');
  setRegion({ currency: 'JPY' }); assertEqual([sb.payMoney(12345), sb.invMoney(12345.4), sb.fmtMoney(12345), sb.fmtMoney(12345.5)], ['¥12,345', '¥12,345', '¥12,345', '¥12,346'], 'money: JPY has no cents, also where cents are always written');
  setRegion({ currency: 'KWD' }); assertEqual([sb.moneyCfg().dec, sb.moneyText(1.5, 2).endsWith('1.500'), sb.moneyText(2, 'auto').endsWith('2')], [3, true, true], 'money: KWD has three decimals');
  assertEqual([sb.currencyDecimalsOf('AUD'), sb.currencyDecimalsOf('JPY'), sb.currencyDecimalsOf('XYZ1')], [2, 0, 2], 'currencyDecimalsOf: AUD 2, JPY 0, an unknown code 2');
  // presentation mode scales the amounts written in texts the way the business writes money
  {
    const script = fs.readFileSync(INDEX_HTML_PATH, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
    const names = ['REGION_DEFAULTS', 'MONEY_FORMATS', 'TZ_VALID', 'REGION_NONE', 'REGION_MEMO', 'regionNow', 'tzValid', 'regionMemo', 'regionWord', 'currencySymbolOf', 'currencyDecimalsOf', 'moneyCfg', 'moneyText', 'curSym', 'PRESENT_FACTOR', 'presentText'];
    const ctx = { STATE: { data: { settings: { catalog: {} } } } };
    vm.createContext(ctx); vm.runInContext('var PRESENT = true;\n' + names.map(n => extractDecl(script, n)).join('\n'), ctx);
    const pt = (region, t) => { ctx.STATE.data.settings = { catalog: region ? { region } : {} }; return ctx.presentText(t); };
    const oldPt = t => String(t).replace(/\$\s?([\d,]+(?:\.\d+)?)(\s?[Kk])?/g, (m, n, kk) => { const v = parseFloat(n.replace(/,/g,''))*3; return kk ? '$'+(Math.round(v*10)/10)+'K' : '$'+(Math.round(v*100)/100).toLocaleString('en-US'); });
    const samples = ['Spent $1,234.5 for 3 leads', 'CPL $85, revenue $12.3K and $ 40', 'cost $0.33 per click', 'no money here', '$1,000,000 total, $2k'];
    assertEqual(samples.map(t => pt(null, t)), samples.map(oldPt), 'presentText: nothing saved = exactly the old texts');
    assertEqual([pt({ currency: 'EUR', moneyFormat: '1.234,56', symbolAfter: true }, '1.234 € revenue, 2,5K € spend'), pt({ currency: 'EUR', moneyFormat: '1.234,56' }, 'revenue €1.234,56 today'),
      pt({ currency: 'EUR', moneyFormat: '1 234,56', symbolAfter: true }, 'revenue 1 234,5 € from 3 jobs')],
      ['3.702 € revenue, 7,5K € spend', 'revenue €3.703,68 today', 'revenue 3 703,5 € from 3 jobs'], 'presentText: symbol after, "1.234,56" and "1 234,56" amounts are found and scaled');
  }
  // tax name, business number, place
  setRegion(null);
  assertEqual([sb.taxName(), sb.bizNumberLabel(), sb.regionKeyOf({}), sb.regionPlaceName({}), sb.regionPlaceShort({}), sb.regionCountry({}), sb.regionState({})],
    ['GST', 'ABN', 'AU-NSW', 'New South Wales', 'NSW', 'AU', 'NSW'], 'labels: nothing saved = GST, ABN, New South Wales');
  setRegion({ country: 'US', state: 'TX', stateName: 'Texas' });
  assertEqual([sb.taxName(), sb.bizNumberLabel(), sb.regionKeyOf(), sb.regionPlaceName(), sb.regionPlaceShort()], ['Sales tax', 'Tax ID', 'US-TX', 'Texas', 'TX'], 'labels: US / Texas');
  setRegion({ country: 'GB' }); assertEqual([sb.taxName(), sb.regionKeyOf()], ['VAT', 'GB'], 'labels: GB = VAT, a country without a state');
  setRegion({ country: 'JP' }); assertEqual(sb.taxName(), 'Tax', 'labels: an unknown country = Tax');
  setRegion({ taxName: '  VAT  ', bizNumberLabel: 'EIN' }); assertEqual([sb.taxName(), sb.bizNumberLabel()], ['VAT', 'EIN'], 'labels: the business\'s own words');
  setRegion({ taxName: '<script>"x"</script>' }); assertEqual(sb.taxName(), 'scriptx/script', 'labels: an own word never carries HTML or quotes');
  assertEqual(sb.regionKeyOf({ country: 'SG' }), 'SG', 'regionKeyOf: no state = the country');
  setRegion(null); assertEqual(sb.regionLabels('Contractors: bank, ABN and signed agreements · amount, GST'), 'Contractors: bank, ABN and signed agreements · amount, GST', 'regionLabels: nothing saved = the text as written');
  setRegion({ country: 'US' }); assertEqual(sb.regionLabels('bank, ABN · amount, GST'), 'bank, Tax ID · amount, Sales tax', 'regionLabels: the fixed texts in the business\'s words');
  // the ABN check and its grouping only for an Australian business
  setRegion(null);
  assertEqual([sb.bizNumberHint('51 824 753 556').includes('A valid ABN'), sb.bizNumberHint('12 345 678 901').includes('fails the check'), sb.bizNumberHint(''), sb.fmtAbn('51824753556')], [true, true, '', '51 824 753 556'], 'ABN: checked and grouped in Australia');
  setRegion({ country: 'US' });
  assertEqual([sb.bizNumberHint('51 824 753 556'), sb.fmtAbn('51824753556')], ['', '51824753556'], 'ABN: no AU check or grouping elsewhere');
  setRegion(null);
}

// ── Public holidays (T1.3, Ofek 14 Oct) ──
function testPublicHolidays(sb){
  console.log('\nPublic holidays follow Country + State (T1.3)');
  assertEqual([sb.holidayKey('Boxing Day (additional day)'), sb.holidayKey('Boxing Day'), sb.holidayKey('Anzac Day (substitute day)')], ['boxing day', 'boxing day', 'anzac day'], 'holidayKey: a moved day has its holiday\'s key');
  // a fake library class: 2026 only, a substitute day and a duplicate date
  class FakeH {
    constructor(country, state, opts){ this.args = [country, state, opts]; }
    getHolidays(y){ return y===2026 ? [{ date: '2026-04-27 00:00:00', name: 'Anzac Day (substitute day)' }, { date: '2026-01-01 00:00:00', name: "New Year's Day" }, { date: '2026-01-01 00:00:00', name: 'Duplicate' }, { date: 'bad', name: 'x' }] : []; }
  }
  const out = sb.holidaysFromLib(FakeH, 'AU', 'NSW', 2026, 3, '2026-10-14T00:00:00.000Z');
  assertEqual(out, { region: 'AU-NSW', source: 'date-holidays@3.37.0', generatedAt: '2026-10-14T00:00:00.000Z', from: '2026-01-01', to: '2028-12-31', days: { '2026-01-01': "New Year's Day", '2026-04-27': 'Anzac Day (additional day)' } },
    'holidaysFromLib: AU wording, one name per day, sorted, 3 years');
  assertEqual(Object.keys(out.days), ['2026-01-01', '2026-04-27'], 'holidaysFromLib: days in date order');
  assertEqual(sb.holidaysFromLib(FakeH, 'SG', '', 2026, 1, 'x').region, 'SG', 'holidaysFromLib: a country without a state');
  const list = { region: 'AU-NSW', to: '2028-12-31', days: { '2026-12-25': 'Christmas Day', '2026-12-26': 'Boxing Day', '2026-12-28': 'Boxing Day (additional day)' } };
  assertEqual([sb.holidayDaysOf({ hours: { publicOn: false }, holidays: list }), sb.holidayDaysOf({ hours: { nsw: true }, holidays: list }), sb.holidayDaysOf({ hours: { nsw: true } }),
    sb.holidayDaysOf({ hours: { nsw: true }, holidays: list, region: { country: 'US', state: 'TX' } }), sb.holidayDaysOf({ hours: { publicOn: true, holidayOff: ['boxing day'] }, holidays: list }),
    sb.holidayDaysOf({ hours: { publicOn: false, nsw: true }, holidays: list })],
    [{}, list.days, {}, {}, { '2026-12-25': 'Christmas Day' }, {}], 'holidayDaysOf: off / the old switch / no stored list / another region / switched-off holiday (with its additional day) / the new switch wins');
  assertEqual([sb.holidaysStale({}, '2026-10-14'), sb.holidaysStale({ holidays: list, region: { country: 'US', state: 'TX' } }, '2026-10-14'), sb.holidaysStale({ holidays: { ...list, to: '2027-06-30' } }, '2026-10-14'), sb.holidaysStale({ holidays: list }, '2026-10-14')],
    ['missing', 'region', 'coverage', ''], 'holidaysStale: missing / another region / under a year left / fine');
  // the list stored by the SQL (round3-stage1.sql B4) gives exactly the NSW days the app had written in for 2026–27
  const sql = fs.readFileSync(path.join(__dirname, '..', '.claude', 'sql', 'round3-stage1.sql'), 'utf8');
  const seed = JSON.parse(sql.split('$json$')[1]);
  const OLD_NSW = { '2026-01-01': "New Year's Day", '2026-01-26': 'Australia Day', '2026-04-03': 'Good Friday', '2026-04-04': 'Easter Saturday', '2026-04-05': 'Easter Sunday', '2026-04-06': 'Easter Monday', '2026-04-25': 'Anzac Day', '2026-04-27': 'Anzac Day (additional day)', '2026-06-08': "King's Birthday", '2026-10-05': 'Labour Day', '2026-12-25': 'Christmas Day', '2026-12-26': 'Boxing Day', '2026-12-28': 'Boxing Day (additional day)',
    '2027-01-01': "New Year's Day", '2027-01-26': 'Australia Day', '2027-03-26': 'Good Friday', '2027-03-27': 'Easter Saturday', '2027-03-28': 'Easter Sunday', '2027-03-29': 'Easter Monday', '2027-04-25': 'Anzac Day', '2027-04-26': 'Anzac Day (additional day)', '2027-06-14': "King's Birthday", '2027-10-04': 'Labour Day', '2027-12-25': 'Christmas Day', '2027-12-26': 'Boxing Day', '2027-12-27': 'Christmas Day (additional day)', '2027-12-28': 'Boxing Day (additional day)' };
  assertEqual([seed.region, Object.fromEntries(Object.entries(seed.days).filter(([d]) => d < '2028')), Object.keys(OLD_NSW).length], ['AU-NSW', OLD_NSW, 27], 'the stored AU-NSW list = the old NSW 2026–27 list, day for day');
  assertEqual([sb.holidaysStale({ holidays: seed }, '2026-10-15'), sb.holidaysStale({ holidays: seed }, '2028-01-05')], ['', 'coverage'], 'the stored list is fresh now and is worked out again in its last year');
  sb.STATE.data.settings = { catalog: { hours: { nsw: true }, holidays: seed } }; sb.applyCatalog();
  assertEqual([sb.isWorkday('2026-10-05'), sb.isWorkday('2027-12-27'), sb.isWorkday('2028-10-02'), sb.isWorkday('2026-10-06')], [false, false, false, true], 'office days: the stored list with the old switch keeps today\'s days off (and 2028 works)');
  sb.STATE.data.settings = { catalog: {} }; sb.applyCatalog();
  // signed in with no profile yet: loadFromSupabase leaves STATE.data = null and applyCatalog still runs (no crash, so the
  // "ask the owner to finish your access" screen shows instead of a sign-out loop)
  { const keep = sb.STATE.data; sb.STATE.data = null; let err = null; try { sb.applyCatalog(); } catch (e) { err = e.message; } sb.STATE.data = keep;
    assertEqual(err, null, 'applyCatalog: no data (no profile yet) does not throw'); }
}

// The holiday library loads once at a time and never redraws from inside a render (T1.3).
async function testHolidayLoaders(){
  console.log('\nPublic holidays: the library loader and the refresh (no loops)');
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8'), script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const names = ['REGION_DEFAULTS', 'REGION_NONE', 'REGION_MEMO', 'BIZ_WALL', 'BIZ_DAY_MEMO', 'TZ_VALID', 'regionNow', 'tzValid', 'regionMemo', 'bizTz', 'bizWall', 'bizDayMemo', 'todayStr', 'regionCountry', 'regionState', 'regionKeyOf', 'regionPlaceName', 'countryName',
    'HOLIDAY_LIB_URL', 'HOLIDAY_SOURCE', 'HOLIDAY_WORDING', 'holidaysFromLib', 'HOLIDAYS_UI', 'holidayLib', 'holidaysTryKey', 'holidaysRefresh', 'pad2', 'fmtLocal'];
  let loads = 0, release = null, failNext = false, renders = 0, role = 'owner', ro = '';
  const saves = [];
  class FakeH { constructor(){} getHolidays(y){ return [{ date: `${y}-12-25`, name: 'Christmas Day' }]; } }
  const ctx = { console, Promise, Date, Intl, Error,
    STATE: { data: { settings: { catalog: {} } } }, window: { Holidays: FakeH },
    loadScriptOnce: () => { loads++; return new Promise((res, rej) => { release = () => (failNext ? rej(new Error('offline')) : res()); }); },
    getCurrentProfile: () => ({ role }), readOnlyReason: () => ro,
    catalogSave: (...a) => { saves.push(a); return Promise.resolve(); }, render: () => { renders++; }, showToast: () => {} };
  vm.createContext(ctx);
  vm.runInContext(names.map(n => extractDecl(script, n)).join('\n') + '\nthis.__x = { holidayLib, holidaysRefresh, HOLIDAYS_UI };', ctx);
  const X = ctx.__x, tick = () => new Promise(r => setTimeout(r, 0));
  const p1 = X.holidayLib(), p2 = X.holidayLib();
  assertEqual([p1===p2, loads], [true, 1], 'holidayLib: a second call while loading gets the same promise (one load)');
  failNext = true; release(); await p1.catch(() => {}); failNext = false;
  const p3 = X.holidayLib(); assertEqual([p3!==p1, loads], [true, 2], 'holidayLib: a failed load is tried again next time');
  release(); await p3;
  const r1 = X.holidaysRefresh(false), r2 = X.holidaysRefresh(false);
  assertEqual([r1===r2, renders], [true, 0], 'holidaysRefresh: a second call while working gets the same promise; nothing redraws at once');
  assertEqual(await r1, true, 'holidaysRefresh: resolves true when saved');
  assertEqual([saves.length, saves[0][0], saves[0][1].region, saves[0][3]], [1, 'holidays', 'AU-NSW', { toast: false }], 'holidaysRefresh: one quiet save of the stored list');
  assertEqual([await X.holidaysRefresh(false), saves.length, loads], [false, 1, 2], 'holidaysRefresh: the same region and year are not tried twice (no loop after a failure)');
  const forced = X.holidaysRefresh(true); assertEqual([await forced, saves.length], [true, 2], 'holidaysRefresh: "Try again" runs it again');
  role = 'va'; assertEqual([await X.holidaysRefresh(true), saves.length], [false, 2], 'holidaysRefresh: only an owner works the list out');
  role = 'owner'; ro = 'Presentation mode is on, changes are not saved'; assertEqual([await X.holidaysRefresh(true), saves.length], [false, 2], 'holidaysRefresh: never in a read-only mode');
  ro = ''; X.HOLIDAYS_UI.lib = null; X.HOLIDAYS_UI.tried = '';
  const bad = X.holidaysRefresh(true); failNext = true; await tick(); release(); failNext = false;
  assertEqual([await bad, renders, !!X.HOLIDAYS_UI.error, X.HOLIDAYS_UI.busy], [false, 1, true, null], 'holidaysRefresh: a failed load shows the error (one redraw, from the promise) and frees the next try');
}

// Static checks: one time zone source, no list of holidays or '$' left in the code.
function testRegionStatic(){
  console.log('\nRegion and format: nothing fixed left (static checks)');
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8'), script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const sydLines = script.split('\n').filter(l => l.includes("'Australia/Sydney'") && !/^\s*\/\//.test(l)).map(l => (l.match(/const (\w+)/) || [])[1]);
  assertEqual(sydLines, ['REGION_DEFAULTS', 'TZ_FALLBACK', 'AUTO_SAFETY_DEFAULTS'], 'Australia/Sydney is written only in the defaults (and the automation_settings column default the engine pins)');
  const fnText = n => extractDecl(script, n);
  // the shift RPCs use the business's day (round3-t12-shift-rpcs.sql), so any zone can be saved; the guard stays for a rollback
  const srf = fnText('setRegionField');
  assertEqual([vm.runInNewContext(fnText('REGION_DEFAULTS') + fnText('TZ_ALLOWED') + 'TZ_ALLOWED'), srf.indexOf('TZ_ALLOWED && !TZ_ALLOWED.includes(v)') > 0 && srf.indexOf('TZ_ALLOWED && !TZ_ALLOWED.includes(v)') < srf.indexOf("catalogSave('region', { ...region, timeZone: v }")],
    [null, true], 'time zone: any zone can be saved now that the office shift RPCs follow the business\'s day (the guard is kept for a rollback)');
  assertEqual([/NSW_HOLIDAYS|New South Wales/.test(fnText('renderOfficeHoursPage') + fnText('renderPublicHolidays')), ['fmtMoney', 'payMoney', 'invMoney'].some(n => fnText(n).includes("'$'")), script.includes('NSW_HOLIDAYS'), /function (sydneyWall|sydneyToday|payTodayStr|connSydDay)\(/.test(script)],
    [false, false, false, false], 'no NSW list, no "$" in the money writers, no Sydney helpers left');
  assertEqual([fnText('autoSafetyHtml').includes("autoSafetySet('timezone'"), fnText('autoSafetySave').includes('timezone: bizTz()'), fnText('holidaysAutoCheck').includes('render('), /setTimeout\(holidaysAutoCheck, 5000\)/.test(script)],
    [false, true, false, true], 'automations: no time zone picker of their own, the saved column mirrors the region; the holiday check runs once after loading, never redraws by itself');
  assertEqual([fnText('autoWindowFieldsHtml').includes('bizTzLabel()'), /autoSafetyNorm\(AUTO\.safety\)\.timezone/.test(script)], [true, false], 'automations: the "Only on" hours are labelled with the business\'s time zone, never the old column');
  assertEqual(/shortName/.test(fnText('autoSample')), false, 'automations preview: {brand} falls back to the business name like the engine, never the short name');
  // the edge functions carry the same region block, word for word
  const fns = ['automations', 'backup', 'conversations', 'push', 'review-requests', 'voice', 'ingest-ads-stats', 'contractor-sign', 'mcp'];
  const blocks = fns.map(f => { const t = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', f, 'index.ts'), 'utf8'); const a = t.indexOf('// ── region ('), b = t.indexOf('// ── end region ──'); return { f, t, block: a >= 0 && b > a ? t.slice(a, b) : '' }; });
  assertEqual(blocks.filter(x => !x.block || x.block!==blocks[0].block).map(x => x.f), [], 'every edge function has the same region block');
  assertEqual(blocks.filter(x => x.t.includes('NSW_HOLIDAYS')).map(x => x.f), [], 'no edge function keeps a list of NSW holidays');
  assertEqual(blocks.filter(x => (x.t.replace(x.block, '').match(/Australia\/Sydney/g) || []).length > (x.f==='automations' ? 1 : 0)).map(x => x.f), [], 'Australia/Sydney appears only in the region block (and the engine\'s DEFAULT_SETTINGS)');
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

// Round 3, D-settings: deleting a service (item 4), People details in place (item 6), Pipeline settings as columns (item 7).
function testServicesPeoplePipeline(sb){
  console.log('\nDeleting services, People details in place, Pipeline settings as columns (round 3)');
  const base = () => [{ key: 'Aircon', label: 'Aircon', color: null, active: true, subs: ['Split System', 'Duct System'] }, { key: 'Chimney', label: 'Chimney', color: null, active: true, subs: ['Chimney Sweep'] },
    { key: 'Pressure Washing', label: 'Pressure Washing', color: null, active: true, subs: [] }, { key: 'Other', label: 'Other', color: null, active: true, subs: [] }];
  // Nothing saved: nothing deleted, every service on (as today).
  sb.STATE.data.jobs = []; sb.STATE.data.contacts = []; sb.STATE.data.settings = { catalog: {} };
  sb.applyCatalog();
  assertEqual([sb.DIV_DELETED.size, [...sb.ACTIVE.divisions], sb.liveDivisions()], [0, ['Aircon', 'Chimney', 'Pressure Washing', 'Other'], ['Aircon', 'Chimney', 'Pressure Washing', 'Other']], 'services: nothing saved = nothing deleted, all four on');
  // Chimney deleted.
  const svc = base(); svc[1].deleted = true; svc[1].deletedAt = '2026-10-14T00:00:00.000Z'; svc[1].color = '#123456'; svc[1].label = 'Chimneys';
  sb.STATE.data.settings = { catalog: { services: svc, pay: TODAY_NAMES.pay } };
  sb.applyCatalog();
  assertEqual(sb.LEAD_DIVISIONS.slice(), ['Aircon', 'Chimney', 'Pressure Washing', 'Other'], 'services: a deleted one stays in LEAD_DIVISIONS (reports and old records)');
  assertEqual([sb.ACTIVE.divisions.has('Chimney'), sb.serviceDeleted('Chimney'), sb.serviceDeleted('Aircon'), sb.divLabel('Chimney'), sb.divColor('Chimney')], [false, true, false, 'Chimneys', '#123456'], 'services: deleted = out of the active set; its name and colour stay for the history');
  assertEqual([sb.activeOnly(sb.LEAD_DIVISIONS, sb.ACTIVE.divisions), sb.activeOnly(sb.LEAD_DIVISIONS, sb.ACTIVE.divisions, 'Chimney'), sb.liveDivisions()],
    [['Aircon', 'Pressure Washing', 'Other'], ['Aircon', 'Chimney', 'Pressure Washing', 'Other'], ['Aircon', 'Pressure Washing', 'Other']], 'services: every picker leaves it out, except on a record that already has it');
  const listed = sb.catalogList('services');
  assertEqual([listed.filter(x => x.key==='Chimney').length, listed.find(x => x.key==='Chimney').deleted, sb.catalogShown('services').map(x => x.key)], [1, true, ['Aircon', 'Pressure Washing', 'Other']], 'catalogList: the deleted built-in service is not re-added as a live copy; Settings doesn\'t show it');
  // The job types offered to a technician.
  assertEqual([sb.jobTypesForTech('Guy'), sb.jobTypesForTech('Alessandro'), sb.jobTypesForTech('Someone new')], [['Aircon', 'Other'], ['Pressure Washing'], ['Aircon', 'Pressure Washing', 'Other']], 'jobTypesForTech: a deleted service is never offered');
  sb.STATE.data.settings.catalog.pay = { jobTypes: { Sam: ['Chimney'] } };
  assertEqual(sb.jobTypesForTech('Sam'), ['Aircon', 'Pressure Washing', 'Other'], 'jobTypesForTech: a list of only deleted services = every service still offered');
  sb.STATE.data.settings.catalog.services = base().map(x => x.key==='Other' ? x : { ...x, deleted: true });
  sb.applyCatalog();
  assertEqual([sb.jobTypesForTech('Sam'), sb.jobTypesForTech('Anyone')], [['Other'], ['Other']], 'jobTypesForTech: everything deleted but Other = Other');
  // Restored: back as it was.
  sb.STATE.data.settings = { catalog: { services: base(), pay: TODAY_NAMES.pay } };
  sb.applyCatalog();
  assertEqual([sb.DIV_DELETED.size, sb.ACTIVE.divisions.has('Chimney'), sb.jobTypesForTech('Guy'), sb.jobTypesForTech('Someone new')], [0, true, ['Aircon', 'Chimney', 'Other'], ['Aircon', 'Chimney', 'Pressure Washing', 'Other']], 'services: restored = back in every list; with nothing deleted the job types are exactly as before');
  sb.STATE.data.settings = { catalog: {} };
  sb.applyCatalog();
  // Can it be deleted, and what uses it.
  assertEqual([sb.serviceDeleteProblem(base(), 'Other'), sb.serviceDeleteProblem([{ key: 'Aircon', active: true }, { key: 'Chimney', active: false }, { key: 'Other', active: true, deleted: true }], 'Aircon'), sb.serviceDeleteProblem(base(), 'Chimney')],
    ['Other is where calls, texts and imported leads land, so it can\'t be deleted. You can switch it off.', 'Keep at least one service switched on', ''], 'serviceDeleteProblem: the catch-all never; never the last one switched on; otherwise yes');
  const contacts = [{ id: 'c1', division: 'Chimney', subDivisions: ['Chimney Sweep', 'Split System'] }, { id: 'c2', division: 'Chimney', tags: ['Split System'] }, { id: 'c3', division: 'Aircon' }];
  const jobs = [{ id: 'j1', jobType: 'Chimney' }, { id: 'j2', jobType: 'Aircon' }];
  assertEqual(sb.serviceUsage(contacts, jobs, 'Chimney'), { leads: 2, jobs: 1 }, 'serviceUsage: 2 Chimney leads and 1 Chimney job');
  assertEqual([sb.serviceUseText({ leads: 2, jobs: 1 }), sb.serviceUseText({ leads: 1, jobs: 0 }), sb.serviceUseText({ leads: 0, jobs: 3 }), sb.serviceUseText({ leads: 0, jobs: 0 })], ['2 leads and 1 job', '1 lead', '3 jobs', ''], 'serviceUseText');
  const before = JSON.stringify([contacts, jobs]);
  assertEqual(sb.serviceMovePlan(contacts, jobs, 'Chimney', 'Aircon', ['Split System', 'Duct System']),
    [{ kind: 'contact', id: 'c1', patch: { division: 'Aircon', subDivisions: ['Split System'] } }, { kind: 'contact', id: 'c2', patch: { division: 'Aircon', subDivisions: ['Split System'] } }, { kind: 'job', id: 'j1', patch: { jobType: 'Aircon' } }],
    'serviceMovePlan: its leads first (sub-services the new one lacks dropped; an old lead\'s tag kept), then its jobs');
  assertEqual(JSON.stringify([contacts, jobs]), before, 'serviceMovePlan: the records themselves are not changed');
  const menu = [{ key: 'Aircon', say: 'a' }, { key: 'Chimney', say: 'c' }];
  assertEqual([sb.phoneMenuWithout(menu, 'Chimney'), sb.phoneMenuWithout(menu, 'Solar'), sb.phoneMenuWithout([{ key: 'Chimney', say: 'c' }], 'Chimney'), menu.length], [[{ key: 'Aircon', say: 'a' }], null, null, 2], 'phoneMenuWithout: takes it out; null when it isn\'t there or the menu would be empty');
  // Source: the Settings list, the delete flow and the pickers.
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8'), script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const fnText = n => { try { return extractDecl(script, n); } catch (e) { return ''; } };
  assertEqual([/typeof o\.remove==='function' \? o\.remove\(x\)/.test(fnText('catalogListHtml')), /catalogListHtml\('services', \{[^}]*remove: x => x\.key!==SERVICE_CATCH_ALL \}\)/.test(fnText('renderSettings')), /section==='services'\) openServiceDelete\(id\)/.test(fnText('deleteCatalogItem'))],
    [true, true, true], 'settings: a service row has Delete (not the catch-all), which asks first');
  assertEqual([fnText('commissionBlock').includes('JOB_TYPES.filter(k => !serviceDeleted(k))'), /jobTypeOpts = job\?\.jobType && !techTypes\.includes\(job\.jobType\) \? \[job\.jobType, \.\.\.techTypes\]/.test(fnText('openJobModal')), /jobTypeOpts\.map/.test(fnText('openJobModal'))], [true, true, true], 'pickers: Pay leaves deleted services out; a job keeps its own type in the Job type list');
  const mv = fnText('moveServiceRecords'), cd = fnText('confirmServiceDelete');
  assertEqual([mv.includes('db.activityLog.insert('), /logContactActivity|automationEvent/.test(mv), cd.indexOf('serviceUsage(') > cd.indexOf('moveServiceRecords(') && cd.indexOf('serviceUsage(') < cd.indexOf('x.deleted = true')], [true, false, true], 'delete: the move logs history but never marks a lead contacted nor starts an automation; the service is deleted only once nothing has it');
  assertEqual(['stageBoardHtml', 'stageColumnHtml', 'deletedServicesHtml'].filter(n => /\brender\(/.test(fnText(n))), [], 'render path: the new HTML builders never redraw');
  // People: roles and names.
  assertEqual([sb.empRolesNext(['VA'], 'Owner', true), sb.empRolesNext(['Owner', 'Technician'], 'Owner', false), sb.empRolesNext(['Driver', 'Technician'], 'Manager', true), sb.empRolesNext(null, 'VA', true)],
    [['Owner', 'VA'], ['Technician'], ['Manager', 'Technician', 'Driver'], ['VA']], 'empRolesNext: in the fixed order; a role it doesn\'t know stays at the end');
  const emps = [{ id: 'e1', name: 'Sam Taylor' }, { id: 'e2', name: 'Alex' }];
  assertEqual([sb.empNameProblem(emps, 'e1', '  '), sb.empNameProblem(emps, 'e1', 'alex'), sb.empNameProblem(emps, 'e1', 'SAM TAYLOR'), sb.empNameProblem(emps, 'e1', 'Sam T')], ['Enter a name', 'There is already someone called alex', '', ''], 'empNameProblem: blank, someone else\'s name (any case), their own name, a new one');
  assertEqual(['owner', 'manager', 'technician', 'va', 'marketing'].map(sb.empRolesForLogin), [['Owner'], ['Manager'], ['Technician'], ['VA'], []], 'empRolesForLogin');
  assertEqual(['va', 'technician', 'manager', 'owner'].map(sb.empTypeForRole), ['Hourly', 'Freelance-commission', 'Salaried', 'Salaried'], 'empTypeForRole: as Add person always did');
  assertEqual([sb.empRoleLabel('VA'), sb.empRoleLabel('Owner')], ['Office (VA)', 'Owner'], 'empRoleLabel: VA shows as the office (no name saved = Office); the saved value stays VA');
  // Pipeline: one head, one colour source.
  assertEqual(sb.pipeHeadHtml('Quoted', 3), '<div class="pipe-head"><span class="pipe-title-wrap"><span class="pipe-dot"></span><span class="pipe-title">Quoted</span></span><span class="pipe-count">3</span></div>', 'pipeHeadHtml: the CRM column head');
  assertEqual(sb.pipeHeadHtml('New', 0, '<i>g</i>'), '<div class="pipe-head"><i>g</i><span class="pipe-title-wrap"><span class="pipe-dot"></span><span class="pipe-title">New lead</span></span><span class="pipe-count">0</span></div>', 'pipeHeadHtml: with the drag handle first');
  assertEqual([sb.stageColStyle('Quoted'), sb.stageColStyle('nope')], ['--stage:var(--stage-quoted)', '--stage:var(--ink-faint)'], 'stageColStyle: the stage colour (stageColor)');
  const crm = fnText('renderCrmPipeline');
  assertEqual([crm.includes('pipeHeadHtml('), crm.includes('stageColStyle('), crm.includes('LEAD_STATUS_COLOR[')], [true, true, false], 'CRM board: the shared head and colour');
  sb.STATE.data.jobs = [{ id: 'j9', customerName: 'Won One', contactId: 'cw', date: '2026-10-01' }]; sb.JOB_CACHE.index = null;
  // New, New, Chasing, and a Quoted lead that has a job (so Won).
  assertEqual(sb.stageCounts([{ id: 'a', fullName: 'A', status: 'New' }, { id: 'b', fullName: 'B', status: 'New' }, { id: 'c', fullName: 'C', status: 'Chasing' }, { id: 'cw', fullName: 'W', status: 'Quoted' }]), { New: 2, Chasing: 1, Won: 1 }, 'stageCounts: as the CRM board counts them');
  sb.STATE.data.jobs = []; sb.JOB_CACHE.index = null;
  const st = [{ key: 'New' }, { key: 'Gone', deleted: true }, { key: 'Quoted' }, { key: 'Won' }];
  assertEqual([sb.catalogReorder(st, 'stages', ['Won', 'Quoted', 'New']).map(x => x.key), sb.catalogReorder(st, 'stages', ['Quoted']).map(x => x.key)], [['Won', 'Quoted', 'New', 'Gone'], ['Quoted', 'New', 'Gone', 'Won']], 'catalogReorder: the order on screen; anything not on screen at the end, in its own order');
  assertEqual([sb.stageMoveBy(st, 'Quoted', -1).map(x => x.key), sb.stageMoveBy(st, 'New', 1).map(x => x.key), sb.stageMoveBy(st, 'New', -1), sb.stageMoveBy(st, 'Won', 1), sb.stageMoveBy(st, 'Nope', 1), st.map(x => x.key)],
    [['Quoted', 'Gone', 'New', 'Won'], ['Quoted', 'Gone', 'New', 'Won'], null, null, null, ['New', 'Gone', 'Quoted', 'Won']], 'stageMoveBy: swaps with the neighbour past a deleted one; null at either end or for an unknown stage; the list given is not changed');
  sb.STATE.data.settings = { catalog: { stages: [{ key: 'sx1', label: 'Site visit', color: '#7746c9', active: true }] } };
  sb.applyCatalog();
  const q = sb.stageColumnHtml({ key: 'Quoted', label: 'Quoted', active: true }, 2), n = sb.stageColumnHtml({ key: 'New', label: 'New lead' }, 0), cx = sb.stageColumnHtml({ key: 'sx1', label: 'Site visit', active: true }, 1);
  assertEqual([q.includes('data-key="Quoted"'), q.includes('style="--stage:' + sb.stageColor('Quoted') + '"'), q.includes(sb.esc(sb.STAGE_RULE_TEXT('Quoted'))), q.includes("openStageEditor('Quoted')"), q.includes('role="switch"'), q.includes('<span class="pipe-count">2</span>'), q.includes("catalogDragStart(event,'stages','x')")],
    [true, true, true, true, true, true, true], 'stageColumnHtml: a built-in stage: its colour, rule, count, Edit, switch and drag handle');
  assertEqual([n.includes('cat-lock'), n.includes('role="switch"'), cx.includes("removeStage('sx1')"), cx.includes('--stage:#7746c9'), sb.stageColumnHtml({ key: 'Booked', label: 'Booked', active: false }, 0).includes('stage-col off')], [true, false, true, true, true], 'stageColumnHtml: New has the lock, a custom stage Delete, a switched-off one is greyed');
  assertEqual([/stageBoardHtml\(\)/.test(fnText('renderSettings')), /catalogListHtml\('stages'/.test(fnText('renderSettings')), fnText('keepListScroll').includes('.stage-board')], [true, false, true], 'settings: Pipeline draws the columns; the board keeps its sideways scroll on a redraw');
  sb.STATE.data.settings = { catalog: {} };
  sb.applyCatalog();
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
  assertEqual([ids, new Set(ids).size], [['gads', 'meta', 'organic', 'nightly', 'email', 'web', 'sheet', 'twilio', 'ghl', 'gbp', 'xero', 'wp', 'mcp'], 13], 'CONNECTORS: the 13 connectors: the 12 of the mockup, then the private connector, each once');
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

function testMcpConnector(sb){
  console.log('\nSettings → Connectors → Private connector (MCP), stage 5');
  sb.URL = URL;   // mcpServerProblems parses addresses (a vm context has no URL of its own)
  const script = fs.readFileSync(INDEX_HTML_PATH, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  const D = id => sb.CONNECTORS.find(d => d.id===id), cfg = (e, id) => sb.connCfgOf({ connectors: e }, id);
  // the tile: a registry entry with no switches, so every connector helper keeps working
  assertEqual([sb.connState(D('mcp'), cfg({}, 'mcp'), {}), sb.connTone(D('mcp'), cfg({}, 'mcp'), {}), sb.connHows(D('mcp')), sb.connStopsAll(D('mcp'), cfg({}, 'mcp')), sb.connMatches(D('mcp'), 'mcp'), sb.connMatches(D('mcp'), 'import leads'), D('mcp').kind],
    ['ok', null, [], [], true, true, 'mcp'], 'MCP tile: connected (Ready), nothing to measure, no tags, nothing stops, found by name and description');
  // who may make keys
  const P = (role, permissions) => ({ role, permissions });
  assertEqual([sb.canUseMcp(P('owner')), sb.canUseMcp(P('manager')), sb.canUseMcp(P('va', {})), sb.canUseMcp(P('va', { mcp: true })), sb.canUseMcp(P('technician', { mcp: false })), sb.canUseMcp(P('marketing', { mcp: true })), sb.canUseMcp({ role: 'va' }), sb.canUseMcp(null), sb.canUseMcp(P('va', { mcp: 'yes' }))],
    [true, true, false, false, false, false, false, false, false], 'canUseMcp: owners and managers only (Ofek 15 Oct); an old permissions.mcp switch means nothing');
  // settings
  const inS = { mcp: { rateLimitPerMin: 30, logKeepDays: 5000, importSource: '  Partner feed ' } }, inCopy = JSON.stringify(inS);
  assertEqual([sb.mcpSettingsOf(undefined), sb.mcpSettingsOf(inS), sb.mcpSettingsOf({ mcp: { rateLimitPerMin: 'abc', logKeepDays: 2, importSource: '' } }), sb.mcpSettingsOf({ mcp: 'x' }), sb.mcpSettingsOf({ mcp: { rateLimitPerMin: '30', logKeepDays: 365.5 } }), JSON.stringify(inS)===inCopy],
    [{ rateLimitPerMin: 60, logKeepDays: 90, importSource: 'MCP import' }, { rateLimitPerMin: 30, logKeepDays: 90, importSource: 'Partner feed' }, { rateLimitPerMin: 60, logKeepDays: 90, importSource: 'MCP import' }, { rateLimitPerMin: 60, logKeepDays: 90, importSource: 'MCP import' }, { rateLimitPerMin: 60, logKeepDays: 90, importSource: 'MCP import' }, true],
    'mcpSettingsOf: as the function reads it (a value out of range or not a whole number = the default), trimmed; the input is not changed');
  assertEqual(sb.mcpSettingsOf({ mcp: { importSource: 'x'.repeat(70) } }).importSource.length, 60, 'mcpSettingsOf: the import source is cut to 60 characters, as the function does');
  assertEqual([sb.mcpSettingProblem('rateLimitPerMin', '0'), sb.mcpSettingProblem('rateLimitPerMin', '2.5'), sb.mcpSettingProblem('rateLimitPerMin', '61'), sb.mcpSettingProblem('rateLimitPerMin', '601'), sb.mcpSettingProblem('logKeepDays', '3'), sb.mcpSettingProblem('logKeepDays', '3650'), sb.mcpSettingProblem('importSource', '  '), sb.mcpSettingProblem('importSource', 'x'.repeat(61)), sb.mcpSettingProblem('importSource', ' Feed ')],
    ['Enter a whole number from 1 to 600.', 'Enter a whole number from 1 to 600.', '', 'Enter a whole number from 1 to 600.', 'Enter a whole number of days from 7 to 3650.', '', 'Give imported leads a source name.', 'Keep the source name to 60 characters.', ''], 'mcpSettingProblem: the same limits as set_mcp_settings');
  // addresses and keys
  const U = { url: 'https://x.supabase.co/functions/v1/mcp', pathUrl: 'https://x.supabase.co/functions/v1/mcp/t/ops_mcp_abc' };
  assertEqual([sb.mcpUrls('https://x.supabase.co/', 'ops_mcp_abc'), sb.mcpUrls('https://x.supabase.co', 'ops_mcp_abc')], [U, U], 'mcpUrls: the plain address and the one with the key, with or without a trailing slash');
  const T = 'ops_mcp_';
  assertEqual([sb.mcpTokenLooksRight(T + 'A'.repeat(43)), sb.mcpTokenLooksRight(T + 'a'.repeat(41) + '-_'), sb.mcpTokenLooksRight(T + 'A'.repeat(42)), sb.mcpTokenLooksRight(T + 'A'.repeat(42) + '='), sb.mcpTokenLooksRight('ops_mcq_' + 'A'.repeat(43)), sb.mcpTokenLooksRight(undefined)],
    [true, true, false, false, false, false], 'mcpTokenLooksRight: ops_mcp_ and exactly 43 url-safe characters');
  const tk = [{ id: 'a', user_id: 'u1', created_at: '2026-10-01T00:00:00Z' }, { id: 'b', user_id: 'u1', created_at: '2026-10-05T00:00:00Z', revoked_at: '2026-10-06T00:00:00Z' }, { id: 'c', user_id: 'u2', created_at: '2026-10-03T00:00:00Z' }, { id: 'd', user_id: 'u1', created_at: '2026-10-04T00:00:00Z' }];
  const kl = sb.mcpKeyLists(tk, 'u1');
  assertEqual([kl.mine.map(t => t.id), kl.all.map(t => t.id), tk.map(t => t.id), sb.mcpKeyLists(null, 'u1').all], [['d', 'a', 'b'], ['d', 'c', 'a', 'b'], ['a', 'b', 'c', 'd'], []], 'mcpKeyLists: working keys first (newest first), then revoked; mine = my keys; the input order is kept');
  const NOW = Date.parse('2026-10-13T21:30:00Z');   // Wed 14 Oct, 8:30 am in Sydney
  const k0 = { token_prefix: 'ops_mcp_AbCd', created_at: '2026-10-13T20:52:00Z' };
  assertEqual([sb.mcpKeyMeta(k0, NOW), sb.mcpKeyMeta({ ...k0, last_used_at: '2026-10-12T20:51:00Z' }, NOW), sb.mcpKeyMeta({ ...k0, revoked_at: '2026-10-13T21:00:00Z' }, NOW).endsWith(' · revoked Today 8:00 am'), sb.mcpWhen('', NOW), sb.mcpWhen(null, NOW)],
    ['ops_mcp_AbCd… · made Today 7:52 am · never used', 'ops_mcp_AbCd… · made Today 7:52 am · last used Yesterday 7:51 am', true, 'Never', 'Never'], 'mcpKeyMeta / mcpWhen: prefix, made, last used and revoked, in Sydney time');
  assertEqual(['ok', 'denied', 'error', 'rate_limited', 'odd', undefined].map(sb.mcpLogStatus), [['good', 'OK'], ['warn', 'Not allowed'], ['bad', 'Error'], ['warn', 'Too many calls'], ['neutral', 'odd'], ['neutral', '']], 'mcpLogStatus: the access log\'s result pills');
  // the address guard (a convenience copy of the function's)
  const blocked = ['localhost', 'api.localhost', 'printer.local', 'metadata.google.internal', '127.0.0.1', '10.2.3.4', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '[::1]', '[fd00::1]', '[fe80::1]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', 'LOCALHOST.'];
  const open = ['172.32.0.1', '8.8.8.8', 'example.com', 'mcp.example.com.au', 'fcbarcelona.com', 'fe80.example.com', '[2001:4860::8888]', '[::ffff:8.8.8.8]'];
  assertEqual([blocked.filter(h => !sb.mcpHostBlocked(h)), open.filter(h => sb.mcpHostBlocked(h))], [[], []], 'mcpHostBlocked: local names, private / loopback / link-local / CGNAT IPv4, and IPv6 loopback, ULA, link-local and mapped forms');
  const sp = s => sb.mcpServerProblems(s);
  assertEqual([sp({ name: '', url: 'http://x.com' }), sp({ name: 'CRM', url: 'https://10.0.0.1/mcp' }), sp({ name: 'CRM', url: 'https://crm.example.com/mcp', auth_header: 'X Key' }), sp({ name: 'CRM', url: 'https://crm.example.com/mcp', auth_header: 'Cookie' }), sp({ name: 'CRM', url: 'not a url' }), sp({ name: 'CRM', url: 'https://crm.example.com/mcp', auth_header: 'Authorization' }), sp({ name: 'x'.repeat(81), url: 'https://[::1]/' })],
    [['Give it a name.', 'The address must start with https://.'], ['That address is on a private network. Use the server\'s public https address.'], ['The header name can only have letters, numbers and dashes.'], ['That header can\'t be used.'], ['That address doesn\'t look right.'], [], ['Keep the name to 80 characters.', 'That address is on a private network. Use the server\'s public https address.']],
    'mcpServerProblems: name, https only, no private address, and a usable header name');
  // the import fields: the app's own columns, each once
  const fieldsOf = n => [...extractDecl(script, n).matchAll(/:\s*'([a-z_]+)'/g)].map(m => m[1]);
  const cols = { contacts: fieldsOf('contactPatchToRow'), jobs: fieldsOf('jobPatchToRow'), tasks: fieldsOf('taskPatchToRow') };
  assertEqual([Object.keys(sb.MCP_IMPORT_FIELDS), Object.keys(sb.MCP_IMPORT_KINDS)], [['contacts', 'jobs', 'tasks'], ['contacts', 'jobs', 'tasks']], 'MCP_IMPORT_FIELDS: leads, jobs and tasks, as MCP_IMPORT_KINDS');
  assertEqual(Object.entries(sb.MCP_IMPORT_FIELDS).flatMap(([k, list]) => list.filter(([t]) => !cols[k].includes(t)).map(([t]) => k + '.' + t)), [], 'MCP_IMPORT_FIELDS: every target is a column the app itself writes (contactPatchToRow / jobPatchToRow / taskPatchToRow)');
  assertEqual(Object.values(sb.MCP_IMPORT_FIELDS).map(list => new Set(list.map(f => f[0])).size===list.length), [true, true, true], 'MCP_IMPORT_FIELDS: no field twice');
  // the mapping editor's rows, both ways
  const mr = sb.mcpMappingRows('contacts', { full_name: { path: 'name' }, source: { value: 'Partner' }, bogus: { path: 'x' }, phone: 'tel' });
  assertEqual([mr.length, mr[0], mr.find(r => r.target==='source'), mr.find(r => r.target==='phone'), mr.filter(r => !r.mode).length, sb.mcpMappingRows('x', {}), sb.mcpMappingRows('tasks', null).length],
    [13, { target: 'full_name', label: 'Name', mode: 'path', text: 'name' }, { target: 'source', label: 'Lead source', mode: 'value', text: 'Partner' }, { target: 'phone', label: 'Phone', mode: 'path', text: 'tel' }, 10, [], 8], 'mcpMappingRows: one row per field in order ({ path }, a plain path string or { value }); unknown targets are ignored');
  assertEqual([sb.mcpMappingFromRows('contacts', mr), sb.mcpMappingFromRows('contacts', [{ target: 'email', mode: 'path', text: '   ' }, { target: 'notes', mode: 'value', text: ' hi ' }, { target: 'bogus', mode: 'path', text: 'x' }, { target: 'phone', mode: '', text: 'p' }])],
    [{ full_name: { path: 'name' }, phone: { path: 'tel' }, source: { value: 'Partner' } }, { notes: { value: 'hi' } }], 'mcpMappingFromRows: back to { path } / { value }; blank text, no mode or an unknown target is dropped; text trimmed');
  assertEqual(['contacts', 'jobs', 'tasks', 'x'].map(sb.mcpDedupeDefault), [{ fields: ['phone', 'email'], match: 'any' }, { fields: ['invoice_number'], match: 'any' }, { fields: ['title', 'due'], match: 'all' }, { fields: [], match: 'any' }], 'mcpDedupeDefault: the function\'s starting duplicate check');
  assertEqual(['', 'items', 'data.items', 'data.items[0].x', 'a-b.$c', 'data/items', '__proto__', 'a..b', 'a.' + 'b.'.repeat(12) + 'c'].map(sb.mcpPathOk), [true, true, true, true, true, false, false, false, false], 'mcpPathOk: the function\'s path rules');
  // what is wrong with a rule
  const good = { name: 'Leads', kind: 'contacts', tool: 'list', mode: 'manual', mapping: { full_name: { path: 'n' }, phone: { path: 'p' }, email: { path: 'e' } }, dedupe: { fields: ['phone', 'email'], match: 'any' }, items_path: 'items' };
  const rp = (patch, tools) => sb.mcpRuleProblems({ ...good, ...patch }, tools || ['list']);
  assertEqual(sb.mcpRuleProblems({ name: '', kind: 'contacts', tool: '', mode: 'manual', mapping: {}, dedupe: { fields: [], match: 'any' } }, []), ['Give the import a name.', 'Pick the tool to call.', 'Map the name.', 'Pick at least one field for the duplicate check.'], 'mcpRuleProblems: an empty rule');
  assertEqual([rp({}), rp({ kind: 'jobs', mapping: {}, dedupe: { fields: [], match: 'any' } }).includes('Map the customer.'), rp({ kind: 'tasks', mapping: {}, dedupe: { fields: [], match: 'any' } }).includes('Map the title.'), rp({ kind: 'x' }).includes('Pick what to import.')],
    [[], true, true, true], 'mcpRuleProblems: a good rule has none; jobs need the customer, tasks the title');
  assertEqual([rp({ mapping: { full_name: { path: 'n' }, phone: { path: 'p' } } }), rp({ mapping: { ...good.mapping, email: { value: 'x@y.z' } } }), rp({ dedupe: { fields: ['phone', 'email', 'notes', 'postcode', 'source'], match: 'any' } }).includes('Pick at most 4 fields for the duplicate check.')],
    [['The duplicate check uses Email, but Email isn\'t mapped.'], ['The duplicate check uses Email, so map it from the data, not as a fixed value.'], true], 'mcpRuleProblems: every duplicate-check field must be mapped from the data');
  assertEqual([rp({ tool: 'b' }, ['a']), rp({ tool: 'b' }, []), rp({ mode: 'daily' }), rp({ items_path: 'data/items' }), rp({ mapping: { ...good.mapping, notes: { path: 'a b' } } })],
    [['Pick one of the server\'s tools (test the connection again if it changed).'], [], ['Pick manual or every hour.'], ['The list\'s place can only have letters, numbers, dots and _ (like data.items).'], ['Notes: the place in the data should look like customer.phone.']], 'mcpRuleProblems: the tool, the mode and the places');
  // tool arguments and answers
  assertEqual([sb.mcpParseArgs(''), sb.mcpParseArgs('{"limit": 5}'), ...['[1]', 'null', '5', '{bad'].map(t => sb.mcpParseArgs(t).error), sb.mcpParseArgs('x'.repeat(10001)).error],
    [{ ok: true, value: {} }, { ok: true, value: { limit: 5 } }, ...Array(4).fill('The arguments must be a JSON object, like {"limit": 10}.'), 'Keep the arguments under 10,000 characters.'], 'mcpParseArgs: blank = {}; only a JSON object');
  assertEqual([sb.mcpArgsTemplate({ type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', default: 20 }, active: { type: 'boolean' }, tags: { type: 'array' }, since: { type: 'string', examples: ['2026-10-01'] }, odd: {} } }), sb.mcpArgsTemplate(null), sb.mcpArgsTemplate({ type: 'string' })],
    [JSON.stringify({ query: '', limit: 20, active: false, tags: [], since: '2026-10-01', odd: '' }, null, 2), '{}', '{}'], 'mcpArgsTemplate: defaults, examples or empty values from the tool\'s schema');
  assertEqual([sb.mcpResultData({ structuredContent: { items: [1] } }), sb.mcpResultData({ content: [{ type: 'text', text: '{"a":1}' }] }), sb.mcpResultData({ content: [{ type: 'text', text: 'hello' }] }), sb.mcpResultData(undefined), sb.mcpResultData({ ok: true, preview: '[{"a":1}]' })],
    [{ items: [1] }, { a: 1 }, null, null, [{ a: 1 }]], 'mcpResultData: structured content, else the first text item (or the function\'s preview) as JSON; never throws');
  assertEqual([sb.mcpItemsAt({ data: { items: [{ a: 1 }] } }, 'data.items'), sb.mcpItemsAt([{ a: 1 }], ''), sb.mcpItemsAt({ x: 1 }, 'items'), sb.mcpItemsAt({ items: 'no' }, 'items'), sb.mcpItemsAt({ pages: [{ rows: [2] }] }, 'pages[0].rows'), sb.mcpItemsAt({}, '__proto__')],
    [[{ a: 1 }], [{ a: 1 }], null, null, [2], null], 'mcpItemsAt: the list at a place in the answer, or null');
  const sample = [{ name: 'A', phone: '1', address: { suburb: 'X', geo: { lat: 1, deep: { z: 1 } } }, tags: ['a'] }, { email: 'e', name: 'B', 'bad key': 1 }];
  assertEqual([sb.mcpSamplePaths(sample), sb.mcpSamplePaths(sample, 2), sb.mcpSamplePaths([]), sb.mcpSamplePaths(null)], [['name', 'phone', 'address.suburb', 'address.geo.lat', 'tags', 'email'], ['name', 'phone'], [], []], 'mcpSamplePaths: places of the values, 3 levels deep, lists as one value, each once');
  assertEqual([sb.mcpPreviewCounts([{ status: 'new' }, { status: 'duplicate' }, { status: 'new' }, { status: 'error' }, null]), sb.mcpPreviewColumns('contacts', { phone: { path: 'p' }, full_name: { path: 'n' }, notes: { value: 'x' } }),
    sb.mcpPreviewColumns('contacts', { full_name: { path: 'a' }, phone: { path: 'b' }, email: { path: 'c' }, postcode: { path: 'd' }, division: { path: 'e' }, source: { path: 'f' } })],
    [{ new: 2, duplicate: 1, error: 1 }, ['full_name', 'phone', 'notes'], ['full_name', 'phone', 'email', 'postcode', 'division']], 'mcpPreviewCounts / mcpPreviewColumns: the counts, and the first 5 mapped fields in field order');
  assertEqual([sb.mcpPreviewText('abc'), sb.mcpPreviewText({ a: 1 }), sb.mcpPreviewText('x'.repeat(20), 12), sb.mcpPreviewText(undefined), sb.mcpPreviewText('y'.repeat(5000)).endsWith('… (cut at 4,000 characters)')],
    ['abc', '{\n  "a": 1\n}', 'x'.repeat(12) + '\n… (cut at 12 characters)', '', true], 'mcpPreviewText: a tool\'s answer as text, cut with a note');
  // import history
  const run = { started_at: '2026-10-13T20:52:00Z', status: 'done', fetched: 14, inserted: 12, duplicates: 2, errors: [] };
  assertEqual([sb.mcpRunLine(run, NOW), sb.mcpRunLine({ ...run, status: 'partial', errors: [{ i: 3, reason: 'x' }] }, NOW), sb.mcpRunLine({ ...run, undone_at: '2026-10-13T21:00:00Z' }, NOW), sb.mcpRunLine({ started_at: run.started_at, status: 'failed', errors: [{ reason: 'Timed out' }] }, NOW), sb.mcpRunLine({ started_at: run.started_at, status: 'running' }, NOW)],
    ['Today 7:52 am · 14 fetched, 12 added, 2 already in the app', 'Today 7:52 am · 14 fetched, 12 added, 2 already in the app, 1 with problems', 'Today 7:52 am · 14 fetched, 12 added, 2 already in the app · undone Today 8:00 am', 'Today 7:52 am · Failed: Timed out', 'Today 7:52 am · Running…'], 'mcpRunLine: what each import did');
  assertEqual([sb.mcpCanUndo({ inserted: 3, status: 'done' }), sb.mcpCanUndo({ inserted: 3, status: 'partial' }), sb.mcpCanUndo({ inserted: 0, status: 'done' }), sb.mcpCanUndo({ inserted: 3, status: 'done', undone_at: 'x' }), sb.mcpCanUndo({ inserted: 3, status: 'running' }), sb.mcpCanUndo(null)],
    [true, true, false, false, false, false], 'mcpCanUndo: once, when it added something and has finished');
  assertEqual([sb.mcpRunLine({ ...run, undo_started_at: '2026-10-13T21:00:00Z' }, NOW), sb.mcpCanUndo({ inserted: 3, status: 'done', undo_started_at: 'x' })],
    ['Today 7:52 am · 14 fetched, 12 added, 2 already in the app · undo not finished: press Undo again to finish it', true], 'mcpRunLine / mcpCanUndo: an undo that stopped in the middle says so, and Undo stays (pressing it again resumes)');
  // an undo that started less than 10 minutes ago may still be running (the server refuses a second Undo until then)
  assertEqual([sb.mcpRunLine({ ...run, undo_started_at: '2026-10-13T21:25:00Z' }, NOW), sb.mcpRunLine({ ...run, undo_started_at: '2026-10-13T21:20:00Z' }, NOW), sb.mcpRunLine({ ...run, undo_started_at: 'x' }, NOW)],
    ['Today 7:52 am · 14 fetched, 12 added, 2 already in the app · being undone… (if it stopped, Undo can finish it after Today 8:35 am)',
      'Today 7:52 am · 14 fetched, 12 added, 2 already in the app · undo not finished: press Undo again to finish it',
      'Today 7:52 am · 14 fetched, 12 added, 2 already in the app · undo not finished: press Undo again to finish it'], 'mcpRunLine: an undo under 10 minutes old says it is being undone (pressing Undo would be refused); from 10 minutes it can be finished');
  // people, reasons, lines
  assertEqual([sb.mcpReasonText('owners only'), sb.mcpReasonText('Only owners and managers can make keys.'), sb.mcpReasonText('not allowed'), sb.mcpReasonText('host blocked'), sb.mcpReasonText('That address is private or local, so OPS won\'t call it.'), sb.mcpReasonText('The server took too long.'), sb.mcpReasonText(''), sb.mcpReasonText('Weird thing'), sb.mcpReasonText('server')],
    ['Only an owner can do this.', 'Only owners and managers can make keys.', 'Only owners and managers can make keys.', 'That address isn\'t allowed: it must be a public https address.', 'That address isn\'t allowed: it must be a public https address.', 'The server didn\'t answer within 15 seconds.', 'Something went wrong. Try again.', 'Weird thing', 'Something went wrong on the server. Try again.'], 'mcpReasonText: the function\'s reasons in plain words');
  assertEqual([sb.mcpLoadErrorText({ code: '42P01' }), sb.mcpLoadErrorText({ message: 'relation "mcp_tokens" does not exist' }), sb.mcpLoadErrorText({ message: 'x' })], ['The private connector isn\'t set up on the server yet.', 'The private connector isn\'t set up on the server yet.', 'Could not load: x'], 'mcpLoadErrorText: a missing table says the server is not set up yet');
  assertEqual([sb.mcpServerMeta({ url: 'https://crm.example.com/mcp', hasSecret: true, last_test_at: '2026-10-13T20:52:00Z', last_test_ok: true, last_tools: [{}, {}] }, NOW), sb.mcpServerMeta({ url: 'https://crm.example.com/mcp', hasSecret: false, last_test_at: '2026-10-13T20:52:00Z', last_test_ok: false, last_tools: [{}] }, NOW), sb.mcpServerMeta({ url: 'https://a.b/c' }, NOW)],
    ['crm.example.com · key saved · connected Today 7:52 am · 2 tools', 'crm.example.com · no key · failed Today 7:52 am · 1 tool', 'a.b · no key · not tested yet'], 'mcpServerMeta: host, key, last test and tools');
  assertEqual([sb.mcpRuleMeta({ kind: 'contacts', tool: 'list', mode: 'hourly', run_automations: true, last_run_at: '2026-10-13T20:52:00Z' }, NOW), sb.mcpRuleMeta({ kind: 'tasks', tool: 't', mode: 'manual' }, NOW)], ['Leads · list · every hour · starts automations · last run Today 7:52 am', 'Tasks · t · manual'], 'mcpRuleMeta: what, which tool, how often');
  // parity with the mcp function (supabase/functions/mcp/index.ts)
  const fn = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'mcp', 'index.ts'), 'utf8');
  const toolsSrc = fn.slice(fn.indexOf('export const TOOLS'), fn.indexOf('\n];', fn.indexOf('export const TOOLS')));
  assertEqual([...toolsSrc.matchAll(/\n {4}name: "(\w+)", title:/g)].map(m => m[1]).sort(), sb.MCP_TOOL_NAMES.slice().sort(), 'mcp function: the same read-only tools as the access log filter');
  const fieldsSrc = fn.slice(fn.indexOf('export const IMPORT_FIELDS'), fn.indexOf('\n};', fn.indexOf('export const IMPORT_FIELDS')));
  const fnFields = {}; let kindNow = null;
  fieldsSrc.split('\n').forEach(l => { const k = /^ {2}(\w+): \{$/.exec(l), f = /^ {4}(\w+): \{ label: "([^"]+)"(.*)$/.exec(l); if (k) { kindNow = k[1]; fnFields[kindNow] = []; } else if (f && kindNow) fnFields[kindNow].push([f[1], f[2], /required: true/.test(f[3])]); });
  assertEqual([Object.keys(fnFields), Object.entries(fnFields).map(([k, list]) => JSON.stringify(list.map(f => [f[0], f[1]]))===JSON.stringify(sb.MCP_IMPORT_FIELDS[k]))], [['contacts', 'jobs', 'tasks'], [true, true, true]], 'mcp function: the same import fields and labels, in the same order');
  assertEqual(Object.fromEntries(Object.entries(fnFields).map(([k, list]) => [k, list.filter(f => f[2]).map(f => f[0]).join()])), sb.MCP_IMPORT_REQUIRED, 'mcp function: the same required field per kind');
  const fnObj = re => Function('return ' + fn.match(re)[1])();
  assertEqual([fnObj(/export const MCP_DEFAULTS = (\{[^}]*\});/), fnObj(/export const DEFAULT_DEDUPE = (\{[^\n]*\});/), fnObj(/const RESERVED_HEADERS = (\[[^\]]*\]);/)],
    [sb.MCP_SETTINGS_DEFAULTS, { contacts: sb.mcpDedupeDefault('contacts'), jobs: sb.mcpDedupeDefault('jobs'), tasks: sb.mcpDedupeDefault('tasks') }, sb.MCP_RESERVED_HEADERS], 'mcp function: the same settings defaults, starting duplicate checks and refused header names');
  const canFn = (fn.match(/export const canUseMcp = [^\n]*/) || [''])[0];
  assertEqual([/role === "owner"/.test(canFn), /role === "manager"/.test(canFn), /permissions/.test(canFn), fn.includes('export const TOKEN_RE = /^ops_mcp_[A-Za-z0-9_-]{43}$/;')], [true, true, false, true], 'mcp function: canUseMcp is owners and managers only (no permissions switch), as the app; its keys look like mcpTokenLooksRight');
  assertEqual([/logKeepDays: intIn\(m\.logKeepDays, 7, 3650/.test(fn), /rateLimitPerMin: intIn\(m\.rateLimitPerMin, 1, 600/.test(fn), /trim\(\)\.slice\(0, 60\)/.test(fn)], [true, true, true], 'mcp function: the same setting limits as mcpSettingsOf');
  // static checks on the page code: no render loops, safe handlers, the key never kept
  const T2 = n => extractDecl(script, n);
  assertEqual([T2('mcpLoad').includes('if (MCP_UI.loading) { if (force) MCP_UI.again = true; return MCP_UI.loading; }'), /\brender\(\)/.test(T2('mcpLoad')), T2('mcpLoadLog').includes('if (MCP_UI.logLoading) return MCP_UI.logLoading'), /\brender\(\)/.test(T2('mcpLoadLog'))], [true, false, true, false], 'MCP loaders: memoized, and never render() themselves (only mcpRedraw, after the read)');
  const loadSrc = T2('mcpLoad');
  assertEqual([(loadSrc.match(/mcp_import_runs[^\n]*/g) || []).map(l => /\.is\('rule_id', null\)\.is\('undone_at', null\)/.test(l) ? 'deleted rules, not undone' : 'other'), loadSrc.includes('mcpRunsOf(r.id, mcpRunLimit(r.id) + 1)'), /\.eq\('rule_id', ruleId\)/.test(T2('mcpRunsOf')), T2('mcpImportsBlock').includes("onclick=\"mcpMoreRuns('${rid}')\"")],
    [['deleted rules, not undone'], true, true, true], 'import history: read per rule (one more than shown, so "Older imports" can page back), never one capped list for all rules; deleted rules\' imports that can still be undone are read apart');
  assertEqual([/if \(MCP_UI\.again\) return;/.test(T2('mcpLoad')), T2('mcpLoad').includes('if (MCP_UI.again) { MCP_UI.again = false; mcpLoad(true); } else mcpRedraw();')], [true, true],
    'mcpLoad: a forced read asked for during a running one drops that answer (it may be from before the change) and reads once more');
  assertEqual([T2('mcpRedraw').includes("getElementById('mcp-keys-list')"), T2('mcpRedraw').includes('mcpKeepTyping(render)'), T2('mcpRuleModal').includes("if (!open && !document.querySelector('#modal-root .mcp-rule'))"), (script.match(/mcpRuleModal\(true\)/g) || []).length],
    [true, true, true, 1], 'MCP redraws: only the key list (a name being typed stays) and the page keeps typed text; the rule editor opens from one place and a late redraw never reopens it');
  assertEqual([T2('mcpSaveServer').includes('if (go && go.isConnected) closeModal()'), T2('mcpCommit').includes('if (go && go.isConnected) mcpPreviewClose()'), T2('mcpPreview').includes("document.getElementById('modal-root').innerHTML.trim()")],
    [true, true, true], 'MCP async steps close or open only their own window (not one opened while they waited)');
  const unsafe = ['renderMcpPage', 'mcpKeysHtml', 'mcpAllKeysBlock', 'mcpServersBlock', 'mcpImportsBlock', 'mcpRunHtml', 'mcpWhoBlock', 'mcpEditServer', 'mcpOpenRunTool', 'mcpRuleModal', 'mcpPreviewModal'].flatMap(n => {
    const t = T2(n);
    return [...t.matchAll(/on(?:click|change)="[a-zA-Z]+\('\$\{([^}]*)\}/g)].map(m => m[1]).filter(x => !x.startsWith('esc(jsStr(') && !new RegExp(`\\b${x}\\s*=\\s*esc\\(jsStr\\(`).test(t)).map(x => n + ': ' + x);
  });
  assertEqual(unsafe, [], 'MCP page: every id in an inline handler goes through esc(jsStr())');
  assertEqual(['mcpShowNewKey', 'mcpCreateKey', 'mcpCopy'].filter(n => /localStorage|sessionStorage|console\.|MCP_UI\.\w+\s*=[^;\n]*token/.test(T2(n))), [], 'MCP key: never stored, logged or kept in MCP_UI');
  const reveal = T2('mcpShowNewKey');
  assertEqual([reveal.includes(`onclick="mcpCopy('\${id}')"`) && ['mcp-reveal-path', 'mcp-reveal-key', 'mcp-reveal-url'].every(id => reveal.includes(`row('${id}'`)) && !/on\w+="[^"]*\$\{(token|v|url|pathUrl)\}/.test(reveal), T2('mcpCall').indexOf('readOnlyReason()') < T2('mcpCall').indexOf('fetch(')], [true, true], 'MCP key: the copy buttons name a field, never the key; mcpCall checks read-only mode before it sends');
  assertEqual([T2('renderShell').includes("${VIEW_AS_ID ? '' : mcpFooterButton(profile)}"), /mcp/i.test(T2('personAccessTab')), T2('personAccessTab').includes('setRows(PAGE_PICK.map(([k, l, desc]) => [esc(l)'), /setMcpPermission|mcpPeopleRows/.test(script)],
    [true, false, true, false], 'the way in: the footer button (not while viewing as someone); no per-person switch any more (People > Access shows only the unchanged page switches)');
  const footer = vm.runInNewContext(T2('mcpFooterButton') + `; ['manager', 'owner', 'va', 'technician', 'marketing'].map(role => mcpFooterButton({ role, permissions: { mcp: true } })).concat([mcpFooterButton(null)])`, { ico: () => '' });
  assertEqual(footer.map(h => /AI assistant keys/.test(h) && /onclick="openMcpKeys\(\)"/.test(h)), [true, false, false, false, false, false], 'footer "AI assistant keys": managers only (owners use Settings; nobody else, an old switch or not)');
  assertEqual([T2('mcpWhoBlock').includes('setToggle('), /Owners and managers/.test(T2('mcpWhoBlock'))], [false, true], 'Settings: "Who may make keys" says owners and managers, with nothing to switch');
  assertEqual([sb.PAGE_PICK.some(p => p[0]==='mcp'), /\bmcp\b/.test(T2('canViewSection')), /\bmcp\b/.test(extractDecl(script, 'SECTION_LABEL')), /\bmcp\b/.test(extractDecl(script, 'ALL_SECTIONS'))], [false, false, false, false], 'the mcp permission is not a page: PAGE_PICK, SECTION_LABEL, ALL_SECTIONS and canViewSection are unchanged');
  assertEqual([sb.CAT_NAMES.mcp, sb.settingsHistParts('Private connector (MCP): key "x" made')], ['Private connector (MCP)', { where: 'Private connector (MCP)', what: 'key "x" made' }], 'Settings history: the private connector\'s lines are grouped under it');
  // Stage 5 review fixes after the rebase
  // the jobs mapping's tax field says the business's own tax name (Settings → Region), as every other screen
  {
    const keep = sb.STATE.data.settings, setRegion = region => { sb.STATE.data.settings = { gstRatePercent: 10, catalog: region ? { region } : {} }; };
    const shown = () => [sb.mcpFieldLabel('jobs', 'includes_gst'), sb.mcpMappingRows('jobs', {}).find(r => r.target==='includes_gst').label, sb.mcpFieldLabel('jobs', 'amount')];
    setRegion(null); const au = shown();
    setRegion({ country: 'GB' }); const gb = shown();
    setRegion({ country: 'US', state: 'TX' }); const us = shown();
    setRegion({ taxName: 'IVA' }); const own = shown();
    sb.STATE.data.settings = keep;
    assertEqual([au, gb, us, own], [['Includes GST', 'Includes GST', 'Amount'], ['Includes VAT', 'Includes VAT', 'Amount'], ['Includes Sales tax', 'Includes Sales tax', 'Amount'], ['Includes IVA', 'Includes IVA', 'Amount']],
      'MCP import mapping: "Includes GST" follows the region\'s tax name (GB = VAT, US = Sales tax, the business\'s own word)');
  }
  // an undo's "being undone" window is the function's UNDO_STALE_MS
  assertEqual([fnObj(/export const RUN_STALE_MS = ([^;]+);/), fn.includes('export const UNDO_STALE_MS = RUN_STALE_MS;')], [sb.MCP_UNDO_STALE_MS, true], 'mcp function: Undo can resume after the same 10 minutes the page waits before saying "press Undo again"');
  // "Older imports" pages back for real: no cap on how many a rule shows, read 1,000 a request
  {
    const ctx = { MCP_UI: { runLimit: { r1: 1205, r2: 'x' } }, calls: [] };
    const runs = Array.from({ length: 2300 }, (_, i) => ({ id: 'run' + String(i).padStart(5, '0'), rule_id: 'r1', started_at: new Date(Date.parse('2026-10-14T00:00:00Z') - i * 3600e3).toISOString() }));
    ctx.sb = { from: t => { const q = { f: [], select(){ return q; }, eq(k, v){ q.f.push([k, v]); return q; }, order(){ return q; },
      range(a, z){ ctx.calls.push([t, a, z]); const rows = runs.filter(r => q.f.every(([k, v]) => r[k]===v)); return Promise.resolve({ data: rows.slice(a, Math.min(z + 1, a + 1000)), error: null }); } }; return q; } };
    vm.createContext(ctx);
    vm.runInContext([extractDecl(script, 'MCP_RUN_COLS'), extractDecl(script, 'mcpRunLimit'), extractDecl(script, 'mcpRunsOf')].join('\n') + '\nthis.T = { mcpRunLimit, mcpRunsOf };', ctx);
    assertEqual([ctx.T.mcpRunLimit('r1'), ctx.T.mcpRunLimit('r2'), ctx.T.mcpRunLimit('r3')], [1205, 5, 5], 'mcpRunLimit: as many as "Older imports" asked for (no 500 cap); 5 to start');
    (async () => {
      const got = await ctx.T.mcpRunsOf('r1', 1206), few = await ctx.T.mcpRunsOf('r1', 6), none = await ctx.T.mcpRunsOf('r9', 6);
      assertEqual([got.data.length, got.data[1205].id, ctx.calls.slice(0, 2), few.data.length, none.data.length, ctx.calls.length], [1206, 'run01205', [['mcp_import_runs', 0, 999], ['mcp_import_runs', 1000, 1205]], 6, 0, 4],
        'mcpRunsOf: a rule\'s imports past 1,000 are read in pages (the 1,206th, from the hourly rule\'s 51st day, keeps its Undo); a short page stops');
    })().catch(e => assertEqual(String(e), '', 'mcpRunsOf threw'));
  }
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
  sb.STATE.data.settings = { catalog: { pay: { jobTypes: { Guy: ['Aircon', 'Other'], Alessandro: ['Pressure Washing'] } } } };
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
  // Round 3 item 6: no edit window any more. Name and roles are edited in place on Details; a rename still asks first and
  // goes through rename_team_member.
  assertEqual([fnText('openEmployeeModal'), fnText('saveEmployeeModal'), /openEmployeeModal|saveEmployeeModal|EMP_RENAME_OK|id="em-/.test(html2), /Edit name and roles/.test(fnText('renderPersonPanel'))], ['', '', false, false], 'people: the edit window, its save and its button are gone');
  assertEqual([fnText('personDetailsTab').includes('setEmployeeName('), fnText('personDetailsTab').includes('setEmployeeRole('), fnText('renameEmployee').includes("sb.rpc('rename_team_member'"), fnText('setEmployeeName').includes('confirmAction('), fnText('noRecordNote').includes('addEmployeeCard(')],
    [true, true, true, true, true], 'people: Details edits the name (confirmed, then renamed everywhere by the RPC) and the roles; a login with no card gets one straight away');
  { const rn = fnText('renameEmployee'), iPay = rn.indexOf("await catalogSave('pay'"), iPeople = rn.indexOf("await catalogSave('people'"), iLoad = rn.indexOf('await loadFromSupabase()');
    assertEqual([iPay > 0, iPeople > iPay, iLoad > iPeople, /[^t] catalogSave\(/.test(rn.replace(/await catalogSave\(/g, ''))], [true, true, true, false], 'rename: the pay and people saves are waited for one after the other, both before the reload (no racing whole-catalog saves)'); }
  const tabsText = ['personDetailsTab', 'personPayTab', 'personDocsTab'].map(fnText).join('\n');
  const once = f => (tabsText.match(new RegExp(`(setEmployeeField\\('\\$\\{e\\.id\\}','${f}'|input\\('${f}'|sel\\('${f}')`, 'g')) || []).length;
  assertEqual(Object.keys(sb.EMP_FIELD_LABEL).filter(f => once(f)!==1).concat(['setEmployeeName(', 'setEmployeeRole(', "'empStatus'"].filter(t => tabsText.split(t).length - 1!==1)), [], 'people: every field is on the tabs exactly once');
  assertEqual([fnText('personPayTab').includes("'commissionNotes'"), fnText('personDetailsTab').includes("'commissionNotes'")], [true, false], 'people: commission notes are on the Pay tab only');
  assertEqual((html2.match(/db\.commissionRates\.set\(/g) || []).length, 2, 'commission rates are written in two places only: one rate on the Pay tab, and the move on a rename');
}

// The app tells the automation engine "look now" only for what it saves itself: a stage move, a lead made by hand, a new job.
function testAutomationEventBody(sb){
  console.log('\nAutomation engine: the app\'s "look now" (phase 4)');
  const B = sb.automationEventBody;
  assertEqual(B('stage', 'abc'), { step:'event', type:'stage', id:'abc' }, 'a stage move');
  assertEqual([B('newLead', ' c1 ').id, B('jobClosed', 42)], ['c1', { step:'event', type:'jobClosed', id:'42' }], 'a new lead and a new job (the id as text)');
  assertEqual([B('rain', 'abc'), B('stage', ''), B('stage', null), B('stage', '  ')], [null, null, null, null], 'an unknown event or no id: nothing');
  assertEqual([B('missedCall', 'k1'), B('chat', 's1')], [null, null], 'missed calls and chats are never sent by the app (the timer finds them)');
}
// Automations: the flow view (phase 4, group J). Every list comes from a registry fixture and a catalog fixture, the
// same way the builder passes its own (ctx.registry) — nothing about one business is written into the flow code.
function flowFixture(){
  const REG = {
    triggers: {
      stage: { label: 'A lead moves to a stage', icon: 'kanban', customer: true, phrase: t => `a lead moves to ${t.params && t.params.stage}` },
      newLead: { label: 'A new lead comes in', icon: 'userPlus', customer: true },
      shift: { label: 'A team member starts a shift', customer: false },
    },
    conds: {
      service: { label: 'Service', valueSource: 'catalog.services', appliesTo: ['stage', 'newLead'] },
      tag: { label: 'Tag', valueSource: 'catalog.tags', appliesTo: ['stage', 'newLead', 'shift'] },
      has_email: { label: 'Has an email address', appliesTo: ['stage', 'newLead'] },
      stage_unchanged: { label: 'Still in the stage that started it', fits: t => !!t && t.type==='stage' },
    },
    actions: {
      push: { label: 'A phone notification to team members', icon: 'bell', audience: 'team' },
      task: { label: 'A task in the app', icon: 'tasks', audience: 'team', make: () => ({ title: 'Call them back' }) },
      email: { label: 'An email to the customer', icon: 'mail', audience: 'customer', make: () => ({ subject: '', body: '' }) },
      text: { label: 'A text message to the customer', icon: 'message', audience: 'customer',
        available: ctx => ctx.phoneLive ? { ok: true } : { ok: false, why: 'Needs the business phone (Twilio)' } },
    },
  };
  const ctx = { registry: REG, phoneLive: false, sample: { first_name: 'Sam' },
    catalog: { services: [{ key: 'Aircon', label: 'Aircon' }], tags: [{ tag: 'VIP' }], stages: [{ key: 'Quoted', label: 'Quoted' }] } };
  return { REG, ctx };
}
function testFlowView(sb){
  console.log('\nAutomations: the flow view (phase 4, group J)');
  const J = x => JSON.stringify(x), ids = list => list.map(s => s.id);
  const { REG, ctx } = flowFixture();
  const W = (id, n) => ({ id, kind: 'wait', n: n || 1, unit: 'days' }), D = (id, type) => ({ id, kind: 'action', type: type || 'email' });
  const WIN = id => ({ id, kind: 'window', days: [1, 2, 3, 4, 5], from: '09:00', until: '17:00', outside: 'next' }), IF = (id, conds) => ({ id, kind: 'if', match: 'all', conds: conds || [] });

  // ids and the pure list moves
  const idIn = [{ id: 's1' }, { id: 's4' }, { id: 'x' }, { id: 's10a' }], idBefore = J(idIn);
  assertEqual([sb.flowStepId([]), sb.flowStepId(idIn), J(idIn)===idBefore], ['s1', 's5', true], 'flowStepId: s1 for none; the largest sN + 1 (ignores x and s10a); the input untouched');
  const abcd = ['a', 'b', 'c', 'd'].map(id => ({ id, kind: 'wait', n: 1, unit: 'days' })), abcdJ = J(abcd);
  const mv = (f, t, list) => ids(sb.flowMove(list || abcd, f, t));
  assertEqual([mv(0, 2), mv(3, 0), mv(1, 1), mv(-1, 2), mv(0, 4)], [['b', 'c', 'a', 'd'], ['d', 'a', 'b', 'c'], ['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd']], 'flowMove: 0→2, 3→0; the same place, or out of range, leaves the order');
  const locked = abcd.map((s, i) => i===0 ? { ...s, lock: true } : s);
  assertEqual([mv(0, 2, locked), sb.flowMove(abcd, 0, 2)!==abcd, J(abcd)===abcdJ], [['a', 'b', 'c', 'd'], true, true], 'flowMove: a locked step stays; the result is a new array; the input is never changed');
  assertEqual([sb.flowCanMove(abcd, 0, 2), sb.flowCanMove(locked, 0, 2), sb.flowCanMove(abcd, 1, 1), sb.flowCanMove(abcd, 0.5, 2), sb.flowCanMove(abcd, 0, '2')], [true, false, false, false, false], 'flowCanMove: only an unlocked, in-range, real move');
  assertEqual(ids(sb.flowMove([{ id: 'u', kind: 'later' }, ...abcd], 0, 2))[0], 'u', 'a step of a kind this app version does not know can\'t be moved (kept as it is)');
  const ins = sb.flowInsert(abcd, -3, { kind: 'wait', n: 2, unit: 'hours' });
  assertEqual([ids(ins)[0], ins[0].id, ids(sb.flowInsert(abcd, 99, { id: 'z', kind: 'if', conds: [] }))[4], J(abcd)===abcdJ], ['s1', 's1', 'z', true], 'flowInsert: clamps to the start / the end; a new step gets the next free id, one with an id keeps it; the input untouched');
  const rm = sb.flowRemove(abcd, 1), rmL = sb.flowRemove(locked, 0), rmO = sb.flowRemove(abcd, 9);
  assertEqual([ids(rm.steps), rm.removed.id, rmL.removed, ids(rmL.steps), rmO.removed, J(abcd)===abcdJ], [['a', 'c', 'd'], 'b', null, ['a', 'b', 'c', 'd'], null, true], 'flowRemove: the middle step comes out and is returned; a locked or missing one is refused');
  const M = [10, 30, 50, 70];
  assertEqual([sb.flowDropIndex(M, 35, 0), sb.flowDropIndex(M, 5, 0), sb.flowDropIndex(M, 100, 0), sb.flowDropIndex(M, 25, 3), sb.flowDropIndex(M, 50, 2)], [1, 0, 3, 1, 2], 'flowDropIndex: counts the other blocks\' midpoints above the dragged one');

  // what the form can show
  const S = (...kinds) => kinds.map((k, i) => ({ id: 's' + (i + 1), kind: k }));
  assertEqual(sb.flowFormSlots(S('wait', 'window', 'if', 'action', 'action')), { wait: 0, window: 1, if: 2, doFrom: 3, doTo: 4, extra: false }, 'form slots: wait, window, condition, then two Do steps — all in the form');
  const fi = sb.flowFormSlots(S('if', 'wait', 'action'));
  assertEqual([fi.wait, fi.if, fi.extra], [1, 0, false], 'form slots: a condition before the wait is still form-shaped');
  const wdwd = sb.flowFormSlots(S('wait', 'action', 'wait', 'action'));
  assertEqual([wdwd.doFrom, wdwd.doTo, wdwd.extra, sb.flowIsFormShaped(S('wait', 'action', 'wait', 'action'))], [1, 1, true, false], 'form slots: wait, do, wait, do has more than the form can show');
  assertEqual([sb.flowFormSlots(S('wait', 'wait', 'action')).extra, sb.flowFormSlots([]), sb.flowFormSlots(S('action'))], [true, { wait: -1, window: -1, if: -1, doFrom: -1, doTo: -1, extra: false }, { wait: -1, window: -1, if: -1, doFrom: 0, doTo: 0, extra: false }], 'form slots: two waits before the first Do → extra; none; a single Do');
  assertEqual(sb.flowFormSlots([{ id: 'u', kind: 'later' }, D('s2')]).extra, true, 'form slots: a step the app does not know is never hidden by the form (it shows under "More steps")');
  const comp = [IF('a'), W('b'), { ...IF('c'), lock: true }, IF('d', [{ field: 'has_email', op: 'true' }]), { id: 'e', kind: 'later' }], compJ = J(comp);
  assertEqual([ids(sb.flowCompact(comp)), J(comp)===compJ], [['b', 'c', 'd', 'e'], true], 'flowCompact (on Save): an empty "Only if" goes; a locked one, the rest and unknown kinds stay, in order');
  assertEqual([undefined, 5, 0, 500, 'abc', 25].map(v => sb.flowMaxSteps({ maxSteps: v })), [20, 5, 1, 30, 20, 25], 'max steps: a setting (default 20), between 1 and the database\'s 30');

  // problems
  const has = (list, t) => list.some(p => p.text===t);
  assertEqual([has(sb.flowProblems({ steps: [D('s1')] }, ctx), 'Pick what starts it.'), has(sb.flowProblems({ trigger: { type: 'newLead' }, steps: [] }, ctx), 'Add at least one Do step.')], [true, true], 'problems: nothing starts it; no Do step');
  const last = sb.flowProblems({ trigger: { type: 'newLead' }, steps: [D('s1'), W('s2')] }, ctx).find(p => p.id==='s2');
  assertEqual(last && last.text, 'Step 2: The last step does nothing. End with a Do step, or remove it.', 'problems: a last step that does nothing is named by its place');
  const many = Array.from({ length: 21 }, (_, i) => D('s' + (i + 1), 'push'));
  assertEqual([has(sb.flowProblems({ trigger: { type: 'newLead' }, steps: many }, ctx), 'At most 20 steps.'), has(sb.flowProblems({ trigger: { type: 'newLead' }, steps: many }, { ...ctx, maxSteps: 25 }), 'At most 25 steps.')], [true, false], 'problems: more steps than the business allows');
  assertEqual(sb.flowProblems({ trigger: { type: 'shift' }, steps: [D('s1', 'email')] }, ctx).map(p => p.text), ['Step 1: There is no customer to send to for this start.'], 'problems: a customer message under a start with no customer');
  assertEqual(sb.flowProblems({ trigger: { type: 'newLead' }, steps: [IF('s1', [{ field: 'stage_unchanged', op: 'true' }]), D('s2', 'push')] }, ctx).map(p => p.text), ['Step 1: This condition doesn\'t fit what starts it.'], 'problems: a condition that does not fit the start (the registry decides)');
  assertEqual(sb.flowProblems({ trigger: { type: 'stage', params: { stage: 'Quoted' } }, steps: [W('s1', 3), D('s2', 'email')] }, ctx), [], 'problems: a valid wait + email under a customer start: none');

  // the "+" menu comes from the registry
  const menu = (type, c) => sb.flowAddMenuItems({ trigger: type ? { type } : null, steps: [] }, c || ctx);
  const byA = (list, a) => list.find(x => x.action===a);
  const team = menu('shift');
  assertEqual([team.slice(0, 3).map(x => x.kind), byA(team, 'email').disabled, byA(team, 'email').why, byA(team, 'push').disabled], [['wait', 'window', 'if'], true, 'There is no customer for this start', false], '+ menu: wait, window, condition; under a team-only start every customer action is off, with why');
  const t0 = byA(menu('newLead'), 'text'), t1 = byA(menu('newLead', { ...ctx, phoneLive: true }), 'text');
  assertEqual([t0.disabled, /business phone/.test(t0.why), t1.disabled], [true, true, false], '+ menu: a text needs the business phone (Twilio); on once it is live');
  REG.actions.slack = { label: 'A message to a team chat', icon: 'chat', audience: 'team' };
  assertEqual([byA(menu('newLead'), 'slack').label, menu('newLead').length], ['Do: A message to a team chat', 8], '+ menu: one more action in the registry = one more line, no flow code changed');
  delete REG.actions.slack;

  // phrases: registries + the business's catalog, never fixed names
  const def = { trigger: { type: 'stage', params: { stage: 'Quoted' } }, steps: [W('s1', 3), WIN('s2'), IF('s3', [{ field: 'service', op: 'is', v: 'Aircon' }]),
    { id: 's4', kind: 'action', type: 'email', subject: 'Quote follow-up', body: '{first_name}, any questions about the quote?' }, W('s5', 2), { id: 's6', kind: 'action', type: 'task', title: 'Call them' }] };
  const sentence = 'When a lead moves to Quoted, then wait 3 days, then only Mon–Fri, 9 am–5 pm (otherwise wait), then only if service is Aircon, then an email to the customer: Quote follow-up, then wait 2 days, then a task in the app: Call them.';
  assertEqual(sb.flowSentence(def, ctx), sentence, 'the sentence: When …, then each step in order, ending with a full stop');
  const renamed = { ...ctx, catalog: { ...ctx.catalog, services: [{ key: 'Aircon', label: 'Air conditioning' }] } };
  assertEqual(sb.flowSentence(def, renamed).includes('only if service is Air conditioning'), true, 'the service\'s name comes from the business\'s own catalog (renamed there → renamed here)');
  assertEqual([sb.flowStepSummary(W('x', 1), def, ctx), sb.flowStepSummary({ id: 'u', kind: 'later' }, def, ctx), sb.flowStepSummary(IF('x'), def, ctx)], ['Wait 1 day', 'Unknown step', 'Only if … (no condition yet)'], 'summaries: one day; an unknown kind; an empty condition');
  assertEqual([sb.flowWindowPhrase({ days: [0, 1, 2, 3, 4, 5, 6], from: '08:00', until: '24:00', outside: 'skip' }), sb.flowWindowPhrase({ mode: 'office', outside: 'at', at: '08:30' }), sb.flowDaysText([1, 3, 5]), sb.flowDaysText([6, 0])],
    ['Only every day, 8 am–midnight (otherwise stop)', 'Only in office hours (otherwise at 8:30 am on the next allowed day)', 'Mon, Wed, Fri', 'Sat, Sun'], 'windows in plain words');
  assertEqual(sb.flowMoveLabel('Wait 3 days', 2, 6), 'Moved "Wait 3 days" to step 3 of 6.', 'the screen-reader line after a move');

  // the canvas
  const four = { trigger: { type: 'newLead' }, steps: [W('s1'), WIN('s2'), IF('s3', [{ field: 'has_email', op: 'true' }]), { id: 's4', kind: 'action', type: 'email', subject: 'Hello', body: '{first_name}, thanks!' }] };
  const html = sb.flowCanvasHtml(four, ctx, { sel: 's2' });
  const count = (h, re) => (h.match(re) || []).length;
  assertEqual([count(html, /class="flow-block/g), count(html, /class="flow-add"/g), count(html, /class="flow-grip"/g)], [5, 5, 4], 'canvas: 4 steps + the start = 5 blocks, 5 "+", 4 handles');
  const block = id => html.slice(html.indexOf(`data-step="${id}"`), html.indexOf('</li>', html.indexOf(`data-step="${id}"`)));
  assertEqual([/aria-label="Move up" title="Move up" disabled/.test(block('s1')), /aria-label="Move down" title="Move down" disabled/.test(block('s4')), /aria-label="Move down" title="Move down" disabled/.test(block('s1'))], [true, true, false], 'canvas: the first can\'t go up, the last can\'t go down');
  assertEqual([/flow-block k-window sel"/.test(html), /aria-expanded="true" aria-controls="flow-panel" onclick="flowSelect\('s2'\)"/.test(html), count(html, /aria-expanded="true"/g)], [true, true, 1], 'canvas: the chosen step is marked and its button says it is open');
  assertEqual(/<div class="flow-msg"[^>]*><b>Hello<\/b> · Sam, thanks!<\/div>/.test(html), true, 'canvas: a Do step carries its message, filled with sample words');
  assertEqual(sb.flowCanvasHtml({ trigger: { type: 'newLead' }, steps: [{ id: 't1', kind: 'action', type: 'task', title: 'Call them' }] }, ctx, {}).includes('flow-msg'), false, 'canvas: a Do step with no words of its own has no message card (its title is already in the block)');
  assertEqual([sb.flowMsgHtml({ id: 'm1', kind: 'action', type: 'email', subject: 'For {first_name}', body: 'Hi <b>{first_name}</b>' }, ctx), sb.flowMsgHtml(W('w1'), ctx), sb.flowMsgHtml({ id: "q'1", kind: 'action', type: 'email', body: 'x' }, ctx).includes("flowSelect('q\\'1')")],
    ['<div class="flow-msg" onclick="flowSelect(\'m1\')"><b>For Sam</b> · Hi &lt;b&gt;Sam&lt;/b&gt;</div>', '', true], 'message card: its name and words are filled with sample values and escaped; none on a non-Do step');
  assertEqual(sb.flowOpenInnerHtml('Wait', 'Wait <3> days', true).replace(/<span class="pill[\s\S]*$/, ''), '<small>Wait</small><b>Wait &lt;3&gt; days</b><span class="flow-warn">', 'a block\'s words are escaped; "Needs a look" when Save would object');
  const atMax = sb.flowCanvasHtml(four, { ...ctx, maxSteps: 4 }, {});
  assertEqual([count(atMax, /class="flow-add"[^>]* disabled title="At most 4 steps"/g)], [5], 'canvas: at the business\'s maximum every "+" is off');
  const mir = sb.flowCanvasHtml(four, ctx, { locked: true });
  assertEqual([count(mir, /class="flow-grip"/g), count(mir, /class="flow-add"/g), count(mir, /Delete this step/g), count(mir, /Move up/g), count(mir, /class="flow-lock"/g)], [0, 0, 0, 0, 4], 'canvas: a ready-made mirror has no handle, no "+", no bin and no moves (its order is fixed)');
  const tail = { trigger: { type: 'newLead' }, steps: [D('s1', 'push'), W('s2')] };
  assertEqual([sb.flowCanvasHtml(tail, ctx, {}).includes('Needs a look'), sb.flowCanvasHtml(tail, ctx, { locked: true }).includes('Needs a look')], [true, false], 'canvas: "Needs a look" marks a step Save would object to; never on a ready-made mirror (it runs on its existing code)');
  const evil = '"><img src=x onerror=alert(1)>';
  const xs = sb.flowCanvasHtml({ trigger: { type: 'newLead' }, steps: [IF("a'b", [{ field: 'tag', op: 'has', v: evil }]), D('s2', 'push')] }, { ...ctx, catalog: { ...ctx.catalog, tags: [{ tag: evil }] } }, {});
  assertEqual([xs.includes('&lt;img'), xs.includes('<img'), xs.includes("flowSelect('a\\'b')"), xs.includes("flowSelect('a'b')")], [true, false, true, false], 'canvas: a tag name with HTML is shown as text; a step id with a quote is escaped in the handlers');
  assertEqual(/#[0-9a-f]{3,6}\b|rgb\(/i.test(html.replace(/<svg[\s\S]*?<\/svg>/g, '')), false, 'canvas: no colour literal (tokens only)');
  const inl = sb.flowCanvasHtml(four, ctx, { sel: 's3', inline: true, panelHtml: '<section id="flow-panel">P</section>' });
  assertEqual([count(inl, /flow-inline-panel/g), inl.indexOf('flow-inline-panel') > inl.indexOf('data-step="s3"') && inl.indexOf('flow-inline-panel') < inl.indexOf('data-step="s4"')], [1, true], 'canvas on a phone: the panel opens under the chosen block');

  // nothing on the render path redraws (the phase-3 freeze)
  let renders = 0, edRenders = 0; sb.render = () => { renders++; }; sb.autoEdRender = () => { edRenders++; };
  for (let k = 0; k < 3; k++) { sb.flowCanvasHtml(def, ctx, { sel: 's1' }); sb.flowSentence(def, ctx); sb.flowProblems(def, ctx); sb.flowFormSlots(def.steps); sb.flowMoreStepsHtml(def, ctx); }
  assertEqual([renders, edRenders], [0, 0], 'drawing the flow view never asks for a redraw (no loader, nothing async)');

  // the viewer's choice of view
  sb.localStorage = { getItem(){ throw new Error('blocked'); }, setItem(){ throw new Error('blocked'); } };
  let threw = false; try { sb.setFlowViewPref('flow'); } catch (e) { threw = true; }
  const pref = [sb.flowViewPref(), threw];
  const store = {}; sb.localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
  sb.setFlowViewPref('flow'); pref.push(sb.flowViewPref()); store['ops.autoEditorView'] = 'xyz'; pref.push(sb.flowViewPref());
  assertEqual(pref, ['form', false, 'flow', 'form'], 'the view choice: blocked storage → Form, no error; Flow is remembered; anything else → Form');
  const tog = sb.flowViewToggleHtml('flow');
  assertEqual([/role="radiogroup" aria-label="How to edit"/.test(tog), /aria-checked="true" tabindex="0" onclick="flowSetView\('flow'\)">Flow/.test(tog)], [true, true], 'the Form / Flow switch is a radio group');

  // the form writes into the same steps (round trip)
  const formDef = [W('s1', 3), IF('s2', [{ field: 'has_email', op: 'true' }]), D('s3', 'email')];
  const rightAway = sb.flowFormSetSlot(formDef, 'wait', null, ctx), after = sb.flowFormSetSlot(rightAway, 'wait', { n: 3, unit: 'days' }, ctx);
  assertEqual([ids(rightAway), [after[0].kind, after[0].n, after[0].unit, after[0].id], J(after.slice(1))===J(formDef.slice(1)), after.length], [['s2', 's3'], ['wait', 3, 'days', 's4'], true, 3], 'form: "Right away" removes the wait, "After 3 days" puts it back first (only its id is new)');
  const win = sb.flowFormSetSlot(formDef, 'window', { outside: 'skip' }, { ...ctx, office: { days: { 1: { from: 540, to: 1020 }, 2: { from: 540, to: 1020 } } } });
  assertEqual([win[1].kind, win[1].days, win[1].from, win[1].until, win[1].outside], ['window', [1, 2], '09:00', '17:00', 'skip'], 'form: unticking "Any day, any time" adds a window after the wait, from the business\'s office hours');
  const noIf = [W('s1'), D('s2')];
  assertEqual([ids(sb.flowFormSetSlot(noIf, 'if', { conds: [] }, ctx)), sb.flowFormSetSlot(noIf, 'if', { conds: [{ field: 'has_email', op: 'true' }] }, ctx).map(s => s.kind)], [['s1', 's2'], ['wait', 'if', 'action']], 'form: the first condition adds an "Only if" just before the Do steps');
  const withTask = sb.flowFormSetAction(formDef, 'task', true, ctx, { type: 'newLead' });
  assertEqual([withTask.map(s => s.type || s.kind), withTask[2].title, ids(sb.flowFormSetAction(withTask, 'email', false, ctx))], [['wait', 'if', 'task', 'email'], 'Call them back', ['s1', 's2', 's4']], 'form: a channel switch adds its Do step in the registry\'s order (a task before an email), and removes it');
  const push = sb.flowFormSetAction(formDef, 'push', true, ctx, { type: 'newLead' });
  assertEqual(push.map(s => s.type || s.kind), ['wait', 'if', 'push', 'email'], 'form: a notification goes before the email (registry order)');
  const seq = [W('s1'), D('s2', 'email'), W('s3', 2), D('s4', 'task')];
  assertEqual([ids(sb.flowFormSetSlot(seq, 'wait', null, ctx)), ids(sb.flowFormSetAction(seq, 'task', false, ctx))], [['s2', 's3', 's4'], ['s1', 's2', 's3', 's4']], 'form on a longer automation: only the first part changes (the later task stays)');
  const more = sb.flowMoreStepsHtml({ trigger: { type: 'newLead' }, steps: seq }, ctx);
  assertEqual([/More steps/.test(more), /<b>Step 3<\/b> Wait 2 days/.test(more), /<b>Step 4<\/b> A task in the app/.test(more), /Step 1/.test(more), /flowSetView\('flow'\)/.test(more), sb.flowMoreStepsHtml({ steps: formDef }, ctx)], [true, true, true, false, true, ''], '"More steps" lists every step the form can\'t show, with the way to Flow; nothing for a form-shaped one');
  const made = sb.FLOW_STEP_KINDS.action.make(ctx, { type: 'newLead' }, 'email');
  assertEqual([made.kind, made.type], ['action', 'email'], 'a new Do step is the engine\'s own shape (kind action + type)');

  // the static rules of the flow view's code
  const html0 = fs.readFileSync(INDEX_HTML_PATH, 'utf8'), script = html0.match(/<script>([\s\S]*?)<\/script>/)[1];
  const fns = [...script.matchAll(/function ((?:flow|setFlow)\w*)\(/g)].map(m => m[1]);
  const bodyOf = n => extractDecl(script, n);
  assertEqual(['pointermove', 'pointerup', 'pointercancel', 'keydown'].map(ev => bodyOf('flowDragStart').includes(`addEventListener('${ev}'`) && bodyOf('flowDragCleanup').includes(`removeEventListener('${ev}'`)), [true, true, true, true], 'drag: the four listeners go on at the start and all come off in the one cleanup');
  assertEqual([/flowDragCleanup\(\)/.test(bodyOf('flowDragEnd')), /flowDragCleanup\(\)/.test(bodyOf('flowDragCancel'))], [true, true], 'drag: the end and the cancel both use that cleanup');
  assertEqual(fns.filter(n => /\brender\(\)|\bdb\.|\bsb\.|fetch\(/.test(bodyOf(n))), [], 'no flow function redraws the whole app, touches the database or calls a server');
  assertEqual([fns.length >= 40, /FLOW_DRAG/.test(bodyOf('renderKeepingInput'))], [true, true], 'live updates wait while a flow block is dragged');
  assertEqual([/flowRefreshBlocks\(\)/.test(bodyOf('autoEdRefresh')), /autoEdRender|flowRedraw|\brender\(|focus\(/.test(bodyOf('flowRefreshBlocks'))], [true, false], 'typing in a panel updates the blocks in place (no redraw, no focus change)');
  const css = html0.slice(html0.indexOf('/* flow view */'), html0.indexOf('/* /flow view */'));
  assertEqual([css.length > 500, /#[0-9a-f]{3,6}\b|rgb\(/i.test(css)], [true, false], 'the flow view\'s CSS uses the theme tokens only');
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
  assertEqual(['Select all', 'Clear', 'areas ticked', 'Include sensitive details (bank, ${bizNumberLabel()}, owner salaries)', 'It unticks itself after each download.', 'For this download only: the Excel will have bank details, ${bizNumberLabel()} and owner salaries.', 'Download Excel (one sheet per area)', "'ex-block'", 'id="dx-go"'].filter(x => !block.includes(x)), [], 'Export to Excel: the mockup\'s controls and wording');
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
testRegionCore(loadSandbox());
testPublicHolidays(loadSandbox());
testRegionStatic();
testChaseCountSetting(loadSandbox());
testLostReasonDelete(loadSandbox());
testPipelineStages(loadSandbox());
testConnectedSources(loadSandbox());
testServicesPeoplePipeline(loadSandbox());
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
testUxRound3(loadSandbox());
testMcpConnector(loadSandbox());
testSecurityFaceId(loadSandbox());
testAutomationEventBody(loadSandbox());
testFlowView(loadSandbox());
testAutomationsBuilder(loadSandbox());
testNamesAndLabels(loadSandbox());
testAutomationsEditor();
testAutomationsEditorKeys();

// ── Saving keeps the place, the settings menu as a panel, drag & drop on every upload (round 3, A-ux) ──
// No promise-memo test here on purpose: this group adds no loader (nothing it adds fetches or redraws on its own).
function testUxRound3(sb){
  console.log('\nSaving keeps the place, settings menu panel, drag & drop (round 3, A-ux)');
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8'), script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  // T1.8: which view a render draws, and what it does with the window's scroll.
  const ph = { tab: 'settings', settings: { page: 'phone', open: true } };
  const k = sb.renderViewKey(ph);
  assertEqual([k === sb.renderViewKey({ ...ph, mobileNavOpen: true, settings: { ...ph.settings, q: 'pho', reviewPreview: 'x' } }),
    k === sb.renderViewKey({ tab: 'settings', settings: { page: 'hours', open: true } }), k === sb.renderViewKey({ tab: 'settings', settings: { page: 'phone', open: true, conn: 'gads' } }),
    k === sb.renderViewKey({ tab: 'settings', settings: { page: 'phone', open: false } })],
    [true, false, false, false], 'view key: the same settings page whatever else changed; another page, a connector or the list is another view');
  assertEqual(sb.renderViewKey({ tab: 'dashboard', dashboard: { view: 'google' } }) === sb.renderViewKey({ tab: 'dashboard', dashboard: { view: 'meta' } }), false, 'view key: the dashboard\'s Google and Meta views differ');
  assertEqual(sb.renderViewKey({ tab: 'settings', settings: { page: 'connections', open: true } }), sb.renderViewKey({ tab: 'settings', settings: { page: 'connectors', open: true } }), 'view key: an old settings page name is the same view as its new name');
  assertEqual([sb.motionPageKey({ tab: 'dashboard', dashboard: { view: 'google' } }), sb.motionPageKey({ tab: 'payroll', payroll: { view: 'week' } }), sb.motionPageKey({ tab: 'settings', settings: { page: 'phone' } }), sb.motionPageKey({ tab: 'jobs' })],
    ['dashboard|google', 'payroll|week:', 'settings|', 'jobs|'], 'motionPageKey(ui): the same keys as before');
  assertEqual([sb.renderScrollPlan(null, k, 'crm'), sb.renderScrollPlan({ key: k, tab: 'settings' }, k, 'settings'),
    sb.renderScrollPlan({ key: 'settings||open:phone:', tab: 'settings' }, 'settings||open:hours:', 'settings'), sb.renderScrollPlan({ key: 'crm|pipeline', tab: 'crm' }, 'jobs|', 'jobs')],
    ['none', 'keep', 'none', 'top'], 'scroll plan: first render none, same view keeps, another settings page is left to its opener, another main page goes to the top');
  // T1.8: the settings search.
  const dataPg = { title: 'Data', desc: 'Your data is yours', group: 'Account', keywords: 'export excel spreadsheet' }, phonePg = { title: 'Phone', desc: 'Who answers the business number', group: 'Customers' };
  assertEqual([sb.settingsNavMatch(sb.settingsNavText(phonePg), ''), sb.settingsNavMatch(sb.settingsNavText(phonePg), '   '), sb.settingsNavMatch(sb.settingsNavText(phonePg), '  PHONE '),
    sb.settingsNavMatch(sb.settingsNavText(dataPg), 'excel'), sb.settingsNavMatch(sb.settingsNavText(phonePg), 'excel'), sb.settingsNavText(phonePg)],
    [true, true, true, true, false, 'phone who answers the business number customers '], 'settings search: empty finds all, case and spaces ignored, keywords count, no match hides');
  // T1.8: render() puts the menu's scroll back only after the page is drawn, and keeps the window where it was.
  const r = extractDecl(script, 'render');
  assertEqual([r.indexOf('putSide();   // only now') > r.indexOf("content.innerHTML = renderSettings(profile)"), r.slice(0, r.indexOf('const content =')).includes('const putSide = () =>') && !/\n\s*if \(sideScroll\) \{ const side/.test(r.slice(0, r.indexOf('const content ='))),
    r.includes('renderScrollPlan('), r.includes('window.scrollTo(0, winY)'), r.includes('RENDER_LAST = { key: view, tab: UI.tab }'),
    r.indexOf('refocus = keepFocus()') > -1 && r.indexOf('refocus = keepFocus()') < r.indexOf('app.innerHTML = renderShell'), r.indexOf('motionAfterRender(motionBefore') > r.indexOf('window.scrollTo(0, winY)'),
    r.includes('putSide(); RENDER_LAST = null; return;')],
    [true, true, true, true, true, true, true, true], 'render: menu scroll set after the page is drawn, window scroll kept, focus kept, motion after the restore');
  const rs = extractDecl(script, 'renderSettings'), fs2 = extractDecl(script, 'filterSettingsNav'), ssp = extractDecl(script, 'setSettingsPage');
  assertEqual([rs.includes('data-keep-focus="set-search"'), rs.includes('value="${esc(ui.q || \'\')}"'), rs.includes('settingsNavMatch(settingsNavText(pg), ui.q)'), /\.q = /.test(fs2), fs2.includes('settingsNavMatch('),
    ssp.includes('isPhoneWidth()'), ssp.includes('window.scrollTo(0, 0)'), ['closeSettingsPage', 'openConnector', 'closeConnector'].every(n => extractDecl(script, n).includes('window.scrollTo(0, 0)'))],
    [true, true, true, true, true, false, true, true], 'settings: the search keeps its text and filter; a different settings page opens at its top on every width');
  assertEqual([extractDecl(script, 'updateBusinessSetting').includes("showToast('Saved')"), extractDecl(script, 'updateBusinessProfileField').includes("showToast('Saved')")], [true, true], 'settings: a business setting saved says Saved');
  // keepFocus with a fake document: puts the focus and caret back on the same field after a redraw.
  const kf = { calls: [] }, fresh = { focus: (o) => kf.calls.push(['focus', o]), setSelectionRange: (a, b) => kf.calls.push(['sel', a, b]) };
  const doc = { activeElement: { dataset: { keepFocus: 'set-search' }, selectionStart: 2, selectionEnd: 4 }, querySelector: (q) => { kf.calls.push(['q', q]); return fresh; } };
  const kctx = { document: doc }; vm.createContext(kctx); vm.runInContext(extractDecl(script, 'keepFocus') + '\nthis.keepFocus = keepFocus;', kctx);
  const back = kctx.keepFocus(); back();
  doc.activeElement = { dataset: {} };
  assertEqual([kf.calls, kctx.keepFocus()], [[['q', '#content [data-keep-focus="set-search"]'], ['focus', { preventScroll: true }], ['sel', 2, 4]], null], 'keepFocus: focus and caret come back; a field without the mark is left alone');
  // T1.10: the settings menu as its own full-height panel on a computer.
  const fixedRule = (html.match(/\.app-grid\.on-settings \.set-nav \{[^}]*\}/) || [''])[0];
  const before901 = html.lastIndexOf('@media (min-width: 901px)', html.indexOf(fixedRule));
  assertEqual([extractDecl(script, 'renderShell').includes("UI.tab==='settings' ? ' on-settings' : ''"), ['position: fixed', 'top: 0', 'bottom: 0', 'border-inline-end: 1px solid var(--line)'].every(x => fixedRule.includes(x)),
    before901 > -1 && !html.slice(before901, html.indexOf(fixedRule)).includes('\n}\n'), html.includes('.app-grid.on-settings.nav-auto .set-nav { inset-inline-start: 0; }')],
    [true, true, true, true], 'settings menu: a fixed full-height panel with a divider on a computer, next to the app menu (or the edge when it is hidden)');
  const newRules = (html.match(/[^\n{}]*(?:on-settings|\.set-nav)[^{}\n]*\{[^}]*\}/g) || []).join('\n');
  assertEqual([/#[0-9a-fA-F]{3,8}\b/.test(newRules), /\.set-nav \{[^}]*position: sticky[^}]*max-height:[^}]*overflow-y: auto/.test(html), html.includes('.set-layout.show-page .set-nav { display: none; }'), html.includes('.sidebar, .main-col, .nav-edge::before, .set-nav { transition: none !important; }'), html.includes('.set-link[hidden] { display: none; }')],
    [false, true, true, true, true], 'settings menu: colours from the theme only (light, dark, branding); a phone keeps list → page; no slide with reduced motion');
  // T1.1: the rules each upload box checks a file against.
  const R = sb.DROP_RULES, MB = 1024 * 1024;
  assertEqual(['file', 'empDoc', 'contractorCert', 'bizCert'].map(x => [R[x].accept === sb.RECEIPT_TYPES, R[x].maxMb === sb.MAX_FILE_MB]), [[true, true], [true, true], [true, true], [true, true]], 'drop rules: photos and PDFs up to 20 MB, like their pickers');
  assertEqual([sb.MAX_FILE_MB, sb.dropFileType({ type: 'IMAGE/PNG' }), sb.dropFileType({ type: '', name: 'IMG_1.HEIC' }), sb.dropFileType({ type: '', name: 'x.locked' })], [20, 'image/png', 'image/heic', ''], 'dropFileType: from the browser, else from the name');
  assertEqual([sb.dropAccepts({ type: 'image/jpeg', name: 'a.jpg' }, sb.RECEIPT_TYPES), sb.dropAccepts({ type: 'application/pdf', name: 'a.pdf' }, sb.RECEIPT_TYPES),
    sb.dropAccepts({ type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: 'a.docx' }, sb.RECEIPT_TYPES), sb.dropAccepts({ type: 'image/heic', name: 'a.heic' }, 'image/*'),
    sb.dropAccepts({ type: '', name: 'data.LOCKED' }, '.locked'), sb.dropAccepts({ type: 'application/zip', name: 'data.zip' }, '.locked'), sb.dropAccepts({ type: 'x/y', name: 'z' }, ''),
    sb.dropAccepts({ type: 'image/gif', name: 'a.gif' }, R.logo.accept), sb.dropAccepts({ type: 'image/webp', name: 'a.webp' }, R.logo.accept)],
    [true, true, false, true, true, false, true, false, true], 'dropAccepts: the same accept list as the picker');
  const f = (name, type, mb) => ({ name, type, size: mb * MB });
  assertEqual([sb.dropCheck([], R.file), sb.dropCheck([f('a.pdf', 'application/pdf', 1), f('b.pdf', 'application/pdf', 1)], R.file).msg,
    sb.dropCheck([f('a.locked', '', 1), f('b.locked', '', 1)], R.backup).files.length, sb.dropCheck([f('a.gif', 'image/gif', 1)], R.logo).msg,
    sb.dropCheck([f('a.pdf', 'application/pdf', 21)], R.file).msg, sb.dropCheck([f('a.pdf', 'application/pdf', 21)], R.empDoc).msg, sb.dropCheck([f('a.png', 'image/png', 3)], R.logo).msg,
    sb.dropCheck([f('a.locked', '', 500)], R.backup).ok],
    [{ ok: false, msg: '' }, 'One file at a time here.', 2, 'Use a PNG, JPG or WebP picture', 'That file is over 20 MB. Use a smaller photo or a PDF.', 'That file is over 20 MB', 'That picture is over 2 MB', true],
    'dropCheck: one file at a time (backups take several), the type, then the size; backups have no size limit');
  assertEqual([0, 1, 2, 5].map(sb.dropRoutePlan), ['none', 'one', 'many', 'many'], 'dropRoutePlan: none, one box straight in, several highlighted');
  const za = sb.dropZoneAttrs('empDoc', { emp: 'e"1', kind: 'licence', side: 'back', Bad: 'x', empty: '' });
  assertEqual([za.includes('data-drop-zone="empDoc"'), za.includes('data-emp="e&quot;1"'), za.includes('ondrop="dropZoneDrop(event, this)"'), za.includes('data-Bad'), za.includes('data-empty'), za.includes('title="Or drag a file here"'),
    sb.dropZoneAttrs('backup', { title: 'Or drag the files here' }).includes('title="Or drag the files here"') && !sb.dropZoneAttrs('backup', { title: 'x' }).includes('data-title')],
    [true, true, true, false, false, true, true], 'dropZoneAttrs: escaped data, only plain lower-case keys, the hover text');
  // T1.1: the nine places, and the page-level drop.
  const has = (fn, x) => extractDecl(script, fn).includes(x);
  assertEqual([has('fileField', "dropZoneAttrs('file'"), has('personDocsTab', "dropZoneAttrs('empDoc'"), has('renderContractorPanel', "dropZoneAttrs('contractorCert'"), has('renderBusinessInsurance', "dropZoneAttrs('bizCert'"),
    has('renderBrandingPage', "dropZoneAttrs('logo'"), has('openLockedBackup', "dropZoneAttrs('backup'"), ['pickEmployeeDoc', 'pickContractorCertificate', 'pickBusinessCertificate'].every(n => has(n, 'DROP_RULES.')),
    ['file', 'empDoc', 'contractorCert', 'bizCert', 'logo', 'backup'].every(x => has('dropTake', `'${x}'`))],
    [true, true, true, true, true, true, true, true], 'drag & drop: every upload box takes a dropped file, through the same code as its picker');
  const dropL = script.slice(script.indexOf("window.addEventListener('drop'"), script.indexOf("window.addEventListener('drop'") + 400);
  assertEqual([script.includes('function fileDragOver('), script.includes('function onFileDropped('), script.includes("['dragover', 'drop'].forEach("), dropL.includes('routeDroppedFiles('),
    has('routeDroppedFiles', "'Nothing on this page takes a file'"), has('routeDroppedFiles', "'Drop it on one of the highlighted boxes'"), has('dropZonesShown', "getElementById('app-popup')")],
    [false, false, false, true, true, true, true], 'drag & drop: a file dropped outside a box goes to the page\'s box; the old swallow is gone');
}

// ── Names and labels (round 3, C-names: T1.7 the office's name, T1.9 no business or person names in the code) ──
function testNamesAndLabels(sb){
  console.log('\nNames and labels (round 3, C-names)');
  const html0 = fs.readFileSync(INDEX_HTML_PATH, 'utf8'), script = html0.match(/<script>([\s\S]*?)<\/script>/)[1];
  const set = (catalog, extra) => { sb.STATE.data.settings = { gstRatePercent: 10, ...(extra || {}), catalog: catalog || {} }; };
  // the office's name (Settings → Phone)
  set({});
  assertEqual([sb.officeLabel(), sb.officePossessive(), sb.taskBoardLabel('ron'), sb.taskBoardLabel('Guy')], ['Office', "Office's", 'Office Tasks', "Guy's Tasks"], 'office: nothing saved = Office');
  set({ labels: { office: '  Reception ' } });
  assertEqual([sb.officeLabel(), sb.taskBoardLabel('ron')], ['Reception', 'Reception Tasks'], 'office: the saved name, trimmed, on the office\'s board');
  sb.applyCatalog();
  assertEqual(sb.MD_BUBBLES.find(x => x[0]==='tasks')[1], "Reception tasks", 'office: My Day\'s tasks bubble follows the name (applyCatalog)');
  set({ labels: { office: 'x'.repeat(40) } });
  assertEqual(sb.officeLabel().length, 30, 'office: at most 30 characters');
  set({ labels: { office: 'Dispatch Team' } });
  const p1 = sb.officePossessive();
  set({ labels: { office: 'Ops Desks' } });
  assertEqual([p1, sb.officePossessive()], ["Dispatch Team's", "Ops Desks'"], "office: possessive ('s, or ' after an s)");
  set({}); sb.applyCatalog();
  assertEqual(sb.MD_BUBBLES.find(x => x[0]==='tasks')[1], "Office tasks", 'office: back to Office');
  // the office's board: a VA login (full name, technician name or first word) or an employee with the VA role
  sb.STATE.profiles = [{ role: 'va', fullName: 'Ron Cruz', technicianName: null }];
  sb.STATE.data.employees = [];
  const b1 = [sb.boardForAssignees(['Ron']), sb.boardForAssignees(['Ron Cruz']), sb.boardForAssignees(['Guy']), sb.boardForAssignees([])];
  sb.STATE.profiles = [];
  sb.STATE.data.employees = [{ name: 'Kim', roles: ['VA'], status: 'Active' }];
  assertEqual([...b1, sb.boardForAssignees(['Kim']), sb.boardForAssignees(['Ron'])], ['ron', 'ron', 'Guy', 'ron', 'ron', 'Ron'], 'board: the office person (login or employee card) → the office\'s board; no built-in name');
  assertEqual(/'Ron'|"Ron"/.test(extractDecl(script, 'boardForAssignees')), false, 'board: no person\'s name written in boardForAssignees');
  // the office's view on the tasks page: the first active VA employee
  const emp = (name, roles, status) => ({ name, roles, status: status || 'Active' });
  assertEqual([sb.officeAssignee({ employees: [emp('Guy', ['Technician']), emp('Old', ['VA'], 'Inactive'), emp('Ron', ['VA'])] }), sb.officeAssignee({ employees: [emp('Guy', ['Technician'])] }), sb.officeAssignee(null)], ['Ron', '', ''], 'officeAssignee: the first active VA, else none');
  sb.STATE.profiles = [{ role: 'va', fullName: 'Ron', technicianName: null }];
  const T = (id, assignees, board) => ({ id, assignees, board, status: 'Not Started' });
  const tasks = [T('t1', ['Ron'], 'ron'), T('t2', ['Ofek', 'Ron'], 'Ofek'), T('t3', ['Guy'], 'Guy'), T('t5', [], 'Noam')];
  const who = sb.officeAssignee({ employees: [emp('Ron', ['VA'])] });
  assertEqual(sb.tasksInView(tasks, who, { fullName: 'Ofek' }).map(t => t.id), ['t1', 't2'], 'office view: the same tasks as the old "Ron" view');
  // owners and the office person by name, from the logins
  const P = [{ role: 'owner', fullName: 'Ofek Shamir' }, { role: 'owner', fullName: 'Noam Gal' }, { role: 'va', fullName: 'Ron' }];
  assertEqual([sb.ownerNamesText(P, 'and'), sb.ownerNamesText(P, 'or'), sb.ownerNamesText([], 'or'), sb.ownerNamesText(undefined), sb.ownerNamesText([P[0]])], ['Noam and Ofek', 'Noam or Ofek', 'the owners', 'the owners', 'Ofek'], 'ownerNamesText: first names A–Z, or the owners');
  assertEqual([sb.listJoin(['A', 'B', 'C'], 'or'), sb.listJoin(['A', 'B']), sb.listJoin(['A'])], ['A, B or C', 'A and B', 'A'], 'listJoin: "or" when asked, "and" as before');
  assertEqual([sb.officeAgentName([{ role: 'va', fullName: 'Zoe Lee' }, { role: 'va', fullName: 'Kim Day' }, { role: 'owner', fullName: 'Al' }]), sb.officeAgentName([]), sb.officeAgentName(undefined)], ['Kim', '', ''], 'officeAgentName: the first VA A–Z, first name');
  // people's colours and names in the owners' reports (catalog.people)
  set({ people: { Noam: { color: 'person-3' }, Guy: { color: '#2F7D6E' }, Bad: { color: 'bogus' } } });
  assertEqual([sb.techColor('Noam'), sb.techColor('Guy'), sb.techColor('Bad'), sb.techColor('Sam'), sb.techColor(undefined)], ['var(--person-3)', '#2f7d6e', sb.techColor('Bad'), 'hsl(79,45%,45%)', 'hsl(0,45%,45%)'], 'techColor: a theme colour, a saved #hex, else the colour made from the name (Sam = 82879 % 360 = 79)');
  assertEqual(sb.techColor('Bad').startsWith('hsl('), true, 'techColor: an unusable saved colour = the made one');
  assertEqual(sb.PERSON_COLORS.map(p => p[0]), ['person-1', 'person-2', 'person-3', 'person-4'], 'PERSON_COLORS: the four theme colours');
  assertEqual([['--guy', '--dolev', '--noam', '--ofek'].filter(v => html0.includes(v)), (html0.match(/--person-1: #/g) || []).length], [[], 3], 'colours: the person colours are --person-1..4 in all three themes; no person names in the CSS');
  set({ people: { Ron: { reportName: 'רון' }, Ofek: { reportName: 'אופק' } } });
  assertEqual([sb.personReportName('Ron Cruz'), sb.personReportName('Kim Day'), sb.personReportName(''), sb.personReportName('Ofek')], ['רון', 'Kim', '', 'אופק'], 'personReportName: the saved name (full name or first name), else the first name');
  // the Hebrew report: whose tasks
  const K = sb.mdCounts({ tasks: [{ done: true }, { done: false }] });
  assertEqual([sb.mdTaskLines(K, 'רון השלים', 'רון')[1], sb.mdTaskLines(K, 'x', '')[1]], ['• המשימות של רון: 1/2', '• המשימות של המשרד: 1/2'], 'mdTaskLines: the tasks bubble names the office person (or "the office")');
  // the net-profit steps name the hourly staff from Payroll
  const np = { revenue: 1000, commission: 300, parts: 50, equipment: 50, marketing: 100, hourlyStaff: 80, owners: 600, days: 7, net: -180 };
  const s1 = sb.profitSteps(np, 'Office'), s0 = sb.profitSteps(np);
  assertEqual([s1.steps[5].label, s0.steps[5].label, s1.steps.map(x => [x.from, x.to])], ['Hourly staff (Office)', 'Hourly staff', [[0,1000],[700,1000],[650,700],[600,650],[500,600],[420,500],[-180,420],[-180,0]]], 'profitSteps: the hourly staff under the office\'s name (T1.7); the numbers unchanged');
  assertEqual([/officeAssignee\(data\)/.test(extractDecl(script, 'renderTasks')), extractDecl(script, 'renderTaskSwitcher').includes("name===office ? officeLabel() : name"), script.includes('profitSteps(np, officeLabel())')],
    [true, true, true], 'office task board and the hourly staff step: the office\'s name, not the person on it (T1.7)');
  // the business's own names
  set({}, { companyName: 'X Pty' });
  assertEqual([sb.brandName(), sb.bizShortName(), sb.bizLegalName()], ['X Pty', 'X Pty', 'X Pty'], 'names: the trading name; no short or legal name = the trading name');
  set({ business: { shortName: 'The Guys Group' }, brands: { Chimney: 'The Chimney Guys' } }, { companyName: 'X Pty', legalName: 'X Pty Ltd' });
  assertEqual([sb.bizShortName(), sb.bizLegalName(), sb.brandOf('Chimney'), sb.brandOf('Aircon')], ['The Guys Group', 'X Pty Ltd', 'The Chimney Guys', ''], 'names: the short name, the legal name, a saved brand; none = ""');
  set({});
  assertEqual([sb.brandName(), sb.bizShortName(), sb.brandOf('Chimney')], ['OPS Service', 'OPS Service', ''], 'names: nothing saved = the product\'s name, no brand');
  // the example in the template previews
  sb.STATE.profiles = [{ role: 'va', fullName: 'Ron' }];
  set({ brands: { Aircon: 'The AC Cleaning Guys' }, reviews: { links: { Aircon: { link: 'https://g.page/r/a/review', result: 'Fresh air!' } } } }, { companyName: 'X Pty' });
  const ex = sb.tplExample();
  assertEqual([ex.brand, ex.service, ex.review_link, ex.result, ex.agent, ex.business_name, ex.technician], ['The AC Cleaning Guys', 'aircon', 'https://g.page/r/a/review', 'Fresh air!', 'Ron', 'X Pty', 'Sam'], 'tplExample: this business\'s brand, service, link, line, office person and name');
  sb.STATE.profiles = []; set({});
  const ex0 = sb.tplExample();
  assertEqual([ex0.brand, ex0.review_link, ex0.result, ex0.agent, ex0.business_name], ['OPS Service', sb.TPL_EXAMPLE.review_link, sb.TPL_EXAMPLE.result, 'Kim', 'OPS Service'], 'tplExample: nothing saved = the neutral example');
  const mT = sb.MSG_TEMPLATES.find(m => m.id==='chatOpen'), vT = { chatOpen: sb.msgTemplateText('chatOpen') };
  assertEqual(sb.tplPreviewHtml(mT, vT) === sb.tplPreviewHtml(mT, vT, sb.tplExample()), true, 'tplPreviewHtml: the default example is tplExample()');
  const mG = sb.MSG_TEMPLATES.find(m => m.id==='phoneGreeting');
  assertEqual([sb.tplPreviewHtml(mG, { phoneGreeting: sb.msgTemplateText('phoneGreeting') }, { business_name: 'Acme' }).includes('Thanks for calling Acme. This call'), sb.tplPreviewHtml(mG, { phoneGreeting: sb.msgTemplateText('phoneGreeting') }).includes('{business_name}')], [true, false], 'tplPreviewHtml: the spoken words are shown with the business name filled in');
  // no names in the registries, no person-keyed constants left
  const NAMES = ['Ron', 'Ofek', 'Noam', 'Guy', 'Dolev', 'Omri', 'Alessandro', 'The Guys', '1300 380', 'theguyservicegroup', 'רון', 'אופק'];
  const regs = ['TPL_EXAMPLE', 'REVIEW_TPL_VARS', 'CHAT_TPL_VARS', 'MSG_TEMPLATES', 'REVIEW_DEFAULTS', 'PERSON_COLORS', 'CONTRACTOR_TRADES', 'AUTO_FIELDS', 'BIZ_TPL_VAR', 'CONNECTORS'].map(n => extractDecl(script, n)).join('\n');
  assertEqual(NAMES.filter(w => new RegExp('(^|[^A-Za-z])' + w + '(?![A-Za-z])').test(regs)), [], 'registries: no business, person or phone number written in');
  assertEqual(['TECH_COLORS', 'TECH_JOB_TYPES', 'PAYROLL_HEBREW_NAMES', 'CONV_BRANDS', 'CONTRACTOR_SERVICES'].filter(n => script.includes(n)), [], 'no constants keyed by a person or holding the brands');
  // contractors: the services list, then other trades
  set({});
  assertEqual(sb.contractorServices(), ['Aircon', 'Chimney', 'Pressure Washing', 'Electrical', 'Plumbing', 'Roof & gutters', 'Other'], 'contractorServices: the same list as before when nothing is changed');
  const keepActive = sb.ACTIVE.divisions;
  sb.ACTIVE.divisions = new Set(['Aircon', 'Pressure Washing', 'Other']);
  assertEqual(sb.contractorServices(), ['Aircon', 'Pressure Washing', 'Electrical', 'Plumbing', 'Roof & gutters', 'Other'], 'contractorServices: a switched-off service is left out, Other once');
  sb.ACTIVE.divisions = keepActive;
  // the agreement: the legal name and the region's law and standards
  const c = { name: 'Spark', contactPerson: 'Jake', services: ['Electrical'], deal: { type: 'commission', amount: 10 } };
  set({ region: { country: 'AU', state: 'VIC', stateName: 'Victoria' } }, { legalName: 'Acme Pty Ltd' });
  const hv = sb.contractorAgreementHtml(c, {});
  assertEqual([hv.includes('Acme Pty Ltd ("we", "us")'), hv.includes('to Australian standards'), hv.includes('the laws of Victoria'), (hv.match(/<h4>/g) || []).length], [true, true, true, 9], 'agreement: the legal name, Australian standards, the laws of Victoria; 9 sections');
  set({}, { companyName: 'The Guys Service Group', legalName: 'The Guys Service Group Pty Ltd' });
  const hn = sb.contractorAgreementHtml(c, {});
  assertEqual([hn.includes('The Guys Service Group Pty Ltd ("we", "us")'), hn.includes('to Australian standards'), hn.includes('the laws of New South Wales')], [true, true, true], 'agreement: nothing saved for the region = today\'s words (New South Wales, Australian)');
  set({ region: { country: 'US', state: 'TX' } }, { companyName: 'Acme' });
  const hu = sb.contractorAgreementHtml(c, {});
  assertEqual([hu.includes('Acme ("we", "us")'), hu.includes('to US standards'), hu.includes('the laws of TX')], [true, true, true], 'agreement: another country: its standards and its state');
  assertEqual([hn.includes('your own tax, GST, superannuation, workers compensation'), hn.includes('at least $10 million'), hu.includes('superannuation'), hu.includes('your own tax, Sales tax, workers compensation')], [true, true, false, true], 'agreement: superannuation only in Australia; the cover in the business\'s currency ($ by default)');
  set({ region: { country: 'GB', currency: 'GBP' } }, { companyName: 'Acme' });
  assertEqual(sb.contractorAgreementHtml(c, {}).includes('at least £10 million'), true, 'agreement: the insurance cover in pounds for a GBP business');
  set({ region: { country: 'FR' } }, { companyName: 'Acme' });
  assertEqual([sb.agreementPlace().standards, sb.agreementPlace().law.length > 0], ['local', true], 'agreement: a country with no word = local standards');
  assertEqual(sb.contractorAgreementHtml(c, {}, { legalName: 'Old Name Pty', law: 'Queensland', standards: 'Australian' }).includes('Old Name Pty ("we", "us")'), true, 'agreement: the names given win');
  // connector texts: the office's name, the website and the brands
  set({ business: { website: 'theguyservicegroup.com' }, brands: { Aircon: 'A Guys', Chimney: 'C Guys' } });
  const before = JSON.stringify(sb.CONNECTORS);
  const defs = sb.connDefs([], []);
  const ghl = defs.find(d => d.id==='ghl'), web = defs.find(d => d.id==='web'), wp = defs.find(d => d.id==='wp'), gbp = defs.find(d => d.id==='gbp');
  assertEqual([JSON.stringify(web).includes('The office still answers'), JSON.stringify(ghl).includes('and the office answers there'), wp.howText.startsWith('The app reads the website (theguyservicegroup.com): '), JSON.stringify(gbp).includes('A Guys and C Guys.'), /\{(office|site|brands)\}/.test(JSON.stringify(defs)), JSON.stringify(sb.CONNECTORS)===before],
    [true, true, true, true, false, true], 'connectors: the office, the website and the brands filled in; CONNECTORS itself unchanged');
  set({ labels: { office: 'Reception' } });
  const d2 = sb.connDefs([], []);
  assertEqual([d2.find(d => d.id==='wp').howText.startsWith('The app reads the website: '), JSON.stringify(d2.find(d => d.id==='web')).includes('The reception still answers'), JSON.stringify(d2.find(d => d.id==='gbp')).includes('OPS Service.')], [true, true, true], 'connectors: no website saved; the office renamed; no brands = the business name');
  const w = { office: 'desk', site: '', brands: 'B' }, nested = { a: ['{office} x', { b: '{site}{brands} {other}' }], n: 3, f: null };
  assertEqual(sb.connWordsIn(nested, w), { a: ['desk x', { b: 'B {other}' }], n: 3, f: null }, 'connWordsIn: nested texts filled, other values and unknown blanks kept');
  assertEqual(nested.a[0], '{office} x', 'connWordsIn: makes a copy');
  // Google Ads: a website conversion's short name, whatever the brand
  sb.STATE.data.settings = { companyName: 'The Guys Service Group', catalog: { business: TODAY_NAMES.business, brands: TODAY_NAMES.brands } };
  assertEqual([sb.adsConvShortName('The Guys Group - Main Website Sydney (web) Lead form'), sb.adsConvShortName('The Guys Group (web) Thank_you'), sb.adsConvShortName('Calls from ads'),
    sb.adsConvShortName('AO Green Solutions (web) purchase'), sb.adsConvShortName('AO Green Solutions (web) Thank_you_page'), sb.adsConvShortName('The AC Cleaning Guys (web) Form')],
    ['Lead form', 'Thank_you', 'Calls from ads', 'AO Green Solutions (web) purchase', 'AO Green Solutions (web) Thank_you_page', 'Form'], 'adsConvShortName: only this business\'s own names come off (today\'s two prefixes, a brand); a legacy account keeps its name');
  assertEqual([sb.adsConvShortName('Acme - Site (web) Form', ['Acme']), sb.adsConvShortName('Acmeco (web) Form', ['Acme'])], ['Form', 'Acmeco (web) Form'], 'adsConvShortName: another business\'s own name; a longer name is not it');
  // no new loaders: the names are read straight from the settings and the logins (nothing to load, nothing to memoise)
  const scan = ['renderPhoneSettings', 'personDetailsTab', 'personInAppGroup', 'payCashToSelect', 'officeLabel', 'officeAgentName', 'ownerNamesText', 'tplExample', 'connWordsNow'].map(n => extractDecl(script, n)).join('\n');
  assertEqual([/\bload[A-Z]\w*\(/.test(scan), /\bawait\b|\bfetch\(|\bsb\.|\bdb\./.test(scan)], [false, false], 'no loader or database call in the Phone page, the Details tab or the name helpers');
  sb.STATE.profiles = undefined; set({});
}

// ── Automations: the BUILDER (settings round 2, phase 4, group I) ──
// The builder's context, the way autoCtx() makes it from the business's settings (a fixture here: no business names).
function autoFixtureCtx(sb, over){
  const reg = { triggers: { ...sb.AUTO_TRIGGERS, ...sb.AUTO_MIRROR_TRIGGERS }, conds: sb.AUTO_CONDS, actions: sb.AUTO_ACTIONS };
  const words = { my_q: '{hi}, any questions about the {service} quote?', my_amt: 'Paid {amount}?', my_empty: '' };
  return { registry: reg, phoneLive: false, maxSteps: 20,
    catalog: { services: [{ key: 'svcA', label: 'Window cleaning' }, { key: 'svcB', label: 'Gutters' }], stages: [{ key: 'New', label: 'New' }, { key: 'Quoted', label: 'Quote sent' }],
      sources: [{ key: 'web', label: 'Website' }], tags: [{ key: 'VIP', tag: 'VIP', label: 'VIP' }] },
    profiles: [{ id: 'p-own', name: 'Alex Owner', role: 'owner' }, { id: 'p-va', name: 'Kim Office', role: 'va' }],
    employees: [{ id: 'e1', name: 'Kim Office' }],
    sample: { hi: 'Hi Sarah', first_name: 'Sarah', name: 'Sarah Mitchell', service: 'window cleaning', brand: 'Brand', business_name: 'Biz', suburb: '2000', source: 'Website', stage: 'New', number: '0412 345 678', technician: 'Sam', amount: '$420', job_date: '2026-10-14', minutes: '15', automation: 'A' },
    templateText: k => words[k] ?? sb.msgTemplateText(k), templateLabel: k => k, ...(over || {}) };
}
function testAutomationsBuilder(sb){
  console.log('\nAutomations: the builder (phase 4, group I)');
  const html0 = fs.readFileSync(INDEX_HTML_PATH, 'utf8'), script = html0.match(/<script>([\s\S]*?)<\/script>/)[1];
  const ctx = autoFixtureCtx(sb);
  // registries: data only, no business names; every start a condition or blank names exists
  const regSrc = ['AUTO_TRIGGERS', 'AUTO_MIRROR_TRIGGERS', 'AUTO_CONDS', 'AUTO_ACTIONS', 'AUTO_FIELDS', 'AUTO_PUSH_DEFAULT', 'AUTO_DUE', 'AUTO_OP_WORDS'].map(n => extractDecl(script, n)).join('\n');
  assertEqual(['Aircon', 'Chimney', 'Pressure', 'Ron', 'Noam', 'Ofek', 'The Guys', '1300'].filter(w => regSrc.includes(w)), [], 'registries: no business, person or phone number is written in');
  const trig = Object.keys(sb.AUTO_TRIGGERS);
  assertEqual(Object.values(sb.AUTO_CONDS).flatMap(c => c.appliesTo || []).filter(t => !trig.includes(t)), [], 'registries: every start a condition is limited to exists');
  assertEqual(Object.values(sb.AUTO_FIELDS).flatMap(f => Array.isArray(f.triggers) ? f.triggers : []).filter(t => !trig.includes(t)), [], 'registries: every start a blank is limited to exists');
  // parity with the engine's registries (supabase/functions/automations): the same keys, limits and starts
  const eng = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'automations', 'index.ts'), 'utf8');
  const keysOf = name => { const at = eng.indexOf(`export const ${name}`), body = eng.slice(eng.indexOf('{', at), eng.indexOf('\n};', at)); return [...body.matchAll(/\n  (\w+): \{/g)].map(m => m[1]).sort(); };
  assertEqual([Object.keys(sb.AUTO_TRIGGERS).sort(), Object.keys(sb.AUTO_CONDS).sort(), Object.keys(sb.AUTO_ACTIONS).sort(), Object.keys(sb.AUTO_FIELDS).sort()],
    [keysOf('TRIGGERS'), keysOf('CONDITIONS'), keysOf('ACTIONS'), keysOf('MERGE_FIELDS')], 'registries: the same starts, conditions, actions and blanks as the engine');
  const lim = JSON.parse(eng.match(/export const LIMITS = (\{[^}]*\})/)[1].replace(/(\w+):/g, '"$1":'));
  assertEqual(sb.AUTO_LIMITS, lim, 'registries: the same length limits as the engine');
  const engApplies = k => { const m = new RegExp(`\\n  ${k}: \\{[\\s\\S]*?appliesTo: (ALL_TRIGGERS|\\[[^\\]]*\\])`).exec(eng.slice(eng.indexOf('export const CONDITIONS'))); return m[1]==='ALL_TRIGGERS' ? null : JSON.parse(m[1]); };
  assertEqual(Object.keys(sb.AUTO_CONDS).filter(k => JSON.stringify(sb.AUTO_CONDS[k].appliesTo)!==JSON.stringify(engApplies(k))), [], 'registries: each condition fits the same starts as in the engine');
  const engOps = { LIST_OPS: ['is', 'is_not', 'in', 'not_in'], BOOL_OPS: ['true', 'false'], NUM_OPS: ['lte', 'gte'] };
  const opsOf = k => { const m = new RegExp(`\\n  ${k}: \\{[^\\n]*?ops: (\\w+_OPS|\\[[^\\]]*\\])`).exec(eng.slice(eng.indexOf('export const CONDITIONS'))); return engOps[m[1]] || JSON.parse(m[1]); };
  assertEqual(Object.keys(sb.AUTO_CONDS).filter(k => !sb.AUTO_CONDS[k].ops.every(o => opsOf(k).includes(o))), [], 'registries: every comparison the builder offers is one the engine accepts');
  const engEvents = k => { const m = new RegExp(`\\n  ${k}: \\{[^\\n]*events: (ALL_TRIGGERS|\\[[^\\]]*\\])`).exec(eng.slice(eng.indexOf('export const MERGE_FIELDS'))); return m[1]==='ALL_TRIGGERS' ? '*' : JSON.parse(m[1]); };
  assertEqual(Object.keys(sb.AUTO_FIELDS).filter(k => JSON.stringify(sb.AUTO_FIELDS[k].triggers)!==JSON.stringify(engEvents(k))), [], 'registries: each blank fills for the same starts as in the engine');
  assertEqual(sb.AUTO_ACTIONS.text.available().ok, false, 'a text to a customer is never available (the engine has no text code until the business phone)');
  // values come from the business's own lists
  assertEqual(sb.autoCondValues('services', ctx), [{ key: 'svcA', label: 'Window cleaning' }, { key: 'svcB', label: 'Gutters' }], 'condition values: the business\'s own services, by key');
  sb.STATE.data.settings = { catalog: { services: [{ key: 'Lawns', label: 'Lawn mowing' }] } };
  assertEqual(sb.catalogShown('services').some(x => x.key==='Lawns'), true, 'a service added in Settings is in the list the builder offers');
  // autoNormalize
  const n0 = sb.autoNormalize({ id: 'a1', name: 'X', enabled: 'yes', trigger: 'nope', steps: 'nope' });
  assertEqual([n0.def, n0.enabled, n0.audience], [{ trigger: null, steps: [] }, false, 'team'], 'normalise: a missing or broken definition is empty, "yes" is not on');
  const n1 = sb.autoNormalize({ id: 'a2', name: 'Y', enabled: true, template_key: 'review', created_by_name: 'Kim', trigger: { type: 'newLead' }, steps: [
    { id: 's1', kind: 'wait', n: 5000, unit: 'minutes' }, { id: 's2', kind: 'wait', n: 0, unit: 'days' }, { id: 's3', kind: 'window', days: [5, 1, 1, 9, -1, 3], from: '17:00', until: '09:00', outside: 'next' },
    { id: 's4', kind: 'teleport', to: 'mars' }, { id: 's5', kind: 'action', type: 'email', subject: 's', templateKey: 'my_q' }], deleted_at: '2026-10-14T00:00:00Z' });
  const st = n1.def.steps;
  assertEqual([st[0].n, st[1].n, st[2].days, st[2].until, st[3], n1.audience, n1.baseKey, n1.createdByName, n1.deleted, n1.def.trigger],
    [1440, 1, [1, 3, 5], '18:00', { id: 's4', kind: 'teleport', to: 'mars' }, 'customer', 'review', 'Kim', true, { type: 'newLead', params: {} }],
    'normalise: waits inside their limits, days 0–6 once each, an end after the start, an unknown step kept as it is');
  // problems
  const P = (def, o) => sb.autoProblems(def, ctx, o || {});
  const T = (def, o) => P(def, o).map(p => (p.block ? '' : '~') + p.text);
  const push = { id: 's9', kind: 'action', type: 'push', to: { roles: ['owner'], people: [] }, title: 'New lead: {name}', body: '' };
  assertEqual(T({ trigger: null, steps: [] }), ['Pick what starts it (step 1).', 'Pick at least one thing to do (step 5).'], 'problems: nothing yet');
  assertEqual(T({ trigger: { type: 'newLead' }, steps: [{ id: 's1', kind: 'wait', n: 0, unit: 'minutes' }, push] }), ['The wait has to be a whole number from 1 to 1440 (step 2).'], 'problems: a wait out of range (minutes)');
  assertEqual(T({ trigger: { type: 'newLead' }, steps: [{ id: 's1', kind: 'wait', n: 400, unit: 'days' }, push] }), ['The wait has to be a whole number from 1 to 365 (step 2).'], 'problems: a wait out of range (days)');
  assertEqual(T({ trigger: { type: 'newLead' }, steps: [{ id: 's1', kind: 'window', days: [], from: '17:00', until: '09:00', outside: 'next' }, push] }), ['Pick at least one day (step 3).', 'The end time has to be after the start (step 3).'], 'problems: no day, the end before the start');
  assertEqual(T({ trigger: { type: 'newLead' }, steps: [{ id: 's1', kind: 'if', match: 'all', conds: [{ field: 'asked_within_months', op: 'true' }, { field: 'unpaid', op: 'true' }, { field: 'service', op: 'is', v: '' }] }, push] }),
    ['A condition needs a whole number from 1 to 36 (step 4).', '"The job is still unpaid" can\'t be used with "A new lead comes in" (step 4).', 'Pick a value for "Service" (step 4).'], 'problems: a missing number, a condition that doesn\'t fit the start, no value');
  assertEqual(T({ trigger: { type: 'newLead' }, steps: [{ id: 's1', kind: 'if', match: 'all', conds: [{ field: 'service', op: 'is', v: 'gone' }] }, push] }), ['~"gone" is no longer in Settings, so "Service" may never match (step 4).'], 'problems: a value deleted from Settings is a warning, not a stop');
  assertEqual(T({ trigger: { type: 'jobClosed' }, steps: [{ id: 's1', kind: 'action', type: 'email', subject: '', templateKey: 'my_empty' }] }), ['The email needs a subject (step 6).', 'The email has no words yet (step 6).'], 'problems: an email with no subject and no words');
  assertEqual(T({ trigger: { type: 'jobClosed' }, steps: [{ id: 's1', kind: 'action', type: 'text', templateKey: '' }] }),
    ['~Text to the customer waits for the business phone: it is saved, but nothing is texted until then.', 'The text has no words yet (step 6).'], 'problems: a text with no words; a text always waits for the phone (a warning)');
  assertEqual(T({ trigger: { type: 'newLead' }, steps: [{ id: 's1', kind: 'action', type: 'push', to: { roles: [], people: [] }, title: ' ' }] }), ['Pick who gets the notification (step 5).', 'Write the notification (step 6).'], 'problems: a notification to nobody, with no title');
  assertEqual(T({ trigger: { type: 'newLead' }, steps: [{ id: 's1', kind: 'action', type: 'task', title: '', assignees: [], due_days: 0 }] }), ['Pick who the task is for (step 5).', 'Write the task (step 6).'], 'problems: a task for nobody, with no words');
  assertEqual(T({ trigger: { type: 'newLead' }, steps: [{ ...push, title: 'Lead {name}: {amount}' }] }), ['{amount} can\'t be filled in for "A new lead comes in" (step 6).'], 'problems: a blank this start can\'t fill');
  assertEqual(T({ trigger: { type: 'jobClosed' }, steps: [{ ...push, to: { roles: ['owner', 'va', 'manager'], people: [] }, title: 'Paid {amount}' }] }), ['~{amount} is money, and this notification also goes to people who are not owners.'], 'problems: money to people who are not owners is a warning');
  assertEqual(T({ trigger: { type: 'jobClosed' }, steps: [{ ...push, to: { roles: [], people: ['p-own'] }, title: 'Paid {amount}' }] }), [], 'problems: money to an owner by name is fine');
  const mirrors = [{ name: 'A new lead comes in', on: true, def: { trigger: { type: 'newLead' }, steps: [push] } }, { name: 'Off one', on: false, def: { trigger: { type: 'newLead' }, steps: [push] } }];
  assertEqual(T({ trigger: { type: 'newLead' }, steps: [push] }, { mirrors }), ['~The ready-made "A new lead comes in" is on and does the same when this happens: both will go.'], 'problems: doubling a ready-made one that is on is a warning');
  assertEqual(T({ trigger: { type: 'newLead' }, steps: [push, { id: 's2', kind: 'wait', n: 1, unit: 'days' }] }), ['The last step does nothing. End with a Do step, or remove it.'], 'problems: a last step that does nothing');
  assertEqual(T({ trigger: { type: 'invoice' }, steps: [push] }), ['This start can\'t be used in an automation of your own yet (step 1).'], 'problems: a start only a ready-made has');
  assertEqual(T({ trigger: { type: 'newLead' }, steps: [push, { ...push }] }), ['Two steps share the same inside name: remove one and add it again.'], 'problems: two steps with the same id (the engine would refuse it)');
  assertEqual(sb.autoStepProblems({ id: 'x', kind: 'action', type: 'push', to: {}, title: '' }, { trigger: { type: 'newLead' } }, ctx), ['Pick who gets the notification.', 'Write the notification.'], 'the flow view\'s "Needs a look" uses the same checks, without the step number');
  // the sentence and the chips: registries + the business's own names; every name escaped
  const quote = { trigger: { type: 'stage', params: { stage: 'Quoted' } }, steps: [{ id: 's1', kind: 'wait', n: 3, unit: 'days' }, { id: 's2', kind: 'window', days: [1, 2, 3, 4, 5], from: '09:00', until: '17:00', outside: 'skip' },
    { id: 's3', kind: 'if', match: 'all', conds: [{ field: 'service', op: 'is', v: 'svcA' }, { field: 'has_email', op: 'true' }] }, { id: 's4', kind: 'action', type: 'email', subject: 'Your quote', templateKey: 'my_q' },
    { id: 's5', kind: 'action', type: 'task', title: 'Call {name}', assignees: ['e1'], due_days: 1 }] };
  assertEqual(sb.autoSentence(quote, ctx), 'When <b>a lead moves to Quote sent</b>, then <b>wait 3 days</b>, then <b>only Mon–Fri, 9 am–5 pm (otherwise stop)</b>, then <b>only if the service is Window cleaning and the customer has an email address</b>, then <b>email the customer &quot;Your quote&quot;</b>, then <b>give Kim a task due the next day</b>.', 'sentence: a quote follow-up, from the registries and the business\'s names');
  assertEqual(sb.autoSentence({ trigger: { type: 'newLead' }, steps: [{ id: 's1', kind: 'wait', n: 15, unit: 'minutes' }, { id: 's2', kind: 'if', match: 'all', conds: [{ field: 'not_picked', op: 'true' }] }, push] }, ctx),
    'When <b>a new lead comes in</b>, then <b>wait 15 minutes</b>, then <b>only if nobody has opened, called or moved the lead</b>, then <b>send a notification to the owners</b>.', 'sentence: a waiting-lead alert');
  assertEqual(sb.autoSentence({ trigger: { type: 'jobClosed' }, steps: [] }, ctx), 'When <b>a job is closed</b>, then… <span class="hint">(pick what to do in step 5)</span>', 'sentence: nothing to do yet');
  const renamed = autoFixtureCtx(sb, { catalog: { ...ctx.catalog, services: [{ key: 'svcA', label: 'Glass' }] } });
  assertEqual([sb.autoSentence(quote, renamed).includes('the service is Glass'), quote.steps[2].conds[0].v], [true, 'svcA'], 'sentence: a service renamed in Settings is renamed here; the saved key stays');
  const gone = autoFixtureCtx(sb, { catalog: { ...ctx.catalog, services: [] } });
  assertEqual(sb.autoSentence(quote, gone).includes('svcA (deleted)'), true, 'sentence: a deleted value says so');
  const evil = '<script>alert(1)</script>';
  const evilCtx = autoFixtureCtx(sb, { catalog: { ...ctx.catalog, stages: [{ key: 'Quoted', label: evil }] } });
  const es = sb.autoSentence(quote, evilCtx);
  assertEqual([es.includes('<script>'), es.includes('&lt;script&gt;')], [false, true], 'sentence: a stage name with HTML is shown as text');
  assertEqual(sb.autoFlowChips(quote, ctx), ['Moves to a stage: Quote sent', 'After 3 days', 'Mon–Fri, 9 am–5 pm', '2 conditions', 'Email + Task for Kim'], 'chips: start › wait › hours › conditions › what it does');
  assertEqual(sb.autoFlowChips({ trigger: { type: 'newLead' }, steps: [push, { id: 's2', kind: 'wait', n: 2, unit: 'hours' }, { ...push, id: 's3' }] }, ctx), ['New lead', 'Right away', 'Any day, any time', 'Push to the owners', '+2 more steps'], 'chips: a longer automation says how many more steps it has');
  assertEqual(sb.autoWhenShort(quote, ctx), '3 days after a lead moves to Quote sent, Mon–Fri, 9 am–5 pm', 'when, in short: the wait, the start and the hours');
  // autoTriggersOn: only automations of your own that are on, not deleted, with a start the app saves itself
  const L = [{ enabled: true, def: { trigger: { type: 'newLead' } } }, { enabled: false, def: { trigger: { type: 'stage' } } }, { enabled: true, deleted: true, def: { trigger: { type: 'jobClosed' } } },
    { enabled: true, def: { trigger: { type: 'missedCall' } } }, { enabled: true, def: { trigger: { type: 'chat' } } }, { enabled: true, ready: true, def: { trigger: { type: 'invoice' } } }];
  assertEqual(sb.autoTriggersOn(L), { newLead: true }, 'events from the app: only for an automation of your own that is on (never missed calls, chats or ready-made ones)');
  // the ready-made rows, from today's settings
  sb.STATE.data.settings = { reviewRequestsAuto: false, chatAutoSms: true, phoneEnabled: false, unpaidReminderDays: 9,
    catalog: { reviews: { sendFrom: 9, askAgainMonths: 4 }, chat: { waitMinutes: 7, windowHours: 3, oneADay: false }, notify: { newLead: { on: true, office: true }, leadWaiting: { on: false }, rules: { waitMinutes: 20, from: 7, until: 19, docDays: 45 } } } };
  sb.STATE.profiles = [];
  const R = sb.autoReadyRows(), by = k => R.find(r => r.key===k);
  assertEqual([by('ready:review').on, by('ready:review').gate, sb.autoGatePill(by('ready:review')).includes('Off until go-live'), by('ready:review').notes[0], by('ready:review').toggle], [false, 'golive', true, 'Texts go through GoHighLevel for now.', ['setReviewAuto', true]], 'ready-made review: off until go-live, through GoHighLevel, its switch is the existing one (with its own confirm)');
  const rv = by('ready:review').def.steps;
  assertEqual([rv[0].from, rv[0].until, rv[0].at, rv[1].conds.map(c => c.field + (c.n ? ':' + c.n : '')), rv.slice(2).map(s => s.templateKey)], ['09:00', '20:00', '10:00', ['dont_ask', 'asked_within_months:4'], ['reviewSms', 'reviewEmailBody']], 'ready-made review: the hours and months are the Google reviews settings; the words are the built-in messages');
  const ch = by('ready:chatText');
  assertEqual([ch.on, ch.gate, ch.def.steps[0].n, ch.def.steps[1].conds[1].n, ch.notes[0].includes('one automatic text a day')], [true, 'phone', 7, 3, false], 'ready-made chat text: its switch, wait, oldest chat and one-a-day are the Website chat settings');
  assertEqual([by('ready:missedText').locked, by('ready:missedText').on], ['On whenever the business phone is on. Its own switch comes when it moves here.', false], 'ready-made missed-call text: its switch is locked (no switch of its own today)');
  const cards = sb.notifyCardsNow(), teams = R.filter(r => r.key.startsWith('ready:team:'));
  assertEqual(teams.map(r => [r.card.id, r.on, r.card.office]), cards.map(c => [c.id, c.on, c.office]), 'ready-made team rows: one per Notifications card, on and office as there');
  const lw = by('ready:team:leadWaiting').def.steps;
  assertEqual([lw[0].n, lw[1].from, lw[1].until, lw[1].outside, by('ready:team:unpaid').def.steps[0].n, by('ready:team:docExpiry').def.trigger.params.days, by('ready:team:newLead').def.steps[0].to.roles],
    [20, '07:00', '19:00', 'skip', 9, 45, ['owner', 'va', 'manager']], 'ready-made team rows: their numbers are the Notifications numbers (unpaid = Tax and payments)');
  assertEqual(R.every(r => !/Aircon|Chimney|The Guys|1300|Ofek|Noam/.test(r.name)), true, 'ready-made rows name no business');
  // chips and search over the list
  const custom = sb.autoNormalize({ id: 'c1', name: 'Quote follow-up', enabled: true, created_by_name: 'Kim', trigger: quote.trigger, steps: quote.steps });
  const rows = [...R, { key: 'c1', ready: false, name: custom.name, on: true, audience: custom.audience, def: custom.def, createdByName: 'Kim' }];
  const count = f => rows.filter(r => sb.autoMatches(r, f, '', ctx)).length;
  assertEqual([count('all'), count('customer'), count('team'), count('ready'), count('mine')], [rows.length, 4, teams.length, R.length, 1], 'chips: All / To customers / To the team / Ready-made / Made by you');
  assertEqual([rows.filter(r => sb.autoMatches(r, 'all', 'quote', ctx)).map(r => r.key), rows.filter(r => sb.autoMatches(r, 'all', 'window cleaning', ctx)).map(r => r.key)], [['c1'], ['c1']], 'search: by name and by the sentence (a service name)');
  // the list's HTML: mirrors, gate pills, escaped names and handlers
  const evilRow = { key: "c'2", ready: false, name: '<img src=x onerror=alert(1)>', on: false, audience: 'team', def: { trigger: { type: 'newLead' }, steps: [push] }, createdByName: '<b>x</b>' };
  const lists = sb.autoListsHtml([...rows, evilRow], ctx, { filter: 'all', q: '', loaded: true, error: '' });
  assertEqual([lists.includes('Review request after a closed job'), lists.includes('Off until go-live'), lists.includes('Waits for the business phone'), lists.includes('Ready-made'), lists.includes('Made by you'),
    lists.includes('<img'), lists.includes('&lt;img'), lists.includes("openAutoEditor('c\\'2')"), lists.includes('&lt;b&gt;x')], [true, true, true, true, true, false, true, true, true], 'list: the ready-made rows with their pills; a typed name and its id are escaped');
  assertEqual(/To customers[\s\S]*To the team/.test(lists), true, 'list: two blocks, To customers then To the team');
  const lerr = sb.autoListsHtml(R, ctx, { filter: 'all', q: '', loaded: true, error: 'relation "automations" does not exist' });
  assertEqual([lerr.includes('Automations could not be loaded. The ready-made ones below still work as before.'), lerr.includes('Review request after a closed job'), lerr.includes('does not exist')], [true, true, false], 'list: before the SQL is run, the ready-made rows still show, with a plain message');
  assertEqual(sb.autoListsHtml(R, ctx, { filter: 'all', q: '', loaded: false, error: '' }).includes('Loading your automations…'), true, 'list: says it is loading');
  assertEqual(sb.autoListsHtml(R, ctx, { filter: 'mine', q: '', loaded: true, error: '' }).includes('Nothing matches.'), true, 'list: nothing of your own yet');
  // previews: words escaped first, then filled; texts counted like phones do
  const pv = sb.autoPreviewHtml('text', '', '{hi}, it’s <b>us</b>', ctx.sample);
  assertEqual([pv.includes('Hi Sarah, it’s &lt;b&gt;us&lt;/b&gt;'), /\d+ characters · 1 text · a curly quote/.test(pv)], [true, true], 'preview: a text bubble, escaped, with its count (a curly quote warns)');
  const pe = sb.autoPreviewHtml('email', 'Hi {first_name}', 'Line one\n\nLine {name}', ctx.sample);
  assertEqual([pe.includes('<span>Subject</span>Hi Sarah'), pe.includes('<p>Line one</p><p>Line Sarah Mitchell</p>')], [true, true], 'preview: an email with its subject and paragraphs');
  // the form and the flow view edit the same steps (J's slot helpers with the builder's registry)
  const tail = [{ id: 's1', kind: 'wait', n: 1, unit: 'days' }, { id: 's2', kind: 'action', type: 'push', to: { roles: ['owner'] }, title: 'A' }, { id: 's3', kind: 'wait', n: 2, unit: 'days' }, { id: 's4', kind: 'action', type: 'task', title: 'B', assignees: ['e1'] }];
  const tailJ = JSON.stringify(tail.slice(2));
  const edited = sb.flowFormSetSlot(tail, 'wait', { n: 5, unit: 'hours' }, ctx);
  assertEqual([sb.flowIsFormShaped(tail), edited[0].n, edited[0].unit, edited[0].id, JSON.stringify(edited.slice(2))===tailJ], [false, 5, 'hours', 's1', true], 'form on a longer automation: the first part changes, the rest is kept byte for byte, ids stay');
  const added = sb.flowFormSetAction([{ id: 's1', kind: 'wait', n: 1, unit: 'days' }], 'email', true, ctx, { type: 'newLead' });
  assertEqual([added[1].kind, added[1].type, added[1].subject, added[1].templateKey, added[1].id], ['action', 'email', '', '', 's2'], 'form: ticking Email adds the engine\'s own email step');
  const pushMade = sb.AUTO_ACTIONS.push.make(ctx, { type: 'newLead' });
  assertEqual([pushMade.to, pushMade.title, pushMade.body], [{ roles: ['owner'], people: [] }, 'New lead: {name}', '{service} · {source}'], 'a new notification goes to the owners with blanks for that start');
  // library templates: who uses one
  assertEqual(sb.autoTplUsers('my_q', [custom, { ...custom, id: 'c3', deleted: true }]).map(a => a.id), ['c1'], 'template users: the automations whose messages use it (not deleted ones)');
  // differential sanity: with no automations the settings the live functions read are exactly as before
  sb.STATE.data.settings = { catalog: {} };
  assertEqual([sb.reviewCfg().sendFrom, sb.reviewCfg().sendUntil, sb.reviewCfg().morning, sb.reviewCfg().askAgainMonths, sb.chatRulesApp(), sb.notifyRulesApp()],
    [8, 20, 10, 6, { waitMinutes: 5, windowHours: 2, oneADay: true }, { waitMinutes: 15, from: 8, until: 20, docDays: 30, unpaidDays: 7 }], 'nothing saved: the review, chat and notification numbers are the originals');
  assertEqual(sb.MSG_TEMPLATES.flatMap(m => m.fields).every(f => sb.msgTemplateText(f.key)===f.text), true, 'nothing saved: every built-in message is its approved words');
  const als = extractDecl(script, 'applyLeadStage');
  assertEqual([als.includes('const patch = { status: stage, stageChangedAt: nowIso, ...extra };'), /db\.contacts\.update\(c\.id, patch\)\.then\(saved => \{ if \(saved\) autoEmitStage\(c\.id, stage\); \}\)/.test(als)], [true, true], 'a stage move saves the same patch; the engine is told only after the save (and the Undo)');
  // the pure helpers never redraw or touch the database
  const pure = ['autoNormalize', 'autoProblems', 'autoStepIssues', 'autoSentence', 'autoFlowChips', 'autoTriggersOn', 'autoMatches', 'autoReadyRows', 'autoRowHtml', 'autoListsHtml', 'autoPreviewHtml'];
  assertEqual(pure.filter(n => /\brender\(|\bdb\.|\bsb\.|fetch\(/.test(extractDecl(script, n))), [], 'the builder\'s pure helpers never redraw, read the database or call a server');
}
// A sandbox with the whole builder (every auto* function and AUTO* constant) for its windows and saves.
function autoSandbox(extra){
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8'), script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const autoNames = [...new Set([...script.matchAll(/\n(?:async )?function (auto\w*)\(/g)].map(m => m[1]).concat([...script.matchAll(/\nconst (AUTO\w*)\s*=/g)].map(m => m[1])))].filter(n => !DECLS.includes(n) && !/^automation/i.test(n));
  const more = ['readOnlyReason', 'flowEd', 'flowCtx', 'flowRenderBlocked', 'flowMainHtml', 'flowSideHtml', 'flowPanelHtml', 'flowIsInline', 'tplHighlight', 'renderTemplatesPage', 'TPL_EXAMPLE', 'tplPreviewHtml', 'tplActionsHtml', 'tplProblemsHtml',
    'toggleAutomation', 'deleteAutomation', 'duplicateAutomation', 'openAutoEditor', 'openAutoPage', 'loadAutomations', 'loadAutoRunCounts', 'renderAutomationsPage', 'renderNotificationsPage', 'newMsgTemplate', 'editMsgTemplate', 'saveMsgTemplate', 'deleteMsgTemplate', 'cancelMsgTemplate', 'brandOf'];
  const src = DECLS.map(n => extractDecl(script, n)).concat(autoNames.map(n => extractDecl(script, n)), more.filter(n => !autoNames.includes(n) && !DECLS.includes(n)).map(n => extractDecl(script, n))).join('\n\n');
  const log = { toasts: [], confirms: [], db: [], renders: 0, opened: [], modal: '' };
  const sandbox = {
    STATE: { data: { settings: { catalog: {} }, contacts: [], jobs: [], employees: [{ id: 'e1', name: 'Kim Office', status: 'Active', roles: ['VA'] }] }, profiles: [{ id: 'p-own', fullName: 'Alex Owner', role: 'owner' }] },
    console, log, PRESENT: false, VIEW_AS_ID: null, UI: { tab: 'settings', settings: { page: 'templates' } },
    showToast: (m, o) => log.toasts.push(m), confirmAction: (m, fn, o) => log.confirms.push({ m, fn, o }), render: () => { log.renders++; }, renderKeepingInput: () => { log.renders++; },
    logSettingsActivity: (a, t) => log.db.push('activity: ' + t), getCurrentProfile: () => ({ fullName: 'Alex Owner', role: 'owner' }), getRealProfile: () => ({ id: 'p-own', role: 'owner' }),
    applyCatalog: () => {}, closeModal: () => { log.modal = ''; }, reopenModal: (h) => { log.modal = h; }, openModal: (h) => { log.modal = h; }, setSettingsPage: (id) => log.opened.push('page:' + id),
    startTemplateEdit: () => {}, weekStartDay: () => 1, motionReduced: () => true, brandLogoHtml: () => '<svg></svg>',
    window: { matchMedia: () => ({ matches: false }) }, document: { getElementById: () => null, querySelector: () => null },
    phoneNotificationsBar: () => '', notifyCardHtml: (c) => `<article>${c.id}</article>`, localStorage: { getItem: () => null, setItem: () => {} },
    db: { settings: { update: (p) => { log.db.push('settings.update'); Object.assign(sandbox.STATE.data.settings, p); return Promise.resolve(); } } },
    sb: { from: () => { throw new Error('no database in this test'); } },
    setTimeout: (fn) => { fn(); return 0; },
    ...(extra || {}),
  };
  vm.createContext(sandbox);
  vm.runInContext('var AUTO_ED = null, AUTO_TPL_EDIT = null, TPL_EDIT = null, FLOW_DRAG = null, FLOW_EDRENDER_PENDING = false;\n' + src + '\nthis.__get = n => eval(n); this.__set = (n, v) => eval(n + " = v");', sandbox, { filename: 'index.html (builder)' });
  return sandbox;
}
function testAutomationsEditor(){
  console.log('\nAutomations: the editor window and the Message templates tab (phase 4, group I)');
  const sb = autoSandbox(), AUTO = sb.__get('AUTO'), log = sb.log;
  // a new automation: 6 steps, the flow switch in the head, nothing saved by opening it
  sb.openAutoEditor(null);
  let h = log.modal;
  assertEqual([...['When', 'Wait', 'Only on', 'Only if', 'Do', 'Message'].map(t => h.includes(`<h4>${t}</h4>`)), h.includes('role="radiogroup" aria-label="How to edit"'), h.includes('Save automation'), h.includes('Pick what starts it (step 1).'), log.db.length],
    [true, true, true, true, true, true, true, true, true, 0], 'new automation: the 6 steps, the Form / Flow switch, "Before you save", and nothing written');
  assertEqual([h.includes('A new lead comes in'), h.includes('A call is missed'), h.includes('Starts once the business phone is connected')], [true, true, true], 'new automation: the starts come from the registry (a missed call waits for the phone)');
  // pick a start, add a notification to the office, write it
  sb.autoEdSetTrigger('newLead');
  sb.autoEdWho('', 'role:office');
  const ed = sb.__get('AUTO_ED'), push = ed.def.steps.find(s => s.type==='push');
  assertEqual([push.to, push.title], [{ roles: ['va', 'manager'], people: [] }, 'New lead: {name}'], 'form: picking "The office" adds a notification to the office, with words for that start');
  sb.autoEdAction('email', true);
  const email = ed.def.steps.find(s => s.type==='email');
  assertEqual([!!email, /^my_\w+$/.test(email.templateKey), ed.drafts[email.templateKey].channel], [true, true, 'email'], 'form: ticking Email starts a new template of your own (a draft until Save)');
  sb.autoEdAction('text', true);
  assertEqual([ed.def.steps.some(s => s.type==='text'), log.toasts.slice(-1)[0]], [false, 'Needs the business phone (Twilio). It turns on here once the phone is connected.'], 'form: a text can\'t be added before the business phone');
  h = sb.autoEditorHtml();
  assertEqual([h.includes('Not available yet'), h.includes('This one messages customers. It is saved off'), h.includes('id="au-step-6"')], [true, true, true], 'form: the text card says why; a customer automation says it is saved off');
  // the editor's On switch on a NEW customer automation stays off
  sb.autoEdToggle();
  assertEqual([ed.enabled, /saved off/.test(log.toasts.slice(-1)[0])], [false, true], 'a new automation that messages customers can\'t be switched on before it is saved');
  // escaping in the editor
  ed.name = '"><script>x</script>';
  h = sb.autoEditorHtml();
  assertEqual([h.includes('<script>x'), h.includes('&quot;&gt;&lt;script&gt;')], [false, true], 'editor: a typed name is escaped');
  // ready-made mirrors open on their live settings
  sb.STATE.data.settings = { reviewRequestsAuto: false, phoneEnabled: false, catalog: { reviews: { sendFrom: 9 } } };
  sb.openAutoEditor('ready:review');
  h = log.modal;
  assertEqual([h.includes('Ready-made automation'), h.includes('This sends to real customers. It stays off until you turn it on at go-live.'), h.includes('Through GoHighLevel for now'), h.includes("autoReadyAct('setReviewCfg', 'sendFrom', this.value)"),
    h.includes('<option value="9" selected>9 am</option>'), h.includes('Back to the default'), h.includes('Duplicate'), h.includes('>Delete<'), h.includes('readonly')],
    [true, true, true, true, true, true, true, false, true], 'ready-made review: its live hours with the Google reviews setter, go-live banner, Back to the default and Duplicate, no Delete');
  sb.openAutoEditor('ready:missedText');
  h = log.modal;
  assertEqual([h.includes('disabled title="On whenever the business phone is on. Its own switch comes when it moves here."'), h.includes('Back to the default')], [true, false], 'ready-made missed-call text: its switch is locked, nothing to put back');
  sb.openAutoEditor('ready:team:leadWaiting');
  h = log.modal;
  assertEqual([h.includes("autoReadyAct('setNotifyNumber', 'waitMinutes', this.value)"), h.includes("sendNotifyTest('leadWaiting')"), h.includes("autoReadyAct('toggleNotifyOffice', 'leadWaiting')")], [true, true, true], 'ready-made team alert: its numbers and "Office" use the Notifications setters; Send a test');
  // Duplicate a ready-made: the built-in words are COPIED, never pointed at; nothing is saved; it is off
  sb.duplicateAutomation('ready:review');
  const dup = sb.__get('AUTO_ED'), keys = dup.def.steps.filter(s => s.kind==='action').map(s => s.templateKey);
  assertEqual([dup.isNew, dup.enabled, dup.baseKey, dup.name, keys.every(k => /^my_/.test(k)), keys.some(k => ['reviewSms', 'reviewEmailBody'].includes(k)), dup.drafts[keys[0]].body===sb.msgTemplateText('reviewSms'), log.db.length],
    [true, false, 'review', 'Copy of Review request after a closed job', true, false, true, 0], 'duplicate a ready-made: a new automation (not saved, off) with COPIES of the built-in words');
  assertEqual(sb.autoProblems(dup.def, sb.autoCtx(), {}).some(p => p.block && /\{review_link\}/.test(p.text)), true, 'the copied review words keep {review_link}, which the engine can\'t fill: it has to be changed before saving');
  // deleting a template of your own is refused while an automation uses it
  sb.STATE.data.settings = { catalog: { msgTemplates: { my_a: { name: 'Quote', channel: 'email' } }, templates: { my_a: 'Hi' } } };
  AUTO.list = [sb.autoNormalize({ id: 'c1', name: 'Quote follow-up', enabled: false, trigger: { type: 'newLead' }, steps: [{ id: 's1', kind: 'action', type: 'email', subject: 'x', templateKey: 'my_a' }] })];
  const c0 = log.confirms.length;
  sb.deleteMsgTemplate('my_a');
  assertEqual([log.confirms.length===c0, /Used by "Quote follow-up"/.test(log.toasts.slice(-1)[0])], [true, true], 'a template of your own can\'t be deleted while an automation uses it');
  // the Message templates tab: who sends each built-in message, and when (live numbers)
  sb.STATE.data.settings = { reviewRequestsAuto: false, chatAutoSms: false, phoneEnabled: false, catalog: { reviews: { sendFrom: 9 }, msgTemplates: { my_a: { name: 'Quote', channel: 'email' } }, templates: { my_a: 'Hi {first_name}' } } };
  const tp = sb.renderTemplatesPage();
  assertEqual([tp.includes("openAutoPage('auto', 'ready:review')\">"), /Review request after a closed job<\/button><span class="pill warn">Off until go-live<\/span><span>· right after a job is closed, every day, 9 am–8 pm<\/span>/.test(tp), tp.includes("openAutoPage('auto', 'ready:chatText')"), tp.includes('Also used when the office presses "Ask for review" on a job or in My Day.')],
    [true, true, true, true], 'templates tab: the review messages say "Sent by Review request after a closed job" and its live hours (9 am)');
  const hand = tp.slice(tp.indexOf('<h3>Used by hand or by the phone</h3>'), tp.indexOf('<h3>Your templates</h3>'));
  assertEqual([['Phone greeting', 'Voicemail (office closed)', 'Moving a website chat to text'].every(n => hand.includes(n)), hand.includes('Review request')], [true, false], 'templates tab: the phone messages and the chat-to-text words are under "Used by hand or by the phone"');
  const mine = tp.slice(tp.indexOf('<h3>Your templates</h3>'));
  assertEqual([mine.includes('Quote'), mine.includes('Made by you'), mine.includes('Sent by'), mine.includes('Quote follow-up')], [true, true, true, true], 'templates tab: your own templates, with the automations that send them');
}
// The editor's Escape and redraws (14 Oct): a question asked over the editor (the review request's go-live switch asks
// first) survives a redraw of the window, and Escape never drops the editor or its changes through the app's own
// "Escape closes any window".
function testAutomationsEditorKeys(){
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8'), script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const calls = [];
  let ask = null, popup = null;
  const root = { children: [], appendChild(el){ calls.push('append:' + el.id); this.children.push(el); }, querySelector: () => null };
  const ctx = { console, calls,
    document: { querySelector: s => s.includes('confirm-back') ? ask : (s==='.auto-ed' || s==='#modal-root .auto-ed') ? {} : null, getElementById: id => id==='modal-root' ? root : id==='app-popup' ? popup : null },
    reopenModal: () => { calls.push('reopen'); }, autoEditorHtml: () => '<div class="auto-ed"></div>', flowRenderBlocked: () => false,
    closePopup: () => calls.push('closePopup'), closeConfirmModal: () => calls.push('closeConfirm'), autoCloseEditor: () => calls.push('closeEditor'), flowDragCancel: () => calls.push('dragCancel') };
  vm.createContext(ctx);
  vm.runInContext('var AUTO_ED = { mirror: true }, FLOW_DRAG = null;\n' + ['autoEdRender', 'autoEdKey'].map(n => extractDecl(script, n)).join('\n') + '\nthis.__set = (k, v) => { if (k==="drag") FLOW_DRAG = v; else AUTO_ED = v; };', ctx);
  ask = { id: 'ask' };
  ctx.autoEdRender();
  assertEqual(calls, ['reopen', 'append:ask'], 'editor: a question open over it stays open (and on top) when the window redraws');
  calls.length = 0; ask = null; ctx.autoEdRender();
  assertEqual(calls, ['reopen'], 'editor: with no question open, only the window redraws');
  const key = (k) => { const e = { key: k, stopped: false, prevented: false, stopPropagation(){ this.stopped = true; }, preventDefault(){ this.prevented = true; } }; ctx.autoEdKey(e); return e; };
  calls.length = 0; ask = { id: 'ask' };
  let e = key('Escape');
  assertEqual([calls, e.stopped], [['closeConfirm'], true], 'Escape with a question open closes only the question (the app\'s own Escape never sees it)');
  calls.length = 0; ask = null; e = key('Escape');
  assertEqual([calls, e.stopped], [['closeEditor'], true], 'Escape closes the editor through its own check (changes are asked about first)');
  calls.length = 0; ctx.__set('drag', { started: true }); e = key('Escape');
  assertEqual(calls, ['dragCancel'], 'Escape while a block is dragged only ends the drag');
  calls.length = 0; ctx.__set('drag', null); popup = {}; ask = { id: 'ask' }; e = key('Escape');
  assertEqual(calls, ['closePopup'], 'Escape with the "Add a step" menu open closes only the menu');
  popup = null; ask = null;
  calls.length = 0; e = key('Enter');
  assertEqual([calls, e.stopped], [[], false], 'other keys pass through');
  const glob = script.slice(script.lastIndexOf("document.addEventListener('keydown'"));
  assertEqual(/if \(e\.key==='Escape'\) \{\s*\/\/[^\n]*\n\s*if \(typeof AUTO_ED!=='undefined' && AUTO_ED && document\.querySelector\('#modal-root \.auto-ed'\)\) \{ autoEdKey\(e\); return; \}/.test(glob), true, 'the app\'s own Escape hands an open automation editor to its own handler');
}
// The page's loader can't loop: a second call while it loads gets the SAME promise; the page never redraws by itself
// until the answer is in, and then once, later (renderKeepingInput); a failed load is not retried by itself.
async function testAutomationsLoaderNoLoop(){
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8'), script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  let queries = 0, release = null, fail = false, renders = 0, keeps = 0, safetyQueries = 0, safetyRelease = null;
  const q = { select(){ return q; }, eq(){ return q; }, order(){ return q; }, gte(){ return q; }, in(){ return q; },
    maybeSingle(){ safetyQueries++; return new Promise(res => { safetyRelease = () => res({ data: { business_id: 'default', customer_from: '07:00', customer_until: '21:00' }, error: null }); }); },
    range(){ queries++; return new Promise((res, rej) => { release = () => fail ? rej(new Error('relation "automations" does not exist')) : res({ data: [{ id: 'a1', name: 'X', enabled: true, trigger: { type: 'newLead' }, steps: [] }], error: null }); }); } };
  const ctx = { console, sb: { from: () => q }, UI: { tab: 'settings', settings: { page: 'templates' } }, AUTO_TABLE: 'automations', AUTO_BUSINESS_ID: 'default', STATE: { profiles: [], data: {} },
    render(){ renders++; throw new Error('render() must not be called from the page'); }, renderKeepingInput(){ keeps++; },
    autoNormalize: r => ({ id: r.id, name: r.name, enabled: r.enabled, def: { trigger: r.trigger, steps: r.steps }, audience: 'team', deleted: false }),
    autoCtx: () => ({}), autoAllRows: () => [], autoListsHtml: () => '', autoMatches: () => true, renderTemplatesPage: () => '', ico: () => '', esc: s => String(s),
    phoneNotificationsBar: () => '', notifyRulesApp: () => ({}), notifyPeopleText: () => ({}), notifyCardsNow: () => [], notifyCardHtml: () => '', flowSentence: () => '', setToggle: () => '', pill: () => '', jsStr: s => s,
    autoSafetyHtml: () => '', autoRemovedHtml: () => '', autoHiddenReady: () => [], autoReadyRows: () => [] };
  vm.createContext(ctx);
  vm.runInContext('var AUTO_ED = null;\n' + ['AUTO', 'loadAutomations', 'loadAutoRunCounts', 'loadAutoSafety', 'autoPageOpen', 'renderAutomationsPage', 'renderNotificationsPage'].map(n => extractDecl(script, n)).join('\n') + '\nthis.__A = AUTO; this.__load = loadAutomations; this.__safety = loadAutoSafety; this.__page = renderAutomationsPage; this.__np = renderNotificationsPage;', ctx);
  const A = ctx.__A;
  const p1 = ctx.__load(), p2 = ctx.__load();
  ctx.__page(); ctx.__page(); ctx.__np(); ctx.__np();
  const s1 = ctx.__safety(), s2 = ctx.__safety();
  await new Promise(r => setTimeout(r, 0));
  assertEqual([p1===p2, queries, A.loaded, renders, keeps], [true, 1, false, 0, 0], 'automations: a second load (and four page draws) while one runs start no other query and draw nothing');
  assertEqual([s1===s2, safetyQueries, A.safetyLoaded], [true, 1, false], 'safety settings: a second load (and the page draws) while one runs is the same promise, one query');
  release(); await p2;
  assertEqual([A.loaded, A.list.map(a => a.id), A.error, renders, keeps], [true, ['a1'], '', 0, 1], 'automations: the list arrives once; the page is drawn again once, later');
  ctx.__page(); ctx.__page();
  await new Promise(r => setTimeout(r, 0));
  assertEqual(queries, 2, 'automations: once loaded, drawing the page again only reads how often they ran (one query), never the list again');
  release(); await new Promise(r => setTimeout(r, 0));
  ctx.__page();
  assertEqual(queries, 2, 'automations: and that only once');
  const keeps0 = keeps; safetyRelease(); await s2;
  ctx.__page(); ctx.__page(); await new Promise(r => setTimeout(r, 0));
  assertEqual([A.safetyLoaded, A.safety && A.safety.customer_from, safetyQueries, keeps - keeps0, renders], [true, '07:00', 1, 1, 0], 'safety settings: they arrive once, the page is drawn again once, and drawing it again reads nothing more');
  A.loaded = false; fail = true;
  const p3 = ctx.__load(); assertEqual(ctx.__load()===p3, true, 'automations: a load started again (outside a draw) is one load too');
  await new Promise(r => setTimeout(r, 0));
  release(); await p3;
  ctx.__page(); ctx.__page();
  assertEqual([A.loaded, A.list, /does not exist/.test(A.error), queries], [true, [], true, 3], 'automations: a failed load shows its message and is not tried again by itself');
}
// The app tells the engine only for automations of your own that are on; a stage move only after its Undo ran out.
async function testAutomationEventsGate(){
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8'), script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const all = [], posts = [], timers = { get length(){ return all.filter(x => x.ms===6500).length; } };
  const stageTimer = i => all.filter(x => x.ms===6500)[i];
  const lead = { id: 'c-1', stage: 'Quoted' };
  const ctx = { console, PRESENT: false, VIEW_AS_ID: null, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k',
    STATE: { data: { settings: { catalog: {} } }, profiles: [] }, getRealProfile: () => ({ id: 'p', role: 'va' }),
    sb: { auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }) } },
    fetch: (u, o) => { posts.push({ u, body: JSON.parse(o.body) }); return Promise.reject(new Error('offline')); },
    setTimeout: (fn, ms) => { all.push({ fn, ms }); return all.length; },
    contactById: id => id===lead.id ? lead : null, leadStage: c => c.stage };
  vm.createContext(ctx);
  vm.runInContext(['readOnlyReason', 'catalogObject', 'automationEventBody', 'AUTOMATIONS_URL', 'AUTOMATION_EVENTS_SENT', 'automationEvent', 'autoEventWanted', 'autoEmitStage'].map(n => extractDecl(script, n)).join('\n') + '\nthis.__ev = automationEvent; this.__st = autoEmitStage;', ctx);
  const flush = () => new Promise(r => setImmediate(r));
  await ctx.__ev('newLead', 'c-9'); await flush();
  assertEqual(posts.length, 0, 'events: nothing is sent while no automation of your own waits for it');
  ctx.STATE.data.settings.catalog.automationEvents = { newLead: true, stage: true };
  ctx.PRESENT = true; await ctx.__ev('newLead', 'c-9'); ctx.__st('c-1', 'Quoted'); await flush();
  assertEqual([posts.length, timers.length], [0, 0], 'events: in presentation mode nothing is sent or waited for');
  ctx.PRESENT = false;
  let threw = false; try { await ctx.__ev('newLead', 'c-9'); await flush(); } catch (e) { threw = true; }
  assertEqual([threw, posts.length, posts[0] && posts[0].body, posts[0] && posts[0].u], [false, 1, { step: 'event', type: 'newLead', id: 'c-9' }, 'https://x.supabase.co/functions/v1/automations'], 'events: only the kind and the id are sent; a failed call never breaks the action');
  ctx.__st('c-1', 'Quoted');
  assertEqual([timers.length, posts.length], [1, 1], 'events: a stage move waits for its Undo (6.5 seconds) first');
  stageTimer(0).fn(); await flush();
  assertEqual(posts.slice(-1)[0].body, { step: 'event', type: 'stage', id: 'c-1' }, 'events: then it is told, the lead still being in that stage');
  ctx.__st('c-1', 'Quoted'); lead.stage = 'New'; stageTimer(1).fn(); await flush();
  assertEqual(posts.length, 2, 'events: a stage move undone in time is never told');
  ctx.STATE.data.settings.catalog.automationEvents = {};
  ctx.__st('c-1', 'New');
  assertEqual(timers.length, 2, 'events: no stage automation on, no wait either');
}
// Saving and switching on: a customer automation is never switched on by the builder without the owner's own yes.
async function testAutomationsCustomerSafety(){
  const writes = [];
  const table = { insert(row){ writes.push(['insert', row]); this.row = { id: 'n1', ...row }; return this; }, update(row){ writes.push(['update', row]); this.row = { id: 'c1', name: 'Team alert', trigger: { type: 'newLead' }, steps: [], ...row }; return this; },
    eq(){ return this; }, select(){ return this; }, single(){ return Promise.resolve({ data: this.row, error: null }); } };
  const sb = autoSandbox({ sb: { from: () => table } }), A = sb.__get('AUTO'), log = sb.log;
  sb.openAutoEditor(null);
  const ed = sb.__get('AUTO_ED');
  ed.name = 'Thanks'; ed.enabled = true;
  ed.def = { trigger: { type: 'jobClosed', params: {} }, steps: [{ id: 's1', kind: 'action', type: 'email', subject: 'Thanks {first_name}', templateKey: 'my_t' }] };
  ed.drafts = { my_t: { name: 'Thanks', channel: 'email', body: '{hi}, thanks!' } };
  await sb.autoSaveEditor();
  assertEqual([writes[0][0], writes[0][1].enabled, writes[0][1].business_id, sb.STATE.data.settings.catalog.templates.my_t, sb.STATE.data.settings.catalog.msgTemplates.my_t.channel, sb.__get('AUTO_ED')],
    ['insert', false, 'default', '{hi}, thanks!', 'email', null], 'save: a NEW automation that emails customers is written OFF, even with its switch on; its words go to the library');
  // an ON team automation gets an email: it is saved off, and says so
  A.list = [sb.autoNormalize({ id: 'c1', name: 'Team alert', enabled: true, trigger: { type: 'newLead' }, steps: [{ id: 's1', kind: 'action', type: 'push', to: { roles: ['owner'] }, title: 'New' }] })];
  sb.openAutoEditor('c1');
  const e2 = sb.__get('AUTO_ED');
  e2.def.steps.push({ id: 's2', kind: 'action', type: 'email', subject: 'Hi', templateKey: 'my_t' });
  writes.length = 0;
  await sb.autoSaveEditor();
  assertEqual([writes[0][0], writes[0][1].enabled, /It is off: switch it on from the list/.test(log.toasts.slice(-1)[0])], ['update', false, true], 'save: adding a customer email to an automation that is on saves it OFF, and says so');
  // switching on from the list
  A.list = [sb.autoNormalize({ id: 'c1', name: 'Mail', enabled: false, trigger: { type: 'jobClosed' }, steps: [{ id: 's1', kind: 'action', type: 'email', subject: 'Hi', templateKey: 'my_t' }] }),
    sb.autoNormalize({ id: 'c2', name: 'Team', enabled: false, trigger: { type: 'newLead' }, steps: [{ id: 's1', kind: 'action', type: 'push', to: { roles: ['owner'] }, title: 'New' }] })];
  writes.length = 0; const c0 = log.confirms.length;
  sb.toggleAutomation('c1');
  assertEqual([log.confirms.length - c0, writes.length, /This sends to real customers/.test(log.confirms.slice(-1)[0].m)], [1, 0, true], 'switching on a customer automation asks first and writes nothing until yes');
  await log.confirms.slice(-1)[0].fn(); await new Promise(r => setImmediate(r));
  assertEqual(writes.map(w => [w[0], w[1]]), [['update', { enabled: true }]], 'after yes: only "enabled" is written');
  writes.length = 0;
  sb.toggleAutomation('c2'); await new Promise(r => setImmediate(r));
  assertEqual([log.confirms.length - c0, writes.map(w => w[1])], [1, [{ enabled: true }]], 'a team automation switches on without asking');
  // a broken automation can't be switched on
  A.list = [sb.autoNormalize({ id: 'c3', name: 'Broken', enabled: false, trigger: { type: 'newLead' }, steps: [] })];
  writes.length = 0; sb.toggleAutomation('c3');
  assertEqual([writes.length, /^Fix it first/.test(log.toasts.slice(-1)[0])], [0, true], 'an automation with a problem can\'t be switched on');
  // the events the app sends follow the automations that are on
  A.list = [sb.autoNormalize({ id: 'c4', name: 'On', enabled: true, trigger: { type: 'stage', params: {} }, steps: [] })];
  sb.autoSyncEvents();
  assertEqual(sb.STATE.data.settings.catalog.automationEvents, { stage: true }, 'the starts the app reports are kept in settings (a silent write)');
}
// The Security page froze the browser on 14 Oct: while the sign-in options were loading, every redraw started another
// load that returned at once and asked for another redraw, an endless loop. Now a second call gets the SAME promise,
// so nothing can redraw before the real answer comes.
async function testAuthProvidersNoLoop(){
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8'), script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  let calls = 0, release = null;
  const ctx = { console, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k', AUTH: { status: 'signedIn' }, render(){},
    fetch(){ calls++; return new Promise(r => { release = () => r({ json: async () => ({ external: { google: true } }) }); }); } };
  vm.createContext(ctx);
  vm.runInContext('let AUTH_PROVIDERS = null;\n' + extractDecl(script, 'loadAuthProviders') + '\nthis.__lap = loadAuthProviders; this.__ap = () => AUTH_PROVIDERS;', ctx);
  const p1 = ctx.__lap(), p2 = ctx.__lap();
  let resolvedEarly = false; p2.then(() => { resolvedEarly = true; });
  await new Promise(r => setTimeout(r, 0));
  assertEqual([p1 === p2, calls, resolvedEarly, ctx.__ap()], [true, 1, false, null], 'security page: a second load of the sign-in options waits for the first one (no endless redraw loop)');
  release(); await p2;
  assertEqual([ctx.__ap(), ctx.__lap() === p1, calls], [{ google: true }, true, 1], 'security page: the options arrive once and are kept');
}

// The 14 Oct review of phase 4: customer safety in the builder, the lead card's "Stop automatic messages", the Safety
// settings, "Try it", ready-made automations taken off the list, the flow view's drag scrolling.
async function testAutomationsReview14Oct(){
  console.log('\nAutomations: the 14 Oct review fixes (phase 4)');
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8'), script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const eng = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'automations', 'index.ts'), 'utf8');
  const sb = autoSandbox(), m = loadSandbox(), ctx = autoFixtureCtx(m);
  // Safety settings: the engine's defaults, the database's limits
  const D = m.autoSafetyNorm(null);
  assertEqual([D.timezone, D.customer_from, D.customer_until, D.customer_daily_cap, D.max_late_hours, D.lookback_hours, D.customer_days.length, D.email_signer, D.email_footer],
    ['Australia/Sydney', '08:00', '20:00', 1, 24, 6, 7, '', ''], 'safety: nothing saved = the engine\'s defaults (every day 8 am–8 pm, one a day)');
  const engFooter = JSON.parse(eng.match(/email_footer: ("(?:[^"\\]|\\.)*")/)[1]);
  assertEqual(m.AUTO_EMAIL_FOOTER_DEFAULT, engFooter, 'safety: the way out the builder shows is the one the engine adds');
  assertEqual([/timezone: "Australia\/Sydney", customer_days: \[0, 1, 2, 3, 4, 5, 6\], customer_from: "08:00", customer_until: "20:00"/.test(eng), /customer_daily_cap: 1,/.test(eng), /max_late_hours: 24, lookback_hours: 6/.test(eng)], [true, true, true], 'safety: the same defaults as the engine\'s DEFAULT_SETTINGS');
  assertEqual(m.autoSafetyProblems({ ...D, customer_days: [], customer_from: '20:00', customer_until: '08:00', customer_daily_cap: 0, max_late_hours: 9999, email_signer: 'x'.repeat(61) }).length, 5, 'safety: no day, an end before the start, a cap of 0, 9999 hours late and a long signer are each refused');
  assertEqual(m.autoSafetyProblems(D), [], 'safety: the defaults are fine');
  const patch = m.autoSafetyPatch({ ...D, email_signer: '  ', email_footer: '', customer_days: [3, 1, 1] });
  assertEqual([patch.email_signer, patch.email_footer, patch.customer_days, Object.keys(patch).includes('business_id')], [null, null, [1, 3], false], 'safety: an empty signer or way out is "not set"; days once each, in order; the business never changes');
  assertEqual([m.autoTzLabel('Australia/Perth'), m.autoTzLabel('Pacific/Auckland'), m.autoTzLabel('')], ['Perth time', 'Auckland time', 'local time'], 'safety: the time zone in words (no fixed "Sydney time")');
  assertEqual(m.autoSafetyLine(null), 'Customers only get automatic messages every day, 8 am–8 pm (Sydney time), at most 1 a day each; a later one waits for the morning.', 'safety: the line the editor shows next to a customer email');
  { const keep = m.STATE.data.settings; m.STATE.data.settings = { ...keep, catalog: { region: { timeZone: 'America/Chicago' } } };
    assertEqual([m.autoSafetyLine({ timezone: 'Australia/Perth' }).includes('(Chicago time)'), m.autoSafetyNorm(null).timezone], [true, 'Australia/Sydney'], 'safety: the line follows the business\'s time zone (Region and format), not the old column; the column default stays the engine\'s');
    m.STATE.data.settings = keep; }
  assertEqual([m.autoEmailSigner({ email_signer: 'Dana Lee' }, 'Olivia Owner'), m.autoEmailSigner({}, 'Olivia Owner'), m.autoEmailSigner({}, 'The team'), m.autoEmailSigner({}, '')], ['Dana Lee', 'Olivia', '', ''], 'safety: who signs (never "The")');
  const A = sb.__get('AUTO');
  Object.assign(A, { safetyLoaded: true, safetyError: '', safety: { email_footer: '<script>x</script>', dont_contact_tags: ['<b>VIP</b>'] }, safetyDraft: null });
  let h = sb.autoSafetyHtml(A, ['VIP']);
  assertEqual([h.includes('<script>'), h.includes('&lt;script&gt;'), h.includes('&lt;b&gt;VIP'), h.includes('autoSafetyEdit()')], [false, true, true, true], 'safety: the read view escapes every saved word, with a Change button');
  A.safetyDraft = m.autoSafetyNorm(A.safety);
  h = sb.autoSafetyHtml(A, ['VIP']);
  assertEqual([h.includes('autoSafetySave()'), h.includes('aria-label="Time zone"'), h.includes('Change in Region and format'), h.includes('(Sydney time)'), (h.match(/class="au-day[ "]/g) || []).length], [true, false, true, true, 7], 'safety: the edit view has the days, hours and Save; the time zone is the business\'s (Region and format), no picker of its own');
  Object.assign(A, { safetyError: 'relation does not exist' });
  assertEqual(/could not be loaded/.test(sb.autoSafetyHtml(A, [])), true, 'safety: a failed load says so (the defaults still apply)');
  Object.assign(A, { safetyError: '', safetyDraft: null });
  // the editor: who signs, 'at' inside the hours, the review-ask warning, gate conditions
  const email = { id: 's1', kind: 'action', type: 'email', subject: 'Hi', templateKey: 'my_q' };
  const def = { trigger: { type: 'newLead', params: {} }, steps: [email] };
  assertEqual([m.autoStepIssues(email, def, { ...ctx, signer: '' }).some(p => p.block && /Nobody signs this email/.test(p.text)), m.autoStepIssues(email, def, { ...ctx, signer: 'Alex' }).some(p => /Nobody signs/.test(p.text)), m.autoStepIssues(email, def, ctx).some(p => /Nobody signs/.test(p.text))],
    [true, false, false], 'editor: an email nobody would sign can\'t be saved (only once the safety settings are known)');
  const win = { id: 'w1', kind: 'window', days: [1, 2, 3, 4, 5], from: '09:00', until: '17:00', outside: 'at', at: '20:00' };
  assertEqual([m.autoStepIssues(win, def, ctx).some(p => p.block && /inside those hours/.test(p.text)), m.autoStepIssues({ ...win, at: '10:00' }, def, ctx).length], [true, 0], 'editor: a 9–5 window can\'t "go at 8 pm"');
  const ask = { trigger: { type: 'jobClosed', params: {} }, steps: [{ id: 'i1', kind: 'if', match: 'all', conds: [{ field: 'asked_within_months', op: 'true', n: 6 }] }, email] };
  assertEqual(m.autoProblems(ask, ctx, {}).some(p => !p.block && /"Ask for review" button doesn't see them/.test(p.text)), true, 'editor: an automation that asks for reviews warns that the office\'s button doesn\'t see its asks');
  const any = { id: 'i1', kind: 'if', match: 'any', conds: [{ field: 'service', op: 'is', v: 'svcA' }, { field: 'source', op: 'is', v: 'web' }, { field: 'stage_unchanged', op: 'true' }] };
  assertEqual(m.flowIfPhrase(any, { trigger: { type: 'stage' } }, ctx), 'Only if (the service is Window cleaning or the lead source is Website) and the lead is still in that stage', 'editor: "Still in the stage" reads as an AND in an "any" group (as the engine runs it)');
  assertEqual([m.AUTO_CONDS.stage_unchanged.gate, m.AUTO_CONDS.stage_move_stands.hidden, /stage_unchanged: \{[^\n]*gate: true/.test(eng)], [true, true, true], 'editor: the gate is the engine\'s; the undo check is never offered');
  // customer channels and new versions (the database's rules)
  assertEqual([m.autoCustomerChannels({ steps: [email, { kind: 'action', type: 'text' }, { kind: 'action', type: 'push' }, { ...email, id: 's9' }] }), m.autoCustomerChannels({ steps: [] })], [['email', 'text'], []], 'channels: the customer channels it uses');
  const base = { trigger: { type: 'stage', params: { stage: 'Lost', x: 1 } }, steps: [{ id: 'w', kind: 'wait', n: 1, unit: 'days' }, { id: 'p', kind: 'action', type: 'push', title: 'a' }] };
  const V = (o) => m.autoNewVersion(base, { ...base, ...o });
  assertEqual([V({}), V({ steps: [base.steps[0], { ...base.steps[1], title: 'b', to: { roles: ['va'] } }] }), V({ steps: [{ ...base.steps[0], n: 3 }, base.steps[1]] }), V({ trigger: { type: 'stage', params: { x: 1, stage: 'Lost' } } }),
    V({ trigger: { type: 'stage', params: { stage: 'Quoted', x: 1 } } }), V({ steps: [base.steps[1], base.steps[0]] }), V({ steps: [base.steps[0]] }), m.autoNewVersion(null, base)],
    [false, false, false, false, true, true, true, false], 'versions: words, numbers and recipients keep what is waiting; another start, or steps added, moved or removed, start it afresh');
  // saving an automation that is on: another channel → off; another start → asked first
  const writes = [];
  const table = { _q: null, insert(row){ writes.push(['insert', row]); this.row = { id: 'n1', ...row }; return this; }, update(row){ writes.push(['update', row]); this.row = { id: 'c1', name: 'X', trigger: { type: 'newLead' }, steps: [], ...row }; return this; },
    eq(){ return this; }, in(){ return Promise.resolve({ count: 3, error: null }); }, select(){ return this; }, single(){ return Promise.resolve({ data: this.row, error: null }); } };
  const s2 = autoSandbox({ sb: { from: () => table } }), A2 = s2.__get('AUTO'), log2 = s2.log;
  s2.STATE.data.settings = { catalog: { templates: { my_t: '{hi}, thanks for asking.' }, msgTemplates: { my_t: { name: 'Thanks', channel: 'email' } } } };
  A2.list = [s2.autoNormalize({ id: 'c1', name: 'Texts', enabled: true, created_by_name: 'Alex Owner', trigger: { type: 'newLead' }, steps: [{ id: 's1', kind: 'action', type: 'text', templateKey: 'my_t' }] })];
  s2.openAutoEditor('c1');
  let e2 = s2.__get('AUTO_ED');
  e2.def.steps = [{ id: 's1', kind: 'action', type: 'email', subject: 'Hi', templateKey: 'my_t' }];
  await s2.autoSaveEditor();
  assertEqual([writes.length, writes[0] && writes[0][1].enabled, /It is off/.test(log2.toasts.slice(-1)[0])], [1, false, true], 'save: an automation that is on and swaps its text for an email is saved OFF (a new channel needs its own switch-on)');
  A2.list = [s2.autoNormalize({ id: 'c1', name: 'Team', enabled: true, created_by_name: 'Alex Owner', trigger: { type: 'stage', params: { stage: 'Lost' } }, steps: [{ id: 's1', kind: 'action', type: 'push', to: { roles: ['owner'] }, title: 'Moved' }] })];
  writes.length = 0; const c0 = log2.confirms.length;
  s2.openAutoEditor('c1'); e2 = s2.__get('AUTO_ED');
  e2.def.trigger = { type: 'stage', params: { stage: 'Quoted' } };
  await s2.autoSaveEditor();
  assertEqual([writes.length, log2.confirms.length - c0, /3 runs are waiting to act/.test(log2.confirms.slice(-1)[0].m), /only acts on what happens after you save/.test(log2.confirms.slice(-1)[0].m)], [0, 1, true, true], 'save: an automation that is on and gets another start asks first, with the runs waiting, and writes nothing yet');
  await log2.confirms.slice(-1)[0].fn(); await new Promise(r => setImmediate(r));
  assertEqual([writes.length, writes[0] && writes[0][1].trigger.params.stage, writes[0] && writes[0][1].enabled], [1, 'Quoted', true], 'save: after yes it is saved (still on; the database re-arms it)');
  writes.length = 0; const c1 = log2.confirms.length;
  s2.openAutoEditor('c1'); e2 = s2.__get('AUTO_ED');
  e2.def.steps[0].title = 'New words';
  await s2.autoSaveEditor();
  assertEqual([writes.length, log2.confirms.length - c1], [1, 0], 'save: new words only: saved at once, nothing waiting stops');
  // ready-made automations taken off the list
  const s3 = autoSandbox(), log3 = s3.log;
  s3.STATE.data.settings = { catalog: { notify: { newLead: { on: true } } } };
  const team = s3.autoReadyRows().find(r => r.base==='team:newLead');
  assertEqual(!!team && team.on, true, 'ready-made: the new-lead notification is on');
  s3.autoRemoveReady(team.key);
  assertEqual(log3.db.filter(x => x==='settings.update').length, 0, 'ready-made: removing asks first');
  log3.confirms.slice(-1)[0].fn();
  const cat3 = s3.STATE.data.settings.catalog;
  assertEqual([log3.db.filter(x => x==='settings.update').length, cat3.notify.newLead.on, cat3.automations.hiddenReady, s3.autoReadyRows().some(r => r.base==='team:newLead'), s3.autoReadyRows(true).some(r => r.base==='team:newLead')],
    [1, false, ['team:newLead'], false, true], 'ready-made: removed = switched off and off the list in ONE settings write; it still exists for "Put back"');
  assertEqual(/Put back/.test(s3.autoRemovedHtml(['team:newLead'], s3.autoReadyRows(true))) && s3.autoRemovedHtml([], s3.autoReadyRows(true))==='', true, 'ready-made: the removed ones are listed under the list, with "Put back"');
  s3.autoRestoreReady('team:newLead');
  assertEqual([s3.STATE.data.settings.catalog.automations.hiddenReady, s3.STATE.data.settings.catalog.notify.newLead.on], [[], false], 'ready-made: put back on the list, still off');
  // Try it
  const data = { contacts: [{ id: 'c1', fullName: 'Old <b>', createdAt: '2026-01-01', status: 'New' }, { id: 'c2', fullName: 'New one', createdAt: '2026-10-14', status: 'Quoted' }], jobs: [{ id: 'j1', customerName: 'Pat', date: '2026-10-13' }] };
  assertEqual([m.autoTryRecords('stage', data).map(r => r.id), m.autoTryRecords('jobClosed', data).map(r => r.kind + ':' + r.id), m.autoTryRecords('chat', data)], [['c2', 'c1'], ['job:j1'], []], 'try it: the latest leads for a lead start, jobs for a job start');
  const res = { ok: true, steps: [{ id: 'w', kind: 'wait', would: 'wait', until: '2026-10-14T21:00:00.000Z' }, { id: 'e1', kind: 'action', type: 'email', would: 'queue', to: 'sam@x.com', subject: '<img src=x>', body: 'Hi Sam', signature: '\n\nAlex', note: 'this automation is off: nothing is sent' }, { id: 'p1', kind: 'action', type: 'push', would: 'skip', reason: 'condition: <b>' }] };
  const out = m.autoTryResultHtml(res, { safety: { timezone: 'Australia/Sydney' } });
  assertEqual([out.includes('<img'), out.includes('&lt;img'), out.includes('Stops: condition: &lt;b&gt;'), /Waits until <b>Thu/.test(out), out.includes('nothing is sent')], [false, true, true, true, true], 'try it: every word from the server escaped; waits in the business\'s time; stops say why');
  assertEqual([/could not be reached/.test(m.autoTryResultHtml({ error: 'The automations service could not be reached. Try again in a moment.' })), /record not found/.test(m.autoTryResultHtml({ ok: false, problems: ['record not found'] }))], [true, true], 'try it: a failure says so');
  {
    let calls = 0, release = null; const shown = {};
    const tctx = { console, PRESENT: false, VIEW_AS_ID: null, AUTOMATIONS_URL: 'u', SUPABASE_ANON_KEY: 'k', AUTO: { tryOut: null }, AUTO_ED: { token: 't1', mirror: false, name: 'X', def: { trigger: { type: 'newLead' }, steps: [] }, enabled: false },
      sb: { auth: { getSession: async () => ({ data: { session: { access_token: 'a' } } }) } }, showToast(){}, autoCtx: () => ({}), autoTryResultHtml: (r) => 'RESULT:' + JSON.stringify(r), flowCompact: x => x,
      document: { getElementById: id => id==='au-try-rec' ? { value: 'contact:c1' } : (shown[id] = shown[id] || { innerHTML: '' }) },
      fetch(u, o){ calls++; tctx.body = JSON.parse(o.body); return new Promise(r => { release = () => r({ json: async () => ({ ok: true, steps: [] }) }); }); } };
    vm.createContext(tctx);
    vm.runInContext(['readOnlyReason', 'autoTryIt'].map(n => extractDecl(script, n)).join('\n') + '\nthis.__try = autoTryIt;', tctx);
    const p1 = tctx.__try(), p2 = tctx.__try();
    await new Promise(r => setImmediate(r));
    assertEqual([p1===p2, calls, tctx.body.step, tctx.body.record, shown['au-try-out'].innerHTML], [true, 1, 'preview', { kind: 'contact', id: 'c1' }, '<div class="hint">Working it out…</div>'], 'try it: one question at a time (a second click waits for the same answer); only the preview step');
    release(); await p2;
    assertEqual([shown['au-try-out'].innerHTML, !!tctx.AUTO.tryOut], ['RESULT:{"ok":true,"steps":[]}', true], 'try it: the answer fills the card only (no redraw)');
    tctx.PRESENT = true; calls = 0;
    assertEqual([tctx.__try(), calls], [null, 0], 'try it: in a read-only mode no server is called');
  }
  // the lead card's "Stop automatic messages"
  const o = loadOptOutSandbox(script);
  const C = { id: 'c1', fullName: 'Sam <Smith>', email: ' Sam@Example.com ', phone: '0412 345 678' };
  assertEqual([o.optOutKeys(C), o.optOutKeys({ email: 'nope', phone: '12' })], [['sam@example.com', '412345678'], []], 'opt-out: the card\'s addresses (lower-case email, the phone\'s last 9 digits)');
  assertEqual(o.optOutInserts(C, 'default', 'Asked to stop').map(r => [r.business_id, r.contact_id, r.channel, r.value_key]), [['default', 'c1', 'all', 'sam@example.com'], ['default', 'c1', 'all', '412345678']], 'opt-out: one row per address, so it outlives the card');
  assertEqual(o.optOutRowsFor({ id: 'c2', email: 'sam@example.com' }, [{ id: 'x', contact_id: 'c1', value_key: 'sam@example.com' }, { id: 'y', contact_id: 'c9', value_key: 'kim@x.com' }]).map(r => r.id), ['x'], 'opt-out: another card with the same email is stopped too');
  assertEqual([o.optOutControlHtml(C, { loaded: false, rows: [] }), /Stop automatic messages/.test(o.optOutControlHtml(C, { loaded: true, rows: [] })), /No automatic messages[\s\S]*Allow again/.test(o.optOutControlHtml(C, { loaded: true, rows: [{ contact_id: 'c1' }] }))], ['', true, true], 'opt-out: the card shows the stop, or that it is stopped');
  const p1 = o.loadCustomerOptOuts(), p2 = o.loadCustomerOptOuts();
  await new Promise(r => setImmediate(r));
  assertEqual([p1===p2, o.__q.reads], [true, 1], 'opt-out: a second load while one runs is the same promise (one read, no redraw)');
  o.__q.release(); await p2;
  assertEqual([o.OPTOUTS.loaded, o.__renders()], [true, 0], 'opt-out: loaded; the page is never redrawn by it');
  o.stopAutoMessages('c1');
  assertEqual(o.__q.writes.length, 0, 'opt-out: stopping asks first');
  await o.__confirms.slice(-1)[0].fn();
  assertEqual([o.__q.writes[0][0], o.__q.writes[0][1].map(r => r.value_key), o.OPTOUTS.rows.length, o.__acts.slice(-1)[0]], ['insert', ['sam@example.com', '412345678'], 2, 'Automatic messages stopped (the customer asked)'], 'opt-out: after yes, both addresses are written and the card\'s history says so');
  o.allowAutoMessages('c1'); await o.__confirms.slice(-1)[0].fn();
  assertEqual([o.__q.writes[1][0], o.__q.writes[1][1].length, o.OPTOUTS.rows.length], ['delete', 2, 0], 'opt-out: "Allow again" removes them (after a yes)');
  o.__ctx.PRESENT = true; const w0 = o.__q.writes.length, k0 = o.__confirms.length;
  o.stopAutoMessages('c1');
  assertEqual([o.__q.writes.length - w0, o.__confirms.length - k0], [0, 0], 'opt-out: nothing in a read-only mode');
  // the flow view's drag: never the page behind the editor
  {
    // scrollTop clamps to the end, as a browser does
    const node = (o2) => { let top = 0; const n = { parentElement: null, scrollHeight: 100, clientHeight: 100, id: '', cls: [], matches(sel){ return sel.split(',').some(x => this.cls.includes(x.trim().slice(1))); }, getBoundingClientRect: () => ({ top: 0, bottom: 600 }), ...o2 };
      Object.defineProperty(n, 'scrollTop', { get: () => top, set: v => { top = Math.max(0, Math.min(n.scrollHeight - n.clientHeight, v)); } }); return n; };
    const docEl = node({ cls: [] }), styles = new Map();
    const fctx = { console, document: { scrollingElement: docEl, documentElement: docEl }, window: { innerHeight: 800 }, getComputedStyle: el => ({ overflowY: styles.get(el) || 'visible' }), requestAnimationFrame: () => 7, FLOW_DRAG: null };
    vm.createContext(fctx);
    vm.runInContext(['flowScroller', 'flowScrollTop', 'flowDropIndex', 'flowDragUpdate', 'flowDragEdge'].map(n => extractDecl(script, n)).join('\n') + '\nthis.__sc = flowScroller; this.__edge = flowDragEdge; this.__set = d => { FLOW_DRAG = d; };', fctx);
    const back = node({ cls: ['modal-back'] }), modal = node({ cls: ['modal', 'auto-ed'], parentElement: back }), body = node({ cls: ['au-ed-body'], parentElement: modal }), main = node({ cls: ['ed-main'], parentElement: body }), canvas = node({ cls: ['flow'], parentElement: main });
    styles.set(modal, 'hidden'); styles.set(back, 'hidden'); styles.set(main, 'auto');
    assertEqual(fctx.__sc(canvas)===main, true, 'drag: a short flow in the editor scrolls the editor\'s own area (even when it is not longer than it shows), never the page');
    styles.set(main, 'visible'); styles.set(body, 'visible');
    assertEqual(fctx.__sc(canvas), null, 'drag: no scroll area in the window = nothing scrolls');
    const loose = node({ cls: ['flow'], parentElement: node({ cls: ['card'] }) });
    assertEqual(fctx.__sc(loose)===docEl, true, 'drag: outside a window the page scrolls');
    const item = { style: {} }, d = { started: true, scroller: null, y: 790, y0: 300, scroll0: 0, item, items: [item], mids: [100], from: 0, to: 0, h: 50, raf: 1 };
    fctx.__set(d); fctx.__edge();
    assertEqual([d.raf, docEl.scrollTop], [null, 0], 'drag: at the bottom edge with nothing to scroll, the frame loop stops and the page stays put');
    styles.set(main, 'auto'); d.scroller = main; d.raf = 1; main.scrollHeight = 100; main.clientHeight = 100;
    fctx.__edge();
    assertEqual([d.raf, main.scrollTop], [null, 0], 'drag: an area already at its end stops the loop too (no endless frames)');
  }
  // the job's event is told after its card is linked (both ways a job is made)
  const sj = extractDecl(script, 'saveJobModal'), fc = extractDecl(script, 'finalizeClosing');
  assertEqual([sj.indexOf("automationEvent('jobClosed'") > sj.indexOf('await ensureContactForJob(job, contactId)'), fc.indexOf("automationEvent('jobClosed'") > fc.indexOf('await ensureContactForJob(job, g.contactId)'), (sj.match(/automationEvent\('jobClosed'/g) || []).length, (fc.match(/automationEvent\('jobClosed'/g) || []).length],
    [true, true, 1, 1], 'events: a new job is reported once, after its customer card is linked');
}
// A small context for the lead card's opt-out control: a fake table that holds its read until released.
function loadOptOutSandbox(script){
  const q = { reads: 0, writes: [], release: null };
  const rows = [];
  const table = () => {
    const b = { op: 'select', payload: null,
      select(){ return b; }, eq(){ return b; },
      insert(p){ b.op = 'insert'; b.payload = p; return b; }, delete(){ b.op = 'delete'; return b; },
      in(k, ids){ q.writes.push(['delete', ids]); return Promise.resolve({ error: null }); },
      range(){ q.reads++; return new Promise(r => { q.release = () => r({ data: rows, error: null }); }); },
      then(res, rej){ if (b.op==='insert') { q.writes.push(['insert', b.payload]); return Promise.resolve({ data: b.payload.map((x, i) => ({ id: 'o' + i, ...x })), error: null }).then(res, rej); } return Promise.resolve({ data: [], error: null }).then(res, rej); } };
    return b;
  };
  let renders = 0; const confirms = [], acts = [];
  const ctx = { console, PRESENT: false, VIEW_AS_ID: null, AUTO_BUSINESS_ID: 'default', LEAD_MODAL_ID: 'c1', sb: { from: table },
    STATE: { data: { contacts: [{ id: 'c1', fullName: 'Sam', email: 'sam@example.com', phone: '0412 345 678' }] } },
    render(){ renders++; }, renderKeepingInput(){ renders++; }, showToast(){}, confirmAction: (m, fn) => confirms.push({ m, fn }), logContactActivity: (c, a, t) => acts.push(t), getCurrentProfile: () => ({ fullName: 'Alex' }),
    document: { getElementById: () => ({ innerHTML: '' }) } };
  vm.createContext(ctx);
  vm.runInContext(['esc', 'jsStr', 'pill', 'readOnlyReason', 'contactById', 'OPTOUTS', 'optOutKeys', 'optOutRowsFor', 'optOutInserts', 'optOutControlHtml', 'loadCustomerOptOuts', 'optOutRefresh', 'stopAutoMessages', 'allowAutoMessages'].map(n => extractDecl(script, n)).join('\n')
    + '\nthis.__x = { OPTOUTS, optOutKeys, optOutRowsFor, optOutInserts, optOutControlHtml, loadCustomerOptOuts, stopAutoMessages, allowAutoMessages };', ctx);
  return { ...ctx.__x, __q: q, __ctx: ctx, __renders: () => renders, __confirms: confirms, __acts: acts };
}

(async () => {
  await testAuthProvidersNoLoop();
  await testAutomationsLoaderNoLoop();
  await testAutomationEventsGate();
  await testAutomationsCustomerSafety();
  await testAutomationsReview14Oct();
  await testHolidayLoaders();
  await testFullBackup(loadSandbox());
  await testDataExport(loadSandbox());
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('business-logic tests crashed:', e); process.exit(1); });
