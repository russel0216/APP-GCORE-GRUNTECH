import { prisma } from '../prisma';
import { audit } from './audit';
import { deleteAttachment } from './attachments';

/**
 * The SCORO archive, removed (2026-10-10, the owner's call: "remove also
 * scoro data").
 *
 * Quotations raised in SCORO used to come across as a read-only archive
 * (`LegacyQuote`, its PDF on each row, a hidden screen under Sales). The owner
 * will upload SCORO's quotations and invoices again later as REAL quotations
 * and sales orders, so the archive is obsolete: its rows and PDFs go, and the
 * quotations "continued" from it stay as ordinary quotations under the
 * numbers they carry.
 *
 * The table itself went on 2026-10-11, the push after the one whose seed
 * emptied it (`prisma db push` refuses to drop a table that holds rows, and
 * the deploy pushes BEFORE it seeds — so the rows went in one deploy and the
 * model in the next, once the owner said the first had run). What can still
 * turn up are the archive's leavings — a PDF attached under its entity type,
 * a saved view of its list — and this step, run by the seed on every deploy,
 * removes whatever it finds; the audit row and the `seed.scoroArchiveRemoved`
 * setting are written once, and a later run with the setting present and
 * nothing to remove does nothing.
 */

export const SCORO_ARCHIVE_REMOVED = 'seed.scoroArchiveRemoved';
/** The entity type the archive's PDFs were attached under (verify-foundation's fixture names it). */
export const ARCHIVE_ATTACHMENT = 'legacy_quote';
/** The archive list's DataList key — its per-viewer saved views go with it. */
export const ARCHIVE_LIST_KEY = 'quote-archive';

export interface ArchiveRemoval {
  pdfs: number;
  views: number;
  /** True on the run that wrote the audit row and the setting. */
  marked: boolean;
}

export async function removeScoroArchive(): Promise<ArchiveRemoval | null> {
  const pdfs = await prisma.attachment.findMany({ where: { entityType: ARCHIVE_ATTACHMENT }, select: { id: true } });
  // Row and file together, one by one — a stray PDF on disk is what a bare
  // deleteMany would leave behind.
  for (const pdf of pdfs) await deleteAttachment(pdf.id);
  const views = await prisma.savedFilter.deleteMany({ where: { listKey: ARCHIVE_LIST_KEY } });
  const removed = { pdfs: pdfs.length, views: views.count };
  const anything = removed.pdfs + removed.views > 0;

  if (await prisma.setting.findUnique({ where: { key: SCORO_ARCHIVE_REMOVED } })) {
    return anything ? { ...removed, marked: false } : null;
  }
  if (anything) {
    await audit({
      entityType: ARCHIVE_ATTACHMENT,
      entityId: 'archive',
      action: 'DELETED',
      summary: `Removed the SCORO archive: ${removed.pdfs} PDFs, ${removed.views} saved views`,
      actorName: 'system',
      after: removed,
    });
  }
  await prisma.setting.upsert({
    where: { key: SCORO_ARCHIVE_REMOVED },
    create: {
      key: SCORO_ARCHIVE_REMOVED,
      value: { at: new Date().toISOString(), ...removed },
      description:
        'The read-only SCORO quotation archive was removed once (2026-10-10, the owner\'s call).',
    },
    update: {},
  });
  return { ...removed, marked: true };
}
