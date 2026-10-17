# OpenBao: create and inspect the policy and AppRole the backend reads its model credential with.
# See apps/dpi-backend/src/secrets.ts. `apply` mutates the live store and is operator-gated.

set shell := ["zsh", "-cu"]
set positional-arguments
set working-directory := "../../apps/dpi-backend"

# List openbao commands
[default]
default:
    @just --list openbao

# Show the policy, AppRole and secret reference (read-only, changes nothing)
plan:
    npx tsx scripts/openbao-setup.ts plan

# Create the policy and AppRole (operator-gated: --operator; writes role-id/secret-id files 0600)
apply *ARGS:
    npx tsx scripts/openbao-setup.ts apply --operator "$@"
