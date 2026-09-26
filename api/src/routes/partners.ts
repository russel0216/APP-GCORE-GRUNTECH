import { Router } from 'express';
import { authenticate } from '../auth/middleware';

// Stub — filled by package P2 (masters: items 4 and 10). Mounted at /api/partners
// so the API compiles and the menu entry lands somewhere while P2 builds it.
export const partnerRoutes = Router();
partnerRoutes.use(authenticate);
