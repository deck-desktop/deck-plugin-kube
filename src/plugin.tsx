// Kubernetes — browse and manage clusters, in the spirit of Lens: every kind of resource as a
// live table, an object's details, YAML, logs and events beside it, a shell in a container, port-
// forwards, metrics and Helm releases.
//
// Everything goes through kubectl (and helm), which Deck runs: `kubectl get --watch` for the
// tables, `exec` for the rest. So it talks to whatever the user's kubeconfig talks to, with the
// same authentication, plus any cluster added here by pasting its kubeconfig (src/Clusters.tsx).
// The context chosen here is passed with --context on every call rather than switched in the
// kubeconfig, which the user's terminals keep reading.
import { useEffect, useMemo, useState } from "react";
import {
  ShipWheel, Plus, ChevronRight, ChevronDown, LayoutDashboard, Package, ArrowRightLeft,
  ExternalLink, Square, Search, TerminalSquare, ScrollText, Trash2,
} from "lucide-react";
import {
  ConfirmDialog, type ConfirmState, ContextMenu, type MenuEntry, NamePrompt, type NamePromptState,
  EmptyState, IconButton, Select, CountChip, Chip, tone, toast,
} from "deck-plugin-sdk/ui";
import { openExternal } from "deck-plugin-sdk/bridge";
import {
  KINDS, age, allocatable, args, crdKinds, eventTime, fmtBytes, fmtCpu, kindByResource, objKey,
  parsePorts, podPorts, podSummary, requested, shellCommand,
  type Kind, type Obj, type Usage,
} from "./kube";
import {
  discardKubeconfig, installed, kubectl, kubectlJson, loadContexts, loadPrefs, savePrefs, startForward,
  stopAll, stopForward, useForwards, useMetrics, useWatch, type Context, type Prefs,
} from "./run";
import { AddCluster } from "./Clusters";
import { Details, CreatePanel, Note, StatusChip, actionsFor, type Act } from "./Details";
import { HelmView } from "./Helm";

export function dispose() {
  stopAll();
}

type View = { type: "overview" } | { type: "kind"; resource: string } | { type: "helm" } | { type: "forwards" } | { type: "add" };

const NS_KIND = kindByResource("namespaces")!;

