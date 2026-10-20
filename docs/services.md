# Services: the durable-pi topology and restart survival

The running topology is three local services and one external device:

| service | endpoint | unit / owner | log |
|---|---|---|---|
| `dpi-backend` (device `local`) | `http://127.0.0.1:4780` | `dpi-backend.service` (systemd **user**) | `~/.dpi/backend.log` |
| hub (web UI + registry) | `http://127.0.0.1:4781` | `dpi-hub.service` (systemd **user**) | `~/.dpi/hub.log` |
| `cbp-agent` (`kind: url`) | `http://127.0.0.1:8790` | the CBP worktree, e.g. `tools/components/agent_device.py serve` | CBP-side |
| CBP device token | env only (`CBP_DEVICE_TOKEN`) | never in a unit, never in `dpi-network.yaml` | — |

The backend and hub units start at login and restart on failure (`Restart=always`,
`RestartSec=2`). The CBP device is deliberately **not** owned by durable-pi: its
service recipe lives in the CBP repo. `just net services` starts, registers and
probes it, and leaves it running on `down`/`restart`.

All commands below run from the durable-pi checkout root.

## Prerequisites

```sh
just install                 # npm install for every app
just hub build               # the built web client the hub serves
```

`just hub service install` refuses when the built UI is missing and tells you to
run `just hub build`; it never builds implicitly.

## Status (read-only, safe)

```sh
just net services status
```

It prints one deterministic row per check and exits non-zero when a check fails:

| service | endpoint | expected |
|---|---|---|
| `backend` | `http://127.0.0.1:4780/healthz` | `200` |
| `hub` | `http://127.0.0.1:4781/api/network` | `200` |
| `cbp-agent` | `http://127.0.0.1:8790/healthz` | `200` |
| `cbp-agent` | `http://127.0.0.1:8790/v1/device` | `401` (tokenless) |

The same checks by hand:

```sh
curl -fsS http://127.0.0.1:4780/healthz
curl -fsS http://127.0.0.1:4781/api/network
curl -fsS http://127.0.0.1:8790/healthz
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8790/v1/device
```

## Install and start

```sh
just backend service install     # write + enable --now dpi-backend.service
just hub service install         # write + enable --now dpi-hub.service
```

Both are idempotent. `install` starts the unit (`systemctl --user enable --now`),
`start` is a no-op when it is already running. The units are written to
`~/.config/systemd/user/`; no `sudo` is needed. To survive logout:

```sh
loginctl enable-linger "$USER"
```

`install` prints that hint when lingering is off.

`just net services up` does the whole topology in order and is idempotent:

1. require `CBP_DEVICE_TOKEN` (and refuse if it is missing or shorter than 32 characters);
2. build the hub UI if it is missing;
3. `just backend service install` then `start`;
4. `just hub service install` then `start`;
5. `just net up cbp-agent` (registers the token from the environment, probes it);
6. run `just net services status` and fail if any row is unhealthy.

```sh
export CBP_DEVICE_TOKEN=...      # supply the token without echoing it
just net services up
```

The token is inherited by `just net up cbp-agent`; it is never printed by the
recipe, the service unit or the registry view (`hasToken: true` only).

## Start, stop, restart, logs

```sh
just backend service start|stop|restart|status|logs
just hub service start|stop|restart|status|logs
just net services down           # stop hub, then backend; cbp-agent is external
just net services restart        # restart backend and hub, then status
```

`down` tolerates a unit that is not installed (idempotent) and prints that the
CBP device was left running. `logs` follows `journalctl --user`; the units also
append stdout/stderr to `~/.dpi/{backend,hub}.log`, so the log survives a
journal cleanup and is readable without systemd.

`just net services up --dry-run` prints the planned `just` commands; it still
refuses a missing `CBP_DEVICE_TOKEN`, because a dry run must not hide a missing
credential. `just hub service print` and `just backend service print` print the
rendered unit without installing it.

## Ports and token environment

