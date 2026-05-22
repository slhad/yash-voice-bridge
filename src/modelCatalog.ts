import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { expandPath } from "./appConfig";

export const MODEL_REPO_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

export type ModelInfo = {
  alias: string;
  fileName: string;
  sizeLabel: string;
  sha1: string;
  notes: string;
  recommendedFor?: string;
};

export type DownloadProgress = {
  downloadedBytes: number;
  totalBytes: number | null;
};

export const MODEL_CATALOG: ModelInfo[] = [
  {
    alias: "tiny",
    fileName: "ggml-tiny.bin",
    sizeLabel: "75 MiB",
    sha1: "bd577a113a864445d4c299885e0cb97d4ba92b5f",
    notes: "Fastest, lowest accuracy.",
    recommendedFor: "quick smoke tests",
  },
  {
    alias: "tiny.en",
    fileName: "ggml-tiny.en.bin",
    sizeLabel: "75 MiB",
    sha1: "c78c86eb1a8faa21b369bcd33207cc90d64ae9df",
    notes: "English-only tiny model.",
  },
  {
    alias: "base",
    fileName: "ggml-base.bin",
    sizeLabel: "142 MiB",
    sha1: "465707469ff3a37a2b9b8d8f89f2f99de7299dac",
    notes: "Still light, modest quality bump over tiny.",
  },
  {
    alias: "base.en",
    fileName: "ggml-base.en.bin",
    sizeLabel: "142 MiB",
    sha1: "137c40403d78fd54d454da0f9bd998f78703390c",
    notes: "English-only base model.",
  },
  {
    alias: "small",
    fileName: "ggml-small.bin",
    sizeLabel: "466 MiB",
    sha1: "55356645c2b361a969dfd0ef2c5a50d530afd8d5",
    notes: "Good starting point. Balanced but can be weak on noisy long-form audio.",
  },
  {
    alias: "small.en",
    fileName: "ggml-small.en.bin",
    sizeLabel: "466 MiB",
    sha1: "db8a495a91d927739e50b3fc1cc4c6b8f6c2d022",
    notes: "English-only small model.",
  },
  {
    alias: "medium",
    fileName: "ggml-medium.bin",
    sizeLabel: "1.5 GiB",
    sha1: "fd9727b6e1217c2f614f9b698455c4ffd82463b4",
    notes: "Meaningful quality jump for multilingual speech.",
    recommendedFor: "better long-form multilingual transcription",
  },
  {
    alias: "medium.en",
    fileName: "ggml-medium.en.bin",
    sizeLabel: "1.5 GiB",
    sha1: "8c30f0e44ce9560643ebd10bbe50cd20eafd3723",
    notes: "English-only medium model.",
  },
  {
    alias: "large-v2",
    fileName: "ggml-large-v2.bin",
    sizeLabel: "2.9 GiB",
    sha1: "0f4c8e34f21cf1a914c59d8b3ce882345ad349d6",
    notes: "High quality, heavy disk and memory cost.",
  },
  {
    alias: "large-v2-q5_0",
    fileName: "ggml-large-v2-q5_0.bin",
    sizeLabel: "1.1 GiB",
    sha1: "00e39f2196344e901b3a2bd5814807a769bd1630",
    notes: "Quantized large-v2; smaller than full large-v2.",
  },
  {
    alias: "large-v3",
    fileName: "ggml-large-v3.bin",
    sizeLabel: "2.9 GiB",
    sha1: "ad82bf6a9043ceed055076d0fd39f5f186ff8062",
    notes: "High quality multilingual model.",
  },
  {
    alias: "large-v3-q5_0",
    fileName: "ggml-large-v3-q5_0.bin",
    sizeLabel: "1.1 GiB",
    sha1: "e6e2ed78495d403bef4b7cff42ef4aaadcfea8de",
    notes: "Quantized large-v3; good quality/size compromise.",
  },
  {
    alias: "large-v3-turbo",
    fileName: "ggml-large-v3-turbo.bin",
    sizeLabel: "1.5 GiB",
    sha1: "4af2b29d7ec73d781377bfd1758ca957a807e941",
    notes: "Fast large-v3 family model.",
  },
  {
    alias: "large-v3-turbo-q5_0",
    fileName: "ggml-large-v3-turbo-q5_0.bin",
    sizeLabel: "547 MiB",
    sha1: "e050f7970618a659205450ad97eb95a18d69c9ee",
    notes: "Current default. Best quality/speed/size compromise for this repo.",
    recommendedFor: "default recommended model",
  },
];

