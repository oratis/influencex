/**
 * Smoke 3 — pipeline approve → status transition.
 *
 * Setup writes a review-stage pipeline job straight into the throwaway DB
 * (see helpers/db.js for why the HTTP route can't get there offline), then the
 * *UI* drives the approval: open the review modal, hit "Approve & Send".
 *
 * What the app actually does in this environment (observed, not assumed):
 *   POST /api/pipeline/jobs/:id/approve
 *     → pipeline_jobs.stage: 'review' → 'send', email_approved = 1
 *     → contacts.status: 'draft' → 'pending'
 *     → enqueues email.send on the in-process queue
 *   the email.send worker (server/email-jobs.js) finds no mail provider
 *   (RESEND_API_KEY / SMTP_* / Gmail OAuth all blank, no mailbox_accounts row)
 *   and takes its dev fallback: it skips the provider call and nothing else.
 *     → contacts.status: 'pending' → 'sent', sent_at set, send_attempts = 1
 *     → pipeline_jobs.stage: 'send' → 'monitor', email_sent_at set
 *     → an outbound email_replies row and a 'sent' email_event (labelled
 *       dryRun) are written; provider ids stay NULL because nothing was sent.
 *
 * This spec previously asserted the opposite and said it should be updated if
 * the dry-run branch ever learned to sync the pipeline row. It has: the early
 * return used to strand every approved job at 'send' on any provider-less
 * deployment — which is what CI is, and what a fresh self-host is.
 */

const { test, expect } = require('@playwright/test');

const { STORAGE_STATE } = require('../env');
const { authHeaders } = require('../helpers/session');
const { cleanupFixture, countRows, getContact, getPipelineJob, seedReviewStageJob } = require('../helpers/db');

test.use({ storageState: STORAGE_STATE });

let fixture;

test.beforeEach(async ({ page }) => {
  fixture = seedReviewStageJob();
  await page.addInitScript(() => {
    localStorage.setItem('influencex_onboarding_done_v1', '1');
    localStorage.setItem('influencex_lang', 'en');
  });
});

test.afterEach(async () => {
  // Leave the shared DB exactly as we found it so specs stay independent and
  // the file can be re-run without wiping the database.
  if (fixture) cleanupFixture(fixture);
  fixture = null;
});

test('approving a review-stage job moves it out of review and marks the contact sent', async ({ page }) => {
  await page.goto('/#/pipeline');
  await expect(page.getByRole('heading', { name: 'AI Agent Pipeline' })).toBeVisible();

  const row = page.locator('tbody tr', { hasText: fixture.displayName });
  await expect(row).toBeVisible();

  const statValue = (label) =>
    page.locator('.stat-card').filter({ hasText: label }).locator('.stat-value');

  // Baseline: exactly this job is awaiting review.
  await expect(statValue('Awaiting Review')).toHaveText('1');

  await row.getByRole('button', { name: 'Review Email' }).click();

  // Review modal is pre-filled from the pipeline row (the only email input on
  // this page belongs to the modal).
  const approveBtn = page.getByRole('button', { name: 'Approve & Send' });
  await expect(approveBtn).toBeEnabled();
  await expect(page.locator('input[type="email"]')).toHaveValue(fixture.emailTo);
  await approveBtn.click();

  // ---- UI reflects the transition ----
  // The row leaves the review bucket: its "Review Email" action disappears and
  // the counters flip. The page polls every 5s, so give the assertions room
  // instead of sleeping.
  await expect(row.getByRole('button', { name: 'Review Email' })).toHaveCount(0, { timeout: 20_000 });
  await expect(statValue('Awaiting Review')).toHaveText('0', { timeout: 20_000 });
  await expect(statValue('Sent / Monitoring')).toHaveText('1', { timeout: 20_000 });

  // The Email Tasks tab lists it under "Recently sent", with nothing pending.
  await page.getByRole('button', { name: /^Email Tasks/ }).click();
  const recentCard = page.locator('.card')
    .filter({ has: page.getByRole('heading', { name: /^Recently sent/ }) });
  const recentRow = recentCard.locator('tbody tr').filter({ hasText: fixture.displayName });
  await expect(recentRow).toBeVisible({ timeout: 20_000 });
  await expect(recentRow).toContainText('Sent');
  await expect(
    page.locator('.card').filter({ has: page.getByRole('heading', { name: /^Needs attention/ }) })
  ).toContainText('No failed or pending sends right now.');

  // ---- row-level truth ----
  await expect.poll(
    () => getContact(fixture.contactId)?.status,
    { message: 'contact should reach a terminal send status', timeout: 20_000 }
  ).toBe('sent');

  const contact = getContact(fixture.contactId);
  expect(contact.send_error).toBeFalsy();
  expect(contact.sent_at).toBeTruthy();
  expect(contact.send_attempts).toBe(1);
  // No provider ran, so there is no provider message id.
  expect(contact.provider_message_id).toBeNull();

  const job = getPipelineJob(fixture.pipelineJobId);
  expect(job.email_approved).toBe(1);
  expect(job.email_to).toBe(fixture.emailTo);
  expect(job.error).toBeNull();
  // The no-provider path runs the same bookkeeping as a real send, minus the
  // send: the job advances out of 'send', and the thread row and event exist
  // so the UI isn't blank. Provider ids stay NULL because nothing was sent.
  expect(job.stage).toBe('monitor');
  expect(job.email_sent_at).toBeTruthy();
  expect(job.smtp_message_id).toBeNull();
  expect(countRows('email_replies', 'contact_id = ?', [fixture.contactId])).toBe(1);
  expect(countRows('email_events', 'contact_id = ?', [fixture.contactId])).toBe(1);
});

test('approve is stage-gated: the action disappears and a second approve is rejected', async ({ page }) => {
  // Guards the selector the previous test depends on — "Review Email" is
  // stage-gated, so a job that has left review must not expose it.
  await page.goto('/#/pipeline');
  const row = page.locator('tbody tr', { hasText: fixture.displayName });
  await expect(row.getByRole('button', { name: 'Review Email' })).toBeVisible();

  const approveOnce = () => page.request.post(
    `/api/pipeline/jobs/${fixture.pipelineJobId}/approve`,
    { data: { email_to: fixture.emailTo }, headers: authHeaders(fixture.workspaceId) }
  );

  const first = await approveOnce();
  expect(first.ok(), await first.text()).toBeTruthy();
  expect((await first.json()).queued).toBe(true);

  await expect(row.getByRole('button', { name: 'Review Email' })).toHaveCount(0, { timeout: 20_000 });

  const second = await approveOnce();
  expect(second.status()).toBe(400);
  // Match the gate, not the stage the job happens to have moved on to — the
  // worker races this assertion ('send' while queued, 'monitor' once the
  // handler finishes), and which side wins is timing, not behavior.
  expect((await second.json()).error).toMatch(/^Job is in stage "(send|monitor)", not "review"$/);
});
