import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { Authenticator } from "./auth.js";

/**
 * development 模式的缺省身份（`PI_DEV_DEFAULT_EMAIL`）。
 *
 * 起因：dev 模式下身份只来自 `x-pigo-dev-email` 头，缺省写死 `developer@localhost`（非管理员），
 * 于是**在浏览器里**打开 demo 控制台永远是那个身份，管理员操作（额度录入/合并/发布）没有入口。
 * 这个变量只影响 development 分支：production + development 会被构造函数拒绝，cloudflare
 * 模式根本不看它——下面的用例把这两条边界都钉住。
 */

const originals = {
  mode: process.env.PI_AUTH_MODE,
  nodeEnv: process.env.NODE_ENV,
  fallback: process.env.PI_DEV_DEFAULT_EMAIL,
  clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY,
  clerkSecretKey: process.env.CLERK_SECRET_KEY,
};

afterEach(() => {
  for (const [key, value] of [
    ["PI_AUTH_MODE", originals.mode],
    ["NODE_ENV", originals.nodeEnv],
    ["PI_DEV_DEFAULT_EMAIL", originals.fallback],
    ["CLERK_PUBLISHABLE_KEY", originals.clerkPublishableKey],
    ["CLERK_SECRET_KEY", originals.clerkSecretKey],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setEnv(input: { mode?: string; nodeEnv?: string; fallback?: string; clerkPublishableKey?: string; clerkSecretKey?: string }) {
  if (input.mode === undefined) delete process.env.PI_AUTH_MODE;
  else process.env.PI_AUTH_MODE = input.mode;
  if (input.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = input.nodeEnv;
  if (input.fallback === undefined) delete process.env.PI_DEV_DEFAULT_EMAIL;
  else process.env.PI_DEV_DEFAULT_EMAIL = input.fallback;
  if (input.clerkPublishableKey === undefined) delete process.env.CLERK_PUBLISHABLE_KEY;
  else process.env.CLERK_PUBLISHABLE_KEY = input.clerkPublishableKey;
  if (input.clerkSecretKey === undefined) delete process.env.CLERK_SECRET_KEY;
  else process.env.CLERK_SECRET_KEY = input.clerkSecretKey;
}

const request = (headers: Record<string, string> = {}) => ({ headers } as unknown as FastifyRequest);
const reply = () => {
  const sent = { status: 0, body: undefined as unknown };
  return {
    sent,
    code(status: number) {
      sent.status = status;
      return this;
    },
    send(body: unknown) {
      sent.body = body;
      return this;
    },
  } as unknown as FastifyReply & { sent: { status: number; body: unknown } };
};

async function authenticate(input: { mode?: string; nodeEnv?: string; fallback?: string }, headers: Record<string, string> = {}) {
  setEnv(input);
  const auth = new Authenticator();
  const req = request(headers);
  const rep = reply();
  await auth.authenticate(req, rep);
  return { auth, req, rep };
}

describe("development 缺省身份", () => {
  it("未设置变量时保持既有缺省 developer@localhost", async () => {
    const { auth, req, rep } = await authenticate({ mode: "development" });
    expect((rep as unknown as { sent: { status: number } }).sent.status).toBe(0);
    expect(auth.identity(req).email).toBe("developer@localhost");
  });

  it("PI_DEV_DEFAULT_EMAIL 生效（小写化），且显式头优先", async () => {
    const fallback = await authenticate({ mode: "development", fallback: "Admin@Example.com" });
    expect(fallback.auth.identity(fallback.req).email).toBe("admin@example.com");

    const withHeader = await authenticate({ mode: "development", fallback: "admin@example.com" }, { "x-pigo-dev-email": "e2e-alt@localhost" });
    expect(withHeader.auth.identity(withHeader.req).email).toBe("e2e-alt@localhost");
  });

  it("空白值视同未设置", async () => {
    const { auth, req } = await authenticate({ mode: "development", fallback: "   " });
    expect(auth.identity(req).email).toBe("developer@localhost");
  });

  it("cloudflare 模式不看这个变量：无令牌仍然 401，且不会解析出 dev 身份", async () => {
    // cloudflare 模式需要 team domain/audience（缺了构造函数就拒绝），这里补上必需变量。
    const previous = [process.env.PI_CF_ACCESS_TEAM_DOMAIN, process.env.PI_CF_ACCESS_AUDIENCE];
    process.env.PI_CF_ACCESS_TEAM_DOMAIN = "https://team.cloudflareaccess.com";
    process.env.PI_CF_ACCESS_AUDIENCE = "aud-test";
    try {
      const { auth, req, rep } = await authenticate({ mode: "cloudflare", fallback: "admin@example.com" });
      expect((rep as unknown as { sent: { status: number } }).sent.status).toBe(401);
      // 身份上下文没有被写入：dev 缺省身份不能泄漏到 cloudflare 模式
      expect(() => auth.identity(req)).toThrow(/identity context is missing/);
    } finally {
      const [team, audience] = previous;
      if (team === undefined) delete process.env.PI_CF_ACCESS_TEAM_DOMAIN;
      else process.env.PI_CF_ACCESS_TEAM_DOMAIN = team;
      if (audience === undefined) delete process.env.PI_CF_ACCESS_AUDIENCE;
      else process.env.PI_CF_ACCESS_AUDIENCE = audience;
    }
  });

  it("production + development 组合被构造函数拒绝（该变量不可能出现在生产）", () => {
    setEnv({ mode: "development", nodeEnv: "production", fallback: "admin@example.com" });
    expect(() => new Authenticator()).toThrow(/not allowed when NODE_ENV=production/);
  });
});

describe("Clerk 邮箱身份", () => {
  const clerkEnv = {
    mode: "clerk",
    clerkPublishableKey: "pk_test_example",
    clerkSecretKey: "sk_test_example",
  };

  it("拒绝缺少密钥的 Clerk 配置", () => {
    setEnv({ mode: "clerk" });
    expect(() => new Authenticator()).toThrow(/requires CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY/);
  });

  it("把已验证主邮箱映射为稳定身份，并缓存用户查询", async () => {
    setEnv(clerkEnv);
    let lookups = 0;
    const auth = new Authenticator({
      clerkAuth: () => ({ isAuthenticated: true, userId: "user_123", sessionClaims: { iss: "https://clerk.example" } }),
      clerkUser: async () => {
        lookups += 1;
        return {
          primaryEmailAddressId: "email_1",
          emailAddresses: [{ id: "email_1", emailAddress: "Owner@Example.com", verification: { status: "verified" } }],
        };
      },
    });
    const firstRequest = request();
    const secondRequest = request();
    await Promise.all([
      auth.authenticate(firstRequest, reply()),
      auth.authenticate(secondRequest, reply()),
    ]);

    expect(auth.identity(firstRequest)).toMatchObject({
      email: "owner@example.com",
      issuer: "https://clerk.example",
      subject: "user_123",
      identityProvider: "clerk",
    });
    expect(auth.identity(secondRequest).legacyOwnerId).toBe(auth.identity(firstRequest).legacyOwnerId);
    expect(lookups).toBe(1);
    expect(auth.publicConfig()).toEqual({
      mode: "clerk",
      clerk: { publishableKey: "pk_test_example", proxyUrl: "/__clerk" },
    });
  });

  it("拒绝未登录会话和未验证邮箱", async () => {
    setEnv(clerkEnv);
    const signedOut = new Authenticator({
      clerkAuth: () => ({ isAuthenticated: false, userId: null }),
      clerkUser: async () => ({ primaryEmailAddressId: null, emailAddresses: [] }),
    });
    const signedOutReply = reply();
    await signedOut.authenticate(request(), signedOutReply);
    expect(signedOutReply.sent.status).toBe(401);

    const unverified = new Authenticator({
      clerkAuth: () => ({ isAuthenticated: true, userId: "user_unverified", sessionClaims: { iss: "https://clerk.example" } }),
      clerkUser: async () => ({
        primaryEmailAddressId: "email_2",
        emailAddresses: [{ id: "email_2", emailAddress: "pending@example.com", verification: { status: "unverified" } }],
      }),
    });
    const unverifiedReply = reply();
    await unverified.authenticate(request(), unverifiedReply);
    expect(unverifiedReply.sent.status).toBe(401);
  });
});
