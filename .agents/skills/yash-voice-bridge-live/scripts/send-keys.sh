#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-yash-voice-bridge:all}"
TEXT="${2:-}"

if [[ -n "$TEXT" ]]; then
  tmux send-keys -t "$TARGET" -l -- "$TEXT"
fi
tmux send-keys -t "$TARGET" Enter
