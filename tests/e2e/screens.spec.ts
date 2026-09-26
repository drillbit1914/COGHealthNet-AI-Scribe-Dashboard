import { expect, test } from '@playwright/test';
import { latestOtp, randomPhone } from './db';

// Captures review screenshots; skipped unless SCREENSHOTS_DIR is set.
test('screenshots', async ({ page }) => {
  test.skip(!process.env.SCREENSHOTS_DIR, 'set SCREENSHOTS_DIR to capture');
  const dir = process.env.SCREENSHOTS_DIR!;
  const phone = randomPhone();
  await page.goto('/book');
  await page.getByLabel('Mobile number').fill(phone);
  await page.screenshot({ path: `${dir}/1-sign-in.png` });
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill(await latestOtp(phone));
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await page.getByRole('link', { name: 'Book a visit' }).click();
  await page.getByText('Evaluation', { exact: true }).click();
  await page.screenshot({ path: `${dir}/2-visit-type.png` });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('fieldset').nth(1).getByRole('button').nth(2).click();
  await page.screenshot({ path: `${dir}/3-time.png` });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel("Child's full name").fill('Leo Brooks');
  await page.getByLabel('Date of birth').fill('2019-04-02');
  await page.getByLabel('Reason for evaluation').fill('Pencil grip');
  await page.getByText('Self-pay', { exact: true }).click();
  await page.getByText(/collecting and using my child/).click();
  await page.getByText(/receiving appointment messages/).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Request this time' }).click();
  await expect(page.getByTestId('booking-ref')).toBeVisible();
  await page.screenshot({ path: `${dir}/4-confirmation.png` });
});

test('admin screenshots', async ({ browser }) => {
  test.skip(!process.env.SCREENSHOTS_DIR, 'set SCREENSHOTS_DIR to capture');
  const dir = process.env.SCREENSHOTS_DIR!;
  const parent = await browser.newPage();
  for (const [i, name] of ['Maya Richardson', 'Leo Brooks', 'Aaliyah Hodge'].entries()) {
    const phone = randomPhone();
    await parent.goto('/book/sign-in');
    await parent.getByLabel('Mobile number').fill(phone);
    await parent.getByRole('button', { name: 'Send code' }).click();
    await parent.getByLabel('6-digit code').fill(await latestOtp(phone));
    await parent.getByRole('button', { name: 'Verify and continue' }).click();
    await parent.getByRole('link', { name: 'Book a visit' }).click();
    await parent.getByText('Follow-up', { exact: true }).click();
    await parent.getByRole('button', { name: 'Continue' }).click();
    await parent
      .locator('fieldset')
      .nth(1)
      .getByRole('button')
      .nth(i * 3 + 1)
      .click();
    await parent.getByRole('button', { name: 'Continue' }).click();
    await parent.getByLabel("Child's full name").fill(name);
    await parent.getByText(/collecting and using my child/).click();
    await parent.getByText(/receiving appointment messages/).click();
    await parent.getByRole('button', { name: 'Continue' }).click();
    await parent.getByRole('button', { name: 'Request this time' }).click();
    await expect(parent.getByTestId('booking-ref')).toBeVisible();
  }
  const { createStaff } = await import('./db');
  const admin = await createStaff('ADMIN');
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(admin.email);
  await page.getByLabel('Password').fill(admin.password);
  await page.getByLabel('Authenticator code').fill(admin.code());
  await page.getByRole('button', { name: 'Sign in' }).click();
  const first = page.getByTestId('queue-item').first();
  await expect(first.getByLabel('Provider').locator('option')).toHaveCount(4);
  await first.getByRole('button', { name: 'Confirm visit' }).click();
  await expect(page.getByTestId('queue-item')).toHaveCount(2);
  await page.screenshot({ path: `${dir}/admin-queue.png` });
  await page.getByRole('link', { name: 'Calendar' }).click();
  await page.getByLabel('Date').fill('2026-10-02');
  await expect(page.getByTestId('cal-appt').first()).toBeVisible();
  await page.screenshot({ path: `${dir}/admin-calendar.png` });
});
