#!/bin/bash
# Runs the push function tests locally: the function with its imports stubbed and a pretend Deno.env, then tests.ts.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="${TMPDIR:-/tmp}/push_test_$$.ts"
{
  echo '(globalThis as any).__PUSH_TEST__ = true;'
  echo '(globalThis as any).Deno = { env: { get: (_k: string) => undefined } };'
  echo 'const createClient = null as any;'
  echo 'const webpush = null as any;'
  sed -e '/^import { createClient }/d' -e '/^import webpush/d' -e 's/^export //' "$DIR/index.ts"
  cat "$DIR/tests.ts"
} > "$OUT"
cd "$DIR" && npx --yes tsx "$OUT"
rm -f "$OUT"
