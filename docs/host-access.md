# Letting roost manage the host's Docker

By default roost can't see the host's Docker at all (see [sandboxing.md](sandboxing.md)). That's the safe setting, but it means an agent can't check on, restart or deploy the services on your server. This page adds two levels of access. Neither hands roost the Docker socket, because anything that can use the full Docker API is root on the host.

| | What roost can do | What stops it doing more |
| --- | --- | --- |
| **Tier 1: socket proxy** | List and inspect containers, images and networks; read logs; watch events; start, stop, restart and kill containers. | A proxy that only forwards those API calls. `POST=0`, so no creating containers, exec, copying files, pulling images or deleting anything. |
| **Tier 2: deploy gate** | Deploy, update, roll back and retire Docker Compose stacks, but only from a git branch you review and merge. | An SSH key that can run one script and nothing else. The script deploys only `origin/main`, and its policy check rejects privileged containers, host namespaces, extra capabilities, devices, the Docker socket and bind mounts outside your app data. |

You can set up either tier on its own. The examples use Unraid. Plain Docker hosts work the same way; the differences are noted.

## What you're accepting

Even with both tiers, a confused or prompt-injected agent could:

- **stop or restart any container**, including ones your household depends on. That's an outage, not a takeover, and anything with a restart policy comes back with the next `docker start` or reboot. If that's too much, set `ALLOW_RESTARTS=0` and `ALLOW_START=0` for a read-only proxy.
- **read every container's environment variables** (`docker inspect`). If your services take passwords or API keys as environment variables, roost can read them. Move those to files (Docker secrets, or a config file in the app's appdata) if that matters.
- **deploy whatever you merge.** Tier 2 is exactly as safe as your review. The policy check catches the obvious ways to take over the host, but it can't tell a good image from a bad one, or spot a container that quietly sends your data somewhere.

Here's what neither tier allows: creating containers outside a reviewed stack, `exec`, mounting the host's disks or the flash drive, touching roost's own sandbox, or anything else that turns into root on the host.

## Tier 1: the socket proxy

