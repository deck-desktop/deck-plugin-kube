// The agent-facing tools for Kubernetes, run by Deck's MCP server in its own Node process.
//
// Every tool runs kubectl itself, against the same clusters the tab shows: the user's own
// kubeconfig, and the kubeconfigs added in the tab (data/kube/, listed in `clusters`). A cluster
// added Through SSH gets a tunnel of this process's own, opened on first use and kept until the
// server exits. kubectl is pointed at it with --server and --tls-server-name rather than by
// writing its port into the kubeconfig, which the tab rewrites for its own tunnel.
//
// The read-only tools are separate from the two that change a cluster (kube_apply, kube_kubectl),
// so an agent's client can allow the first without asking and still ask for the second.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer, connect } from "node:net";
import { writeFileSync, unlinkSync, mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseContexts, tunnelServer, type KubeConfig, type Tunnel } from "./kube.js";
import type { DeckMcp, McpServer } from "deck-plugin-sdk/mcp";

/** The plugin's data folder, where added kubeconfigs are kept: the MCP server's Deck, dev or not. */
const DATA = join(process.env.APPDATA ?? "", process.env.DECK_DEV === "1" ? "Deck-Dev" : "Deck", "data", "kube");

/** Output past this is cut, with a note: an agent reads it all, and a big list is mostly noise. */
const MAX_OUTPUT = 60_000;

interface Run { stdout: string; stderr: string; code: number }

function run(program: string, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(program, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
      (err, stdout, stderr) => resolve({ stdout: String(stdout), stderr: String(stderr), code: err ? (typeof err.code === "number" ? err.code : 1) : 0 }));
  });
}

