import { Env, AiModel } from "./types";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  content: string;
}

export async function callLLM(env: Env, messages: LLMMessage[]): Promise<LLMResponse> {
  const model = await env.DB.prepare(
    "SELECT * FROM ai_models WHERE is_default = 1 LIMIT 1"
  ).first<AiModel>();

  if (!model) throw new Error("No default model configured. Add one in /providers.html");

  const apiKey = model.api_key || env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("No API key configured");

  const url = `${model.base_url}${model.endpoint}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model.model_id,
      messages,
      stream: false,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as any;
  return { content: data.choices[0].message.content };
}

export function buildSystemPrompt(): string {
  return `You are a helpful assistant. You respond in well-structured Markdown.

Rules:
- Use ## headings to organize your response into distinct sections/topics
- Each ## section should be self-contained and could be discussed independently
- Keep responses focused and concise
- If the user's question is simple, a single section is fine
- Do NOT use # (h1) headings, start from ## (h2)`;
}
