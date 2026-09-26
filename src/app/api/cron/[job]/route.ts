import { NextResponse, type NextRequest } from 'next/server';
import { routeCtx } from '@/server/http';
import { JOBS, runJob, type JobName } from '@/server/jobs';
import { verifyBearer } from '@/server/messaging/signatures';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Vercel Cron / pg_net call GET with "Authorization: Bearer $CRON_SECRET". */
export async function GET(req: NextRequest, { params }: { params: Promise<{ job: string }> }) {
  if (!verifyBearer(req.headers.get('authorization'), process.env.CRON_SECRET))
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  const { job } = await params;
  if (!(job in JOBS)) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  return NextResponse.json(await runJob(routeCtx(), job as JobName));
}
export const POST = GET;
