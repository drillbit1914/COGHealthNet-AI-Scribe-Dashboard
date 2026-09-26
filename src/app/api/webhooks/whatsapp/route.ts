import { NextResponse, type NextRequest } from 'next/server';
import { routeCtx } from '@/server/http';
import { handleInbound } from '@/server/messaging/inbound';
import { processOutbox, recordDeliveryStatus } from '@/server/messaging/outbox';
import { getProviders } from '@/server/messaging/provider';
import { verifyMetaSignature } from '@/server/messaging/signatures';

export const dynamic = 'force-dynamic';

/** Meta webhook verification handshake. */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  if (
    p.get('hub.mode') === 'subscribe' &&
    process.env.WA_VERIFY_TOKEN &&
    p.get('hub.verify_token') === process.env.WA_VERIFY_TOKEN
  )
    return new NextResponse(p.get('hub.challenge') ?? '', { headers: { 'Content-Type': 'text/plain' } });
  return new NextResponse(null, { status: 403 });
}

interface WaStatus {
  id: string;
  status: string;
  errors?: { code?: number; title?: string }[];
}
interface WaMessage {
  from: string;
  id: string;
  type: string;
  text?: { body: string };
  button?: { payload: string; text?: string };
  interactive?: { button_reply?: { id: string } };
  image?: { id: string; caption?: string };
  document?: { id: string; caption?: string };
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (!verifyMetaSignature(raw, req.headers.get('x-hub-signature-256'), process.env.WA_APP_SECRET))
    return NextResponse.json({ error: 'BAD_SIGNATURE' }, { status: 401 });
  let body: { entry?: { changes?: { value?: { statuses?: WaStatus[]; messages?: WaMessage[] } }[] }[] };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });
  }
  const ctx = routeCtx();
  const providers = getProviders();
  for (const entry of body.entry ?? [])
    for (const change of entry.changes ?? []) {
      for (const st of change.value?.statuses ?? [])
        await recordDeliveryStatus(
          ctx,
          st.id,
          st.status,
          st.errors?.[0] ? `${st.errors[0].code ?? ''} ${st.errors[0].title ?? ''}`.trim() : undefined,
        );
      for (const m of change.value?.messages ?? []) {
        const mediaId = m.image?.id ?? m.document?.id;
        await handleInbound(ctx, {
          channel: 'WHATSAPP',
          from: m.from,
          providerMessageId: m.id,
          text: m.text?.body ?? m.image?.caption ?? m.document?.caption,
          buttonPayload: m.button?.payload ?? m.interactive?.button_reply?.id,
          media: mediaId ? () => providers.whatsapp.fetchMedia(mediaId) : undefined,
        });
      }
    }
  // Replies and SMS fallbacks go out now (AC 8: within 60 seconds).
  await processOutbox(ctx, { providers });
  return NextResponse.json({ ok: true });
}
