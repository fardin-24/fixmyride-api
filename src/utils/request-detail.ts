import { eq } from 'drizzle-orm';
import { db } from '../db';
import { providers, reviews, service_requests, users, vehicles } from '../db/schema';

export async function build_request_detail(request_id: string) {
  const [request] = await db
    .select()
    .from(service_requests)
    .where(eq(service_requests.id, request_id))
    .limit(1);

  if (!request) return null;

  const [customer] = await db
    .select({ name: users.name, phone: users.phone, profile_photo_url: users.profile_photo_url })
    .from(users)
    .where(eq(users.id, request.customer_id))
    .limit(1);

  const [provider_row] = await db
    .select()
    .from(providers)
    .where(eq(providers.id, request.provider_id))
    .limit(1);

  const [provider_user] = provider_row
    ? await db
        .select({ phone: users.phone, profile_photo_url: users.profile_photo_url })
        .from(users)
        .where(eq(users.id, provider_row.user_id))
        .limit(1)
    : [null];

  const [vehicle] = await db
    .select({
      vehicle_type: vehicles.vehicle_type,
      brand: vehicles.brand,
      model: vehicles.model,
      registration_number: vehicles.registration_number,
      year: vehicles.year,
      color: vehicles.color,
    })
    .from(vehicles)
    .where(eq(vehicles.id, request.vehicle_id))
    .limit(1);

  const [existing_review] = await db
    .select({ id: reviews.id })
    .from(reviews)
    .where(eq(reviews.request_id, request_id))
    .limit(1);

  return {
    ...request,
    customer: customer ?? { name: 'Unknown', phone: null, profile_photo_url: null },
    provider: provider_row
      ? {
          id: provider_row.id,
          workshop_name: provider_row.workshop_name,
          workshop_address: provider_row.workshop_address,
          workshop_lat: provider_row.workshop_lat,
          workshop_lng: provider_row.workshop_lng,
          current_lat: provider_row.current_lat,
          current_lng: provider_row.current_lng,
          phone: provider_user?.phone ?? null,
          profile_photo_url: provider_user?.profile_photo_url ?? null,
          rating_avg: provider_row.rating_avg,
        }
      : null,
    vehicle: vehicle ?? null,
    has_review: !!existing_review,
  };
}