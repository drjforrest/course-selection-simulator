# VPS Deployment

Runs the MSHI Course Selection Simulator on the Contabo VPS at **https://course-simulator.drjforrest.com**, next to the sites already hosted there.

## Architecture

```
Internet ──► Caddy (443) ──► drjforrest.com / www                   ──► localhost:3005  (forrest-frontend)
                          └► mind-the-gap.drjforrest.com           ──► localhost:3007
                          └► rounds-and-square-pegs.drjforrest.com ──► localhost:3006
                          └► citation-network.drjforrest.com       ──► localhost:8001
                          └► course-simulator.drjforrest.com       ──► localhost:3011  (this app; 3010 is vitae-app)
```

Same VPS (`Contabo-vps6`, host `144.91.72.223`, SSH alias `Contabo-vps6`, user `admin`).

The app is a single Node process (`server.js`) with no npm dependencies and no build step. It serves the student page (`/`), the faculty page (`/faculty`) and a small JSON API. Faculty settings are saved to `data/overrides.json` on the server. Students' plans are never stored.

## DNS

| Name | Type | Value |
| --- | --- | --- |
| `course-simulator.drjforrest.com` | A | `144.91.72.223` (proxied) |

Caddy issues the TLS certificate automatically on the first HTTPS request after the record resolves. Set the record to **DNS only** (grey cloud) until the first certificate is issued. Then turn the proxy on (orange cloud), with SSL/TLS mode **Full (strict)**, to keep the VPS address private.

Behind the proxy, the app takes the visitor's address from Cloudflare's `CF-Connecting-IP` header, but only when the request actually came from a Cloudflare address (`client-ip.js`). The faculty sign-in limit therefore counts each visitor separately. If Cloudflare publishes new IP ranges (https://www.cloudflare.com/ips), update the list in `client-ip.js`.

## What's in this directory

| File | Purpose |
| --- | --- |
| `deploy.sh` | `setup` (one-time) and deploy (every release) |
| `course-simulator.service` | systemd unit template; `setup` fills in the user, path and Node binary |
| `Caddyfile.snippet` | Caddy site block template; `setup` fills in the domain and port and installs it as `/etc/caddy/conf.d/course-simulator.caddy` |

Settings live at the top of `deploy.sh`: `SERVER_HOST`, `SERVER_PATH` (`/var/www/course-simulator`), `SERVICE_NAME` (`course-simulator`), `SERVICE_PORT` (`3011`) and `DOMAIN`.

## Prerequisites on the VPS

- Node.js 18 or newer on the default PATH for non-interactive SSH (`ssh Contabo-vps6 'node -v'` must work). The existing Next.js site already needs Node, so this is normally true. An nvm-only install is not visible to systemd.
- Caddy running from `/etc/caddy/Caddyfile`, which imports `/etc/caddy/conf.d/*.caddy` (one file per site).
- Passwordless `sudo` for `admin`, as the other deploy scripts already use.

## One-time setup

```bash
./deploy/deploy.sh setup
```

This command:

1. Checks the Node version, and checks that port 3011 is free. If another process holds the port, it stops and tells you to change `SERVICE_PORT`. It never kills other processes.
2. Creates `/var/www/course-simulator` (and `data/`), owned by `admin`.
3. Creates `/var/www/course-simulator/.env` (mode 600) containing a randomly generated `FACULTY_PASSWORD`, plus `PORT=3011`, `HOST=127.0.0.1` and `COOKIE_SECURE=1`. If the file already exists, it is left alone.
4. Installs and enables the `course-simulator` systemd unit.
5. Writes the site block to `/etc/caddy/conf.d/course-simulator.caddy`, backing up any existing copy first, and validates the whole Caddy config. If validation passes it reloads Caddy; if it fails it restores the previous file (or removes the new one). Other sites' files are never touched.

Get the faculty password to share with faculty:

```bash
ssh Contabo-vps6 'cat /var/www/course-simulator/.env'
```

To change the password, edit `FACULTY_PASSWORD` in that file, then run `ssh Contabo-vps6 'sudo systemctl restart course-simulator'`. Restarting signs out every faculty session.

## Deploying

```bash
./deploy/deploy.sh
```

What it does:

1. Runs `npm test` locally and stops if anything fails.
2. Syncs only the runtime files: `public/` (with `--delete`), `server.js`, `client-ip.js`, `package.json` and `data/base.json`. It does **not** touch `data/overrides.json` (faculty settings) or `.env`. Source spreadsheets, scripts, tests and local dev data stay on your machine.
3. Restarts the service and waits until it answers on `127.0.0.1:3011`. If it doesn't, the script prints the last 30 log lines and exits with an error.
4. Checks `https://course-simulator.drjforrest.com`. It only warns if this fails, because DNS or the certificate may still be pending.

## Updating course data

When there is a new schedule spreadsheet or a new catalogue year:

1. Replace `scripts/schedule.xlsx`, or update the pools and prerequisites in `scripts/build_base.py`.
2. Run `npm run build-data`, which regenerates `data/base.json`. This needs Python 3 and openpyxl.
3. Run `npm test`, then `./deploy/deploy.sh`.

Faculty settings in `data/overrides.json` still apply on top of the new data.

## Backups

The only state on the server is `data/overrides.json`. Copy it down occasionally:

```bash
scp Contabo-vps6:/var/www/course-simulator/data/overrides.json ./overrides-$(date +%Y%m%d).json
```

## Troubleshooting

```bash
ssh Contabo-vps6 'sudo systemctl status course-simulator --no-pager; sudo journalctl -u course-simulator -n 100 --no-pager'
ssh Contabo-vps6 'sudo journalctl -u caddy -n 50 --no-pager'        # certificate or proxy problems
ssh Contabo-vps6 'curl -s http://127.0.0.1:3011/api/session'        # app answering locally?
```

- **"Faculty sign-in is not configured"**: `.env` is missing `FACULTY_PASSWORD`, or the service wasn't restarted after you edited it.
- **Faculty can't stay signed in**: the site must be reached over HTTPS, because `COOKIE_SECURE=1` makes the browser drop the cookie on plain HTTP.
- **Removing the app**: run `sudo systemctl disable --now course-simulator`, delete the unit file and `/etc/caddy/conf.d/course-simulator.caddy`, reload Caddy, then remove `/var/www/course-simulator`.
