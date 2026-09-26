import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { forbidden } from '../errors.js';
import { handleInbound } from '../inbound.js';
import { handleDeliveryStatus } from '../notify/notify.js';
import type { AppDeps } from './app.js';

const safeEq = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Meta signs the raw body with the app secret (PRD §12). */
export function verifyMetaSignature(raw: string, header: string | undefined, appSecret: string) {
  if (!header) return false;
  return safeEq(header, 'sha256=' + crypto.createHmac('sha256', appSecret).update(raw).digest('hex'));
}

/** Twilio: HMAC-SHA1 over the full URL + sorted form params. */
export function verifyTwilioSignature(url: string, params: Record<string, string>, header: string | undefined, authToken: string) {
  if (!header) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return safeEq(header, crypto.createHmac('sha1', authToken).update(data).digest('base64'));
}

interface WaMessage {
  from: string; id: string; type: string; text?: { body: string }; button?: { payload: string };
  interactive?: { button_reply?: { id: string } }; image?: { id: string }; document?: { id: string };
}

export const webhookRoutes = (deps: AppDeps): FastifyPluginAsync => async (app) => {
  const { ctx } = deps;
  const env = process.env;

  app.get('/whatsapp', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q['hub.mode'] === 'subscribe' && env.WHATSAPP_VERIFY_TOKEN && q['hub.verify_token'] === env.WHATSAPP_VERIFY_TOKEN)
      return reply.type('text/plain').send(q['hub.challenge']);
    throw forbidden();
  });

  app.post('/whatsapp', async (req) => {
    if (!env.WHATSAPP_APP_SECRET || !verifyMetaSignature(req.rawBody ?? '', req.headers['x-hub-signature-256'] as string, env.WHATSAPP_APP_SECRET))
      throw forbidden('Bad signature');
    const body = req.body as { entry?: { changes?: { value?: { statuses?: { id: string; status: string; errors?: { title?: string; code?: number }[] }[]; messages?: WaMessage[] } }[] }[] };
    for (const entry of body.entry ?? [])
      for (const ch of entry.changes ?? []) {
        for (const st of ch.value?.statuses ?? [])
          await handleDeliveryStatus(ctx, st.id, st.status, st.errors?.[0] ? `${st.errors[0].code ?? ''} ${st.errors[0].title ?? ''}`.trim() : undefined);
        for (const m of ch.value?.messages ?? [])
          await handleInbound(ctx, {
            channel: 'WHATSAPP', from: m.from, providerMessageId: m.id, text: m.text?.body,
            buttonPayload: m.button?.payload ?? m.interactive?.button_reply?.id, mediaId: m.image?.id ?? m.document?.id,
          });
      }
    return { ok: true };
  });

  const twilioCheck = (req: FastifyRequest) => {
    const url = `${env.PUBLIC_BASE_URL ?? ''}${req.url}`;
    if (!env.TWILIO_AUTH_TOKEN || !verifyTwilioSignature(url, req.body as Record<string, string>, req.headers['x-twilio-signature'] as string, env.TWILIO_AUTH_TOKEN))
      throw forbidden('Bad signature');
  };
  app.post('/twilio/status', async (req) => {
    twilioCheck(req);
    const b = req.body as Record<string, string>;
    const status = { undelivered: 'FAILED', failed: 'FAILED' }[b.MessageStatus] ?? b.MessageStatus;
    await handleDeliveryStatus(ctx, b.MessageSid, status, b.ErrorCode);
    return { ok: true };
  });
  app.post('/twilio/inbound', async (req, reply) => {
    twilioCheck(req);
    const b = req.body as Record<string, string>;
    await handleInbound(ctx, { channel: 'SMS', from: b.From, providerMessageId: b.MessageSid, text: b.Body,
      mediaId: Number(b.NumMedia) > 0 ? b.MessageSid : undefined });
    return reply.type('text/xml').send('<Response></Response>');
  });
};
