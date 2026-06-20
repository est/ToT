export interface Env {
  DB: D1Database;
}

export interface AiModel {
  id: string;
  provider_name: string;
  base_url: string;
  endpoint: string;
  api_format: string;
  api_key: string | null;
  model_id: string;
  display_name: string | null;
  is_default: number;
  meta: string;
  created_at: string;
  updated_at: string;
}

export interface ProviderGroup {
  provider_name: string;
  base_url: string;
  endpoint: string;
  api_format: string;
  models: AiModel[];
}

export interface ChatConversation {
  id: string;
  title: string;
  focus_id: string | null;
  meta: string;
  created_at: string;
  updated_at: string;
}

export interface ChatNode {
  conversation_id: string;
  id: string;
  parents: string;
  user_content: string;
  user_meta: string;
  assistant_content: string;
  assistant_meta: string;
  meta: string;
  created_at: string;
}

export function now(): string {
  return new Date().toISOString();
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function blobToHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export function intTo2Bytes(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

export function bytesToInt(bytes: Uint8Array): number {
  return (bytes[0] << 8) | bytes[1];
}
