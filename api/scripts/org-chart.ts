/**
 * The organisation chart of 2026-10-17 — a DRY RUN by default: prints what
 * the seed's once-only step will change for every person on the chart
 * (roles added and removed, Reports to, team, Supports teams, position) and
 * the employee records it will create, writing nothing.
 *
 *   npx tsx scripts/org-chart.ts            # dry run
 *   npx tsx scripts/org-chart.ts --apply    # apply now (the seed would, once)
 *   npx tsx scripts/org-chart.ts --force    # apply again although marked
 */
import { prisma } from '../src/prisma';
import { ORG_CHART, ORG_CHART_MARK, applyOrgChart, grantSupervisorRole } from '../src/shared/orgChart';

async function main() {
  const apply = process.argv.includes('--apply') || process.argv.includes('--force');
  const force = process.argv.includes('--force');
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
