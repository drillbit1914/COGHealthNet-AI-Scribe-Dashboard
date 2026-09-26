process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://wav:wav@localhost:5432/wav_test';
process.env.SESSION_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.CRON_SECRET ??= 'test-cron';
process.env.APP_BASE_URL ??= 'https://book.wellnessave.test';
process.env.WA_APP_SECRET ??= 'test-meta-app-secret';
process.env.WA_VERIFY_TOKEN ??= 'test-verify-token';
process.env.TWILIO_AUTH_TOKEN ??= 'test-twilio-token';
process.env.TWILIO_ACCOUNT_SID ??= 'ACtest';
