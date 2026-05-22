import { appendFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileExists, humanBytes, listInstalledModels, resolveModelPath } from "./modelCatalog";
import {
  DEFAULT_MODEL_ALIAS,
  displayPath,
  expandPath,
  loadOrInitAppConfig,
  resolveModelsDirFromConfig,
} from "./appConfig";
import { resolveYashSocketPath, sendIpcRequest, sendVoiceTranscript } from "./ipc";
import { type ActionMapper, createActionMapper } from "./actionMapper";

type Mode = "raw";
type SourceKind = "pulse" | "file";
type TranscriptOutput = "stdout" | "file" | "both";

type Config = {
  mode: Mode;
  sourceKind: SourceKind;
  source: string;
  sourceOffsetSeconds: number;
  sourceDurationSeconds: number | null;
  statsIntervalSeconds: number;
  minMeanVolumeDb: number;
  minPeakVolumeDb: number;
  model: string;
  modelsDir: string;
  lang: string;
  segmentSeconds: number;
  overlapSeconds: number;
  runtimeDir: string;
  transcriptOutput: TranscriptOutput;
  transcriptFile: string | null;
  yashIpc: boolean;
  yashSocket: string;
  wakePhrase: string | null;
  wakePhraseStrip: boolean;
  yashActions: boolean;
  listSources: boolean;
  listModels: boolean;
  help: boolean;
};

type ChunkTask = {
  filePath: string;
  previousFilePath: string | null;
};

const DEFAULT_RUNTIME_DIR = path.join(process.cwd(), "tmp", "runtime");
const POLL_INTERVAL_MS = 500;
const FILE_STABLE_MS = 1200;
const DEFAULT_FILE_SOURCE = path.join(process.cwd(), "tmp", "test-live-stream-recording.mp4");

function parseArgs(argv: string[]): Config {
  const help = argv.includes("--help") || argv.includes("-h") || argv[0] === "help";
  const args = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part?.startsWith("--")) continue;

    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args.set(part, "true");
      continue;
    }

    args.set(part, next);
    i += 1;
  }

  const runtimeDir = args.get("--runtime-dir") ?? DEFAULT_RUNTIME_DIR;
  const transcriptOutput =
    (args.get("--transcript-output") as TranscriptOutput | undefined) ?? "stdout";
  const transcriptFileArg = args.get("--transcript-file");
  const transcriptFile =
    transcriptOutput === "file" || transcriptOutput === "both"
      ? (transcriptFileArg ?? path.join(runtimeDir, "transcript.txt"))
      : (transcriptFileArg ?? null);

  return {
    mode: (args.get("--mode") as Mode | undefined) ?? "raw",
    sourceKind: resolveSourceKind(args.get("--source-kind"), args.get("--source")),
    source: args.get("--source") ?? "default",
    sourceOffsetSeconds: Number(args.get("--source-offset-seconds") ?? "0"),
    sourceDurationSeconds: args.has("--source-duration-seconds")
      ? Number(args.get("--source-duration-seconds"))
      : null,
    statsIntervalSeconds: Number(args.get("--stats-interval-seconds") ?? "30"),
    minMeanVolumeDb: Number(args.get("--min-mean-volume-db") ?? "-45"),
    minPeakVolumeDb: Number(args.get("--min-peak-volume-db") ?? "-20"),
    model: args.get("--model") ?? DEFAULT_MODEL_ALIAS,
    modelsDir: args.get("--models-dir") ?? "",
    lang: args.get("--lang") ?? "auto",
    segmentSeconds: Number(args.get("--segment-seconds") ?? "6"),
    overlapSeconds: Number(args.get("--overlap-seconds") ?? "0.75"),
    runtimeDir,
    transcriptOutput,
    transcriptFile,
    yashIpc: args.get("--yash-ipc") === "true",
    yashSocket: args.get("--yash-socket") ?? "",
    wakePhrase: args.get("--wake-phrase") ?? null,
    wakePhraseStrip: args.get("--no-wake-phrase-strip") !== "true",
    yashActions: args.get("--yash-actions") === "true",
    listSources: args.get("--list-sources") === "true",
    listModels: args.get("--list-models") === "true",
    help,
  };
}

