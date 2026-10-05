#!/bin/bash
# Runs the review-requests function tests locally: the function with its esm.sh import stubbed and a pretend Deno.env,
# then tests.ts, with npx tsx.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="${TMPDIR:-/tmp}/review_requests_test_$$.ts"
{
  echo '(globalThis as any).__REVIEW_TEST__ = true;'
  echo '(globalThis as any).Deno = { env: { get: (k: string) => (({ GHL_REVIEW_WEBHOOK_URL: "https://ghl.test/hook" }) as any)[k] } };'
  echo 'const createClient = null as any;'
  sed -e '/^import { createClient }/d' -e 's/^export //' "$DIR/index.ts"
  cat "$DIR/tests.ts"
} > "$OUT"
cd "$DIR" && npx --yes tsx "$OUT"
rm -f "$OUT"
