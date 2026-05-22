# SPECS

## Goal

Build an external Linux voice bridge for YASH that:

- captures stream audio continuously
- transcribes locally
- can expose a raw console mode for debugging and validation
- later communicates with YASH over its Unix socket IPC

## v0 scope

The first implementation milestone is complete when:

- a live Pulse source can be captured continuously on this machine
- a recorded validation stream can be replayed through the same transcription path
- local transcription runs continuously over short rolling segments
- recognized text can be routed to stdout and optionally to a transcript file

The first milestone explicitly does not require:

- command triggering
- intent matching
- wake word handling
- always-on background service management
- config persistence

## Milestone 1 status

Milestone 1 is complete.

Validated proof points:

- live Pulse capture was validated against `alsa_input.usb-PreSonus_Revelator_IO_24_AB7C21181959-00.analog-surround-21`
- replay validation was completed against `tmp/test-live-stream-recording.mp4` at 1x speed
- chunked local transcription ran continuously in both live and replay modes
- recognized text was emitted to stdout and to transcript files
- quiet/no-voice chunks were gated so silent sections no longer emit obvious hallucinated text in the validated replay path

## Runtime assumptions

- Linux host
- PulseAudio-on-PipeWire or equivalent Pulse-compatible capture path
- `ffmpeg` available
- `whisper-cli` available
- one or more local Whisper ggml model files available
- a local validation recording may be used when a live source is inconvenient or noisy

## Whisper model workflow

The bridge should treat Whisper models as operator-managed local assets in a shared model directory, not as a single hard-coded file assumption.

Baseline assumptions:

- the app config file lives under `~/.config/yash-voice-bridge/config.json` unless `XDG_CONFIG_HOME` overrides it
- the configured model directory can point at a relative `./models` folder in the app config dir or at a legacy `~/.openclaw/whisper-models` cache
- model filenames follow common ggml naming such as `ggml-small.bin` or `ggml-medium.bin`
- raw mode still resolves to one concrete model file for each run

The intended CLI workflow should support:

- listing locally available ggml models in the model directory
- downloading a named ggml model into the model directory
- choosing a model either by full path or by model name/alias that resolves within the model directory

Current interface:

- `--model <whisper-model-path>`
- `--model <tiny|base|small|medium|large-v3|large-v3-turbo-q5_0|...>`
- `--models-dir <dir>`
- `--list-models`
- `bun run config:show`
- `bun run models:list`
- `bun run models:installed`
- `bun run models -- download <alias...>`

Behavior notes:

- `--model` remains the lowest-level escape hatch and also accepts catalog aliases
- alias resolution happens within `--models-dir` or the default model directory
- `--list-models` should show which expected ggml variants are already present and which are missing
- `bun run models -- download ...` should place the resolved model into the model directory without changing unrelated files
- the bootstrap milestone does not require background auto-updates or remote model management beyond on-demand download

Quality guidance:

- `tiny` favors speed over accuracy and is mainly for smoke tests
- `base` is a low-cost live option when latency matters more than accuracy
- `small` is a lightweight fallback when `large-v3-turbo-q5_0` is too heavy or unavailable
- `large-v3-turbo-q5_0` is the default recommended model for day-to-day raw mode
- `medium` is an alternative step-up for multilingual speech when turbo accuracy falls short
- `large-v3` is primarily for high-accuracy validation and slower offline comparison runs

## Current operating mode

### Raw mode

Raw mode is the primary bootstrap mode.

Behavior:

- select an input stream source
- support a live Pulse capture source, default `default`
- support replay from `tmp/test-live-stream-recording.mp4` for deterministic validation
- record 16 kHz mono WAV chunks in the runtime directory
- transcribe each completed chunk with `whisper-cli`
- emit non-empty recognized text to one or more sinks:
  - stdout
  - append-only transcript file

Flags to support:

- `--mode raw`
- `--source-kind pulse|file`
- `--source <pulse-source>`
- `--source-offset-seconds <n>`
- `--source-duration-seconds <n>`
- `--model <whisper-model-path>`
- `--models-dir <dir>`
- `--lang <whisper-language|auto>`
- `--segment-seconds <n>`
- `--overlap-seconds <n>`
- `--stats-interval-seconds <n>`
- `--min-mean-volume-db <n>`
- `--min-peak-volume-db <n>`
- `--runtime-dir <dir>`
- `--list-sources`
- `--list-models`
- `--transcript-output stdout|file|both`
- `--transcript-file <path>`
- `--yash-ipc`
- `--yash-socket <path>`
- `--wake-phrase <phrase>`
- `--no-wake-phrase-strip`
- `--yash-actions`

Behavior notes:

- `--source-kind pulse` captures directly from Pulse and should be the default operator path
- `--source-kind file --source tmp/test-live-stream-recording.mp4` feeds a recorded stream through the same chunking and transcription pipeline used by live capture
- `--source-offset-seconds` and `--source-duration-seconds` allow deterministic replay validation while preserving 1x playback speed
- `--overlap-seconds` allows a small rolling-window overlap between adjacent transcription jobs to reduce boundary loss
- `--transcript-output stdout` is the default bootstrap sink
- `--transcript-output file` or `both` should preserve line-oriented recognized text for later inspection

## Future direction

The main integration direction is:

- keep transcription external
- keep the stream-first capture/transcription loop stable while validating and tuning the implemented action logic
- treat YASH IPC as the control boundary
- eventually target structured actions rather than free-form slash commands

This repo should stay focused on:

- live and replayable stream capture
- transcription
- transcript routing and normalization if needed
- IPC client behavior

It should not absorb YASH business logic that belongs in YASH itself.

## Packaging

Packaging is now part of the supported operator workflow.

Supported packaging flow:

- `bun run build` compiles a standalone Linux binary to `dist/yash-voice-bridge`
- `bun run appimage` builds a Linux x86_64 AppImage locally
- `.github/workflows/release.yml` builds a Linux x86_64 AppImage on pushed tags matching `v*`
- tagged builds publish the `.AppImage` file to the matching GitHub release
- manual workflow dispatch uploads the `.AppImage` as a workflow artifact

Packaging assumptions:

- mutable defaults must live in the app config dir, not in `process.cwd()`
- the packaged app must work with the dedicated config file under `~/.config/yash-voice-bridge/config.json`
- model path defaults should be driven by config, not hardcoded absolute repo-local paths

## Validation

Before claiming the raw pipeline works:

- confirm live capture starts against the chosen Pulse source when `--source-kind pulse`
- confirm replay starts from `tmp/test-live-stream-recording.mp4` when `--source-kind file`
- confirm WAV chunks are created under the selected runtime directory
- confirm completed chunks are passed to `whisper-cli`
- confirm recognized text appears on stdout when enabled
- confirm transcript lines are appended to the transcript file when file output is enabled

Validated artifacts from milestone completion:

- live mic proof: `tmp/runtime-live-mic-test/transcript.txt` on the validating machine
- full replay proof: `tmp/runtime-full/transcript.txt` on the validating machine

## YASH IPC client

The IPC client layer is now implemented. Current capabilities:

- `--yash-ipc` forwards each transcript line to YASH over `~/.yash/yash.sock`
- `--wake-phrase <phrase>` gates forwarding to lines starting with the phrase (stripped before forwarding by default)
- `--yash-actions` enables local action mapping against YASH's `list_actions` output, preferring IPC-safe actions with useful token/title/example matches and falling back to raw `command` on no match
- All IPC errors are non-fatal: YASH not running logs a warning and the transcription loop continues
