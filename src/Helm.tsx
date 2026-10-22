// Helm releases: the list, and for one release its values, its manifest and its history, with
// rollback and uninstall. Through the `helm` program, which reads the same kubeconfig.
import { useEffect, useState } from "react";
import { RefreshCw, Trash2, X, History, Package } from "lucide-react";
import { ConfirmDialog, type ConfirmState, EmptyState, GhostButton, IconButton, Tabs, Toggle, tone } from "deck-plugin-sdk/ui";
import { age, helmArgs, helmTime, type Release, type Revision } from "./kube";
import { helm, installed } from "./run";
import { Note, StatusChip, YamlEditor } from "./Details";

export function HelmView({ context, namespace, filter, runInTerminal }: {
  context: string; namespace: string; filter: string;
  runInTerminal: (label: string, command: string) => void;
}) {
  const [has, setHas] = useState<boolean | null>(null);
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Release | null>(null);
  const [n, setN] = useState(0);

  useEffect(() => { installed("helm").then(setHas, () => setHas(false)); }, []);
  useEffect(() => {
    if (!has) return;
    let alive = true;
    helm(helmArgs.list(context, namespace)).then((t) => {
      if (!alive) return;
      setReleases(JSON.parse(t || "[]"));
      setError("");
    }, (e) => {
      console.warn("[kube] helm list failed", e);
      if (alive) { setReleases([]); setError(String(e.message ?? e)); }
    });
    return () => { alive = false; };
  }, [has, context, namespace, n]);

  if (has === null) return null;
  if (!has) {
    return (
      <div className="p-4">
        <EmptyState card icon={<Package />} title="Helm is not installed"
          action={{ label: "Install Helm", onClick: () => runInTerminal("Install Helm", "winget install --id Helm.Helm -e") }}>
          Helm releases are listed through the helm program. Install it, then open this view again.
        </EmptyState>
      </div>
    );
  }

  const f = filter.toLowerCase();
  const rows = (releases ?? []).filter((r) => !f || r.name.toLowerCase().includes(f) || r.chart.toLowerCase().includes(f));
  const now = Date.now();
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 px-3 py-1.5 text-[11.5px] text-text-muted">
          <span className="flex-1">{releases ? `${rows.length} releases` : "Loading…"}</span>
          <IconButton title="Refresh" onClick={() => setN(n + 1)}><RefreshCw size={14} /></IconButton>
        </div>
        {error && <Note color={tone("red")}>{error}</Note>}
        {releases && !rows.length && !error && <EmptyState>No Helm releases{namespace ? ` in ${namespace}` : ""}.</EmptyState>}
        <div className="min-h-0 flex-1 overflow-auto px-1.5">
          <table className="w-full border-collapse text-[12.5px]">
            {!!rows.length && (
              <thead className="sticky top-0 bg-[var(--bg-app)] text-left text-[11.5px] text-text-muted">
                <tr>{["Name", "Namespace", "Chart", "App version", "Revision", "Status", "Updated"].map((h) => <th key={h} className="h-6 px-2 font-normal">{h}</th>)}</tr>
              </thead>
            )}
            <tbody>
              {rows.map((r) => {
                const sel = open?.name === r.name && open.namespace === r.namespace;
                return (
                  <tr key={`${r.namespace}/${r.name}`} onClick={() => setOpen(r)}
                    className={"h-6 cursor-default text-text-secondary hover:bg-white/5 " + (sel ? "text-text-primary" : "")}
                    style={sel ? { background: "var(--accent-soft)" } : undefined}>
                    <td className="truncate px-2">{r.name}</td>
                    <td className="px-2 text-text-muted">{r.namespace}</td>
                    <td className="px-2">{r.chart}</td>
                    <td className="px-2 font-mono text-[11.5px]">{r.app_version}</td>
                    <td className="px-2 font-mono text-[11.5px]">{r.revision}</td>
                    <td className="px-2"><StatusChip s={r.status} /></td>
                    <td className="px-2 font-mono text-[11.5px] text-text-muted">{age(helmTime(r.updated), now)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {open && (
        <div className="flex min-w-0 flex-col border-l border-subtle bg-panel" style={{ width: "46%", minWidth: 360 }}>
          <ReleasePanel context={context} r={open} onClose={() => setOpen(null)} onChanged={() => setN((x) => x + 1)} />
        </div>
      )}
    </div>
  );
}

type Tab = "values" | "manifest" | "history";

function ReleasePanel({ context, r, onClose, onChanged }: { context: string; r: Release; onClose: () => void; onChanged: () => void }) {
  const [tab, setTab] = useState<Tab>("values");
  const [all, setAll] = useState(false);
  const [text, setText] = useState("");
  const [history, setHistory] = useState<Revision[]>([]);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    let alive = true;
    setText("");
    const a = tab === "values" ? helmArgs.values(context, r.name, r.namespace, all)
      : tab === "manifest" ? helmArgs.manifest(context, r.name, r.namespace)
      : helmArgs.history(context, r.name, r.namespace);
    helm(a).then((t) => {
      if (!alive) return;
      if (tab === "history") setHistory((JSON.parse(t || "[]") as Revision[]).reverse());
      else setText(t);
    }, (e) => { console.warn("[kube] helm failed", tab, e); if (alive) setText(`# ${String(e.message ?? e)}`); });
    return () => { alive = false; };
  }, [context, r.name, r.namespace, r.revision, tab, all]);

  const act = (label: string, a: string[]) => {
    setMsg("");
    helm(a).then((out) => { setMsg(out.trim() || label); onChanged(); },
      (e) => { console.warn("[kube] helm failed", label, e); setMsg(String(e.message ?? e)); });
  };
  const now = Date.now();

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 px-3 pt-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium text-text-primary">{r.name}</span>
          <span className="truncate text-[11px] text-text-muted">{r.chart} in {r.namespace}</span>
        </div>
        <IconButton title="Uninstall" danger onClick={() => setConfirm({
          title: `Uninstall ${r.name}?`, confirmLabel: "Uninstall",
          body: `Removes the release and every resource it created in ${r.namespace}.`,
          onConfirm: () => { act("Uninstalled", helmArgs.uninstall(context, r.name, r.namespace)); onClose(); },
        })}><Trash2 size={14} /></IconButton>
        <i aria-hidden className="mx-1 h-3.5 w-px bg-white/10" />
        <IconButton title="Close" onClick={onClose}><X size={14} /></IconButton>
      </div>
      <div className="shrink-0 px-3 pt-1">
        <Tabs value={tab} onChange={setTab} layoutId="kube-helm-tab"
          options={[{ value: "values", label: "Values" }, { value: "manifest", label: "Manifest" }, { value: "history", label: "History" }]} />
      </div>
      {msg && <div className="pt-2"><Note>{msg}</Note></div>}
      {tab === "values" && (
        <div className="flex shrink-0 items-center gap-2 px-3 py-2 text-[12px] text-text-secondary">
          <Toggle on={all} onChange={setAll} /> Include the chart's defaults
        </div>
      )}
      {tab !== "history" && <YamlEditor value={text} readOnly />}
      {tab === "history" && (
        <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
          {history.map((h) => (
            <div key={h.revision} className="group flex min-h-7 items-center gap-2 rounded-md px-2 text-[12px] hover:bg-white/5">
              <span className="w-8 font-mono text-text-secondary">{h.revision}</span>
              <StatusChip s={h.status} />
              <span className="min-w-0 flex-1 truncate text-text-muted" title={h.description}>{h.chart} · {h.description}</span>
              <span className="font-mono text-[11px] text-text-muted">{age(helmTime(h.updated), now)}</span>
              {String(h.revision) !== r.revision && (
                <span className="opacity-0 group-hover:opacity-100">
                  <GhostButton onClick={() => setConfirm({
                    title: `Roll ${r.name} back to revision ${h.revision}?`, confirmLabel: "Roll back", danger: false,
                    body: `Helm makes a new revision with revision ${h.revision}'s chart and values.`,
                    onConfirm: () => act("Rolled back", helmArgs.rollback(context, r.name, r.namespace, h.revision)),
                  })}><History size={13} /> Roll back</GhostButton>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}
