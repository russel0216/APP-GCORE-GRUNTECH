/**
 * Import the SCORO quotation archive from a bundle folder.
 *
 *   npx tsx scripts/import-scoro-quotes.ts <bundleDir>                 dry run
 *   npx tsx scripts/import-scoro-quotes.ts <bundleDir> --commit        import
 *   npx tsx scripts/import-scoro-quotes.ts <bundleDir> --commit --as admin@gruntech.com
 *
 * The bundle is what tools/scoro/scoro_quotes.py writes on the workstation:
 * quotes.json and a pdf/ folder. See tools/scoro/README.md.
 *
 * A dry run writes nothing. It prints what would happen: how many quotes,
 * which SCORO customers match a G-CORE customer and which do not, each owner's
 * SCORO employee code against the employee number their G-CORE login carries,
 * the quotes whose lines do not add up, and the quotation counters that would
 * be raised so G-CORE's next number follows SCORO's last.
 *
 * --commit applies it: archive rows (a re-run updates, never duplicates), the
 * PDFs through the attachment store, the counters (raised, never lowered), and
 * one audit row. `--as <email>` names the user it is recorded against; the
 * default is the first active super admin.
 */

import path from 'node:path';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { importBundle, type ImportReport } from '../src/shared/legacyQuotes';

function print(r: ImportReport) {
  const t = r.totals;
  console.log(`
  Source            ${r.source}
  Quotes            ${t.quotes}  (${t.created} new, ${t.updated} already archived${t.skipped ? `, ${t.skipped} skipped` : ''})
  Open / closed     ${t.open} open (can be continued) / ${t.closed} closed (view only)
  PDFs              ${t.withPdf} found, ${t.missingPdf} missing, no PDF: ${t.noPdf} (SCORO exported none)
  By status         ${Object.entries(t.byStatus).map(([s, n]) => `${s} ${n}`).join(', ')}`);

  const c = r.customers;
  console.log(`
Customers
  matched by name        ${c.matchedByName} quotes
  matched by SCORO id    ${c.matchedByScoroId} quotes
  unmatched              ${c.unmatchedQuotes} quotes across ${c.unmatched.length} SCORO customers`);
  for (const u of c.unmatched) {
    console.log(`    - ${u.name}${u.scoroId ? `  (SCORO id ${u.scoroId})` : ''}  ${u.quotes} quote(s)`);
  }
  if (c.unmatched.length) {
    console.log('  Unmatched quotes are archived all the same; link them to a customer from the archive screen,');
    console.log('  or import the customer and re-run this script.');
  }

  console.log('\nOwners');
  for (const o of r.owners) {
    const codes = o.codes.map((x) => `${x.code}×${x.count}`).join(', ') || 'no house-format numbers';
    const who = o.user ? `${o.user.name}, employee no. ${o.user.employeeNo ?? '(none)'} → ${o.user.token}` : 'NO G-CORE USER';
    console.log(`  ${o.name.padEnd(24)} ${String(o.quotes).padStart(4)} quotes  codes ${codes}  |  ${who}${o.mismatch ? '  MISMATCH' : ''}`);
    if (o.message) console.log(`      ${o.message}`);
  }

  console.log(`\nLines that do not add up to SCORO's figure: ${r.notReconciling.length}`);
  for (const q of r.notReconciling) {
    console.log(`  ${q.number.padEnd(14)} lines ${q.linesSum.toFixed(2).padStart(14)}  SCORO ${q.subtotal.toFixed(2).padStart(14)}  ${q.customer}`);
  }

  console.log(`\nNot in the house format — no counter seeded: ${r.notHouseFormat.length}`);
  for (const q of r.notHouseFormat) console.log(`  ${q.number.padEnd(14)} ${q.date.padEnd(10)}  ${q.owner}`);

  console.log('\nQuotation counters (current month onward, one per code)');
  if (r.counterTemplate) {
    console.log(`  template: ${r.counterTemplate.pattern} (${r.counterTemplate.period}, ${r.counterTemplate.scope})${r.counterTemplate.houseScheme ? '' : '  <- not the SCORO scheme'}`);
  }
  if (!r.counters.length) console.log('  none — no SCORO number is dated this month or later');
  for (const k of r.counters) {
    const from = k.existing === null ? 'new' : String(k.existing);
    console.log(`  ${k.periodKey.padEnd(14)} SCORO last ${String(k.scoroSeq).padStart(3)}  counter ${from} → ${k.target}  (${k.change})  next number ${k.emp}${k.month.slice(2, 4)}${k.month.slice(5, 7)}${String(k.target + 1).padStart(3, '0')}`);
  }

  if (r.warnings.length) {
    console.log('\nWarnings');
    for (const w of r.warnings) console.log(`  ! ${w}`);
  }
  if (r.committed) {
    console.log(`\nPDFs: ${r.pdfs.stored} stored, ${r.pdfs.replaced} replaced, ${r.pdfs.kept} unchanged, ${r.pdfs.missing.length} missing, ${r.pdfs.noPdf.length} with no PDF from SCORO.`);
  }
}

(async () => {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const asIdx = args.indexOf('--as');
  const asEmail = asIdx >= 0 ? args[asIdx + 1] : undefined;
  const dir = args.find((a, i) => !a.startsWith('--') && (asIdx < 0 || i !== asIdx + 1));

  if (!dir) {
    console.error('\nUsage: npx tsx scripts/import-scoro-quotes.ts <bundleDir> [--commit] [--as <email>]\n');
    process.exitCode = 1;
    await prisma.$disconnect();
    return;
  }

  if (env.isProduction) {
    console.log('\n*** This is a PRODUCTION database. ***');
  }

  let actor: { id: string; name: string; email: string } | null = null;
  if (commit) {
    actor = asEmail
      ? await prisma.user.findUnique({
          where: { email: asEmail.trim().toLowerCase() },
          select: { id: true, name: true, email: true },
        })
      : await prisma.user.findFirst({
          where: { isSuperAdmin: true, isActive: true },
          orderBy: { createdAt: 'asc' },
          select: { id: true, name: true, email: true },
        });
    if (!actor) {
      console.error(asEmail ? `\nNo user with the email "${asEmail}".\n` : '\nNo active super admin to record the import against. Pass --as <email>.\n');
      process.exitCode = 1;
      await prisma.$disconnect();
      return;
    }
  }

  const bundle = path.resolve(dir);
  console.log(`\n${commit ? 'IMPORTING' : 'DRY RUN — nothing is written'}: ${bundle}${actor ? `  (as ${actor.name} <${actor.email}>)` : ''}`);

  const report = await importBundle(bundle, {
    commit,
    actorId: actor?.id ?? null,
    actorName: actor ? `${actor.name} via console (import-scoro-quotes.ts)` : null,
  });
  print(report);

  console.log(
    commit
      ? `\nDone. ${report.totals.quotes} SCORO quotes are in the archive (G-OPS > Sales > SCORO Archive).\n`
      : '\nDry run only. Re-run with --commit to import.\n',
  );
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('\nImport failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
  await prisma.$disconnect();
});
