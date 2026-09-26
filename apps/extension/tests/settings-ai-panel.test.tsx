// @vitest-environment happy-dom
import "fake-indexeddb/auto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastViewport } from "@astryxdesign/core/Toast";
import { NookHostProvider, type NookHost } from "../src/app/host/NookHost";
import { AiPanel } from "../src/app/settings-dialog/AiPanel";
import { SettingsDialog } from "../src/app/settings-dialog/SettingsDialog";
import { _resetAiClientForTests } from "../lib/ai-client";
import { DEFAULT_AI_SETTINGS, _resetAiSettingsCacheForTests, type AiSettings } from "../lib/ai-settings";
import { configureCloud, saveCloudSession } from "../lib/cloud-sync";
import * as NookDB from "../lib/db";
import { LOCALE_STORAGE_KEY } from "../src/i18n";

// SettingsDialog renders SyncPanel's status through this hook; the AI panel
// never reads it, but the module is in the import graph, so stub it the same
// way settings-dialog.test.tsx does.
vi.mock("../src/app/host/useCloudStatus", () => ({
  useCloudStatus: () => null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AI_SETTINGS_KEY = "ai.settings";
const CLOUD_ORIGIN = "https://nook.beyler.co";

// -- the AI routes this (slimmer) panel still touches -----------------------
//
// Settings → AI is just the switches, "Search by meaning"'s informational
// row, Advanced, and a button to the Organize page now — the suggest/accept/
// run-now flow moved to dashboard/organize/ (see tests/organize-page.test.tsx
// for its own coverage). This panel still reads GET/PUT /api/ai/settings and
// GET /api/ai/status (for the outage banner and the per-row "not available"
// notes), so those two routes still need a fetch router.

/** Stands in for GET/PUT /api/ai/settings — the account's row. */
class MockSettingsServer {
  settings: AiSettings = { ...DEFAULT_AI_SETTINGS };
  requests: Array<{ method: string; body?: unknown }> = [];

  respond = (init: RequestInit | undefined): Response => {
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Partial<AiSettings>) : undefined;
    this.requests.push({ method, body });
    if (method === "PUT" && body) this.settings = { ...this.settings, ...body };
    return json(this.settings);
  };
}

/** Stands in for GET /api/ai/status. The body is deliberately partial-friendly:
 *  `lib/ai-client.ts` fills every absent field, and a test should be able to
 *  hand it whatever the real server would. */
class MockStatusServer {
  body: Record<string, unknown> = {};

  respond = (): Response => json({ ...this.body });
}

/** A status body with everything filled in, so a test only has to state the
 *  part it is about. */
function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    available: true,
    settings: { ...DEFAULT_AI_SETTINGS },
    pending: 0,
    taxonomy: { acceptedAt: null, collections: [], tags: [] },
    run: {
      processed: 0,
      assigned: 0,
      tagged: 0,
      skipped: 0,
      lastRunAt: null,
      lastError: null,
      isUnavailable: false,
      isBackingOff: false,
      log: [],
    },
    summarize: {
      available: true,
      model: "gpt-4o-mini",
      pending: 0,
      summarised: 0,
      written: 0,
      skipped: 0,
      lastRunAt: null,
      lastError: null,
      isUnavailable: false,
      isBackingOff: false,
    },
    ...overrides,
  };
}

/** The summarise half on its own, for the tests that are about it. */
function summariseStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    available: true,
    model: "gpt-4o-mini",
    pending: 0,
    summarised: 0,
    written: 0,
    skipped: 0,
    lastRunAt: null,
    lastError: null,
    isUnavailable: false,
    isBackingOff: false,
    ...overrides,
  };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

let settingsServer: MockSettingsServer;
let statusServer: MockStatusServer;

type RouteReply = () => Response | Promise<Response>;

let statusHandler: RouteReply | null;

/** Every request the panel made, in order, whichever route it was for. */
let fetchLog: Array<{ url: string; method: string; headers: Record<string, string>; credentials?: string }>;

function installFetchRouter(): void {
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit): Promise<Response> => {
    fetchLog.push({
      url: input,
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string>) ?? {},
      ...(init?.credentials !== undefined ? { credentials: init.credentials } : {}),
    });
    if (input.endsWith("/api/ai/settings")) return settingsServer.respond(init);
    if (input.endsWith("/api/ai/status")) {
      if (statusHandler) return statusHandler();
      return statusServer.respond();
    }
    throw new Error(`Unexpected fetch in this test: ${input}`);
  });
}

