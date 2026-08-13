#!/bin/sh

set -eu

: "${IMAGE_REPOSITORY:?Set IMAGE_REPOSITORY, for example registry.example.com/freeresend}"
: "${IMAGE_TAG:?Set IMAGE_TAG to an immutable image tag}"

IMAGE="${IMAGE_REPOSITORY}:${IMAGE_TAG}"

docker build --platform linux/amd64 -t "$IMAGE" .
docker push "$IMAGE"
kubectl set image deployment/waka "waka=${IMAGE}" -n waka
kubectl rollout status deployment/waka -n waka --timeout=300s
kubectl get pods -n waka
