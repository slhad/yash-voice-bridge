#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-yash-voice-bridge:all}"

tmux capture-pane -t "$TARGET" -p | tail -n 80