function requestsTo(suffix: string) {
  return fetchLog.filter((request) => request.url.endsWith(suffix));
}

// -- hosts ----------------------------------------------------------------

function webHost(overrides: Partial<NookHost> = {}): NookHost {
  return {
    kind: "web",
    appVersion: "1.2.3",
    apiUrl: "https://nook.beyler.co",
    user: { id: "u1", name: "Ada Lovelace", email: "ada@example.com", createdAt: "2024-01-01T00:00:00.000Z" },
    sync: { requestSync: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
}

function extensionHost(overrides: Partial<NookHost> = {}): NookHost {
  return {
    kind: "extension",
    appVersion: "1.2.3",
    apiUrl: "https://nook.beyler.co",
    user: null,
    sync: { requestSync: vi.fn().mockResolvedValue(undefined) },
    openWebApp: vi.fn(),
    ...overrides,
  };
}

const signedIn = { id: "u1", name: "Ada Lovelace", email: "ada@example.com", createdAt: "2024-01-01T00:00:00.000Z" };

/** A connected extension: `user` and no `account`, which is the shape the
 *  section is actually gated on. */
function aiHost(overrides: Partial<NookHost> = {}): NookHost {
  return extensionHost({ user: signedIn, ...overrides });
}

function fakeLibrary() {
  return {
    bookmarkCount: 12,
    collectionCount: 3,
    isImporting: false,
    importBookmarks: vi.fn().mockResolvedValue(true),
    exportBookmarks: vi.fn(),
    clearAllBookmarks: vi.fn().mockResolvedValue(true),
  };
}

/**
 * Node ships its own global `localStorage` that shadows happy-dom's and,
 * under this harness, isn't a full `Storage` (no `removeItem`) — the same
 * issue `tests/i18n.test.ts` works around. `readCachedLocaleSetting()`
 * (`lib/locale.ts`) reads this synchronously, which is how the Turkish-locale
 * tests below switch languages without mounting `<I18nProvider>`.
 */
function stubLocalStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  });
}

let container: HTMLElement;
let root: Root;

beforeEach(async () => {
  NookDB._resetForTests();
  _resetAiSettingsCacheForTests();
  _resetAiClientForTests();
  settingsServer = new MockSettingsServer();
  statusServer = new MockStatusServer();
  // A healthy, fully-configured server by default — most tests are about a
  // feature's own behaviour, not about the "server is unavailable" edge case,
  // which has its own dedicated tests and overrides this explicitly.
  statusServer.body = status();
  statusHandler = null;
  fetchLog = [];
  installFetchRouter();
  stubLocalStorage();
  // English by default; the Turkish-locale tests opt in explicitly.
  localStorage.removeItem(LOCALE_STORAGE_KEY);
  await saveCloudSession("test-token", "user-1");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await settle();
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  configureCloud({ apiUrl: "https://nook.beyler.co", auth: "bearer" });
});

// -- harness ---------------------------------------------------------------

function renderDialog(host: NookHost, overrides: Partial<Parameters<typeof SettingsDialog>[0]> = {}) {
  act(() => {
    root.render(
      <NookHostProvider host={host}>
        <ToastViewport>
          <SettingsDialog
            isOpen
            onOpenChange={vi.fn()}
            appearance="system"
            onAppearanceChange={vi.fn()}
            library={fakeLibrary()}
            {...overrides}
          />
        </ToastViewport>
      </NookHostProvider>,
    );
  });
}

/**
 * Flushes the panel's async work: the settings read, the status read, and
 * whatever they set.
 */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await NookDB.getMeta("ai.settle-probe");
    }
  });
}

function hasText(text: string): boolean {
  return container.textContent?.includes(text) ?? false;
}

function rowText(title: string): string {
  const label = rowLabel(title);
  return label.closest("li")?.textContent ?? "";
}

function rowLabel(title: string): HTMLElement {
  const label = [...container.querySelectorAll<HTMLElement>('[data-type="label"]')].find(
    (element) => element.textContent?.trim() === title,
  );
  if (!label) throw new Error(`No settings row titled "${title}".`);
  return label;
}

/** The section labels currently in the dialog's navigation, in order. */
function sectionLabels(): string[] {
  const nav = container.querySelector('[aria-label="Settings sections"]');
  return [...(nav?.querySelectorAll("button") ?? [])].map((el) => el.textContent?.trim() ?? "");
}

