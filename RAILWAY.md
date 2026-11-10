# Running the COLDEST Merge Engine on Railway

Everything is done by clicking on railway.com. No command line.
Your keys go **only** into Railway's *Variables* tab, never into GitHub.

## 1. Create the service from GitHub
1. Go to **https://railway.com** and sign in (choose *Sign in with GitHub*).
2. Click **New Project → Deploy from GitHub repo**.
   If Railway asks for access to your repositories, allow it for **hottubjoe/shiphero-merge**.
3. Pick **shiphero-merge**. Railway sees the `Dockerfile` and starts building.
   The first deploy will **fail or keep restarting**. That's expected: the passwords aren't set yet (next step).

## 2. Add a volume (permanent storage) ← important
The database holds the safety ledger that prevents duplicate changes, so it must survive restarts.
1. Right-click the service on the project canvas (or press ⌘K / Ctrl+K) → **Add Volume**.
2. **Mount path:** `/data`
3. Keep **1 replica** for this service. Volumes don't support more, and the app is designed to run as a single copy.

## 3. Add your settings (Variables)
Click the service → **Variables** tab → **Raw Editor**, paste this, fill in the blanks, and click **Update Variables**:

```
# Safety: leave as they are for now
DRY_RUN=true
PILOT_MODE=true
PILOT_ORDER_IDS=
TRACKING_MODE=native_verify
BLOCKED_CARRIERS=USPS

# Dashboard login: at least 16 characters, unique to this app
DASHBOARD_PASSWORD=

# TikTok (Partner Center → App & Service → your app)
TIKTOK_APP_KEY=
TIKTOK_APP_SECRET=

# ShipHero: optional. Easiest is dashboard → Setup → Connect ShipHero (sign in once)
SHIPHERO_REFRESH_TOKEN=
# Make up a long random string (letters and numbers only); it goes into the ShipHero webhook address (step 6)
SHIPHERO_WEBHOOK_SECRET=
SHIPHERO_TIKTOK_ID_FIELD=partner_order_id

CONSOLIDATION_WINDOW_MINUTES=5
DEADLINE_SAFETY_HOURS=12
POLL_INTERVAL_SECONDS=60
```
Railway redeploys automatically. You do **not** need `PORT`, `HOST` or `DATABASE_FILE`; the Dockerfile handles them.
`TIKTOK_ACCESS_TOKEN` and `TIKTOK_SHOP_CIPHER` aren't needed either: the dashboard sets them up (step 5).

## 4. Get your web address
1. Service → **Settings → Networking → Generate Domain**.
2. You'll get something like `https://shiphero-merge-production.up.railway.app`. Open it and sign in with your `DASHBOARD_PASSWORD`.
3. Optional: Service → **Settings → Healthcheck Path** = `/healthz`.

## 5. Connect TikTok and run the check (from the dashboard)
1. Dashboard → **Setup** box. Copy the **TikTok redirect URL** shown there (`https://YOUR-ADDRESS/tiktok/callback`).
2. TikTok Partner Center → your app → set that as the **Redirect URL**, and make sure these scopes are on:
   *Package Split And Combine, Fulfillment Basic, Order Information, Logistics Basic*.
3. Open your app's **authorization link** and authorize the COLDEST shop. TikTok sends you back to the dashboard. Click **Finish connecting**.
   (If the redirect can't be set, copy the address you land on, which contains `code=`, and paste it into **Connect TikTok** in the Setup box.)
4. Click **Run API check**. It changes nothing. Then click **Copy report** and paste it to Claude.

## 6. ShipHero shipment webhook (optional)
The app already checks ShipHero for shipments every minute. For instant updates, add a **Shipment Update** webhook in ShipHero with this URL:
```
https://YOUR-ADDRESS/webhooks/shiphero/shipment-update?token=YOUR_SHIPHERO_WEBHOOK_SECRET
```

## Updating
Every change pushed to the GitHub repo deploys automatically. Each redeploy has a few seconds of downtime (one copy with a volume). Nothing is lost: interrupted work is resumed safely on start.

## Security notes
- Only the dashboard login, the health check (`/healthz`, reveals nothing) and the signed webhook route are reachable without a password.
- Wrong passwords lock that visitor out for 5 minutes after 5 tries, and all logins lock for 15 minutes after 20 failures from anywhere.
- Login cookies are HTTPS-only and expire after 12 hours.
- TikTok tokens are stored in the database on your private volume and are never shown in the dashboard or logs.
