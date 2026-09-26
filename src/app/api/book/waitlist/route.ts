import { NextResponse } from 'next/server';
import { json, requireGuardian, route } from '@/server/http';
import { joinWaitlist } from '@/server/parent';

export const POST = route(async ({ req, ctx, actor }) =>
  NextResponse.json(await joinWaitlist(ctx, requireGuardian(actor), await json(req)), { status: 201 }),
);
