import { t } from '@/i18n';
import { badRequest } from './errors';

/**
 * Normalize to E.164. Local 7-digit numbers get +1-264 (Anguilla); 10-digit NANP numbers get +1.
 * Numbers typed with + or 00 are accepted from any country (parents abroad).
 */
export function toE164(input: string, countryCode = '1', areaCode = '264'): string {
  const raw = input.trim();
  const digits = raw.replace(/\D/g, '');
  let out: string;
  if (raw.startsWith('+')) out = '+' + digits;
  else if (digits.startsWith('00')) out = '+' + digits.slice(2);
  else if (digits.length === 7) out = `+${countryCode}${areaCode}${digits}`;
  else if (digits.length === 10 && countryCode === '1') out = '+1' + digits;
  else if (digits.length === 11 && digits.startsWith('1')) out = '+' + digits;
  else throw badRequest(t('errors.invalidPhone'));
  if (!/^\+[1-9]\d{7,14}$/.test(out)) throw badRequest(t('errors.invalidPhone'));
  return out;
}
