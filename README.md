# Kubernetes for Deck

Browse and manage Kubernetes clusters in the spirit of Lens. Open it from the **+** beside your
tabs and choose **Kubernetes**.

## What it does

- **Every resource as a live table**: pods, deployments, stateful sets, daemon sets, replica sets,
  jobs, cron jobs, services, ingresses, endpoints, network policies, config maps, secrets,
  autoscalers, disruption budgets, quotas, volumes and claims, storage classes, access control,
  nodes, namespaces and events, plus the custom resources your cluster defines (with their own
  columns). Tables update as the cluster changes; sort by any column, filter by name.
- **Details beside the table**: an overview for each kind (a pod's containers and their state, a
  deployment's images, a service's ports, a secret's values hidden until you show them, a node's
  capacity), the object's events, and its **YAML, editable**. Saving sends only what you changed,
  so a controller updating the object's status does not get in the way; if somebody else changed
  its spec after you opened it, you are told, and choose between their version and yours.
- **Logs**: followed live, per container, with the previous container's log after a restart,
  timestamps, a line filter and copy.
- **Shell**: opens a Deck terminal in the container (bash when the image has it, sh otherwise).
  A container with no shell at all offers **Debug with busybox**, which adds a temporary busybox
  container to the pod and opens a shell in it.
- **Port-forwards** from a pod or a service. They keep running while the tab is closed, are listed
  under Port-forwards, open in the browser with one click, and stop when Deck exits.
- **Actions**: scale, restart a rollout, run a cron job now, suspend or resume it, cordon,
  uncordon and drain a node, delete anything (with a confirmation), and create resources from
  YAML.
- **Overview**: nodes, pods by state, CPU and memory requested against what the nodes can hold,
  usage when metrics-server runs, and the latest warnings.
- **Helm releases**: values (yours or with the chart's defaults), the rendered manifest, the
  revision history with rollback, and uninstall.

**Terminals from Kubernetes** in Settings > Where things open: a pod's shell, and installing
kubectl or Helm, open as a tab or in a floating window.

## For agents

Deck's MCP server gets tools for the same clusters, including those added through SSH (the tools
open their own tunnel):

- **Read only:** `kube_contexts`, `kube_get`, `kube_describe`, `kube_logs`, `kube_events`,
  `kube_top`.
- **Change the cluster:** `kube_apply` (YAML) and `kube_kubectl` (any kubectl command: scale,
  rollout restart, delete, …). Kept apart from the read-only ones so an agent can be allowed to
  read without asking and still asked before it changes anything.

A tool's `context` is an id from `kube_contexts`; without one it uses the cluster picked in the tab.

## What it needs

- **kubectl** on PATH. Docker Desktop brings one; otherwise the tab offers to install it with
  winget.
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
- **helm**, for the Helm view only (the view offers to install it).
- **metrics-server** in the cluster, for CPU and memory in use only.

The plugin talks to clusters only through kubectl and helm, so it works with every kind of
authentication your kubeconfig uses. The cluster you pick is passed to each command with
`--context`; your kubeconfig's current context, which your terminals use, is never changed. The
added clusters and your choices are kept in Deck's config on this machine (`clusters.json`,
`prefs.json`, and the pasted kubeconfigs beside them).
