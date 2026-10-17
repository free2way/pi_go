#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./oci-manifest.mjs";

const CONTAINER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/u;
const COMPONENT_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const ZERO_CAPABILITIES = /^0+$/u;

export const SECURITY_PROBE = String.raw`set -eu
uid=$(id -u)
cap_eff=$(awk '/^CapEff:/{print $2}' /proc/1/status)
no_new_privs=$(awk '/^NoNewPrivs:/{print $2}' /proc/1/status)
root_write=blocked
if touch /pigo-security-probe 2>/dev/null; then
  rm -f /pigo-security-probe
  root_write=allowed
fi
tmp_write=ok
tmp_probe=/tmp/pigo-security-probe-$$
if ! touch "$tmp_probe" 2>/dev/null; then tmp_write=failed; fi
rm -f "$tmp_probe"
device_create=blocked
device_probe=/tmp/pigo-security-device-$$
if mknod "$device_probe" c 1 3 2>/dev/null; then
  rm -f "$device_probe"
  device_create=allowed
fi
sensitive_devices=absent
for path in /dev/kmsg /dev/mem /dev/sda /dev/nvme0n1; do
  if test -e "$path"; then sensitive_devices=present; fi
done
printf 'uid=%s capEff=%s noNewPrivs=%s rootWrite=%s tmpWrite=%s deviceCreate=%s sensitiveDevices=%s\n' \
  "$uid" "$cap_eff" "$no_new_privs" "$root_write" "$tmp_write" "$device_create" "$sensitive_devices"`;

