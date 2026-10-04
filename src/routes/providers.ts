import { Router } from 'express';
import type { Request, Response } from 'express';
import { and, eq, ilike, inArray, notInArray } from 'drizzle-orm';
import { db } from '../db';
import { provider_services, providers, service_requests } from '../db/schema';
import { eta_minutes, haversine_km } from '../utils/geo';

const router = Router();

// Turn on later once provider verification review is in place.
const REQUIRE_VERIFICATION = false;

const ACTIVE_STATUSES = ['pending', 'accepted', 'on_the_way', 'arrived', 'in_progress'] as const;

const SERVICE_TYPES = ['mechanic', 'towing', 'tire', 'battery', 'fuel_delivery', 'other'] as const;
type ServiceType = (typeof SERVICE_TYPES)[number];

function is_service_type(value: unknown): value is ServiceType {
  return typeof value === 'string' && SERVICE_TYPES.includes(value as ServiceType);
}

function parse_number(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

type ProviderCardRow = {
  provider_id: string;
  workshop_name: string;
  workshop_address: string | null;
  profile_photo_url: string | null;
  phone: string | null;
  services: { service_type: ServiceType; base_price: number | null }[];
  distance_km: number;
  eta_minutes: number;
  estimated_price: number | null;
  rating_avg: number;
  rating_count: number;
  lat: number;
  lng: number;
};

async function build_provider_card(
  provider: typeof providers.$inferSelect,
  lat: number,
  lng: number,
  service_type_filter: ServiceType | null,
): Promise<ProviderCardRow> {
  const services = await db
    .select({ service_type: provider_services.service_type, base_price: provider_services.base_price })
    .from(provider_services)
    .where(eq(provider_services.provider_id, provider.id));

  const provider_lat = provider.current_lat ?? provider.workshop_lat;
  const provider_lng = provider.current_lng ?? provider.workshop_lng;
  const distance_km = haversine_km(lat, lng, provider_lat, provider_lng);

  let estimated_price: number | null;
  if (service_type_filter) {
    const match = services.find((s) => s.service_type === service_type_filter);
    estimated_price = match?.base_price ?? null;
  } else {
    const priced = services.map((s) => s.base_price).filter((p): p is number => p !== null);
    estimated_price = priced.length > 0 ? Math.min(...priced) : null;
  }

  return {
    provider_id: provider.id,
    workshop_name: provider.workshop_name,
    workshop_address: provider.workshop_address,
    profile_photo_url: null,
    phone: null,
    services,
    distance_km,
    eta_minutes: eta_minutes(distance_km),
    estimated_price,
    rating_avg: provider.rating_avg,
    rating_count: provider.rating_count,
    lat: provider_lat,
    lng: provider_lng,
  };
}

// GET /api/providers/nearby?lat&lng&service_type?&q?&nearest?&radius_km?
router.get('/nearby', async (req: Request, res: Response) => {
  const lat = parse_number(req.query.lat);
  const lng = parse_number(req.query.lng);
  if (lat === null || lng === null) {
    res.status(400).json({ error: 'lat and lng are required' });
    return;
  }

  const service_type_filter = is_service_type(req.query.service_type)
    ? (req.query.service_type as ServiceType)
    : null;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : null;
  const nearest = req.query.nearest === 'true';
  const radius_km = parse_number(req.query.radius_km) ?? 20;

  const busy_provider_ids = await db
    .selectDistinct({ provider_id: service_requests.provider_id })
    .from(service_requests)
    .where(inArray(service_requests.status, ACTIVE_STATUSES));
  const busy_ids = busy_provider_ids.map((r) => r.provider_id);

  const conditions = [eq(providers.is_online, true)];
  if (REQUIRE_VERIFICATION) {
    conditions.push(eq(providers.verification_status, 'approved'));
  }
  if (q) {
    conditions.push(ilike(providers.workshop_name, `%${q}%`));
  }
  if (busy_ids.length > 0) {
    conditions.push(notInArray(providers.id, busy_ids));
  }

  let candidates = await db
    .select()
    .from(providers)
    .where(and(...conditions));

  if (service_type_filter) {
    const with_service = await db
      .selectDistinct({ provider_id: provider_services.provider_id })
      .from(provider_services)
      .where(eq(provider_services.service_type, service_type_filter));
    const allowed = new Set(with_service.map((r) => r.provider_id));
    candidates = candidates.filter((p) => allowed.has(p.id));
  } else {
    const any_service = await db.selectDistinct({ provider_id: provider_services.provider_id }).from(
      provider_services,
    );
    const allowed = new Set(any_service.map((r) => r.provider_id));
    candidates = candidates.filter((p) => allowed.has(p.id));
  }

  const cards = await Promise.all(
    candidates.map((p) => build_provider_card(p, lat, lng, service_type_filter)),
  );

  let result = cards.filter((c) => c.distance_km <= radius_km).sort((a, b) => a.distance_km - b.distance_km);

  if (nearest) {
    result = result.slice(0, 1);
  }

  res.json({ providers: result });
});

// GET /api/providers/:id?lat&lng
router.get('/:id', async (req: Request, res: Response) => {
  const lat = parse_number(req.query.lat);
  const lng = parse_number(req.query.lng);
  if (lat === null || lng === null) {
    res.status(400).json({ error: 'lat and lng are required' });
    return;
  }

  const providerId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!providerId) {
    res.status(400).json({ error: 'Provider id is required' });
    return;
  }

  const [provider] = await db.select().from(providers).where(eq(providers.id, providerId)).limit(1);
  if (!provider) {
    res.status(404).json({ error: 'Provider not found' });
    return;
  }

  const card = await build_provider_card(provider, lat, lng, null);
  res.json({ provider: card });
});

export default router;