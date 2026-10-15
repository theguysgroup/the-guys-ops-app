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
  const re = /fetch\(\s*(CONV_URL|VOICE_URL|PASSKEY_URL|BACKUP_URL|AUTOMATIONS_URL|MCP_URL|`\$\{VOICE_URL\}|SUPABASE_URL \+ '\/functions\/v1\/)/g; let m; const seen = [];
  while ((m = re.exec(SRC))) {
    const f = enclosingFunction(m.index);
    seen.push(f.name);
    if (NOT_A_WRITE[f.name]) continue;
    ok(/readOnlyReason\(\)/.test(f.text), `${f.name}() sends data to a server function and must check readOnlyReason() first`);
  }
  ok(seen.length >= 7 && seen.includes('passkeyCall'), 'static scan found the server calls (setMyBreak, convSend, mdCloseOldDays, mdEndOfDay, askForReview, voiceFetch, passkeyCall)', seen);
  ok(seen.includes('backupFetch') && seen.includes('downloadFullBackup'), 'static scan found the backup function calls (backupFetch, downloadFullBackup)', seen);
  ok(seen.includes('automationEvent'), 'static scan found the automation engine\'s "look now" (automationEvent)', seen);
  ok(seen.includes('mcpCall'), 'static scan found the private connector\'s server calls (mcpCall)', seen);
  // Business details (14 Oct): the insurance certificate upload and the week-start change stop in a read-only mode.
  ok(['pickBusinessCertificate', 'setWeekStart'].every(n => /readOnlyReason\(\)/.test(fnText(n))), 'business certificate upload and week start check read-only mode');
  // Drag & drop (round 3, T1.1): a dropped file goes through the same upload functions as a picked one; each checks the mode.
  const dropUploads = ['pickBusinessCertificate', 'setWeekStart', 'uploadContractorCertificate', 'uploadBrandLogoFile', 'uploadEmployeeDoc', 'uploadBusinessCertificate'];
  ok(dropUploads.every(n => /readOnlyReason\(\)/.test(fnText(n))), 'every upload a dropped file reaches checks read-only mode', dropUploads.filter(n => !/readOnlyReason\(\)/.test(fnText(n))));
}

// Drag & drop (round 3, T1.1): a certificate or logo dropped in a read-only mode is not read, stored or uploaded.
async function testDropUploadsReadOnly(){
  for (const [mode, present, viewAs] of [['presentation mode', true, null], ['View as', false, 'ron']]) {
    const log = { toasts: [], touched: [] };
    const ctx = { PRESENT: present, VIEW_AS_ID: viewAs, MAX_FILE_MB: 20, console,
      showToast: (m) => log.toasts.push(m), render: () => log.touched.push('render'),
      FileReader: function(){ log.touched.push('FileReader'); this.readAsDataURL = () => {}; },
      storeFile: async () => { log.touched.push('storeFile'); return 'sb:x'; },
      sb: { storage: { from: () => { log.touched.push('sb.storage'); return { upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: 'x' } }) }; } } },
      setBranding: () => log.touched.push('setBranding'),
      db: { suppliers: { update: () => log.touched.push('suppliers.update') } },
      STATE: { data: { suppliers: [{ id: 'c1', insurance: {} }] } } };
    vm.createContext(ctx);
    vm.runInContext(['readOnlyReason', 'uploadContractorCertificate', 'uploadBrandLogoFile'].map(fnText).join('\n'), ctx);
    vm.runInContext(`uploadContractorCertificate('c1', { size: 1, name: 'a.pdf', type: 'application/pdf' })`, ctx);
    await vm.runInContext(`uploadBrandLogoFile({ size: 1, name: 'a.png', type: 'image/png' })`, ctx);
    ok(log.touched.length === 0, `${mode}: a dropped certificate or logo is not read, stored or uploaded`, log.touched);
    ok(log.toasts.length === 2 && log.toasts.every(t => /not saved/.test(t)), `${mode}: the person is told it is not saved`, log.toasts);
  }
}

// ── 3. the click actions in a read-only mode ──────────────────────────────────────────────────────
function actionSandbox(){
  const log = { toasts: [], db: [], fetch: [], nav: [] };
  const contact = { id: 'c1', fullName: 'Sarah', notes: '', customerNotes: [{ id: 'n1', text: 'Gate code 1234', by: 'Ofek', at: '2026-10-10T01:00:00.000Z' }], phone: '0412 345 678', email: 'a@b.co' };
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
    bizWall: () => ({ day: '2026-10-05', hour: 10, minute: 0, dow: 'Mon' }), todayStr: () => '2026-10-05',
    goToLeadConversation: (id) => log.nav.push(id),
    render: () => {}, renderKeepingInput: () => {}, phoneSync: () => {}, loadShiftEvents: () => {},
    logContactActivity: () => log.db.push('activity'), logSettingsActivity: () => log.db.push('activity'),
    document: { getElementById: () => null, querySelector: () => null },
    CONV_URL: 'https://x/functions/v1/conversations', SUPABASE_URL: 'https://x', SUPABASE_ANON_KEY: 'k',
    leadStage: () => 'New', chaseTooLong: () => false, isWorkday: () => true, Promise, console,
    // Settings → Pipeline stages: reaching any of these means the read-only check was skipped.
    catalogList: () => { log.db.push('opened'); return []; }, stageIsBuiltin: () => { log.db.push('opened'); return true; }, openStageRemove: () => log.db.push('opened'),
    // Settings → Connectors: reaching any of these means the read-only check was skipped (closing a window is fine).
    catalogObject: () => { log.db.push('opened'); return {}; }, openModal: () => log.db.push('opened'), closeModal: () => {}, closePopup: () => {},
    // Services, People and Pipeline (round 3, D-settings): reaching any of these means the read-only check was skipped.
    openPopup: () => log.db.push('opened'), confirmAction: () => log.db.push('opened'), catalogSave: () => log.db.push('opened'),
  };
  vm.createContext(ctx);
  const names = ['readOnlyReason', 'markPaymentContacted', 'setPaymentFollowup', 'markReofferDone', 'markTeamReminded', 'leadNotes', 'addLeadNote', 'deleteLeadNote', 'vaLogIn', 'vaLogOut', 'setMyBreak', 'convSend', 'openWhileOutItem', 'mdRecordBooking', 'mdTick', 'mdEndOfDay', 'mdCloseOldDays', 'askForReview', 'askReviewAgain', 'markReviewLeft', 'setChatAutoSms', 'setMyShift', 'toggleMyPhoneAvailable', 'storeFile', 'savePayrollInvoice', 'deleteLostReason', 'moveStageLeads', 'setStageActive', 'removeStage', 'setVaShiftTime',
    // Settings → People (14 Oct): pages, pay and role defaults
    'togglePermission', 'resetPersonPages', 'setOwnerSalary', 'updateCommissionRateFromSettings', 'setTechJobType', 'setPayHebrew', 'setPayHebrewName', 'savePeopleHourly', 'applyRoleToPeople', 'setRolePage',
    // Names and labels (round 3, C-names): the office's name, a person's colour / report name, who gets the cash
    'setOfficeLabel', 'setPersonSetting', 'setPayCashTo',
    // Deleting services, People details in place, Pipeline columns (round 3, D-settings)
    'openServiceDelete', 'confirmServiceDelete', 'moveServiceRecords', 'restoreService', 'setEmployeeName', 'renameEmployee', 'setEmployeeRole', 'addEmployeeCard', 'moveStage',
    // Settings → Connectors (14 Oct): every switch, Disconnect / Remove, the add-ons and a new connected source
    'connToggleItem', 'connItemOff', 'connToggleAccount', 'connAccountOff', 'connToggleAuto', 'openConnDisconnect', 'openConnRemove', 'connOpenStopWindow', 'connDisconnect', 'connReconnect', 'connRemove', 'connAddonConnect', 'connGbpSent', 'connAddConnectedSource',
    // Settings > Connectors > Private connector (MCP), stage 5: every change, and the server call itself
    'mcpCall', 'mcpCreateKey', 'mcpRevokeKey', 'mcpRevokeNow', 'mcpSetSetting', 'mcpEditServer', 'mcpSaveServer', 'mcpDeleteServer', 'mcpDeleteServerNow', 'mcpTestServer', 'mcpOpenRunTool', 'mcpRunTool',
    'mcpEditRule', 'mcpRuleSample', 'mcpSaveRule', 'mcpToggleRule', 'mcpDeleteRule', 'mcpDeleteRuleNow', 'mcpPreview', 'mcpCommit', 'mcpUndo', 'mcpUndoNow'];
  vm.runInContext(names.map(fnText).join('\n'), ctx);
  return ctx;
}
async function testActions(){
  for (const [mode, present, viewAs] of [['presentation mode', true, null], ['View as', false, 'ron']]) {
    const ctx = actionSandbox();
    ctx.PRESENT = present; ctx.VIEW_AS_ID = viewAs;
    // An action that got past its read-only check runs into the stubs and may throw: that is a failure too.
    const run = async (code) => { try { await vm.runInContext(code, ctx); } catch (e) { ok(false, `${mode}: ${code} ran past its read-only check`, String(e.message || e).slice(0, 120)); } };
    await run(`addLeadNote('c1', 'inbox')`);
    await run(`deleteLeadNote('c1', 'n1')`);
    ok(ctx.contactById('c1').notes === '' && JSON.stringify(ctx.contactById('c1').customerNotes) === '[{"id":"n1","text":"Gate code 1234","by":"Ofek","at":"2026-10-10T01:00:00.000Z"}]', `${mode}: customer notes are not added or deleted`);
    await run(`vaLogIn()`);
    await run(`vaLogOut()`);
    await run(`setMyBreak(true)`);
    await run(`setMyShift(true)`);
    await run(`toggleMyPhoneAvailable()`);
    await run(`convSend(contactById('c1'), 'sms', 'Hi', 'inbox')`);
    await run(`askForReview('j1')`);
    await run(`askReviewAgain('j1')`);
    await run(`markReviewLeft('j1')`);
    await run(`savePayrollInvoice('salary', 'Guy', '2026-10-04')`);
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
    await run(`deleteLostReason('spam')`);
    let moved = 'x';
    try { moved = await vm.runInContext(`moveStageLeads('sx1', 'Lost', { lostReason: 'spam' }, 'delete')`, ctx); } catch (e) { moved = 'threw: ' + e.message; }
    ok(moved === false, `${mode}: moving a stage's leads in Settings stops before any save`, moved);
    await run(`setStageActive('Quoted', false)`);
    await run(`removeStage('sx1')`);
    await run(`setVaShiftTime('ron', 'logoutAt', '21:00')`);
    // Settings → People: every change checks the mode before it touches anything (these fixtures would throw past it).
    const before = ctx.log.toasts.length;
    await run(`togglePermission('p1', 'crm', true)`);
    await run(`resetPersonPages('p1')`);
    await run(`setOwnerSalary('Ofek', '1300')`);
    await run(`updateCommissionRateFromSettings('Guy', 'Aircon', '30')`);
    await run(`setTechJobType('Guy', 'Aircon', false)`);
    await run(`setPayHebrew('Guy', true)`);
    await run(`setPayHebrewName('Guy', 'גיא')`);
    await run(`applyRoleToPeople('va')`);
    await run(`setRolePage('va', 'crm', true)`);
    await run(`setOfficeLabel('Reception')`);
    await run(`setPersonSetting('Guy', 'color', 'person-1')`);
    await run(`setPayCashTo('Ofek')`);
    let savedHourly = 'x';
    try { savedHourly = await vm.runInContext(`savePeopleHourly()`, ctx); } catch (e) { savedHourly = 'threw: ' + e.message; }
    ok(savedHourly === false, `${mode}: an hourly pay change is not saved`, savedHourly);
    ok(ctx.log.toasts.length - before === 13, `${mode}: each People change says it is not saved`, ctx.log.toasts.slice(before));
    ok(ctx.STATE.data.commissionRates === undefined && ctx.STATE.data.settings.ownerSalaries === undefined, `${mode}: no rate or salary is changed on screen either`);
    // Services, People and Pipeline (round 3, D-settings): nothing is deleted, moved, restored, renamed, added or reordered.
    const beforeD = ctx.log.toasts.length;
    let movedSvc = 'x';
    try { movedSvc = await vm.runInContext(`moveServiceRecords('Chimney', 'Aircon')`, ctx); } catch (e) { movedSvc = 'threw: ' + e.message; }
    ok(movedSvc === false, `${mode}: moving a deleted service's leads and jobs stops before any save`, movedSvc);
    await run(`openServiceDelete('Chimney')`);
    await run(`confirmServiceDelete('Chimney')`);
    await run(`restoreService('Chimney')`);
    await run(`setEmployeeName('e1', 'New name')`);
    await run(`renameEmployee('e1', 'New name')`);
    await run(`setEmployeeRole('e1', 'Owner', true)`);
    await run(`addEmployeeCard('p1')`);
    await run(`moveStage('Quoted', 1)`);
    ok(ctx.log.toasts.length - beforeD === 9 && ctx.log.toasts.slice(beforeD).every(t => /not saved/.test(t)), `${mode}: each Services, People and Pipeline change says it is not saved`, ctx.log.toasts.slice(beforeD));
    // Settings → Connectors (14 Oct): nothing is switched, disconnected, removed or added, and no window opens.
    const beforeConn = ctx.log.toasts.length;
    await run(`var connEv = { prevented: 0, preventDefault(){ this.prevented++; } }`);
    await run(`connToggleItem('gads', 'stats')`);
    await run(`connItemOff('gads', 'stats')`);
    await run(`connToggleAccount(connEv, 'gads', '6569440597')`);
    await run(`connToggleAccount(connEv, 'meta', '*')`);
    await run(`connAccountOff('gads', '6569440597')`);
    await run(`connToggleAuto('xero', 'inv')`);
    await run(`openConnDisconnect('gads')`);
    await run(`openConnRemove('xero')`);
    await run(`connDisconnect('gads')`);
    await run(`connReconnect('gads')`);
    await run(`connRemove('xero')`);
    await run(`connAddonConnect('chatgpt')`);
    await run(`connGbpSent()`);
    await run(`connAddConnectedSource('ChatGPT')`);
    ok(vm.runInContext('connEv.prevented', ctx) === 2, `${mode}: an account tickbox clicked in a read-only mode stays as it was`);
    ok(ctx.log.toasts.length - beforeConn === 14 && ctx.log.toasts.slice(beforeConn).every(t => /not saved/.test(t)), `${mode}: each Connectors change says it is not saved`, ctx.log.toasts.slice(beforeConn));
    // Settings > Connectors > Private connector (MCP): no key, setting, permission, server, import or undo reaches the server.
    const beforeMcp = ctx.log.toasts.length;
    for (const c of [`mcpCreateKey()`, `mcpRevokeKey('k1')`, `mcpRevokeNow('k1')`, `mcpSetSetting('rateLimitPerMin', '30')`, `mcpEditServer('s1')`, `mcpSaveServer()`, `mcpDeleteServer('s1')`,
      `mcpDeleteServerNow('s1')`, `mcpTestServer('s1')`, `mcpOpenRunTool('s1')`, `mcpRunTool('s1')`, `mcpEditRule('s1', 'r1')`, `mcpRuleSample()`, `mcpSaveRule()`, `mcpToggleRule('r1', false)`, `mcpDeleteRule('r1')`,
      `mcpDeleteRuleNow('r1')`, `mcpPreview('r1')`, `mcpCommit('r1')`, `mcpUndo('u1')`, `mcpUndoNow('u1')`]) await run(c);
    let mcpRefused = '';
    try { await vm.runInContext(`mcpCall('create_token', { name: 'x' })`, ctx); } catch (e) { mcpRefused = String(e.message || e); }
    ok(/not saved/.test(mcpRefused), `${mode}: mcpCall itself refuses to send`, mcpRefused);
    ok(ctx.log.toasts.length - beforeMcp === 21 && ctx.log.toasts.slice(beforeMcp).every(t => /not saved/.test(t)), `${mode}: each private connector change says it is not saved`, ctx.log.toasts.slice(beforeMcp));
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

// Look and branding and the colour picker (14 Oct): a colour picked in a read-only mode is not saved, and a colour being
// tried on screen is dropped (the save guard is catalogSave's; this pins it for the new setters).
function brandingSandbox(present){
  const log = { toasts: [], db: [], applied: 0 };
  const ctx = {
    log, PRESENT: present, VIEW_AS_ID: null, JSON,
    showToast: (m) => log.toasts.push(m), render: () => {}, applyCatalog: () => {}, applyBranding: () => { log.applied++; },
    logSettingsActivity: (who, what) => log.db.push('activity: ' + what), getCurrentProfile: () => ({ fullName: 'Ofek' }),
    db: { settings: { update: (patch) => { log.db.push('settings.update'); ctx.STATE.data.settings.catalog = patch.catalog; return Promise.resolve(true); } } },
    STATE: { data: { settings: { catalog: { branding: { color: '' }, tags: [{ tag: 'Complaint', hint: '', color: '#A5473F', active: true }] } } } },
  };
  ctx.catalogList = (section) => JSON.parse(JSON.stringify(ctx.STATE.data.settings.catalog[section] || []));
  vm.createContext(ctx);
  const consts = ['BRAND_ORIGINAL', 'BRAND_MARK', 'THEME_OPTS', 'CAT_NAMES'].map(n => SRC.match(new RegExp(`const ${n} = [^\\n]+`))[0]).join('\n');
  vm.runInContext(`var BRAND_PREVIEW = { bg: '#000000' };\n${consts}\n` + ['readOnlyReason', 'normHex', 'catalogObject', 'catalogId', 'catalogSave', 'setCatalogField', 'setBranding'].map(fnText).join('\n'), ctx);
  return ctx;
}
function testBrandingReadOnly(){
  const ro = brandingSandbox(true);
  vm.runInContext(`setBranding('bg', '#5b6b82'); setCatalogField('tags', 'Complaint', 'color', '#1f66c9');`, ro);
  ok(ro.log.db.length === 0, 'presentation mode: a background colour or a tag colour is not saved', ro.log.db);
  ok(ro.log.toasts.length === 2 && ro.log.toasts.every(t => /not saved/.test(t)), 'presentation mode: each colour change says it is not saved', ro.log.toasts);
  ok(JSON.stringify(vm.runInContext('BRAND_PREVIEW', ro)) === '{}' && ro.log.applied === 1, 'presentation mode: a colour being tried is dropped and the saved colours are put back', ro.log.applied);
  ok(ro.STATE.data.settings.catalog.tags[0].color === '#A5473F' && ro.STATE.data.settings.catalog.branding.bg === undefined, 'presentation mode: nothing changes on screen either');
  const rw = brandingSandbox(false);
  vm.runInContext(`setCatalogField('tags', 'Complaint', 'color', '#a5473f'); setBranding('color', '#C31F2B');`, rw);
  ok(rw.log.db.length === 0, 'the same colour written another way (or the original crimson) is not saved again', rw.log.db);
  vm.runInContext(`setCatalogField('tags', 'Complaint', 'color', '#1F66C9'); setBranding('bg', '5B6B82');`, rw);
  const cat = rw.STATE.data.settings.catalog;
  ok(cat.tags[0].color === '#1f66c9' && cat.branding.bg === '#5b6b82' && rw.log.db.filter(x => x === 'settings.update').length === 2, 'normal mode: a new colour is saved as a clean lowercase code', cat);
  ok(rw.log.db.includes('activity: Look and branding: background colour #5b6b82'), 'normal mode: the settings history names the change', rw.log.db);
}

// Settings → Security (14 Oct): setting up Face ID / fingerprint is a change, so it is refused in a read-only mode; the unlock
// itself (status, password, Face ID, Google, lock) must still work there, so the owner can open Security to turn Presentation
// mode off. Removing a key is refused before anything is asked.
async function testSecurityReadOnly(){
  for (const [mode, present, viewAs] of [['presentation mode', true, null], ['View as', false, 'ron']]) {
    const log = { fetch: [], toasts: [], db: [] };
    const ctx = {
      log, PRESENT: present, VIEW_AS_ID: viewAs, JSON, Promise, Date,
      PASSKEY_URL: 'https://x/functions/v1/passkey', SUPABASE_ANON_KEY: 'k',
      sb: { auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }) }, from: () => { log.db.push('from'); throw new Error('no database in a read-only mode'); } },
      fetch: (u, o) => { log.fetch.push(JSON.parse(o.body).action); return Promise.resolve({ status: 200, ok: true, json: async () => ({ ok: true }) }); },
      showToast: (m) => log.toasts.push(m),
      SEC: { keys: [{ id: 'k1', credential_id: 'c1', device_name: "Ofek's Mac" }], regOpts: { options: { challenge: 'AQID' }, at: Date.now() }, until: Date.now() + 60e3 },
      navigator: { credentials: { create: () => { log.db.push('create'); return Promise.resolve({}); }, get: () => { log.db.push('get'); return Promise.resolve({}); } }, userAgent: 'x', maxTouchPoints: 0 },
      openModal: () => log.db.push('opened'), confirmAction: () => log.db.push('confirm'), modalError: () => {}, closeModal: () => {}, render: () => {},
      document: { getElementById: () => null, body: { contains: () => false } },
    };
    vm.createContext(ctx);
    vm.runInContext(['readOnlyReason', 'passkeyCall', 'openPasskeySetup', 'secRegisterPasskey', 'removePasskey'].map(fnText).join('\n'), ctx);
    const msg = vm.runInContext('readOnlyReason()', ctx);
    for (const a of ['reg-options', 'reg-verify']) {
      let err = '';
      try { await vm.runInContext(`passkeyCall({ action: '${a}' })`, ctx); } catch (e) { err = String(e.message); }
      ok(err === msg, `${mode}: passkeyCall('${a}') is refused with the read-only message`, err);
    }
    ok(log.fetch.length === 0, `${mode}: setting up a key never reaches the server`, log.fetch);
    for (const a of ['status', 'password', 'auth-options', 'auth-verify', 'google', 'lock']) await vm.runInContext(`passkeyCall({ action: '${a}' })`, ctx);
    ok(log.fetch.join() === 'status,password,auth-options,auth-verify,google,lock', `${mode}: the unlock still works (so Presentation mode can be turned off)`, log.fetch);
    log.fetch.length = 0;
    await vm.runInContext(`openPasskeySetup()`, ctx);
    await vm.runInContext(`secRegisterPasskey()`, ctx);
    await vm.runInContext(`removePasskey('k1')`, ctx);
    ok(log.db.length === 0 && log.fetch.length === 0, `${mode}: no set-up window, no new key, no removal`, [log.db, log.fetch]);
    ok(log.toasts.length === 3 && log.toasts.every(t => t === msg), `${mode}: each one says changes are not saved`, log.toasts);
  }
  ok(/readOnlyReason\(\)/.test(fnText('passkeyCall')), 'passkeyCall checks readOnlyReason()');
  ok(/return secUnlocked\(\) \? renderSecurityUnlocked\(\) : renderSecurityLock\('page'\);/.test(fnText('renderSecurityPage')), 'Security draws its unlocked page only when this session is unlocked');
}

