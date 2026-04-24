#!/bin/bash
set -e

# One-time prod migration: when secrets previously set as plain env vars on
# Cloud Run are flipped to `--update-secrets` in deploy.sh, the first redeploy
# fails with "Cannot update environment variable [X] to the given type because
# it has already been set with a different type".
#
# This script removes the conflicting env-var entries from the live Cloud Run
# service so the subsequent `./deploy.sh` can re-attach them as secret refs.
# Safe to re-run — `--remove-env-vars` on an absent var is a no-op.
#
# Usage: ./migrate-env-to-secret.sh
# Then: ./deploy.sh

PROJECT_ID="gameclaw-492005"
SERVICE_NAME="influencex"
REGION="us-central1"

# Keep this list in sync with SECRETS_CSV keys in deploy.sh.
TO_REMOVE="MAILBOX_ENCRYPTION_KEY,ADMIN_PASSWORD,GMAIL_OAUTH_CLIENT_SECRET,\
RESEND_API_KEY,RESEND_WEBHOOK_SECRET,SMTP_PASS,\
ANTHROPIC_API_KEY,OPENAI_API_KEY,GOOGLE_AI_API_KEY,VOLCENGINE_ARK_API_KEY,\
ELEVENLABS_API_KEY,HUNTER_API_KEY,APIFY_TOKEN,MODASH_API_KEY,SERPAPI_API_KEY,\
YOUTUBE_API_KEY,GOOGLE_OAUTH_CLIENT_SECRET,FEISHU_APP_SECRET,\
FEISHU_CONTENT_SHEET_TOKEN,FEISHU_REG_SHEET_TOKEN,TWITTER_CLIENT_SECRET,\
LINKEDIN_CLIENT_SECRET,META_APP_SECRET,YOUTUBE_CLIENT_SECRET,\
TIKTOK_CLIENT_SECRET,THREADS_APP_SECRET,PINTEREST_APP_SECRET,\
REDDIT_CLIENT_SECRET,TWITCH_CLIENT_SECRET,STRIPE_SECRET_KEY,\
STRIPE_WEBHOOK_SECRET,NOTIFY_SLACK_WEBHOOK_URL,NOTIFY_FEISHU_WEBHOOK_URL,\
NOTIFY_DISCORD_WEBHOOK_URL,NOTIFY_GENERIC_WEBHOOK_URL,DATABASE_URL"

echo "Removing plain-env entries for ${TO_REMOVE//,/ } from ${SERVICE_NAME}..."

gcloud run services update "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --remove-env-vars="${TO_REMOVE}"

echo ""
echo "✅ Env vars cleared. Now run ./deploy.sh to attach them as secrets."
