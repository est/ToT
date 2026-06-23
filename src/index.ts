import { Hono } from "hono";
import { Env, User } from "./lib/types";
import { authMiddleware } from "./middleware/auth";
import { createApiRouter } from "./api/router";

const app = new Hono<{ Bindings: Env; Variables: { user?: User } }>();

app.use("*", authMiddleware);
app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api", createApiRouter());

export default app;
