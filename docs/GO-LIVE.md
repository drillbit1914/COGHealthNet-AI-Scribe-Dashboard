# Wellness Ave Scheduling: go-live guide

This guide is for Dr. Kniquiah Hughes and whoever helps with setup. Follow the parts in order.

**Two tracks run side by side:**
- **Tonight (about 1 hour).** Parts A–C put the app online and let you run a full practice pilot. Sign-in codes are read from a log screen for now.
- **This week and next.** Parts D–E connect real SMS and WhatsApp. Meta's WhatsApp verification takes 1–3 weeks, so start Part E today as well.

**Keep a private note as you go.** Each step produces a value you'll paste into Vercel in Part B (marked **→ save as `NAME`**). Keep them in a password manager or a private note, and never send them by WhatsApp or email.

---

## Part A: Supabase (database and private file storage), about 15 minutes

1. **Create an account.** Go to <https://supabase.com/dashboard/sign-up> and sign up. Using "Continue with GitHub" is easiest.
2. **Create the project.** Click **New project** and fill in:
   - Name: `wellness-ave`
   - Database password: click **Generate a password** and copy it. **→ save as the database password**
   - Region: **East US (North Virginia)**, the closest to Anguilla.
   - Plan: Free is fine for the pilot. Before real families use it, upgrade to **Pro** for daily backups and so the project never pauses (the free plan pauses after a week without use).
3. **Copy the database address.** Once the project is ready, click **Connect** at the top. Tap the **Direct / Connection string** tile, and choose **Session pooler** as the method. Copy the connection string (it starts with `postgresql://postgres.` and ends with `:5432/postgres`). Replace `[YOUR-PASSWORD]` with the database password. Don't add anything else to the end.
   **→ save as `DATABASE_URL`, and the same value as `DIRECT_URL`**
   - Forgot the password? Go to **Project Settings → Database → Reset database password**.
4. **Create the private file bucket.** In the left menu, open **Storage → New bucket**. Name it `wellness-ave-private` and leave **Public bucket OFF**. Referral letters and payment screenshots are stored here.
5. **Copy the storage keys.** Go to **Project Settings → Data API**. Copy the **Project URL**.
   **→ save as `SUPABASE_URL`**
6. **Copy the service key.** Go to **Project Settings → API Keys → Legacy API keys** and copy the `service_role` key. It's secret: never share it or put it in a web page.
   **→ save as `SUPABASE_SERVICE_ROLE_KEY`**

## Part B: Vercel (puts the app online), about 20 minutes

