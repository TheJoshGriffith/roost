# roost: root's ~/.bashrc
# Interactive root shells (e.g. Unraid's container "Console" button) switch to the
# roost user, so sign-ins and files end up owned by the user the agents run as.
# For a real root shell: `sudo -i` from the roost user, or `ROOST_ROOT=1 bash`.
if [[ $- == *i* ]] && [ -t 0 ] && [ -z "${ROOST_ROOT:-}" ] && [ -z "${SUDO_USER:-}" ]; then
  echo "roost: switching to the 'roost' user (for root: sudo -i, or ROOST_ROOT=1 bash)"
  cd /workspace 2> /dev/null || true
  exec runuser -u roost -- bash -l
fi
PS1='\[\e[31m\]root\[\e[0m\]@roost:\w# '
