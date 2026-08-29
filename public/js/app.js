/* Koinos Bio Wallet — the Veive smart-account app. One button in:
   a new passkey mints a REAL smart account on-chain (server-bootstrapped,
   mana-sponsored); the same scan signs you back in anywhere the passkey
   syncs. Sends are authorized by WebAuthn assertions the CHAIN verifies. */
'use strict';

(async () => {
  const $ = (s) => document.querySelector(s);
  const LS_ADDR = 'bw_smart_addr';

  let ADDRESS = null;      // the smart account (a contract address)
  let ACTIVE = false;      // bootstrap finished — sends unlocked
  let POLL = null;

  const storeAddr = (a) => { try { a ? localStorage.setItem(LS_ADDR, a) : localStorage.removeItem(LS_ADDR); } catch (_) {} };
  const storedAddr = () => { try { return localStorage.getItem(LS_ADDR); } catch (_) { return null; } };

  /* ---------------- api ---------------- */
  async function api(path, body) {
    const r = await fetch(path, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : undefined);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || 'request failed'); e.status = r.status; throw e; }
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

  /* Activation banner + send gating: a fresh account exists the moment the
     passkey does, but sends unlock when the contract is live on-chain. */
  function setStep(step, error) {
    ACTIVE = step === 'active';
    const box = $('#activation');
    const send = $('#btn-send');
    if (ACTIVE) { box.hidden = true; send.disabled = false; stopPoll(); return; }
    box.hidden = false;
    send.disabled = true;
    box.className = 'status' + (step === 'conflict' || error ? ' err' : '');
    box.textContent =
      step === 'conflict' ? 'This account answers to a different passkey — sign in with that one.' :
      error ? 'Setup hit a snag — retrying: ' + error :
      'Your smart account is being written on-chain (a real contract, mana-sponsored) — sends unlock in a minute…';
  }
  function stopPoll() { if (POLL) { clearInterval(POLL); POLL = null; } }
  function pollStatus() {
    stopPoll();
    const id = Passkey.storedId();
    if (!id) return;
    POLL = setInterval(async () => {
      try {
        const st = await api('/api/account-status?credentialId=' + encodeURIComponent(id));
        setStep(st.step, st.error);
        if (st.step === 'active') paint();
        if (st.step === 'conflict') stopPoll();
      } catch (_) {}
    }, 3000);
  }

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
    if (e && e.name === 'InvalidStateError') return 'This device already holds an account passkey — signing you in…';
    return (e && e.message) || 'Passkey ceremony failed';
  }

  async function signIn() {
    const credentialId = await Passkey.identify();
    const who = await api('/api/whoami', { credentialId });
    ADDRESS = who.address; storeAddr(ADDRESS);
    setStep(who.step, who.error);
    if (who.step !== 'active') pollStatus();
    show(true);
  }

  async function createAccount() {
    let made;
    try { made = await Passkey.createCredential(); }
    catch (e) {
      if (e && e.name === 'InvalidStateError') return signIn(); // this device already has our passkey
      throw e;
    }
    const rec = await api('/api/create-account', {
      credentialId: made.credentialId, publicKey: made.publicKey, name: 'passkey',
    });
    ADDRESS = rec.address; storeAddr(ADDRESS);
    setStep(rec.step, rec.error);
    if (rec.step !== 'active') pollStatus();
    show(true);
  }

  async function enter(create) {
    go.disabled = true;
    try {
      if (create) await createAccount();
      else await signIn();
    } catch (e) {
      if (e.status === 404) {
        /* A passkey with no account behind it (never bootstrapped) can't be
           adopted — its public key was only available at creation. Let the
           next tap mint a fresh one. */
        Passkey.forget(); storeAddr(null);
        alertLine('That passkey has no smart account here — tap the button to create a fresh one.');
      } else alertLine(friendly(e));
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
    if (!ADDRESS) return;
    $('#addr').textContent = ADDRESS;
    try {
      const a = await api('/api/account?address=' + encodeURIComponent(ADDRESS)
        + '&credentialId=' + encodeURIComponent(Passkey.storedId() || ''));
      $('#bal').textContent = Number(a.koin || 0).toLocaleString('en-US', { maximumFractionDigits: 8 });
      $('#mana').textContent = Number(a.mana || 0).toFixed(2);
      if (a.smart) setStep(a.smart.step, a.smart.error);
    } catch (_) {
      $('#bal').textContent = '—'; $('#mana').textContent = '—';
    }
  }
  setInterval(() => { if (!$('#view-wallet').hidden) paint(); }, 30000);

  $('#addr').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(ADDRESS || ''); $('#addr').style.borderColor = 'var(--good)'; }
    catch (_) { window.prompt('Copy your address:', ADDRESS || ''); }
    setTimeout(() => { $('#addr').style.borderColor = ''; }, 900);
  });

  /* Send — prepare on the server, sign with the passkey (the challenge IS
     the transaction id), the chain verifies the assertion itself. */
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
      const prep = await api('/api/prepare', { address: ADDRESS, to, amount });
      say('Confirm with your passkey — it signs the transaction id itself…');
      const a = await Passkey.assert(WebauthnWire.challengeForTxId(prep.tx.id), [Passkey.storedId()]);
      const blob = WebauthnWire.packSignatureBlob(a);
      say('Broadcasting — the chain verifies your passkey on-chain…');
      const r = await api('/api/submit', { ref: prep.ref, transaction: { ...prep.tx, signatures: [blob] } });
      say('Sent ✓ ' + (r.explorer
        ? `— <a href="${r.explorer}" target="_blank" rel="noopener">view it on-chain ↗</a>`
        : (r.demo ? `(demo transaction ${r.txid.slice(0, 14)}…)` : '')), 'ok');
      $('#send-to').value = ''; $('#send-amount').value = '';
      paint();
    } catch (e) {
      say(e.name === 'NotAllowedError' ? 'Passkey prompt closed — nothing was sent' : (e.message || 'Send failed'), 'err');
    } finally {
      btn.disabled = ACTIVE ? false : true;
    }
  });

  $('#btn-signout').addEventListener('click', () => {
    if (!confirm('Sign out?\n\nYour passkey re-opens this account with one scan — nothing is lost.')) return;
    stopPoll();
    ADDRESS = null; ACTIVE = false;
    storeAddr(null); Passkey.forget();
    try { localStorage.removeItem('bw_wif'); localStorage.removeItem('bw_passkey_id'); } catch (_) {} // v1 leftovers
    show(false);
    $('#alt-unlock').hidden = false;
  });

  /* ---------------- resume ---------------- */
  if (storedAddr() && Passkey.remembered()) {
    ADDRESS = storedAddr();
    setStep('pending');
    pollStatus();
    show(true);
  } else {
    show(false);
  }
})();
