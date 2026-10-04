import { Router } from 'express';
import type { Request, Response } from 'express';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { providers, provider_services, reviews, service_requests, users } from '../db/schema';
import { requireRole } from '../middleware/auth';
import { build_request_detail } from '../utils/request-detail';

const router = Router();

const SERVICE_TYPES = ['mechanic', 'towing', 'tire', 'battery', 'fuel_delivery', 'other'] as const;
type ServiceType = (typeof SERVICE_TYPES)[number];
type ServiceInput = { service_type: ServiceType; base_price?: number | null };
type ProfileInput = {
  workshop_name: string;
  workshop_address?: string | null;
  workshop_lat: number;
  workshop_lng: number;
  services: ServiceInput[];
};

// Any status that blocks a provider from being offered new requests (used for "busy" checks)
const ACTIVE_STATUSES = ['pending', 'accepted', 'on_the_way', 'arrived', 'in_progress'] as const;
// Only statuses that mean the provider has actually accepted and can act on the job
const ASSIGNED_STATUSES = ['accepted', 'on_the_way', 'arrived', 'in_progress'] as const;

const isServiceType = (value: unknown): value is ServiceType =>
  typeof value === 'string' && SERVICE_TYPES.includes(value as ServiceType);

const parseService = (value: unknown): { ok: true; data: ServiceInput } | { ok: false; message: string } => {
  if (!value || typeof value !== 'object') return { ok: false, message: 'Service is required' };
  const record = value as Record<string, unknown>;
  if (!isServiceType(record.service_type)) return { ok: false, message: 'Invalid service type' };
  const base_price = record.base_price;
  if (
    base_price !== undefined &&
    base_price !== null &&
    (typeof base_price !== 'number' || !Number.isInteger(base_price) || base_price <= 0)
  ) {
    return { ok: false, message: 'base_price must be a positive integer or null' };
  }
  return {
    ok: true,
    data: {
      service_type: record.service_type as ServiceType,
      base_price: base_price === undefined ? undefined : (base_price as number | null),
    },
  };
};

const parseProfile = (value: unknown): { ok: true; data: ProfileInput } | { ok: false; message: string } => {
  if (!value || typeof value !== 'object') return { ok: false, message: 'Invalid input' };
  const record = value as Record<string, unknown>;
  if (typeof record.workshop_name !== 'string' || record.workshop_name.trim().length < 1) {
    return { ok: false, message: 'workshop_name is required' };
  }
  if (
    record.workshop_address !== undefined &&
    record.workshop_address !== null &&
    typeof record.workshop_address !== 'string'
  ) {
    return { ok: false, message: 'workshop_address must be a string or null' };
  }
  if (typeof record.workshop_lat !== 'number' || typeof record.workshop_lng !== 'number') {
    return { ok: false, message: 'workshop coordinates are required' };
  }
  if (!Array.isArray(record.services) || record.services.length < 1) {
    return { ok: false, message: 'At least one service is required' };
  }
  const services: ServiceInput[] = [];
  for (const service of record.services) {
    const parsed = parseService(service);
    if (!parsed.ok) return parsed;
    services.push(parsed.data);
  }
  return {
    ok: true,
    data: {
      workshop_name: record.workshop_name.trim(),
      workshop_address:
        typeof record.workshop_address === 'string' ? record.workshop_address.trim() : record.workshop_address ?? undefined,
      workshop_lat: record.workshop_lat,
      workshop_lng: record.workshop_lng,
      services,
    },
  };
};

