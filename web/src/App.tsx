import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { ToastProvider, Loading } from './components/ui';
import { Shell } from './components/Shell';
import { Login } from './pages/Login';
import { Home } from './pages/Home';
import { MyWork } from './pages/MyWork';
import { Account, SystemSettings, ComingSoon } from './pages/Misc';
import { Users } from './pages/admin/Users';
import { Roles } from './pages/admin/Roles';
import { Company } from './pages/admin/Company';
import { Numbering } from './pages/admin/Numbering';
import { Workflows } from './pages/admin/Workflows';
import { Audit } from './pages/admin/Audit';
import { Customers } from './pages/masters/Customers';
import { Customer360Page } from './pages/masters/Customer360';
import { Suppliers, SupplierDetail } from './pages/masters/Suppliers';
import { Employees } from './pages/masters/Employees';
import { Items } from './pages/masters/Items';
import { Categories, Warehouses } from './pages/masters/Reference';
import { Leads, LeadDetail } from './pages/sales/Leads';
import { Costings } from './pages/sales/Costings';
import { CostingDetailPage } from './pages/sales/CostingDetail';
import { Quotations, QuotationDetail } from './pages/sales/Quotations';
import { SalesCalendar, Pipeline } from './pages/sales/CalendarPipeline';
import { Projects } from './pages/delivery/Projects';
import { ProjectWorkspace } from './pages/delivery/ProjectWorkspace';
import {
  ProgressReports,
  ProgressReportDetail,
  BillingDetailPage,
  BudgetRequests,
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
import { Receivables, InvoiceDetail, Payments } from './pages/finance/Receivables';
import { Payables, BillDetail } from './pages/finance/Payables';
import { Expenses, ExpenseClaimDetail } from './pages/finance/Expenses';
import {
  FinanceDashboard,
  FinanceReports,
  CashFlow,
  BudgetVsActual,
  FinanceSettings,
} from './pages/finance/Reports';

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

function Routed() {
  const { me, loading } = useAuth();

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
          path="/g-ops/costing"
          element={
            <GuardAny permissions={['gops.costing.view_all', 'gops.costing.view_own']}>
              <Costings />
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
          path="/g-ops/quotations"
          element={
            <GuardAny permissions={['gops.quotations.view_all', 'gops.quotations.view_own']}>
              <Quotations />
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
          path="/g-ops/calendar"
          element={
            <Guard permission="gops.calendar.view_all">
              <SalesCalendar />
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
        <Route
          path="/g-chain/purchase-requests/:id"
          element={
            <GuardAny permissions={['gchain.purchase_requests.view_all', 'gchain.purchase_requests.view_own']}>
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

        {/* Screens whose module ships in a later phase — their access and
            numbering are already configurable, so this is a signpost, not a 404. */}
        <Route path="/admin/templates" element={<ComingSoon />} />
        <Route path="/g-ops/*" element={<ComingSoon />} />
        <Route path="/g-ops" element={<ComingSoon />} />
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
