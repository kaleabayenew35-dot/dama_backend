/**
 * Normalizes Ethiopian phone numbers without collapsing distinct users.
 * Supports inputs like "0909095880", "251909095880", "909095880", "+251909095880", etc.
 *
 * @param {string|number} phone
 * @returns {string}
 */
export function normalizePhone(phone) {
  if (phone === undefined || phone === null || phone === '') return '';

  const clean = String(phone).replace(/\D/g, '');
  if (!clean) return '';

  if (clean.startsWith('251')) return clean;
  if (clean.startsWith('0') && clean.length === 10) return `251${clean.slice(1)}`;
  if (clean.length === 9) return `251${clean}`;

  return clean;
}
