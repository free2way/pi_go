import { afterEach, describe, expect, it, vi } from "vitest";
import { api, setAuthTokenProvider } from "./api";

afterEach(() => {
  setAuthTokenProvider(undefined);
  vi.unstubAllGlobals();
});

describe("authenticated API requests", () => {
  it("attaches a Clerk bearer token and removes it when the session bridge unmounts", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ id: "u1", email: "user@example.com" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const remove = setAuthTokenProvider(async () => "session-token");
    await api.me();
    const authenticatedHeaders = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(authenticatedHeaders.get("Authorization")).toBe("Bearer session-token");
    expect(fetchMock.mock.calls[0][1]?.credentials).toBe("same-origin");

    remove();
    await api.me();
    const signedOutHeaders = new Headers(fetchMock.mock.calls[1][1]?.headers);
    expect(signedOutHeaders.has("Authorization")).toBe(false);
  });
});
