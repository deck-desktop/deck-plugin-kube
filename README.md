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
  capacity), the object's events, and its **YAML, editable**. Saving sends only what you changed, so a
  controller updating the object's status does not get in the way; if somebody else changed its
  spec after you opened it, you are told, and choose between their version and yours.
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
- **A cluster.** Every cluster in your own kubeconfig (`%USERPROFILE%\.kube\config`) shows up by
  itself. For one on a server, use **Add a cluster** (the + beside the cluster picker) and paste
  the kubeconfig it came with: k3s leaves it at `/etc/rancher/k3s/k3s.yaml`, kubeadm at
  `/etc/kubernetes/admin.conf`, and a hosted provider offers it for download. It is kept in the
  plugin's own folder, and your own kubeconfig is not changed. When the pasted file points at
  127.0.0.1 (as k3s's does), you are asked for the server's real address.
- **A way to reach it.** Either this PC reaches the cluster's API port (usually 6443) directly, or
  you pick **Through SSH** when adding it and name the SSH host (an alias from your SSH config, or
  `user@server`). The tunnel opens when you first use the cluster and closes when Deck exits. It
  uses your SSH keys; a password prompt cannot be answered from here.
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
