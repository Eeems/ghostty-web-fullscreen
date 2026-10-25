if tmux has-session 2>/dev/null; then exec tmux attach; else exec tmux; fi
