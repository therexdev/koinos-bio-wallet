/* ============================================================
   Passkey wallets — the wallet IS the passkey.

   WebAuthn's PRF extension makes the device's authenticator produce a
   deterministic 32-byte secret, gated by the device's own unlock (face,
   fingerprint, or PIN — the OS decides). We turn that secret into the
   account's secp256k1 key, so ONE SCAN both creates and re-opens the
   wallet, on every device the passkey syncs to. Non-custodial end to end.

   INTEROP: the derivation salt and (apex-domain) rpId are shared with the
   other usekoinos.com apps — the same passkey opens the SAME wallet on
   all of them. Both values are protocol, not preference.
   ============================================================ */
'use strict';

const Passkey = (() => {
  const CRED_KEY = 'bw_passkey_id';
  /* The usekoinos ecosystem's wallet-derivation salt. CHANGING IT CHANGES
     EVERY PASSKEY WALLET'S ADDRESS. */
  const SALT = new TextEncoder().encode('discover-koinos:wallet:v1');

  /* The relying-party id passkeys bind to. The server supplies the APEX
     domain (e.g. usekoinos.com) so one passkey serves every subdomain;
     unset it falls back to this page's hostname (local dev). */
  let RP_ID = location.hostname;
  const setRpId = (id) => { if (id) RP_ID = String(id); };

  const supported = () =>
    !!(window.isSecureContext && window.PublicKeyCredential && navigator.credentials);

  async function platformReady() {
    if (!supported()) return false;
    try { return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); }
    catch (_) { return false; }
  }

  const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const fromB64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

  function storeId(rawId) { try { localStorage.setItem(CRED_KEY, b64u(rawId)); } catch (_) {} }
  function storedId() { try { return localStorage.getItem(CRED_KEY); } catch (_) { return null; } }
  const remembered = () => !!storedId();

  /* PRF secret → secp256k1 private key: SHA-256 whitening plus a curve-order
     range check, deterministically iterated on the (astronomically unlikely)
     miss. Same PRF value → same key, forever. */
  const CURVE_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
  async function deriveWif(prfBytes) {
    let bytes = new Uint8Array(prfBytes);
    for (let i = 0; i < 16; i++) {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const hex = Array.from(digest).map(b => b.toString(16).padStart(2, '0')).join('');
      const k = BigInt('0x' + hex);
      if (k > 0n && k < CURVE_N) return new Signer({ privateKey: hex }).getPrivateKey('wif', true);
      bytes = digest;
    }
    throw new Error('key derivation failed');
  }

  const challenge = () => crypto.getRandomValues(new Uint8Array(32));
  function prfFrom(cred) {
    const ext = cred.getClientExtensionResults();
    return (ext && ext.prf && ext.prf.results && ext.prf.results.first) || null;
  }

  async function assertPrf(allowIds) {
    const cred = await navigator.credentials.get({
      publicKey: {
        challenge: challenge(),
        rpId: RP_ID,
        userVerification: 'required',
        allowCredentials: (allowIds || []).map(id => ({ type: 'public-key', id: fromB64u(id) })),
        extensions: { prf: { eval: { first: SALT } } },
      },
    });
    const prf = prfFrom(cred);
    if (!prf) throw new Error('This passkey can’t derive a wallet key (no PRF support on this device)');
    storeId(cred.rawId);
    return prf;
  }

  /** Create the passkey AND the wallet inside it. */
  async function create() {
    const existing = storedId();
    const cred = await navigator.credentials.create({
      publicKey: {
        rp: { name: 'Koinos Bio Wallet', id: RP_ID },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: 'Koinos Wallet',
          displayName: 'Koinos Wallet',
        },
        challenge: challenge(),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: 'required',
          userVerification: 'required',
        },
        excludeCredentials: existing ? [{ type: 'public-key', id: fromB64u(existing) }] : [],
        extensions: { prf: { eval: { first: SALT } } },
      },
    });
    storeId(cred.rawId);
    let prf = prfFrom(cred);
    if (!prf) prf = await assertPrf([b64u(cred.rawId)]);   // some platforms eval PRF only on get()
    return deriveWif(prf);
  }

  /** Unlock: the same scan re-derives the same key. Empty allow-list opens
      the platform's picker (synced passkeys included). */
  async function unlock() {
    const id = storedId();
    const prf = await assertPrf(id ? [id] : []);
    return deriveWif(prf);
  }

  return { supported, platformReady, remembered, setRpId, create, unlock };
})();
