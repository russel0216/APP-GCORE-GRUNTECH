import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { Stat } from '../../../components/charts';
import type { TeamReadiness } from '../academy/Passports';

/**
 * The HR dashboard's training tile: company readiness from
 * `GET /passports/summary` — the same `teamReadiness()` the Passports
 * register heads with, so the tile and the screen it opens cannot disagree.
 *
 * Mounted by the HR dashboard; takes no props. Renders nothing it has no
 * right to read, and nothing at all until a course carries a requirement —
 * a tile reading "—" on day one looks like a failed load.
 */
export function ReadinessTile() {
  const { can } = useAuth();
  const [s, setS] = useState<TeamReadiness | null>(null);

  useEffect(() => {
    let live = true;
    api
      .get<TeamReadiness>('/passports/summary')
      .then((r) => live && setS(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (!s || s.pct == null) return null;
  const gaps = s.missing + s.expired;
  const open = can('ghr.passports.view_all');

  return (
    <Stat
      label="Training readiness"
      value={`${s.pct}%`}
      sub={[
        `${s.ready} of ${s.employees} fully ready`,
        gaps ? `${gaps} gap${gaps === 1 ? '' : 's'}` : null,
        s.expiring ? `${s.expiring} expiring` : null,
        s.pendingVerification ? `${s.pendingVerification} awaiting HR` : null,
      ]
        .filter(Boolean)
        .join(' · ')}
      accent={s.pct >= 100 ? 'ok' : gaps ? 'danger' : s.expiring ? 'warn' : 'quiet'}
      icon="book"
      to={open ? `/g-hr/academy/passports${gaps ? '?state=gaps' : s.expiring ? '?state=expiring' : ''}` : undefined}
      more={open ? (gaps ? 'Who has gaps' : 'Open passports') : undefined}
    />
  );
}
