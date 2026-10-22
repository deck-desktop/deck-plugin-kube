// What the plugin knows about Kubernetes, with no Deck and no cluster around it: the resource
// kinds and their columns, kubectl's own rules for a pod's status and an age, the arguments of
// every kubectl and helm call, and the parsers for what those print. kube.check.mjs runs all of
// it in node.
//
// Everything goes through kubectl rather than the API server directly, so every way a
// kubeconfig can authenticate (client certificates, tokens, `aws`/`gcloud` exec plugins) works
// without this plugin knowing about any of them.

// ---- objects -------------------------------------------------------------------------------

/** A Kubernetes object as `kubectl get -o json` prints it. Only what the plugin reads is typed. */
export interface Obj {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string;
    deletionTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: { kind: string; name: string }[];
    resourceVersion?: string;
    managedFields?: unknown;
  };
  spec?: any;
  status?: any;
  [k: string]: any;
}

/** The key a row is held under: namespace and name, which together are unique within a kind. */
export const objKey = (o: Obj) => `${o.metadata.namespace ?? ""}/${o.metadata.name}`;

// ---- age -----------------------------------------------------------------------------------

/**
 * kubectl's AGE column (k8s.io/apimachinery duration.HumanDuration): precise while short, then
 * coarser as it grows, so "2m30s" but "5h" and "40d".
 */
export function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 0) return "0s";
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 10) return s % 60 ? `${m}m${s % 60}s` : `${m}m`;
  if (m < 180) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 8) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  if (h < 24 * 8) return h % 24 ? `${d}d${h % 24}h` : `${d}d`;
  if (d < 365 * 2) return `${d}d`;
  const y = Math.floor(d / 365);
  if (y < 8) return d % 365 ? `${y}y${d % 365}d` : `${y}y`;
  return `${y}y`;
}

/** The age of a timestamp, or "" when there is none. */
export const age = (ts: string | undefined, now: number) =>
  ts ? humanDuration(now - Date.parse(ts)) : "";

// ---- pods ----------------------------------------------------------------------------------

/**
 * A pod's STATUS column, by kubectl's own rules (printPod in pkg/printers/internalversion): the
 * failing init container first, then the last container with a reason, and Terminating over
 * everything once the pod is being deleted. The phase alone says "Running" for a pod whose
 * container is in CrashLoopBackOff, which is the one thing a status column is for.
 */
export function podStatus(p: Obj): string {
  const st = p.status ?? {};
  let reason: string = st.reason || st.phase || "Unknown";
  const inits: Container[] = st.initContainerStatuses ?? [];
  const nInit = (p.spec?.initContainers ?? []).length || inits.length;
  let initializing = false;
  for (let i = 0; i < inits.length; i++) {
    const c = inits[i];
    const t = c.state?.terminated;
    if (t && t.exitCode === 0) continue;
    initializing = true;
    if (t) {
      reason = t.reason ? `Init:${t.reason}`
        : t.signal ? `Init:Signal:${t.signal}` : `Init:ExitCode:${t.exitCode}`;
    } else if (c.state?.waiting?.reason && c.state.waiting.reason !== "PodInitializing") {
      reason = `Init:${c.state.waiting.reason}`;
    } else {
      reason = `Init:${i}/${nInit}`;
    }
    break;
  }
  if (!initializing) {
    let hasRunning = false;
    const cs: Container[] = st.containerStatuses ?? [];
    for (let i = cs.length - 1; i >= 0; i--) {
      const c = cs[i];
      if (c.state?.waiting?.reason) reason = c.state.waiting.reason;
      else if (c.state?.terminated?.reason) reason = c.state.terminated.reason;
      else if (c.state?.terminated) {
        reason = c.state.terminated.signal ? `Signal:${c.state.terminated.signal}`
          : `ExitCode:${c.state.terminated.exitCode}`;
      } else if (c.ready && c.state?.running) hasRunning = true;
    }
    if (reason === "Completed" && hasRunning) {
      const ready = (st.conditions ?? []).some((c: { type: string; status: string }) =>
        c.type === "Ready" && c.status === "True");
      reason = ready ? "Running" : "NotReady";
    }
  }
  if (p.metadata.deletionTimestamp) reason = st.reason === "NodeLost" ? "Unknown" : "Terminating";
  return reason;
}

interface Container {
  name: string;
  ready?: boolean;
  restartCount?: number;
  state?: {
    running?: { startedAt?: string };
    waiting?: { reason?: string; message?: string };
    terminated?: { reason?: string; exitCode?: number; signal?: number };
  };
}

/** READY: the pod's ready containers over all of them. */
export function podReady(p: Obj): string {
  const cs: Container[] = p.status?.containerStatuses ?? [];
  const total = (p.spec?.containers ?? []).length || cs.length;
  return `${cs.filter((c) => c.ready).length}/${total}`;
}

/** RESTARTS: every container's restarts added up. */
export const podRestarts = (p: Obj) =>
  ((p.status?.containerStatuses ?? []) as Container[]).reduce((n, c) => n + (c.restartCount ?? 0), 0);

/** The pod's containers by name, init containers first, for the logs and shell pickers. */
export const podContainers = (p: Obj): { name: string; init: boolean }[] => [
  ...((p.spec?.initContainers ?? []) as { name: string }[]).map((c) => ({ name: c.name, init: true })),
  ...((p.spec?.containers ?? []) as { name: string }[]).map((c) => ({ name: c.name, init: false })),
];

