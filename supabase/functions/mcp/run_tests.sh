#!/bin/bash
# Runs the mcp function tests locally: the function with its import stubbed and a pretend Deno.env, the app's own role
# and pay functions extracted from index.html (APP, for the parity tests), then tests.ts.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
OUT="${TMPDIR:-/tmp}/mcp_test_$$.ts"
{
  echo '(globalThis as any).__MCP_TEST__ = true;'
  echo "(globalThis as any).__MCP_ENV__ = { SUPABASE_URL: 'https://example.supabase.co', MCP_CRON_SECRET: 'test-cron-secret' } as Record<string, string>;"
  echo '(globalThis as any).Deno = { env: { get: (k: string) => (globalThis as any).__MCP_ENV__[k] } };'
  echo 'const createClient = null as any;'
  sed -e '/^import { createClient }/d' -e 's/^export //' "$DIR/index.ts"
  # The app's functions, inside one function so they never clash with the server's names (same extraction as
  # tests/business-logic.test.js). A renamed or missing function fails the run here.
  node - "$ROOT/index.html" <<'JS'
const fs = require('fs');
const NAMES = ['canViewSection', 'defaultPermissionsFor', 'assigneeNames', 'taskAssignedTo', 'filterForProfile', 'pad2', 'parseLocalDate', 'fmtLocal',
  'daysBetween', 'round2', 'shiftDays', 'localDay', 'MONTHS', 'DAY_NAMES', 'WEEK_RULES_MEMO', 'weekRules', 'weekRulesNow', 'weekBounds', 'weekOf',
  'jobGst', 'jobTotalCollected', 'employeeByName', 'commissionDeductsParts', 'jobCommissionBase', 'jobCommissionAmount', 'commissionEligibleTechnicianNames',
  'PAYROLL_HOURLY_RATE', 'PAYROLL_BOOKING_BONUS', 'payCatalog', 'payTiersOk', 'payHourlyFor', 'bookingBonus', 'salesLogBookings', 'salesLogPay',
  'payrollWeekOf', 'shiftPayrollWeek', 'jobPaidDate', 'materialsGst', 'payrollMaterialItems', 'computePayrollMaterials', 'payrollStatus',
  'payrollBonusesFor', 'computePayrollCommission', 'computePayrollHourly', 'payrollCommissionPeople', 'payrollHourlyPeople', 'computeWeek',
  'summarizeCalls', 'GOOGLE_ADS_AIRCON_ACCOUNT', 'callDivision', 'commissionRateFor',
  // the task board rule (imports put a task on the board the app would)
  'boardForAssignees',
  // the built-in lists an import checks values against (Settings → Pipeline / Services / Lead sources start from these)
  'LEAD_DIVISIONS', 'LEAD_STATUSES', 'LEAD_SOURCES', 'STAGE_CORE', 'LEAD_STAGE_LABEL', 'LEAD_SOURCE_LABEL',
  // the business's day (stage 1 region helpers; localDay and the pay week read it) — same list tests/business-logic.test.js uses
  'REGION_DEFAULTS', 'REGION_NONE', 'REGION_MEMO', 'BIZ_WALL', 'BIZ_DAY_MEMO', 'TZ_VALID', 'regionNow', 'tzValid', 'regionMemo', 'bizTz', 'bizWall',
  'bizDayOf', 'bizDayMemo', 'todayStr',
  // the app's own row mappers, so the parity fixture reaches the app exactly as the app loads it
  'mapJobRow', 'mapEquipSpendRow', 'mapTaskRow', 'mapClosingRow', 'mapPayrollRow', 'mapBonusRow', 'mapSalesLogRow'];
function extractDecl(source, name){
  const fnIdx = source.indexOf(`function ${name}(`);
  const constIdx = source.search(new RegExp(`\\bconst ${name}\\s*=`));
  if (fnIdx === -1 && constIdx === -1) { console.error(`run_tests.sh: "${name}" not found in index.html — was it renamed?`); process.exit(1); }
  if (fnIdx !== -1 && (constIdx === -1 || fnIdx < constIdx)) {
    let depth = 1, i = source.indexOf('{', fnIdx) + 1;
    while (depth > 0) { if (source[i] === '{') depth++; else if (source[i] === '}') depth--; i++; }
    return source.slice(fnIdx, i);
  }
  let i = constIdx, depth = 0;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 0) { i++; break; }
  }
  return source.slice(constIdx, i);
}
const m = fs.readFileSync(process.argv[2], 'utf8').match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('run_tests.sh: no <script> in index.html'); process.exit(1); }
console.log(`const APP: any = (() => { const STATE: any = { data: null, profiles: [] };\n${NAMES.map(n => extractDecl(m[1], n)).join('\n')}\nreturn { STATE, ${NAMES.join(', ')} }; })();`);
JS
  cat "$DIR/tests.ts"
} > "$OUT"
cd "$DIR" && npx --yes tsx "$OUT"
rm -f "$OUT"
