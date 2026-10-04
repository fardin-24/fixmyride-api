import { Router } from 'express';
import type { Request, Response } from 'express';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { provider_services, providers, reviews, service_requests, vehicles } from '../db/schema';
import { eta_minutes, haversine_km } from '../utils/geo';
import { build_request_detail } from '../utils/request-detail';


const router = Router();

const ACTIVE_STATUSES = ['pending', 'accepted', 'on_the_way', 'arrived', 'in_progress'] as const;
const CANCELABLE_STATUSES = ['pending', 'accepted', 'on_the_way'] as const;

const SERVICE_TYPES = ['mechanic', 'towing', 'tire', 'battery', 'fuel_delivery', 'other'] as const;
type ServiceType = (typeof SERVICE_TYPES)[number];

function is_service_type(value: unknown): value is ServiceType {
  return typeof value === 'string' && SERVICE_TYPES.includes(value as ServiceType);
}

// POST /api/requests
router.post('/', async (req: Request, res: Response) => {
  const user = req.user!;
  const body = req.body as Record<string, unknown>;

  const provider_id = typeof body.provider_id === 'string' ? body.provider_id : null;
  const vehicle_id = typeof body.vehicle_id === 'string' ? body.vehicle_id : null;
  const service_type = is_service_type(body.service_type) ? body.service_type : null;
  const problem_description =
    typeof body.problem_description === 'string' ? body.problem_description.trim() : '';
  const problem_photo_url =
    typeof body.problem_photo_url === 'string' ? body.problem_photo_url : null;
  const customer_lat = typeof body.customer_lat === 'number' ? body.customer_lat : null;
  const customer_lng = typeof body.customer_lng === 'number' ? body.customer_lng : null;
  const customer_address = typeof body.customer_address === 'string' ? body.customer_address : null;

  if (!provider_id || !vehicle_id || !service_type || !problem_description) {
    res.status(400).json({ error: 'provider_id, vehicle_id, service_type and problem_description are required' });
    return;
  }
  if (customer_lat === null || customer_lng === null) {
    res.status(400).json({ error: 'customer_lat and customer_lng are required' });
    return;
  }

  try {
    const [vehicle] = await db
      .select()
      .from(vehicles)
      .where(and(eq(vehicles.id, vehicle_id), eq(vehicles.user_id, user.id)))
      .limit(1);
    if (!vehicle) {
      res.status(404).json({ error: 'Vehicle not found' });
      return;
    }

    const [provider] = await db.select().from(providers).where(eq(providers.id, provider_id)).limit(1);
    if (!provider || !provider.is_online) {
      res.status(409).json({ error: 'This provider is not available right now' });
      return;
    }

    const [service] = await db
      .select()
      .from(provider_services)
      .where(and(eq(provider_services.provider_id, provider_id), eq(provider_services.service_type, service_type)))
      .limit(1);
    if (!service) {
      res.status(409).json({ error: 'This provider does not offer that service' });
      return;
    }

    const [existing_active] = await db
      .select({ id: service_requests.id })
      .from(service_requests)
      .where(and(eq(service_requests.customer_id, user.id), inArray(service_requests.status, ACTIVE_STATUSES)))
      .limit(1);
    if (existing_active) {
      res.status(409).json({ error: 'You already have an active request' });
      return;
    }

    const [provider_busy] = await db
      .select({ id: service_requests.id })
      .from(service_requests)
      .where(and(eq(service_requests.provider_id, provider_id), inArray(service_requests.status, ACTIVE_STATUSES)))
      .limit(1);
    if (provider_busy) {
      res.status(409).json({ error: 'This provider just became busy. Please choose another.' });
      return;
    }

    const provider_lat = provider.current_lat ?? provider.workshop_lat;
    const provider_lng = provider.current_lng ?? provider.workshop_lng;
    const distance_km = haversine_km(customer_lat, customer_lng, provider_lat, provider_lng);

    const [created] = await db
      .insert(service_requests)
      .values({
        customer_id: user.id,
        provider_id,
        vehicle_id,
        service_type,
        problem_description,
        problem_photo_url,
        customer_lat,
        customer_lng,
        customer_address,
        distance_km,
        eta_minutes: eta_minutes(distance_km),
        estimated_price: service.base_price ?? null,
      })
      .returning();

    const detail = await build_request_detail(created.id);
    res.json({ request: detail });
  } catch (err) {
    console.error('POST /api/requests failed:', err);
    res.status(500).json({ error: 'Could not create the request' });
  }
});

