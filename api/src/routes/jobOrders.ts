import { Router } from 'express';
import { authenticate } from '../auth/middleware';

// Stub — filled by package SVC (item 9, job orders). Mounted at /api/job-orders
// so the API compiles while SVC builds it.
export const jobOrderRoutes = Router();
jobOrderRoutes.use(authenticate);
