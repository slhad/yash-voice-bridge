import { homedir } from "node:os";
import path from "node:path";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";

export const APP_DIR_NAME = "yash-voice-bridge";
export const DEFAULT_MODEL_ALIAS = "large-v3-turbo-q5_0";

export type AppConfigFile = {
  model?: string;
  modelsDir?: string;
  lang?: string;
  segmentSeconds?: number;
  overlapSeconds?: number;
  statsIntervalSeconds?: number;
  minMeanVolumeDb?: number;
  minPeakVolumeDb?: number;
  wakePhrase?: string;
  wakePhraseStrip?: boolean;
  yashActions?: boolean;
  yashSocket?: string;
};

export type LoadedAppConfig = {
  configDir: string;
  configFilePath: string;
  values: AppConfigFile;
};

export function getAppConfigDir(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, APP_DIR_NAME);
  }

  return path.join(homedir(), ".config", APP_DIR_NAME);
}

export function getAppConfigFilePath(): string {
  return path.join(getAppConfigDir(), "config.json");
}

export function getLegacyModelsDir(): string {
  return path.join(homedir(), ".openclaw", "whisper-models");
}

export function displayPath(filePath: string): string {
  const home = homedir();
  if (filePath === home) return "~";
  if (filePath.startsWith(`${home}/`)) {
    return `~/${filePath.slice(home.length + 1)}`;
  }
  return filePath;
}

export function expandPath(filePath: string, baseDir?: string): string {
  if (filePath === "~") {
    return homedir();
  }

  if (filePath.startsWith("~/")) {
    return path.join(homedir(), filePath.slice(2));
  }

  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  return path.resolve(baseDir ?? process.cwd(), filePath);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function buildInitialConfigFile(): Promise<AppConfigFile> {
  const legacyModelsDir = getLegacyModelsDir();
  const defaultModelsDir = (await fileExists(legacyModelsDir))
    ? "~/.openclaw/whisper-models"
    : "./models";

  return {
    model: DEFAULT_MODEL_ALIAS,
    modelsDir: defaultModelsDir,
    lang: "auto",
    segmentSeconds: 6,
    overlapSeconds: 0.75,
    statsIntervalSeconds: 30,
    minMeanVolumeDb: -45,
    minPeakVolumeDb: -20,
  };
}

export async function loadOrInitAppConfig(): Promise<LoadedAppConfig> {
  const configDir = getAppConfigDir();
  const configFilePath = getAppConfigFilePath();

  await mkdir(configDir, { recursive: true });

  if (!(await fileExists(configFilePath))) {
    const initialConfig = await buildInitialConfigFile();
    await writeFile(configFilePath, `${JSON.stringify(initialConfig, null, 2)}\n`);
  }

  const raw = await readFile(configFilePath, "utf8");
  const values = JSON.parse(raw) as AppConfigFile;
  return { configDir, configFilePath, values };
}

export function resolveModelsDirFromConfig(config: LoadedAppConfig): string {
  return expandPath(config.values.modelsDir ?? "./models", config.configDir);
}
