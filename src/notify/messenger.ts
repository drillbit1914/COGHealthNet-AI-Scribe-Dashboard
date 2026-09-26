import crypto from 'node:crypto';
import { META_TEMPLATE_NAME, type Button, type TemplateKey } from '../i18n/en.js';

export interface OutboundWhatsApp { to: string; templateKey: TemplateKey; params: string[]; body: string; buttons: Button[] }
export interface Messenger {
  sendWhatsApp(m: OutboundWhatsApp): Promise<{ id: string }>;
  sendSms(to: string, body: string): Promise<{ id: string }>;
}

/** Meta WhatsApp Cloud API (direct, PRD §12). Template names map from META_TEMPLATE_NAME. */
export class WhatsAppCloudMessenger implements Pick<Messenger, 'sendWhatsApp'> {
  constructor(private phoneNumberId: string, private token: string, private templateNames: Record<string, string>,
              private lang = 'en') {}
  async sendWhatsApp(m: OutboundWhatsApp) {
    const components: unknown[] = [{ type: 'body', parameters: m.params.map((text) => ({ type: 'text', text })) }];
    m.buttons.forEach((b, index) => components.push({
      type: 'button', sub_type: 'quick_reply', index: String(index), parameters: [{ type: 'payload', payload: b.id }],
    }));
    const res = await fetch(`https://graph.facebook.com/v21.0/${this.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: m.to.replace('+', ''), type: 'template',
        template: { name: this.templateNames[m.templateKey], language: { code: this.lang }, components },
      }),
    });
    const json = (await res.json()) as { messages?: { id: string }[]; error?: { message: string } };
    if (!res.ok || !json.messages?.[0]) throw new Error(json.error?.message ?? `WhatsApp HTTP ${res.status}`);
    return { id: json.messages[0].id };
  }
}

/** Twilio Programmable Messaging (PRD §12). */
export class TwilioSmsMessenger implements Pick<Messenger, 'sendSms'> {
  constructor(private accountSid: string, private authToken: string, private from: string, private statusCallback?: string) {}
  async sendSms(to: string, body: string) {
    const form = new URLSearchParams({ To: to, From: this.from, Body: body });
    if (this.statusCallback) form.set('StatusCallback', this.statusCallback);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64') },
      body: form,
    });
    const json = (await res.json()) as { sid?: string; message?: string };
    if (!res.ok || !json.sid) throw new Error(json.message ?? `Twilio HTTP ${res.status}`);
    return { id: json.sid };
  }
}

/** In-memory messenger for dev and tests. `failWhatsApp` simulates an API error. */
export class FakeMessenger implements Messenger {
  sent: { channel: 'WHATSAPP' | 'SMS'; to: string; body: string; buttons: Button[]; templateKey?: string; id: string }[] = [];
  failWhatsApp = false;
  async sendWhatsApp(m: OutboundWhatsApp) {
    if (this.failWhatsApp) throw new Error('simulated WhatsApp failure');
    const id = 'wamid.' + crypto.randomUUID();
    this.sent.push({ channel: 'WHATSAPP', to: m.to, body: m.body, buttons: m.buttons, templateKey: m.templateKey, id });
    return { id };
  }
  async sendSms(to: string, body: string) {
    const id = 'SM' + crypto.randomUUID().replace(/-/g, '');
    this.sent.push({ channel: 'SMS', to, body, buttons: [], id });
    return { id };
  }
}

export function messengerFromEnv(env = process.env): Messenger {
  if (!env.WHATSAPP_TOKEN || !env.TWILIO_ACCOUNT_SID) return new FakeMessenger();
  const names = { ...META_TEMPLATE_NAME, ...JSON.parse(env.WHATSAPP_TEMPLATE_NAMES ?? '{}') };
  const wa = new WhatsAppCloudMessenger(env.WHATSAPP_PHONE_NUMBER_ID!, env.WHATSAPP_TOKEN, names);
  const sms = new TwilioSmsMessenger(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN!, env.TWILIO_FROM!, env.TWILIO_STATUS_CALLBACK);
  return { sendWhatsApp: (m) => wa.sendWhatsApp(m), sendSms: (to, b) => sms.sendSms(to, b) };
}
