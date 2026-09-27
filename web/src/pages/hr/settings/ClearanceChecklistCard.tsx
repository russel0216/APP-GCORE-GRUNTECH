import { useAuth } from '../../../lib/auth';
import { SettingListCard } from '../../../components/SettingListCard';

/**
 * HR Settings › Clearance checklist — the company property every leaver
 * returns. Copied onto a clearance when it is raised, so editing this list
 * never rewrites one already open. Tools on borrow slips, unpaid claims and
 * assignments are NOT listed here: the clearance reads them off the records.
 *
 * Mounted by HR Settings; takes no props.
 */

const AREAS = [
  { value: 'ADMIN', label: 'Company property' },
  { value: 'SUPERVISOR', label: 'Work handover' },
  { value: 'WAREHOUSE', label: 'Tools & equipment' },
  { value: 'FINANCE', label: 'Money' },
  { value: 'HR', label: 'HR' },
];

export function ClearanceChecklistCard() {
  const { can } = useAuth();
  return (
    <SettingListCard
      settingKey="hr.clearanceChecklist"
      title="Clearance checklist"
      hint="Company property every leaver returns, and who clears each line. Tools on borrow slips, unpaid claims and assignments are added automatically from the records."
      columns={[
        { key: 'area', label: 'Cleared by', kind: 'select', options: AREAS },
        { key: 'description', label: 'Item', kind: 'text' },
      ]}
      newRow={() => ({ area: 'ADMIN', description: '' })}
      canEdit={can('ghr.settings.edit_all')}
    />
  );
}
