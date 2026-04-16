#!/bin/bash
set -e

# This script sets up URL routing so gogameclaw.com/InfluenceX/* routes to the influencex Cloud Run service
# Run this AFTER deploy.sh has successfully deployed the service

PROJECT_ID="gameclaw-492005"
SERVICE_NAME="influencex"
REGION="us-central1"
NEG_NAME="influencex-neg"
BACKEND_NAME="influencex-backend"

echo "🔧 Setting up URL routing for gogameclaw.com/InfluenceX/..."

# Step 1: Create a serverless NEG for the Cloud Run service
echo "Creating serverless NEG..."
gcloud compute network-endpoint-groups create ${NEG_NAME} \
  --region=${REGION} \
  --network-endpoint-type=serverless \
  --cloud-run-service=${SERVICE_NAME} \
  --project=${PROJECT_ID} 2>/dev/null || echo "NEG already exists"

# Step 2: Create a backend service
echo "Creating backend service..."
gcloud compute backend-services create ${BACKEND_NAME} \
  --global \
  --project=${PROJECT_ID} 2>/dev/null || echo "Backend service already exists"

# Step 3: Add the NEG to the backend service
echo "Adding NEG to backend service..."
gcloud compute backend-services add-backend ${BACKEND_NAME} \
  --global \
  --network-endpoint-group=${NEG_NAME} \
  --network-endpoint-group-region=${REGION} \
  --project=${PROJECT_ID} 2>/dev/null || echo "Backend already added"

echo ""
echo "✅ Backend service created!"
echo ""
echo "📌 MANUAL STEP REQUIRED:"
echo "You need to add a path rule to your existing URL map for gogameclaw.com:"
echo ""
echo "  Path: /InfluenceX, /InfluenceX/*"
echo "  Backend: ${BACKEND_NAME}"
echo ""
echo "Run this command to update your URL map (replace YOUR_URL_MAP_NAME):"
echo ""
echo "  gcloud compute url-maps add-path-matcher YOUR_URL_MAP_NAME \\"
echo "    --path-matcher-name=influencex-matcher \\"
echo "    --default-service=YOUR_DEFAULT_BACKEND \\"
echo "    --path-rules='/InfluenceX=influencex-backend,/InfluenceX/*=influencex-backend' \\"
echo "    --global"
echo ""
echo "Or edit the URL map in the Google Cloud Console:"
echo "https://console.cloud.google.com/net-services/loadbalancing/list?project=${PROJECT_ID}"
