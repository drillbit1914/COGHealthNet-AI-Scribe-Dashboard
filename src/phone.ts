import { badRequest } from './errors.js';

/**
 * Normalize to E.164. Local 7-digit Anguilla numbers get +1-264; 10-digit NANP numbers get +1.
 * Numbers typed with + or 00 are accepted from any country (parents abroad).
 */
export function toE164(input: string, countryCode = '1', areaCode = '264'): string {
  const raw = input.trim();
  let digits = raw.replace(/[^\d]/g, '');
  if (raw.startsWith('+')) return check('+' + digits);
  if (digits.startsWith('00')) return check('+' + digits.slice(2));
  if (digits.length === 7) return check(`+${countryCode}${areaCode}${digits}`);
  if (digits.length === 10 && countryCode === '1') return check('+1' + digits);
  if (digits.length === 11 && digits.startsWith('1')) return check('+' + digits);
  throw badRequest('Please enter a valid mobile number');
}

function check(e164: string) {
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) throw badRequest('Please enter a valid mobile number');
  return e164;
}
