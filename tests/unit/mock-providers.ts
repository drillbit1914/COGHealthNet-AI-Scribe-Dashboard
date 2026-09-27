import crypto from 'node:crypto';
import type { OutboundMessage, Providers, WhatsAppProvider, MessagingProvider } from '@/server/messaging/provider';

export interface Sent extends OutboundMessage {
  channel: 'WHATSAPP' | 'SMS';
  id: string;
}

/** Records every send; `fail` makes the next sends throw (simulated API error). */
export class MockProviders implements Providers {
  sent: Sent[] = [];
  failWhatsApp = false;
  failSms = false;
  whatsappEnabled = true;
  media = { data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png' };
  whatsapp: WhatsAppProvider = {
    channel: 'WHATSAPP',
    send: async (m) => this.record('WHATSAPP', m, this.failWhatsApp),
    fetchMedia: async () => this.media,
  };
  sms: MessagingProvider = { channel: 'SMS', send: async (m) => this.record('SMS', m, this.failSms) };
  private async record(channel: 'WHATSAPP' | 'SMS', m: OutboundMessage, fail: boolean) {
    if (fail) throw new Error(`simulated ${channel} failure`);
    const id = (channel === 'WHATSAPP' ? 'wamid.' : 'SM') + crypto.randomUUID().replace(/-/g, '');
    this.sent.push({ ...m, channel, id });
    return { providerMessageId: id };
  }
  to(phone: string) {
    return this.sent.filter((s) => s.to === phone);
  }
  byTemplate(key: string) {
    return this.sent.filter((s) => s.templateKey === key);
  }
}
