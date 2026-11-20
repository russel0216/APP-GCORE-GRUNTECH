import { checkBuilkData, importBuilkProject, lineByAmount, type BuilkCat, type BuilkOrder, type BuilkProject } from './builkImport';

/**
 * What Builk already spent on project j-2658 "SQU '26 ABOITIZ LAND_CP-51 PIPING
 * SYSTEM TAKEOVER" — the Ajoya Pampanga job (2026-11-20, the owner's call:
 * "j-2658, all its POs"). Brought into G-CORE ONCE, by the seed
 * (`BUILK_AJOYA_MARK`), onto the project built from quotation 0062602018.2.
 *
 * The 34 purchase orders of Builk's Project Cost Drilldown for j-2658, line by
 * line as Builk allocated them: Materials (Builk 101 piping and fittings, 116
 * work order) PHP 301,890.50 on 28 orders, Labor (Builk 215, Gas Ion's job
 * order) PHP 200,000.00, Indirect (Builk 504 mobilization) PHP 55,100.80 on 5
 * orders. The project's other Builk orders waited for allocation or approval,
 * or were trashed, and are left out, as Builk leaves them out. Builk's
 * headline actual reads PHP 650.00 less than its own drilldown (PO 2607-099,
 * PHP 650.00, sits in the drilldown); the drilldown is what is brought over.
 *
 * Builk's GRUNTECH_ORDER SLIP, _REIMBURSEMENT and _BUDGET REQUEST orders are
 * recorded against the GRUNTECHNOLOGY CORPORATION supplier row, what each was
 * said on its notes. Amounts are Builk's, before VAT.
 */
export const BUILK_AJOYA_MARK = 'seed.builkAjoya20261120';
export const BUILK_AJOYA_QUOTATION = '0062602018.2';

const GT = 'GRUNTECHNOLOGY CORPORATION';
const ORDER_SLIP = "Gruntech ORDER SLIP — goods from Gruntech's own stock (company stock not touched).";
const REIMB = 'Gruntech REIMBURSEMENT — expenses reimbursed in Builk.';
const BR = 'Gruntech BUDGET REQUEST — project cash in Builk.';

type Row = [name: string, qty: number, unit: string, amount: number];
const iso = (d: string) => { const [dd, mm, yyyy] = d.split('/'); return `${yyyy}-${mm}-${dd}`; };
function order(builk: string, supplier: string, date: string, createdBy: string, cat: BuilkCat, rows: Row[], notes?: string, service?: boolean): BuilkOrder {
  const lines = rows.map(([name, qty, unit, amount]) => lineByAmount(cat, name, qty, unit, amount, undefined, service));
  const total = Math.round(rows.reduce((s, r) => s + Math.round(r[3] * 100), 0)) / 100;
  return { builk, supplier, date: iso(date), delivery: iso(date), total, createdBy, notes, lines };
}

