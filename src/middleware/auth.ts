import { Context, Next } from "hono";
import { Env, User, unpackSessionCookie } from "../lib/types";
import { validateSession } from "../lib/auth";

export async function authMiddleware(c: Context<{ Bindings: Env; Variables: { user?: User } }>, next: Next) {
  const cookie = c.req.header("Cookie") || "";
  const match = cookie.match(/session=([^;]+)/);

  if (match) {
    const parsed = unpackSessionCookie(match[1]);
    if (parsed) {
      const user = await validateSession(c.env.DB, parsed.userId, parsed.tokenHex);
      if (user) {
        c.set("user", user);
      }
    }
  }

  await next();
}
