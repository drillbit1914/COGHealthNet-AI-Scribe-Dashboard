import { createPool } from './db.js';
import { runJobs } from './jobs.js';
import { messengerFromEnv } from './notify/messenger.js';

/** Runs expiries, escalations, reminders, agendas and retention every minute. */
const db = createPool();
const ctx = { db, messenger: messengerFromEnv(), now: () => new Date() };
const tick = async () => {
  try {
    const r = await runJobs(ctx);
    if (Object.values(r).some(Boolean)) console.log(new Date().toISOString(), r);
  } catch (e) { console.error('job tick failed', e); }
};
await tick();
setInterval(tick, 60000);
