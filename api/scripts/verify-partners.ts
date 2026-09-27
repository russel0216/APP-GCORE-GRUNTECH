/**
 * Masters package verification — partners, industries, and the two 360 pages.
 *
 *   npx tsx scripts/verify-partners.ts
 *
 * Two halves. The first drives the shared logic directly (shared/partners.ts
 * and the real exported import specs), because those rules have no click-path
 * that exercises them all. The second goes over HTTP against the running API
 * with throwaway roles, because the promises this package makes are mostly
 * about WHO sees WHAT: a salesperson reads a partner's price list without ever
 * receiving a cost; the customer page never becomes a way around the leads,
 * installed-base or finance permissions; the supplier page likewise.
 *
 * If the API is down the HTTP half FAILS loudly rather than skipping.
 * Creates its own records (TAG prefix), cleans up at start and end, and
 * refuses to run against production.
 */

import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { resolveUser, menuFor } from '../src/permissions/resolve';
import { permissionsFor } from '../src/permissions/registry';
import { signToken } from '../src/auth/middleware';
import { runImport } from '../src/shared/csv';
import { globalSearch } from '../src/shared/search';
import { deleteAttachment } from '../src/shared/attachments';
import { previewNext } from '../src/shared/numbering';
import { listQuery } from '../src/http/kit';
import {
  PARTNER_RESOURCE_ENTITY,
  makePartner,
  unflagPartner,
  partnerDetail,
  partnerPriceList,
  resourceSchema,
  safeHttpUrl,
} from '../src/shared/partners';
import { partnerSpec, partnerWrite, itemSpec, itemWrite } from '../src/routes/imports';

if (env.isProduction) {
  console.error('Refusing to run against a production database.');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const TAG = 'ZZPARTNER';
const MAIL = '@verifyp.local';
const ROLE = 'zzpartner_';
const INDUSTRY_CODE = 'ZZPV';
const BASE = `http://localhost:${env.port}/api`;

async function cleanup() {
  const suppliers = await prisma.supplier.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true, resources: { select: { id: true } } },
  });
  const resourceIds = suppliers.flatMap((s) => s.resources.map((r) => r.id));
  if (resourceIds.length) {
    const files = await prisma.attachment.findMany({
      where: { entityType: PARTNER_RESOURCE_ENTITY, entityId: { in: resourceIds } },
      select: { id: true },
    });
    for (const f of files) await deleteAttachment(f.id);
  }

  await prisma.payment.deleteMany({ where: { number: { startsWith: TAG } } });
  await prisma.supplierBill.deleteMany({ where: { number: { startsWith: TAG } } });
  await prisma.purchaseOrder.deleteMany({ where: { number: { startsWith: TAG } } });
  await prisma.lead.deleteMany({ where: { number: { startsWith: TAG } } });
  await prisma.item.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.supplier.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.industry.deleteMany({ where: { code: INDUSTRY_CODE } });

  const users = await prisma.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.attachment.deleteMany({ where: { uploadedById: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.role.deleteMany({ where: { key: { startsWith: ROLE } } });
}

/** A role holding exactly the permissions named (copied from verify-hr.ts). */
async function makeRole(key: string, name: string, permissionKeys: string[]) {
  const permissions = await prisma.permission.findMany({
    where: { key: { in: permissionKeys } },
    select: { id: true, key: true },
  });
  if (permissions.length !== permissionKeys.length) {
    const found = new Set(permissions.map((p) => p.key));
    throw new Error(`Unknown permission(s): ${permissionKeys.filter((k) => !found.has(k)).join(', ')}`);
  }
  return prisma.role.create({
    data: { key, name, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } },
  });
}

async function makeUser(name: string, local: string, roleIds: string[]) {
  return prisma.user.create({
    data: {
      name,
      email: `${local}${MAIL}`,
      passwordHash: await bcrypt.hash('x', 10),
      roles: { create: roleIds.map((roleId) => ({ roleId })) },
    },
  });
}

interface HttpResult {
  status: number;
  text: string;
  body: Record<string, unknown>;
}

async function http(token: string, method: string, path: string, body?: unknown): Promise<HttpResult> {
  const isForm = body instanceof FormData;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: isForm ? (body as FormData) : JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, text, body: parsed };
}

async function apiReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** A ListQuery as the route would build it, without an Express request. */
function query(filters: Record<string, string> = {}) {
  return listQuery({ query: { ...filters } } as never);
}

