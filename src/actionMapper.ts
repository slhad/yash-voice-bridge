import { sendIpcRequest } from "./ipc";

type ArgSchema = {
  type: "string" | "boolean" | "number" | "enum";
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  values?: string[];
};

type ActionDefinition = {
  id: string;
  title: string;
  description: string;
  domain: string;
  ipcEnabled: boolean;
  readOnly: boolean;
  safety: "safe" | "confirm" | "dangerous" | "blocked";
  voiceHint?: boolean;
  args: Record<string, ArgSchema>;
  examples?: Array<{ args: Record<string, unknown>; description?: string }>;
};

export type MappedAction =
  | { matched: true; action: string; args: Record<string, unknown> }
  | { matched: false };

export type ActionMapperConfig = {
  socketPath: string;
  refreshIntervalMs: number;
};

export interface ActionMapper {
  map(transcript: string): Promise<MappedAction>;
  close(): void;
}

const MIN_SCORE = 2;
const STOP_WORDS = new Set([
  "a",
  "all",
  "an",
  "at",
  "do",
  "for",
  "from",
  "i",
  "in",
  "it",
  "let",
  "let's",
  "me",
  "my",
  "of",
  "on",
  "one",
  "or",
  "past",
  "please",
  "recent",
  "retrieve",
  "s",
  "send",
  "stream",
  "talk",
  "the",
  "to",
]);

function tokenizeText(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s']/gu, " ")
      .split(/\s+/)
      .filter(Boolean),
  );
}

function scoreAction(action: ActionDefinition, transcriptTokens: Set<string>): number {
  const idTokens = action.id.split(".");
  const candidateText = [
    ...idTokens,
    action.title,
    ...(action.examples ?? []).map((e) => e.description ?? ""),
  ].join(" ");

  const candidateTokens = tokenizeText(candidateText);
  let score = 0;

  for (const token of transcriptTokens) {
    if (candidateTokens.has(token)) score += 1;
  }

  if (action.voiceHint) score *= 2;
  return score;
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeWithoutStopWords(text: string): Set<string> {
  return new Set([...tokenizeText(text)].filter((token) => !STOP_WORDS.has(token)));
}

function countEnumMatches(args: Record<string, unknown>, schema: Record<string, ArgSchema>): number {
  let count = 0;
  for (const [key, argSchema] of Object.entries(schema)) {
    if (argSchema.type === "enum" && args[key] !== undefined) count += 1;
  }
  return count;
}

function countMatchedTokens(candidateTokens: Set<string>, transcriptTokens: Set<string>): number {
  let count = 0;
  for (const token of transcriptTokens) {
    if (candidateTokens.has(token)) count += 1;
  }
  return count;
}

function hasExactPhraseMatch(transcript: string, action: ActionDefinition): boolean {
  const normalizedTranscript = normalizeText(transcript);
  const phrases = [
    action.title,
    action.id.replace(".", " "),
    ...(action.examples ?? []).map((example) => example.description ?? ""),
  ]
    .map(normalizeText)
    .filter(Boolean);

  return phrases.some((phrase) => normalizedTranscript.includes(phrase));
}

type RankedCandidate = {
  action: ActionDefinition;
  args: Record<string, unknown>;
  score: number;
  matchedTokenCount: number;
  enumMatchCount: number;
  exactPhraseMatch: boolean;
};

function extractArgs(transcript: string, action: ActionDefinition): Record<string, unknown> {
  const tokens = tokenizeText(transcript);
  const args: Record<string, unknown> = {};
  let remaining = transcript.trim();

  for (const [key, schema] of Object.entries(action.args)) {
    if (schema.type !== "enum" || !schema.values) continue;
    for (const val of schema.values) {
      if (tokens.has(val.toLowerCase())) {
        args[key] = val;
        remaining = remaining.replace(new RegExp(`\\b${val}\\b`, "gi"), "").trim();
        break;
      }
    }
  }

  for (const [key, schema] of Object.entries(action.args)) {
    if (schema.type !== "string" || key in args) continue;
    const text = remaining.replace(/\s+/g, " ").trim();
    if (text) {
      args[key] = text;
      remaining = "";
    }
  }

  return args;
}

function validateArgs(args: Record<string, unknown>, schema: Record<string, ArgSchema>): boolean {
  for (const [key, argSchema] of Object.entries(schema)) {
    const value = args[key];

    if (argSchema.required && (value === undefined || value === null)) return false;
    if (value === undefined || value === null) continue;

    if (argSchema.type === "enum" && argSchema.values) {
      if (!argSchema.values.includes(String(value))) return false;
    }

    if (argSchema.type === "string" && typeof value === "string") {
      if (argSchema.maxLength !== undefined && value.length > argSchema.maxLength) return false;
      if (argSchema.minLength !== undefined && value.length < argSchema.minLength) return false;
    }
  }

  return true;
}

export async function createActionMapper(config: ActionMapperConfig): Promise<ActionMapper> {
  let actions: ActionDefinition[] = [];
  let inactive = false;

  async function fetchActions(): Promise<void> {
    try {
      const response = await sendIpcRequest(config.socketPath, {
        type: "list_actions",
        details: true,
      });

      if (!response.ok) {
        console.error(`[actions] list_actions failed: ${response.error.message}`);
        return;
      }

      const data = response.result.data as { actions?: ActionDefinition[] } | undefined;
      actions = (data?.actions ?? []).filter((a) => a.ipcEnabled && a.safety === "safe");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ECONNREFUSED") {
        console.error("[actions] YASH not reachable, action mapper inactive");
        inactive = true;
      } else {
        console.error("[actions] failed to fetch actions:", err);
      }
    }
  }

  await fetchActions();

  const refreshTimer = setInterval(() => {
    void fetchActions();
  }, config.refreshIntervalMs);

  function map(transcript: string): Promise<MappedAction> {
    if (inactive || actions.length === 0) return Promise.resolve({ matched: false });

    const transcriptTokens = tokenizeText(transcript);
    const transcriptMeaningfulTokens = tokenizeWithoutStopWords(transcript);
    const scored = actions
      .map((action): RankedCandidate => {
        const args = extractArgs(transcript, action);
        const candidateText = [
          action.id.replace(".", " "),
          action.title,
          action.description,
          ...(action.examples ?? []).map((example) => example.description ?? ""),
        ].join(" ");
        const candidateTokens = tokenizeWithoutStopWords(candidateText);

        return {
          action,
          args,
          score: scoreAction(action, transcriptTokens),
          matchedTokenCount: countMatchedTokens(candidateTokens, transcriptMeaningfulTokens),
          enumMatchCount: countEnumMatches(args, action.args),
          exactPhraseMatch: hasExactPhraseMatch(transcript, action),
        };
      })
      .filter(({ score }) => score >= MIN_SCORE)
      .sort((a, b) => {
        if (b.enumMatchCount !== a.enumMatchCount) return b.enumMatchCount - a.enumMatchCount;
        if (b.exactPhraseMatch !== a.exactPhraseMatch) return Number(b.exactPhraseMatch) - Number(a.exactPhraseMatch);
        if (b.matchedTokenCount !== a.matchedTokenCount) return b.matchedTokenCount - a.matchedTokenCount;
        return b.score - a.score;
      });

    if (scored.length === 0) return Promise.resolve({ matched: false });

    const best = scored[0];

    if (!validateArgs(best.args, best.action.args)) return Promise.resolve({ matched: false });

    return Promise.resolve({ matched: true, action: best.action.id, args: best.args });
  }

  function close(): void {
    clearInterval(refreshTimer);
  }

  return { map, close };
}
