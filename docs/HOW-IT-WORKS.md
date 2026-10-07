# How it works

A one-page guide for whoever looks after the app next.

## Units
Every item has two units:
- **The supplier's unit** (`supplier_unit`, e.g. Each, KG, Bottle 480 GM): what people count and log in, exactly as
  the supplier's count sheet asks for it.
- **The case** (the order unit): what orders are planned in. `items_per_order_unit` says how many supplier units
  are in one case, and should match the case on the supplier's order screen. Stock is stored in cases.

Where the app counts single units but the supplier orders a case of several (chemicals, gloves), `supplier_order_pack`
holds the supplier's case size and orders are rounded to whole supplier cases.
`price_per_unit` is the price of one of the app's cases (the supplier's price per case ÷ supplier units per case ×
items per case).

## The stock log
Stock is never overwritten. Every change is a row in `inventory_events` (delivery, waste, usage, count
correction), recording who made it, and `inventory_ledger` holds the running total per item.
- **Usage** comes off each day once that day's real sales are entered: `usage_per_100_sales` (cases per £100 of
  sales) × sales ÷ 100.
- **Counts** set stock to what was counted. A count is compared with the stock as it stood at the end of its
  date (not now), so a count saved late doesn't wipe out what was logged after it.
- Anything dated **on or before the latest count** (a late delivery, waste, a sales correction) is recorded
  without moving stock again – the count already includes it.

## Use-by dates
Each item's **Use-by dates** setting (Item master) is one of: *not dated*; *date from the pack* – typed in when a
delivery arrives, and the app asks for any that are missing (`track_use_by`, with an optional usual number of
days in `shelf_life_days` that pre-fills the date and helps planning); or *days after delivery* – every delivery
is dated automatically (`shelf_life_days` only). Dated stock is kept as batches (`batches`). Stock leaving comes off
the oldest date first, and `batch_consumptions` remembers which batches, so an undone waste entry goes back
exactly where it came from. Dated stock can never exceed stock on hand.
Out-of-date stock is **never removed automatically** – it stays until someone logs it as out-of-date waste.
Part of a batch can be given its own date (e.g. taken out to defrost); those re-dated batches are left out of
the shelf life the planner learns from deliveries.

## The order plan
Delivery days and the day each one is ordered are set on the Settings page (Mon / Wed / Fri, ordered
Fri / Mon / Wed, unless changed). Each delivery has to last until the next one arrives.
For each delivery and item:
1. **Expected when it arrives** – stock now, minus forecast usage until then, minus anything going out of date,
   plus confirmed orders due before it.
2. **Needed until the next delivery** – forecast usage from this delivery until the next one arrives, plus the
   safety buffer.
3. **Order** – the shortfall, rounded up to whole cases, then limited by the max in store, the item's shelf life
   (perishables aren't ordered beyond what will be used before they go off) and the supplier's case size.
4. Costs are balanced towards the target per delivery (Settings, £3,500 by default) by moving orders in the
   chosen categories between deliveries.

A **confirmed** order (placed with the supplier) is used as it is, and later deliveries are planned on top of it. The
plan still works out its own suggestion for it, shown with *Compare with suggestion*. Click any quantity to see
the calculation.

## Usage rates
The Usage page compares two counts: used = opening count + deliveries − closing count, minus logged waste,
per £100 of the real sales in between. Rates are only changed when someone applies them.

## Several people
- Each person signs in; sessions last 30 days. Crew log and count; managers also change orders, sales, settings,
  the item master and their stores' crew, and correct records; admins also manage managers, stores and backups
  (the server checks this on every change, the pages just hide what someone can't use).
- Several stores: sign-ins, the store list and who works where are in `hub.db`; each store's data is in its own
  database file. Each request works on the store picked in the sidebar (a cookie), checked against the stores the
  person can open. A store's file keeps a copy of people's names (no passwords) so "logged by" still reads. The count sheet is shared through the server so two people can split a count.
- The database runs in WAL mode, so several people can use it at once.
- Dates are UK dates (Europe/London) whatever the server's clock is set to.

## Where things are
| Part | Files |
|---|---|
| Server and routes | `server.js`, `routes/*.js` |
| Stock log | `ledger/ledger.js`, `lib/batchConsumption.js` |
| Order plan | `routes/orders.js` (schedule, bridging), `lib/orderEngine.js` (quantities), `lib/costSmoothing.js` |
| Database | `db/schema.sql` (new databases), `db/connection.js` (upgrades to existing ones) |
| Pages | `public/*.html` + `public/*.js`; `layout.js` draws the sidebar and top bar; `common.js` shared helpers |
| Tests | `test/*.test.js` (`npm test`) |
