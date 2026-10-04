import { Router } from 'express';
import type { Request, Response } from 'express';
import { clerkClient } from '@clerk/express';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { requireSignedIn } from '../middleware/auth';

const router = Router();    

function is_unique_violation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

router.post('/sync', requireSignedIn, async (req: Request, res: Response) => {
  const clerk_id = req.clerk_id as string;

  // Already synced before? Just return it.
  const [existing] = await db.select().from(users).where(eq(users.clerk_id, clerk_id)).limit(1);
  if (existing) {
    res.json({ user: existing });
    return;
  }

  // Read email and sign-up data (name, phone, role) from Clerk
  const clerk_user = await clerkClient.users.getUser(clerk_id);
  const primary_email =
    clerk_user.emailAddresses.find((e) => e.id === clerk_user.primaryEmailAddressId) ??
    clerk_user.emailAddresses[0];

  if (!primary_email) {
    res.status(400).json({ error: 'No email found on this account' });
    return;
  }

  const email = primary_email.emailAddress.toLowerCase();
  const meta = clerk_user.unsafeMetadata as { name?: unknown; phone?: unknown; role?: unknown };

  const name =
    typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : email.split('@')[0];
  const phone = typeof meta.phone === 'string' && meta.phone.trim() ? meta.phone.trim() : null;
  // Only customer or provider. Anything else becomes customer. Never admin.
  const role = meta.role === 'provider' ? 'provider' : 'customer';

  try {
    await db
      .insert(users)
      .values({ clerk_id, name, email, phone, role })
      .onConflictDoNothing({ target: users.clerk_id });
  } catch (err) {
    if (is_unique_violation(err)) {
      res.status(409).json({ error: 'An account with this email already exists' });
      return;
    }
    throw err;
  }

  const [user] = await db.select().from(users).where(eq(users.clerk_id, clerk_id)).limit(1);
  if (!user) {
    res.status(500).json({ error: 'Could not create the user' });
    return;
  }

  res.json({ user });
});

export default router;