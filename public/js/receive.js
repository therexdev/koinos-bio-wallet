/* ============================================================
   Receive: your address as a QR code, plus copy and share.

   The other half of Scan QR code. Someone paying you points their camera
   at this; it encodes a `koinos:` payment URI (which our own scanner and
   other wallets read) and the bare address is right there to copy.

   The encoder is vendored (qrcode-generator, MIT, ~56KB) and loaded on the
   first open, not at page load — most sessions never receive.
   ============================================================ */
'use strict';

const Receive = (() => {
  const VENDOR = '/js/vendor/qrcode-generator.js';
  let loading = null;

  function loadEncoder() {
    if (window.qrcode) return Promise.resolve(window.qrcode);
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = VENDOR;
        s.onload = () => (window.qrcode ? resolve(window.qrcode) : reject(new Error('QR encoder failed to load')));
        s.onerror = () => { loading = null; reject(new Error('QR encoder failed to load')); };
        document.head.appendChild(s);
      });
    }
    return loading;
  }

  /** The text a payer's scanner should read. A plain address scans too,
      but the URI form lets a wallet know what chain it is for. */
  const paymentUri = (address, amount) =>
    `koinos:${address}${amount ? `?amount=${encodeURIComponent(amount)}` : ''}`;

  /** Render the QR as inline SVG into `el`. Error level M: a phone camera
      at arm's length reads it fine and the code stays small. `raw` encodes
      the text as given (an Ethereum deposit address is not a koinos: URI). */
  async function render(el, address, { amount = null, cell = 6, margin = 2, raw = false } = {}) {
    const qrcode = await loadEncoder();
    const q = qrcode(0, 'M');
    q.addData(raw ? String(address) : paymentUri(address, amount));
    q.make();
    el.innerHTML = q.createSvgTag({ cellSize: cell, margin, scalable: true });
    const svg = el.querySelector('svg');
    if (svg) {
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', raw ? 'QR code' : 'QR code of your Koinos address');
      svg.style.width = '100%'; svg.style.height = 'auto';
    }
    return q.getModuleCount();
  }

  async function copy(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch (_) { /* fall through */ }
    try { window.prompt('Copy your address:', text); } catch (_) { /* nothing */ }
    return false;
  }

  /** The native share sheet where there is one (every phone), copy where
      there is not. */
  async function share(address) {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'My Koinos address', text: address });
        return 'shared';
      } catch (e) {
        if (e && e.name === 'AbortError') return 'cancelled';
      }
    }
    return (await copy(address)) ? 'copied' : 'prompted';
  }

  return { render, copy, share, paymentUri };
})();
