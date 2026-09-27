import { expect, test, type Page } from '@playwright/test';
import { createStaff, latestOtp, randomPhone } from './db';

test.use({ viewport: { width: 1400, height: 900 }, isMobile: false, hasTouch: false, timezoneId: 'Asia/Tokyo' });

async function parentBooks(page: Page, childName: string) {
  const phone = randomPhone();
  await page.goto('/book/sign-in');
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill(await latestOtp(phone));
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await page.getByRole('link', { name: 'Book a visit' }).click();
  await page.getByText('Follow-up', { exact: true }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  // Pick the last open time of the first day so repeated runs don't collide.
  await page.locator('fieldset').nth(1).getByRole('button').last().click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel("Child's full name").fill(childName);
  await page.getByText(/collecting and using my child/).click();
  await page.getByText(/receiving appointment messages/).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Request this time' }).click();
  const ref = (await page.getByTestId('booking-ref').textContent())!.trim();
  const when = (await page.getByTestId('booking-ref').locator('xpath=following-sibling::p').textContent())!.trim();
  return { ref, when };
}

async function staffLogin(page: Page, s: { email: string; password: string; code: () => string }) {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(s.email);
  await page.getByLabel('Password').fill(s.password);
  await page.getByLabel('Authenticator code').fill(s.code());
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Approval queue' })).toBeVisible();
}

test('admin: TOTP login, confirm with reassignment, calendar, parent sees provider; device timezone ignored', async ({
  browser,
}) => {
  const parent = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const child = `E2E Child ${Date.now()}`;
  const { ref, when: parentWhen } = await parentBooks(parent, child);

  const page = await browser.newPage({ timezoneId: 'Asia/Tokyo', viewport: { width: 1400, height: 900 } });
  const admin = await createStaff('ADMIN');
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(admin.email);
  await page.getByLabel('Password').fill(admin.password);
  await page.getByLabel('Authenticator code').fill('000000');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Email, password or code is not correct.')).toBeVisible();
  await staffLogin(page, admin);
  await expect(page).toHaveTitle('Admin | Wellness Ave');

  const item = page.getByTestId('queue-item').filter({ hasText: ref });
  await expect(item).toBeVisible();
  await expect(item).toContainText(/expires in \d+h/);
  // AC 14: times are AST even though this browser runs in Tokyo (UTC+9).
  const when = (await item.getByTestId('queue-when').textContent())!.trim();
  const clock = (s: string) => s.match(/\d{1,2}:\d{2} (AM|PM)/)![0];
  expect(clock(when)).toBe(clock(parentWhen)); // parent page (390px) and admin (Tokyo browser) agree on AST
  const select = item.getByLabel('Provider');
  await expect(select.locator('option', { hasText: 'Provider C' })).toHaveCount(1); // free-provider list loaded
  const target = (await select.locator('option').allTextContents()).find((o) => o.startsWith('Provider C'))!;
  await select.selectOption({ label: target });
  await item.getByRole('button', { name: 'Confirm visit' }).click();
  await expect(page.getByTestId('queue-item').filter({ hasText: ref })).toHaveCount(0);

  await page.getByRole('link', { name: 'Calendar' }).click();
  const whenDate = when.match(/\w{3} (\d{1,2}) (\w{3}) (\d{4})/)!;
  const iso = new Date(`${whenDate[1]} ${whenDate[2]} ${whenDate[3]} 12:00 UTC`).toISOString().slice(0, 10);
  await page.getByLabel('Date').fill(iso);
  const block = page.getByTestId('col-Provider C').getByTestId('cal-appt').filter({ hasText: child });
  await expect(block).toBeVisible();
  await expect(block).not.toContainText('pending');

  await parent.goto('/book/visits');
  await expect(parent.getByTestId('visit-card').filter({ hasText: ref })).toContainText('Confirmed');
  await expect(parent.getByTestId('visit-card').filter({ hasText: ref })).toContainText('with Provider C');

  // Settings round-trip and message log.
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByLabel('Buffer between visits (minutes)').fill('0');
  await page.getByRole('link', { name: 'Messages & audit' }).click();
  await expect(page.getByRole('cell', { name: 'T3' }).first()).toBeVisible();
});

test('provider: own calendar only, no admin pages', async ({ page }) => {
  const p = await createStaff('PROVIDER', 'Provider A');
  await staffLogin(page, p);
  await expect(page.getByRole('link', { name: 'Patients' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Calendar' }).click();
  await expect(page.getByTestId(/^col-/)).toHaveCount(1);
  await expect(page.getByTestId('col-Provider A')).toBeVisible();
  await page.goto('/admin/settings');
  await expect(page).toHaveURL(/\/admin\/queue/);
});

test('first admin sign-in: scan QR, enter code, land in the console', async ({ page }) => {
  const { createAdminWithoutTotp } = await import('./db');
  const a = await createAdminWithoutTotp();
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(a.email);
  await page.getByLabel('Password').fill(a.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Set up two-factor sign-in' })).toBeVisible();
  await expect(page.getByAltText('Authenticator QR code')).toBeVisible();
  const key = (await page.locator('code').textContent())!.trim();
  await page.getByLabel('6-digit code').fill(a.codeFor(key));
  await page.getByRole('button', { name: 'Finish setup and sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Approval queue' })).toBeVisible();
});
