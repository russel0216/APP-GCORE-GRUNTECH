/**
 * Sales › Marketing — exhibition visitors (2026-10-27, PSECE 2026).
 *
 * The badge reader on the owner's own badge and its web copy, the brand
 * matching the spreadsheet import leans on, then over HTTP: an exhibition and
 * its days, a visitor from a scanned badge, the same badge scanned again by
 * someone else (one visitor, two scans, the brands joined), the rights (View
 * Own, nobody, Delete), Modify, the bar graphs' figures against the list,
 * the lead made once, the paper, and the spreadsheet import (aliases, a
 * column per brand, "Brand: product", the same person on two rows).
 */
import bcrypt from 'bcryptjs';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { signToken } from '../src/auth/middleware';
import { parseBadge, parseBadgeWith, matchBrand, splitProducts, brandKey, EXHIBITION_BRANDS } from '../src/shared/marketing';
import { parseBadge as webParseBadge, parseBadgeWith as webParseBadgeWith } from '../../web/src/lib/badge';
import { runImport } from '../src/shared/csv';
import { exhibitionVisitorsSpecFor, exhibitionVisitorsWrite } from '../src/routes/imports/exhibitionVisitors';
import { dayKey } from '../src/shared/day';

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

const TAG = 'ZZMARKETING';
const BASE = `http://localhost:${env.port}/api`;

// The owner's own PSECE badge, read off the photo he sent (2026-10-27).
const OWNER_BADGE =
  'BEGIN:VCARD\nVERSION:3.0\nFN:JHON RUSSEL BALICAS\nN:BALICAS;JHON RUSSEL;;;\nORG:GRUNTECHNOLOGY CORPORATION\nTITLE:TECHNICAL HEAD\nEMAIL:russelbalicas@gruntechnology.com\nTEL;CELL:+639617562416\nEND:VCARD';

async function cleanup() {
  const events = await prisma.exhibition.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const visitors = await prisma.exhibitionVisitor.findMany({ where: { OR: [{ exhibitionId: { in: events.map((e) => e.id) } }, { createdBy: { email: { endsWith: '@verifymk.local' } } }, { name: { startsWith: TAG } }] }, select: { id: true, leadId: true } });
  await prisma.exhibitionVisitor.deleteMany({ where: { id: { in: visitors.map((v) => v.id) } } });
  await prisma.lead.deleteMany({ where: { id: { in: visitors.map((v) => v.leadId).filter((x): x is string => !!x) } } });
  await prisma.lead.deleteMany({ where: { source: { startsWith: `Exhibition: ${TAG}` } } });
  await prisma.exhibitionScan.deleteMany({ where: { user: { email: { endsWith: '@verifymk.local' } } } });
  await prisma.exhibition.deleteMany({ where: { id: { in: events.map((e) => e.id) } } });
  await prisma.notification.deleteMany({ where: { OR: [{ title: { contains: TAG } }, { body: { contains: TAG } }, { user: { email: { endsWith: '@verifymk.local' } } }] } });
  await prisma.auditLog.deleteMany({ where: { actor: { email: { endsWith: '@verifymk.local' } } } });
  await prisma.userRole.deleteMany({ where: { user: { email: { endsWith: '@verifymk.local' } } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: '@verifymk.local' } } });
  await prisma.role.deleteMany({ where: { key: { startsWith: TAG.toLowerCase() } } });
}

async function makeUser(slug: string, keys: string[]) {
  const perms = await prisma.permission.findMany({ where: { key: { in: keys } }, select: { id: true } });
  const role = await prisma.role.create({ data: { key: `${TAG.toLowerCase()}_${slug}`, name: `${TAG} ${slug}`, permissions: { create: perms.map((p) => ({ permissionId: p.id })) } } });
  const user = await prisma.user.create({
    data: { name: `${TAG} ${slug}`, email: `${slug}@verifymk.local`, passwordHash: await bcrypt.hash('x', 10), roles: { create: [{ roleId: role.id }] } },
  });
  return { user, token: signToken(user.id, user.email) };
}

