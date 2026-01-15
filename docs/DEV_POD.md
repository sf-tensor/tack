# DevPod

DevPod is a first-class local workflow for developing against a Kubernetes cluster.

## What it does

- Creates a development pod for your app in the cluster.
- Syncs your local files to the pod and watches for changes.
- Forwards ports so you can use the app as if it were local.

## Requirements

- `kubectl` access to the target cluster.
- A local stack (`development` or `local-staging`).
- The app configuration includes `localPath` and `devPod` settings.

## Config options

These live under `devPod` in `BunAppConfig`:

- `nodeModulesCacheSize`: PVC size for node_modules cache (default `5Gi`).
- `ignorePatterns`: Additional ignore patterns for file sync.
- `skipInit`: Skip automatic init after deployment (default `false`).
- `initTimeoutMs`: Init timeout in ms (default `180000`).

## Typical flow

1) Create the app with `createBunApp` in a local stack.
2) Tack deploys a dev pod and starts the sync/port-forward client.
3) Your local edits sync to the pod and the app reloads as configured.

If your cluster uses a different namespace or policy, you may need to adapt the service account and RBAC configuration.
