import en from './en.json';

export type Vars = Record<string, string | number | null | undefined>;

/** Replace {{var}} placeholders; unknown vars render as empty strings. */
export function render(text: string, vars: Vars = {}): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
}

/** Look up a dotted key in en.json and interpolate. */
export function t(key: string, vars?: Vars): string {
  const val = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], en);
  if (typeof val !== 'string') throw new Error(`Missing i18n key: ${key}`);
  return render(val, vars);
}

export { en };
