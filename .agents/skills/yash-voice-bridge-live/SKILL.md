---
name: yash-voice-bridge-live
description: Use when the user wants a shared live tmux session for `/home/slash/dev/git/yash-voice-bridge`, especially to run `bun run raw` with YASH IPC enabled, watch transcripts in real time, send spoken-test guidance, or coordinate interactive voice/IPC debugging in the `yash-voice-bridge:all` tmux target.
---

# Yash Voice Bridge Live

This skill runs and monitors a shared tmux session for live `yash-voice-bridge` testing.

Use the fixed tmux target:

- session: `yash-voice-bridge`
- window: `all`
- full target: `yash-voice-bridge:all`

## When To Use

Use this skill when the user wants to:

- watch live bridge output in tmux
- join the same live session while Codex is also observing it
- run live mic tests against YASH IPC
- send short spoken test phrases and inspect what the bridge forwarded

## Session Workflow

1. Start or restart the shared session with `scripts/start-live-session.sh`.
2. When the session already exists, restart only the pane process in place. Do not kill the tmux session unless the user explicitly wants a fresh session.
3. Tell the user to attach with `tmux attach -t yash-voice-bridge:all` when the session is ready.
4. Use `scripts/capture-pane.sh` to read the latest output without disturbing the session.
5. Use the tmux skill patterns or `scripts/send-keys.sh` only for short interactive input like `C-c`.

## Default Live Command

The shared session runs this validated style of command from `/home/slash/dev/git/yash-voice-bridge`:

```bash
bun run raw \
  --source-kind pulse \
  --source alsa_input.usb-PreSonus_Revelator_IO_24_AB7C21181959-00.analog-surround-21 \
  --transcript-output stdout \
  --yash-ipc \
  --yash-actions
```

## Overrides

`scripts/start-live-session.sh` accepts optional environment overrides:

- `YVB_SOURCE`
- `YVB_TRANSCRIPT_OUTPUT`
- `YVB_EXTRA_ARGS`

Keep overrides short and visible in chat when using them.

## Notes

- Preserve attached clients whenever possible. Prefer restarting the command in the existing pane over recreating the whole tmux session.
- Prefer the real YASH socket default unless the task explicitly needs a proxy.
- For mapper validation, ask the user to say a short English phrase with no extra words, such as `list markers youtube`.
- If the user wants to watch live, avoid background-only validation. Keep the work inside `yash-voice-bridge:all`.
