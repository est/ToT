import { Hono } from "hono";
import { Env, User, ChatNode, now, uuid, blobToHex, hexToBytes } from "../lib/types";
import { callLLM, buildSystemPrompt } from "../lib/llm";
import { getNextIdx, buildContext, parseHeadings } from "../lib/context";

export function createChatRoutes() {
  const api = new Hono<{ Bindings: Env; Variables: { user?: User } }>();

  api.post("/conversation", async (c) => {
    const user = c.get("user");
    const body = await c.req.json<{ data?: { message: string; model_id?: string } }>();
    const msg = body.data?.message;
    if (!msg) return c.json({ data: null, em: "message required" });

    const convId = uuid();
    const { bytes: idxBytes, hex: idxHex } = await getNextIdx(c.env, convId);
    const ts = now();

    const llmMessages = [
      { role: "system" as const, content: buildSystemPrompt() },
      { role: "user" as const, content: msg },
    ];

    let assistantContent = "";
    let usedModel = body.data?.model_id || "";
    try {
      const result = await callLLM(c.env, llmMessages, body.data?.model_id);
      assistantContent = result.content;
      usedModel = result.model_id;
    } catch (err: any) {
      assistantContent = `Error: ${err.message}`;
    }

    const headings = parseHeadings(assistantContent);
    const title = msg.slice(0, 50);

    await c.env.DB.prepare(
      `INSERT INTO chat_nodes (conv_id, idx, title, prefix_idx, user_id, user_content, assistant_content, meta, created_at)
       VALUES (?, ?, ?, X'', ?, ?, ?, ?, ?)`
    ).bind(convId, idxBytes, title, user?.id ?? null, msg, assistantContent, JSON.stringify({ model_id: usedModel }), ts).run();

    return c.json({ data: { conv_id: convId, idx: idxHex, title, user_content: msg, assistant_content: assistantContent, headings, model_id: usedModel }, em: "" });
  });

  api.get("/list", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ data: [], em: "" });

    const rows = await c.env.DB.prepare(
      `SELECT conv_id, hex(idx) as idx, title, user_content, created_at
       FROM chat_nodes
       WHERE prefix_idx = X'' AND user_id = ?
       ORDER BY created_at DESC`
    ).bind(user.id).all();

    return c.json({ data: rows.results, em: "" });
  });

  api.get("/tree", async (c) => {
    const convId = c.req.query("conv_id");
    if (!convId) return c.json({ data: null, em: "conv_id required" });

    const nodes = await c.env.DB.prepare(
      `SELECT conv_id, hex(idx) as idx, title, hex(prefix_idx) as prefix_idx,
              hex(scatter_from) as scatter_from, hex(gather_from) as gather_from,
              user_id, user_content, assistant_content, meta, created_at
       FROM chat_nodes WHERE conv_id = ? ORDER BY idx`
    ).bind(convId).all();

    return c.json({ data: nodes.results, em: "" });
  });

  api.post("/send", async (c) => {
    const user = c.get("user");
    const body = await c.req.json<{
      data: { conv_id: string; message: string; node_idx?: string; model_id?: string };
    }>();
    const d = body.data;
    if (!d.conv_id || !d.message) {
      return c.json({ data: null, em: "conv_id and message required" });
    }

    const { bytes: newIdxBytes, hex: newIdxHex } = await getNextIdx(c.env, d.conv_id);

    let prefixHex = "";
    let contextIdxHex = "";

    if (d.node_idx) {
      const targetNode = await c.env.DB.prepare(
        "SELECT hex(prefix_idx) as prefix_idx FROM chat_nodes WHERE conv_id = ? AND idx = ?"
      ).bind(d.conv_id, hexToBytes(d.node_idx)).first<{ prefix_idx: string }>();
      if (targetNode) {
        prefixHex = targetNode.prefix_idx ? `${targetNode.prefix_idx}${d.node_idx}` : d.node_idx;
        contextIdxHex = d.node_idx;
      }
    } else {
      const latest = await c.env.DB.prepare(
        "SELECT hex(idx) as idx, hex(prefix_idx) as prefix_idx FROM chat_nodes WHERE conv_id = ? ORDER BY idx DESC LIMIT 1"
      ).bind(d.conv_id).first<{ idx: string; prefix_idx: string }>();
      if (latest) {
        prefixHex = latest.prefix_idx ? `${latest.prefix_idx}${latest.idx}` : latest.idx;
        contextIdxHex = latest.idx;
      }
    }

    const contextMessages = contextIdxHex
      ? await buildContext(c.env, d.conv_id, prefixHex.length > 4 ? prefixHex.slice(0, -4) : "", contextIdxHex)
      : [];

    const llmMessages = [
      { role: "system" as const, content: buildSystemPrompt() },
      ...contextMessages.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "user" as const, content: d.message },
    ];

    const ts = now();
    let assistantContent = "";
    let usedModel = d.model_id || "";
    try {
      const result = await callLLM(c.env, llmMessages, d.model_id);
      assistantContent = result.content;
      usedModel = result.model_id;
    } catch (err: any) {
      assistantContent = `Error: ${err.message}`;
    }

    const headings = parseHeadings(assistantContent);

    await c.env.DB.prepare(
      `INSERT INTO chat_nodes (conv_id, idx, title, prefix_idx, user_id, user_content, assistant_content, meta, created_at)
       VALUES (?, ?, '', ?, ?, ?, ?, ?, ?)`
    ).bind(d.conv_id, newIdxBytes, hexToBytes(prefixHex), user?.id ?? null, d.message, assistantContent, JSON.stringify({ model_id: usedModel }), ts).run();

    return c.json({
      data: { idx: newIdxHex, prefix_idx: prefixHex, user_content: d.message, assistant_content: assistantContent, headings, model_id: usedModel },
      em: "",
    });
  });

  api.post("/branch", async (c) => {
    const user = c.get("user");
    const body = await c.req.json<{
      data: { conv_id: string; node_idx: string; heading: string; message: string; model_id?: string };
    }>();
    const d = body.data;
    if (!d.conv_id || !d.node_idx || !d.heading || !d.message) {
      return c.json({ data: null, em: "conv_id, node_idx, heading, message required" });
    }

    const { bytes: newIdxBytes, hex: newIdxHex } = await getNextIdx(c.env, d.conv_id);
    const parentNode = await c.env.DB.prepare(
      "SELECT hex(prefix_idx) as prefix_idx FROM chat_nodes WHERE conv_id = ? AND idx = ?"
    ).bind(d.conv_id, hexToBytes(d.node_idx)).first<{ prefix_idx: string }>();

    const newPrefix = parentNode?.prefix_idx
      ? `${parentNode.prefix_idx}${d.node_idx}`
      : d.node_idx;

    const contextMessages = await buildContext(c.env, d.conv_id, newPrefix.length > 4 ? newPrefix.slice(0, -4) : "", d.node_idx);

    const llmMessages = [
      { role: "system" as const, content: buildSystemPrompt() },
      ...contextMessages.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "user" as const, content: d.message },
    ];

    const ts = now();
    let assistantContent = "";
    let usedModel = d.model_id || "";
    try {
      const result = await callLLM(c.env, llmMessages, d.model_id);
      assistantContent = result.content;
      usedModel = result.model_id;
    } catch (err: any) {
      assistantContent = `Error: ${err.message}`;
    }

    const headings = parseHeadings(assistantContent);

    await c.env.DB.prepare(
      `INSERT INTO chat_nodes (conv_id, idx, title, prefix_idx, scatter_from, user_id, user_content, assistant_content, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(d.conv_id, newIdxBytes, `[Branch: ${d.heading}]`, hexToBytes(newPrefix), hexToBytes(d.node_idx), user?.id ?? null, d.message, assistantContent, JSON.stringify({ model_id: usedModel }), ts).run();

    return c.json({ data: { idx: newIdxHex, prefix_idx: newPrefix, user_content: d.message, assistant_content: assistantContent, headings, model_id: usedModel }, em: "" });
  });

  api.get("/models", async (c) => {
    const rows = await c.env.DB.prepare(
      "SELECT model_id, display_name, provider_name, is_default FROM ai_models ORDER BY provider_name, model_id"
    ).all();
    return c.json({ data: rows.results, em: "" });
  });

  return api;
}
