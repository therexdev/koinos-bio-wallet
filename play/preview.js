'use strict';
// Reproducible layout fixture for screenshots. No authentication, signing,
// API calls or real balances. Never served by the production public directory.
// Usage: node play/preview.js /absolute/output/directory
const fs = require('node:fs');
const path = require('node:path');
const { androidHtml } = require('../tools/app-surface');
const out = process.argv[2];
if (!out || !path.isAbsolute(out)) throw new Error('Provide an absolute output directory');
fs.mkdirSync(out, { recursive: true });
const root = path.join(__dirname, '..', 'public');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const inline = s => s.replace(/<\/script/gi, '<\\/script');
const fixture = `
  const sampleAddress = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
  document.querySelector('#view-landing').hidden = true;
  document.querySelector('#view-wallet').hidden = false;
  const cfg = { demo: true, nativeSymbol: 'KOIN', networkLabel: 'Koinos mainnet' };
  UI.setContext({ cfg, address: sampleAddress, active: true });
  UI.onView('#view-wallet');
  UI.paintProtection([{ id: 'sample-passkey', kind: 'passkey', label: 'This phone' }], null, true, true);
  UI.paintPortfolio(Portfolio.model({ demo: true, address: sampleAddress, network: 'mainnet', mana: 100,
    allPriced: true, totalUsd: 0, assets: [
      { id: 'koin', symbol: 'KOIN', name: 'Koin', native: true, decimals: 8, sats: '0', usd: 0 },
      { id: 'vhp', symbol: 'VHP', name: 'Vapor', decimals: 8, sats: '0', usd: 0 }
    ] }));
  document.querySelector('#cred-list').innerHTML = '<li><span class="cred-kind passkey">passkey</span> <span class="cred-label">This phone</span> <span class="cred-now">— in use here</span></li>';
`;
for (const surface of ['android', 'web']) {
  let html = read('index.html');
  if (surface === 'android') html = androidHtml(html);
  html = html.replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<link[^>]+>/g, '')
    .replace('</head>', '<style>' + read('css/wallet.css') + '</style></head>');
  const scripts = ['js/client.js', 'js/portfolio.js', 'js/vendor/qrcode-generator.js', 'js/receive.js', 'js/ui.js'];
  html = html.replace('</body>', scripts.map(p => '<script>' + inline(read(p)) + '</script>').join('\n') + '<script>' + fixture + '</script></body>');
  fs.writeFileSync(path.join(out, surface + '.html'), html);
  fs.writeFileSync(path.join(out, surface + '-frame.html'), '<!doctype html><html><body style="margin:0;background:#121212"><iframe title="Wallet preview" src="' + surface + '.html" style="display:block;border:0;width:360px;height:640px"></iframe></body></html>');
}
console.log('Wallet layout fixtures saved to ' + out);
