// node kube.check.mjs
//
// The plugin's logic, in node with no Deck and no cluster around it. The parts worth the most:
// podStatus, which has to say CrashLoopBackOff where the phase says Running; the watch-stream
// splitter, which is wrong the moment a string value holds a "}"; and the kubectl arguments,
// since a missing --context sends a delete to whichever cluster the user's terminal points at.
import assert from "node:assert";
import { build } from "esbuild";

const out = await build({
  entryPoints: ["src/kube.ts"],
  bundle: true, format: "esm", write: false, platform: "node",
});
const k = await import(
  `data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`
);

// ---- age -------------------------------------------------------------------------------------
const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;
assert.equal(k.humanDuration(5 * S), "5s");
assert.equal(k.humanDuration(119 * S), "119s");
assert.equal(k.humanDuration(2 * M + 30 * S), "2m30s");
assert.equal(k.humanDuration(5 * M), "5m");
assert.equal(k.humanDuration(45 * M), "45m");
assert.equal(k.humanDuration(3 * H + 20 * M), "3h20m");
assert.equal(k.humanDuration(30 * H), "30h");
assert.equal(k.humanDuration(3 * D + 4 * H), "3d4h");
assert.equal(k.humanDuration(40 * D), "40d");
assert.equal(k.humanDuration(800 * D), "2y70d");
assert.equal(k.humanDuration(-5 * S), "0s", "clock skew never shows a negative age");
assert.equal(k.age(undefined, Date.now()), "");

// ---- pod status ------------------------------------------------------------------------------
const pod = (status, extra = {}) => ({
  metadata: { name: "p", namespace: "default", ...extra.metadata },
  spec: { containers: [{ name: "app" }, { name: "side" }], ...extra.spec },
  status,
});
assert.equal(k.podStatus(pod({
  phase: "Running",
  containerStatuses: [
    { name: "app", ready: true, state: { running: {} } },
    { name: "side", ready: true, state: { running: {} } },
  ],
})), "Running");
assert.equal(k.podStatus(pod({
  phase: "Running",
  containerStatuses: [
    { name: "app", ready: false, restartCount: 7, state: { waiting: { reason: "CrashLoopBackOff" } } },
    { name: "side", ready: true, state: { running: {} } },
  ],
})), "CrashLoopBackOff", "a crashing container wins over the Running phase");
assert.equal(k.podStatus(pod({
  phase: "Pending",
  initContainerStatuses: [
    { name: "a", state: { terminated: { exitCode: 0 } } },
    { name: "b", state: { running: {} } },
  ],
}, { spec: { initContainers: [{ name: "a" }, { name: "b" }] } })), "Init:1/2");
assert.equal(k.podStatus(pod({
  phase: "Pending",
  initContainerStatuses: [{ name: "a", state: { terminated: { exitCode: 1, reason: "Error" } } }],
}, { spec: { initContainers: [{ name: "a" }] } })), "Init:Error");
assert.equal(k.podStatus(pod({
  phase: "Pending",
  initContainerStatuses: [{ name: "a", state: { waiting: { reason: "ImagePullBackOff" } } }],
}, { spec: { initContainers: [{ name: "a" }] } })), "Init:ImagePullBackOff");
assert.equal(k.podStatus(pod({
  phase: "Running",
  containerStatuses: [{ name: "app", state: { terminated: { exitCode: 137 } } }],
})), "ExitCode:137");
assert.equal(k.podStatus(pod({
  phase: "Running",
  conditions: [{ type: "Ready", status: "True" }],
  containerStatuses: [
    { name: "app", ready: true, state: { running: {} } },
    { name: "side", state: { terminated: { reason: "Completed", exitCode: 0 } } },
  ],
})), "Running", "a finished sidecar beside a running container is still Running");
assert.equal(k.podStatus(pod({ phase: "Running", containerStatuses: [] },
  { metadata: { deletionTimestamp: "2026-10-22T00:00:00Z" } })), "Terminating");
assert.equal(k.podStatus(pod({ phase: "Failed", reason: "Evicted" })), "Evicted");

const ready = pod({ containerStatuses: [{ name: "app", ready: true, restartCount: 2 }, { name: "side", ready: false, restartCount: 1 }] });
assert.equal(k.podReady(ready), "1/2");
assert.equal(k.podRestarts(ready), 3);
assert.deepEqual(
  k.podContainers({ metadata: { name: "p" }, spec: { initContainers: [{ name: "i" }], containers: [{ name: "c" }] } }),
  [{ name: "i", init: true }, { name: "c", init: false }],
);

