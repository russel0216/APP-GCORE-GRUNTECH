import { Link, useNavigate } from 'react-router-dom';
import { DataList, type Column } from '../../components/DataList';
import { StatusBadge, formatDateTime, type Tone } from '../../components/ui';
import { recordLink } from '../../lib/links';

interface AuditRow {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  summary: string | null;
  actorName: string | null;
  ip: string | null;
  at: string;
}

/**
 * Audit actions are not document statuses, so the shared pill needs telling
 * which way each one leans: a creation is good news, a deletion is not, and
 * a plain update or sign-in is neither. Anything not listed falls through to
 * statusTone(), which reads an unknown word as "in motion".
 */
const ACTION_TONES: Record<string, Tone> = {
  CREATED: 'ok',
  APPROVED: 'ok',
  COMPLETED: 'ok',
  UPDATED: '',
  SIGNED_IN: '',
  SIGNED_OUT: '',
  DELETED: 'danger',
  REJECTED: 'danger',
  CANCELLED: 'danger',
  SEPARATED: 'danger',
  RETURNED: 'warn',
  SUBMITTED: 'info',
  CONVERTED: 'info',
  EXECUTED: 'info',
  EXPORTED: 'info',
};

export function Audit() {
  const navigate = useNavigate();

  const columns: Column<AuditRow>[] = [
    {
      key: 'at',
      label: 'When',
      sortKey: 'at',
      width: '180px',
      render: (r) => <span className="muted">{formatDateTime(r.at)}</span>,
    },
    { key: 'actorName', label: 'Who', render: (r) => r.actorName ?? <span className="faint">system</span> },
    {
      key: 'action',
      label: 'Action',
      sortKey: 'action',
      render: (r) => <StatusBadge status={r.action} extra={ACTION_TONES} />,
    },
    {
      key: 'entityType',
      label: 'Record',
      sortKey: 'entityType',
      // The record itself, when it has a screen. A type with no address
      // (recordLink returns null) prints as text rather than as a link that
      // lands on "Not built yet".
      render: (r) => {
        const link = recordLink(r.entityType, r.entityId);
        return link ? (
          <Link to={link} onClick={(e) => e.stopPropagation()}>
            {r.entityType}
          </Link>
        ) : (
          r.entityType
        );
      },
    },
    { key: 'entityId', label: 'Record ID', render: (r) => <span className="mono faint">{r.entityId}</span>, optional: true },
    { key: 'summary', label: 'Detail', render: (r) => r.summary ?? '—' },
    { key: 'ip', label: 'IP', render: (r) => <span className="mono faint">{r.ip ?? '—'}</span>, optional: true },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Audit Logs</h1>
        </div>
      </div>

      <DataList<AuditRow>
        listKey="admin-audit"
        endpoint="/audit"
        printPath="/api/audit/pdf"
        columns={columns}
        rowKey={(r) => r.id}
        onRowClick={(r) => {
          const link = recordLink(r.entityType, r.entityId);
          if (link) navigate(link);
        }}
        searchPlaceholder="Search detail, record id, person…"
        emptyTitle="No matching activity"
        filters={[
          {
            key: 'action',
            label: 'Action',
            options: [
              'CREATED',
              'UPDATED',
              'DELETED',
              'SUBMITTED',
              'APPROVED',
              'REJECTED',
              'RETURNED',
              'EXPORTED',
              'SIGNED_IN',
            ].map((a) => ({ value: a, label: a })),
          },
          {
            key: 'entityType',
            label: 'Record',
            options: [
              'user',
              'role',
              'company',
              'pdf_specimen',
              'approval_workflow',
              'number_sequence',
              'setting',
              'customer',
              'supplier',
              'employee',
              'lead',
              'quotation',
              'costing',
              'job',
              'purchase_request',
              'purchase_order',
              'receiving',
              'invoice',
              'supplier_bill',
              'expense_claim',
              'cash_advance',
              'payment',
              'service_report',
              'job_order',
              'cad_job_order',
              'leave_request',
              'overtime_request',
              'clearance',
              'evaluation',
              'meeting',
              'training_session',
            ].map((t) => ({ value: t, label: t })),
          },
        ]}
      />
    </div>
  );
}
