import crypto from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { getStorage, LocalStorage } from '@/server/storage';

/** Serves LocalStorage files (dev/test only) behind 15-minute HMAC-signed URLs. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ key: string[] }> }) {
  const storage = getStorage();
  if (!(storage instanceof LocalStorage)) return new NextResponse(null, { status: 404 });
  const key = (await params).key.join('/');
  const exp = Number(req.nextUrl.searchParams.get('exp'));
  const sig = req.nextUrl.searchParams.get('sig') ?? '';
  const want = Buffer.from(LocalStorage.sign(key, exp));
  const ok = exp > Date.now() / 1000 && want.length === sig.length && crypto.timingSafeEqual(want, Buffer.from(sig));
  if (!ok) return new NextResponse(null, { status: 403 });
  try {
    const f = await storage.read(key);
    return new NextResponse(new Uint8Array(f.data), {
      headers: { 'Content-Type': f.contentType, 'Cache-Control': 'no-store' },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
