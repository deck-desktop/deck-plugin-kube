// Running kubectl and helm from Deck: one-shot calls through `exec`, live rows through a
// `kubectl get --watch` stream, metrics on a poll, and port-forwards and SSH tunnels, the things
// that outlive the tab and so live here at module scope (stopped by `dispose`).
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  configDelete, configRead, configWrite, dataDir, exec, openExternal, procKill, procStream, sshTunnelClose, sshTunnelOpen,
  type ProcLine, type ProcResult,
} from "deck-plugin-sdk/bridge";
import { listen } from "deck-plugin-sdk/event";
import { dismissNotification, notify } from "deck-plugin-sdk/ui";
import {
  applyEvent, args, ctxParts, editLock, editPatch, editRefusal, forwardedPort, jsonSplitter, parseContexts, parseTop, tunnelGone, tunnelServer,
  type Kind, type KubeConfig, type Obj, type Tunnel, type Usage, type WatchEvent,
} from "./kube";

/** The name Deck's notifications show this plugin's under. */
export const SOURCE = "Kubernetes";

// ---- one-shot calls --------------------------------------------------------------------------

/**
 * The kubeconfig a kubectl or helm call names, when it is one added here: its SSH tunnel, if it
 * has one, has to be open before the call. `kubectl config` only reads and writes the file.
 */
function kubeconfigOf(a: string[]): string {
  if (a[0] === "config") return "";
  const i = a.indexOf("--kubeconfig");
  return i >= 0 ? a[i + 1] : "";
}

/** Runs a program to completion: its stdout, or an error carrying what it printed to stderr. */
async function run(program: string, a: string[]): Promise<string> {
  const file = kubeconfigOf(a);
  if (file) await ensureTunnel(file);
  const out = await exec(program, a);
  if (out.code !== 0) {
    if (file && tunnelGone(out.stderr)) closeTunnel(file);
    throw new Error(out.stderr.trim() || out.stdout.trim() || `${program} exited with ${out.code}`);
  }
  return out.stdout;
}

export const kubectl = (a: string[]) => run("kubectl", a);
export const helm = (a: string[]) => run("helm", a);
export const kubectlJson = async <T = { items: Obj[] }>(a: string[]) => JSON.parse(await kubectl(a)) as T;

/**
 * Whether a program is there at all: cmd.exe reports a missing one as "not recognized". Asks for
 * the client's version only, since kubectl's plain `version` waits on the cluster.
 */
export async function installed(program: string): Promise<boolean> {
  const out = await exec(program, program === "kubectl" ? ["version", "--client"] : ["version"]).catch(() => null);
  return !!out && !/is not recognized|cannot find|not found/i.test(out.stderr);
}

/**
 * Writes `text` to a file kubectl can read, runs `fn` with its path, and removes it after. A
 * Secret being edited goes through here, so the file is never left behind (nor carried along by
 * Deck's backup).
 */
export async function withFile<T>(text: string, fn: (path: string) => Promise<T>, name = "apply.yaml"): Promise<T> {
  await configWrite(name, text);
  try {
    return await fn(`${await dataDir()}\\${name}`);
  } finally {
    await configDelete(name).catch((e) => console.warn("[kube] could not remove the edited file", e));
  }
}

// ---- saving an edit --------------------------------------------------------------------------

/** Somebody changed the object's spec since the edit began; saving anyway writes over it. */
export class EditConflict extends Error {}

/**
 * Saves an edit of an object's YAML (src/kube.ts says why as a patch). `base` is the YAML the edit
 * started from. Unless `force`, an object whose spec changed since then is refused with
 * EditConflict. Resolves with what kubectl said, or "No changes".
 */
