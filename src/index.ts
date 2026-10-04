import 'dotenv/config';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { clerkMiddleware } from '@clerk/express';
import { sql } from 'drizzle-orm';
import { db } from './db';
import { requireUser } from './middleware/auth';
import authRoutes from './routes/auth';
import meRoutes from './routes/me';
import providerRoutes from './routes/provider';
import requestRoutes from './routes/requests';
import vehicleRoutes from './routes/vehicles';
import providersRoutes from './routes/providers';
import complaintRoutes from './routes/complaints';
import adminRoutes from './routes/admin';

const app = express();

app.use(cors());
app.use(express.json());

// ---------- Health (no login needed) ----------
app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.get('/health/db', async (_req: Request, res: Response) => {
  try {
    await db.execute(sql`select 1`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Database check failed:', err);
    res.status(500).json({ error: 'Database connection failed' });
  }
});

// ---------- Clerk ----------
app.use(clerkMiddleware());

// ---------- API ----------
// Only /api/auth/sync works without a users row, so it comes first
app.use('/api/auth', authRoutes);

// Every route below needs a valid login AND a users row
app.use('/api', requireUser);
app.use('/api/me', meRoutes);
app.use('/api/provider', providerRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/providers', providersRoutes);
app.use('/api/complaints', complaintRoutes);
app.use('/api/admin', adminRoutes);


// Unknown route
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Any other error
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

const port = Number(process.env.PORT) || 5000;

app.listen(port, () => {
  console.log(`API running on port ${port}`);
});