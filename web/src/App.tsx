import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { ToastProvider, Loading } from './components/ui';
import { Shell } from './components/Shell';
import { Login } from './pages/Login';
import { ForgotPassword, ResetPassword, Welcome } from './pages/AccountLinks';
import { Home } from './pages/Home';
import { FileViewer } from './pages/FileViewer';
import { MyWork } from './pages/MyWork';
import { Account, SystemSettings, ComingSoon } from './pages/Misc';
import { OpsDashboard } from './pages/OpsDashboard';
import { Users } from './pages/admin/Users';
import { Roles } from './pages/admin/Roles';
import { Company } from './pages/admin/Company';
import { Appearance } from './pages/admin/Appearance';
import { Numbering } from './pages/admin/Numbering';
import { Workflows } from './pages/admin/Workflows';
import { Audit } from './pages/admin/Audit';
import { PdfTemplates } from './pages/admin/PdfTemplates';
import { PipelineStages } from './pages/admin/PipelineStages';
import { Customers } from './pages/masters/Customers';
import { Customer360Page } from './pages/masters/Customer360';
import { Suppliers, SupplierDetail } from './pages/masters/Suppliers';
import { Employees } from './pages/masters/Employees';
import { Items } from './pages/masters/Items';
import { Categories, Warehouses } from './pages/masters/Reference';
import { SalesOrders, SalesOrderDetail, SalesOrderEditor } from './pages/sales/SalesOrders';
import { Leads, LeadDetail } from './pages/sales/Leads';
import { Costings } from './pages/sales/Costings';
import { CostingDetailPage } from './pages/sales/CostingDetail';
import { CostingSheet } from './pages/sales/CostingSheet';
import { Quotations, QuotationDetail } from './pages/sales/Quotations';
import { QuotationEditor } from './pages/sales/QuotationEditor';
import { SalesCalendar } from './pages/sales/Calendar';
import { ActivityPage } from './pages/sales/ActivityPage';
import { Pipeline } from './pages/sales/Pipeline';
import { Forecast } from './pages/sales/Forecast';
import { Partners, PartnerDetail } from './pages/sales/Partners';
import { QuoteArchive, QuoteArchiveDetail } from './pages/sales/QuoteArchive';
import { Projects } from './pages/delivery/Projects';
import { ProjectWorkspace } from './pages/delivery/ProjectWorkspace';
import {
  ProgressReports,
  ProgressReportDetail,
  BillingDetailPage,
  BudgetMonitoring,
  PlansRegister,
} from './pages/delivery/Progress';
import { PurchaseRequests, PurchaseRequestDetail } from './pages/chain/PurchaseRequests';
import {
  Canvasses,
  CanvassDetail,
  PurchaseOrders,
  PurchaseOrderDetail,
} from './pages/chain/Orders';
import {
  Receivings,
  ReceivingDetail,
  StockIssues,
  StockIssueDetail,
  BorrowSlips,
  BorrowSlipDetail,
  Inventory,
  StockCard,
  ChainReports,
  ChainDashboard,
} from './pages/chain/Warehouse';
import { Clock } from './pages/hr/Clock';
import { HrDashboard, AttendanceRegister } from './pages/hr/Dashboard';
import { Leave } from './pages/hr/Leave';
import { Overtime, OvertimeDetail } from './pages/hr/Overtime';
import { HrSettingsPage } from './pages/hr/Settings';
import { HrReports } from './pages/hr/Reports';
import { Plantilla } from './pages/hr/Plantilla';
import { Clearances, ClearanceDetail } from './pages/hr/Clearances';
import { Meetings, MeetingDetail } from './pages/hr/Meetings';
import { Evaluations, EvaluationDetail } from './pages/hr/Evaluations';
import { Courses } from './pages/hr/academy/Courses';
import { TrainingCalendar } from './pages/hr/academy/TrainingCalendar';
import { Sessions, SessionDetail } from './pages/hr/academy/Sessions';
import { Passport } from './pages/hr/academy/Passport';
import { Passports } from './pages/hr/academy/Passports';
import { Receivables, InvoiceDetail, Payments } from './pages/finance/Receivables';
import { Payables, BillDetail } from './pages/finance/Payables';
import { Expenses, ExpenseClaimDetail } from './pages/finance/Expenses';
import { CashAdvances, CashAdvanceDetail } from './pages/finance/CashAdvances';
import { BudgetRequests, BudgetRequestDetail, FinanceBudgetRequests } from './pages/delivery/BudgetRequests';
import {
  FinanceDashboard,
  FinanceReports,
  CashFlow,
  BudgetVsActual,
  FinanceSettings,
} from './pages/finance/Reports';
import { InstalledBase, AssetDetailPage } from './pages/service/InstalledBase';
import { ServiceContracts, ContractDetail } from './pages/service/Contracts';
import { ServiceReports, ServiceReportDetail, Renewals } from './pages/service/Reports';
import { ServiceSchedule } from './pages/service/Schedule';
import { JobOrders, JobOrderDetail } from './pages/service/JobOrders';
import { CadJobOrders, CadJobOrderDetail } from './pages/delivery/CadJobOrders';
import {
  ReportTemplates,
  AftermarketDashboard,
  ServiceCosting,
} from './pages/service/Templates';
import { CompanyOverview, Profitability } from './pages/insights/Overview';
import {
  SalesAnalytics,
  CashForecast,
  InventoryAnalytics,
  PerformanceReport,
} from './pages/insights/Reports';

