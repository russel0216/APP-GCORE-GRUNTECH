import { prisma } from '../prisma';
import { audit } from './audit';

export const CANVASS_CODE_MOVED = 'seed.canvassCodeMoved';

/**
 * RFQ and Canvass became two documents on 2026-10-14 (the owner's call:
 * "separate the RFQ and Canvass"). The canvass had been numbered under the
 * code RFQ — GT-RFQ-2026-0001 — which now belongs to the Request for
 * Quotation, so a stored canvass template still on 'RFQ' moves to 'CVS',
 * ONCE (marked in `seed.canvassCodeMoved`), audited. A code an
 * administrator set to anything else is theirs and stays; a canvass already
 * numbered keeps its number, because a printed number never moves. Run by
 * the seed after the numbering loop, which creates the new `rfq` template.
 */
export async function moveCanvassCode(): Promise<{ moved: boolean }> {
  if (await prisma.setting.findUnique({ where: { key: CANVASS_CODE_MOVED } })) return { moved: false };
  const moved = await prisma.$transaction(async (tx) => {
    const n = await tx.numberSequence.updateMany({
      where: { documentType: 'canvass', periodKey: '', typeCode: 'RFQ' },
      data: { typeCode: 'CVS' },
    });
    await tx.setting.upsert({
      where: { key: CANVASS_CODE_MOVED },
      create: {
        key: CANVASS_CODE_MOVED,
        value: { at: new Date().toISOString(), moved: n.count > 0 },
        description:
          "The canvass's numbering code moved from RFQ to CVS once, when the Request for Quotation became its own document; " +
          'set so a code an administrator chooses afterwards is kept.',
      },
      update: {},
    });
    return n.count > 0;
  });
  if (moved) {
    await audit({
      entityType: 'number_sequence',
      entityId: 'canvass',
      action: 'UPDATED',
      summary: 'Canvass numbering code moved from RFQ to CVS — RFQ now numbers the Request for Quotation',
      actorName: 'system',
    });
  }
  return { moved };
}
