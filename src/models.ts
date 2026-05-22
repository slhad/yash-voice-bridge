import path from "node:path";
import {
  MODEL_CATALOG,
  type DownloadProgress,
  downloadModel,
  ensureModelsDir,
  getModelInfo,
  humanBytes,
  listInstalledModels,
} from "./modelCatalog";
import { displayPath, loadOrInitAppConfig, resolveModelsDirFromConfig } from "./appConfig";

type Command = "list" | "installed" | "download";

type CliConfig = {
  command: Command;
  modelsDir: string;
  aliases: string[];
  help: boolean;
};

function parseArgs(argv: string[]): CliConfig {
  const args = [...argv];
  let modelsDir = "";
  const help = args.includes("--help") || args.includes("-h") || args[0] === "help";

  if (help) {
    return {
      command: "list",
      modelsDir,
      aliases: [],
      help: true,
    };
  }

  const modelsDirIndex = args.indexOf("--models-dir");
  if (modelsDirIndex >= 0) {
    const value = args[modelsDirIndex + 1];
    if (!value) {
      throw new Error("--models-dir requires a value");
    }

    modelsDir = value;
    args.splice(modelsDirIndex, 2);
  }

  const command = (args[0] as Command | undefined) ?? "list";
  const aliases = args.slice(1);

  if (!["list", "installed", "download"].includes(command)) {
    throw new Error(`Unknown command '${command}'. Use: list, installed, or download.`);
  }

  return { command, modelsDir, aliases, help: false };
}

function printHelp(): void {
  console.log(`Usage:
  bun run models:list
  bun run models:installed
  bun run models -- download <alias...> [--models-dir <dir>]
  bun run config:show
  bun run src/models.ts <list|installed|download> [args]

Commands:
  list         Show the built-in Whisper model catalog.
  installed    Show catalog models currently installed in the models directory.
  download     Download one or more catalog models by alias.

Options:
  --models-dir <dir>  Override the models directory from the app config file.
  --help, -h          Show this help message.

Examples:
  bun run models:list
  bun run models:installed
  bun run models -- download medium
  bun run models -- download large-v3-turbo-q5_0 --models-dir /tmp/whisper-models
  bun run config:show`);
}

function printCatalog(modelsDir: string): void {
  console.log(`Models dir: ${displayPath(modelsDir)}`);
  console.log("");

  for (const model of MODEL_CATALOG) {
    const recommendation = model.recommendedFor ? ` recommended=${model.recommendedFor}` : "";
    console.log(
      `${model.alias.padEnd(20)} ${model.sizeLabel.padEnd(8)} ${model.fileName} ${model.notes}${recommendation}`,
    );
  }
}

function renderProgressBar(downloadedBytes: number, totalBytes: number | null, width = 24): string {
  if (!totalBytes || totalBytes <= 0) {
    return `[${".".repeat(width)}]`;
  }

  const ratio = Math.max(0, Math.min(1, downloadedBytes / totalBytes));
  const filled = Math.round(ratio * width);
  return `[${"#".repeat(filled)}${".".repeat(width - filled)}]`;
}

async function printInstalled(modelsDir: string): Promise<void> {
  const installed = await listInstalledModels(modelsDir);

  if (installed.length === 0) {
    console.log(`No installed catalog models found in ${displayPath(modelsDir)}`);
    return;
  }

  console.log(`Installed models in ${displayPath(modelsDir)}`);
  console.log("");

  for (const model of installed) {
    console.log(
      `${model.alias.padEnd(20)} ${humanBytes(model.bytes).padEnd(8)} ${path.basename(model.filePath)} ${model.notes}`,
    );
  }
}

async function runDownload(modelsDir: string, aliases: string[]): Promise<void> {
  if (aliases.length === 0) {
    throw new Error("download requires at least one model alias");
  }

  await ensureModelsDir(modelsDir);

  for (const alias of aliases) {
    const model = getModelInfo(alias);
    if (!model) {
      throw new Error(`Unknown model alias '${alias}'`);
    }

    console.log(
      `Downloading ${model.alias} (${model.sizeLabel}) -> ${displayPath(path.join(modelsDir, model.fileName))}`,
    );
    const startedAt = Date.now();
    let lastRenderAt = 0;
    let renderedProgress = false;
    const renderProgress = (progress: DownloadProgress, force = false) => {
      const now = Date.now();
      if (!force && now - lastRenderAt < 250) {
        return;
      }

      lastRenderAt = now;
      renderedProgress = true;
      const elapsedSeconds = Math.max((now - startedAt) / 1000, 0.001);
      const speed = humanBytes(progress.downloadedBytes / elapsedSeconds);
      const totalLabel = progress.totalBytes === null ? "unknown" : humanBytes(progress.totalBytes);
      const percent =
        progress.totalBytes && progress.totalBytes > 0
          ? `${((progress.downloadedBytes / progress.totalBytes) * 100).toFixed(1)}%`
          : "??.?%";
      const bar = renderProgressBar(progress.downloadedBytes, progress.totalBytes);
      const line = `  ${bar} ${percent} ${humanBytes(progress.downloadedBytes)} / ${totalLabel} at ${speed}/s`;

      if (process.stdout.isTTY) {
        process.stdout.write(`\r${line}`);
      } else {
        console.log(line);
      }
    };

    const finalPath = await downloadModel(model, modelsDir, (progress) => renderProgress(progress));
    if (renderedProgress && process.stdout.isTTY) {
      const finalStats = await Bun.file(finalPath).stat();
      renderProgress({ downloadedBytes: finalStats.size, totalBytes: finalStats.size }, true);
      process.stdout.write("\n");
    }
    console.log(`Saved ${model.alias} to ${displayPath(finalPath)}`);
  }
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const appConfig = await loadOrInitAppConfig();

  const config: CliConfig = {
    ...cli,
    modelsDir: cli.modelsDir || resolveModelsDirFromConfig(appConfig),
  };

  if (config.help) {
    printHelp();
    console.log("");
    console.log(`App config: ${displayPath(appConfig.configFilePath)}`);
    return;
  }

  switch (config.command) {
    case "list":
      printCatalog(config.modelsDir);
      break;
    case "installed":
      await printInstalled(config.modelsDir);
      break;
    case "download":
      await runDownload(config.modelsDir, config.aliases);
      break;
  }
}

await main();
