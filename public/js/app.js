/* Koinos Bio Wallet — the whole app. One button in, then a plain wallet:
   address, balances, sponsored send, key export. The key lives in
   localStorage between visits and is ALWAYS re-derivable from the passkey. */
'use strict';

(async () => {
  const $ = (s) => document.querySelector(s);
  const LS_WIF = 'bw_wif';

  /* ---------------- tiny wallet core ---------------- */
  let signer = null;
  function loadKey() {
    if (signer) return true;
    let wif = null;
    try { wif = localStorage.getItem(LS_WIF); } catch (_) {}
    if (!wif) return false;
    try { signer = Signer.fromWif(wif); return true; } catch (_) { return false; }
  }
  function adoptWif(wif) {
    try { localStorage.setItem(LS_WIF, wif); } catch (_) {}
    signer = Signer.fromWif(wif);
    return signer.getAddress();
  }
  const address = () => (loadKey() ? signer.getAddress() : null);
  async function proof(action) {
    const ts = Date.now();
    const sig = await signer.signMessage(`koinos-bio-wallet:${action}:${ts}`);
    return { address: signer.getAddress(), ts, sig: btoa(String.fromCharCode(...sig)) };
  }

  /* ---------------- api ---------------- */
  async function api(path, body) {
    const r = await fetch(path, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : undefined);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'request failed');
    return data;
  }

  /* ---------------- boot ---------------- */
  let cfg = null;
  try { cfg = await api('/api/config'); } catch (_) { cfg = { demo: true, nativeSymbol: 'KOIN' }; }
  if (cfg.rpId) Passkey.setRpId(cfg.rpId);
  const badge = $('#net-badge');
  if (cfg.demo) { badge.textContent = 'demo'; badge.classList.add('demo'); $('#demo-note').hidden = false; }
  else badge.textContent = cfg.testnet ? (cfg.networkLabel || '').replace('Koinos ', '') : 'mainnet';
  $('#sym').textContent = cfg.nativeSymbol || 'KOIN';
  $('#sym2').textContent = cfg.nativeSymbol || 'KOIN';

  const show = (wallet) => {
    $('#view-landing').hidden = wallet;
    $('#view-wallet').hidden = !wallet;
    $('#btn-signout').hidden = !wallet;
    if (wallet) paint();
  };

  /* ---------------- landing: THE button ---------------- */
  const go = $('#btn-go');
  const ready = await Passkey.platformReady();
  if (!ready) {
    go.disabled = true;
    $('#no-passkey').hidden = false;
  } else if (!Passkey.remembered()) {
    $('#alt-unlock').hidden = false;
  }

  function friendly(e) {
    if (e && e.name === 'NotAllowedError') return 'Prompt closed — nothing changed';
    if (e && e.name === 'InvalidStateError') return 'This device already holds a wallet passkey — signing you in…';
    return (e && e.message) || 'Passkey ceremony failed';
  }

  async function enter(create) {
    go.disabled = true;
    try {
      let wif;
      if (create) {
        try { wif = await Passkey.create(); }
        catch (e) {
          /* The device already has our passkey (cleared browser data) —
             fall through to a sign-in with it instead of failing. */
          if (e && e.name === 'InvalidStateError') wif = await Passkey.unlock();
          else throw e;
        }
      } else {
        wif = await Passkey.unlock();
      }
      adoptWif(wif);
      show(true);
    } catch (e) {
      alertLine(friendly(e));
    } finally {
      go.disabled = false;
    }
  }

  go.addEventListener('click', () => enter(!Passkey.remembered()));
  $('#btn-unlock-existing').addEventListener('click', (e) => { e.preventDefault(); enter(false); });

  let alertEl = null;
  function alertLine(msg) {
    if (!alertEl) {
      alertEl = document.createElement('p');
      alertEl.className = 'note';
      go.insertAdjacentElement('afterend', alertEl);
    }
    alertEl.textContent = msg;
  }

  /* ---------------- wallet view ---------------- */
  async function paint() {
    const addr = address();
    if (!addr) return;
    $('#addr').textContent = addr;
    try {
      const a = await api('/api/account?address=' + encodeURIComponent(addr));
      $('#bal').textContent = Number(a.koin || 0).toLocaleString('en-US', { maximumFractionDigits: 8 });
      $('#mana').textContent = Number(a.mana || 0).toFixed(2);
    } catch (_) {
      $('#bal').textContent = '—'; $('#mana').textContent = '—';
    }
  }
  setInterval(() => { if (!$('#view-wallet').hidden) paint(); }, 30000);

  $('#addr').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(address() || ''); $('#addr').style.borderColor = 'var(--good)'; }
    catch (_) { window.prompt('Copy your address:', address() || ''); }
    setTimeout(() => { $('#addr').style.borderColor = ''; }, 900);
  });

  /* Send — the mana-shared co-sign round-trip. */
  $('#btn-send').addEventListener('click', async () => {
    const btn = $('#btn-send'), st = $('#send-status');
    const to = $('#send-to').value.trim();
    const amount = $('#send-amount').value.trim();
    const say = (msg, cls) => { st.hidden = false; st.className = 'status' + (cls ? ' ' + cls : ''); st.innerHTML = msg; };
    if (!to) { say('Paste a destination address', 'err'); return; }
    if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) { say('Amount must be a positive number', 'err'); return; }
    btn.disabled = true;
    try {
      say('Preparing the exact transaction — the sharer pays the mana…');
      const p = await proof('transfer');
      const prep = await api('/api/prepare', { ...p, to, amount });
      say('Signing with your key — locally…');
      const signed = prep.demo ? { id: 'demo' } : await signer.signTransaction(prep.tx);
      say('Broadcasting…');
      const r = await api('/api/submit', { ref: prep.ref, transaction: signed });
      say('Sent ✓ ' + (r.explorer
        ? `— <a href="${r.explorer}" target="_blank" rel="noopener">view it on-chain ↗</a>`
        : (r.demo ? `(demo transaction ${r.txid.slice(0, 14)}…)` : '')), 'ok');
      $('#send-to').value = ''; $('#send-amount').value = '';
      paint();
    } catch (e) {
      say(e.message || 'Send failed', 'err');
    } finally {
      btn.disabled = false;
    }
  });

  /* Export + sign out. */
  $('#btn-export').addEventListener('click', () => {
    const box = $('#wif');
    if (!box.hidden) { box.hidden = true; $('#btn-export').textContent = 'Reveal private key'; return; }
    if (!confirm('Reveal your private key?\n\nAnyone who sees it controls the wallet. Only do this to import into another wallet app.')) return;
    let wif = null;
    try { wif = localStorage.getItem(LS_WIF); } catch (_) {}
    box.textContent = wif || '—';
    box.hidden = false;
    $('#btn-export').textContent = 'Hide private key';
  });

  $('#btn-signout').addEventListener('click', () => {
    if (!confirm('Sign out?\n\nYour passkey re-creates this wallet with one scan — nothing is lost.')) return;
    try { localStorage.removeItem(LS_WIF); } catch (_) {}
    signer = null;
    $('#wif').hidden = true; $('#btn-export').textContent = 'Reveal private key';
    show(false);
    if (Passkey.remembered()) $('#alt-unlock').hidden = true;
  });

  /* ---------------- go ---------------- */
  show(!!address());
})();
