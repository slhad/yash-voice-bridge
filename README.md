# yash-voice-bridge

`yash-voice-bridge` is an external Linux voice sidecar for YASH.

The current bootstrap goal is intentionally small and stream-first:

- capture audio from a live Pulse source or a replayable local stream fixture
- transcribe short rolling chunks locally with `whisper-cli`
- expose raw recognized text to stdout and, when configured, to a transcript file

Later phases will add:

- action-routing refinements
- VAD / wake-word refinements
- optional always-on daemon mode

## Current status

Implemented:

- Bun/TypeScript project scaffold
- raw transcription mode
- ffmpeg Pulse/PipeWire live capture and file replay capture
- local `whisper-cli` chunk transcription loop
- configurable transcript sink selection: stdout, file, or both
- replay offsets and bounded replay duration for deterministic validation
- silence gating for quiet chunks
- dedicated app config dir for defaults and packaging-safe runtime behavior
- AppImage packaging workflow and local AppImage build script
- wake-phrase filter: only forward transcripts to YASH IPC when they begin with the configured phrase
- local action mapping: score transcripts against YASH's structured action registry and invoke `invoke_action` when matched, falling back to raw command forwarding

Validated:

- full 1x replay transcription of `tmp/test-live-stream-recording.mp4`
- live Pulse capture against the Revelator mic input
- transcript output to stdout and file in both live and replay workflows
- local AppImage build via `./scripts/build-appimage.sh`

These validation artifacts currently live under `tmp/` and are machine-local operator evidence, not committed repo fixtures.

Not implemented yet:

- durable transcript persistence beyond the raw output file
- configurable VAD / wake-word policy

## Requirements

Expected local tools:

- `bun`
- `ffmpeg`
- `whisper-cli`
- one or more local Whisper ggml models
- PulseAudio / PipeWire compatibility (`ffmpeg -f pulse`)

## Whisper models

The repo now supports a shared local model directory with named ggml aliases, plus a small helper CLI for listing and downloading models.

App config location:

- `~/.config/yash-voice-bridge/config.json`

Default models directory behavior:

- fresh setups default to `./models` relative to the app config dir
- existing machines with a legacy Whisper cache may default to `~/.openclaw/whisper-models`
- inspect the effective config with `bun run config:show`

Expected naming pattern:

- `ggml-tiny.bin`
- `ggml-base.bin`
- `ggml-small.bin`
- `ggml-medium.bin`
- `ggml-large-v3.bin`

List the upstream catalog known to the repo:

```bash
bun run models:list
```

List installed catalog models on this machine:

```bash
bun run models:installed
```

Show the app config and resolved models directory:

```bash
bun run config:show
```

Download one or more models by alias:

```bash
bun run models -- download large-v3-turbo-q5_0 medium
```

Use either a full path or an alias in raw mode:

```bash
bun run raw --model small
```

```bash
bun run raw --model ~/.openclaw/whisper-models/ggml-medium.bin
```

## How to pick a model

Use the smallest model that is still accurate enough for the stream or microphone you are testing.

Practical tradeoffs:

- `tiny`: fastest and lightest, but the weakest accuracy; good only for rough smoke tests
- `base`: still lightweight, slightly better than `tiny`; useful when latency matters more than text quality
- `small`: lightweight fallback when `large-v3-turbo-q5_0` is unavailable or the machine can't keep up
- `large-v3-turbo-q5_0`: **current default**; best quality/speed/size compromise for this repo at 547 MiB
- `medium`: alternative step-up for multilingual speech when turbo accuracy falls short
- `large-v3`: highest quality, but the most expensive to run; better for offline validation than tight live loops unless the machine still keeps up

Selection guidance:

- use `large-v3-turbo-q5_0` as the default starting point — it is only 82 MiB larger than `small` but noticeably more accurate
- drop to `small`, `base`, or `tiny` if chunks backlog or the machine cannot keep pace with the capture rate
- try `medium` when multilingual speech is being recognized poorly and turbo is not enough
- reserve `large-v3` for high-accuracy comparison runs, fixture replay, or later tuning work

If you are unsure which model to use, run the same replay slice against `large-v3-turbo-q5_0` and `small` first. That gives a quick read on whether `small` is a viable fallback on this machine and audio source.

## YASH IPC

Enable IPC forwarding to send each recognized transcript line to YASH over its Unix socket:

```bash
bun run raw --yash-ipc
```

### Wake-phrase filter

Only forward lines that begin with a specific phrase. The phrase is stripped before forwarding by default:

```bash
bun run raw --yash-ipc --wake-phrase "hey yash"
```

