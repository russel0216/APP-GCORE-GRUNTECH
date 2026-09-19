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
