import { OrgChart } from '../admin/OrgChart';

/**
 * G-HR › People › Organizational Chart and Hierarchy Chart (2026-11-13, the
 * owner's call: "can be viewed by HR in G-HR"; his answer: every employee).
 * The same drawings as Admin › Users, READ-ONLY: a card opens nothing, and
 * the people come from the slim `/users/org-chart` list (name, title, roles,
 * team, picture, "Reports to" — never an email or a right).
 */
export function OrgChartPage() {
  return (
    <div>
      <div className="page-head">
        <h1>Organizational Chart</h1>
      </div>
      <OrgChart readOnly />
    </div>
  );
}

export function HierarchyChartPage() {
  return (
    <div>
      <div className="page-head">
        <h1>Hierarchy Chart</h1>
      </div>
      <OrgChart readOnly rolesOnly />
    </div>
  );
}