function requiredString(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

export function validateAuditProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("profile must be a JSON object");
  const entries = Object.entries(value);
  if (entries.length === 0) throw new Error("profile must contain at least one component");
  return Object.fromEntries(entries.map(([component, raw]) => {
    if (!COMPONENT_PATTERN.test(component)) throw new Error(`invalid component name: ${component}`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${component} profile must be an object`);
    const unknown = Object.keys(raw).filter((key) => !["container", "dockerSocketDestination"].includes(key));
    if (unknown.length > 0) throw new Error(`${component} profile contains unknown field: ${unknown[0]}`);
    const container = requiredString(raw.container, `${component} container`);
    if (!CONTAINER_PATTERN.test(container)) throw new Error(`${component} container name is invalid`);
    const dockerSocketDestination = raw.dockerSocketDestination === undefined
      ? undefined
      : requiredString(raw.dockerSocketDestination, `${component} Docker socket destination`);
    if (dockerSocketDestination !== undefined
      && (!dockerSocketDestination.startsWith("/") || dockerSocketDestination.includes("..") || !dockerSocketDestination.endsWith(".sock"))) {
      throw new Error(`${component} Docker socket destination must be an absolute socket path without traversal`);
    }
    return [component, { container, ...(dockerSocketDestination ? { dockerSocketDestination } : {}) }];
  }));
}

export function validateContainerInspect(component, value, profile) {
  const problems = [];
  const user = String(value?.Config?.User ?? "").trim().toLowerCase();
  const host = value?.HostConfig ?? {};
  const state = value?.State ?? {};
  const mounts = list(value?.Mounts);
  const socketMounts = mounts.filter((mount) => String(mount?.Destination ?? "").endsWith(".sock"));
  const sensitiveMounts = mounts.filter((mount) => /^(?:\/dev|\/proc|\/sys)(?:\/|$)/u.test(String(mount?.Destination ?? "")));

  if (state.Running !== true) problems.push("container is not running");
  if (state.Health?.Status !== "healthy") problems.push("container is not healthy");
  if (!user || user === "root" || /^0(?::0)?$/u.test(user)) problems.push("container user is root or unspecified");
  if (host.ReadonlyRootfs !== true) problems.push("root filesystem is writable");
  if (host.Privileged === true) problems.push("privileged mode is enabled");
  if (list(host.CapAdd).length > 0) problems.push("additional Linux capabilities are enabled");
  if (!list(host.CapDrop).map(String).some((capability) => capability.toUpperCase() === "ALL")) {
    problems.push("all Linux capabilities are not dropped");
  }
  if (!list(host.SecurityOpt).includes("no-new-privileges:true")) problems.push("no-new-privileges is missing");
  if (!(Number(host.PidsLimit) > 0)) problems.push("PID limit is missing");
  if (!(Number(host.Memory) > 0)) problems.push("memory limit is missing");
  if (!(Number(host.NanoCpus) > 0)) problems.push("CPU limit is missing");
  if (list(host.Devices).length > 0 || list(host.DeviceRequests).length > 0
    || list(host.DeviceCgroupRules).length > 0 || sensitiveMounts.length > 0) {
    problems.push("host device or kernel filesystem access is configured");
  }
  if (host.PidMode === "host") problems.push("host PID namespace is enabled");
  if (host.IpcMode === "host") problems.push("host IPC namespace is enabled");
  if (host.NetworkMode === "host") problems.push("host network namespace is enabled");
  if (host.UTSMode === "host") problems.push("host UTS namespace is enabled");
  if (host.CgroupnsMode === "host") problems.push("host cgroup namespace is enabled");
  if (profile.dockerSocketDestination) {
    if (socketMounts.length !== 1 || socketMounts[0]?.Type !== "bind"
      || socketMounts[0]?.Destination !== profile.dockerSocketDestination) {
      problems.push("approved Docker gateway socket mount is missing or ambiguous");
    }
  } else if (socketMounts.length > 0) {
    problems.push("Docker socket is mounted into a non-gateway container");
  }
  if (problems.length > 0) throw new Error(`${component}: ${problems.join("; ")}`);

  return {
    container: profile.container,
    user: value.Config.User,
    healthy: true,
    readOnlyRoot: true,
    privileged: false,
    capabilitiesDropped: true,
    noNewPrivileges: true,
    limits: { pids: host.PidsLimit, memoryBytes: host.Memory, nanoCpus: host.NanoCpus },
    dockerSocket: profile.dockerSocketDestination ? "gateway-only" : "absent",
  };
}

export function parseProbeOutput(component, output) {
  const fields = Object.fromEntries(requiredString(output, `${component} probe output`).trim().split(/\s+/u).map((part) => {
    const separator = part.indexOf("=");
    if (separator <= 0) throw new Error(`${component}: malformed security probe output`);
    return [part.slice(0, separator), part.slice(separator + 1)];
  }));
  const expected = {
    uid: (value) => /^\d+$/u.test(value) && value !== "0",
    capEff: (value) => ZERO_CAPABILITIES.test(value),
    noNewPrivs: (value) => value === "1",
    rootWrite: (value) => value === "blocked",
    tmpWrite: (value) => value === "ok",
    deviceCreate: (value) => value === "blocked",
    sensitiveDevices: (value) => value === "absent",
  };
  for (const [field, valid] of Object.entries(expected)) {
    if (!valid(fields[field] ?? "")) throw new Error(`${component}: security probe failed for ${field}`);
  }
  return fields;
}

function defaultDocker(args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function auditContainer(component, profile, docker = defaultDocker) {
  const before = JSON.parse(docker(["container", "inspect", profile.container]))[0];
  const inspect = validateContainerInspect(component, before, profile);
  const probe = parseProbeOutput(component, docker(["exec", profile.container, "sh", "-c", SECURITY_PROBE]));
  const after = JSON.parse(docker(["container", "inspect", profile.container]))[0];
  if (after?.State?.Running !== true || after?.State?.Health?.Status !== "healthy") {
    throw new Error(`${component}: container became unhealthy during the security probe`);
  }
  if (after.RestartCount !== before.RestartCount) throw new Error(`${component}: restart count changed during the security probe`);
  return { ...inspect, probe, restartCount: after.RestartCount };
}

export function auditProfile(profile, docker = defaultDocker, now = () => new Date()) {
  const components = Object.fromEntries(Object.entries(validateAuditProfile(profile)).map(([component, item]) => [
    component,
    auditContainer(component, item, docker),
  ]));
  return { schemaVersion: 1, status: "succeeded", checkedAt: now().toISOString(), components };
}

function writeExclusive(pathValue, evidence) {
  const output = resolve(requiredString(pathValue, "output"));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return output;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const profilePath = resolve(requiredString(options.profile, "profile"));
  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
  const evidence = auditProfile(profile);
  const output = writeExclusive(options.output, evidence);
  console.log(`[container-security-audit] ${Object.keys(evidence.components).length} components passed; wrote ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[container-security-audit] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
