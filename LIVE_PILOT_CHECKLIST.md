# Two-order live pilot: checklist

Do these in order. Stop at the first ✘ and send Claude the details.

## A. Before the pilot (all read-only)
- [ ] `setup.bat` finished and every test passed
- [ ] `verify.bat` (`npm run verify-api`) shows **all checks passed**, especially
      "Search Combinable Packages WORKS for this shop"
- [ ] You sent `data\verify\report.md` to Claude, and the expected field names are confirmed
- [ ] `SHIPHERO_TIKTOK_ID_FIELD` matches what verify-api found
- [ ] Your ShipHero carrier for these orders is **not USPS** (TikTok requires USPS labels from TikTok Shipping)
- [ ] App ran for a day in **Dry Run**, and the dashboard groups look right (same customer, same address per TikTok)

## B. Credentials and approvals needed
| Item | Who | Notes |
|---|---|---|
| TikTok app key + secret | You (Partner Center) | in `.env` only |
| TikTok app scopes: Package Split And Combine, Fulfillment Basic, Order Information, Logistics Basic | You | re-authorize after adding |
| TikTok shop authorization (auth code → tokens) | You | `npm run tiktok:auth` |
| ShipHero refresh token | You (app.shiphero.com/dashboard/users → + Add Third-Party Developer) | API user that can read and merge orders |
| ShipHero webhook (optional) | You | polling works without it |
| Your OK to keep the native ShipHero↔TikTok integration **as is** | You | nothing is disconnected or changed |

## C. Pick the two orders
- [ ] Place (or find) **two real orders from the same buyer, same address**, both *Awaiting shipment*, Seller Shipping,
      in-stock, ship-by deadline at least 24h away
- [ ] Both show in TikTok's combinable list (dashboard → "TikTok combine API" or verify-api output)
- [ ] Put both TikTok order IDs in `.env`: `PILOT_ORDER_IDS=ID1,ID2`
- [ ] Tell the warehouse to **hold** these two orders until the merge shows in ShipHero

## D. Go live for the pilot only
- [ ] In `.env`: `DRY_RUN=false`, keep `PILOT_MODE=true`, keep `TRACKING_MODE=native_verify`
- [ ] Restart (`start.bat`) and turn on **Live mode** in the dashboard
- [ ] **Approve "Combine in TikTok".** Check Seller Center: both orders show one *Combined shipment* package
- [ ] **Approve "Merge in ShipHero".** Check ShipHero: one master plus one merged order, all SKUs, correct quantities
- [ ] Warehouse picks, packs, and prints **one** label in ShipHero
- [ ] Dashboard reaches **TIKTOK_CONFIRMED** (tracking source "native") or shows a clear exception

## E. Verify after shipping, then switch back
- [ ] TikTok: the combined package shows the ShipHero tracking number; both orders are *Awaiting collection / In transit*
- [ ] No duplicate or conflicting tracking on either original order
- [ ] ShipHero: one shipment, one label, correct inventory deduction
- [ ] Customer view in the TikTok app shows a single package
- [ ] Set `DRY_RUN=true` again until the results are reviewed together

Only after all of this is reviewed should automatic combination (`PILOT_MODE=false`) even be discussed.
