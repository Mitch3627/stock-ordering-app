# Stock & Ordering

A web app that turns a restaurant manager's manual delivery ordering into an automatic, explainable order plan.
It tracks live stock, use-by dates, waste and counts, then works out what to order for each delivery from the
sales forecast, each item's usage rate (PAR levels) and the stock that will be left when the delivery arrives.

I built it as a shift manager in a busy quick-service restaurant, where working out each order by hand took a
manager a long time and still left out-of-date waste. The aim: accurate orders in minutes, less waste, and real
usage figures for every item.

**Stack:** Node.js 22, Express, SQLite (better-sqlite3), plain HTML/CSS/JavaScript front end, Node's built-in test
runner (222 tests). Runs on one PC with no outside services, or on a server for several stores.

**Demo data:** the item list in `scripts/` is made up for this public copy (generic items, invented prices and
usage rates). It is not any real restaurant's data.

### What it does
- **Order plan** – suggested orders for each delivery: forecast usage until the next delivery + safety buffer −
  stock expected on arrival, rounded to whole cases, capped by max storage and shelf life, then balanced towards a
  cost target per delivery. Click any quantity to see exactly how it was worked out.
- **Live stock log** – every delivery, waste entry, count and day's usage is an event; stock is never overwritten.
- **Use-by tracking** – dated batches, used oldest first; out-of-date stock is flagged for logging as waste.
- **Usage rates** – usage per £100 of sales calculated from two counts, applied only when a manager approves.
- **Shared counts** – two people can split a stock count on different devices.
- **Roles and stores** – crew, manager and admin access; any number of stores from one copy, each with its own
  database; activity log and daily backups.

- **How it works:** [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) – the stock log, use-by dates, counts and the order plan.
- **Hosting it for several stores:** [DEPLOYMENT.md](DEPLOYMENT.md).

## Setting it up on a new PC

1. Install [Node.js](https://nodejs.org) 22 or newer, then in this folder:
   ```
   npm install
   ```
2. **Only for a brand-new, empty database:** load the demo item list from `scripts/`.
   ```
   npm run seed
   ```
   It refuses to run on a database that already has counts or deliveries (it would overwrite usage rates,
   buffers, maxes, prices and units). Stock starts at zero – the first full count sets it.
   To move an existing store onto a new PC instead, copy the newest file from `data/backups/` to
   `data/inventory.db` with the app stopped.
3. Create the first admin, then add everyone else from the **Users** page once signed in:
   ```
   node scripts/manage_users.js add "Full Name" "person@example.com" "a password" admin
   ```

## Running it day to day

- **Easiest:** double-click `start.bat`. It stops any older copy that's still running, starts the app and
  opens `http://localhost:3000` once it's ready.
- **By hand:** `npm start`, then open `http://localhost:3000`.

By default only this PC can open it. To use it from tablets or phones on the restaurant Wi-Fi, start it with
`HOST=0.0.0.0` (in `start.bat`: add `set HOST=0.0.0.0` before `npm start`) and open
`http://<this PC's address>:3000` on the tablet.

| Setting | What it does | Default |
|---|---|---|
| `PORT` | Port to listen on | `3000` |
| `HOST` | Who can connect: `127.0.0.1` this PC only, `0.0.0.0` the whole network | `127.0.0.1` |
| `INVENTORY_DB` | The first store's database file | `data/inventory.db` |
| `HUB_DB` | Sign-ins, the store list and who works where | `hub.db` beside `INVENTORY_DB` |
| `STORE_NAME` | The first store's name, used once when the store list is created | `Northgate` |

## Pages

- **Dashboard** – what needs doing today, the next delivery, stock running low, use-by dates.
- **Stock on hand** – live stock per item, in the supplier's units with cases alongside.
- **Deliveries** – receive a delivery against its confirmed order; delivery history.
- **Waste** – log waste as it happens; out-of-date stock waiting to be logged.
- **Use-by dates** – dated stock, oldest first; give part of a batch a new date.
- **Stock count** – the weekly count, shared so two people can split it; copy for the supplier.
- **Order plan** – suggested orders for each delivery, with how each quantity was worked out.
- **Usage rates** – usage per £100 of sales worked out from two counts.
- **Item master** – every item's settings (units, case sizes, usage, buffer, max, price, use-by dates).
- **Settings** – delivery days, the day each is ordered, the cost target and default daily sales (managers).
- **Users** – who can sign in, where they work and whether they're crew, a manager or an admin (managers and admins).
- **Admin** – stores (add, rename, archive, download a backup), the activity log, and signing everyone out (admins).

## Stores

One copy of the app runs any number of stores. Each store has its own stock, deliveries, waste, counts, orders,
item master and settings, in its own database file (the first store's is `data/inventory.db`; new ones go in
`data/stores/<name>/`). Sign-ins and the store list are in `data/hub.db`. People switch store from the top of the
sidebar and only see the stores they work at. A new store can start from another store's items and settings.

The first time this version starts, the existing database becomes the first store: its sign-ins carry over and
its longest-standing manager becomes the admin.

```
node scripts/manage_stores.js list
node scripts/manage_stores.js add "Eastgate" "Northgate"    (copies Northgate's items and settings)
node scripts/manage_stores.js rename "Old name" "New name"
node scripts/manage_stores.js archive "Name"                     (hidden from everyone; data kept)
node scripts/manage_stores.js restore "Name"
```

## Users

There are three access levels.
- **Crew** log deliveries and waste, fill in the count sheet and add use-by dates.
- **Managers** can also confirm and change orders, enter sales, save counts, correct records, change the item
  master and settings, and add, reset and remove the crew at their stores.
- **Admins** can open every store, and also add, promote and remove managers and admins, choose which stores
  people work at, add and archive stores, download backups, see the activity log and sign everyone out. There's
  always at least one admin.

The same can be done from the command line:

```
node scripts/manage_users.js add "Name" "email" "password" [admin|manager|crew] ["Store, Other store"]
node scripts/manage_users.js set-role "email" admin|manager|crew
node scripts/manage_users.js set-stores "email" "Store, Other store"
node scripts/manage_users.js reset-password "email" "new password"   (signs them out everywhere)
node scripts/manage_users.js sign-out "email"                        (ends their sign-ins everywhere)
node scripts/manage_users.js remove "email"                          (a leaver: signed out, can't sign in)
node scripts/manage_users.js restore "email"
node scripts/manage_users.js list
```
Anyone can change their own password from the key icon at the bottom of the sidebar.

## Backups

The app saves a copy of each store's database once a day into a `backups` folder beside it (for the first store,
`data/backups/`), plus the sign-ins (`hub-<date>.db`), and keeps the newest 14 of each. Admins can also download
a store's data at any time from the Admin page. Scripts that
change data also save a copy there first. While the app runs, don't copy `data/inventory.db` itself (recent
changes may still be in the files next to it) – copy the newest backup instead.

## Tests

```
npm test
```
