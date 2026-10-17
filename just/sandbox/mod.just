# Execution sandbox: the boundary an agent's commands and file tools run inside.
# See apps/dpi-backend/src/sandbox.ts. Configured in ~/.dpi/backend.env (DPI_SANDBOX*).

set shell := ["zsh", "-cu"]
set positional-arguments
set working-directory := "../../apps/dpi-backend"

# List sandbox commands
[default]
default:
    @just --list sandbox

# Show the device's sandbox policy, and how to enable or scope it
status:
    npx tsx scripts/sandbox-check.ts --status

# Verify the boundary end to end: file path guard + container containment
check *ARGS:
    npx tsx scripts/sandbox-check.ts "$@"
