/**
 * The employee numbers of the owner's ROLE.xlsx (2026-10-18) — a DRY RUN by
 * default: who would get which number, who is not on file, and any number
 * already in use. The seed applies it once (shared/employeeNumbersFromList.ts).
 *
 *   npx tsx scripts/employee-numbers.ts            # dry run
 *   npx tsx scripts/employee-numbers.ts --apply    # apply now (the seed would, once)
 *   npx tsx scripts/employee-numbers.ts --force    # apply again although marked
 */
import { prisma } from '../src/prisma';
import { applyEmployeeNumberList } from '../src/shared/employeeNumbersFromList';

async function main() {
  const force = process.argv.includes('--force');
  const apply = force || process.argv.includes('--apply');
  const r = await applyEmployeeNumberList({ dryRun: !apply, force });
  if (!r) {
    console.log('Already applied by the seed — pass --force to apply again.');
    return;
  }
  console.log(`${r.applied ? 'Set' : 'Would set'} ${r.changed.length} employee number(s); ${r.unchanged} already so\n`);
  for (const c of r.changed) console.log(`  ${c.employeeNo}  ${c.name}${c.before ? ` (was ${c.before})` : ''}${c.login ? ` — login ${c.login}` : ' — no login'}`);
  if (r.notFound.length) console.log(`\nNot on file: ${r.notFound.join(', ')}`);
  if (r.clashes.length) console.log(`\nLeft, number in use: ${r.clashes.join('; ')}`);
  if (!r.applied) console.log('\nDry run — pass --apply to write.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
