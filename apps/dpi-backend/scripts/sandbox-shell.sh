#!/usr/bin/env bash
#
# sandbox-shell.sh — the shell a SandboxExecutionEnv hands to NodeExecutionEnv.
#
# NodeExecutionEnv invokes a custom shell as `<shell> -c "<command>"`; this wrapper ensures the session's
# container is running (idempotently) and then runs the command inside it. Because only the shell is swapped,
# pi-durable's timeout, streaming, spill and abort handling are all reused unchanged.
#
# The container mounts only the declared roots (first read-write, the rest read-only), drops all capabilities,
# runs with a read-only root filesystem and a writable /tmp, and is resource-capped. It receives no secrets.
set -euo pipefail

name="${DPI_SANDBOX_CONTAINER:?DPI_SANDBOX_CONTAINER is required}"
image="${DPI_SANDBOX_IMAGE:?DPI_SANDBOX_IMAGE is required}"
workdir="${DPI_SANDBOX_WORKDIR:-/}"
docker_bin="${DPI_SANDBOX_DOCKER:-docker}"

cmd="${2:-}"
if [ "${1:-}" != "-c" ] || [ -z "$cmd" ]; then
  fallback=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -c|-lc) fallback="${2:-}"; shift 2 2>/dev/null || true; break ;;
      -*) shift ;;
      *) fallback="$1"; shift; break ;;
    esac
  done
  [ -n "$cmd" ] || cmd="$fallback"
  if [ -z "$cmd" ] && [ ! -t 0 ]; then cmd="$(cat)"; fi
fi

mounts=()
if [ -n "${DPI_SANDBOX_MOUNTS:-}" ]; then
  while IFS= read -r spec; do
    [ -n "$spec" ] && mounts+=(-v "$spec")
  done <<< "$DPI_SANDBOX_MOUNTS"
fi

running="$("$docker_bin" inspect -f '{{.State.Running}}' "$name" 2>/dev/null || true)"
if [ "$running" != "true" ]; then
  if "$docker_bin" inspect "$name" >/dev/null 2>&1; then
    "$docker_bin" start "$name" >/dev/null
  else
    "$docker_bin" run -d --name "$name" \
      --network "${DPI_SANDBOX_NETWORK:-none}" \
      --cap-drop ALL \
      --security-opt no-new-privileges \
      --pids-limit "${DPI_SANDBOX_PIDS:-512}" \
      --memory "${DPI_SANDBOX_MEMORY:-2g}" \
      --cpus "${DPI_SANDBOX_CPUS:-2}" \
      --read-only \
      --tmpfs "/tmp:rw,nosuid,nodev,size=256m" \
      "${mounts[@]}" \
      -w "$workdir" -e HOME=/tmp \
      "$image" sleep infinity >/dev/null
  fi
fi

exec "$docker_bin" exec -i -w "$workdir" "$name" /bin/bash -lc "$cmd"
