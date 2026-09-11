import type { Role } from '@fld/shared';
import { SignJWT, jwtVerify } from 'jose';

export const SESSION_COOKIE = 'fld_session';
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface SessionPayload {
  userId: number;
  role: Role;
}

/** viewer < manager < admin */
export const ROLE_RANK: Record<Role, number> = { viewer: 1, manager: 2, admin: 3 };

export function roleAtLeast(role: Role | null | undefined, required: Role): boolean {
  if (!role) return false;
  const have = ROLE_RANK[role];
  const need = ROLE_RANK[required];
  if (!have || !need) return false;
  return have >= need;
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  return new SignJWT({ role: payload.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(payload.userId))
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(key(secret));
}

export async function verifySession(token: string, secret: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'] });
    const userId = Number(payload.sub);
    const role = payload.role as Role | undefined;
    if (!Number.isFinite(userId) || !role || !(role in ROLE_RANK)) return null;
    return { userId, role };
  } catch {
    return null;
  }
}