export async function saveEdit(context: string, resource: string, base: string, edited: string, force: boolean): Promise<string> {
  const json = await withFile(base, (a) => withFile(edited, (b) => kubectl(args.toJson(context, [a, b])), "edited.yaml"), "original.yaml");
  const split = jsonSplitter();
  const [original, next] = json.split(/\r?\n/).flatMap(split) as Obj[];
  if (!original || !next) throw new Error("kubectl did not read the YAML back.");
  const refused = editRefusal(original, next);
  if (refused) throw new Error(refused);
  const patch = editPatch(original, next);
  if (!patch) return "No changes";
  const ns = original.metadata.namespace;
  if (!force) {
    const current = await kubectlJson<Obj>(args.get(context, resource, original.metadata.name, ns, "json"));
    if (editLock(current) !== editLock(original)) {
      throw new EditConflict("Changed on the server since you opened it: somebody else edited it.");
    }
  }
  // Not a .json name: a JSON file in the data folder would wake Deck's config listeners.
  return withFile(JSON.stringify(patch), (p) => kubectl(args.patch(context, resource, original.metadata.name, ns, p)), "patch.txt");
}

// ---- streams ---------------------------------------------------------------------------------

// One listener for every stream this plugin runs, handing each line to its run by id, rather
// than a listener per run that each hear every line Deck streams.
const handlers = new Map<string, (l: ProcLine) => void>();
const unlisten = listen<ProcLine>("proc-line", (e) => handlers.get(e.payload.id)?.(e.payload));
let seq = 0;

// A stream that waits on a tunnel can be stopped while it waits, and must not start afterwards
// with nobody left to stop it.
const waiting = new Set<string>();
const stopped = new Set<string>();

/** Stops a stream, whether it is running yet or still waiting on its tunnel. */
export function stop(id: string) {
  if (waiting.has(id)) stopped.add(id);
  void procKill(id).catch(() => { /* already ended */ });
}

/** Runs a program, handing each output line to `onLine`, until it exits or is stopped. */
async function stream(id: string, program: string, a: string[], onLine: (l: ProcLine) => void): Promise<ProcResult> {
  const file = kubeconfigOf(a);
  if (file) {
    waiting.add(id);
    try {
      await ensureTunnel(file);
    } catch (e) {
      stopped.delete(id);
      throw e;
    } finally {
      waiting.delete(id);
    }
    if (stopped.delete(id)) return { id, code: 0, cancelled: true };
  }
  handlers.set(id, file
    ? (l) => { if (l.stream === "stderr" && tunnelGone(l.line)) closeTunnel(file); onLine(l); }
    : onLine);
  return procStream(id, program, a).finally(() => handlers.delete(id));
}

export interface Watch { rows: Obj[]; error: string; loading: boolean }

/**
 * The live rows of a kind: `kubectl get --watch`, which lists first and then reports every
 * change, for as long as the tab is open. The server ends a watch after a while; it is started
 * again then, from a fresh list, so a deletion missed in between does not linger.
 */
export function useWatch(context: string, kind: Kind | undefined, ns: string, ready: boolean): Watch {
  const [state, setState] = useState<Watch>({ rows: [], error: "", loading: true });
  useEffect(() => {
    if (!kind || !ready) return;
    let alive = true;
    let id = "";
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const rows = new Map<string, Obj>();
    setState({ rows: [], error: "", loading: true });

    // A burst of events (the first list, a rollout) becomes one render.
    const flush = () => {
      flushTimer = undefined;
      if (alive) setState({ rows: [...rows.values()], error: "", loading: false });
    };
    const start = async () => {
      id = `kube:watch:${++seq}`;
      const split = jsonSplitter();
      let err = "";
      // An SSH cluster's tunnel first, so the wait for rows below starts when they can arrive.
      await ensureContext(context).catch(() => { /* the stream reports it */ });
      if (!alive) return;
      // An empty list prints nothing at all, so "loading" ends on a timer as well as on rows.
      const quiet = setTimeout(() => alive && setState((s) => (s.loading ? { ...s, loading: false } : s)), 2500);
      rows.clear();
      const res = await stream(id, "kubectl", args.watch(context, kind, ns), (l) => {
        if (l.stream === "stderr") { err = err ? `${err}\n${l.line}` : l.line; return; }
        let changed = false;
        for (const ev of split(l.line)) changed = applyEvent(rows, ev as WatchEvent) || changed;
        if (changed && !flushTimer) flushTimer = setTimeout(flush, 80);
      }).catch((e) => ({ code: -1, cancelled: false, err: String(e) }));
      clearTimeout(quiet);
      if (!alive || ("cancelled" in res && res.cancelled)) return;
      const failed = !!err || ("err" in res && !!res.err) || res.code !== 0;
      if (failed) {
        const msg = err || ("err" in res ? String(res.err) : "") || `kubectl exited with ${res.code}`;
        console.warn("[kube] watch failed", kind.resource, msg);
        setState((s) => ({ ...s, error: msg, loading: false }));
      }
      retryTimer = setTimeout(() => { if (alive) void start(); }, failed ? 5000 : 500);
    };
    void start();
    return () => {
      alive = false;
      clearTimeout(flushTimer);
      clearTimeout(retryTimer);
      if (id) stop(id);
    };
  }, [context, kind?.resource, ns, ready]);
  return state;
}

