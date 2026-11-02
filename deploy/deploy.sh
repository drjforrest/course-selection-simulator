#!/bin/bash
# MSHI Course Selection Simulator → VPS
#
#   ./deploy/deploy.sh setup   one-time: directories, .env with faculty password, systemd unit, Caddy site block
#   ./deploy/deploy.sh         deploy: run tests, sync app files, restart service, health check
#
# Safe to re-run. Neither command touches data/overrides.json (faculty settings) or the server .env.

set -euo pipefail

SERVER_USER="admin"
SERVER_HOST="Contabo-vps6"
SERVER_PATH="/var/www/course-simulator"
SERVICE_NAME="course-simulator"
SERVICE_PORT="3011"
DOMAIN="course-simulator.drjforrest.com"
CADDY_SITE="/etc/caddy/conf.d/${SERVICE_NAME}.caddy"  # imported by /etc/caddy/Caddyfile

SSH_TARGET="${SERVER_USER}@${SERVER_HOST}"
SSH_OPTS=(-o Ciphers=aes256-gcm@openssh.com)

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

for f in package.json server.js client-ip.js data/base.json public/index.html; do
	if [ ! -f "$PROJECT_ROOT/$f" ]; then
		error "$f not found under $PROJECT_ROOT"
		exit 1
	fi
done

remote() { ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "$@"; }

render() { # template file → stdout with placeholders filled
	sed -e "s|__USER__|${SERVER_USER}|g" \
		-e "s|__PATH__|${SERVER_PATH}|g" \
		-e "s|__NODE__|${NODE_BIN:-}|g" \
		-e "s|__DOMAIN__|${DOMAIN}|g" \
		-e "s|__PORT__|${SERVICE_PORT}|g" \
		"$1"
}

