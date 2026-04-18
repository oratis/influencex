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
  --update-env-vars "BASE_PATH=/InfluenceX,NODE_ENV=production,CLOUD_SQL_CONNECTION=${CLOUD_SQL_INSTANCE}"

echo ""
echo "✅ Deployment complete!"
echo "Service URL:"
gcloud run services describe ${SERVICE_NAME} --region ${REGION} --format 'value(status.url)'
echo ""
echo "📌 Note: Configure your load balancer to route gogameclaw.com/InfluenceX/* to this Cloud Run service"
