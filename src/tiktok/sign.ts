import crypto from 'node:crypto';

/**
 * TikTok Shop Open API request signature (202309 APIs).
 *
 * Algorithm as published in TikTok's "Sign your API request" guide:
 *  1. Take all query parameters except `sign` and `access_token`, sorted alphabetically by key.
 *  2. Concatenate them as {key}{value}.
 *  3. Put the API path in front.
 *  4. If the body is not multipart/form-data, append the raw request body.
 *  5. Wrap the string with app_secret at both ends.
 *  6. HMAC-SHA256 the result using app_secret as key; hex-encode (lowercase).
 */
export function signTikTokRequest(input: {
  path: string;
  query: Record<string, string>;
  body?: string;
  appSecret: string;
  contentType?: string;
}): string {
  const keys = Object.keys(input.query)
    .filter((k) => k !== 'sign' && k !== 'access_token')
    .sort();
  let base = input.path;
  for (const k of keys) base += k + input.query[k];
  if (input.body && !(input.contentType ?? '').toLowerCase().startsWith('multipart/form-data')) base += input.body;
  base = input.appSecret + base + input.appSecret;
  return crypto.createHmac('sha256', input.appSecret).update(base).digest('hex');
}