assert.equal(k.statusTone("Running"), "green");
assert.equal(k.statusTone("CrashLoopBackOff"), "red");
assert.equal(k.statusTone("Pending"), "amber");
assert.equal(k.statusTone("Init:1/2"), "amber");
assert.equal(k.statusTone("Init:Error"), "red");
assert.equal(k.statusTone("Completed"), "blue");
assert.equal(k.statusTone("Ready,SchedulingDisabled"), "muted");
assert.equal(k.statusTone("Warning"), "red");

// ---- quantities ----------------------------------------------------------------------------
assert.equal(k.parseQuantity("250m"), 0.25);
assert.equal(k.parseQuantity("2"), 2);
assert.equal(k.parseQuantity("128Mi"), 128 * 2 ** 20);
assert.equal(k.parseQuantity("1Gi"), 2 ** 30);
assert.equal(k.parseQuantity("500k"), 500e3);
assert.equal(k.parseQuantity("1e3"), 1000);
assert.equal(k.parseQuantity("1500000n"), 0.0015);
assert.ok(Number.isNaN(k.parseQuantity("lots")));
assert.ok(Number.isNaN(k.parseQuantity(undefined)));
assert.equal(k.fmtCpu(0.25), "250m");
assert.equal(k.fmtCpu(1.5), "1.5");
assert.equal(k.fmtBytes(128 * 2 ** 20), "128Mi");
assert.equal(k.fmtBytes(1.5 * 2 ** 30), "1.5Gi");

// ---- columns ---------------------------------------------------------------------------------
const col = (resource, title, o) =>
  k.KINDS.find((x) => x.resource === resource).columns.find((c) => c.title === title).get(o, Date.now());
assert.equal(col("deployments", "Ready", { metadata: { name: "d" }, spec: { replicas: 3 }, status: { readyReplicas: 2 } }), "2/3");
assert.equal(col("deployments", "Ready", { metadata: { name: "d" }, spec: { replicas: 0 }, status: {} }), "0/0");
assert.equal(col("services", "Ports", { metadata: { name: "s" }, spec: { ports: [{ port: 80, protocol: "TCP" }, { port: 443, nodePort: 30443 }] } }), "80/TCP,443:30443/TCP");
assert.equal(col("services", "External IP", { metadata: { name: "s" }, spec: { type: "LoadBalancer" }, status: {} }), "<pending>");
assert.equal(col("services", "External IP", { metadata: { name: "s" }, spec: { type: "LoadBalancer" }, status: { loadBalancer: { ingress: [{ hostname: "localhost" }] } } }), "localhost");
assert.equal(col("services", "External IP", { metadata: { name: "s" }, spec: { type: "ClusterIP" } }), "<none>");
assert.equal(k.nodeStatus({ metadata: { name: "n" }, spec: { unschedulable: true }, status: { conditions: [{ type: "Ready", status: "True" }] } }), "Ready,SchedulingDisabled");
assert.equal(k.nodeRoles({ metadata: { name: "n", labels: { "node-role.kubernetes.io/control-plane": "" } } }), "control-plane");
assert.equal(k.jobStatus({ metadata: { name: "j" }, status: { conditions: [{ type: "Complete", status: "True" }] } }), "Complete");
assert.equal(col("endpoints", "Endpoints", { metadata: { name: "e" }, subsets: [{ addresses: [{ ip: "10.0.0.1" }, { ip: "10.0.0.2" }], ports: [{ port: 80 }] }] }), "10.0.0.1:80,10.0.0.2:80");
assert.equal(new Set(k.KINDS.map((x) => x.resource)).size, k.KINDS.length, "no kind listed twice");

// ---- custom resources ------------------------------------------------------------------------
const crds = k.crdKinds({ items: [{
  metadata: { name: "certificates.cert-manager.io" },
  spec: {
    group: "cert-manager.io", scope: "Namespaced",
    names: { kind: "Certificate", plural: "certificates" },
    versions: [
      { name: "v1alpha1", served: true, storage: false },
      { name: "v1", served: true, storage: true, additionalPrinterColumns: [
        { name: "Ready", type: "string", jsonPath: '.status.conditions[?(@.type=="Ready")].status' },
        { name: "Secret", type: "string", jsonPath: ".spec.secretName" },
        { name: "Issuer", type: "string", jsonPath: ".spec.issuerRef.name", priority: 1 },
        { name: "Age", type: "date", jsonPath: ".metadata.creationTimestamp" },
      ] },
    ],
  },
}] });
assert.equal(crds[0].resource, "certificates.cert-manager.io");
assert.equal(crds[0].namespaced, true);
assert.deepEqual(crds[0].columns.map((c) => c.title), ["Ready", "Secret", "Age"], "wide-only columns are left out, Age not doubled");
const cert = { metadata: { name: "c", creationTimestamp: new Date(Date.now() - 5 * S).toISOString() }, spec: { secretName: "tls" }, status: { conditions: [{ type: "Issuing", status: "False" }, { type: "Ready", status: "True" }] } };
assert.equal(crds[0].columns[0].get(cert, Date.now()), "True");
assert.equal(crds[0].columns[1].get(cert, Date.now()), "tls");
assert.equal(crds[0].columns[2].get(cert, Date.now()), "5s");

