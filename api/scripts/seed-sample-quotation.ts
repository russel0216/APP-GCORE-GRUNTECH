/**
 * File SCORO quote 0062602018 (AJOYA PAMPANGA, Aboitiz Land) — an ongoing
 * project carried over from SCORO — as a live quotation to walk the whole
 * setup with: approve it, book a sales order, win it, build the project.
 *
 * The quotation takes the SCORO number itself and CONTINUES the archive row
 * where the archive holds it (continuedQuotationId, the archive's one-way
 * link), the way "Continue in G-CORE" does — although that button refuses a
 * quote SCORO marked Completed. This is the owner's call for this one: the
 * project is still running, so the live record carries the number. A
 * quotation an earlier run filed as 0062602018.2 is renamed and linked.
 *
 *   npx tsx scripts/seed-sample-quotation.ts
 *   OWNER_EMAIL=someone@gruntech.com npx tsx scripts/seed-sample-quotation.ts
 *
 * It creates what is missing and reuses what is there: the customer
 * (ABOITIZ LAND, INC., Building Industry), its contact and site, the
 * supplier GAS ION TECHNOLOGY INC. that carries the outsourced line, and the
 * quotation as a DRAFT under the owner's name — so submission, approval and
 * everything after it run through the real paths rather than being written
 * here. Idempotent: a quotation already carrying the number stops the script.
 *
 * The owner is OWNER_EMAIL, else the login whose name contains the SCORO
 * author's surname, else admin@gruntech.com.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma';
import { nextNumber } from '../src/shared/numbering';
import { recalcQuotationRevision } from '../src/shared/quotation';
import { rememberGroups } from '../src/shared/quotationGroups';
import { audit } from '../src/shared/audit';
import { LEGACY_QUOTE_ENTITY } from '../src/shared/legacyQuotes';
import { recalcOrder } from '../src/routes/salesOrders';
import { valueRevision } from '../src/shared/pipeline';

const NUMBER = '0062602018';
/** What an earlier version of this script filed it as. */
const OLD_NUMBER = '0062602018.2';
const SUBJECT = 'AJOYA PAMPANGA';
const ISSUED = new Date('2026-05-26T00:00:00+08:00');
const CLOSING = '2026-06-25';
const GROUP_GIF = 'Gruntech Installation and Fabrication';
const GROUP_OTHER = 'Other Services';

const d = (v: number | string) => new Prisma.Decimal(v);

interface SeedLine {
  heading?: string;
  group?: string;
  title?: string;
  description?: string;
  unitPrice?: number;
  unitCost?: number;
  provider?: 'owner' | 'gasion';
  costNote?: string;
}

