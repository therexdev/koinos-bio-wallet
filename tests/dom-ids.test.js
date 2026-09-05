/* The id contract between index.html and the scripts.

   app.js, fund.js and ui.js look elements up by id at boot without null
   checks — a missing id is a TypeError before the first screen paints, and a
   duplicated id quietly wires a handler to the wrong element. This pins every
   id the scripts need to exactly one element, keeps the pieces that must
   live inside the wallet section there (tabs and sheets hide with it), and
   checks the script order (each file is a classic script that expects the
   ones before it).

   Run: node tests/dom-ids.test.js
*/
'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/* Every id a script dereferences. Grouped by owner so a removal is easy to
   trace back to the code that would break. */
const IDS = {
  'app.js (existing)': [
    'demo-note', 'sym', 'sym2', 'btn-signout', 'btn-go', 'no-passkey', 'alt-unlock',
    'btn-unlock-existing', 'btn-open-recover', 'btn-recover-back', 'btn-recover', 'addr',
    'btn-add-passkey', 'btn-backup-activate', 'btn-backup-cancel', 'btn-make-kit', 'btn-kit-activate',
    'btn-kit-cancel', 'btn-rekey', 'btn-send', 'btn-scan', 'btn-send-all', 'view-landing', 'view-wallet',
    'view-recover', 'activation', 'kit-input', 'recover-status', 'bal', 'mana', 'cred-list', 'kit-armed',
    'recovery-banner', 'backup-nudge', 'backup-status', 'backup-box', 'kit-box', 'kit-text', 'send-to',
    'send-amount', 'send-status',
  ],
  'fund.js': [
    'btn-fund-enable', 'fund-eth-addr', 'btn-fund-land', 'btn-fund-retry', 'btn-fund-reset', 'fund-assets',
    'fund-setup', 'fund-body', 'fund-balances', 'fund-idle', 'fund-empty', 'fund-job', 'fund-spin',
    'fund-job-label', 'fund-job-sub', 'fund-status', 'stat-eth', 'stat-stable', 'stat-bridge',
    'deposit-stats', 'stat-bridge-card',
    /* null-guarded additions for the mobile shell */
    'fund-eth-qr', 'buy-sim-chip', 'tabdot-convert', 'stat-eth-row', 'stat-stable-row', 'fund-land-idle',
    'fund-convert-busy',
  ],
  'ui.js (shell)': [
    'tabbar', 'tabbtn-home', 'tabbtn-convert', 'tabbtn-security', 'tabdot-security', 'scrim', 'toast',
    'offline-note', 'notices', 'tab-home', 'tab-convert', 'tab-security',
  ],
  'ui.js (home)': [
    'hero', 'hero-label', 'total-usd', 'hero-note', 'bal-usd', 'vhp-bal', 'vhp-sub', 'addr-short',
    'protect-line', 'btn-open-receive', 'btn-open-send', 'btn-open-buy', 'btn-add-token', 'token-list',
    'refresh-note',
  ],
  'ui.js (token sheet)': [
    'sheet-token', 'tok-icon', 'tok-title', 'tok-sym', 'tok-name', 'tok-amount', 'tok-usd', 'tok-price',
    'tok-mana-row', 'btn-tok-receive', 'btn-tok-send', 'tok-send-note', 'tok-contract', 'tok-contract-row',
    'tok-decimals', 'tok-network', 'tok-explorer', 'btn-tok-remove', 'btn-tok-close',
  ],
  'ui.js (send sheet)': [
    'sheet-send', 'btn-send-close', 'send-from', 'btn-paste', 'send-to-check', 'send-suffix', 'send-avail',
    'send-usd', 'sign-summary', 'ss-to', 'ss-amount', 'ss-signer', 'ss-network', 'send-offline', 'send-gate',
    'btn-send-done',
  ],
  'ui.js (receive sheet)': [
    'sheet-receive', 'btn-recv-close', 'recv-net', 'receive-qr', 'btn-recv-copy', 'btn-recv-share',
    'recv-request', 'recv-amount', 'recv-suffix', 'recv-amount-note', 'recv-to-buy',
  ],
  'ui.js (add-token sheet)': [
    'sheet-add-token', 'btn-add-token-close', 'add-token-addr', 'add-token-err', 'btn-add-token-go',
  ],
  'ui.js (security)': [
    'protect-meter', 'protect-title', 'protect-sub', 'chk-passkey', 'chk-backup', 'chk-kit', 'acct-addr',
    'acct-net', 'acct-explorer', 'acct-signed', 'btn-show-qr', 'install-row', 'btn-install',
    'ios-install-note', 'install-generic', 'installed-note', 'offline-ready', 'how-it-works', 'about-prices', 'signout-note',
  ],
  'ui.js (install sheet)': [
    'sheet-install', 'btn-install-close', 'install-title', 'install-sub', 'install-steps-ios', 'install-steps-android',
    'btn-install-now', 'btn-install-later',
  ],
};