| variable | where | default |
|---|---|---|
| `DPI_PORT` | `~/.dpi/backend.env`, written by `just net up local` | `4780` |
| `DPI_HUB_PORT` | environment when installing/starting the hub; embedded in `dpi-hub.service` | `4781` |
| `DPI_HOME` | backend/hub units | `~/.dpi` |
| `CBP_DEVICE_TOKEN` | operator environment for `just net up cbp-agent` / `just net services up` | none |

No token appears in either unit. The hub reads tokens from
`~/.dpi/network.sqlite` (mode `0600`); the backend reads its own token from
`~/.dpi/backend.env`.

Changing `DPI_HUB_PORT` requires reinstalling the hub unit so the new value is
written into it:

```sh
DPI_HUB_PORT=4791 just hub service install
```

## Restart survival

- A machine reboot (with lingering) brings back the backend and hub from their
  user units; the CBP device comes back from the CBP-side service.
- A crashed process is restarted after 2 seconds by systemd; a clean `stop` stays
  stopped.
- Session data lives in the device's SQLite store (`~/.dpi/backend/`), not in the
  unit. Stopping or restarting a service never rewrites it.
- `just net services status` after the restart is the acceptance check.

## Registration and `codeDir` reconciliation

`cbp-agent` is registered from `dpi-network.yaml`. Its lifecycle fields are
declared explicitly because a `url` device has no deploy step to learn them from:

```yaml
  cbp-agent:
    name: CBP Agent
    kind: url
    url: http://127.0.0.1:8790
    token_env: CBP_DEVICE_TOKEN
    code_dir: /home/me/cbp-workspace/github/cbp-pro-next
    home_dir: /home/me/.dpi
    start_dirs: ["/home/me/.dpi/dpi-workdir"]
```

- `code_dir` is what the device reports as `deviceInfo().codeDir` at
  `GET /v1/device` (the CBP repo root).
- `home_dir` is where the CBP device keeps its env/runs (`~/.dpi`).
- `url` is the device's actual listen address.
- A commented, explicit example is in `dpi-network.example.yaml`.

`just net status [device]` prints the reported `codeDir` in its detail column.
`just net reconcile [device]` compares the declared `code_dir` with the live
report, refreshes the registry row from a successful probe, and exits non-zero on
`MISMATCH` or `unverified` (device offline / no token). When the YAML declares a
different checkout than the row last cached, the sync step forgets that cached
`lastInfo`/tree first, so the hub never keeps showing a stale `codeDir`.
`just net up <device>` also fails closed after it comes online if the declared
`code_dir` and the reported `codeDir` disagree.

```sh
just net status cbp-agent
just net reconcile cbp-agent
```

The token is read from the registry for these probes; no token is printed. To
re-register after rotation, export `CBP_DEVICE_TOKEN` and run
`just net up cbp-agent` (or `just net services up`).

## Rollback

```sh
just net services down
just hub service uninstall
just backend service uninstall
```

`uninstall` removes the unit file and disables it; it does not touch
`~/.dpi/network.sqlite`, `~/.dpi/backend/`, the logs or the CBP device. Restore a
previous `dpi-network.yaml`, then run `just net status` to refresh the registry.
If you only want the old ad-hoc processes back, stop the units first (so they do
not fight for the same ports) and start the backend/hub in a terminal with
`just backend run` / `just hub start`.

## Troubleshooting

- **Hub `install` refuses:** run `just hub build`; the service serves
  `apps/dpi-playground/apps/dpi-playground-fe/dist`.
- **Non-Linux:** `just hub service` and `just backend service` manage a systemd
  user unit and refuse cleanly elsewhere; use a launchd login item for the hub or
  run `just hub start`.
- **Port already in use:** an ad-hoc backend/hub is still running. Stop it before
  `install`, or set `DPI_HUB_PORT` for the hub. `just backend service` uses
  `DPI_PORT` from `~/.dpi/backend.env`.
- **`unverified` in `reconcile`:** the device is offline or the row has no token.
  Start the CBP device and export `CBP_DEVICE_TOKEN`, then run
  `just net up cbp-agent`.
