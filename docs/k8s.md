# Kubernetes deployment guide

The Qlik Observability Toolkit project ships with Kustomize-based Kubernetes manifests
under `deploy/k8s/`. A `base/` folder holds the protocol-agnostic
manifests; two overlays (`minikube/`, `eks/`) layer on environment-specific
patches.

This page walks through what the manifests deploy, how secrets and
multi-tenant config get wired in, and step-by-step bring-up for each
overlay.

---

## What gets deployed

Every workload lands in the **`talend-tmc-mcp`** namespace.

| Resource                         | Kind          | Image                                         | Port | Notes                                                 |
|----------------------------------|---------------|-----------------------------------------------|------|-------------------------------------------------------|
| `tmc-mcp`                        | Deployment    | `talend-tmc-mcp:latest`                       | 9464 | Stdio MCP server + Prometheus /metrics + /health      |
| `business-exporter`              | Deployment    | `talend-tmc-python-exporters:obs`             | 9465 | Talend Cloud business metrics                         |
| `engine-log-scraper`             | Deployment    | `talend-tmc-python-exporters:obs`             | 9466 | Tails Remote Engine logs from a mounted directory     |
| `qvd-exporter`                   | Deployment    | `talend-tmc-python-exporters:obs`             | 9467 | Periodically exports a QVD to Qlik Cloud              |
| `qlik-obs-exporter`              | Deployment    | `talend-tmc-python-exporters:obs`             | 9468 | Qlik Cloud observability (multi-tenant)               |
| `prometheus`                     | Deployment    | `prom/prometheus:v3.5.0`                      | 9090 | Scrapes all of the above; PVC-backed tsdb             |
| `loki`                           | Deployment    | `grafana/loki:3.5.4`                          | 3100 | Single-binary log store; PVC-backed                   |
| `promtail`                       | DaemonSet     | `grafana/promtail:3.5.4`                      | 9080 | Tails `/var/log/pods` of pods labeled `logging=promtail` |
| `grafana`                        | Deployment    | `grafana/grafana:12.2.0`                      | 3000 | Pre-provisioned with the two project dashboards       |

The MCP server is **stdio-first** — the Deployment exists only so the
metrics endpoint is reachable. Real MCP tool calls from Claude Desktop or
Claude Code still happen via `docker run -i` (or `kubectl run -it --rm
... --image=talend-tmc-mcp:latest -- node dist/index.js`) on a developer
workstation. The in-cluster pod is for observability data, not for tool
invocation.

Promtail uses `kubernetes_sd_configs` to discover pods — works on any
container runtime (containerd, CRI-O, docker), not just docker. It scrapes
only pods carrying the `logging=promtail` pod label; every base workload
sets that label.

---

## Secrets — overlay differs

### Base

The base ships **no** Secret. The Deployments reference a Secret named
`tmc-mcp-secrets` and expect it to exist by the time pods schedule.

`base/secrets.example.yaml` is a **template** showing the expected keys.
DO NOT commit a populated copy.

### Minikube overlay

For local dev, the minikube overlay opts in to a literal manifest by
including `secrets.example.yaml` in its kustomization `resources:`. Edit
the template, replace the `REPLACE_ME_*` values with real ones, then apply.

### EKS overlay

The EKS overlay does NOT include `secrets.example.yaml`. Instead it ships
an `ExternalSecret` that pulls all three keys from AWS Secrets Manager via
external-secrets-operator. The flow:

1. You create one AWS Secrets Manager secret (suggested name
   `tmc-mcp/prod`) whose `SecretString` is a JSON object with keys
   `TMC_PAT`, `QLIK_CLOUD_API_KEY`, `GRAFANA_ADMIN_PASSWORD`.
2. You create an IAM role (suggested name `tmc-mcp-eks-role`) whose trust
   policy allows the four ServiceAccounts in this overlay
   (`tmc-mcp`, `business-exporter`, `qlik-obs-exporter`, `qvd-exporter`)
   via your cluster's OIDC provider. The role gets
   `secretsmanager:GetSecretValue` on the secret above and `kms:Decrypt`
   on its KMS key.
3. The ServiceAccount annotations
   `eks.amazonaws.com/role-arn: arn:aws:iam::<ACCOUNT>:role/tmc-mcp-eks-role`
   are applied by `irsa-patches.yaml`.
4. external-secrets-operator (deployed once into the cluster outside this
   overlay) reads the AWS secret and materializes a Kubernetes Secret
   named `tmc-mcp-secrets`. The workloads pick it up automatically.

Rotation: bump the AWS Secrets Manager secret. The ExternalSecret's
`refreshInterval: 1h` syncs the change down; trigger an immediate rollout
with `kubectl rollout restart`.

---

## Multi-tenant config

All workloads that read TMC tenants or Qlik tenants do so from a single
JSON config file at `/etc/tmc-mcp/config.json`, mounted from the
`tmc-mcp-config` ConfigMap.

The base ship-shape is an **empty** schema (`{"schemaVersion": 2,
"talendTenants": [], "qlikTenants": []}`) — apply the manifests, then
patch:

```bash
kubectl -n talend-tmc-mcp edit configmap tmc-mcp-config
# ...add tenants, save...
kubectl -n talend-tmc-mcp rollout restart \
  deploy/tmc-mcp deploy/business-exporter deploy/qlik-obs-exporter
```

