#!/bin/bash
# Runs the automations function tests locally: the function with its esm.sh and npm imports stubbed and a pretend
# Deno.env (the tests set test values in __AUTO_ENV__), then tests.ts; first the offline differential (differential/run.sh).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="${TMPDIR:-/tmp}/automations_test_$$.ts"
{
  echo '(globalThis as any).__AUTO_TEST__ = true;'
  echo '(globalThis as any).__AUTO_ENV__ = {} as Record<string, string>;'
  echo '(globalThis as any).Deno = { env: { get: (k: string) => (globalThis as any).__AUTO_ENV__[k] } };'
  echo 'const createClient = null as any;'
  echo 'const webpush = null as any;'
  sed -e '/^import { createClient }/d' -e '/^import webpush/d' -e 's/^export //' "$DIR/index.ts"
  cat "$DIR/tests.ts"
} > "$OUT"
# The offline differential (design §8.3 #1, the phase-1 gate): phase 4 (a8c6d2d) = the v2 compat build = the rollback
# build on the built-in corpus and every cutover. Its summary line comes first; the test count stays the last line.
if ! DIFF_OUT="$(bash "$DIR/differential/run.sh" 2>&1)"; then
  echo "$DIFF_OUT" | tail -40
  rm -f "$OUT"
  echo "automations: DIFFERENTIAL FAILED"
  exit 1
fi
echo "$DIFF_OUT" | grep -E '^DIFFERENTIAL: ' || { rm -f "$OUT"; echo "automations: DIFFERENTIAL gave no verdict"; exit 1; }
cd "$DIR" && npx --yes tsx "$OUT"
rm -f "$OUT"
