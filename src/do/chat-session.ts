import { DurableObject } from "cloudflare:workers";
import { Env, AiModel, LLMMessage } from "../lib/types";

interface StreamingState {
  convId: string;
  nodeIdx: Uint8Array;
  modelId: string;
  content: string;
  status: "streaming" | "complete" | "error" | "interrupted";
  lastSaved: number;
}

export class ChatSessionDO extends DurableObject<Env> {
  private subscribers: Map<string, WritableStreamDefaultWriter> = new Map();

  /**
   * Main entry point for SSE streaming.
   * Returns SSE Response that streams AI output.
   */
  async chat(
    messages: LLMMessage[],
    modelId: string | undefined,
    convId: string,
    nodeIdx: Uint8Array,
    userMessage: { user_content: string; prefix_idx: Uint8Array; title: string; user_id: number | null }
  ): Promise<Response> {
    const streamId = crypto.randomUUID();
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // Register subscriber
    this.subscribers.set(streamId, writer);
    writer.closed.then(() => this.subscribers.delete(streamId)).catch(() => this.subscribers.delete(streamId));

    // Check if we already have content for this node
    const existing = await this.getExistingContent(convId, nodeIdx);

    // Check for active stream via DO storage
    const activeStreamKey = `stream:${convId}:${Array.from(nodeIdx).join(",")}`;
    const activeStreamMeta = await this.ctx.storage.get<{
      streamId: string;
      startedAt: number;
    }>(activeStreamKey);

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

      // Check for stale stream (streaming > 5 minutes)
      if (existing.status === "streaming") {
        const meta = JSON.parse(existing.rawMeta || "{}");
        const streamingStartedAt = meta.streaming_started_at;
        if (streamingStartedAt && Date.now() - streamingStartedAt > 5 * 60 * 1000) {
          // Stream is stale - mark as interrupted and start fresh
          await this.persistProgress(existing.content, existing.modelId, convId, nodeIdx, "interrupted");
        } else if (activeStreamMeta && Date.now() - activeStreamMeta.startedAt < 5 * 60 * 1000) {
          // Active stream exists and is fresh - subscribe to it
          if (existing.content) {
            // Replay what we have so far
            await writer.write(encoder.encode(`data: ${JSON.stringify({ replay: existing.content })}\n\n`));
          }
          // Wait for the stream to complete
          return new Response(readable, {
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
          });
        }
      }
    }

    // Insert user message if this is a new conversation node
    if (!existing) {
      const ts = Math.floor(Date.now() / 1000);
      await this.env.DB.prepare(
        `INSERT INTO chat_nodes (conv_id, idx, prefix_idx, user_content, assistant_content, meta, created_at)
         VALUES (?, ?, ?, ?, '', ?, ?)`
      ).bind(
        convId,
        nodeIdx,
        userMessage.prefix_idx,
        userMessage.user_content,
        JSON.stringify({
          title: userMessage.title,
          user_id: userMessage.user_id,
          status: "streaming",
          streaming_started_at: Date.now(),
        }),
        ts
      ).run();
    }

    // Get model
    const model = await this.getModel(modelId);
    if (!model) {
      await writer.write(encoder.encode(`data: ${JSON.stringify({ error: "No model configured" })}\n\n`));
      await writer.write(encoder.encode("data: [DONE]\n\n"));
      await writer.close();
      return new Response(readable, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
      });
    }

    // Mark stream as active in DO storage
    await this.ctx.storage.put(activeStreamKey, {
      streamId,
      startedAt: Date.now(),
    });

    // Use ctx.waitUntil to run streaming in background (no blockConcurrencyWhile)
    this.ctx.waitUntil(
      this.streamAI(messages, model, convId, nodeIdx, streamId, activeStreamKey).finally(() => {
        // Clean up active stream marker
        this.ctx.storage.delete(activeStreamKey);
      })
    );

    return new Response(readable, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
    });
  }

  /**
   * Get existing content from D1 for this node.
   */
  private async getExistingContent(convId: string, nodeIdx: Uint8Array): Promise<{
    content: string;
    modelId: string;
    status: string;
    rawMeta: string;
  } | null> {
    const row = await this.env.DB.prepare(
      `SELECT assistant_content, meta FROM chat_nodes WHERE conv_id = ? AND idx = ?`
    ).bind(convId, nodeIdx).first<{ assistant_content: string; meta: string }>();

    if (!row) return null;

    const meta = JSON.parse(row.meta || "{}");
    return {
      content: row.assistant_content,
      modelId: meta.model_id || "",
      status: meta.status || "complete",
      rawMeta: row.meta || "{}",
    };
  }

  /**
   * Broadcast data to all connected subscribers.
   */
  private async broadcast(data: string) {
    const encoder = new TextEncoder();
    const deadStreams: string[] = [];

    for (const [id, writer] of this.subscribers) {
      try {
        await writer.write(encoder.encode(data));
      } catch {
        deadStreams.push(id);
      }
    }

    for (const id of deadStreams) {
      this.subscribers.delete(id);
    }
  }

  /**
   * Stream AI response, persisting incrementally.
   * Uses ctx.waitUntil, so it won't block other DO operations.
   */
  private async streamAI(
    messages: LLMMessage[],
    model: AiModel,
    convId: string,
    nodeIdx: Uint8Array,
    streamId: string,
    activeStreamKey: string
  ) {
    const modelId = model.model_id;
    const TIMEOUT_MS = 5 * 60 * 1000; // 5 minute timeout

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (model.api_key) headers["Authorization"] = `Bearer ${model.api_key}`;

      const url = `${model.base_url}${model.endpoint}/chat/completions`;
      
      // Use AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: model.model_id, messages, stream: true }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        const error = await response.text();
        await this.broadcast(`data: ${JSON.stringify({ error })}\n\n`);
        // Store error message in D1
        await this.persistProgress("", modelId, convId, nodeIdx, "error", error);
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
      // Save error message in D1 with status "error"
      await this.persistProgress("", modelId, convId, nodeIdx, "error", error.message);
    } finally {
      // Clean up: close all subscriber writers to release resources
      for (const [id, writer] of this.subscribers) {
        try {
          await writer.close();
        } catch {}
      }
      this.subscribers.clear();
    }
  }

  /**
   * Persist streaming progress to D1.
   * Only UPDATE, never INSERT - user message must already exist.
   */
  private async persistProgress(
    content: string,
    modelId: string,
    convId: string,
    nodeIdx: Uint8Array,
    status: string,
    errorMessage?: string
  ) {
    const meta: Record<string, any> = { model_id: modelId, status };

    // Add streaming_started_at when starting
    if (status === "streaming") {
      meta.streaming_started_at = Date.now();
    }

    // Store error message if present
    if (errorMessage) {
      meta.error = errorMessage;
    }

    const result = await this.env.DB.prepare(
      `UPDATE chat_nodes 
       SET assistant_content = ?, meta = ?
       WHERE conv_id = ? AND idx = ?`
    ).bind(
      content,
      JSON.stringify(meta),
      convId,
      nodeIdx
    ).run();

    // If UPDATE fails (0 rows), log error but don't create ghost records
    if (result.meta?.changes === 0) {
      console.error(`persistProgress: No row found for conv_id=${convId}, idx=${nodeIdx}. Status=${status}`);
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