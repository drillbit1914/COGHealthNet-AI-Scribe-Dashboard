import crypto from 'node:crypto';
import { t } from '@/i18n';
import { audit } from '@/server/audit';
import { badRequest } from '@/server/errors';
import { requireGuardian, route } from '@/server/http';
import { ALLOWED_UPLOADS, getStorage, MAX_UPLOAD_BYTES } from '@/server/storage';

/** Referral letter upload (PDF/JPG/PNG, 10 MB). Keys are namespaced by guardian so only the uploader can attach them. */
export const POST = route(async ({ req, ctx, actor }) => {
  const guardianId = requireGuardian(actor);
  const type = (req.headers.get('content-type') ?? '').split(';')[0].trim();
  const ext = ALLOWED_UPLOADS[type];
  if (!ext) throw badRequest(t('errors.uploadType'));
  if (Number(req.headers.get('content-length') ?? 0) > MAX_UPLOAD_BYTES) throw badRequest(t('errors.uploadSize'));
  const data = Buffer.from(await req.arrayBuffer());
  if (!data.length) throw badRequest(t('errors.uploadType'));
  if (data.length > MAX_UPLOAD_BYTES) throw badRequest(t('errors.uploadSize'));
  const key = `referrals/${guardianId}/${crypto.randomUUID()}.${ext}`;
  await getStorage().put(key, data, type);
  await audit(ctx.db, { type: 'GUARDIAN', id: guardianId }, 'upload', 'file', key);
  return { key };
});