// ---- metrics ---------------------------------------------------------------------------------

export interface Metrics { usage: Map<string, Usage>; error: string }

/**
 * `kubectl top` every 15s while the tab is open and the window visible. Needs metrics-server in
 * the cluster; without it the error says so, and the poll keeps trying in case it is installed.
 */
export function useMetrics(context: string, nodes: boolean, enabled: boolean): Metrics | null {
  const [m, setM] = useState<Metrics | null>(null);
  useEffect(() => {
    if (!enabled) { setM(null); return; }
    let alive = true;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const usage = parseTop(await kubectl(args.top(context, nodes)), nodes);
        if (alive) setM((prev) => (prev && !prev.error && sameUsage(prev.usage, usage) ? prev : { usage, error: "" }));
      } catch (e) {
        const error = String((e as Error).message ?? e);
        if (alive) setM((prev) => (prev?.error === error ? prev : { usage: new Map(), error }));
      }
    };
    void tick();
    const t = setInterval(tick, 15000);
    const onVis = () => { if (!document.hidden) void tick(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { alive = false; clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [context, nodes, enabled]);
  return m;
}

function sameUsage(a: Map<string, Usage>, b: Map<string, Usage>) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) { const w = b.get(k); if (!w || w.cpu !== v.cpu || w.memory !== v.memory) return false; }
  return true;
}

// ---- logs ------------------------------------------------------------------------------------

const MAX_LINES = 5000;