// Settings → Data (14 Oct): the weekly backup's address, day and time and "Download full backup" do nothing in a read-only
// mode: no step-up window, no server call, no database write; the person is told.
async function testBackupReadOnly(){
  for (const [mode, present, viewAs] of [['presentation mode', true, null], ['View as', false, 'ron']]) {
    const log = { fetch: [], toasts: [], db: [], lock: 0 };
    const ctx = {
      log, PRESENT: present, VIEW_AS_ID: viewAs, JSON, Promise, Date, Number, String,
      BACKUP_URL: 'https://x/functions/v1/backup', SUPABASE_ANON_KEY: 'k', DAY_NAMES: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
      BACKUP_ST: { ok: true, config: { email: 'info@theguyservicegroup.com', day: 0, time: '03:00' } },
      sb: { auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }) }, from: () => { log.db.push('from'); throw new Error('no database in a read-only mode'); } },
      db: new Proxy({}, { get: () => { log.db.push('db'); throw new Error('no database in a read-only mode'); } }),
      fetch: (u, o) => { log.fetch.push(String(u)); return Promise.resolve({ status: 200, ok: true, json: async () => ({ ok: true }), text: async () => '{}' }); },
      showToast: (m) => log.toasts.push(m), render: () => {}, logSettingsActivity: () => log.db.push('activity'),
      secEnsureUnlocked: () => { log.lock++; }, openPopup: () => { log.lock++; },
    };
    vm.createContext(ctx);
    vm.runInContext(['readOnlyReason', 'backupEmailOk', 'backupFetch', 'backupWithStepUp', 'backupConfigDone', 'saveBackupEmail', 'saveBackupWhen', 'downloadFullBackup'].map(fnText).join('\n'), ctx);
    const msg = vm.runInContext('readOnlyReason()', ctx);
    await vm.runInContext(`saveBackupEmail('someone@else.com')`, ctx);
    await vm.runInContext(`saveBackupWhen('day', '3')`, ctx);
    await vm.runInContext(`saveBackupWhen('time', '23:30')`, ctx);
    await vm.runInContext(`downloadFullBackup()`, ctx);
    const r = await vm.runInContext(`backupFetch({ step: 'config', day: 2 })`, ctx);
    ok(log.fetch.length === 0 && log.db.length === 0 && log.lock === 0, `${mode}: no backup change or download reaches the server, the database or the Security lock`, log);
    ok(r && r.ok === false && r.reason === msg, `${mode}: backupFetch refuses a change with the read-only message`, r);
    const want = [msg, msg, msg, present ? 'Exports are off in presentation mode' : msg];
    ok(JSON.stringify(log.toasts) === JSON.stringify(want), `${mode}: each one says so`, log.toasts);
    ok(vm.runInContext('BACKUP_ST.config.email', ctx) === 'info@theguyservicegroup.com', `${mode}: the address on screen is unchanged`);
    await vm.runInContext(`backupFetch({ step: 'status' })`, ctx);
    ok(log.fetch.length === 1, `${mode}: reading the status still works (it changes nothing)`, log.fetch);
  }
}

