import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Private file storage with 15-minute signed URLs (PRD §12). */
export interface Storage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  signedUrl(key: string): Promise<string>;
}

export const ALLOWED_UPLOADS: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const TTL_S = 15 * 60;
const KEY = /^[\w-]+(\/[\w.-]+)+$/;

/** Supabase Storage private bucket via REST (service role; server-side only). */
export class SupabaseStorage implements Storage {
  constructor(
    private url: string,
    private serviceKey: string,
    private bucket: string,
  ) {}
  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.serviceKey}`, apikey: this.serviceKey, ...extra };
  }
  async put(key: string, data: Buffer, contentType: string) {
    if (!KEY.test(key)) throw new Error('bad key');
    const res = await fetch(`${this.url}/storage/v1/object/${this.bucket}/${key}`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': contentType, 'x-upsert': 'false' }),
      body: new Uint8Array(data),
    });
    if (!res.ok) throw new Error(`Storage upload failed: ${res.status}`);
  }
  async signedUrl(key: string) {
    const res = await fetch(`${this.url}/storage/v1/object/sign/${this.bucket}/${key}`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ expiresIn: TTL_S }),
    });
    const json = (await res.json()) as { signedURL?: string };
    if (!res.ok || !json.signedURL) throw new Error(`Storage sign failed: ${res.status}`);
    return `${this.url}/storage/v1${json.signedURL}`;
  }
}

/** Local-disk fallback for development and tests; URLs are HMAC-signed and served by /api/files. */
export class LocalStorage implements Storage {
  constructor(private root: string) {}
  file(key: string) {
    if (!KEY.test(key) || key.includes('..')) throw new Error('bad key');
    return path.join(this.root, key);
  }
  async put(key: string, data: Buffer, contentType: string) {
    const f = this.file(key);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, data);
    await fs.writeFile(f + '.type', contentType);
  }
  async read(key: string) {
    const f = this.file(key);
    return { data: await fs.readFile(f), contentType: await fs.readFile(f + '.type', 'utf8') };
  }
  static sign(key: string, exp: number) {
    return crypto
      .createHmac('sha256', process.env.SESSION_SECRET ?? '')
      .update(`${key}:${exp}`)
      .digest('base64url');
  }
  async signedUrl(key: string) {
    const exp = Math.floor(Date.now() / 1000) + TTL_S;
    return `/api/files/${key}?exp=${exp}&sig=${LocalStorage.sign(key, exp)}`;
  }
}

let storage: Storage | undefined;
export function getStorage(): Storage {
  const e = process.env;
  if (!storage) {
    if (e.SUPABASE_URL && e.SUPABASE_SERVICE_ROLE_KEY)
      storage = new SupabaseStorage(
        e.SUPABASE_URL,
        e.SUPABASE_SERVICE_ROLE_KEY,
        e.STORAGE_BUCKET ?? 'wellness-ave-private',
      );
    else if (e.NODE_ENV === 'production' && e.E2E !== '1')
      // Serverless disks are ephemeral: referral letters and payment proofs would be lost.
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in production');
    else storage = new LocalStorage(path.resolve(e.FILE_ROOT ?? '.data/files'));
  }
  return storage;
}
export const setStorage = (s: Storage) => void (storage = s);
