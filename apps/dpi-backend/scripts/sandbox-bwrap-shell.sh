#!/usr/bin/env bash
#
# sandbox-bwrap-shell.sh — the shell a SandboxExecutionEnv hands to NodeExecutionEnv for `DPI_SANDBOX=bwrap`.
#
# NodeExecutionEnv invokes a custom shell as `<shell> -c "<command>"`; this wrapper builds a bubblewrap
# namespace that mounts only the declared roots, then runs the command inside it. The first root is writable,
# the rest are read-only. The host home directory (and therefore ~/.pi/agent/auth.json and sibling worktrees)
# is never bound. The system dirs are read-only; /tmp is a fresh tmpfs; the network is unshared unless the
# policy says otherwise.
set -euo pipefail

workdir="${DPI_SANDBOX_WORKDIR:-/}"
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

args=(
  --unshare-all
  --die-with-parent
  --new-session
  --dev /dev
  --proc /proc
  --tmpfs /tmp
  --chdir "$workdir"
  --setenv HOME /tmp
)

# System dirs: read-only. Never bind /home or /root.
for path in /usr /bin /sbin /lib /lib64 /etc; do
  [ -e "$path" ] && args+=(--ro-bind "$path" "$path")
done

if [ "${DPI_SANDBOX_NETWORK:-none}" != "none" ]; then
  args+=(--share-net)
fi

index=0
if [ -n "${DPI_SANDBOX_MOUNTS:-}" ]; then
  while IFS= read -r spec; do
    [ -z "$spec" ] && continue
    root="${spec%%:*}"
    if [ "$index" -eq 0 ]; then
      args+=(--bind "$root" "$root")
    else
      args+=(--ro-bind "$root" "$root")
    fi
    index=$((index + 1))
  done <<< "$DPI_SANDBOX_MOUNTS"
fi

exec bwrap "${args[@]}" /bin/bash -lc "$cmd"
