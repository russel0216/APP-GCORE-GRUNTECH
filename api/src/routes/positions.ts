import { Router } from 'express';
import { authenticate } from '../auth/middleware';

// Stub — filled by package A (plantilla-clearance, item 3). Mounted at
// /api/positions so the API compiles while A builds it.
export const positionRoutes = Router();
positionRoutes.use(authenticate);