export function PaneView({ runInTerminal }: { cwd: string; runInTerminal: (label: string, command: string) => void }) {
  const [hasKubectl, setHasKubectl] = useState<boolean | null>(null);
  const [contexts, setContexts] = useState<Context[] | null>(null);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [context, setContext] = useState("");
  const [ns, setNs] = useState("");
  const [view, setView] = useState<View>({ type: "overview" });
  const [filter, setFilter] = useState("");
  const [crds, setCrds] = useState<Kind[]>([]);
  const [reload, setReload] = useState(0);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  // A cluster just added: chosen once the contexts are read again.
  const [choose, setChoose] = useState("");

  // kubectl, the contexts in the kubeconfigs, and the choices made here last time.
  useEffect(() => {
    let alive = true;
    (async () => {
      const has = await installed("kubectl");
      if (!alive) return;
      setHasKubectl(has);
      if (!has) return;
      const [{ current, contexts: list }, p] = await Promise.all([loadContexts(), loadPrefs()]);
      if (!alive) return;
      setContexts(list);
      setPrefs(p);
      const known = (k: string) => list.some((c) => c.key === k);
      const chosen = [choose, p.context, current].find((k) => k && known(k)) ?? list[0]?.key ?? "";
      setContext(chosen);
      setNs(p.namespaces[chosen] ?? list.find((c) => c.key === chosen)?.namespace ?? "");
      if (choose) {
        setChoose("");
        setView({ type: "overview" });
        if (known(choose)) savePrefs({ ...p, context: choose });
      }
    })();
    return () => { alive = false; };
  }, [reload]);

  // Custom resources: what this cluster adds to the built-in kinds.
  useEffect(() => {
    if (!context) return;
    let alive = true;
    setCrds([]);
    kubectlJson(args.crds(context)).then((l) => { if (alive) setCrds(crdKinds(l)); },
      (e) => console.warn("[kube] could not list custom resources", e));
    return () => { alive = false; };
  }, [context, reload]);

  const pickContext = (c: string) => {
    setContext(c);
    const next = prefs?.namespaces[c] ?? contexts?.find((x) => x.key === c)?.namespace ?? "";
    setNs(next);
    const p = { context: c, namespaces: { ...(prefs?.namespaces ?? {}) } };
    setPrefs(p);
    savePrefs(p);
  };
  const added = (key: string) => { setChoose(key); setReload((r) => r + 1); };
  const remove = (c: Context) => setConfirm({
    title: `Remove ${c.name}?`, confirmLabel: "Remove",
    body: "Its kubeconfig, added here, is deleted. The cluster itself is not touched.",
    onConfirm: () => void discardKubeconfig(c.file).then(() => setReload((r) => r + 1)),
  });

  const pickNs = (n: string) => {
    setNs(n);
    const p = { context, namespaces: { ...(prefs?.namespaces ?? {}), [context]: n } };
    setPrefs(p);
    savePrefs(p);
  };

  const namespaces = useWatch(context, NS_KIND, "", !!context);

  if (hasKubectl === false) {
    return (
      <Centered>
        <EmptyState card icon={<ShipWheel />} title="kubectl is not installed"
          action={{ label: "Install kubectl", onClick: () => runInTerminal("Install kubectl", "winget install --id Kubernetes.kubectl -e") }}>
          This tool reaches your clusters through kubectl. Install it, or turn on Kubernetes in Docker
          Desktop, which brings its own. Then <button className="underline" onClick={() => setReload(reload + 1)}>check again</button>.
        </EmptyState>
      </Centered>
    );
  }
  if (!contexts) return <Centered><span className="text-[12px] text-text-muted">Reading your kubeconfig…</span></Centered>;
  if (!contexts.length) return <div className="flex h-full min-h-0 flex-col"><AddCluster onAdded={added} /></div>;

  const kind = view.type === "kind" ? kindByResource(view.resource, crds) : undefined;

  return (
    <div className="flex h-full min-h-0 text-[12.5px]">
      <Sidebar contexts={contexts} context={context} onContext={pickContext}
        namespaces={namespaces.rows.map((o) => o.metadata.name).sort()} ns={ns} onNs={pickNs}
        view={view} onView={(v) => { setView(v); setFilter(""); }} crds={crds} onRemove={remove} />
      <div className="flex min-w-0 flex-1 flex-col">
        {view.type === "add" && <AddCluster onAdded={added} onCancel={() => setView({ type: "overview" })} />}
        {namespaces.error && view.type !== "add" && (
          <div className="pt-3"><Note color={tone("red")}>{namespaces.error}</Note></div>
        )}
        {view.type === "overview" && <ClusterOverview context={context} ns={ns} onView={setView} />}
        {view.type === "forwards" && <Forwards />}
        {(view.type === "kind" || view.type === "helm") && (
          <>
            <Toolbar title={view.type === "helm" ? "Helm releases" : kind?.label ?? view.resource}
              filter={filter} onFilter={setFilter} />
            {view.type === "helm"
              ? <HelmView context={context} namespace={ns} filter={filter} runInTerminal={runInTerminal} />
              : kind && <ResourceView key={`${context}/${kind.resource}/${ns}`} context={context} kind={kind} ns={ns}
                  filter={filter} runInTerminal={runInTerminal} />}
          </>
        )}
      </div>
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6"><div style={{ maxWidth: 460 }}>{children}</div></div>;
}

// ---- sidebar ---------------------------------------------------------------------------------

function Sidebar({ contexts, context, onContext, namespaces, ns, onNs, view, onView, crds, onRemove }: {
  contexts: Context[]; context: string; onContext: (c: string) => void;
  namespaces: string[]; ns: string; onNs: (n: string) => void;
  view: View; onView: (v: View) => void; crds: Kind[]; onRemove: (c: Context) => void;
}) {
  const current = contexts.find((c) => c.key === context);
  const own = contexts.filter((c) => !c.file);
  const added = contexts.filter((c) => c.file);
  const option = (c: Context) => <option key={c.key} value={c.key}>{c.name}</option>;
  const [folded, setFolded] = useState<Record<string, boolean>>({ "Access control": true });
  const forwards = useForwards();
  const groups = useMemo(() => {
    const m = new Map<string, Kind[]>();
    for (const k of KINDS) m.set(k.group, [...(m.get(k.group) ?? []), k]);
    return [...m];
  }, []);
  const crdGroups = useMemo(() => {
    const m = new Map<string, Kind[]>();
    for (const k of crds) m.set(k.group, [...(m.get(k.group) ?? []), k]);
    return [...m];
  }, [crds]);
  const isOn = (v: View) => JSON.stringify(v) === JSON.stringify(view);
  const fold = (g: string) => setFolded((f) => ({ ...f, [g]: !(f[g] ?? false) }));

  return (
    <nav className="flex shrink-0 flex-col gap-2 overflow-auto border-r border-subtle bg-panel px-2 py-2" style={{ width: 210 }}>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <Select value={context} onChange={(e) => onContext(e.target.value)} title={current?.server || "Cluster"}>
              {own.length > 0 && added.length > 0 ? <optgroup label="Your kubeconfig">{own.map(option)}</optgroup> : own.map(option)}
              {added.length > 0 && (own.length > 0 ? <optgroup label="Added here">{added.map(option)}</optgroup> : added.map(option))}
            </Select>
          </div>
          {current?.file && <IconButton title="Remove this cluster" danger onClick={() => onRemove(current)}><Trash2 size={13} /></IconButton>}
          <IconButton title="Add a cluster" active={view.type === "add"} onClick={() => onView({ type: "add" })}><Plus size={14} /></IconButton>
        </div>
        <Select value={ns} onChange={(e) => onNs(e.target.value)} title="Namespace">
          <option value="">All namespaces</option>
          {!namespaces.includes(ns) && ns && <option value={ns}>{ns}</option>}
          {namespaces.map((n) => <option key={n} value={n}>{n}</option>)}
        </Select>
      </div>
      <div className="flex flex-col">
        <NavRow icon={<LayoutDashboard size={13} />} label="Overview" on={isOn({ type: "overview" })} onClick={() => onView({ type: "overview" })} />
        {groups.map(([g, kinds]) => (
          <NavGroup key={g} title={g} folded={!!folded[g]} onFold={() => fold(g)}>
            {kinds.map((k) => (
              <NavRow key={k.resource} label={k.label} on={isOn({ type: "kind", resource: k.resource })}
                onClick={() => onView({ type: "kind", resource: k.resource })} />
            ))}
          </NavGroup>
        ))}
        <NavGroup title="Apps" folded={!!folded.Apps} onFold={() => fold("Apps")}>
          <NavRow icon={<Package size={13} />} label="Helm releases" on={isOn({ type: "helm" })} onClick={() => onView({ type: "helm" })} />
          <NavRow icon={<ArrowRightLeft size={13} />} label="Port-forwards" on={isOn({ type: "forwards" })}
            onClick={() => onView({ type: "forwards" })} count={forwards.length} />
        </NavGroup>
        {!!crdGroups.length && (
          <NavGroup title="Custom resources" folded={folded["Custom resources"] ?? true} onFold={() => fold("Custom resources")}>
            {crdGroups.map(([g, kinds]) => (
              <NavGroup key={g} title={g} folded={folded[`crd:${g}`] ?? true} onFold={() => fold(`crd:${g}`)} nested>
                {kinds.map((k) => (
                  <NavRow key={k.resource} label={k.label} on={isOn({ type: "kind", resource: k.resource })}
                    onClick={() => onView({ type: "kind", resource: k.resource })} />
                ))}
              </NavGroup>
            ))}
          </NavGroup>
        )}
      </div>
    </nav>
  );
}

function NavGroup({ title, folded, onFold, nested, children }: {
  title: string; folded: boolean; onFold: () => void; nested?: boolean; children: React.ReactNode;
}) {
  return (
    <div className={"flex flex-col " + (nested ? "pl-2" : "pt-1.5")}>
      <button onClick={onFold}
        className="flex h-7 items-center gap-1 rounded-md px-1.5 text-left text-[12px] font-medium text-text-secondary transition-colors hover:bg-white/5 hover:text-text-primary">
        {folded ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <span className="truncate">{title}</span>
      </button>
      {!folded && <div className="flex flex-col">{children}</div>}
    </div>
  );
}

function NavRow({ label, on, onClick, icon, count }: {
  label: string; on: boolean; onClick: () => void; icon?: React.ReactNode; count?: number;
}) {
  return (
    <button onClick={onClick}
      className={"flex h-6 shrink-0 items-center gap-2 rounded-md pl-6 pr-2 text-left transition-colors hover:bg-white/5 hover:text-text-primary "
        + (on ? "text-text-primary" : "text-text-secondary")}
      style={{ ...(on ? { background: "var(--accent-soft)" } : {}), ...(icon ? { paddingLeft: 8 } : {}) }}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {!!count && <CountChip n={count} />}
    </button>
  );
}

function Toolbar({ title, filter, onFilter }: { title: string; filter: string; onFilter: (s: string) => void }) {
  return (
    <div className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-2">
      <span className="truncate text-[13px] font-medium text-text-primary">{title}</span>
      <div className="ml-auto flex h-7 items-center gap-1.5 rounded-lg border border-subtle bg-elev px-2 focus-within:border-[var(--accent)]" style={{ width: 240 }}>
        <Search size={13} className="shrink-0 text-text-muted" />
        <input value={filter} onChange={(e) => onFilter(e.target.value)} placeholder="Filter by name"
          className="min-w-0 flex-1 bg-transparent text-[12px] text-text-primary outline-none placeholder:text-text-muted" />
      </div>
    </div>
  );
}

// ---- a kind's table --------------------------------------------------------------------------

type Panel = { type: "details"; key: string; logs?: { container: string; n: number } } | { type: "create" } | null;

function ResourceView({ context, kind, ns, filter, runInTerminal }: {
  context: string; kind: Kind; ns: string; filter: string;
  runInTerminal: (label: string, command: string) => void;
}) {
  const watch = useWatch(context, kind, ns, true);
  const metricsFor = kind.kind === "Pod" || kind.kind === "Node";
  const metrics = useMetrics(context, kind.kind === "Node", metricsFor);
  const [sort, setSort] = useState<{ col: number; desc: boolean }>({ col: kind.kind === "Event" ? 5 : -1, desc: false });
  const [panel, setPanel] = useState<Panel>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; o: Obj } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [prompt, setPrompt] = useState<NamePromptState | null>(null);

  const showNs = kind.namespaced && !ns;
  const usage = metricsFor && metrics && !metrics.error ? metrics.usage : null;
  const now = Date.now();

  const rows = useMemo(() => {
    const f = filter.toLowerCase();
    const list = watch.rows.filter((o) => !f || o.metadata.name.toLowerCase().includes(f)
      || (o.metadata.namespace ?? "").toLowerCase().includes(f));
    const col = sort.col >= 0 ? kind.columns[sort.col] : undefined;
    const key = (o: Obj): string | number =>
      !col ? o.metadata.name : col.sortKey ? col.sortKey(o) : col.get(o, now);
    list.sort((a, b) => {
      const x = key(a), y = key(b);
      const c = typeof x === "number" && typeof y === "number" ? x - y
        : String(x).localeCompare(String(y), undefined, { numeric: true });
      return (sort.desc ? -c : c) || objKey(a).localeCompare(objKey(b));
    });
    return list;
  }, [watch.rows, filter, sort, kind]);

  const open = panel?.type === "details" ? watch.rows.find((o) => objKey(o) === panel.key) : undefined;

  const act = (o: Obj, a: Act, container?: string) => {
    const name = o.metadata.name, n = o.metadata.namespace ?? "";
    const done = (what: string) => (out: string) => toast(out.trim().split("\n").pop() || what, "success");
    const fail = (what: string) => (e: Error) => {
      console.warn(`[kube] ${what} failed`, e);
      toast(`${what} failed: ${e.message ?? e}`, "error", { ms: 8000 });
    };
    const c = container ?? (o.spec?.containers?.[0]?.name as string | undefined) ?? "";
    switch (a) {
      case "logs":
        setPanel({ type: "details", key: objKey(o), logs: { container: c, n: Date.now() } });
        break;
      case "shell":
        runInTerminal(`${name}${c && (o.spec?.containers?.length ?? 0) > 1 ? `/${c}` : ""}`, shellCommand(context, name, n, c));
        break;
      case "forward": {
        const target = `${kind.kind === "Service" ? "svc" : "pod"}/${name}`;
        const first = kind.kind === "Service" ? o.spec?.ports?.[0]?.port : podPorts(o)[0]?.port;
        setPrompt({
          title: `Port-forward ${target}`,
          subtitle: "local:remote, or one port for both. :remote picks a free local port.",
          initial: first ? String(first) : "", placeholder: "8080:80", confirmLabel: "Forward",
          onSave: (v) => {
            const p = parsePorts(v);
            if (!p) { toast(`"${v}" is not a port or local:remote`, "error"); return; }
            startForward(context, n, target, p.remote, p.local);
            toast(`Forwarding ${target} port ${p.remote}. See Port-forwards.`, "success");
          },
        });
        break;
      }
      case "scale":
        setPrompt({
          title: `Scale ${name}`, subtitle: "How many replicas", initial: String(o.spec?.replicas ?? 1), confirmLabel: "Scale",
          onSave: (v) => {
            const r = Number(v);
            if (!Number.isInteger(r) || r < 0) { toast(`"${v}" is not a number of replicas`, "error"); return; }
            kubectl(args.scale(context, kind.resource, name, n, r)).then(done("Scaled"), fail("Scale"));
          },
        });
        break;
      case "restart":
        setConfirm({
          title: `Restart ${name}?`, confirmLabel: "Restart", danger: false,
          body: "Its pods are replaced one by one, the way a new rollout replaces them.",
          onConfirm: () => void kubectl(args.restart(context, kind.resource, name, n)).then(done("Restarted"), fail("Restart")),
        });
        break;
      case "trigger": {
        const job = `${name.slice(0, 44)}-manual-${Date.now().toString(36).slice(-6)}`;
        kubectl(args.trigger(context, name, n, job)).then(done(`Started ${job}`), fail("Run now"));
        break;
      }
      case "suspend":
        kubectl(args.suspend(context, name, n, !o.spec?.suspend)).then(done(o.spec?.suspend ? "Resumed" : "Suspended"), fail("Suspend"));
        break;
      case "cordon":
        kubectl(args.cordon(context, name, !o.spec?.unschedulable)).then(done("Done"), fail("Cordon"));
        break;
      case "drain":
        setConfirm({
          title: `Drain ${name}?`, confirmLabel: "Drain",
          body: "The node is cordoned and its pods are evicted, except those of daemon sets. Pods using emptyDir lose that data.",
          onConfirm: () => {
            toast(`Draining ${name}…`);
            void kubectl(args.drain(context, name)).then(done("Drained"), fail("Drain"));
          },
        });
        break;
      case "delete":
        setConfirm({
          title: `Delete ${kind.kind.toLowerCase()} ${name}?`, confirmLabel: "Delete",
          body: n ? `In namespace ${n}. This cannot be undone.` : "This cannot be undone.",
          onConfirm: () => {
            if (panel?.type === "details" && panel.key === objKey(o)) setPanel(null);
            void kubectl(args.delete(context, kind.resource, name, n || undefined)).then(done("Deleted"), fail("Delete"));
          },
        });
        break;
    }
  };

  const menuItems = (o: Obj): MenuEntry[] => {
    const acts = actionsFor(kind, o);
    const del = acts.pop()!;
    return [
      ...acts.map((a) => ({ label: a.label, icon: a.icon, danger: a.danger, onClick: () => act(o, a.act) }) as MenuEntry),
      ...(acts.length ? ["sep" as const] : []),
      { label: "Copy name", onClick: () => void navigator.clipboard.writeText(o.metadata.name) },
      "sep",
      { label: del.label, icon: del.icon, danger: true, onClick: () => act(o, "delete") } as MenuEntry,
    ];
  };

  const headers = ["Name", ...(showNs ? ["Namespace"] : []), ...kind.columns.map((c) => c.title), ...(usage ? ["CPU", "Memory"] : [])];
  const colIndex = (h: number) => h - 1 - (showNs ? 1 : 0); // a header's index into kind.columns

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 px-3 pb-1 text-[11.5px] text-text-muted">
          <span>{watch.loading ? "Loading…" : `${rows.length}${filter ? ` of ${watch.rows.length}` : ""} ${kind.label.toLowerCase()}`}</span>
          {metricsFor && metrics?.error && <span title={metrics.error}>· no metrics (metrics-server is not installed)</span>}
          <span className="ml-auto" />
          <IconButton title="New resource from YAML" onClick={() => setPanel({ type: "create" })}><Plus size={14} /></IconButton>
        </div>
        {watch.error && (
          <Note color={tone("red")}>{watch.error}</Note>
        )}
        {!watch.loading && !rows.length && !watch.error && (
          <EmptyState>{filter ? `Nothing named like "${filter}".` : `No ${kind.label.toLowerCase()}${kind.namespaced && ns ? ` in ${ns}` : ""}.`}</EmptyState>
        )}
        <div className="min-h-0 flex-1 overflow-auto px-1.5">
          <table className="w-full border-collapse">
            {!!rows.length && (
              <thead className="sticky top-0 z-10 text-left text-[11.5px] text-text-muted" style={{ background: "var(--bg-app)" }}>
                <tr>
                  {headers.map((h, i) => {
                    const ci = i === 0 ? -1 : colIndex(i);
                    const sortable = i === 0 || (ci >= 0 && ci < kind.columns.length);
                    const on = sortable && sort.col === ci;
                    return (
                      <th key={h} className={"h-6 whitespace-nowrap px-2 font-normal " + (sortable ? "cursor-pointer hover:text-text-primary" : "")}
                        onClick={() => sortable && setSort((s) => ({ col: ci, desc: s.col === ci ? !s.desc : false }))}>
                        {h}{on ? (sort.desc ? " ↓" : " ↑") : ""}
                      </th>
                    );
                  })}
                </tr>
              </thead>
            )}
            <tbody>
              {rows.map((o) => {
                const key = objKey(o);
                const sel = panel?.type === "details" && panel.key === key;
                const u = usage?.get(kind.kind === "Node" ? `/${o.metadata.name}` : key);
                return (
                  <tr key={key}
                    onClick={() => setPanel({ type: "details", key })}
                    onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, o }); }}
                    className={"group h-6 cursor-default text-[12.5px] transition-colors hover:bg-white/5 " + (sel ? "text-text-primary" : "text-text-secondary")}
                    style={sel ? { background: "var(--accent-soft)" } : undefined}>
                    <td className="px-2">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate" style={{ maxWidth: 420 }} title={o.metadata.name}>{o.metadata.name}</span>
                        {kind.kind === "Pod" && (
                          <span className="ml-auto hidden shrink-0 gap-0.5 group-hover:flex">
                            <IconButton size="row" title="Logs" onClick={(e) => { e.stopPropagation(); act(o, "logs"); }}><ScrollText size={12} /></IconButton>
                            <IconButton size="row" title="Shell" onClick={(e) => { e.stopPropagation(); act(o, "shell"); }}><TerminalSquare size={12} /></IconButton>
                          </span>
                        )}
                      </div>
                    </td>
                    {showNs && <td className="whitespace-nowrap px-2 text-text-muted">{o.metadata.namespace}</td>}
                    {kind.columns.map((c) => {
                      const v = c.get(o, now);
                      return (
                        <td key={c.title} title={v.length > 40 ? v : undefined}
                          className={"px-2 " + (c.mono ? "font-mono text-[11.5px] " : "") + (c.title === "Message" ? "" : "whitespace-nowrap")}>
                          {c.status ? <StatusChip s={v} /> : <span className="block truncate" style={{ maxWidth: c.title === "Message" ? 520 : 260 }}>{v}</span>}
                        </td>
                      );
                    })}
                    {usage && <td className="whitespace-nowrap px-2 font-mono text-[11.5px]">{u ? fmtCpu(u.cpu) : ""}</td>}
                    {usage && <td className="whitespace-nowrap px-2 font-mono text-[11.5px]">{u ? fmtBytes(u.memory) : ""}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {panel && (
        <div className="flex min-w-0 flex-col border-l border-subtle bg-panel" style={{ width: "46%", minWidth: 380 }}>
          {panel.type === "create" && <CreatePanel context={context} namespace={ns} onClose={() => setPanel(null)} />}
          {panel.type === "details" && open && (
            <Details context={context} kind={kind} o={open} logsFor={panel.logs}
              onClose={() => setPanel(null)} onAct={(a, c) => act(open, a, c)} />
          )}
          {panel.type === "details" && !open && !watch.loading && (
            <EmptyState action={{ label: "Close", onClick: () => setPanel(null) }}>This {kind.kind.toLowerCase()} no longer exists.</EmptyState>
          )}
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.o)} onClose={() => setMenu(null)} />}
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
      <NamePrompt state={prompt} onClose={() => setPrompt(null)} />
    </div>
  );
}

