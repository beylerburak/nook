// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { detectSiteColorScheme, parseCssColor, relativeLuminance, watchSiteColorScheme } from "../lib/site-color-scheme";

function paint(element: HTMLElement, background: string) {
  element.style.backgroundColor = background;
}

describe("parseCssColor", () => {
  it("parses legacy and modern rgb syntaxes", () => {
    expect(parseCssColor("rgb(21, 32, 43)")).toEqual({ r: 21, g: 32, b: 43, a: 1 });
    expect(parseCssColor("rgba(0, 0, 0, 0)")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseCssColor("rgb(255 255 255 / 50%)")).toEqual({ r: 255, g: 255, b: 255, a: 0.5 });
  });

  it("returns null for color spaces it can't compare", () => {
    expect(parseCssColor("oklch(0.2 0.02 250)")).toBeNull();
  });
});

describe("relativeLuminance", () => {
  it("spans black to white", () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0, a: 1 })).toBe(0);
    expect(relativeLuminance({ r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(1);
  });
});

describe("detectSiteColorScheme", () => {
  afterEach(() => {
    paint(document.body, "");
    paint(document.documentElement, "");
  });

  it.each([
    ["X dark (lights out)", "rgb(0, 0, 0)", "dark"],
    ["X dim", "rgb(21, 32, 43)", "dark"],
    ["X light", "rgb(255, 255, 255)", "light"],
  ])("detects %s", (_label, background, expected) => {
    paint(document.body, background);
    expect(detectSiteColorScheme()).toBe(expected);
  });

  it("looks through a transparent body to the html background", () => {
    paint(document.body, "transparent");
    paint(document.documentElement, "rgb(18, 18, 18)");
    expect(detectSiteColorScheme()).toBe("dark");
  });

  it("treats an unpainted page as light", () => {
    expect(detectSiteColorScheme()).toBe("light");
  });

  it("reports theme switches made through body styles", async () => {
    paint(document.body, "rgb(255, 255, 255)");
    const schemes: Array<string | null> = [];
    const stop = watchSiteColorScheme((scheme) => schemes.push(scheme));

    paint(document.body, "rgb(0, 0, 0)");
    await new Promise((resolve) => setTimeout(resolve, 0));
    stop();

    expect(schemes).toEqual(["dark"]);
  });
});
