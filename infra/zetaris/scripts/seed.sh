#!/usr/bin/env bash
# Seeds the running stack: silos, identities, policies, semantic layer and gate fixtures. Idempotent.
# The object store (S3Mock) is in memory, so run this again after every `up` that recreated it.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
command -v node >/dev/null || zt_die "node is not installed"
node "$ZT_SCRIPTS/secrets.mjs" >/dev/null
node "$ZT_SCRIPTS/wait-ready.mjs" 900
node "$ZT_SCRIPTS/seed.mjs"
# The semantic layer over the silos: collection manifest, review_semantics USL, rules, grants. Idempotent.
(cd "$ZT_ROOT" && npx tsx infra/zetaris/scripts/usl.ts ensure)