// Settings → Data → Export to Excel (14 Oct): in a read-only mode the sensitive tick and the Excel download do nothing: no
// Face ID window, no SheetJS, no database read or write, no server call; ticking areas still works (it saves nothing).
// Outside those modes the sensitive tick asks for the step-up first and stays unticked until it says yes.
function constText(name){
  const at = SRC.search(new RegExp(`\\bconst ${name}\\s*=`));
  if (at === -1) throw new Error(`const ${name} not found in index.html`);
  let i = at, depth = 0;
  for (; i < SRC.length; i++) { const c = SRC[i]; if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--; else if (c === ';' && depth === 0) { i++; break; } }
  return SRC.slice(at, i);
}
function exportSandbox(present, viewAs, unlocked){
  const log = { fetch: [], toasts: [], db: [], lock: [], xlsx: 0, renders: 0 };
  const ctx = {
    log, PRESENT: present, VIEW_AS_ID: viewAs, Promise, Set,
    sb: { from: (t) => { log.db.push('from:' + t); throw new Error('no database in a read-only mode'); }, rpc: (n) => { log.db.push('rpc:' + n); } },
    db: new Proxy({}, { get: () => { log.db.push('db'); throw new Error('no database in a read-only mode'); } }),
    fetch: (u) => { log.fetch.push(String(u)); return Promise.resolve({ ok: true, json: async () => ({}) }); },
    showToast: (m) => log.toasts.push(m), render: () => { log.renders++; }, logSettingsActivity: () => log.db.push('activity'),
    secUnlocked: () => unlocked, secEnsureUnlocked: (why, then) => { log.lock.push({ why, then }); },
    ensureXlsx: () => { log.xlsx++; return Promise.reject(new Error('SheetJS must not load here')); },
    UI: { tab: 'settings', settings: { page: 'data', open: true } }, settingsPageKey: (k) => k,
    document: { getElementById: () => null }, console,
  };
  vm.createContext(ctx);
  vm.runInContext([constText('EXPORT_AREAS'), 'var DATA_EXPORT = { sel: null, sens: false, busy: false, step: \'\', counts: null, countsBusy: false };',
    ...['readOnlyReason', 'exportDefaultSelection', 'dataExportSel', 'dataPageOpen', 'setExportArea', 'setExportAll', 'setExportSensitive', 'dataExportProgress', 'downloadDataExcel'].map(fnText)].join('\n'), ctx);
  return ctx;
}
async function testExportReadOnly(){
  for (const [mode, present, viewAs] of [['presentation mode', true, null], ['View as', false, 'ron']]) {
    const ctx = exportSandbox(present, viewAs, true), log = ctx.log, msg = vm.runInContext('readOnlyReason()', ctx);
    const want = present ? 'Exports are off in presentation mode' : msg;
    await vm.runInContext(`setExportSensitive(true)`, ctx);
    ok(vm.runInContext('DATA_EXPORT.sens', ctx) === false, `${mode}: the sensitive tick stays off`);
    await vm.runInContext(`downloadDataExcel()`, ctx);
    await vm.runInContext(`DATA_EXPORT.sens = true; downloadDataExcel()`, ctx);
    ok(log.db.length === 0 && log.fetch.length === 0 && log.lock.length === 0 && log.xlsx === 0, `${mode}: no database, no server call, no Face ID window, no SheetJS`, log);
    ok(JSON.stringify(log.toasts) === JSON.stringify([want, want, want]), `${mode}: each one says why ("${want}")`, log.toasts);
    vm.runInContext(`setExportAll(false); setExportArea('jobs', true); setExportArea('ghl', true)`, ctx);
    ok(vm.runInContext('[...dataExportSel()].join()', ctx) === 'jobs,ghl' && log.db.length === 0, `${mode}: ticking areas still works and saves nothing`);
    vm.runInContext(`setExportAll(true)`, ctx);
    ok(vm.runInContext('dataExportSel().size', ctx) === 15, `${mode}: Select all ticks the 15 areas`);
  }
  // Normal mode, Security locked: the tick asks for the step-up and stays off until it says yes; cancelled = off.
  const ctx = exportSandbox(false, null, false), log = ctx.log;
  await vm.runInContext(`setExportSensitive(true)`, ctx);
  ok(log.lock.length === 1 && log.lock[0].why === 'Include sensitive details in the Excel' && vm.runInContext('DATA_EXPORT.sens', ctx) === false, 'the sensitive tick asks for Face ID / the password first and stays off meanwhile', log.lock.map(x => x.why));
  log.lock[0].then();
  ok(vm.runInContext('DATA_EXPORT.sens', ctx) === true, 'after the step-up the sensitive tick is on');
  await vm.runInContext(`downloadDataExcel()`, ctx);
  ok(log.lock.length === 2 && log.xlsx === 0 && vm.runInContext('DATA_EXPORT.sens', ctx) === false, 'a download with the tick after the 30 minutes ran out asks again and downloads nothing until then');
  await vm.runInContext(`setExportSensitive(false)`, ctx);
  ok(log.lock.length === 2 && vm.runInContext('DATA_EXPORT.sens', ctx) === false && log.db.length === 0, 'unticking needs nothing');
  // E calls group G (Security's lock) and group F (the backup) by these names: E can't ship without them.
  ok(['secUnlocked', 'secEnsureUnlocked', 'downloadFullBackup', 'backupWithStepUp', 'renderFullBackupBlock'].every(n => { try { return !!fnText(n); } catch (e) { return false; } }), 'the Security lock and the Full backup that Export to Excel uses exist');
  ok(!/exportDataAsJson|exportDataFile/.test(SRC), 'the old "Export everything" (a JSON of the screen\'s data, scaled ×3 in presentation mode) is gone');
  ok(/readOnlyReason\(\)/.test(fnText('downloadDataExcel')) && /readOnlyReason\(\)/.test(fnText('setExportSensitive')), 'the download and the sensitive tick check read-only mode');
}

