import { sealData, unsealData } from 'iron-session';
import type { NextRequest, NextResponse } from 'next/server';
import type { Actor } from '../audit';
import { getDb, type Queryable } from '../db';

export const SESSION_COOKIE = 'wellnessave_session';
export const PARENT_SESSION_S = 30 * 86400; // PRD §13
export const STAFF_SESSION_S = 12 * 3600; // PRD §13

/** iat / exp are epoch milliseconds. */
export type SessionData =
  | { kind: 'guardian'; guardianId: string; iat: number; exp: number }
  | { kind: 'staff'; staffId: string; role: 'ADMIN' | 'PROVIDER'; providerId: string | null; iat: number; exp: number };

const password = () => {
  const p = process.env.SESSION_SECRET;
  if (!p || p.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  return p;
};

export async function sealSession(data: SessionData) {
  return sealData(data, { password: password(), ttl: Math.ceil((data.exp - data.iat) / 1000) });
}

export function setSessionCookie(res: NextResponse, sealed: string, maxAge: number) {
  res.cookies.set(SESSION_COOKIE, sealed, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge,
  });
}

export function clearSessionCookie(res: NextResponse) {
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
}

/**
 * Unseal and validate: expiry, and the account's sessions_valid_after (revocation on logout-everywhere,
 * restriction, or merge). Returns the actor, or null.
 */
export async function actorFromCookie(
  value: string | undefined,
  db: Queryable = getDb(),
  now = new Date(),
): Promise<Actor | null> {
  if (!value) return null;
  let s: SessionData;
  try {
    s = await unsealData<SessionData>(value, { password: password() });
  } catch {
    return null;
  }
  if (!s?.kind || s.exp <= now.getTime()) return null;
  if (s.kind === 'guardian') {
    const g = await db.guardian.findUnique({
      where: { id: s.guardianId },
      select: { sessionsValidAfter: true, mergedIntoId: true },
    });
    if (!g || g.mergedIntoId || g.sessionsValidAfter.getTime() > s.iat) return null;
    return { type: 'GUARDIAN', id: s.guardianId };
  }
  const u = await db.staffUser.findUnique({
    where: { id: s.staffId },
    select: { sessionsValidAfter: true, role: true, providerId: true, active: true },
  });
  if (!u || !u.active || u.sessionsValidAfter.getTime() > s.iat) return null;
  return { type: 'STAFF', id: s.staffId, role: u.role, providerId: u.providerId };
}

export const actorFromRequest = (req: NextRequest, db?: Queryable, now?: Date) =>
  actorFromCookie(req.cookies.get(SESSION_COOKIE)?.value, db, now);
