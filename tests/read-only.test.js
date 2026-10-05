#!/usr/bin/env node
// Read-only modes: "Presentation mode" (PRESENT) and an owner's "View as…" (VIEW_AS_ID) must never save anything.
// Run: node tests/read-only.test.js
//
// Three layers, all read straight out of the live index.html (like business-logic.test.js), so they test the current code:
//   1. The database guard: in a read-only mode every insert / update / upsert / delete and every RPC is refused
//      before it reaches Supabase; reading still works; outside those modes everything passes through.
//   2. Every function that sends data to a server function (fetch POST) checks readOnlyReason() itself, so a new
//      one can't be added without the check (static scan).
//   3. The actions people click (notes, Log In / Log Out, breaks, replies, review requests, the My Day counters…)
//      do nothing that writes when called in a read-only mode, and show the "not saved" message where they should.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
let pass = 0, fail = 0;
function ok(cond, name, extra){ if (cond) pass++; else { fail++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); } }

// A top-level function's full text, found by name (brace matching, same idea as business-logic.test.js).
function fnText(name){
  const m = new RegExp(`(?:async\\s+)?function ${name}\\(`).exec(SRC);
  if (!m) throw new Error(`function ${name} not found in index.html`);
  let i = SRC.indexOf('{', m.index), depth = 1; i++;
  while (depth > 0) { const ch = SRC[i]; if (ch === '{') depth++; else if (ch === '}') depth--; i++; }
  return SRC.slice(m.index, i);
}

// ── 1. the database guard ──────────────────────────────────────────────────────────────────────────
function guardSandbox(){
  const calls = [];
  const builder = (table) => {
    const q = {};
    ['select','eq','gte','lte','order','limit','single','in','is','ilike','or','range'].forEach(m => { q[m] = () => q; });
    ['insert','update','upsert','delete'].forEach(m => { q[m] = (...a) => { calls.push(`${table}.${m}`); return q; }; });
    q.then = (res) => Promise.resolve({ data: [], error: null }).then(res);
    return q;
  };
  const sb = { from: (t) => builder(t), rpc: (name) => { calls.push(`rpc:${name}`); return Promise.resolve({ data: null, error: null }); } };
  const ctx = vm.createContext({ sb, calls, PRESENT: false, VIEW_AS_ID: null, Proxy, Promise });
  // `let` in the app; plain vars here so the test can switch modes.
  const block = SRC.slice(SRC.indexOf('{\n  const realFrom = sb.from.bind(sb);'), SRC.indexOf('// Dollar figures written inside text'));
  vm.runInContext(`${fnText('readOnlyReason')}\n${fnText('presentBlocked')}\n${block}`, ctx);
  return ctx;
}
async function testGuard(){
  const ctx = guardSandbox();
  const run = (code) => vm.runInContext(code, ctx);
  // normal: writes go through
  await run(`sb.from('contacts').update({ notes: 'x' }).eq('id', 1)`);
  await run(`sb.rpc('myday_merge', {})`);
  ok(ctx.calls.join() === 'contacts.update,rpc:myday_merge', 'normal mode: writes and RPCs reach the database', ctx.calls);
  for (const [mode, setup, msg] of [
    ['presentation mode', 'PRESENT = true; VIEW_AS_ID = null;', 'Presentation mode is on, changes are not saved'],
    ['View as', 'PRESENT = false; VIEW_AS_ID = "ron";', 'You are viewing as someone else, changes are not saved'],
  ]) {
    ctx.calls.length = 0;
    run(setup);
    const results = [];
    for (const w of [
      `sb.from('contacts').insert({ full_name: 'x' })`,
      `sb.from('contacts').update({ notes: 'x' }).eq('id', 1).select().single()`,
      `sb.from('sales_daily_log').upsert({ person: 'Ron' }, { onConflict: 'person,date' })`,
      `sb.from('tasks').delete().eq('id', 1)`,
      `sb.rpc('set_phone_duty', { p_on: true })`,
      `sb.rpc('myday_merge', {})`,
    ]) results.push(await run(w));
    ok(ctx.calls.length === 0, `${mode}: no insert / update / upsert / delete / RPC reaches the database`, ctx.calls);
    ok(results.every(r => r && r.data === null && r.error && r.error.message === msg), `${mode}: each refused write answers with "${msg}"`, results);
    const read = await run(`sb.from('contacts').select('*').eq('id', 1)`);
    ok(read && read.error === null, `${mode}: reading still works`);
  }
}