/** Every container port the pod declares, for port-forward. */
export const podPorts = (p: Obj): { port: number; name?: string; protocol?: string }[] =>
  ((p.spec?.containers ?? []) as { ports?: { containerPort: number; name?: string; protocol?: string }[] }[])
    .flatMap((c) => (c.ports ?? []).map((x) => ({ port: x.containerPort, name: x.name, protocol: x.protocol })));

// ---- status tones ----------------------------------------------------------------------------

export type Tone = "green" | "amber" | "red" | "blue" | "muted";

/** Which colour a status word is drawn in. Unknown words are muted rather than guessed at. */
export function statusTone(s: string): Tone {
  if (/^(Running|Ready|Active|Bound|Available|Complete|Completed|Succeeded|deployed|True|Normal)$/i.test(s)) {
    return s === "Completed" || s === "Succeeded" || s === "Complete" ? "blue" : "green";
  }
  if (/^(Pending|ContainerCreating|PodInitializing|Terminating|Released|pending-.*|uninstalling|superseded|Init:\d+\/\d+)$/i.test(s)) {
    return "amber";
  }
  if (/(Err|Fail|BackOff|Crash|Evicted|OOMKilled|Lost|NotReady|Unknown|Warning|Error|ExitCode|Signal|failed)/i.test(s)) {
    return "red";
  }
  return "muted";
}

// ---- quantities ----------------------------------------------------------------------------

const SUFFIX: Record<string, number> = {
  n: 1e-9, u: 1e-6, m: 1e-3, "": 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
  Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60,
};

/** A resource quantity ("250m", "128Mi", "1.5", "2e3") as a plain number, NaN when unreadable. */
export function parseQuantity(q: string | number | undefined): number {
  if (q === undefined || q === "") return NaN;
  if (typeof q === "number") return q;
  const m = /^([+-]?[\d.]+(?:[eE][+-]?\d+)?)([a-zA-Z]*)$/.exec(q.trim());
  if (!m || !(m[2] in SUFFIX)) return NaN;
  return Number(m[1]) * SUFFIX[m[2]];
}

/** CPU cores as kubectl top prints them: millicores below one core. */
export const fmtCpu = (cores: number) =>
  !isFinite(cores) ? "" : cores < 1 ? `${Math.round(cores * 1000)}m` : `${+cores.toFixed(2)}`;

/** Bytes in binary units, the way a memory limit is usually written. */
export function fmtBytes(b: number): string {
  if (!isFinite(b)) return "";
  const units = ["", "Ki", "Mi", "Gi", "Ti"];
  let i = 0;
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
  return `${i ? +b.toFixed(b < 10 ? 1 : 0) : Math.round(b)}${units[i]}`;
}

// ---- kinds and columns -----------------------------------------------------------------------

export interface Column {
  title: string;
  get: (o: Obj, now: number) => string;
  /** The value is a state: drawn as a chip in its tone. */
  status?: boolean;
  /** Numbers and addresses: right-aligned or monospaced. */
  mono?: boolean;
  /** What the column sorts by, when its text would sort wrongly ("5m" after "2h"). */
  sortKey?: (o: Obj) => number;
}

export interface Kind {
  /** The resource name kubectl takes, qualified when it is not a core one (`ingresses.networking.k8s.io`). */
  resource: string;
  /** The singular kind, as in an object's `kind` field. */
  kind: string;
  label: string;
  group: string;
  namespaced: boolean;
  columns: Column[];
}

/** Sorts youngest first: by the timestamp, newest at the top. */
const byTime = (ts: string | undefined) => -(Date.parse(ts ?? "") || 0);
const AGE: Column = {
  title: "Age", get: (o, now) => age(o.metadata.creationTimestamp, now), mono: true,
  sortKey: (o) => byTime(o.metadata.creationTimestamp),
};
const n = (v: unknown) => String(v ?? 0);
const count = (o: Obj, field: "data" | "stringData") => String(Object.keys(o[field] ?? {}).length);

const ACCESS: Record<string, string> = {
  ReadWriteOnce: "RWO", ReadOnlyMany: "ROX", ReadWriteMany: "RWX", ReadWriteOncePod: "RWOP",
};
const modes = (o: Obj) => ((o.spec?.accessModes ?? []) as string[]).map((m) => ACCESS[m] ?? m).join(",");

