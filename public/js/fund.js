/* Fund with ETH / USDC / USDT — the wallet face of the two-route
   ETH→KOIN pipeline. The server drives the Ethereum legs from the
   account's transit deposit address; this card shows the address, live
   balances and route quotes, runs the one-click swap, and prompts the
   PASSKEY when the KOIN is ready to land (the chain verifies that
   signature — the server can't land funds on its own). */
'use strict';

const Fund = (() => {
  let CTX = null;   // { api, signPrepared, credentialId(), active() }
  let TIMER = null;
  let LAST = null;
  let BUSY = false;

  const $ = (s) => document.querySelector(s);
  const koin = (sats) => (Number(BigInt(sats)) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 2 });

  const STEP_LABEL = {
    front_gas: 'Fronting a little ETH for gas (on us)…',
    approve_v3_usdc: 'Approving USDC on Uniswap…',
    swap_usdc_usdt: 'Swapping USDC → USDT (Uniswap v3)…',
    swap_eth_usdt: 'Swapping ETH → USDT (Uniswap v3)…',
    approve_permit2: 'Approving the Uniswap router…',
    approve_ur: 'Approving the Uniswap router…',
    swap_usdt_vkoin: 'Swapping USDT → vKOIN (Uniswap v4)…',
    approve_bridge: 'Approving the Vortex bridge…',
    bridge_token: 'Bridging vKOIN → Koinos (Vortex, 1:1)…',
    deposit_eth: 'Depositing ETH into the Vortex bridge…',
    awaiting_signatures: 'Bridge guardians are signing (usually 2–3 minutes)…',
    awaiting_redeem: 'Your KOIN is ready to land!',
    awaiting_swap: 'vETH arrived — one more tap swaps it to KOIN.',
  };

  function mount(ctx) {
    CTX = ctx;
    $('#btn-fund-enable').addEventListener('click', enable);
    $('#fund-eth-addr').addEventListener('click', copyAddr);
    $('#btn-fund-land').addEventListener('click', land);
    $('#btn-fund-retry').addEventListener('click', () => act('/api/fund/resume'));
    $('#btn-fund-reset').addEventListener('click', () => act('/api/fund/reset'));
    $('#fund-swaps').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-asset]');
      if (b) startSwap(b.dataset.asset, b);
    });
    refresh();
  }
  function stop() { if (TIMER) { clearTimeout(TIMER) ; TIMER = null; } }

  async function refresh() {
    stop();
    if (!CTX || !CTX.credentialId()) return;
    try {
      LAST = await CTX.api('/api/fund/status?credentialId=' + encodeURIComponent(CTX.credentialId()));
      render(LAST);
    } catch (_) { /* card keeps its last state */ }
    const active = LAST && LAST.job && !['done', 'error'].includes(LAST.job.status);
    TIMER = setTimeout(refresh, active ? 4000 : 15000);
  }

  const say = (m, cls) => { const st = $('#fund-status'); st.hidden = !m; st.className = 'status' + (cls ? ' ' + cls : ''); st.textContent = m || ''; };

  async function enable() {
    const btn = $('#btn-fund-enable');
    btn.disabled = true;
    try {
      await CTX.api('/api/fund/enable', { credentialId: CTX.credentialId() });
      await refresh();
    } catch (e) { say(e.message || 'Could not set up funding', 'err'); }
    finally { btn.disabled = false; }
  }

  async function copyAddr() {
    const a = (LAST && LAST.ethAddress) || '';
    try { await navigator.clipboard.writeText(a); $('#fund-eth-addr').style.borderColor = 'var(--good)'; }
    catch (_) { window.prompt('Copy your Ethereum deposit address:', a); }
    setTimeout(() => { $('#fund-eth-addr').style.borderColor = ''; }, 900);
  }

  async function act(path) {
    try { await CTX.api(path, { credentialId: CTX.credentialId() }); say(''); await refresh(); }
    catch (e) { say(e.message || 'Failed', 'err'); }
  }

  async function startSwap(asset, btn) {
    if (BUSY) return;
    BUSY = true; btn.disabled = true;
    try {
      say('Starting the swap — the server drives the Ethereum side from here…');
      await CTX.api('/api/fund/start', { credentialId: CTX.credentialId(), asset });
      say('');
      await refresh();
    } catch (e) { say(e.message || 'Could not start the swap', 'err'); }
    finally { BUSY = false; btn.disabled = false; }
  }

  /* The passkey landing: bridge redeem (and Route B's KoinDX swap). */
  async function land() {
    if (BUSY) return;
    const btn = $('#btn-fund-land');
    BUSY = true; btn.disabled = true;
    try {
      say('Preparing the landing transaction…');
      const prep = await CTX.api('/api/fund/prepare-step', { credentialId: CTX.credentialId() });
      say('Confirm with your passkey — it authorizes the KOIN landing on-chain…');
      const blob = await CTX.signPrepared(prep.tx);
      say('Broadcasting…');
      await CTX.api('/api/submit', { ref: prep.ref, transaction: { ...prep.tx, signatures: [blob] } });
      say('');
      await refresh();
      if (CTX.onKoinMoved) CTX.onKoinMoved();
    } catch (e) {
      say(e.name === 'NotAllowedError' ? 'Passkey prompt closed — your funds are safe; tap again to land them.' : (e.message || 'Landing failed'), 'err');
    } finally { BUSY = false; btn.disabled = false; }
  }

  function render(st) {
    $('#fund-setup').hidden = !!st.enabled;
    $('#fund-body').hidden = !st.enabled;
    if (!st.enabled) return;

    $('#fund-eth-addr').textContent = st.ethAddress;

    const j = st.job;
    const jobActive = j && !['done', 'error'].includes(j.status);
    $('#fund-idle').hidden = !!jobActive || (j && j.status === 'error');
    $('#fund-job').hidden = !j;

    /* balances + one-click swap rows */
    const rows = [];
    if (!jobActive && st.balances) {
      const q = st.quotes || {};
      const add = (asset, sym, amount, quote) => {
        if (!(Number(amount) > 0)) return;
        const est = quote && quote.koinOut ? ` → ≈ <strong>${koin(quote.koinOut)} KOIN</strong>` : '';
        const via = asset === 'eth' && quote && quote.best ? ` <span class="fund-via">via ${quote.best.label}</span>` : '';
        rows.push(`<div class="fund-row"><span>${amount} ${sym}${est}${via}</span>` +
          `<button class="cta small" data-asset="${asset}">Swap to KOIN</button></div>`);
      };
      add('eth', 'ETH', st.balances.eth, q.eth ? { koinOut: q.eth.best && q.eth.best.koinOut, best: q.eth.best } : null);
      add('usdc', 'USDC', st.balances.usdc, q.usdc);
      add('usdt', 'USDT', st.balances.usdt, q.usdt);
    }
    $('#fund-swaps').innerHTML = rows.join('');
    $('#fund-empty').hidden = !!rows.length || !!jobActive || !!(j && j.status === 'error');
    if (st.balancesError) say('Ethereum balances unavailable right now: ' + st.balancesError, '');

    /* the job */
    if (j) {
      const label = j.status === 'done' ? `🎉 Landed ${j.koinReceived ? koin(j.koinReceived) + ' ' : ''}KOIN on your account!`
        : j.status === 'error' ? 'Swap hit a snag: ' + (j.error || 'unknown error')
        : (STEP_LABEL[j.status] || j.status);
      $('#fund-job-label').textContent = label;
      $('#fund-job-sub').textContent = jobActive && j.estKoinOut
        ? `${j.amountLabel || (j.amountEth ? j.amountEth + ' ETH' : '')} → ≈ ${koin(j.estKoinOut)} KOIN` +
          (j.route ? ` · route ${j.route}` : '')
        : '';
      $('#fund-spin').hidden = !jobActive || ['awaiting_redeem', 'awaiting_swap'].includes(j.status);
      $('#btn-fund-land').hidden = !['awaiting_redeem', 'awaiting_swap'].includes(j.status);
      $('#btn-fund-land').textContent = j.status === 'awaiting_swap' ? 'Swap vETH → KOIN — confirm with passkey' : 'Land my KOIN — confirm with passkey';
      $('#btn-fund-retry').hidden = j.status !== 'error';
      $('#btn-fund-reset').hidden = !['done', 'error'].includes(j.status);
      $('#fund-job').className = 'status' + (j.status === 'done' ? ' ok' : j.status === 'error' ? ' err' : '');
    }
  }

  return { mount, refresh, stop };
})();
