import { NextResponse, type NextRequest } from 'next/server';
import { appBaseUrl } from '@/server/env';
import { routeCtx } from '@/server/http';
import { handleInbound } from '@/server/messaging/inbound';
import { processOutbox, recordDeliveryStatus } from '@/server/messaging/outbox';
import { getProviders } from '@/server/messaging/provider';
import { verifyTwilioSignature } from '@/server/messaging/signatures';

export const dynamic = 'force-dynamic';

const twiml = () =>
  new NextResponse('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    headers: { 'Content-Type': 'text/xml' },
  });

/** Twilio status callbacks and inbound SMS/MMS. Signature is over the public URL Twilio called. */
export async function POST(req: NextRequest) {
  const params = Object.fromEntries(new URLSearchParams(await req.text()));
  const publicUrl = `${appBaseUrl()}${req.nextUrl.pathname}${req.nextUrl.search}`;
  if (!verifyTwilioSignature(publicUrl, params, req.headers.get('x-twilio-signature'), process.env.TWILIO_AUTH_TOKEN))
    return NextResponse.json({ error: 'BAD_SIGNATURE' }, { status: 401 });
  const ctx = routeCtx();

  if (params.MessageStatus && !params.Body && params.SmsStatus !== 'received') {
    await recordDeliveryStatus(ctx, params.MessageSid, params.MessageStatus, params.ErrorCode || undefined);
    return twiml();
  }

  const mediaUrl = Number(params.NumMedia ?? 0) > 0 ? params.MediaUrl0 : undefined;
  await handleInbound(ctx, {
    channel: 'SMS',
    from: params.From,
    providerMessageId: params.MessageSid,
    text: params.Body || undefined,
    media: mediaUrl
      ? async () => {
          const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString(
            'base64',
          );
          const res = await fetch(mediaUrl, { headers: { Authorization: `Basic ${auth}` } });
          return {
            data: Buffer.from(await res.arrayBuffer()),
            contentType: params.MediaContentType0 ?? res.headers.get('content-type') ?? '',
          };
        }
      : undefined,
  });
  await processOutbox(ctx, { providers: getProviders() });
  return twiml();
}
