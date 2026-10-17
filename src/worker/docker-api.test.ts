import { describe, expect, it } from "vitest";
import { buildDockerRequestOptions, DockerApi } from "./docker-api.js";

describe("DockerApi sandbox gateway transport", () => {
  it("targets the configured origin with bearer auth and never carries the socket", () => {
    const options = buildDockerRequestOptions({
      socketPath: "/var/run/docker.sock",
      gateway: new URL("http://sandbox-gateway:3210"),
      gatewayToken: "gateway-secret",
      apiVersion: "v1.43",
      pathName: "/images/sandbox%40sha256%3Aabc/json",
      method: "GET",
    });
    expect(options).toMatchObject({
      protocol: "http:",
      hostname: "sandbox-gateway",
      port: "3210",
      path: "/v1.43/images/sandbox%40sha256%3Aabc/json",
      method: "GET",
      headers: { Authorization: "Bearer gateway-secret" },
    });
    expect(options).not.toHaveProperty("socketPath");
  });

  it("rejects unsafe gateway URLs and missing authentication", () => {
    expect(() => new DockerApi({ gatewayUrl: "http://gateway:3210/path", gatewayToken: "token" })).toThrow(/HTTP origin/);
    expect(() => new DockerApi({ gatewayUrl: "https://gateway:3210", gatewayToken: "token" })).toThrow(/HTTP origin/);
    expect(() => new DockerApi({ gatewayUrl: "http://gateway:3210" })).toThrow(/PI_DOCKER_GATEWAY_TOKEN/);
    expect(() => new DockerApi({ gatewayRequired: true })).toThrow(/PI_DOCKER_GATEWAY_URL is required/);
  });
});
