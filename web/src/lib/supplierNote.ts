/** DOM-free, so verify-sales can import it. */

/**
 * A supplier not on file, kept on the line as "Supplier: X" in its cost note
 * — before whatever note is there, and once: typing the same name again
 * leaves the note as it is.
 */
export function withSupplierNote(note: string, name: string): string {
  const tag = `Supplier: ${name.trim()}`;
  const rest = note.trim();
  if (rest.toLowerCase().includes(tag.toLowerCase())) return note;
  return rest ? `${tag} — ${rest}` : tag;
}
