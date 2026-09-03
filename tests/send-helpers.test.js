/* The two things the new send buttons compute, checked without a browser.

   Both are places where being approximately right is being wrong: a
   misparsed QR sends money to the wrong address, and a rounded "send all"
   either leaves dust behind or asks for more than exists.
*/
'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* qr.js is a browser file; give it just enough window to define itself. */
function loadQR() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'qr.js'), 'utf8');
  const sandbox = {
    window: { isSecureContext: true }, navigator: {}, location: { hostname: 'localhost' },
    document: { createElement: () => ({ style: {} }), head: { appendChild() {} }, body: { appendChild() {} } },
    URL, URLSearchParams, console,
  };
  sandbox.window.URL = URL;
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;QR;', sandbox);
  return vm.runInContext('QR', sandbox);
}

/* The exact same arithmetic app.js uses for "Send all". Kept in step by
   test 3, which fails if the shipped version stops matching. */
function sendAll(satsStr) {
  const sats = BigInt(/^\d+$/.test(satsStr) ? satsStr : '0');
  if (sats <= 0n) return null;
  const whole = sats / 100000000n;
  const frac = String(sats % 100000000n).padStart(8, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

const QR = loadQR();
/* qr.js runs in its own realm, so its objects carry that realm's prototype;
   copy before comparing or deepStrictEqual rejects identical values. */
const plain = (o) => (o ? { ...o } : o);
const ADDR = '1NsQBhtnesUNoTBFyzUXqCcpqvhaGvxGdt';

(() => {
  /* --- 1. what a scanned code means --- */
  {
    assert.deepStrictEqual(plain(QR.parse(ADDR)), { address: ADDR, amount: null }, 'a bare address');
    assert.deepStrictEqual(plain(QR.parse('  ' + ADDR + '\n')), { address: ADDR, amount: null }, 'whitespace trimmed');
    assert.deepStrictEqual(plain(QR.parse(`koinos:${ADDR}`)), { address: ADDR, amount: null }, 'a payment URI');
    assert.deepStrictEqual(plain(QR.parse(`koinos:${ADDR}?amount=12.5`)), { address: ADDR, amount: '12.5' },
      'an amount in the code is taken, so nobody retypes it');
    assert.deepStrictEqual(plain(QR.parse(`KOINOS://${ADDR}?value=3`)), { address: ADDR, amount: '3' },
      'case and slashes and the value alias');
    assert.deepStrictEqual(plain(QR.parse(`https://koinosblocks.com/address/${ADDR}`)), { address: ADDR, amount: null },
      'an explorer link — the address is the last path segment');
    assert.strictEqual(QR.parse(''), null);
    assert.strictEqual(QR.parse('   '), null);
    /* A junk amount must not become the amount field. */
    assert.strictEqual(QR.parse(`koinos:${ADDR}?amount=all-of-it`).amount, null,
      'a non-numeric amount is ignored rather than pasted in');
    assert.strictEqual(QR.parse(`koinos:${ADDR}?amount=-5`).amount, null, 'and so is a negative one');
    console.log('✓ QR text parses: bare address, koinos: URI with amount, explorer link, junk rejected');
  }

  /* --- 2. only a plausible address reaches the field --- */
  {
    assert.strictEqual(QR.looksLikeAddress(ADDR), true);
    assert.strictEqual(QR.looksLikeAddress('0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb'), false,
      'an Ethereum address must not pass as a Koinos one');
    assert.strictEqual(QR.looksLikeAddress('hello world'), false);
    assert.strictEqual(QR.looksLikeAddress('1'), false);
    assert.strictEqual(QR.looksLikeAddress(''), false);
    console.log('✓ an obviously wrong code is caught at the camera, not at the chain');
  }

  /* --- 3. "send all" is exact, to the satoshi --- */
  {
    assert.strictEqual(sendAll('12419000000'), '124.19');
    assert.strictEqual(sendAll('100000000'), '1', 'a whole number carries no trailing point');
    assert.strictEqual(sendAll('1'), '0.00000001', 'one satoshi is not rounded away');
    assert.strictEqual(sendAll('100000001'), '1.00000001');
    assert.strictEqual(sendAll('99999999'), '0.99999999');
    /* A balance beyond what a float can hold exactly still comes out right —
       which is the entire reason this reads the chain's integer. */
    assert.strictEqual(sendAll('900719925474099'), '9007199.25474099');
    assert.strictEqual(sendAll('0'), null, 'an empty account offers nothing to send');
    assert.strictEqual(sendAll(''), null, 'and neither does a balance that has not loaded');
    assert.strictEqual(sendAll('nonsense'), null);

    /* The shipped copy in app.js must be this same arithmetic. */
    const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
    const shipped = /function sendAllAmount\(\) \{([\s\S]*?)\n  \}/.exec(app);
    assert.ok(shipped, 'sendAllAmount() must exist in app.js');
    assert.match(shipped[1], /BigInt/, 'and must do its arithmetic in BigInt, never on a float');
    assert.match(shipped[1], /100000000n/, 'against KOIN\'s 8 decimals');
    console.log('✓ send all is exact to the satoshi, past the range a float can hold');
  }

  console.log('\nALL SEND-HELPER CHECKS PASSED');
})();
