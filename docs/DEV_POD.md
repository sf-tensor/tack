# DevPod

DevPod is a first-class local development workflow for working against a real Kubernetes cluster.

## Table of Contents

- [Overview](#overview)
- [How It Works](#how-it-works)
- [Configuration](#configuration)
- [Typical Workflow](#typical-workflow)
- [Troubleshooting](#troubleshooting)
- [Best Practices](#best-practices)

---

## Overview

DevPod enables rapid local development by:

- Creating a development pod in your cluster
- Syncing local files to the pod in real-time
- Forwarding ports for local access
- Caching `node_modules` for fast rebuilds

### When DevPod is Used

| Stack | Deployment Type | DevPod Active |
|-------|-----------------|---------------|
| development | DevPod | Yes |
| local-staging | Kubernetes Deployment | No |
| staging | Kubernetes Deployment | No |
| production | Kubernetes Deployment | No |

---

## How It Works

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     LOCAL MACHINE                           │
│                                                             │
│  ┌─────────────────┐    ┌─────────────────────────────────┐ │
│  │  Your Code      │    │    DevPod Client                │ │
│  │  /path/to/app   │───▶│  - File watcher                 │ │
│  │                 │    │  - Sync engine                  │ │
│  └─────────────────┘    │  - Port forwarder               │ │
│                         └───────────────┬─────────────────┘ │
└─────────────────────────────────────────┼───────────────────┘
                                          │
                                          │ kubectl
                                          │ (sync + port-forward)
                                          │
┌─────────────────────────────────────────┼───────────────────┐
│                     MINIKUBE CLUSTER    │                   │
│                                         ▼                   │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                    DevPod                              │ │
│  │  ┌──────────────┐  ┌────────────────┐  ┌─────────────┐ │ │
│  │  │ App Code     │  │ node_modules   │  │ Dev Server  │ │ │
│  │  │ (synced)     │  │ (PVC cached)   │  │ (hot reload)│ │ │
│  │  └──────────────┘  └────────────────┘  └─────────────┘ │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐             │
│  │   MinIO    │  │ PostgreSQL │  │   nginx    │             │
│  │  (buckets) │  │    (db)    │  │ (ingress)  │             │
│  └────────────┘  └────────────┘  └────────────┘             │
└─────────────────────────────────────────────────────────────┘
```

### File Sync

1. DevPod client watches your local directory
2. Changes are detected and synced to the pod
3. The dev server (Next.js/Bun) picks up changes
4. Hot reload updates the browser

### Port Forwarding

Ports defined in your app config are forwarded:
- `localhost:3000` → Pod port 3000
- `localhost:9090` → Pod port 9090

---

## Configuration

### DevPodConfig

```typescript
interface DevPodConfig {
  nodeModulesCacheSize?: string;  // PVC size (default: '5Gi')
  ignorePatterns?: string[];      // Files to ignore during sync
  skipInit?: boolean;             // Skip auto-init (default: false)
  initTimeoutMs?: number;         // Init timeout (default: 180000)
}
```

### Example Configuration

```typescript
const app = createBunApp({
  id: "web-app",
  runtime: "next",
  localPath: "/Users/dev/projects/my-app",

  devPod: {
    // Large cache for big node_modules
    nodeModulesCacheSize: "10Gi",

    // Ignore files that don't need syncing
    ignorePatterns: [
      ".git",
      "node_modules",
      ".next",
      "dist",
      "build",
      "*.log",
      ".env.local",
      ".DS_Store"
    ],

    // Don't skip initialization
    skipInit: false,

    // 5 minute timeout for large projects
    initTimeoutMs: 300000
  },

  // Other config...
  cluster,
  deploymentManager,
  region
});
```

### Ignore Patterns

Common patterns to ignore:

```typescript
ignorePatterns: [
  // Version control
  ".git",
  ".svn",

  // Dependencies (managed in pod)
  "node_modules",

  // Build outputs
  ".next",
  "dist",
  "build",
  ".turbo",

  // Local environment
  ".env.local",
  ".env.development.local",

  // IDE/Editor
  ".idea",
  ".vscode",
  "*.swp",

  // System files
  ".DS_Store",
  "Thumbs.db",

  // Logs
  "*.log",
  "npm-debug.log*",
  "yarn-debug.log*"
]
```

---

## Typical Workflow

### Initial Setup

1. **Start Minikube**
   ```bash
   minikube start
   ```

2. **Deploy Infrastructure**
   ```bash
   pulumi stack select development
   pulumi up
   ```

3. **Wait for DevPod**
   The DevPod client starts automatically and syncs your files.

### Development Loop

1. **Edit files locally** in your IDE
2. **Changes sync automatically** to the pod
3. **Hot reload** updates your app
4. **Test in browser** at `localhost:3000`

### Stopping Development

```bash
# Stop Pulumi resources
pulumi down

# Or just stop Minikube
minikube stop
```

### Restarting

```bash
# Start Minikube
minikube start

# Pulumi will reconnect to existing resources
pulumi up
```

---

## Requirements

### Required Tools

| Tool | Purpose | Installation |
|------|---------|--------------|
| kubectl | Cluster access | `brew install kubectl` |
| Minikube | Local cluster | `brew install minikube` |
| Docker | Container runtime | Docker Desktop |

### Cluster Access

Ensure kubectl can connect:

```bash
# Verify connection
kubectl cluster-info

# Should show Minikube control plane
# Kubernetes control plane is running at https://192.168.49.2:8443
```

### Local Path

The `localPath` must be an absolute path to your application:

```typescript
// Good
localPath: "/Users/dev/projects/my-app"

// Bad
localPath: "./my-app"
localPath: "~/projects/my-app"
```

---

## Troubleshooting

### DevPod Not Starting

**Symptom**: Pod stays in `Pending` state.

**Solutions**:
1. Check Minikube status:
   ```bash
   minikube status
   ```
2. Check pod events:
   ```bash
   kubectl describe pod -l app=web-app
   ```
3. Check PVC binding:
   ```bash
   kubectl get pvc
   ```

### File Sync Not Working

**Symptom**: Changes not appearing in pod.

**Solutions**:
1. Check DevPod client logs (in Pulumi output)
2. Verify `localPath` is correct
3. Check ignore patterns aren't too broad
4. Restart the sync:
   ```bash
   pulumi up --refresh
   ```

### Hot Reload Not Working

**Symptom**: Files sync but app doesn't reload.

**Solutions**:
1. Check dev server logs:
   ```bash
   kubectl logs -l app=web-app -f
   ```
2. Verify your app has hot reload configured (Next.js has it by default)
3. Check for TypeScript/compilation errors in logs

### Port Forward Failing

**Symptom**: Can't access `localhost:3000`.

**Solutions**:
1. Check if port is already in use:
   ```bash
   lsof -i :3000
   ```
2. Manually forward:
   ```bash
   kubectl port-forward svc/web-app 3000:3000
   ```
3. Check service exists:
   ```bash
   kubectl get svc web-app
   ```

### Init Timeout

**Symptom**: Initialization times out.

**Solutions**:
1. Increase timeout:
   ```typescript
   devPod: {
     initTimeoutMs: 600000  // 10 minutes
   }
   ```
2. Check if dependencies are installing:
   ```bash
   kubectl logs -l app=web-app -f
   ```
3. Increase PVC size for large `node_modules`:
   ```typescript
   devPod: {
     nodeModulesCacheSize: "15Gi"
   }
   ```

### Out of Disk Space

**Symptom**: Pod evicted or build fails.

**Solutions**:
1. Clean Minikube:
   ```bash
   minikube ssh -- docker system prune -a
   ```
2. Increase PVC size
3. Add more ignore patterns

---

## Best Practices

### 1. Use Appropriate Cache Sizes

For typical projects:
- Small (< 500 deps): `5Gi`
- Medium (500-1000 deps): `10Gi`
- Large (1000+ deps): `15Gi`

```typescript
nodeModulesCacheSize: "10Gi"
```

### 2. Ignore Everything Unnecessary

Faster syncs = faster development:

```typescript
ignorePatterns: [
  ".git",
  "node_modules",
  ".next",
  "dist",
  "*.log"
]
```

### 3. Use Consistent Local Paths

Keep project paths consistent for team members:

```typescript
// In environment or config
const APP_PATH = process.env.APP_PATH || "/Users/dev/projects/my-app";

createBunApp({
  localPath: APP_PATH,
  // ...
});
```

### 4. Monitor Resource Usage

Watch Minikube resources:

```bash
# Resource usage
minikube dashboard

# Or via kubectl
kubectl top pods
kubectl top nodes
```

### 5. Clean Up Periodically

```bash
# Prune Docker in Minikube
minikube ssh -- docker system prune -a

# Delete and recreate PVCs if needed
kubectl delete pvc --all
pulumi up
```

---

## Integration with IDEs

### VS Code

1. Install Kubernetes extension
2. Use Remote - Kubernetes extension for in-pod debugging
3. Configure port forwarding in tasks.json

### JetBrains IDEs

1. Install Kubernetes plugin
2. Configure remote interpreter to use pod
3. Set up deployment configuration

---

## Comparison with Other Approaches

| Approach | Pros | Cons |
|----------|------|------|
| **DevPod** | Real cluster, same as prod | Requires Minikube |
| **Docker Compose** | Simple setup | Different from K8s |
| **Local Node** | Fastest | No container behavior |
| **Remote Cluster** | Real environment | Network latency |

---

## Related Documentation

- [Bun Apps](./BUN_APPS.md) - App configuration
- [Getting Started](./GETTING_STARTED.md) - Initial setup
- [Core Concepts](./CORE_CONCEPTS.md) - Stack behavior
