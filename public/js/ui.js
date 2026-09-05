/* ============================================================
   The mobile shell: tabs, bottom sheets, the home screen and the small
   surfaces around them (toast, install row, offline note).

   Everything here is presentation. The money paths — prepare / sign /
   submit, the funding pipeline, the backups — stay in app.js and fund.js
   and keep their element ids; this file only arranges them into tabs and
   sheets and paints numbers the portfolio model already formatted.

   Two rules it never breaks:
     · it never writes #btn-send.disabled (setStep in app.js owns that);
     · it never invents a number: an unknown price prints as nothing or "—",
       never as $0.00 (see portfolio.js).
   ============================================================ */
'use strict';

const UI = (() => {
  const $ = (s) => document.querySelector(s);
  const byId = (id) => document.getElementById(id);
  const TABS = ['tab-home', 'tab-convert', 'tab-security'];
  const LS_LAST = 'bw_portfolio_last';   // {at, model} — the last good screen, per address
  const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* What the screen knows. app.js pushes state in through setContext(). */
  const CTX = {
    address: null, cfg: {}, recovery: null, active: false, refresh: null,
    model: null, modelAt: null, credentials: [], credsLoaded: false,
  };
  let sheetEl = null;         // the open sheet
  let opener = null;          // the element that opened it — focus goes back there
  let closing = null;         // {el, timer, onEnd} while a close animation runs
  let toastTimer = null;
  let installPrompt = null;   // a stashed beforeinstallprompt event
  let lastSats = {};          // row id → sats, to flash a row that grew
  let lastQr = null;          // "address|amount" last rendered in the receive sheet
  let tokenOpen = null;       // the row model shown in the token sheet

  /* ---------------- small helpers ---------------- */
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const shortAddr = (a) => (a && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a || '');
  const groups = (a) => String(a || '').replace(/(.{4})/g, '$1 ').trim();
  const fmtTime = (t) => { try { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; } };
  const relTime = (t) => {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 90) return 'a minute ago';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return fmtTime(t);
  };
  const sym = () => (CTX.cfg && CTX.cfg.nativeSymbol) || 'KOIN';
  const netLabel = () => {
    const c = CTX.cfg || {};
    const label = c.networkLabel || (c.testnet ? 'Koinos testnet' : 'Koinos mainnet');
    return c.demo ? `Demo (${label})` : label;
  };
  const explorerAddr = (addr) => (CTX.cfg && CTX.cfg.explorer && addr ? `${CTX.cfg.explorer}/address/${addr}` : null);
  const CLOCK = '<svg class="ic ic-14" aria-hidden="true"><use href="#i-clock"/></svg>';

  /* Stale-price glyph: a tiny clock. Defined here so the sprite in
     index.html stays the list of icons buttons use. */
  (() => {
    const sprite = document.querySelector('svg.sprite');
    if (!sprite || byId('i-clock')) return;
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'symbol');
    s.setAttribute('id', 'i-clock'); s.setAttribute('viewBox', '0 0 24 24');
    s.innerHTML = '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>';
    sprite.appendChild(s);
  })();

  /* ---------------- tabs ---------------- */
  let currentTab = 'tab-home';
  function showTab(id) {
    if (!TABS.includes(id)) id = 'tab-home';
    closeSheet();
    for (const t of TABS) {
      const panel = byId(t), btn = byId('tabbtn-' + t.slice(4));
      if (panel) panel.hidden = t !== id;
      if (btn) { btn.setAttribute('aria-selected', String(t === id)); btn.tabIndex = t === id ? 0 : -1; }
    }
    currentTab = id;
    window.scrollTo(0, 0);
    if (id === 'tab-convert') {
      if (typeof Fund !== 'undefined' && Fund.refresh) Fund.refresh();
      const job = byId('fund-job');
      if (job && !job.hidden) requestAnimationFrame(() => job.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' }));
    }
  }

  /* app.js calls this from show(): the tab bar exists only in the wallet,
     and leaving the wallet forgets the tab and closes any sheet. */
  function onView(view) {
    const inWallet = view === '#view-wallet';
    const bar = byId('tabbar');
    if (bar) bar.hidden = !inWallet;
    document.body.classList.toggle('in-wallet', inWallet);
    if (!inWallet) { closeSheet({ immediate: true, restoreFocus: false }); showTab('tab-home'); }
    else paintInstall();
  }

  /* Deep links from the home-screen shortcuts, applied once the wallet is
     open: ?open=receive | ?open=send | ?tab=convert. */
  function applyIntent(intent) {
    if (!intent) return;
    if (intent.tab === 'convert') showTab('tab-convert');
    if (intent.open === 'receive') openSheet('sheet-receive');
    else if (intent.open === 'send') openSheet('sheet-send');
  }

  /* ---------------- sheets ---------------- */
  function openSheet(id, opts = {}) {
    const s = byId(id);
    if (!s) return;
    if (sheetEl && sheetEl !== s) closeSheet({ immediate: true, restoreFocus: false });
    if (closing && closing.el === s) {           // reopened mid-close
      clearTimeout(closing.timer); s.removeEventListener('transitionend', closing.onEnd); closing = null;
    }
    const active = document.activeElement;
    opener = opts.opener || (active && active !== document.body && !s.contains(active) ? active : null);
    sheetEl = s;
    const scrim = byId('scrim');
    s.hidden = false;
    if (scrim) scrim.hidden = false;
    document.body.classList.add('sheet-open');
    s.scrollTop = 0;
    onSheetOpen(id);
    const go = () => { s.classList.add('in'); if (scrim) scrim.classList.add('in'); };
    if (reduced()) go(); else requestAnimationFrame(() => requestAnimationFrame(go));
    const target = opts.focus ? s.querySelector(opts.focus) : null;
    setTimeout(() => { try { (target || s).focus({ preventScroll: !target }); } catch (_) {} }, reduced() ? 0 : 60);
  }

  function closeSheet(opts = {}) {
    const s = sheetEl;
    if (!s) return;
    sheetEl = null;
    const scrim = byId('scrim');
    s.classList.remove('in');
    if (scrim) scrim.classList.remove('in');
    document.body.classList.remove('sheet-open');
    const finish = () => {
      s.hidden = true;
      if (scrim && !sheetEl) scrim.hidden = true;
      s.removeEventListener('transitionend', onEnd);
      if (closing && closing.el === s) closing = null;
    };
    const onEnd = (ev) => { if (ev.target === s) finish(); };
    if (opts.immediate || reduced()) finish();
    else {
      s.addEventListener('transitionend', onEnd);
      /* A WebView that never fires transitionend must not leave a ghost
         sheet in the DOM: the timer is the guarantee, the event the fast path. */
      closing = { el: s, timer: setTimeout(finish, 300), onEnd };
    }
    onSheetClose(s.id);
    const back = opener; opener = null;
    if (opts.restoreFocus !== false && back && document.contains(back) && !back.hidden && typeof back.focus === 'function') {
      try { back.focus({ preventScroll: true }); } catch (_) {}
    }
  }

  function onSheetOpen(id) {
    if (id === 'sheet-receive') {
      renderReceiveQr();
      const share = byId('btn-recv-share'); if (share) share.hidden = !navigator.share;
      const note = byId('recv-amount-note'); if (note) note.hidden = !byId('recv-amount').value.trim();
    }
    if (id === 'sheet-send') {
      const done = byId('btn-send-done'); if (done) done.hidden = true;
      const paste = byId('btn-paste'); if (paste) paste.hidden = !(navigator.clipboard && navigator.clipboard.readText);
      paintOffline();
      renderSendSummary();
    }
    if (id === 'sheet-add-token') {
      const err = byId('add-token-err'); if (err) { err.hidden = true; err.textContent = ''; }
      const inp = byId('add-token-addr'); if (inp) inp.value = '';
    }
  }
  function onSheetClose(id) {
    if (id === 'sheet-token') tokenOpen = null;
  }

  /* ---------------- toast ---------------- */
  function toast(text, ms = 2000) {
    const t = byId('toast');
    if (!t) return;
    clearTimeout(toastTimer);
    /* The element is never hidden: a live region announces a text change,
       not an un-hiding. Clear then set, so a repeated message is a change. */
    t.textContent = '';
    t.classList.remove('in');
    void t.offsetWidth;                       // restart the slide
    t.textContent = text;
    t.classList.add('in');
    toastTimer = setTimeout(() => { t.classList.remove('in'); }, ms);
  }

  /* ---------------- context from app.js ---------------- */
  function setContext(patch) {
    const before = CTX.address;
    Object.assign(CTX, patch || {});
    if (patch && 'address' in patch && CTX.address) {
      const short = shortAddr(CTX.address);
      const pill = $('#addr-short .pill-text'); if (pill) pill.textContent = short;
      const from = byId('send-from'); if (from) from.textContent = short;
      const acct = byId('acct-addr'); if (acct) decorateAddr(acct, CTX.address);
      const full = byId('addr'); if (full) decorateAddr(full, CTX.address);
      const ex = byId('acct-explorer');
      if (ex) { const href = explorerAddr(CTX.address); ex.hidden = !href; if (href) ex.href = href; }
      /* A new address (or the first): show the last good screen for it
         while the live numbers load, instead of a blank hero. */
      if (CTX.address !== before) {
        lastSats = {}; CTX.model = null; CTX.modelAt = null; lastQr = null;
        const cached = restoreLast(CTX.address);
        if (cached) renderModel(cached.model, cached.at);
      }
    }
    if (patch && 'cfg' in patch) {
      const c = CTX.cfg || {};
      const net = byId('acct-net'); if (net) net.textContent = netLabel();
      const ssn = byId('ss-network'); if (ssn) ssn.textContent = netLabel();
      const rn = byId('recv-net');
      if (rn) { rn.textContent = c.demo ? 'DEMO' : netLabel(); rn.className = 'badge ' + (c.demo ? 'demo' : c.testnet ? 'testnet' : 'mainnet'); }
      const s1 = byId('send-suffix'); if (s1) s1.textContent = sym();
      const s2 = byId('recv-suffix'); if (s2) s2.textContent = sym();
      const tn = byId('tok-network'); if (tn) tn.textContent = netLabel();
    }
    if (patch && ('recovery' in patch || 'active' in patch)) paintSigner();
  }

  /* The checksum cue on a full address: the first and last four characters
     are the ones people compare, so they get a highlight. The click handlers
     copy the ADDRESS variable, not textContent, so wrapping is safe. */
  function decorateAddr(node, addr) {
    if (!node || !addr) return;
    node.textContent = '';
    node.appendChild(el('span', 'head', addr.slice(0, 4)));
    node.appendChild(document.createTextNode(addr.slice(4, -4)));
    node.appendChild(el('span', 'tail', addr.slice(-4)));
  }

  function paintSigner() {
    const signed = byId('acct-signed');
    if (signed) {
      signed.textContent = '';
      if (CTX.recovery) {
        signed.appendChild(el('span', 'warn-text', 'Recovery kit key — '));
        const b = el('button', 'linkish accent', 'add a passkey'); b.type = 'button'; b.dataset.rekey = '1';
        signed.appendChild(b);
      } else signed.textContent = 'Passkey on this device';
    }
    const ss = byId('ss-signer'); if (ss) ss.textContent = CTX.recovery ? 'Recovery kit key' : 'Face ID / fingerprint on this device';
  }

  /* ---------------- the home screen ---------------- */
  function saveLast(model, at) {
    try { localStorage.setItem(LS_LAST, JSON.stringify({ at, model })); } catch (_) {}
  }
  function restoreLast(address) {
    try {
      const v = JSON.parse(localStorage.getItem(LS_LAST) || 'null');
      if (!v || !v.model || v.model.address !== address) return null;
      /* Same address on another network (or a demo server) is another wallet. */
      const net = CTX.cfg && CTX.cfg.network;
      if (net && v.model.network && v.model.network !== net) return null;
      if (CTX.cfg && !!v.model.demo !== !!CTX.cfg.demo) return null;
      return v;
    } catch (_) { return null; }
  }

  /** Called by app.js with the result of Portfolio.load(). A failed load
      keeps the last good numbers on screen and says when they are from. */
  function paintPortfolio(m) {
    if (!m) return;
    const note = byId('refresh-note');
    if (m.error) {
      if (CTX.model) {
        if (note) { note.hidden = false; note.textContent = `Could not refresh — showing balances from ${fmtTime(CTX.modelAt)}`; }
      } else {
        if (note) { note.hidden = false; note.textContent = 'Could not load balances — ' + m.error; }
        renderUnavailable();
      }
      return;
    }
    if (note) note.hidden = true;
    const at = Date.now();
    renderModel(m, at);
    if (m.address === CTX.address) saveLast(m, at);
    paintOffline();
  }

  function renderUnavailable() {
    const total = byId('total-usd');
    if (total) { total.textContent = ''; total.appendChild(el('span', 'amt', '—')); }
    const bal = byId('bal'); if (bal) bal.textContent = '—';
    const vb = byId('vhp-bal'); if (vb) vb.textContent = '—';
    const hn = byId('hero-note'); if (hn) { hn.hidden = false; hn.textContent = 'Balance unavailable right now'; }
    const list = byId('token-list');
    if (list) { list.textContent = ''; list.appendChild(tokenRow({ id: 'koin', symbol: sym(), name: 'Koin', amountText: '—', usdText: '—', unavailable: true })); }
  }

  function renderModel(m, at) {
    CTX.model = m; CTX.modelAt = at;
    const koin = m.koin || { id: 'koin', symbol: sym(), name: 'Koin', amountText: '—', usdText: '—', unavailable: true };
    const vhp = m.vhp || { id: 'vhp', symbol: 'VHP', name: 'Virtual Hash Power', amountText: '—', usdText: '—', unavailable: true };
    const hasUsd = m.totalUsd != null;

    /* hero label + tags */
    const label = byId('hero-label');
    if (label) {
      label.textContent = hasUsd ? 'Total balance' : 'Balance';
      if (m.demo || m.priceSource === 'sample') label.appendChild(el('span', 'tag warn', 'Sample prices'));
      else if (m.priceStale && m.priceAt) {
        const t = el('span', 'tag dim'); t.innerHTML = CLOCK + ' '; t.appendChild(document.createTextNode('as of ' + relTime(m.priceAt)));
        label.appendChild(t);
      }
    }
    /* the big number: dollars when known, otherwise the KOIN balance itself */
    const total = byId('total-usd');
    if (total) {
      total.textContent = '';
      if (hasUsd) total.appendChild(el('span', 'amt', m.totalUsdText));
      else {
        total.appendChild(el('span', 'amt', koin.amountText));
        total.appendChild(document.createTextNode(' '));
        total.appendChild(el('span', 'unit', koin.symbol || sym()));
      }
    }
    const hn = byId('hero-note');
    if (hn) {
      const text = koin.unavailable ? 'Balance unavailable right now'
        : m.partialTotal ? 'Some tokens are not priced'
        : (!hasUsd && !m.demo) ? 'USD price unavailable right now' : '';
      hn.hidden = !text; hn.textContent = text;
    }
    /* tiles */
    const bal = byId('bal'); if (bal) bal.textContent = koin.amountText;
    const bu = byId('bal-usd'); if (bu) bu.textContent = koin.usdText;
    const vb = byId('vhp-bal'); if (vb) vb.textContent = vhp.amountText;
    const vs = byId('vhp-sub');
    if (vs) {
      if (vhp.usd != null) vs.textContent = vhp.usdText;
      else if (m.vhpKoin != null && vhp.amount != null) vs.textContent = '≈ ' + Portfolio.fmtAmount(String(Number(vhp.amount) * m.vhpKoin), 2) + ' ' + sym();
      else vs.textContent = '—';
    }
    /* rows */
    const list = byId('token-list');
    if (list) {
      list.textContent = '';
      for (const r of [koin, vhp].concat(m.others || [])) {
        const row = tokenRow(r);
        const prev = lastSats[r.id];
        if (prev != null && r.sats != null && /^\d+$/.test(String(r.sats)) && /^\d+$/.test(String(prev)) && BigInt(r.sats) > BigInt(prev)) {
          row.classList.add('grew');
          setTimeout(() => row.classList.remove('grew'), 1300);
        }
        if (r.sats != null) lastSats[r.id] = String(r.sats);
        list.appendChild(row);
      }
    }
    /* send sheet helper + summary */
    const avail = byId('send-avail');
    if (avail) avail.textContent = 'Available ' + (koin.unavailable ? '—' : koin.amountText + ' ' + (koin.symbol || sym()));
    renderSendSummary();
    /* about */
    const ap = byId('about-prices');
    if (ap) {
      const src = String(m.priceSource || '');
      ap.textContent = src.startsWith('uniswap') ? 'Prices: on-chain — Uniswap vKOIN/USDT · KoinDX koin/vhp'
        : src.startsWith('coingecko') ? 'Prices: CoinGecko'
        : src === 'sample' || m.demo ? 'Prices: sample (demo)'
        : 'Prices: unavailable';
    }
    /* an open token sheet follows the numbers */
    if (tokenOpen) {
      const fresh = [koin, vhp].concat(m.others || []).find((r) => r.id === tokenOpen.id);
      if (fresh) fillToken(fresh);
    }
  }

  function iconFor(r) {
    const i = el('span', 'icon');
    if (r.id === 'koin') { i.classList.add('koin'); i.textContent = 'K'; }
    else if (r.id === 'vhp') { i.classList.add('vhp'); i.textContent = 'V'; }
    else { i.classList.add('custom'); i.textContent = String(r.symbol || '?').replace(/[^0-9A-Za-z]/g, '').charAt(0).toUpperCase() || '?'; }
    return i;
  }

  function tokenRow(r) {
    const row = el('button', 'row'); row.type = 'button'; row.setAttribute('role', 'listitem'); row.dataset.id = r.id;
    row.appendChild(iconFor(r));
    const mid = el('span', 'mid');
    mid.appendChild(el('span', 't', r.symbol || '?'));
    const s = el('span', 's');
    if (r.unavailable) { s.classList.add('warn-text'); s.textContent = r.error ? r.error : 'Balance unavailable'; if (r.error) s.classList.add('bad-text'); }
    else {
      /* Price first: a long name gets the ellipsis, the number never does. */
      s.textContent = r.priceText ? r.priceText + ' · ' + (r.name || '') : (r.name || '');
      if (r.priceStale) { const c = document.createElement('span'); c.innerHTML = ' ' + CLOCK; s.appendChild(c); }
    }
    mid.appendChild(s);
    row.appendChild(mid);
    const right = el('span', 'right');
    right.appendChild(el('span', 'v num', r.amountText));
    right.appendChild(el('span', 'u', r.usdText));
    row.appendChild(right);
    row.setAttribute('aria-label', `${r.symbol || '?'}, ${r.amountText}, ${r.usdText}`);
    row.addEventListener('click', () => openToken(r));
    return row;
  }

  /* ---------------- token sheet ---------------- */
  function openToken(r) {
    tokenOpen = r;
    fillToken(r);
    openSheet('sheet-token');
  }
  function fillToken(r) {
    tokenOpen = r;
    const icon = byId('tok-icon');
    if (icon) { const i = iconFor(r); icon.className = 'icon ' + i.className.replace('icon ', ''); icon.textContent = i.textContent; }
    byId('tok-sym').textContent = r.symbol || '?';
    byId('tok-name').textContent = r.name || '';
    byId('tok-amount').textContent = (r.amountText || '—') + ' ' + (r.symbol || '');
    byId('tok-usd').textContent = r.usdText || '—';
    const price = byId('tok-price');
    const m = CTX.model || {};
    const mainnet = !m.network || m.network === 'mainnet';
    let ptext = '';
    if (r.id === 'koin') ptext = r.priceText ? `1 ${r.symbol} = ${r.priceText}` : 'Price unavailable';
    else if (r.id === 'vhp') {
      if (m.vhpKoin != null) ptext = `1 VHP ≈ ${Portfolio.fmtAmount(String(m.vhpKoin), 4)} ${sym()}` + (r.priceText ? ` · ${r.priceText}` : '');
      else ptext = mainnet ? 'Price unavailable' : 'Not priced on testnet';
    } else ptext = 'No price feed for this token';
    price.textContent = ptext;
    if (r.priceStale && m.priceAt) { const c = document.createElement('span'); c.innerHTML = ' ' + CLOCK + ' as of ' + relTime(m.priceAt); price.appendChild(c); }
    byId('tok-mana-row').hidden = r.id !== 'koin';
    const send = byId('btn-tok-send');
    send.disabled = r.id !== 'koin';
    byId('tok-send-note').hidden = r.id === 'koin';
    const cr = byId('tok-contract-row'), cb = byId('tok-contract');
    if (r.address) { cr.hidden = false; cb.textContent = shortAddr(r.address); cb.dataset.full = r.address; }
    else { cr.hidden = true; cb.textContent = ''; delete cb.dataset.full; }
    byId('tok-decimals').textContent = r.decimals != null ? String(r.decimals) : '—';
    byId('tok-network').textContent = netLabel();
    const ex = byId('tok-explorer');
    const href = explorerAddr(r.address);
    ex.hidden = !href; if (href) ex.href = href;
    byId('btn-tok-remove').hidden = !!r.native || r.id === 'koin' || r.id === 'vhp';
  }

  /* ---------------- protection (security tab + home line) ---------------- */
  function paintProtection(creds, recovery, active, loaded) {
    CTX.credentials = Array.isArray(creds) ? creds : [];
    CTX.credsLoaded = !!loaded;
    CTX.recovery = recovery || null;
    CTX.active = !!active;
    const list = CTX.credentials;
    const passkeys = list.filter((c) => c.kind !== 'recovery').length;
    const hasKit = list.some((c) => c.kind === 'recovery');
    const n = list.length;
    const single = loaded && n === 1 && !hasKit;

    const meter = byId('protect-meter');
    if (meter) {
      const segs = meter.querySelectorAll('span');
      const on = [passkeys >= 1, passkeys >= 2, hasKit];
      segs.forEach((s, i) => s.classList.toggle('on', !!(loaded && on[i])));
      meter.classList.toggle('warn', !!(single || recovery));
    }
    const title = byId('protect-title'), sub = byId('protect-sub');
    let t, s, cls;
    if (!loaded) { t = 'Checking your keys…'; s = 'Reading the sign-in methods registered on your account.'; cls = ''; }
    else if (recovery) { t = 'Recovery mode'; s = 'You are signed in with your kit key. Add a passkey to this device to get back to biometric sign-in.'; cls = 'warn'; }
    else if (single) { t = 'Basic protection'; s = 'One passkey is one point of failure. Add a second device or a recovery kit.'; cls = 'warn'; }
    else { t = 'Protected'; s = 'Any one of your sign-in methods opens this account.'; cls = 'good'; }
    if (title) { title.textContent = t; title.className = 'protect-title ' + cls; }
    if (sub) sub.textContent = s;

    const chk = (id, ok, todo) => { const b = byId(id); if (!b) return; b.classList.toggle('on', !!(loaded && ok)); b.classList.toggle('todo', !!(loaded && !ok && todo)); };
    chk('chk-passkey', passkeys >= 1, false);
    chk('chk-backup', passkeys >= 2, true);
    chk('chk-kit', hasKit, true);

    const line = byId('protect-line');
    if (line) {
      const dot = line.querySelector('.dot'), txt = line.querySelector('.protect-text');
      let state, text;
      if (!loaded) { state = ''; text = 'Checking your keys…'; }
      else if (recovery) { state = 'warn'; text = 'Recovery mode — add a passkey'; }
      else if (single) { state = 'warn'; text = 'Protected by 1 sign-in method — add a backup'; }
      else { state = 'good'; text = `Protected by ${n} sign-in methods`; }
      if (dot) dot.className = 'dot ' + state;
      if (txt) txt.textContent = text;
    }
    const tabdot = byId('tabdot-security');
    if (tabdot) {
      tabdot.hidden = !(loaded && (recovery || single));
      tabdot.classList.toggle('bad', !!recovery);
      tabdot.classList.toggle('warn', !recovery && !!single);
    }
    paintSigner();
  }

  /* ---------------- send sheet ---------------- */
  function renderSendSummary() {
    const toEl = byId('send-to'), amtEl = byId('send-amount'), sum = byId('sign-summary');
    if (!toEl || !amtEl || !sum) return;
    const to = toEl.value.trim(), amt = amtEl.value.trim();
    const chk = byId('send-to-check');
    if (chk) {
      if (!to) { chk.textContent = ''; chk.className = 'check'; }
      else if (typeof QR !== 'undefined' && QR.looksLikeAddress(to)) { chk.textContent = '✓ Looks like a Koinos address'; chk.className = 'check good'; }
      else { chk.textContent = 'Not a Koinos address yet'; chk.className = 'check warn'; }
    }
    const n = Number(amt);
    const priced = !!(CTX.model && CTX.model.koinUsd != null && /^\d+(\.\d+)?$/.test(amt) && n > 0);
    const usd = priced ? Portfolio.fmtUsd(n * CTX.model.koinUsd) : null;
    const su = byId('send-usd'); if (su) su.textContent = usd ? `· ≈ ${usd}` : '';
    if (!to || !amt) { sum.hidden = true; return; }
    sum.hidden = false;
    byId('ss-to').textContent = groups(to);
    byId('ss-amount').textContent = `${amt} ${sym()}` + (usd ? ` ≈ ${usd}` : '');
    byId('ss-signer').textContent = CTX.recovery ? 'Recovery kit key' : 'Face ID / fingerprint on this device';
    byId('ss-network').textContent = netLabel();
  }

  function paintOffline() {
    const off = navigator.onLine === false;
    const so = byId('send-offline'); if (so) so.hidden = !off;
    const on = byId('offline-note');
    if (on) {
      on.hidden = !off;
      if (off) on.textContent = CTX.modelAt ? `Offline — showing balances from ${fmtTime(CTX.modelAt)}` : 'Offline — balances will load when you reconnect';
    }
  }

  /* ---------------- receive sheet ---------------- */
  let qrTimer = null;
  async function renderReceiveQr() {
    const box = byId('receive-qr');
    if (!box || !CTX.address || typeof Receive === 'undefined') return;
    const amt = (byId('recv-amount') && byId('recv-amount').value.trim()) || '';
    const amount = /^\d+(\.\d+)?$/.test(amt) && Number(amt) > 0 ? amt : null;
    const key = CTX.address + '|' + (amount || '');
    if (key === lastQr) return;
    lastQr = key;
    box.classList.remove('fail');
    try { await Receive.render(box, CTX.address, { amount }); }
    catch (_) { lastQr = null; box.classList.add('fail'); box.textContent = 'QR unavailable — copy the address instead'; }
  }

  async function copyText(text, label) {
    if (!text) return;
    const ok = typeof Receive !== 'undefined' ? await Receive.copy(text) : false;
    if (ok) toast(label || 'Copied');
  }
  const flash = (node) => { if (!node) return; node.classList.add('flash'); setTimeout(() => node.classList.remove('flash'), 900); };

  /* ---------------- install / PWA ---------------- */
  function paintInstall() {
    const row = byId('install-row');
    if (!row) return;
    const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
    const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent) && !window.MSStream;
    row.hidden = standalone;
    byId('btn-install').hidden = !installPrompt;
    byId('ios-install-note').hidden = !(ios && !installPrompt);
    byId('install-generic').hidden = !!installPrompt || ios;
    const ready = byId('offline-ready');
    if (ready) ready.hidden = !(navigator.serviceWorker && navigator.serviceWorker.controller);
  }

  /* ---------------- wiring ---------------- */
  function init() {
    /* tabs */
    for (const t of TABS) { const b = byId('tabbtn-' + t.slice(4)); if (b) b.addEventListener('click', () => showTab(t)); }
    /* home actions */
    on('btn-open-receive', () => openSheet('sheet-receive'));
    on('btn-open-send', () => openSheet('sheet-send'));
    on('btn-open-buy', () => showTab('tab-convert'));
    on('btn-add-token', () => openSheet('sheet-add-token', { focus: '#add-token-addr' }));
    on('protect-line', () => showTab('tab-security'));
    on('addr-short', () => { copyText(CTX.address, 'Address copied'); flash(byId('addr-short')); });
    on('acct-addr', () => { copyText(CTX.address, 'Address copied'); flash(byId('acct-addr')); });
    on('btn-show-qr', () => openSheet('sheet-receive'));
    document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.goto)));
    /* token sheet */
    on('btn-tok-receive', () => openSheet('sheet-receive'));
    on('btn-tok-send', () => openSheet('sheet-send', { focus: '#send-amount' }));
    on('tok-contract', () => copyText(byId('tok-contract').dataset.full, 'Contract address copied'));
    on('btn-tok-remove', () => {
      const r = tokenOpen;
      if (!r || !r.address) return;
      Portfolio.removeToken(r.address);
      closeSheet();
      toast('Stopped tracking ' + (r.symbol || 'token'));
      if (CTX.refresh) CTX.refresh();
    });
    /* add token */
    on('btn-add-token-go', () => {
      const inp = byId('add-token-addr'), err = byId('add-token-err');
      try {
        Portfolio.addToken(inp.value);
        closeSheet();
        toast('Token added');
        if (CTX.refresh) CTX.refresh();
      } catch (e) { err.hidden = false; err.textContent = e.message || 'Could not add that token'; }
    });
    const addInp = byId('add-token-addr');
    if (addInp) addInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); byId('btn-add-token-go').click(); } });
    /* receive */
    on('btn-recv-copy', () => copyText(CTX.address, 'Address copied'));
    on('btn-recv-share', async () => {
      const r = await Receive.share(CTX.address);
      if (r === 'copied') toast('Copied — sharing is not available here');
    });
    on('recv-to-buy', (e) => { e.preventDefault(); closeSheet(); showTab('tab-convert'); });
    const ra = byId('recv-amount');
    if (ra) ra.addEventListener('input', () => {
      clearTimeout(qrTimer);
      const v = ra.value.trim();
      const note = byId('recv-amount-note');
      if (note) { note.hidden = !v; note.textContent = v ? `This code asks for ${v} ${sym()} — the sender can still change it.` : ''; }
      qrTimer = setTimeout(renderReceiveQr, 200);
    });
    /* send sheet: paste, summary, done */
    on('btn-paste', async () => {
      try {
        const text = (await navigator.clipboard.readText()).trim();
        const to = byId('send-to');
        to.value = text;
        to.dispatchEvent(new Event('input', { bubbles: true }));
        byId('send-amount').focus();
      } catch (_) { toast('Clipboard not available — paste with a long press'); }
    });
    const sendSheet = byId('sheet-send');
    if (sendSheet) {
      /* Values can change without an input event (Scan, Send all, the
         success path clearing the fields), so any interaction re-renders. */
      const later = () => setTimeout(renderSendSummary, 0);
      sendSheet.addEventListener('input', later);
      sendSheet.addEventListener('click', later);
      sendSheet.addEventListener('focusin', later);
      sendSheet.addEventListener('focusin', (e) => {
        if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) setTimeout(() => { try { e.target.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' }); } catch (_) {} }, 250);
      });
    }
    on('btn-send-done', () => closeSheet());
    const sendBtn = byId('btn-send'), gate = byId('send-gate');
    if (sendBtn && gate && window.MutationObserver) {
      const sync = () => { gate.hidden = !sendBtn.disabled; };
      new MutationObserver(sync).observe(sendBtn, { attributes: true, attributeFilter: ['disabled'] });
      sync();
    }
    const st = byId('send-status'), done = byId('btn-send-done');
    if (st && done && window.MutationObserver) {
      new MutationObserver(() => {
        done.hidden = !(st.className.includes('ok') && /^Sent/.test(st.textContent.trim()));
        renderSendSummary();
      }).observe(st, { attributes: true, childList: true, characterData: true, subtree: true, attributeFilter: ['class', 'hidden'] });
    }
    /* sheets: scrim, handles, X, Escape */
    const scrim = byId('scrim'); if (scrim) scrim.addEventListener('click', () => closeSheet());
    document.addEventListener('click', (e) => {
      const c = e.target.closest && e.target.closest('[data-close]');
      if (c && sheetEl && sheetEl.contains(c)) closeSheet();
      const rk = e.target.closest && e.target.closest('[data-rekey]');
      if (rk) { const b = byId('btn-rekey'); if (b) b.click(); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Escape') {
        if (document.querySelector('.qr-overlay')) return;   // the scanner owns Escape while it is up
        if (sheetEl) { e.preventDefault(); closeSheet(); }
        return;
      }
      /* Tab stays inside an open sheet (it is a modal dialog). */
      if (e.key === 'Tab' && sheetEl && !document.querySelector('.qr-overlay')) {
        const items = [...sheetEl.querySelectorAll('button, [href], input, textarea, select, summary, [tabindex]:not([tabindex="-1"])')]
          .filter((n) => !n.disabled && !n.hidden && n.offsetParent !== null && !n.closest('[hidden]'));
        if (!items.length) { e.preventDefault(); sheetEl.focus(); return; }
        const first = items[0], last = items[items.length - 1], cur = document.activeElement;
        if (!sheetEl.contains(cur)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
        else if (e.shiftKey && cur === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
      }
    });
    /* Arrow keys move between tabs, as a tablist should. */
    const bar = byId('tabbar');
    if (bar) bar.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      const i = TABS.indexOf(currentTab);
      const next = e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'Home' ? 0 : TABS.length - 1;
      e.preventDefault();
      showTab(TABS[next]);
      const b = byId('tabbtn-' + TABS[next].slice(4)); if (b) b.focus();
    });
    /* checklist rows */
    on('chk-backup', () => { const b = byId('btn-add-passkey'); if (b && !b.hidden && !byId('chk-backup').classList.contains('on')) { b.scrollIntoView({ block: 'center' }); b.click(); } });
    on('chk-kit', () => { const b = byId('btn-make-kit'); if (b && !b.hidden && !byId('chk-kit').classList.contains('on')) { b.scrollIntoView({ block: 'center' }); b.click(); } });
    /* install prompt */
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; paintInstall(); });
    window.addEventListener('appinstalled', () => { installPrompt = null; paintInstall(); });
    on('btn-install', async () => {
      if (!installPrompt) return;
      try { installPrompt.prompt(); await installPrompt.userChoice; } catch (_) {}
      installPrompt = null; paintInstall();
    });
    if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('controllerchange', paintInstall);
    /* offline */
    window.addEventListener('online', () => { paintOffline(); if (CTX.refresh) CTX.refresh(); });
    window.addEventListener('offline', paintOffline);
    paintProtection([], null, false, false);
    paintInstall();
  }
  function on(id, fn) { const n = byId(id); if (n) n.addEventListener('click', fn); }

  init();

  return {
    showTab, openSheet, closeSheet, toast, onView, applyIntent, setContext,
    paintPortfolio, paintProtection, renderSendSummary, decorateAddr, openToken,
    currentTab: () => currentTab, openSheetId: () => (sheetEl ? sheetEl.id : null),
  };
})();
