import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { metaTemplate, type Button, type TemplateKey } from './templates';

/** One outbound message, already rendered. `templateKey` is null for free-form session replies. */
export interface OutboundMessage {
  to: string;
  body: string;
  templateKey: TemplateKey | null;
  params: string[];
  buttons: Button[];
}

export interface MessagingProvider {
  readonly channel: 'WHATSAPP' | 'SMS';
  send(m: OutboundMessage): Promise<{ providerMessageId: string }>;
}

/** WhatsApp additionally downloads inbound media (payment screenshots). */
export interface WhatsAppProvider extends MessagingProvider {
  fetchMedia(mediaId: string): Promise<{ data: Buffer; contentType: string }>;
}

/**
 * Meta WhatsApp Cloud API, direct (PRD §12). Templates are sent with body parameters in registry order;
 * quick-reply buttons carry our payload ids. Session replies use type "text".
 */
export class WhatsAppCloudProvider implements WhatsAppProvider {
  readonly channel = 'WHATSAPP' as const;
  constructor(
    private phoneNumberId: string,
    private token: string,
    private graphVersion = 'v21.0',
  ) {}

  private url(path: string) {
    return `https://graph.facebook.com/${this.graphVersion}/${path}`;
  }

  /** Graph API request payload (exported for tests). */
  payload(m: OutboundMessage) {
    const to = m.to.replace(/^\+/, '');
    if (!m.templateKey) return { messaging_product: 'whatsapp', to, type: 'text', text: { body: m.body } };
    const tpl = metaTemplate(m.templateKey);
    const components: unknown[] = [{ type: 'body', parameters: m.params.map((text) => ({ type: 'text', text })) }];
    if (tpl.category === 'AUTHENTICATION') {
      // Authentication templates carry the code again on the copy-code button.
      components.push({
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: m.params[0] }],
      });
    }
    m.buttons.forEach((b, index) =>
      components.push({
        type: 'button',
        sub_type: 'quick_reply',
        index: String(index),
        parameters: [{ type: 'payload', payload: b.id }],
      }),
    );
    return {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name: tpl.name, language: { code: tpl.language }, components },
    };
  }

  async send(m: OutboundMessage) {
    const res = await fetch(this.url(`${this.phoneNumberId}/messages`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(this.payload(m)),
    });
    const json = (await res.json().catch(() => ({}))) as {
      messages?: { id: string }[];
      error?: { message?: string; code?: number };
    };
    if (!res.ok || !json.messages?.[0])
      throw new Error(
        json.error ? `${json.error.code ?? ''} ${json.error.message ?? ''}`.trim() : `WhatsApp HTTP ${res.status}`,
      );
    return { providerMessageId: json.messages[0].id };
  }

  async fetchMedia(mediaId: string) {
    const meta = await fetch(this.url(mediaId), { headers: { Authorization: `Bearer ${this.token}` } });
    const info = (await meta.json()) as { url?: string; mime_type?: string };
    if (!meta.ok || !info.url) throw new Error(`Media lookup failed: ${meta.status}`);
    const file = await fetch(info.url, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!file.ok) throw new Error(`Media download failed: ${file.status}`);
    return { data: Buffer.from(await file.arrayBuffer()), contentType: info.mime_type ?? 'application/octet-stream' };
  }
}

/** Twilio Programmable Messaging (PRD §12). Delivery reports come back to /api/webhooks/sms. */
export class TwilioSmsProvider implements MessagingProvider {
  readonly channel = 'SMS' as const;
  constructor(
    private accountSid: string,
    private authToken: string,
    private from: string,
    private statusCallback?: string,
  ) {}
  async send(m: OutboundMessage) {
    const form = new URLSearchParams({ To: m.to, From: this.from, Body: m.body });
    if (this.statusCallback) form.set('StatusCallback', this.statusCallback);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64') },
      body: form,
    });
    const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
    if (!res.ok || !json.sid)
      throw new Error(json.message ? `${json.code ?? ''} ${json.message}`.trim() : `Twilio HTTP ${res.status}`);
    return { providerMessageId: json.sid };
  }
}

/**
 * Development stub: logs instead of sending. Used whenever credentials are missing. With
 * MESSAGING_LOG_FILE set (dev/e2e only) it also appends each message as a JSON line.
 */
export class ConsoleProvider implements WhatsAppProvider {
  constructor(readonly channel: 'WHATSAPP' | 'SMS') {}
  async send(m: OutboundMessage) {
    const file = process.env.MESSAGING_LOG_FILE;
    if (file && (process.env.NODE_ENV !== 'production' || process.env.E2E === '1'))
      await fs.appendFile(file, JSON.stringify({ channel: this.channel, ...m }) + '\n').catch(() => {});
    console.info(
      `[${this.channel} → ${m.to}] ${m.body}${m.buttons.length ? ` [${m.buttons.map((b) => b.title).join(' | ')}]` : ''}`,
    );
    return { providerMessageId: `console-${crypto.randomUUID()}` };
  }
  async fetchMedia(): Promise<{ data: Buffer; contentType: string }> {
    return { data: Buffer.from(''), contentType: 'application/octet-stream' };
  }
}

export interface Providers {
  whatsapp: WhatsAppProvider;
  sms: MessagingProvider;
}

let providers: Providers | undefined;
export function getProviders(): Providers {
  if (providers) return providers;
  const e = process.env;
  const whatsapp =
    e.WA_PHONE_NUMBER_ID && e.WA_ACCESS_TOKEN
      ? new WhatsAppCloudProvider(e.WA_PHONE_NUMBER_ID, e.WA_ACCESS_TOKEN, e.WA_GRAPH_VERSION || 'v21.0')
      : new ConsoleProvider('WHATSAPP');
  const sms =
    e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && e.TWILIO_FROM_NUMBER
      ? new TwilioSmsProvider(
          e.TWILIO_ACCOUNT_SID,
          e.TWILIO_AUTH_TOKEN,
          e.TWILIO_FROM_NUMBER,
          e.APP_BASE_URL ? `${e.APP_BASE_URL}/api/webhooks/sms` : undefined,
        )
      : new ConsoleProvider('SMS');
  if (e.NODE_ENV === 'production' && (whatsapp instanceof ConsoleProvider || sms instanceof ConsoleProvider))
    console.warn('Messaging credentials missing — messages are being logged, not sent.');
  providers = { whatsapp, sms };
  return providers;
}
export const setProviders = (p: Providers | undefined) => void (providers = p);
