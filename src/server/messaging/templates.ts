/**
 * Template registry (PRD §7): template_key → Meta template name, language, category and the fixed
 * body-variable order ({{1}}, {{2}}, … in the Meta-approved template). Bodies live in src/i18n/en.json.
 *
 * Once Meta approves the templates, drop the approved names in via WA_TEMPLATE_NAMES
 * (JSON, e.g. {"T1":"wellness_ave_fu_received_v2"}) or edit `metaName` below. Variable order must
 * match the approved template exactly — a unit test checks it against en.json.
 */
import { t, type Vars } from '@/i18n';

export type TemplateKey =
  'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'T8' | 'T9' | 'T10' | 'S1' | 'S2' | 'S3';
/** Free-form session reply (inside WhatsApp's 24-hour customer-service window), never a template. */
export const REPLY = 'REPLY';

export interface Button {
  id: string;
  title: string;
}

export interface TemplateDef {
  metaName: string;
  language: string;
  category: 'UTILITY' | 'AUTHENTICATION';
  vars: readonly string[];
  /** Quick-reply buttons — only ever attached for can_book guardians (PRD §7). */
  buttons?: (v: Vars) => Button[];
}

const U = 'UTILITY' as const;

export const TEMPLATES: Record<TemplateKey, TemplateDef> = {
  T0: { metaName: 'wellness_ave_otp', language: 'en', category: 'AUTHENTICATION', vars: ['code'] },
  T1: {
    metaName: 'wellness_ave_fu_received',
    language: 'en',
    category: U,
    vars: ['guardian', 'child', 'day', 'date', 'time', 'ref', 'ACCOUNT_NAME', 'NCBA_ACCOUNT_NO', 'ref'],
  },
  T2: {
    metaName: 'wellness_ave_eval_received',
    language: 'en',
    category: U,
    vars: ['guardian', 'child', 'day', 'date', 'time', 'ref'],
  },
  T3: {
    metaName: 'wellness_ave_confirmed',
    language: 'en',
    category: U,
    vars: ['child', 'visit_type', 'day', 'date', 'time', 'provider', 'ref'],
    buttons: (v) => [
      { id: `VIEW:${v.appointment_id}`, title: t('buttons.view') },
      { id: `RESCHEDULE:${v.appointment_id}`, title: t('buttons.reschedule') },
    ],
  },
  T4: {
    metaName: 'wellness_ave_declined',
    language: 'en',
    category: U,
    vars: ['child', 'date', 'time', 'reason', 'link'],
  },
  T5: {
    metaName: 'wellness_ave_alternate',
    language: 'en',
    category: U,
    vars: ['new_day', 'new_date', 'new_time', 'child'],
    buttons: (v) => [
      { id: `ACCEPT:${v.appointment_id}`, title: t('buttons.accept') },
      { id: `CHOOSE_OTHER:${v.appointment_id}`, title: t('buttons.chooseOther') },
    ],
  },
  T6: {
    metaName: 'wellness_ave_reminder_24h',
    language: 'en',
    category: U,
    vars: ['child', 'visit_type', 'time', 'provider'],
    buttons: (v) => [
      { id: `ATTEND:${v.appointment_id}`, title: t('buttons.attend') },
      { id: `RESCHEDULE:${v.appointment_id}`, title: t('buttons.reschedule') },
    ],
  },
  T7: {
    metaName: 'wellness_ave_cancelled',
    language: 'en',
    category: U,
    vars: ['child', 'date', 'time', 'reason', 'link'],
  },
  T8: {
    metaName: 'wellness_ave_waitlist_offer',
    language: 'en',
    category: U,
    vars: ['visit_type', 'day', 'date', 'time'],
    buttons: (v) => [{ id: `CLAIM:${v.offer_id}`, title: t('buttons.claim') }],
  },
  T9: { metaName: 'wellness_ave_guardian_invite', language: 'en', category: U, vars: ['inviter', 'child'] },
  T10: {
    metaName: 'wellness_ave_clinic_closure',
    language: 'en',
    category: U,
    vars: ['date', 'reason', 'child', 'time', 'link'],
  },
  S1: {
    metaName: 'wellness_ave_staff_new_request',
    language: 'en',
    category: U,
    vars: ['visit_type', 'child', 'date', 'time', 'provider', 'admin_link'],
  },
  S2: { metaName: 'wellness_ave_staff_escalation', language: 'en', category: U, vars: ['ref', 'expires_at'] },
  S3: { metaName: 'wellness_ave_provider_agenda', language: 'en', category: U, vars: ['n', 'time', 'link'] },
};

/** Approved Meta names/language, with env overrides (WA_TEMPLATE_NAMES, WA_TEMPLATE_LANGUAGE). */
export function metaTemplate(key: TemplateKey) {
  let names: Record<string, string> = {};
  try {
    names = JSON.parse(process.env.WA_TEMPLATE_NAMES ?? '{}');
  } catch {}
  const def = TEMPLATES[key];
  return {
    name: names[key] ?? def.metaName,
    language: process.env.WA_TEMPLATE_LANGUAGE ?? def.language,
    category: def.category,
  };
}

export const isTemplateKey = (k: string | null | undefined): k is TemplateKey => !!k && k in TEMPLATES;
export const renderBody = (key: TemplateKey, v: Vars) => t(`templates.${key}`, v);
export const templateParams = (key: TemplateKey, v: Vars) => TEMPLATES[key].vars.map((k) => String(v[k] ?? ''));