const LINES: SeedLine[] = [
  { heading: 'PIPING MATERIALS' },
  {
    group: GROUP_GIF,
    title: 'MATERIALS',
    description: [
      'GIF - MATERIALS',
      'DISCHARGE PIPING',
      'GI PIPE 4" SCHEDULE 40 2PCS 14,800 29,600',
      'GI ELBOW 90 DEGREE , WELDED 4" 8PCS 5800 46,400',
      'GI TEE 4 INCHES 2PCS 6,800 13,600',
      'GI FLANGE 4 INCHES 12PCS 1,500 18,000',
      'EVER, SWING CHECK VALVE 4" FLANGE CONNECTION 2 PCS 21,800 43,600',
      'RUBBER BELLOW 5" 2 PCS 12,000 24,000',
      'SUCTION PIPING',
      'GI PIPE 125MM/5" 2 PCS 21,800 43,600',
      'GI ELBOW 90 DEGREE , WELDED 5" 2PCS 9,800 19,600',
      'GI COUPLING 5" (THREADED) 6 PCS 4,800 28,800',
      'FOOT VALVE 5" 2PCS 8,500 17,000',
      'EQUALIZATION VALVE 1 LOT 46,060',
      'ELECTRICAL WIRE 1 LOT 40,000',
      'PANEL COMPONENT 1 LOT 30,000',
      'CORING 1 LOT 30,000',
      'CONTINGENCY 1 LOT 80,000',
    ].join('\n'),
    unitPrice: 690000,
    unitCost: 489140,
    provider: 'owner',
    costNote: '409,140 = MATERIALS\n80,000 MOBILIZATION',
  },
  { heading: 'CONTROLLER COMPONENTS' },
  {
    group: GROUP_OTHER,
    title: 'GRUNTECH SERVICES, ELECTRICAL WORKS',
    description: [
      'INSTALLATION OF ELECTRICAL WIRES AND CONDUIT FROM GENERATOR SET TO ATS',
      '',
      'Supply and installation of Main distribution panel',
      'Meralco connection processing',
      'Cable laying from service entrance to pump house',
      'Supply of needed cables conduits for the electrical works',
    ].join('\n'),
    unitPrice: 60000,
    unitCost: 40000,
    provider: 'owner',
  },
  { heading: 'SUPPLY AND INSTALLATION' },
  {
    group: GROUP_GIF,
    title: 'SUPPLY AND INSTALLATION',
    description: [
      'GIF-SUPPLY AND INSTALLATION',
      'Supply of Labor, Tools and Technical expertise for the RE-PIPING and relocation of 2 units End Suction Pump as per drawing and below Scope of Work:',
      '',
      'SCOPE OF WORKS',
      '',
      '* Site Mobilization: Transport of equipment, materials, and personnel to the site.',
      '* Decommissioning: Systematic dismantling and removal of existing pipework.',
      '* Pump Realignment: Precision repositioning of two (2) pump units.',
      '* Structural Remediation: Pouring and curing of the concrete floor slab.',
      '* Discharge Line Installation: Routing and welding/fusion of HDPE (PE100) discharge piping.',
      '* Pressure Tank Integration: Installation of HDPE (PE100) piping for the pressure tank system.',
      '* Suction Line Assembly: Installation of galvanized iron (GI) suction piping.',
      '* Ancillary Components: Installation of priming ports and system sensors.',
      '* System Verification: Comprehensive testing and commissioning to ensure operational integrity.',
      '',
      'All Consumables Like Rubber bellows, bracket and support, gasket, bolts and nuts, are included',
    ].join('\n'),
    unitPrice: 300000,
    unitCost: 200000,
    provider: 'gasion',
    costNote: 'GAS ION JOB ORDER',
  },
];

async function pickOwner() {
  const wanted = process.env.OWNER_EMAIL;
  if (wanted) {
    const u = await prisma.user.findUnique({ where: { email: wanted } });
    if (!u) throw new Error(`No login with the email ${wanted}`);
    return u;
  }
  const byName = await prisma.user.findFirst({
    where: { isActive: true, name: { contains: 'Ugaban', mode: 'insensitive' } },
  });
  if (byName) return byName;
  const admin = await prisma.user.findUnique({ where: { email: 'admin@gruntech.com' } });
  if (!admin) throw new Error('No owner found: set OWNER_EMAIL');
  return admin;
}

/**
 * The archive's one-way link to the live quotation, where the archive holds
 * the SCORO quote: the archive page then says "Continued in G-CORE as …",
 * and the number check lets the quotation keep the number. The archive row
 * is also pointed at the customer when the import could not match it.
 */
async function linkArchive(quotationId: string, actor: { actorId: string; actorName: string }) {
  const lq = await prisma.legacyQuote.findFirst({
    where: { number: { equals: NUMBER, mode: 'insensitive' } },
    select: { id: true, number: true, status: true, continuedQuotationId: true, customerId: true },
  });
  if (!lq) {
    console.log(`The SCORO archive does not hold ${NUMBER} here — nothing to link`);
    return;
  }
  if (lq.continuedQuotationId === quotationId) {
    console.log(`SCORO quote ${lq.number} already continued as this quotation`);
    return;
  }
  if (lq.continuedQuotationId) {
    console.log(`SCORO quote ${lq.number} is continued as another quotation — left alone`);
    return;
  }
  const quotation = await prisma.quotation.findUniqueOrThrow({ where: { id: quotationId }, select: { customerId: true } });
  await prisma.$transaction(async (tx) => {
    const linked = await tx.legacyQuote.updateMany({
      where: { id: lq.id, continuedQuotationId: null },
      data: { continuedQuotationId: quotationId, ...(lq.customerId ? {} : { customerId: quotation.customerId }) },
    });
    if (linked.count !== 1) throw new Error('Somebody continued this quote a moment ago');
    await audit(
      {
        entityType: LEGACY_QUOTE_ENTITY,
        entityId: lq.id,
        action: 'CONVERTED',
        summary: `Continued in G-CORE as quotation ${NUMBER} (SCORO status ${lq.status}; ongoing project, sample seed)`,
        ...actor,
      },
      undefined,
      tx,
    );
  });
  console.log(`SCORO quote ${lq.number} (${lq.status}) linked: continued in G-CORE`);
}

