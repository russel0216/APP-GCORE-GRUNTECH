import { Router } from 'express';
import { authenticate } from '../auth/middleware';

// Stub — filled by package A (plantilla-clearance, item 3). Mounted at
// /api/clearances and, for the turnover report, /api/hr-reports.
export const clearanceRoutes = Router();
clearanceRoutes.use(authenticate);

export const turnoverReportRoutes = Router();
turnoverReportRoutes.use(authenticate);
