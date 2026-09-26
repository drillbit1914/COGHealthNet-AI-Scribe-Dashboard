import type { Db } from './db.js';
import type { Messenger } from './notify/messenger.js';

/** Service context: injected so tests can control time and capture messages. */
export interface Ctx { db: Db; messenger: Messenger; now: () => Date }
