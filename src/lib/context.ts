import { Env, ChatNode, blobToHex, hexToBytes, bytesToInt, intTo2Bytes } from "./types";

interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export async function getNextId(env: Env, conversationId: string): Promise<{ bytes: Uint8Array; hex: string }> {
  const row = await env.DB.prepare(
    "SELECT id FROM chat_nodes WHERE conversation_id = ? ORDER BY id DESC LIMIT 1"
  ).bind(conversationId).first<{ id: ArrayBuffer }>();

  let next = 1;
  if (row?.id) {
    const arr = new Uint8Array(row.id);
    next = bytesToInt(arr) + 1;
  }

  const bytes = intTo2Bytes(next);
  return { bytes, hex: blobToHex(bytes) };
}

export async function buildContext(env: Env, conversationId: string, nodeParents: string, selfHex: string): Promise<LLMMessage[]> {
  const pathHexes = nodeParents ? nodeParents.split(".") : [];
  pathHexes.push(selfHex);

  const messages: { role: "user" | "assistant"; content: string }[] = [];

  for (const hex of pathHexes) {
    const idBytes = hexToBytes(hex);
    const node = await env.DB.prepare(
      "SELECT * FROM chat_nodes WHERE conversation_id = ? AND id = ?"
    ).bind(conversationId, idBytes).first<ChatNode>();

    if (node) {
      messages.push({ role: "user", content: node.user_content });
      if (node.assistant_content) {
        messages.push({ role: "assistant", content: node.assistant_content });
      }
    }
  }

  return messages;
}

export function formatNodeId(hex: string): string {
  return hex;
}

export function parseHeadings(markdown: string): string[] {
  const headings: string[] = [];
  const lines = markdown.split("\n");
  for (const line of lines) {
    const match = line.match(/^##\s+(.+)/);
    if (match) {
      headings.push(match[1].trim());
    }
  }
  return headings;
}
