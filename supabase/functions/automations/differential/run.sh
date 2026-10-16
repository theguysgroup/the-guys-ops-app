#!/bin/bash
# Stage 2 phase 1 — OFFLINE differential (design §8.3 #1, G1.4): the phase-1 go-live gate. Nothing here talks to a
# database or the network. Run by supabase/functions/automations/run_tests.sh (built-in corpus), so check_all covers it.
#
# Replays recorded-style phase-4 scenarios through three engines on the same in-memory fake database (the one the
# automations tests use, Part-1 shaped):
#   old = the phase-4 function as live before stage 2: the vendored copy tests/phase4-reference.ts (= git commit f9c64b6,
#         supabase/functions/automations/index.ts: phase 4 + stage 5's quiet imports + stage 3's vacations, live since
#         15 Oct, + the stage 3 follow-ups' vacations block (vacBackDay; 16 Oct); checked against the commit whenever git
#         can show it)
#   new = the stage-2 function in compat mode (supabase/functions/automations/index.ts: phase-4 scanners + enqueue, runs
#         executed by advanceV2)
#   rb  = the rollback build (supabase/functions/automations-phase4-compat/index.ts)
# plus "nf" = the new build deployed BEFORE Part 1 (its phase-4 fallback; must write no v2 rows), and the cutovers:
# old → new after tick k (the deploy), new → rb / new → old (a rollback), new → rb → new (a redeploy), new/rb alternating
# every tick, nf → new (Part 1 applied after the function); and (G2.1) "ev" = the same build with the event store on
# (Part 2 step E: phase4_compat = false; design §8.3 #1 (b): upgradeV1 + matcher + advanceV2) alone, switched on after
# tick 1 / mid, switched back (ev → new, ev → rb) and alternating with compat every tick; and (G2.4) "ev+mg" = the event
# store after step "migrate" (every row runs its doc: design §8.3 #4) from the start, migrated mid-way, then rolled back to
# the rollback build, plus "doc only" (the phase-4 steps emptied after the migration: an old-editor edit or phase 7's drop;
# only rows whose phase-4 ids are v2 ids). Compared: action log rows (step id, channel, audience, status,
# reason, recipient, time), run end status / reason / step_index, every due_at a run had, pushes, tasks and emails (exact
# text). step / exit / enroll rows are ignored (phase 4 writes none). Any difference is printed and the script exits 1.
#
# Usage (from anywhere):
#   bash supabase/functions/automations/differential/run.sh
#        the built-in corpus (corpus/builtin.json + the fixtures/upgrade.json v1 shapes)
#   … run.sh --corpus live-automations.json
#        + a READ-ONLY JSON export of the live automations (RUNBOOK step 3):
#          [{ id, name, enabled, armed_at, version, created_by_name, trigger, steps }]
#   … run.sh --corpus live-automations.json --records live-records.json
#        + the live shadow: each live automation × its last 20 matching records of a READ-ONLY export (contacts, jobs,
#          calls, chat_sessions, lead_messages, customer_opt_outs, review_requests, settings, automation_settings,
#          profiles, employees), each record alone at the moment of its event
#   … run.sh --corpus selftest/fake-live-automations.json --records selftest/fake-live-records.json
#        the two options above on made-up data (proves those paths work before real exports exist)
#   … run.sh --corpus live-automations-after-migrate.json
#        (G2.4) an export taken AFTER step "migrate" (+ definition, settings): the migration check — every doc exactly
#        upgradeV1 of its steps and run as phase 4 (selftest/fake-live-automations-migrated.json = the made-up one)
#   … run.sh --quick     first 3 scenarios only
# Live exports hold customer data: keep them OUT of the repo (the session scratchpad), never commit them.
# Output: a summary on screen; report.json in the temporary build folder (its path is printed).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
WT="$(cd "$DIR/../../../.." && pwd)"
PHASE4_COMMIT="${PHASE4_COMMIT:-f9c64b6}"
REF="$WT/tests/phase4-reference.ts"
B="$(mktemp -d "${TMPDIR:-/tmp}/automations_differential_XXXXXX")"
trap 'rm -rf "$B/"*.ts' EXIT
stub() { sed -e 's#^import { createClient } .*#const createClient = null as any;#' -e 's#^import webpush .*#const webpush = null as any;#'; }
[ -f "$REF" ] || { echo "DIFFERENTIAL: FAILED (the vendored phase-4 reference $REF is missing)"; exit 1; }
cp "$REF" "$B/phase4.src.ts"
# the vendored copy must be the phase-4 commit byte for byte (skipped only where git can't show that commit)
if git -C "$WT" cat-file -e "$PHASE4_COMMIT:supabase/functions/automations/index.ts" 2>/dev/null; then
  git -C "$WT" show "$PHASE4_COMMIT:supabase/functions/automations/index.ts" | cmp -s - "$REF" \
    || { echo "DIFFERENTIAL: FAILED (tests/phase4-reference.ts is not $PHASE4_COMMIT:supabase/functions/automations/index.ts)"; exit 1; }
fi
stub < "$B/phase4.src.ts" > "$B/old.ts"
stub < "$WT/supabase/functions/automations/index.ts" > "$B/new.ts"
cp "$WT/supabase/functions/automations-phase4-compat/index.ts" "$B/rb.src.ts"
stub < "$B/rb.src.ts" > "$B/rb.ts"
# the fake database of the automations tests (between its two markers), as a module
T="$WT/supabase/functions/automations/tests.ts"
{
  echo '// deno-lint-ignore-file no-explicit-any'
  awk '/^\/\/ ── a small in-memory stand-in for the Supabase client ──/{on=1} /^\/\/ ── the outside world ──/{on=0} on' "$T"
  echo 'export { fakeDb, SQL_SIGS, sqlSigs };'
} > "$B/fake.ts"
grep -q '^function fakeDb' "$B/fake.ts" || { echo "DIFFERENTIAL: FAILED (fake database not found in tests.ts)"; exit 1; }
cat > "$B/setup.ts" <<'TS'
(globalThis as any).__AUTO_TEST__ = true;
(globalThis as any).__AUTO_ENV__ = {} as Record<string, string>;
(globalThis as any).Deno = { env: { get: (k: string) => (globalThis as any).__AUTO_ENV__[k] } };
TS
cp "$DIR/harness.ts" "$B/harness.ts"
ORIG_PWD="$PWD"
cd "$B" && PHASE4_COMMIT="$PHASE4_COMMIT" ORIG_PWD="$ORIG_PWD" WT="$WT" DIFF_DIR="$DIR" REPORT="$B/report.json" npx --yes tsx harness.ts "$@"
