# Minikube overlay

Local dev deployment of the Talend TMC MCP observability stack on a single
minikube VM. Total memory ask is ~2 GB; allocate at least 4 GB to the VM.

## 1. Start minikube with the ingress addon

```bash
minikube start --cpus=4 --memory=6g --addons=ingress
```

## 2. Build and load the custom images into the VM

```bash
# From the repo root.
docker build -t talend-tmc-mcp:latest .
docker build -t talend-tmc-python-exporters:obs ./python

minikube image load talend-tmc-mcp:latest
minikube image load talend-tmc-python-exporters:obs
```

## 3. Edit the example Secret with your real credentials

The minikube overlay pulls in `base/secrets.example.yaml` as a convenience —
edit it (or replace it with `secrets.yaml` and adjust the kustomization
resources list) before applying.

Required fields:

- `TMC_PAT` — Talend Cloud personal access token
- `QLIK_CLOUD_API_KEY` — optional, used by qvd-exporter / qlik-obs-exporter
- `GRAFANA_ADMIN_PASSWORD` — optional, defaults to `admin`

## 4. Apply

```bash
kubectl apply -k deploy/k8s/overlays/minikube
```

Watch the rollout:

```bash
kubectl -n talend-tmc-mcp get pods -w
```

## 5. Reach the UIs

Easiest path is port-forward:

```bash
kubectl -n talend-tmc-mcp port-forward svc/grafana    3000:3000
kubectl -n talend-tmc-mcp port-forward svc/prometheus 9090:9090
```

Or use the Ingress hosts (add to `/etc/hosts`):

```bash
echo "$(minikube ip) grafana.tmc.local prometheus.tmc.local" | sudo tee -a /etc/hosts
```

Grafana login: `admin / admin` (or whatever you set in the secret). The
Prometheus + Loki datasources and both dashboards are provisioned on first
boot.

## 6. Multi-tenant config

The base `tmc-mcp-config` ConfigMap ships with an empty tenant list. Edit
it in place to add real tenants:

```bash
kubectl -n talend-tmc-mcp edit configmap tmc-mcp-config
kubectl -n talend-tmc-mcp rollout restart deploy/tmc-mcp deploy/business-exporter deploy/qlik-obs-exporter
```

See `docs/k8s.md` for the config schema.

## 7. Teardown

```bash
kubectl delete -k deploy/k8s/overlays/minikube
# or
minikube delete
```
