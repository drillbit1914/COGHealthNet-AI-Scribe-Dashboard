import crypto from 'node:crypto';

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Meta: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body). */
export function verifyMetaSignature(rawBody: string, header: string | null, appSecret: string | undefined) {
  if (!header || !appSecret) return false;
  return safeEq(header, 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex'));
}

/** Twilio: X-Twilio-Signature = base64 HMAC-SHA1(auth token, full URL + params sorted by key, concatenated). */
export function twilioSignature(url: string, params: Record<string, string>, authToken: string) {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join('');
  return crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  header: string | null,
  authToken: string | undefined,
) {
  if (!header || !authToken) return false;
  return safeEq(header, twilioSignature(url, params, authToken));
}

export function verifyBearer(header: string | null, secret: string | undefined) {
  if (!header || !secret) return false;
  return safeEq(header, `Bearer ${secret}`);
}
