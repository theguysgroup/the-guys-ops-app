#!/bin/bash
# Runs the ingest-ads-stats tests locally: the function with its esm.sh import stubbed and a pretend Deno.env (the
# server part is skipped in tests), then tests.ts, with npx tsx.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="${TMPDIR:-/tmp}/ingest_ads_stats_test_$$.ts"
{
  echo '(globalThis as any).__INGEST_TEST__ = true;'
  echo '(globalThis as any).Deno = { env: { get: (_k: string) => undefined } };'
  echo 'const createClient = null as any;'
  sed -e '/^import { createClient }/d' -e 's/^export //' "$DIR/index.ts"
  cat "$DIR/tests.ts"
} > "$OUT"
cd "$DIR" && npx --yes tsx "$OUT"
rm -f "$OUT"
