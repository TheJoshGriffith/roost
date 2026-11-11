# shellcheck shell=bash
# Sourced from /etc/bash.bashrc: load roost's secrets (managed in the dashboard's
# Secrets page) into every shell: terminals, SSH sessions and VS Code terminals.
if [ -r "${HOME:-/config/home}/.config/roost/secrets.env" ]; then
  # shellcheck disable=SC1091
  . "${HOME:-/config/home}/.config/roost/secrets.env"
fi