// ── 2. every POST to a server function checks readOnlyReason() ────────────────────────────────────
// voiceFetch only asks for the browser-phone token or plays a recording (nothing is written); it is also never
// reached in a read-only mode, because phoneWanted() is false there.
const NOT_A_WRITE = { voiceFetch: 'phone token / recording playback only' };
function enclosingFunction(idx){
  const re = /(?:async\s+)?function (\w+)\(/g; let m, name = null, at = -1;
  while ((m = re.exec(SRC)) && m.index < idx) { name = m[1]; at = m.index; }
  return { name, text: name ? fnText(name) : '' , at };
}
function testStaticScan(){
  const re = /fetch\(\s*(CONV_URL|VOICE_URL|`\$\{VOICE_URL\}|SUPABASE_URL \+ '\/functions\/v1\/)/g; let m; const seen = [];
  while ((m = re.exec(SRC))) {
    const f = enclosingFunction(m.index);
    seen.push(f.name);
    if (NOT_A_WRITE[f.name]) continue;
    ok(/readOnlyReason\(\)/.test(f.text), `${f.name}() sends data to a server function and must check readOnlyReason() first`);
  }
  ok(seen.length >= 6, 'static scan found the server calls (setMyBreak, convSend, mdCloseOldDays, mdEndOfDay, askForReview, voiceFetch)', seen);
}

// ── 3. the click actions in a read-only mode ──────────────────────────────────────────────────────
function actionSandbox(){
  const log = { toasts: [], db: [], fetch: [], nav: [] };
  const contact = { id: 'c1', fullName: 'Sarah', notes: '', phone: '0412 345 678', email: 'a@b.co' };
  const job = { id: 'j1', customerName: 'Sarah', invoiceNumber: '2400' };
  const anyDb = new Proxy({}, { get: (t, table) => new Proxy({}, { get: (t2, op) => (...a) => { log.db.push(`${String(table)}.${String(op)}`); return Promise.resolve(true); } }) });
  const ctx = {
    log, PRESENT: true, VIEW_AS_ID: null,
    showToast: (m) => log.toasts.push(m),
    db: anyDb,
    sb: { rpc: (n) => { log.db.push('rpc:' + n); return Promise.resolve({ error: null }); }, auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }) }, from: () => { throw new Error('read-only actions must not query'); } },
    fetch: (u) => { log.fetch.push(String(u)); return Promise.resolve({ json: async () => ({ ok: true }) }); },
    contactById: (id) => id === contact.id ? contact : null,
    getCurrentProfile: () => ({ id: 'ron', fullName: 'Ron', role: 'va', onDuty: true, onDutyDate: '2026-10-05' }),
    getRealProfile: () => ({ id: 'own', role: 'owner' }),
    STATE: { data: { jobs: [job], contacts: [contact], tasks: [{ id:'t1', title:'x', assignees:['Guy'] }], settings: {} }, profiles: [] },
    MD: { loaded: true, days: {}, pending: {} },
    UI: { tab: 'myDay' },
    sydneyWall: () => ({ day: '2026-10-05', hour: 10, minute: 0, dow: 'Mon' }),
    goToLeadConversation: (id) => log.nav.push(id),
    render: () => {}, renderKeepingInput: () => {}, phoneSync: () => {}, loadShiftEvents: () => {},
    logContactActivity: () => log.db.push('activity'), logSettingsActivity: () => log.db.push('activity'),
    document: { getElementById: () => null, querySelector: () => null },
    CONV_URL: 'https://x/functions/v1/conversations', SUPABASE_URL: 'https://x', SUPABASE_ANON_KEY: 'k',
    leadStage: () => 'New', chaseTooLong: () => false, isWorkday: () => true, Promise, console,
  };
  vm.createContext(ctx);
  const names = ['readOnlyReason', 'markPaymentContacted', 'setPaymentFollowup', 'markReofferDone', 'markTeamReminded', 'setLeadNotes', 'vaLogIn', 'vaLogOut', 'setMyBreak', 'convSend', 'openWhileOutItem', 'mdRecordBooking', 'mdTick', 'mdEndOfDay', 'mdCloseOldDays', 'askForReview', 'askReviewAgain', 'markReviewLeft', 'setChatAutoSms', 'setMyShift', 'storeFile', 'sendPayrollInvoice'];
  vm.runInContext(names.map(fnText).join('\n'), ctx);
  return ctx;
}
async function testActions(){
  for (const [mode, present, viewAs] of [['presentation mode', true, null], ['View as', false, 'ron']]) {
    const ctx = actionSandbox();
    ctx.PRESENT = present; ctx.VIEW_AS_ID = viewAs;
    // An action that got past its read-only check runs into the stubs and may throw: that is a failure too.
    const run = async (code) => { try { await vm.runInContext(code, ctx); } catch (e) { ok(false, `${mode}: ${code} ran past its read-only check`, String(e.message || e).slice(0, 120)); } };
    await run(`setLeadNotes('c1', 'Gate code 1234')`);
    ok(ctx.contactById('c1').notes === '', `${mode}: a customer note is not changed`);
    await run(`vaLogIn()`);
    await run(`vaLogOut()`);
    await run(`setMyBreak(true)`);
    await run(`setMyShift(true)`);
    await run(`convSend(contactById('c1'), 'sms', 'Hi', 'inbox')`);
    await run(`askForReview('j1')`);
    await run(`askReviewAgain('j1')`);
    await run(`markReviewLeft('j1')`);
    await run(`sendPayrollInvoice('salary', 'Guy', '2026-10-04')`);
    await run(`setChatAutoSms(true)`);
    await run(`mdRecordBooking(contactById('c1'))`);
    await run(`mdTick()`);
    await run(`mdEndOfDay({ signOut: false })`);
    await run(`mdCloseOldDays('2026-10-05')`);
    await run(`openWhileOutItem('c1', 'mX')`);
    await run(`markPaymentContacted('j1')`);
    await run(`setPaymentFollowup('j1', '2099-01-01')`);
    await run(`markReofferDone('j1')`);
    await run(`markTeamReminded('t1')`);
    // A receipt or invoice picked in a form is not uploaded to file storage (the sandbox has no storage: a call would throw).
    let stored = 'x';
    try { stored = await vm.runInContext(`storeFile('job1', 'parts-receipt', 'data:image/png;base64,AAAA')`, ctx); } catch (e) { stored = 'threw: ' + e.message; }
    ok(stored === null, `${mode}: a picked file is not uploaded`, stored);
    ok(ctx.log.db.length === 0, `${mode}: nothing is written (database, RPCs, activity log)`, ctx.log.db);
    ok(ctx.log.fetch.length === 0, `${mode}: no message, review request, report or status is sent`, ctx.log.fetch);
    ok(ctx.log.toasts.length >= 8 && ctx.log.toasts.every(t => /not saved/.test(t)), `${mode}: the person is told changes are not saved`, ctx.log.toasts);
    ok(ctx.log.nav.join() === 'c1', `${mode}: opening a "While you were out" item still opens the customer (reading is fine)`);
  }
}

(async () => {
  await testGuard();
  testStaticScan();
  await testActions();
  console.log(`read-only: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
