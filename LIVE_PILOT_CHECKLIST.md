# Two-order live pilot: checklist (Railway)

Do these in order. Stop at the first ✘ and send Claude the details (dashboard → Setup → Run API check → Copy report).

## A. Before the pilot (all read-only)
- [ ] Dashboard opens at your Railway address and you can log in
- [ ] Setup box: TikTok connected, shop shown, ShipHero connected, "Background checks running"
- [ ] **Run API check** shows "Search Combinable Packages WORKS for this shop" and no ✘ lines
- [ ] You pasted the report to Claude, and the field names TikTok actually returned are confirmed
- [ ] The report says how TikTok orders are found in ShipHero (`partner_order_id` or `order_number`);
      if it says "set SHIPHERO_TIKTOK_ID_FIELD=…", that variable is set in Railway
- [ ] The ShipHero carrier for these orders is **not USPS** (TikTok requires USPS labels to come from TikTok Shipping)
- [ ] App ran for a day in **Dry Run**, and the groups on the dashboard look right (TikTok says same buyer, same address)

## B. Things only you can do
| Item | Where | Notes |
|---|---|---|
| TikTok app key + secret | Partner Center → your app | Railway → Variables only |
| App scopes: Package Split And Combine, Fulfillment Basic, Order Information, Logistics Basic | Partner Center → your app | re-authorize the shop after adding scopes |
| Authorize the shop | dashboard → Setup → step 2 | paste the returned address if the page doesn't load |
| Connect ShipHero | dashboard → Setup → step 2b | password used once, never saved |
| ShipHero webhook (optional) | ShipHero → Webhooks → Shipment Update | copy the address from Setup → step 4 |
| Keep ShipHero's native TikTok integration **exactly as is** | — | nothing is disconnected or changed |

## C. Pick the two orders
- [ ] **Two real orders from the same buyer and address**, both *Awaiting shipment*, Seller Shipping, in stock,
      ship-by deadline at least 24 hours away
- [ ] Both show up together in TikTok's combinable list (Run API check, or a group on the dashboard)
- [ ] Railway → Variables: `PILOT_ORDER_IDS=FIRST_ID,SECOND_ID` (TikTok order IDs, comma, no spaces)
- [ ] Tell the warehouse to **hold** these two orders until the merge shows in ShipHero

## D. Go live for the pilot only
- [ ] Railway → Variables: `DRY_RUN=false`. Keep `PILOT_MODE=true` and `TRACKING_MODE=native_verify`
- [ ] After the redeploy, switch the dashboard to **Live**
- [ ] **Approve "Combine in TikTok".** Seller Center: both orders now sit in one combined package
- [ ] **Approve "Merge in ShipHero".** ShipHero: one master order plus one merged order, all SKUs, right quantities
- [ ] Warehouse picks, packs and prints **one** label in ShipHero
- [ ] Dashboard reaches **TIKTOK_CONFIRMED** (tracking source "native"), or shows a clear exception

## E. Check after shipping, then switch back
- [ ] TikTok: the combined package shows the ShipHero tracking number; both orders are *Awaiting collection / In transit*
- [ ] No duplicate or conflicting tracking on either original order
- [ ] ShipHero: one shipment, one label, correct inventory deduction
- [ ] The buyer's view in the TikTok app shows a single package
- [ ] Railway → Variables: `DRY_RUN=true` again until you and Claude have reviewed the result

Turning off pilot mode (`PILOT_MODE=false`) is only worth discussing after all of this has been reviewed.
