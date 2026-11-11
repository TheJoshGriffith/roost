# roost ~/.bashrc (seeded once; edit freely, it won't be overwritten)

# Environment first, so non-interactive SSH commands get it too.
export PATH="$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export EDITOR="${EDITOR:-nano}"
export DISPLAY="${DISPLAY:-:99}"
export DISABLE_AUTOUPDATER=1

case $- in *i*) ;; *) return ;; esac

HISTSIZE=50000
HISTFILESIZE=100000
HISTCONTROL=ignoreboth:erasedups
shopt -s histappend checkwinsize

if [ -n "${TMUX:-}" ]; then where="$(tmux display-message -p '#S')"; else where="$(hostname)"; fi
PS1='\[\e[38;5;179m\]roost\[\e[0m\]:\[\e[38;5;110m\]${where}\[\e[0m\] \[\e[1m\]\w\[\e[0m\] \$ '

alias ll='ls -alF --color=auto'
alias ls='ls --color=auto'
alias fd='fdfind'
alias rc='tmux attach -t rc-workspace'

if [ -z "${ROOST_MOTD_SHOWN:-}" ]; then
  export ROOST_MOTD_SHOWN=1
  echo "roost: claude, codex, gh, uv and friends are on PATH. Workspace: /workspace"
  [ -s "$HOME/.claude/.credentials.json" ] || echo "  -> Claude isn't signed in yet: run roost-setup"
fi