async function main() {
  console.log('\nG-CORE partners, industries and 360 verification\n');
  await cleanup();

  const admin = await prisma.user.findFirst({ where: { isSuperAdmin: true } });
  if (!admin) throw new Error('No super admin — run the seed first');

  // ══ 1. A partner is a supplier ══════════════════════════════════════════
  console.log('A partner is a supplier');

  const fresh = await prisma.$transaction((tx) =>
    makePartner({ name: `${TAG} Compressors Inc.`, brand: `${TAG}AIR` }, admin.id, tx),
  );
  check('a new partner is flagged', fresh.isPartner === true);
  check(
    'and takes a supplier code — no numbering type of its own',
    /^GT-SUPP-\d{4}-\d{4}$/.test(fresh.code),
    fresh.code,
  );

  const plain = await prisma.supplier.create({
    data: { code: `${TAG}-PLAIN`, name: `${TAG} Plain Supplier`, createdById: admin.id },
  });
  const before = await prisma.supplier.count({ where: { name: { startsWith: TAG } } });
  const flagged = await makePartner({ supplierId: plain.id, brand: `${TAG}GEN` }, admin.id);
  const after = await prisma.supplier.count({ where: { name: { startsWith: TAG } } });
  check('flagging an existing supplier keeps its id', flagged.id === plain.id && flagged.isPartner);
  check('and never makes a second supplier row', before === after, `${before} → ${after}`);

  // ══ 2. Links are http(s) only ═══════════════════════════════════════════
  console.log('\nLinks and resources');

  check('a javascript: link is refused', throws(() => safeHttpUrl('javascript:alert(1)')));
  check('an ftp: link is refused', throws(() => safeHttpUrl('ftp://files.example.com/x')));
  check('a bare word is refused', throws(() => safeHttpUrl('catalogue')));
  check(
    'an https link passes unchanged',
    safeHttpUrl(' https://sizing.example.com/app ') === 'https://sizing.example.com/app',
  );
  check(
    'a resource needs no url at the schema (url-or-file is the route’s rule)',
    resourceSchema.safeParse({ kind: 'SIZING_APP', title: 'Sizer' }).success,
  );
  check('an unknown kind is refused', !resourceSchema.safeParse({ kind: 'BROCHURE', title: 'Sizer' }).success);
  const parsedForm = resourceSchema.parse({ kind: 'CATALOGUE', title: 'Cat', isActive: 'false', validFrom: '' });
  check(
    'multipart "false" means false, and a blank date means none',
    parsedForm.isActive === false && parsedForm.validFrom === null,
    JSON.stringify(parsedForm),
  );

  // ══ 3. The price list is prices only ════════════════════════════════════
  console.log('\nPrice list');

  const priced = await prisma.item.create({
    data: {
      code: `${TAG}-ITM-1`,
      name: `${TAG} Screw compressor 37kW`,
      preferredSupplierId: fresh.id,
      standardCost: new Prisma.Decimal(900),
      lastCost: new Prisma.Decimal(950),
      listPrice: new Prisma.Decimal(1234.5),
      listPriceCurrency: 'USD',
    },
  });
  await prisma.item.create({
    data: { code: `${TAG}-ITM-2`, name: `${TAG} Unpriced filter`, preferredSupplierId: fresh.id },
  });
  await prisma.item.create({
    data: {
      code: `${TAG}-ITM-3`,
      name: `${TAG} Someone else's dryer`,
      preferredSupplierId: plain.id,
      listPrice: new Prisma.Decimal(10),
    },
  });

  const list = await partnerPriceList(fresh.id, query());
  const row = list.rows.find((r) => r.id === priced.id) as Record<string, unknown> | undefined;
  check('a priced item carries its list price as a number', row?.listPrice === 1234.5, String(row?.listPrice));
  check('and its currency', row?.listPriceCurrency === 'USD');
  check(
    'and NO cost field reaches the Sales screen',
    !!row && !('standardCost' in row) && !('lastCost' in row),
    row ? Object.keys(row).join(',') : 'no row',
  );
  check('the partner’s unpriced item is listed too', list.total === 2, `${list.total} rows`);
  check(
    'an item of another supplier is not on this price list',
    !list.rows.some((r) => r.name.includes('dryer')),
  );
  const pricedOnly = await partnerPriceList(fresh.id, query({ priced: 'true' }));
  check('"priced only" leaves the unpriced item out', pricedOnly.total === 1, `${pricedOnly.total}`);

  // ══ 4. Removing a partner keeps the supplier ════════════════════════════
  console.log('\nRemoving a partner');

  await prisma.partnerResource.create({
    data: { supplierId: plain.id, kind: 'CATALOGUE', title: 'Gen catalogue', url: 'https://example.com/cat' },
  });
  const resourcesBefore = await prisma.partnerResource.count({ where: { supplierId: plain.id } });
  await unflagPartner(plain.id);
  const stillThere = await prisma.supplier.findUnique({ where: { id: plain.id } });
  check('the supplier row survives', stillThere !== null && stillThere.isPartner === false);
  check(
    'its resources survive, ready for a re-flag',
    (await prisma.partnerResource.count({ where: { supplierId: plain.id } })) === resourcesBefore,
  );
  check('and the partner page no longer finds it', (await partnerDetail(plain.id)) === null);

  const detail = await partnerDetail(fresh.id);
  check('the partner page counts priced items', detail?.counts.pricedItems === 1, JSON.stringify(detail?.counts));

  // ══ 5. Partner CSV, end to end through the real spec ════════════════════
  console.log('\nPartner import');

  const partnerCsv = [
    'Name,Brand,Category,Website,Catalogue URL,Price List URL,Sizing App URL,Contact Name,Active',
    `${TAG} Pumps Corp,${TAG}PUMP,Pumps,https://pumps.example.com,https://pumps.example.com/cat,https://pumps.example.com/prices,https://pumps.example.com/size,Ana Reyes,Yes`,
  ].join('\n');
  const first = await runImport(partnerCsv, partnerSpec, true, partnerWrite);
  check('one partner imported', first.committed && first.created === 1, JSON.stringify(first.rows));
  const pumps = await prisma.supplier.findFirst({
    where: { name: `${TAG} Pumps Corp` },
    include: { resources: true, contacts: true },
  });
  check('it is a partner', pumps?.isPartner === true);
  check(
    'with one link of each kind',
    ['CATALOGUE', 'PRICE_LIST', 'SIZING_APP'].every((k) => pumps?.resources.some((r) => r.kind === k)) &&
      pumps?.resources.length === 3,
    pumps?.resources.map((r) => r.kind).join(','),
  );
  check('and a primary contact', pumps?.contacts.length === 1 && pumps.contacts[0].isPrimary);

  const again = await runImport(partnerCsv, partnerSpec, true, partnerWrite);
  check('re-importing updates rather than creates', again.updated === 1 && again.created === 0);
  check(
    'and does not duplicate the links',
    (await prisma.partnerResource.count({ where: { supplierId: pumps!.id } })) === 3,
  );

  const hostile = [
    'Name,Sizing App URL',
    `${TAG} Hostile,javascript:alert(1)`,
    `${TAG} Fine,https://ok.example.com`,
  ].join('\n');
  const refused = await runImport(hostile, partnerSpec, true, partnerWrite);
  check('a javascript: link in the file is an error', refused.errors === 1, refused.rows[0]?.message);
  check('and blocks the whole file', !refused.committed);

  // ══ 6. Items: preferred supplier by brand, list price ═══════════════════
  console.log('\nItem import');

  const itemCsv = [
    'Code,Name,Preferred Supplier,List Price,List Currency,List Price As Of',
    `${TAG}-ITM-9,${TAG} Booster pump,${TAG}PUMP,999,usd,2026-09-01`,
  ].join('\n');
  const items = await runImport(itemCsv, itemSpec, true, itemWrite);
  check('an item row naming the partner’s BRAND imports', items.committed, JSON.stringify(items.rows));
  const booster = await prisma.item.findUnique({ where: { code: `${TAG}-ITM-9` } });
  check('it resolves to the partner', booster?.preferredSupplierId === pumps?.id);
  check('the list price lands', Number(booster?.listPrice) === 999);
  check('the currency is upper-cased', booster?.listPriceCurrency === 'USD');

  // A brand shared by two supplier rows is ambiguous — refused, not guessed.
  await prisma.supplier.create({
    data: { code: `${TAG}-DIST`, name: `${TAG} Local Distributor`, brand: `${TAG}PUMP` },
  });
  const ambiguous = await runImport(
    ['Code,Name,Preferred Supplier', `${TAG}-ITM-10,${TAG} Seal kit,${TAG}PUMP`].join('\n'),
    itemSpec,
    false,
    itemWrite,
  );
  check(
    'a brand matching two suppliers is refused',
    ambiguous.errors === 1 && (ambiguous.rows[0].message ?? '').includes('more than one'),
    ambiguous.rows[0]?.message,
  );

  // ══ 7. Search and menu ══════════════════════════════════════════════════
  console.log('\nSearch and menu');

  const viewRole = await makeRole(`${ROLE}view`, 'Verify partner viewer', [
    'gops.partners.view_all',
    'gops.partners.export',
  ]);
  const otherRole = await makeRole(`${ROLE}other`, 'Verify no partners', ['gops.customers.view_all']);
  const viewer = await makeUser('Verify Partner Viewer', 'viewer', [viewRole.id]);
  const outsider = await makeUser('Verify Outsider', 'outsider', [otherRole.id]);
  const viewerR = (await resolveUser(viewer.id))!;
  const outsiderR = (await resolveUser(outsider.id))!;

  const hits = await globalSearch(`${TAG}AIR`, viewerR);
  const partnerHit = hits.find((h) => h.kind === 'partner');
  check('a partner is findable by its brand', !!partnerHit);
  check('and links into Sales', partnerHit?.link === `/g-ops/partners/${fresh.id}`, partnerHit?.link);
  check(
    'without the key, no partner hit appears',
    !(await globalSearch(`${TAG}AIR`, outsiderR)).some((h) => h.kind === 'partner'),
  );
  const docHits = await globalSearch('Gen catalogue', viewerR);
  check(
    'a resource of a REMOVED partner is not findable',
    !docHits.some((h) => h.kind === 'partner_resource' && h.link.includes(plain.id)),
  );
  await makePartner({ supplierId: plain.id }, admin.id);
  const docHits2 = await globalSearch('Gen catalogue', viewerR);
  check(
    'and is again once it is a partner',
    docHits2.some((h) => h.kind === 'partner_resource' && h.link === `/g-ops/partners/${plain.id}`),
  );

  const gops = menuFor(viewerR).find((m) => m.key === 'gops');
  const entry = gops?.submodules.find((s) => s.key === 'partners');
  check(
    'the menu entry is Sales › Partners at /g-ops/partners',
    entry?.group === 'Sales' && entry.path === '/g-ops/partners',
    JSON.stringify(entry),
  );
  check(
    'gops.partners has exactly the five shared actions',
    JSON.stringify(permissionsFor('gops', 'partners').sort()) ===
      JSON.stringify(
        ['gops.partners.view_all', 'gops.partners.create', 'gops.partners.edit_all', 'gops.partners.delete', 'gops.partners.export'].sort(),
      ),
    permissionsFor('gops', 'partners').join(','),
  );

  // ══ 8. Over HTTP ════════════════════════════════════════════════════════
  console.log('\nRoute guards and 360 pages (over HTTP)');

  if (!(await apiReachable())) {
    failed += 1;
    console.log(
      `  ✗ the API is not reachable at ${BASE} — the route guards were NOT verified.\n` +
        '      Start it with "npm run dev" in api/ and run this script again.',
    );
  } else {
    await httpCases({ admin, viewer, outsider, fresh, pumpsId: pumps!.id, plainId: plain.id });
  }

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

async function httpCases(ctx: {
  admin: { id: string; email: string };
  viewer: { id: string; email: string };
  outsider: { id: string; email: string };
  fresh: { id: string };
  pumpsId: string;
  plainId: string;
}) {
  const adminT = signToken(ctx.admin.id, ctx.admin.email);
  const viewerT = signToken(ctx.viewer.id, ctx.viewer.email);
  const outsiderT = signToken(ctx.outsider.id, ctx.outsider.email);

  const mgrRole = await makeRole(`${ROLE}mgr`, 'Verify partner manager', permissionsFor('gops', 'partners'));
  const manager = await makeUser('Verify Partner Manager', 'manager', [mgrRole.id]);
  const mgrT = signToken(manager.id, manager.email);

  // ── Partners ──────────────────────────────────────────────────────────────
  const listed = await http(viewerT, 'GET', `/partners?search=${TAG}`);
  check('a viewer lists partners', listed.status === 200, String(listed.status));
  check('without the key the list is refused', (await http(outsiderT, 'GET', '/partners')).status === 403);

  const prices = await http(viewerT, 'GET', `/partners/${ctx.fresh.id}/price-list`);
  check('a viewer reads the price list', prices.status === 200, String(prices.status));
  check(
    'and the response carries the list price',
    prices.text.includes('"listPrice":1234.5'),
    prices.text.slice(0, 200),
  );
  check(
    'but no cost field anywhere in the bytes',
    !prices.text.includes('standardCost') && !prices.text.includes('lastCost'),
  );
  check(
    'a supplier that is not a partner has no price list here',
    (await http(viewerT, 'GET', `/partners/${ctx.pumpsId}x/price-list`)).status === 404,
  );

  check(
    'a viewer cannot add a partner',
    (await http(viewerT, 'POST', '/partners', { name: `${TAG} Nope` })).status === 403,
  );
  const created = await http(mgrT, 'POST', '/partners', { name: `${TAG} Chillers Ltd`, brand: `${TAG}COOL` });
  check('a manager adds one', created.status === 201, created.text.slice(0, 200));
  const newId = String(created.body.id ?? '');
  const audited = await prisma.auditLog.count({ where: { entityType: 'supplier', entityId: newId, action: 'CREATED' } });
  check('and the addition is audited', audited === 1, `${audited}`);

  const js = new FormData();
  js.set('kind', 'SIZING_APP');
  js.set('title', 'Evil sizer');
  js.set('url', 'javascript:alert(1)');
  check(
    'a javascript: link is refused by the route',
    (await http(mgrT, 'POST', `/partners/${newId}/resources`, js)).status === 400,
  );
  const empty = new FormData();
  empty.set('kind', 'CATALOGUE');
  empty.set('title', 'Nothing attached');
  const noSource = await http(mgrT, 'POST', `/partners/${newId}/resources`, empty);
  check('a resource with neither file nor link is refused', noSource.status === 400, noSource.text.slice(0, 120));

  const withFile = new FormData();
  withFile.set('kind', 'CATALOGUE');
  withFile.set('title', '2026 chiller catalogue');
  withFile.set('isActive', 'true');
  withFile.set('file', new Blob(['%PDF-1.4\n%verify\n'], { type: 'application/pdf' }), 'chillers.pdf');
  const upload = await http(mgrT, 'POST', `/partners/${newId}/resources`, withFile);
  const uploaded = upload.body as { id?: string; attachment?: { id: string; fileName: string } | null };
  check(
    'a catalogue file uploads through the one attachment service',
    upload.status === 201 && uploaded.attachment?.fileName === 'chillers.pdf',
    upload.text.slice(0, 200),
  );

  const replace = new FormData();
  replace.set('removeFile', 'true');
  replace.set('url', 'https://chillers.example.com/catalogue');
  const patched = await http(mgrT, 'PATCH', `/partners/${newId}/resources/${uploaded.id}`, replace);
  check(
    'removing the file while adding a link leaves a link-only resource',
    patched.status === 200 &&
      (patched.body as { attachment: unknown }).attachment === null &&
      (patched.body as { url: string }).url === 'https://chillers.example.com/catalogue',
    patched.text.slice(0, 200),
  );
  const orphan = await prisma.attachment.count({
    where: { entityType: PARTNER_RESOURCE_ENTITY, entityId: uploaded.id ?? '' },
  });
  check('and the file itself is gone', orphan === 0, `${orphan}`);

  check(
    'a viewer cannot remove a resource',
    (await http(viewerT, 'DELETE', `/partners/${newId}/resources/${uploaded.id}`)).status === 403,
  );

  // Procurement's delete refuses while Sales lists it — otherwise its
  // catalogues would cascade away unseen.
  const del = await http(adminT, 'DELETE', `/suppliers/${newId}`);
  check('a partner cannot be deleted as a supplier', del.status === 400, del.text.slice(0, 160));
  const unflag = await http(mgrT, 'DELETE', `/partners/${newId}`);
  check('removing it from partners keeps the supplier', unflag.status === 200 && !!(await prisma.supplier.findUnique({ where: { id: newId } })));
  check('after which it no longer opens as a partner', (await http(viewerT, 'GET', `/partners/${newId}`)).status === 404);

  // ── Industries ────────────────────────────────────────────────────────────
  const industries = await http(outsiderT, 'GET', '/reference/industries?active=true');
  const industryRows = (industries.body as unknown as { id: string; code: string; isSystem: boolean }[]) ?? [];
  check(
    'any signed-in user reads the industry list',
    industries.status === 200 && Array.isArray(industries.body) && industryRows.some((i) => i.code === 'HI'),
    industries.text.slice(0, 120),
  );
  const hi = industryRows.find((i) => i.code === 'HI')!;
  const gi = industryRows.find((i) => i.code === 'GI')!;
  check(
    'a standard industry cannot be deleted',
    (await http(adminT, 'DELETE', `/reference/industries/${hi.id}`)).status === 400,
  );
  check(
    'nor recoded',
    (await http(adminT, 'PATCH', `/reference/industries/${hi.id}`, { code: 'HX' })).status === 400,
  );
  check(
    'and only an administrator may add one',
    (await http(viewerT, 'POST', '/reference/industries', { code: INDUSTRY_CODE, name: 'Verify industry' })).status === 403,
  );
  const extra = await http(adminT, 'POST', '/reference/industries', { code: INDUSTRY_CODE.toLowerCase(), name: 'Verify industry' });
  check('an administrator adds one (code upper-cased)', extra.status === 201 && extra.body.code === INDUSTRY_CODE, extra.text.slice(0, 120));
  const extraId = String(extra.body.id ?? '');

  // ── Customers ─────────────────────────────────────────────────────────────
  const custRole = await makeRole(`${ROLE}cust`, 'Verify customer editor', [
    'gops.customers.view_all',
    'gops.customers.create',
    'gops.customers.edit_all',
    'gops.leads.view_own',
  ]);
  const clerk = await makeUser('Verify Customer Clerk', 'clerk', [custRole.id]);
  const clerkT = signToken(clerk.id, clerk.email);

  const noIndustry = await http(clerkT, 'POST', '/customers', { name: `${TAG} No Industry Co` });
  check('a customer without an industry is refused', noIndustry.status === 400, noIndustry.text.slice(0, 160));

  await prisma.industry.update({ where: { id: extraId }, data: { isActive: false } });
  const inactive = await http(clerkT, 'POST', '/customers', { name: `${TAG} Inactive Co`, industryId: extraId });
  check('an inactive industry is refused', inactive.status === 400, inactive.text.slice(0, 160));
  await prisma.industry.update({ where: { id: extraId }, data: { isActive: true } });

  const expectCode = (await previewNext('customer')).number;
  const nextCode = await http(clerkT, 'GET', '/customers/next-code');
  check(
    'next-code previews exactly what nextNumber would issue',
    nextCode.status === 200 && nextCode.body.code === expectCode,
    `${nextCode.body.code} vs ${expectCode}`,
  );

  const hospital = await http(clerkT, 'POST', '/customers', { name: `${TAG} Hospital`, industryId: hi.id });
  check('a customer is created with its industry', hospital.status === 201, hospital.text.slice(0, 160));
  const hospitalId = String(hospital.body.id ?? '');
  const createdAudit = await prisma.auditLog.findFirst({ where: { entityType: 'customer', entityId: hospitalId, action: 'CREATED' } });
  check('the audit line names the industry code', (createdAudit?.summary ?? '').includes('(HI)'), createdAudit?.summary ?? '');

  check(
    'reclassifying to null is refused',
    (await http(clerkT, 'PATCH', `/customers/${hospitalId}`, { industryId: null })).status === 400,
  );

  const plant = await prisma.customer.create({
    data: { code: `${TAG}-C2`, name: `${TAG} Plant`, industryId: gi.id },
  });
  const legacy = await prisma.customer.create({ data: { code: `${TAG}-C3`, name: `${TAG} Legacy` } });
  // The in-use guard on a non-system industry.
  await prisma.customer.update({ where: { id: plant.id }, data: { industryId: extraId } });
  check(
    'an industry customers carry cannot be deleted',
    (await http(adminT, 'DELETE', `/reference/industries/${extraId}`)).status === 400,
  );
  await prisma.customer.update({ where: { id: plant.id }, data: { industryId: gi.id } });

  const names = async (q: string) =>
    ((await http(clerkT, 'GET', `/customers?search=${TAG}&${q}`)).body.rows as { name: string }[] | undefined)?.map(
      (r) => r.name,
    ) ?? [];
  const hiRows = await names('industry=hi');
  check('the list filters by industry code, any case', hiRows.includes(`${TAG} Hospital`) && !hiRows.includes(`${TAG} Plant`), hiRows.join(','));
  const noneRows = await names('industry=none');
  check('"Unclassified" finds the customer nobody has filed', noneRows.includes(`${TAG} Legacy`) && !noneRows.includes(`${TAG} Hospital`), noneRows.join(','));
  void legacy;

  // ── Customer 360 is a window, never a way around ──────────────────────────
  const other = await makeUser('Verify Other Rep', 'rep2', [custRole.id]);
  await prisma.lead.create({
    data: { number: `${TAG}-L1`, companyName: `${TAG} Hospital`, customerId: hospitalId, assignedToId: clerk.id, createdById: clerk.id },
  });
  await prisma.lead.create({
    data: { number: `${TAG}-L2`, companyName: `${TAG} Hospital`, customerId: hospitalId, assignedToId: other.id, createdById: other.id },
  });

  const c360 = await http(clerkT, 'GET', `/customers/${hospitalId}`);
  const leads = (c360.body.leads as { number: string }[] | undefined) ?? [];
  check('the 360 page lists the leads the caller owns', leads.some((l) => l.number === `${TAG}-L1`), JSON.stringify(leads));
  check('and omits the ones a view_own user does not own', !leads.some((l) => l.number === `${TAG}-L2`));
  const blanks = ['installedAssets', 'serviceReports', 'payments', 'jobOrders', 'invoices', 'quotations'];
  check(
    'collections behind permissions the caller lacks arrive empty',
    blanks.every((k) => Array.isArray(c360.body[k]) && (c360.body[k] as unknown[]).length === 0),
    blanks.map((k) => `${k}:${Array.isArray(c360.body[k]) ? (c360.body[k] as unknown[]).length : 'missing'}`).join(' '),
  );
  const asAdmin = await http(adminT, 'GET', `/customers/${hospitalId}`);
  check(
    'a view_all caller sees both leads',
    ((asAdmin.body.leads as unknown[]) ?? []).length === 2,
    String(((asAdmin.body.leads as unknown[]) ?? []).length),
  );
  check(
    'and the industry rides on the record',
    (asAdmin.body.industry as { code?: string } | null)?.code === 'HI',
  );

  // ── Supplier 360, same rule ───────────────────────────────────────────────
  const poRole = await makeRole(`${ROLE}po`, 'Verify buyer', [
    'gchain.suppliers.view_all',
    'gchain.purchase_orders.view_all',
  ]);
  const buyer = await makeUser('Verify Buyer', 'buyer', [poRole.id]);
  const buyerT = signToken(buyer.id, buyer.email);
  await prisma.purchaseOrder.create({
    data: { number: `${TAG}-PO-1`, supplierId: ctx.fresh.id, createdById: ctx.admin.id, total: new Prisma.Decimal(5000) },
  });
  await prisma.supplierBill.create({
    data: {
      number: `${TAG}-BILL-1`,
      supplierId: ctx.fresh.id,
      billDate: new Date(),
      dueDate: new Date(),
      subtotal: new Prisma.Decimal(100),
      vatAmount: new Prisma.Decimal(12),
      total: new Prisma.Decimal(112),
      netPayable: new Prisma.Decimal(110),
      createdById: ctx.admin.id,
    },
  });
  const s360 = await http(buyerT, 'GET', `/suppliers/${ctx.fresh.id}`);
  const pos = (s360.body.purchaseOrders as { number: string; total: unknown }[] | undefined) ?? [];
  check('the supplier page lists its purchase orders', pos.some((p) => p.number === `${TAG}-PO-1`), s360.text.slice(0, 160));
  check('with money as a number at the boundary', pos[0]?.total === 5000, String(pos[0]?.total));
  check(
    'but not a bill the caller cannot open',
    Array.isArray(s360.body.bills) && (s360.body.bills as unknown[]).length === 0,
  );
  const s360Admin = await http(adminT, 'GET', `/suppliers/${ctx.fresh.id}`);
  const bills = (s360Admin.body.bills as { number: string; outstanding: number }[] | undefined) ?? [];
  check(
    'a finance-capable caller sees the bill and what is outstanding',
    bills.some((b) => b.number === `${TAG}-BILL-1` && b.outstanding === 110),
    JSON.stringify(bills).slice(0, 160),
  );
}

main()
  .catch(async (err) => {
    console.error('\nVerification crashed:', err);
    failed++;
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch((e) => console.error('cleanup failed:', e));
    await prisma.$disconnect();
  });
