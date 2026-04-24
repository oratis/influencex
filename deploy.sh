#!/bin/bash
set -e

PROJECT_ID="gameclaw-492005"
SERVICE_NAME="influencex"
REGION="us-central1"
IMAGE="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"
CLOUD_SQL_INSTANCE="${PROJECT_ID}:${REGION}:influencex-db"

echo "🎯 Deploying InfluenceX to Google Cloud Run..."
echo "Project: ${PROJECT_ID}"
echo "Service: ${SERVICE_NAME}"
echo "Region: ${REGION}"
echo ""

# Set project
gcloud config set project ${PROJECT_ID}

# Build and push container image
echo "📦 Building container image..."
gcloud builds submit --tag ${IMAGE} --timeout=600

# Sensitive values are sourced from GCP Secret Manager (see setup-secrets.sh).
# Each entry has the form "ENV_VAR_NAME=secret-resource-name:latest". Cloud
# Run mounts the named secret's latest version as the env var at container
# start. The runtime SA needs roles/secretmanager.secretAccessor on each —
# setup-secrets.sh handles the binding.
#
# Keep this list in sync with SECRET_NAMES in setup-secrets.sh. New secret?
# Add it to both. Non-sensitive config belongs in --update-env-vars below.
SECRETS_CSV="\
MAILBOX_ENCRYPTION_KEY=MAILBOX_ENCRYPTION_KEY:latest,\
ADMIN_PASSWORD=ADMIN_PASSWORD:latest,\
GMAIL_OAUTH_CLIENT_SECRET=GMAIL_OAUTH_CLIENT_SECRET:latest,\
RESEND_API_KEY=RESEND_API_KEY:latest,\
RESEND_WEBHOOK_SECRET=RESEND_WEBHOOK_SECRET:latest,\
SMTP_PASS=SMTP_PASS:latest,\
ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest,\
OPENAI_API_KEY=OPENAI_API_KEY:latest,\
GOOGLE_AI_API_KEY=GOOGLE_AI_API_KEY:latest,\
VOLCENGINE_ARK_API_KEY=VOLCENGINE_ARK_API_KEY:latest,\
ELEVENLABS_API_KEY=ELEVENLABS_API_KEY:latest,\
HUNTER_API_KEY=HUNTER_API_KEY:latest,\
APIFY_TOKEN=APIFY_TOKEN:latest,\
MODASH_API_KEY=MODASH_API_KEY:latest,\
SERPAPI_API_KEY=SERPAPI_API_KEY:latest,\
YOUTUBE_API_KEY=YOUTUBE_API_KEY:latest,\
GOOGLE_OAUTH_CLIENT_SECRET=GOOGLE_OAUTH_CLIENT_SECRET:latest,\
FEISHU_APP_SECRET=FEISHU_APP_SECRET:latest,\
FEISHU_CONTENT_SHEET_TOKEN=FEISHU_CONTENT_SHEET_TOKEN:latest,\
FEISHU_REG_SHEET_TOKEN=FEISHU_REG_SHEET_TOKEN:latest,\
TWITTER_CLIENT_SECRET=TWITTER_CLIENT_SECRET:latest,\
LINKEDIN_CLIENT_SECRET=LINKEDIN_CLIENT_SECRET:latest,\
META_APP_SECRET=META_APP_SECRET:latest,\
YOUTUBE_CLIENT_SECRET=YOUTUBE_CLIENT_SECRET:latest,\
TIKTOK_CLIENT_SECRET=TIKTOK_CLIENT_SECRET:latest,\
THREADS_APP_SECRET=THREADS_APP_SECRET:latest,\
PINTEREST_APP_SECRET=PINTEREST_APP_SECRET:latest,\
REDDIT_CLIENT_SECRET=REDDIT_CLIENT_SECRET:latest,\
TWITCH_CLIENT_SECRET=TWITCH_CLIENT_SECRET:latest,\
STRIPE_SECRET_KEY=STRIPE_SECRET_KEY:latest,\
STRIPE_WEBHOOK_SECRET=STRIPE_WEBHOOK_SECRET:latest,\
NOTIFY_SLACK_WEBHOOK_URL=NOTIFY_SLACK_WEBHOOK_URL:latest,\
NOTIFY_FEISHU_WEBHOOK_URL=NOTIFY_FEISHU_WEBHOOK_URL:latest,\
NOTIFY_DISCORD_WEBHOOK_URL=NOTIFY_DISCORD_WEBHOOK_URL:latest,\
NOTIFY_GENERIC_WEBHOOK_URL=NOTIFY_GENERIC_WEBHOOK_URL:latest,\
DATABASE_URL=DATABASE_URL:latest\
"

# Non-sensitive env vars. OAuth client IDs, CORS, LLM routing, mail sender
# identity, public sheet IDs — none of these are secrets (they're visible to
# the browser on login / in email headers) so they stay as plain env vars
# rather than Secret Manager refs.
#
# CORS_ORIGINS contains commas; --update-env-vars' default delimiter IS
# comma, which would split the value mid-URL. Prefix with `^##^` to switch
# the inter-var separator to `##` so embedded commas survive.
ENV_VARS="^##^\
BASE_PATH=##\
NODE_ENV=production##\
CLOUD_SQL_CONNECTION=${CLOUD_SQL_INSTANCE}##\
OAUTH_CALLBACK_BASE=https://influencexes.com##\
CORS_ORIGINS=https://influencexes.com,https://www.influencexes.com,https://gogameclaw.com##\
RESEND_FROM_EMAIL=contact@market.hakko.ai##\
RESEND_REPLY_TO=market@hakko.ai##\
FEISHU_APP_ID=cli_a94eb8811578dcd4##\
GA4_PROPERTY_ID=291429613##\
LLM_DEFAULT_PROVIDER=anthropic##\
STRATEGY_LLM_PROVIDER=google##\
RESEARCH_LLM_PROVIDER=google##\
SEO_LLM_PROVIDER=google##\
COMPETITOR_LLM_PROVIDER=google##\
REVIEW_LLM_PROVIDER=google##\
TWITTER_CLIENT_ID=Yy04RnJKVDlpRF81RDNNa0poNno6MTpjaQ##\
TWITCH_CLIENT_ID=ftj4lauvvjr4dkywfyeri0200pp0xq"

# Deploy to Cloud Run
echo "🚀 Deploying to Cloud Run..."
gcloud run deploy ${SERVICE_NAME} \
  --image ${IMAGE} \
  --platform managed \
  --region ${REGION} \
  --allow-unauthenticated \
  --port 8080 \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 3 \
  --add-cloudsql-instances ${CLOUD_SQL_INSTANCE} \
  --update-env-vars "${ENV_VARS}" \
  --update-secrets "${SECRETS_CSV}"

echo ""
echo "✅ Deployment complete!"
echo "Service URL:"
gcloud run services describe ${SERVICE_NAME} --region ${REGION} --format 'value(status.url)'
echo ""
echo "📌 Note: Configure your load balancer to route gogameclaw.com/InfluenceX/* to this Cloud Run service"
