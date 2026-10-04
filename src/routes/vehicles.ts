import { Router } from 'express';
import type { Request, Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { vehicles } from '../db/schema';

const router = Router();

const VEHICLE_TYPES = ['car', 'motorcycle', 'cng', 'truck', 'bus', 'other'] as const;
type VehicleType = (typeof VEHICLE_TYPES)[number];

function is_vehicle_type(value: unknown): value is VehicleType {
  return typeof value === 'string' && VEHICLE_TYPES.includes(value as VehicleType);
}

function is_unique_violation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

function is_fk_violation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23503' || e?.cause?.code === '23503';
}

type ParseResult =
  | { ok: true; data: {
      vehicle_type: VehicleType;
      brand: string;
      model: string;
      registration_number: string;
      year: number | null;
      color: string | null;
    } }
  | { ok: false; message: string };

function parse_vehicle_body(body: unknown, require_all: boolean): ParseResult {
  if (!body || typeof body !== 'object') {
    return { ok: false, message: 'Invalid input' };
  }
  const b = body as Record<string, unknown>;

  if (require_all || b.vehicle_type !== undefined) {
    if (!is_vehicle_type(b.vehicle_type)) {
      return { ok: false, message: 'Invalid or missing vehicle_type' };
    }
  }
  if (require_all || b.brand !== undefined) {
    if (typeof b.brand !== 'string' || !b.brand.trim()) {
      return { ok: false, message: 'brand is required' };
    }
  }
  if (require_all || b.model !== undefined) {
    if (typeof b.model !== 'string' || !b.model.trim()) {
      return { ok: false, message: 'model is required' };
    }
  }
  if (require_all || b.registration_number !== undefined) {
    if (typeof b.registration_number !== 'string' || !b.registration_number.trim()) {
      return { ok: false, message: 'registration_number is required' };
    }
  }
  if (b.year !== undefined && b.year !== null && typeof b.year !== 'number') {
    return { ok: false, message: 'year must be a number or null' };
  }
  if (b.color !== undefined && b.color !== null && typeof b.color !== 'string') {
    return { ok: false, message: 'color must be a string or null' };
  }

  return {
    ok: true,
    data: {
      vehicle_type: b.vehicle_type as VehicleType,
      brand: (b.brand as string)?.trim(),
      model: (b.model as string)?.trim(),
      registration_number: (b.registration_number as string)?.trim(),
      year: b.year === undefined ? null : (b.year as number | null),
      color: b.color === undefined ? null : ((b.color as string | null)?.toString().trim() ?? null),
    },
  };
}

// GET /api/vehicles
router.get('/', async (req: Request, res: Response) => {
  const user = req.user!;
  const rows = await db.select().from(vehicles).where(eq(vehicles.user_id, user.id));
  res.json({ vehicles: rows });
});

// POST /api/vehicles
router.post('/', async (req: Request, res: Response) => {
  const user = req.user!;
  const parsed = parse_vehicle_body(req.body, true);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.message });
    return;
  }

  try {
    const [created] = await db
      .insert(vehicles)
      .values({ user_id: user.id, ...parsed.data })
      .returning();
    res.json({ vehicle: created });
  } catch (err) {
    if (is_unique_violation(err)) {
      res.status(409).json({ error: 'You already have a vehicle with this registration number' });
      return;
    }
    throw err;
  }
});

// PATCH /api/vehicles/:id
router.patch('/:id', async (req: Request, res: Response) => {
  const user = req.user!;
  const { id } = req.params;
  const vehicleId = Array.isArray(id) ? id[0] : id;

  const [existing] = await db
    .select()
    .from(vehicles)
    .where(and(eq(vehicles.id, vehicleId), eq(vehicles.user_id, user.id)))
    .limit(1);

  if (!existing) {
    res.status(404).json({ error: 'Vehicle not found' });
    return;
  }

  const parsed = parse_vehicle_body(req.body, false);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.message });
    return;
  }

  const updates: Partial<typeof vehicles.$inferInsert> = {};
  const body = req.body as Record<string, unknown>;
  if (body.vehicle_type !== undefined) updates.vehicle_type = parsed.data.vehicle_type;
  if (body.brand !== undefined) updates.brand = parsed.data.brand;
  if (body.model !== undefined) updates.model = parsed.data.model;
  if (body.registration_number !== undefined) updates.registration_number = parsed.data.registration_number;
  if (body.year !== undefined) updates.year = parsed.data.year;
  if (body.color !== undefined) updates.color = parsed.data.color;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  try {
    const [updated] = await db
      .update(vehicles)
      .set(updates)
      .where(eq(vehicles.id, vehicleId))
      .returning();
    res.json({ vehicle: updated });
  } catch (err) {
    if (is_unique_violation(err)) {
      res.status(409).json({ error: 'You already have a vehicle with this registration number' });
      return;
    }
    throw err;
  }
});

// DELETE /api/vehicles/:id
router.delete('/:id', async (req: Request, res: Response) => {
  const user = req.user!;
  const { id } = req.params;
  const vehicleId = Array.isArray(id) ? id[0] : id;

  const [existing] = await db
    .select()
    .from(vehicles)
    .where(and(eq(vehicles.id, vehicleId), eq(vehicles.user_id, user.id)))
    .limit(1);

  if (!existing) {
    res.status(404).json({ error: 'Vehicle not found' });
    return;
  }

  try {
    await db.delete(vehicles).where(eq(vehicles.id, vehicleId));
    res.json({ ok: true });
  } catch (err) {
    if (is_fk_violation(err)) {
      res.status(409).json({ error: 'This vehicle has requests and cannot be deleted' });
      return;
    }
    throw err;
  }
});

export default router;