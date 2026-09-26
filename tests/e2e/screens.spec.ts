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
