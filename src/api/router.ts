import { Hono } from "hono";
import { Env } from "../lib/types";
import { createProviderRoutes } from "./providers";
import { createChatRoutes } from "./chat";
import { createAuthRoutes } from "./auth";

export function createApiRouter() {
  const api = new Hono<{ Bindings: Env }>();
  api.route("/auth", createAuthRoutes());
  api.route("/provider", createProviderRoutes());
  api.route("/chat", createChatRoutes());
  return api;
}
