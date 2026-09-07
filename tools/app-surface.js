'use strict';

// Android has a permanent wallet-only surface. This is a product capability,
// not user authentication: the browser/PWA remains a separate, full wallet.
const ANDROID_BASE = '/android';
const isAndroidPath = (path) => path === ANDROID_BASE || path.startsWith(ANDROID_BASE + '/');
const isFundingPath = (path) => /^\/api\/fund(?:\/|$)/.test(path);

function requestSurface(path, headers = {}) {
  let android = isAndroidPath(path) || headers['x-wallet-client'] === 'android';
  // Defense in depth for a root API request originating in the APK surface.
  try { android ||= isAndroidPath(new URL(headers.referer).pathname); } catch (_) {}
  return { android, apiPath: isAndroidPath(path) ? path.slice(ANDROID_BASE.length) : path };
}

function androidHtml(html) {
  // Explicit template regions keep removal reviewable; no Buy DOM or funding
  // script is shipped to the Android page, including before JavaScript runs.
  const starts = (html.match(/<!-- WEB_ONLY_START -->/g) || []).length;
  const ends = (html.match(/<!-- WEB_ONLY_END -->/g) || []).length;
  if (starts < 6 || starts !== ends) throw new Error('Android template regions are incomplete');
  return html.replace(/<!-- WEB_ONLY_START -->[\s\S]*?<!-- WEB_ONLY_END -->/g, '')
    .replace('<html lang="en">', '<html lang="en" data-wallet-client="android">')
    .replace('href="/manifest.webmanifest"', 'href="/android/manifest.webmanifest"');
}

module.exports = { ANDROID_BASE, isAndroidPath, isFundingPath, requestSurface, androidHtml };
