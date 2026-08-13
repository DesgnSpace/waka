# PostgreSQL in Kubernetes

This optional setup runs one PostgreSQL 16 pod with one persistent volume in the `waka` namespace. It is useful for a small test cluster. It is not a high-availability production database. A managed PostgreSQL service is safer for production backups and failover.

The PVC uses the DigitalOcean `do-block-storage` storage class from `03-pvc.yaml`. Change `storageClassName` for another Kubernetes provider.

## Files

- `01-namespace.yaml`: the `waka` namespace.
- `02-secrets.yaml`: PostgreSQL username, password, and connection string template.
- `03-pvc.yaml`: 10 GiB persistent volume claim.
- `04-statefulset.yaml`: one PostgreSQL 16 pod.
- `05-service.yaml`: internal service named `postgres-service`.

The app migration in `migrations/001_baseline.sql` is the database schema source of truth. PostgreSQL does not load an application schema ConfigMap in this setup. FreeResend applies the migration when the app starts.

## Deploy

1. Replace `POSTGRES_PASSWORD` and the password in `DATABASE_URL` in `02-secrets.yaml`. URL-encode reserved characters in the connection string password.
2. Apply the database resources:

   ```bash
   kubectl apply -f k8s/postgres/01-namespace.yaml
   kubectl apply -f k8s/postgres/02-secrets.yaml
   kubectl apply -f k8s/postgres/03-pvc.yaml
   kubectl apply -f k8s/postgres/04-statefulset.yaml
   kubectl apply -f k8s/postgres/05-service.yaml
   kubectl wait --for=condition=ready pod/postgres-0 -n waka --timeout=300s
   ```

3. Set the app `DATABASE_URL` to:

   ```text
   postgresql://waka:URL_ENCODED_PASSWORD@postgres-service.waka.svc.cluster.local:5432/waka?sslmode=disable
   ```

4. Create the app secret from `k8s/secret.template.yaml`, set its `DATABASE_SSL` to `false`, and deploy the app from [../README.md](../README.md).

The database secret is not the app secret. The app Deployment reads `waka-secrets`, not `postgres-secret`.

## Status and backup

```bash
kubectl get statefulset postgres -n waka
kubectl get pvc postgres-pvc -n waka
kubectl logs postgres-0 -n waka
kubectl exec -it postgres-0 -n waka -- psql -U waka -d waka
```

Back up the database before upgrades. This StatefulSet has one replica and one volume; a pod restart does not provide database failover.
