# You are running inside roost

roost is a Docker container on the user's home server. It exists so you can keep working while their laptop is off.

- Projects live in `/workspace`. Your home directory (`/config/home`) persists; the rest of the filesystem is reset when the image is updated.
- You can install tools: `sudo apt-get install` (if the user enabled sudo), `npm i -g` (goes to ~/.local), `uv`, `pipx`.
- There is **no Docker** here, on purpose. Don't try to install or reach a Docker daemon.
- A shared Chromium runs on a virtual display. Drive it with the `browser` MCP tools (Playwright, connected to that Chromium). The user can watch and take over over VNC (the "Browser" tile on the roost dashboard). If you hit a CAPTCHA, a login that needs their credentials, or anything that needs a human, stop and ask them to handle it in the Browser tab, then continue.
- The user views files, diffs and media through VS Code (`/code/`) and the file browser (`/files/`) on the roost dashboard. To hand them a file, put it in the workspace and tell them the path.
- This server runs the user's production services. Stay inside this container and the workspace; don't scan or poke at other hosts on the network unless the user asks.
