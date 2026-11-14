# syntax=docker/dockerfile:1
#
# roost: an always-on home for Claude Code and Codex.
# One container: Claude Remote Control server, Codex, VS Code (code-server),
# a web terminal, a file browser and a VNC-viewable Chromium that agents can drive.

FROM node:22-trixie-slim

ARG TARGETARCH
ARG ROOST_VERSION=dev
ARG CODE_SERVER_VERSION=4.145.2
ARG TTYD_VERSION=1.7.7
ARG NOVNC_VERSION=1.7.0
ARG GH_VERSION=2.103.3
ARG GLAB_VERSION=1.130.0
ARG FILEBROWSER_VERSION=2.0.2-stable
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
ARG PLAYWRIGHT_MCP_VERSION=latest

LABEL org.opencontainers.image.title="roost" \
      org.opencontainers.image.description="Always-on, self-hosted home for Claude Code and Codex: Remote Control, VS Code, web terminal, files and a VNC browser." \
      org.opencontainers.image.source="https://github.com/TheJoshGriffith/roost" \
      org.opencontainers.image.licenses="MIT"

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# System packages: dev tooling, process supervision, the virtual display + browser stack.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg git git-lfs openssh-client openssh-server sudo \
      tmux jq ripgrep fd-find less nano vim-tiny procps psmisc htop lsof iproute2 iputils-ping bind9-dnsutils \
      unzip zip xz-utils bzip2 file tree rsync \
      build-essential pkg-config python3 python3-pip python3-venv pipx \
      tini supervisor caddy tzdata \
      xvfb x11vnc openbox python3-websockify \
      chromium fonts-liberation fonts-noto-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/* \
 # Each instance generates its own SSH host keys at first boot (kept in /config).
 && rm -f /etc/ssh/ssh_host_*

# Standalone binaries: ttyd (web terminal), noVNC, FileBrowser Quantum, code-server, uv.
# (noVNC comes from upstream: Debian's package drags in a second Node.js.)
RUN case "${TARGETARCH}" in \
      amd64) ttyd_arch=x86_64 ;; \
      arm64) ttyd_arch=aarch64 ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && cd /tmp \
 && curl -fsSLO "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_arch}" \
 && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/SHA256SUMS" | grep " ttyd.${ttyd_arch}\$" | sha256sum -c - \
 && install -m 0755 "ttyd.${ttyd_arch}" /usr/local/bin/ttyd \
 && mkdir -p /usr/share/novnc \
 && curl -fsSL "https://github.com/novnc/noVNC/archive/refs/tags/v${NOVNC_VERSION}.tar.gz" \
      | tar -xz -C /usr/share/novnc --strip-components=1 \
 && curl -fsSL -o /usr/local/bin/filebrowser "https://github.com/gtsteffaniak/filebrowser/releases/download/v${FILEBROWSER_VERSION}/linux-${TARGETARCH}-filebrowser" \
 && chmod 0755 /usr/local/bin/filebrowser \
 && curl -fsSL -o code-server.deb "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_${TARGETARCH}.deb" \
 && dpkg -i code-server.deb \
 && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh \
 && rm -rf /tmp/*

# GitHub CLI and GitLab CLI, from their official releases (checksums verified).
# Both read tokens from the environment (GH_TOKEN / GITLAB_TOKEN), which roost's
# Secrets page provides.
RUN cd /tmp \
 && gh_tar="gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" \
 && curl -fsSLO "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${gh_tar}" \
 && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt" | grep " ${gh_tar}\$" | sha256sum -c - \
 && tar -xzf "${gh_tar}" \
 && install -m 0755 "gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" /usr/local/bin/gh \
 && glab_tar="glab_${GLAB_VERSION}_linux_${TARGETARCH}.tar.gz" \
 && curl -fsSLO "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/${glab_tar}" \
 && curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/checksums.txt" | grep " ${glab_tar}\$" | sha256sum -c - \
 && mkdir glab && tar -xzf "${glab_tar}" -C glab \
 && install -m 0755 glab/bin/glab /usr/local/bin/glab \
 && rm -rf /tmp/* \
 && gh --version | head -1 && glab --version | head -1

# Docker CLI only, no daemon. It does nothing unless you point DOCKER_HOST at
# something, such as the filtered socket proxy in docs/host-access.md.
RUN install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=${TARGETARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian trixie stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli \
 && rm -rf /var/lib/apt/lists/* \
 && docker --version

# The agents themselves, plus the MCP bridge that lets them drive the shared browser.
RUN npm install -g --omit=dev \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
 && npm cache clean --force

# Unprivileged agent user. UID/GID are remapped at runtime from PUID/PGID.
RUN userdel -r node \
 && groupadd -g 1000 roost \
 && useradd -u 1000 -g roost -d /config/home -M -s /bin/bash roost \
 && usermod -p '*' roost \
 && git config --system safe.directory '*' \
 && git config --system init.defaultBranch main \
 && mkdir -p /config /workspace \
 && install -d -m 1777 /tmp/.X11-unix

# Dashboard dependencies first, so editing roost's own files doesn't re-run npm.
COPY rootfs/opt/roost/dash/package.json rootfs/opt/roost/dash/package-lock.json /opt/roost/dash/
RUN cd /opt/roost/dash && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY rootfs/ /
RUN chmod 0755 /usr/local/bin/roost-* \
 # Prepended, not appended: Debian's bash.bashrc returns early for non-interactive
 # shells, and bash reads it for SSH commands, which need the secrets too.
 && sed -i '1i . /etc/roost/shell-env.sh\n. /etc/roost/root-switch.sh' /etc/bash.bashrc \
 && echo "${ROOST_VERSION}" > /etc/roost/version

ENV HOME=/config/home \
    PUID=1000 \
    PGID=1000 \
    UMASK=002 \
    TZ=Etc/UTC \
    DISPLAY=:99 \
    DISABLE_AUTOUPDATER=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    ROOST_PREVIEW_PORTS=7700-7704

EXPOSE 7680 2222 5900 7700-7704
VOLUME ["/config", "/workspace"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:7682/api/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/roost-entrypoint"]
