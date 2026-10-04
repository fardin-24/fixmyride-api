import { Router } from 'express';
import type { Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { provider_services, providers, users } from '../db/schema';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  const user = req.user!;

  const [provider] = await db
    .select()
    .from(providers)
    .where(eq(providers.user_id, user.id))
    .limit(1);

  if (!provider) {
    res.json({ user, provider: null });
    return;
  }

  const services = await db
    .select({
      service_type: provider_services.service_type,
      base_price: provider_services.base_price,
    })
    .from(provider_services)
    .where(eq(provider_services.provider_id, provider.id));

  res.json({ user, provider: { ...provider, services } });
});

router.patch('/', async (req: Request, res: Response) => {
  const user = req.user!;
  const body = req.body as Record<string, unknown>;

  const updates: Partial<typeof users.$inferInsert> = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      res.status(400).json({ error: 'name must be a non-empty string' });
      return;
    }
    updates.name = body.name.trim();
  }

  if (body.phone !== undefined) {
    if (body.phone !== null && typeof body.phone !== 'string') {
      res.status(400).json({ error: 'phone must be a string or null' });
      return;
    }
    updates.phone = body.phone === null ? null : (body.phone as string).trim();
  }

  if (body.profile_photo_url !== undefined) {
    if (body.profile_photo_url !== null && typeof body.profile_photo_url !== 'string') {
      res.status(400).json({ error: 'profile_photo_url must be a string or null' });
      return;
    }
    updates.profile_photo_url = body.profile_photo_url as string | null;
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  updates.updated_at = new Date();

  const [updated] = await db
    .update(users)
    .set(updates)
    .where(eq(users.id, user.id))
    .returning();

  res.json({ user: updated });
});

export default router;