// PUT /api/provider/profile
router.put('/profile', requireRole('provider'), async (req: Request, res: Response) => {
  const parsed = parseProfile(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.message });
    return;
  }
  const { workshop_name, workshop_address, workshop_lat, workshop_lng, services } = parsed.data;
  const user = req.user!;

  const [existing] = await db.select().from(providers).where(eq(providers.user_id, user.id)).limit(1);

  let provider_id: string;
  if (existing) {
    const [updated] = await db
      .update(providers)
      .set({ workshop_name, workshop_address: workshop_address ?? null, workshop_lat, workshop_lng, updated_at: new Date() })
      .where(eq(providers.id, existing.id))
      .returning();
    provider_id = updated.id;
  } else {
    const [created] = await db
      .insert(providers)
      .values({ user_id: user.id, workshop_name, workshop_address: workshop_address ?? null, workshop_lat, workshop_lng })
      .returning();
    provider_id = created.id;
  }

  await db.delete(provider_services).where(eq(provider_services.provider_id, provider_id));
  await db.insert(provider_services).values(
    services.map((s) => ({ provider_id, service_type: s.service_type, base_price: s.base_price ?? null })),
  );

  const [provider] = await db.select().from(providers).where(eq(providers.id, provider_id));
  const saved_services = await db
    .select({ service_type: provider_services.service_type, base_price: provider_services.base_price })
    .from(provider_services)
    .where(eq(provider_services.provider_id, provider_id));

  res.json({ provider: { ...provider, services: saved_services } });
});

// PATCH /api/provider/status
router.patch('/status', requireRole('provider'), async (req: Request, res: Response) => {
  const user = req.user!;
  const body = req.body as Record<string, unknown>;

  if (typeof body.is_online !== 'boolean') {
    res.status(400).json({ error: 'is_online must be a boolean' });
    return;
  }

  const [existing] = await db.select().from(providers).where(eq(providers.user_id, user.id)).limit(1);
  if (!existing) {
    res.status(404).json({ error: 'Provider profile not found. Complete verification first.' });
    return;
  }

  const updates: Partial<typeof providers.$inferInsert> = { is_online: body.is_online, updated_at: new Date() };
  if (typeof body.lat === 'number' && typeof body.lng === 'number') {
    updates.current_lat = body.lat;
    updates.current_lng = body.lng;
    updates.location_updated_at = new Date();
  }

  const [updated] = await db.update(providers).set(updates).where(eq(providers.id, existing.id)).returning();
  res.json({ provider: updated });
});

// PATCH /api/provider/location
router.patch('/location', requireRole('provider'), async (req: Request, res: Response) => {
  const user = req.user!;
  const body = req.body as Record<string, unknown>;

  if (typeof body.lat !== 'number' || typeof body.lng !== 'number') {
    res.status(400).json({ error: 'lat and lng are required' });
    return;
  }

  const [existing] = await db.select().from(providers).where(eq(providers.user_id, user.id)).limit(1);
  if (!existing) {
    res.status(404).json({ error: 'Provider profile not found' });
    return;
  }

  await db
    .update(providers)
    .set({ current_lat: body.lat, current_lng: body.lng, location_updated_at: new Date() })
    .where(eq(providers.id, existing.id));

  res.json({ ok: true });
});

// GET /api/provider/requests/active — only a job the provider has actually accepted
router.get('/requests/active', requireRole('provider'), async (req: Request, res: Response) => {
  const user = req.user!;
  const [provider] = await db.select().from(providers).where(eq(providers.user_id, user.id)).limit(1);
  if (!provider) {
    res.status(404).json({ error: 'Provider profile not found' });
    return;
  }

  const [active] = await db
    .select({ id: service_requests.id })
    .from(service_requests)
    .where(and(eq(service_requests.provider_id, provider.id), inArray(service_requests.status, ASSIGNED_STATUSES)))
    .limit(1);

  const request = active ? await build_request_detail(active.id) : null;
  res.json({ request });
});

// PATCH /api/provider/requests/:id/status
const NEXT_STATUS: Record<string, string> = { accepted: 'on_the_way', on_the_way: 'arrived', arrived: 'in_progress' };
const STATUS_TIMESTAMP_FIELD: Record<string, string> = {
  on_the_way: 'on_the_way_at',
  arrived: 'arrived_at',
  in_progress: 'started_at',
};