function clickText(text: string) {
  const candidates = [...container.querySelectorAll<HTMLElement>("button, a, [role='radio'], [role='tab']")];
  const match = candidates.find((el) => el.textContent?.trim() === text || el.getAttribute("aria-label") === text);
  if (!match) {
    throw new Error(`No clickable element for "${text}". Saw: ${candidates.map((el) => el.textContent?.trim()).join(" | ")}`);
  }
  act(() => match.click());
}

function labelled(text: string): HTMLElement | null {
  const byFor = [...container.querySelectorAll<HTMLLabelElement>("label[for]")].find(
    (label) => label.textContent?.trim() === text,
  );
  if (byFor) return container.querySelector<HTMLElement>(`[id="${byFor.htmlFor}"]`);
  const byLabelledBy = [...container.querySelectorAll<HTMLElement>("[aria-labelledby]")].find((el) => {
    const id = el.getAttribute("aria-labelledby");
    return id != null && container.querySelector(`[id="${id}"]`)?.textContent?.trim() === text;
  });
  return byLabelledBy ?? null;
}

function switchFor(text: string): HTMLInputElement {
  const input = labelled(text);
  if (!(input instanceof HTMLInputElement)) throw new Error(`No switch labelled "${text}".`);
  return input;
}

function sliderFor(text: string): HTMLElement {
  const thumb = labelled(text);
  if (thumb?.getAttribute("role") !== "slider") throw new Error(`No slider labelled "${text}".`);
  return thumb;
}

function numberInputFor(text: string): HTMLInputElement {
  const input = labelled(text);
  if (input?.getAttribute("role") !== "spinbutton" || !(input instanceof HTMLInputElement)) {
    throw new Error(`No number input labelled "${text}".`);
  }
  return input;
}

function isDisabled(element: HTMLElement): boolean {
  return (element as HTMLButtonElement).disabled || element.getAttribute("aria-disabled") === "true";
}

function buttonFor(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === label || element.getAttribute("aria-label") === label,
  );
  if (!match) {
    const seen = [...container.querySelectorAll<HTMLButtonElement>("button")].map((element) => element.textContent?.trim());
    throw new Error(`No button labelled "${label}". Saw: ${seen.join(" | ")}`);
  }
  return match;
}

/** A Collapsible keeps its content mounted (hidden via `display:none`) rather
 *  than unmounting it, so `hasText` cannot tell open from closed — the trigger
 *  button's own `aria-expanded` is the signal that actually changes. */
function isExpanded(triggerText: string): boolean {
  return buttonFor(triggerText).getAttribute("aria-expanded") === "true";
}

function readMeta<T>(key: string): Promise<T | undefined> {
  return NookDB.getMeta<T>(key);
}

const readAiSettings = () => readMeta<Record<string, unknown>>(AI_SETTINGS_KEY);

/** Renders the dialog on the AI section and waits for its reads. */
async function renderAiPanel(host: NookHost, overrides: Partial<Parameters<typeof SettingsDialog>[0]> = {}): Promise<void> {
  renderDialog(host, overrides);
  clickText("AI");
  await settle();
}

/**
 * Mounts <AiPanel/> on its own, bypassing the dialog — the only way to
 * exercise its own `!host.user` fallback, since the dialog never offers the
 * section (and so never mounts the panel) for a signed-out host.
 */
async function renderAiPanelDirectly(host: NookHost, onOpenOrganize?: () => void): Promise<void> {
  act(() => {
    root.render(
      <NookHostProvider host={host}>
        <ToastViewport>
          <AiPanel onOpenOrganize={onOpenOrganize} />
        </ToastViewport>
      </NookHostProvider>,
    );
  });
  await settle();
}

/** Opens the collapsed "Advanced" disclosure — the thresholds live behind it
 *  now, so a test that needs a slider or the language selector has to open it
 *  first. */
function openAdvanced() {
  clickText("Advanced");
}

// -- section visibility ----------------------------------------------------

