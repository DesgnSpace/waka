#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)

command -v kubectl >/dev/null 2>&1 || {
  printf '%s\n' "kubectl is required." >&2
  exit 1
}
kubectl cluster-info >/dev/null

kubectl apply -f "$ROOT_DIR/k8s/postgres/01-namespace.yaml"
kubectl apply -f "$ROOT_DIR/k8s/postgres/02-secrets.yaml"
kubectl apply -f "$ROOT_DIR/k8s/postgres/03-pvc.yaml"
kubectl apply -f "$ROOT_DIR/k8s/postgres/04-statefulset.yaml"
kubectl apply -f "$ROOT_DIR/k8s/postgres/05-service.yaml"
kubectl wait --for=condition=ready pod/postgres-0 -n waka --timeout=300s
kubectl get statefulset postgres -n waka
kubectl get pvc postgres-pvc -n waka
