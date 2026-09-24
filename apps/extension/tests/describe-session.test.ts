import { describe, expect, it } from "vitest";
import { describeSession, isPublicIpAddress, sessionTitle } from "../src/app/settings-dialog/describe-session";

const UA = {
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  firefoxWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0",
  chromeAndroidMobile:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36",
  chromeAndroidTablet:
    "Mozilla/5.0 (Linux; Android 10; SM-T510) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  safariIpad:
    "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  chromeIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/122.0.6261.62 Mobile/15E148 Safari/604.1",
  firefoxAndroid: "Mozilla/5.0 (Android 14; Mobile; rv:124.0) Gecko/124.0 Firefox/124.0",
  chromeLinux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  chromeOS:
    "Mozilla/5.0 (X11; CrOS x86_64 15633.69.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  operaWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 OPR/108.0.0.0",
  vivaldiLinux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Vivaldi/6.6",
  samsungInternet:
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/115.0.0.0 Mobile Safari/537.36",
  nookBackground:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Nook/1.0",
};

describe("describeSession", () => {
  it("recognizes Chrome on macOS (desktop)", () => {
    expect(describeSession(UA.chromeMac)).toEqual({ browser: "Chrome", os: "macOS", device: "desktop" });
  });

  it("recognizes Safari on macOS (desktop)", () => {
    expect(describeSession(UA.safariMac)).toEqual({ browser: "Safari", os: "macOS", device: "desktop" });
  });

  it("recognizes Firefox on Windows (desktop)", () => {
    expect(describeSession(UA.firefoxWindows)).toEqual({ browser: "Firefox", os: "Windows", device: "desktop" });
  });

  it("recognizes Chromium Edge on Windows (desktop), not Chrome", () => {
    expect(describeSession(UA.edgeWindows)).toEqual({ browser: "Edge", os: "Windows", device: "desktop" });
  });

  it("recognizes Chrome on Android as mobile", () => {
    expect(describeSession(UA.chromeAndroidMobile)).toEqual({ browser: "Chrome", os: "Android", device: "mobile" });
  });

  it("recognizes an Android tablet UA (no Mobile token) as tablet", () => {
    expect(describeSession(UA.chromeAndroidTablet)).toEqual({ browser: "Chrome", os: "Android", device: "tablet" });
  });

  it("recognizes Safari on iPhone as mobile/iOS", () => {
    expect(describeSession(UA.safariIphone)).toEqual({ browser: "Safari", os: "iOS", device: "mobile" });
  });

  it("recognizes Safari on iPad as tablet/iOS", () => {
    expect(describeSession(UA.safariIpad)).toEqual({ browser: "Safari", os: "iOS", device: "tablet" });
  });

  it("recognizes Chrome for iOS (CriOS) as Chrome, not Safari", () => {
    expect(describeSession(UA.chromeIos)).toEqual({ browser: "Chrome", os: "iOS", device: "mobile" });
  });

  it("recognizes Firefox on Android as mobile", () => {
    expect(describeSession(UA.firefoxAndroid)).toEqual({ browser: "Firefox", os: "Android", device: "mobile" });
  });

  it("recognizes Chrome on Linux (desktop)", () => {
    expect(describeSession(UA.chromeLinux)).toEqual({ browser: "Chrome", os: "Linux", device: "desktop" });
  });

  it("recognizes Chrome on Chrome OS", () => {
    expect(describeSession(UA.chromeOS)).toEqual({ browser: "Chrome", os: "Chrome OS", device: "desktop" });
  });

  it("recognizes Opera, not Chrome", () => {
    expect(describeSession(UA.operaWindows)).toEqual({ browser: "Opera", os: "Windows", device: "desktop" });
  });

  it("recognizes Vivaldi, not Chrome", () => {
    expect(describeSession(UA.vivaldiLinux)).toEqual({ browser: "Vivaldi", os: "Linux", device: "desktop" });
  });

  it("recognizes Samsung Internet, not Chrome", () => {
    expect(describeSession(UA.samsungInternet)).toEqual({
      browser: "Samsung Internet",
      os: "Android",
      device: "mobile",
    });
  });

  it("recognizes a Nook-tagged background request ahead of its Chromium tokens", () => {
    expect(describeSession(UA.nookBackground)).toEqual({ browser: "Nook", os: "macOS", device: "desktop" });
  });

  it("falls back sensibly for null, undefined, empty or blank input", () => {
    const fallback = { browser: "Unknown browser", os: "Unknown OS", device: "desktop" };
    expect(describeSession(null)).toEqual(fallback);
    expect(describeSession(undefined)).toEqual(fallback);
    expect(describeSession("")).toEqual(fallback);
    expect(describeSession("   ")).toEqual(fallback);
  });

  it("falls back sensibly for unrecognizable garbage", () => {
    expect(describeSession("definitely not a user agent string")).toEqual({
      browser: "Unknown browser",
      os: "Unknown OS",
      device: "desktop",
    });
  });
});