const SCRIPT_ORDER = ['webauthn-wire', 'passkey', 'recovery', 'fund', 'qr', 'receive', 'portfolio', 'ui', 'app'];

/* Elements that must sit INSIDE #view-wallet so show() hides them with it. */
const INSIDE_WALLET = [
  'notices', 'activation', 'recovery-banner', 'offline-note', 'tab-home', 'tab-convert', 'tab-security',
  'sheet-token', 'sheet-send', 'sheet-receive', 'sheet-add-token', 'btn-signout', 'addr', 'mana', 'bal',
];

(() => {
  /* --- 1. every id exactly once --- */
  const count = (id) => (html.match(new RegExp(`\\sid="${id}"`, 'g')) || []).length;
  const missing = [], dupes = [];
  for (const [owner, ids] of Object.entries(IDS)) {
    for (const id of ids) {
      const n = count(id);
      if (n === 0) missing.push(`${id} (${owner})`);
      else if (n > 1) dupes.push(`${id} ×${n} (${owner})`);
    }
  }
  assert.deepStrictEqual(missing, [], 'ids missing from index.html');
  assert.deepStrictEqual(dupes, [], 'ids duplicated in index.html');
  const total = Object.values(IDS).reduce((n, a) => n + a.length, 0);
  console.log(`✓ all ${total} script-owned ids are present exactly once`);

  /* --- 2. no id anywhere is duplicated (the contract above is not the only
         thing a duplicate breaks — getElementById returns the first) --- */
  const all = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Map();
  for (const id of all) seen.set(id, (seen.get(id) || 0) + 1);
  const anyDupes = [...seen].filter(([, n]) => n > 1).map(([id, n]) => `${id} ×${n}`);
  assert.deepStrictEqual(anyDupes, [], 'duplicate ids in index.html');
  console.log(`✓ no duplicate ids at all (${seen.size} unique)`);

  /* --- 3. tabs, sheets and notices live inside the wallet section --- */
  const start = html.indexOf('id="view-wallet"');
  assert.ok(start > 0, '#view-wallet exists');
  /* The section's own closing tag, not the first </section> after it (the
     hero is a section too): walk the open/close tags and track depth. */
  let end = -1, depth = 1;
  const tag = /<\/?section\b/g;
  tag.lastIndex = start;
  for (let m; (m = tag.exec(html));) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) { end = m.index; break; }
  }
  assert.ok(end > start, '#view-wallet is closed');
  const outside = INSIDE_WALLET.filter((id) => { const i = html.indexOf(`id="${id}"`); return i < start || i > end; });
  assert.deepStrictEqual(outside, [], 'elements that must be inside #view-wallet');
  console.log('✓ tabs, sheets and notices are nested inside #view-wallet');

  /* --- 4. script order --- */
  const scripts = [...html.matchAll(/<script src="\/js\/([a-z-]+)\.js"><\/script>/g)].map((m) => m[1]);
  assert.deepStrictEqual(scripts, SCRIPT_ORDER, 'script tags in the wrong order');
  console.log('✓ script order: ' + scripts.join(' → '));

  /* --- 5. CSP-friendly: no inline scripts, no inline style attributes --- */
  assert.strictEqual((html.match(/<script(?![^>]*\bsrc=)/g) || []).length, 0, 'inline <script> blocks');
  assert.strictEqual((html.match(/\sstyle="/g) || []).length, 0, 'inline style attributes');
  console.log('✓ no inline scripts or style attributes');

  /* --- 6. the QR scanner and the sheets keep their layering contract:
         qr.js appends .qr-overlay to <body>, so the sheets' z-index must
         stay below the overlay's (checked in the stylesheet) --- */
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'wallet.css'), 'utf8');
  const z = (name) => { const m = css.match(new RegExp(`--z-${name}:\\s*(\\d+)`)); return m ? Number(m[1]) : null; };
  assert.ok(z('qr') != null && z('sheet') != null && z('toast') != null, 'z-index tokens exist');
  assert.ok(z('sheet') < z('qr'), 'the scanner overlay sits above the sheets');
  assert.ok(z('sheet') > z('tabbar') && z('scrim') > z('tabbar'), 'sheets cover the tab bar');
  console.log('✓ layering: tabbar < scrim < sheet < toast/qr');

  console.log('\nALL DOM-ID CHECKS PASSED');
})();
