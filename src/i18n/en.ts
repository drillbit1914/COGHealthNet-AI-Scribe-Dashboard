/** All user-facing strings (PRD §2: English, i18n file). Message templates follow PRD §7 verbatim. */
export type Vars = Record<string, string | number>;
export interface Button { id: string; title: string }
export type TemplateKey =
  | 'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'T8' | 'T9' | 'T10' | 'S1' | 'S2' | 'S3';

/** Meta template names (UTILITY; T0 is AUTHENTICATION). Params are sent in {{var}} order of the text. */
export const META_TEMPLATE_NAME: Record<TemplateKey, string> = {
  T0: 'otp', T1: 'fu_received', T2: 'eval_received', T3: 'confirmed', T4: 'declined', T5: 'alternate',
  T6: 'reminder_24h', T7: 'cancelled', T8: 'waitlist_offer', T9: 'guardian_invite', T10: 'clinic_closure',
  S1: 'staff_new_request', S2: 'staff_escalation', S3: 'provider_agenda',
};

export const TEMPLATES: Record<TemplateKey, string> = {
  T0: 'Your {{clinic}} code is {{code}}. It expires in 10 minutes.',
  T1: "Hi {{guardian}}, we received {{child}}'s follow-up request for {{day}} {{date}} at {{time}}. Ref {{ref}}. Payment options: cash at the clinic, or bank transfer to NCBA, account name {{ACCOUNT_NAME}}, account {{NCBA_ACCOUNT_NO}}, reference {{ref}}. After paying, reply with your transfer reference or a screenshot. We will never send new bank details by message. We will confirm shortly.",
  T2: "Hi {{guardian}}, we received {{child}}'s evaluation request for {{day}} {{date}} at {{time}}. Ref {{ref}}. Your therapist will reach out to you for confirmation.",
  T3: "{{child}}'s {{visit_type}} is confirmed: {{day}} {{date}}, {{time}}, with {{provider}}. Ref {{ref}}.",
  T4: "We could not confirm {{child}}'s request for {{date}} {{time}}. {{reason}}. Book another time: {{link}}",
  T5: 'We can offer {{new_day}} {{new_date}} at {{new_time}} for {{child}} instead.',
  T6: 'Reminder: {{child}} has {{visit_type}} tomorrow at {{time}} with {{provider}}.',
  T7: "{{child}}'s appointment on {{date}} at {{time}} is cancelled. {{reason}} Book again: {{link}}",
  T8: 'A {{visit_type}} time opened: {{day}} {{date}} {{time}}. First to tap gets it.',
  T9: '{{inviter}} added you to receive appointment updates for {{child}} at {{clinic}}. Reply YES to receive them on WhatsApp, or STOP to opt out.',
  T10: "{{clinic}} is closed on {{date}} ({{reason}}). {{child}}'s {{time}} appointment is cancelled. We will contact you to rebook, or book here: {{link}}",
  S1: 'New {{visit_type}} request: {{child}}, {{date}} {{time}}, suggested provider {{provider}}. Review: {{admin_link}}',
  S2: 'Request {{ref}} still pending. Expires {{expires_at}}.',
  S3: "Today's schedule: {{n}} visits. First at {{time}}. {{link}}",
};

/** Action buttons — only ever attached for can_book guardians (PRD §7 fan-out rule). */
export const BUTTONS: Partial<Record<TemplateKey, (v: Vars) => Button[]>> = {
  T3: (v) => [{ id: `VIEW:${v.appointment_id}`, title: 'View' }, { id: `RESCHEDULE:${v.appointment_id}`, title: 'Reschedule' }],
  T5: (v) => [{ id: `ACCEPT:${v.appointment_id}`, title: 'Accept' }, { id: `CHOOSE_OTHER:${v.appointment_id}`, title: 'Choose another time' }],
  T6: (v) => [{ id: `ATTEND:${v.appointment_id}`, title: "I'll be there" }, { id: `RESCHEDULE:${v.appointment_id}`, title: 'Reschedule' }],
  T8: (v) => [{ id: `CLAIM:${v.offer_id}`, title: 'Claim' }],
};

export const VISIT_LABEL = { FOLLOW_UP: 'follow-up', EVALUATION: 'evaluation' } as const;

export const STRINGS = {
  slotTaken: 'That time was just taken. Please pick another time.',
  notifyOnlyCannotBook: 'Bookings for {{child}} are made by the primary contact. Contact the clinic at {{CLINIC_PHONE}} for changes.',
  otherGuardianHelper: 'They will receive updates. Only you can book or change appointments.',
  neverNewBankDetails: 'We will never send you new bank details by message.',
  offerTaken: 'Sorry, that time has already been taken.',
  tooManyCodes: 'Too many codes requested. Please try again later.',
  codeLocked: 'Too many wrong attempts. Please request a new code.',
  codeInvalid: 'That code is not correct or has expired.',
  smsManageSuffix: ' Manage: {{link}}',
};

export function render(text: string, v: Vars): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => (v[k] === undefined ? '' : String(v[k])));
}

/** Ordered parameter values for the Meta template body. */
export function templateParams(key: TemplateKey, v: Vars): string[] {
  return [...TEMPLATES[key].matchAll(/\{\{(\w+)\}\}/g)].map((m) => String(v[m[1]] ?? ''));
}
