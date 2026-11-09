/**
 * Turn the one-time TikTok authorization code into access + refresh tokens.
 * Usage:  npm run tiktok:auth -- PASTE_CODE_HERE
 * (The code is in the address bar after you authorize the app: ...?code=XXXX)
 */
import { buildApp, describeError, updateEnvFile } from '../app.ts';

const code = (process.argv[2] ?? '').trim().replace(/^.*[?&]code=([^&]+).*$/, '$1');
if (!code) {
  console.log('\nUsage: npm run tiktok:auth -- YOUR_AUTH_CODE\n(You can also paste the whole address-bar URL that contains ?code=...)\n');
  process.exit(1);
}
const app = buildApp({ quiet: true });
if (!app.config.tiktok.appKey || !app.config.tiktok.appSecret) {
  console.log('\nFill in TIKTOK_APP_KEY and TIKTOK_APP_SECRET in .env first.\n');
  process.exit(1);
}
try {
  const t = await app.tiktok.exchangeAuthCode(decodeURIComponent(code));
  updateEnvFile({ TIKTOK_ACCESS_TOKEN: t.access_token, TIKTOK_REFRESH_TOKEN: t.refresh_token ?? '' });
  console.log(`\n✔ TikTok authorized${t.sellerName ? ` for ${t.sellerName}` : ''}. Tokens saved to .env (access token valid until ${t.access_expires_at}).`);
  console.log('Next step: npm run verify-api\n');
} catch (e) {
  console.log(`\n✘ Could not exchange the code: ${describeError(e)}\nCodes expire quickly — authorize again and run this command right away.\n`);
  process.exit(1);
}
