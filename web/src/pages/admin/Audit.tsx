import { DataList, type Column } from '../../components/DataList';
import { formatDateTime } from '../../components/ui';

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

const ACTION_TONE: Record<string, string> = {
  CREATED: 'ok',
  APPROVED: 'ok',
  COMPLETED: 'ok',
  DELETED: 'danger',
  REJECTED: 'danger',
  CANCELLED: 'danger',
  RETURNED: 'warn',
  SUBMITTED: 'info',
  CONVERTED: 'info',
  EXECUTED: 'info',
};

export function Audit() {
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
      render: (r) => <span className={`badge ${ACTION_TONE[r.action] ?? ''}`}>{r.action}</span>,
    },
    { key: 'entityType', label: 'Record', sortKey: 'entityType', render: (r) => r.entityType },
    { key: 'entityId', label: 'Record ID', render: (r) => <span className="mono faint">{r.entityId}</span>, optional: true },
    { key: 'summary', label: 'Detail', render: (r) => r.summary ?? '—' },
    { key: 'ip', label: 'IP', render: (r) => <span className="mono faint">{r.ip ?? '—'}</span>, optional: true },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Audit Logs</h1>
          <p>
            Every create, change, approval and deletion, with who did it and when. Records are
            written by the shared audit service, so a new module gets a trail by calling one
            function rather than by remembering to build one.
          </p>
        </div>
      </div>

      <DataList<AuditRow>
        listKey="admin-audit"
        endpoint="/audit"
        columns={columns}
        rowKey={(r) => r.id}
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
              'SIGNED_IN',
            ].map((a) => ({ value: a, label: a })),
          },
          {
            key: 'entityType',
            label: 'Record',
            options: ['user', 'role', 'company', 'approval_workflow', 'number_sequence', 'setting'].map(
              (t) => ({ value: t, label: t }),
            ),
          },
        ]}
      />
    </div>
  );
}
