# Hosting it on a server

The app needs no code changes to move from this PC to an always-on server. This is the checklist for when a
server is ready. One copy of the app runs every store: each store's data is in its own database file, and
sign-ins, the store list and who works where are in `hub.db`.

## What the server needs
- Node.js 22 or newer (the same major version as the PC it comes from; `better-sqlite3` is built for it on
  `npm install`).
- The project files, without `node_modules` (run `npm install` fresh on the server) and without `data/`
  (the server gets its own database – see below).

## Settings
| Variable | Purpose | Example |
|---|---|---|
| `NODE_ENV` | `production` on the real server: sign-in cookies need HTTPS, error pages hide code details | `production` |
| `PORT` | Port to listen on | `3000` |
| `HOST` | Leave at the default `127.0.0.1` behind a reverse proxy on the same machine | `127.0.0.1` |
| `TRUST_PROXY` | Set to `loopback` behind a proxy on the same machine, so sign-in limits see each person's address | `loopback` |
| `INVENTORY_DB` | The first store's database; `hub.db` and `stores/` go in the same folder | `/opt/inventory/inventory.db` |
| `HUB_DB` | Only if `hub.db` should live somewhere else | `/opt/inventory/hub.db` |
| `STORE_NAME` | The first store's name, used once when the store list is created | `Northgate` |

## Starting data
Stop the app on the PC, then copy the whole `data` folder to the server's folder (`/opt/inventory/` above):
`hub.db`, `inventory.db` and `stores/`. Copy it only while the app is stopped – recent changes may still be in
the `-wal` files beside each database. From then on the server's copy is the only one used for real orders.

Never keep the database in OneDrive, Dropbox or a shared network folder, and never let two running copies
use the same file.

## Running it continuously
`ecosystem.config.js` (in this folder) runs it under pm2 with `NODE_ENV=production`:
```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # then run the command it prints
```
Edit the `env` block in `ecosystem.config.js` (database folder, port). New stores are added from the Admin page,
not with another pm2 entry.

## HTTPS and an address
Sign-in cookies need HTTPS in production. The simplest route is a reverse proxy on the same server that
handles certificates automatically, e.g. Caddy:
```
northgate.yourdomain.com {
    reverse_proxy localhost:3000
}
```
Caddy issues and renews the certificate on its own. Point a (sub)domain at the server's IP.

## Stores and user accounts
There's no self-signup. Admins add stores on the **Admin** page and people on the **Users** page (managers can
add crew to their own store). The same can be done with scripts on the server (set `INVENTORY_DB` first if it
isn't the default path):
```bash
node scripts/manage_users.js add "Full Name" "person@example.com" "a password" admin
node scripts/manage_users.js add "Full Name" "person@example.com" "a password" manager "Northgate"
node scripts/manage_stores.js add "Eastgate" "Northgate"   # starts from Northgate's items and settings
node scripts/manage_users.js reset-password "person@example.com" "new password"
node scripts/manage_users.js remove "person@example.com"      # someone who's left
node scripts/manage_users.js list
node scripts/manage_stores.js list
```
Stop the app before adding a store from the command line (the Admin page is fine while it runs).
Everyone can change their own password from the key icon at the bottom of the sidebar; doing so signs them
out on their other devices.

## Security already in place
- Passwords hashed with scrypt; only hashes of sign-in tokens are stored, so backups hold no working logins.
- 10 failed sign-ins for an email or device within 15 minutes locks that out for the rest of the 15 minutes.
- Browser security headers (content security policy, no framing, no MIME sniffing; HSTS in production).
- Every stock change, delivery, waste entry, count and confirmed order records who made it; sign-ins and changes
  to people and stores go in the admin activity log.
- People only open the stores they work at; the server checks every request.

## Backups
The app writes a copy of each store once a day into a `backups/` folder beside that store's database, and of
`hub.db` into the `backups/` folder beside it, keeping the newest 14 of each. On a server, also copy the whole
data folder's backups off the machine every night (e.g. `rsync` to another machine or cloud storage), so a
lost server doesn't lose the data too.
