import { Hono } from "hono";
import { Env, User, now, packSessionCookie, blobToHex } from "../lib/types";
import {
  getRpId, getRpOrigin,
  regOptions, regVerify,
  authOptions, authVerify,
  createUserSession,
} from "../lib/auth";

const CHALLENGE_TTL = 300;

export function createAuthRoutes() {
  const api = new Hono<{ Bindings: Env; Variables: { user?: User } }>();
  const challenges = new Map<string, { challenge: string; email: string; expires: number }>();

  api.post("/register/options", async (c) => {
    const { data } = await c.req.json<{ data: { email: string } }>();
    if (!data?.email) return c.json({ data: null, em: "email required" });

    const options = await regOptions(c.env.DB, getRpId(c.req.raw), data.email);

    challenges.set(`reg:${data.email}`, {
      challenge: options.challenge,
      email: data.email,
      expires: Date.now() + CHALLENGE_TTL * 1000,
    });

    return c.json({ data: options, em: "" });
  });

  api.post("/register/verify", async (c) => {
    const { data } = await c.req.json<{ data: { email: string; response: any } }>();
    if (!data?.email || !data?.response) return c.json({ data: null, em: "email and response required" });

    const key = `reg:${data.email}`;
    const entry = challenges.get(key);
    if (!entry || entry.expires < Date.now()) {
      challenges.delete(key);
      return c.json({ data: null, em: "challenge expired" });
    }

    const user = await regVerify(c.env.DB, data.response, entry.challenge, getRpOrigin(c.req.raw), getRpId(c.req.raw), data.email);
    challenges.delete(key);
    if (!user) return c.json({ data: null, em: "registration failed" });

    const tokenHex = await createUserSession(c.env.DB, user);
    const tokenBytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) tokenBytes[i] = parseInt(tokenHex.substr(i * 2, 2), 16);
    const cookie = packSessionCookie(user.id, tokenBytes);

    c.header("Set-Cookie", `session=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`);
    return c.json({ data: { id: user.id, email: user.email }, em: "" });
  });

  api.post("/login/options", async (c) => {
    const { data } = await c.req.json<{ data: { email: string } }>();
    if (!data?.email) return c.json({ data: null, em: "email required" });

    const result = await authOptions(c.env.DB, getRpId(c.req.raw), data.email);
    if (!result) return c.json({ data: null, em: "user not found" });

    challenges.set(`auth:${data.email}`, {
      challenge: result.options.challenge,
      email: data.email,
      expires: Date.now() + CHALLENGE_TTL * 1000,
    });

    return c.json({ data: result.options, em: "" });
  });

  api.post("/login/verify", async (c) => {
    const { data } = await c.req.json<{ data: { email: string; response: any } }>();
    if (!data?.email || !data?.response) return c.json({ data: null, em: "email and response required" });

    const key = `auth:${data.email}`;
    const entry = challenges.get(key);
    if (!entry || entry.expires < Date.now()) {
      challenges.delete(key);
      return c.json({ data: null, em: "challenge expired" });
    }

    const user = await authVerify(c.env.DB, data.response, entry.challenge, getRpOrigin(c.req.raw), getRpId(c.req.raw));
    challenges.delete(key);
    if (!user) return c.json({ data: null, em: "authentication failed" });

    const tokenHex = await createUserSession(c.env.DB, user);
    const tokenBytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) tokenBytes[i] = parseInt(tokenHex.substr(i * 2, 2), 16);
    const cookie = packSessionCookie(user.id, tokenBytes);

    c.header("Set-Cookie", `session=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`);
    return c.json({ data: { id: user.id, email: user.email }, em: "" });
  });

  api.post("/logout", async (c) => {
    c.header("Set-Cookie", `session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return c.json({ data: null, em: "" });
  });

  api.get("/me", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ data: null, em: "unauthorized" });
    return c.json({ data: { id: user.id, email: user.email, display_name: user.display_name }, em: "" });
  });

  return api;
}
