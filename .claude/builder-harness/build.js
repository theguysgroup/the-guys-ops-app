// Builds the builder harness: the REAL index.html with a fake Supabase client and a fake automations function
// (fake-sb.js), plus the write-path click-through (clickthrough.js), so Settings → Automation and the workflow builder can
// be driven in a browser without signing in. Nothing is sent anywhere (every fetch is answered by fake-sb.js).
// Run: node .claude/builder-harness/build.js → .claude/builder-harness/index.html; serve the repo root (the "local-static"
// preview: python3 -m http.server 8743) and open /.claude/builder-harness/ ; then in the console: await __wfClickThrough()
const fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
const tag = '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>';
if (!SRC.includes(tag)) throw new Error('supabase script tag not found');
if (!SRC.includes('</body>')) throw new Error('</body> not found');
const out = SRC.replace(tag, '<script src="fake-sb.js"></script>').replace('<head>', '<head><base href="/.claude/builder-harness/">')
  .replace(/<\/body>(?![\s\S]*<\/body>)/, '<script src="clickthrough.js"></script>\n</body>');
fs.writeFileSync(path.join(__dirname, 'index.html'), out);
console.log('builder harness built');