async function http(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed as Record<string, any>, contentType: res.headers.get('content-type') ?? '' }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function apiReachable() {
  try {
    return (await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}

async function main() {
  console.log('\nThe badge');
  const b = parseBadge(OWNER_BADGE);
  check('The owner’s PSECE badge reads its name, company, position, email and mobile', b.name === 'JHON RUSSEL BALICAS' && b.company === 'GRUNTECHNOLOGY CORPORATION' && b.position === 'TECHNICAL HEAD' && b.email === 'russelbalicas@gruntechnology.com' && b.mobile === '+639617562416', JSON.stringify(b));
  const fixtures = [
    OWNER_BADGE,
    OWNER_BADGE.replace(/\n/g, '\r\n'),
    'BEGIN:VCARD\nVERSION:3.0\nN:Dela Cruz;Juan;P.;;\nORG:ABC Inc.;Facilities\nTEL;TYPE=WORK:+63 2 8123 4567\nTEL;TYPE=CELL:+63 917 123 4567\nEMAIL;TYPE=INTERNET:juan@abc.com\nEND:VCARD',
    'BEGIN:VCARD\nVERSION:3.0\nFN:Maria\n  Santos\nTITLE:Plant Engineer\nEND:VCARD',
    'MECARD:N:Santos,Maria;ORG:XYZ Corp;TEL:09171234567;EMAIL:maria@xyz.com;;',
    'Visitor 0123 — call me at +63 917 555 0101 or ana@example.org',
    '',
  ];
  check('The web copy reads every badge as the API does', fixtures.every((f) => JSON.stringify(parseBadge(f)) === JSON.stringify(webParseBadge(f))));
  const n = parseBadge(fixtures[2]);
  check('A vCard with N only gives "first middle last", the cell number over the work one, both ORG parts', n.name === 'Juan P. Dela Cruz' && n.mobile === '+63 917 123 4567' && n.company === 'ABC Inc., Facilities', JSON.stringify(n));
  check('A folded vCard line is joined', parseBadge(fixtures[3]).name === 'Maria Santos', String(parseBadge(fixtures[3]).name));
  const m = parseBadge(fixtures[4]);
  check('A MECARD reads too', m.name === 'Maria Santos' && m.company === 'XYZ Corp' && m.email === 'maria@xyz.com' && m.mobile === '09171234567', JSON.stringify(m));
  const p = parseBadge(fixtures[5]);
  check('Plain text gives its email and number, and no guessed name', p.email === 'ana@example.org' && p.mobile === '+63 917 555 0101' && p.name === null, JSON.stringify(p));

  console.log('\nAnother exhibition’s badge');
  const piped = { qrFormat: 'DELIMITED', qrSeparator: '|', qrFields: ['skip', 'name', 'position', 'company', 'email', 'mobile'] };
  const d1 = parseBadgeWith('V-00123|Ana Reyes|Plant Engineer|Fab One Inc.|ana@fabone.ph|0917 000 0001', piped);
  check('A text badge is read in the exhibition’s own order, a part skipped', d1.name === 'Ana Reyes' && d1.position === 'Plant Engineer' && d1.company === 'Fab One Inc.' && d1.email === 'ana@fabone.ph' && d1.mobile === '0917 000 0001', JSON.stringify(d1));
  const split = { qrFormat: 'DELIMITED', qrSeparator: 'TAB', qrFields: ['firstName', 'lastName', 'position'] };
  const d2 = parseBadgeWith('Ben\tCruz\tBuyer', split);
  check('First and last names join; a tab separates', d2.name === 'Ben Cruz' && d2.position === 'Buyer', JSON.stringify(d2));
  check('A vCard scanned at a text-badge exhibition is still read as a vCard', parseBadgeWith(OWNER_BADGE, piped).position === 'TECHNICAL HEAD');
  check('A badge with fewer parts leaves the rest empty', parseBadgeWith('V-9|Carl', piped).name === 'Carl' && parseBadgeWith('V-9|Carl', piped).email === null);
  const dfixtures: [string, typeof piped][] = [
    ['V-00123|Ana Reyes|Plant Engineer|Fab One Inc.|ana@fabone.ph|0917 000 0001', piped],
    ['Ben\tCruz\tBuyer', split],
    [OWNER_BADGE, piped],
    ['a;b;c', { qrFormat: 'DELIMITED', qrSeparator: ';', qrFields: ['company', 'name', 'position'] }],
    ['x\ny', { qrFormat: 'DELIMITED', qrSeparator: 'NEWLINE', qrFields: ['name', 'company'] }],
    [OWNER_BADGE, { qrFormat: 'AUTO', qrSeparator: null as unknown as string, qrFields: [] }],
  ];
  check('The web copy reads every exhibition’s badge as the API does', dfixtures.every(([t, f]) => JSON.stringify(parseBadgeWith(t, f)) === JSON.stringify(webParseBadgeWith(t, f))));

  console.log('\nBrands');
  const brands = EXHIBITION_BRANDS.map((name, i) => ({ id: String(i), name }));
  check('Short forms find their brand: Schneider, Nidec, Omega, Suto itec, sure purity', matchBrand('Schneider', brands)?.name === 'Schneider Electric' && matchBrand('nidec', brands)?.name === 'Nidec Drives' && matchBrand('Omega', brands)?.name === 'Omega Air' && matchBrand('Suto itec', brands)?.name === 'Suto-itec' && matchBrand('sure purity', brands)?.name === 'Sure Purity');
  check('Two letters, or a word no brand starts, is no brand', matchBrand('Sc', brands) === null && matchBrand('Atlas', brands) === null);
  check('A brand followed by its product still finds the brand', matchBrand('Schneider Electric UPS', brands)?.name === 'Schneider Electric');
  check('Products split on commas, each once whatever its case', JSON.stringify(splitProducts('UPS, ups , PLC;F600\n')) === JSON.stringify(['UPS', 'PLC', 'F600']));
  const onFile = await prisma.exhibitionBrand.findMany({ where: { isActive: true } });
  check('The owner’s nine brands are on file', EXHIBITION_BRANDS.every((name) => onFile.some((x) => brandKey(x.name) === brandKey(name))), onFile.map((x) => x.name).join(', '));

  if (!(await apiReachable())) {
    failed++;
    console.log(`  ✗ API is not reachable at ${BASE} — the HTTP checks did not run`);
    return;
  }

  await cleanup();
  const all = await makeUser('all', ['gops.marketing.view_all', 'gops.marketing.create', 'gops.marketing.edit_all', 'gops.leads.create']);
  const own = await makeUser('own', ['gops.marketing.view_own', 'gops.marketing.create', 'gops.marketing.edit_own']);
  const none = await makeUser('none', ['gops.leads.view_all']);
  const boss = await makeUser('boss', ['gops.marketing.view_all', 'gops.marketing.edit_all', 'gops.marketing.delete']);

  console.log('\nThe exhibition');
  const today = dayKey(new Date()).toISOString().slice(0, 10);
  const plus = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
  const made = await http(all.token, 'POST', '/marketing/exhibitions', { name: `${TAG} Expo`, startDate: today, endDate: plus(today, 2) });
  check('An exhibition is set up by an Edit All holder', made.status === 201, JSON.stringify(made.body));
  const ex = made.body;
  check('It runs three days, and today is Day 1', ex.days?.length === 3 && ex.today === 1, JSON.stringify({ days: ex.days, today: ex.today }));
  check('View Own cannot set one up', (await http(own.token, 'POST', '/marketing/exhibitions', { name: `${TAG} X`, startDate: today, endDate: today })).status === 403);
  check('A last day before Day 1 is refused', (await http(all.token, 'POST', '/marketing/exhibitions', { name: `${TAG} Bad`, startDate: today, endDate: plus(today, -1) })).status === 400);

  const brandRows = await http(all.token, 'GET', '/reference/exhibition-brands?active=true');
  const brandList = brandRows.body as unknown as { id: string; name: string }[];
  const schneider = brandList.find((x) => x.name === 'Schneider Electric')!;
  const nidec = brandList.find((x) => x.name === 'Nidec Drives')!;
  const omega = brandList.find((x) => x.name === 'Omega Air')!;

  console.log('\nScanning');
  const scanned = await http(all.token, 'POST', '/marketing/visitors', {
    exhibitionId: ex.id,
    name: 'JHON RUSSEL BALICAS',
    company: 'GRUNTECHNOLOGY CORPORATION',
    position: 'TECHNICAL HEAD',
    email: 'RusselBalicas@gruntechnology.com',
    mobile: '+639617562416',
    qrText: `${OWNER_BADGE}\nNOTE:${TAG}`,
    source: 'SCAN',
    interests: [
      { brandId: schneider.id, products: 'UPS, PLC' },
      { brandId: nidec.id, products: 'F600' },
    ],
  });
  check('A scanned badge is a new visitor on today’s day', scanned.status === 201 && scanned.body.day === 1 && scanned.body.merged === false, JSON.stringify(scanned.body).slice(0, 300));
  const v1 = scanned.body;
  check('Its brands and the products under each are kept', v1.brands?.length === 2 && v1.brands.find((x: { brandId: string }) => x.brandId === schneider.id)?.products.join() === 'UPS,PLC');
  check('The email is kept in small letters', v1.email === 'russelbalicas@gruntechnology.com', v1.email);

  const match = await http(own.token, 'GET', `/marketing/visitors/match?exhibitionId=${ex.id}&email=russelbalicas@gruntechnology.com`);
  check('The scanner hears the badge is already on file — and, for a View Own holder, not whose', match.status === 200 && match.body.visitor === null && match.body.exists === true, JSON.stringify(match.body));

  const again = await http(own.token, 'POST', '/marketing/visitors', {
    exhibitionId: ex.id,
    name: 'JHON RUSSEL BALICAS',
    email: 'russelbalicas@gruntechnology.com',
    qrText: `${OWNER_BADGE}\nNOTE:${TAG}`,
    interests: [
      { brandId: schneider.id, products: 'ups, Inverter' },
      { brandId: omega.id, products: '' },
    ],
    notes: 'Asked for a catalogue',
  });
  check('The same badge scanned again by someone else is the SAME visitor', again.status === 200 && again.body.merged === true && again.body.id === v1.id, JSON.stringify(again.body).slice(0, 200));
  const merged = await prisma.exhibitionVisitor.findUnique({ where: { id: v1.id }, include: { interests: { include: { brand: true } }, scans: true } });
  check('Two scans, by two people', merged?.scans.length === 2 && new Set(merged.scans.map((s) => s.userId)).size === 2);
  check('The brands are joined — Schneider gains Inverter (UPS once), Omega added, Nidec kept', merged?.interests.filter((i) => i.brandId === schneider.id).map((i) => i.product).sort().join() === 'Inverter,PLC,UPS' && merged.interests.some((i) => i.brandId === omega.id && i.product === null) && merged.interests.some((i) => i.brandId === nidec.id));
  check('The note is added', merged?.notes === 'Asked for a catalogue');
  check('Only one visitor for the badge', (await prisma.exhibitionVisitor.count({ where: { exhibitionId: ex.id } })) === 1);

  const ownVisitor = await http(own.token, 'POST', '/marketing/visitors', { exhibitionId: ex.id, day: 1, name: `${TAG} Walk-in`, company: 'Walk-in Co', interests: [{ brandId: omega.id, products: 'Dryer' }] });
  check('A visitor typed in on Day 1, with no badge', ownVisitor.status === 201 && ownVisitor.body.day === 1 && ownVisitor.body.source === 'MANUAL');
  check('A day the exhibition does not have is refused', (await http(all.token, 'POST', '/marketing/visitors', { exhibitionId: ex.id, day: 4, name: `${TAG} Late`, interests: [] })).status === 400);
  check('A name is required', (await http(all.token, 'POST', '/marketing/visitors', { exhibitionId: ex.id, name: ' ', interests: [] })).status === 400);

  console.log('\nRights');
  check('Nobody without Marketing reads the list', (await http(none.token, 'GET', `/marketing/visitors?exhibitionId=${ex.id}`)).status === 403);
  const ownList = await http(own.token, 'GET', `/marketing/visitors?exhibitionId=${ex.id}`);
  check('View Own lists the visitors one added', ownList.status === 200 && ownList.body.total === 1 && ownList.body.rows[0].id === ownVisitor.body.id, JSON.stringify(ownList.body.total));
  check('View Own does not open a colleague’s visitor', (await http(own.token, 'GET', `/marketing/visitors/${v1.id}`)).status === 404);
  check('Edit Own does not change a colleague’s visitor', (await http(own.token, 'PATCH', `/marketing/visitors/${v1.id}`, { notes: 'x' })).status === 403);
  check('Edit Own changes one’s own', (await http(own.token, 'PATCH', `/marketing/visitors/${ownVisitor.body.id}`, { position: 'Buyer' })).status === 200);
  check('Delete is refused without its box', (await http(all.token, 'DELETE', `/marketing/visitors/${ownVisitor.body.id}`)).status === 403);

  console.log('\nModify');
  const mod = await http(all.token, 'PATCH', `/marketing/visitors/${v1.id}`, { day: 2, interests: [{ brandId: nidec.id, products: 'F600, F510' }] });
  check('A saved visitor stays editable: day and brands replaced', mod.status === 200 && mod.body.day === 2 && mod.body.brands.length === 1 && mod.body.brands[0].products.join() === 'F600,F510', JSON.stringify(mod.body.brands));
  check('An email another visitor has is refused', (await http(all.token, 'PATCH', `/marketing/visitors/${ownVisitor.body.id}`, { email: 'russelbalicas@gruntechnology.com' })).status === 409);

  console.log('\nThe bar graphs');
  const dash = await http(all.token, 'GET', `/marketing/dashboard?exhibitionId=${ex.id}`);
  const nidecBar = dash.body.byBrand?.find((x: { brandId: string }) => x.brandId === nidec.id);
  const nidecList = await http(all.token, 'GET', `/marketing/visitors?exhibitionId=${ex.id}&brandId=${nidec.id}`);
  check('A brand’s bar counts what its list holds', nidecBar?.visitors === 1 && nidecList.body.total === 1, JSON.stringify({ nidecBar, total: nidecList.body.total }));
  check('Visitors per day: one on Day 1, one on Day 2', dash.body.byDay?.[0]?.visitors === 1 && dash.body.byDay?.[1]?.visitors === 1, JSON.stringify(dash.body.byDay));
  check('Scans per person: each scanner counted', dash.body.byScanner?.length === 2 && dash.body.totals?.scans === 3, JSON.stringify(dash.body.byScanner));
  check('The products under Nidec Drives are listed', dash.body.products?.find((x: { brandId: string }) => x.brandId === nidec.id)?.products.map((x: { product: string }) => x.product).sort().join() === 'F510,F600');
  const byProduct = await http(all.token, 'GET', `/marketing/visitors?exhibitionId=${ex.id}&product=f600`);
  check('The list filters by a product, case-blind', byProduct.body.total === 1);
  const sug = await http(all.token, 'GET', `/marketing/suggest/products?field=product&brandId=${nidec.id}&q=F5`);
  check('The product box remembers what was typed under the brand', Array.isArray(sug.body) && (sug.body as unknown as string[]).includes('F510'), JSON.stringify(sug.body));

  console.log('\nLead and paper');
  const lead = await http(all.token, 'POST', `/marketing/visitors/${v1.id}/lead`, {});
  check('A lead is made of a visitor', lead.status === 201, JSON.stringify(lead.body));
  const leadRow = await prisma.lead.findUnique({ where: { id: String(lead.body.id) } });
  check('Its company, contact, source and what they asked about come from the visitor', leadRow?.companyName === 'GRUNTECHNOLOGY CORPORATION' && leadRow.contactEmail === 'russelbalicas@gruntechnology.com' && leadRow.source === `Exhibition: ${TAG} Expo` && !!leadRow.description?.includes('Nidec Drives'), JSON.stringify(leadRow));
  check('Only once', (await http(all.token, 'POST', `/marketing/visitors/${v1.id}/lead`, {})).status === 409);
  const pdf = await fetch(`${BASE}/marketing/visitors/pdf?exhibitionId=${ex.id}`, { headers: { Authorization: `Bearer ${all.token}` } });
  check('The list prints', pdf.status === 200 && (pdf.headers.get('content-type') ?? '').includes('pdf'));

  console.log('\nThe spreadsheet');
  const csv = [
    'Day,Full Name,Company Name,Designation,E-mail,Contact No.,Brand,Product,Schneider Electric,Horiba,Remarks',
    `1,${TAG} Ana Reyes,Fab One,Engineer,ana@fabone.ph,0917 000 0001,"Nidec, Omega",Nidec Drives: F600; Omega Air: Dryer,,,Hot lead`,
    `1,${TAG} Ana Reyes,Fab One,Engineer,ana@fabone.ph,,,,UPS,,`,
    `Day 1,${TAG} Ben Cruz,Chip Two,,,,Pentair,pumps,,✓,`,
  ].join('\n');
  const dry = await runImport(csv, exhibitionVisitorsSpecFor(ex.id), false, async () => undefined);
  check('The dry run reads the file’s own headings, two people (the same email is one)', dry.errors === 0 && dry.created === 2, JSON.stringify(dry.rows));
  const bad = await runImport(['Name,Brands', `${TAG} X,Atlas Copco`].join('\n'), exhibitionVisitorsSpecFor(ex.id), false, async () => undefined);
  check('A brand not on the list stops the file, naming it', bad.errors === 1 && !!bad.rows[0].message?.includes('Atlas Copco'), JSON.stringify(bad.rows));
  await runImport(csv, exhibitionVisitorsSpecFor(ex.id), true, (records) => exhibitionVisitorsWrite(records as never, { id: all.user.id, name: all.user.name }, ex.id));
  const ana = await prisma.exhibitionVisitor.findFirst({ where: { exhibitionId: ex.id, email: 'ana@fabone.ph' }, include: { interests: { include: { brand: true } }, scans: true } });
  check('Imported: Ana on Day 1 with Nidec F600, Omega Dryer and Schneider UPS from its column', ana?.day === 1 && ana.interests.map((i) => `${i.brand.name}:${i.product}`).sort().join('|') === 'Nidec Drives:F600|Omega Air:Dryer|Schneider Electric:UPS', JSON.stringify(ana?.interests.map((i) => `${i.brand.name}:${i.product}`)));
  check('Her scan is marked imported, her remark kept', ana?.scans[0]?.source === 'IMPORT' && ana.notes === 'Hot lead');
  const ben = await prisma.exhibitionVisitor.findFirst({ where: { exhibitionId: ex.id, name: `${TAG} Ben Cruz` }, include: { interests: { include: { brand: true } } } });
  check('Ben: plain products go under the one brand named; a ticked brand column counts', ben?.interests.map((i) => `${i.brand.name}:${i.product ?? ''}`).sort().join('|') === 'Horiba:|Pentair:pumps', JSON.stringify(ben?.interests.map((i) => `${i.brand.name}:${i.product}`)));
  await runImport(csv, exhibitionVisitorsSpecFor(ex.id), true, (records) => exhibitionVisitorsWrite(records as never, { id: all.user.id, name: all.user.name }, ex.id));
  check('Importing the file again adds no second person', (await prisma.exhibitionVisitor.count({ where: { exhibitionId: ex.id, email: 'ana@fabone.ph' } })) === 1);

  // Into the exhibition the screen names, through the route (`?exhibitionId=`), not the latest running one.
  const other = await http(all.token, 'POST', '/marketing/exhibitions', { name: `${TAG} Older Fair`, startDate: plus(today, -40), endDate: plus(today, -38), isActive: false });
  const form = new FormData();
  form.append('file', new Blob([`Name,Position,Brands\n${TAG} Cara Lim,QA Lead,KSB`], { type: 'text/csv' }), 'day1.csv');
  const viaRoute = await fetch(`${BASE}/imports/exhibition_visitors?exhibitionId=${other.body.id}&commit=true`, { method: 'POST', headers: { Authorization: `Bearer ${all.token}` }, body: form });
  const cara = await prisma.exhibitionVisitor.findFirst({ where: { name: `${TAG} Cara Lim` } });
  check('The import goes to the exhibition the screen names', viaRoute.status === 200 && cara?.exhibitionId === other.body.id && cara.position === 'QA Lead', `${viaRoute.status} ${cara?.exhibitionId}`);

  console.log('\nPosition');
  const dash2 = await http(all.token, 'GET', `/marketing/dashboard?exhibitionId=${ex.id}`);
  const eng = dash2.body.byPosition?.find((x: { position: string }) => x.position.toUpperCase() === 'ENGINEER');
  const engList = await http(all.token, 'GET', `/marketing/visitors?exhibitionId=${ex.id}&position=engineer`);
  check('Visitors by position counts case-blind, and its bar equals its list', eng?.visitors === 1 && engList.body.total === 1, JSON.stringify({ eng, total: engList.body.total }));
  check('Visitors with no position are counted apart', typeof dash2.body.noPosition === 'number' && dash2.body.noPosition >= 1, String(dash2.body.noPosition));
  const pos = await http(all.token, 'GET', '/marketing/suggest/positions?field=position&q=qa');
  check('The position box remembers positions typed at any exhibition', (pos.body as unknown as string[]).includes('QA Lead'), JSON.stringify(pos.body));

  console.log('\nExhibitions');
  check('A text-badge exhibition must say which part is the name', (await http(all.token, 'PATCH', `/marketing/exhibitions/${other.body.id}`, { qrFormat: 'DELIMITED', qrSeparator: '|', qrFields: ['company', 'email'] })).status === 400);
  const setUp = await http(all.token, 'PATCH', `/marketing/exhibitions/${other.body.id}`, { qrFormat: 'DELIMITED', qrSeparator: '|', qrFields: ['skip', 'name', 'position'], brandIds: [omega.id, nidec.id] });
  check('Its badge format and featured brands are kept', setUp.status === 200 && setUp.body.qrFormat === 'DELIMITED' && setUp.body.qrFields.join() === 'skip,name,position' && setUp.body.brandIds.length === 2 && setUp.body.when === 'ended', JSON.stringify(setUp.body).slice(0, 300));
  const dash3 = await http(all.token, 'GET', `/marketing/dashboard?exhibitionId=${other.body.id}`);
  check('Its graph lists the featured brands, and any a visitor asked about', dash3.body.byBrand?.map((b: { brand: string }) => b.brand).sort().join() === 'KSB,Nidec Drives,Omega Air', JSON.stringify(dash3.body.byBrand));
  check('An unknown brand is refused', (await http(all.token, 'PATCH', `/marketing/exhibitions/${other.body.id}`, { brandIds: ['nope'] })).status === 400);
  check('An exhibition with visitors is not deleted', (await http(all.token, 'DELETE', `/marketing/exhibitions/${other.body.id}`)).status === 400);
  const empty = await http(all.token, 'POST', '/marketing/exhibitions', { name: `${TAG} Empty`, startDate: plus(today, 30), endDate: plus(today, 31) });
  check('An upcoming one reads as upcoming, on Day 1', empty.body.when === 'upcoming' && empty.body.today === 1);
  check('An exhibition nobody was recorded at is deleted', (await http(all.token, 'DELETE', `/marketing/exhibitions/${empty.body.id}`)).status === 200);
  check('Only Edit All deletes one', (await http(own.token, 'DELETE', `/marketing/exhibitions/${other.body.id}`)).status === 403);

  console.log('\nRemoving');
  const del = await http(boss.token, 'DELETE', `/marketing/visitors/${ownVisitor.body.id}`);
  check('A holder of Delete removes a visitor, with their brands and scans', del.status === 200 && (await prisma.exhibitionScan.count({ where: { visitorId: ownVisitor.body.id } })) === 0);
}

main()
  .catch((err) => {
    failed++;
    console.error(err);
  })
  .finally(async () => {
    await cleanup().catch((e) => console.error('cleanup:', e));
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
