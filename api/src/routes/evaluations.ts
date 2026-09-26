import { Router } from 'express';
import { authenticate } from '../auth/middleware';

// Stub — filled by package C (evaluations, item 12). Mounted at /api/evaluations
// so the API compiles while C builds it.
export const evaluationRoutes = Router();
evaluationRoutes.use(authenticate);
