import { checkBuilkData, importBuilkProject, lineByAmount, type BuilkCat, type BuilkOrder, type BuilkProject } from './builkImport';

/**
 * What Builk already bought for project j-26103 "CMG '26 AMHERST LAB, 45KW VFD
 * W/ CONTROL PANEL,PO753009233" (2026-11-24, the owner's call: "input this
 * project and costing, it has all been approved in Builk"). Brought into
 * G-CORE ONCE, by the seed (`BUILK_AMHERST_MARK`), onto the project built
 * from quotation 0832610006.
 *
 * Five of Builk's purchase orders — 2609-211, 2610-044, -045, -054, -135 —
 * whose sum is Builk's actual cost, PHP 278,766.36. Builk's 2611-018 (an
 * order slip of 2026-11-10) re-lists the lines of 2610-135 and the wires of
 * 2610-054 and Builk leaves it out of the actual; so does this. 2609-211 and
 * 2610-044 are Gruntech's own ORDER SLIPs: goods taken from the warehouse
 * before the Odoo stock count of 2026-10-25, so today's stock is not touched —
 * recorded against the GRUNTECHNOLOGY CORPORATION supplier row at Builk's
 * prices.
 *
 * Budget lines as Builk allocated them — Equipment (Builk 307 Control
 * Technique) PHP 132,880.00, Materials (Builk 104, 106, 108, 109, 110, 118)
 * PHP 97,286.36 — except Gas Ion's labor (2610-045, PHP 48,600.00), which
 * Builk filed under 104 Controller Assembly and the owner put under
 * Subcontract, received as a service.
 */
export const BUILK_AMHERST_MARK = 'seed.builkAmherst20261124';
export const BUILK_AMHERST_QUOTATION = '0832610006';

const GT = 'GRUNTECHNOLOGY CORPORATION';
const ORDER_SLIP = "Gruntech ORDER SLIP — goods from Gruntech's own warehouse stock, taken off the shelf before the Odoo stock count of 2026-10-25 (company stock not touched).";

type Row = [cat: BuilkCat, name: string, qty: number, unit: string, amount: number, description?: string];
function order(builk: string, supplier: string, date: string, createdBy: string, rows: Row[], notes?: string, service?: boolean): BuilkOrder {
  const lines = rows.map(([cat, name, qty, unit, amount, description]) => lineByAmount(cat, name, qty, unit, amount, description, service));
  const total = rows.reduce((s, r) => s + Math.round(r[4] * 100), 0) / 100;
  return { builk, supplier, date, delivery: date, total, createdBy, notes, lines };
}