function servicePorts(o: Obj): string {
  return ((o.spec?.ports ?? []) as { port: number; nodePort?: number; protocol?: string }[])
    .map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ""}/${p.protocol ?? "TCP"}`).join(",");
}

function externalIp(o: Obj): string {
  const lb = ((o.status?.loadBalancer?.ingress ?? []) as { ip?: string; hostname?: string }[])
    .map((i) => i.ip || i.hostname).filter(Boolean);
  const ips = [...lb, ...(o.spec?.externalIPs ?? [])];
  if (ips.length) return ips.join(",");
  return o.spec?.type === "LoadBalancer" ? "<pending>" : "<none>";
}

/** A node's STATUS: its Ready condition, plus SchedulingDisabled when cordoned. */
export function nodeStatus(o: Obj): string {
  const ready = ((o.status?.conditions ?? []) as { type: string; status: string }[])
    .find((c) => c.type === "Ready");
  const s = ready?.status === "True" ? "Ready" : ready ? "NotReady" : "Unknown";
  return o.spec?.unschedulable ? `${s},SchedulingDisabled` : s;
}

/** A node's ROLES, from its node-role.kubernetes.io/<role> labels. */
export const nodeRoles = (o: Obj) =>
  Object.keys(o.metadata.labels ?? {})
    .filter((l) => l.startsWith("node-role.kubernetes.io/"))
    .map((l) => l.slice("node-role.kubernetes.io/".length)).join(",") || "<none>";

function jobDuration(o: Obj, now: number): string {
  const start = o.status?.startTime;
  if (!start) return "";
  const end = o.status?.completionTime ? Date.parse(o.status.completionTime) : now;
  return humanDuration(end - Date.parse(start));
}

/** A job's state: its Complete or Failed condition, else Running. */
export function jobStatus(o: Obj): string {
  const c = ((o.status?.conditions ?? []) as { type: string; status: string }[])
    .find((x) => (x.type === "Complete" || x.type === "Failed") && x.status === "True");
  if (c) return c.type;
  return o.status?.active ? "Running" : "Pending";
}

/** An event's time: when it last happened, which newer events keep in `eventTime` alone. */
export const eventTime = (o: Obj) =>
  o.lastTimestamp || o.series?.lastObservedTime || o.eventTime || o.metadata.creationTimestamp;

const ref = (r: { kind?: string; name?: string } | undefined) => (r ? `${r.kind}/${r.name}` : "");

/** Every built-in kind the sidebar lists, in its order, with the columns kubectl prints for it. */
export const KINDS: Kind[] = [
  { resource: "pods", kind: "Pod", label: "Pods", group: "Workloads", namespaced: true, columns: [
    { title: "Ready", get: podReady, mono: true },
    { title: "Status", get: podStatus, status: true },
    { title: "Restarts", get: (o) => n(podRestarts(o)), mono: true },
    { title: "Node", get: (o) => o.spec?.nodeName ?? "" },
    { title: "IP", get: (o) => o.status?.podIP ?? "", mono: true },
    AGE,
  ] },
  { resource: "deployments", kind: "Deployment", label: "Deployments", group: "Workloads", namespaced: true, columns: [
    { title: "Ready", get: (o) => `${o.status?.readyReplicas ?? 0}/${o.spec?.replicas ?? 0}`, mono: true },
    { title: "Up-to-date", get: (o) => n(o.status?.updatedReplicas), mono: true },
    { title: "Available", get: (o) => n(o.status?.availableReplicas), mono: true },
    AGE,
  ] },
  { resource: "statefulsets", kind: "StatefulSet", label: "Stateful sets", group: "Workloads", namespaced: true, columns: [
    { title: "Ready", get: (o) => `${o.status?.readyReplicas ?? 0}/${o.spec?.replicas ?? 0}`, mono: true },
    AGE,
  ] },
  { resource: "daemonsets", kind: "DaemonSet", label: "Daemon sets", group: "Workloads", namespaced: true, columns: [
    { title: "Desired", get: (o) => n(o.status?.desiredNumberScheduled), mono: true },
    { title: "Current", get: (o) => n(o.status?.currentNumberScheduled), mono: true },
    { title: "Ready", get: (o) => n(o.status?.numberReady), mono: true },
    { title: "Up-to-date", get: (o) => n(o.status?.updatedNumberScheduled), mono: true },
    { title: "Available", get: (o) => n(o.status?.numberAvailable), mono: true },
    AGE,
  ] },
  { resource: "replicasets", kind: "ReplicaSet", label: "Replica sets", group: "Workloads", namespaced: true, columns: [
    { title: "Desired", get: (o) => n(o.spec?.replicas), mono: true },
    { title: "Current", get: (o) => n(o.status?.replicas), mono: true },
    { title: "Ready", get: (o) => n(o.status?.readyReplicas), mono: true },
    AGE,
  ] },
  { resource: "jobs", kind: "Job", label: "Jobs", group: "Workloads", namespaced: true, columns: [
    { title: "Status", get: jobStatus, status: true },
    { title: "Completions", get: (o) => `${o.status?.succeeded ?? 0}/${o.spec?.completions ?? 1}`, mono: true },
    { title: "Duration", get: jobDuration, mono: true },
    AGE,
  ] },
  { resource: "cronjobs", kind: "CronJob", label: "Cron jobs", group: "Workloads", namespaced: true, columns: [
    { title: "Schedule", get: (o) => o.spec?.schedule ?? "", mono: true },
    { title: "Suspend", get: (o) => String(!!o.spec?.suspend) },
    { title: "Active", get: (o) => n(o.status?.active?.length), mono: true },
    { title: "Last schedule", get: (o, now) => age(o.status?.lastScheduleTime, now), mono: true },
    AGE,
  ] },

  { resource: "services", kind: "Service", label: "Services", group: "Network", namespaced: true, columns: [
    { title: "Type", get: (o) => o.spec?.type ?? "" },
    { title: "Cluster IP", get: (o) => o.spec?.clusterIP ?? "", mono: true },
    { title: "External IP", get: externalIp, mono: true },
    { title: "Ports", get: servicePorts, mono: true },
    AGE,
  ] },
  { resource: "ingresses", kind: "Ingress", label: "Ingresses", group: "Network", namespaced: true, columns: [
    { title: "Class", get: (o) => o.spec?.ingressClassName ?? "<none>" },
    { title: "Hosts", get: (o) => ((o.spec?.rules ?? []) as { host?: string }[]).map((r) => r.host ?? "*").join(",") || "*" },
    { title: "Address", get: (o) => ((o.status?.loadBalancer?.ingress ?? []) as { ip?: string; hostname?: string }[]).map((i) => i.ip || i.hostname).join(","), mono: true },
    { title: "Ports", get: (o) => (o.spec?.tls?.length ? "80, 443" : "80"), mono: true },
    AGE,
  ] },
  { resource: "endpoints", kind: "Endpoints", label: "Endpoints", group: "Network", namespaced: true, columns: [
    { title: "Endpoints", get: endpointsText, mono: true },
    AGE,
  ] },
  { resource: "networkpolicies", kind: "NetworkPolicy", label: "Network policies", group: "Network", namespaced: true, columns: [
    { title: "Pod selector", get: (o) => selectorText(o.spec?.podSelector) || "<none>", mono: true },
    AGE,
  ] },

  { resource: "configmaps", kind: "ConfigMap", label: "Config maps", group: "Config", namespaced: true, columns: [
    { title: "Data", get: (o) => count(o, "data"), mono: true },
    AGE,
  ] },
  { resource: "secrets", kind: "Secret", label: "Secrets", group: "Config", namespaced: true, columns: [
    { title: "Type", get: (o) => o.type ?? "" },
    { title: "Data", get: (o) => count(o, "data"), mono: true },
    AGE,
  ] },
  { resource: "horizontalpodautoscalers", kind: "HorizontalPodAutoscaler", label: "Autoscalers", group: "Config", namespaced: true, columns: [
    { title: "Reference", get: (o) => ref(o.spec?.scaleTargetRef) },
    { title: "Min", get: (o) => n(o.spec?.minReplicas ?? 1), mono: true },
    { title: "Max", get: (o) => n(o.spec?.maxReplicas), mono: true },
    { title: "Replicas", get: (o) => n(o.status?.currentReplicas), mono: true },
    AGE,
  ] },
  { resource: "poddisruptionbudgets", kind: "PodDisruptionBudget", label: "Disruption budgets", group: "Config", namespaced: true, columns: [
    { title: "Min available", get: (o) => String(o.spec?.minAvailable ?? "N/A"), mono: true },
    { title: "Max unavailable", get: (o) => String(o.spec?.maxUnavailable ?? "N/A"), mono: true },
    { title: "Allowed", get: (o) => n(o.status?.disruptionsAllowed), mono: true },
    AGE,
  ] },
  { resource: "resourcequotas", kind: "ResourceQuota", label: "Resource quotas", group: "Config", namespaced: true, columns: [AGE] },
  { resource: "limitranges", kind: "LimitRange", label: "Limit ranges", group: "Config", namespaced: true, columns: [AGE] },

  { resource: "persistentvolumeclaims", kind: "PersistentVolumeClaim", label: "Volume claims", group: "Storage", namespaced: true, columns: [
    { title: "Status", get: (o) => o.status?.phase ?? "", status: true },
    { title: "Volume", get: (o) => o.spec?.volumeName ?? "" },
    { title: "Capacity", get: (o) => o.status?.capacity?.storage ?? "", mono: true },
    { title: "Access", get: modes, mono: true },
    { title: "Storage class", get: (o) => o.spec?.storageClassName ?? "" },
    AGE,
  ] },
  { resource: "persistentvolumes", kind: "PersistentVolume", label: "Volumes", group: "Storage", namespaced: false, columns: [
    { title: "Capacity", get: (o) => o.spec?.capacity?.storage ?? "", mono: true },
    { title: "Access", get: modes, mono: true },
    { title: "Reclaim", get: (o) => o.spec?.persistentVolumeReclaimPolicy ?? "" },
    { title: "Status", get: (o) => o.status?.phase ?? "", status: true },
    { title: "Claim", get: (o) => (o.spec?.claimRef ? `${o.spec.claimRef.namespace}/${o.spec.claimRef.name}` : "") },
    { title: "Storage class", get: (o) => o.spec?.storageClassName ?? "" },
    AGE,
  ] },
  { resource: "storageclasses", kind: "StorageClass", label: "Storage classes", group: "Storage", namespaced: false, columns: [
    { title: "Provisioner", get: (o) => o.provisioner ?? "" },
    { title: "Reclaim", get: (o) => o.reclaimPolicy ?? "Delete" },
    { title: "Binding", get: (o) => o.volumeBindingMode ?? "Immediate" },
    AGE,
  ] },

  { resource: "serviceaccounts", kind: "ServiceAccount", label: "Service accounts", group: "Access control", namespaced: true, columns: [AGE] },
  { resource: "roles", kind: "Role", label: "Roles", group: "Access control", namespaced: true, columns: [AGE] },
  { resource: "rolebindings", kind: "RoleBinding", label: "Role bindings", group: "Access control", namespaced: true, columns: [
    { title: "Role", get: (o) => ref(o.roleRef) },
    AGE,
  ] },
  { resource: "clusterroles", kind: "ClusterRole", label: "Cluster roles", group: "Access control", namespaced: false, columns: [AGE] },
  { resource: "clusterrolebindings", kind: "ClusterRoleBinding", label: "Cluster role bindings", group: "Access control", namespaced: false, columns: [
    { title: "Role", get: (o) => ref(o.roleRef) },
    AGE,
  ] },

  { resource: "nodes", kind: "Node", label: "Nodes", group: "Cluster", namespaced: false, columns: [
    { title: "Status", get: nodeStatus, status: true },
    { title: "Roles", get: nodeRoles },
    { title: "Version", get: (o) => o.status?.nodeInfo?.kubeletVersion ?? "", mono: true },
    { title: "Internal IP", get: (o) => ((o.status?.addresses ?? []) as { type: string; address: string }[]).find((a) => a.type === "InternalIP")?.address ?? "", mono: true },
    AGE,
  ] },
  { resource: "namespaces", kind: "Namespace", label: "Namespaces", group: "Cluster", namespaced: false, columns: [
    { title: "Status", get: (o) => o.status?.phase ?? "", status: true },
    AGE,
  ] },
  { resource: "events", kind: "Event", label: "Events", group: "Cluster", namespaced: true, columns: [
    { title: "Type", get: (o) => o.type ?? "", status: true },
    { title: "Reason", get: (o) => o.reason ?? "" },
    { title: "Object", get: (o) => ref(o.involvedObject) },
    { title: "Message", get: (o) => o.message ?? "" },
    { title: "Count", get: (o) => n(o.count ?? o.series?.count ?? 1), mono: true },
    { title: "Last seen", get: (o, now) => age(eventTime(o), now), mono: true, sortKey: (o) => byTime(eventTime(o)) },
  ] },
];

export const kindByResource = (r: string, extra: Kind[] = []) =>
  KINDS.find((k) => k.resource === r) ?? extra.find((k) => k.resource === r);

function endpointsText(o: Obj): string {
  const out: string[] = [];
  for (const s of (o.subsets ?? []) as { addresses?: { ip: string }[]; ports?: { port: number }[] }[]) {
    for (const a of s.addresses ?? []) for (const p of s.ports ?? [{ port: 0 }]) out.push(p.port ? `${a.ip}:${p.port}` : a.ip);
  }
  if (!out.length) return "<none>";
  return out.length > 3 ? `${out.slice(0, 3).join(",")} + ${out.length - 3} more` : out.join(",");
}

/** A label selector as `k=v,k2=v2`, the way kubectl prints one. */
export function selectorText(sel: { matchLabels?: Record<string, string> } | Record<string, string> | undefined): string {
  if (!sel) return "";
  const labels = "matchLabels" in sel ? (sel.matchLabels as Record<string, string>) : (sel as Record<string, string>);
  return Object.entries(labels ?? {}).map(([k, v]) => `${k}=${v}`).join(",");
}

/** What can be done to an object of a kind, beyond Edit and Delete which every kind has. */
export function kindActions(kind: string): ("logs" | "shell" | "forward" | "scale" | "restart" | "trigger" | "suspend" | "cordon" | "drain")[] {
  switch (kind) {
    case "Pod": return ["logs", "shell", "forward"];
    case "Deployment": case "StatefulSet": return ["scale", "restart"];
    case "ReplicaSet": return ["scale"];
    case "DaemonSet": return ["restart"];
    case "Service": return ["forward"];
    case "CronJob": return ["trigger", "suspend"];
    case "Node": return ["cordon", "drain"];
    default: return [];
  }
}

// ---- custom resources ------------------------------------------------------------------------

interface PrinterColumn { name: string; type: string; jsonPath: string; priority?: number }

/**
 * The kinds a cluster's CustomResourceDefinitions add, from `kubectl get crd -o json`, with
 * their `additionalPrinterColumns` (the served storage version's) as columns. Wide-only columns
 * (priority above 0) are left out, as kubectl leaves them out without `-o wide`.
 */
export function crdKinds(list: { items?: Obj[] }): Kind[] {
  return (list.items ?? []).map((c) => {
    const versions = (c.spec?.versions ?? []) as { name: string; served: boolean; storage: boolean; additionalPrinterColumns?: PrinterColumn[] }[];
    const v = versions.find((x) => x.storage) ?? versions.find((x) => x.served) ?? versions[0];
    const printer = (v?.additionalPrinterColumns ?? []).filter((p) => !p.priority);
    const columns: Column[] = printer.map((p) => ({
      title: p.name,
      get: (o: Obj, now: number) => {
        const val = jsonPath(o, p.jsonPath);
        if (val === undefined || val === null) return "";
        return p.type === "date" ? age(String(val), now) : typeof val === "object" ? JSON.stringify(val) : String(val);
      },
      mono: p.type === "integer" || p.type === "number",
      sortKey: p.type === "date" ? (o: Obj) => byTime(String(jsonPath(o, p.jsonPath) ?? "")) : undefined,
    }));
    if (!printer.some((p) => p.name.toLowerCase() === "age")) columns.push(AGE);
    return {
      resource: `${c.spec.names.plural}.${c.spec.group}`,
      kind: c.spec.names.kind,
      label: c.spec.names.kind,
      group: c.spec.group,
      namespaced: c.spec.scope === "Namespaced",
      columns,
    } satisfies Kind;
  }).sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
}

/**
 * The subset of JSONPath that printer columns use: `.a.b`, `.a[0].b`, `.a['b.c']`, and a filter
 * on one field, `.conditions[?(@.type=="Ready")].status`. A path that does not resolve is
 * undefined, which the column shows as empty.
 */
export function jsonPath(o: unknown, path: string): unknown {
  const re = /\.([A-Za-z0-9_$-]+)|\[(\d+)\]|\[['"]([^'"]+)['"]\]|\[\?\(@\.([A-Za-z0-9_.-]+)\s*==\s*['"]([^'"]*)['"]\)\]/g;
  let cur: unknown = o;
  let m: RegExpExecArray | null;
  let at = 0;
  const p = path.trim().replace(/^\{|\}$/g, "");
  while ((m = re.exec(p))) {
    if (m.index !== at) return undefined;
    at = re.lastIndex;
    if (cur === undefined || cur === null) return undefined;
    if (m[1] !== undefined || m[3] !== undefined) cur = (cur as Record<string, unknown>)[m[1] ?? m[3]];
    else if (m[2] !== undefined) cur = (cur as unknown[])[Number(m[2])];
    else {
      if (!Array.isArray(cur)) return undefined;
      const field = m[4], want = m[5];
      cur = cur.find((x) => String(jsonPath(x, `.${field}`)) === want);
    }
  }
  return at === p.length ? cur : undefined;
}

// ---- kubectl's output --------------------------------------------------------------------------

/**
 * Splits the stream `kubectl get -w -o json` prints into its objects. With --output-watch-events
 * (kubectl 1.36) each event is one compact line. Older ones pretty-print an object over many lines,
 * and there the only line that is a bare `}` is its closing brace at the top level (anything
 * nested is indented), so that is where one ends.
 */
export function jsonSplitter(): (line: string) => unknown[] {
  let buf: string[] = [];
  return (line) => {
    const l = line.replace(/\r$/, "");
    if (!buf.length && !l.startsWith("{")) return [];
    if (!buf.length && l.startsWith("{") && l.endsWith("}")) {
      try { return [JSON.parse(l)]; } catch { /* the start of a pretty-printed one after all */ }
    }
    buf.push(l);
    if (l !== "}") return [];
    const text = buf.join("\n");
    buf = [];
    try { return [JSON.parse(text)]; } catch { return []; }
  };
}

export interface WatchEvent { type: "ADDED" | "MODIFIED" | "DELETED" | "BOOKMARK" | "ERROR"; object: Obj }

/** Applies one watch event to the rows held for a kind. Returns whether anything changed. */
export function applyEvent(rows: Map<string, Obj>, ev: WatchEvent): boolean {
  if (!ev?.object?.metadata) return false;
  const key = objKey(ev.object);
  if (ev.type === "DELETED") return rows.delete(key);
  if (ev.type !== "ADDED" && ev.type !== "MODIFIED") return false;
  const prev = rows.get(key);
  if (prev && prev.metadata.resourceVersion && prev.metadata.resourceVersion === ev.object.metadata.resourceVersion) {
    return false;
  }
  // The server's bookkeeping, often most of the object and shown nowhere: a watch prints it
  // even where `get -o yaml` leaves it out.
  delete ev.object.metadata.managedFields;
  rows.set(key, ev.object);
  return true;
}

export interface KubeConfig {
  contexts?: { name: string; context?: { cluster?: string; namespace?: string; user?: string } }[];
  clusters?: { name: string; cluster?: { server?: string } }[];
  "current-context"?: string;
}

/**
 * `kubectl config view -o json`, reduced to the contexts, the server each one talks to, and which
 * one is current. `file` is the kubeconfig it was read from when it is not the user's own, and
 * becomes part of each context's key.
 */
export function parseContexts(cfg: KubeConfig, file = "") {
  const servers = new Map((cfg.clusters ?? []).map((c) => [c.name, c.cluster?.server ?? ""]));
  return {
    current: cfg["current-context"] ? ctxKey(cfg["current-context"], file) : "",
    contexts: (cfg.contexts ?? []).map((c) => ({
      key: ctxKey(c.name, file),
      name: c.name,
      file,
      cluster: c.context?.cluster ?? "",
      server: servers.get(c.context?.cluster ?? "") ?? "",
      namespace: c.context?.namespace ?? "",
    })),
  };
}

/**
 * A server address that only means something on the server itself: what k3s and kubeadm write
 * into the kubeconfig they leave there. From this PC it has to be the server's own address.
 */
export const isLocalServer = (server: string) =>
  /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|0\.0\.0\.0|\[::1?\])(:|\/|$)/i.test(server.trim());

/** The address a local server address should become: the same scheme and port on `host`. */
export function serverOn(server: string, host: string): string {
  const m = /^(https?:\/\/)(?:\[[^\]]*\]|[^:/]+)(.*)$/i.exec(server.trim());
  const h = host.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  return m ? `${m[1]}${h}${m[2]}` : server;
}

export interface Usage { cpu: number; memory: number }

/**
 * `kubectl top pods -A --no-headers` (namespace, name, cpu, memory) or `kubectl top nodes
 * --no-headers` (name, cpu, cpu%, memory, memory%), keyed the way rows are: `ns/name`, or `/name`
 * for a node.
 */
export function parseTop(text: string, nodes: boolean): Map<string, Usage> {
  const out = new Map<string, Usage>();
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (nodes ? f.length < 4 : f.length < 4) continue;
    const [key, cpu, mem] = nodes ? [`/${f[0]}`, f[1], f[3]] : [`${f[0]}/${f[1]}`, f[2], f[3]];
    const u = { cpu: parseQuantity(cpu), memory: parseQuantity(mem) };
    if (isFinite(u.cpu) && isFinite(u.memory)) out.set(key, u);
  }
  return out;
}

/**
 * What was typed for a port-forward: `8080:80` (local, remote), `80` (the same port both sides)
 * or `:80` (any free local port). Null when it is not one of those.
 */
export function parsePorts(s: string): { local: number | ""; remote: number } | null {
  const m = /^\s*(\d*)\s*(?::\s*(\d+))?\s*$/.exec(s);
  if (!m || (!m[1] && !m[2])) return null;
  const ok = (p: number) => p > 0 && p < 65536;
  if (m[2] === undefined) return ok(+m[1]) ? { local: +m[1], remote: +m[1] } : null;
  const remote = +m[2];
  if (!ok(remote) || (m[1] && !ok(+m[1]))) return null;
  return { local: m[1] ? +m[1] : "", remote };
}

/** "Forwarding from 127.0.0.1:54321 -> 80": the local port kubectl chose, or null. */
export function forwardedPort(line: string): number | null {
  const m = /Forwarding from (?:127\.0\.0\.1|\[::1\]|localhost):(\d+) ->/.exec(line);
  return m ? Number(m[1]) : null;
}

/** A Secret's value: base64 as stored, decoded as UTF-8. Bytes that are not text stay base64. */
export function decodeSecret(b64: string): { text: string; binary: boolean } {
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), binary: false };
  } catch {
    return { text: b64, binary: true };
  }
}

// ---- kubectl's arguments -------------------------------------------------------------------------

/** A server address's host and port, as an `ssh -L` target takes them. HTTPS's port when none is given. */
export function serverHostPort(server: string): { host: string; port: number } | null {
  const m = /^https?:\/\/(\[[^\]]+\]|[^:/]+)(?::(\d+))?/i.exec(server.trim());
  return m ? { host: m[1], port: m[2] ? Number(m[2]) : 443 } : null;
}

/**
 * A cluster reached through SSH: `ssh -L` from a port on this PC to the API server's address as
 * the server itself sees it (127.0.0.1:6443 for k3s). The kubeconfig then points at the local
 * end, with the original host as its TLS server name, so the API server's certificate still
 * matches.
 */
export interface Tunnel {
  /** The kubeconfig's cluster entry it serves, whose server address is the local end. */
  cluster: string;
  /** What comes after `ssh`: an alias from ~/.ssh/config, or user@host. */
  host: string;
  /** The API server as the SSH host reaches it, `host:port`. */
  target: string;
  /** The local port the kubeconfig points at. */
  port: number;
}

export const tunnelServer = (port: number) => `https://127.0.0.1:${port}`;

