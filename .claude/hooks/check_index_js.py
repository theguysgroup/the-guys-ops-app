#!/usr/bin/env python3
"""Best-effort JS sanity check for <script> blocks inside index.html.

No JS engine is installed on this machine (no node/npx/deno), so this is
NOT a real parser. It tracks bracket/paren/brace nesting, string
termination, regex-vs-division, and (nested) template literals with
${...} interpolation, ignoring comments. Good enough to catch the #1 way
a hand-edit silently breaks a single giant HTML file: a deleted/extra
{, (, [ or an unterminated string/template. It will miss real syntax
errors (bad operators, typos in keywords, etc) and can still misjudge a
rare division-vs-regex case.

Stack-based design: a single stack of frames drives both bracket matching
and template-literal mode. A frame is (kind, line) where kind is one of
'(' '{' '[' '`' '${'. We're in "template raw text" mode iff the top frame
is '`'; otherwise we're in normal code mode. Entering a `${` inside a
template pushes a '${' frame (closed by the next matching '}', which
pops back to raw-text mode automatically since the frame below it is the
enclosing '`'). This naturally handles nested templates.
"""
import re
import sys

OPEN_FOR_CLOSE = {")": "(", "}": ("{", "${"), "]": "["}
_VALUE_END_CHARS = set(")]`")
_IDENT_CHAR_RE = re.compile(r"[A-Za-z0-9_$]")


def check_block(code, block_start_line):
    stack = []  # list of (kind, line)
    i = 0
    n = len(code)
    line = block_start_line
    comment_state = None  # None | "line" | "block"
    last_significant = ""
    errors = []

    def in_template():
        return bool(stack) and stack[-1][0] == "`"

    while i < n:
        c = code[i]
        nxt = code[i + 1] if i + 1 < n else ""

        if c == "\n":
            line += 1

        if comment_state == "line":
            if c == "\n":
                comment_state = None
            i += 1
            continue
        if comment_state == "block":
            if c == "*" and nxt == "/":
                comment_state = None
                i += 2
                continue
            i += 1
            continue

        if in_template():
            if c == "\\":
                i += 2
                continue
            if c == "`":
                stack.pop()
                last_significant = "`"
                i += 1
                continue
            if c == "$" and nxt == "{":
                stack.append(("${", line))
                last_significant = ""
                i += 2
                continue
            i += 1
            continue

        # --- code mode below ---
        if c == "/" and nxt == "/":
            comment_state = "line"
            i += 2
            continue
        if c == "/" and nxt == "*":
            comment_state = "block"
            i += 2
            continue
        if c == "/":
            is_division = last_significant and (
                _IDENT_CHAR_RE.match(last_significant) or last_significant in _VALUE_END_CHARS
            )
            if is_division:
                last_significant = c
                i += 1
                continue
            # regex literal
            i += 1
            while i < n:
                rc = code[i]
                if rc == "\\":
                    i += 2
                    continue
                if rc == "[":
                    j = i + 1
                    while j < n and code[j] != "]":
                        if code[j] == "\\":
                            j += 1
                        j += 1
                    i = j + 1
                    continue
                if rc == "/":
                    i += 1
                    while i < n and code[i].isalpha():
                        i += 1
                    break
                if rc == "\n":
                    errors.append(f"line {line}: '/' looked like a regex start but never closed before end of line")
                    break
                i += 1
            last_significant = "/"
            continue
        if c in ("'", '"'):
            quote = c
            start_line = line
            j = i + 1
            closed = False
            while j < n:
                jc = code[j]
                if jc == "\\":
                    j += 2
                    continue
                if jc == "\n":
                    break
                if jc == quote:
                    closed = True
                    j += 1
                    break
                j += 1
            if not closed:
                errors.append(f"line {start_line}: unterminated string (newline inside {quote}...{quote})")
            line += code[i:j].count("\n")
            i = j
            last_significant = quote
            continue
        if c == "`":
            stack.append(("`", line))
            last_significant = ""
            i += 1
            continue
        if c in ("(", "{", "["):
            stack.append((c, line))
            last_significant = c
            i += 1
            continue
        if c in (")", "}", "]"):
            expected = OPEN_FOR_CLOSE[c]
            expected_set = expected if isinstance(expected, tuple) else (expected,)
            if not stack:
                errors.append(f"line {line}: unexpected '{c}' with nothing open")
            else:
                top, topline = stack[-1]
                if top in expected_set:
                    stack.pop()
                else:
                    errors.append(
                        f"line {line}: found '{c}' but '{top}' opened on line {topline} is still unclosed"
                    )
            last_significant = c
            i += 1
            continue
        if not c.isspace():
            last_significant = c
        i += 1

    if in_template():
        _, opened_line = stack[-1]
        errors.append(f"line {opened_line}: template literal (`) is never closed")

    for kind, opened_line in stack:
        if kind != "`":
            errors.append(f"line {opened_line}: '{kind}' is never closed")

    return errors


def main():
    if len(sys.argv) != 2:
        print("usage: check_index_js.py <html-file>", file=sys.stderr)
        return 2

    path = sys.argv[1]
    try:
        with open(path, "r", encoding="utf-8") as f:
            html = f.read()
    except OSError as e:
        print(f"could not read {path}: {e}", file=sys.stderr)
        return 0  # don't block on read errors (e.g. file deleted)

    script_re = re.compile(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", re.IGNORECASE | re.DOTALL)

    all_errors = []
    for m in script_re.finditer(html):
        code = m.group(1)
        if not code.strip():
            continue
        start_line = html.count("\n", 0, m.start(1)) + 1
        all_errors.extend(check_block(code, start_line))

    if all_errors:
        print(f"Possible JS breakage in {path}:")
        for e in all_errors[:20]:
            print(f"  - {e}")
        if len(all_errors) > 20:
            print(f"  ... and {len(all_errors) - 20} more")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