// GET /api/requests/active
router.get('/active', async (req: Request, res: Response) => {
  const user = req.user!;
  const [active] = await db
    .select({ id: service_requests.id })
    .from(service_requests)
    .where(and(eq(service_requests.customer_id, user.id), inArray(service_requests.status, ACTIVE_STATUSES)))
    .limit(1);

  if (!active) {
    res.json({ request: null });
    return;
  }

  const detail = await build_request_detail(active.id);
  res.json({ request: detail });
});

// GET /api/requests/:id
router.get('/:id', async (req: Request, res: Response) => {
  const user = req.user!;
  const request_id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const detail = await build_request_detail(request_id);

  if (!detail) {
    res.status(404).json({ error: 'Request not found' });
    return;
  }

  const is_customer = detail.customer_id === user.id;
  const provider_row = detail.provider_id
    ? await db.select().from(providers).where(eq(providers.id, detail.provider_id)).limit(1)
    : [];
  const is_provider = provider_row[0]?.user_id === user.id;

  if (!is_customer && !is_provider && user.role !== 'admin') {
    res.status(403).json({ error: 'You do not have access to this' });
    return;
  }

  res.json({ request: detail });
});

// POST /api/requests/:id/review
router.post('/:id/review', async (req: Request, res: Response) => {
  const user = req.user!;
  const request_id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const body = req.body as Record<string, unknown>;

  const rating = body.rating;
  const comment = typeof body.comment === 'string' ? body.comment.trim() : null;

  if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    res.status(400).json({ error: 'rating must be an integer from 1 to 5' });
    return;
  }

  const [request] = await db
    .select()
    .from(service_requests)
    .where(eq(service_requests.id, request_id))
    .limit(1);

  if (!request) {
    res.status(404).json({ error: 'Request not found' });
    return;
  }
  if (request.customer_id !== user.id) {
    res.status(403).json({ error: 'You do not have access to this' });
    return;
  }
  if (request.status !== 'completed') {
    res.status(400).json({ error: 'You can only review a completed request' });
    return;
  }

  const [existing] = await db
    .select({ id: reviews.id })
    .from(reviews)
    .where(eq(reviews.request_id, request_id))
    .limit(1);
  if (existing) {
    res.status(409).json({ error: 'You already reviewed this request' });
    return;
  }

  const [created] = await db
    .insert(reviews)
    .values({
      request_id,
      customer_id: user.id,
      provider_id: request.provider_id,
      rating,
      comment,
    })
    .returning();

  // Recalculate the provider's rating_avg and rating_count
  const all_reviews = await db
    .select({ rating: reviews.rating })
    .from(reviews)
    .where(eq(reviews.provider_id, request.provider_id));

  const count = all_reviews.length;
  const avg = all_reviews.reduce((sum, r) => sum + r.rating, 0) / count;

  await db
    .update(providers)
    .set({ rating_avg: avg, rating_count: count, updated_at: new Date() })
    .where(eq(providers.id, request.provider_id));

  res.json({ review: created });
});


// POST /api/requests/:id/cancel
router.post('/:id/cancel', async (req: Request, res: Response) => {
  const user = req.user!;
  const request_id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [updated] = await db
    .update(service_requests)
    .set({ status: 'cancelled', cancelled_at: new Date(), updated_at: new Date() })
    .where(
      and(
        eq(service_requests.id, request_id),
        eq(service_requests.customer_id, user.id),
        inArray(service_requests.status, CANCELABLE_STATUSES),
      ),
    )
    .returning();

  if (!updated) {
    res.status(409).json({ error: 'This request can no longer be cancelled' });
    return;
  }

  const detail = await build_request_detail(updated.id);
  res.json({ request: detail });
});

// GET /api/requests
router.get('/', async (req: Request, res: Response) => {
  const user = req.user!;
  const rows = await db
    .select({ id: service_requests.id })
    .from(service_requests)
    .where(eq(service_requests.customer_id, user.id))
    .orderBy(desc(service_requests.created_at));

  const details = await Promise.all(rows.map((r) => build_request_detail(r.id)));
  res.json({ requests: details.filter(Boolean) });
});

export default router;