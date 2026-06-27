#!/bin/bash

# Waka PostgreSQL K8s Deployment Script

set -e

echo "🚀 Waka PostgreSQL Kubernetes Deployment"
echo "=============================================="
echo ""

# Check if kubectl is available
if ! command -v kubectl &> /dev/null; then
    echo "❌ kubectl not found. Please install kubectl first."
    exit 1
fi

# Check if connected to cluster
if ! kubectl cluster-info &> /dev/null; then
    echo "❌ Not connected to a Kubernetes cluster."
    echo "Please configure kubectl to connect to your cluster."
    exit 1
fi

echo "✅ Connected to Kubernetes cluster"
kubectl cluster-info | head -n 1
echo ""

# Warning about secrets
echo "⚠️  IMPORTANT: Have you updated the secrets in 02-secrets.yaml?"
echo "   - PostgreSQL password"
echo "   - DATABASE_URL with the same password"
echo "   - AWS credentials"
echo ""
read -p "Continue with deployment? (yes/no): " confirm

if [ "$confirm" != "yes" ]; then
    echo "Deployment cancelled. Please update secrets and try again."
    exit 0
fi

echo ""
echo "📦 Deploying PostgreSQL to Kubernetes..."
echo ""

# Deploy in order
echo "1️⃣  Creating namespace..."
kubectl apply -f 01-namespace.yaml

echo "2️⃣  Creating secrets..."
kubectl apply -f 02-secrets.yaml

echo "3️⃣  Creating PersistentVolumeClaim..."
kubectl apply -f 03-pvc.yaml

echo "4️⃣  Creating ConfigMap with database schema..."
kubectl apply -f 06-configmap.yaml

echo "5️⃣  Deploying PostgreSQL StatefulSet..."
kubectl apply -f 04-statefulset.yaml

echo "6️⃣  Creating PostgreSQL Service..."
kubectl apply -f 05-service.yaml

echo ""
echo "⏳ Waiting for PostgreSQL to be ready..."
kubectl wait --for=condition=ready pod/postgres-0 -n waka --timeout=300s

echo ""
echo "✅ PostgreSQL deployed successfully!"
echo ""

# Show status
echo "📊 Current Status:"
kubectl get all -n waka -l app=postgres

echo ""
echo "💾 Storage:"
kubectl get pvc -n waka postgres-pvc

echo ""
echo "🔍 PostgreSQL Pod Logs (last 10 lines):"
kubectl logs -n waka postgres-0 --tail=10

echo ""
echo "✨ Next Steps:"
echo ""
echo "1. Update application secret (if not already done):"
echo "   kubectl apply -f ../secret.yaml"
echo ""
echo "2. Restart Waka app to use new database:"
echo "   kubectl rollout restart deployment/waka -n waka"
echo ""
echo "3. Verify database connection:"
echo "   kubectl logs -n waka deployment/waka | grep -i database"
echo ""
echo "4. Access database directly (optional):"
echo "   kubectl exec -it -n waka postgres-0 -- psql -U waka -d waka"
echo ""
echo "📚 For more information, see k8s/postgres/README.md"
