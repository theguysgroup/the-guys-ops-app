/* GHL live chat v4 (2026-09-29) - conversational intake in our own window, then GHL.
   Hosted here (not in WordPress) because the web host's firewall blocks saving a script this size in Code Snippets.
   Loaded by a small Code Snippets loader on theguyservicegroup.com, which decides who gets it (test visits only,
   or everyone) and sets window.tggChatV4Config = { test: true|false } plus window.__tggChatLoaded so the old v3 stays off.
   Flow: automated greeting -> service chips -> first name -> Australian phone (required) -> suburb/details.
   Once the phone is valid the visitor's name + phone go into GHL's own contact form and the first message is sent
   (GHL widget kept hidden); after that Ron's replies from GHL are shown in our window.
   Conversion (Google Ads via GTM + Meta 'Contact') fires once GHL has accepted the name + phone; test mode only pushes
   'ghl_chat_lead_test' and never calls Meta. Anything failing in GHL shows GHL's own chat instead.
   If this file fails to load, the site's floating phone button simply stays visible. */
(function () {
  if (window.__tggChatV4Started) return;
  window.__tggChatV4Started = true;
  var CFG = window.tggChatV4Config || {};
  var TEST_MODE = CFG.test !== false;
  var WIDGET_ID = '6aba0f5a57e2265a4c930c7d';
  var META_EVENT = 'Contact';
  var CALL_DISPLAY = '1300 380 090', CALL_TEL = '1300380090';

  var STATE_KEY = 'tggChat4', LEAD_KEY = 'tggChat4Lead', WEEK = 7 * 24 * 3600 * 1000;
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function waitFor(fn, ms) {
    return new Promise(function (resolve) {
      var end = Date.now() + ms;
      (function tick() {
        var v = null;
        try { v = fn(); } catch (e) {}
        if (v) return resolve(v);
        if (document.hidden) end += 250; // a background tab is slowed down by the browser; only count visible time
        if (Date.now() > end) return resolve(null);
        setTimeout(tick, 250);
      })();
    });
  }

  var AVATAR = 'data:image/svg+xml,' + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>" +
    "<rect width='64' height='64' fill='#B73C3A'/>" +
    "<path d='M12 60c1.5-12 9.5-18.5 20-18.5S50.5 48 52 60z' fill='#fff'/>" +
    "<circle cx='32' cy='27' r='11.5' fill='#fff'/>" +
    "<path d='M20.5 25c-.5-9 5-14 11.5-14s12 4.5 11.5 14c-2-4.5-6.5-6-11.5-6s-9.5 1.5-11.5 6z' fill='#6B1F1E'/>" +
    "</svg>");

  var SERVICES = [
    { key: 'split', label: 'Aircon split system', text: 'aircon split system cleaning', division: 'Aircon' },
    { key: 'ducted', label: 'Ducted aircon', text: 'ducted aircon cleaning', division: 'Aircon' },
    { key: 'chimney', label: 'Chimney', text: 'chimney cleaning', division: 'Chimney' },
    { key: 'pw', label: 'Pressure washing', text: 'pressure washing', division: 'Pressure Washing' },
    { key: 'other', label: 'Something else', text: '', division: '' }
  ];
  function serviceByKey(k) { for (var i = 0; i < SERVICES.length; i++) if (SERVICES[i].key === k) return SERVICES[i]; return SERVICES[4]; }
  function serviceForPage() {
    var p = window.location.pathname.toLowerCase();
    if (p.indexOf('duct') > -1) return SERVICES[1];
    if (p.indexOf('aircon') > -1 || p.indexOf('air-condition') > -1) return SERVICES[0];
    if (p.indexOf('chimney') > -1 || p.indexOf('fireplace') > -1) return SERVICES[2];
    if (/pressure|washing|gutter|solar|window|roof/.test(p)) return SERVICES[3];
    return null;
  }

  // Office hours: Monday to Friday, 8am to 5pm Sydney time (same as the GHL widget settings).
  function sydney() {
    try {
      var parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Australia/Sydney', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date());
      var wd = '', h = 0;
      parts.forEach(function (p) { if (p.type === 'weekday') wd = p.value; if (p.type === 'hour') h = parseInt(p.value, 10) % 24; });
      return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd), hour: h };
    } catch (e) { var d = new Date(); return { day: d.getDay(), hour: d.getHours() }; }
  }
  function isOpen() { var s = sydney(); return s.day >= 1 && s.day <= 5 && s.hour >= 8 && s.hour < 17; }
  function nextOpen() {
    var s = sydney();
    if (s.day >= 1 && s.day <= 5 && s.hour < 8) return 'today';
    if (s.day === 6 || s.day === 0 || (s.day === 5 && s.hour >= 17)) return 'on Monday';
    return 'tomorrow';
  }

  // Where the visitor came from: the site's attribution cookie (snippet #15), then the URL.
  function param(name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(window.location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }
  function attribution() {
    var a = {};
    try {
      var m = document.cookie.match(/(?:^|; )tgsg_attribution=([^;]*)/);
      if (m) a = JSON.parse(decodeURIComponent(m[1])) || {};
    } catch (e) { a = {}; }
    var keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'landing_page'];
    var out = {};
    keys.forEach(function (k) { out[k] = a[k] || (k === 'landing_page' ? '' : param(k)) || ''; });
    return out;
  }

  // Australian numbers: mobiles, landlines, 13/1300/1800. Returns digits (0412345678) or ''.
  function ausPhone(v) {
    var d = String(v).replace(/[\s().-]/g, '');
    if (/^\+61\d{9}$/.test(d)) d = '0' + d.slice(3);
    else if (/^61\d{9}$/.test(d)) d = '0' + d.slice(2);
    else if (/^[2-478]\d{8}$/.test(d)) d = '0' + d;
    if (/^0[2-478]\d{8}$/.test(d)) return d;
    if (/^1[38]00\d{6}$/.test(d) || /^13\d{4}$/.test(d)) return d;
    return '';
  }
  function prettyPhone(p) {
    if (/^04\d{8}$/.test(p)) return p.replace(/^(\d{4})(\d{3})(\d{3})$/, '$1 $2 $3');
    if (/^0\d{9}$/.test(p)) return p.replace(/^(\d{2})(\d{4})(\d{4})$/, '$1 $2 $3');
    return p;
  }

  /* ---------- state (kept across pages for a week) ---------- */
  var st = lsGet(STATE_KEY);
  if (!st || !st.ts || Date.now() - st.ts > WEEK) st = null;
  function fresh() {
    var pageService = serviceForPage();
    return { ts: Date.now(), step: 'service', open: isOpen(), log: [], pageService: pageService ? pageService.key : '', service: '', name: '', phone: '', badTries: 0, handed: false, seenIn: 0 };
  }
  if (!st) st = fresh();
  function save() { st.ts = Date.now(); if (st.log.length > 80) st.log = st.log.slice(-80); lsSet(STATE_KEY, st); }

  /* ---------- the GHL widget (hidden; our window is what the visitor sees) ---------- */
  var hideNative = document.createElement('style');
  hideNative.id = 'tgg-chat4-hide-ghl';
  hideNative.textContent = 'chat-widget{visibility:hidden!important}';
  document.head.appendChild(hideNative);

  var loader = document.createElement('script');
  loader.src = 'https://widgets.leadconnectorhq.com/loader.js';
  loader.setAttribute('data-resources-url', 'https://widgets.leadconnectorhq.com/chat-widget/loader.js');
  loader.setAttribute('data-widget-id', WIDGET_ID);
  loader.async = true;
  document.body.appendChild(loader);

  function ghlNodes() {
    var host = document.querySelector('chat-widget');
    if (!host || !host.shadowRoot) return [];
    var out = Array.prototype.slice.call(host.shadowRoot.querySelectorAll('*'));
    for (var i = 0; i < out.length; i++) {
      if (out[i].shadowRoot) out = out.concat(Array.prototype.slice.call(out[i].shadowRoot.querySelectorAll('*')));
    }
    return out;
  }
  function findTag(nodes, tag) { for (var i = 0; i < nodes.length; i++) if (nodes[i].tagName === tag) return nodes[i]; return null; }
  function findInput(nodes, name) { for (var i = 0; i < nodes.length; i++) if (nodes[i].tagName === 'INPUT' && nodes[i].name === name) return nodes[i]; return null; }
  function findId(nodes, id) { for (var i = 0; i < nodes.length; i++) if (nodes[i].id === id) return nodes[i]; return null; }
  function ghlMessages(nodes) {
    var out = [];
    nodes.forEach(function (n) {
      if (n.tagName !== 'CHAT-MESSAGE') return;
      var outgoing = !!(n.shadowRoot && n.shadowRoot.querySelector('.bubble.outgoing'));
      out.push({ out: outgoing, text: (n.textContent || '').trim(), sys: n.id === 'lc-chat-widget-enter-contact-details-msg' });
    });
    return out;
  }
  var SYSTEM_TEXT = /^(to connect you with ron|please share (your )?contact details|give us a minute|thanks! ron will reply|thanks for your message! our office is closed|hi, i'm ron from the guys group office|chat closed|.*inactiv)/i;
  function typeInto(el, value) {
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: value, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }
  function widgetApi() { var c = window.leadConnector && window.leadConnector.chatWidget; return c && c.openWidget ? c : null; }

  // GHL ended the chat (office hours, or 5 minutes without activity): shows 'Chat Closed' + a 'Click here' restart button.
  function findRestart(nodes) {
    for (var i = 0; i < nodes.length; i++) if (nodes[i].tagName === 'ION-BUTTON' && /reset-chat-button/.test(nodes[i].className) && nodes[i].getClientRects().length) return nodes[i];
    return null;
  }
  function ghlState() {
    var n = ghlNodes();
    if (findInput(n, 'name') && findInput(n, 'phone')) return 'form';
    if (findRestart(n)) return 'closed';
    if (findTag(n, 'TEXTAREA')) return 'box';
    return null;
  }

  // Sends one message to GHL as the visitor. Fills GHL's name + phone form first when it asks for it, and restarts
  // a chat GHL has closed. If GHL closes the chat right after the form (outside office hours) the name + phone are
  // saved in GHL but the message cannot be added; that is reported as 'closed' and does not count as a failure.
  async function deliver(text) {
    var cw = await waitFor(widgetApi, 20000);
    if (!cw) throw new Error('widget-not-loaded');
    cw.openWidget();
    var state = await waitFor(ghlState, 30000);
    if (!state) throw new Error('no-form-or-box');
    if (state === 'closed') {
      if (st.closedAt && Date.now() - st.closedAt < 12 * 3600 * 1000 && !isOpen()) return 'closed';
      var rb = findRestart(ghlNodes());
      if (rb) rb.click();
      state = await waitFor(function () { var s2 = ghlState(); return s2 && s2 !== 'closed' ? s2 : null; }, 15000);
      if (!state) throw new Error('restart-failed');
    }
    var usedForm = false;
    if (state === 'form') {
      // GHL's form can ignore a click that comes right after it appears, so check the values and retry.
      await sleep(600);
      var after = null;
      for (var attempt = 0; attempt < 4 && !after; attempt++) {
        var n = ghlNodes();
        var nameIn = findInput(n, 'name'), phoneIn = findInput(n, 'phone');
        var btn = findId(n, 'lc_text-widget--send-btn');
        if (!nameIn || !phoneIn || !btn) break;
        if (nameIn.value !== st.name) typeInto(nameIn, st.name);
        if (phoneIn.value !== st.phone) typeInto(phoneIn, st.phone);
        await sleep(500);
        btn.click();
        after = await waitFor(function () { var s2 = ghlState(); return s2 === 'box' || s2 === 'closed' ? s2 : null; }, 4000);
      }
      if (!after) after = await waitFor(function () { var s2 = ghlState(); return s2 === 'box' || s2 === 'closed' ? s2 : null; }, 6000);
      if (!after) throw new Error('form-not-accepted');
      state = after;
      usedForm = true;
    }
    fireLead();
    if (state === 'closed') {
      st.closedAt = Date.now();
      save();
      return 'closed';
    }
    if (!usedForm && !st.handed) text = 'Name: ' + st.name + ', Phone: ' + st.phone + '. ' + text;
    var nodes = ghlNodes();
    var before = ghlMessages(nodes).filter(function (m) { return m.out; }).length;
    var ion = findTag(nodes, 'ION-TEXTAREA'), ta = findTag(nodes, 'TEXTAREA');
    if (!ta) throw new Error('no-message-box');
    if (ion) ion.value = text;
    typeInto(ta, text);
    await sleep(250);
    ['keydown', 'keypress', 'keyup'].forEach(function (t) {
      ta.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, composed: true, cancelable: true }));
    });
    var sent = await waitFor(function () { return ghlMessages(ghlNodes()).filter(function (m) { return m.out; }).length > before ? true : null; }, 10000);
    if (!sent) throw new Error('message-not-sent');
    if (!st.handed) {
      st.handed = true;
      st.seenIn = ghlMessages(ghlNodes()).filter(function (m) { return !m.out; }).length;
      save();
      startMirror();
    }
  }
  var queue = Promise.resolve(), failed = false;
  function sendToRon(text) {
    queue = queue.then(function () { if (!failed) return deliver(text); }).catch(function (err) { fallback(err); });
  }

  // If anything in GHL does not work: show GHL's own chat (or the phone number if GHL is not there at all).
  function fallback(err) {
    if (failed) return;
    failed = true;
    try { window.dataLayer = window.dataLayer || []; window.dataLayer.push({ event: 'ghl_chat_v4_error', chat_error: String(err && err.message || err) }); } catch (e) {}
    var cw = widgetApi();
    if (cw) {
      hideNative.remove();
      closePanel();
      root.style.display = 'none';
      try { cw.openWidget(); } catch (e) {}
    } else {
      addCallBubble('Sorry, our chat is having trouble right now. Please call us on ' + CALL_DISPLAY + '.');
      showCallBtn();
    }
  }

  // Ron's replies in GHL -> our window.
  var mirrorTimer = null;
  function startMirror() {
    if (mirrorTimer) return;
    mirrorTimer = setInterval(function () {
      if (failed) return;
      var incoming = ghlMessages(ghlNodes()).filter(function (m) { return !m.out; });
      if (incoming.length < st.seenIn) { st.seenIn = incoming.length; save(); return; }
      if (incoming.length === st.seenIn) return;
      incoming.slice(st.seenIn).forEach(function (m) {
        if (m.sys || !m.text || SYSTEM_TEXT.test(m.text)) return;
        add('ron', m.text);
        if (!panelOpen) notify(m.text);
      });
      st.seenIn = incoming.length;
      save();
    }, 1500);
  }
  // Returning visitor who already reached Ron: reopen GHL hidden so replies keep coming in.
  if (st.handed) {
    waitFor(widgetApi, 20000).then(function (cw) {
      if (!cw) return;
      cw.openWidget();
      waitFor(ghlState, 15000).then(function () { startMirror(); });
    });
  }

  function fireLead() {
    var last = lsGet(LEAD_KEY);
    if (last && Date.now() - last < WEEK) return;
    lsSet(LEAD_KEY, Date.now());
    var svc = serviceByKey(st.service);
    var ev = {
      event: TEST_MODE ? 'ghl_chat_lead_test' : 'ghl_chat_lead',
      chat_service: svc.label,
      division: svc.division,
      page_path: window.location.pathname,
      chat_version: 'v4',
      office_open: isOpen() ? 'yes' : 'no'
    };
    var src = attribution();
    Object.keys(src).forEach(function (k) { ev['lead_' + k] = src[k]; });
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(ev);
    if (!TEST_MODE && typeof window.fbq === 'function') {
      var eventId = 'chat-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
      window.fbq('track', META_EVENT, { content_name: 'Website chat', content_category: svc.division || 'Other' }, { eventID: eventId });
    }
  }

  /* ---------- our chat window ---------- */
  var root = document.createElement('div');
  root.id = 'tgg-chat4';
  document.body.appendChild(root);
  var sh = root.attachShadow({ mode: 'open' });
  // Built with DOM calls (no HTML strings), so nothing here looks like markup to the host's firewall.
  function el(tag, props, kids) {
    var e = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'text') e.textContent = props[k];
      else if (k === 'hidden') e.hidden = !!props[k];
      else e.setAttribute(k === 'cls' ? 'class' : k, props[k]);
    });
    (kids || []).forEach(function (c) { e.appendChild(c); });
    return e;
  }
  function sendIcon() {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    [['width', '18'], ['height', '18'], ['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2.2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']].forEach(function (a) { svg.setAttribute(a[0], a[1]); });
    ['M22 2 11 13', 'M22 2 15 22l-4-9-9-4 20-7z'].forEach(function (d) { var pth = document.createElementNS(NS, 'path'); pth.setAttribute('d', d); svg.appendChild(pth); });
    return svg;
  }
  var css = document.createElement('style');
  css.textContent =
    ':host{all:initial}' +
    '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}' +
    '.launch{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;gap:10px}' +
    '.teaser{background:#fff;color:#231c1b;border-radius:14px;padding:11px 34px 11px 13px;font-size:14px;line-height:1.4;max-width:250px;box-shadow:0 6px 24px rgba(0,0,0,.22);position:relative;cursor:pointer}' +
    '.teaser b{display:block;font-weight:600}' +
    '.teaser .tx{position:absolute;top:4px;right:4px;border:0;background:transparent;font-size:18px;line-height:1;color:#8a7e7c;cursor:pointer;padding:6px}' +
    '.fab{width:60px;height:60px;border-radius:50%;border:0;padding:0;background:#B73C3A;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.3);position:relative}' +
    '.fab img{width:100%;height:100%;border-radius:50%;display:block}' +
    '.dot{position:absolute;right:1px;bottom:1px;width:14px;height:14px;border-radius:50%;border:2px solid #fff;background:#2bb760}' +
    '.closed .dot{background:#b9aeac}' +
    '.badge{position:absolute;top:-4px;left:-4px;min-width:20px;height:20px;border-radius:10px;background:#1f8a4c;color:#fff;font-size:12px;font-weight:700;line-height:20px;text-align:center;padding:0 5px}' +
    '.back{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:2147483001}' +
    '.panel{position:fixed;z-index:2147483002;right:20px;bottom:20px;width:370px;height:min(600px,calc(100vh - 40px));background:#fff;color:#231c1b;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.28);display:flex;flex-direction:column;overflow:hidden}' +
    '.grab{display:none}' +
    '@media (max-width:600px){.panel{left:0;right:0;bottom:0;width:auto;height:72vh;height:72dvh;border-radius:18px 18px 0 0}.grab{display:block;width:40px;height:5px;border-radius:3px;background:#d8cfcd;margin:8px auto 0}}' +
    '@media (min-width:601px){.back{display:none}}' +
    '.head{display:flex;align-items:center;gap:10px;padding:12px 12px 12px 14px;border-bottom:1px solid #eee6e4}' +
    '.av{width:42px;height:42px;border-radius:50%;position:relative;flex:0 0 auto}' +
    '.av img{width:100%;height:100%;border-radius:50%;display:block}' +
    '.av .dot{width:12px;height:12px;right:-1px;bottom:-1px}' +
    '.who{flex:1;min-width:0}' +
    '.who .n{font-weight:600;font-size:15px;line-height:1.25}' +
    '.who .s{font-size:12.5px;color:#6d6260;line-height:1.3}' +
    '.x{border:0;background:#f3eeed;width:34px;height:34px;border-radius:50%;font-size:20px;line-height:1;cursor:pointer;color:#4a3f3d;flex:0 0 auto}' +
    '.msgs{flex:1;overflow-y:auto;padding:14px 12px 8px;display:flex;flex-direction:column;gap:8px;-webkit-overflow-scrolling:touch}' +
    '.sys{align-self:center;font-size:11.5px;color:#8a7e7c;background:#f6f2f1;border-radius:999px;padding:2px 10px}' +
    '.b{max-width:84%;padding:9px 12px;border-radius:16px;font-size:14.5px;line-height:1.42;white-space:pre-line;word-wrap:break-word}' +
    '.bot,.ron{align-self:flex-start;background:#f1eceb;border-bottom-left-radius:4px}' +
    '.ron{background:#fbe9e8}' +
    '.me{align-self:flex-end;background:#B73C3A;color:#fff;border-bottom-right-radius:4px}' +
    '.b a{color:#B73C3A;font-weight:600}' +
    '.who2{align-self:flex-start;font-size:11px;color:#8a7e7c;margin:2px 0 -5px 4px}' +
    '.typing{align-self:flex-start;background:#f1eceb;border-radius:16px;padding:11px 14px;display:flex;gap:4px}' +
    '.typing i{width:6px;height:6px;border-radius:50%;background:#a99b99;animation:tb 1s infinite}' +
    '.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}' +
    '@keyframes tb{50%{opacity:.3}}' +
    '.chips{display:flex;flex-wrap:wrap;gap:7px;padding:2px 0 4px}' +
    '.chip{font-size:14px;border:1.5px solid #B73C3A;color:#B73C3A;background:#fff;border-radius:999px;padding:8px 13px;cursor:pointer;text-decoration:none;line-height:1.2}' +
    '.chip.first{background:#B73C3A;color:#fff}' +
    '.chip.ghost{border-color:#d6cccb;color:#6d6260}' +
    '.foot{border-top:1px solid #eee6e4;padding:10px 10px 12px}' +
    '.row{display:flex;gap:8px;align-items:center}' +
    '.in{flex:1;min-width:0;font-size:16px;border:1.5px solid #ddd3d1;border-radius:22px;padding:10px 14px;color:#231c1b;background:#fff;outline:none;-webkit-appearance:none}' +
    '.in:focus{border-color:#B73C3A}' +
    '.in:disabled{background:#f6f2f1}' +
    '.send{width:44px;height:44px;border-radius:50%;border:0;background:#B73C3A;color:#fff;cursor:pointer;flex:0 0 auto;display:flex;align-items:center;justify-content:center}' +
    '.send:disabled{background:#d9c9c8;cursor:default}' +
    '.fine{font-size:11px;color:#8a7e7c;text-align:center;margin-top:7px}' +
    'button:focus-visible,.in:focus-visible,a:focus-visible{outline:2px solid #B73C3A;outline-offset:2px}' +
    '[hidden]{display:none!important}';
  sh.appendChild(css);
  sh.appendChild(el('div', { cls: 'launch', id: 'launch' }, [
    el('div', { cls: 'teaser', id: 'teaser', hidden: true }, [el('span', { id: 'teaserText' }), el('button', { cls: 'tx', id: 'teaserX', 'aria-label': 'Dismiss', text: '\u00D7' })]),
    el('button', { cls: 'fab', id: 'fab', 'aria-label': 'Chat with Ron from The Guys Group' }, [el('img', { alt: '', id: 'fabImg' }), el('span', { cls: 'dot' }), el('span', { cls: 'badge', id: 'badge', hidden: true, text: '1' })])
  ]));
  sh.appendChild(el('div', { cls: 'back', id: 'back', hidden: true }));
  sh.appendChild(el('div', { cls: 'panel', id: 'panel', role: 'dialog', 'aria-label': 'Chat with Ron from The Guys Group', hidden: true }, [
    el('div', { cls: 'grab' }),
    el('div', { cls: 'head' }, [
      el('div', { cls: 'av' }, [el('img', { alt: '', id: 'avImg' }), el('span', { cls: 'dot' })]),
      el('div', { cls: 'who' }, [el('div', { cls: 'n', text: 'Ron from The Guys Group' }), el('div', { cls: 's', id: 'status' })]),
      el('button', { cls: 'x', id: 'close', 'aria-label': 'Close chat', text: '\u00D7' })
    ]),
    el('div', { cls: 'msgs', id: 'msgs', 'aria-live': 'polite' }),
    el('div', { cls: 'foot' }, [
      el('div', { cls: 'row' }, [
        el('input', { cls: 'in', id: 'in', autocomplete: 'off', placeholder: 'Choose an option above' }),
        el('button', { cls: 'send', id: 'send', 'aria-label': 'Send' }, [sendIcon()])
      ]),
      el('div', { cls: 'fine', text: 'We only use your details to reply to your enquiry.' })
    ])
  ]));
  function $(id) { return sh.getElementById(id); }
  $('fabImg').src = AVATAR; $('avImg').src = AVATAR;
  var msgs = $('msgs'), input = $('in'), sendBtn = $('send'), panel = $('panel');
  input.disabled = true; sendBtn.disabled = true;
  var panelOpen = false;

  function paintHeader() {
    var open = isOpen();
    $('launch').classList.toggle('closed', !open);
    panel.classList.toggle('closed', !open);
    $('status').textContent = open ? 'Sydney office \u00B7 Replies in a few minutes' : 'Office closed \u00B7 Back ' + nextOpen() + ' 8am';
  }

  function scrollDown() { msgs.scrollTop = msgs.scrollHeight; }
  function bubble(who, text) {
    if (who === 'sys') { var s = document.createElement('div'); s.className = 'sys'; s.textContent = text; msgs.appendChild(s); return; }
    if (who === 'ron') { var l = document.createElement('div'); l.className = 'who2'; l.textContent = 'Ron'; msgs.appendChild(l); }
    var d = document.createElement('div');
    d.className = 'b ' + who;
    d.textContent = text;
    msgs.appendChild(d);
  }
  function callBubble(text) {
    var d = document.createElement('div');
    d.className = 'b bot';
    d.appendChild(document.createTextNode(text + ' '));
    var a = document.createElement('a');
    a.href = 'tel:' + CALL_TEL;
    a.textContent = 'Call ' + CALL_DISPLAY;
    d.appendChild(a);
    msgs.appendChild(d);
  }
  function add(who, text) { st.log.push({ w: who, t: text }); save(); bubble(who, text); scrollDown(); }
  function addCallBubble(text) { st.log.push({ w: 'call', t: text }); save(); callBubble(text); scrollDown(); }
  function botSay(text, then) {
    var t = document.createElement('div');
    t.className = 'typing';
    for (var i = 0; i < 3; i++) t.appendChild(document.createElement('i'));
    msgs.appendChild(t); scrollDown();
    setTimeout(function () { t.remove(); add('bot', text); if (then) then(); }, 700);
  }
  function setInput(placeholder, type, enabled) {
    input.placeholder = placeholder;
    input.type = type || 'text';
    input.setAttribute('inputmode', type === 'tel' ? 'tel' : 'text');
    input.setAttribute('autocomplete', type === 'tel' ? 'tel' : (st.step === 'name' ? 'given-name' : 'off'));
    input.disabled = !enabled;
    input.value = '';
    sendBtn.disabled = true;
    if (enabled && panelOpen) { try { input.focus({ preventScroll: true }); } catch (e) {} }
  }
  function chips(list, onPick) {
    var box = document.createElement('div');
    box.className = 'chips';
    list.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (c.cls ? ' ' + c.cls : '');
      b.textContent = c.label;
      b.addEventListener('click', function () { box.remove(); onPick(c); });
      box.appendChild(b);
    });
    msgs.appendChild(box);
    scrollDown();
  }

  function greeting() {
    return st.open
      ? "Hi there \uD83D\uDC4B This is an automated message. A real person from our Sydney office will reply here in a few minutes.\n\nWhat can we help you with?"
      : "Hi there \uD83D\uDC4B This is an automated message. Our office is closed right now. We're open Monday to Friday, 8am to 5pm (Sydney time).\n\nLeave your details and a short description of the job, and you'll be first on our call list when we open. What do you need help with?";
  }
  function serviceChips() {
    var first = st.pageService ? serviceByKey(st.pageService) : null;
    var list = [];
    if (first) list.push({ key: first.key, label: first.label, cls: 'first' });
    SERVICES.forEach(function (s) {
      if (first && s.key === first.key) return;
      list.push({ key: s.key, label: s.label, cls: s.key === 'other' ? 'ghost' : '' });
    });
    chips(list, pickService);
  }
  function detailsQuestion() {
    var svc = serviceByKey(st.service);
    if (!svc.text) return 'What do you need done, and which suburb are you in?';
    return isOpen()
      ? 'Last one, optional: which suburb are you in, and anything we should know? For example, how many units.'
      : 'Please describe the job in a few words and tell us your suburb, e.g. "3 split units in Ryde, one is mouldy". It helps Ron prepare your quote before he calls.';
  }
  function skipChip() { chips([{ label: 'Skip', cls: 'ghost' }], function () { finish(''); }); }

  // Rebuild the window from the saved conversation (also on the next page).
  function render() {
    msgs.textContent = '';
    st.log.forEach(function (m) { if (m.w === 'call') callBubble(m.t); else bubble(m.w, m.t); });
    if (st.step === 'service') { serviceChips(); setInput('Choose an option above', 'text', false); }
    else if (st.step === 'name') setInput('First name', 'text', true);
    else if (st.step === 'phone') setInput('Mobile number', 'tel', true);
    else if (st.step === 'details') { setInput('Suburb and details', 'text', true); if (serviceByKey(st.service).text) skipChip(); }
    else setInput('Type a message\u2026', 'text', true);
    scrollDown();
  }
  function start() {
    st.open = isOpen();
    add('sys', 'Automated message');
    add('bot', greeting());
    st.step = 'service'; save();
    serviceChips();
    setInput('Choose an option above', 'text', false);
  }
  function pickService(c) {
    st.service = c.key; st.step = 'name'; save();
    var svc = serviceByKey(c.key);
    add('me', svc.label);
    botSay(svc.text ? 'Great, ' + svc.label.toLowerCase() + ". What's your first name?" : "No problem. What's your first name?",
      function () { setInput('First name', 'text', true); });
  }
  function submit() {
    var v = input.value.trim();
    if (!v) return;
    if (st.step === 'name') {
      if (!/[A-Za-z\u00C0-\u024F]/.test(v) || v.length > 40 || /\d{3,}/.test(v)) {
        add('me', v); input.value = ''; sendBtn.disabled = true;
        botSay('Just your first name is fine.');
        return;
      }
      var first = v.split(/\s+/)[0];
      st.name = v.replace(/(^|\s)(\S)/g, function (m, sp, ch) { return sp + ch.toUpperCase(); });
      st.first = first.charAt(0).toUpperCase() + first.slice(1);
      st.step = 'phone'; save();
      add('me', v); setInput('', 'text', false);
      botSay('Thanks ' + st.first + ". What's the best mobile number to reach you? If the chat drops out, we'll call you back on it.",
        function () { setInput('Mobile number', 'tel', true); });
    } else if (st.step === 'phone') {
      var p = ausPhone(v);
      add('me', v); input.value = ''; sendBtn.disabled = true;
      if (!p) {
        st.badTries = (st.badTries || 0) + 1; save();
        var msg = /[A-Za-z]/.test(v)
          ? 'To talk to Ron and get a quote, we need a valid phone number. Please type your mobile number, for example 0412 345 678.'
          : "That phone number doesn't look right. To talk to Ron and get a quote, please enter a valid number, for example 0412 345 678.";
        botSay(msg, function () {
          if (st.badTries >= 2 && isOpen()) addCallBubble('Prefer to talk now?');
          setInput('Mobile number', 'tel', true);
        });
        return;
      }
      st.phone = prettyPhone(p); st.step = 'details'; save();
      var svc = serviceByKey(st.service);
      sendToRon(svc.text ? "Hi, I'd like a quote for " + svc.text + '.' : "Hi, I'd like a quote.");
      setInput('', 'text', false);
      botSay(detailsQuestion(), function () {
        setInput('Suburb and details', 'text', true);
        if (svc.text) skipChip();
      });
    } else if (st.step === 'details') {
      add('me', v);
      sendToRon(v);
      finish(v);
    } else {
      add('me', v);
      input.value = ''; sendBtn.disabled = true;
      sendToRon(v);
    }
  }
  function finish() {
    var c = msgs.querySelector('.chips'); if (c) c.remove();
    st.step = 'chat'; save();
    setInput('', 'text', false);
    var text = isOpen()
      ? 'Thanks ' + st.first + ", you're all set \u2705\nRon from our office will reply right here in a few minutes. Don't want to wait? We'll call you on " + st.phone + ' shortly.'
      : 'Thanks ' + st.first + ", we've got your request \u2705\nYou're first on our call list: Ron will call you on " + st.phone + ' ' + nextOpen() + ' from 8am.';
    botSay(text, function () { setInput('Type a message\u2026', 'text', true); });
  }

  input.addEventListener('input', function () { sendBtn.disabled = !input.value.trim(); });
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  sendBtn.addEventListener('click', submit);

  // Keep the window above the phone keyboard (iOS does not shrink fixed elements).
  function fitKeyboard() {
    var vv = window.visualViewport;
    if (!vv || window.innerWidth > 600 || !panelOpen) { panel.style.bottom = ''; panel.style.height = ''; return; }
    var hidden = window.innerHeight - vv.height - vv.offsetTop;
    if (hidden > 80) { panel.style.bottom = hidden + 'px'; panel.style.height = Math.round(vv.height * 0.96) + 'px'; }
    else { panel.style.bottom = ''; panel.style.height = ''; }
  }
  if (window.visualViewport) { window.visualViewport.addEventListener('resize', fitKeyboard); window.visualViewport.addEventListener('scroll', fitKeyboard); }

  var unread = 0;
  function notify(text) {
    unread++;
    $('badge').textContent = String(unread);
    $('badge').hidden = false;
    $('teaserText').textContent = 'Ron: ' + (text.length > 90 ? text.slice(0, 88) + '\u2026' : text);
    $('teaser').hidden = false;
  }
  function openPanel() {
    panelOpen = true;
    paintHeader();
    panel.hidden = false;
    $('back').hidden = false;
    $('launch').hidden = true;
    unread = 0; $('badge').hidden = true; $('teaser').hidden = true;
    ssSet('tggChat4Teaser', 'x');
    if (!st.log.length) start(); else if (!msgs.childNodes.length) render();
    scrollDown();
    if (!input.disabled && window.innerWidth > 600) { try { input.focus({ preventScroll: true }); } catch (e) {} }
    fitKeyboard();
  }
  function closePanel() {
    panelOpen = false;
    panel.hidden = true;
    $('back').hidden = true;
    $('launch').hidden = false;
    fitKeyboard();
  }
  $('fab').addEventListener('click', openPanel);
  $('teaser').addEventListener('click', function (e) { if (e.target.id !== 'teaserX') openPanel(); });
  $('teaserX').addEventListener('click', function (e) { e.stopPropagation(); $('teaser').hidden = true; ssSet('tggChat4Teaser', 'x'); });
  $('close').addEventListener('click', closePanel);
  $('back').addEventListener('click', closePanel);

  // The chat replaces the floating phone button (the phone in the header stays).
  var hideCall = document.createElement('style');
  hideCall.id = 'tgg-hide-call-btn';
  hideCall.textContent = '#call-btn{display:none!important}';
  document.head.appendChild(hideCall);
  function showCallBtn() { hideCall.remove(); }

  paintHeader();
  setInterval(paintHeader, 60000);
  if (st.log.length) render();
  if (!ssGet('tggChat4Teaser') && !st.handed) {
    setTimeout(function () {
      if (panelOpen) return;
      $('teaserText').textContent = '';
      var b = document.createElement('b');
      if (isOpen()) { b.textContent = 'Need a quote?'; $('teaserText').appendChild(b); $('teaserText').appendChild(document.createTextNode('Chat with our Sydney office.')); }
      else { b.textContent = "We're closed right now"; $('teaserText').appendChild(b); $('teaserText').appendChild(document.createTextNode("Leave your details and we'll call you " + nextOpen() + ' from 8am.')); }
      $('teaser').hidden = false;
    }, 4000);
  }
})();
