import type { FilterDef } from '../../components/DataList';

/**
 * The superior's two filters on the Leave and Overtime lists (2026-10-23, the
 * owner's report: requests "not appearing to superior"): what is waiting on
 * my decision, and my direct reports' filings ("Reports to" is me). The API
 * reads `waiting=me` and `reports=true`.
 */
export const APPROVER_FILTERS: FilterDef[] = [
  { key: 'waiting', label: 'Approval', options: [{ value: 'me', label: 'Waiting on me' }] },
  { key: 'reports', label: 'Direct reports', options: [{ value: 'true', label: 'My direct reports' }] },
];
