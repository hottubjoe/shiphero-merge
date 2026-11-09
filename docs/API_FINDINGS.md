# API findings (US shop): verified vs. still unverified

Researched 2026-11-09 from TikTok Shop Partner Center, ShipHero developer docs and ShipHero help center.
The TikTok reference pages are JavaScript-rendered, so field-level details were read from indexed copies
of the official pages. Anything not confirmed is marked **[VERIFY]** in the code and is checked by
`npm run verify-api` against your real shop before going live.

## TikTok Shop (API version 202309)

| What | Status |
|---|---|
| `GET /fulfillment/202309/combinable_packages/search`, scope **Package Split And Combine** (`seller.fulfillment.package.write`) | Path and scope confirmed in official docs |
| `POST /fulfillment/202309/packages/combine`, body `combinable_packages[]` (each item identifies a package and can list order IDs), same scope | Path, scope and top-level field confirmed. Item field names `id` / `order_ids` and response `packages[]` / `errors[]` are **[VERIFY]** |
| `GET /fulfillment/202309/packages/{package_id}`, scope `seller.fulfillment.basic`; returns `package_id`, `orders[].id`, tracking number, shipping provider | Confirmed |
| `POST /fulfillment/202309/packages/{package_id}/ship` with `self_shipment { tracking_number, shipping_provider_id }` | Documented. See the US caveat below |
| Shipping provider IDs come from **Get Shipping Providers** using the order's `delivery_option_id` | Confirmed. The app never guesses an ID |
| Request signing (HMAC-SHA256, sorted params, path + body, wrapped in app_secret), `x-tts-access-token` header, `shop_cipher` | Confirmed against the published algorithm and multiple independent SDKs |
| `is_on_hold_order` on v202309 orders | Confirmed |
| Policy: one tracking number may cover **at most 20 orders**, all with the same recipient name and address | Confirmed. Enforced (max 20 per group) |

### ⚠ Key US question: is combine-first available by API?
TikTok's Seller Shipping overview lists the **pre-shipping consolidation** API flow
(Search Combinable Packages → Combine Package → Ship Package) under **SEA and LATAM**.
For US 3PL/seller-shipped orders it describes **in-shipping consolidation**: pack the orders together, ship,
then use **Mark Package As Shipped** (`POST /fulfillment/202309/orders/{order_id}/packages`, US-available)
to upload the *same* tracking number to each consolidated order.

TikTok's US Seller University does document combining seller-shipped orders into one package in Seller Center,
so the capability exists for US shops. **Whether the API allows it for COLDEST's app and shop is unknown
until `verify-api` runs.** If Search Combinable Packages returns a permission or availability error, the
combine-first flow cannot run and the app stays in dry-run.

### ⚠ US shipping policy
- Seller Shipping is still available in the US. TikTok announced it would end on Feb 25, 2026, then **paused
  that change** on Feb 17, 2026.
- **USPS labels for TikTok orders must be bought through TikTok Shipping** (since Jan 2026). If ShipHero
  buys USPS labels for these orders, TikTok may reject the tracking. USPS is on `BLOCKED_CARRIERS` by default.

## ShipHero

| What | Status |
|---|---|
| `mergeable_orders` query and `order_merge(data: MergeOrdersInput!)` with `master_order_id` + `sub_order_ids` | Copied exactly from the official "Merge Orders" flow |
| `order(id)` returning `merged_orders { order_id is_master }` | Confirmed (same docs page) |
| Shipment Update webhook: merged orders fire **one webhook per order**, all sharing `shipment_id` + `tracking_number`, with per-order `line_items` | Confirmed. Deduplicated per (shipment, order) |
| Expected webhook reply `{"code":"200","Message":"Success"}` | Confirmed |
| Webhook HMAC header `x-shiphero-hmac-sha256` | **[VERIFY]**: not on the Shipment Update page. The app also accepts a secret `?token=` in the webhook URL |
| `orders(partner_order_id:)`, `allocations { warehouse_id }`, `shipments(order_id:)` field shapes | **[VERIFY]**: checked by `verify-api` |

## ShipHero's native TikTok integration (critical)

From ShipHero's "How to Set Up TikTok Shop with ShipHero" article:
- It imports TikTok orders automatically (US region only), keeps inventory in sync, and **sends tracking back
  to TikTok automatically** when the label comes from a supported carrier.
- **Merged orders are supported.** One tracking number is applied to both master and child orders.
- The article also says TikTok doesn't accept the same tracking number for two separate orders. That's one
  reason TikTok-side combination matters.
- Shipping provider info can be changed **once, within 72 hours** of the first upload.
- Split shipments and Multi-Warehouse are **not** supported for TikTok.
- **No documented way** was found to stop the native integration from sending tracking for specific orders.

**Decision:** because duplicate or conflicting tracking updates couldn't be ruled out, the default is
`TRACKING_MODE=native_verify`. ShipHero's integration sends tracking. This app never does; it only
verifies that TikTok's combined package shows the same tracking number ShipHero shipped, and that every
original order is linked to that package. If anything else appears (different tracking, tracking before
the shipment), the group goes to Exceptions.

Open questions for ShipHero support before considering `TRACKING_MODE=engine`:
1. After a TikTok-side package combination, does the native integration post tracking to the **combined
   package ID**, or to each original order? (The pilot answers this, read-only, in `native_verify` mode.)
2. Can shipment notifications be disabled per order (e.g. by tag) without disabling the store?
3. Does the integration re-import or overwrite TikTok package IDs after a combination?

No global integration setting was changed, and none will be without your explicit approval.
