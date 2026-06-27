#!/bin/bash

# Waka Kubernetes Deployment Script
# Deploy to Digital Ocean Kubernetes

set -e

echo "🚀 Deploying Waka to Kubernetes..."

# Build and push Docker image
echo "📦 Building Docker image..."
docker build --platform linux/amd64 -t registry.digitalocean.com/curatedletters/waka:latest .

echo "🔄 Pushing to Digital Ocean Container Registry..."
docker push registry.digitalocean.com/curatedletters/waka:latest

# Apply Kubernetes manifests
echo "🔧 Applying Kubernetes manifests..."

# Create namespace first
kubectl apply -f k8s/namespace.yaml

# Apply secrets (create from template first if needed)
if [ ! -f "k8s/secret.yaml" ]; then
  echo "⚠️  secret.yaml not found. Copy secret.template.yaml to secret.yaml and update with your values."
  echo "   cp k8s/secret.template.yaml k8s/secret.yaml"
  exit 1
fi
kubectl apply -f k8s/secret.yaml

# Apply application resources
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml
kubectl apply -f k8s/hpa.yaml

echo "⏳ Waiting for deployment to be ready..."
kubectl rollout status deployment/waka -n waka --timeout=300s

echo "🔍 Getting deployment status..."
kubectl get pods -n waka
kubectl get services -n waka
kubectl get ingress -n waka

echo "✅ Waka deployment completed!"
echo "🌐 Application will be available at: https://www.waka.com"
echo ""
echo "📋 Useful commands:"
echo "  kubectl get pods -n waka"
echo "  kubectl logs -f deployment/waka -n waka"
echo "  kubectl describe ingress waka-ingress -n waka"