function printHelp(): void {
  console.log(`Usage:
  bun run raw [options]
  bun run src/index.ts --mode raw [options]

Modes:
  --mode raw                 Continuous raw transcription mode.

Source options:
  --source-kind pulse|file   Capture from Pulse or replay a file.
  --source <value>           Pulse source name or input file path.
  --source-offset-seconds N  Start replay N seconds into the file.
  --source-duration-seconds N
                             Limit replay duration to N seconds.
  --list-sources             Print available Pulse sources and exit.

Model options:
  --model <path|alias>       Whisper model path or alias like small, medium, large-v3-turbo-q5_0.
  --models-dir <dir>         Directory used for model alias resolution.
  --list-models              Print installed catalog models and exit.

Transcription options:
  --lang <auto|lang>         Whisper language, default auto.
  --segment-seconds N        Chunk length in seconds.
  --overlap-seconds N        Tail overlap from previous chunk.
  --stats-interval-seconds N Emit progress stats every N seconds.
  --min-mean-volume-db N     Skip chunks below this mean dBFS, default -45.
  --min-peak-volume-db N     Skip chunks below this peak dBFS, default -20.

Output options:
  --runtime-dir <dir>        Runtime directory for chunk WAV files.
  --transcript-output stdout|file|both
                             Where transcript lines should go.
  --transcript-file <path>   Transcript file path for file/both output.

YASH IPC options:
  --yash-ipc                 Forward each transcript line to YASH over its Unix socket.
  --yash-socket <path>       Override the YASH socket path (default: ~/.yash/yash.sock).

Wake-word filter options:
  --wake-phrase <phrase>     Only forward to YASH IPC transcripts that begin with this phrase.
  --no-wake-phrase-strip     Keep the wake phrase in the forwarded text (default: strip it).

Action mapping options:
  --yash-actions             Map transcripts to structured YASH actions via keyword matching (requires --yash-ipc).

Help:
  --help, -h                 Show this help message.

Examples:
  bun run raw --model medium
  bun run raw --source-kind file --source tmp/test-live-stream-recording.mp4 --model large-v3-turbo-q5_0
  bun run src/index.ts --list-sources
  bun run src/index.ts --list-models
  bun run config:show`);
}

function resolveSourceKind(
  sourceKindArg: string | undefined,
  sourceArg: string | undefined,
): SourceKind {
  if (sourceKindArg === "pulse" || sourceKindArg === "file") {
    return sourceKindArg;
  }

  if (
    sourceArg &&
    sourceArg !== "default" &&
    !sourceArg.startsWith("alsa_input.") &&
    !sourceArg.startsWith("pulse:")
  ) {
    return "file";
  }

  return "pulse";
}

function validateConfig(config: Config): void {
  if (config.mode !== "raw") {
    throw new Error(`Unsupported mode: ${config.mode}`);
  }

  if (!Number.isFinite(config.segmentSeconds) || config.segmentSeconds <= 0) {
    throw new Error(`Invalid --segment-seconds value: ${config.segmentSeconds}`);
  }

  if (!Number.isFinite(config.overlapSeconds) || config.overlapSeconds < 0) {
    throw new Error(`Invalid --overlap-seconds value: ${config.overlapSeconds}`);
  }

  if (!Number.isFinite(config.sourceOffsetSeconds) || config.sourceOffsetSeconds < 0) {
    throw new Error(`Invalid --source-offset-seconds value: ${config.sourceOffsetSeconds}`);
  }

  if (
    config.sourceDurationSeconds !== null &&
    (!Number.isFinite(config.sourceDurationSeconds) || config.sourceDurationSeconds <= 0)
  ) {
    throw new Error(`Invalid --source-duration-seconds value: ${config.sourceDurationSeconds}`);
  }

  if (!Number.isFinite(config.statsIntervalSeconds) || config.statsIntervalSeconds <= 0) {
    throw new Error(`Invalid --stats-interval-seconds value: ${config.statsIntervalSeconds}`);
  }

  if (!Number.isFinite(config.minMeanVolumeDb) || config.minMeanVolumeDb > 0) {
    throw new Error(`Invalid --min-mean-volume-db value: ${config.minMeanVolumeDb}`);
  }

  if (!Number.isFinite(config.minPeakVolumeDb) || config.minPeakVolumeDb > 0) {
    throw new Error(`Invalid --min-peak-volume-db value: ${config.minPeakVolumeDb}`);
  }

  if (config.overlapSeconds >= config.segmentSeconds) {
    throw new Error("--overlap-seconds must be smaller than --segment-seconds");
  }

  if (!["stdout", "file", "both"].includes(config.transcriptOutput)) {
    throw new Error(`Invalid --transcript-output value: ${config.transcriptOutput}`);
  }

  if (config.wakePhrase !== null && config.wakePhrase.trim().length < 2) {
    throw new Error("--wake-phrase must be at least 2 characters");
  }
}