describe("Settings → AI — section visibility", () => {
  it("offers the section on a connected extension", async () => {
    renderDialog(aiHost());
    await settle();
    expect(sectionLabels()).toContain("AI");

    clickText("AI");
    await settle();
    expect(hasText("File bookmarks automatically")).toBe(true);
    expect(hasText("Open Organize")).toBe(true);
  });

  it("hides the section with no session", async () => {
    renderDialog(extensionHost());
    await settle();
    expect(sectionLabels()).not.toContain("AI");
  });

  it("shows the section for a user without an account", async () => {
    renderDialog(extensionHost({ user: { id: "u2", name: "Grace Hopper", email: "grace@example.com" } }));
    await settle();
    expect(sectionLabels()).toContain("AI");

    clickText("AI");
    await settle();
    expect(hasText("File bookmarks automatically")).toBe(true);
  });

  it("shows the section on the web host when signed in, with everything live", async () => {
    renderDialog(webHost());
    await settle();
    expect(sectionLabels()).toContain("AI");

    clickText("AI");
    await settle();
    expect(hasText("File bookmarks automatically")).toBe(true);
    expect(hasText("Summarise long pages")).toBe(true);
  });

  it("hides the section on the web host with no session", async () => {
    renderDialog(webHost({ user: null }));
    await settle();
    expect(sectionLabels()).not.toContain("AI");
  });

  it("AiPanel itself falls back to the sign-in banner when mounted without a user", async () => {
    await renderAiPanelDirectly(webHost({ user: null }));
    expect(hasText("Sign in to use AI features")).toBe(true);
    expect(hasText("File bookmarks automatically")).toBe(false);
  });
});

// -- the intro, and the one "unavailable" banner ---------------------------

describe("Settings → AI — intro and availability", () => {
  it("always shows the plain-language intro, and a working refresh", async () => {
    statusServer.body = status();
    await renderAiPanel(aiHost());

    expect(hasText("runs on Nook's server")).toBe(true);
    const before = requestsTo("/api/ai/status").length;
    act(() => buttonFor("Refresh").click());
    await settle();
    expect(requestsTo("/api/ai/status").length).toBeGreaterThan(before);
  });

  it("shows one banner when neither deployment is configured, instead of an error per row", async () => {
    statusServer.body = status({ available: false, summarize: summariseStatus({ available: false }) });
    await renderAiPanel(aiHost());

    expect(hasText("AI isn't set up on this server yet")).toBe(true);
  });

  it("does not show the global banner when only one deployment is down", async () => {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoClassify: true };
    statusServer.body = status({ available: false });
    await renderAiPanel(aiHost());

    expect(hasText("AI isn't set up on this server yet")).toBe(false);
    // The local note still says so, on the row it affects.
    expect(hasText("Not available on this server yet.")).toBe(true);
  });
});

// -- file bookmarks automatically (just the switch now) ---------------------

describe("Settings → AI — file bookmarks automatically", () => {
  it("commits autoClassify through the settings route and survives a remount", async () => {
    renderDialog(aiHost());
    clickText("AI");
    await settle();

    expect(switchFor("File bookmarks automatically").checked).toBe(false);
    act(() => switchFor("File bookmarks automatically").click());
    await settle();

    expect(settingsServer.settings.autoClassify).toBe(true);
    expect((await readAiSettings())?.autoClassify).toBe(true);
    expect(switchFor("File bookmarks automatically").checked).toBe(true);

    act(() => root.unmount());
    root = createRoot(container);
    renderDialog(aiHost(), { initialSection: "ai" });
    await settle();

    expect(switchFor("File bookmarks automatically").checked).toBe(true);
  });

  it("says the toggle covers the existing library too, not only new saves", async () => {
    await renderAiPanel(aiHost());
    expect(hasText("Works through your whole library, not just new bookmarks")).toBe(true);
  });

  it("names the missing deployment locally when it, and only it, is down", async () => {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoClassify: true };
    statusServer.body = status({ available: false });
    await renderAiPanel(aiHost());
    expect(hasText("Not available on this server yet.")).toBe(true);
  });

  it("no longer shows the run-now button or run history — that moved to the Organize page", async () => {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoClassify: true };
    statusServer.body = status({
      run: { processed: 25, assigned: 18, tagged: 40, skipped: 7, lastRunAt: "2026-09-20T10:00:00.000Z", lastError: null, isUnavailable: false, isBackingOff: false, log: [] },
    });
    await renderAiPanel(aiHost());

    expect(hasText("Filed 18, left 7 alone")).toBe(false);
    expect(() => buttonFor("Organize unfiled bookmarks now")).toThrow();
  });
});

// -- summaries ---------------------------------------------------------------