export const BUILK_AMHERST_ORDERS: BuilkOrder[] = [
  order('2609-211', GT, '2026-09-21', 'Camille Guiling', [
    ['EQP', 'NIDEC DRIVES VFD C200-07400770A10100AB100', 1, 'unit', 132880, 'For PO 7530009233'],
    ['MAT', 'SCHNEIDER ELECTRIC HMI SHM - HMIET6500', 1, 'unit', 23917.06],
    ['MAT', 'SENSOR S694 3557', 1, 'unit', 7308],
    ['MAT', 'RELAY RXM4LB2P7', 3, 'pcs', 551.82],
    ['MAT', 'RELAY RXZE1M4C', 3, 'pcs', 356.55],
    ['MAT', 'CIRCUIT BREAKER EZC250H3125', 1, 'pc', 7447.87],
    ['MAT', 'CIRCUIT BREAKER A9F74204', 2, 'pc', 1280.8],
    ['MAT', 'PROGRAMMABLE LOGIC CONTROLLER TM200CE24R', 1, 'pc', 9319.62],
  ], `${ORDER_SLIP} For PO 7530009233.`),
  order('2610-044', GT, '2026-10-07', 'Camille Guiling', [
    ['MAT', 'SEP - A9F74206 - SCHNEIDER ELECTRIC, ACTI9 IC60N 2P C 6A MCB', 1, 'unit', 636.68],
    ['MAT', 'SPP - ABLS1A24031 - SCHNEIDER ELECTRIC, POWER SUPPLY 24V 3.1A 1PH OPTIMIZED', 1, 'unit', 3105.7],
    ['MAT', 'SEP - XA2ED33 - SCHNEIDER ELECTRIC, SELECTOR SWITCH', 1, 'unit', 134.4],
    ['MAT', 'OOP - THHN 30MM2 (B) - PHELPS DODGE, THHN WIRE', 6, 'm', 1530.9],
    ['MAT', 'OOP - THHN 30MM2 (R) - PHELPS DODGE, THHN WIRE', 6, 'm', 1530.9],
    ['MAT', 'OOP - THHN 30MM2 (Y) - PHELPS DODGE, THHN WIRE', 6, 'm', 1530.9],
  ], ORDER_SLIP),
  order('2610-045', 'GAS ION TECHNOLOGY', '2026-10-07', 'Ayessa Yaya', [
    ['SUB', 'GAS ION, LABOR — CONTROLLER ASSEMBLY AND PROGRAMMING', 1, 'lot', 33600, 'PO 3052'],
    ['SUB', 'GAS ION, FIELD DEPLOYMENT — MOBILIZATION AND ACCOMMODATION', 1, 'lot', 15000, 'PO 3052'],
  ], 'Builk filed this under 104 Controller Assembly; charged to Subcontract in G-CORE (the owner\'s call).', true),
  order('2610-054', 'GLOBAL STANDARD ELECTRICAL DEPOT', '2026-10-08', 'Ayessa Yaya', [
    ['MAT', 'PHELPS DODGE, THHN WIRE 14MM2, RED', 11, 'm', 2200, 'PO 3055'],
    ['MAT', 'PHELPS DODGE, THHN WIRE 14MM2, YELLOW', 11, 'm', 2200],
    ['MAT', 'PHELPS DODGE, THHN WIRE 14MM2, BLUE', 11, 'm', 2200],
    ['MAT', 'PHELPS DODGE, THHN WIRE 14MM2, GREEN', 3, 'm', 600.06],
    ['MAT', 'PHELPS DODGE, TF WIRE 0.75MM2', 1, 'roll', 2085],
  ]),
  order('2610-135', 'ELECTRICAL & EQUIPMENT SALES CO', '2026-10-21', 'Ayessa Yaya', [
    ['MAT', 'TIBOX, ENCLOSURE 800MM(W) X 1000MM(H) X 400MM(D)', 1, 'pc', 14600, 'PO 3079'],
    ['MAT', 'POWER TERMINAL BLOCK 125A (35MM2)', 3, 'pcs', 517.65],
    ['MAT', 'POWER TERMINAL BLOCK 75AMP (FJ411S)', 12, 'pcs', 693.6],
    ['MAT', 'CONTROL TERMINAL BLOCK JUT1 2.5', 1, 'pc', 27.2],
    ['MAT', 'CABLE TRAY 50X50', 3, 'length', 2811],
    ['MAT', 'TERMINAL LUGS 30MM2', 20, 'pcs', 1335],
    ['MAT', 'TERMINAL LUGS 14MM2', 40, 'pcs', 1194],
    ['MAT', 'VINYL END CAP 30MM2 (RED)', 7, 'pcs', 61.95],
    ['MAT', 'VINYL END CAP 30MM2 (YELLOW)', 7, 'pcs', 61.95],
    ['MAT', 'VINYL END CAP 30MM2 (BLUE)', 7, 'pcs', 61.95],
    ['MAT', 'VINYL END CAP 14MM2 (RED)', 10, 'pcs', 39],
    ['MAT', 'VINYL END CAP 14MM2 (YELLOW)', 10, 'pcs', 39],
    ['MAT', 'VINYL END CAP 14MM2 (BLUE)', 10, 'pcs', 39],
    ['MAT', 'VINYL END CAP 14MM2 (GREEN)', 10, 'pcs', 39],
    ['MAT', 'EMERGENCY STOP PUSH BUTTON', 1, 'pc', 592.9],
    ['MAT', 'FLEXIBLE LQT CONDUIT, HARD TYPE, 2"', 2, 'pcs', 953.7],
    ['MAT', 'CONTROL TRANSFORMER 300VA 460/220V', 1, 'pc', 6283.2],
  ]),
];

/** Builk's actual cost of the project, by budget line — what the import must come to. */
export const BUILK_AMHERST_ACTUAL = { MAT: 97286.36, EQP: 132880, SUB: 48600 } as const;

export const BUILK_AMHERST: BuilkProject = {
  mark: BUILK_AMHERST_MARK,
  markDescription: "seed: Builk's purchases for CMG '26 AMHERST LAB were brought over once (2026-11-24)",
  builkName: "j-26103 CMG '26 AMHERST LAB, 45KW VFD W/ CONTROL PANEL,PO753009233",
  quotation: BUILK_AMHERST_QUOTATION,
  deliverTo: 'Unilab Pharma Campus, Brgy. Mamplasan 4024, Biñan, Laguna — person in charge Camille Guiling',
  actual: BUILK_AMHERST_ACTUAL,
  orders: BUILK_AMHERST_ORDERS,
};

export const checkBuilkAmherstData = () => checkBuilkData(BUILK_AMHERST);
export const importBuilkAmherst = (opts: { dryRun?: boolean; force?: boolean; jobId?: string } = {}) => importBuilkProject(BUILK_AMHERST, opts);
