import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { Stat } from '../../../components/charts';
import type { PlantillaSummary } from '../Plantilla';
import type { ClearanceSummary } from '../Clearances';

/**
 * The HR dashboard's people row: the plantilla, the year's separations and
 * who is clearing out. Every figure is the same endpoint the owning screen
 * reads — `/positions/summary` and `/clearances/summary` — so a tile and the
 * screen it opens cannot disagree.
 *
 * Mounted by the HR dashboard; takes no props. Renders nothing it has no
 * right to read rather than three error boxes.
 */
export function PeopleTiles() {
  const { can } = useAuth();
  const [plantilla, setPlantilla] = useState<PlantillaSummary | null>(null);
  const [clearances, setClearances] = useState<ClearanceSummary | null>(null);

  useEffect(() => {
    let live = true;
    api
      .get<PlantillaSummary>('/positions/summary')
      .then((s) => live && setPlantilla(s))
      .catch(() => {});
    api
      .get<ClearanceSummary>('/clearances/summary')
      .then((s) => live && setClearances(s))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (!plantilla && !clearances) return null;

  return (
    <div className="kpi-grid">
      {plantilla && (
        <Stat
          label="Plantilla"
          value={`${plantilla.filled}/${plantilla.authorised}`}
          sub={`${plantilla.vacant} vacant${plantilla.overComplement ? `, ${plantilla.overComplement} over` : ''}${
            plantilla.unclassified ? ` · ${plantilla.unclassified} unclassified` : ''
          }`}
          accent={plantilla.overComplement > 0 ? 'danger' : plantilla.vacant > 0 ? 'warn' : 'ok'}
          icon="layers"
          to={can('ghr.plantilla.view_all') ? `/g-hr/plantilla${plantilla.vacant > 0 ? '?vacant=true' : ''}` : undefined}
          more={can('ghr.plantilla.view_all') ? 'Open plantilla' : undefined}
        />
      )}
      {clearances && (
        <Stat
          label="Separations, 12 months"
          value={clearances.separations12m}
          sub={`turnover ${clearances.turnover12mPct}% · ${clearances.hires12m} hired`}
          accent="quiet"
          icon="people"
          to={can('ghr.reports.view_all') ? '/g-hr/reports?tab=turnover' : undefined}
          more={can('ghr.reports.view_all') ? 'Turnover report' : undefined}
        />
      )}
      {clearances && (
        <Stat
          label="Clearances open"
          value={clearances.open}
          sub={
            clearances.open > 0
              ? `leavers with items outstanding${clearances.pendingApproval ? ` · ${clearances.pendingApproval} awaiting sign-off` : ''}`
              : clearances.pendingApproval
                ? `${clearances.pendingApproval} awaiting sign-off`
                : 'nobody clearing out'
          }
          accent={clearances.open > 0 ? 'warn' : 'quiet'}
          icon="document"
          to={can('ghr.clearances.view_all') ? '/g-hr/clearances?status=OPEN' : undefined}
          more={can('ghr.clearances.view_all') ? 'Open clearances' : undefined}
        />
      )}
    </div>
  );
}
