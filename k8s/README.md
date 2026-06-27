# Waka Kubernetes Deployment

Deploy Waka to Digital Ocean Kubernetes cluster with domain www.waka.com.

## Prerequisites

- Digital Ocean Kubernetes cluster
- kubectl configured for your cluster
- Docker logged in to Digital Ocean Container Registry
- cert-manager installed for SSL certificates
- nginx-ingress-controller installed
- Domain www.waka.com pointing to your cluster

## Quick Deployment

```bash
# Deploy everything
./k8s/deploy.sh
```

## Manual Deployment

```bash
# 1. Build and push Docker image
docker build -t registry.digitalocean.com/curatedletters/waka:latest .
docker push registry.digitalocean.com/curatedletters/waka:latest

# 2. Apply Kubernetes manifests
kubectl apply -f k8s/namespace.yaml

# Copy and customize the secret file
cp k8s/secret.template.yaml k8s/secret.yaml
# Edit secret.yaml with your actual values
kubectl apply -f k8s/secret.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml
kubectl apply -f k8s/hpa.yaml

# 3. Check deployment status
kubectl get pods -n waka
kubectl get ingress -n waka
```

## Configuration Files

- `namespace.yaml` - Creates waka namespace
- `secret.template.yaml` - Template for environment variables and secrets (copy to secret.yaml)
- `deployment.yaml` - Waka application deployment
- `service.yaml` - Internal service for pods
- `ingress.yaml` - HTTPS ingress for www.waka.com
- `hpa.yaml` - Horizontal pod autoscaler (2-10 replicas)

## Environment Variables

Update `secret.yaml` with your actual values:

- `NEXTAUTH_URL` - https://www.waka.com
- `NEXTAUTH_SECRET` - JWT secret key
- `DATABASE_URL` - PostgreSQL connection string
- `AWS_REGION` - AWS SES region
- `AWS_ACCESS_KEY_ID` - AWS access key
- `AWS_SECRET_ACCESS_KEY` - AWS secret key
- `DO_API_TOKEN` - Digital Ocean API token
- `ADMIN_EMAIL` - Admin user email
- `ADMIN_PASSWORD` - Admin user password

## Updating the Application

```bash
# Update with new image
./k8s/update.sh
```

## Monitoring

```bash
# Check pods
kubectl get pods -n waka

# Check logs
kubectl logs -f deployment/waka -n waka

# Check ingress
kubectl describe ingress waka-ingress -n waka

# Check HPA status
kubectl get hpa -n waka
```

## Scaling

The HPA automatically scales between 2-10 replicas based on CPU and memory usage.

Manual scaling:
```bash
kubectl scale deployment waka --replicas=5 -n waka
```

## SSL Certificate

The ingress automatically provisions SSL certificates via cert-manager for:
- www.waka.com  
- waka.com

## Troubleshooting

**Pods not starting:**
```bash
kubectl describe pod <pod-name> -n waka
kubectl logs <pod-name> -n waka
```

**SSL certificate issues:**
```bash
kubectl describe certificate waka-tls -n waka
kubectl describe clusterissuer letsencrypt-prod
```

**Ingress not working:**
```bash
kubectl describe ingress waka-ingress -n waka
```

## Clean Up

```bash
# Delete all resources
kubectl delete namespace waka
```