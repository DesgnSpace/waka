# Deployment

FreeResend is a long-running Bun HTTP server. The repository supports Docker Compose and Kubernetes. It does not support the old Vercel, Next.js, or Node.js deployment instructions that were previously in this file.

Read [SETUP.md](SETUP.md) for the environment variable table, SES permissions, SES sandbox, DNS, and webhook setup. This file only covers deployment.

## Docker Compose

`docker-compose.yml` starts a PostgreSQL 16 container and the FreeResend API. The API runs migrations before it accepts requests.

1. Create the environment file:

   ```bash
   cp .env.example .env
   ```

2. Set real values in `.env`, including `NEXTAUTH_SECRET`, both admin values, and the three AWS values.

3. Start the stack:

   ```bash
   docker compose up --build -d
   ```

4. Check the API:

   ```bash
   curl http://localhost:3000/api/health
   docker compose ps
   ```

For production:

- Publish port `3000` through an HTTPS reverse proxy or load balancer.
- Use a strong `NEXTAUTH_SECRET` and a strong PostgreSQL password.
- Use `NODE_ENV=production` so the dashboard cookie is marked `Secure`.
- Set `DATABASE_SSL=require` when the database endpoint requires verified TLS.
- Store `.env` outside source control. `.env` is ignored and is not copied into the image.
- Replace the local PostgreSQL service with a managed PostgreSQL service when you need backups and high availability; set `DATABASE_URL` to that service.
- Set `DOMAIN` or `CORS_ORIGIN` only when browser clients need cross-origin access.
- Configure the SES SNS webhook with the public HTTPS URL described in [SETUP.md](SETUP.md).

Stop the stack with `docker compose down`. Add `-v` only when you intend to delete the local PostgreSQL data volume.

## Kubernetes

The manifests in `k8s/` deploy the API behind a ClusterIP service and an NGINX Ingress. The checked-in `deployment.yaml` uses a placeholder image name. Change it to an image in your registry before applying it.

Required cluster components:

- A Kubernetes cluster and configured `kubectl`.
- A container registry where the image can be pushed.
- An Ingress controller that supports `ingressClassName: nginx`.
- A TLS provider such as cert-manager if you keep the TLS annotations.
- A metrics server if you apply `k8s/hpa.yaml`.
- PostgreSQL, either a managed endpoint or the optional in-cluster manifests in `k8s/postgres/`.

Build and push an image. Use a pinned tag instead of `latest` for production:

```bash
docker build -t registry.example.com/freeresend:2026-08-13 .
docker push registry.example.com/freeresend:2026-08-13
```

Edit `k8s/deployment.yaml` and set `spec.template.spec.containers[0].image` to that image. Edit `k8s/ingress.yaml` and replace `api.example.com` with a hostname you control. Create the application secret from the template without committing the completed file:

```bash
cp k8s/secret.template.yaml k8s/secret.yaml
```

Set real values in `k8s/secret.yaml`, including `DATABASE_URL`, `NEXTAUTH_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY`. Add optional variables from the table in [SETUP.md](SETUP.md) when needed. `k8s/secret.yaml` is ignored by Git.

Apply the app:

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/secret.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml
kubectl apply -f k8s/hpa.yaml
kubectl rollout status deployment/waka -n waka
kubectl get ingress -n waka
```

The Ingress must expose `POST /api/webhooks/ses` to the public internet over HTTPS. Point the SNS HTTP(S) subscription at that exact URL and make sure the Ingress does not rewrite or change the JSON request body.

### In-cluster PostgreSQL

`k8s/postgres/` contains a single-replica PostgreSQL 16 StatefulSet with one PVC. It is suitable for a small test cluster, not a high-availability production database. The included `02-secrets.yaml` is a template; replace every placeholder before applying it. Use a secret manager when possible.

If you use these manifests, first update `k8s/postgres/02-secrets.yaml`, then apply:

```bash
kubectl apply -f k8s/postgres/01-namespace.yaml
kubectl apply -f k8s/postgres/02-secrets.yaml
kubectl apply -f k8s/postgres/03-pvc.yaml
kubectl apply -f k8s/postgres/04-statefulset.yaml
kubectl apply -f k8s/postgres/05-service.yaml
kubectl wait --for=condition=ready pod/postgres-0 -n waka --timeout=300s
```

Set the app `DATABASE_URL` to the service host from `k8s/postgres/05-service.yaml`. The FreeResend application migration runs on app startup. The old PostgreSQL ConfigMap contains a separate schema and is not the migration source used by the app; keep the app migration as the source of truth for new deployments.

## Updates and operations

Use a new immutable image tag for each release, update `k8s/deployment.yaml`, then apply it and wait for the rollout:

```bash
kubectl apply -f k8s/deployment.yaml
kubectl rollout status deployment/waka -n waka
kubectl logs -f deployment/waka -n waka
```

Back up PostgreSQL before upgrades. Do not delete the PostgreSQL PVC during cleanup unless the data is no longer needed.