assert.equal(k.jsonPath({ a: { b: [{ c: 1 }, { c: 2 }] } }, ".a.b[1].c"), 2);
assert.equal(k.jsonPath({ a: { "x.y": 3 } }, ".a['x.y']"), 3);
assert.equal(k.jsonPath({ a: 1 }, "{.a}"), 1, "kubectl's braces are allowed");
assert.equal(k.jsonPath({ a: 1 }, ".b.c"), undefined);
assert.equal(k.jsonPath({ a: 1 }, "a"), undefined, "a path not in the subset is undefined, not a guess");

// ---- the watch stream ------------------------------------------------------------------------
const split = k.jsonSplitter();
const stream = [
  "{",
  '    "type": "ADDED",',
  '    "object": {',
  '        "metadata": { "name": "a", "namespace": "ns" },',
  '        "data": { "x": "}" }',
  "    }",
  "}",
  "{",
  '    "type": "DELETED",',
  '    "object": { "metadata": { "name": "a", "namespace": "ns" } }',
  "}\r",
  '{"type":"MODIFIED","object":{"metadata":{"name":"b"}}}',
];
const got = stream.flatMap(split);
assert.equal(got.length, 3, "three objects, a \"}\" inside a string notwithstanding");
assert.equal(got[0].object.data.x, "}");
assert.equal(got[1].type, "DELETED");
assert.equal(got[2].object.metadata.name, "b", "a compact object on one line is one object");
assert.deepEqual(["error: something", "W1022 warning"].flatMap(k.jsonSplitter()), [], "stray lines are not objects");

const rows = new Map();
const obj = (name, rv) => ({ metadata: { name, namespace: "ns", resourceVersion: rv } });
assert.equal(k.applyEvent(rows, { type: "ADDED", object: obj("a", "1") }), true);
assert.equal(k.applyEvent(rows, { type: "MODIFIED", object: obj("a", "1") }), false, "the same version is no change");
assert.equal(k.applyEvent(rows, { type: "MODIFIED", object: obj("a", "2") }), true);
assert.equal(rows.get("ns/a").metadata.resourceVersion, "2");
assert.equal(k.applyEvent(rows, { type: "BOOKMARK", object: obj("a", "3") }), false);
assert.equal(k.applyEvent(rows, { type: "DELETED", object: obj("a", "3") }), true);
assert.equal(rows.size, 0);

// ---- kubectl's arguments ---------------------------------------------------------------------
const pods = k.KINDS.find((x) => x.resource === "pods");
const nodes = k.KINDS.find((x) => x.resource === "nodes");
assert.deepEqual(k.args.watch("docker-desktop", pods, ""),
  ["get", "pods", "-A", "--watch", "--output-watch-events", "-o", "json", "--context", "docker-desktop"]);
assert.deepEqual(k.args.watch("c", pods, "kube-system").slice(0, 4), ["get", "pods", "-n", "kube-system"]);
assert.ok(!k.args.watch("c", nodes, "kube-system").includes("-n"), "a cluster-wide kind takes no namespace");
assert.ok(!k.args.watch("c", nodes, "").includes("-A"));
assert.deepEqual(k.args.contexts(), ["config", "view", "-o", "json"]);
for (const [name, a] of Object.entries({
  delete: k.args.delete("c", "pods", "p", "ns"),
  scale: k.args.scale("c", "deployments", "d", "ns", 2),
  restart: k.args.restart("c", "deployments", "d", "ns"),
  replace: k.args.replace("c", "f.yaml"),
  drain: k.args.drain("c", "n"),
  logs: k.args.logs("c", "p", "ns", "app", { follow: true, previous: false, tail: 500, timestamps: false }),
  forward: k.args.portForward("c", "pod/p", "ns", "", 80),
})) {
  const i = a.indexOf("--context");
  assert.ok(i >= 0 && a[i + 1] === "c", `${name} names the context`);
  assert.ok(!a.includes("use-context"), `${name} never changes the kubeconfig's current context`);
}
assert.ok(!k.args.delete("", "pods", "p", "ns").includes("--context"), "no context: kubectl's current one");
assert.deepEqual(k.args.logs("", "p", "ns", "app", { follow: true, previous: true, tail: 100, timestamps: true }),
  ["logs", "p", "-n", "ns", "-c", "app", "--tail=100", "--previous", "--timestamps"], "a previous container's log cannot be followed");
