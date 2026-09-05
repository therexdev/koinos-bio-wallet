/* Koinos Bio Wallet — the Veive smart-account app. One button in:
   a new passkey mints a REAL smart account on-chain (server-bootstrapped,
   mana-sponsored); the same scan signs you back in anywhere the passkey
   syncs. Sends are authorized by WebAuthn assertions the CHAIN verifies.
   Backups: extra passkeys and a downloadable recovery kit are simply more
   credentials registered on the account — any of them can sign. */
'use strict';

(async () => {
  const $ = (s) => document.querySelector(s);
  const LS_ADDR = 'bw_smart_addr';

  let ADDRESS = null;      // the smart account (a contract address)
  let ACTIVE = false;      // bootstrap finished — sends unlocked
  let CREDENTIALS = [];    // [{id, label, kind, ts}] — this account's keys
  let RECOVERY = null;     // {credentialId, privateKey} while in recovery mode
  let PENDING_BACKUP = null; // a captured-but-unregistered backup passkey
  let BALANCE_SATS = '';   // the chain's own integer balance, for "Send all"

  /* ---------------- installable ----------------
     The service worker makes the wallet open offline and installable. It
     never touches /api, so nothing about balances or signing changes. */
  if ('serviceWorker' in navigator && (window.isSecureContext || location.hostname === 'localhost')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    });
  }
  let PENDING_KIT = null;    // a generated-but-unregistered recovery kit
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

  const VIEWS = ['#view-landing', '#view-wallet', '#view-recover'];
  const show = (view) => {
    for (const v of VIEWS) $(v).hidden = v !== view;
    $('#btn-signout').hidden = view !== '#view-wallet';
    if (view === '#view-wallet') { paint(); Fund.refresh(); }
    else Fund.stop();
    if (view === '#view-landing') refreshLandingSupport(); // support can change (recovery adds a passkey)
  };

  function takeSmart(smart) {
    if (!smart) return;
    if (Array.isArray(smart.credentials)) { CREDENTIALS = smart.credentials; renderCredentials(); }
    if (smart.step) setStep(smart.step, smart.error);
  }

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
        takeSmart(st);
        if (st.step === 'active') paint();
        if (st.step === 'conflict') stopPoll();
      } catch (_) {}
    }, 3000);
  }

  /* ---------------- signing (the one place a transaction gets signed) ----------------
     Recovery mode signs with the kit's software key; otherwise any of the
     account's passkeys — the chain accepts every registered credential. */
  async function signPrepared(tx) {
    if (RECOVERY) {
      const a = await Recovery.signTx(RECOVERY.privateKey, RECOVERY.credentialId, tx.id);
      return WebauthnWire.packSignatureBlob(a);
    }
    const allow = CREDENTIALS.filter((c) => c.kind === 'passkey').map((c) => c.id);
    const a = await Passkey.assert(WebauthnWire.challengeForTxId(tx.id), allow.length ? allow : [Passkey.storedId()]);
    return WebauthnWire.packSignatureBlob(a);
  }

  /* ---------------- landing: THE button ---------------- */
  const go = $('#btn-go');
  async function refreshLandingSupport() {
    const ok = await Passkey.platformReady();
    go.disabled = !ok;
    $('#no-passkey').hidden = ok;
    if (ok && !Passkey.remembered()) $('#alt-unlock').hidden = false;
  }
  await refreshLandingSupport();

  function friendly(e) {
    if (e && e.name === 'NotAllowedError') return 'Prompt closed — nothing changed';
    if (e && e.name === 'InvalidStateError') return 'This device already holds an account passkey — signing you in…';
    return (e && e.message) || 'Passkey ceremony failed';
  }

  async function signIn() {
    const credentialId = await Passkey.identify();
    const who = await api('/api/whoami', { credentialId });
    ADDRESS = who.address; storeAddr(ADDRESS);
    RECOVERY = null;
    takeSmart(who);
    if (who.step !== 'active') pollStatus();
    show('#view-wallet');
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
    RECOVERY = null;
    takeSmart(rec);
    if (rec.step !== 'active') pollStatus();
    show('#view-wallet');
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
  $('#btn-open-recover').addEventListener('click', (e) => { e.preventDefault(); show('#view-recover'); });
  $('#btn-recover-back').addEventListener('click', (e) => { e.preventDefault(); show('#view-landing'); });

  let alertEl = null;
  function alertLine(msg) {
    if (!alertEl) {
      alertEl = document.createElement('p');
      alertEl.className = 'note';
      go.insertAdjacentElement('afterend', alertEl);
    }
    alertEl.textContent = msg;
  }

  /* ---------------- recovery flow ---------------- */
  $('#btn-recover').addEventListener('click', async () => {
    const st = $('#recover-status');
    const say = (m, cls) => { st.hidden = false; st.className = 'status' + (cls ? ' ' + cls : ''); st.textContent = m; };
    const kit = Recovery.parseKit($('#kit-input').value);
    if (!kit) { say('That doesn\'t look like a recovery kit — paste the whole file, including the Credential and Key lines.', 'err'); return; }
    try {
      await Recovery.signTx(kit.privateKey, kit.credentialId, '0x1220' + '00'.repeat(32)); // key sanity check
    } catch (_) { say('The Key line is damaged — check the file.', 'err'); return; }
    try {
      const who = await api('/api/whoami', { credentialId: kit.credentialId });
      ADDRESS = who.address; storeAddr(ADDRESS);
      RECOVERY = { credentialId: kit.credentialId, privateKey: kit.privateKey };
      takeSmart(who);
      $('#kit-input').value = '';
      show('#view-wallet');
      renderCredentials();
    } catch (e) {
      say(e.status === 404
        ? 'No account answers to this kit. Was it activated? (The kit only works after "activate on-chain".)'
        : (e.message || 'Recovery failed'), 'err');
    }
  });

  /* ---------------- wallet view ---------------- */
  async function paint() {
    if (!ADDRESS) return;
    $('#addr').textContent = ADDRESS;
    try {
      const credParam = RECOVERY ? RECOVERY.credentialId : (Passkey.storedId() || '');
      const a = await api('/api/account?address=' + encodeURIComponent(ADDRESS)
        + '&credentialId=' + encodeURIComponent(credParam));
      BALANCE_SATS = String(a.koinSats == null ? '' : a.koinSats);
      $('#bal').textContent = Number(a.koin || 0).toLocaleString('en-US', { maximumFractionDigits: 8 });
      $('#mana').textContent = Number(a.mana || 0).toFixed(2);
      takeSmart(a.smart);
    } catch (_) {
      BALANCE_SATS = '';
      $('#bal').textContent = '—'; $('#mana').textContent = '—';
    }
  }
  setInterval(() => { if (!$('#view-wallet').hidden) paint(); }, 30000);

  $('#addr').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(ADDRESS || ''); $('#addr').style.borderColor = 'var(--good)'; }
    catch (_) { window.prompt('Copy your address:', ADDRESS || ''); }
    setTimeout(() => { $('#addr').style.borderColor = ''; }, 900);
  });

  /* ---------------- backups card ---------------- */
  function renderCredentials() {
    const list = $('#cred-list');
    list.innerHTML = '';
    for (const c of CREDENTIALS) {
      const li = document.createElement('li');
      const kind = c.kind === 'recovery' ? 'recovery kit' : 'passkey';
      const current = (RECOVERY && c.id === RECOVERY.credentialId) || (!RECOVERY && c.id === Passkey.storedId());
      li.innerHTML = '<span class="cred-kind ' + (c.kind || 'passkey') + '">' + kind + '</span> '
        + '<span class="cred-label"></span>'
        + (current ? ' <span class="cred-now">— in use here</span>' : '')
        + (c.ts ? ' <span class="cred-ts">' + new Date(c.ts).toLocaleDateString() + '</span>' : '');
      li.querySelector('.cred-label').textContent = c.label || 'passkey';
      list.appendChild(li);
    }
    const hasKit = CREDENTIALS.some((c) => c.kind === 'recovery');
    $('#kit-armed').hidden = !hasKit;
    const full = CREDENTIALS.length >= 6;
    $('#btn-add-passkey').hidden = full || !!PENDING_BACKUP;
    $('#btn-make-kit').hidden = full || !!PENDING_KIT;
    $('#recovery-banner').hidden = !RECOVERY;
    const single = CREDENTIALS.length === 1 && !hasKit;
    $('#backup-nudge').hidden = !single || !ACTIVE;
  }

  const bsay = (m, cls) => { const st = $('#backup-status'); st.hidden = !m; st.className = 'status' + (cls ? ' ' + cls : ''); st.innerHTML = m || ''; };

  /** Register one more credential on the account: prepare on the server,
      sign with a CURRENT credential, submit; the chain checks the rest. */
  async function registerCredential(newCred, progressLabel) {
    bsay(progressLabel + ' — preparing the transaction…');
    const signerId = RECOVERY ? RECOVERY.credentialId : Passkey.storedId();
    const prep = await api('/api/prepare-register', {
      address: ADDRESS, signerCredentialId: signerId, newCredential: newCred,
    });
    bsay(progressLabel + ' — confirm with your ' + (RECOVERY ? 'recovery key' : 'passkey') + '…');
    const blob = await signPrepared(prep.tx);
    bsay(progressLabel + ' — writing it on-chain…');
    const r = await api('/api/submit', { ref: prep.ref, transaction: { ...prep.tx, signatures: [blob] } });
    takeSmart(r.smart);
    return r;
  }

  /* Adding a backup passkey is two deliberate ceremonies: first the NEW
     authenticator creates its credential (pick a security key or another
     device), then the CURRENT passkey signs the registration. */
  $('#btn-add-passkey').addEventListener('click', async () => {
    const btn = $('#btn-add-passkey');
    btn.disabled = true;
    try {
      const made = await Passkey.createBackupCredential(CREDENTIALS.map((c) => c.id));
      PENDING_BACKUP = made;
      $('#backup-box').hidden = false;
      btn.hidden = true;
      bsay('');
    } catch (e) {
      bsay(e.name === 'InvalidStateError' ? 'That authenticator already holds a passkey for this account — use a different device or a security key.'
        : e.name === 'NotAllowedError' ? 'Prompt closed — nothing changed.'
        : (e.message || 'Could not create the backup passkey'), 'err');
    } finally { btn.disabled = false; }
  });
  $('#btn-backup-activate').addEventListener('click', async () => {
    if (!PENDING_BACKUP) return;
    const btn = $('#btn-backup-activate');
    btn.disabled = true;
    try {
      await registerCredential(
        { credentialId: PENDING_BACKUP.credentialId, publicKey: PENDING_BACKUP.publicKey, kind: 'passkey', label: 'backup passkey' },
        'Adding backup passkey');
      PENDING_BACKUP = null;
      $('#backup-box').hidden = true;
      bsay('Backup passkey added ✓ — it opens this account even if the first one is gone.', 'ok');
    } catch (e) {
      bsay(e.name === 'NotAllowedError' ? 'Prompt closed — the backup is not active yet; confirm with your current passkey to finish.'
        : (e.message || 'Could not add the passkey'), 'err');
    } finally {
      btn.disabled = false;
      renderCredentials();
    }
  });
  $('#btn-backup-cancel').addEventListener('click', () => {
    PENDING_BACKUP = null;
    $('#backup-box').hidden = true;
    renderCredentials();
    bsay('Backup discarded — nothing was registered.', '');
  });

  /* The kit: generate → the user SAVES it → only then register on-chain.
     Never the other way around — a registered key nobody saved is a lie. */
  $('#btn-make-kit').addEventListener('click', async () => {
    try {
      const k = await Recovery.generate();
      PENDING_KIT = { ...k, address: ADDRESS };
      Recovery.downloadKit(PENDING_KIT);
      $('#kit-text').textContent = Recovery.kitText(PENDING_KIT);
      $('#kit-box').hidden = false;
      $('#btn-make-kit').hidden = true;
      bsay('');
    } catch (e) { bsay(e.message || 'Could not generate a key', 'err'); }
  });
  $('#btn-kit-activate').addEventListener('click', async () => {
    if (!PENDING_KIT) return;
    const btn = $('#btn-kit-activate');
    btn.disabled = true;
    try {
      await registerCredential(
        { credentialId: PENDING_KIT.credentialId, publicKey: PENDING_KIT.publicKey, kind: 'recovery', label: 'recovery kit' },
        'Activating your kit');
      $('#kit-box').hidden = true;
      $('#kit-text').textContent = '';
      PENDING_KIT = null;
      bsay('Recovery kit active ✓ — the saved file now opens this account all by itself. Keep it offline.', 'ok');
    } catch (e) {
      bsay((e.message || 'Activation failed') + ' — your downloaded kit is not active yet; try again.', 'err');
      btn.disabled = false;
    }
  });
  $('#btn-kit-cancel').addEventListener('click', () => {
    PENDING_KIT = null;
    $('#kit-box').hidden = true; $('#kit-text').textContent = '';
    $('#btn-make-kit').hidden = CREDENTIALS.length >= 6;
    bsay('Kit discarded — nothing was registered. Delete the downloaded file.', '');
  });

  /* Recovery mode's way back to normal: mint a fresh passkey ON this device
     and register it with the kit key. */
  $('#btn-rekey').addEventListener('click', async () => {
    const btn = $('#btn-rekey');
    btn.disabled = true;
    try {
      const made = await Passkey.createCredential();
      await registerCredential(
        { credentialId: made.credentialId, publicKey: made.publicKey, kind: 'passkey', label: 'passkey' },
        'Adding a new passkey');
      RECOVERY = null;
      renderCredentials();
      bsay('New passkey registered ✓ — you\'re out of recovery mode; the button on the front page signs you in again.', 'ok');
    } catch (e) {
      bsay(e.name === 'NotAllowedError' ? 'Prompt closed — still in recovery mode.' : (e.message || 'Could not add the passkey'), 'err');
    } finally { btn.disabled = false; }
  });

  /* Send — prepare on the server, sign with the passkey (the challenge IS
     the transaction id) or the recovery key, the chain verifies either. */
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
      say(RECOVERY ? 'Signing with your recovery key…' : 'Confirm with your passkey — it signs the transaction id itself…');
      const blob = await signPrepared(prep.tx);
      say('Broadcasting — the chain verifies the signature on-chain…');
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

  /* ---------------- scan a QR code ----------------
     Typing an address by hand is how money goes to the wrong place. */
  $('#btn-scan').addEventListener('click', async () => {
    const btn = $('#btn-scan'), st = $('#send-status');
    const say = (msg, cls) => { st.hidden = false; st.className = 'status' + (cls ? ' ' + cls : ''); st.textContent = msg; };
    btn.disabled = true;
    try {
      const hit = await QR.scan();
      if (!hit) return;                          // cancelled — say nothing
      if (!QR.looksLikeAddress(hit.address)) {
        return say('That code is not a Koinos address: ' + hit.address.slice(0, 42), 'err');
      }
      $('#send-to').value = hit.address;
      /* A payment QR can carry the amount too; taking it saves retyping a
         number that was already in the code. */
      if (hit.amount) $('#send-amount').value = hit.amount;
      say('Scanned ✓ ' + hit.address + (hit.amount ? ` · ${hit.amount} KOIN` : ''), 'ok');
      ($('#send-amount').value ? $('#btn-send') : $('#send-amount')).focus();
    } catch (e) {
      say(e.message || 'Could not open the camera', 'err');
    } finally {
      btn.disabled = false;
    }
  });

  /** The whole balance, to the satoshi.

      Formatted from the chain's own integer rather than the displayed
      number: a float rounds, and "all" that leaves dust behind — or asks for
      more than exists — is not all. Mana is sponsored here, so nothing has
      to be held back for a fee. */
  function sendAllAmount() {
    const sats = BigInt(/^\d+$/.test(BALANCE_SATS) ? BALANCE_SATS : '0');
    if (sats <= 0n) return null;
    const whole = sats / 100000000n;
    const frac = String(sats % 100000000n).padStart(8, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : String(whole);
  }

  $('#btn-send-all').addEventListener('click', () => {
    const st = $('#send-status');
    const all = sendAllAmount();
    if (!all) {
      st.hidden = false; st.className = 'status err';
      st.textContent = BALANCE_SATS === '' ? 'Balance is still loading — try again in a moment' : 'There is no KOIN in this account yet';
      return;
    }
    $('#send-amount').value = all;
    $('#send-to').value.trim() ? $('#btn-send').focus() : $('#send-to').focus();
  });

  $('#btn-signout').addEventListener('click', () => {
    if (!confirm('Sign out?\n\nYour passkey (or recovery kit) re-opens this account — nothing is lost.')) return;
    stopPoll();
    ADDRESS = null; ACTIVE = false; RECOVERY = null; CREDENTIALS = []; PENDING_KIT = null; PENDING_BACKUP = null;
    /* The credential id stays remembered: it's public on-chain anyway, the
       biometric still gates every ceremony, and forgetting it would make the
       next tap CREATE a second account instead of signing back in. */
    storeAddr(null);
    try { localStorage.removeItem('bw_wif'); localStorage.removeItem('bw_passkey_id'); } catch (_) {} // v1 leftovers
    show('#view-landing');
    $('#alt-unlock').hidden = false;
  });

  /* ---------------- fund card ---------------- */
  Fund.mount({
    api,
    signPrepared,
    credentialId: () => (RECOVERY ? RECOVERY.credentialId : Passkey.storedId()),
    onKoinMoved: paint,
  });

  /* ---------------- resume ---------------- */
  if (storedAddr() && Passkey.remembered()) {
    ADDRESS = storedAddr();
    setStep('pending');
    pollStatus();
    show('#view-wallet');
  } else {
    show('#view-landing');
  }
})();