export const BUILK_AJOYA_ORDERS: BuilkOrder[] = [
  // ── Materials — Builk 101 PIPING AND FITTINGS ───────────────────────────
  order('2606-061', 'LAZARUS CORPORATION', '08/06/2026', 'Ayessa Yaya', 'MAT', [
    ['FOOT VALVE 5"', 2, 'pc', 20000],
    ['GI COUPLING 5" (THREADED) PO 2856', 2, 'pc', 1912],
    ['GI ELBOW 90 DEGREE, WELDED 4"', 4, 'pc', 2220],
    ['GI FLANGE 4"', 6, 'pc', 3096],
    ['GI FLANGE 5"', 3, 'pc', 1245],
    ['GI LONG ELBOW 5"', 2, 'pc', 1357.9],
    ['GI PIPE 125MM/5"', 2, 'pc', 19566],
    ['GI PIPE 4" SCHEDULE 40', 1, 'pc', 6931],
    ['GI TEE 4"', 1, 'pc', 1405],
    ['RUBBER BELLOW 4"', 2, 'pc', 4670],
    ['SPRING, WAFER TYPE CAST IRON', 2, 'pc', 7246.8],
  ]),
  order('2606-146', GT, '17/06/2026', 'Salvador Ugaban', 'MAT', [
    ['APRIL 22, 2026 KRISPY KREME, DALIA PASALUBONG', 1, 'lot', 529.29],
    ['APRIL 20, 2026 HANSBURY INC, MEALS WITH ABOITIZ RIEL, DAN BHADZ', 1, 'lot', 610],
    ['APRIL APMC, THREE PARKADE ACCEL TRAINING', 1, 'lot', 160],
    ['JUNE 02, 2026 CERA SUMMIT SERVICE FUEL FOR RUSSEL BYD', 1, 'lot', 500],
    ['JUNE 08, 2026 FPC HARDWARE CEMENT, REBARS', 1, 'lot', 423],
    ['JUNE 08, 2026 JOLLIBEE MEALS, JULY, SHAQ, POGAY, BHADZ', 1, 'lot', 746.57],
    ['JUNE 08, 2026 KFC, GASIONG OFFICE, JULY, MARK, SHAQ, POGAY, RUSSEL, BHADZ, BOSS', 1, 'lot', 1335],
    ['JUNE 08, 2026 RMV HARDWARE CONSTRUCTION GRAVEL', 1, 'lot', 240],
    ['JUNE 08, 2026 SAND, ELECTRICAL TAPE', 1, 'lot', 140],
    ['JUNE 08, 2026 LAMUAN GAS STATION FUEL COLORADO BHADZ OUT OF TOWN', 1, 'lot', 3000],
    ['JUNE 11, 2026 NLEX TPLEX SAN MIGUEL EXIT', 1, 'lot', 553],
  ], REIMB),
  order('2607-016', 'JIVAN TRADING', '02/07/2026', 'Ayessa Yaya', 'MAT', [
    ['GI HEXBOLT WITH NUT & WASHER FOR 3/4 X 3" PO 2897', 20, 'pcs', 786],
    ['GI HEXBOLT WITH NUT & WASHER FOR 5/8 X 3" PO 2897', 50, 'pcs', 1320],
    ['GI HEXBOLT WITH NUT & WASHER FOR 5/8 X 6" PO 2897', 10, 'pcs', 406.5],
  ]),
  order('2607-099', GT, '10/07/2026', 'Daniel Cabacungan', 'MAT', [
    ['JULY 9, 2026 - GI SOF 5" ANSI - JANSY COMMERCIAL', 1, 'lot', 650],
  ], REIMB),
  order('2607-119', 'MLC HARDWARE & GENERAL CONSTRUCTION SUPPLY', '13/07/2026', 'Salvador Ugaban', 'MAT', [
    ['C-CHANNEL', 2, 'pc', 6400],
  ]),
  order('2607-120', 'ELECTRICAL & EQUIPMENT SALES CO', '13/07/2026', 'Salvador Ugaban', 'MAT', [
    ['UNISTRUT CHANNEL 1-5/8"', 1, 'pc', 724],
    ['UNISTRUT CLAMP 3"', 8, 'pc', 792],
  ]),
  order('2607-121', 'GLOBAL STANDARD ELECTRICAL DEPOT', '13/07/2026', 'Salvador Ugaban', 'MAT', [
    ['THHN WIRE 14MM2', 24, 'm', 4490.4],
    ['THHN WIRE 60MM2 BLUE', 24, 'm', 17625.6],
    ['THHN WIRE 60MM2 RED', 24, 'm', 17625.6],
    ['THHN WIRE 60MM2 YELLOW', 24, 'm', 17625.6],
  ]),
  order('2607-139', '3M INDUSTRIAL SUPPLY', '15/07/2026', 'Ayessa Yaya', 'MAT', [
    ['GATE VALVE 1 1/2" THREADED PO 2896', 1, 'pc', 1870],
    ['NIPPLE 1 1/2" 6 INCHES PO 2896', 3, 'pc', 441],
    ['UNION PATENTE 1 1/2" PO 2896', 1, 'pc', 370],
  ]),
  order('2607-219', 'KCMT', '27/07/2026', 'Salvador Ugaban', 'MAT', [
    ['BI ANGLE BAR 2 X 2 X 1/4 (6MM)', 1, 'pc', 1610],
    ['MASONRY DRILL BIT W/ LAGSCREW (1/2)', 1, 'pc', 120],
    ['EPOXY PRIMER GUILDER GRAY LITER', 1, 'pc', 390],
    ['EXPANSION SHIELD W/ LAGSCREW 1/2', 12, 'pc', 864],
    ['EPOXY REDUCER', 2, 'pc', 520],
  ]),
  order('2607-220', 'ELECTRICAL & EQUIPMENT SALES CO', '27/07/2026', 'Salvador Ugaban', 'MAT', [
    ['CONDUIT LR 2"', 2, 'pcs', 2882],
    ['UNISTRUT CLAMP 2"', 8, 'pcs', 504],
    ['UNISTRUT CHANNEL 1-5/8"', 1, 'pc', 724],
  ]),
  order('2607-222', 'K.CMT II MATERIAL SUPPLY INC.', '27/07/2026', 'Ayessa Yaya', 'MAT', [
    ['RSC BUSHING AND LOCKNUT 2" PO 2913', 4, 'pcs', 180],
    ['RSC COUPLING 2" PO 2913', 15, 'pcs', 1508.55],
    ['RSC LONG ELBOW 2" PO 2913', 5, 'pcs', 1450],
    ['RSC PIPE 2" PO 2913', 8, 'pcs', 9680],
  ]),
  order('2609-065', GT, '04/09/2026', 'Salvador Ugaban', 'MAT', [
    ['AUGUST 19, 2026 FUEL COLORADO NEL5004', 1, 'lot', 3000],
    ['SEPTEMBER 03, 2026 WVMAG CONSTRUCTION MASONRY DRILL', 1, 'pc', 380],
  ], REIMB),
  order('2609-128', GT, '11/09/2026', 'Salvador Ugaban', 'MAT', [
    ['WSS - PDV-A750MA', 1, 'unit', 15120],
  ], ORDER_SLIP),
  order('2609-149', GT, '14/09/2026', 'Salvador Ugaban', 'MAT', [
    ['OOP - DCB581528 INGCO, DIAMOND CORE BIT', 1, 'pc', 7209],
  ], ORDER_SLIP),
  order('2609-150', GT, '14/09/2026', 'Salvador Ugaban', 'MAT', [
    ['AUG 15, 2026 MEALS TRAINING BASIC PRINCIPLE 18 PARTICIPANTS', 1, 'lot', 1619],
    ['SEP 07, 2026 MEALS OFFICE OVERTIME CARTER, NOEL, RODRIGO, BHADZ, RUSSEL', 1, 'lot', 910],
  ], REIMB),

  // ── Materials — Builk 116 WORK ORDER ─────────────────────────────────────
  order('2607-042', GT, '07/07/2026', 'Salvador Ugaban', 'MAT', [
    ['JUNE 24, 2026 ABACUS BOOK AND CARD CORP (PAPER WORKS / BINDING MATERIALS)', 1, 'lot', 1139],
    ['JUNE 24, 2026 PANDAYAN BOOKSHOP (BINDING MATERIALS)', 1, 'lot', 95],
  ], REIMB),
  order('2607-145', 'LACSON AND LACSON INSURANCE BROKERS', '15/07/2026', 'Ayessa Yaya', 'MAT', [
    ['PERFORMANCE BOND', 1, 'lot', 3555.04],
    ['SURETY BOND', 1, 'lot', 6920.23],
  ]),
  order('2607-185', GT, '21/07/2026', 'Joy Kenneth Robinos', 'MAT', [
    ['DIAMOND DISC', 1, 'pc', 280],
    ['GITI MEALS 7.14.26 (MANG INASAL)', 1, 'lot', 820],
    ['GITI MEALS 7.13.26 (JOLLIBEE)', 1, 'lot', 808],
    ['GITI MEALS 7.13.26 (MCDONALDS)', 1, 'lot', 907],
    ['GITI MEALS 7.14.26 (JOLLIBEE)', 1, 'lot', 787],
    ['GITI MEALS 7.15.26 (KARINDERIA)', 1, 'lot', 209],
    ['GITI MEALS 7.16.26 (KARINDERIA)', 1, 'lot', 250],
    ['MACHINE SHOP FEE (THREAD ON 5" PIPE)', 4, 'lot', 2000],
    ['MATERIALS (TEFLON, NELTEX, FLAME GUN, ELBOW, MALE ADAPTOR, REDUCER, COUPLING, PVC)', 1, 'lot', 1045],
  ], REIMB),
  order('2608-013', GT, '03/08/2026', 'Joy Kenneth Robinos', 'MAT', [
    ['DIESEL', 1, 'lot', 675],
    ['LALAMOVE FEE - JIVAN BOLTS AND NUTS (STA. CRUZ TO PAMPANGA)', 1, 'lot', 400],
    ['WATER PUMP RENTAL', 1, 'lot', 2500],
    ['WIRE AND ACCESSORIES', 1, 'lot', 500],
  ], REIMB),
  order('2608-027', 'MELCH CASTLE', '04/08/2026', 'Salvador Ugaban', 'MAT', [
    ['AJOYA PAMPANGA FCD ELECTRICAL/PLUMBING PLAN SIGNED AND SEALED', 1, 'lot', 10000],
    ['AJOYA TARLAC FCD ELECTRICAL PLAN SIGNED AND SEALED', 1, 'lot', 3500],
    ['AJOYA TARLAC FCD PLUMBING PLAN SIGNED AND SEALED', 1, 'lot', 3600],
    ['PERMIT IN-CHARGE ELECTRICAL AJCAPAS SIGNED AND SEALED', 1, 'lot', 2000],
    ['PERMIT IN-CHARGE AJPAM SIGNED AND SEALED', 1, 'lot', 10000],
    ['PERMIT IN-CHARGE PLUMBING AJCAPAS SIGNED AND SEALED', 1, 'lot', 2000],
  ]),
  order('2608-146', GT, '19/08/2026', 'Joy Kenneth Robinos', 'MAT', [
    ['ACCOMMODATION AUGUST 20 - 22, 2026 (SUNDAY BELAJANDRO HOTEL VIA BOOKING.COM)', 1, 'lot', 4349.9],
    ['ACCOMMODATION JULY 13 - 16, 2026 (LANTERN VILLA VIA BOOKING.COM)', 1, 'lot', 8231.71],
    ['ACCOMMODATION JULY 16 - 17, 2026 EXTENSION (SUNDAY BELAJANDRO HOTEL VIA BOOKING.COM)', 1, 'lot', 1743.4],
  ], REIMB),
  order('2608-184', GT, '25/08/2026', 'Joy Kenneth Robinos', 'MAT', [
    ['ELBOW #3', 1, 'lot', 730],
    ['ELBOW, THHN WIRE, COUPLING', 1, 'lot', 1398],
    ['FOOD (JOLLIBEE)', 1, 'lot', 756],
    ['FOOD FOR 4 PERSONS', 1, 'lot', 516],
    ['GROCERY (DALI)', 1, 'lot', 839.75],
    ['SOLVENT', 1, 'lot', 80],
    ['STEEL BRUSH, COUPLING', 1, 'lot', 910],
    ['THHN WIRE #10, ELECTRICAL TAPE', 1, 'lot', 416],
  ], REIMB),
  order('2609-013', GT, '01/09/2026', 'Joy Kenneth Robinos', 'MAT', [
    ['MEAL (08.20.26) FOR JULY, FREDDIE, STANLEE, REJOHN', 1, 'lot', 596],
    ['MEAL (08.20.26) FOR JULY, FREDDIE, STANLEE, REJOHN', 1, 'lot', 780],
    ['MEAL (08.21.26) FOR JULY, FREDDIE, STANLEE, REJOHN', 1, 'lot', 540],
    ['MEAL (08.21.26) FOR JULY, FREDDIE, STANLEE, REJOHN', 1, 'lot', 616],
    ['MEAL (08.21.26) FOR JULY, FREDDIE, STANLEE, REJOHN', 1, 'lot', 340],
    ['MEAL (08.22.26) FOR JULY, FREDDIE, STANLEE, REJOHN', 1, 'lot', 340],
    ['MEAL (08.22.26) FOR JULY, FREDDIE, STANLEE, REJOHN', 1, 'lot', 520],
    ['MEAL (08.22.26) FOR JULY, FREDDIE, STANLEE, REJOHN', 1, 'lot', 276],
    ['TOLL FEE (08.22.26)', 1, 'lot', 353],
    ['TOX SCREW (08.21.26)', 1, 'lot', 353.75],
    ['WATER (08.22.26) FOR JULY, FREDDIE, STANLEE, REJOHN', 1, 'lot', 25],
  ], REIMB),
  order('2609-055', 'K.CMT II MATERIAL SUPPLY INC.', '03/09/2026', 'Ayessa Yaya', 'MAT', [
    ['CUTTING DISC 4" SUNRISE PO 2990', 25, 'pcs', 500],
    ['DRILL BIT 1/2" PO 2990', 1, 'pcs', 120],
    ['FLAP DISC #120 PO 2990', 2, 'pcs', 58],
    ['PAINT BRUSH 2" PO 2990', 2, 'pcs', 100],
    ['PAINT ROLLER 4" PO 2990', 2, 'pcs', 40],
    ['PAINT THINNER PO 2990', 1, 'pcs', 670],
    ['TYROLIT GRINDING DISC 4" PO 2990', 5, 'pcs', 140],
  ]),
  order('2609-079', GT, '07/09/2026', 'Joy Kenneth Robinos', 'MAT', [
    ['LALAMOVE FEE (PO 2896 - 3MG, ABOITIZ - AJOYA)', 1, 'lot', 123],
    ['LBC DOCS (ABOITIZ LAND)', 1, 'lot', 180],
    ['MEAL (09.03.26)', 1, 'lot', 195],
    ['MEAL (09.04.26)', 1, 'lot', 175],
    ['TRANSPO (09.03.26)', 1, 'lot', 73],
    ['TRANSPO (09.04.26)', 1, 'lot', 198],
    ['WITHDRAWAL FEE (BR FOR ANNIV 26K)', 3, 'lot', 48],
  ], REIMB),
  order('2609-082', GT, '07/09/2026', 'Joy Kenneth Robinos', 'MAT', [
    ['GLOBAL (ADDITIONAL PAYMENT DUE TO PRICE INCREASE)', 1, 'lot', 2185.91],
    ['LALAMOVE FEE (GLOBAL TO 3MG TO MINTEX)', 1, 'lot', 800],
  ], REIMB),
  order('2609-151', GT, '14/09/2026', 'Salvador Ugaban', 'MAT', [
    ['CONTINGENCY', 1, 'lot', 3000],
    ['FUEL COLORADO FULL TANK', 1, 'lot', 6000],
    ['MEALS 150 PER MEAL SEPT 14-18 (TOTAL OF 11 MEALS)', 1, 'lot', 4950],
    ['PIPE THREADING', 1, 'lot', 2500],
    ['TOLL FEE TWO WAY', 1, 'lot', 1200],
  ], BR),
  order('2610-146', GT, '23/10/2026', 'Ayessa Yaya', 'MAT', [
    ['NJA FABRICATION AND MACHINE SHOP - THREADING OF GI PIPE, RECEIPT 000233 SEPT 24, 2026', 1, 'lot', 2250],
  ], REIMB),

  // ── Labor — Builk 215 PROJECT MANAGEMENT ─────────────────────────────────
  order('2606-055', 'GAS ION TECHNOLOGY', '08/06/2026', 'Ayessa Yaya', 'LAB', [
    ['GAS ION, JOB ORDER - SERVICE (ELECTRICAL FIELD WIRING)', 1, 'lot', 80000],
    ['GAS ION, JOB ORDER - SERVICE (PUMP SKID ASSEMBLY) PO 2859', 1, 'lot', 120000],
  ], undefined, true),

  // ── Indirect — Builk 504 MOBILIZATION ────────────────────────────────────
  order('2608-028', GT, '04/08/2026', 'Salvador Ugaban', 'IND', [
    ['BACOLOD TO CEBU TICKET SEA FARE (NOLI, JESSY, RODRIGO, ARTHUR)', 4, 'lot', 1600],
    ['CAR RENTAL FOR 2 DAYS', 1, 'lot', 6000],
    ['HOTEL ACCOMMODATION 1 DAY (NOLI, JESSY, RODRIGO, ARTHUR)', 1, 'lot', 5000],
    ['MEALS', 1, 'lot', 1600],
  ], BR),
  order('2608-066', GT, '07/08/2026', 'Salvador Ugaban', 'IND', [
    ['JULY 17, 2026 FUEL FOR BYD', 1, 'lot', 1500],
    ['JULY 20, 2026 FUEL FOR CHEVROLET COLORADO AJOYA PAMPANGA MOBILIZATION', 1, 'lot', 3000],
    ['JUNE 26, 2026 NOTARY FEE FOR ABOITIZ CONTRACT', 1, 'lot', 500],
    ['JUNE 29, 2026 CTC FOR BONDS REQUIREMENT', 1, 'lot', 16.8],
  ], REIMB),
  order('2608-132', GT, '18/08/2026', 'Rodrigo Catuday', 'IND', [
    ['FARE - GRAB, INSULAR SQUARE MANDAUE CEBU - MACTAN AIRPORT, 8.16.26', 1, 'lot', 209],
    ['MATERIALS - INGCOPH STORES INC., CLAMP METER, 8.14.26', 1, 'pc', 2425],
  ], REIMB),
  order('2609-059', GT, '03/09/2026', 'Salvador Ugaban', 'IND', [
    ['CONTINGENCY', 1, 'lot', 3000],
    ['GASOLINE FULL TANK COLORADO', 1, 'lot', 6000],
    ['HOTEL ACCOMMODATION', 1, 'lot', 3300],
    ['MEALS 4 PAX AT 150 PER MEAL (8 MEALS TOTAL)', 1, 'lot', 4800],
    ['TOLL FEE TWO WAY NLEX', 1, 'lot', 1200],
  ], BR),
  order('2609-134', GT, '12/09/2026', 'Salvador Ugaban', 'IND', [
    ['OOP - DDM28001 INGCO, DIAMOND DRILLING', 1, 'unit', 14950],
  ], ORDER_SLIP),
];