/** A local port for a new tunnel, away from the ports dev servers favour. */
export const tunnelPort = (random = Math.random()) => 20000 + Math.floor(random * 20000);

/**
 * Whether ssh's output says the forward is open, or that its local port was taken. Not "Local
 * forwarding listening on": Windows' OpenSSH prints that before the bind, and then fails it
 * ("bind [127.0.0.1]:N: Permission denied"). "Entering interactive session" comes only once every
 * forward is set up, and with ExitOnForwardFailure never after a failed one.
 */
export const tunnelOpen = (line: string) => /Entering interactive session/.test(line);
export const tunnelBindFailed = (line: string) => /Address already in use|cannot listen to port|Could not request local forwarding/i.test(line);

/**
 * A context, as one string: its name for one in the user's own kubeconfig, `<file>|<name>` for
 * one in a kubeconfig added here. One string so it can be a React dependency and a saved choice
 * as it is. A Windows path cannot hold a `|`, so the first one is always the separator.
 */
export const ctxKey = (name: string, file = "") => (file ? `${file}|${name}` : name);

export function ctxParts(key: string): { file: string; name: string } {
  const i = key.indexOf("|");
  return i < 0 ? { file: "", name: key } : { file: key.slice(0, i), name: key.slice(i + 1) };
}

/**
 * The context goes on every call with `--context`, never through `kubectl config use-context`:
 * choosing a cluster here must not change which one the user's own terminals talk to. A cluster
 * added here also names its own kubeconfig with `--kubeconfig`.
 */
