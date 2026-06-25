import { Env, AiModel } from "./types";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  content: string;
  model_id: string;
}

export async function callLLM(env: Env, messages: LLMMessage[], modelId?: string): Promise<LLMResponse> {
  let model: AiModel | null = null;

  if (modelId) {
    model = await env.DB.prepare(
      "SELECT * FROM ai_models WHERE model_id = ? LIMIT 1"
    ).bind(modelId).first<AiModel>();
  }

  if (!model) {
    model = await env.DB.prepare(
      "SELECT * FROM ai_models WHERE is_default = 1 LIMIT 1"
    ).first<AiModel>();
  }

  if (!model) {
    model = await env.DB.prepare(
      "SELECT * FROM ai_models LIMIT 1"
    ).first<AiModel>();
  }

  if (!model) throw new Error("No model configured. Add one in /providers.html");

  const apiKey = model.api_key;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const url = `${model.base_url}${model.endpoint}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers,
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
  return { content: data.choices[0].message.content, model_id: model.model_id };
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
