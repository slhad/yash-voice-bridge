import { createConnection } from "node:net";
import { homedir } from "node:os";
import path from "node:path";

type IpcRequest =
  | { type: "list_actions"; details?: boolean }
  | { type: "describe_action"; action: string }
  | { type: "invoke_action"; action: string; args?: Record<string, unknown> }
  | { type: "command"; command: string };

type IpcResponse =
  | {
      ok: true;
      result: {
        action: string;
        output?: string[];
        data?: Record<string, unknown>;
        warnings?: string[];
      };
    }
  | {
      ok: false;
      error: { code: string; message: string; details?: Record<string, unknown> };
    };

export function resolveYashSocketPath(override?: string): string {
  if (override) return override;
  const dataDir = process.env.YASH_DATA_DIR ?? path.join(homedir(), ".yash");
  return path.join(dataDir, "yash.sock");
}

export async function sendIpcRequest(
  socketPath: string,
  request: IpcRequest,
): Promise<IpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath, () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });

    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) return;
      try {
        resolve(JSON.parse(buffer.slice(0, newlineIdx)) as IpcResponse);
      } catch {
        reject(new Error("Invalid JSON response from YASH"));
      }
      socket.destroy();
    });

    socket.on("error", reject);
  });
}

export async function sendVoiceTranscript(socketPath: string, text: string): Promise<IpcResponse> {
  return sendIpcRequest(socketPath, { type: "command", command: text });
}
