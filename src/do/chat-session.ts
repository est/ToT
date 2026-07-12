import { DurableObject } from "cloudflare:workers";
import { Env, AiModel, LLMMessage } from "../lib/types";

interface StreamingState {
  convId: string;
  nodeIdx: Uint8Array;
  modelId: string;
  content: string;
  status: "streaming" | "complete" | "error";
  lastSaved: number;
}

export class ChatSessionDO extends DurableObject<Env> {
  private subscribers: Map<string, WritableStreamDefaultWriter> = new Map();
  private activeStream: StreamingState | null = null;

  /**
   * Main entry point for SSE streaming.
   * Returns SSE Response that streams AI output.
   */
  async chat(messages: LLMMessage[], modelId: string | undefined, convId: string, nodeIdx: Uint8Array): Promise<Response> {
    const streamId = crypto.randomUUID();
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // Register subscriber
    this.subscribers.set(streamId, writer);
    writer.closed.then(() => this.subscribers.delete(streamId)).catch(() => this.subscribers.delete(streamId));

    // Check if we already have content for this node
    const existing = await this.getExistingContent(convId, nodeIdx);
    if (existing) {
      if (existing.status === "complete") {
        // Already done - replay full content and close
        await writer.write(encoder.encode(`data: ${JSON.stringify({ content: existing.content })}\n\n`));
        await writer.write(encoder.encode("data: [DONE]\n\n"));
        await writer.close();
        return new Response(readable, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
        });
      }

      if (existing.status === "streaming" && existing.content) {
        // Partial content exists - replay what we have so far
        await writer.write(encoder.encode(`data: ${JSON.stringify({ replay: existing.content })}\n\n`));
        // Continue streaming from where we left off (handled by streamAI checking state)
      }
    }

    // Start streaming in background
    const model = await this.getModel(modelId);
    if (!model) {
      await writer.write(encoder.encode(`data: ${JSON.stringify({ error: "No model configured" })}\n\n`));
      await writer.close();
      return new Response(readable, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
      });
    }

    // Use blockConcurrencyWhile to ensure streamAI keeps running
    this.ctx.blockConcurrencyWhile(async () => {
      await this.streamAI(messages, model, convId, nodeIdx);
    });

    return new Response(readable, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
    });
  }

  /**
   * Get existing content from D1 for this node.
   */
  private async getExistingContent(convId: string, nodeIdx: Uint8Array): Promise<{ content: string; status: string } | null> {
    const row = await this.env.DB.prepare(
      `SELECT assistant_content, meta FROM chat_nodes WHERE conv_id = ? AND idx = ?`
    ).bind(convId, nodeIdx).first<{ assistant_content: string; meta: string }>();

    if (!row) return null;

    const meta = JSON.parse(row.meta || "{}");
    return {
      content: row.assistant_content,
      status: meta.status || "complete",
    };
  }

  /**
   * Broadcast data to all connected subscribers.
   */
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

  /**
   * Stream AI response, persisting incrementally.
   * This runs inside blockConcurrencyWhile, so it won't be interrupted.
   */
  private async streamAI(messages: LLMMessage[], model: AiModel, convId: string, nodeIdx: Uint8Array) {
    const modelId = model.model_id;

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (model.api_key) headers["Authorization"] = `Bearer ${model.api_key}`;

      const url = `${model.base_url}${model.endpoint}/chat/completions`;
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: model.model_id, messages, stream: true }),
      });

      if (!response.ok) {
        const error = await response.text();
        await this.broadcast(`data: ${JSON.stringify({ error })}\n\n`);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) return;

      // Initialize or resume state
      const existing = await this.getExistingContent(convId, nodeIdx);
      let fullContent = existing?.content || "";
      let buffer = "";
      let done = false;
      const decoder = new TextDecoder();
      let lastSaveTime = Date.now();
      const SAVE_INTERVAL = 2000; // Save every 2 seconds

      // Mark as streaming
      await this.persistProgress(fullContent, modelId, convId, nodeIdx, "streaming");

      while (!done) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            done = true;
            break;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content || "";
            if (content) {
              fullContent += content;
              await this.broadcast(`data: ${JSON.stringify({ content })}\n\n`);

              // Incremental save
              const now = Date.now();
              if (now - lastSaveTime > SAVE_INTERVAL) {
                await this.persistProgress(fullContent, modelId, convId, nodeIdx, "streaming");
                lastSaveTime = now;
              }
            }
          } catch {}
        }
      }

      // Process remaining buffer
      if (buffer.trim().startsWith("data: ")) {
        const data = buffer.trim().slice(6);
        if (data !== "[DONE]") {
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content || "";
            if (content) {
              fullContent += content;
              await this.broadcast(`data: ${JSON.stringify({ content })}\n\n`);
            }
          } catch {}
        }
      }

      // Final save - mark as complete
      await this.persistProgress(fullContent, modelId, convId, nodeIdx, "complete");
      await this.broadcast("data: [DONE]\n\n");

    } catch (error: any) {
      await this.broadcast(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      // Save error state
      await this.persistProgress("", modelId, convId, nodeIdx, "error");
    }
  }

  /**
   * Persist streaming progress to D1.
   */
  private async persistProgress(content: string, modelId: string, convId: string, nodeIdx: Uint8Array, status: string) {
    const result = await this.env.DB.prepare(
      `UPDATE chat_nodes 
       SET assistant_content = ?, meta = ?
       WHERE conv_id = ? AND idx = ?`
    ).bind(
      content,
      JSON.stringify({ model_id: modelId, status }),
      convId,
      nodeIdx
    ).run();

    // If row doesn't exist yet, insert it
    if (result.meta?.changes === 0) {
      const ts = Math.floor(Date.now() / 1000);
      await this.env.DB.prepare(
        `INSERT INTO chat_nodes (conv_id, idx, prefix_idx, user_content, assistant_content, meta, created_at)
         VALUES (?, ?, X'', '', ?, ?, ?)`
      ).bind(
        convId,
        nodeIdx,
        content,
        JSON.stringify({ model_id: modelId, status }),
        ts
      ).run();
    }
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
    return Promise.all(
      tasks.map(async (task) => {
        const model = await this.getModel(task.modelId);
        if (!model) throw new Error("No model configured");
        return this.callAI(task.messages, model);
      })
    );
  }

  private async callAI(messages: LLMMessage[], model: AiModel): Promise<string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (model.api_key) headers["Authorization"] = `Bearer ${model.api_key}`;

    const response = await fetch(`${model.base_url}${model.endpoint}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: model.model_id, messages, stream: false }),
    });

    if (!response.ok) throw new Error(`AI error: ${response.status}`);
    const data = await response.json<any>();
    return data.choices[0].message.content;
  }
}