function ctx(key: string, flag = "--context") {
  const { file, name } = ctxParts(key);
  return [...(file ? ["--kubeconfig", file] : []), ...(name ? [flag, name] : [])];
}

/** `-n <ns>` for a namespaced kind in one namespace, `-A` for all of them, nothing otherwise. */
const scope = (namespaced: boolean, ns: string) => (!namespaced ? [] : ns ? ["-n", ns] : ["-A"]);

export const args = {
  contexts: (file = "") => ["config", "view", "-o", "json", ...(file ? ["--kubeconfig", file] : [])],
  setServer: (file: string, cluster: string, server: string, tlsName?: string) =>
    ["config", "set-cluster", cluster, `--server=${server}`, ...(tlsName ? [`--tls-server-name=${tlsName}`] : []), "--kubeconfig", file],
  /** The SSH tunnel, with the options Deck's own SSH uses: keys only (no prompt can be answered),
   *  and kept alive. `-v` prints the line that says the forwards are set up. */
  tunnel: (t: Tunnel) => [
    "-N", "-v", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3", "-o", "ExitOnForwardFailure=yes",
    "-L", `127.0.0.1:${t.port}:${t.target}`, t.host,
  ],
  /** Whether the cluster answers: the server's version, waiting at most a few seconds. */
  ping: (c: string) => ["version", "-o", "json", "--request-timeout=8s", ...ctx(c)],
  events: (c: string, ns: string | undefined, uid: string) =>
    ["get", "events", ...(ns ? ["-n", ns] : ["-A"]), "--field-selector", `involvedObject.uid=${uid}`, "-o", "json", ...ctx(c)],
  namespaces: (c: string) => ["get", "namespaces", "-o", "json", ...ctx(c)],
  crds: (c: string) => ["get", "customresourcedefinitions", "-o", "json", ...ctx(c)],
  /** The rows of a kind: the list first, as ADDED events, then every change, until killed. */
  watch: (c: string, k: Kind, ns: string) =>
    ["get", k.resource, ...scope(k.namespaced, ns), "--watch", "--output-watch-events", "-o", "json", ...ctx(c)],
  list: (c: string, resource: string, namespaced: boolean, ns: string) =>
    ["get", resource, ...scope(namespaced, ns), "-o", "json", ...ctx(c)],
  get: (c: string, resource: string, name: string, ns: string | undefined, format: "json" | "yaml") =>
    ["get", resource, name, ...(ns ? ["-n", ns] : []), "-o", format, ...ctx(c)],
  /** Writes an edited object back. `replace` keeps the resourceVersion as a lock, so an object
   *  changed since it was opened is refused rather than overwritten. */
  replace: (c: string, file: string) => ["replace", "-f", file, ...ctx(c)],
  apply: (c: string, file: string) => ["apply", "-f", file, ...ctx(c)],
  delete: (c: string, resource: string, name: string, ns: string | undefined) =>
    ["delete", resource, name, ...(ns ? ["-n", ns] : []), "--wait=false", ...ctx(c)],
  scale: (c: string, resource: string, name: string, ns: string, replicas: number) =>
    ["scale", resource, name, "-n", ns, `--replicas=${replicas}`, ...ctx(c)],
  restart: (c: string, resource: string, name: string, ns: string) =>
    ["rollout", "restart", `${resource}/${name}`, "-n", ns, ...ctx(c)],
  trigger: (c: string, name: string, ns: string, job: string) =>
    ["create", "job", job, `--from=cronjob/${name}`, "-n", ns, ...ctx(c)],
  suspend: (c: string, name: string, ns: string, on: boolean) =>
    ["patch", "cronjob", name, "-n", ns, "-p", JSON.stringify({ spec: { suspend: on } }), ...ctx(c)],
  cordon: (c: string, node: string, on: boolean) => [on ? "cordon" : "uncordon", node, ...ctx(c)],
  drain: (c: string, node: string) =>
    ["drain", node, "--ignore-daemonsets", "--delete-emptydir-data", "--timeout=120s", ...ctx(c)],
  logs: (c: string, pod: string, ns: string, container: string, o: { follow: boolean; previous: boolean; tail: number; timestamps: boolean }) => [
    "logs", pod, "-n", ns, "-c", container, `--tail=${o.tail}`,
    ...(o.follow && !o.previous ? ["-f"] : []), ...(o.previous ? ["--previous"] : []),
    ...(o.timestamps ? ["--timestamps"] : []), ...ctx(c),
  ],
  /** `local` empty lets kubectl choose a free port, which it then prints. */
  portForward: (c: string, target: string, ns: string, local: number | "", remote: number) =>
    ["port-forward", target, "-n", ns, `${local}:${remote}`, ...ctx(c)],
  top: (c: string, nodes: boolean) =>
    nodes ? ["top", "nodes", "--no-headers", ...ctx(c)] : ["top", "pods", "-A", "--no-headers", ...ctx(c)],
};