Use `--no-wake-phrase-strip` to keep the phrase in the forwarded text.

### Action mapping

Map transcripts to structured YASH actions using the local YASH action registry instead of raw command forwarding:

```bash
bun run raw --yash-ipc --wake-phrase "hey yash" --yash-actions
```

The mapper fetches YASH actions with `list_actions`, keeps IPC-safe actions, scores transcripts against action titles/examples/ids, and prefers actions with `voiceHint: true`. Unmatched transcripts fall back to raw `command` forwarding.

Socket path defaults to `~/.yash/yash.sock`. Override with `--yash-socket <path>` or set `yashSocket` in `~/.config/yash-voice-bridge/config.json`.

## Usage

Default raw mode against the default Pulse source:

```bash
bun run raw
```

Explicit model swap using the alias-aware interface:

```bash
bun run raw --model medium
```

Explicit live capture configuration:

```bash
bun run src/index.ts \
  --mode raw \
  --source-kind pulse \
  --source alsa_input.usb-PreSonus_Revelator_IO_24_AB7C21181959-00.analog-surround-21 \
  --model small \
  --lang auto \
  --segment-seconds 4 \
  --transcript-output stdout
```

Replay validation target:

```bash
bun run src/index.ts \
  --mode raw \
  --source-kind file \
  --source tmp/test-live-stream-recording.mp4 \
  --source-offset-seconds 3240 \
  --source-duration-seconds 45 \
  --model large-v3-turbo-q5_0 \
  --lang auto \
  --segment-seconds 4 \
  --overlap-seconds 0.75 \
  --transcript-output both \
  --transcript-file tmp/runtime/replay-transcript.txt
```

## Packaging

Local binary build:

```bash
bun run build
```

Local AppImage build:

```bash
bun run appimage
```

This produces an artifact like:

- `yash-voice-bridge-dev-x86_64.AppImage`

Release automation:

- `.github/workflows/release.yml` builds a Linux x86_64 AppImage on pushed tags matching `v*`
- tagged builds publish the `.AppImage` to the matching GitHub release
- manual workflow dispatch also uploads the `.AppImage` as an artifact

Why the config dir matters for packaging:

- mutable defaults now live in `~/.config/yash-voice-bridge/config.json`
- model paths and runtime defaults no longer depend on `process.cwd()`
- repo files no longer need hardcoded home-directory paths

What raw mode does:

- selects a stream input path
- captures from Pulse when running live, or decodes the replay fixture when validating offline
- writes 16 kHz mono WAV chunks under the runtime directory
- transcribes finished chunks through a queued consumer so capture can keep running while Whisper is busy
- optionally builds a small overlap window from the tail of the previous chunk to reduce boundary loss
- prints recognized text to stdout when enabled
- appends recognized text to a transcript file when enabled

Press `Ctrl+C` to stop.

## Architecture

Current v0 path:

1. `ffmpeg` ingests either a live Pulse source or a replay file
2. audio is segmented into short WAV files under `tmp/runtime/`
3. `whisper-cli` transcribes each completed segment
4. transcript lines are routed to stdout, file output, or both

Future path:

1. normalize transcript
2. improve action scoring, confidence heuristics, and transcript normalization before IPC forwarding
3. validate the current IPC/action path more deeply against a live YASH instance

## Validation flows

Use live validation when checking the real device path:

- optionally list sources with `bun run src/index.ts --list-sources`
- optionally list installed models with `bun run src/index.ts --list-models`
- choose the target Pulse source
- confirm chunk files appear under `tmp/runtime/`
- speak into the device and confirm transcript lines appear on stdout
- a validated example transcript is in `tmp/runtime-live-mic-test/transcript.txt` on the validating machine

Use replay validation when you want deterministic testing without speaking:

- run against `tmp/test-live-stream-recording.mp4`
- use `--source-offset-seconds` to jump to a known spoken section without changing playback speed
- use `--source-duration-seconds` when you want a bounded replay that exits cleanly after draining the queue
- confirm the same chunk/transcription path runs without Pulse-device variance
- confirm stdout and transcript-file output match expectations
- a validated full-run transcript is in `tmp/runtime-full/transcript.txt` on the validating machine

## Milestone 1

Milestone 1 is complete.

That milestone covered:

- continuous live Pulse capture
- continuous replay capture from a recorded stream
- chunked local transcription
- raw terminal transcript visibility
- transcript file output for validation

Remaining work is now follow-up quality and next-phase integration work, not milestone-1 bootstrap plumbing.

## Notes

This repo is deliberately external to YASH so it can iterate on audio/transcription behavior without pulling microphone/runtime complexity into the YASH TUI process too early.
