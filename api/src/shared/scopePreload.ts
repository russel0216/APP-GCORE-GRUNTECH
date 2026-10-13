/**
 * The scope of work a new costing opens on (2026-10-13, the owner's
 * SCOPE_OF_WORK_PRELOADED.xlsx: column A the phase, column B its tasks),
 * in the sheet's order. One spelling is mended ("Turn orver" → "Turn
 * over"). Each task starts at one working day, as a blank task does, so the
 * plan reads in sequence until the real durations are typed; a phase's
 * value is the schedule of values' business (the spread, or typed).
 *
 * Pure data: the lists route sends it, the sheet loads it on /new, and
 * verify-costing pins it. A change to the preload is a commit here.
 */
export type ScopeKind = 'MAIN_WORK' | 'TESTING_COMMISSIONING' | 'TURNOVER' | 'OTHER';

export interface PreloadPhase {
  name: string;
  kind: ScopeKind;
  /**
   * The cost buckets (CostCategory CODES) whose cost is this phase's value —
   * the owner's "materials cost to purchasing of materials, equipment cost
   * to purchasing of equipment" (2026-10-13). Empty: the phase spreads.
   */
  valueFrom: string[];
  tasks: { name: string; durationDays: number }[];
}

const phase = (name: string, kind: ScopeKind, tasks: string[], valueFrom: string[] = []): PreloadPhase => ({
  name,
  kind,
  valueFrom,
  tasks: tasks.map((t) => ({ name: t, durationDays: 1 })),
});

export const SCOPE_PRELOAD: readonly PreloadPhase[] = [
  // Its purchases carry the Materials and Equipment cost, priced as the sheet prices it.
  phase(
    'PLANNING & ENGINEERING',
    'MAIN_WORK',
    ['Review of costing and design', 'Kick-off meeting (Gruntech)', 'Purchase of equipment', 'Purchase of other materials'],
    ['MAT', 'EQP'],
  ),
  phase('SITE PREPARATION', 'MAIN_WORK', [
    'Kick-off meeting (Customer)',
    'Site survey',
    'Verification of all specification and location',
  ]),
  phase('DELIVERY, UNLOADING & PLACEMENT', 'MAIN_WORK', ['Equipment delivery', 'Placement']),
  phase('INSTALLATION & INTEGRATION', 'MAIN_WORK', [
    'Installation of equipment',
    'Integration of equipment',
    'All activities related to installation and integration',
  ]),
  phase('TESTING & COMMISSIONING', 'TESTING_COMMISSIONING', ['Start up and commissioning']),
  phase('HAND OVER & CLOSURE', 'TURNOVER', [
    'Training for operation and troubleshooting',
    'Turn over of all documents and as-built plan',
  ]),
];
