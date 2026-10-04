import { Router } from 'express';
import type { Request, Response } from 'express';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { complaints, providers, service_requests, users } from '../db/schema';
import { requireRole } from '../middleware/auth';
import { build_request_detail } from '../utils/request-detail';

const router = Router();

const COMPLETED = 'completed';
const ACTIVE_STATUSES = ['pending', 'accepted', 'on_the_way', 'arrived', 'in_progress'] as const;

// GET /api/admin/dashboard
router.get('/dashboard', requireRole('admin'), async (_req: Request, res: Response) => {
  const all_users = await db.select({ id: users.id, role: users.role }).from(users);
  const total_users = all_users.filter((u) => u.role === 'customer').length;

  const all_providers = await db.select({ id: providers.id, verification_status: providers.verification_status }).from(providers);
  const total_providers = all_providers.length;
  const pending_provider_verification = all_providers.filter((p) => p.verification_status === 'pending').length;

  const all_requests = await db.select({ id: service_requests.id, status: service_requests.status }).from(service_requests);
  const active_requests = all_requests.filter((r) => (ACTIVE_STATUSES as readonly string[]).includes(r.status)).length;
  const completed_requests = all_requests.filter((r) => r.status === COMPLETED).length;

  const recent_request_rows = await db
    .select({ id: service_requests.id })
    .from(service_requests)
    .orderBy(desc(service_requests.created_at))
    .limit(10);
  const recent_requests = await Promise.all(recent_request_rows.map((r) => build_request_detail(r.id)));

  const recent_complaints = await db
    .select()
    .from(complaints)
    .orderBy(desc(complaints.created_at))
    .limit(10);

  res.json({
    total_users,
    total_providers,
    active_requests,
    completed_requests,
    pending_provider_verification,
    recent_requests: recent_requests.filter(Boolean),
    recent_complaints,
  });
});

// GET /api/admin/complaints
router.get('/complaints', requireRole('admin'), async (_req: Request, res: Response) => {
  const rows = await db
    .select({
      id: complaints.id,
      reporter_id: complaints.reporter_id,
      request_id: complaints.request_id,
      provider_id: complaints.provider_id,
      message: complaints.message,
      status: complaints.status,
      created_at: complaints.created_at,
      resolved_at: complaints.resolved_at,
      reporter_name: users.name,
      reporter_email: users.email,
    })
    .from(complaints)
    .innerJoin(users, eq(users.id, complaints.reporter_id))
    .orderBy(desc(complaints.created_at));

  res.json({ complaints: rows });
});

// PATCH /api/admin/complaints/:id
router.patch('/complaints/:id', requireRole('admin'), async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const status = body.status;

  if (typeof status !== 'string' || !['open', 'in_review', 'resolved'].includes(status)) {
    res.status(400).json({ error: 'status must be one of open, in_review, resolved' });
    return;
  }

  const updates: Partial<typeof complaints.$inferInsert> = { status: status as any };
  if (status === 'resolved') {
    updates.resolved_at = new Date();
  }

  const complaint_id = Array.isArray(req.params.id) ? req.params.id[0] ?? '' : req.params.id;

  const [updated] = await db
    .update(complaints)
    .set(updates)
    .where(eq(complaints.id, complaint_id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: 'Complaint not found' });
    return;
  }

  res.json({ complaint: updated });
});

export default router;