async function ensureRuntimeDir(runtimeDir: string): Promise<void> {
  await mkdir(runtimeDir, { recursive: true });
}

async function ensureTranscriptFile(config: Config): Promise<void> {
  if (!config.transcriptFile) return;

  await mkdir(path.dirname(config.transcriptFile), { recursive: true });
  await writeFile(config.transcriptFile, "");
}

async function cleanRuntimeDir(runtimeDir: string): Promise<void> {
  const entries = await readdir(runtimeDir, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries.map((entry) =>
      rm(path.join(runtimeDir, entry.name), {
        recursive: true,
        force: true,
      }),
    ),
  );
}

async function streamToText(
  stream: ReadableStream<Uint8Array<ArrayBufferLike>> | number | undefined,
): Promise<string> {
  if (!(stream instanceof ReadableStream)) {
    return "";
  }

  return new Response(stream).text();
}

async function runCommand(
  cmd: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    streamToText(proc.stdout),
    streamToText(proc.stderr),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

async function transcribeChunk(filePath: string, config: Config, prompt: string): Promise<string> {
  const cmd = [
    "whisper-cli",
    "-m",
    config.model,
    "-l",
    config.lang,
    "-nt",
    "-np",
    "--prompt",
    prompt,
    "-f",
    filePath,
  ];

  const { stdout, stderr, exitCode } = await runCommand(cmd);

  if (exitCode !== 0) {
    throw new Error(
      `whisper-cli failed for ${path.basename(filePath)}: ${stderr.trim() || stdout.trim()}`,
    );
  }

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => Boolean(line) && line !== "[BLANK_AUDIO]" && line !== "[ Silence ]")
    .join(" ");
}

async function listProcessableChunks(
  runtimeDir: string,
  seen: Set<string>,
  includeLastChunk: boolean,
): Promise<string[]> {
  const names = (await readdir(runtimeDir).catch(() => []))
    .filter((name) => name.endsWith(".wav") && name.startsWith("chunk-"))
    .sort();

  if (names.length === 0) return [];

  const candidates = includeLastChunk ? names : names.slice(0, -1);
  const now = Date.now();
  const ready: string[] = [];

  for (const name of candidates) {
    if (seen.has(name)) continue;

    const filePath = path.join(runtimeDir, name);
    const info = await stat(filePath).catch(() => null);
    if (!info) continue;
    if (now - info.mtimeMs < FILE_STABLE_MS) continue;
    if (info.size <= 44) continue;
    ready.push(filePath);
  }

  return ready;
}

async function createOverlapChunk(task: ChunkTask, config: Config): Promise<string> {
  if (!task.previousFilePath || config.overlapSeconds <= 0) {
    return task.filePath;
  }

  const overlapPath = path.join(config.runtimeDir, `overlap-${path.basename(task.filePath)}`);
  const overlapDuration = String(config.overlapSeconds);
  const cmd = [
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-sseof",
    `-${overlapDuration}`,
    "-i",
    task.previousFilePath,
    "-i",
    task.filePath,
    "-filter_complex",
    "[0:a][1:a]concat=n=2:v=0:a=1[out]",
    "-map",
    "[out]",
    overlapPath,
  ];

  const { stderr, stdout, exitCode } = await runCommand(cmd);

  if (exitCode !== 0) {
    throw new Error(
      `ffmpeg overlap build failed for ${path.basename(task.filePath)}: ${stderr.trim() || stdout.trim()}`,
    );
  }

  return overlapPath;
}