/**
 * SCORO's two invoices on this quote, as sales orders: 4720 booked 20% of
 * every line as the downpayment, 4897 another 70% at completion. Each line
 * points at the quotation line it books, so the quotation's "Booked" and
 * "Outstanding" (10% left) come out of the ordinary booking arithmetic.
 */
const ORDERS = [
  {
    number: '4720',
    orderDate: '2026-05-30',
    share: 0.2,
    comment: '20% dp\nProject name: CP-51 Pumping system takeover',
  },
  {
    number: '4897',
    orderDate: '2026-09-30',
    share: 0.7,
    comment: '70% booking\n90% completion\nProject name: CP-51 Pumping system takeover',
  },
];
const PO_NUMBER = 'NTP ONLY ALI-PCM-001-F019';
/** SCORO's description on the booked line, where it differs from the quotation's. */
const ORDER_DESCRIPTIONS: Record<string, string> = {
  MATERIALS: 'WORK ORDER',
  'SUPPLY AND INSTALLATION': 'GAS ION JOB ORDER',
};

async function seedOrders(quotationId: string, actor: { actorId: string; actorName: string }) {
  const quotation = await prisma.quotation.findUniqueOrThrow({
    where: { id: quotationId },
    include: { revisions: { include: { items: { orderBy: { sortOrder: 'asc' } } } } },
  });
  // The revision an order books: approved, else latest — the booking rule.
  const revision = valueRevision(quotation.revisions);
  if (!revision) throw new Error(`${quotation.number} has no revision to book`);
  for (const spec of ORDERS) {
    const taken = await prisma.salesOrder.findUnique({
      where: { number: spec.number },
      select: { id: true, quotationId: true, status: true, quotation: { select: { number: true } } },
    });
    if (taken && taken.quotationId === quotationId) {
      console.log(`Sales order ${spec.number} already filed (/g-ops/sales-orders/${taken.id})`);
      continue;
    }
    if (taken && taken.status !== 'DRAFT') {
      console.log(`Sales order ${spec.number} is ${taken.status} on ${taken.quotation.number} — left where it is`);
      continue;
    }
    if (taken) {
      // A draft an earlier run filed on the wrong quotation: refile it here.
      await prisma.$transaction(async (tx) => {
        await tx.salesOrder.delete({ where: { id: taken.id } });
        await audit(
          { entityType: 'sales_order', entityId: taken.id, action: 'DELETED', summary: `Draft sales order ${spec.number} removed from ${taken.quotation.number} to be refiled on ${quotation.number} (sample seed)`, ...actor },
          undefined,
          tx,
        );
      });
      console.log(`Sales order ${spec.number} moved off ${taken.quotation.number}`);
    }
    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.salesOrder.create({
        data: {
          number: spec.number,
          status: 'DRAFT',
          quotationId,
          customerId: quotation.customerId,
          contactId: quotation.contactId,
          ownerId: quotation.ownerId,
          orderDate: new Date(spec.orderDate),
          termsDays: 30,
          paymentMethod: 'Bank transfer',
          poNumber: PO_NUMBER,
          comment: spec.comment,
          vatRate: revision.vatRate,
          vatInclusive: revision.vatInclusive,
          createdAt: new Date(`${spec.orderDate}T00:00:00+08:00`),
        },
      });
      let sortOrder = 0;
      for (const item of revision.items) {
        sortOrder += 1;
        if (item.isHeading) {
          await tx.salesOrderLine.create({
            data: { orderId: created.id, isHeading: true, title: item.title, description: '', quantity: d(0), unit: item.unit, unitPrice: d(0), amount: d(0), sortOrder },
          });
          continue;
        }
        const quantity = d(item.quantity).mul(spec.share).toDecimalPlaces(3);
        const amount = quantity.mul(item.unitPrice).toDecimalPlaces(2);
        const costAmount = item.unitCost == null ? null : quantity.mul(item.unitCost).toDecimalPlaces(2);
        await tx.salesOrderLine.create({
          data: {
            orderId: created.id,
            group: item.group,
            title: item.title,
            description: (item.title && ORDER_DESCRIPTIONS[item.title]) ?? item.description,
            quantity,
            unit: item.unit,
            unitPrice: item.unitPrice,
            amount,
            sortOrder,
            unitCost: item.unitCost,
            costAmount,
            providerSupplierId: item.providerSupplierId,
            providerUserId: item.providerUserId,
            costNote: item.costNote,
            quotationItemId: item.id,
          },
        });
      }
      await rememberGroups(tx, revision.items.map((i) => i.group));
      const totals = await recalcOrder(created.id, tx);
      await audit(
        {
          entityType: 'sales_order',
          entityId: created.id,
          action: 'CREATED',
          summary: `Sales order ${spec.number} filed from SCORO invoice ${spec.number} on ${quotation.number} (sample seed)`,
          ...actor,
        },
        undefined,
        tx,
      );
      return { id: created.id, totals };
    });
    console.log(
      `Sales order ${spec.number} — ${Math.round(spec.share * 100)}% of every line: subtotal ${Number(order.totals.subtotal).toLocaleString()}  total ${Number(order.totals.total).toLocaleString()}  /g-ops/sales-orders/${order.id}`,
    );
  }
}