/**
 * Route guard. Permission checks live on the server — this only decides what to
 * render, so a user who types a URL they lack access to sees the same refusal
 * the API would give rather than a broken screen.
 */
function Guard({ permission, children }: { permission: string; children: React.ReactNode }) {
  const { can } = useAuth();
  if (!can(permission)) {
    return (
      <div className="card">
        <h3 className="card-title">No access</h3>
        <p className="muted" style={{ marginBottom: 0 }}>
          You do not have permission to open this screen. Ask an administrator for{' '}
          <span className="mono">{permission}</span>.
        </p>
      </div>
    );
  }
  return <>{children}</>;
}

/**
 * For screens where either view scope is enough — a salesperson with only
 * `view_own` still opens the list, and the server narrows it to their records.
 */
function GuardAny({ permissions, children }: { permissions: string[]; children: React.ReactNode }) {
  const { can } = useAuth();
  if (!permissions.some((p) => can(p))) {
    return (
      <div className="card">
        <h3 className="card-title">No access</h3>
        <p className="muted" style={{ marginBottom: 0 }}>
          You do not have permission to open this screen. Ask an administrator for{' '}
          {permissions.map((p, i) => (
            <span key={p}>
              {i > 0 && ' or '}
              <span className="mono">{p}</span>
            </span>
          ))}
          .
        </p>
      </div>
    );
  }
  return <>{children}</>;
}

/**
 * The pages that open from a link before anyone can sign in — an invitation,
 * a reset, "Forgot password?" — whether or not somebody is signed in already.
 */
const SIGNED_OUT_PAGES: Record<string, () => JSX.Element> = {
  '/welcome': Welcome,
  '/reset-password': ResetPassword,
  '/forgot-password': ForgotPassword,
};