1. **Create an account.** Go to <https://vercel.com/signup> and choose **Continue with GitHub**, using the GitHub account that owns the repository.
2. **Hobby (free) is fine.** Vercel runs the app's housekeeping job once a day on Hobby. For the every-5-minutes timing that reminders and request expiry need, use Supabase's free scheduler (step 8 below).
3. **Start the import.** Go to <https://vercel.com/new> and **Import** `drillbit1914/COGHealthNet-AI-Scribe-Dashboard`. Leave the framework (Next.js) and the build settings as detected.
4. **Add the variables.** Before clicking Deploy, open **Environment Variables** and add these:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | from A3 |
   | `DIRECT_URL` | from A3 (same value) |
   | `SUPABASE_URL` | from A5 |
   | `SUPABASE_SERVICE_ROLE_KEY` | from A6 |
   | `STORAGE_BUCKET` | `wellness-ave-private` |
   | `SESSION_SECRET` | a random 40+ character string (make one at <https://1password.com/password-generator>: Random, 40 characters) |
   | `CRON_SECRET` | another, different random 40-character string |
   | `ADMIN_EMAIL` | `kniquiah.hughes@gmail.com` |
   | `ADMIN_INITIAL_PASSWORD` | the password Dr. Hughes will sign in with (12+ characters, not reused anywhere) |
   | `APP_BASE_URL` | leave it for now; set it in step 6 |

5. **Deploy.** Click **Deploy**. The build creates the database tables, the settings and Dr. Hughes's admin login, which takes 2–4 minutes. When it finishes, Vercel shows a web address like `https://coghealthnet-ai-scribe-dashboard.vercel.app`.
6. **Set the web address.** Go to **Project → Settings → Environment Variables** and add `APP_BASE_URL` = that web address (no slash at the end). Then open **Deployments**, find the latest one, click **⋯ → Redeploy**.
7. **If Vercel pre-filled settings** ("Environment Variables · 23 Detected"), delete any that aren't in the table above or are empty. Fix the rest to the values in the table.
8. **Every-5-minutes timing (free, in Supabase).** In Supabase, open **SQL Editor → New query**. Paste this, replacing the two capitalised parts with your web address and your `CRON_SECRET`, then click **Run**:

   ```sql
   create extension if not exists pg_cron;
   create extension if not exists pg_net;
   select cron.schedule('wellness-ave-every-5-min', '*/5 * * * *', $$
     select net.http_get(
       url := 'https://YOUR-ADDRESS.vercel.app/api/cron/all',
       headers := jsonb_build_object('Authorization', 'Bearer YOUR-CRON-SECRET'),
       timeout_milliseconds := 60000);
   $$);
   ```
   To check it's working: **Database → Cron jobs** shows it running every 5 minutes.
9. **Security clean-up.** After Dr. Hughes has signed in once (Part C step 1), delete `ADMIN_INITIAL_PASSWORD` from Vercel. It's only used to create the first login.

Later, use your own address, e.g. `book.wellnessave.com`: **Project → Settings → Domains**. Then update `APP_BASE_URL` and redeploy.

## Part C: tonight's practice pilot, about 30–45 minutes

Use two screens: a laptop for the **admin** side and a phone for the **parent** side.

**Before SMS is connected, sign-in codes are shown in the log.** In Vercel, open **Project → Logs**, filter by `code`, and look for a line like `Your Wellness Ave code is 482913`. Once Twilio is connected (Part D), codes arrive by text instead.

1. **Admin first sign-in (laptop).**
   - Open `<APP_BASE_URL>/admin/login`. Enter the email and initial password and leave the code empty.
   - A QR code appears. Scan it with **Google Authenticator** or **Microsoft Authenticator**, then type the 6-digit code.
   - You land in the **Approval queue**.
   - ✅ Check: the page title reads "Admin | Wellness Ave".
2. **Check the settings.** Open **Settings** and confirm:
   - The clinic phone, NCBA account "Wellness Ave." 6001232, and alert phone +17869420603.
   - Opening hours: Friday 08:00–17:00 and Saturday 08:00–18:00.
   - Providers: Dr. Kniquiah Hughes, OT.
3. **Parent books a follow-up (phone).**
   - Open `<APP_BASE_URL>/book` and sign in with a phone number. Take the code from the log.
   - Book a **Follow-up** for "Test Child One" on the next Friday.
   - ✅ Check: you get a booking reference (WAV-XXXX), the NCBA payment details and the "never send new bank details" line, and "Add to calendar" works.
4. **Admin confirms (laptop).**
   - The request appears in the queue with a countdown. Click **Confirm visit**.
   - Open **Calendar** on that Friday. The visit shows as a solid block.
   - ✅ On the phone, **My visits** now shows "Confirmed, with Dr. Kniquiah Hughes".
5. **Parent books an evaluation (phone).**
   - Book an **Evaluation**: choose Insurance, then Referral: Yes, and upload any PDF or photo.
   - Add the "other parent" with a second phone number.
   - ✅ Check (admin): the queue shows the reason, the insurer and a **Referral letter** link that opens the file. This proves private storage works.
6. **Propose another time (admin).**
   - On the evaluation, click **Propose alternate** and pick another time.
   - ✅ Check (phone): My visits shows "New time offered". Tap **Accept new time**, and it becomes Confirmed.
7. **Change and cancel (phone).**
   - Use **Change time** on the follow-up. It goes back to the queue.
   - Then **Cancel** another visit. If it's within 24 hours, you see a late-cancel warning.
8. **Payments (admin).**
   - Under **Payments**, mark one visit **Cash**, and another **Bank transfer** with reference `TEST123`.
   - ✅ Check: the daily totals update.
9. **Closure preview (admin).** Under **Closures**, pick a Saturday, type "Test", and click **Preview**. **Don't** click "Close clinic" unless you want to cancel the test visits. That's a fine end-of-test clean-up.
10. **Look at the logs (admin).** Open **Messages & audit**. Every message the system would have sent is listed, and every action is in the Audit log.
11. **Clean up.** Cancel the test visits, or close the clinic for the test dates, before real families book.

Write down anything confusing or wrong, and send the list back for fixes.

## Part D: Twilio SMS (real texts, including sign-in codes), about 30 minutes

1. **Create an account.** Sign up at <https://www.twilio.com/try-twilio> and open the console at <https://console.twilio.com>.
2. **Buy a number.** Go to **Phone Numbers → Manage → Buy a number**, choose United States, tick SMS, and buy one. **→ save as `TWILIO_FROM_NUMBER`** (format `+1XXXXXXXXXX`)
3. **Turn on Anguilla texting.** Go to **Messaging → Settings → Geo permissions** and tick **Anguilla** (and any country parents live in). International texting is off by default.
4. **Register for US texting (A2P 10DLC).** Go to **Messaging → Regulatory compliance → A2P 10DLC** and register a Brand and a Campaign. Use "Sole proprietor" if there's no company registration. This is required to text US numbers, including the +1 786 alert phone and parents living in the US, and approval takes days.
5. **Copy the account keys.** On the console home, copy the **Account SID** and **Auth Token**. **→ save as `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`**
6. **Set the webhook.** Go to **Phone Numbers → Manage → Active numbers →** your number **→ Messaging configuration**. Under **A message comes in**, set Webhook to `<APP_BASE_URL>/api/webhooks/sms`, method HTTP POST, and save.
7. **Add the keys and redeploy.** Add the three `TWILIO_*` variables in Vercel and redeploy.
   - ✅ Check: sign in on `/book` and the code arrives by SMS.
   - ✅ Send one test booking to a **Digicel** phone and one to a **Flow** phone in Anguilla.
8. **If you're still on a trial account:** Twilio only texts numbers you've verified under **Phone Numbers → Verified Caller IDs**, and adds "Sent from your Twilio trial account". Upgrade (add a card) before the pilot opens to families.

Until WhatsApp is connected, **every message goes by SMS**. That's automatic.

## Part E: Meta WhatsApp Business (start today; approval takes 1–3 weeks)

The sending number will be **+1 786 942 0603**.

> ⚠️ **Before you begin:** a number can't be in the regular WhatsApp app and the WhatsApp Cloud API at the same time. If +1 786 942 0603 is on WhatsApp or WhatsApp Business on a phone, back up its chats first. During setup Meta will either:
> - offer to connect it while keeping the WhatsApp Business app (called "coexistence", only for WhatsApp **Business** app numbers where available), or
> - ask you to delete the account from the app first (in the app: **Settings → Account → Delete account**).
>
> Also: staff alerts are set to go to the same number, and WhatsApp can't message itself, so alerts will arrive by SMS. To get alerts on WhatsApp, change **Settings → Admin alert phones** to Dr. Hughes's personal mobile.

1. **Create a business portfolio.** Go to <https://business.facebook.com> and click **Create account** (portfolio) with the name **Wellness Ave**, plus the business email and address.
2. **Verify the business.** Go to <https://business.facebook.com/settings/security> (**Security Centre**) and click **Start verification**. Have ready:
   - the legal business name and address, exactly as on official documents;
   - a business document (trade licence, registration, or a utility bill in the business name);
   - a business website or email domain if you have one.

   This is the 1–3 week step.
3. **Create a developer app.** At <https://developers.facebook.com/apps>, click **Create app**, choose **Business**, name it `Wellness Ave Scheduling` and pick the portfolio. Then add the **WhatsApp** product.
4. **Add the phone number.**
   - Go to **WhatsApp → API Setup → Add phone number**.
   - Enter the display name **Wellness Ave**, category **Medical and health**, and +1 786 942 0603, and verify it by SMS or voice call.
   - Copy the **Phone number ID**. **→ save as `WA_PHONE_NUMBER_ID`**
5. **Create a permanent token.**
   - Go to <https://business.facebook.com/settings/system-users>, click **Add**, name it `wellness-ave-server`, and choose role **Admin**.
   - Click **Assign assets**: give full control of the app and the WhatsApp account.
   - Click **Generate token** for the app with expiry **Never** and the permissions `whatsapp_business_messaging` and `whatsapp_business_management`.
   **→ save as `WA_ACCESS_TOKEN`**
6. **Copy the app secret.** In the app, go to **App settings → Basic** and click **Show** next to App secret. **→ save as `WA_APP_SECRET`**
7. **Set the webhook.**
   - Make up a verify token (any random 30-character string). **→ save as `WA_VERIFY_TOKEN`**
   - Add `WA_VERIFY_TOKEN`, `WA_APP_SECRET`, `WA_PHONE_NUMBER_ID`, `WA_ACCESS_TOKEN` and `WA_GRAPH_VERSION` = `v21.0` to Vercel, then redeploy.
   - In the app, go to **WhatsApp → Configuration → Webhook → Edit**. Set the Callback URL to `<APP_BASE_URL>/api/webhooks/whatsapp` and the Verify token to the same string. Click **Verify and save**, then subscribe to **messages**.
8. **Submit the templates.** In <https://business.facebook.com/wa/manage/message-templates/>, create the 14 templates exactly as listed in [`docs/WHATSAPP_TEMPLATES.md`](WHATSAPP_TEMPLATES.md): same names, categories, variable order and buttons. Approval usually takes minutes to 1 day per template.
9. **Add a payment method.** In WhatsApp Manager, go to **Payment settings** and add a card. Meta charges per template message.
10. **Go live.** Switch the app from Development to **Live** (top of the developer dashboard; this needs a privacy policy URL).
    - ✅ Check: book as a parent. The confirmation arrives on WhatsApp with **View / Reschedule** buttons.

## Part F: before real families (checklist)

- [ ] Anguilla counsel has approved the two consent sentences and the privacy notice. The notice should say data is hosted in the US (Supabase/Vercel).
- [ ] The printed notice at the clinic shows "Wellness Ave." NCBA 6001232 and "We never change bank details by message."
- [ ] Supabase is on the Pro plan, for backups and so it never pauses.
- [ ] Twilio is upgraded from trial, Geo permissions include Anguilla, and A2P registration is approved.
- [ ] Test data is cleaned up and `ADMIN_INITIAL_PASSWORD` is removed from Vercel.
- [ ] Your own domain is set, and `APP_BASE_URL` is updated and redeployed.

**If something goes wrong:** Vercel **Project → Logs** shows errors, and the admin **Messages & audit** page shows every message's delivery status and failure reason.