/** A container's log, followed while open. Only the last MAX_LINES are kept. */
export function useLogs(context: string, pod: string, ns: string, container: string,
  o: { previous: boolean; timestamps: boolean; tail: number }) {
  const [lines, setLines] = useState<string[]>([]);
  const [state, setState] = useState<"running" | "ended" | "error">("running");
  useEffect(() => {
    if (!container) return;
    let alive = true;
    const id = `kube:logs:${++seq}`;
    let buf: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLines([]);
    setState("running");
    const flush = () => {
      timer = undefined;
      if (!alive || !buf.length) return;
      const add = buf;
      buf = [];
      setLines((prev) => {
        const next = prev.concat(add);
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    };
    stream(id, "kubectl", args.logs(context, pod, ns, container, { follow: true, ...o }), (l) => {
      buf.push(l.line);
      if (!timer) timer = setTimeout(flush, 100);
    }).then((r) => { if (alive) { flush(); setState(r.code === 0 || r.cancelled ? "ended" : "error"); } },
      (e) => { console.warn("[kube] logs failed", e); if (alive) setState("error"); });
    return () => { alive = false; clearTimeout(timer); stop(id); };
  }, [context, pod, ns, container, o.previous, o.timestamps, o.tail]);
  return { lines, state, clear: () => setLines([]) };
}

// ---- port-forwards ---------------------------------------------------------------------------

export interface Forward {
  id: string;
  context: string;
  ns: string;
  /** `pod/name` or `svc/name`. */
  target: string;
  remote: number;
  local: number | null;
  state: "starting" | "open" | "failed";
  error: string;
}

let forwards: Forward[] = [];
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const patch = (id: string, p: Partial<Forward>) => {
  forwards = forwards.map((f) => (f.id === id ? { ...f, ...p } : f));
  emit();
};

export function useForwards(): Forward[] {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => forwards);
}

/**
 * Forwards a local port to a pod's or a service's, until stopped. `local` empty lets kubectl pick
 * a free one, which it prints and this reads back. Runs on whether or not the tab is open.
 */
export function startForward(context: string, ns: string, target: string, remote: number, local: number | "") {
  const id = `kube:forward:${++seq}`;
  forwards = [...forwards, { id, context, ns, target, remote, local: local || null, state: "starting", error: "" }];
  emit();
  let err = "";
  let told = false;
  const failed = (error: string) => {
    patch(id, { state: "failed", error });
    notify({ kind: "error", source: SOURCE, key: id, title: `Port-forward ${target} stopped`, body: error });
  };
  stream(id, "kubectl", args.portForward(context, target, ns, local, remote), (l) => {
    const port = forwardedPort(l.line);
    if (port) {
      patch(id, { local: port, state: "open" });
      // kubectl prints a line for each address it listens on (127.0.0.1, [::1]): say it once.
      if (!told) {
        told = true;
        notify({
          kind: "activity", source: SOURCE, key: id, title: `Forwarding ${target}`, body: `localhost:${port} to port ${remote}`,
          actions: [{ label: "Open", primary: true, run: () => void openExternal(`http://localhost:${port}`) }],
        });
      }
    } else if (l.stream === "stderr") err = l.line;
  }).then((r) => {
    if (r.cancelled) return;
    console.warn("[kube] port-forward ended", target, err);
    failed(err || `kubectl exited with ${r.code}`);
  }, (e) => {
    console.warn("[kube] port-forward failed", target, e);
    failed(String(e));
  });
}

export function stopForward(id: string) {
  forwards = forwards.filter((f) => f.id !== id);
  emit();
  stop(id);
  // Its card and bell row offered to open a port that is now closed.
  dismissNotification(SOURCE, id);
}

// ---- clusters --------------------------------------------------------------------------------

export type Context = ReturnType<typeof parseContexts>["contexts"][number];

/**
 * Kubeconfigs added in this tool, as Lens keeps them: each one a file in the plugin's own folder,
 * named in the `clusters` config, and passed to kubectl with --kubeconfig. The user's own
 * kubeconfig is read as well and never written.
 */
interface Index { files: string[]; tunnels: Record<string, Tunnel> }

/** The `clusters` config as last read or written: the files, and the tunnel of each that has one. */
let index: Index = { files: [], tunnels: {} };

async function readIndex(): Promise<Index> {
  const raw = await configRead("clusters").catch((e) => { console.warn("[kube] could not read the added clusters", e); return ""; });
  try {
    const p = raw.trim() ? JSON.parse(raw) : {};
    index = { files: p.files ?? [], tunnels: p.tunnels ?? {} };
  } catch {
    index = { files: [], tunnels: {} };
  }
  return index;
}

async function writeIndex(next: Index) {
  index = next;
  await configWrite("clusters", JSON.stringify(next));
}

const fileName = (path: string) => path.slice(path.lastIndexOf("\\") + 1);

// ---- SSH tunnels -----------------------------------------------------------------------------
//
// A cluster whose API port is not open to this PC is reached through Deck's SSH tunnel, opened the
// first time a call names its kubeconfig and shared by every call after it. It stays open until
// Deck exits or the plugin reloads; when it drops, the call that finds it gone closes it, and the
// next one opens a new one.

/** Tunnels of kubeconfigs being added, not yet in the index. */
const stagedTunnels = new Map<string, Tunnel>();
const tunnelFor = (file: string) => index.tunnels[fileName(file)] ?? stagedTunnels.get(fileName(file));

/** The SSH host a cluster added here is reached through, if any. */
export const tunnelHost = (file: string) => (file ? tunnelFor(file)?.host : undefined);

interface Open { id: number | null; ready: Promise<void>; failedAt?: number }
const open = new Map<string, Open>();

/** The tunnel a context needs, open: for a shell, which kubectl runs in a terminal rather than here. */
export function ensureContext(key: string): Promise<void> {
  const { file } = ctxParts(key);
  return file ? ensureTunnel(file) : Promise.resolve();
}

function ensureTunnel(file: string): Promise<void> {
  const t = tunnelFor(file);
  if (!t) return Promise.resolve();
  const cur = open.get(file);
  // A failure is answered for a few seconds rather than retried by every call that was waiting.
  if (cur && !(cur.failedAt && Date.now() - cur.failedAt > 5000)) return cur.ready;

  const entry: Open = { id: null, ready: Promise.resolve() };
  entry.ready = (async () => {
    const [id, port] = await sshTunnelOpen(t.host, t.target);
    // Closed while it opened (the tab, a Back, the cluster removed): nobody is left to use it, and
    // writing the port would make kubectl create the deleted kubeconfig anew, holding only that.
    if (open.get(file) !== entry || !tunnelFor(file)) { void sshTunnelClose(id).catch(() => {}); return; }
    entry.id = id;
    // Deck picks a free port for each tunnel, so the kubeconfig follows it.
    await run("kubectl", args.setServer(file, t.cluster, tunnelServer(port), t.tlsName));
  })().catch((e) => {
    entry.failedAt = Date.now();
    console.warn("[kube] ssh tunnel failed", t.host, e);
    throw new Error(`SSH to ${t.host} failed: ${String((e as Error).message ?? e)}`);
  });
  open.set(file, entry);
  return entry.ready;
}

function closeTunnel(file: string) {
  const o = open.get(file);
  if (!o) return;
  open.delete(file);
  if (o.id !== null) void sshTunnelClose(o.id).catch(() => { /* already gone */ });
}

/** Drops the tunnel of a kubeconfig being added, which is to be reached directly after all. */
export function unstageTunnel(file: string) {
  closeTunnel(file);
  stagedTunnels.delete(fileName(file));
}

/** Makes a kubeconfig being added reach its cluster through SSH, from its next call on. */
export function stageTunnel(file: string, t: Tunnel) {
  closeTunnel(file);
  stagedTunnels.set(fileName(file), t);
}

/** Every context: the user's own kubeconfig's, then those of the kubeconfigs added here. */
export async function loadContexts(): Promise<{ current: string; contexts: Context[] }> {
  const own = parseContexts(await kubectlJson<KubeConfig>(args.contexts()).catch((e) => {
    console.warn("[kube] could not read the kubeconfig", e);
    return {};
  }));
  const dir = await dataDir();
  const added = await Promise.all((await readIndex()).files.map((n) => {
    const file = `${dir}\\${n}`;
    return kubectlJson<KubeConfig>(args.contexts(file)).then((c) => parseContexts(c, file).contexts, (e) => {
      console.warn("[kube] could not read an added kubeconfig", file, e);
      return [];
    });
  }));
  return { current: own.current, contexts: [...own.contexts, ...added.flat()] };
}

/** Writes a pasted kubeconfig to a file of its own, not yet listed: its path and what it names. */
export async function stageKubeconfig(text: string): Promise<{ file: string; contexts: Context[] }> {
  const name = `kubeconfig-${Date.now().toString(36)}.yaml`;
  await configWrite(name, text);
  const file = `${await dataDir()}\\${name}`;
  try {
    const { contexts } = parseContexts(await kubectlJson<KubeConfig>(args.contexts(file)), file);
    if (!contexts.length) throw new Error("This kubeconfig names no context.");
    return { file, contexts };
  } catch (e) {
    await discardKubeconfig(file);
    throw e;
  }
}

/** Lists a staged kubeconfig, and its tunnel, so they are read from now on. */
export async function keepKubeconfig(file: string) {
  const name = fileName(file);
  const { files, tunnels } = await readIndex();
  const t = stagedTunnels.get(name);
  stagedTunnels.delete(name);
  await writeIndex({
    files: files.includes(name) ? files : [...files, name],
    tunnels: t ? { ...tunnels, [name]: t } : tunnels,
  });
}

/** Removes an added kubeconfig: its tunnel, its place in the list, and its file. */
export async function discardKubeconfig(file: string) {
  const name = fileName(file);
  closeTunnel(file);
  stagedTunnels.delete(name);
  const { files, tunnels } = await readIndex();
  if (files.includes(name) || tunnels[name]) {
    const { [name]: _gone, ...rest } = tunnels;
    await writeIndex({ files: files.filter((n) => n !== name), tunnels: rest });
  }
  await configDelete(name).catch((e) => console.warn("[kube] could not remove a kubeconfig", file, e));
}

// ---- remembered choices ------------------------------------------------------------------------

/** The context last looked at, and the namespace chosen in each context. */
export interface Prefs { context: string; namespaces: Record<string, string> }

let lastPrefs = "";

export async function loadPrefs(): Promise<Prefs> {
  const raw = await configRead("prefs").catch((e) => { console.warn("[kube] could not read prefs", e); return ""; });
  lastPrefs = raw.trim();
  try {
    return raw.trim() ? { context: "", namespaces: {}, ...JSON.parse(raw) } : { context: "", namespaces: {} };
  } catch {
    return { context: "", namespaces: {} };
  }
}

/** Saves the choices, skipping a write when nothing changed: every write wakes Deck's config listeners. */
export function savePrefs(p: Prefs) {
  const text = JSON.stringify(p);
  if (text === lastPrefs) return;
  lastPrefs = text;
  configWrite("prefs", text).catch((e) => console.warn("[kube] could not save prefs", e));
}

/** Stops what module scope started: the stream listener, every port-forward and every tunnel. */
export function stopAll() {
  unlisten.then((f) => f()).catch(() => {});
  clearTimeout(resuming);
  // What a reload's fresh copy starts again (see below). A plugin switched off or removed leaves
  // the note unread, and its forwards stopped.
  NOTES[RELOAD_NOTE] = {
    at: Date.now(),
    forwards: forwards.filter((f) => f.state !== "failed").map(({ context, ns, target, remote, local }) => ({ context, ns, target, remote, local })),
  };
  for (const f of forwards) { stop(f.id); dismissNotification(SOURCE, f.id); }
  for (const file of [...open.keys()]) closeTunnel(file);
  forwards = [];
  handlers.clear();
}

// Port-forwards that were open when the plugin was reloaded (a rebuild in dev, an update), started
// again on the same local ports. The old copy's dispose had to stop them (Deck's rule 13), so a
// reload used to end every forward. A note older than a few seconds is from a plugin switched off
// and back on later, and is dropped.
type ReloadNote = { at: number; forwards: Pick<Forward, "context" | "ns" | "target" | "remote" | "local">[] };
const RELOAD_NOTE = "__deckKubeForwards";
const NOTES = globalThis as unknown as Record<string, ReloadNote | undefined>;
const note = NOTES[RELOAD_NOTE];
delete NOTES[RELOAD_NOTE];
let resuming: ReturnType<typeof setTimeout> | undefined;
if (note && Date.now() - note.at < 10_000 && note.forwards.length) {
  // A second for the old kubectl processes, being killed, to let go of their ports.
  resuming = setTimeout(() => { for (const f of note.forwards) startForward(f.context, f.ns, f.target, f.remote, f.local ?? ""); }, 1000);
}
