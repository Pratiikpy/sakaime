#!/usr/bin/env bash
# Runs the verification gates against the running stack and prints PASS, FAIL or BLOCKED for each.
#   infra/zetaris/scripts/verify.sh                  all gates except the kill drill
#   infra/zetaris/scripts/verify.sh Z-POL Z-AUD      selected gates
#   infra/zetaris/scripts/verify.sh kill-drill --kill-drill
#                                                    the kill drill: stops the API container and runs the engine out of memory
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
command -v node >/dev/null || zt_die "node is not installed"
zt_write_secrets
zt_compose ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'
exec node "$ZT_SCRIPTS/verify.mjs" "$@"