describe("Settings → AI — summaries", () => {
  it("commits autoSummarize, keeps the description short, and puts the privacy detail behind a disclosure", async () => {
    await renderAiPanel(aiHost());

    expect(hasText("Writes a short summary for long pages")).toBe(true);
    expect(hasText("4,000 characters of the page")).toBe(true);
    // The privacy paragraph is collapsed by default and only announced open
    // once the disclosure is actually toggled.
    expect(isExpanded("What gets sent")).toBe(false);
    clickText("What gets sent");
    await settle();
    expect(isExpanded("What gets sent")).toBe(true);
    expect(hasText("OpenAI or Google")).toBe(true);

    act(() => switchFor("Summarise long pages").click());
    await settle();
    expect(settingsServer.settings.autoSummarize).toBe(true);
  });

  it("reports the server's own counts in one line", async () => {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoSummarize: true };
    statusServer.body = status({ summarize: summariseStatus({ summarised: 241, pending: 12 }) });
    await renderAiPanel(aiHost());

    expect(hasText("241 pages have a summary, 12 waiting.")).toBe(true);
  });

  it("says the waiting count means nothing while the toggle is off", async () => {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoSummarize: false };
    statusServer.body = status({ summarize: summariseStatus({ summarised: 241, pending: 0 }) });
    await renderAiPanel(aiHost());

    expect(hasText("Nothing is summarised while this is off.")).toBe(true);
  });

  it("renders the last pass as a live relative time, and Never when there has been none", async () => {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoSummarize: true };
    statusServer.body = status({ summarize: summariseStatus({ lastRunAt: "2026-09-20T10:00:00.000Z" }) });
    await renderAiPanel(aiHost());
    expect(rowText("In your library")).toMatch(/ago/);

    act(() => root.unmount());
    root = createRoot(container);
    statusServer.body = status({ summarize: summariseStatus() });
    await renderAiPanel(aiHost());
    expect(rowText("In your library")).toContain("Never");
  });

  it("reports a server with no summariser as unavailable", async () => {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoSummarize: true };
    statusServer.body = status({ summarize: summariseStatus({ available: false }) });
    await renderAiPanel(aiHost());

    expect(hasText("Not available on this server yet.")).toBe(true);
  });

  it("survives a server that does not send the summarise half at all", async () => {
    const withoutSummarize = status();
    delete withoutSummarize.summarize;
    statusServer.body = withoutSummarize;

    await renderAiPanel(aiHost());
    expect(hasText("In your library")).toBe(true);
  });
});

// -- search by meaning -------------------------------------------------------

describe("Settings → AI — search by meaning", () => {
  it("is described as informational, with no switch of its own", async () => {
    await renderAiPanel(aiHost());
    expect(hasText("Search by meaning")).toBe(true);
    expect(hasText("Works automatically once you're signed in")).toBe(true);
  });
});

// -- advanced -----------------------------------------------------------------

describe("Settings → AI — advanced", () => {
  beforeEach(() => {
    settingsServer.settings = {
      ...DEFAULT_AI_SETTINGS,
      collectionMinConfidence: 0.9,
      tagMinNoul: 0.65,
      maxTags: 5,
    };
  });

  it("is collapsed by default", async () => {
    await renderAiPanel(aiHost());
    expect(isExpanded("Advanced")).toBe(false);

    openAdvanced();
    await settle();
    expect(isExpanded("Advanced")).toBe(true);
    expect(hasText("Collection confidence")).toBe(true);
    expect(hasText("Tag confidence")).toBe(true);
    expect(hasText("Max tags")).toBe(true);
    expect(hasText("Language for new names")).toBe(true);
  });

  it("renders each threshold's current value", async () => {
    await renderAiPanel(aiHost());
    openAdvanced();
    await settle();

    expect(sliderFor("Collection confidence").getAttribute("aria-valuenow")).toBe("0.9");
    expect(sliderFor("Tag confidence").getAttribute("aria-valuenow")).toBe("0.65");
    expect(numberInputFor("Max tags").value).toBe("5");
    expect(hasText("0.90")).toBe(true);
    expect(hasText("0.65")).toBe(true);
  });

  it("commits a dragged collection confidence on change end", async () => {
    await renderAiPanel(aiHost());
    openAdvanced();
    await settle();

    const thumb = sliderFor("Collection confidence");
    act(() => {
      thumb.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });
    await settle();

    expect(settingsServer.settings.collectionMinConfidence).toBe(0.95);
    expect(settingsServer.settings.tagMinNoul).toBe(0.65);
  });

  it("commits a stepped max-tags value", async () => {
    await renderAiPanel(aiHost());
    openAdvanced();
    await settle();

    const input = numberInputFor("Max tags");
    const steppers = input.parentElement?.querySelectorAll<HTMLButtonElement>("button") ?? [];
    const increment = steppers[0];
    if (!increment) throw new Error("No max-tags stepper.");
    act(() => increment.click());
    await settle();

    expect(settingsServer.settings.maxTags).toBe(6);
  });

  it("still renders a stored value the loader had to clamp", async () => {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, collectionMinConfidence: 7, tagMinNoul: -3, maxTags: 99 };
    await renderAiPanel(aiHost());
    openAdvanced();
    await settle();

    const collection = Number(sliderFor("Collection confidence").getAttribute("aria-valuenow"));
    const tags = Number(sliderFor("Tag confidence").getAttribute("aria-valuenow"));
    const maxTags = Number(numberInputFor("Max tags").value);

    expect(collection).toBeGreaterThanOrEqual(0);
    expect(collection).toBeLessThanOrEqual(1);
    expect(tags).toBeGreaterThanOrEqual(0);
    expect(tags).toBeLessThanOrEqual(1);
    expect(maxTags).toBeGreaterThanOrEqual(0);
  });

  it("resets every threshold to its default in one click", async () => {
    await renderAiPanel(aiHost());
    openAdvanced();
    await settle();

    act(() => buttonFor("Reset to defaults").click());
    await settle();

    expect(settingsServer.settings.collectionMinConfidence).toBe(DEFAULT_AI_SETTINGS.collectionMinConfidence);
    expect(settingsServer.settings.tagMinNoul).toBe(DEFAULT_AI_SETTINGS.tagMinNoul);
    expect(settingsServer.settings.maxTags).toBe(DEFAULT_AI_SETTINGS.maxTags);
    expect(settingsServer.settings.taxonomyLanguage).toBe(DEFAULT_AI_SETTINGS.taxonomyLanguage);
  });
});

