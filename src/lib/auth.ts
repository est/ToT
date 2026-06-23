import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { Env, User, Passkey, now, blobToHex } from "./types";

const RP_NAME = "ChatScatter";
const SESSION_DURATION = 30 * 24 * 60 * 60;

export function getRpId(request: Request): string {
  const url = new URL(request.url);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    return url.hostname;
  }
  return "chats.est.im";
}

export function getRpOrigin(request: Request): string {
  return new URL(request.url).origin;
}

export async function regOptions(db: D1Database, rpId: string, email: string) {
  const user = await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<User>();

  const passkeys = user
    ? await db.prepare("SELECT * FROM passkeys WHERE user_id = ?").bind(user.id).all<Passkey>()
    : { results: [] as Passkey[] };

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpId,
    userName: email,
    userDisplayName: email.split("@")[0],
    ...(user ? { userID: new TextEncoder().encode(String(user.id)) as Uint8Array<ArrayBuffer> } : {}),
    attestationType: "none",
    excludeCredentials: passkeys.results.map((pk: Passkey) => ({
      id: pk.id,
      transports: JSON.parse(pk.transports) as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });

  return options;
}

export async function regVerify(
  db: D1Database,
  response: RegistrationResponseJSON,
  expectedChallenge: string,
  expectedOrigin: string,
  expectedRpId: string,
  email: string
) {
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin,
    expectedRPID: expectedRpId,
  });

  if (!verification.verified || !verification.registrationInfo) return null;

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

  let user = await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<User>();
  if (!user) {
    const ts = now();
    await db.prepare("INSERT INTO users (email, display_name, created_at) VALUES (?, ?, ?)")
      .bind(email, email.split("@")[0], ts).run();
    user = await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<User>()!;
  }

  await db.prepare(
    "INSERT OR REPLACE INTO passkeys (id, user_id, public_key, counter, transports, device_name, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    credential.id,
    user!.id,
    credential.publicKey,
    credential.counter,
    JSON.stringify(credential.transports || []),
    `${credentialDeviceType}${credentialBackedUp ? " + backup" : ""}`,
    "{}",
    now()
  ).run();

  return user;
}

export async function authOptions(db: D1Database, rpId: string, email: string) {
  const user = await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<User>();
  if (!user) return null;

  const passkeys = await db.prepare("SELECT * FROM passkeys WHERE user_id = ?").bind(user.id).all<Passkey>();

  const options = await generateAuthenticationOptions({
    rpID: rpId,
    allowCredentials: passkeys.results.map((pk: Passkey) => ({
      id: pk.id,
      transports: JSON.parse(pk.transports) as AuthenticatorTransportFuture[],
    })),
    userVerification: "preferred",
  });

  return { options, user };
}

export async function authVerify(
  db: D1Database,
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  expectedOrigin: string,
  expectedRpId: string
) {
  const passkey = await db.prepare("SELECT * FROM passkeys WHERE id = ?").bind(response.id).first<Passkey>();
  if (!passkey) return null;

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin,
    expectedRPID: expectedRpId,
    credential: {
      id: passkey.id,
      publicKey: passkey.public_key as any,
      counter: passkey.counter,
      transports: JSON.parse(passkey.transports) as AuthenticatorTransportFuture[],
    },
  });

  if (!verification.verified) return null;

  await db.prepare("UPDATE passkeys SET counter = ? WHERE id = ?")
    .bind(verification.authenticationInfo.newCounter, passkey.id).run();

  return await db.prepare("SELECT * FROM users WHERE id = ?").bind(passkey.user_id).first<User>();
}

export async function createUserSession(db: D1Database, user: User): Promise<string> {
  const token = crypto.getRandomValues(new Uint8Array(16));
  const tokenHex = blobToHex(token);
  const expiresAt = now() + SESSION_DURATION;

  const sessions: Record<string, { expires_at: number; device: string }> = JSON.parse(user.sessions || "{}");
  sessions[tokenHex] = { expires_at: expiresAt, device: "" };

  await db.prepare("UPDATE users SET sessions = ? WHERE id = ?")
    .bind(JSON.stringify(sessions), user.id).run();

  return tokenHex;
}

export async function validateSession(db: D1Database, userId: number, tokenHex: string): Promise<User | null> {
  const user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<User>();
  if (!user) return null;

  const sessions: Record<string, { expires_at: number }> = JSON.parse(user.sessions || "{}");
  const session = sessions[tokenHex];
  if (!session) return null;

  if (session.expires_at < now()) {
    delete sessions[tokenHex];
    await db.prepare("UPDATE users SET sessions = ? WHERE id = ?")
      .bind(JSON.stringify(sessions), user.id).run();
    return null;
  }

  return user;
}

export async function removeSession(db: D1Database, userId: number, tokenHex: string) {
  const user = await db.prepare("SELECT sessions FROM users WHERE id = ?").bind(userId).first<User>();
  if (!user) return;
  const sessions: Record<string, unknown> = JSON.parse(user.sessions || "{}");
  delete sessions[tokenHex];
  await db.prepare("UPDATE users SET sessions = ? WHERE id = ?")
    .bind(JSON.stringify(sessions), userId).run();
}
