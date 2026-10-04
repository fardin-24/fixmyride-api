import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';


const tstz = (name: string) => timestamp(name, { withTimezone: true });


export const user_role = pgEnum('user_role', ['customer', 'provider', 'admin']);

export const vehicle_type = pgEnum('vehicle_type', [
  'car',
  'motorcycle',
  'cng',
  'truck',
  'bus',
  'other',
]);

export const service_type = pgEnum('service_type', [
  'mechanic',
  'towing',
  'tire',
  'battery',
  'fuel_delivery',
  'other',
]);

export const verification_status = pgEnum('verification_status', [
  'unverified',
  'pending',
  'approved',
  'rejected',
]);

export const request_status = pgEnum('request_status', [
  'pending',
  'accepted',
  'on_the_way',
  'arrived',
  'in_progress',
  'completed',
  'declined',
  'cancelled',
]);

export const payment_status = pgEnum('payment_status', ['unpaid', 'paid']);

export const document_type = pgEnum('document_type', ['nid', 'license', 'other']);

export const complaint_status = pgEnum('complaint_status', [
  'open',
  'in_review',
  'resolved',
]);


export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  clerk_id: text('clerk_id').notNull().unique(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  phone: text('phone'),
  role: user_role('role').notNull().default('customer'),
  profile_photo_url: text('profile_photo_url'),
  created_at: tstz('created_at').notNull().defaultNow(),
  updated_at: tstz('updated_at').notNull().defaultNow(),
});

export const vehicles = pgTable(
  'vehicles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    vehicle_type: vehicle_type('vehicle_type').notNull(),
    brand: text('brand').notNull(),
    model: text('model').notNull(),
    registration_number: text('registration_number').notNull(),
    year: integer('year'),
    color: text('color'),
    created_at: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('vehicles_user_id_registration_number_unique').on(
      t.user_id,
      t.registration_number,
    ),
  ],
);

export const providers = pgTable('providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  workshop_name: text('workshop_name').notNull(),
  workshop_address: text('workshop_address'),
  workshop_lat: doublePrecision('workshop_lat').notNull(),
  workshop_lng: doublePrecision('workshop_lng').notNull(),
  nid_or_license_number: text('nid_or_license_number'),
  verification_status: verification_status('verification_status')
    .notNull()
    .default('unverified'),
  is_online: boolean('is_online').notNull().default(false),
  current_lat: doublePrecision('current_lat'),
  current_lng: doublePrecision('current_lng'),
  location_updated_at: tstz('location_updated_at'),
  rating_avg: doublePrecision('rating_avg').notNull().default(0),
  rating_count: integer('rating_count').notNull().default(0),
  created_at: tstz('created_at').notNull().defaultNow(),
  updated_at: tstz('updated_at').notNull().defaultNow(),
});

export const provider_services = pgTable(
  'provider_services',
  {
    provider_id: uuid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    service_type: service_type('service_type').notNull(),
    base_price: integer('base_price'),
  },
  (t) => [primaryKey({ columns: [t.provider_id, t.service_type] })],
);

export const provider_documents = pgTable('provider_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider_id: uuid('provider_id')
    .notNull()
    .references(() => providers.id, { onDelete: 'cascade' }),
  doc_type: document_type('doc_type').notNull(),
  file_url: text('file_url').notNull(),
  created_at: tstz('created_at').notNull().defaultNow(),
});

export const service_requests = pgTable(
  'service_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customer_id: uuid('customer_id')
      .notNull()
      .references(() => users.id),
    provider_id: uuid('provider_id')
      .notNull()
      .references(() => providers.id),
    vehicle_id: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id, { onDelete: 'restrict' }),
    service_type: service_type('service_type').notNull(),
    problem_description: text('problem_description').notNull(),
    problem_photo_url: text('problem_photo_url'),
    customer_lat: doublePrecision('customer_lat').notNull(),
    customer_lng: doublePrecision('customer_lng').notNull(),
    customer_address: text('customer_address'),
    status: request_status('status').notNull().default('pending'),
    distance_km: doublePrecision('distance_km').notNull(),
    eta_minutes: integer('eta_minutes'),
    estimated_price: integer('estimated_price'),
    final_price: integer('final_price'),
    service_performed: text('service_performed'),
    provider_notes: text('provider_notes'),
    payment_status: payment_status('payment_status').notNull().default('unpaid'),
    created_at: tstz('created_at').notNull().defaultNow(),
    accepted_at: tstz('accepted_at'),
    declined_at: tstz('declined_at'),
    on_the_way_at: tstz('on_the_way_at'),
    arrived_at: tstz('arrived_at'),
    started_at: tstz('started_at'),
    completed_at: tstz('completed_at'),
    cancelled_at: tstz('cancelled_at'),
    updated_at: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('service_requests_customer_id_status_idx').on(t.customer_id, t.status),
    index('service_requests_provider_id_status_idx').on(t.provider_id, t.status),
  ],
);

export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    request_id: uuid('request_id')
      .notNull()
      .unique()
      .references(() => service_requests.id),
    customer_id: uuid('customer_id')
      .notNull()
      .references(() => users.id),
    provider_id: uuid('provider_id')
      .notNull()
      .references(() => providers.id),
    rating: integer('rating').notNull(),
    comment: text('comment'),
    created_at: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('reviews_rating_check', sql`${t.rating} >= 1 AND ${t.rating} <= 5`),
  ],
);

export const complaints = pgTable('complaints', {
  id: uuid('id').primaryKey().defaultRandom(),
  reporter_id: uuid('reporter_id')
    .notNull()
    .references(() => users.id),
  request_id: uuid('request_id').references(() => service_requests.id),
  provider_id: uuid('provider_id').references(() => providers.id),
  message: text('message').notNull(),
  status: complaint_status('status').notNull().default('open'),
  created_at: tstz('created_at').notNull().defaultNow(),
  resolved_at: tstz('resolved_at'),
});