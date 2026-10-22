// The panel beside the table: one object's overview, its YAML (editable, written back with
// `kubectl replace`), a pod's logs, and the object's events.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  X, ScrollText, TerminalSquare, ArrowRightLeft, Trash2, RotateCw, Scale, Play, Pause,
  ShieldOff, Shield, LogOut, Eye, EyeOff, Copy, Save, Undo2, WrapText, Clock, Eraser,
} from "lucide-react";
import { Chip, tone, IconButton, Select, GhostButton, PrimaryButton, EmptyState, Tabs, TextInput } from "deck-plugin-sdk/ui";
import { monaco } from "deck-plugin-sdk/monaco";
import {
  age, decodeSecret, eventTime, kindActions, nodeStatus, podContainers, podReady, podRestarts,
  podStatus, selectorText, statusTone, args, type Kind, type Obj,
} from "./kube";
import { kubectl, kubectlJson, useLogs, withFile } from "./run";

// ---- small pieces ----------------------------------------------------------------------------

const TONES = { green: "green", amber: "amber", red: "red", blue: "blue" } as const;

/** A status word in its colour. */
export function StatusChip({ s }: { s: string }) {
  if (!s) return null;
  const t = statusTone(s);
  return <Chip color={t === "muted" ? "var(--text-muted)" : tone(TONES[t])}>{s}</Chip>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-6 items-start gap-3 py-0.5 text-[12px]">
      <span className="w-28 shrink-0 text-text-muted">{label}</span>
      <span className="min-w-0 flex-1 break-words text-text-secondary">{children}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-[12px] font-medium text-text-secondary">{title}</h3>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

function Labels({ labels }: { labels?: Record<string, string> }) {
  const entries = Object.entries(labels ?? {});
  if (!entries.length) return <span className="text-text-muted">None</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {entries.map(([k, v]) => (
        <span key={k} className="rounded bg-elev px-1.5 py-px font-mono text-[11px] text-text-secondary">{v ? `${k}=${v}` : k}</span>
      ))}
    </span>
  );
}

function Conditions({ o }: { o: Obj }) {
  const cs = (o.status?.conditions ?? []) as { type: string; status: string; reason?: string; message?: string; lastTransitionTime?: string }[];
  if (!cs.length) return null;
  const now = Date.now();
  return (
    <Section title="Conditions">
      {cs.map((c) => (
        <div key={c.type} className="flex min-h-6 items-center gap-2 text-[12px]" title={c.message}>
          <span className="w-40 shrink-0 truncate text-text-secondary">{c.type}</span>
          <StatusChip s={c.status} />
          <span className="min-w-0 flex-1 truncate text-text-muted">{c.reason ?? ""}</span>
          <span className="shrink-0 font-mono text-[11px] text-text-muted">{age(c.lastTransitionTime, now)}</span>
        </div>
      ))}
    </Section>
  );
}

/** A command's output or error, in a box under a toolbar. */
export function Note({ color, children }: { color?: string; children: React.ReactNode }) {
  return (
    <div className="whitespace-pre-wrap rounded-lg border border-subtle bg-elev px-3 py-2 font-mono text-[11.5px]"
      style={{ margin: "0 12px 8px", color: color ?? "var(--text-secondary)" }}>{children}</div>
  );
}

// ---- the YAML editor -------------------------------------------------------------------------

