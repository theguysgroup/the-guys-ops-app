// The builder's write path, clicked through in the harness (stage 2 G4.4; design §8.4 "Builder harness … for every write
// path: save, 409 conflict, publish gate, overlap, restore, notes, template drafts, AI-origin save as Draft"). Run in the
// harness page's console: await __wfClickThrough() → { pass, fail, lines }. Real clicks on the builder's buttons where a
// person clicks; the fake function (fake-sb.js) answers with the function's rules. Nothing leaves the page.
window.__wfClickThrough = async function(){
  const lines = [];
  let pass = 0, fail = 0;
  const ok = (c, name, extra) => { if (c) pass++; else fail++; const l = `${c ? 'PASS' : 'FAIL'} ${name}${!c && extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 300) : ''}`; lines.push(l); (c ? console.log : console.error)(l); };
  const wait = ms => new Promise(r => setTimeout(r, ms || 50));
  const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 4000)) { try { if (fn()) return true; } catch (e) { /* not yet */ } await wait(40); } return false; };
  const $ = (sel, root) => (root || document).querySelector(sel);
  const click = (sel, root) => { const el = $(sel, root); if (!el) throw new Error('not found: ' + sel); el.click(); return el; };
  const confirmYes = async () => { await until(() => $('#modal-root .confirm-back')); const b = $('#modal-root .confirm-actions .btn.primary, #modal-root .confirm-actions .btn.danger-solid'); if (b) b.click(); await wait(80); };
  const type = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const lastCall = step => [...__fake.calls].reverse().find(c => c.step === step) || null;
  const row = id => FAKE_DB.automations.find(a => a.id === id);
  const ID = FAKE_IDS;
  try {
    // 0. Settings → Automation; the list's Edit opens the NEW builder (not the old editor)
    openAutomation({ tab: 'workflows' });
    await until(() => document.querySelector('[onclick^="wfEdit("]'));
    click(`[onclick="wfEdit('${ID.flat}')"]`);
    ok(await until(() => typeof WF !== 'undefined' && WF && WF.id === ID.flat && !$('#wf-root').hidden), 'Edit on the list opens the new builder on that workflow');
    ok(!document.querySelector('.auto-ed'), 'the old editor did not open');
    const p0 = window.__wfp; await wait(1200);
    ok(window.__wfp === p0 && !(window.__wfPaintReentry > 0), 'idle: no paint at all after opening', { p0, now: window.__wfp });
    // 1. rename + Save (the revision it was opened at; the new builder's mark)
    click('[data-act="rename"]');
    await until(() => $('.wfb-rename'));
    const inp = $('.wfb-rename'); inp.value = 'Quote follow-up (builder)'; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await until(() => WF.name === 'Quote follow-up (builder)');
    click('[data-act="save"]');
    ok(await until(() => $('.wfb-save') && $('.wfb-save').textContent.includes('Saved')), 'Save → "Saved"');
    const s1 = lastCall('save');
    ok(s1 && s1.expected_revision === 2 && s1.editor === 'builder' && row(ID.flat).layout.editor === 'builder' && row(ID.flat).revision === 3, 'the save carried the revision it was opened at and the builder\'s mark', s1);
    // 2. 409: someone else saves; ours asks Load their version / Save mine as a copy
    __fake.bump(ID.flat);
    WF.el.top.querySelector('[data-act="rename"]').click(); await until(() => $('.wfb-rename'));
    const in2 = $('.wfb-rename'); in2.value = 'Mine'; in2.dispatchEvent(new Event('input', { bubbles: true })); in2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    click('[data-act="save"]');
    ok(await until(() => $('#wf-modal [data-act="conflictLoad"]')), '409 → "This workflow was changed by …" with Load their version / Save mine as a copy');
    ok($('#wf-modal').textContent.includes('This workflow was changed by Kim Office'), 'the dialog names who changed it');
    click('#wf-modal [data-act="conflictCopy"]');
    ok(await until(() => WF.id && WF.id !== ID.flat && row(WF.id) && row(WF.id).name === 'Mine (copy)'), '"Save mine as a copy": a new workflow; theirs untouched', row(ID.flat) && row(ID.flat).name);
    // 3. the publish gate: a new empty workflow → "Save and publish?" → errors → "Workflow can't be published yet" → Review issues
    WF_ACTS.back(); await until(() => !WF || $('#wf-modal [data-act="leaveDiscard"]'));
    wfBuilderOpen(null, {}); await wait(100);
    click('[data-act="publish"]');
    await confirmYes();
    ok(await until(() => $('#wf-modal [data-act="gateReview"]')), 'publish with errors (no step): "Workflow can\'t be published yet" + Review issues');
    click('#wf-modal [data-act="gateReview"]');
    ok(await until(() => WF.rail === 'errors' && $('.wfb-lbody [data-act="errOpen"], .wfb-lbody .wfr-g')), 'Review issues opens the Errors panel, grouped');
    ok(lastCall('validate') !== null, 'the Errors panel asked the server\'s check (validate)');
    // 4. a customer workflow: Publish asks; the function gets the yes
    await wfEdit(ID.email); await until(() => WF && WF.id === ID.email);
    click('[data-act="publish"]');
    await confirmYes();
    ok(await until(() => row(ID.email).enabled === true), 'Publish on a workflow that emails customers: asked first, then published with the yes', lastCall('publish'));
    ok(lastCall('publish').confirm === true && lastCall('publish').expected_revision === row(ID.email).revision, 'the publish carried the yes and the revision');
    // 5. Workflow AI's change on a Published workflow → asked → saved as a Draft
    wfAiApply([{ op: 'setNode', id: 'n1', patch: { name: 'Thank you (AI)' } }], 'Workflow AI: name');
    click('[data-act="save"]');
    await confirmYes();
    ok(await until(() => row(ID.email).enabled === false && lastCall('save').ai_edited === true), 'Workflow AI\'s change on a Published workflow: saved as a Draft');
    // 6. a 25-step workflow made in the builder publishes by the v2 rules (no "At most 20 steps.")
    await wfEdit(ID.big); await until(() => WF && WF.id === ID.big);
    WF.el.top.querySelector('[data-act="rename"]').click(); await until(() => $('.wfb-rename'));
    const in3 = $('.wfb-rename'); in3.value = 'Big team alert'; in3.dispatchEvent(new Event('input', { bubbles: true })); in3.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    click('[data-act="save"]'); await until(() => $('.wfb-save').textContent.includes('Saved'));
    click('[data-act="publish"]');
    ok(await until(() => row(ID.big).enabled === true), 'a 25-step workflow the builder saved publishes (v2 rules), never "At most 20 steps."', lastCall('publish'));
    // 7. notes: add one to the workflow, see it listed
    click('[data-act="rail"][data-rail="notes"]');
    await until(() => $('.wfb-lbody [data-act="noteNew"]'));
    type($('.wfb-lbody [data-act="noteNew"]'), 'Checked with Noam');
    click('.wfb-lbody [data-act="noteAdd"]');
    ok(await until(() => FAKE_DB.automation_notes.some(n => n.automation_id === ID.big && n.body === 'Checked with Noam') && $('.wfb-lbody').textContent.includes('Checked with Noam')), 'Notes: added (automation_notes) and listed with who and when');
    // 8. template drafts: a step's new template words go with the Save into the catalog
    wfRailToggle('notes');
    const k = autoLibKey(WF.tplDrafts);
    wfCommit('Edit action', w => ({ tplDrafts: { ...w.tplDrafts, [k]: { name: 'Harness words', channel: 'email', body: 'Hello from the harness' } } }));
    click('[data-act="save"]');
    ok(await until(() => FAKE_DB.settings[0].catalog.templates[k] === 'Hello from the harness' && Object.keys(WF.tplDrafts).length === 0), 'template drafts: saved with the workflow into the catalog; the builder\'s drafts are done');
    // 9. the local draft: unsaved work kept on this device, offered back on opening
    wfCommit('Rename workflow', () => ({ name: 'Unsaved draft name' }));
    await wait(1800);
    ok(Object.keys(localStorage).some(x => x.startsWith(`wf.draft.default.${ID.big}.`)), 'the local draft is written 1.5 s after a change');
    wfBuilderClose(); await wfEdit(ID.big);
    ok(await until(() => $('#wf-modal [data-act="draftRestore"]')), 'opening it again offers "Unsaved changes found" (Restore / Discard)');
    click('#wf-modal [data-act="draftRestore"]');
    ok(await until(() => WF.name === 'Unsaved draft name'), 'Restore brings the unsaved name back');
    // 10. leaving with unsaved changes asks Save / Discard / Cancel; Discard leaves
    click('[data-act="back"]');
    ok(await until(() => $('#wf-modal [data-act="leaveDiscard"]')), '← Workflows list with unsaved changes asks first');
    click('#wf-modal [data-act="leaveDiscard"]');
    ok(await until(() => !WF && $('#wf-root').hidden), 'Discard: the builder closes, the list is back');
    ok(!Object.keys(localStorage).some(x => x.startsWith(`wf.draft.default.${ID.big}.`)), 'Discard dropped the local draft');
    // 11. a System workflow: read-only with its banner; Duplicate to edit opens an unsaved copy
    await wfEdit('ready:team:newLead');
    ok(await until(() => WF && WF.mode === 'system' && !$('.wfb-banner').hidden), 'a System row opens read-only with "System workflow · runs on the built-in system"');
    click('.wfb-banner [data-act="sysCopy"]');
    ok(await until(() => WF && WF.mode === 'edit' && !WF.id && /^Copy of /.test(WF.name)), '"Duplicate to edit": an unsaved copy in the builder');
    WF_HOOKS.leave(() => wfBuilderClose()); await wait(50);
    if ($('#wf-modal [data-act="leaveDiscard"]')) click('#wf-modal [data-act="leaveDiscard"]');
    // idle at the end
    const p1 = window.__wfp; await wait(3000);
    ok(window.__wfp === p1 && !(window.__wfPaintReentry > 0), 'idle 3 s at the end: no builder paint, no paint asked for during a paint');
  } catch (e) { ok(false, 'the click-through stopped: ' + (e && e.message)); }
  console.log(`builder click-through: ${pass} passed, ${fail} failed`);
  return { pass, fail, lines };
};