/** Builk's drilldown totals per budget line — what the import must come to. */
export const BUILK_AJOYA_ACTUAL = { MAT: 301890.5, LAB: 200000, IND: 55100.8 } as const;

/** Each order's total as Builk's drilldown gives it — checked against its lines. */
export const BUILK_AJOYA_TOTALS: Record<string, number> = {
  '2606-061': 69649.7, '2606-146': 8236.86, '2607-016': 2512.5, '2607-099': 650, '2607-119': 6400, '2607-120': 1516,
  '2607-121': 57367.2, '2607-139': 2681, '2607-219': 3504, '2607-220': 4110, '2607-222': 12818.55, '2609-065': 3380,
  '2609-128': 15120, '2609-149': 7209, '2609-150': 2529, '2607-042': 1234, '2607-145': 10475.27, '2607-185': 7106,
  '2608-013': 4075, '2608-027': 31100, '2608-146': 14325.01, '2608-184': 5645.75, '2609-013': 4739.75, '2609-055': 1628,
  '2609-079': 992, '2609-082': 2985.91, '2609-151': 17650, '2610-146': 2250,
  '2606-055': 200000,
  '2608-028': 14200, '2608-066': 5016.8, '2608-132': 2634, '2609-059': 18300, '2609-134': 14950,
};

