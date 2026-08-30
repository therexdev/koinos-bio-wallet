/* ============================================================
   Passkeys for Veive smart accounts.

   The passkey here isn't a key-derivation trick — it IS the account's
   on-chain authority. Creation captures the credential's P-256 public
   key (DER SPKI) so the server can register it in the sign module;
   after that, every transaction is authorized by a WebAuthn assertion
   whose challenge is the transaction id, verified BY THE CHAIN.

   The rpId defaults to this page's hostname, which keeps this
   playground's passkeys fully separate from other usekoinos apps
   (PASSKEY_RPID on the server overrides).
   ============================================================ */
'use strict';

const Passkey = (() => {
  const CRED_KEY = 'bw_smart_cred';

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
  function forget() { try { localStorage.removeItem(CRED_KEY); } catch (_) {} }
  const remembered = () => !!storedId();

  /** Create the credential that will OWN the smart account. ES256 only —
      it's the one algorithm the chain's P-256 verifier speaks. */
  async function createCredential() {
    const existing = storedId();
    const cred = await navigator.credentials.create({
      publicKey: {
        rp: { name: 'Koinos Bio Wallet', id: RP_ID },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: 'Koinos Smart Account',
          displayName: 'Koinos Smart Account',
        },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: 'required',
          userVerification: 'required',
        },
        excludeCredentials: existing ? [{ type: 'public-key', id: fromB64u(existing) }] : [],
      },
    });
    const resp = cred.response;
    if (typeof resp.getPublicKey !== 'function') {
      throw new Error('This browser is too old to export the passkey’s public key — try a current one');
    }
    const spki = resp.getPublicKey();
    if (!spki) throw new Error('The authenticator did not hand over a public key');
    storeId(cred.rawId);
    return { credentialId: b64u(cred.rawId), publicKey: b64u(spki) };
  }

  /** A backup credential for an EXISTING account. Unlike the primary, any
      authenticator is welcome — another device, another ecosystem, a USB
      security key — that's what makes it a backup. Existing credentials are
      excluded so the same authenticator can't double-register. */
  async function createBackupCredential(excludeIds) {
    const cred = await navigator.credentials.create({
      publicKey: {
        rp: { name: 'Koinos Bio Wallet', id: RP_ID },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: 'Koinos Smart Account (backup)',
          displayName: 'Koinos Smart Account (backup)',
        },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        excludeCredentials: (excludeIds || []).map((id) => ({ type: 'public-key', id: fromB64u(id) })),
      },
    });
    const resp = cred.response;
    const spki = typeof resp.getPublicKey === 'function' ? resp.getPublicKey() : null;
    if (!spki) throw new Error('The authenticator did not hand over a public key');
    return { credentialId: b64u(cred.rawId), publicKey: b64u(spki) };
  }

  /** A WebAuthn assertion over the given challenge bytes. Empty allow-list
      opens the platform's picker (synced passkeys included). */
  async function assert(challengeBytes, allowIds) {
    const cred = await navigator.credentials.get({
      publicKey: {
        challenge: challengeBytes,
        rpId: RP_ID,
        userVerification: 'required',
        allowCredentials: (allowIds || []).map((id) => ({ type: 'public-key', id: fromB64u(id) })),
      },
    });
    storeId(cred.rawId);
    return {
      credentialId: b64u(cred.rawId),
      signature: new Uint8Array(cred.response.signature),
      authenticatorData: new Uint8Array(cred.response.authenticatorData),
      clientDataJSON: new Uint8Array(cred.response.clientDataJSON),
    };
  }

  /** Sign-in gesture: any assertion identifies the credential (reads are
      public; real authority is checked per-transaction by the chain). If the
      remembered credential is gone from this device (lost phone, stale
      browser data), fall back to the discoverable picker so any surviving
      credential — a backup passkey included — can answer. */
  async function identify() {
    const id = storedId();
    if (id) {
      try { return (await assert(crypto.getRandomValues(new Uint8Array(32)), [id])).credentialId; }
      catch (e) { if (!e || e.name !== 'NotAllowedError') throw e; }
    }
    return (await assert(crypto.getRandomValues(new Uint8Array(32)), [])).credentialId;
  }

  return { supported, platformReady, remembered, storedId, forget, setRpId, createCredential, createBackupCredential, assert, identify };
})();
