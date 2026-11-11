# Sandboxing: what roost protects, and what it doesn't

roost assumes the agents inside it might do something dumb: delete files, install junk, break the OS, run a bad script. The goal is that the damage stays **inside the container and the workspace you mapped**. The host and its other containers should be untouched.

## What the container can't do

| | |
| --- | --- |
| **No Docker socket** | Agents can't see, start or stop your other containers. |
| **No `--privileged`, no extra capabilities** | It runs with Docker's default capability set and seccomp profile, so it can't mount host disks, load kernel modules or reach host devices. |
| **No host network** | It sits on the bridge network with its own IP and ports. |
| **Only two mounts** | `/config` (its own appdata) and `/workspace` (the share you chose). Nothing else from the host is visible. |
| **Agents run as `roost`, not root** | `sudo` (on by default) grants root *in the container* only. Container root is still bounded by everything above. |
| **Resource limits** | The Unraid template sets `--memory=8g --pids-limit=4096`, so a runaway build or fork bomb can't starve the host. Tune these to taste. |

**Why not Docker-in-Docker?** DinD needs `--privileged`, and a privileged container can trivially take over the host. Giving an agent a DinD daemon is about as dangerous as giving it the host's Docker socket. If agents need Docker, the safe pattern is a small **VM** with its own Docker engine, with `DOCKER_HOST=tcp://<vm>:2376` (TLS) set in roost. The VM boundary is a real wall, and you can snapshot it and reset it. This is on the roadmap.

## What it doesn't protect against

- **Your workspace.** Agents can read, change and delete anything under `/workspace`. Keep it under git, and keep backups of anything you care about. Don't map shares the agents don't need.
- **Your network.** The container can reach anything the host's LAN can reach, including other services on Harris by IP and your router's admin page. It also can't tell a legitimate request from a prompt-injected one. If that matters, put roost on its own VLAN or Docker network and restrict its traffic with firewall rules. Network policy isn't built in yet.
- **Credentials inside roost.** The Claude, Codex and GitHub sign-ins in `/config/home` can be read by the agents, and by anyone who gets into the web UI, because the UI includes a shell. Treat the roost web password like an SSH key:
  - keep it set (the default generates one),
  - don't expose port 7680 or 2222 to the internet; use a VPN (WireGuard/Tailscale) to reach it remotely,
  - give `gh` a fine-grained token limited to the repos roost works on, rather than your all-powerful one.
- **Plain HTTP.** The web UI is HTTP on your LAN, so basic-auth credentials cross the network unencrypted. If you put it behind a reverse proxy with TLS (e.g. SWAG / Nginx Proxy Manager on Unraid), keep it LAN- or VPN-only.

## Defence in depth inside the container

- The web UI binds every backend (code-server, ttyd, filebrowser, noVNC, the dashboard) to `127.0.0.1`. Only Caddy faces the network, and Caddy requires the login for every path.
- ttyd checks the WebSocket origin (`-O`). Dashboard actions need a custom header, so other sites can't trigger them from your browser.
- Raw VNC is localhost-only unless you set `ROOST_VNC_PASSWORD`.
- Each instance generates its own SSH host keys. SSH is key-only, root login is disabled, and only the `roost` user is allowed.
- Chromium runs with `--no-sandbox`, because its own sandbox needs user namespaces that Docker's default seccomp blocks. A malicious page that escaped the renderer would land in the container, not on the host.

## Reset ladder

1. **Recreate the container.** This resets the OS, packages and anything installed with sudo.
2. **Delete `appdata/roost/home`.** This resets dotfiles, `~/.local` tools, sign-ins and the browser profile.
3. **Delete `appdata/roost`.** This resets everything, including SSH host keys and the generated password.