[linuxserver/socket-proxy](https://github.com/linuxserver/docker-socket-proxy) mounts the Docker socket and passes on only the API sections you enable. roost reaches it over a private Docker network. No port is published, so nothing else on your LAN can use it.

### Unraid

1. **Settings → Docker:** stop the Docker service, set **Preserve user defined networks** to **Yes**, and start Docker again. Without this, Unraid deletes custom networks at restart.
2. In the Unraid terminal, run `docker network create roost-ops`.
3. **Docker → Add Container → Template:** paste
   `https://raw.githubusercontent.com/TheJoshGriffith/roost/main/unraid/roost-socket-proxy.xml`
   and apply it. Its Network Type is already `roost-ops`. Don't add a port.
4. Edit **roost** and set its **Network Type** to `roost-ops`. Port mappings keep working on a custom network, and the WebUI stays where it was.
5. On roost's **Secrets** page, add `DOCKER_HOST` = `tcp://roost-socket-proxy:2375`, with a description such as *Filtered Docker on the host: read, logs, start/stop/restart.*
6. Restart Remote Control (there's a button on the Secrets page) and any open chats. Then, from roost's terminal:

   ```bash
   docker ps                         # works
   docker logs --tail 20 <container> # works
   docker run --rm alpine true       # fails with 403: creating containers is blocked
   docker exec <container> true      # fails with 403
   ```

Keep other containers off `roost-ops`. Anything on that network can use the proxy.

### Plain Docker / Compose

Start [`host/socket-proxy/docker-compose.yml`](../host/socket-proxy/docker-compose.yml), add roost to the `roost-ops` network (`networks: [default, roost-ops]`, with `roost-ops: {external: true}`), then continue from step 5.

### Settings worth knowing

| Variable | Template | |
| --- | --- | --- |
| `POST` | `0` | **Leave at 0.** `1` allows `docker run --privileged -v /:/host`, which is the host. |
| `EXEC`, `ALLOW_ARCHIVE`, `ALLOW_EXPORT` | `0` | Leave at 0. These give a shell in, or files out of, any container. |
| `CONTAINERS`, `IMAGES`, `NETWORKS`, `INFO`, `EVENTS` | `1` | Read-only. |
| `ALLOW_LOGS` | `1` | Container logs. |
| `ALLOW_RESTARTS`, `ALLOW_START` | `1` | Change container state, even with `POST=0`. `ALLOW_RESTARTS` covers restart, stop and kill. Set both to `0` for strictly read-only access. |

## Tier 2: the deploy gate

You keep your stacks (Compose files) in a git repository. The agent proposes a change on a branch, and you review and merge it. The agent then asks the host to deploy it, and the host checks it before running anything.

```
roost ──ssh (key restricted to one command)──▶ host: roost-deploy-gate
                                                 ├─ git fetch origin main  (read-only credentials)
                                                 ├─ optional: is the commit signed by you?
                                                 ├─ policy check on `docker compose config`
                                                 └─ docker compose up -d
```

The gate runs on the host as root, since it needs the real Docker socket. It's built so that roost can't influence it except by choosing a verb and a stack name:

- The SSH key is set to `restrict,command=...`. It can't open a shell, run another command, or forward ports and sockets. Without `restrict`, a key could forward `/var/run/docker.sock` and skip everything else on this page.
- The requested command is split into words and matched against a fixed list of verbs. Stack names must match `[a-z0-9][a-z0-9_-]*`. Nothing from the request reaches a shell.
- Only the branch you name (default `main`), as fetched from the remote, is ever deployed. Rollback can only go back to a commit that was deployed before.
- The gate refuses to run if roost can see the gate's own files (it checks roost's mounts with `docker inspect`). If roost could edit the script, it could get root through it.
- `docker compose` runs with an empty environment, so host variables don't leak into stacks.
- Everything it does goes to `state/deploy.log` and syslog.

### Set it up (Unraid)

Do this in the **Unraid terminal**, as root, not in roost.

1. **Make the gate's directory.** It must be somewhere roost doesn't mount. Your roost template maps `/mnt/user/appdata/roost` and your workspace share, so this is fine:

   ```bash
   mkdir -p /mnt/user/appdata/roost-deploy && cd /mnt/user/appdata/roost-deploy
   curl -fsSLO https://raw.githubusercontent.com/TheJoshGriffith/roost/main/host/deploy/roost-deploy-gate
   curl -fsSL -o deploy.conf https://raw.githubusercontent.com/TheJoshGriffith/roost/main/host/deploy/deploy.conf.example
   chmod 700 roost-deploy-gate && chmod 600 deploy.conf
   ```

   Read the script before you trust it with root. It's one file.

2. **Make sure `docker compose` works.** On Unraid, install the **Docker Compose Manager** plugin from Community Applications. The gate uses the host's `git` and `jq` if they're present, and otherwise runs them in throwaway containers (`alpine/git`, `ghcr.io/jqlang/jq`).

3. **Create the stacks repository** on GitHub or GitLab, with one directory per stack:

   ```
   stacks/
     immich/compose.yaml
     paperless/compose.yaml
     paperless/nginx.conf      # files next to the compose file can be mounted read-only
   ```

   Bind-mount data from absolute paths under `/mnt/user/appdata/` (or whatever `ALLOWED_BIND_PREFIXES` says). Relative paths such as `./data` are only accepted read-only, for config files that live in the repo.

4. **Protect the branch.** The agents' tokens must not be able to change `main` directly, or "review" means nothing:
   - **GitLab:** Settings → Repository → Protected branches: `main`, *Allowed to push* = No one, *Allowed to merge* = Maintainers. Give roost's `GITLAB_TOKEN` the Developer role on that project, not Maintainer.
   - **GitHub:** a branch ruleset on `main` requiring a pull request with an approval, and a fine-grained `GH_TOKEN` for roost that you don't use to approve.
   - Even stronger: sign your merge commits and set `ALLOWED_SIGNERS` in `deploy.conf`. The gate then refuses any commit you didn't sign, whatever happens to the tokens.

5. **Clone it with read-only credentials** (a read-only deploy key, or a deploy token with `read_repository` only):

   ```bash
   cd /mnt/user/appdata/roost-deploy
   git clone https://<deploy-token-user>:<token>@gitlab.com/<you>/<stacks>.git repo
   # no git on the host?
   # docker run --rm -v "$PWD:/w" -w /w alpine/git clone https://...  repo
   ```

6. **Put values that shouldn't go in git** (database passwords and the like) in `env/<stack>.env`. They're used for `${VAR}` interpolation in that stack's compose file. Remember that anything that ends up in a container's environment is readable through Tier 1's `docker inspect`.

7. **Review `deploy.conf`.** Set `ALLOWED_BIND_PREFIXES`, any `ALLOWED_CAPS` you need (e.g. `NET_ADMIN` for a VPN container), and `ROOST_CONTAINER` if roost's container isn't called `roost`.

8. **Create the SSH key in roost.** Secrets → **SSH keys** → Generate, named `deploy`, for host `<your server's LAN IP>`. Copy the public key.

9. **Authorise it on the host, restricted to the gate.** Unraid keeps root's SSH keys on the flash drive: since 6.9, `/root/.ssh` links to `/boot/config/ssh/root`. Check with `ls -l /root/.ssh`. Add one line:

   ```
   restrict,command="/bin/bash /mnt/user/appdata/roost-deploy/roost-deploy-gate" ssh-ed25519 AAAA... roost-deploy
   ```

   Also make sure **Settings → Management Access → Use SSH** is on.

10. **Tell roost where it is.** On the Secrets page, add `ROOST_DEPLOY_HOST` = `root@<your server's LAN IP>`, with a description such as *Deploys reviewed Compose stacks on the host; run roost-deploy help*. Then, in roost's terminal:

    ```bash
    roost-deploy help
    roost-deploy list
    ssh root@<server> id    # prints the gate's usage, not "uid=0(root)": the key can't run anything else
    ```

### Using it

```bash
roost-deploy list                    # stacks on main, and what's deployed where
roost-deploy plan paperless          # commits and diff since the last deploy, plus the policy check
roost-deploy deploy paperless        # deploy origin/main
roost-deploy deploy paperless --pull # also fetch newer images (for :latest-style tags)
roost-deploy deploy paperless --recreate  # recreate even if compose thinks nothing changed
roost-deploy rollback paperless      # back to the commit that was live before
roost-deploy retire paperless        # stop and remove a stack you've deleted from main (keeps volumes)
roost-deploy status [paperless]
roost-deploy log 50
```

If `docker compose up` fails, the gate puts the stack back on the commit that was running before and says so.

### What the policy check rejects

It runs on the output of `docker compose config`, which resolves `extends`, `include`, profiles and interpolation, so the check sees what Docker will actually run:

- `privileged: true`
- `network_mode: host`; `pid`, `uts`, `userns_mode` or `cgroup` set to anything except private; `ipc: host` or `container:...`. Sharing another container's pid namespace reaches that container's files, and the socket proxy has the Docker socket.
- `cap_add` outside `ALLOWED_CAPS`, `devices` unless `ALLOW_DEVICES=1`, and `security_opt` that turns off AppArmor, seccomp or `no-new-privileges`
- `volumes_from` and `cgroup_parent`
- bind mounts (and named volumes that are binds underneath, and file-based secrets and configs) outside `ALLOWED_BIND_PREFIXES`, anything mentioning the Docker socket, and anything that overlaps the gate's own directory

It's a backstop. It catches the common ways a stack could take over the host if one gets past review. It doesn't replace reading the diff.

### Plain Docker hosts

The gate works on any Linux host with Docker and the compose plugin. Put it somewhere roost doesn't mount, set `ALLOWED_BIND_PREFIXES` to where your app data lives (e.g. `/srv/`), and add the `authorized_keys` line for whichever user owns your Docker access. Unraid's `/mnt/user`, `/mnt/cache` and `/mnt/diskN` paths are treated as the same share when paths are compared.

## Turning it off

- **Tier 1:** stop `roost-socket-proxy` and delete `DOCKER_HOST` from the Secrets page.
- **Tier 2:** remove the line from the host's `authorized_keys`. Deployed stacks keep running; they're ordinary Compose projects (`docker compose -p <stack> ...`).
