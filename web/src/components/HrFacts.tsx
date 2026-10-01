/**
 * What HR keeps about a person's job — team, position, employee number — shown
 * to the person on their invitation and on My Account, never edited there.
 * The employee number is the {EMP} in every quotation number they raise and
 * the position has one writer (the plantilla), so a wrong one goes to HR.
 */

export interface HrFacts {
  /** The industry team (an Industry row's name). */
  team: string | null;
  position: string | null;
  employeeNo: string | null;
}

/** One fact, labelled like the fields around it; an empty one says HR has not set it. */
export function HrFact({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="field">
      <span className="field-label-text">{label}</span>
      <div className={`hr-fact${mono && value ? ' mono' : ''}${value ? '' : ' faint'}`}>{value ?? 'Not set yet — HR adds it'}</div>
    </div>
  );
}
