import en from '@/i18n/en.json';
import { t, type Vars } from '@/i18n';

export type TemplateKey =
  'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'T8' | 'T9' | 'T10' | 'S1' | 'S2' | 'S3';
export interface Button {
  id: string;
  title: string;
}

interface TemplateDef {
  /** Meta-approved template name — replace with the approved names once Meta accepts them. */
  metaName: string;
  language: string;
  category: 'UTILITY' | 'AUTHENTICATION';
  /** Body variable order for the Meta template ({{1}}, {{2}}, …), derived from the en.json text. */
  vars: string[];
  /** Quick-reply buttons — only ever attached for can_book guardians (PRD §7). */
  buttons?: (v: Vars) => Button[];
}

const varsOf = (key: TemplateKey) => [...(en.templates[key] as string).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);

const def = (key: TemplateKey, metaName: string, extra: Partial<TemplateDef> = {}): TemplateDef => ({
  metaName,
  language: 'en',
  category: 'UTILITY',
  vars: varsOf(key),
  ...extra,
});

export const TEMPLATES: Record<TemplateKey, TemplateDef> = {
  T0: def('T0', 'wellness_ave_otp', { category: 'AUTHENTICATION' }),
  T1: def('T1', 'wellness_ave_fu_received'),
  T2: def('T2', 'wellness_ave_eval_received'),
  T3: def('T3', 'wellness_ave_confirmed', {
    buttons: (v) => [
      { id: `VIEW:${v.appointment_id}`, title: t('buttons.view') },
      { id: `RESCHEDULE:${v.appointment_id}`, title: t('buttons.reschedule') },
    ],
  }),
  T4: def('T4', 'wellness_ave_declined'),
  T5: def('T5', 'wellness_ave_alternate', {
    buttons: (v) => [
      { id: `ACCEPT:${v.appointment_id}`, title: t('buttons.accept') },
      { id: `CHOOSE_OTHER:${v.appointment_id}`, title: t('buttons.chooseOther') },
    ],
  }),
  T6: def('T6', 'wellness_ave_reminder_24h', {
    buttons: (v) => [
      { id: `ATTEND:${v.appointment_id}`, title: t('buttons.attend') },
      { id: `RESCHEDULE:${v.appointment_id}`, title: t('buttons.reschedule') },
    ],
  }),
  T7: def('T7', 'wellness_ave_cancelled'),
  T8: def('T8', 'wellness_ave_waitlist_offer', {
    buttons: (v) => [{ id: `CLAIM:${v.offer_id}`, title: t('buttons.claim') }],
  }),
  T9: def('T9', 'wellness_ave_guardian_invite'),
  T10: def('T10', 'wellness_ave_clinic_closure'),
  S1: def('S1', 'wellness_ave_staff_new_request'),
  S2: def('S2', 'wellness_ave_staff_escalation'),
  S3: def('S3', 'wellness_ave_provider_agenda'),
};

export const renderBody = (key: TemplateKey, v: Vars) => t(`templates.${key}`, v);
export const templateParams = (key: TemplateKey, v: Vars) => TEMPLATES[key].vars.map((k) => String(v[k] ?? ''));