/** Monaco on YAML. Read-only unless `onChange` is given. Disposed with the component. */
export function YamlEditor({ value, onChange, readOnly }: { value: string; onChange?: (v: string) => void; readOnly?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const ed = useRef<ReturnType<typeof monaco.editor.create> | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  useEffect(() => {
    if (!host.current) return;
    const e = monaco.editor.create(host.current, {
      value, language: "yaml", theme: "deck-dark", readOnly,
      minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true,
      fontSize: 12.5, tabSize: 2, padding: { top: 8, bottom: 8 }, wordWrap: "off",
    });
    ed.current = e;
    const sub = e.onDidChangeModelContent(() => change.current?.(e.getValue()));
    return () => { sub.dispose(); e.dispose(); ed.current = null; };
  }, []);
  // A new value from outside (the object changed on the server, Revert) replaces the text; the
  // user's own typing comes back here as the same value and is left alone.
  useEffect(() => {
    const e = ed.current;
    if (e && e.getValue() !== value) e.setValue(value);
  }, [value]);
  useEffect(() => { ed.current?.updateOptions({ readOnly }); }, [readOnly]);
  return <div ref={host} className="min-h-0 flex-1" />;
}

/**
 * An object's YAML, editable. Save writes it back with `kubectl replace`, whose resourceVersion
 * check refuses an object someone changed since it was opened rather than overwriting their
 * change. While nothing is edited, the text follows the object as it changes.
 */
function YamlTab({ context, kind, o }: { context: string; kind: Kind; o: Obj }) {
  const [server, setServer] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = text !== server;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    let alive = true;
    kubectl(args.get(context, kind.resource, o.metadata.name, o.metadata.namespace, "yaml")).then((y) => {
      if (!alive) return;
      setServer(y);
      if (!dirtyRef.current) setText(y);
    }, (e) => { console.warn("[kube] could not read YAML", e); if (alive) setMsg({ ok: false, text: String(e.message ?? e) }); });
    return () => { alive = false; };
  }, [context, kind.resource, o.metadata.name, o.metadata.namespace, o.metadata.resourceVersion]);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const out = await withFile(text, (f) => kubectl(args.replace(context, f)));
      setMsg({ ok: true, text: out.trim() || "Saved" });
      setServer(text);
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error).message ?? e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <PrimaryButton onClick={() => void save()} disabled={!dirty || busy}>
          <Save size={13} /> {busy ? "Saving…" : "Save"}
        </PrimaryButton>
        <GhostButton onClick={() => { setText(server); setMsg(null); }} disabled={!dirty || busy}>
          <Undo2 size={13} /> Revert
        </GhostButton>
        {dirty && <span className="text-[11.5px] text-text-muted">Edited. Changes on the server no longer show until you save or revert.</span>}
      </div>
      {msg && <Note color={msg.ok ? tone("green") : tone("red")}>{msg.text}</Note>}
      <YamlEditor value={text} onChange={setText} />
    </div>
  );
}

// ---- logs ------------------------------------------------------------------------------------