/** One argument for a terminal's command line, quoted when it needs to be. */
const q = (s: string) => (/^[\w./:@=-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);

/**
 * The command a terminal runs for a shell in a container: bash when the image has it, sh
 * otherwise. Quoted so PowerShell, cmd and bash all hand `sh -c` the same one argument.
 */
export function shellCommand(c: string, pod: string, ns: string, container: string): string {
  return ["kubectl", ...ctx(c), "exec", "-it", "-n", ns, pod, "-c", container, "--"]
    .map(q).join(" ") + ` sh -c "command -v bash >/dev/null && exec bash || exec sh"`;
}

// ---- helm ------------------------------------------------------------------------------------

export interface Release {
  name: string; namespace: string; revision: string; updated: string;
  status: string; chart: string; app_version: string;
}

export interface Revision {
  revision: number; updated: string; status: string; chart: string; app_version: string; description: string;
}

const kctx = (c: string) => ctx(c, "--kube-context");

export const helmArgs = {
  list: (c: string, ns: string) => ["list", ...(ns ? ["-n", ns] : ["-A"]), "-o", "json", ...kctx(c)],
  history: (c: string, name: string, ns: string) => ["history", name, "-n", ns, "-o", "json", ...kctx(c)],
  values: (c: string, name: string, ns: string, all: boolean) =>
    ["get", "values", name, "-n", ns, ...(all ? ["--all"] : []), "-o", "yaml", ...kctx(c)],
  manifest: (c: string, name: string, ns: string) => ["get", "manifest", name, "-n", ns, ...kctx(c)],
  rollback: (c: string, name: string, ns: string, rev: number) =>
    ["rollback", name, String(rev), "-n", ns, "--wait=false", ...kctx(c)],
  uninstall: (c: string, name: string, ns: string) => ["uninstall", name, "-n", ns, ...kctx(c)],
};

/** helm's `updated` ("2026-10-22 10:01:02.123 +0000 UTC") as something Date.parse reads. */
export function helmTime(s: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? ([+-]\d{2})(\d{2})/.exec(s);
  return m ? `${m[1]}T${m[2]}${m[3]}:${m[4]}` : s;
}

// ---- the overview ------------------------------------------------------------------------------

/** Pods counted by the tone of their status, for the cluster overview. */
export function podSummary(pods: Obj[]): Record<Tone, number> {
  const out: Record<Tone, number> = { green: 0, amber: 0, red: 0, blue: 0, muted: 0 };
  for (const p of pods) out[statusTone(podStatus(p))]++;
  return out;
}

/** What the nodes can hold: allocatable CPU (cores) and memory (bytes), added up. */
export function allocatable(nodes: Obj[]): Usage {
  let cpu = 0, memory = 0;
  for (const nd of nodes) {
    cpu += parseQuantity(nd.status?.allocatable?.cpu) || 0;
    memory += parseQuantity(nd.status?.allocatable?.memory) || 0;
  }
  return { cpu, memory };
}

/** What the pods ask for: their containers' requests, added up. */
export function requested(pods: Obj[]): Usage {
  let cpu = 0, memory = 0;
  for (const p of pods) {
    const phase = p.status?.phase;
    if (phase === "Succeeded" || phase === "Failed") continue;
    for (const c of (p.spec?.containers ?? []) as { resources?: { requests?: Record<string, string> } }[]) {
      cpu += parseQuantity(c.resources?.requests?.cpu) || 0;
      memory += parseQuantity(c.resources?.requests?.memory) || 0;
    }
  }
  return { cpu, memory };
}
