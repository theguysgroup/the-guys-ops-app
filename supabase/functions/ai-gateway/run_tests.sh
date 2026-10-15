#!/bin/bash
# Runs the ai-gateway function tests locally: the function with its three imports stubbed (the Anthropic SDK by a stub
# with the SDK's error classes; tests hand in a fake client through io.anthropicClient) and a pretend Deno.env, the
# app's own office-hours, role-label, product-name, task-board, stage and vacation code extracted from index.html (APP, for
# the parity tests), the provider fixtures (CF_FIXTURES, fixtures/), then tests.ts.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
OUT="${TMPDIR:-/tmp}/ai_gateway_test_$$.ts"
{
  echo '(globalThis as any).__AI_TEST__ = true;'
  echo "(globalThis as any).__AI_ENV__ = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon-test' } as Record<string, string>;"
  echo '(globalThis as any).Deno = { env: { get: (k: string) => (globalThis as any).__AI_ENV__[k] } };'
  echo 'const createClient = null as any;'
  echo 'const webpush = null as any;'
  cat <<'TS'
// The SDK's error classes, as the gateway checks them (instanceof, most specific first).
class __APIError extends Error { status: any; constructor(status?: any, message = "api error") { super(message); this.status = status; } }
class __APIUserAbortError extends __APIError { constructor() { super(undefined, "Request was aborted."); } }
class __APIConnectionError extends __APIError { constructor() { super(undefined, "Connection error."); } }
class __BadRequestError extends __APIError { constructor(m?: string) { super(400, m); } }
class __AuthenticationError extends __APIError { constructor(m?: string) { super(401, m); } }
class __PermissionDeniedError extends __APIError { constructor(m?: string) { super(403, m); } }
class __NotFoundError extends __APIError { constructor(m?: string) { super(404, m); } }
class __RateLimitError extends __APIError { constructor(m?: string) { super(429, m); } }
class __InternalServerError extends __APIError { constructor(m?: string) { super(500, m); } }
const Anthropic: any = class { constructor() { throw new Error("tests use io.anthropicClient"); } };
Object.assign(Anthropic, { APIError: __APIError, APIUserAbortError: __APIUserAbortError, APIConnectionError: __APIConnectionError, BadRequestError: __BadRequestError,
  AuthenticationError: __AuthenticationError, PermissionDeniedError: __PermissionDeniedError, NotFoundError: __NotFoundError, RateLimitError: __RateLimitError,
  InternalServerError: __InternalServerError });
TS
  sed -e '/^import { createClient }/d' -e '/^import Anthropic/d' -e '/^import webpush/d' -e 's/^export //' "$DIR/index.ts"
  # The app's functions, inside one function so they never clash with the server's names (same extraction as
  # tests/business-logic.test.js). A renamed or missing function fails the run here.
  node - "$ROOT/index.html" <<'JS'
const fs = require('fs');
const NAMES = ['catalogHours', 'ROLE_LABEL', 'productName', 'OFFICE', 'hhmmToMins', 'minsToHhmm', 'officeHoursText',
  // G2 (tests_changes.ts): the role pages, dates, ids, task boards and the pipeline's stage rules
  'canViewSection', 'SECTION_LABEL', 'MONTHS', 'parseLocalDate', 'fmtDateShort', 'uid', 'boardForAssignees', 'catalogObject', 'officeLabel', 'taskBoardLabel',
  'LEAD_STATUSES', 'LEAD_STAGE_LABEL', 'STAGE_CORE', 'STAGES_NEED_DATE', 'JOB_CACHE', 'jobIndex', 'leadLatestJobDate', 'leadWonByJob', 'leadStage', 'stageMovePlan',
  // stage 3 (rebase on a8c6d2d): the vacation warning on a new task, with the business's day it reads (stage 1 region helpers)
  'VACATION_OPTIONS', 'VACATION_PAY', 'vacationOptionsNorm', 'mapVacationRow', 'vacationOpt', 'vacationMatches', 'vacationOnDay', 'vacationFor', 'vacationUntilText',
  'vacationPickerInfo', 'vacationUsableStandIn', 'vacationJobStandIn', 'vacationWho', 'vacationAssignInfo', 'vacationAssignConflicts', 'listJoin', 'vacationAssignLine',
  // stage 3 follow-ups (rebase on f9c64b6): the app's "due back" day reads the person's working days
  'vacationWorkingDaysOf', 'vacationBackDay',
  'pad2', 'fmtLocal', 'shiftDays', 'REGION_DEFAULTS', 'REGION_NONE', 'REGION_MEMO', 'BIZ_WALL', 'BIZ_DAY_MEMO', 'TZ_VALID', 'regionNow', 'tzValid', 'regionMemo', 'bizTz',
  'bizWall', 'bizDayOf', 'bizDayMemo',
  // stage 8 (tests_read.ts): the role fixtures' pages and the task statuses
  'defaultPermissionsFor', 'TASK_STATUSES'];
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
console.log(`const APP: any = (() => { const STATE: any = { data: { settings: { catalog: {} }, jobs: [], employees: [] }, profiles: [] };\n${NAMES.map(n => extractDecl(m[1], n)).join('\n')}\nreturn { STATE, ${NAMES.join(', ')} }; })();`);
JS
  # The provider fixtures as CF_FIXTURES (tests_providers.ts): fixtures/*.txt streams (hand-built from the documented
  # shapes, cf-rec-* recorded live by G7's --record) and *.json non-streamed answers, named without the extension.
  node -e 'const fs = require("fs"), d = process.argv[1];
const files = fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /\.(txt|json)$/.test(f)).sort() : [];
console.log("const CF_FIXTURES: { name: string; body: string }[] = " + JSON.stringify(files.map((f) => ({ name: f.replace(/\.[a-z]+$/, ""), body: fs.readFileSync(d + "/" + f, "utf8") }))) + ";");' "$DIR/fixtures"
  cat "$DIR/tests.ts"
  # later groups' tests (they push suites that tests.ts runs before its summary)
  for f in "$DIR"/tests_*.ts; do [ -f "$f" ] && cat "$f"; done
} > "$OUT"
cd "$DIR" && npx --yes tsx "$OUT"
rm -f "$OUT"
