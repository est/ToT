import { DurableObject } from "cloudflare:workers";
import { Env, AiModel, LLMMessage } from "../lib/types";

export class ChatSessionDO extends DurableObject<Env> {
  private subscribers: Map<string, WritableStreamDefaultWriter> = new Map();

  async chat(messages: LLMMessage[], modelId: string | undefined, convId: string, nodeIdx: Uint8Array): Promise<Response> {
    const model = await this.getModel(modelId);
    if (!model) {
      return new Response("No model configured", { status: 500 });
    }

    const streamId = crypto.randomUUID();
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    this.subscribers.set(streamId, writer);

    writer.closed.then(() => {
      this.subscribers.delete(streamId);
    }).catch(() => {
      this.subscribers.delete(streamId);
    });

    this.ctx.waitUntil(this.streamAI(messages, model, encoder, convId, nodeIdx));

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Stream-Id": streamId,
      },
    });
  }

  private async broadcast(data: string) {
    const encoder = new TextEncoder();
    const deadStreams: string[] = [];

    for (const [streamId, writer] of this.subscribers) {
      try {
        await writer.write(encoder.encode(data));
      } catch {
        deadStreams.push(streamId);
      }
    }

    for (const streamId of deadStreams) {
      this.subscribers.delete(streamId);
    }
  }

  private async streamAI(messages: LLMMessage[], model: AiModel, encoder: TextEncoder, convId: string, nodeIdx: Uint8Array) {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (model.api_key) {
        headers["Authorization"] = `Bearer ${model.api_key}`;
      }

      const url = `${model.base_url}${model.endpoint}/chat/completions`;
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: model.model_id,
          messages,
          stream: true,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        await this.broadcast(`data: ${JSON.stringify({ error })}\n\n`);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) return;

      let fullContent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = new TextDecoder().decode(value);
        const lines = chunk.split("\n").filter((l) => l.startsWith("data: "));

        for (const line of lines) {
          const data = line.slice(6);
          if (data === "[DONE]") {
            await this.broadcast("data: [DONE]\n\n");
            break;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content || "";
            if (content) {
              fullContent += content;
              await this.broadcast(
                `data: ${JSON.stringify({ content })}\n\n`
              );
            }
          } catch {}
        }
      }

      this.ctx.waitUntil(this.persistResult(fullContent, model.model_id, convId, nodeIdx));
    } catch (error: any) {
      await this.broadcast(
        `data: ${JSON.stringify({ error: error.message })}\n\n`
      );
    }
  }

  private async persistResult(content: string, modelId: string, convId: string, nodeIdx: Uint8Array) {
    await this.env.DB.prepare(
      `UPDATE chat_nodes 
       SET assistant_content = ?, meta = ?
       WHERE conv_id = ? AND idx = ?`
    ).bind(
      content,
      JSON.stringify({ model_id: modelId, status: "complete" }),
      convId,
      nodeIdx
    ).run();
  }

  private async getModel(modelId?: string): Promise<AiModel | null> {
    if (modelId) {
      return await this.env.DB.prepare(
        "SELECT * FROM ai_models WHERE model_id = ? LIMIT 1"
      ).bind(modelId).first<AiModel>();
    }
    return await this.env.DB.prepare(
      "SELECT * FROM ai_models WHERE is_default = 1 LIMIT 1"
    ).first<AiModel>();
  }

  async chainCalls(steps: Array<{ messages: LLMMessage[]; modelId?: string }>): Promise<string> {
    let context = "";
    for (const step of steps) {
      const model = await this.getModel(step.modelId);
      if (!model) throw new Error("No model configured");

      const result = await this.callAI([...step.messages, { role: "user", content: context }], model);
      context = result;
    }
    return context;
  }

  async parallelCalls(tasks: Array<{ messages: LLMMessage[]; modelId?: string }>): Promise<string[]> {
    const results = await Promise.all(
      tasks.map(async (task) => {
        const model = await this.getModel(task.modelId);
        if (!model) throw new Error("No model configured");
        return this.callAI(task.messages, model);
      })
    );
    return results;
  }

  private async callAI(messages: LLMMessage[], model: AiModel): Promise<string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (model.api_key) {
      headers["Authorization"] = `Bearer ${model.api_key}`;
    }

    const response = await fetch(`${model.base_url}${model.endpoint}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: model.model_id, messages, stream: false }),
    });

    if (!response.ok) {
      throw new Error(`AI error: ${response.status}`);
    }

    const data = await response.json<any>();
    return data.choices[0].message.content;
  }
}