describe("sessionTitle", () => {
  it("combines browser and OS", () => {
    expect(sessionTitle({ browser: "Chrome", os: "macOS", device: "desktop" })).toBe("Chrome on macOS");
  });

  it("drops the OS when it's unknown", () => {
    expect(sessionTitle({ browser: "Nook", os: "Unknown OS", device: "desktop" })).toBe("Nook");
  });

  it("says 'Unknown browser on <os>' when only the OS is known", () => {
    expect(sessionTitle({ browser: "Unknown browser", os: "Windows", device: "desktop" })).toBe(
      "Unknown browser on Windows",
    );
  });

  it("says 'Unknown device' when nothing is known", () => {
    expect(sessionTitle({ browser: "Unknown browser", os: "Unknown OS", device: "desktop" })).toBe("Unknown device");
  });
});

describe("isPublicIpAddress", () => {
  it("hides loopback addresses", () => {
    expect(isPublicIpAddress("127.0.0.1")).toBe(false);
    expect(isPublicIpAddress("::1")).toBe(false);
  });

  it("hides RFC1918 private ranges", () => {
    expect(isPublicIpAddress("10.0.0.5")).toBe(false);
    expect(isPublicIpAddress("192.168.1.20")).toBe(false);
  });

  it("hides the 172.16-31 private/Docker range but not neighbors outside it", () => {
    expect(isPublicIpAddress("172.29.0.1")).toBe(false); // the exact Docker-bridge IP from the bug report
    expect(isPublicIpAddress("172.16.0.1")).toBe(false);
    expect(isPublicIpAddress("172.31.255.255")).toBe(false);
    expect(isPublicIpAddress("172.15.0.1")).toBe(true);
    expect(isPublicIpAddress("172.32.0.1")).toBe(true);
  });

  it("hides link-local addresses", () => {
    expect(isPublicIpAddress("169.254.1.1")).toBe(false);
  });

  it("hides IPv6 unique local addresses (fc00::/7)", () => {
    expect(isPublicIpAddress("fc00::1")).toBe(false);
    expect(isPublicIpAddress("fd12:3456:789a::1")).toBe(false);
  });

  it("shows public IPv4 addresses", () => {
    expect(isPublicIpAddress("8.8.8.8")).toBe(true);
    expect(isPublicIpAddress("203.0.113.42")).toBe(true);
  });

  it("shows public IPv6 addresses", () => {
    expect(isPublicIpAddress("2001:4860:4860::8888")).toBe(true);
  });

  it("treats null, undefined and empty as not public", () => {
    expect(isPublicIpAddress(null)).toBe(false);
    expect(isPublicIpAddress(undefined)).toBe(false);
    expect(isPublicIpAddress("")).toBe(false);
    expect(isPublicIpAddress("   ")).toBe(false);
  });
});