function dedupeTranscript(previousText: string, currentText: string): string {
  const normalizedCurrent = currentText.trim().replace(/\s+/g, " ");
  if (!previousText || !normalizedCurrent) {
    return normalizedCurrent;
  }

  const previousWords = tokenize(previousText);
  const currentWords = tokenize(normalizedCurrent);
  const maxOverlap = Math.min(previousWords.length, currentWords.length, 18);

  for (let overlap = maxOverlap; overlap >= 3; overlap -= 1) {
    const previousSuffix = previousWords.slice(-overlap).join(" ");
    const currentPrefix = currentWords.slice(0, overlap).join(" ");
    if (previousSuffix === currentPrefix) {
      return currentWords.slice(overlap).join(" ").trim();
    }
  }

  return normalizedCurrent;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function shouldForwardToIpc(text: string, config: Config): string | null {
  if (!config.wakePhrase) return text;

  const normalized = text.toLowerCase().trim();
  const phrase = config.wakePhrase.toLowerCase().trim();
  if (!normalized.startsWith(phrase)) return null;

  if (!config.wakePhraseStrip) return text;
  return text.slice(phrase.length).trim() || null;
}

async function emitTranscript(
  text: string,
  config: Config,
  mapper: ActionMapper | null,
): Promise<void> {
  if (!text) return;

  if (config.transcriptOutput === "stdout" || config.transcriptOutput === "both") {
    console.log(`[raw] ${text}`);
  }

  if (
    (config.transcriptOutput === "file" || config.transcriptOutput === "both") &&
    config.transcriptFile
  ) {
    await appendFile(config.transcriptFile, `${text}\n`);
  }

  if (config.yashIpc) {
    const forwardText = shouldForwardToIpc(text, config);
    if (forwardText) {
      try {
        let dispatched = false;
        if (mapper) {
          const mapped = await mapper.map(forwardText);
          if (mapped.matched) {
            const res = await sendIpcRequest(config.yashSocket, {
              type: "invoke_action",
              action: mapped.action,
              args: mapped.args,
            });
            if (!res.ok) {
              console.error(`[ipc] YASH rejected action ${mapped.action}: ${res.error.message}`);
            }
            dispatched = true;
          }
        }
        if (!dispatched) {
          const res = await sendVoiceTranscript(config.yashSocket, forwardText);
          if (!res.ok) {
            console.error(`[ipc] YASH rejected command: ${res.error.message}`);
          }
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ECONNREFUSED") {
          console.error("[ipc] YASH is not running — transcript not forwarded");
        } else {
          console.error("[ipc] IPC send failed:", err);
        }
      }
    }
  }
}

type ProgressStats = {
  emittedLines: number;
  emittedChars: number;
  queuedChunks: number;
  completedChunks: number;
  skippedQuietChunks: number;
};

function formatElapsedMs(startMs: number): string {
  const totalSeconds = Math.floor((Date.now() - startMs) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function logProgress(config: Config, stats: ProgressStats, startMs: number): void {
  console.log(
    `[raw] stats elapsed=${formatElapsedMs(startMs)} queued=${stats.queuedChunks} completedChunks=${stats.completedChunks} skippedQuietChunks=${stats.skippedQuietChunks} emittedLines=${stats.emittedLines} emittedChars=${stats.emittedChars} output=${config.transcriptOutput}`,
  );
}

type AudioLevel = {
  meanVolumeDb: number;
  peakVolumeDb: number;
};

function findWavDataOffset(buffer: Buffer): { offset: number; length: number } | null {
  if (buffer.length < 12) {
    return null;
  }

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;

    if (chunkId === "data") {
      const availableLength = Math.min(chunkSize, buffer.length - chunkDataOffset);
      return { offset: chunkDataOffset, length: availableLength };
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  return null;
}

async function analyzeWavAudioLevel(filePath: string): Promise<AudioLevel> {
  const buffer = Buffer.from(await Bun.file(filePath).arrayBuffer());
  const dataChunk = findWavDataOffset(buffer);
  if (!dataChunk || dataChunk.length < 2) {
    return { meanVolumeDb: -Infinity, peakVolumeDb: -Infinity };
  }

  let sumSquares = 0;
  let peak = 0;
  let sampleCount = 0;

  const endOffset = dataChunk.offset + dataChunk.length;
  for (let offset = dataChunk.offset; offset + 1 < endOffset; offset += 2) {
    const sample = buffer.readInt16LE(offset);
    const normalized = sample / 32768;
    const abs = Math.abs(normalized);

    sumSquares += normalized * normalized;
    if (abs > peak) {
      peak = abs;
    }
    sampleCount += 1;
  }

  if (sampleCount === 0) {
    return { meanVolumeDb: -Infinity, peakVolumeDb: -Infinity };
  }

  const rms = Math.sqrt(sumSquares / sampleCount);
  return {
    meanVolumeDb: rms > 0 ? 20 * Math.log10(rms) : -Infinity,
    peakVolumeDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
  };
}

function isChunkTooQuiet(level: AudioLevel, config: Config): boolean {
  return level.meanVolumeDb < config.minMeanVolumeDb && level.peakVolumeDb < config.minPeakVolumeDb;
}

async function listPulseSources(): Promise<void> {
  const { stdout, stderr, exitCode } = await runCommand(["pactl", "list", "short", "sources"]);
  if (exitCode !== 0) {
    throw new Error(`pactl list short sources failed: ${stderr.trim() || stdout.trim()}`);
  }

  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    console.log("No Pulse sources found.");
    return;
  }

  for (const line of lines) {
    console.log(line);
  }
}

async function listModels(modelsDir: string): Promise<void> {
  const installed = await listInstalledModels(modelsDir);

  if (installed.length === 0) {
    console.log(`No installed catalog models found in ${displayPath(modelsDir)}`);
    return;
  }

  console.log(`Installed models in ${displayPath(modelsDir)}`);
  console.log("");

  for (const model of installed) {
    console.log(
      `${model.alias.padEnd(20)} ${humanBytes(model.bytes).padEnd(8)} ${displayPath(model.filePath)} ${model.notes}`,
    );
  }
}

async function startCapture(config: Config): Promise<Bun.Subprocess> {
  const targetSource =
    config.sourceKind === "file" && config.source === "default"
      ? DEFAULT_FILE_SOURCE
      : config.source;

  console.log(`[raw] starting stream capture`);
  console.log(`[raw] sourceKind=${config.sourceKind}`);
  console.log(`[raw] source=${targetSource}`);
  console.log(`[raw] sourceOffsetSeconds=${config.sourceOffsetSeconds}`);
  if (config.sourceDurationSeconds !== null) {
    console.log(`[raw] sourceDurationSeconds=${config.sourceDurationSeconds}`);
  }
  console.log(`[raw] model=${config.model}`);
  console.log(`[raw] modelsDir=${config.modelsDir}`);
  console.log(`[raw] lang=${config.lang}`);
  console.log(`[raw] segmentSeconds=${config.segmentSeconds}`);
  console.log(`[raw] overlapSeconds=${config.overlapSeconds}`);
  console.log(`[raw] minMeanVolumeDb=${config.minMeanVolumeDb}`);
  console.log(`[raw] minPeakVolumeDb=${config.minPeakVolumeDb}`);
  console.log(`[raw] runtimeDir=${config.runtimeDir}`);
  console.log(`[raw] transcriptOutput=${config.transcriptOutput}`);
  console.log(`[raw] statsIntervalSeconds=${config.statsIntervalSeconds}`);
  if (config.transcriptFile) {
    console.log(`[raw] transcriptFile=${config.transcriptFile}`);
  }
  if (config.yashIpc) {
    console.log(`[raw] yashIpc=true yashSocket=${config.yashSocket}`);
  }
  if (config.wakePhrase) {
    console.log(`[raw] wakePhrase=${config.wakePhrase} wakePhraseStrip=${config.wakePhraseStrip}`);
  }
  if (config.yashActions) {
    console.log(`[raw] yashActions=true`);
  }

  const globalArgs = ["-hide_banner", "-loglevel", "error"];

  const segmentOutputArgs = [
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    "-f",
    "segment",
    "-segment_time",
    String(config.segmentSeconds),
    "-reset_timestamps",
    "1",
    path.join(config.runtimeDir, "chunk-%06d.wav"),
  ];

  const cmd =
    config.sourceKind === "file"
      ? [
          "ffmpeg",
          ...globalArgs,
          ...(config.sourceOffsetSeconds > 0 ? ["-ss", String(config.sourceOffsetSeconds)] : []),
          "-re",
          "-i",
          targetSource,
          ...(config.sourceDurationSeconds !== null
            ? ["-t", String(config.sourceDurationSeconds)]
            : []),
          "-map",
          "0:a:0?",
          "-vn",
          "-sn",
          "-dn",
          ...segmentOutputArgs,
        ]
      : ["ffmpeg", ...globalArgs, "-f", "pulse", "-i", targetSource, ...segmentOutputArgs];

  return Bun.spawn({
    cmd,
    stdout: "ignore",
    stderr: "pipe",
  });
}

async function runTranscriber(
  config: Config,
  queue: ChunkTask[],
  stats: ProgressStats,
  isDone: () => boolean,
  mapper: ActionMapper | null,
): Promise<void> {
  let lastPrompt = config.wakePhrase ? `[voice command prefix: ${config.wakePhrase}]` : "";
  let lastEmitted = "";

  while (!isDone() || queue.length > 0) {
    const task = queue.shift();
    if (!task) {
      await Bun.sleep(100);
      continue;
    }

    let transcriptionFile = task.filePath;

    try {
      transcriptionFile = await createOverlapChunk(task, config);
      const level = await analyzeWavAudioLevel(transcriptionFile);
      if (isChunkTooQuiet(level, config)) {
        stats.skippedQuietChunks += 1;
        stats.completedChunks += 1;
        continue;
      }

      const rawText = await transcribeChunk(
        transcriptionFile,
        { ...config, model: resolveModelPath(config.model, config.modelsDir) },
        lastPrompt,
      );
      const text = dedupeTranscript(lastEmitted, rawText);

      if (text) {
        await emitTranscript(text, config, mapper);
        lastPrompt = `${lastPrompt} ${text}`.trim().slice(-500);
        lastEmitted = text;
        stats.emittedLines += 1;
        stats.emittedChars += text.length;
      }
      stats.completedChunks += 1;
    } catch (error) {
      console.error(`[raw] transcription error for ${path.basename(task.filePath)}:`, error);
    } finally {
      if (transcriptionFile !== task.filePath) {
        await rm(transcriptionFile, { force: true }).catch(() => undefined);
      }
    }
  }
}

async function runRawMode(config: Config, mapper: ActionMapper | null): Promise<void> {
  const resolvedModelPath = resolveModelPath(config.model, config.modelsDir);
  if (!(await fileExists(resolvedModelPath))) {
    throw new Error(`Resolved model path does not exist: ${resolvedModelPath}`);
  }

  const resolvedConfig: Config = {
    ...config,
    model: resolvedModelPath,
  };

  await ensureRuntimeDir(config.runtimeDir);
  await cleanRuntimeDir(config.runtimeDir);
  await ensureTranscriptFile(config);

  const capture = await startCapture(resolvedConfig);
  const seen = new Set<string>();
  const queue: ChunkTask[] = [];
  const stats: ProgressStats = {
    emittedLines: 0,
    emittedChars: 0,
    queuedChunks: 0,
    completedChunks: 0,
    skippedQuietChunks: 0,
  };
  const startMs = Date.now();
  let previousChunkPath: string | null = null;
  let stopped = false;
  let captureEnded = false;
  let captureError: Error | null = null;

  const stderrReader = streamToText(capture.stderr)
    .then((text) => text.trim())
    .catch(() => "");

  const shutdown = async () => {
    stopped = true;
    if (capture.exitCode === null) {
      capture.kill();
      await capture.exited.catch(() => undefined);
    }
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  const transcriber = runTranscriber(
    resolvedConfig,
    queue,
    stats,
    () => stopped && captureEnded,
    mapper,
  );
  const statsTimer = setInterval(() => {
    stats.queuedChunks = queue.length;
    logProgress(config, stats, startMs);
  }, config.statsIntervalSeconds * 1000);

  while (!stopped) {
    if (capture.exitCode !== null && !captureEnded) {
      captureEnded = true;
      const stderr = await stderrReader;
      if (capture.exitCode !== 0) {
        captureError = new Error(
          `ffmpeg capture exited with code ${capture.exitCode}${stderr ? `: ${stderr}` : ""}`,
        );
      } else if (config.sourceKind === "pulse") {
        captureError = new Error(
          `ffmpeg Pulse capture ended unexpectedly${stderr ? `: ${stderr}` : ""}`,
        );
      }
    }

    const readyChunks = await listProcessableChunks(config.runtimeDir, seen, captureEnded);

    for (const filePath of readyChunks) {
      const fileName = path.basename(filePath);
      seen.add(fileName);
      queue.push({ filePath, previousFilePath: previousChunkPath });
      stats.queuedChunks = queue.length;
      previousChunkPath = filePath;
    }

    if (captureEnded && queue.length === 0) {
      stopped = true;
      break;
    }

    await Bun.sleep(POLL_INTERVAL_MS);
  }

  captureEnded = true;
  clearInterval(statsTimer);
  stats.queuedChunks = queue.length;
  await transcriber;
  logProgress(config, stats, startMs);

  if (captureError) {
    throw captureError;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const config = parseArgs(argv);
  const appConfig = await loadOrInitAppConfig();
  const cliFlags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const resolvedFromFile = appConfig.values;
  const resolvedConfig: Config = {
    ...config,
    model: cliFlags.has("--model") ? config.model : (resolvedFromFile.model ?? config.model),
    modelsDir: cliFlags.has("--models-dir")
      ? config.modelsDir
      : resolveModelsDirFromConfig(appConfig),
    lang: cliFlags.has("--lang") ? config.lang : (resolvedFromFile.lang ?? config.lang),
    segmentSeconds: cliFlags.has("--segment-seconds")
      ? config.segmentSeconds
      : (resolvedFromFile.segmentSeconds ?? config.segmentSeconds),
    overlapSeconds: cliFlags.has("--overlap-seconds")
      ? config.overlapSeconds
      : (resolvedFromFile.overlapSeconds ?? config.overlapSeconds),
    statsIntervalSeconds: cliFlags.has("--stats-interval-seconds")
      ? config.statsIntervalSeconds
      : (resolvedFromFile.statsIntervalSeconds ?? config.statsIntervalSeconds),
    minMeanVolumeDb: cliFlags.has("--min-mean-volume-db")
      ? config.minMeanVolumeDb
      : (resolvedFromFile.minMeanVolumeDb ?? config.minMeanVolumeDb),
    minPeakVolumeDb: cliFlags.has("--min-peak-volume-db")
      ? config.minPeakVolumeDb
      : (resolvedFromFile.minPeakVolumeDb ?? config.minPeakVolumeDb),
    yashSocket: resolveYashSocketPath(
      cliFlags.has("--yash-socket")
        ? config.yashSocket
        : resolvedFromFile.yashSocket
          ? expandPath(resolvedFromFile.yashSocket)
          : undefined,
    ),
    wakePhrase: cliFlags.has("--wake-phrase")
      ? config.wakePhrase
      : (resolvedFromFile.wakePhrase ?? config.wakePhrase),
    wakePhraseStrip: cliFlags.has("--no-wake-phrase-strip")
      ? config.wakePhraseStrip
      : (resolvedFromFile.wakePhraseStrip ?? config.wakePhraseStrip),
    yashActions: cliFlags.has("--yash-actions")
      ? config.yashActions
      : (resolvedFromFile.yashActions ?? config.yashActions),
  };

  if (resolvedConfig.help) {
    printHelp();
    console.log("");
    console.log(`App config: ${displayPath(appConfig.configFilePath)}`);
    return;
  }

  validateConfig(resolvedConfig);

  const mapper: ActionMapper | null =
    resolvedConfig.yashActions && resolvedConfig.yashIpc
      ? await createActionMapper({
          socketPath: resolvedConfig.yashSocket,
          refreshIntervalMs: 60_000,
        })
      : null;

  if (resolvedConfig.listSources) {
    await listPulseSources();
    return;
  }

  if (resolvedConfig.listModels) {
    await listModels(resolvedConfig.modelsDir);
    return;
  }

  try {
    await runRawMode(resolvedConfig, mapper);
  } finally {
    mapper?.close();
  }
}

await main();
