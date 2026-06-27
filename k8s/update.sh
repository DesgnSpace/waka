#!/bin/bash

# Waka Kubernetes Update Script
# Update deployment with new image

set -e

# Generate timestamp for unique image tag
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
IMAGE_TAG="registry.digitalocean.com/curatedletters/waka:${TIMESTAMP}"

echo "🔄 Updating Waka deployment..."

# Build and push new image
echo "📦 Building Docker image with tag: ${IMAGE_TAG}"
docker build --platform linux/amd64 -t ${IMAGE_TAG} .
docker tag ${IMAGE_TAG} registry.digitalocean.com/curatedletters/waka:latest

echo "🔄 Pushing to Digital Ocean Container Registry..."
docker push ${IMAGE_TAG}
docker push registry.digitalocean.com/curatedletters/waka:latest

# Update deployment
echo "🚀 Updating Kubernetes deployment..."
kubectl set image deployment/waka waka=${IMAGE_TAG} -n waka

echo "⏳ Waiting for rollout to complete..."
kubectl rollout status deployment/waka -n waka --timeout=300s

echo "🔍 Deployment status..."
kubectl get pods -n waka

echo "✅ Waka update completed!"