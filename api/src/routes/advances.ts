import { Router } from 'express';
import { authenticate } from '../auth/middleware';

// Stub — filled by package FIN (cash advances and liquidations). Mounted at
// /api/cash-advances so the API compiles while FIN builds it.
export const advanceRoutes = Router();
advanceRoutes.use(authenticate);
