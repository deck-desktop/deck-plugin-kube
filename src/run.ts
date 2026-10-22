// Running kubectl and helm from Deck: one-shot calls through `exec`, live rows through a
// `kubectl get --watch` stream, metrics on a poll, and port-forwards, the one thing that outlives
// the tab and so lives here at module scope (stopped by `dispose`).
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  configDelete, configRead, configWrite, dataDir, exec, procKill, procStream,
  type ProcLine, type ProcResult,
} from "deck-plugin-sdk/bridge";
import { listen } from "deck-plugin-sdk/event";
import {
  applyEvent, args, forwardedPort, jsonSplitter, parseTop,
  type Kind, type Obj, type Usage, type WatchEvent,
} from "./kube";

// ---- one-shot calls --------------------------------------------------------------------------

/** Runs a program to completion: its stdout, or an error carrying what it printed to stderr. */
async function run(program: string, a: string[]): Promise<string> {
  const out = await exec(program, a);
  if (out.code !== 0) throw new Error(out.stderr.trim() || out.stdout.trim() || `${program} exited with ${out.code}`);
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
export async function withFile<T>(text: string, fn: (path: string) => Promise<T>): Promise<T> {
  const name = "apply.yaml";
  await configWrite(name, text);
  try {
    return await fn(`${await dataDir()}\\${name}`);
  } finally {
    await configDelete(name).catch((e) => console.warn("[kube] could not remove the edited file", e));
  }
}

// ---- streams ---------------------------------------------------------------------------------

// One listener for every stream this plugin runs, handing each line to its run by id, rather
// than a listener per run that each hear every line Deck streams.
const handlers = new Map<string, (l: ProcLine) => void>();
const unlisten = listen<ProcLine>("proc-line", (e) => handlers.get(e.payload.id)?.(e.payload));
let seq = 0;

/** Runs a program, handing each output line to `onLine`, until it exits or `procKill(id)`. */
function stream(id: string, program: string, a: string[], onLine: (l: ProcLine) => void): Promise<ProcResult> {
  handlers.set(id, onLine);
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
      if (id) void procKill(id).catch(() => {});
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
    return () => { alive = false; clearTimeout(timer); void procKill(id).catch(() => {}); };
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
  stream(id, "kubectl", args.portForward(context, target, ns, local, remote), (l) => {
    const port = forwardedPort(l.line);
    if (port) patch(id, { local: port, state: "open" });
    else if (l.stream === "stderr") err = l.line;
  }).then((r) => {
    if (r.cancelled) return;
    console.warn("[kube] port-forward ended", target, err);
    patch(id, { state: "failed", error: err || `kubectl exited with ${r.code}` });
  }, (e) => {
    console.warn("[kube] port-forward failed", target, e);
    patch(id, { state: "failed", error: String(e) });
  });
}

export function stopForward(id: string) {
  forwards = forwards.filter((f) => f.id !== id);
  emit();
  void procKill(id).catch(() => {});
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

/** Stops what module scope started: the stream listener and every port-forward. */
export function stopAll() {
  unlisten.then((f) => f()).catch(() => {});
  for (const f of forwards) void procKill(f.id).catch(() => {});
  forwards = [];
  handlers.clear();
}
