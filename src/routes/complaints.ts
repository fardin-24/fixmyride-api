import { Router } from 'express';
import type { Request, Response } from 'express';
import { db } from '../db';
import { complaints } from '../db/schema';

const router = Router();

// POST /api/complaints
router.post('/', async (req: Request, res: Response) => {
  const user = req.user!;
  const body = req.body as Record<string, unknown>;

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const request_id = typeof body.request_id === 'string' ? body.request_id : null;
  const provider_id = typeof body.provider_id === 'string' ? body.provider_id : null;

  if (!message) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  const [created] = await db
    .insert(complaints)
    .values({
      reporter_id: user.id,
      request_id,
      provider_id,
      message,
    })
    .returning();

  res.json({ complaint: created });
});

export default router;