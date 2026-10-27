#!/usr/bin/env bash
# Shared helpers for the Sakaime Zetaris scripts. Source it; do not run it.

ZT_SCRIPTS="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ZT_DIR="$(cd -- "$ZT_SCRIPTS/.." && pwd)"
ZT_ROOT="$(cd -- "$ZT_DIR/../.." && pwd)"
ZT_BUNDLE="$ZT_DIR/bundle"
ZT_RUNTIME="$ZT_DIR/.runtime"
ZT_PROJECT="sakaime-zetaris"
# Services started by `up`. The vendor `bootstrap` job is left out on purpose: it registers two sample datasets from
# public S3 and starts a second Spark session, which this stack does not need.
ZT_SERVICES=(postgres init driver api ui hospital-db object-store rest-silo)

zt_die() { printf 'error: %s\n' "$*" >&2; exit 1; }
zt_log() { printf '[zetaris] %s\n' "$*"; }

# Reads one KEY from the repository .env without sourcing the file.
zt_env_get() {
  local key=$1 file="${2:-$ZT_ROOT/.env}"
  [ -f "$file" ] || return 0
  grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2- | tr -d '\r' | sed -e 's/^"//' -e 's/"$//'
}

# Writes .runtime/secrets.env (mode 600) from the repository .env, using the variable names the vendor compose file
# and the overlay read.
zt_write_secrets() {
  mkdir -p "$ZT_RUNTIME"
  ( umask 077
    {
      printf 'POSTGRES_PASSWORD=%s\n' "$(zt_env_get SAKAIME_ZETARIS_PG_PASSWORD)"
      printf 'ZETARIS_ADMIN_PASSWORD=%s\n' "$(zt_env_get SAKAIME_ZETARIS_ADMIN_PASSWORD)"
      printf 'SAKAIME_HOSPITAL_PG_PASSWORD=%s\n' "$(zt_env_get SAKAIME_HOSPITAL_PG_PASSWORD)"
    } > "$ZT_RUNTIME/secrets.env" )
  grep -qE '=$' "$ZT_RUNTIME/secrets.env" && zt_die "a secret is empty; run: node infra/zetaris/scripts/secrets.mjs"
  return 0
}

# docker compose with the project name, project directory, environment files and overlay of this stack.
zt_compose() {
  docker compose \
    -p "$ZT_PROJECT" \
    --project-directory "$ZT_BUNDLE" \
    --env-file "$ZT_DIR/sakaime.env" \
    --env-file "$ZT_RUNTIME/secrets.env" \
    -f "$ZT_BUNDLE/docker-compose.yml" \
    -f "$ZT_DIR/docker-compose.sakaime.yml" \
    "$@"
}

zt_port() { # zt_port UI_PORT
  sed -n "s/^$1=//p" "$ZT_DIR/sakaime.env" | tail -n 1
}
