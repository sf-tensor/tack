# Load Balancer

This document covers load balancing, certificates, and DNS configuration in Tack.

## Table of Contents

- [Overview](#overview)
- [createLoadBalancer](#createloadbalancer)
- [Certificate Management](#certificate-management)
- [DNS Configuration](#dns-configuration)
- [Complete Examples](#complete-examples)

---

## Overview

Tack's load balancer module creates Kubernetes Ingress resources with automatic TLS and DNS configuration.

### Stack Behavior

| Stack | Ingress Controller | TLS | DNS |
|-------|-------------------|-----|-----|
| development | nginx | None | localhost |
| local-staging | nginx | None | localhost |
| staging | AWS ALB | ACM | Cloudflare |
| production | AWS ALB | ACM | Cloudflare |

---

## createLoadBalancer

Creates a load balancer with routing rules.

### Signature

```typescript
function createLoadBalancer(args: LoadBalancerArgs): {
  ingress: k8s.networking.v1.Ingress;
  albHostname: pulumi.Output<string>;
  dnsRecords: cloudflare.DnsRecord[];
  certificates: Certificate[];
}
```

### LoadBalancerArgs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | `string` | Yes | Load balancer name |
| `cluster` | `Cluster` | Yes | Target cluster |
| `healthCheckPath` | `string` | Yes | Path for health checks |
| `rules` | `Rule[]` | Yes | Routing rules |

### Rule

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `host` | `string` | No | Domain name |
| `routes` | `Route[]` | Yes | Routing paths |

### Route

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | Yes | URL path (prefix match) |
| `service` | `string` | Yes | Kubernetes service name |
| `port` | `number` | Yes | Service port |

### Basic Example

```typescript
import { createLoadBalancer, createBunApp } from "@sf-tensor/tack";

const app = createBunApp({ /* ... */ });

const lb = createLoadBalancer({
  name: "main-lb",
  cluster,
  healthCheckPath: "/health",
  rules: [
    {
      host: "app.example.com",
      routes: [
        { path: "/", service: app.service.metadata.name, port: 3000 }
      ]
    }
  ]
});

export const loadBalancerHostname = lb.albHostname;
```

### Routing Multiple Bun Workloads

When a Bun app is configured with `containers`, each workload gets its own Service. Route them explicitly through `app.services`:

```typescript
const app = createBunApp({ /* ... */ });

const lb = createLoadBalancer({
  name: "main-lb",
  cluster,
  healthCheckPath: "/health",
  rules: [
    {
      host: "app.example.com",
      routes: [
        { path: "/", service: app.service.metadata.name, port: 3000 },
        { path: "/rates", service: app.services.rates.metadata.name, port: 3001 }
      ]
    }
  ]
});
```

---

## Certificate Management

### Automatic Certificate Creation

When `cloudflareZoneId` is configured, certificates are automatically created:

```bash
pulumi config set cloudflareZoneId <zone-id>
```

Certificates are:
- Created via AWS ACM
- Validated via Cloudflare DNS
- Automatically renewed

### Certificate Properties

```typescript
interface Certificate {
  certificate: aws.acm.Certificate;
  certificateArn: pulumi.Output<string>;
  validationRecords: cloudflare.DnsRecord[];
}
```

### Manual Certificate

For custom certificate needs:

```typescript
import { createCertificate } from "@sf-tensor/tack";

const cert = createCertificate({
  id: "custom-cert",
  domainName: "custom.example.com",
  subjectAlternativeNames: ["*.custom.example.com"],
  zoneId: cloudflareZoneId
});

// Use cert.certificateArn in other resources
```

---

## DNS Configuration

### Automatic DNS Records

When certificates are created, CNAME records are automatically added to Cloudflare.

### DNS Record Properties

```typescript
interface DnsRecordArgs {
  id: string;
  recordName: string;
  albHostname: pulumi.Input<string>;
  zoneId: pulumi.Input<string>;
}
```

### Manual DNS Record

```typescript
import { createDnsRecord } from "@sf-tensor/tack";

const record = createDnsRecord({
  id: "custom-dns",
  recordName: "custom.example.com",
  albHostname: lb.albHostname,
  zoneId: cloudflareZoneId
});
```

### Cloudflare Proxying

DNS records are created with `proxied: true` which provides:
- DDoS protection
- CDN caching
- SSL/TLS termination at edge

---

## ALB Configuration

### Default Annotations

Production load balancers include:

```typescript
annotations: {
  "kubernetes.io/ingress.class": "alb",
  "alb.ingress.kubernetes.io/scheme": "internet-facing",
  "alb.ingress.kubernetes.io/target-type": "ip",
  "alb.ingress.kubernetes.io/healthcheck-path": "/health",
  "alb.ingress.kubernetes.io/listen-ports": '[{"HTTP": 80}, {"HTTPS": 443}]',
  "alb.ingress.kubernetes.io/certificate-arn": "<cert-arn>",
  "alb.ingress.kubernetes.io/ssl-redirect": "443"
}
```

### Health Checks

The ALB performs health checks on the specified path:
- Default interval: 15 seconds
- Healthy threshold: 2
- Unhealthy threshold: 2
- Timeout: 5 seconds

### SSL Redirect

HTTP requests are automatically redirected to HTTPS when certificates are configured.

---

## nginx Configuration (Local)

### Local Annotations

```typescript
annotations: {
  "kubernetes.io/ingress.class": "nginx",
  "nginx.ingress.kubernetes.io/proxy-body-size": "50m",
  "nginx.ingress.kubernetes.io/proxy-read-timeout": "600",
  "nginx.ingress.kubernetes.io/proxy-send-timeout": "600"
}
```

### Local Access

Access via `localhost` when port forwarding is active.

---

## Complete Examples

### Example 1: Single Domain

```typescript
import {
  createCluster,
  createDeploymentManager,
  createBunApp,
  createLoadBalancer,
  type Region
} from "@sf-tensor/tack";

const region: Region = "us-east-1";

const app = createBunApp({
  id: "web",
  runtime: "next",
  ports: [{ name: "http", port: 3000 }],
  healthRoute: { path: "/api/health", port: 3000 },
  // ...
  cluster,
  deploymentManager,
  region
});

const lb = createLoadBalancer({
  name: "main",
  cluster,
  healthCheckPath: "/api/health",
  rules: [
    {
      host: "app.example.com",
      routes: [
        { path: "/", service: app.service.metadata.name, port: 3000 }
      ]
    }
  ]
});

export const appUrl = "https://app.example.com";
export const albHostname = lb.albHostname;
```

### Example 2: Multiple Domains

```typescript
const frontend = createBunApp({
  id: "frontend",
  // ...
});

const api = createBunApp({
  id: "api",
  // ...
});

const admin = createBunApp({
  id: "admin",
  // ...
});

const lb = createLoadBalancer({
  name: "multi-domain",
  cluster,
  healthCheckPath: "/health",
  rules: [
    {
      host: "app.example.com",
      routes: [
        { path: "/", service: frontend.service.metadata.name, port: 3000 }
      ]
    },
    {
      host: "api.example.com",
      routes: [
        { path: "/", service: api.service.metadata.name, port: 4000 }
      ]
    },
    {
      host: "admin.example.com",
      routes: [
        { path: "/", service: admin.service.metadata.name, port: 3000 }
      ]
    }
  ]
});
```

### Example 3: Path-Based Routing

```typescript
const lb = createLoadBalancer({
  name: "path-based",
  cluster,
  healthCheckPath: "/health",
  rules: [
    {
      host: "example.com",
      routes: [
        { path: "/api", service: api.service.metadata.name, port: 4000 },
        { path: "/admin", service: admin.service.metadata.name, port: 3000 },
        { path: "/", service: frontend.service.metadata.name, port: 3000 }
      ]
    }
  ]
});
```

### Example 4: Local Development

```typescript
import { isLocalStack, currentStack } from "@sf-tensor/tack";

const lb = createLoadBalancer({
  name: "dev",
  cluster,
  healthCheckPath: "/health",
  rules: [
    {
      // Empty host for local development
      host: isLocalStack(currentStack) ? "" : "app.example.com",
      routes: [
        { path: "/", service: app.service.metadata.name, port: 3000 }
      ]
    }
  ]
});
```

---

## Troubleshooting

### Certificate Not Validating

**Check DNS propagation:**
```bash
dig _acme-challenge.app.example.com TXT
```

**Check Cloudflare records:**
- Ensure validation records exist
- Ensure `proxied: false` for validation

### ALB Not Creating

**Check AWS Load Balancer Controller:**
```bash
kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller
kubectl logs -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller
```

**Check Ingress events:**
```bash
kubectl describe ingress main
```

### 502 Bad Gateway

**Check target health:**
```bash
# AWS Console → EC2 → Target Groups → Select group → Targets
```

**Check pod health:**
```bash
kubectl get pods
kubectl logs <pod-name>
```

### SSL Certificate Error

**Check certificate status:**
```bash
aws acm describe-certificate --certificate-arn <arn>
```

**Ensure certificate is in same region as ALB.**

---

## Best Practices

### 1. Use Meaningful Health Check Paths

```typescript
healthCheckPath: "/api/health"  // Good
healthCheckPath: "/"            // May not reflect actual health
```

### 2. Order Routes Correctly

More specific paths should come first:

```typescript
routes: [
  { path: "/api/v2", service: "api-v2", port: 4000 },
  { path: "/api", service: "api", port: 4000 },
  { path: "/", service: "frontend", port: 3000 }
]
```

### 3. Configure Appropriate Timeouts

For long-running requests, increase ALB timeout.

### 4. Use Cloudflare Proxy

Take advantage of:
- DDoS protection
- Edge caching
- Performance optimization

---

## Related Documentation

- [Cluster](./CLUSTER.md) - AWS Load Balancer Controller
- [Bun Apps](./BUN_APPS.md) - Application services
- [Networking](./NETWORKING.md) - VPC for ALB
