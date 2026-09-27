// Generates docs/WHATSAPP_TEMPLATES.md from the template registry and en.json (run: pnpm tsx scripts/whatsapp-templates.ts).
import fs from 'node:fs';
import en from '../src/i18n/en.json';
import { TEMPLATES, type TemplateKey } from '../src/server/messaging/templates';

const SAMPLE: Record<string, string> = {
  code: '482913',
  guardian: 'Tasha',
  child: 'Maya',
  day: 'Friday',
  date: '2 October 2026',
  time: '9:00 AM',
  ref: 'WAV-4F7K',
  ACCOUNT_NAME: 'Wellness Ave.',
  NCBA_ACCOUNT_NO: '6001232',
  visit_type: 'follow-up',
  provider: 'Dr. Kniquiah Hughes',
  reason: 'The requested time is no longer available',
  link: 'https://book.wellnessave.com/book',
  new_day: 'Saturday',
  new_date: '3 October 2026',
  new_time: '10:30 AM',
  inviter: 'Tasha',
  admin_link: 'https://book.wellnessave.com/admin',
  expires_at: '3 October 2026 9:00 AM',
  n: '4',
};
const BUTTONS: Partial<Record<TemplateKey, string[]>> = {
  T3: ['View', 'Reschedule'],
  T5: ['Accept', 'Choose another time'],
  T6: ["I'll be there", 'Reschedule'],
  T8: ['Claim'],
};

let out =
  '# WhatsApp templates to submit to Meta\n\n' +
  'Generated from `src/server/messaging/templates.ts` and `src/i18n/en.json`. In WhatsApp Manager → Message templates → ' +
  'Create template: use the **name**, **category** and **language** below, paste the **body**, give each variable its ' +
  '**sample**, and add the **quick-reply buttons** where listed (button text only; the app supplies the payload). ' +
  'Keep the variables in this order.\n\n';
for (const [key, def] of Object.entries(TEMPLATES) as [TemplateKey, (typeof TEMPLATES)[TemplateKey]][]) {
  let i = 0;
  const body = (en.templates[key] as string).replace(/\{\{(\w+)\}\}/g, () => `{{${++i}}}`);
  out += `## ${key} — \`${def.metaName}\`\n\n- Category: **${def.category}** · Language: **English (en)**\n`;
  if (def.category === 'AUTHENTICATION')
    out +=
      '- Authentication templates use Meta\'s fixed wording: choose the "Copy code" button. The app sends the code as {{1}} and on the button.\n';
  out += `\n**Body**\n\n> ${body}\n\n| Variable | Meaning | Sample |\n|---|---|---|\n`;
  def.vars.forEach((v, n) => (out += `| {{${n + 1}}} | ${v} | ${SAMPLE[v] ?? ''} |\n`));
  if (BUTTONS[key]) out += `\n**Quick-reply buttons:** ${BUTTONS[key]!.map((b) => `"${b}"`).join(', ')}\n`;
  out += '\n';
}
fs.writeFileSync('docs/WHATSAPP_TEMPLATES.md', out);
console.log('wrote docs/WHATSAPP_TEMPLATES.md');
