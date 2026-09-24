import { describe, expect, it } from "vitest";
import {
  buildDashboardBookmarkUrl,
  buildDashboardSearchUrl,
  buildWebBookmarkUrl,
  buildWebConnectUrl,
  buildWebDashboardRedirectUrl,
  buildWebSearchUrl,
} from "../src/app/popup/dashboardLinks";

describe("buildDashboardSearchUrl", () => {
  it("links to the plain dashboard for an empty or whitespace-only query", () => {
    expect(buildDashboardSearchUrl("")).toBe("dashboard.html");
    expect(buildDashboardSearchUrl("   ")).toBe("dashboard.html");
  });

  it("appends a trimmed, encoded q parameter for a real query", () => {
    expect(buildDashboardSearchUrl("  nook design  ")).toBe("dashboard.html?q=nook%20design");
  });

  it("encodes special characters like # and &", () => {
    expect(buildDashboardSearchUrl("#tag & more")).toBe("dashboard.html?q=%23tag%20%26%20more");
  });
});

describe("buildDashboardBookmarkUrl", () => {
  it("builds an id deep link", () => {
    expect(buildDashboardBookmarkUrl("chrome:123")).toBe("dashboard.html?id=chrome%3A123");
  });
});

describe("buildWebSearchUrl", () => {
  it("links to the web app root for an empty or whitespace-only query", () => {
    expect(buildWebSearchUrl("https://nook.example.com", "")).toBe("https://nook.example.com/");
    expect(buildWebSearchUrl("https://nook.example.com", "   ")).toBe("https://nook.example.com/");
  });

  it("appends a trimmed, encoded q parameter for a real query", () => {
    expect(buildWebSearchUrl("https://nook.example.com", "  nook design  ")).toBe(
      "https://nook.example.com/?q=nook%20design",
    );
  });

  it("strips a trailing slash from apiUrl before joining", () => {
    expect(buildWebSearchUrl("https://nook.example.com/", "tag")).toBe("https://nook.example.com/?q=tag");
  });
});

describe("buildWebBookmarkUrl", () => {
  it("builds an id deep link against the web app", () => {
    expect(buildWebBookmarkUrl("https://nook.example.com", "chrome:123")).toBe(
      "https://nook.example.com/?id=chrome%3A123",
    );
  });
});

describe("buildWebConnectUrl", () => {
  it("builds the connect-extension entry point", () => {
    expect(buildWebConnectUrl("https://nook.example.com")).toBe("https://nook.example.com/?connect=extension");
  });
});

describe("buildWebDashboardRedirectUrl", () => {
  it("falls back to the web app root when there's no q or id", () => {
    expect(buildWebDashboardRedirectUrl("https://nook.example.com", "")).toBe("https://nook.example.com/");
    expect(buildWebDashboardRedirectUrl("https://nook.example.com", "?local=1")).toBe("https://nook.example.com/");
  });

  it("preserves a q search param", () => {
    expect(buildWebDashboardRedirectUrl("https://nook.example.com", "?q=nook%20design")).toBe(
      "https://nook.example.com/?q=nook%20design",
    );
  });

  it("preserves an id param, preferring it over q when both are present", () => {
    expect(buildWebDashboardRedirectUrl("https://nook.example.com", "?id=chrome:123")).toBe(
      "https://nook.example.com/?id=chrome%3A123",
    );
    expect(buildWebDashboardRedirectUrl("https://nook.example.com", "?q=x&id=chrome:123")).toBe(
      "https://nook.example.com/?id=chrome%3A123",
    );
  });
});
