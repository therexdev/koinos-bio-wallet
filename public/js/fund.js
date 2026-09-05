/* Fund with ETH / USDC / USDT / SOL — the wallet face of the funding
   pipeline, mirroring Koinos Node Desktop's Fund view: pick an amount, see
   every route priced with the best on top, choose one, and confirm the KOIN
   landing with your passkey (the chain verifies that signature — the server
   can't land funds on its own). Every account has its deposit addresses
   from birth: Ethereum for ETH and the stables, Solana for SOL (Route S,
   which crosses Wormhole to Ethereum and then lands like the others). */
'use strict';

const Fund = (() => {
  let CTX = null;   // { api, signPrepared, credentialId(), onKoinMoved }
  let TIMER = null;
  let GEN = 0;                // bumped by stop(): an in-flight refresh older than it is void
  let LAST = null;
  let BUSY = false;
  let QR_SHOWN = null;        // the deposit address the QR tile currently shows
  let QR_SHOWN_SOL = null;    // same, for the Solana tile
  let LAST_JOB_STATUS = null; // to notice a job finishing while another tab is up
  const DEBOUNCE = {};

  const $ = (s) => document.querySelector(s);
  /* Exact from the integer, truncated to 4 places — never a rounded-up
     figure stated as what landed. (Portfolio loads after this file, so it
     is resolved at call time.) */
  const koin = (sats) => (typeof Portfolio !== 'undefined'
    ? Portfolio.fmtAmount(Portfolio.fromSats(String(sats), 8), 4)
    : (Number(BigInt(sats)) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 4 }));
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
    /* Route S */
    sol_swap: 'Swapping SOL → vKOIN on Solana (Jupiter)…',
    sol_bridge: 'Sending vKOIN across Wormhole to Ethereum…',
    awaiting_vaa: 'Wormhole guardians are signing (usually 1–2 minutes)…',
    wh_redeem: 'Receiving the vKOIN on Ethereum…',
    awaiting_signatures: 'Bridge guardians are signing (usually 2–3 minutes)…',
    awaiting_redeem: 'Landing your KOIN on your account…',
    /* awaiting_redeem normally completes on its own; it only asks for a tap
       if the chain refused the sponsor-submitted redeem (see needsTap). */
    awaiting_swap: 'vETH arrived — one more tap swaps it to KOIN.',
  };

  const needsTap = (j) => j.status === 'awaiting_redeem' && !!j.needsTap;

  /* Job states where the funds sit in the bridge rather than at the deposit
     address — nothing shows in the token balances, so say it explicitly. */
  const IN_BRIDGE = new Set(['awaiting_signatures', 'awaiting_redeem', 'awaiting_swap', 'awaiting_vaa', 'wh_redeem']);
  /* Gas being fronted right before the Wormhole redeem is the same state
     for the money: it is in Wormhole, not at either address. */
  const inBridgeState = (j) => !!j && (IN_BRIDGE.has(j.status) || (j.status === 'front_gas' && j.afterGas === 'wh_redeem'));
  const bridgeName = (j) => (j && (j.status === 'awaiting_vaa' || j.status === 'wh_redeem' || j.afterGas === 'wh_redeem') ? 'Wormhole' : 'Vortex');

  const SYM = { eth: 'ETH', usdc: 'USDC', usdt: 'USDT', sol: 'SOL' };
  const CHAIN = { eth: 'Ethereum', usdc: 'Ethereum', usdt: 'Ethereum', sol: 'Solana' };
  const DP = { eth: 5, usdc: 2, usdt: 2, sol: 4 };

  function mount(ctx) {
    CTX = ctx;
    $('#btn-fund-enable').addEventListener('click', refresh);
    $('#fund-eth-addr').addEventListener('click', () => copyAddr('eth'));
    opt('#fund-sol-addr', (n) => n.addEventListener('click', () => copyAddr('sol')));
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
  /* stop() also voids a refresh that is mid-request: without that, the
     answer would render and re-arm the poll after the wallet was left. */
  function stop() { GEN++; if (TIMER) { clearTimeout(TIMER); TIMER = null; } }
  /* Sign-out: nothing of the previous account survives into the next —
     neither the state nor what render() wrote on screen. */
  function forget() {
    stop(); LAST = null; LAST_JOB_STATUS = null; QR_SHOWN = null; QR_SHOWN_SOL = null;
    $('#fund-setup').hidden = false; $('#fund-body').hidden = true;
    $('#fund-eth-addr').textContent = ''; $('#fund-balances').innerHTML = ''; $('#fund-assets').innerHTML = '';
    $('#fund-job').hidden = true; $('#fund-job-label').textContent = ''; $('#fund-job-sub').textContent = '';
    say('');
    opt('#fund-eth-qr', (n) => { n.classList.remove('fail'); n.innerHTML = '<span class="skel" aria-hidden="true"></span>'; });
    opt('#fund-sol-qr', (n) => { n.classList.remove('fail'); n.innerHTML = '<span class="skel" aria-hidden="true"></span>'; });
    opt('#fund-sol-block', (n) => { n.hidden = true; });
    opt('#fund-sol-addr', (n) => { n.textContent = ''; });
    opt('#stat-sol-row', (n) => { n.hidden = true; });
    opt('#deposit-stats', (n) => { n.hidden = true; });
    opt('#stat-bridge-card', (n) => { n.hidden = true; });
    opt('#tabdot-convert', (n) => { n.hidden = true; n.classList.remove('pulse'); });
    opt('#fund-land-idle', (n) => { n.hidden = false; });
    opt('#fund-convert-busy', (n) => { n.hidden = true; });
  }

  async function refresh() {
    stop();
    const g = GEN;
    if (!CTX || !CTX.credentialId()) return;
    let st = null;
    try {
      st = await CTX.api('/api/fund/status?credentialId=' + encodeURIComponent(CTX.credentialId()));
      if (g !== GEN) return;
      LAST = st;
      render(LAST);
    } catch (e) {
      if (g !== GEN) return;
      /* Never fail silently — a dead-looking button is worse than a reason. */
      if (e.status !== 404) say(e.message || 'Funding is unavailable right now', 'err');
    }
    const active = LAST && LAST.job && !['done', 'error'].includes(LAST.job.status);
    TIMER = setTimeout(refresh, active ? 4000 : 15000);
  }

  const say = (m, cls) => { const st = $('#fund-status'); st.hidden = !m; st.className = 'status' + (cls ? ' ' + cls : ''); st.textContent = m || ''; };

  async function copyAddr(which) {
    const solana = which === 'sol';
    const a = (LAST && (solana ? LAST.solAddress : LAST.ethAddress)) || '';
    const el = $(solana ? '#fund-sol-addr' : '#fund-eth-addr');
    try { await navigator.clipboard.writeText(a); el.style.borderColor = 'var(--good)'; }
    catch (_) { window.prompt(`Copy your ${solana ? 'Solana' : 'Ethereum'} deposit address:`, a); }
    setTimeout(() => { el.style.borderColor = ''; }, 900);
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
      const via = r.via && r.via.length ? ` · via ${esc(r.via.join(', '))}` : '';
      const steps = `<div class="fund-steps">${esc((r.steps || []).join('  →  '))}${via}</div>`;
      if (r.koinOut == null) {
        return `<div class="fund-route">${head}${steps}<div class="fund-unavail">unavailable: ${esc(r.error || 'no quote')}</div></div>`;
      }
      const best = r.isBest ? ' <span class="fund-best">★ best</span>'
        : (r.pctOfBest != null ? ` <span class="fund-worse">— ${r.pctOfBest}% of best</span>` : '');
      const min = r.koinOutMin ? ` <span class="fund-min">(min ${koin(r.koinOutMin)} after slippage)</span>` : '';
      /* A shallow pool moves a lot for a little — say so before the tap,
         not after: the trade is priced with the impact in, and a smaller
         amount keeps more of it. */
      const pi = Number(r.priceImpactPct);
      const impact = r.priceImpactPct != null && isFinite(pi)
        ? `<span class="fund-impact${pi >= 5 ? ' warn' : ''}">price impact ${pi < 0.01 ? '<0.01' : pi.toFixed(2)}%${pi >= 5 ? ' — the pool is shallow; a smaller amount loses less' : ''}</span>`
        : '';
      const btnLabel = single ? 'Swap & bridge to KOIN' : `Use Route ${esc(r.id)}`;
      return `<div class="fund-route${r.isBest ? ' is-best' : ''}">` +
        `<div class="fund-route-head">${head}` +
        `<button class="${r.isBest || single ? 'cta small' : 'ghost small'}" data-route="${esc(r.id)}">${btnLabel}</button></div>` +
        steps +
        `<div class="fund-out"><strong>${koin(r.koinOut)} KOIN</strong>${best}${min}${impact}</div>` +
        `</div>`;
    }).join('');
  }

  async function startSwap(asset, amount, route, btn) {
    if (BUSY) return;
    BUSY = true; if (btn) btn.disabled = true;
    try {
      say(asset === 'sol' ? 'Starting the swap — the server drives the Solana and Ethereum legs from here…'
        : 'Starting the swap — the server drives the Ethereum side from here…');
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

  /* The mobile shell's extras (tab dot, SIMULATED chip, deposit QR, dimmed
     zero rows). Each is null-guarded: the card must keep working in a page
     that has none of these elements. */
  const opt = (sel, fn) => { const n = $(sel); if (n) fn(n); };

  function render(st) {
    $('#fund-setup').hidden = !!st.enabled;
    $('#fund-body').hidden = !st.enabled;
    opt('#buy-sim-chip', (n) => { n.hidden = !st.demo; });
    if (!st.enabled) return;

    $('#fund-eth-addr').textContent = st.ethAddress;
    /* Receive and UI are top-level consts of later scripts: lexical globals,
       so typeof — never window.X — is the existence check. */
    if (st.ethAddress && st.ethAddress !== QR_SHOWN && typeof Receive !== 'undefined') {
      opt('#fund-eth-qr', (n) => {
        QR_SHOWN = st.ethAddress;
        n.classList.remove('fail');
        Receive.render(n, st.ethAddress, { raw: true, cell: 4 })
          .catch(() => { QR_SHOWN = null; n.classList.add('fail'); n.textContent = 'QR unavailable — copy the address instead'; });
      });
    }
    /* The Solana deposit block, when this server runs Route S. */
    const solOn = !!(st.solAddress && st.solRail && st.solRail.enabled);
    opt('#fund-sol-block', (n) => { n.hidden = !solOn; });
    if (solOn) {
      opt('#fund-sol-addr', (n) => { n.textContent = st.solAddress; });
      if (st.solAddress !== QR_SHOWN_SOL && typeof Receive !== 'undefined') {
        opt('#fund-sol-qr', (n) => {
          QR_SHOWN_SOL = st.solAddress;
          n.classList.remove('fail');
          Receive.render(n, st.solAddress, { raw: true, cell: 4 })
            .catch(() => { QR_SHOWN_SOL = null; n.classList.add('fail'); n.textContent = 'QR unavailable — copy the address instead'; });
        });
      }
    }
    const b = st.balances;

    /* Deposit balances as wallet stats on the home screen — but only what
       can actually be converted. A row is shown when the server's SPENDABLE
       amount (balance minus the gas reserve, within the cap) is above zero;
       dust below the reserve, or nothing at all, shows no row, and with no
       row and nothing mid-bridge the whole group goes. A row that leads to
       a Buy tab with nothing to convert is worse than no row. */
    const tiles = $('#deposit-stats');
    if (tiles) {
      const f = (v, dp) => Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: dp });
      const tag = st.demo ? ' <span class="stat-sample">sample</span>' : '';
      const sp = st.spendable || {};
      const can = (a) => Number(sp[a]) > 0;
      const showEth = !!b && can('eth');
      const showStable = !!b && (can('usdc') || can('usdt'));
      const showSol = solOn && !!b && b.sol != null && can('sol');
      $('#stat-eth').innerHTML = b ? f(b.eth, 5) + tag : '—';
      $('#stat-stable').innerHTML = b ? `${f(b.usdc, 2)} / ${f(b.usdt, 2)}` + tag : '—';
      opt('#stat-sol', (n) => { n.innerHTML = showSol ? f(b.sol, 4) + tag : '—'; });
      opt('#stat-eth-row', (n) => { n.hidden = !showEth; });
      opt('#stat-stable-row', (n) => { n.hidden = !showStable; });
      opt('#stat-sol-row', (n) => { n.hidden = !showSol; });
      /* Funds mid-bridge belong on the wallet screen too — they are the
         user's, they are just not at the deposit address any more. */
      const j0 = st.job;
      const held = inBridgeState(j0) ? (j0.recordAmount || j0.estKoinOut) : null;
      const card = $('#stat-bridge-card');
      if (card) {
        card.hidden = !held;
        if (held) {
          $('#stat-bridge').innerHTML = `${koin(held)} KOIN` + tag;
          opt('#stat-bridge-sub', (n) => { n.textContent = `In the ${bridgeName(j0)} bridge`; });
        }
      }
      tiles.hidden = !(showEth || showStable || showSol || !!held);
    }

    /* the in-card strip mirrors the same numbers */
    const strip = [];
    if (st.demo) strip.push('<span class="fund-sample">SAMPLE — demo mode</span>');
    if (b) {
      const f = (v, dp) => Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: dp });
      strip.push(`<span>ETH <strong>${f(b.eth, 5)}</strong></span>`);
      strip.push(`<span>USDC <strong>${f(b.usdc, 2)}</strong></span>`);
      strip.push(`<span>USDT <strong>${f(b.usdt, 2)}</strong></span>`);
      /* Always shown, zero included. Hiding it when it hits 0 is how a
         correct bridging step reads as "my money disappeared". */
      strip.push(`<span>vKOIN <strong>${f(b.vkoin, 2)}</strong></span>`);
      if (solOn) {
        if (b.sol != null) {
          const sp = st.spendable || {};
          const stuck = Number(b.sol) > 0 && !(Number(sp.sol) > 0) && st.solFloor;
          strip.push(`<span>SOL <strong>${f(b.sol, 4)}</strong>${stuck ? ` · needs ${esc(st.solFloor)} to convert` : ''}</span>`);
          /* vKOIN on Solana exists only mid-route; shown while it does. */
          if (Number(b.solVkoin) > 0) strip.push(`<span>vKOIN·Solana <strong>${f(b.solVkoin, 2)}</strong></span>`);
        } else if (b.solError) {
          strip.push('<span>Solana balance unavailable right now</span>');
        }
      }
    } else if (st.balancesError) {
      strip.push('<span>balances unavailable right now</span>');
    }
    /* Money that has LEFT the deposit address but not yet arrived as KOIN is
       still yours — it is locked in the bridge against a guardian-signed
       record. Showing nothing for it reads as "it vanished", which is the
       one thing it has not done. */
    const inFlight = st.job;
    const inBridge = inBridgeState(inFlight)
      ? (inFlight.recordAmount || inFlight.estKoinOut) : null;
    if (inBridge) {
      strip.push(`<span class="fund-inflight">in the ${bridgeName(inFlight)} bridge <strong>${koin(inBridge)} KOIN</strong>`
        + ' — waiting to land on your account</span>');
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
    opt('#fund-convert-busy', (n) => { n.hidden = !$('#fund-idle').hidden; });
    opt('#fund-land-idle', (n) => { n.hidden = !!j; });
    opt('#tabdot-convert', (n) => { n.hidden = !j; n.classList.toggle('pulse', !!(j && needsTap(j))); });
    /* KOIN landing while the person is on another tab deserves a word. */
    if (j && j.status === 'done' && LAST_JOB_STATUS && LAST_JOB_STATUS !== 'done') {
      const tab = $('#tab-convert');
      if (tab && tab.hidden && typeof UI !== 'undefined') UI.toast('KOIN landed — see Home');
    }
    LAST_JOB_STATUS = j ? j.status : null;

    /* per-asset amount + route panels (only rebuilt when idle, so typing
       is never clobbered by the poll) */
    const assets = $('#fund-assets');
    if (!jobActive && b && st.spendable && st.accountActive !== false) {
      const lowGas = !st.gasFronting && Number(b.eth) < Number(st.gasMinEth || 0.0012);
      const panels = [];
      for (const asset of ['eth', 'usdc', 'usdt', 'sol']) {
        const spend = st.spendable[asset];
        if (!(Number(spend) > 0)) continue;
        if (asset === 'sol' && (!solOn || b.sol == null)) continue;
        const open = document.querySelector(`.fund-asset[data-asset="${asset}"] input[data-amt]`);
        const value = open && document.activeElement === open ? open.value : spend;
        const cap = !st.caps ? '' : asset === 'eth' ? st.caps.eth : asset === 'sol' ? (st.caps.sol || '') : st.caps.stable;
        const min = asset === 'sol' && st.solMin ? ' · min ' + esc(st.solMin) : '';
        const q = st.quotes && st.quotes[asset];
        panels.push(
          `<div class="fund-asset" data-asset="${asset}" data-spendable="${esc(spend)}">` +
          `<div class="fund-asset-head">${esc(Number(b[asset]).toLocaleString('en-US', { maximumFractionDigits: DP[asset] }))} ${SYM[asset]} at your ${CHAIN[asset]} deposit address</div>` +
          `<label class="fund-amt-label">Amount (${SYM[asset]} · max ${esc(spend)}${cap ? ' · cap ' + esc(cap) : ''}${min})</label>` +
          `<div class="fund-amount-row"><input data-amt inputmode="decimal" autocomplete="off" spellcheck="false" value="${esc(value)}">` +
          `<button class="ghost" data-max>Max</button></div>` +
          `<div data-routes>${q ? routesHtml(asset, q) : '<div class="hint">Pricing routes…</div>'}</div>` +
          (asset === 'sol' && lowGas
            ? `<div class="fund-gaswarn">⚠ This route finishes on Ethereum (Wormhole → Vortex), and your Ethereum deposit address holds almost no ETH — it needs ~${esc(st.gasMinEth)} ETH for gas. Send a little ETH there first.</div>`
            : asset !== 'eth' && lowGas
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
        : needsTap(j) ? 'Your KOIN is ready to land!'
        : (STEP_LABEL[j.status] || j.status);
      $('#fund-job-label').textContent = label;
      $('#fund-job-sub').textContent = jobActive && j.estKoinOut
        ? `${j.amountLabel || ''} → ≈ ${koin(j.estKoinOut)} KOIN · route ${j.route}`
        : '';
      const tap = needsTap(j) || j.status === 'awaiting_swap';
      $('#fund-spin').hidden = !jobActive || tap;
      $('#btn-fund-land').hidden = !tap;
      $('#btn-fund-land').textContent = j.status === 'awaiting_swap'
        ? 'Swap vETH → KOIN — confirm with passkey'
        : 'Land my KOIN — confirm with passkey';
      $('#btn-fund-retry').hidden = j.status !== 'error';
      $('#btn-fund-reset').hidden = !['done', 'error'].includes(j.status);
      opt('#fund-job .btn-row', (n) => { n.hidden = !(tap || ['done', 'error'].includes(j.status)); });
      $('#fund-job').className = 'status' + (j.status === 'done' ? ' ok' : j.status === 'error' ? ' err' : '');
    }
  }

  return { mount, refresh, stop, forget };
})();