router.patch('/requests/:id/status', requireRole('provider'), async (req: Request, res: Response) => {
  const user = req.user!;
  const requested_status = (req.body as Record<string, unknown>).status;

  if (typeof requested_status !== 'string' || !['on_the_way', 'arrived', 'in_progress'].includes(requested_status)) {
    res.status(400).json({ error: 'status must be one of on_the_way, arrived, in_progress' });
    return;
  }

  const [provider] = await db.select().from(providers).where(eq(providers.user_id, user.id)).limit(1);
  if (!provider) {
    res.status(404).json({ error: 'Provider profile not found' });
    return;
  }

  const request_id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [current] = await db
    .select()
    .from(service_requests)
    .where(and(eq(service_requests.id, request_id), eq(service_requests.provider_id, provider.id)))
    .limit(1);

  if (!current) {
    res.status(404).json({ error: 'Request not found' });
    return;
  }
  if (NEXT_STATUS[current.status] !== requested_status) {
    res.status(400).json({ error: `Cannot move from ${current.status} to ${requested_status}` });
    return;
  }

  const timestamp_field = STATUS_TIMESTAMP_FIELD[requested_status];
  const [updated] = await db
    .update(service_requests)
    .set({ status: requested_status as any, [timestamp_field]: new Date(), updated_at: new Date() })
    .where(eq(service_requests.id, request_id))
    .returning();

  const detail = await build_request_detail(updated.id);
  res.json({ request: detail });
});

// GET /api/provider/dashboard
router.get('/dashboard', requireRole('provider'), async (req: Request, res: Response) => {
  const user = req.user!;
  const [provider] = await db.select().from(providers).where(eq(providers.user_id, user.id)).limit(1);
  if (!provider) {
    res.status(404).json({ error: 'Provider profile not found' });
    return;
  }

  const today_start = new Date();
  today_start.setHours(0, 0, 0, 0);

  const today_rows = await db
    .select({ id: service_requests.id })
    .from(service_requests)
    .where(and(eq(service_requests.provider_id, provider.id), sql`${service_requests.created_at} >= ${today_start}`));

  const [active] = await db
    .select({ id: service_requests.id })
    .from(service_requests)
    .where(and(eq(service_requests.provider_id, provider.id), inArray(service_requests.status, ASSIGNED_STATUSES)))
    .limit(1);

  const active_request = active ? await build_request_detail(active.id) : null;

  res.json({
    is_online: provider.is_online,
    today_requests: today_rows.length,
    active_request,
    rating_avg: provider.rating_avg,
    rating_count: provider.rating_count,
  });
});

// GET /api/provider/requests/incoming
router.get('/requests/incoming', requireRole('provider'), async (req: Request, res: Response) => {
  const user = req.user!;
  const [provider] = await db.select().from(providers).where(eq(providers.user_id, user.id)).limit(1);
  if (!provider) {
    res.status(404).json({ error: 'Provider profile not found' });
    return;
  }

  const rows = await db
    .select({ id: service_requests.id })
    .from(service_requests)
    .where(and(eq(service_requests.provider_id, provider.id), eq(service_requests.status, 'pending')))
    .orderBy(service_requests.created_at);

  const details = await Promise.all(rows.map((r) => build_request_detail(r.id)));
  res.json({ requests: details.filter(Boolean) });
});

