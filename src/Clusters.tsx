// Adding a cluster: paste the kubeconfig it came with, the way Lens adds one. The text is kept as
// a file of its own in the plugin's folder and passed to kubectl with --kubeconfig, so the user's
// own kubeconfig is never written to.
import { useEffect, useRef, useState } from "react";
import { ShipWheel } from "lucide-react";
import { GhostButton, PrimaryButton, TextInput, tone } from "deck-plugin-sdk/ui";
import { args, isLocalServer, serverOn } from "./kube";
import { discardKubeconfig, keepKubeconfig, kubectl, stageKubeconfig, type Context } from "./run";
import { Note, YamlEditor } from "./Details";

export function AddCluster({ onAdded, onCancel }: {
  /** Called with the key of the first context the new kubeconfig names. */
  onAdded: (key: string) => void;
  /** Absent when there is nothing to go back to (no cluster at all yet). */
  onCancel?: () => void;
}) {
  const [text, setText] = useState("");
  const [staged, setStaged] = useState<{ file: string; contexts: Context[] } | null>(null);
  // The server each cluster in it talks to, as it will be saved: a local address replaced.
  const [servers, setServers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [failedPing, setFailedPing] = useState(false);

  // A kubeconfig staged and then left (Back, Cancel, the tab closed) is not kept.
  const pending = useRef<string | null>(null);
  pending.current = staged?.file ?? null;
  useEffect(() => () => { if (pending.current) void discardKubeconfig(pending.current); }, []);

  const clusters = staged
    ? [...new Map(staged.contexts.map((c) => [c.cluster, c.server])).entries()]
    : [];

  const next = async () => {
    setBusy(true);
    setError("");
    try {
      const s = await stageKubeconfig(text);
      setStaged(s);
      setServers(Object.fromEntries(s.contexts.map((c) => [c.cluster, c.server])));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const back = () => {
    if (staged) void discardKubeconfig(staged.file);
    setStaged(null);
    setFailedPing(false);
    setError("");
  };

  const add = async (anyway: boolean) => {
    if (!staged) return;
    setBusy(true);
    setError("");
    try {
      for (const [cluster, server] of clusters) {
        if (servers[cluster] && servers[cluster] !== server) await kubectl(args.setServer(staged.file, cluster, servers[cluster]));
      }
      if (!anyway) {
        try {
          await kubectl(args.ping(staged.contexts[0].key));
        } catch (e) {
          setFailedPing(true);
          setError(`The cluster did not answer: ${String((e as Error).message ?? e)}`);
          return;
        }
      }
      await keepKubeconfig(staged.file);
      pending.current = null;
      onAdded(staged.contexts[0].key);
    } catch (e) {
      console.warn("[kube] adding a cluster failed", e);
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-3">
      <div className="flex items-center gap-2">
        <ShipWheel size={16} style={{ color: "#326ce5" }} />
        <span className="text-[13px] font-medium text-text-primary">Add a cluster</span>
      </div>

      {!staged && (
        <>
          <div className="flex flex-col gap-1 text-[12px] leading-relaxed text-text-muted" style={{ maxWidth: 640 }}>
            <span>Paste the kubeconfig your cluster gives you. Where to find it:</span>
            <span>· k3s: <code className="font-mono text-text-secondary">sudo cat /etc/rancher/k3s/k3s.yaml</code> on the server</span>
            <span>· kubeadm: <code className="font-mono text-text-secondary">/etc/kubernetes/admin.conf</code> on a control-plane node</span>
            <span>· MicroK8s: <code className="font-mono text-text-secondary">microk8s config</code></span>
            <span>· A hosted cluster (DigitalOcean, Linode, Civo, Rancher): download it from its dashboard</span>
            <span>· EKS, GKE and AKS: their command line adds it to your own kubeconfig, which is read already</span>
            <span>This PC has to reach the cluster's API port, usually 6443.</span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-subtle" style={{ minHeight: 240 }}>
            <YamlEditor value={text} onChange={setText} />
          </div>
          {error && <Note color={tone("red")}>{error}</Note>}
          <div className="flex items-center gap-2">
            <PrimaryButton onClick={() => void next()} disabled={busy || !text.trim()}>{busy ? "Reading…" : "Next"}</PrimaryButton>
            {onCancel && <GhostButton onClick={onCancel}>Cancel</GhostButton>}
          </div>
        </>
      )}

      {staged && (
        <>
          <section className="flex flex-col gap-1">
            <h3 className="text-[12px] font-medium text-text-secondary">Contexts</h3>
            {staged.contexts.map((c) => (
              <span key={c.key} className="text-[12.5px] text-text-secondary">
                {c.name} <span className="text-text-muted">· cluster {c.cluster}{c.namespace ? ` · namespace ${c.namespace}` : ""}</span>
              </span>
            ))}
          </section>
          <section className="flex flex-col gap-2" style={{ maxWidth: 560 }}>
            <h3 className="text-[12px] font-medium text-text-secondary">Server</h3>
            {clusters.map(([cluster, server]) => (
              <div key={cluster} className="flex flex-col gap-1">
                {clusters.length > 1 && <span className="text-[12px] text-text-muted">{cluster}</span>}
                <TextInput value={servers[cluster] ?? ""} onChange={(e) => setServers({ ...servers, [cluster]: e.target.value })} />
                {isLocalServer(server) && servers[cluster] === server && (
                  <LocalHint server={server} onHost={(h) => setServers({ ...servers, [cluster]: serverOn(server, h) })} />
                )}
              </div>
            ))}
          </section>
          {error && <Note color={tone("red")}>{error}</Note>}
          <div className="flex items-center gap-2">
            <PrimaryButton onClick={() => void add(false)} disabled={busy}>{busy ? "Connecting…" : "Add"}</PrimaryButton>
            {failedPing && <GhostButton onClick={() => void add(true)} disabled={busy}>Add anyway</GhostButton>}
            <GhostButton onClick={back} disabled={busy}>Back</GhostButton>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The kubeconfig a server leaves for itself points at 127.0.0.1, which from this PC is this PC.
 * Asks for the server's own address and keeps the scheme and port.
 */
function LocalHint({ server, onHost }: { server: string; onHost: (host: string) => void }) {
  const [host, setHost] = useState("");
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-subtle bg-elev px-3 py-2 text-[12px] text-text-muted">
      <span>
        <span style={{ color: tone("amber") }}>{server}</span> is the server's address for itself. From this PC,
        it needs the server's own name or IP.
      </span>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <TextInput value={host} onChange={(e) => setHost(e.target.value)} placeholder="vps.example.com or 203.0.113.5"
            onKeyDown={(e) => { if (e.key === "Enter" && host.trim()) onHost(host); }} />
        </div>
        <GhostButton onClick={() => onHost(host)} disabled={!host.trim()}>Use</GhostButton>
      </div>
    </div>
  );
}
