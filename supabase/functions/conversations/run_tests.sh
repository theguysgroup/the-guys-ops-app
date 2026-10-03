#!/bin/bash
# Runs the conversations function tests locally: the function with its esm.sh import stubbed, then tests.ts.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="${TMPDIR:-/tmp}/conversations_test_$$.ts"
{
  echo '(globalThis as any).__CONV_TEST__ = true;'
  echo 'const createClient = null as any;'
  sed -e '/^import { createClient }/d' -e 's/^export //' "$DIR/index.ts"
  cat "$DIR/tests.ts"
} > "$OUT"
cd "$DIR" && npx --yes tsx "$OUT"
rm -f "$OUT"
