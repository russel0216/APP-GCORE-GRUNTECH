import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import path from 'node:path';
import fs from 'node:fs';
import { env } from './env';
import { connectDb, prisma } from './prisma';
import { errorMiddleware, notFound } from './http/kit';
import { authRoutes } from './routes/auth';
import { appearanceRoutes } from './routes/appearance';
import { pdfTemplateRoutes } from './routes/pdfTemplates';
import { userRoutes, roleRoutes, departmentRoutes } from './routes/users';
import {
  companyRoutes,
  numberingRoutes,
  workflowRoutes,
  auditRoutes,
  settingRoutes,
} from './routes/admin';
import {
  notificationRoutes,
  searchRoutes,
  approvalRoutes,
  myWorkRoutes,
  attachmentRoutes,
  savedFilterRoutes,
  pdfRoutes,
} from './routes/workspace';
import { customerRoutes } from './routes/customers';
import {
  supplierRoutes,
  employeeRoutes,
  itemRoutes,
  referenceRoutes,
  warehouseRoutes,
} from './routes/masters';
import { importRoutes } from './routes/imports';
import { costingRoutes } from './routes/costing';
import {
  leadRoutes,
  quotationRoutes,
  activityRoutes,
  pipelineRoutes,
} from './routes/sales';
import { jobRoutes, budgetRequestRoutes } from './routes/jobs';
import { progressRoutes, billingRoutes, planRoutes } from './routes/progress';
import {
  purchaseRequestRoutes,
  canvassRoutes,
  purchaseOrderRoutes,
} from './routes/procurement';
import {
  receivingRoutes,
  stockIssueRoutes,
  borrowRoutes,
  inventoryRoutes,
} from './routes/warehouse';
import {
  clockRoutes,
  attendanceRoutes,
  leaveRoutes,
  overtimeRoutes,
  hrSettingsRoutes,
  hrReportRoutes,
} from './routes/hr';
import { warmUpFaceModels } from './shared/face';
import {
  invoiceRoutes,
  billRoutes,
  expenseRoutes,
  paymentRoutes,
  financeReportRoutes,
  financeSettingsRoutes,
} from './routes/finance';
import {
  assetRoutes,
  contractRoutes,
  visitRoutes,
  templateRoutes,
  serviceReportRoutes,
  aftermarketRoutes,
} from './routes/aftermarket';
import { insightRoutes } from './routes/insights';
import { gopsRoutes } from './routes/gops';
import { chainRoutes } from './routes/chain';
import { partnerRoutes } from './routes/partners';
import { quoteArchiveRoutes } from './routes/quoteArchive';
import { advanceRoutes } from './routes/advances';
import { jobOrderRoutes } from './routes/jobOrders';
import { positionRoutes } from './routes/positions';
import { clearanceRoutes, turnoverReportRoutes } from './routes/clearances';
import { meetingRoutes } from './routes/meetings';
import { evaluationRoutes } from './routes/evaluations';
import {
  courseRoutes,
  sessionRoutes,
  passportRoutes,
  academySettingsRoutes,
} from './routes/academy';
import { salesOrderRoutes } from './routes/salesOrders';
import { startActivityReminders } from './shared/activities';

const app = express();

