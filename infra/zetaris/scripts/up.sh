#!/usr/bin/env bash
# Starts the Sakaime Zetaris stack: the vendor platform (metastore, driver, API, UI) plus the hospital database, the
# object store and the REST silo. Safe to run repeatedly. Needs Docker with the compose plugin and Node 22 or later.
#
#   infra/zetaris/scripts/up.sh            start (pulls images on first use)
#   infra/zetaris/scripts/up.sh --no-wait  start and return without waiting for the platform to answer
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

command -v docker >/dev/null || zt_die "docker is not installed"
docker compose version >/dev/null 2>&1 || zt_die "the docker compose plugin is missing"
command -v node >/dev/null || zt_die "node is not installed"
[ -f "$ZT_BUNDLE/docker-compose.yml" ] || zt_die "the vendor bundle is missing at infra/zetaris/bundle. Download zetaris-platform.zip from your Zetaris Cloud account (Run locally page), unzip it so that infra/zetaris/bundle/docker-compose.yml exists, and run again. See infra/zetaris/README.md."

node "$ZT_SCRIPTS/secrets.mjs" --check >/dev/null || true
zt_write_secrets

driver_image="$(sed -n 's/^DRIVER_IMAGE=//p' "$ZT_DIR/sakaime.env")"
if ! docker image inspect "$driver_image" >/dev/null 2>&1; then
  reg="$(zt_env_get ZETARIS_REGISTRY)"; user="$(zt_env_get ZETARIS_REGISTRY_USER)"; pass="$(zt_env_get ZETARIS_REGISTRY_PASSWORD)"
  [ -n "$reg" ] && [ -n "$user" ] && [ -n "$pass" ] || zt_die "images are not present and ZETARIS_REGISTRY, ZETARIS_REGISTRY_USER and ZETARIS_REGISTRY_PASSWORD are not in .env"
  zt_log "logging in to the Zetaris registry"
  printf '%s' "$pass" | docker login "$reg" -u "$user" --password-stdin >/dev/null
  zt_log "pulling images (about 4 GB the first time)"
  zt_compose pull "${ZT_SERVICES[@]}"
fi

zt_log "starting ${ZT_SERVICES[*]}"
zt_compose up -d "${ZT_SERVICES[@]}"

if [ "${1:-}" = "--no-wait" ]; then
  zt_log "started; run infra/zetaris/scripts/verify.sh to check it"
  exit 0
fi
node "$ZT_SCRIPTS/wait-ready.mjs"
