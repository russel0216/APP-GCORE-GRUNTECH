import { Router } from 'express';
import { authenticate } from '../auth/middleware';

// Stub — filled by package D (academy, item 13). Mounted at /api/courses,
// /api/training-sessions, /api/passports and /api/academy-settings.
export const courseRoutes = Router();
courseRoutes.use(authenticate);

export const sessionRoutes = Router();
sessionRoutes.use(authenticate);

export const passportRoutes = Router();
passportRoutes.use(authenticate);

export const academySettingsRoutes = Router();
academySettingsRoutes.use(authenticate);
