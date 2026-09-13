'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Recovery = require('../public/js/recovery.js');
const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');

(async () => {
  // Exercise the actual file and kit lifecycle with generated test keys only.
  const elements = new Map(), downloads = [], registrations = [];
  let generated = 0, blockAutoDownload = false, failActivation = false, finishGeneration;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, disabled: false, textContent: '', href: '', download: '', listeners: {},
      addEventListener(type, callback) { this.listeners[type] = callback; },
      removeAttribute(name) { this[name] = ''; },
      click() {
        if (!blockAutoDownload) downloads.push({ filename: this.download, content: fetch(this.href).then(r => r.text()) });
      },
    });
    return elements.get(id);
  }
  const context = vm.createContext({
    $: element, ADDRESS: 'test-account-address', PAINT_GEN: 0, CREDENTIALS: [],
    PENDING_KIT: null, RELEASE_KIT_DOWNLOAD: null,
    Recovery: { ...Recovery, generate: async () => {
      generated++;
      if (finishGeneration !== undefined) await new Promise(resolve => { finishGeneration = resolve; });
      return Recovery.generate();
    } },
    bsay() {}, renderCredentials() {},
    registerCredential: async credential => {
      if (failActivation) throw new Error('Cancelled');
      registrations.push(credential);
    },
  });
  const start = source.indexOf('  function clearPendingKit()');
  const end = source.indexOf('  /* Recovery mode');
  vm.runInContext(source.slice(start, end), context);
  const click = id => element(id).listeners.click();
  await click('#btn-make-kit');
  assert.equal(downloads.length, 1, 'Creating a kit starts a text-file download');
  const first = await downloads[0].content;
  assert.match(downloads[0].filename, /^koinos-recovery-kit-.*\.txt$/);
  const kit = Recovery.parseKit(first);
  assert.equal(kit.address, context.ADDRESS);
  assert.equal(kit.privateKey, context.PENDING_KIT.privateKey);
  assert.equal(kit.credentialId, context.PENDING_KIT.credentialId);
  assert.equal(element('#kit-text').textContent, first);
  assert.equal(registrations.length, 0, 'Downloading alone must not register a key');
  assert.equal(element('#kit-box').hidden, false);
  element('#btn-kit-download').click();
  assert.equal(await downloads[1].content, first, 'A repeat download must contain the same key');
  await click('#btn-make-kit'); assert.equal(generated, 1, 'Do not replace a pending kit');

  const liveUrl = element('#btn-kit-download').href;
  failActivation = true;
  await click('#btn-kit-activate');
  assert.equal(element('#btn-kit-activate').disabled, false);
  assert.equal(element('#btn-kit-download').href, liveUrl, 'Failed activation keeps the saved kit available');
  failActivation = false;
  await click('#btn-kit-activate');
  assert.equal(registrations[0].credentialId, kit.credentialId, 'Activate the credential from the downloaded file');
  assert.equal(context.PENDING_KIT, null);
  assert.equal(element('#btn-kit-download').href, '');
  assert.equal(element('#kit-text').textContent, '');
  await assert.rejects(fetch(liveUrl), 'Released kit URLs must no longer expose the key');

  // Simulate a browser ignoring the async automatic click, then a direct click.
  blockAutoDownload = true;
  await click('#btn-make-kit');
  assert.equal(generated, 2);
  assert.equal(element('#btn-kit-activate').disabled, false, 'A subsequent kit can be activated');
  assert.equal(element('#kit-box').hidden, false);
  blockAutoDownload = false;
  element('#btn-kit-download').click();
  const manual = Recovery.parseKit(await downloads.at(-1).content);
  assert.equal(manual.privateKey, context.PENDING_KIT.privateKey);
  const manualUrl = element('#btn-kit-download').href;
  await click('#btn-kit-cancel');
  assert.equal(context.PENDING_KIT, null);
  assert.equal(element('#kit-box').hidden, true);
  await assert.rejects(fetch(manualUrl));

  finishGeneration = null;
  const preparing = click('#btn-make-kit');
  await click('#btn-make-kit'); assert.equal(generated, 3, 'Double click cannot create competing kits');
  context.ADDRESS = null; context.PAINT_GEN++;
  finishGeneration(); await preparing;
  assert.equal(context.PENDING_KIT, null, 'Signing out during generation must discard the result');
  assert.equal(element('#btn-kit-download').href, '');

  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /<a[^>]*id="btn-kit-download"[^>]*download[^>]*>Download recovery kit \(\.txt\)<\/a>/);
  assert.match(source.slice(source.indexOf("$('#btn-signout').addEventListener")), /clearPendingKit\(\)/);
  console.log('✓ Recovery .txt contents, repeat/direct download, matching activation, cancellation, and secret cleanup');
})().catch(error => { console.error(error); process.exitCode = 1; });
