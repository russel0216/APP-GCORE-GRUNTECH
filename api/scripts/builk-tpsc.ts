/**
 * Builk's purchases for RA '26 TPSC - TOSHIBA LTI (shared/builkTpsc.ts).
 * The seed runs it once on deploy; this is its dry run.
 *
 *   npx tsx scripts/builk-tpsc.ts            # dry run: checks the data and the project
 *   npx tsx scripts/builk-tpsc.ts --apply    # writes, once (the seed's mark)
 */
import { prisma } from '../src/prisma';
import { checkBuilkTpscData, importBuilkTpsc } from '../src/shared/builkTpsc';

async function main() {
  const apply = process.argv.includes('--apply');
  const problems = checkBuilkTpscData();
  console.log(problems.length ? `Data problems:\n  ${problems.join('\n  ')}` : 'Data adds up to Builk: Materials 164,525.19, Equipment 138,578.38');
  const result = await importBuilkTpsc({ dryRun: !apply });
  console.log(result === null ? 'Already imported (mark set).' : JSON.stringify(result, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