setup() {
	info "Checking Node.js on ${SERVER_HOST} (needs 18+)"
	NODE_BIN="$(remote 'command -v node' || true)"
	if [ -z "$NODE_BIN" ]; then
		error "node is not installed (or not on the default PATH) on ${SERVER_HOST}"
		exit 1
	fi
	NODE_MAJOR="$(remote "$NODE_BIN -p 'process.versions.node.split(\".\")[0]'")"
	if [ "$NODE_MAJOR" -lt 18 ]; then
		error "Node $NODE_MAJOR found at $NODE_BIN; 18 or newer is required"
		exit 1
	fi
	info "Using $NODE_BIN (Node $NODE_MAJOR)"

	info "Checking port ${SERVICE_PORT} is free (or already ours)"
	remote "
		if sudo ss -ltnH 'sport = :${SERVICE_PORT}' | grep -q . && ! systemctl is-active --quiet ${SERVICE_NAME}; then
			echo 'Port ${SERVICE_PORT} is used by another process:'
			sudo ss -ltnpH 'sport = :${SERVICE_PORT}'
			exit 1
		fi
	" || { error "Pick a free SERVICE_PORT in deploy/deploy.sh and re-run setup"; exit 1; }

	info "Creating ${SERVER_PATH}"
	remote "
		set -e
		sudo mkdir -p ${SERVER_PATH}/data
		sudo chown -R ${SERVER_USER}:${SERVER_USER} ${SERVER_PATH}
	"

	info "Creating server .env (kept if it already exists)"
	remote "
		set -e
		if [ -f ${SERVER_PATH}/.env ]; then
			echo 'exists, leaving it alone'
		else
			umask 077
			{
				echo \"FACULTY_PASSWORD=\$(openssl rand -base64 18 | tr -d '/+=')\"
				echo 'PORT=${SERVICE_PORT}'
				echo 'HOST=127.0.0.1'
				echo 'COOKIE_SECURE=1'
			} > ${SERVER_PATH}/.env
			echo 'created with a generated faculty password'
		fi
	"

	info "Installing systemd unit ${SERVICE_NAME}"
	render "$SCRIPT_DIR/course-simulator.service" | remote "
		set -e
		cat > /tmp/${SERVICE_NAME}.service
		sudo mv /tmp/${SERVICE_NAME}.service /etc/systemd/system/${SERVICE_NAME}.service
		sudo systemctl daemon-reload
		sudo systemctl enable ${SERVICE_NAME}
	"

	info "Writing Caddy site ${CADDY_SITE}"
	render "$SCRIPT_DIR/Caddyfile.snippet" | remote "
		set -e
		grep -q 'conf.d/\\*.caddy' /etc/caddy/Caddyfile || { echo '/etc/caddy/Caddyfile does not import conf.d/*.caddy'; exit 1; }
		cat > /tmp/${SERVICE_NAME}.caddy
		backup=''
		if [ -f ${CADDY_SITE} ]; then backup=${CADDY_SITE}.bak.\$(date +%Y%m%d-%H%M%S); sudo cp ${CADDY_SITE} \$backup; fi
		sudo mv /tmp/${SERVICE_NAME}.caddy ${CADDY_SITE}
		if sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile > /dev/null 2>&1; then
			sudo systemctl reload caddy
			echo 'Caddy reloaded'
		else
			if [ -n \"\$backup\" ]; then sudo mv \$backup ${CADDY_SITE}; else sudo rm -f ${CADDY_SITE}; fi
			echo 'Caddy validation failed; previous config restored'
			exit 1
		fi
	"

	info "Setup done. Now run: ./deploy/deploy.sh"
	info "Faculty password: ssh ${SERVER_HOST} 'cat ${SERVER_PATH}/.env'"
}

deploy() {
	info "Running tests"
	(cd "$PROJECT_ROOT" && npm test --silent) || { error "Tests failed; not deploying"; exit 1; }

	if ! remote "test -f ${SERVER_PATH}/.env && test -f /etc/systemd/system/${SERVICE_NAME}.service"; then
		error "Server is not set up yet. Run: ./deploy/deploy.sh setup"
		exit 1
	fi

	# Only the runtime files go up. data/ is synced without --delete so faculty settings
	# (data/overrides.json) survive every deploy.
	info "Syncing app → ${SERVER_HOST}:${SERVER_PATH}"
	rsync -az --delete -e "ssh ${SSH_OPTS[*]}" --exclude '.DS_Store' \
		"$PROJECT_ROOT/public/" "${SSH_TARGET}:${SERVER_PATH}/public/"
	rsync -az -e "ssh ${SSH_OPTS[*]}" \
		"$PROJECT_ROOT/server.js" "$PROJECT_ROOT/client-ip.js" "$PROJECT_ROOT/package.json" "${SSH_TARGET}:${SERVER_PATH}/"
	rsync -az -e "ssh ${SSH_OPTS[*]}" \
		"$PROJECT_ROOT/data/base.json" "${SSH_TARGET}:${SERVER_PATH}/data/"

	info "Restarting ${SERVICE_NAME}"
	remote "
		set -e
		sudo systemctl restart ${SERVICE_NAME}
		for i in 1 2 3 4 5 6 7 8 9 10; do
			curl -fs -o /dev/null http://127.0.0.1:${SERVICE_PORT}/api/session && break
			sleep 1
		done
		if ! curl -fsS -o /dev/null http://127.0.0.1:${SERVICE_PORT}/api/session; then
			echo 'FATAL: service is not answering on :${SERVICE_PORT}'
			sudo journalctl -u ${SERVICE_NAME} -n 30 --no-pager
			exit 1
		fi
		sudo systemctl status ${SERVICE_NAME} --no-pager -l | head -5
	"

	info "Checking https://${DOMAIN}"
	if curl -fsS -o /dev/null --max-time 15 "https://${DOMAIN}/api/session"; then
		info "Live at https://${DOMAIN}  (faculty: https://${DOMAIN}/faculty)"
	else
		warn "Not reachable over HTTPS yet. If DNS was just added, wait for it to propagate;"
		warn "Caddy issues the certificate on the first request. Watch: ssh ${SERVER_HOST} 'sudo journalctl -u caddy -f'"
	fi
	info "Logs: ssh ${SERVER_HOST} 'sudo journalctl -u ${SERVICE_NAME} -f'"
}

case "${1:-deploy}" in
	setup) setup ;;
	deploy) deploy ;;
	*) echo "Usage: $0 [setup|deploy]"; exit 1 ;;
esac