const cut = (s: string) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n… cut at ${MAX_OUTPUT} characters of ${s.length}` : s);

// ---- SSH tunnels -----------------------------------------------------------------------------

/** A free port on this PC, from the OS. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const answers = (port: number) => new Promise<boolean>((resolve) => {
  const c = connect(port, "127.0.0.1");
  c.once("connect", () => { c.destroy(); resolve(true); });
  c.once("error", () => resolve(false));
});

/** Open tunnels by kubeconfig file: the ssh process and the local port it listens on. */
const tunnels = new Map<string, Promise<{ child: ChildProcess; port: number }>>();
process.once("exit", () => { for (const t of tunnels.values()) void t.then((x) => x.child.kill(), () => {}); });

/**
 * The tunnel for a kubeconfig added Through SSH, open: ssh -N -L with the options Deck's own
 * tunnel uses (keys only, kept alive). Open once the local port answers; a failure says what ssh
 * printed and is forgotten, so the next call tries again.
 */
function tunnelFor(file: string, t: Tunnel) {
  const cur = tunnels.get(file);
  if (cur) return cur;
  const opening = (async () => {
    const port = await freePort();
    const child = spawn("ssh", [
      "-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
      "-L", `127.0.0.1:${port}:${t.target}`, t.host,
    ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr?.on("data", (d) => { err += String(d); });
    let exited = false;
    child.once("exit", () => { exited = true; tunnels.delete(file); });
    for (let i = 0; i < 100 && !exited; i++) {
      if (await answers(port)) return { child, port };
      await new Promise((r) => setTimeout(r, 200));
    }
    child.kill();
    throw new Error(`SSH to ${t.host} did not open a tunnel${err.trim() ? `: ${err.trim()}` : ""}`);
  })();
  tunnels.set(file, opening);
  opening.catch(() => tunnels.delete(file));
  return opening;
}

// ---- contexts --------------------------------------------------------------------------------

interface Ctx { id: string; name: string; file: string; cluster: string; server: string; namespace: string; via?: string }

/**
 * Every context the tab knows, each with an id the tools take: a context's name for one in the
 * user's own kubeconfig, `<kubeconfig file>|<name>` for one added in the tab (two added clusters
 * are often both called "default").
 */
async function contexts(deck: DeckMcp): Promise<{ current: string; list: Ctx[] }> {
  const own = await run("kubectl", ["config", "view", "-o", "json"]);
  const mine = parseContexts(own.code === 0 && own.stdout.trim() ? JSON.parse(own.stdout) as KubeConfig : {});
  const index = deck.readJson<{ files?: string[]; tunnels?: Record<string, Tunnel> }>("clusters", {});
  const list: Ctx[] = mine.contexts.map((c) => ({ ...c, id: c.name }));
  for (const name of index.files ?? []) {
    const file = join(DATA, name);
    const r = await run("kubectl", ["config", "view", "-o", "json", "--kubeconfig", file]);
    if (r.code !== 0) continue;
    for (const c of parseContexts(JSON.parse(r.stdout) as KubeConfig, file).contexts) {
      const t = index.tunnels?.[name];
      list.push({ ...c, id: `${name}|${c.name}`, server: t ? `${t.target} (on ${t.host})` : c.server, via: t ? `ssh ${t.host}` : undefined });
    }
  }
  // The one picked in the tab, as the default: what the user is looking at.
  const prefs = deck.readJson<{ context?: string }>("prefs", {});
  const picked = prefs.context ? list.find((c) => c.file ? `${c.file}|${c.name}` === prefs.context : c.name === prefs.context) : undefined;
  return { current: picked?.id ?? mine.current, list };
}

/**
 * The kubectl flags that reach a context: --context, and for an added one its --kubeconfig, and
 * for one Through SSH this process's tunnel.
 */
async function reach(deck: DeckMcp, id: string | undefined): Promise<string[]> {
  const { current, list } = await contexts(deck);
  const want = id || current;
  const c = list.find((x) => x.id === want);
  if (!c) throw new Error(`No context "${want}". kube_contexts lists them.`);
  if (!c.file) return ["--context", c.name];
  const flags = ["--kubeconfig", c.file, "--context", c.name];
  const index = deck.readJson<{ tunnels?: Record<string, Tunnel> }>("clusters", {});
  const t = index.tunnels?.[c.file.split(/[\\/]/).pop() ?? ""];
  if (!t) return flags;
  const { port } = await tunnelFor(c.file, t);
  return [...flags, "--server", tunnelServer(port), ...(t.tlsName ? ["--tls-server-name", t.tlsName] : [])];
}

// ---- tools -----------------------------------------------------------------------------------

export function register(server: McpServer, deck: DeckMcp) {
  const { z, ok } = deck;

  /** kubectl against a context, its output (cut when long) or what it said went wrong. */
  async function kubectl(context: string | undefined, args: string[]) {
    let flags: string[];
    try { flags = await reach(deck, context); } catch (e) { return ok(String((e as Error).message ?? e)); }
    const r = await run("kubectl", [...args, ...flags]);
    if (r.code !== 0) return ok(`kubectl failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
    return ok(cut(r.stdout.trim() || r.stderr.trim() || "(no output)"));
  }

  const context = z.string().optional()
    .describe("a context id from kube_contexts; the one picked in Deck's Kubernetes tab when left out");
  const namespace = z.string().optional().describe("a namespace; all namespaces when left out, where the kind has them");
  const ns = (n: string | undefined) => (n ? ["-n", n] : ["-A"]);

  server.tool(
    "kube_contexts",
    "List the Kubernetes clusters Deck's Kubernetes tab can reach: the user's own kubeconfig and " +
      "the clusters added in the tab (some through an SSH tunnel). Each has an id the other kube_ " +
      "tools take as `context`; the one marked * is the default.",
    {},
    async () => {
      const { current, list } = await contexts(deck);
      if (!list.length) return ok("No clusters. Add one in Deck's Kubernetes tab, or to ~/.kube/config.");
      return ok(list.map((c) => `${c.id === current ? "*" : " "} ${c.id}  cluster=${c.cluster}  server=${c.server}` +
        `${c.namespace ? `  namespace=${c.namespace}` : ""}${c.via ? `  via ${c.via}` : ""}`).join("\n"));
    },
  );

  server.tool(
    "kube_get",
    "Read resources: kubectl get. A list as kubectl's own table (-o wide), or one object by name as " +
      "YAML. `resource` is anything kubectl takes: pods, deployments, svc, nodes, a custom resource.",
    {
      context,
      resource: z.string().describe("pods, deployments, services, nodes, events, crds, certificates.cert-manager.io, …"),
      name: z.string().optional().describe("one object; omit to list"),
      namespace,
      selector: z.string().optional().describe("a label selector, as -l takes it (app=web)"),
      output: z.enum(["table", "yaml", "json"]).optional().describe("table (default for a list) or yaml (default for one object)"),
    },
    async ({ context: c, resource, name, namespace: n, selector, output }) => {
      const fmt = output ?? (name ? "yaml" : "table");
      return kubectl(c, [
        "get", resource, ...(name ? [name] : []), ...(name ? (n ? ["-n", n] : []) : ns(n)),
        ...(selector ? ["-l", selector] : []), "-o", fmt === "table" ? "wide" : fmt,
      ]);
    },
  );

  server.tool(
    "kube_describe",
    "kubectl describe: an object's state with its recent events, the usual first look at why a pod " +
      "does not start or a deployment does not roll out.",
    { context, resource: z.string(), name: z.string(), namespace: z.string().optional() },
    async ({ context: c, resource, name, namespace: n }) =>
      kubectl(c, ["describe", resource, name, ...(n ? ["-n", n] : [])]),
  );

  server.tool(
    "kube_logs",
    "A pod's log (or a deployment's, as deploy/<name>): the last lines, of one container or all of them.",
    {
      context,
      target: z.string().describe("a pod name, or deploy/<name>, job/<name>, …"),
      namespace: z.string().describe("its namespace"),
      container: z.string().optional().describe("one container; all of them when left out"),
      tail: z.number().int().positive().optional().describe("how many lines from the end (default 200)"),
      previous: z.boolean().optional().describe("the container's log before its last restart (a crash)"),
      since: z.string().optional().describe("only newer than this, as kubectl takes it: 10m, 2h"),
    },
    async ({ context: c, target, namespace: n, container, tail, previous, since }) => kubectl(c, [
      "logs", target, "-n", n, ...(container ? ["-c", container] : ["--all-containers", "--prefix"]),
      `--tail=${tail ?? 200}`, ...(previous ? ["--previous"] : []), ...(since ? [`--since=${since}`] : []),
    ]),
  );

  server.tool(
    "kube_events",
    "Recent cluster events, newest last: warnings show why things fail (image pulls, scheduling, " +
      "probes). Optionally only one object's.",
    {
      context, namespace,
      object: z.string().optional().describe("only this object's, as kind/name (pod/web-0)"),
      warnings: z.boolean().optional().describe("only warnings"),
    },
    async ({ context: c, namespace: n, object, warnings }) => {
      const [kind, name] = object?.split("/") ?? [];
      const sel = [
        ...(name ? [`involvedObject.name=${name}`, ...(kind ? [`involvedObject.kind=${kind[0].toUpperCase()}${kind.slice(1)}`] : [])] : []),
        ...(warnings ? ["type=Warning"] : []),
      ];
      return kubectl(c, ["get", "events", ...ns(n), "--sort-by=.lastTimestamp", ...(sel.length ? ["--field-selector", sel.join(",")] : [])]);
    },
  );

  server.tool(
    "kube_top",
    "CPU and memory in use, by node or by pod (needs metrics-server in the cluster).",
    { context, of: z.enum(["nodes", "pods"]), namespace },
    async ({ context: c, of, namespace: n }) => kubectl(c, ["top", of, ...(of === "pods" ? ns(n) : [])]),
  );

  server.tool(
    "kube_apply",
    "CHANGES THE CLUSTER. Create or update objects from YAML (kubectl apply): one document or several " +
      "separated by ---.",
    { context, yaml: z.string().describe("the manifest") },
    async ({ context: c, yaml }) => {
      // A file rather than stdin, which kubectl on Windows reads unreliably through a pipe.
      const dir = mkdtempSync(join(tmpdir(), "deck-kube-"));
      const file = join(dir, "apply.yaml");
      writeFileSync(file, yaml, "utf8");
      try {
        return await kubectl(c, ["apply", "-f", file]);
      } finally {
        try { unlinkSync(file); rmdirSync(dir); } catch { /* the OS clears its temp folder */ }
      }
    },
  );

  server.tool(
    "kube_kubectl",
    "CHANGES THE CLUSTER (or anything else kubectl does). Run kubectl with these arguments against a " +
      "context: scale, rollout restart / status / undo, delete, cordon, label, patch, … Context " +
      "flags are added; do not pass --context or --kubeconfig. Prefer the read-only kube_ tools for reading.",
    {
      context,
      args: z.array(z.string()).describe('kubectl\'s arguments, one per item: ["scale", "deploy/web", "-n", "prod", "--replicas=3"]'),
    },
    async ({ context: c, args }) => {
      if (args.some((a: string) => /^--(context|kubeconfig|server)(=|$)/.test(a))) {
        return ok("Pass the cluster as `context`, not as --context, --kubeconfig or --server.");
      }
      return kubectl(c, args);
    },
  );
}
