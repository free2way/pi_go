import assert from "node:assert/strict";
import test from "node:test";
import { auditContainer, parseProbeOutput, validateAuditProfile, validateContainerInspect } from "./container-security-audit.mjs";

function inspectFixture(overrides = {}) {
  return {
    Config: { User: "node" },
    HostConfig: {
      ReadonlyRootfs: true,
      Privileged: false,
      CapAdd: null,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: 128,
      Memory: 536_870_912,
      NanoCpus: 1_000_000_000,
      Devices: [],
      DeviceRequests: [],
      DeviceCgroupRules: [],
      PidMode: "",
      IpcMode: "private",
      NetworkMode: "pigo-control",
      UTSMode: "",
      CgroupnsMode: "private",
    },
    Mounts: [],
    State: { Running: true, Health: { Status: "healthy" } },
    RestartCount: 0,
    ...overrides,
  };
}

const profile = { container: "pigo-web" };
const goodProbe = "uid=1000 capEff=0000000000000000 noNewPrivs=1 rootWrite=blocked tmpWrite=ok deviceCreate=blocked sensitiveDevices=absent\n";

test("validates a least-privilege application container", () => {
  const result = validateContainerInspect("web", inspectFixture(), profile);
  assert.equal(result.readOnlyRoot, true);
  assert.equal(result.dockerSocket, "absent");
  assert.equal(result.limits.nanoCpus, 1_000_000_000);
  assert.equal(parseProbeOutput("web", goodProbe).rootWrite, "blocked");
});

test("requires a narrowly declared gateway before accepting the Docker socket", () => {
  const gateway = inspectFixture({ Mounts: [{ Destination: "/run/user/1000/docker.sock", Type: "bind", Source: "/private/socket" }] });
  assert.throws(() => validateContainerInspect("worker", gateway, profile), /Docker socket/u);
  const result = validateContainerInspect("gateway", gateway, {
    container: "gateway",
    dockerSocketDestination: "/run/user/1000/docker.sock",
  });
  assert.equal(result.dockerSocket, "gateway-only");
  assert.throws(() => validateContainerInspect("gateway", gateway, {
    container: "gateway",
    dockerSocketDestination: "/var/run/docker.sock",
  }), /missing or ambiguous/u);
});

test("fails closed for writable, privileged, root, capable, unlimited, device or host-namespace containers", () => {
  const mutations = [
    ["writable", (value) => { value.HostConfig.ReadonlyRootfs = false; }, /writable/u],
    ["privileged", (value) => { value.HostConfig.Privileged = true; }, /privileged/u],
    ["root", (value) => { value.Config.User = "0:0"; }, /root/u],
    ["capability", (value) => { value.HostConfig.CapAdd = ["SYS_ADMIN"]; }, /capabilities/u],
    ["cap-drop", (value) => { value.HostConfig.CapDrop = []; }, /not dropped/u],
    ["nnp", (value) => { value.HostConfig.SecurityOpt = []; }, /no-new-privileges/u],
    ["pids", (value) => { value.HostConfig.PidsLimit = 0; }, /PID/u],
    ["memory", (value) => { value.HostConfig.Memory = 0; }, /memory/u],
    ["cpu", (value) => { value.HostConfig.NanoCpus = 0; }, /CPU/u],
    ["device", (value) => { value.HostConfig.Devices = [{ PathOnHost: "/dev/kmsg" }]; }, /device/u],
    ["device-rule", (value) => { value.HostConfig.DeviceCgroupRules = ["c 1:3 rwm"]; }, /device/u],
    ["device-bind", (value) => { value.Mounts = [{ Destination: "/dev", Type: "bind" }]; }, /device/u],
    ["proc-bind", (value) => { value.Mounts = [{ Destination: "/proc/host", Type: "bind" }]; }, /kernel filesystem/u],
    ["pid", (value) => { value.HostConfig.PidMode = "host"; }, /PID namespace/u],
    ["ipc", (value) => { value.HostConfig.IpcMode = "host"; }, /IPC namespace/u],
    ["network", (value) => { value.HostConfig.NetworkMode = "host"; }, /network namespace/u],
    ["uts", (value) => { value.HostConfig.UTSMode = "host"; }, /UTS namespace/u],
    ["cgroup", (value) => { value.HostConfig.CgroupnsMode = "host"; }, /cgroup namespace/u],
  ];
  for (const [label, mutate, expected] of mutations) {
    const value = inspectFixture();
    mutate(value);
    assert.throws(() => validateContainerInspect(label, value, profile), expected);
  }
});

test("rejects every failed live probe dimension", () => {
  for (const [field, value] of [
    ["uid", "0"], ["capEff", "0000000000000001"], ["noNewPrivs", "0"],
    ["rootWrite", "allowed"], ["tmpWrite", "failed"], ["deviceCreate", "allowed"], ["sensitiveDevices", "present"],
  ]) {
    const broken = goodProbe.replace(new RegExp(`${field}=[^\\s]+`, "u"), `${field}=${value}`);
    assert.throws(() => parseProbeOutput("web", broken), new RegExp(field, "u"));
  }
});

test("validates profile fields and container names", () => {
  assert.deepEqual(validateAuditProfile({ web: { container: "pigo-web" } }), {
    web: { container: "pigo-web" },
  });
  assert.throws(() => validateAuditProfile({}), /at least one/u);
  assert.throws(() => validateAuditProfile({ Web: { container: "pigo-web" } }), /component/u);
  assert.throws(() => validateAuditProfile({ web: { container: "../../bad" } }), /container name/u);
  assert.throws(() => validateAuditProfile({ web: { container: "pigo-web", command: "id" } }), /unknown field/u);
  assert.throws(() => validateAuditProfile({ gateway: {
    container: "gateway",
    dockerSocketDestination: "../docker.sock",
  } }), /absolute socket path/u);
});

test("audits with fixed Docker inspect and exec commands and rejects restarts", () => {
  let inspectCount = 0;
  const docker = (args) => {
    assert.ok(args[0] === "container" || args[0] === "exec");
    if (args[0] === "exec") {
      assert.deepEqual(args.slice(0, 4), ["exec", "pigo-web", "sh", "-c"]);
      return goodProbe;
    }
    inspectCount += 1;
    return JSON.stringify([inspectFixture({ RestartCount: inspectCount === 2 ? 1 : 0 })]);
  };
  assert.throws(() => auditContainer("web", profile, docker), /restart count changed/u);
});
