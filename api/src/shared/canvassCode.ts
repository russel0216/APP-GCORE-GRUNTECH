import { prisma } from '../prisma';
import { audit } from './audit';

/**
 * The once-only mark. The first version of this step (push 2 of
 * 2026-10-14, marked `seed.canvassCodeMoved`) moved the template alone and
 * left this year's counter printing RFQ; this mark is the one that counts,
 * so an install that ran the first version is put right once.
 */
export const CANVASS_CODE_MOVED = 'seed.canvassCountersMoved';

/** The codes the step may move from: the canvass's own old code, or the one the first version left on the template. */
const OURS = ['RFQ', 'CVS'];

/**
 * RFQ and Canvass became two documents on 2026-10-14 (the owner's call:
 * "separate the RFQ and Canvass"). The canvass had been numbered under the
 * code RFQ — GT-RFQ-2026-0001 — which now belongs to the Request for
 * Quotation, so the canvass's numbering moves to 'CVS': the template AND
 * every period counter still on 'RFQ' (a counter copies the template's code
 * when it is made and prints with its own copy, so the template alone would
 * leave this year's sheets RFQ — Admin › Numbering changes every row of a
 * type for the same reason). ONCE (marked in `seed.canvassCountersMoved`),
 * audited, and only while the template still carries one of our codes: a
 * code an administrator chose is theirs and stays. A canvass already
 * numbered keeps its number, because a printed number never moves. Run by
 * the seed after the numbering loop, which creates the new `rfq` template.
 */
export async function moveCanvassCode(): Promise<{ moved: boolean }> {
  if (await prisma.setting.findUnique({ where: { key: CANVASS_CODE_MOVED } })) return { moved: false };
  const moved = await prisma.$transaction(async (tx) => {
    const template = await tx.numberSequence.findFirst({ where: { documentType: 'canvass', periodKey: '' }, select: { typeCode: true } });
    const n =
      template && OURS.includes(template.typeCode)
        ? await tx.numberSequence.updateMany({ where: { documentType: 'canvass', typeCode: 'RFQ' }, data: { typeCode: 'CVS' } })
        : { count: 0 };
    await tx.setting.upsert({
      where: { key: CANVASS_CODE_MOVED },
      create: {
        key: CANVASS_CODE_MOVED,
        value: { at: new Date().toISOString(), rows: n.count },
        description:
          "The canvass's numbering code moved from RFQ to CVS once (the template and every period counter), when the Request for Quotation became its own document; " +
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
