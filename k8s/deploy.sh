#!/bin/sh

set -eu

: "${IMAGE_REPOSITORY:?Set IMAGE_REPOSITORY, for example registry.example.com/freeresend}"
: "${IMAGE_TAG:?Set IMAGE_TAG to an immutable image tag}"

IMAGE="${IMAGE_REPOSITORY}:${IMAGE_TAG}"

if [ ! -f "k8s/secret.yaml" ]; then
  printf '%s\n' "k8s/secret.yaml is missing. Copy k8s/secret.template.yaml and replace its placeholders." >&2
  exit 1
fi

docker build --platform linux/amd64 -t "$IMAGE" .
docker push "$IMAGE"

kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/secret.yaml
kubectl apply -f k8s/deployment.yaml
kubectl set image deployment/waka "waka=${IMAGE}" -n waka
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml
kubectl apply -f k8s/hpa.yaml
kubectl rollout status deployment/waka -n waka --timeout=300s

kubectl get pods -n waka
kubectl get ingress -n waka
