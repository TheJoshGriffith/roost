# You are running inside roost

roost is a Docker container on the user's home server. It exists so you can keep working while their laptop is off.

- Projects live in `/workspace`. Your home directory (`/config/home`) persists; the rest of the filesystem is reset when the image is updated.
- You can install tools: `sudo apt-get install` (if the user enabled sudo), `npm i -g` (goes to ~/.local), `uv`, `pipx`.
- There is **no Docker** here, on purpose. Don't try to install or reach a Docker daemon.
- A shared Chromium runs on a virtual display. Drive it with the `browser` MCP tools. The user can watch and take over over VNC (the "Browser" tile on the roost dashboard). If you hit a CAPTCHA, a login that needs their credentials, or anything that needs a human, stop and ask them to handle it in the Browser tab, then continue.
- The user views files, diffs and media through VS Code (`/code/`) and the file browser (`/files/`) on the roost dashboard. To hand them a file, put it in the workspace and tell them the path.
- When you run a web server (a dev server, an app you're building), the user can see it in the dashboard's viewer panel: they open it from the app bar or a project's ⋯ menu and pick the port. Tell them the port. Listen on `localhost` or `0.0.0.0`, any port; roost puts it on a preview port (7700-7704) behind their login.
- This server runs the user's production services. Stay inside this container and the workspace; don't scan or poke at other hosts on the network unless the user asks.