function LogsTab({ context, o, initial }: { context: string; o: Obj; initial?: string }) {
  const containers = podContainers(o);
  const [container, setContainer] = useState(initial ?? containers.find((c) => !c.init)?.name ?? "");
  const [previous, setPrevious] = useState(false);
  const [timestamps, setTimestamps] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [find, setFind] = useState("");
  const { lines, state, clear } = useLogs(context, o.metadata.name, o.metadata.namespace ?? "", container,
    { previous, timestamps, tail: 1000 });
  const box = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  useEffect(() => { if (initial) setContainer(initial); }, [initial]);
  // Follow the end while it is in view; scrolling up to read stops following until scrolled back down.
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const shown = useMemo(() => {
    if (!find) return lines;
    const f = find.toLowerCase();
    return lines.filter((l) => l.toLowerCase().includes(f));
  }, [lines, find]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-3 py-2">
        {containers.length > 1 && (
          <Select value={container} onChange={(e) => setContainer(e.target.value)} style={{ width: 160 }}>
            {containers.map((c) => <option key={c.name} value={c.name}>{c.init ? `${c.name} (init)` : c.name}</option>)}
          </Select>
        )}
        <div className="min-w-0 flex-1">
          <TextInput value={find} onChange={(e) => setFind(e.target.value)} placeholder="Filter lines" />
        </div>
        <IconButton title="Previous container's log (before its last restart)" active={previous} onClick={() => setPrevious(!previous)}><RotateCw size={14} /></IconButton>
        <IconButton title="Timestamps" active={timestamps} onClick={() => setTimestamps(!timestamps)}><Clock size={14} /></IconButton>
        <IconButton title="Wrap lines" active={wrap} onClick={() => setWrap(!wrap)}><WrapText size={14} /></IconButton>
        <IconButton title="Copy the lines shown" onClick={() => void navigator.clipboard.writeText(shown.join("\n"))}><Copy size={14} /></IconButton>
        <IconButton title="Clear" onClick={clear}><Eraser size={14} /></IconButton>
      </div>
      <pre ref={box}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}
        className={"min-h-0 flex-1 overflow-auto px-3 pb-3 font-mono text-[11.5px] leading-[1.45] text-text-secondary "
          + (wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre")}>
        {shown.join("\n")}
        {!lines.length && <span className="text-text-muted">{state === "running" ? "Waiting for output…" : "No output."}</span>}
      </pre>
      <div className="shrink-0 px-3 pb-2 text-[11px] text-text-muted">
        {state === "running" ? (previous ? "Previous container" : "Following") : state === "ended" ? "Ended" : "kubectl logs failed; see Deck's log"}
        {" · "}{lines.length} lines{find ? `, ${shown.length} shown` : ""}
      </div>
    </div>
  );
}

// ---- events ----------------------------------------------------------------------------------

function EventsTab({ context, o }: { context: string; o: Obj }) {
  const [events, setEvents] = useState<Obj[] | null>(null);
  useEffect(() => {
    let alive = true;
    kubectlJson(args.events(context, o.metadata.namespace, o.metadata.uid ?? "")).then((l) => {
      if (alive) setEvents(l.items.sort((x, y) => Date.parse(eventTime(y) ?? "") - Date.parse(eventTime(x) ?? "")));
    }, (e) => { console.warn("[kube] could not read events", e); if (alive) setEvents([]); });
    return () => { alive = false; };
  }, [context, o.metadata.uid, o.metadata.resourceVersion]);
  if (!events) return <div className="px-3 py-3 text-[12px] text-text-muted">Loading…</div>;
  if (!events.length) return <EmptyState>No events for this object. The cluster keeps them for about an hour.</EmptyState>;
  const now = Date.now();
  return (
    <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
      {events.map((e) => (
        <div key={e.metadata.uid ?? e.metadata.name} className="flex flex-col gap-0.5 border-b border-subtle py-1.5 text-[12px]">
          <div className="flex items-center gap-2">
            <StatusChip s={e.type ?? ""} />
            <span className="font-medium text-text-secondary">{e.reason}</span>
            {(e.count ?? 1) > 1 && <span className="text-text-muted">×{e.count}</span>}
            <span className="ml-auto font-mono text-[11px] text-text-muted">{age(eventTime(e), now)}</span>
          </div>
          <span className="break-words text-text-muted">{e.message}</span>
        </div>
      ))}
    </div>
  );
}

// ---- overview --------------------------------------------------------------------------------

function Overview({ kind, o, onLogs, onShell }: {
  kind: Kind; o: Obj; onLogs: (container: string) => void; onShell: (container: string) => void;
}) {
  const now = Date.now();
  const m = o.metadata;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-3 py-3">
      <Section title="Metadata">
        <Field label="Created">{m.creationTimestamp ? `${age(m.creationTimestamp, now)} ago (${new Date(m.creationTimestamp).toLocaleString()})` : ""}</Field>
        {m.namespace && <Field label="Namespace">{m.namespace}</Field>}
        <Field label="Labels"><Labels labels={m.labels} /></Field>
        {!!Object.keys(m.annotations ?? {}).length && <Field label="Annotations"><Annotations a={m.annotations!} /></Field>}
        {!!m.ownerReferences?.length && <Field label="Owner">{m.ownerReferences.map((r) => `${r.kind}/${r.name}`).join(", ")}</Field>}
      </Section>
      <KindOverview kind={kind} o={o} now={now} onLogs={onLogs} onShell={onShell} />
      <Conditions o={o} />
    </div>
  );
}