function Routed() {
  const { me, loading } = useAuth();
  const { pathname } = useLocation();

  const SignedOutPage = SIGNED_OUT_PAGES[pathname.replace(/\/+$/, '') || '/'];
  if (SignedOutPage) return <SignedOutPage />;

  if (loading) {
    return (
      <div className="landing">
        <div style={{ margin: 'auto' }}>
          <Loading label="Starting G-CORE…" />
        </div>
      </div>
    );
  }

  if (!me) return <Login />;

  return (
    <Routes>
      {/* A stored spreadsheet, read in its own tab and at full width — the
          sheet needs the room the menu would take. The file route behind it
          keeps each record's own guard. */}
      <Route path="/files/:id" element={<FileViewer />} />
      <Route element={<Shell />}>
        <Route path="/" element={<Home />} />
        <Route path="/my-work" element={<MyWork />} />
        <Route path="/my-work/*" element={<MyWork />} />
        <Route path="/account" element={<Account />} />

        <Route
          path="/admin/users"
          element={
            <Guard permission="admin.users.view_all">
              <Users />
            </Guard>
          }
        />
        <Route
          path="/admin/users/:id"
          element={
            <Guard permission="admin.users.view_all">
              <Users />
            </Guard>
          }
        />
        <Route
          path="/admin/roles"
          element={
            <Guard permission="admin.roles.view_all">
              <Roles />
            </Guard>
          }
        />
        <Route
          path="/admin/company"
          element={
            <Guard permission="admin.company.view_all">
              <Company />
            </Guard>
          }
        />
        <Route
          path="/admin/appearance"
          element={
            <Guard permission="admin.appearance.view_all">
              <Appearance />
            </Guard>
          }
        />
        <Route
          path="/admin/numbering"
          element={
            <Guard permission="admin.numbering.view_all">
              <Numbering />
            </Guard>
          }
        />
        <Route
          path="/admin/workflows"
          element={
            <Guard permission="admin.workflows.view_all">
              <Workflows />
            </Guard>
          }
        />
        <Route
          path="/admin/audit"
          element={
            <Guard permission="admin.audit.view_all">
              <Audit />
            </Guard>
          }
        />
        <Route
          path="/admin/pdf-templates"
          element={
            <Guard permission="admin.pdf_templates.view_all">
              <PdfTemplates />
            </Guard>
          }
        />
        <Route
          path="/admin/pipeline-stages"
          element={
            <Guard permission="admin.pipeline_stages.view_all">
              <PipelineStages />
            </Guard>
          }
        />
        <Route
          path="/admin/settings"
          element={
            <Guard permission="admin.settings.view_all">
              <SystemSettings />
            </Guard>
          }
        />
        <Route
          path="/admin/categories"
          element={
            <Guard permission="admin.categories.view_all">
              <Categories />
            </Guard>
          }
        />

        {/* Masters (Phase 2) */}
        <Route
          path="/g-ops/customers"
          element={
            <Guard permission="gops.customers.view_all">
              <Customers />
            </Guard>
          }
        />
        <Route
          path="/g-ops/customers/:id"
          element={
            <Guard permission="gops.customers.view_all">
              <Customer360Page />
            </Guard>
          }
        />
        <Route
          path="/g-chain/suppliers"
          element={
            <Guard permission="gchain.suppliers.view_all">
              <Suppliers />
            </Guard>
          }
        />
        <Route
          path="/g-chain/suppliers/:id"
          element={
            <Guard permission="gchain.suppliers.view_all">
              <SupplierDetail />
            </Guard>
          }
        />
        <Route
          path="/g-chain/items"
          element={
            <Guard permission="gchain.items.view_all">
              <Items />
            </Guard>
          }
        />
        <Route
          path="/g-chain/items/:id"
          element={
            <Guard permission="gchain.items.view_all">
              <Items />
            </Guard>
          }
        />
        <Route
          path="/g-chain/warehouses"
          element={
            <Guard permission="gchain.warehouses.view_all">
              <Warehouses />
            </Guard>
          }
        />
        <Route
          path="/g-hr/employees"
          element={
            <Guard permission="ghr.employees.view_all">
              <Employees />
            </Guard>
          }
        />
        <Route
          path="/g-hr/employees/:id"
          element={
            <Guard permission="ghr.employees.view_all">
              <Employees />
            </Guard>
          }
        />

        {/* Sales (Phase 3) */}
        <Route
          path="/g-ops/leads"
          element={
            <GuardAny permissions={['gops.leads.view_all', 'gops.leads.view_own']}>
              <Leads />
            </GuardAny>
          }
        />
        <Route
          path="/g-ops/leads/:id"
          element={
            <GuardAny permissions={['gops.leads.view_all', 'gops.leads.view_own']}>
              <LeadDetail />
            </GuardAny>
          }
        />
        <Route
          path="/g-ops/sales-orders"
          element={
            <GuardAny permissions={['gops.sales_orders.view_all', 'gops.sales_orders.view_own']}>
              <SalesOrders />
            </GuardAny>
          }
        />
        <Route
          path="/g-ops/sales-orders/:id"
          element={
            <GuardAny permissions={['gops.sales_orders.view_all', 'gops.sales_orders.view_own']}>
              <SalesOrderDetail />
            </GuardAny>
          }
        />
        <Route
          path="/g-ops/sales-orders/:id/edit"
          element={
            <GuardAny permissions={['gops.sales_orders.view_all', 'gops.sales_orders.view_own']}>
              <SalesOrderEditor />
            </GuardAny>
          }
        />
        <Route
          path="/g-ops/costing"
          element={
            <GuardAny permissions={['gops.costing.view_all', 'gops.costing.view_own']}>
              <Costings />
            </GuardAny>
          }
        />
        {/*
          The costing sheet, a page rather than a dialog. `/new` is a static
          segment, so React Router ranks it above `/:id`. Editing is refused by
          the API to anyone but the author or an edit_all holder, and to a
          costing that is final or with the approver; the page says which.
        */}
        <Route
          path="/g-ops/costing/new"
          element={
            <GuardAny permissions={['gops.costing.view_all', 'gops.costing.view_own']}>
              <Guard permission="gops.costing.create">
                <CostingSheet />
              </Guard>
            </GuardAny>
          }
        />
        <Route
          path="/g-ops/costing/:id"
          element={
            <GuardAny permissions={['gops.costing.view_all', 'gops.costing.view_own']}>
              <CostingDetailPage />
            </GuardAny>
          }
        />
        <Route
          path="/g-ops/costing/:id/edit"
          element={
            <GuardAny permissions={['gops.costing.view_all', 'gops.costing.view_own']}>
              <CostingSheet key="edit" />
            </GuardAny>
          }
        />
        <Route
          path="/g-ops/quotations"
          element={
            <GuardAny permissions={['gops.quotations.view_all', 'gops.quotations.view_own']}>
              <Quotations />
            </GuardAny>
          }
        />
        {/*
          The full-page editor (SCORO's "Modify quote details"). `/new` is a
          static segment, so React Router ranks it above `/:id` — it is never
          read as a quotation id. Editing is refused by the API to anyone but
          the author or an edit_all holder; the page says so rather than guessing.
        */}
        <Route
          path="/g-ops/quotations/new"
          element={
            <GuardAny permissions={['gops.quotations.view_all', 'gops.quotations.view_own']}>
              <Guard permission="gops.quotations.create">
                <QuotationEditor />
              </Guard>
            </GuardAny>
          }
        />
        <Route
          path="/g-ops/quotations/:id"
          element={
            <GuardAny permissions={['gops.quotations.view_all', 'gops.quotations.view_own']}>
              <QuotationDetail />
            </GuardAny>
          }
        />
        <Route
          path="/g-ops/quotations/:id/edit"
          element={
            <GuardAny permissions={['gops.quotations.view_all', 'gops.quotations.view_own']}>
              <QuotationEditor />
            </GuardAny>
          }
        />
        {/* The read-only SCORO quotation history. */}
        <Route
          path="/g-ops/quote-archive"
          element={
            <Guard permission="gops.quote_archive.view_all">
              <QuoteArchive />
            </Guard>
          }
        />
        <Route
          path="/g-ops/quote-archive/:id"
          element={
            <Guard permission="gops.quote_archive.view_all">
              <QuoteArchiveDetail />
            </Guard>
          }
        />
        <Route
          path="/g-ops/calendar"
          element={
            <Guard permission="gops.calendar.view_all">
              <SalesCalendar />
            </Guard>
          }
        />
        <Route
          path="/g-ops/calendar/activities/:id"
          element={
            <Guard permission="gops.calendar.view_all">
              <ActivityPage />
            </Guard>
          }
        />
        <Route
          path="/g-ops/pipeline"
          element={
            <Guard permission="gops.pipeline.view_all">
              <Pipeline />
            </Guard>
          }
        />
        {/* The Forecast: open quotations by expected closing date, by period. */}
        <Route
          path="/g-ops/forecast"
          element={
            <Guard permission="gops.forecast.view_all">
              <Forecast />
            </Guard>
          }
        />
        {/* Principals and OEM brands Gruntech represents — a supplier flagged
            as a partner, viewed from Sales. */}
        <Route
          path="/g-ops/partners"
          element={
            <Guard permission="gops.partners.view_all">
              <Partners />
            </Guard>
          }
        />
        <Route
          path="/g-ops/partners/:id"
          element={
            <Guard permission="gops.partners.view_all">
              <PartnerDetail />
            </Guard>
          }
        />

        {/* Delivery (Phase 4) */}
        <Route
          path="/g-ops/projects"
          element={
            <GuardAny permissions={['gops.projects.view_all', 'gops.projects.view_own']}>
              <Projects />
            </GuardAny>
          }
        />
        <Route
          path="/g-ops/projects/:id"
          element={
            <GuardAny permissions={['gops.projects.view_all', 'gops.projects.view_own']}>
              <ProjectWorkspace />
            </GuardAny>
          }
        />
        <Route
          path="/g-ops/progress"
          element={
            <GuardAny permissions={['gops.progress_billing.view_all', 'gops.progress_billing.view_own']}>
              <ProgressReports />
            </GuardAny>
          }
        />
        <Route
          path="/g-ops/progress/:id"
          element={
            <GuardAny permissions={['gops.progress_billing.view_all', 'gops.progress_billing.view_own']}>
              <ProgressReportDetail />
            </GuardAny>
          }
        />
        <Route
          path="/g-ops/billings/:id"
          element={
            <GuardAny permissions={['gops.progress_billing.view_all', 'gops.progress_billing.view_own']}>
              <BillingDetailPage />
            </GuardAny>
          }
        />
        <Route
          path="/g-ops/budget-requests"
          element={
            <GuardAny permissions={['gops.budget_requests.view_all', 'gops.budget_requests.view_own']}>
              <BudgetRequests />
            </GuardAny>
          }
        />
        {/* One request: the project side's page, where finance releases and the team liquidates. */}
        <Route
          path="/g-ops/budget-requests/:id"
          element={
            <GuardAny permissions={['gops.budget_requests.view_all', 'gops.budget_requests.view_own', 'gfin.budget_requests.view_all']}>
              <BudgetRequestDetail />
            </GuardAny>
          }
        />
        <Route
          path="/g-ops/budget-monitoring"
          element={
            <Guard permission="gops.budget_monitoring.view_all">
              <BudgetMonitoring />
            </Guard>
          }
        />
        <Route
          path="/g-ops/plans"
          element={
            <Guard permission="gops.plans.view_all">
              <PlansRegister />
            </Guard>
          }
        />

        {/* G-CHAIN (Phase 5) */}
        <Route
          path="/g-ops"
          element={
            <Guard permission="gops.dashboard.view_all">
              <OpsDashboard />
            </Guard>
          }
        />
        <Route
          path="/g-chain"
          element={
            <Guard permission="gchain.dashboard.view_all">
              <ChainDashboard />
            </Guard>
          }
        />
        <Route
          path="/g-chain/purchase-requests"
          element={
            <GuardAny permissions={['gchain.purchase_requests.view_all', 'gchain.purchase_requests.view_own']}>
              <PurchaseRequests />
            </GuardAny>
          }
        />
        {/*
            The same screen under G-OPS, because the registry lists Purchase
            Requests in both menus and means it: a project manager raises one
            against a job, procurement works it. It had no route here at all,
            so the Delivery menu entry fell through to "Not built yet" — the
            registry promised a screen the app never rendered.

            Its own path, so the menu can highlight it and the sidebar stays in
            G-OPS; and either module's permission opens it, since the two menu
            entries are the two ways into one register.
        */}
        <Route
          path="/g-ops/purchase-requests"
          element={
            <GuardAny
              permissions={[
                'gops.purchase_requests.view_all',
                'gops.purchase_requests.view_own',
                'gchain.purchase_requests.view_all',
                'gchain.purchase_requests.view_own',
              ]}
            >
              <PurchaseRequests />
            </GuardAny>
          }
        />
        {/* The detail page under both modules too, for the same reason: a
            project manager who raised a PR from the Delivery menu opens it
            from the Delivery menu, and either module's permission is enough. */}
        <Route
          path="/g-ops/purchase-requests/:id"
          element={
            <GuardAny
              permissions={[
                'gops.purchase_requests.view_all',
                'gops.purchase_requests.view_own',
                'gchain.purchase_requests.view_all',
                'gchain.purchase_requests.view_own',
              ]}
            >
              <PurchaseRequestDetail />
            </GuardAny>
          }
        />
        <Route
          path="/g-chain/purchase-requests/:id"
          element={
            <GuardAny
              permissions={[
                'gops.purchase_requests.view_all',
                'gops.purchase_requests.view_own',
                'gchain.purchase_requests.view_all',
                'gchain.purchase_requests.view_own',
              ]}
            >
              <PurchaseRequestDetail />
            </GuardAny>
          }
        />
        <Route
          path="/g-chain/canvass"
          element={
            <GuardAny permissions={['gchain.canvass.view_all', 'gchain.canvass.view_own']}>
              <Canvasses />
            </GuardAny>
          }
        />
        <Route
          path="/g-chain/canvass/:id"
          element={
            <GuardAny permissions={['gchain.canvass.view_all', 'gchain.canvass.view_own']}>
              <CanvassDetail />
            </GuardAny>
          }
        />
        <Route
          path="/g-chain/purchase-orders"
          element={
            <GuardAny permissions={['gchain.purchase_orders.view_all', 'gchain.purchase_orders.view_own']}>
              <PurchaseOrders />
            </GuardAny>
          }
        />
        <Route
          path="/g-chain/purchase-orders/:id"
          element={
            <GuardAny permissions={['gchain.purchase_orders.view_all', 'gchain.purchase_orders.view_own']}>
              <PurchaseOrderDetail />
            </GuardAny>
          }
        />
        <Route
          path="/g-chain/receiving"
          element={
            <Guard permission="gchain.receiving.view_all">
              <Receivings />
            </Guard>
          }
        />
        <Route
          path="/g-chain/receiving/:id"
          element={
            <Guard permission="gchain.receiving.view_all">
              <ReceivingDetail />
            </Guard>
          }
        />
        <Route
          path="/g-chain/stock-issuance"
          element={
            <Guard permission="gchain.stock_issuance.view_all">
              <StockIssues />
            </Guard>
          }
        />
        <Route
          path="/g-chain/stock-issuance/:id"
          element={
            <Guard permission="gchain.stock_issuance.view_all">
              <StockIssueDetail />
            </Guard>
          }
        />
        <Route
          path="/g-chain/borrow-slips"
          element={
            <Guard permission="gchain.borrow_slips.view_all">
              <BorrowSlips />
            </Guard>
          }
        />
        <Route
          path="/g-chain/borrow-slips/:id"
          element={
            <Guard permission="gchain.borrow_slips.view_all">
              <BorrowSlipDetail />
            </Guard>
          }
        />
        <Route
          path="/g-chain/inventory"
          element={
            <Guard permission="gchain.inventory.view_all">
              <Inventory />
            </Guard>
          }
        />
        <Route
          path="/g-chain/inventory/:itemId"
          element={
            <Guard permission="gchain.inventory.view_all">
              <StockCard />
            </Guard>
          }
        />
        <Route
          path="/g-chain/reports"
          element={
            <Guard permission="gchain.reports.view_all">
              <ChainReports />
            </Guard>
          }
        />

        {/* G-HR (Phase 6) */}
        {/* The clock is deliberately ungated: "any one who access the web
            application can clock in clock out". */}
        <Route path="/g-hr/clock" element={<Clock />} />
        <Route
          path="/g-hr"
          element={
            <Guard permission="ghr.dashboard.view_all">
              <HrDashboard />
            </Guard>
          }
        />
        <Route
          path="/g-hr/attendance"
          element={
            <Guard permission="ghr.dashboard.view_all">
              <AttendanceRegister />
            </Guard>
          }
        />
        <Route
          path="/g-hr/leave"
          element={
            <GuardAny permissions={['ghr.leave.view_all', 'ghr.leave.view_own']}>
              <Leave />
            </GuardAny>
          }
        />
        {/* A leave request has a URL of its own, so an approval notification
            lands on the request rather than on the register. */}
        <Route
          path="/g-hr/leave/:id"
          element={
            <GuardAny permissions={['ghr.leave.view_all', 'ghr.leave.view_own']}>
              <Leave />
            </GuardAny>
          }
        />
        <Route
          path="/g-hr/overtime"
          element={
            <GuardAny permissions={['ghr.overtime.view_all', 'ghr.overtime.view_own']}>
              <Overtime />
            </GuardAny>
          }
        />
        <Route
          path="/g-hr/overtime/:id"
          element={
            <GuardAny permissions={['ghr.overtime.view_all', 'ghr.overtime.view_own']}>
              <OvertimeDetail />
            </GuardAny>
          }
        />
        <Route
          path="/g-hr/reports"
          element={
            <Guard permission="ghr.reports.view_all">
              <HrReports />
            </Guard>
          }
        />
        <Route
          path="/g-hr/settings"
          element={
            <Guard permission="ghr.settings.view_all">
              <HrSettingsPage />
            </Guard>
          }
        />
        {/* Hire-to-separate: the plantilla, evaluations, clearances and
            meetings. All before the /g-hr/* catch-all below. */}
        <Route
          path="/g-hr/plantilla"
          element={
            <Guard permission="ghr.plantilla.view_all">
              <Plantilla />
            </Guard>
          }
        />
        <Route
          path="/g-hr/clearances"
          element={
            <GuardAny permissions={['ghr.clearances.view_all', 'ghr.clearances.view_own']}>
              <Clearances />
            </GuardAny>
          }
        />
        <Route
          path="/g-hr/clearances/:id"
          element={
            <GuardAny permissions={['ghr.clearances.view_all', 'ghr.clearances.view_own']}>
              <ClearanceDetail />
            </GuardAny>
          }
        />
        <Route
          path="/g-hr/meetings"
          element={
            <GuardAny permissions={['ghr.meetings.view_all', 'ghr.meetings.view_own']}>
              <Meetings />
            </GuardAny>
          }
        />
        <Route
          path="/g-hr/meetings/:id"
          element={
            <GuardAny permissions={['ghr.meetings.view_all', 'ghr.meetings.view_own']}>
              <MeetingDetail />
            </GuardAny>
          }
        />
        <Route
          path="/g-hr/evaluations"
          element={
            <GuardAny permissions={['ghr.evaluations.view_all', 'ghr.evaluations.view_own']}>
              <Evaluations />
            </GuardAny>
          }
        />
        <Route
          path="/g-hr/evaluations/:id"
          element={
            <GuardAny permissions={['ghr.evaluations.view_all', 'ghr.evaluations.view_own']}>
              <EvaluationDetail />
            </GuardAny>
          }
        />
        {/* Gruntech Academy */}
        <Route
          path="/g-hr/academy/courses"
          element={
            <Guard permission="ghr.courses.view_all">
              <Courses />
            </Guard>
          }
        />
        <Route
          path="/g-hr/academy/calendar"
          element={
            <Guard permission="ghr.training_calendar.view_all">
              <TrainingCalendar />
            </Guard>
          }
        />
        <Route
          path="/g-hr/academy/sessions"
          element={
            <GuardAny permissions={['ghr.training_sessions.view_all', 'ghr.training_sessions.view_own']}>
              <Sessions />
            </GuardAny>
          }
        />
        <Route
          path="/g-hr/academy/sessions/:id"
          element={
            <GuardAny permissions={['ghr.training_sessions.view_all', 'ghr.training_sessions.view_own']}>
              <SessionDetail />
            </GuardAny>
          }
        />
        <Route
          path="/g-hr/academy/passport"
          element={
            <GuardAny permissions={['ghr.passport.view_own', 'ghr.passports.view_all']}>
              <Passport />
            </GuardAny>
          }
        />
        <Route
          path="/g-hr/academy/passports"
          element={
            <Guard permission="ghr.passports.view_all">
              <Passports />
            </Guard>
          }
        />
        <Route
          path="/g-hr/academy/passports/:employeeId"
          element={
            <GuardAny permissions={['ghr.passports.view_all', 'ghr.passport.view_own']}>
              <Passport />
            </GuardAny>
          }
        />

        {/* G-FIN (Phase 7) */}
        <Route
          path="/g-fin"
          element={
            <Guard permission="gfin.dashboard.view_all">
              <FinanceDashboard />
            </Guard>
          }
        />
        <Route
          path="/g-fin/ar"
          element={
            <Guard permission="gfin.ar.view_all">
              <Receivables />
            </Guard>
          }
        />
        <Route
          path="/g-fin/ar/:id"
          element={
            <Guard permission="gfin.ar.view_all">
              <InvoiceDetail />
            </Guard>
          }
        />
        <Route
          path="/g-fin/ap"
          element={
            <Guard permission="gfin.ap.view_all">
              <Payables />
            </Guard>
          }
        />
        <Route
          path="/g-fin/ap/:id"
          element={
            <Guard permission="gfin.ap.view_all">
              <BillDetail />
            </Guard>
          }
        />
        <Route
          path="/g-fin/expenses"
          element={
            <GuardAny permissions={['gfin.expenses.view_all', 'gfin.expenses.view_own']}>
              <Expenses />
            </GuardAny>
          }
        />
        <Route
          path="/g-fin/expenses/:id"
          element={
            <GuardAny permissions={['gfin.expenses.view_all', 'gfin.expenses.view_own']}>
              <ExpenseClaimDetail />
            </GuardAny>
          }
        />
        {/* Money issued before it is spent; liquidated through an expense claim. */}
        <Route
          path="/g-fin/cash-advances"
          element={
            <GuardAny permissions={['gfin.cash_advances.view_all', 'gfin.cash_advances.view_own']}>
              <CashAdvances />
            </GuardAny>
          }
        />
        <Route
          path="/g-fin/cash-advances/:id"
          element={
            <GuardAny permissions={['gfin.cash_advances.view_all', 'gfin.cash_advances.view_own']}>
              <CashAdvanceDetail />
            </GuardAny>
          }
        />
        {/* Project cash: finance's window on every project's budget requests. */}
        <Route
          path="/g-fin/budget-requests"
          element={
            <Guard permission="gfin.budget_requests.view_all">
              <FinanceBudgetRequests />
            </Guard>
          }
        />
        <Route
          path="/g-fin/payments"
          element={
            <Guard permission="gfin.payments.view_all">
              <Payments />
            </Guard>
          }
        />
        <Route
          path="/g-fin/cash-flow"
          element={
            <Guard permission="gfin.cashflow.view_all">
              <CashFlow />
            </Guard>
          }
        />
        <Route
          path="/g-fin/budget-vs-actual"
          element={
            <Guard permission="gfin.budget_vs_actual.view_all">
              <BudgetVsActual />
            </Guard>
          }
        />
        <Route
          path="/g-fin/reports"
          element={
            <GuardAny permissions={['gfin.reports.view_all', 'gfin.ar.view_all', 'gfin.ap.view_all']}>
              <FinanceReports />
            </GuardAny>
          }
        />
        <Route
          path="/g-fin/settings"
          element={
            <Guard permission="gfin.settings.view_all">
              <FinanceSettings />
            </Guard>
          }
        />

        {/* Aftermarket (Phase 8) */}
        <Route
          path="/g-ops/aftermarket"
          element={
            <Guard permission="gops.aftermarket.view_all">
              <AftermarketDashboard />
            </Guard>
          }
        />
        <Route
          path="/g-ops/installed-base"
          element={
            <Guard permission="gops.installed_base.view_all">
              <InstalledBase />
            </Guard>
          }
        />
        <Route
          path="/g-ops/installed-base/:id"
          element={
            <Guard permission="gops.installed_base.view_all">
              <AssetDetailPage />
            </Guard>
          }
        />
        <Route
          path="/g-ops/service-contracts"
          element={
            <GuardAny permissions={['gops.service_contracts.view_all', 'gops.service_contracts.view_own']}>
              <ServiceContracts />
            </GuardAny>
          }
        />
        <Route
          path="/g-ops/service-contracts/:id"
          element={
            <GuardAny permissions={['gops.service_contracts.view_all', 'gops.service_contracts.view_own']}>
              <ContractDetail />
            </GuardAny>
          }
        />
        <Route
          path="/g-ops/visits"
          element={
            <Guard permission="gops.visits.view_all">
              <ServiceSchedule />
            </Guard>
          }
        />
        {/* A job order is the authorisation for one visit — one order, one
            visit, one report. */}
        <Route
          path="/g-ops/job-orders"
          element={
            <GuardAny permissions={['gops.job_orders.view_all', 'gops.job_orders.view_own']}>
              <JobOrders />
            </GuardAny>
          }
        />
        <Route
          path="/g-ops/job-orders/:id"
          element={
            <GuardAny permissions={['gops.job_orders.view_all', 'gops.job_orders.view_own']}>
              <JobOrderDetail />
            </GuardAny>
          }
        />
        {/* CAD job orders (2026-10-09): the design team's queue — requests,
            revisions, a comment thread. */}
        <Route
          path="/g-ops/cad-job-orders"
          element={
            <GuardAny permissions={['gops.cad_job_orders.view_all', 'gops.cad_job_orders.view_own']}>
              <CadJobOrders />
            </GuardAny>
          }
        />
        <Route
          path="/g-ops/cad-job-orders/:id"
          element={
            <GuardAny permissions={['gops.cad_job_orders.view_all', 'gops.cad_job_orders.view_own']}>
              <CadJobOrderDetail />
            </GuardAny>
          }
        />
        <Route
          path="/g-ops/renewals"
          element={
            <Guard permission="gops.renewals.view_all">
              <Renewals />
            </Guard>
          }
        />
        <Route
          path="/g-ops/report-templates"
          element={
            <Guard permission="gops.report_templates.view_all">
              <ReportTemplates />
            </Guard>
          }
        />
        <Route
          path="/g-ops/service-costing"
          element={
            <GuardAny permissions={['gops.service_costing.view_all', 'gops.service_costing.view_own']}>
              <ServiceCosting />
            </GuardAny>
          }
        />
        {/* The three report menus are one screen with a preset filter — the
            fields that differ between them live in the template, not in code. */}
        <Route
          path="/g-ops/service-reports"
          element={
            <GuardAny
              permissions={[
                'gops.pm_reports.view_all',
                'gops.pm_reports.view_own',
                'gops.commissioning_reports.view_all',
                'gops.commissioning_reports.view_own',
                'gops.inspection_reports.view_all',
                'gops.inspection_reports.view_own',
              ]}
            >
              <ServiceReports />
            </GuardAny>
          }
        />
        <Route
          path="/g-ops/service-reports/:id"
          element={
            <GuardAny
              permissions={[
                'gops.pm_reports.view_all',
                'gops.pm_reports.view_own',
                'gops.commissioning_reports.view_all',
                'gops.commissioning_reports.view_own',
                'gops.inspection_reports.view_all',
                'gops.inspection_reports.view_own',
              ]}
            >
              <ServiceReportDetail />
            </GuardAny>
          }
        />
        {/*
            The three report menus render HERE, at their own declared paths,
            rather than redirecting to /g-ops/service-reports with a ?kind= that
            nothing read. Same screen, presetting its own kind — and a URL the
            permission registry actually declares, so the menu can highlight it.
        */}
        {['/g-ops/commissioning', '/g-ops/pm', '/g-ops/inspections'].map((path) => (
          <Route
            key={path}
            path={path}
            element={
              <GuardAny
                permissions={[
                  'gops.pm_reports.view_all',
                  'gops.pm_reports.view_own',
                  'gops.commissioning_reports.view_all',
                  'gops.commissioning_reports.view_own',
                  'gops.inspection_reports.view_all',
                  'gops.inspection_reports.view_own',
                ]}
              >
                <ServiceReports />
              </GuardAny>
            }
          />
        ))}

        {/* Insights (Phase 9) — read-only reporting across every division */}
        <Route
          path="/insights"
          element={
            <Guard permission="insights.dashboard.view_all">
              <CompanyOverview />
            </Guard>
          }
        />
        <Route
          path="/insights/profitability"
          element={
            <Guard permission="insights.profitability.view_all">
              <Profitability />
            </Guard>
          }
        />
        <Route
          path="/insights/pipeline"
          element={
            <Guard permission="insights.pipeline.view_all">
              <SalesAnalytics />
            </Guard>
          }
        />
        <Route
          path="/insights/cash-forecast"
          element={
            <Guard permission="insights.cash.view_all">
              <CashForecast />
            </Guard>
          }
        />
        <Route
          path="/insights/inventory"
          element={
            <Guard permission="insights.inventory.view_all">
              <InventoryAnalytics />
            </Guard>
          }
        />
        <Route
          path="/insights/performance"
          element={
            <Guard permission="insights.performance.view_all">
              <PerformanceReport />
            </Guard>
          }
        />

        {/* Screens whose module ships in a later phase — their access and
            numbering are already configurable, so this is a signpost, not a 404. */}
        {/* Document Templates is the service report template editor — the
            registry lists it under Admin as well as Aftermarket, and it used to
            fall through to ComingSoon from here. */}
        <Route
          path="/admin/templates"
          element={
            <Guard permission="admin.templates.view_all">
              <ReportTemplates />
            </Guard>
          }
        />
        <Route path="/g-ops/*" element={<ComingSoon />} />
        <Route path="/g-hr/*" element={<ComingSoon />} />
        <Route path="/g-hr" element={<ComingSoon />} />
        <Route path="/g-fin/*" element={<ComingSoon />} />
        <Route path="/g-fin" element={<ComingSoon />} />
        <Route path="/g-chain/*" element={<ComingSoon />} />
        <Route path="/g-chain" element={<ComingSoon />} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <Routed />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
