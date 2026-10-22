# Kubernetes

Browse and manage Kubernetes clusters from a tab in Deck, in the spirit of Lens.

## What it does

- **Every resource as a live table**: pods, deployments, stateful sets, daemon sets, replica sets,
  jobs, cron jobs, services, ingresses, endpoints, network policies, config maps, secrets,
  autoscalers, disruption budgets, quotas, volumes and claims, storage classes, access control,
  nodes, namespaces and events, plus the custom resources your cluster defines (with their own
  columns). Tables update as the cluster changes; sort by any column, filter by name.
- **Details beside the table**: an overview for each kind (a pod's containers and their state, a
  deployment's images, a service's ports, a secret's values hidden until you show them, a node's
  capacity), the object's events, and its **YAML, editable**. Saving uses `kubectl replace`, so an
  object someone changed after you opened it is refused rather than overwritten.
- **Logs**: followed live, per container, with the previous container's log after a restart,
  timestamps, a line filter and copy.
- **Shell**: opens a Deck terminal in the container (bash when the image has it, sh otherwise).
- **Port-forwards** from a pod or a service. They keep running while the tab is closed, are listed
  under Port-forwards, open in the browser with one click, and stop when Deck exits.
- **Actions**: scale, restart a rollout, run a cron job now, suspend or resume it, cordon,
  uncordon and drain a node, delete anything (with a confirmation), and create resources from
  YAML.
- **Overview**: nodes, pods by state, CPU and memory requested against what the nodes can hold,
  usage when metrics-server runs, and the latest warnings.
- **Helm releases**: values (yours or with the chart's defaults), the rendered manifest, the
  revision history with rollback, and uninstall.

## What it needs

- **kubectl** on PATH. Docker Desktop brings one; otherwise `winget install Kubernetes.kubectl`.
- **A kubeconfig** naming at least one cluster (`%USERPROFILE%\.kube\config`). Turning on
  Kubernetes in Docker Desktop writes one for a local cluster.
- **helm**, for the Helm view only.
- **metrics-server** in the cluster, for CPU and memory in use only.

The plugin talks to clusters only through kubectl and helm, so it works with every kind of
authentication your kubeconfig uses. The cluster you pick is passed to each command with
`--context`; your kubeconfig's current context, which your terminals use, is never changed.

## Developing

```sh
npm run dev            # rebuild as you edit; each save shows in your test Deck
npm test               # the logic, in node: pod status, columns, the watch stream, arguments
npm run install-local  # when it is done: install it into your real Deck
```

`src/kube.ts` holds everything that needs neither Deck nor a cluster, `src/run.ts` runs kubectl
and helm, and the views are `src/plugin.tsx`, `src/Details.tsx` and `src/Helm.tsx`.
