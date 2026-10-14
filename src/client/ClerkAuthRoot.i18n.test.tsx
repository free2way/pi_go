import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { localeStore } from "./i18n";

vi.mock("@clerk/react", () => ({
  ClerkFailed: ({ children }: { children: ReactNode }) => children,
  ClerkLoaded: ({ children }: { children: ReactNode }) => children,
  ClerkLoading: ({ children }: { children: ReactNode }) => children,
  ClerkProvider: ({ children }: { children: ReactNode }) => children,
  SignIn: () => <div data-auth-form="sign-in" />,
  SignUp: () => <div data-auth-form="sign-up" />,
  useAuth: () => ({ isLoaded: true, isSignedIn: false, getToken: vi.fn() }),
  useClerk: () => ({ signOut: vi.fn() }),
}));

import { clerkLocalizationFor, SignInPortal } from "./ClerkAuthRoot";

describe("Clerk authentication locale wiring", () => {
  beforeEach(() => localeStore.setLocale("zh"));

  it("renders Chinese authentication copy and both language choices", () => {
    const html = renderToString(<SignInPortal />);
    expect(html).toContain("让开发、审核与发布");
    expect(html).toContain("邮箱注册");
    expect(html).toContain("中文");
    expect(html).toContain("EN");
  });

  it("renders the same entry screen in English", () => {
    localeStore.setLocale("en");
    const html = renderToString(<SignInPortal />);
    expect(html).toContain("Develop, review and ship");
    expect(html).toContain("Sign up with email");
    expect(html).not.toContain("邮箱注册");
  });

  it("selects the matching official Clerk localization", () => {
    expect(clerkLocalizationFor("zh").locale).toBe("zh-CN");
    expect(clerkLocalizationFor("zh").formFieldInputPlaceholder__password).toBe("请输入密码");
    expect(clerkLocalizationFor("zh").formFieldInputPlaceholder__signUpPassword).toBe("请创建密码");
    expect(clerkLocalizationFor("en").locale).toBe("en-US");
  });
});
