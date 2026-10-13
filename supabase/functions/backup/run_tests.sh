#!/bin/bash
# Runs the backup function tests locally: the function with its esm.sh import stubbed and a pretend Deno.env (the tests set
# test values in __BACKUP_ENV__), then tests.ts.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="${TMPDIR:-/tmp}/backup_test_$$.ts"
{
  echo '(globalThis as any).__BACKUP_TEST__ = true;'
  echo '(globalThis as any).__BACKUP_ENV__ = {} as Record<string, string>;'
  echo '(globalThis as any).Deno = { env: { get: (k: string) => (globalThis as any).__BACKUP_ENV__[k] } };'
  echo 'const createClient = null as any;'
  sed -e '/^import { createClient }/d' -e 's/^export //' "$DIR/index.ts"
  cat "$DIR/tests.ts"
} > "$OUT"
cd "$DIR" && npx --yes tsx "$OUT"
rm -f "$OUT"