export const BUILK_AJOYA: BuilkProject = {
  mark: BUILK_AJOYA_MARK,
  markDescription: "seed: Builk's purchases for SQU '26 ABOITIZ LAND_CP-51 PIPING SYSTEM TAKEOVER (Ajoya Pampanga) were brought over once (2026-11-20)",
  builkName: "j-2658 SQU '26 ABOITIZ LAND_CP-51 PIPING SYSTEM TAKEOVER",
  quotation: BUILK_AJOYA_QUOTATION,
  deliverTo: 'AJOYA PAMPANGA (Aboitiz Land CP-51), Pampanga — person in charge Salvador Ugaban',
  actual: BUILK_AJOYA_ACTUAL,
  orders: BUILK_AJOYA_ORDERS,
};

/** The data against Builk's totals: each order against the drilldown's own figure, then the budget lines. */
export function checkBuilkAjoyaData(): string[] {
  const problems = checkBuilkData(BUILK_AJOYA);
  const listed = new Set(BUILK_AJOYA_ORDERS.map((o) => o.builk));
  for (const [builk, total] of Object.entries(BUILK_AJOYA_TOTALS)) {
    const o = BUILK_AJOYA_ORDERS.find((x) => x.builk === builk);
    if (!o) problems.push(`${builk} is missing`);
    else if (Math.round(o.total * 100) !== Math.round(total * 100)) problems.push(`${builk} comes to ${o.total.toFixed(2)}, Builk's drilldown says ${total.toFixed(2)}`);
  }
  for (const b of listed) if (!(b in BUILK_AJOYA_TOTALS)) problems.push(`${b} is not in Builk's drilldown`);
  return problems;
}

export async function importBuilkAjoya(opts: { dryRun?: boolean; force?: boolean; jobId?: string } = {}) {
  const problems = checkBuilkAjoyaData();
  if (problems.length) return { done: false as const, reason: `the Builk data does not add up: ${problems.join('; ')}` };
  return importBuilkProject(BUILK_AJOYA, opts);
}
