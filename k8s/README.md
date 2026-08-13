# Kubernetes

The manifests in this directory run FreeResend in a Kubernetes namespace named `waka`. The app uses a ClusterIP service and an NGINX Ingress. Read [../SETUP.md](../SETUP.md) for the environment variable table and SES webhook setup. Read [../DEPLOYMENT.md](../DEPLOYMENT.md) for the deployment flow and production choices.

## Requirements

- A Kubernetes cluster and configured `kubectl`.
- A container registry and permission to push images.
- An NGINX Ingress controller.
- A TLS provider such as cert-manager, or a replacement for the TLS settings in `ingress.yaml`.
- A PostgreSQL database. Use a managed database or the small in-cluster option in `postgres/`.
- A metrics server if you apply `hpa.yaml`.

## Files

- `namespace.yaml`: creates the `waka` namespace.
- `secret.template.yaml`: application environment template. Copy it to the ignored `secret.yaml` and replace every placeholder, including `DOMAIN`.
- `deployment.yaml`: app Deployment. Replace its image before applying it.
- `service.yaml`: internal HTTP service on port 80.
- `ingress.yaml`: HTTPS ingress for one example hostname. Replace `api.example.com` and the certificate issuer with your values.
- `hpa.yaml`: optional autoscaling from 2 to 10 replicas.
- `deploy.sh`: builds, pushes, and applies the app when `IMAGE_REPOSITORY` and `IMAGE_TAG` are set.
- `update.sh`: builds and rolls out a new image when `IMAGE_REPOSITORY` and `IMAGE_TAG` are set.

## Manual deployment

1. Build and push an image with an immutable tag:

   ```bash
   docker build -t registry.example.com/freeresend:2026-08-13 .
   docker push registry.example.com/freeresend:2026-08-13
   ```

2. Set that image in `deployment.yaml`.

3. Create the application secret and replace every placeholder:

   ```bash
   cp k8s/secret.template.yaml k8s/secret.yaml
   ```

4. Apply the app resources:

   ```bash
   kubectl apply -f k8s/namespace.yaml
   kubectl apply -f k8s/secret.yaml
   kubectl apply -f k8s/deployment.yaml
   kubectl apply -f k8s/service.yaml
   kubectl apply -f k8s/ingress.yaml
   kubectl apply -f k8s/hpa.yaml
   kubectl rollout status deployment/waka -n waka
   ```

The app runs the migration from `migrations/` before it accepts traffic. It needs network access to the configured PostgreSQL endpoint.

## Helper scripts

For a registry that accepts the image from the current machine:

```bash
IMAGE_REPOSITORY=registry.example.com/freeresend IMAGE_TAG=2026-08-13 ./k8s/deploy.sh
```

For a later update:

```bash
IMAGE_REPOSITORY=registry.example.com/freeresend IMAGE_TAG=2026-08-14 ./k8s/update.sh
```

Log in to the registry before running either script. Create `k8s/secret.yaml` first. The scripts do not create or print secret values.

## Public webhook

The Ingress must route this exact endpoint over public HTTPS:

```text
https://api.example.com/api/webhooks/ses
```

Replace `api.example.com` with the real host in both `ingress.yaml` and the SNS subscription. The proxy must pass signed SNS `POST` bodies unchanged. Set `SES_SNS_TOPIC_ARN` in the application secret to pin the endpoint to one topic.

## Checks and logs

```bash
kubectl get pods -n waka
kubectl rollout status deployment/waka -n waka
kubectl logs -f deployment/waka -n waka
kubectl get ingress -n waka
kubectl get hpa -n waka
```

Do not delete the PostgreSQL PVC during cleanup unless its data is no longer needed.