// Automations, the flow view (phase 4, group J): moving, adding and removing steps, switching Form / Flow and a whole
// drag change only the editor's own copy (AUTO_ED). In a read-only mode, as in any other, nothing reaches the database
// or a server (saving stays the editor's Save, which checks readOnlyReason()). One drag redraws the editor exactly once,
// and never the whole app.
function flowSandbox(present){
  const log = { db: [], fetch: [], render: 0, edRender: 0, toasts: [], popups: 0 };
  const ctx = {
    log, PRESENT: present, VIEW_AS_ID: null, console,
    sb: new Proxy({}, { get: () => { log.db.push('sb'); throw new Error('no database here'); } }),
    db: new Proxy({}, { get: () => { log.db.push('db'); throw new Error('no database here'); } }),
    fetch: (u) => { log.fetch.push(String(u)); return Promise.resolve({ ok: true, json: async () => ({}) }); },
    render: () => { log.render++; }, autoEdRender: () => { log.edRender++; },
    showToast: (m, o) => { log.toasts.push({ m, o }); }, openPopup: () => { log.popups++; }, closePopup: () => {},
    motionReduced: () => true, CSS: { escape: s => String(s) },
    window: { matchMedia: () => ({ matches: false }) },
    document: { getElementById: () => null, querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {} },
    localStorage: { getItem: () => null, setItem: () => {} },
    cancelAnimationFrame: () => {}, requestAnimationFrame: () => 0,
    autoCtx: () => ({ phoneLive: false, catalog: {}, registry: { triggers: { newLead: { label: 'A new lead comes in', customer: true } }, conds: {},
      actions: { push: { label: 'A phone notification', audience: 'team' }, email: { label: 'An email to the customer', audience: 'customer' },
        text: { label: 'A text', audience: 'customer', available: c => ({ ok: !!c.phoneLive, why: 'Needs the business phone (Twilio)' }) } } } }),
  };
  vm.createContext(ctx);
  const names = [...SRC.matchAll(/function ((?:flow|setFlow)\w*)\(/g)].map(m => m[1]);
  vm.runInContext([constText('FLOW_MAX_STEPS_DEFAULT'), constText('FLOW_MAX_STEPS_CEILING'), constText('FLOW_STEP_KINDS'), constText('ICONS'),
    'let FLOW_DRAG = null, FLOW_EDRENDER_PENDING = false;',
    'var AUTO_ED = { token: 7, view: "form", sel: null, mirror: false, dirty: false, def: { trigger: { type: "newLead" }, steps: [{ id: "s1", kind: "wait", n: 1, unit: "days" }, { id: "s2", kind: "action", type: "push", title: "New lead" }, { id: "s3", kind: "wait", n: 2, unit: "hours" }] } };',
    ...['readOnlyReason', 'esc', 'jsStr', 'ico', 'pill', 'fillTemplate', ...names].map(fnText)].join('\n'), ctx);
  return ctx;
}
function testFlowViewReadOnly(){
  const ids = ctx => vm.runInContext('AUTO_ED.def.steps.map(s => s.id).join(",")', ctx);
  for (const present of [true, false]) {
    const mode = present ? 'presentation mode' : 'normal mode', ctx = flowSandbox(present), log = ctx.log;
    const before = vm.runInContext('JSON.stringify(AUTO_ED.def)', ctx);
    vm.runInContext('flowSetView("flow"); flowSetView("form"); flowSetView("flow")', ctx);
    ok(vm.runInContext('JSON.stringify(AUTO_ED.def)', ctx) === before && vm.runInContext('AUTO_ED.view', ctx) === 'flow', `${mode}: switching Form ↔ Flow keeps the automation byte for byte`);
    vm.runInContext('flowMoveBy("s1", 1)', ctx);
    ok(ids(ctx) === 's2,s1,s3', `${mode}: Move down changes the editor's copy`, ids(ctx));
    vm.runInContext('flowAddPick(3, "action", "email")', ctx);
    ok(ids(ctx) === 's2,s1,s3,s4' && vm.runInContext('AUTO_ED.sel', ctx) === 's4', `${mode}: "+" adds a Do step at its place and opens it`, ids(ctx));
    vm.runInContext('flowAddPick(0, "action", "text")', ctx);
    ok(ids(ctx) === 's2,s1,s3,s4', `${mode}: a text can't be added before the business phone is live (not even by calling the handler)`, ids(ctx));
    vm.runInContext('flowRemoveStep("s1")', ctx);
    ok(ids(ctx) === 's2,s3,s4' && log.toasts.length === 1 && /^Removed "Wait 1 day"$/.test(log.toasts[0].m), `${mode}: the bin removes the step and offers Undo`, log.toasts.map(x => x.m));
    log.toasts[0].o.undo();
    ok(ids(ctx) === 's2,s1,s3,s4', `${mode}: Undo puts it back where it was`, ids(ctx));
    vm.runInContext('AUTO_ED.token = 8', ctx); vm.runInContext('flowRemoveStep("s1")', ctx); vm.runInContext('AUTO_ED.token = 9', ctx);
    log.toasts[1].o.undo();
    ok(ids(ctx) === 's2,s3,s4', `${mode}: Undo after the editor moved on does nothing`, ids(ctx));
    // A whole drag: nothing redraws while it moves (a live update is held), then the editor redraws exactly once.
    const r0 = log.edRender;
    vm.runInContext(`FLOW_DRAG = { id: 's4', from: 2, to: 0, started: true, pointerId: 1, raf: null, items: [], item: { classList: { remove(){} } }, canvas: { classList: { remove(){} } }, grip: { releasePointerCapture(){} } };
      flowRedraw(); flowRedraw();`, ctx);
    ok(log.edRender === r0 && vm.runInContext('FLOW_EDRENDER_PENDING', ctx) === true, `${mode}: no redraw while a block is dragged`);
    vm.runInContext('flowDragEnd({ pointerId: 1 })', ctx);
    ok(ids(ctx) === 's4,s2,s3' && log.edRender === r0 + 1 && vm.runInContext('FLOW_DRAG', ctx) === null, `${mode}: the drop moves the step and redraws the editor once`, [ids(ctx), log.edRender - r0]);
    vm.runInContext('AUTO_ED.mirror = true; flowMoveBy("s4", 1); flowRemoveStep("s4"); flowAddPick(0, "wait", ""); flowAddAt(0)', ctx);
    ok(ids(ctx) === 's4,s2,s3' && log.popups === 0, `${mode}: a ready-made mirror's steps can't be moved, removed or added to`);
    ok(log.db.length === 0 && log.fetch.length === 0 && log.render === 0, `${mode}: no database, no server call, no whole-app redraw`, log);
  }
  const fns = [...SRC.matchAll(/function ((?:flow|setFlow)\w*)\(/g)].map(m => m[1]);
  ok(fns.length > 30 && fns.every(n => !/fetch\(|\bdb\.|\bsb\./.test(fnText(n))), 'no flow function sends anything to a server or the database (layer 2 stays complete)', fns.filter(n => /fetch\(|\bdb\.|\bsb\./.test(fnText(n))));
}


// Automations, the builder (phase 4, group I): in a read-only mode no automation, template, switch or ready-made setting
// is saved, no event reaches the engine, and the person is told (the events, which nobody clicked, stay silent).
async function testAutomationsReadOnly(){
  for (const [mode, present, viewAs] of [['presentation mode', true, null], ['View as', false, 'ron']]) {
    const log = { toasts: [], touched: [], fetch: [], timers: 0 };
    const touch = what => (...a) => { log.touched.push(what); return Promise.resolve({ data: null, error: null }); };
    const ctx = {
      log, PRESENT: present, VIEW_AS_ID: viewAs, console, Promise, JSON,
      showToast: (m) => log.toasts.push(m), render: () => {}, closeModal: () => {}, autoEdRender: () => {},
      db: new Proxy({}, { get: (t, k) => { log.touched.push('db.' + String(k)); throw new Error('no database in a read-only mode'); } }),
      sb: new Proxy({}, { get: (t, k) => { log.touched.push('sb.' + String(k)); throw new Error('no database in a read-only mode'); } }),
      fetch: (u) => { log.fetch.push(String(u)); return Promise.resolve({ json: async () => ({}) }); },
      setTimeout: () => { log.timers++; return 0; },
      confirmAction: touch('confirm'), openAutoEditor: touch('editor'), catalogSave: touch('catalogSave'), logSettingsActivity: touch('activity'),
      autoCatalogWrite: touch('catalogWrite'), autoReadyRow: () => ({ key: 'ready:review', base: 'review', name: 'Review request after a closed job', def: { trigger: { type: 'jobClosed' }, steps: [] } }),
      window: { setReviewCfg: touch('setReviewCfg'), setChatAutoSms: touch('setChatAutoSms'), toggleNotifyCard: touch('toggleNotifyCard') },
      AUTO: { list: [{ id: 'a1', name: 'Quote', enabled: false, def: { trigger: { type: 'newLead' }, steps: [] } }] },
      AUTO_ED: { id: 'a1', isNew: false, mirror: false, def: { trigger: { type: 'newLead' }, steps: [] }, drafts: {} },
      AUTO_TPL_EDIT: { key: 'my_a', name: 'Quote', channel: 'text', body: 'Hi' },
      AUTO_READY_SETTERS: ['setReviewCfg', 'setChatAutoSms', 'toggleNotifyCard'],
      STATE: { data: { settings: { catalog: { automationEvents: { newLead: true, stage: true } } } }, profiles: [] },
      getRealProfile: () => ({ id: 'p', role: 'owner' }), SUPABASE_URL: 'https://x', SUPABASE_ANON_KEY: 'k', contactById: () => ({ id: 'c1' }), leadStage: () => 'Quoted',
    };
    vm.createContext(ctx);
    vm.runInContext([constText('AUTOMATIONS_URL'), constText('AUTOMATION_EVENTS_SENT'), ...['readOnlyReason', 'catalogObject', 'automationEventBody', 'automationEvent', 'autoEventWanted', 'autoEmitStage', 'autoSyncEvents',
      'saveMsgTemplate', 'deleteMsgTemplate', 'newMsgTemplate', 'editMsgTemplate', 'autoSaveEditor', 'toggleAutomation', 'autoWriteEnabled', 'deleteAutomation', 'duplicateAutomation',
      'autoBackToDefault', 'autoReadyBackToDefault', 'autoReadyAct'].map(fnText)].join('\n'), ctx);
    const msg = vm.runInContext('readOnlyReason()', ctx);
    const run = async (code) => { try { await vm.runInContext(code, ctx); } catch (e) { ok(false, `${mode}: ${code} ran past its read-only check`, String(e.message || e).slice(0, 120)); } };
    for (const c of [`saveMsgTemplate()`, `deleteMsgTemplate('my_a')`, `newMsgTemplate()`, `editMsgTemplate('my_a')`, `autoSaveEditor()`, `toggleAutomation('a1')`, `autoWriteEnabled(AUTO.list[0], true)`,
      `deleteAutomation('a1')`, `duplicateAutomation('ready:review')`, `autoBackToDefault('ready:review')`, `autoReadyBackToDefault()`, `autoReadyAct('setReviewCfg', 'sendFrom', '9')`, `autoReadyAct('setChatAutoSms', true)`]) await run(c);
    ok(log.touched.length === 0 && log.fetch.length === 0, `${mode}: no automation, template, switch or ready-made setting is saved, and no window opens`, log);
    ok(log.toasts.length === 13 && log.toasts.every(t => t === msg), `${mode}: each one says changes are not saved`, log.toasts);
    const before = log.toasts.length;
    await run(`automationEvent('newLead', 'c1')`); await run(`autoEmitStage('c1', 'Quoted')`); await run(`autoSyncEvents()`);
    await new Promise(r => setImmediate(r));
    ok(log.fetch.length === 0 && log.timers === 0 && log.touched.length === 0 && log.toasts.length === before, `${mode}: no event reaches the engine, nothing waits to send one, and nobody is told (nobody clicked)`, log);
    ok(JSON.stringify(ctx.AUTO.list[0].enabled) === 'false' && ctx.AUTO_TPL_EDIT.key === 'my_a', `${mode}: nothing changes on screen either`);
  }
  for (const n of ['autoSaveEditor', 'toggleAutomation', 'autoWriteEnabled', 'deleteAutomation', 'duplicateAutomation', 'saveMsgTemplate', 'deleteMsgTemplate', 'newMsgTemplate', 'autoBackToDefault', 'autoReadyBackToDefault', 'autoReadyAct', 'autoCatalogWrite', 'autoSyncEvents', 'autoEmitStage'])
    ok(/readOnlyReason\(\)/.test(fnText(n)), `${n}() checks readOnlyReason()`);
  ok(/if \(!autoEventWanted\(type\)\) return;/.test(fnText('automationEvent')), 'automationEvent only tells the engine when an automation of your own waits for that event');
}

(async () => {
  await testGuard();
  testStaticScan();
  await testDropUploadsReadOnly();
  await testActions();
  testBrandingReadOnly();
  await testSecurityReadOnly();
  await testBackupReadOnly();
  await testExportReadOnly();
  testFlowViewReadOnly();
  await testAutomationsReadOnly();
  console.log(`read-only: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
