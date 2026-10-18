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

# Start (or restart) the persistent raft-storage OpenBao container
up:
    npx tsx scripts/openbao.ts up

# Initialize a fresh vault; writes unseal material 0600 (operator-gated: --operator)
init *ARGS:
    npx tsx scripts/openbao.ts init --operator "$@"

# Unseal a sealed vault using the stored unseal keys
unseal:
    npx tsx scripts/openbao.ts unseal

# Show whether the container is initialized and sealed
status:
    npx tsx scripts/openbao.ts status

# Boot-time unseal as a systemd user service (install|uninstall|start|stop|restart|status|logs|print)
service *ARGS:
    npx tsx scripts/openbao.ts service "$@"