export function getModelInfo(alias: string): ModelInfo | undefined {
  return MODEL_CATALOG.find((model) => model.alias === alias);
}

export async function ensureModelsDir(modelsDir: string): Promise<void> {
  await mkdir(modelsDir, { recursive: true });
}

export function resolveModelPath(modelArg: string, modelsDir: string, baseDir?: string): string {
  if (modelArg.includes("/") || modelArg.endsWith(".bin")) {
    return expandPath(modelArg, baseDir);
  }

  const model = getModelInfo(modelArg);
  if (!model) {
    const knownAliases = MODEL_CATALOG.map((entry) => entry.alias).join(", ");
    throw new Error(`Unknown model alias '${modelArg}'. Known aliases: ${knownAliases}`);
  }

  return path.join(modelsDir, model.fileName);
}

export async function listInstalledModels(
  modelsDir: string,
): Promise<Array<ModelInfo & { filePath: string; bytes: number }>> {
  const entries: string[] = await readdir(modelsDir).catch(() => []);
  const installed: Array<ModelInfo & { filePath: string; bytes: number }> = [];

  for (const model of MODEL_CATALOG) {
    if (!entries.includes(model.fileName)) continue;

    const filePath = path.join(modelsDir, model.fileName);
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) continue;

    installed.push({
      ...model,
      filePath,
      bytes: info.size,
    });
  }

  return installed;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function sha1Hex(filePath: string): Promise<string> {
  const hash = createHash("sha1");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }

  return hash.digest("hex");
}

export function humanBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export async function downloadModel(
  model: ModelInfo,
  modelsDir: string,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<string> {
  await ensureModelsDir(modelsDir);

  const finalPath = path.join(modelsDir, model.fileName);
  if (await fileExists(finalPath)) {
    const existingSha1 = await sha1Hex(finalPath);
    if (existingSha1 === model.sha1) {
      return finalPath;
    }

    throw new Error(
      `Existing file at ${finalPath} does not match expected SHA-1 for ${model.alias}. Remove it and retry.`,
    );
  }

  const tmpPath = `${finalPath}.part`;
  const url = `${MODEL_REPO_BASE_URL}/${model.fileName}`;
  const response = await fetch(url);

  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download ${model.alias} from ${url}: ${response.status} ${response.statusText}`,
    );
  }

  const totalBytesHeader = response.headers.get("content-length");
  const totalBytes = totalBytesHeader ? Number(totalBytesHeader) : null;
  const input = Readable.fromWeb(response.body as any);
  const output = createWriteStream(tmpPath);
  let downloadedBytes = 0;

  try {
    for await (const chunk of input) {
      downloadedBytes += chunk.length;
      onProgress?.({ downloadedBytes, totalBytes });

      if (!output.write(chunk)) {
        await once(output, "drain");
      }
    }

    await new Promise<void>((resolve, reject) => {
      output.end(() => resolve());
      output.once("error", reject);
    });
  } catch (error) {
    output.destroy();
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }

  const downloadedSha1 = await sha1Hex(tmpPath);
  if (downloadedSha1 !== model.sha1) {
    await unlink(tmpPath).catch(() => undefined);
    throw new Error(
      `SHA-1 mismatch for ${model.alias}: expected ${model.sha1}, got ${downloadedSha1}`,
    );
  }

  await rename(tmpPath, finalPath);
  return finalPath;
}
