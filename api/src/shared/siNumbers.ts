import { prisma } from '../prisma';
import { conflict } from '../http/kit';

/**
 * One BIR printed sales invoice number, one holder (2026-10-20). A live
 * (not cancelled) invoice holds its `siNumber`; an invoice request still a
 * draft or waiting for approval holds the number it RESERVED — on approval
 * the number moves onto the invoice raised. Case-blind. A 409 names the
 * holder.
 */
export async function assertSiNumberFree(
  siNumber: string | null | undefined,
  except: { invoiceId?: string; requestId?: string } = {},
): Promise<void> {
  const si = siNumber?.trim();
  if (!si) return;
  const [invoice, request] = await Promise.all([
    prisma.invoice.findFirst({
      where: { siNumber: { equals: si, mode: 'insensitive' }, status: { not: 'CANCELLED' }, ...(except.invoiceId ? { id: { not: except.invoiceId } } : {}) },
      select: { number: true },
    }),
    prisma.invoiceRequest.findFirst({
      where: {
        siNumber: { equals: si, mode: 'insensitive' },
        status: { in: ['DRAFT', 'PENDING_APPROVAL'] },
        ...(except.requestId ? { id: { not: except.requestId } } : {}),
      },
      select: { number: true },
    }),
  ]);
  if (invoice) throw conflict(`Invoice no. ${si} is already on ${invoice.number}`);
  if (request) throw conflict(`Invoice no. ${si} is reserved on invoice request ${request.number}`);
}
