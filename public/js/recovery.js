/* ============================================================
   The recovery kit — a manual backup for the smart account.

   A recovery key is a plain P-256 keypair generated HERE, in the page,
   with WebCrypto — the same curve and the same on-chain verification
   path as a passkey, because it is registered in the sign module as one
   more credential. The private key is exportable: the user downloads it
   as a small text file (the kit) and keeps it offline. The server never
   sees it.

   To sign with it, we build a synthetic WebAuthn-shaped assertion:
   well-formed authenticatorData, a clientDataJSON whose challenge is the
   transaction id, and an ECDSA signature over
   authenticatorData ‖ sha256(clientDataJSON) — byte-for-byte what the
   deployed mod-sign-webauthn verifies. Losing every passkey therefore
   costs nothing while the kit exists: it can sign a transaction that
   registers a fresh passkey, or simply move the funds.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./webauthn-wire.js'));
  else root.Recovery = factory(root.WebauthnWire);
})(typeof self !== 'undefined' ? self : this, function (WebauthnWire) {
  'use strict';
  const ALG = { name: 'ECDSA', namedCurve: 'P-256' };
  const SIGN = { name: 'ECDSA', hash: 'SHA-256' };
  const te = new TextEncoder();

  /* The page context baked into synthetic assertions; overridable so the
     shipped file is testable outside a browser. */
  const CTX = typeof location !== 'undefined'
    ? { rpId: location.hostname, origin: location.origin }
    : { rpId: 'localhost', origin: 'http://localhost' };
  const setContext = (c) => Object.assign(CTX, c || {});

  const b64u = (buf) => WebauthnWire.encodeB64u(new Uint8Array(buf));
  const fromB64u = (s) => WebauthnWire.decodeB64u(s);

  /** A fresh recovery credential: id, SPKI public key, PKCS8 private key. */
  async function generate() {
    const kp = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
    const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
    const idBytes = crypto.getRandomValues(new Uint8Array(24));
    return {
      credentialId: 'rk' + b64u(idBytes),
      publicKey: b64u(spki),
      privateKey: b64u(pkcs8),
    };
  }

  async function importKey(privateKeyB64u) {
    return crypto.subtle.importKey('pkcs8', fromB64u(privateKeyB64u), ALG, false, ['sign']);
  }

  /** Sign a transaction id the way the chain expects from this credential:
      a synthetic assertion in the exact mod-sign-webauthn wire format. */
  async function signTx(privateKeyB64u, credentialId, txId) {
    const key = await importKey(privateKeyB64u);
    const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(CTX.rpId)));
    const authenticatorData = new Uint8Array(37);
    authenticatorData.set(rpIdHash, 0);
    authenticatorData[32] = 0x05; // UP | UV
    const clientDataJSON = te.encode(JSON.stringify({
      type: 'webauthn.get',
      challenge: b64u(WebauthnWire.challengeForTxId(txId)),
      origin: CTX.origin,
      crossOrigin: false,
    }));
    const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON));
    const msg = new Uint8Array(authenticatorData.length + clientHash.length);
    msg.set(authenticatorData, 0); msg.set(clientHash, authenticatorData.length);
    const rawRs = new Uint8Array(await crypto.subtle.sign(SIGN, key, msg));
    return {
      credentialId,
      signature: WebauthnWire.derFromRawRS(rawRs),
      authenticatorData,
      clientDataJSON,
    };
  }

  /* ---------------- the kit file ---------------- */

  function kitText({ address, credentialId, privateKey }) {
    return [
      'KOINOS BIO WALLET — RECOVERY KIT',
      '================================',
      'Account:    ' + address,
      'Credential: ' + credentialId,
      'Key:        ' + privateKey,
      '',
      'Anyone holding this file controls the account — keep it OFFLINE',
      '(printed, or on a drive that never touches the internet).',
      'To use it: open the wallet site, choose "Recover with your kit",',
      'and paste this file. You can then add a new passkey or move funds.',
      '',
    ].join('\n');
  }

  function parseKit(text) {
    const t = String(text || '');
    const grab = (label) => (t.match(new RegExp(label + ':\\s*(\\S+)')) || [])[1] || null;
    const out = { address: grab('Account'), credentialId: grab('Credential'), privateKey: grab('Key') };
    if (!out.credentialId || !out.privateKey) return null;
    return out;
  }

  function downloadKit(kit) {
    const blob = new Blob([kitText(kit)], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'koinos-recovery-kit-' + String(kit.address || 'account').slice(0, 8) + '.txt';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }

  return { generate, signTx, kitText, parseKit, downloadKit, setContext };
});