// ---- the cluster overview --------------------------------------------------------------------

const NODES = kindByResource("nodes")!;
const PODS = kindByResource("pods")!;
const EVENTS = kindByResource("events")!;

function ClusterOverview({ context, ns, onView }: { context: string; ns: string; onView: (v: View) => void }) {
  const nodes = useWatch(context, NODES, "", true);
  const pods = useWatch(context, PODS, ns, true);
  const events = useWatch(context, EVENTS, ns, true);
  const metrics = useMetrics(context, true, true);

  const cap = allocatable(nodes.rows);
  const req = requested(pods.rows);
  const used: Usage | null = metrics && !metrics.error
    ? [...metrics.usage.values()].reduce((a, u) => ({ cpu: a.cpu + u.cpu, memory: a.memory + u.memory }), { cpu: 0, memory: 0 })
    : null;
  const summary = podSummary(pods.rows);
  const warnings = events.rows.filter((e) => e.type === "Warning")
    .sort((a, b) => Date.parse(eventTime(b) ?? "") - Date.parse(eventTime(a) ?? "")).slice(0, 30);
  const readyNodes = nodes.rows.filter((n) => (n.status?.conditions ?? []).some((c: { type: string; status: string }) => c.type === "Ready" && c.status === "True")).length;
  const now = Date.now();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-4 py-3">
      <div className="flex items-center gap-2">
        <ShipWheel size={16} style={{ color: "#326ce5" }} />
        <span className="text-[13px] font-medium text-text-primary">{context}</span>
        <span className="text-[11.5px] text-text-muted">{ns ? `namespace ${ns}` : "all namespaces"}</span>
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
        <Card title="Nodes" onClick={() => onView({ type: "kind", resource: "nodes" })}>
          <span className="text-[20px] text-text-primary">{nodes.rows.length}</span>
          <span className="text-[11.5px] text-text-muted">{readyNodes} ready</span>
        </Card>
        <Card title="Pods" onClick={() => onView({ type: "kind", resource: "pods" })}>
          <span className="text-[20px] text-text-primary">{pods.rows.length}</span>
          <span className="flex flex-wrap gap-1">
            {!!summary.green && <Chip color={tone("green")}>{summary.green} running</Chip>}
            {!!summary.amber && <Chip color={tone("amber")}>{summary.amber} pending</Chip>}
            {!!summary.red && <Chip color={tone("red")}>{summary.red} failing</Chip>}
            {!!summary.blue && <Chip color={tone("blue")}>{summary.blue} completed</Chip>}
          </span>
        </Card>
        <Card title="CPU">
          <Meter label="Requested" value={req.cpu} of={cap.cpu} fmt={fmtCpu} />
          {used && <Meter label="Used" value={used.cpu} of={cap.cpu} fmt={fmtCpu} />}
        </Card>
        <Card title="Memory">
          <Meter label="Requested" value={req.memory} of={cap.memory} fmt={fmtBytes} />
          {used && <Meter label="Used" value={used.memory} of={cap.memory} fmt={fmtBytes} />}
        </Card>
      </div>
      {ns && <span className="text-[11.5px] text-text-muted">Requests count the pods in {ns}; capacity is the whole cluster's.</span>}
      {metrics?.error && (
        <EmptyState card title="No usage figures"
          action={{ label: "How to install metrics-server", onClick: () => void openExternal("https://github.com/kubernetes-sigs/metrics-server#installation") }}>
          CPU and memory in use come from metrics-server, which this cluster does not run. On a local
          cluster such as Docker Desktop's it also needs the --kubelet-insecure-tls argument.
        </EmptyState>
      )}
      <section className="flex flex-col gap-1">
        <h3 className="text-[12px] font-medium text-text-secondary">Recent warnings</h3>
        {!warnings.length && <span className="text-[12px] text-text-muted">{events.loading ? "Loading…" : "None. The cluster keeps events for about an hour."}</span>}
        {warnings.map((e) => (
          <div key={e.metadata.uid ?? objKey(e)} className="flex min-h-6 items-baseline gap-2 py-0.5 text-[12px]">
            <span className="w-14 shrink-0 font-mono text-[11px] text-text-muted">{age(eventTime(e), now)}</span>
            <span className="shrink-0 text-text-secondary">{e.reason}</span>
            <span className="shrink-0 text-text-muted">{e.involvedObject?.kind}/{e.involvedObject?.name}</span>
            <span className="min-w-0 flex-1 truncate text-text-muted" title={e.message}>{e.message}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

function Card({ title, children, onClick }: { title: string; children: React.ReactNode; onClick?: () => void }) {
  return (
    <div onClick={onClick}
      className={"flex flex-col gap-1.5 rounded-lg border border-subtle bg-elev px-3 py-2.5 " + (onClick ? "cursor-pointer transition-colors hover:border-strong" : "")}>
      <span className="text-[12px] font-medium text-text-secondary">{title}</span>
      {children}
    </div>
  );
}

function Meter({ label, value, of, fmt }: { label: string; value: number; of: number; fmt: (n: number) => string }) {
  const pct = of > 0 ? Math.min(100, (value / of) * 100) : 0;
  const color = pct > 90 ? tone("red") : pct > 70 ? tone("amber") : "var(--accent)";
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex justify-between text-[11.5px]">
        <span className="text-text-muted">{label}</span>
        <span className="font-mono text-text-secondary">{fmt(value)} / {fmt(of)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

// ---- port-forwards -------------------------------------------------------------------------------

function Forwards() {
  const forwards = useForwards();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto px-3 py-2">
      <span className="text-[13px] font-medium text-text-primary">Port-forwards</span>
      {!forwards.length && (
        <EmptyState>
          None running. Start one from a pod or a service: right-click it, Port-forward. A forward keeps
          running while this tab is closed, until you stop it or Deck exits.
        </EmptyState>
      )}
      {forwards.map((f) => (
        <div key={f.id} className="group flex h-7 items-center gap-2 rounded-md px-2 text-[12.5px] hover:bg-white/5">
          <StatusChip s={f.state === "open" ? "Active" : f.state === "starting" ? "Pending" : "Failed"} />
          <span className="font-mono text-[11.5px] text-text-primary">
            {f.local ? `localhost:${f.local}` : "…"} → {f.target}:{f.remote}
          </span>
          <span className="min-w-0 flex-1 truncate text-text-muted" title={f.error}>{f.error || `${f.ns} · ${f.context}`}</span>
          {f.local && f.state === "open" && (
            <IconButton size="row" title="Open in the browser" onClick={() => void openExternal(`http://localhost:${f.local}`)}>
              <ExternalLink size={12} />
            </IconButton>
          )}
          <IconButton size="row" danger title="Stop" onClick={() => stopForward(f.id)}><Square size={11} /></IconButton>
        </div>
      ))}
    </div>
  );
}

