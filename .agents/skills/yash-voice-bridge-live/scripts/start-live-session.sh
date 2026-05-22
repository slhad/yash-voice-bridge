#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="${SESSION_NAME:-yash-voice-bridge}"
WINDOW_NAME="${WINDOW_NAME:-all}"
TARGET="$SESSION_NAME:$WINDOW_NAME"
ROOT_DIR="/home/slash/dev/git/yash-voice-bridge"
SOURCE="${YVB_SOURCE:-alsa_input.usb-PreSonus_Revelator_IO_24_AB7C21181959-00.analog-surround-21}"
TRANSCRIPT_OUTPUT="${YVB_TRANSCRIPT_OUTPUT:-stdout}"
EXTRA_ARGS="${YVB_EXTRA_ARGS:-}"

mkdir -p "$ROOT_DIR/tmp"

CMD="cd \"$ROOT_DIR\" && bun run raw --source-kind pulse --source \"$SOURCE\" --transcript-output \"$TRANSCRIPT_OUTPUT\" --yash-ipc --yash-actions $EXTRA_ARGS"

if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  tmux new-session -d -s "$SESSION_NAME" -n "$WINDOW_NAME" "$CMD"
  tmux set-option -t "$SESSION_NAME" remain-on-exit on >/dev/null
  printf 'started %s\n' "$TARGET"
  printf 'command: %s\n' "$CMD"
  exit 0
fi

if ! tmux list-windows -t "$SESSION_NAME" -F '#{window_name}' | grep -Fxq "$WINDOW_NAME"; then
  tmux new-window -d -t "$SESSION_NAME" -n "$WINDOW_NAME" "$CMD"
  tmux set-option -t "$SESSION_NAME" remain-on-exit on >/dev/null
  printf 'started %s\n' "$TARGET"
  printf 'command: %s\n' "$CMD"
  exit 0
fi

tmux respawn-pane -k -t "$TARGET" "$CMD"
tmux set-option -t "$SESSION_NAME" remain-on-exit on >/dev/null

printf 'restarted %s in place\n' "$TARGET"
printf 'command: %s\n' "$CMD"
