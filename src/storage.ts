import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Private file storage with 15-minute signed URLs (PRD §12). Swap LocalStorage for S3/GCS in production. */
export interface Storage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ data: Buffer; contentType: string } | null>;
  signedUrl(key: string, now?: Date): string;
  verify(key: string, exp: string, sig: string, now?: Date): boolean;
}

export const ALLOWED_UPLOADS: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const TTL_MS = 15 * 60000;

export class LocalStorage implements Storage {
  constructor(private root: string, private secret: string, private baseUrl = '/files') {}
  private file(key: string) {
    if (!/^[\w-]+\/[\w.-]+$/.test(key)) throw new Error('bad key');
    return path.join(this.root, key);
  }
  async put(key: string, data: Buffer, contentType: string) {
    const f = this.file(key);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, data);
    await fs.writeFile(f + '.type', contentType);
  }
  async get(key: string) {
    try {
      const f = this.file(key);
      return { data: await fs.readFile(f), contentType: await fs.readFile(f + '.type', 'utf8') };
    } catch { return null; }
  }
  private sign(key: string, exp: string) { return crypto.createHmac('sha256', this.secret).update(`${key}:${exp}`).digest('base64url'); }
  signedUrl(key: string, now = new Date()) {
    const exp = String(now.getTime() + TTL_MS);
    return `${this.baseUrl}/${key}?exp=${exp}&sig=${this.sign(key, exp)}`;
  }
  verify(key: string, exp: string, sig: string, now = new Date()) {
    if (!exp || !sig || Number(exp) < now.getTime()) return false;
    const want = Buffer.from(this.sign(key, exp));
    const got = Buffer.from(sig);
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }
}
