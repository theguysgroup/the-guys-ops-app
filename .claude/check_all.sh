#!/bin/bash
# Runs every local check: app business-logic tests, read-only tests, inline-script syntax, and the tests of each edge function.
cd "$(dirname "$0")/.." || exit 1
set -o pipefail   # a failing test fails the whole script, even through `tail`
fail=0
node tests/business-logic.test.js 2>&1 | tail -2 || fail=1
node tests/read-only.test.js 2>&1 | tail -1 || fail=1
python3 - <<'PY' || fail=1
import re,subprocess,sys,tempfile
bad=0
for f in ['index.html','sign.html']:
    s=open(f).read()
    js='\n;\n'.join(re.findall(r'<script(?![^>]*src)[^>]*>(.*?)</script>',s,re.S))
    t=tempfile.NamedTemporaryFile('w',suffix='.js',delete=False); t.write(js); t.close()
    r=subprocess.run(['node','--check',t.name],capture_output=True,text=True)
    print(f,'syntax','OK' if r.returncode==0 else 'FAIL '+r.stderr[:600]); bad|=r.returncode!=0
sys.exit(1 if bad else 0)
PY
for fn in supabase/functions/*/; do [ -f "$fn/run_tests.sh" ] && { bash "$fn/run_tests.sh" 2>&1 | tail -1 || { echo "FAILED: $fn"; fail=1; }; }; done
[ $fail -eq 0 ] && echo "ALL GREEN" || echo "SOMETHING FAILED"
exit $fail
