# EKS overlay

Production-ish deployment of the Talend TMC MCP observability stack on
Amazon EKS. The overlay adds:

- **gp3 StorageClass** marked as cluster default
- **IRSA-annotated ServiceAccounts** (one role for all the workloads that
  need to pull from AWS Secrets Manager)
- **ExternalSecret** that materializes `tmc-mcp-secrets` from AWS Secrets
  Manager via the external-secrets-operator
- **ALB Ingress** for Grafana with health checks
- Bigger resource requests/limits and PVC sizes than the base

## 0. Cluster prerequisites

This overlay assumes the following have been installed once into the
cluster (typically via Helm and your IaC of choice):

| Component                        | Why                                             |
|----------------------------------|-------------------------------------------------|
| EBS CSI driver                   | Backs PVCs with gp3 volumes                     |
| aws-load-balancer-controller     | Translates the ALB Ingress into a real ALB      |
| external-secrets-operator        | Pulls TMC_PAT etc. from AWS Secrets Manager     |
| `ClusterSecretStore aws-secretsmanager` | EKS-side wiring for the operator        |

A typical bring-up:

```bash
helm repo add eks https://aws.github.io/eks-charts
helm repo add external-secrets https://charts.external-secrets.io
helm repo update

helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system --set clusterName=<your-cluster>

helm install external-secrets external-secrets/external-secrets \
  -n external-secrets --create-namespace
```

## 1. Push images to ECR

```bash
ACCOUNT=123456789012
REGION=us-east-1

aws ecr get-login-password --region $REGION \
  | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$REGION.amazonaws.com

# Create the two ECR repositories (idempotent — ignore "already exists").
aws ecr create-repository --repository-name talend-tmc-mcp --region $REGION || true
aws ecr create-repository --repository-name talend-tmc-python-exporters --region $REGION || true

# Build, tag, push.
docker build -t talend-tmc-mcp:latest .
docker tag talend-tmc-mcp:latest $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/talend-tmc-mcp:latest
docker push $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/talend-tmc-mcp:latest

docker build -t talend-tmc-python-exporters:obs ./python
docker tag talend-tmc-python-exporters:obs $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/talend-tmc-python-exporters:obs
docker push $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/talend-tmc-python-exporters:obs
```

## 2. Provision the AWS Secrets Manager secret

Create a secret with all three keys as JSON, e.g.:

```bash
aws secretsmanager create-secret \
  --name tmc-mcp/prod \
  --secret-string '{
    "TMC_PAT": "tcp_REPLACE_ME",
    "QLIK_CLOUD_API_KEY": "qlik_REPLACE_ME",
    "GRAFANA_ADMIN_PASSWORD": "REPLACE_ME"
  }' \
  --region $REGION
```

## 3. Fill in the placeholders

Edit these files BEFORE applying:

- `irsa-patches.yaml` — replace `<ACCOUNT_ID>` in the role ARNs (and create
  the IAM role `tmc-mcp-eks-role` with a trust policy for your OIDC
  provider + Secrets Manager + KMS read perms).
- `ingress.yaml` — replace `<REGION>`, `<ACCOUNT_ID>`, `<CERT_ID>`, and the
  hostname.
- `kustomization.yaml` — replace `<account>` and `<region>` in the `images:`
  block, or do the sed-and-pipe trick shown below.

## 4. Connect and apply

```bash
aws eks update-kubeconfig --name <your-cluster> --region $REGION

# Render-and-substitute style:
kubectl kustomize deploy/k8s/overlays/eks \
  | sed "s|<account>|$ACCOUNT|g; s|<region>|$REGION|g; s|<ACCOUNT_ID>|$ACCOUNT|g" \
  | kubectl apply -f -

# ...or if you've baked the placeholders into the files:
kubectl apply -k deploy/k8s/overlays/eks
```

## 5. Watch the rollout

```bash
kubectl -n talend-tmc-mcp get pods -w
kubectl -n talend-tmc-mcp get ingress
kubectl -n talend-tmc-mcp get externalsecret
```

`tmc-mcp-secrets` should appear within a minute of the ExternalSecret
becoming Ready. If it doesn't, `kubectl describe externalsecret
tmc-mcp-secrets` shows why (most commonly: IRSA role missing
`secretsmanager:GetSecretValue` or wrong OIDC trust policy).

## 6. Multi-tenant config

Same as the minikube overlay: edit the `tmc-mcp-config` ConfigMap and
rollout-restart the consumers. For real environments, bake the config into
your IaC and ship it as a kustomize patch on top of this overlay instead
of editing in place.

## Notes

- The base manifests mark every pod with `logging: promtail` — the
  DaemonSet's `kubernetes_sd_config` matches that. On EKS the node `/var/log/pods`
  layout is the same as a vanilla containerd cluster, so no overlay
  changes are needed for the log path.
- The MCP server's `/metrics` port is ClusterIP-only here on purpose. If
  you run Prometheus *outside* the cluster, swap the Service type to
  `LoadBalancer` with `service.beta.kubernetes.io/aws-load-balancer-internal: "true"`.
