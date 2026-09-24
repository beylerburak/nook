import { describe, expect, it } from "vitest";
import { buildDashboardBookmarkUrl, buildDashboardSearchUrl } from "../src/app/popup/dashboardLinks";

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