app.disable('x-powered-by');
app.use(
  helmet({
    // The web build is served from this same origin in production; relaxing
    // CSP only for the SPA's own assets.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  }),
);
app.use(compression());
app.use(cors({ origin: env.corsOrigin, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
if (!env.isProduction) app.use(morgan('dev'));

app.get('/api/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, service: 'gcore-api', db: 'up' });
  } catch {
    res.status(503).json({ ok: false, service: 'gcore-api', db: 'down' });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/company', companyRoutes);
app.use('/api/numbering', numberingRoutes);
app.use('/api/workflows', workflowRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/settings', settingRoutes);
app.use('/api/appearance', appearanceRoutes);
app.use('/api/pdf-templates', pdfTemplateRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/approvals', approvalRoutes);
app.use('/api/my-work', myWorkRoutes);
app.use('/api/attachments', attachmentRoutes);
app.use('/api/saved-filters', savedFilterRoutes);
app.use('/api/pdf', pdfRoutes);

// Masters (Phase 2)
app.use('/api/customers', customerRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/items', itemRoutes);
app.use('/api/reference', referenceRoutes);
app.use('/api/warehouses', warehouseRoutes);
app.use('/api/imports', importRoutes);

// Sales (Phase 3)
app.use('/api/leads', leadRoutes);
app.use('/api/costings', costingRoutes);
app.use('/api/quotations', quotationRoutes);
app.use('/api/activities', activityRoutes);
app.use('/api/pipeline', pipelineRoutes);
app.use('/api/sales-orders', salesOrderRoutes);
app.use('/api/partners', partnerRoutes);
// The read-only SCORO quotation archive.
app.use('/api/quote-archive', quoteArchiveRoutes);

// Delivery (Phase 4)
app.use('/api/jobs', jobRoutes);
app.use('/api/jobs', planRoutes);
app.use('/api/budget-requests', budgetRequestRoutes);
app.use('/api/progress-reports', progressRoutes);
app.use('/api/billings', billingRoutes);

// G-CHAIN (Phase 5)
app.use('/api/purchase-requests', purchaseRequestRoutes);
app.use('/api/canvasses', canvassRoutes);
app.use('/api/purchase-orders', purchaseOrderRoutes);
app.use('/api/receivings', receivingRoutes);
app.use('/api/stock-issues', stockIssueRoutes);
app.use('/api/borrow-slips', borrowRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/gchain', chainRoutes);

// G-HR (Phase 6)
app.use('/api/clock', clockRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/leave', leaveRoutes);
app.use('/api/overtime', overtimeRoutes);
app.use('/api/hr-settings', hrSettingsRoutes);
app.use('/api/positions', positionRoutes);
app.use('/api/clearances', clearanceRoutes);
// The turnover report shares the hr-reports prefix; it mounts first so its
// own paths are matched before hrReportRoutes gets a look.
app.use('/api/hr-reports', turnoverReportRoutes);
app.use('/api/hr-reports', hrReportRoutes);
app.use('/api/meetings', meetingRoutes);
app.use('/api/evaluations', evaluationRoutes);
app.use('/api/courses', courseRoutes);
app.use('/api/training-sessions', sessionRoutes);
app.use('/api/passports', passportRoutes);
app.use('/api/academy-settings', academySettingsRoutes);

// G-FIN (Phase 7)
app.use('/api/invoices', invoiceRoutes);
app.use('/api/supplier-bills', billRoutes);
app.use('/api/expense-claims', expenseRoutes);
app.use('/api/cash-advances', advanceRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/finance-reports', financeReportRoutes);
app.use('/api/finance-settings', financeSettingsRoutes);

// Aftermarket (Phase 8)
app.use('/api/installed-assets', assetRoutes);
app.use('/api/service-contracts', contractRoutes);
app.use('/api/service-visits', visitRoutes);
app.use('/api/job-orders', jobOrderRoutes);
app.use('/api/report-templates', templateRoutes);
app.use('/api/service-reports', serviceReportRoutes);
app.use('/api/aftermarket', aftermarketRoutes);

// Insights (Phase 9) — read-only reporting across every division
app.use('/api/insights', insightRoutes);
app.use('/api/gops', gopsRoutes);

app.use('/api', (_req, _res, next) => next(notFound('No such endpoint')));

// In production this process also serves the built SPA, so there is one origin,
// one port and one tunnel — see docs/BUSINESS-OPERATIONS-MODEL.md §12.
const webDist = path.resolve(__dirname, '..', '..', 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

app.use(errorMiddleware);

async function start() {
  await connectDb();
  app.listen(env.port, () => {
    console.log(`G-CORE API listening on http://localhost:${env.port}`);
    console.log(`  health   http://localhost:${env.port}/api/health`);
    if (!fs.existsSync(webDist)) {
      console.log(`  web dev  http://localhost:5173  (run "npm run dev" in /web)`);
    }
  });

  // Loading the face models takes a few seconds. Doing it now rather than on
  // the first clock-in means nobody stands at the door thinking it is broken.
  // Deliberately not awaited — the API serves everything else meanwhile.
  void warmUpFaceModels();

  // Calendar reminders: G-CORE has no scheduler, so the API checks once a
  // minute for activities whose reminder is due (shared/activities.ts).
  startActivityReminders();
}

start().catch((err) => {
  console.error('Failed to start G-CORE API:', err);
  process.exit(1);
});

// Shut down cleanly. On the shared production server we must never be the
// process that lingers and gets killed by something broader.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}