// -- Open Organize ------------------------------------------------------------

describe("Settings → AI — Open Organize", () => {
  it("is a prominent, always-present button once wired up", async () => {
    await renderAiPanel(aiHost(), { onOpenOrganize: vi.fn() });
    expect(hasText("Open Organize")).toBe(true);
    expect(isDisabled(buttonFor("Open Organize"))).toBe(false);
  });

  it("closes the dialog and switches the dashboard to the Organize page", async () => {
    const onOpenChange = vi.fn();
    const onOpenOrganize = vi.fn();
    renderDialog(aiHost(), { onOpenChange, onOpenOrganize });
    clickText("AI");
    await settle();

    act(() => buttonFor("Open Organize").click());

    expect(onOpenOrganize).toHaveBeenCalledTimes(1);
  });

  it("is disabled rather than silently doing nothing when no callback was wired up", async () => {
    await renderAiPanelDirectly(aiHost());
    expect(isDisabled(buttonFor("Open Organize"))).toBe(true);
  });
});

// -- Turkish locale -----------------------------------------------------------

describe("Settings → AI — Turkish locale", () => {
  // Mounted directly (bypassing the Settings dialog's section nav), so these
  // don't depend on the AI section's own translated label/description —
  // that's `settings-shared.tsx`, owned by another agent and out of scope here.
  it("renders the intro, the sign-in banner and the file-automatically switch in Turkish", async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "tr");

    await renderAiPanelDirectly(webHost({ user: null }));
    expect(hasText("Yapay zekâ özelliklerini kullanmak için giriş yap")).toBe(true);

    await renderAiPanelDirectly(aiHost());
    expect(hasText("Nook yer imlerini koleksiyonlara ayırabilir")).toBe(true);
    expect(hasText("Yer imlerini otomatik dosyala")).toBe(true);
    expect(hasText("Düzenle sayfasını aç")).toBe(true);
  });

  it("pluralises and formats counts through the Turkish catalog", async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "tr");
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoSummarize: true };
    statusServer.body = status({ summarize: summariseStatus({ summarised: 12, pending: 3 }) });

    await renderAiPanelDirectly(aiHost());
    expect(hasText("12 sayfanın özeti var, 3 tanesi bekliyor.")).toBe(true);
  });

  it("translates the summaries card and the shared 'not available' note", async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "tr");
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoSummarize: true };
    statusServer.body = status({ summarize: summariseStatus({ available: false }) });

    await renderAiPanelDirectly(aiHost());
    expect(hasText("Özetler")).toBe(true);
    expect(hasText("Bu sunucuda henüz kullanılamıyor.")).toBe(true);
  });
});
