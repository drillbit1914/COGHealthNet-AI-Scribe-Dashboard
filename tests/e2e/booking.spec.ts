import { expect, test, type Page } from '@playwright/test';
import { latestOtp, randomPhone } from './db';

async function signIn(page: Page) {
  const phone = randomPhone();
  await page.goto('/book');
  await expect(page).toHaveURL(/\/book\/sign-in/);
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill(await latestOtp(phone));
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await expect(page.getByRole('heading', { name: /Hello/ })).toBeVisible();
  return phone;
}

async function pickFirstTime(page: Page) {
  await expect(page.getByRole('heading', { name: 'Pick a time' })).toBeVisible();
  const firstTime = page.locator('fieldset').nth(1).getByRole('button').first();
  await firstTime.click();
  await expect(firstTime).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Continue' }).click();
}

test.describe('parent booking at 390px', () => {
  test('follow-up happy path', async ({ page }) => {
    expect(page.viewportSize()?.width).toBe(390);
    await signIn(page);
    await page.getByLabel('Your name').fill('Tasha');
    await page.getByRole('button', { name: 'Save name' }).click();
    await expect(page.getByRole('heading', { name: 'Hello, Tasha' })).toBeVisible();

    await page.getByRole('link', { name: 'Book a visit' }).click();
    await page.getByText('Follow-up', { exact: true }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await pickFirstTime(page);

    await page.getByLabel("Child's full name").fill('Maya Richardson');
    await page.getByText(/collecting and using my child/).click();
    await page.getByText(/receiving appointment messages/).click();
    await page.getByRole('button', { name: 'Continue' }).click();

    // Back navigation preserves state.
    await expect(page.getByRole('heading', { name: 'Check and send' })).toBeVisible();
    await page.goBack();
    await expect(page.getByLabel("Child's full name")).toHaveValue('Maya Richardson');
    await page.goForward();

    await expect(page.getByText('Maya Richardson')).toBeVisible();
    await page.getByRole('button', { name: 'Request this time' }).click();
    await expect(page.getByRole('heading', { name: 'Request sent' })).toBeVisible();
    await expect(page.getByTestId('booking-ref')).toHaveText(/^WAV-[A-Z0-9]{4}$/);
    await expect(page.getByText('Bank transfer to NCBA')).toBeVisible();
    await expect(page.getByText('We will never send you new bank details by message.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Add to calendar' })).toHaveAttribute('href', /\/ics$/);
    // No provider is ever named before confirmation.
    await expect(page.getByText(/Provider [A-D]/)).toHaveCount(0);

    await page.getByRole('link', { name: 'View my visits' }).click();
    await expect(page.getByRole('heading', { name: 'My visits' })).toBeVisible();
    await expect(page.getByTestId('visit-card').first()).toContainText('Requested');
    // No horizontal scroll at phone width.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test('evaluation happy path with insurance, referral upload and co-parent', async ({ page }) => {
    await signIn(page);
    await page.getByRole('link', { name: 'Book a visit' }).click();
    await page.getByText('Evaluation', { exact: true }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await pickFirstTime(page);

    await page.getByLabel("Child's full name").fill('Leo Brooks');
    await page.getByLabel('Date of birth').fill('2019-04-02');
    await page.getByLabel('Reason for evaluation').fill('Difficulty with pencil grip and buttons.');
    await page.getByText('Handwriting', { exact: true }).click();
    await page.getByText('Insurance', { exact: true }).click();
    await page.getByLabel('Insurer name').fill('NAGICO');
    await page.getByLabel('Member or policy number').fill('M-123');
    await page.getByText('Yes', { exact: true }).click();
    await page.getByLabel('Upload referral letter').setInputFiles({
      name: 'referral.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n%test referral\n'),
    });
    await expect(page.getByText('Uploaded: referral.pdf')).toBeVisible();
    await page.getByLabel('Their name').fill('Marcus Brooks');
    await page.getByLabel('Relationship').fill('Father');
    await page.getByLabel('Their mobile number').fill('+1 721 555 0199');
    await page.getByText(/collecting and using my child/).click();
    await page.getByText(/receiving appointment messages/).click();
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.getByRole('button', { name: 'Request this time' }).click();
    await expect(page.getByRole('heading', { name: 'Request sent' })).toBeVisible();
    await expect(page.getByTestId('booking-ref')).toHaveText(/^WAV-/);
    await expect(page.getByText('Your therapist will reach out to you for confirmation.')).toBeVisible();
    await expect(page.getByText('Bank transfer to NCBA')).toHaveCount(0);
  });
});
