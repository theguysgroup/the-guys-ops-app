#!/bin/bash
# Runs the contractor-sign tests locally: the function with its esm.sh import stubbed and the server part skipped,
# then tests.ts, with npx tsx.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="${TMPDIR:-/tmp}/contractor_sign_test_$$.ts"
{
  echo '(globalThis as any).__SIGN_TEST__ = true;'
  echo '(globalThis as any).Deno = { env: { get: (_k: string) => undefined } };'
  echo 'const createClient = null as any;'
  sed -e '/^import { createClient }/d' -e 's/^export //' "$DIR/index.ts"
  cat "$DIR/tests.ts"
} > "$OUT"
cd "$DIR" && npx --yes tsx "$OUT"
rm -f "$OUT"
