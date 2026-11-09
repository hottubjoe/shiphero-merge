# COLDEST Order Merge Engine

When one TikTok customer places several orders, this app:

1. asks **TikTok** which orders it allows to be combined (TikTok decides, not us),
2. waits a few minutes in case more orders come in,
3. **combines them inside TikTok** into one package (with your approval),
4. **merges the matching orders inside ShipHero** (only after TikTok confirms the combination),
5. lets your warehouse pick, pack and print **one label** in ShipHero as usual,
6. makes sure TikTok shows that **one tracking number on the combined package**, and that every original order is linked to it.

It runs **on Railway (cloud): see `RAILWAY.md`**, or on your Windows PC (below). It is **safe by default**: it starts in **Dry Run** (changes nothing) and **Pilot mode** (asks you before every change).

---

## 1. Install Node.js (one time)

1. Go to **https://nodejs.org** and click the big **LTS** download button.
2. Run the installer and click *Next* through every screen.

## 2. Install this app (one time)

1. Unzip `coldest-merge-engine.zip` into its **own** folder, for example `C:\COLDEST\coldest-merge-engine`.
   (Keep it separate from your other automation projects. It doesn't touch them.)
2. Double-click **`setup.bat`**. It installs everything, creates your settings file (`.env`), and runs the automated tests. Wait for "Setup finished".
3. Optional: double-click **`demo.bat`** to watch a full walkthrough against fake TikTok/ShipHero servers. No keys needed.

## 3. Fill in your settings

Right-click **`.env`** → *Open with* → **Notepad**. Fill in:

| Setting | Where to get it |
|---|---|
| `DASHBOARD_PASSWORD` | Make one up (at least 12 characters). |
| `SESSION_SECRET` | Run `start.bat` once with it empty. The app prints a random value you can paste here. |
| `TIKTOK_APP_KEY`, `TIKTOK_APP_SECRET` | partner.tiktokshop.com → **App & Service** → your app → *App key / App secret*. |
| `SHIPHERO_REFRESH_TOKEN` | Open **app.shiphero.com/dashboard/users** → **+ Add Third-Party Developer** → copy the **Refresh Token** it shows. |
| `SHIPHERO_WEBHOOK_SECRET` | Make up a long random string, letters and numbers only (only needed if you set up webhooks, step 7). |

**Leave `DRY_RUN=true` and `PILOT_MODE=true`.**

Your TikTok app needs these permissions (Partner Center → your app → *Manage API scopes*):
- **Package Split And Combine** (`seller.fulfillment.package.write`)
- **Fulfillment Basic** (`seller.fulfillment.basic`)
- **Order Information**
- **Logistics Basic** (for *Get Shipping Providers*)

If you add permissions, authorize the shop again (step 4).

## 4. Connect TikTok (one time)

1. In Partner Center, open your app and use its **authorization link** to authorize the COLDEST shop.
2. You'll land on your app's redirect page. The address bar contains `?code=XXXX`. Copy the **whole address**.
3. Open a command window in the app folder: click the folder's address bar, type `cmd`, and press Enter. Then run:
   ```
   npm run tiktok:auth -- "PASTE_THE_ADDRESS_HERE"
   ```
   The code expires within minutes, so do this right away. Tokens are saved into `.env`, and the app refreshes them automatically from then on.

## 5. Run the read-only API check  ← do this first

Double-click **`verify.bat`**. It **changes nothing**. It checks:
- your TikTok and ShipHero credentials (and saves your shop ID to `.env`),
- **whether TikTok's combine API is available to your US shop** (the key question),
- that TikTok's and ShipHero's real responses contain the exact fields this app expects,
- how ShipHero stores TikTok order numbers.

Then send the file `data\verify\report.md` to Claude. It contains no passwords.

## 6. Start the app and open the dashboard

Double-click **`start.bat`**, keep the window open, and go to **http://localhost:4870**.

The dashboard shows connections, unshipped orders, eligible combinations, approvals, merge/label/tracking status, exceptions, labels avoided, and savings. Controls: Dry Run/Live, automatic eligibility, automatic combination (disabled during the pilot), wait window, **Pause all new merges**, Approve, Retry, and the full audit history.

## 7. Shipment updates from ShipHero (two options)

- **Simplest (fine for the pilot):** do nothing. The app checks ShipHero for the shipment every minute.
- **Instant webhooks (optional):** ShipHero has to reach your PC from the internet. Install Cloudflare Tunnel (`cloudflared`) and run `cloudflared tunnel --url http://localhost:4871`. Then in ShipHero, register a **Shipment Update** webhook pointing to `https://YOUR-TUNNEL/webhooks/shiphero/shipment-update?token=YOUR_SHIPHERO_WEBHOOK_SECRET`.
  Only port **4871** (webhooks only) should be exposed. Never expose 4870 (the dashboard).

## 8. The live two-order pilot

See **`LIVE_PILOT_CHECKLIST.md`**. Don't switch off Dry Run until every item there is checked.

---

### Safety rules built in
- `DRY_RUN=true` by default. Live mode can't be turned on from the dashboard unless `.env` says `DRY_RUN=false`.
- Pilot mode: approval before **every** change, exactly **2** orders, and only order IDs you list in `PILOT_ORDER_IDS`.
- ShipHero is never merged until TikTok's combined package has been **re-read and verified**.
- Every change is written to a ledger *before* it's sent, so the same change is never sent twice. After a timeout, the app **checks TikTok/ShipHero first** before trying again.
- A successful TikTok combination is **never reversed automatically**. Problems go to the Exceptions list.
- By default, tracking is sent by ShipHero's **built-in TikTok integration**, and this app only verifies it. See `docs/API_FINDINGS.md`.
- USPS shipments are flagged for review (TikTok requires USPS labels to come from TikTok Shipping).
- Max 20 orders per group (TikTok's limit per tracking number).

### Files
- `data\coldest-merge.sqlite`: the local database (groups, ledger, audit trail)
- `data\engine.log`: structured log (tokens are masked)
- `docs\API_FINDINGS.md`: what was verified in the official docs, and what still has to be confirmed
- `docs\POSTGRES.md`: moving to PostgreSQL for several machines

### For developers
`npm test` (41 automated tests), `npm run typecheck`, `npm run demo`, and `node --import tsx scripts/fake-servers.ts` (fake TikTok/ShipHero over HTTP on ports 5701/5702).