assert.deepEqual(k.args.portForward("", "svc/web", "ns", "", 80), ["port-forward", "svc/web", "-n", "ns", ":80"]);
assert.ok(k.args.suspend("", "cj", "ns", true).includes('{"spec":{"suspend":true}}'));

assert.equal(
  k.shellCommand("arn:aws:eks:eu-west-1:1:cluster/x y", "web-0", "prod", "app"),
  'kubectl --context "arn:aws:eks:eu-west-1:1:cluster/x y" exec -it -n prod web-0 -c app -- sh -c "command -v bash >/dev/null && exec bash || exec sh"',
);
assert.ok(!k.shellCommand("", "p", "ns", "c").includes("--context"));

assert.deepEqual(k.helmArgs.list("c", ""), ["list", "-A", "-o", "json", "--kube-context", "c"]);
assert.deepEqual(k.helmArgs.rollback("", "r", "ns", 3), ["rollback", "r", "3", "-n", "ns", "--wait=false"]);
assert.equal(k.helmTime("2026-10-22 10:01:02.123456 +0200 CEST"), "2026-10-22T10:01:02+02:00");
assert.ok(!Number.isNaN(Date.parse(k.helmTime("2026-10-22 10:01:02.123456 +0000 UTC"))));

// ---- other output ------------------------------------------------------------------------------
const ctxs = k.parseContexts({ "current-context": "b", contexts: [{ name: "a", context: { cluster: "ca" } }, { name: "b", context: { cluster: "cb", namespace: "dev" } }] });
assert.equal(ctxs.current, "b");
assert.deepEqual(ctxs.contexts[1], { name: "b", cluster: "cb", namespace: "dev" });
assert.deepEqual(k.parseContexts({}), { current: "", contexts: [] });

const topPods = k.parseTop("kube-system   coredns-1   3m   12Mi\ndefault web 250m 1Gi\n\n", false);
assert.deepEqual(topPods.get("kube-system/coredns-1"), { cpu: 0.003, memory: 12 * 2 ** 20 });
assert.deepEqual(topPods.get("default/web"), { cpu: 0.25, memory: 2 ** 30 });
const topNodes = k.parseTop("docker-desktop   180m   2%   1700Mi   21%", true);
assert.deepEqual(topNodes.get("/docker-desktop"), { cpu: 0.18, memory: 1700 * 2 ** 20 });

assert.equal(k.forwardedPort("Forwarding from 127.0.0.1:54321 -> 80"), 54321);
assert.equal(k.forwardedPort("Forwarding from [::1]:8080 -> 8080"), 8080);
assert.equal(k.forwardedPort("Handling connection for 8080"), null);

assert.deepEqual(k.decodeSecret(Buffer.from("héllo").toString("base64")), { text: "héllo", binary: false });
assert.equal(k.decodeSecret(Buffer.from([0xff, 0xfe, 0x00]).toString("base64")).binary, true);

const withFields = { metadata: { name: "x", managedFields: [{}], resourceVersion: "9" } };
assert.equal(k.stripForEdit(withFields).metadata.managedFields, undefined);
assert.equal(k.stripForEdit(withFields).metadata.resourceVersion, "9", "the version stays: it is replace's lock");
assert.ok(withFields.metadata.managedFields, "the original is not changed");

assert.deepEqual(k.allocatable([{ metadata: { name: "n" }, status: { allocatable: { cpu: "4", memory: "8Gi" } } }]), { cpu: 4, memory: 8 * 2 ** 30 });
assert.deepEqual(k.requested([
  { metadata: { name: "a" }, spec: { containers: [{ resources: { requests: { cpu: "100m", memory: "64Mi" } } }, {}] }, status: { phase: "Running" } },
  { metadata: { name: "b" }, spec: { containers: [{ resources: { requests: { cpu: "1" } } }] }, status: { phase: "Succeeded" } },
]), { cpu: 0.1, memory: 64 * 2 ** 20 }, "a finished pod no longer holds its requests");

console.log("kube checks passed");
