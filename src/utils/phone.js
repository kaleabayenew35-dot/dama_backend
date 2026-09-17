/**
 * Normalizes phone numbers to standard format (251 + last 9 digits).
 * Supports inputs like "0909095880", "251909095880", "909095880", "+251909095880", etc.
 *
 * @param {string|number} phone
 * @returns {string}
 */
export function normalizePhone(phone) {
  if (!phone) return '';
  const clean = String(phone).replace(/\D/g, '');
  if (clean.length >= 9) {
    return '251' + clean.slice(-9);
  }
  return clean;
}
