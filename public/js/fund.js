/* Fund with ETH / USDC / USDT — the wallet face of the two-route
   ETH→KOIN pipeline, mirroring Koinos Node Desktop's Fund view: pick an
   amount, see BOTH routes priced with the best on top, choose one, and
   confirm the KOIN landing with your passkey (the chain verifies that
   signature — the server can't land funds on its own). Every account has
   its deposit address from birth. */
'use strict';

const Fund = (() => {
  let CTX = null;   // { api, signPrepared, credentialId(), onKoinMoved }
  let TIMER = null;
  let LAST = null;
  let BUSY = false;
  const DEBOUNCE = {};

  const $ = (s) => document.querySelector(s);
  const koin = (sats) => (Number(BigInt(sats)) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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

  const SYM = { eth: 'ETH', usdc: 'USDC', usdt: 'USDT' };

  function mount(ctx) {
    CTX = ctx;
    $('#btn-fund-enable').addEventListener('click', refresh);
    $('#fund-eth-addr').addEventListener('click', copyAddr);
    $('#btn-fund-land').addEventListener('click', land);
    $('#btn-fund-retry').addEventListener('click', () => act('/api/fund/resume'));
    $('#btn-fund-reset').addEventListener('click', () => act('/api/fund/reset'));
    const assets = $('#fund-assets');
    assets.addEventListener('click', (e) => {
      const max = e.target.closest('button[data-max]');
      if (max) {
        const panel = max.closest('.fund-asset');
        panel.querySelector('input[data-amt]').value = panel.dataset.spendable;
        requote(panel.dataset.asset);
        return;
      }
      const go = e.target.closest('button[data-route]');
      if (go) {
        const panel = go.closest('.fund-asset');
        startSwap(panel.dataset.asset, panel.querySelector('input[data-amt]').value.trim(), go.dataset.route, go);
      }
    });
    assets.addEventListener('input', (e) => {
      const inp = e.target.closest('input[data-amt]');
      if (inp) requote(inp.closest('.fund-asset').dataset.asset);
    });
    refresh();
  }
  function stop() { if (TIMER) { clearTimeout(TIMER); TIMER = null; } }

  async function refresh() {
    stop();
    if (!CTX || !CTX.credentialId()) return;
    try {
      LAST = await CTX.api('/api/fund/status?credentialId=' + encodeURIComponent(CTX.credentialId()));
      render(LAST);
    } catch (e) {
      /* Never fail silently — a dead-looking button is worse than a reason. */
      if (e.status !== 404) say(e.message || 'Funding is unavailable right now', 'err');
    }
    const active = LAST && LAST.job && !['done', 'error'].includes(LAST.job.status);
    TIMER = setTimeout(refresh, active ? 4000 : 15000);
  }

  const say = (m, cls) => { const st = $('#fund-status'); st.hidden = !m; st.className = 'status' + (cls ? ' ' + cls : ''); st.textContent = m || ''; };

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

  /* Re-price the routes for the amount in the box (debounced). */
  function requote(asset) {
    clearTimeout(DEBOUNCE[asset]);
    DEBOUNCE[asset] = setTimeout(async () => {
      const panel = document.querySelector(`.fund-asset[data-asset="${asset}"]`);
      if (!panel) return;
      const amount = panel.querySelector('input[data-amt]').value.trim();
      const box = panel.querySelector('[data-routes]');
      if (!amount || !/^\d*\.?\d*$/.test(amount) || !(Number(amount) > 0)) {
        box.innerHTML = '<div class="hint">Enter an amount to price the routes.</div>';
        return;
      }
      box.innerHTML = '<div class="hint">Pricing routes…</div>';
      try {
        const r = await CTX.api('/api/fund/quote', { credentialId: CTX.credentialId(), asset, amount });
        box.innerHTML = routesHtml(asset, r.quote);
      } catch (e) {
        box.innerHTML = '<div class="fund-unavail">' + esc(e.message || 'Quote failed') + '</div>';
      }
    }, 450);
  }

  function routesHtml(asset, q) {
    if (!q || !Array.isArray(q.routes) || !q.routes.length) {
      return '<div class="fund-unavail">' + esc((q && q.error) || 'No route can be priced right now') + '</div>';
    }
    const single = q.routes.length === 1;
    return q.routes.map((r) => {
      const head = `<strong>Route ${esc(r.id)}</strong> — ${esc(r.label)}`;
      const steps = `<div class="fund-steps">${esc((r.steps || []).join('  →  '))}</div>`;
      if (r.koinOut == null) {
        return `<div class="fund-route">${head}${steps}<div class="fund-unavail">unavailable: ${esc(r.error || 'no quote')}</div></div>`;
      }
      const best = r.isBest ? ' <span class="fund-best">★ best</span>'
        : (r.pctOfBest != null ? ` <span class="fund-worse">— ${r.pctOfBest}% of best</span>` : '');
      const min = r.koinOutMin ? ` <span class="fund-min">(min ${koin(r.koinOutMin)} after slippage)</span>` : '';
      const btnLabel = single ? 'Swap & bridge to KOIN' : `Use Route ${esc(r.id)}`;
      return `<div class="fund-route${r.isBest ? ' is-best' : ''}">` +
        `<div class="fund-route-head">${head}` +
        `<button class="${r.isBest || single ? 'cta small' : 'ghost small'}" data-route="${esc(r.id)}">${btnLabel}</button></div>` +
        steps +
        `<div class="fund-out"><strong>${koin(r.koinOut)} KOIN</strong>${best}${min}</div>` +
        `</div>`;
    }).join('');
  }

  async function startSwap(asset, amount, route, btn) {
    if (BUSY) return;
    BUSY = true; if (btn) btn.disabled = true;
    try {
      say('Starting the swap — the server drives the Ethereum side from here…');
      await CTX.api('/api/fund/start', { credentialId: CTX.credentialId(), asset, amount, route });
      say('');
      await refresh();
    } catch (e) { say(e.message || 'Could not start the swap', 'err'); }
    finally { BUSY = false; if (btn) btn.disabled = false; }
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
    const b = st.balances;

    /* Deposit balances as first-class wallet stats, next to KOIN and mana. */
    const tiles = $('#deposit-stats');
    if (tiles) {
      tiles.hidden = false;
      const f = (v, dp) => Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: dp });
      const tag = st.demo ? ' <span class="stat-sample">sample</span>' : '';
      $('#stat-eth').innerHTML = b ? f(b.eth, 5) + tag : '—';
      $('#stat-stable').innerHTML = b ? `${f(b.usdc, 2)} / ${f(b.usdt, 2)}` + tag : '—';
    }

    /* the in-card strip mirrors the same numbers */
    const strip = [];
    if (st.demo) strip.push('<span class="fund-sample">SAMPLE — demo mode</span>');
    if (b) {
      const f = (v, dp) => Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: dp });
      strip.push(`<span>ETH <strong>${f(b.eth, 5)}</strong></span>`);
      strip.push(`<span>USDC <strong>${f(b.usdc, 2)}</strong></span>`);
      strip.push(`<span>USDT <strong>${f(b.usdt, 2)}</strong></span>`);
      if (Number(b.vkoin) > 0) strip.push(`<span>vKOIN <strong>${f(b.vkoin, 2)}</strong> (in transit)</span>`);
    } else if (st.balancesError) {
      strip.push('<span>balances unavailable right now</span>');
    }
    $('#fund-balances').innerHTML = strip.join('<span class="fund-dot">·</span>');

    /* Swaps need a live on-chain account; the address and balances don't. */
    if (st.accountActive === false) {
      say(st.accountStep === 'conflict'
        ? 'This account answers to a different passkey — sign in with that one.'
        : 'Your smart account is still being written on-chain — swaps unlock once it is live.'
          + (st.accountError ? ' (' + st.accountError + ')' : ''), '');
    } else if ($('#fund-status').textContent.startsWith('Your smart account is still')) {
      say('');
    }

    const j = st.job;
    const jobActive = j && !['done', 'error'].includes(j.status);
    $('#fund-idle').hidden = !!jobActive || (j && j.status === 'error');
    $('#fund-job').hidden = !j;

    /* per-asset amount + route panels (only rebuilt when idle, so typing
       is never clobbered by the poll) */
    const assets = $('#fund-assets');
    if (!jobActive && b && st.spendable && st.accountActive !== false) {
      const lowGas = !st.gasFronting && Number(b.eth) < Number(st.gasMinEth || 0.0012);
      const panels = [];
      for (const asset of ['eth', 'usdc', 'usdt']) {
        const spend = st.spendable[asset];
        if (!(Number(spend) > 0)) continue;
        const open = document.querySelector(`.fund-asset[data-asset="${asset}"] input[data-amt]`);
        const value = open && document.activeElement === open ? open.value : spend;
        const cap = asset === 'eth' ? (st.caps ? st.caps.eth : '') : (st.caps ? st.caps.stable : '');
        const q = st.quotes && st.quotes[asset];
        panels.push(
          `<div class="fund-asset" data-asset="${asset}" data-spendable="${esc(spend)}">` +
          `<div class="fund-asset-head">${esc(Number(b[asset]).toLocaleString('en-US', { maximumFractionDigits: asset === 'eth' ? 5 : 2 }))} ${SYM[asset]} at your deposit address</div>` +
          `<label class="fund-amt-label">Amount (${SYM[asset]} · max ${esc(spend)}${cap ? ' · cap ' + esc(cap) : ''})</label>` +
          `<div class="fund-amount-row"><input data-amt inputmode="decimal" autocomplete="off" spellcheck="false" value="${esc(value)}">` +
          `<button class="ghost" data-max>Max</button></div>` +
          `<div data-routes>${q ? routesHtml(asset, q) : '<div class="hint">Pricing routes…</div>'}</div>` +
          (asset !== 'eth' && lowGas
            ? `<div class="fund-gaswarn">⚠ This address holds almost no ETH — swaps need ~${esc(st.gasMinEth)} ETH for Ethereum gas. Send a little ETH along with your ${SYM[asset]}.</div>`
            : '') +
          `</div>`);
      }
      /* Rebuild only when the set of panels changes or none exist, or when
         no input is focused — otherwise leave the DOM alone. */
      const focused = document.activeElement && assets.contains(document.activeElement);
      if (!focused) assets.innerHTML = panels.join('');
      $('#fund-empty').hidden = !!panels.length;
    } else if (jobActive) {
      assets.innerHTML = '';
      $('#fund-empty').hidden = true;
    }

    /* the job */
    if (j) {
      const label = j.status === 'done' ? `🎉 Landed ${j.koinReceived ? koin(j.koinReceived) + ' ' : ''}KOIN on your account!`
        : j.status === 'error' ? 'Swap hit a snag: ' + (j.error || 'unknown error')
        : (STEP_LABEL[j.status] || j.status);
      $('#fund-job-label').textContent = label;
      $('#fund-job-sub').textContent = jobActive && j.estKoinOut
        ? `${j.amountLabel || ''} → ≈ ${koin(j.estKoinOut)} KOIN · route ${j.route}`
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
