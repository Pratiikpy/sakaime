#!/usr/bin/env bash
# Stops the Sakaime Zetaris stack and keeps its data (metastore, encryption keypair, hospital database).
#
#   infra/zetaris/scripts/down.sh            stop and remove containers, keep volumes
#   infra/zetaris/scripts/down.sh --purge    also delete the volumes. This destroys the metastore, the field-encryption
#                                            keypair and the hospital database; nothing can be restored afterwards.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

zt_write_secrets
if [ "${1:-}" = "--purge" ]; then
  zt_log "removing containers and volumes of project $ZT_PROJECT"
  zt_compose down -v
else
  zt_log "removing containers of project $ZT_PROJECT, keeping volumes"
  zt_compose down
fi
