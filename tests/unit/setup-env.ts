process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://wav:wav@localhost:5432/wav_test';
process.env.SESSION_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.CRON_SECRET ??= 'test-cron';
process.env.APP_BASE_URL ??= 'https://book.wellnessave.test';
