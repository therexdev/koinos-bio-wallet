'use strict';

// Per-page state only. A shared Chrome cookie/localStorage flag would also
// remove Buy from a browser tab or PWA opened by the same person.
const WalletClient = (() => {
  const android = document.documentElement.dataset.walletClient === 'android'
    || /^\/android(?:\/|$)/.test(location.pathname);
  if (android) document.documentElement.dataset.walletClient = 'android';
  return Object.freeze({
    android,
    canBuy: !android,
    apiPath: (path) => android && path.startsWith('/api/') ? '/android' + path : path,
    serviceWorker: android ? '/android/sw.js' : '/sw.js',
    serviceWorkerScope: android ? '/android/' : '/',
  });
})();
