export interface Env {
  DB: D1Database;
  CHAT_SESSION_DO: DurableObjectNamespace;
}

export interface User {
  id: number;
  email: string;
  display_name: string | null;
  providers_config: string;
  sessions: string;
  settings: string;
  meta: string;
  created_at: number;
}

export interface Passkey {
  id: string;
  user_id: number;
  public_key: ArrayBuffer;
  counter: number;
  transports: string;
  device_name: string | null;
  meta: string;
  created_at: number;
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
  created_at: number;
  updated_at: number;
}

export interface ProviderGroup {
  provider_name: string;
  base_url: string;
  endpoint: string;
  api_format: string;
  models: AiModel[];
}

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatNode {
  conv_id: string;
  idx: string;
  title: string;
  prefix_idx: string;
  scatter_from: string | null;
  gather_from: string | null;
  user_id: number | null;
  user_content: string;
  user_meta: string;
  assistant_content: string;
  assistant_meta: string;
  meta: string;
  created_at: number;
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
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

export function prefixIdxToHexes(blob: string): string[] {
  const hexes: string[] = [];
  for (let i = 0; i < blob.length; i += 4) {
    hexes.push(blob.substring(i, i + 4));
  }
  return hexes;
}

export function hexToPrefixBlob(hexes: string[]): string {
  return hexes.join("");
}

export function prefixDepth(blob: string): number {
  return blob.length / 4;
}

export function randomToken(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

export function packSessionCookie(userId: number, token: Uint8Array): string {
  const buf = new Uint8Array(4 + 16);
  buf[0] = (userId >>> 24) & 0xff;
  buf[1] = (userId >>> 16) & 0xff;
  buf[2] = (userId >>> 8) & 0xff;
  buf[3] = userId & 0xff;
  buf.set(token, 4);
  return btoa(String.fromCharCode(...buf));
}

export function unpackSessionCookie(cookie: string): { userId: number; tokenHex: string } | null {
  try {
    const raw = atob(cookie);
    if (raw.length !== 20) return null;
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const userId = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
    const tokenHex = blobToHex(bytes.slice(4));
    return { userId, tokenHex };
  } catch {
    return null;
  }
}