// POST /api/provider/requests/:id/accept
router.post('/requests/:id/accept', requireRole('provider'), async (req: Request, res: Response) => {
  const user = req.user!;
  const [provider] = await db.select().from(providers).where(eq(providers.user_id, user.id)).limit(1);
  if (!provider) {
    res.status(404).json({ error: 'Provider profile not found' });
    return;
  }

  const request_id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [busy] = await db
    .select({ id: service_requests.id })
    .from(service_requests)
    .where(and(eq(service_requests.provider_id, provider.id), inArray(service_requests.status, ACTIVE_STATUSES)))
    .limit(1);
  if (busy && busy.id !== request_id) {
    res.status(409).json({ error: 'You already have an active job' });
    return;
  }

  const [updated] = await db
    .update(service_requests)
    .set({ status: 'accepted', accepted_at: new Date(), updated_at: new Date() })
    .where(
      and(
        eq(service_requests.id, request_id),
        eq(service_requests.provider_id, provider.id),
        eq(service_requests.status, 'pending'),
      ),
    )
    .returning();

  if (!updated) {
    res.status(409).json({ error: 'This request is no longer available' });
    return;
  }

  const detail = await build_request_detail(updated.id);
  res.json({ request: detail });
});

// POST /api/provider/requests/:id/decline
router.post('/requests/:id/decline', requireRole('provider'), async (req: Request, res: Response) => {
  const user = req.user!;
  const [provider] = await db.select().from(providers).where(eq(providers.user_id, user.id)).limit(1);
  if (!provider) {
    res.status(404).json({ error: 'Provider profile not found' });
    return;
  }

  const request_id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [updated] = await db
    .update(service_requests)
    .set({ status: 'declined', declined_at: new Date(), updated_at: new Date() })
    .where(
      and(
        eq(service_requests.id, request_id),
        eq(service_requests.provider_id, provider.id),
        eq(service_requests.status, 'pending'),
      ),
    )
    .returning();

  if (!updated) {
    res.status(409).json({ error: 'This request is no longer pending' });
    return;
  }

  const detail = await build_request_detail(updated.id);
  res.json({ request: detail });
});

// POST /api/provider/requests/:id/complete
router.post('/requests/:id/complete', requireRole('provider'), async (req: Request, res: Response) => {
  const user = req.user!;
  const body = req.body as Record<string, unknown>;

  const service_performed = typeof body.service_performed === 'string' ? body.service_performed.trim() : '';
  const final_price = body.final_price;
  const notes = typeof body.notes === 'string' ? body.notes.trim() : null;

  if (!service_performed) {
    res.status(400).json({ error: 'service_performed is required' });
    return;
  }
  if (typeof final_price !== 'number' || !Number.isInteger(final_price) || final_price <= 0) {
    res.status(400).json({ error: 'final_price must be a positive integer' });
    return;
  }

  const [provider] = await db.select().from(providers).where(eq(providers.user_id, user.id)).limit(1);
  if (!provider) {
    res.status(404).json({ error: 'Provider profile not found' });
    return;
  }

  const request_id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [updated] = await db
    .update(service_requests)
    .set({
      status: 'completed',
      completed_at: new Date(),
      service_performed,
      final_price,
      provider_notes: notes,
      payment_status: 'paid',
      updated_at: new Date(),
    })
    .where(
      and(
        eq(service_requests.id, request_id),
        eq(service_requests.provider_id, provider.id),
        eq(service_requests.status, 'in_progress'),
      ),
    )
    .returning();

  if (!updated) {
    res.status(409).json({ error: 'This request cannot be completed from its current status' });
    return;
  }

  const detail = await build_request_detail(updated.id);
  res.json({ request: detail });
});

// GET /api/provider/reviews
router.get('/reviews', requireRole('provider'), async (req: Request, res: Response) => {
  const user = req.user!;
  const [provider] = await db.select().from(providers).where(eq(providers.user_id, user.id)).limit(1);
  if (!provider) {
    res.status(404).json({ error: 'Provider profile not found' });
    return;
  }

  const rows = await db
    .select({ rating: reviews.rating, comment: reviews.comment, created_at: reviews.created_at, customer_name: users.name })
    .from(reviews)
    .innerJoin(users, eq(users.id, reviews.customer_id))
    .where(eq(reviews.provider_id, provider.id))
    .orderBy(desc(reviews.created_at));

  res.json({ reviews: rows, rating_avg: provider.rating_avg, rating_count: provider.rating_count });
});

export default router;