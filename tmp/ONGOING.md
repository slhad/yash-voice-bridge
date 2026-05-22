# Ongoing

- Current baseline:
  - Milestone 1 is complete; raw Pulse/file capture, chunked local transcription, stdout/file transcript output, and silence gating are already implemented and documented in `SPECS.md`.
  - YASH IPC forwarding, wake-phrase gating, and the local no-API-cost action mapper are implemented; `SPECS.md` is the source of truth for current behavior.
  - `large-v3-turbo-q5_0` is the default recommended model; `small` is the lightweight fallback.

- Active work:
  - Validate IPC + local action mapping end-to-end against a live YASH instance.
  - Decide whether to add `--list-actions` for operator visibility into YASH's current voice-hinted action registry.
  - Decide whether to add stronger VAD / wake-word policy to reduce unnecessary `whisper-cli` calls on silent stretches.

- Notes:
  - Keep this file short and current. Closed implementation history belongs in `SPECS.md` or commit history, not here.
