import type { NextFunction, Request, Response } from 'express';
import { getAuth } from '@clerk/express';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';

export type AuthUser = typeof users.$inferSelect;
export type UserRole = AuthUser['role'];

// Lets us use req.user and req.clerk_id in routes
declare global {
  namespace Express {
    interface Request {
      clerk_id?: string;
      user?: AuthUser;
    }
  }
}

// 1) Only checks that the Clerk login token is valid.
//    Used by POST /api/auth/sync (works before the users row exists).
export function requireSignedIn(req: Request, res: Response, next: NextFunction) {
  const { isAuthenticated, userId } = getAuth(req);

  if (!isAuthenticated || !userId) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }

  req.clerk_id = userId;
  next();
}

// 2) Checks the token AND loads the users row into req.user.
//    Used by every /api route except /api/auth/sync.
export async function requireUser(req: Request, res: Response, next: NextFunction) {
  const { isAuthenticated, userId } = getAuth(req);

  if (!isAuthenticated || !userId) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }

  const [user] = await db.select().from(users).where(eq(users.clerk_id, userId)).limit(1);

  if (!user) {
    res.status(404).json({ error: 'User not found. Call POST /api/auth/sync first.' });
    return;
  }

  req.clerk_id = userId;
  req.user = user;
  next();
}

// 3) Role guard. Use after requireUser, for example: requireRole('customer')
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ error: 'You do not have access to this' });
      return;
    }
    next();
  };
}