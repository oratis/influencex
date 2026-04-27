#!/bin/bash
#
# Bootstrap GCP Secret Manager for the InfluenceX Cloud Run deployment.
#
# What this does (idempotent — safe to re-run):
#   1. Enables the Secret Manager API on the project.
#   2. For every secret listed in SECRET_NAMES below, reads the current value
#      from the local .env file and writes it to GCP Secret Manager. Creates
#      the secret if it doesn't exist; otherwise adds a new version.
#   3. Grants the Cloud Run runtime service account
#      roles/secretmanager.secretAccessor on each secret.
#
# After this runs, `deploy.sh` mounts these via `gcloud run deploy
# --update-secrets` so they appear as env vars inside the Cloud Run container
# without the values ever being stored in plaintext in the service config.
#
# Usage:
#   ./setup-secrets.sh            # reads values from ./.env
#   ./setup-secrets.sh path/to/env  # reads values from a different env file
#
# Requires: gcloud CLI authenticated to an account with
#   roles/secretmanager.admin and roles/resourcemanager.projectIamAdmin
# on the project.
set -euo pipefail

PROJECT_ID="gameclaw-492005"
REGION="us-central1"
SERVICE_NAME="influencex"
ENV_FILE="${1:-.env}"

# Sensitive values that should live in Secret Manager. Plain config (ports,
# feature flags, non-sensitive IDs, model names) stays in --update-env-vars
# in deploy.sh — keep this list tight to avoid secret-per-toggle sprawl.
#
# Client IDs are intentionally NOT here: OAuth client IDs are transmitted to
# the browser and aren't secrets. Only the corresponding *_CLIENT_SECRET /
# *_API_KEY / *_WEBHOOK_SECRET values are.
SECRET_NAMES=(
  # Encryption + admin
  MAILBOX_ENCRYPTION_KEY
  ADMIN_PASSWORD
  # Email provider credentials
  GMAIL_OAUTH_CLIENT_SECRET
  RESEND_API_KEY
  RESEND_WEBHOOK_SECRET
  SMTP_PASS
  # LLM / AI providers
  ANTHROPIC_API_KEY
  OPENAI_API_KEY
  GOOGLE_AI_API_KEY
  VOLCENGINE_ARK_API_KEY
  ELEVENLABS_API_KEY
  # Data / research
  HUNTER_API_KEY
  APIFY_TOKEN
  MODASH_API_KEY
  SERPAPI_API_KEY
  YOUTUBE_API_KEY
  # Observability
  SENTRY_DSN
  # SSO
  GOOGLE_OAUTH_CLIENT_SECRET
  # Publishing OAuth secrets
  TWITTER_CLIENT_SECRET
  LINKEDIN_CLIENT_SECRET
  META_APP_SECRET
  YOUTUBE_CLIENT_SECRET
  TIKTOK_CLIENT_SECRET
  THREADS_APP_SECRET
  PINTEREST_APP_SECRET
  REDDIT_CLIENT_SECRET
  TWITCH_CLIENT_SECRET
  # Billing
  STRIPE_SECRET_KEY
  STRIPE_WEBHOOK_SECRET
  # Database — Cloud SQL socket connection is in env, password is in the URL
  DATABASE_URL
)

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ Env file not found: $ENV_FILE" >&2
  exit 1
fi

echo "🔐 Bootstrapping Secret Manager for ${PROJECT_ID}"
echo "   Env source: ${ENV_FILE}"
echo ""

gcloud config set project "${PROJECT_ID}" >/dev/null

# 1. Enable the API (idempotent — gcloud no-ops if already enabled).
echo "📡 Ensuring Secret Manager API is enabled..."
gcloud services enable secretmanager.googleapis.com --quiet

# 2. Resolve the Cloud Run runtime service account. Cloud Run uses the
#    compute-engine default SA unless --service-account is passed at deploy
#    time; deploy.sh doesn't override, so we bind IAM on the default SA.
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
RUN_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
echo "🎭 Cloud Run runtime SA: ${RUN_SA}"
echo ""

# Reads a key's value from ENV_FILE. Returns empty if the line is missing or
# is commented out. Stays pure-bash to avoid sourcing untrusted env files.
get_env_value() {
  local key="$1"
  # Strip surrounding quotes on the value, tolerate spaces around =
  awk -F= -v k="$key" '
    /^[[:space:]]*#/ { next }
    $1 ~ "^[[:space:]]*"k"[[:space:]]*$" {
      sub("^[[:space:]]*"k"[[:space:]]*=[[:space:]]*", "", $0)
      sub("[[:space:]]+$", "", $0)
      gsub(/^["'"'"']|["'"'"']$/, "", $0)
      print
      exit
    }
  ' "$ENV_FILE"
}

created=0
updated=0
skipped_empty=0

for name in "${SECRET_NAMES[@]}"; do
  value="$(get_env_value "$name")"
  if [[ -z "$value" ]]; then
    echo "  ⏭  ${name}: empty in ${ENV_FILE}, skipping"
    skipped_empty=$((skipped_empty + 1))
    continue
  fi

  if gcloud secrets describe "$name" --quiet >/dev/null 2>&1; then
    # Secret exists — add a new version. Previous versions stay available for
    # rollback; Cloud Run pins ":latest" by default so the new version takes
    # effect on the next deploy.
    printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- --quiet
    echo "  ♻  ${name}: added new version"
    updated=$((updated + 1))
  else
    printf '%s' "$value" | gcloud secrets create "$name" \
      --replication-policy="automatic" \
      --data-file=- \
      --quiet
    echo "  ✨ ${name}: created"
    created=$((created + 1))
  fi

  # Grant the runtime SA accessor rights on this specific secret (narrower
  # than a project-wide grant). add-iam-policy-binding is idempotent — it
  # won't duplicate an existing binding.
  gcloud secrets add-iam-policy-binding "$name" \
    --member="serviceAccount:${RUN_SA}" \
    --role="roles/secretmanager.secretAccessor" \
    --quiet >/dev/null
done

echo ""
echo "✅ Done. Created: ${created}, Updated: ${updated}, Skipped (empty): ${skipped_empty}"
echo ""
echo "Next step: run ./deploy.sh — it will mount these secrets into Cloud Run"
echo "via --update-secrets (secret values never appear in the Cloud Run"
echo "service config or in \`gcloud run services describe\` output)."
