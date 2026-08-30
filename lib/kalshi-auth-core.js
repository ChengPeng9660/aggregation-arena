/**
 * @typedef {{ KALSHI_API_KEY_ID?: string, KALSHI_API_PRIVATE_KEY?: string }} KalshiAuthEnv
 * @typedef {(url: URL | string) => Promise<Record<string, string>>} KalshiGetHeaders
 */

// These are the existing public-data origins. Never send credentials to a URL
// discovered in market data, a redirect target, or another API provider.
const KALSHI_ORIGINS = new Set([
  'https://external-api.kalshi.com',
  'https://api.elections.kalshi.com',
]);

/**
 * Optional authentication for public Kalshi GET requests only. The imported key
 * is scoped to this invocation; signed headers are never cached between requests.
 * https://docs.kalshi.com/getting_started/quick_start_authenticated_requests
 * @param {KalshiAuthEnv} [env]
 * @param {() => number} [now]
 * @returns {KalshiGetHeaders}
 */
export function createKalshiGetHeaders(env = {}, now = () => Date.now()) {
  const keyId = (env.KALSHI_API_KEY_ID || '').trim();
  const pem = (env.KALSHI_API_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  if (!keyId && !pem) return async () => ({});
  if (!keyId || !pem) throw new Error('Kalshi authentication requires both API key ID and private key');
  if (!/^[A-Za-z0-9_-]+$/.test(keyId)) throw new Error('Kalshi API key ID has an invalid format');

  /** @type {Promise<CryptoKey> | undefined} */
  let keyPromise;
  return async (input) => {
    const url = new URL(input);
    if (!KALSHI_ORIGINS.has(url.origin) || url.username || url.password
      || !url.pathname.startsWith('/trade-api/v2/')) {
      throw new Error('Kalshi authentication refused an unsupported API destination');
    }
    if (!keyPromise) {
      keyPromise = (async () => {
        try {
          const match = pem.match(/^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END PRIVATE KEY-----$/);
          if (!match) throw new Error('invalid PEM');
          const bytes = Uint8Array.from(atob(match[1].replace(/\s/g, '')), (char) => char.charCodeAt(0));
          return await crypto.subtle.importKey('pkcs8', bytes,
            { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign']);
        } catch {
          // Do not include the supplied key, API ID, or underlying crypto error.
          throw new Error('Kalshi private key must be an unencrypted PKCS8 RSA PEM');
        }
      })();
    }
    const privateKey = await keyPromise;
    // Take the timestamp after key import and afresh for each network attempt.
    // The official docs do not specify a server acceptance/expiry window.
    const milliseconds = now();
    if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) throw new Error('Kalshi signing clock is invalid');
    const timestamp = String(milliseconds);
    let signature;
    try {
      signature = await crypto.subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, privateKey,
        new TextEncoder().encode(`${timestamp}GET${url.pathname}`));
    } catch {
      throw new Error('Kalshi request signing failed');
    }
    return {
      'KALSHI-ACCESS-KEY': keyId,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
      'KALSHI-ACCESS-SIGNATURE': btoa(String.fromCharCode(...new Uint8Array(signature))),
    };
  };
}
