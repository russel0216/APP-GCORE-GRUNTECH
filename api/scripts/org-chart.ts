/**
 * The organisation chart of 2026-10-17 — a DRY RUN by default: prints what
 * the seed's once-only step will change for every person on the chart
 * (roles added and removed, Reports to, team, Supports teams, position) and
 * the employee records it will create, writing nothing.
 *
 *   npx tsx scripts/org-chart.ts            # dry run
 *   npx tsx scripts/org-chart.ts --apply    # apply now (the seed would, once)
 *   npx tsx scripts/org-chart.ts --force    # apply again although marked
 *
 * Since 2026-10-18 the roles are the owner's own (every seeded role was
 * emptied for him to build his own), so the chart's TITLES are assigned to
 * his roles BY NAME — "Team Leader" to the role named Team Leader — added,
 * never removed, and never marked, so it may be run again as the roles grow:
 *
 *   npx tsx scripts/org-chart.ts --roles-by-name            # dry run: every assignment, every title with no role
 *   npx tsx scripts/org-chart.ts --roles-by-name --apply    # write them, audited per login
 */
import { prisma } from '../src/prisma';
import { ORG_CHART, ORG_CHART_MARK, applyChartRolesByName, applyOrgChart, grantSupervisorRole } from '../src/shared/orgChart';

async function main() {
  const apply = process.argv.includes('--apply') || process.argv.includes('--force');
  const force = process.argv.includes('--force');

  if (process.argv.includes('--roles-by-name')) {
    const result = await applyChartRolesByName({ dryRun: !apply });
    console.log(`${result.applied ? 'Assigned' : 'Would assign'} the chart's titles to the roles named after them: ${result.people.length} login(s) with roles to add\n`);
    for (const p of result.people) {
      console.log(`${p.name}`);
      for (const c of p.changes) console.log(`   - ${c}`);
    }
    if (result.unmatchedTitles.length) {
      console.log(`\nTitles on the chart with NO role of that name (create or rename one, then run again): ${result.unmatchedTitles.join(', ')}`);
    }
    if (result.noLogin.length) console.log(`\nOn the chart with no login yet (nothing to assign to): ${result.noLogin.join(', ')}`);
    if (!apply) console.log('\nDry run — pass --apply to write the assignments.');
    return;
  }

  const marked = await prisma.setting.findUnique({ where: { key: ORG_CHART_MARK } });
  if (marked && !force) console.log(`Already applied (${ORG_CHART_MARK}): ${JSON.stringify(marked.value)}${apply ? ' — pass --force to apply again' : ''}`);
  const result = await applyOrgChart({ dryRun: !apply || (!!marked && !force), force });
  console.log(`${result.applied ? 'Applied' : 'Would apply'} the chart of ${ORG_CHART.length} people: ${result.people.length} with changes, ${result.unmatched.length} employee record(s) ${result.applied ? 'created' : 'to create'}\n`);
  for (const p of result.people) {
    console.log(`${p.name}`);
    for (const c of p.changes) console.log(`   - ${c}`);
  }
  if (result.applied) {
    const bosses = await grantSupervisorRole();
    if (bosses) console.log(`\nGave Supervisor to ${bosses} login(s) with direct reports`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