For real environments, define your tenant list in your IaC (Terraform's
`kubernetes_config_map_v1` or an Argo CD application) and apply it as a
kustomize patch on top of the chosen overlay. The config schema is the
same one used by `docker-compose.observability.yml` — see
`docs/configuration.md` for fields.

---

## Minikube walkthrough

```bash
# 1. Start the cluster
minikube start --cpus=4 --memory=6g --addons=ingress

# 2. Build images and load into the VM
docker build -t talend-tmc-mcp:latest .
docker build -t talend-tmc-python-exporters:obs ./python
minikube image load talend-tmc-mcp:latest
minikube image load talend-tmc-python-exporters:obs

# 3. Edit the example secret with your real TMC PAT etc.
${EDITOR:-vi} deploy/k8s/base/secrets.example.yaml

# 4. Apply
kubectl apply -k deploy/k8s/overlays/minikube

# 5. Reach the UIs
kubectl -n talend-tmc-mcp port-forward svc/grafana 3000:3000
# open http://localhost:3000  (no login — anonymous access enabled)
```

Full instructions including the Ingress wiring are in
`deploy/k8s/overlays/minikube/README.md`.

---

## EKS walkthrough

```bash
# 1. Cluster + addons (one-time per cluster)
aws eks update-kubeconfig --name <cluster> --region us-east-1
# Install EBS CSI, aws-load-balancer-controller, external-secrets-operator
# — see deploy/k8s/overlays/eks/README.md.

# 2. Push images to ECR
ACCOUNT=123456789012
REGION=us-east-1
aws ecr get-login-password --region $REGION \
  | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$REGION.amazonaws.com
aws ecr create-repository --repository-name talend-tmc-mcp --region $REGION || true
aws ecr create-repository --repository-name talend-tmc-python-exporters --region $REGION || true

docker build -t talend-tmc-mcp:latest .
docker tag talend-tmc-mcp:latest $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/talend-tmc-mcp:latest
docker push $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/talend-tmc-mcp:latest

docker build -t talend-tmc-python-exporters:obs ./python
docker tag talend-tmc-python-exporters:obs $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/talend-tmc-python-exporters:obs
docker push $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/talend-tmc-python-exporters:obs

# 3. Provision the secret in AWS Secrets Manager
aws secretsmanager create-secret --name tmc-mcp/prod --region $REGION \
  --secret-string '{"TMC_PAT":"tcp_xxx","QLIK_CLOUD_API_KEY":"qlik_xxx","GRAFANA_ADMIN_PASSWORD":"<random>"}'

# 4. Substitute placeholders + apply
kubectl kustomize deploy/k8s/overlays/eks \
  | sed "s|<account>|$ACCOUNT|g; s|<region>|$REGION|g; s|<ACCOUNT_ID>|$ACCOUNT|g" \
  | kubectl apply -f -
```

Full instructions including the IAM role definitions and the
external-secrets ClusterSecretStore setup are in
`deploy/k8s/overlays/eks/README.md`.

---

## File layout

```
deploy/k8s/
├── base/
│   ├── kustomization.yaml          # base resources + configMapGenerator
│   ├── namespace.yaml
│   ├── mcp-server.yaml             # Deployment + Svc + SA + tmc-mcp-config CM
│   ├── business-exporter.yaml      # Deployment + Svc
│   ├── engine-log-scraper.yaml     # Deployment + Svc
│   ├── qvd-exporter.yaml           # Deployment + Svc + PVC + qvd-exporter-config CM
│   ├── qlik-obs-exporter.yaml      # Deployment + Svc
│   ├── prometheus.yaml             # Deployment + Svc + PVC + scrape config CM
│   ├── loki.yaml                   # Deployment + Svc + PVC + CM
│   ├── promtail.yaml               # DaemonSet + SA + ClusterRole + CRB + CM
│   ├── grafana.yaml                # Deployment + Svc + datasources/providers CMs
│   └── secrets.example.yaml        # TEMPLATE — do not commit with real values
└── overlays/
    ├── minikube/
    │   ├── kustomization.yaml
    │   ├── ingress.yaml            # NGINX Ingress for Grafana + Prometheus
    │   └── README.md
    └── eks/
        ├── kustomization.yaml
        ├── storageclass.yaml       # gp3 as default
        ├── irsa-patches.yaml       # ServiceAccount annotations
        ├── external-secret.yaml    # AWS Secrets Manager → Kubernetes Secret
        ├── ingress.yaml            # ALB Ingress for Grafana
        └── README.md
```

The Grafana dashboard ConfigMap (`grafana-dashboards`) is **generated** by
the base kustomization's `configMapGenerator` from the existing
`deploy/grafana/dashboards/*.json` files. That way the dashboards stay in
one place and the k8s manifests don't carry a duplicate copy.

---

## Operations cheat-sheet

```bash
# Trigger a re-scrape after editing prometheus-config:
kubectl -n talend-tmc-mcp exec deploy/prometheus -- \
  wget -qO- --method=POST localhost:9090/-/reload

# Quick health roll-call:
kubectl -n talend-tmc-mcp get pods -o wide

# Tail one component's logs (e.g. the business exporter):
kubectl -n talend-tmc-mcp logs -f deploy/business-exporter

# Re-apply after editing a manifest:
kubectl apply -k deploy/k8s/overlays/<env>
```

For deeper troubleshooting, the same `docs/observability.md` runbook
applies — the metric names, dashboard panels, and log shapes don't change
between docker-compose and k8s.
