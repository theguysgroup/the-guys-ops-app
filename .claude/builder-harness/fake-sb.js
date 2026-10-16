// A fake Supabase client AND a fake automations function for the builder harness: no network at all. Every read answers
// from FAKE_DB, every write is logged in window.__writes and changes FAKE_DB like the database would; every call to the
// automations function (fetch …/functions/v1/automations) is answered here with the function's rules that the builder's
// write path depends on (stage 2 G4.4; design §3.13, §8.4):
//   registry — the engine's own export (tests/fixtures/wf-registry.json, written by the engine's tests; today's context)
//   validate — errors for a workflow with no step, warnings for one with no trigger; shapeChanged when the steps differ
//   save     — 409 "conflict" when expected_revision ≠ revision (updated_by_name / updated_at); a Published one refuses
//              errors (422); revision + 1; the new builder's mark (layout.editor "builder" when editor = "builder", taken
//              off by a save without a layout); template drafts written into the catalog; ai_edited → Draft
//   publish  — 409 "conflict" on an old revision; 409 "confirm" for a customer step without the yes; the old editor's
//              block ("At most 20 steps.", E_EDITOR_BLOCK) only for a row the new builder did not save last; never bumps
//   duplicate / test / migrate — enough for the screens
// window.__fake: bump(id) (someone else saves), calls (every function call), setErrors([...]) (validate's extra errors).
(function(){
  const uid = '00000000-0000-4000-8000-000000000001';
  const user = { id: uid, email: 'owner@example.com', app_metadata: {}, user_metadata: {}, aud: 'authenticated' };
  const session = { access_token: 'fake', refresh_token: 'fake', user, expires_at: Math.floor(Date.now() / 1000) + 3600 };
  const realFetch = window.fetch.bind(window), clone = x => JSON.parse(JSON.stringify(x)), now = () => new Date().toISOString();
  const F0 = { match: 'all', segments: [{ match: 'all', rules: [] }] };
  const IDS = { flat: '11111111-1111-4111-8111-111111111111', big: '22222222-2222-4222-8222-222222222222', email: '33333333-3333-4333-8333-333333333333' };
  const pushNode = (i, last) => ({ kind: 'action', type: 'internal_notification', config: { channel: 'push', to: { roles: ['owner'] }, title: `Alert ${i}` }, out: { next: last ? null : `n${i + 1}` } });
  const big = { schema: 2, seq: 25, entry: 'n1', triggers: [{ id: 't1', type: 'newLead', filters: F0 }], nodes: {} };
  for (let i = 1; i <= 25; i++) big.nodes[`n${i}`] = pushNode(i, i===25);
  const row = (id, name, def, x) => ({ id, business_id: 'default', name, enabled: false, created_by_name: 'Alex Owner', template_key: null, trigger: {}, steps: [], definition: def, settings: {}, layout: { v: 1 }, builder: 'standard',
    folder_id: null, deleted_at: null, origin: 'user', revision: 2, system_key: null, enrolled_total: 0, list_summary: { triggers: def.triggers.map(t => t.type), actions: [...new Set(Object.values(def.nodes).map(n => n.type))], audience: 'team' },
    created_at: '2026-10-14T00:00:00Z', updated_at: '2026-10-14T00:00:00Z', updated_by_name: 'Alex Owner', ...(x || {}) });
  window.__writes = [];
  window.FAKE_IDS = IDS;
  window.FAKE_DB = {
    profiles: [{ id: uid, full_name: 'Alex Owner', role: 'owner', permissions: {}, email: 'owner@example.com' }, { id: '00000000-0000-4000-8000-000000000002', full_name: 'Kim Office', role: 'manager', permissions: { crm: true } }],
    settings: [{ id: 1, company_name: 'Example Services', unpaid_reminder_days: 7, gst_rate_percent: 10, review_requests_auto: false, chat_auto_sms: true, phone_enabled: false,
      catalog: { msgTemplates: { my_demo0001: { name: 'Quote follow-up', channel: 'email' } }, templates: { my_demo0001: '{hi},\n\nJust checking you got our quote for {service}. Reply to this email with any question.\n\nThanks!' },
        notify: { newLead: { on: true, office: true }, leadWaiting: { on: true } } } }],
    employees: [{ id: 'e1', name: 'Kim Office', status: 'Active', roles: ['VA'] }],
    contacts: [{ id: 'c-demo-1', full_name: 'Sam Smith', phone: '0412 345 678', email: 'sam@example.com', status: 'Quoted', created_at: '2026-10-13', source: 'Google Ads', division: 'Aircon', messages: [], tags: [] }],
    automations: [
      row(IDS.flat, 'Quote follow-up email', { schema: 2, seq: 3, entry: 'n1', triggers: [{ id: 't1', type: 'stage', filters: { match: 'all', segments: [{ match: 'all', rules: [{ field: 'trigger.stage', op: 'is', v: 'Quoted' }] }] } }],
        nodes: { n1: { kind: 'wait', type: 'period', config: { n: 3, unit: 'days' }, out: { next: 'n2' } }, n2: { kind: 'action', type: 'add_task', config: { title: 'Call {name} about the quote' }, out: { next: null } } } }),
      row(IDS.big, 'Big team alert (25 steps)', big),
      row(IDS.email, 'Thank you email', { schema: 2, seq: 1, entry: 'n1', triggers: [{ id: 't1', type: 'jobClosed', filters: F0 }],
        nodes: { n1: { kind: 'action', type: 'send_email', config: { subject: 'Thanks from {business_name}', body: '{hi}, thanks for choosing us.' }, out: { next: null } } } }, { list_summary: { triggers: ['jobClosed'], actions: ['send_email'], audience: 'customer' }, audience: 'customer' }),
    ],
    automation_notes: [], automation_folders: [], automation_pauses: [], automation_system_meta: [], automation_reviews: [],
    automation_templates: [{ id: 'tpl-1', key: 'team_new_lead', name: 'Tell the team about a new lead', description: 'A phone notification.', category: 'Team notifications', origin: 'system',
      definition: { schema: 2, seq: 1, entry: 'n1', triggers: [{ id: 't1', type: 'newLead', filters: F0 }], nodes: { n1: pushNode(1, true) } }, settings: {}, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' }],
  };
  const T = name => (window.FAKE_DB[name] = window.FAKE_DB[name] || []);
  // ── the client: select with eq / is / in filters, insert, update (by the filters), upsert, delete ──
  function builder(table){
    let op = 'select', payload = null, single = false, maybe = false;
    const filters = [];
    const match = r => filters.every(f => f(r));
    const q = new Proxy({}, { get(t, k){
      if (k === 'then') return (res, rej) => {
        let data = null, error = null;
        const rows = T(table);
        if (op === 'select') data = clone(rows.filter(match));
        else {
          window.__writes.push({ table, op, payload: clone(payload) });
          if (op === 'insert' || op === 'upsert') { const list = (Array.isArray(payload) ? payload : [payload]).map(p => ({ id: crypto.randomUUID(), created_at: now(), deleted_at: null, ...(table === 'automation_notes' ? { created_by: uid } : {}), ...clone(p) })); rows.push(...list); data = clone(list); }
          else if (op === 'update') { const hit = rows.filter(match); hit.forEach(r => Object.assign(r, clone(payload), table === 'automations' ? { updated_at: now() } : {})); data = clone(hit); }
          else if (op === 'delete') { const keep = rows.filter(r => !match(r)); data = clone(rows.filter(match)); window.FAKE_DB[table] = keep; }
        }
        if (single || maybe) data = Array.isArray(data) ? data[0] || null : data;
        if (single && !data) error = { message: 'not found', code: 'PGRST116' };
        return Promise.resolve({ data, error, count: Array.isArray(data) ? data.length : data ? 1 : 0 }).then(res, rej);
      };
      if (['insert', 'update', 'upsert', 'delete'].includes(k)) return (p) => { op = k; payload = p; return q; };
      if (k === 'single') return () => { single = true; return q; };
      if (k === 'maybeSingle') return () => { maybe = true; return q; };
      if (k === 'eq') return (col, v) => { filters.push(r => String(r[col]) === String(v)); return q; };
      if (k === 'neq') return (col, v) => { filters.push(r => String(r[col]) !== String(v)); return q; };
      if (k === 'is') return (col, v) => { filters.push(r => (v === null ? r[col] == null : r[col] === v)); return q; };
      if (k === 'in') return (col, vs) => { filters.push(r => (vs || []).map(String).includes(String(r[col]))); return q; };
      return () => q;
    } });
    return q;
  }
  // ── the automations function ──
  const regP = realFetch('../../tests/fixtures/wf-registry.json').then(r => r.json()).then(S => {
    const ctx = JSON.stringify({ ai: false, atomicTags: true, gbp: false, phone: false, reviews: false, teamEmail: false, xero: false }), b = S.byAvail[ctx], r = clone(S.base), av = b.availability;
    r.availCtx = b.availCtx;
    r.triggers.forEach(t => { t.availability = av['t:' + t.key]; });
    ['actions', 'waits', 'goals', 'logic'].forEach(l => r[l].forEach(n => { n.availability = av[`n:${n.kind}/${n.key}`]; }));
    r.fields.forEach(f => { f.availability = av['f:' + f.key]; });
    r.merge.forEach(m => { m.availability = av['m:' + m.key]; });
    return { ok: true, ...r };
  }).catch(e => ({ ok: false, reason: 'registry fixture not read: ' + e.message }));
  const fake = { calls: [], extraErrors: [] };
  window.__fake = { calls: fake.calls, bump(id){ const a = T('automations').find(x => x.id === id); if (a) { a.revision += 1; a.updated_by_name = 'Kim Office'; a.updated_at = now(); } return a && a.revision; },
    setErrors(list){ fake.extraErrors = Array.isArray(list) ? list : []; } };
  const shape = d => JSON.stringify(Object.keys((d && d.nodes) || {}).sort().map(k => [k, d.nodes[k].type, d.nodes[k].out]));
  const check = d => {
    const nodes = Object.values((d && d.nodes) || {}), errors = [...fake.extraErrors], warnings = [];
    if (!nodes.some(n => n.kind === 'action')) errors.push({ code: 'E_NO_ACTION', severity: 'error', path: '/nodes', text: 'Add at least one action' });
    if (!((d && d.triggers) || []).length) warnings.push({ code: 'E_NO_TRIGGER', severity: 'warning', path: '/triggers', text: 'Only manual add or Add to workflow can start it' });
    return { errors, warnings };
  };
  const res = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const conflict = a => res(409, { ok: false, reason: 'conflict', revision: a.revision, updated_by_name: a.updated_by_name || 'Kim Office', updated_at: a.updated_at });
  async function fn(b){
    fake.calls.push(clone(b));
    const rows = T('automations'), a = b.automation_id ? rows.find(x => x.id === b.automation_id && !x.deleted_at) : null;
    if (b.step === 'registry') return res(200, await regP);
    if (b.step === 'validate') { const c = check(b.definition); return res(200, { ok: true, ...c, shapeChanged: !!a && shape(a.definition) !== shape(b.definition), armChanged: false, idsRemoved: [], waitingRunsAffected: 0 }); }
    if (b.step === 'save') {
      if (b.automation_id && !a) return res(404, { ok: false, reason: 'workflow not found' });
      if (a && b.expected_revision !== a.revision) return conflict(a);
      const c = check(b.definition);
      if (a && a.enabled && c.errors.length) return res(422, { ok: false, reason: 'errors', errors: c.errors, warnings: c.warnings });
      let layout = b.layout == null ? (a && a.layout) || { v: 1 } : clone(b.layout);
      if (b.editor === 'builder') layout = { ...layout, editor: 'builder' }; else if (b.layout == null) { layout = { ...layout }; delete layout.editor; }
      const cat = T('settings')[0].catalog, keys = Object.keys(b.template_drafts || {});
      keys.forEach(k => { const d = b.template_drafts[k]; cat.templates = { ...(cat.templates || {}), [k]: d.body }; cat.msgTemplates = { ...(cat.msgTemplates || {}), [k]: { name: d.name, channel: d.channel } }; });
      const was = !!(a && a.enabled), r = a || row(crypto.randomUUID(), b.name, b.definition, { revision: 0, template_key: b.template_key || null });
      Object.assign(r, { name: b.name, definition: clone(b.definition), settings: b.settings || r.settings, layout, builder: b.builder || r.builder, revision: r.revision + 1, updated_at: now(), updated_by_name: 'Alex Owner',
        list_summary: { triggers: (b.definition.triggers || []).map(t => t.type), actions: [...new Set(Object.values(b.definition.nodes || {}).map(n => n.type))], audience: Object.values(b.definition.nodes || {}).some(n => n.type === 'send_email' || n.type === 'send_sms') ? 'customer' : 'team' } });
      if (b.ai_edited === true) r.enabled = false;
      if (!a) rows.push(r);
      window.__writes.push({ fn: 'save', id: r.id, revision: r.revision });
      return res(200, { ok: true, id: r.id, revision: r.revision, version: 1, enabled: r.enabled, armed_at: null, shapeChanged: false, armChanged: false, drafted: was && !r.enabled, version_no: null, template_key: r.template_key, templates: keys, errors: c.errors, warnings: c.warnings });
    }
    if (b.step === 'publish') {
      if (!a) return res(404, { ok: false, reason: 'workflow not found' });
      const on = b.on === true;
      if (on && b.expected_revision != null && b.expected_revision !== a.revision) return conflict(a);
      if (on) {
        const c = check(a.definition), nodes = Object.values(a.definition.nodes || {});
        const old = (a.layout || {}).editor !== 'builder' && nodes.length > 20 ? [{ code: 'E_EDITOR_BLOCK', severity: 'error', path: '', text: 'At most 20 steps.' }] : [];
        if (old.length || c.errors.length) return res(422, { ok: false, reason: 'errors', errors: [...old, ...c.errors], warnings: c.warnings });
        if (nodes.some(n => n.type === 'send_email' || n.type === 'send_sms') && b.confirm !== true) return res(409, { ok: false, reason: 'confirm', confirm: ['Sends to customers: Send email'] });
      }
      a.enabled = on;
      window.__writes.push({ fn: 'publish', id: a.id, on });
      return res(200, { ok: true, enabled: a.enabled, armed_at: null, revision: a.revision, version: 1, warnings: [] });
    }
    if (b.step === 'duplicate') { const r = { ...clone(a), id: crypto.randomUUID(), name: b.name || `${a.name} (copy)`, enabled: false, revision: 1 }; rows.push(r); return res(200, { ok: true, id: r.id }); }
    if (b.step === 'test') return res(200, { ok: true, problems: [], trigger: { matched: true }, path: [], ended: 'end', notes: [] });
    if (b.step === 'migrate') return res(200, { ok: true, migrated: 0 });
    return res(400, { ok: false, reason: 'the harness has no step ' + b.step });
  }
  const authApi = new Proxy({}, { get(t, k){
    if (k === 'onAuthStateChange') return (cb) => { setTimeout(() => cb('SIGNED_IN', session), 0); return { data: { subscription: { unsubscribe(){} } } }; };
    if (k === 'mfa') return new Proxy({}, { get: () => async () => ({ data: { all: [], totp: [], currentLevel: 'aal1', nextLevel: 'aal1', currentAuthenticationMethods: [] }, error: null }) });
    return async () => ({ data: { session, user }, error: null });
  } });
  const rpcData = { automation_list_stats: {}, automation_needs_review: [], automation_trigger_stats: [], automation_step_stats: [] };
  const client = { auth: authApi, from: builder, rpc: async (name) => { window.__writes.push({ rpc: name }); return { data: name in rpcData ? clone(rpcData[name]) : null, error: null }; },
    channel: () => { const c = { on: () => c, subscribe: () => c, unsubscribe(){}, track: async () => {}, presenceState: () => ({}) }; return c; }, removeChannel(){},
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: '' } }), upload: async () => ({ data: null, error: null }), createSignedUrl: async () => ({ data: { signedUrl: '' }, error: null }) }) },
    functions: { invoke: async () => ({ data: null, error: null }) } };
  window.supabase = { createClient: () => client };
  window.fetch = (u, init) => {
    const url = String(u);
    if (/\/functions\/v1\/automations$/.test(url)) { let b = {}; try { b = JSON.parse((init && init.body) || '{}'); } catch (e) {} return fn(b); }
    if (url.startsWith('../../tests/') || url.includes('/tests/fixtures/')) return realFetch(u, init);
    window.__writes.push({ fetch: url });
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
})();