async function main() {
  const owner = await pickOwner();
  const actor = { actorId: owner.id, actorName: owner.name };
  console.log(`Owner: ${owner.name} <${owner.email}>`);

  // The live quotation is the one carrying the SCORO number — on the server
  // that is the one "Continue in G-CORE" raised. Only when there is none is
  // an earlier run's 0062602018.2 renumbered to take its place.
  const live = await prisma.quotation.findFirst({ where: { number: { equals: NUMBER, mode: 'insensitive' } }, select: { id: true, number: true } });
  const old = await prisma.quotation.findFirst({ where: { number: { equals: OLD_NUMBER, mode: 'insensitive' } }, select: { id: true, number: true } });
  if (live && old) {
    console.log(`${OLD_NUMBER} (an earlier sample) is still on file beside the live ${NUMBER} — delete it from its page, /g-ops/quotations/${old.id}`);
  }
  const existing = live ?? old;
  if (existing) {
    if (existing.number !== NUMBER) {
      await prisma.$transaction(async (tx) => {
        await tx.quotation.update({ where: { id: existing.id }, data: { number: NUMBER } });
        await audit(
          { entityType: 'quotation', entityId: existing.id, action: 'UPDATED', summary: `Quotation ${existing.number} renumbered ${NUMBER} — the SCORO number (sample seed)`, before: { number: existing.number }, after: { number: NUMBER }, ...actor },
          undefined,
          tx,
        );
      });
      console.log(`${existing.number} renumbered ${NUMBER}`);
    }
    await linkArchive(existing.id, actor);
    console.log(`${NUMBER} is filed (/g-ops/quotations/${existing.id})`);
    await seedOrders(existing.id, actor);
    return;
  }

  const result = await prisma.$transaction(async (tx) => {
    // Customer, contact, site.
    let customer = await tx.customer.findFirst({
      where: { name: { equals: 'ABOITIZ LAND, INC.', mode: 'insensitive' } },
    });
    if (!customer) {
      const industry = await tx.industry.findUnique({ where: { code: 'BI' } });
      if (!industry) throw new Error('Industry BI is not seeded — run npm run seed first');
      customer = await tx.customer.create({
        data: {
          code: await nextNumber('customer', tx, { ownerId: owner.id }),
          name: 'ABOITIZ LAND, INC.',
          legalName: 'Aboitiz Land, Inc.',
          industryId: industry.id,
          paymentTerms: '20% DOWNPAYMENT 70% PROGRESS BILLING',
          createdById: owner.id,
        },
      });
      await audit({ entityType: 'customer', entityId: customer.id, action: 'CREATED', summary: `Customer ${customer.code} ${customer.name} (sample seed)`, ...actor }, undefined, tx);
      console.log(`Customer ${customer.code} ${customer.name} created`);
    } else {
      console.log(`Customer ${customer.code} ${customer.name} reused`);
    }

    let contact = await tx.customerContact.findFirst({
      where: { customerId: customer.id, name: { equals: 'Dalia Simbajon', mode: 'insensitive' } },
    });
    if (!contact) {
      const hasPrimary = await tx.customerContact.count({ where: { customerId: customer.id, isPrimary: true } });
      contact = await tx.customerContact.create({
        data: { customerId: customer.id, name: 'Dalia Simbajon', isPrimary: hasPrimary === 0 },
      });
    }

    let site = await tx.customerSite.findFirst({
      where: { customerId: customer.id, name: { equals: 'Aboitiz Building', mode: 'insensitive' } },
    });
    if (!site) {
      site = await tx.customerSite.create({
        data: {
          customerId: customer.id,
          name: 'Aboitiz Building',
          address: 'Archbishop Reyes, Kasambagan, Mabolo',
          city: 'Cebu City',
          contactId: contact.id,
        },
      });
    }

    // The supplier carrying the outsourced line.
    let gasion = await tx.supplier.findFirst({
      where: { name: { contains: 'GAS ION', mode: 'insensitive' } },
    });
    if (!gasion) {
      gasion = await tx.supplier.create({
        data: {
          code: await nextNumber('supplier', tx),
          name: 'GAS ION TECHNOLOGY INC.',
          category: 'Subcontract — installation',
          createdById: owner.id,
        },
      });
      await audit({ entityType: 'supplier', entityId: gasion.id, action: 'CREATED', summary: `Supplier ${gasion.code} ${gasion.name} (sample seed)`, ...actor }, undefined, tx);
      console.log(`Supplier ${gasion.code} ${gasion.name} created`);
    } else {
      console.log(`Supplier ${gasion.code} ${gasion.name} reused`);
    }

    const number = NUMBER;

    const company = await tx.company.findUnique({ where: { id: 'company' }, select: { vatRate: true } });
    const vatRate = company?.vatRate ?? d(0.12);

    const quotation = await tx.quotation.create({
      data: {
        number,
        customerId: customer.id,
        contactId: contact.id,
        siteId: site.id,
        ownerId: owner.id,
        subject: SUBJECT,
        outcome: 'OPEN',
        probability: 10,
        expectedClosing: new Date(CLOSING),
        createdAt: ISSUED,
        revisions: {
          create: {
            revision: 0,
            status: 'DRAFT',
            validityDays: 30,
            delivery: '4 TO 6 WEEKS',
            paymentTerms: '20% DOWNPAYMENT 70% PROGRESS BILLING',
            vatRate,
            createdAt: ISSUED,
          },
        },
      },
      include: { revisions: true },
    });
    const revision = quotation.revisions[0];

    let sortOrder = 0;
    for (const line of LINES) {
      sortOrder += 1;
      if (line.heading) {
        await tx.quotationItem.create({
          data: {
            revisionId: revision.id,
            isHeading: true,
            title: line.heading,
            description: '',
            quantity: d(0),
            unit: 'lot',
            unitPrice: d(0),
            amount: d(0),
            sortOrder,
          },
        });
        continue;
      }
      const price = line.unitPrice ?? 0;
      const cost = line.unitCost;
      await tx.quotationItem.create({
        data: {
          revisionId: revision.id,
          group: line.group ?? null,
          title: line.title ?? null,
          description: line.description ?? '',
          quantity: d(1),
          unit: 'lot',
          unitPrice: d(price),
          amount: d(price),
          sortOrder,
          unitCost: cost == null ? null : d(cost),
          costAmount: cost == null ? null : d(cost),
          providerUserId: line.provider === 'owner' ? owner.id : null,
          providerSupplierId: line.provider === 'gasion' ? gasion.id : null,
          costNote: line.costNote ?? null,
        },
      });
    }
    await rememberGroups(tx, LINES.map((l) => l.group));
    const totals = await recalcQuotationRevision(revision.id, tx);

    await audit(
      {
        entityType: 'quotation',
        entityId: quotation.id,
        action: 'CREATED',
        summary: `Quotation ${number} ${SUBJECT} filed from SCORO quote ${NUMBER} (sample seed)`,
        ...actor,
      },
      undefined,
      tx,
    );
    return { quotation, number, totals };
  });

  const t = result.totals;
  console.log(`Quotation ${result.number} — ${SUBJECT}`);
  console.log(`  subtotal ${Number(t?.subtotal ?? 0).toLocaleString()}  VAT ${Number(t?.vatAmount ?? 0).toLocaleString()}  total ${Number(t?.total ?? 0).toLocaleString()}`);
  console.log(`  open it at /g-ops/quotations/${result.quotation.id}`);
  await linkArchive(result.quotation.id, actor);
  await seedOrders(result.quotation.id, actor);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
