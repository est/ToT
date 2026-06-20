import { Hono } from "hono";
import { Env, now, uuid, blobToHex, hexToBytes } from "../lib/types";
import { callLLM, buildSystemPrompt } from "../lib/llm";
import { getNextId, buildContext, parseHeadings } from "../lib/context";

export function createChatRoutes() {
  const api = new Hono<{ Bindings: Env }>();

  api.post("/conversation", async (c) => {
    const body = await c.req.json<{ data?: { title?: string } }>();
    const id = uuid();
    const ts = now();
    const title = body.data?.title || "New Chat";
    await c.env.DB.prepare(
      "INSERT INTO chat_conversations (id, title, focus_id, meta, created_at, updated_at) VALUES (?, ?, NULL, '{}', ?, ?)"
    ).bind(id, title, ts, ts).run();
    return c.json({ data: { id, title }, em: "" });
  });

  api.get("/list", async (c) => {
    const rows = await c.env.DB.prepare(
      "SELECT * FROM chat_conversations ORDER BY updated_at DESC"
    ).all();
    return c.json({ data: rows.results, em: "" });
  });

  api.get("/tree", async (c) => {
    const convId = c.req.query("conversation_id");
    if (!convId) return c.json({ data: null, em: "conversation_id required" });

    const conv = await c.env.DB.prepare(
      "SELECT * FROM chat_conversations WHERE id = ?"
    ).bind(convId).first();

    const nodes = await c.env.DB.prepare(
      "SELECT conversation_id, hex(id) as id, parents, user_content, assistant_content, meta, created_at FROM chat_nodes WHERE conversation_id = ? ORDER BY id"
    ).bind(convId).all();

    return c.json({ data: { conversation: conv, nodes: nodes.results }, em: "" });
  });

  api.post("/send", async (c) => {
    const body = await c.req.json<{
      data: { conversation_id: string; message: string; node_id?: string };
    }>();
    const d = body.data;
    if (!d.conversation_id || !d.message) {
      return c.json({ data: null, em: "conversation_id and message required" });
    }

    const { bytes: newIdBytes, hex: newIdHex } = await getNextId(c.env, d.conversation_id);

    const conv = await c.env.DB.prepare(
      "SELECT focus_id FROM chat_conversations WHERE id = ?"
    ).bind(d.conversation_id).first<{ focus_id: ArrayBuffer | null }>();

    let parents = "";
    let contextNodeIdHex = "";

    if (d.node_id) {
      const targetNode = await c.env.DB.prepare(
        "SELECT parents FROM chat_nodes WHERE conversation_id = ? AND id = ?"
      ).bind(d.conversation_id, hexToBytes(d.node_id)).first<{ parents: string }>();
      if (targetNode) {
        parents = targetNode.parents ? `${targetNode.parents}.${d.node_id}` : d.node_id;
        contextNodeIdHex = d.node_id;
      }
    } else if (conv?.focus_id) {
      contextNodeIdHex = blobToHex(new Uint8Array(conv.focus_id));
      const focusNode = await c.env.DB.prepare(
        "SELECT parents FROM chat_nodes WHERE conversation_id = ? AND id = ?"
      ).bind(d.conversation_id, conv.focus_id).first<{ parents: string }>();
      if (focusNode) {
        parents = focusNode.parents ? `${focusNode.parents}.${contextNodeIdHex}` : contextNodeIdHex;
      }
    }

    const contextMessages = contextNodeIdHex
      ? await buildContext(c.env, d.conversation_id, parents.split(".").slice(0, -1).join("."), contextNodeIdHex)
      : [];

    const llmMessages = [
      { role: "system" as const, content: buildSystemPrompt() },
      ...contextMessages.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "user" as const, content: d.message },
    ];

    const ts = now();
    let assistantContent = "";
    try {
      const result = await callLLM(c.env, llmMessages);
      assistantContent = result.content;
    } catch (err: any) {
      assistantContent = `Error: ${err.message}`;
    }

    const headings = parseHeadings(assistantContent);

    await c.env.DB.prepare(
      `INSERT INTO chat_nodes (conversation_id, id, parents, user_content, user_meta, assistant_content, assistant_meta, meta, created_at)
       VALUES (?, ?, ?, ?, '{}', ?, '{}', '{}', ?)`
    ).bind(
      d.conversation_id,
      newIdBytes,
      parents,
      d.message,
      assistantContent,
      ts
    ).run();

    await c.env.DB.prepare(
      "UPDATE chat_conversations SET focus_id = ?, updated_at = ? WHERE id = ?"
    ).bind(newIdBytes, ts, d.conversation_id).run();

    return c.json({
      data: {
        id: newIdHex,
        parents,
        user_content: d.message,
        assistant_content: assistantContent,
        headings,
      },
      em: "",
    });
  });

  api.post("/branch", async (c) => {
    const body = await c.req.json<{
      data: { conversation_id: string; node_id: string; heading: string };
    }>();
    const d = body.data;
    if (!d.conversation_id || !d.node_id || !d.heading) {
      return c.json({ data: null, em: "conversation_id, node_id, heading required" });
    }

    const { bytes: newIdBytes, hex: newIdHex } = await getNextId(c.env, d.conversation_id);
    const parentNode = await c.env.DB.prepare(
      "SELECT parents FROM chat_nodes WHERE conversation_id = ? AND id = ?"
    ).bind(d.conversation_id, hexToBytes(d.node_id)).first<{ parents: string }>();

    const newParents = parentNode?.parents
      ? `${parentNode.parents}.${d.node_id}`
      : d.node_id;

    const ts = now();
    await c.env.DB.prepare(
      `INSERT INTO chat_nodes (conversation_id, id, parents, user_content, user_meta, assistant_content, assistant_meta, meta, created_at)
       VALUES (?, ?, ?, ?, '{}', '', '{}', '{}', ?)`
    ).bind(d.conversation_id, newIdBytes, newParents, `[Branch: ${d.heading}]`, ts).run();

    await c.env.DB.prepare(
      "UPDATE chat_conversations SET focus_id = ?, updated_at = ? WHERE id = ?"
    ).bind(newIdBytes, ts, d.conversation_id).run();

    return c.json({ data: { id: newIdHex, parents: newParents }, em: "" });
  });

  api.post("/focus", async (c) => {
    const body = await c.req.json<{ data: { conversation_id: string; node_id: string } }>();
    const d = body.data;
    if (!d.conversation_id || !d.node_id) {
      return c.json({ data: null, em: "conversation_id and node_id required" });
    }

    const idBytes = hexToBytes(d.node_id);
    await c.env.DB.prepare(
      "UPDATE chat_conversations SET focus_id = ?, updated_at = ? WHERE id = ?"
    ).bind(idBytes, now(), d.conversation_id).run();

    return c.json({ data: { node_id: d.node_id }, em: "" });
  });

  return api;
}
