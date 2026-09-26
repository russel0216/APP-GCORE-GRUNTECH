import { Router } from 'express';
import { authenticate } from '../auth/middleware';

// Stub — filled by package B (meetings, item 11). Mounted at /api/meetings so
// the API compiles while B builds it.
export const meetingRoutes = Router();
meetingRoutes.use(authenticate);