function Annotations({ a }: { a: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  const entries = Object.entries(a);
  if (!open) return <button className="text-text-muted hover:text-text-primary" onClick={() => setOpen(true)}>{entries.length} annotations, show</button>;
  return (
    <span className="flex flex-col gap-0.5">
      {entries.map(([k, v]) => <span key={k} className="break-all font-mono text-[11px]"><span className="text-text-muted">{k}: </span>{v}</span>)}
    </span>
  );
}

function KindOverview({ kind, o, now, onLogs, onShell }: {
  kind: Kind; o: Obj; now: number; onLogs: (c: string) => void; onShell: (c: string) => void;
}) {
  const s = o.spec ?? {}, st = o.status ?? {};
  switch (kind.kind) {
    case "Pod": {
      const statuses = new Map<string, { ready?: boolean; restartCount?: number; state?: Record<string, { reason?: string; startedAt?: string }> }>(
        [...(st.initContainerStatuses ?? []), ...(st.containerStatuses ?? [])].map((c) => [c.name, c]));
      const specs = new Map<string, { image: string; ports?: { containerPort: number; protocol?: string }[] }>(
        [...(s.initContainers ?? []), ...(s.containers ?? [])].map((c) => [c.name, c]));
      return (
        <>
          <Section title="Pod">
            <Field label="Status"><StatusChip s={podStatus(o)} /></Field>
            <Field label="Ready">{podReady(o)}</Field>
            <Field label="Restarts">{podRestarts(o)}</Field>
            <Field label="Node">{s.nodeName ?? ""}</Field>
            <Field label="Pod IP"><span className="font-mono">{st.podIP ?? ""}</span></Field>
            <Field label="QoS class">{st.qosClass ?? ""}</Field>
            <Field label="Service account">{s.serviceAccountName ?? ""}</Field>
          </Section>
          <Section title="Containers">
            {podContainers(o).map(({ name, init }) => {
              const cs = statuses.get(name);
              const state = cs?.state ? Object.keys(cs.state)[0] : "";
              const reason = cs?.state?.[state]?.reason;
              return (
                <div key={name} className="group flex flex-col gap-0.5 rounded-md px-2 py-1.5 hover:bg-white/5">
                  <div className="flex items-center gap-2 text-[12.5px]">
                    <span className="font-medium text-text-primary">{name}</span>
                    {init && <span className="text-[11px] text-text-muted">init</span>}
                    {state && <StatusChip s={reason ?? state[0].toUpperCase() + state.slice(1)} />}
                    {!!cs?.restartCount && <span className="text-[11px] text-text-muted">{cs.restartCount} restarts</span>}
                    <span className="ml-auto flex gap-0.5 opacity-0 group-hover:opacity-100">
                      <IconButton size="row" title={`Logs of ${name}`} onClick={() => onLogs(name)}><ScrollText size={12} /></IconButton>
                      {!init && <IconButton size="row" title={`Shell in ${name}`} onClick={() => onShell(name)}><TerminalSquare size={12} /></IconButton>}
                    </span>
                  </div>
                  <span className="truncate font-mono text-[11px] text-text-muted" title={specs.get(name)?.image}>{specs.get(name)?.image}</span>
                  {!!specs.get(name)?.ports?.length && (
                    <span className="font-mono text-[11px] text-text-muted">
                      {specs.get(name)!.ports!.map((p) => `${p.containerPort}/${p.protocol ?? "TCP"}`).join(", ")}
                    </span>
                  )}
                </div>
              );
            })}
          </Section>
        </>
      );
    }
    case "Deployment": case "StatefulSet": case "DaemonSet": case "ReplicaSet": {
      const images = ((s.template?.spec?.containers ?? []) as { name: string; image: string }[]);
      return (
        <Section title={kind.label.replace(/s$/, "")}>
          {s.replicas !== undefined && <Field label="Replicas">{`${st.readyReplicas ?? st.numberReady ?? 0} ready of ${s.replicas}`}</Field>}
          {kind.kind === "DaemonSet" && <Field label="Scheduled">{`${st.numberReady ?? 0} ready of ${st.desiredNumberScheduled ?? 0}`}</Field>}
          <Field label="Selector"><span className="font-mono">{selectorText(s.selector)}</span></Field>
          {s.strategy?.type && <Field label="Strategy">{s.strategy.type}</Field>}
          {s.updateStrategy?.type && <Field label="Update strategy">{s.updateStrategy.type}</Field>}
          <Field label="Images">
            <span className="flex flex-col">{images.map((c) => <span key={c.name} className="break-all font-mono text-[11px]">{c.image}</span>)}</span>
          </Field>
        </Section>
      );
    }
    case "Service":
      return (
        <Section title="Service">
          <Field label="Type">{s.type}</Field>
          <Field label="Cluster IP"><span className="font-mono">{s.clusterIP}</span></Field>
          <Field label="Selector"><span className="font-mono">{selectorText(s.selector) || "None"}</span></Field>
          <Field label="Ports">
            <span className="flex flex-col font-mono text-[11px]">
              {((s.ports ?? []) as { name?: string; port: number; targetPort?: number | string; nodePort?: number; protocol?: string }[]).map((p) => (
                <span key={`${p.port}/${p.protocol}`}>{p.name ? `${p.name}: ` : ""}{p.port}{p.targetPort !== undefined ? ` → ${p.targetPort}` : ""}{p.nodePort ? ` (node ${p.nodePort})` : ""}/{p.protocol ?? "TCP"}</span>
              ))}
            </span>
          </Field>
        </Section>
      );
    case "ConfigMap":
      return (
        <Section title="Data">
          {Object.entries((o.data ?? {}) as Record<string, string>).map(([k, v]) => (
            <div key={k} className="flex flex-col gap-1 py-1">
              <span className="font-mono text-[11.5px] text-text-secondary">{k}</span>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-subtle bg-elev px-2 py-1.5 font-mono text-[11px] text-text-muted">{v}</pre>
            </div>
          ))}
          {!Object.keys(o.data ?? {}).length && <span className="text-[12px] text-text-muted">No data.</span>}
        </Section>
      );
    case "Secret":
      return (
        <Section title="Data">
          <Field label="Type">{o.type}</Field>
          {Object.entries((o.data ?? {}) as Record<string, string>).map(([k, v]) => <SecretValue key={k} name={k} b64={v} />)}
          {!Object.keys(o.data ?? {}).length && <span className="text-[12px] text-text-muted">No data.</span>}
        </Section>
      );
    case "Node": {
      const info = st.nodeInfo ?? {};
      return (
        <>
          <Section title="Node">
            <Field label="Status"><StatusChip s={nodeStatus(o)} /></Field>
            <Field label="Kubelet">{info.kubeletVersion}</Field>
            <Field label="OS">{`${info.osImage ?? ""} (${info.operatingSystem ?? ""}/${info.architecture ?? ""})`}</Field>
            <Field label="Kernel">{info.kernelVersion}</Field>
            <Field label="Runtime">{info.containerRuntimeVersion}</Field>
            <Field label="Addresses">
              <span className="font-mono">{((st.addresses ?? []) as { type: string; address: string }[]).map((a) => `${a.type} ${a.address}`).join(", ")}</span>
            </Field>
            <Field label="Taints">
              {((s.taints ?? []) as { key: string; value?: string; effect: string }[]).map((t) => `${t.key}${t.value ? `=${t.value}` : ""}:${t.effect}`).join(", ") || "None"}
            </Field>
          </Section>
          <Section title="Capacity">
            {["cpu", "memory", "pods", "ephemeral-storage"].map((r) => (
              <Field key={r} label={r}>{`${st.allocatable?.[r] ?? "?"} allocatable of ${st.capacity?.[r] ?? "?"}`}</Field>
            ))}
          </Section>
        </>
      );
    }
    case "Event":
      return (
        <Section title="Event">
          <Field label="Type"><StatusChip s={o.type ?? ""} /></Field>
          <Field label="Reason">{o.reason}</Field>
          <Field label="Object">{`${o.involvedObject?.kind}/${o.involvedObject?.name}`}</Field>
          <Field label="Message">{o.message}</Field>
          <Field label="Count">{o.count ?? 1}</Field>
          <Field label="Last seen">{age(eventTime(o), now)}</Field>
          <Field label="Source">{o.source?.component ?? o.reportingComponent ?? ""}</Field>
        </Section>
      );
    case "CronJob":
      return (
        <Section title="Cron job">
          <Field label="Schedule"><span className="font-mono">{s.schedule}</span></Field>
          <Field label="Suspended">{s.suspend ? "Yes" : "No"}</Field>
          <Field label="Last run">{st.lastScheduleTime ? `${age(st.lastScheduleTime, now)} ago` : "Never"}</Field>
          <Field label="Running now">{st.active?.length ?? 0}</Field>
        </Section>
      );
    default:
      return null;
  }
}

function SecretValue({ name, b64 }: { name: string; b64: string }) {
  const [shown, setShown] = useState(false);
  const v = useMemo(() => decodeSecret(b64), [b64]);
  return (
    <div className="flex flex-col gap-1 py-1">
      <div className="flex items-center gap-1">
        <span className="font-mono text-[11.5px] text-text-secondary">{name}</span>
        {v.binary && <span className="text-[11px] text-text-muted">binary, shown as base64</span>}
        <span className="ml-auto flex gap-0.5">
          <IconButton size="row" title={shown ? "Hide" : "Show"} onClick={() => setShown(!shown)}>{shown ? <EyeOff size={12} /> : <Eye size={12} />}</IconButton>
          <IconButton size="row" title="Copy the value" onClick={() => void navigator.clipboard.writeText(v.text)}><Copy size={12} /></IconButton>
        </span>
      </div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-subtle bg-elev px-2 py-1.5 font-mono text-[11px] text-text-muted">
        {shown ? v.text : "•".repeat(Math.min(24, v.text.length || 8))}
      </pre>
    </div>
  );
}

// ---- the panel -------------------------------------------------------------------------------

export type Act = "logs" | "shell" | "forward" | "scale" | "restart" | "trigger" | "suspend" | "cordon" | "drain" | "delete";
type Tab = "overview" | "yaml" | "logs" | "events";

/** The actions a row's menu and the panel's header both offer, for one object. */
export function actionsFor(kind: Kind, o: Obj): { act: Act; label: string; icon: typeof X; danger?: boolean }[] {
  const out: { act: Act; label: string; icon: typeof X; danger?: boolean }[] = [];
  for (const a of kindActions(kind.kind)) {
    if (a === "logs") out.push({ act: a, label: "Logs", icon: ScrollText });
    if (a === "shell") out.push({ act: a, label: "Shell", icon: TerminalSquare });
    if (a === "forward") out.push({ act: a, label: "Port-forward…", icon: ArrowRightLeft });
    if (a === "scale") out.push({ act: a, label: "Scale…", icon: Scale });
    if (a === "restart") out.push({ act: a, label: "Restart", icon: RotateCw });
    if (a === "trigger") out.push({ act: a, label: "Run now", icon: Play });
    if (a === "suspend") out.push(o.spec?.suspend ? { act: a, label: "Resume", icon: Play } : { act: a, label: "Suspend", icon: Pause });
    if (a === "cordon") out.push(o.spec?.unschedulable ? { act: a, label: "Uncordon", icon: Shield } : { act: a, label: "Cordon", icon: ShieldOff });
    if (a === "drain") out.push({ act: a, label: "Drain…", icon: LogOut, danger: true });
  }
  out.push({ act: "delete", label: "Delete…", icon: Trash2, danger: true });
  return out;
}

export function Details({ context, kind, o, onClose, onAct, logsFor }: {
  context: string;
  kind: Kind;
  o: Obj;
  onClose: () => void;
  onAct: (act: Act, container?: string) => void;
  /** Set to a container's name to open the Logs tab on it. */
  logsFor?: { container: string; n: number };
}) {
  const isPod = kind.kind === "Pod";
  const [tab, setTab] = useState<Tab>(logsFor && isPod ? "logs" : "overview");
  const [logContainer, setLogContainer] = useState(logsFor?.container);
  useEffect(() => { if (logsFor && isPod) { setTab("logs"); setLogContainer(logsFor.container); } }, [logsFor?.n]);
  // Another object opened in the same panel starts on its overview, unless it was opened for its logs.
  const key = `${kind.resource}/${o.metadata.namespace}/${o.metadata.name}`;
  const lastKey = useRef(key);
  useEffect(() => {
    if (lastKey.current === key) return;
    lastKey.current = key;
    if (!(logsFor && isPod)) setTab("overview");
  }, [key]);

  const tabs: { value: Tab; label: string }[] = [
    { value: "overview", label: "Overview" },
    { value: "yaml", label: "YAML" },
    ...(isPod ? [{ value: "logs" as Tab, label: "Logs" }] : []),
    ...(kind.kind !== "Event" ? [{ value: "events" as Tab, label: "Events" }] : []),
  ];
  const acts = actionsFor(kind, o).filter((a) => a.act !== "logs");

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 pt-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium text-text-primary" title={o.metadata.name}>{o.metadata.name}</span>
          <span className="truncate text-[11px] text-text-muted">{kind.kind}{o.metadata.namespace ? ` in ${o.metadata.namespace}` : ""}</span>
        </div>
        {acts.map((a) => (
          <IconButton key={a.act} title={a.label.replace("…", "")} danger={a.danger} onClick={() => onAct(a.act)}>
            <a.icon size={14} />
          </IconButton>
        ))}
        <i aria-hidden className="mx-1 h-3.5 w-px bg-white/10" />
        <IconButton title="Close" onClick={onClose}><X size={14} /></IconButton>
      </div>
      <div className="shrink-0 px-3 pt-1">
        <Tabs value={tab} onChange={setTab} options={tabs} layoutId="kube-details-tab" />
      </div>
      {tab === "overview" && <Overview kind={kind} o={o}
        onLogs={(c) => { setLogContainer(c); setTab("logs"); }}
        onShell={(c) => onAct("shell", c)} />}
      {tab === "yaml" && <YamlTab context={context} kind={kind} o={o} />}
      {tab === "logs" && isPod && <LogsTab context={context} o={o} initial={logContainer} />}
      {tab === "events" && <EventsTab context={context} o={o} />}
    </div>
  );
}

// ---- creating ------------------------------------------------------------------------------------

const TEMPLATE = `apiVersion: v1
kind: ConfigMap
metadata:
  name: example
  namespace: default
data:
  key: value
`;

/** A new object from YAML, created with `kubectl apply`. Several, separated by `---`, work too. */
export function CreatePanel({ context, namespace, onClose }: { context: string; namespace: string; onClose: () => void }) {
  const [text, setText] = useState(() => TEMPLATE.replace("namespace: default", `namespace: ${namespace || "default"}`));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const create = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const out = await withFile(text, (f) => kubectl(args.apply(context, f)));
      setMsg({ ok: true, text: out.trim() || "Applied" });
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error).message ?? e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <span className="flex-1 text-[13px] font-medium text-text-primary">New resource</span>
        <PrimaryButton onClick={() => void create()} disabled={busy}>{busy ? "Applying…" : "Apply"}</PrimaryButton>
        <IconButton title="Close" onClick={onClose}><X size={14} /></IconButton>
      </div>
      {msg && <Note color={msg.ok ? tone("green") : tone("red")}>{msg.text}</Note>}
      <YamlEditor value={text} onChange={setText} />
    </div>
  );
}
