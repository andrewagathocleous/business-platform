/** JSON text for an audit details cell. The caller binds it as text, never as HTML. */
export function auditDetailsText(details: unknown): string {
  try {
    const text = JSON.stringify(details, null, 2);
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}
