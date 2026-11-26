/**
 * Where is every document waiting, and on whom — and which people are set up
 * so that their documents cannot move. The same figures as Admin › Approval
 * Health (shared/approvalHealth.ts), in text.
 *
 *   npx tsx scripts/approval-health.ts          (the first 60 of each list)
 *   npx tsx scripts/approval-health.ts --all    (everything)
 *
 * READ-ONLY. Safe to run against production.
 */

import { prisma } from '../src/prisma';
import { healthOverview } from '../src/shared/approvalHealth';

const CAP = process.argv.includes('--all') ? Infinity : 60;

function heading(text: string) {
  console.log('\n' + '='.repeat(78) + '\n' + text + '\n' + '='.repeat(78));
}
function capped<T>(rows: T[]): T[] {
  if (rows.length > CAP) console.log(`(showing ${CAP} of ${rows.length} — run with --all for every one)`);
  return rows.slice(0, CAP);
}

async function main() {
  const h = await healthOverview();
  const blocked = h.waiting.filter((r) => r.problem && r.problem !== 'slow');
  const slow = h.waiting.filter((r) => r.problem === 'slow').sort((a, b) => b.days - a.days);

  heading(`1. DOCUMENTS THAT CANNOT MOVE — ${blocked.length} of ${h.waiting.length} waiting`);
  if (!blocked.length) console.log('None.');
  for (const r of capped(blocked)) {
    console.log(`\n${r.number}  [${r.typeLabel}]  ${r.problemText}`);
    console.log(`   ${r.subject}`);
    console.log(`   raised by ${r.requester.name} · at step ${r.stepName} · ${r.days} days`);
    if (r.fix) console.log(`   FIX: ${r.fix}`);
  }

  heading(`2. WAITING 7 DAYS OR MORE — ${slow.length}`);
  for (const r of capped(slow)) console.log(`${String(r.days).padStart(4)}d  ${r.number}  [${r.typeLabel}]  ${r.stepName} → ${r.waitingOn.map((p) => p.name).join(', ')}`);

  heading('3. ROUTE STEPS THAT REACH NOBODY');
  for (const w of h.routes) for (const s of w.steps.filter((x) => x.problem)) console.log(`[${w.typeLabel}] ${w.name} — step ${s.sequence} ${s.name}: ${s.problem}`);

  heading('4. PEOPLE WHOSE SET-UP STOPS DOCUMENTS');
  for (const g of h.setup.people) {
    console.log(`\n${g.title} — ${g.people.length}\n   ${g.why}`);
    for (const p of capped(g.people)) console.log(`   · ${p.name} <${p.email}>  roles: ${p.roles.join(', ') || 'none'}`);
  }

  heading('5. ROLES WITH A PROBLEM');
  for (const r of h.setup.roles.filter((x) => x.problem)) console.log(`${r.name}: ${r.problem}`);

  console.log(`\nDone. ${h.waiting.length} waiting, ${blocked.length} cannot move, ${slow.length} slow. Nothing was changed.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
