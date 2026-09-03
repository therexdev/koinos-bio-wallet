/* ============================================================
   Scan a QR code with the phone's camera.

   Typing a Koinos address by hand is how people send money to the wrong
   place, so the send form offers the camera instead.

   Two decoders, because neither one covers everybody:

     · BarcodeDetector — native, hardware-accelerated, zero bytes to
       download. Chrome/Android has it.
     · jsQR — the fallback for Safari/iOS, which has no BarcodeDetector.
       256KB, so it is fetched ONLY when the first scan needs it, never at
       page load.

   The camera needs a secure context (https, or localhost). If it is not
   available at all, we say which of the two reasons it is rather than
   showing a dead button.
   ============================================================ */
'use strict';

const QR = (() => {
  const VENDOR = '/js/vendor/jsqr.js';
  let jsqrLoading = null;

  const supported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const secure = () => window.isSecureContext || location.hostname === 'localhost';

  function unavailableReason() {
    if (!secure()) return 'the camera needs a secure (https) connection';
    if (!supported()) return 'this browser will not give a web page camera access';
    return null;
  }

  /** Load jsQR once, and only if we actually need it. */
  function loadJsQR() {
    if (window.jsQR) return Promise.resolve(window.jsQR);
    if (!jsqrLoading) {
      jsqrLoading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = VENDOR;
        s.onload = () => (window.jsQR ? resolve(window.jsQR) : reject(new Error('QR decoder failed to load')));
        s.onerror = () => { jsqrLoading = null; reject(new Error('QR decoder failed to load')); };
        document.head.appendChild(s);
      });
    }
    return jsqrLoading;
  }

  /** One decoder call, whichever backend this browser has. */
  async function makeDecoder() {
    if ('BarcodeDetector' in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) {
          const det = new window.BarcodeDetector({ formats: ['qr_code'] });
          return async (video) => {
            const found = await det.detect(video);
            return found.length ? found[0].rawValue : null;
          };
        }
      } catch (_) { /* fall through to jsQR */ }
    }
    const jsQR = await loadJsQR();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return async (video) => {
      const w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) return null;
      canvas.width = w; canvas.height = h;
      ctx.drawImage(video, 0, 0, w, h);
      const hit = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
      return hit ? hit.data : null;
    };
  }

  /** What a scanned string actually means.

      A QR may hold a bare address or a payment URI — `koinos:1ABC…?amount=2`
      is what other wallets emit — so read the amount too when it is there
      rather than making someone type a number that was in the code. */
  function parse(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    let body = text, amount = null;
    const uri = /^(?:koinos|koin):(?:\/\/)?([^?#]+)(?:\?([^#]*))?/i.exec(text);
    if (uri) {
      body = decodeURIComponent(uri[1]).trim();
      if (uri[2]) {
        const q = new URLSearchParams(uri[2]);
        const a = q.get('amount') || q.get('value');
        if (a && /^\d+(\.\d+)?$/.test(a.trim())) amount = a.trim();
      }
    }
    /* Some wallets wrap the address in a URL; take the last path segment. */
    if (/^https?:\/\//i.test(body)) {
      try {
        const u = new URL(body);
        const last = u.pathname.split('/').filter(Boolean).pop();
        if (last) body = decodeURIComponent(last);
        const a = u.searchParams.get('amount');
        if (!amount && a && /^\d+(\.\d+)?$/.test(a)) amount = a;
      } catch (_) { /* keep body as-is */ }
    }
    return { address: body, amount };
  }

  /** Does this look like a Koinos address? A loose shape check only — the
      server and the chain do the real validation, but catching an obviously
      wrong code at the camera saves a confusing failure later. */
  const looksLikeAddress = (s) => /^1[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(String(s || '').trim());

  /* ---------------- the scanner overlay ---------------- */

  let overlay = null, stream = null, raf = null, cancelled = false;

  function teardown() {
    cancelled = true;
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (overlay) { overlay.remove(); overlay = null; }
  }

  function build() {
    const el = document.createElement('div');
    el.className = 'qr-overlay';
    el.innerHTML = `
      <div class="qr-sheet">
        <div class="qr-head">Point at the QR code</div>
        <div class="qr-stage">
          <video class="qr-video" playsinline muted autoplay></video>
          <div class="qr-frame"></div>
        </div>
        <div class="qr-note">Hold steady — it reads the address by itself.</div>
        <button type="button" class="cta small ghost qr-cancel">Cancel</button>
      </div>`;
    document.body.appendChild(el);
    return el;
  }

  /** Open the camera and resolve with { address, amount } on the first code
      that scans, or null if the person cancels. Rejects only when the camera
      itself cannot be used, with a reason worth showing. */
  async function scan() {
    const why = unavailableReason();
    if (why) throw new Error(why);

    teardown();
    cancelled = false;
    overlay = build();
    const video = overlay.querySelector('.qr-video');

    return new Promise((resolve, reject) => {
      const finish = (val) => { teardown(); resolve(val); };
      const fail = (e) => { teardown(); reject(e); };

      overlay.querySelector('.qr-cancel').addEventListener('click', () => finish(null));
      overlay.addEventListener('click', (ev) => { if (ev.target === overlay) finish(null); });
      const onKey = (ev) => { if (ev.key === 'Escape') finish(null); };
      document.addEventListener('keydown', onKey, { once: true });

      (async () => {
        try {
          /* The rear camera is the one pointed at someone else's screen. */
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' } }, audio: false,
          });
          if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
          video.srcObject = stream;
          await video.play().catch(() => {});
          const decode = await makeDecoder();
          if (cancelled) return;

          const tick = async () => {
            if (cancelled) return;
            let hit = null;
            try { hit = await decode(video); } catch (_) { /* one bad frame */ }
            if (hit) {
              const parsed = parse(hit);
              if (parsed && parsed.address) return finish(parsed);
            }
            raf = requestAnimationFrame(tick);
          };
          tick();
        } catch (e) {
          fail(new Error(
            e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
              ? 'Camera access was blocked — allow it in your browser settings to scan'
              : (e && e.name === 'NotFoundError' ? 'No camera on this device' : (e.message || 'Could not open the camera'))));
        }
      })();
    });
  }

  return { scan, parse, looksLikeAddress, available: () => !unavailableReason(), unavailableReason };
})();
