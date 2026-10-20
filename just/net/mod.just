# Durable Agent Network devices. Every recipe takes an id from dpi-network.yaml,
# then runs the driver for that device's kind (local, ssh, exe-dev, url).

set shell := ["zsh", "-cu"]
set positional-arguments
set working-directory := "../../apps/dpi-sdk"

net := "NODE_NO_WARNINGS=1 npx tsx scripts/net.ts"
services := "NODE_NO_WARNINGS=1 ./node_modules/.bin/tsx scripts/services.ts"

# List device commands
[default]
default:
    @just --list net

# The local topology: backend + hub + cbp-agent (status|up|down|restart)
services *ARGS:
    {{ services }} "$@"

# Probe every device, or one
status *DEVICE:
    {{ net }} status "$@"

# Print device ids from dpi-network.yaml
ids:
    @{{ net }} ids

# Bring a device online (idempotent)
up DEVICE:
    {{ net }} up "$1"

# Sync code to a device and restart it
deploy DEVICE:
    {{ net }} deploy "$1"
    {{ net }} restart "$1"

# Copy a device token into the registry
register DEVICE *ARGS:
    {{ net }} register "$@"

# Tail a device's service log
logs DEVICE *LINES:
    {{ net }} logs "$@"

# Restart a device's backend service
restart DEVICE:
    {{ net }} restart "$1"

# Stop a device's backend service
down DEVICE:
    {{ net }} down "$1"

# New token on a device, then re-register
rotate DEVICE:
    {{ net }} rotate "$1"

# Compare declared code_dir with each device's report; refresh a stale registry row
reconcile *DEVICE:
    {{ net }} reconcile "$@"

# Check healthz 200 and tokenless 401
probe DEVICE:
    {{ net }} probe-unauth "$1"

# Delete an exe-dev VM named in the YAML
destroy DEVICE *ARGS:
    {{ net }} destroy "$@"

# Run any single driver step on a device
step VERB DEVICE *ARGS:
    {{ net }} "$@"
