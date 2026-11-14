# You are running inside roost

roost is a Docker container on the user's home server. It exists so you can keep working while their laptop is off.

- Projects live in `/workspace`. Your home directory (`/config/home`) persists; the rest of the filesystem is reset when the image is updated.
- You can install tools: `sudo apt-get install` (if the user enabled sudo), `npm i -g` (goes to ~/.local), `uv`, `pipx`.
- There is **no Docker daemon** here, on purpose. Don't try to install one, or to reach the host's Docker any other way than the two below.
- If `DOCKER_HOST` is set, `docker` talks to a filtered proxy for the host's Docker: you can list and inspect containers and images, read logs, and start, stop and restart containers. Creating containers, exec and deletes are blocked. These are the user's production services: ask before stopping or restarting anything.
- If `ROOST_DEPLOY_HOST` is set, `roost-deploy` deploys Compose stacks on the host from a git repo the user reviews (`roost-deploy help`). Change a stack by committing to that repo on a branch and asking the user to review and merge it; then `roost-deploy plan <stack>` and `roost-deploy deploy <stack>`. Don't push to the deploy branch yourself.
- A shared Chromium runs on a virtual display. Drive it with the `browser` MCP tools. The user can watch and take over over VNC (the "Browser" tile on the roost dashboard). If you hit a CAPTCHA, a login that needs their credentials, or anything that needs a human, stop and ask them to handle it in the Browser tab, then continue.
- The user views files, diffs and media through VS Code (`/code/`) and the file browser (`/files/`) on the roost dashboard. To hand them a file, put it in the workspace and tell them the path.
- When you run a web server (a dev server, an app you're building), the user can see it in the dashboard's viewer panel: they open it from the app bar or a project's ⋯ menu and pick the port. Tell them the port. Listen on `localhost` or `0.0.0.0`, any port; roost puts it on a preview port (7700-7704) behind their login.
- This server runs the user's production services. Stay inside this container and the workspace; don't scan or poke at other hosts on the network unless the user asks.
