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

// SettingsDialog renders SyncPanel's status through this hook; the AI panel
// never reads it, but the module is in the import graph, so stub it the same
// way settings-dialog.test.tsx does.
vi.mock("../src/app/host/useCloudStatus", () => ({
  useCloudStatus: () => null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AI_SETTINGS_KEY = "ai.settings";
const CLOUD_ORIGIN = "https://nook.beyler.co";

// -- the four AI routes ----------------------------------------------------
//
// A pass runs on Nook's server now, so the panel's every read and write is an
// HTTP call (docs/ai-cloud-contract.md). The old harness read `ai.cursor` out of
// IndexedDB and answered "Classify now" over the chrome message channel; both
// of those seams are gone, and everything below is one fetch router standing in
// for GET/PUT /api/ai/settings, GET /api/ai/status, POST /api/ai/run, POST
// /api/ai/taxonomy/propose and PUT /api/ai/taxonomy.

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

/**
 * Per-route handlers, as mutable slots rather than a wholesale
 * `vi.stubGlobal("fetch", ...)` per test: one global fetch has to answer every
 * route at once, because the panel's toggles and its status reads are live
 * throughout any test that also drives a run or a proposal.
 */
type RouteReply = () => Response | Promise<Response>;

let statusHandler: RouteReply | null;
let runHandler: RouteReply | null;
let proposerHandler: RouteReply | null;
let acceptHandler: RouteReply | null;
let acceptBodies: unknown[];

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
      // The one failure a status read has: a route that does not answer. The
      // panel has to render that as "no status to report" rather than as zeros.
      if (statusHandler) return statusHandler();
      return statusServer.respond();
    }
    if (input.endsWith("/api/ai/run")) {
      if (runHandler) return runHandler();
      return json({ queued: 0, summariesQueued: 0, status: status() });
    }
    if (input.endsWith("/api/ai/taxonomy/propose")) {
      if (proposerHandler) return proposerHandler();
      return json({ sampleSize: 0, collections: [], tags: [], existingCollections: [] });
    }
    if (input.endsWith("/api/ai/taxonomy")) {
      acceptBodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
      if (acceptHandler) return acceptHandler();
      return json({ createdCollections: 0, addedTags: 0, dropped: 0, taxonomy: { acceptedAt: null, collections: [], tags: [] } });
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

let container: HTMLElement;
let root: Root;

beforeEach(async () => {
  NookDB._resetForTests();
  _resetAiSettingsCacheForTests();
  _resetAiClientForTests();
  settingsServer = new MockSettingsServer();
  statusServer = new MockStatusServer();
  statusHandler = null;
  runHandler = null;
  proposerHandler = null;
  acceptHandler = null;
  acceptBodies = [];
  fetchLog = [];
  installFetchRouter();
  // A bearer session by default: every AI route is session-guarded, and most of
  // this file is about what a signed-in host does. The couple of tests that are
  // specifically about a missing session clear it explicitly.
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
 *
 * A fixed number of macrotasks was not enough. fake-indexeddb resolves an
 * `open()` over a variable number of turns, and how many depends on what else
 * the file has in flight, so a fixed count made a different test in this file
 * fail on almost every full-suite run. This waits for the store to actually
 * answer a read instead of guessing how long that takes.
 */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await NookDB.getMeta("ai.settle-probe");
    }
  });
}

/**
 * Runs work and a trailing flush inside one act(), because an await outside
 * act() is a window in which a pending panel update lands unwrapped — the read
 * would be racing the very update under test.
 */
async function settled<T>(work: () => Promise<T>): Promise<T> {
  let value: T;
  await act(async () => {
    value = await work();
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return value!;
}

function hasText(text: string): boolean {
  return container.textContent?.includes(text) ?? false;
}

/** How many times a phrase is on screen, for the sentences that have to appear in
 *  two rows at once. */
function countText(text: string): number {
  return (container.textContent?.split(text).length ?? 1) - 1;
}

/**
 * One settings row's own text, found by its title. The rows are untitled
 * containers in a stack, so a claim about a single row's copy — "this row says
 * Never, that row says six days ago" — needs this rather than the whole panel's
 * text, where both are on screen at once.
 */
function rowText(title: string): string {
  const label = rowLabel(title);
  return label.closest("li")?.textContent ?? "";
}

/**
 * The colour one row's status dot is painted. The two states this panel has to
 * keep apart are a deploy away and a failure, and they are told apart by colour
 * as much as by label, so a test asserts the colour too.
 */
function rowDotVariant(title: string): string | undefined {
  // Scoped to the dot's own class: a row's divider carries a data-variant of
  // its own, and the dot is what the panel means.
  return rowLabel(title).closest("li")?.querySelector(".astryx-status-dot")?.getAttribute("data-variant") ?? undefined;
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

/**
 * The control a label names: through `label[for]` (Switch, NumberInput) or
 * `aria-labelledby` (a Slider thumb). Astryx keeps the label in the DOM even
 * when it is visually hidden, so this is how a test reaches the control behind
 * a `SettingsRow`'s title.
 */
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

/**
 * A control can be off in two ways: natively disabled, or `aria-disabled`
 * because it carries a tooltip (which Astryx does so the button stays
 * focusable and the explanation stays reachable).
 */
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

/**
 * A control's explanation, which Astryx puts in a tooltip layer rather than in
 * the control's own text: a disabled button stays focusable so the reason is
 * reachable by keyboard. Read through the id `aria-describedby` points at, since
 * every tooltip'd control on screen has a layer of its own and a scan for
 * tooltip text would find the neighbours'.
 */
function tooltipFor(label: string): string {
  const describedBy = buttonFor(label).getAttribute("aria-describedby");
  return describedBy ? (document.getElementById(describedBy)?.textContent ?? "") : "";
}

function reviewCheckboxes(): HTMLInputElement[] {
  // The two feature Switches are checkboxes underneath (role="switch"), so the
  // review lists are scoped by the container class CheckboxList documents.
  return [...container.querySelectorAll<HTMLInputElement>(".astryx-checkbox-list input[type='checkbox']")];
}

/**
 * The review checkbox carrying a given label, across both lists. Keyed by label
 * because a collection and a tag can share a name, so a positional accessor
 * cannot tell them apart. Matches on the list item's own text, which is where
 * `CheckboxListItem` puts the label and its description.
 */
function reviewCheckbox(label: string): HTMLInputElement {
  const item = [...container.querySelectorAll<HTMLElement>("li.astryx-list-item")].find((element) =>
    element.textContent?.includes(label),
  );
  const box = item?.querySelector<HTMLInputElement>("input[type='checkbox']");
  if (!box) throw new Error(`No review checkbox labelled "${label}".`);
  return box;
}

function readMeta<T>(key: string): Promise<T | undefined> {
  return settled(() => NookDB.getMeta<T>(key));
}

/** The local read-through cache `loadAiSettings`/`saveAiSettings` write to —
 *  most tests should read `settingsServer.settings` instead, which is the
 *  account's actual stored value. */
const readAiSettings = () => readMeta<Record<string, unknown>>(AI_SETTINGS_KEY);

/** Renders the dialog on the AI section and waits for its reads. */
async function renderAiPanel(host: NookHost): Promise<void> {
  renderDialog(host);
  clickText("AI");
  await settle();
}

/**
 * Mounts <AiPanel/> on its own, bypassing the dialog.
 *
 * The dialog shows the AI section for any signed-in host (extension or web) and
 * switches away the moment `host.user` goes away (see `SettingsDialog`'s
 * "re-pick the requested section" effect), so `AiPanel`'s own `!host.user` guard
 * is not reachable through it at all — only a race during that switch could
 * ever hit it for real. This helper is what exercises that guard directly.
 */
async function renderAiPanelDirectly(host: NookHost): Promise<void> {
  act(() => {
    root.render(
      <NookHostProvider host={host}>
        <ToastViewport>
          <AiPanel />
        </ToastViewport>
      </NookHostProvider>,
    );
  });
  await settle();
}

/** The proposal response, as the server sends it. */
function stubProposer(body: unknown, responseStatus = 200): { calls: number } {
  const state = { calls: 0 };
  proposerHandler = () => {
    state.calls++;
    return json(body, { status: responseStatus });
  };
  return state;
}

const PROPOSALS = {
  sampleSize: 200,
  existingCollections: [],
  collections: [
    { name: "Tasarım", why: "Design systems, type and UI craft." },
    { name: "Sistem ve Altyapı", why: "Servers, networking and deployment." },
  ],
  tags: [{ name: "ücretsiz", why: "Free to use.", coveredBy: [] }],
};

// -- section visibility ----------------------------------------------------

describe("Settings → AI — section visibility", () => {
  // Each of these renders once and reads the section list after a flush. Two
  // renders in one test made the second read race the first render's commit, and
  // the whole file went intermittently flaky.
  it("offers the section on a connected extension", async () => {
    renderDialog(aiHost());
    await settle();
    expect(sectionLabels()).toContain("AI");

    clickText("AI");
    await settle();
    expect(hasText("File new bookmarks into collections")).toBe(true);
    expect(hasText("Suggest new categories and tags")).toBe(true);
  });

  it("hides the section with no session", async () => {
    renderDialog(extensionHost());
    await settle();
    expect(sectionLabels()).not.toContain("AI");
  });

  // `host.user` is the gate, not `host.account`: a connected extension has a
  // user and no account, and it is exactly the host that needs this section.
  it("shows the section for a user without an account", async () => {
    renderDialog(extensionHost({ user: { id: "u2", name: "Grace Hopper", email: "grace@example.com" } }));
    await settle();
    expect(sectionLabels()).toContain("AI");

    clickText("AI");
    await settle();
    expect(hasText("File new bookmarks into collections")).toBe(true);
  });

  // A pass is an authenticated call to Nook's server on either host, so a
  // signed-in web user gets the exact same section a signed-in extension does —
  // and the whole point of this change is that it is now the same section, not
  // the same toggles in front of a disabled panel.
  it("shows the section on the web host when signed in, with everything live", async () => {
    renderDialog(webHost());
    await settle();
    expect(sectionLabels()).toContain("AI");

    clickText("AI");
    await settle();
    expect(hasText("File new bookmarks into collections")).toBe(true);
    expect(hasText("Suggest new categories and tags")).toBe(true);
    expect(hasText("Last classification run")).toBe(true);
    expect(isDisabled(buttonFor("Run now"))).toBe(true); // off: no pass is switched on
  });

  it("hides the section on the web host with no session", async () => {
    renderDialog(webHost({ user: null }));
    await settle();
    expect(sectionLabels()).not.toContain("AI");
  });

  // The dialog never mounts AiPanel with `host.user` falsy (the section is not
  // offered at all), so this exercises the panel's own defensive guard
  // directly — the fallback for the one render that could land mid sign-out,
  // before the dialog's own effect switches away from this section.
  it("AiPanel itself falls back to the sign-in banner when mounted without a user", async () => {
    await renderAiPanelDirectly(webHost({ user: null }));
    expect(hasText("Sign in to use AI classification")).toBe(true);
    expect(hasText("File new bookmarks into collections")).toBe(false);
  });
});

// -- feature toggles -------------------------------------------------------

describe("Settings → AI — feature toggles", () => {
  it("commits autoClassify through the settings route and survives a remount", async () => {
    renderDialog(aiHost());
    clickText("AI");
    await settle();

    expect(switchFor("File new bookmarks into collections").checked).toBe(false);
    act(() => switchFor("File new bookmarks into collections").click());
    await settle();

    // The account's row is the source of truth now, not this browser's cache.
    expect(settingsServer.settings.autoClassify).toBe(true);
    expect((await readAiSettings())?.autoClassify).toBe(true);
    expect(settingsServer.requests.some((request) => request.method === "PUT")).toBe(true);
    expect(switchFor("File new bookmarks into collections").checked).toBe(true);

    // Remount: the value has to come back off the server, not out of component
    // state.
    act(() => root.unmount());
    root = createRoot(container);
    renderDialog(aiHost(), { initialSection: "ai" });
    await settle();

    expect(switchFor("File new bookmarks into collections").checked).toBe(true);
  });

  it("commits autoTaxonomy independently of autoClassify", async () => {
    renderDialog(aiHost());
    clickText("AI");
    await settle();

    act(() => switchFor("Suggest new categories and tags").click());
    await settle();

    expect(settingsServer.settings.autoTaxonomy).toBe(true);
    expect(settingsServer.settings.autoClassify).toBe(false);
  });

  // The toggle is the account's row like the other two, and its description is
  // now the only place in Settings that discloses what a summary sends: the pass
  // runs on the server, so a user flipping this is handing their page text to a
  // third-party model and has to be able to read that on the switch.
  it("commits autoSummarize, and says on the switch what a summary sends", async () => {
    renderDialog(aiHost());
    clickText("AI");
    await settle();

    expect(hasText("with the browser closed")).toBe(true);
    expect(hasText("4,000 characters of the page")).toBe(true);
    expect(hasText("OpenAI or Google")).toBe(true);
    // And what the other two send, so the size of this one is legible.
    expect(hasText("Filing and taxonomy send only titles, hostnames and a short preview")).toBe(true);
    // The old card's admission is gone: a pass does run.
    expect(hasText("Nothing fills them in yet")).toBe(false);

    act(() => switchFor("Summarise long pages").click());
    await settle();

    expect(settingsServer.settings.autoSummarize).toBe(true);
  });

  it("only shows the thresholds while autoClassify is on", async () => {
    renderDialog(aiHost());
    clickText("AI");
    await settle();

    expect(hasText("Collection confidence")).toBe(false);

    act(() => switchFor("File new bookmarks into collections").click());
    await settle();
    expect(hasText("Collection confidence")).toBe(true);
    expect(hasText("Tag confidence")).toBe(true);
    expect(hasText("Max tags")).toBe(true);
  });
});

// -- thresholds ------------------------------------------------------------

describe("Settings → AI — thresholds", () => {
  beforeEach(() => {
    settingsServer.settings = {
      ...DEFAULT_AI_SETTINGS,
      autoClassify: true,
      autoTaxonomy: false,
      collectionMinConfidence: 0.9,
      tagMinNoul: 0.65,
      maxTags: 5,
    };
  });

  it("renders each threshold's current value", async () => {
    renderDialog(aiHost());
    clickText("AI");
    await settle();

    expect(sliderFor("Collection confidence").getAttribute("aria-valuenow")).toBe("0.9");
    expect(sliderFor("Tag confidence").getAttribute("aria-valuenow")).toBe("0.65");
    expect(numberInputFor("Max tags").value).toBe("5");
    // The value display is what makes a slider's number readable.
    expect(hasText("0.90")).toBe(true);
    expect(hasText("0.65")).toBe(true);
  });

  it("commits a dragged collection confidence on change end", async () => {
    renderDialog(aiHost());
    clickText("AI");
    await settle();

    const thumb = sliderFor("Collection confidence");
    act(() => {
      thumb.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });
    await settle();

    expect(settingsServer.settings.collectionMinConfidence).toBe(0.95);
    // The tag threshold is its own number: one drag must not move it.
    expect(settingsServer.settings.tagMinNoul).toBe(0.65);
  });

  it("commits a stepped max-tags value", async () => {
    renderDialog(aiHost());
    clickText("AI");
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
    settingsServer.settings = {
      ...DEFAULT_AI_SETTINGS,
      autoClassify: true,
      autoTaxonomy: true,
      collectionMinConfidence: 7,
      tagMinNoul: -3,
      maxTags: 99,
    };

    renderDialog(aiHost());
    clickText("AI");
    await settle();

    const collection = Number(sliderFor("Collection confidence").getAttribute("aria-valuenow"));
    const tags = Number(sliderFor("Tag confidence").getAttribute("aria-valuenow"));
    const maxTags = Number(numberInputFor("Max tags").value);

    expect(Number.isFinite(collection)).toBe(true);
    expect(collection).toBeGreaterThanOrEqual(0);
    expect(collection).toBeLessThanOrEqual(1);
    expect(tags).toBeGreaterThanOrEqual(0);
    expect(tags).toBeLessThanOrEqual(1);
    expect(Number.isInteger(maxTags)).toBe(true);
    expect(maxTags).toBeGreaterThanOrEqual(0);
  });
});

// -- status ----------------------------------------------------------------

describe("Settings → AI — status", () => {
  it("renders the server's run history and its counters", async () => {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoClassify: true };
    statusServer.body = status({
      run: {
        processed: 25,
        assigned: 18,
        tagged: 40,
        skipped: 7,
        lastRunAt: "2026-09-20T10:00:00.000Z",
        lastError: null,
        isUnavailable: false,
        isBackingOff: false,
        log: [],
      },
    });

    await renderAiPanel(aiHost());

    expect(hasText("Last classification run")).toBe(true);
    expect(hasText("Last classification pass")).toBe(true);
    expect(hasText("18")).toBe(true);
    expect(hasText("7")).toBe(true);
    // Idle: available, nothing wrong, a feature on.
    expect(hasText("Idle")).toBe(true);
  });

  it("reports off when no feature is on", async () => {
    statusServer.body = status();
    await renderAiPanel(aiHost());
    expect(hasText("Off")).toBe(true);
  });

  it("surfaces the run's own lastError", async () => {
    statusServer.body = status({
      run: { processed: 3, assigned: 0, tagged: 0, skipped: 3, lastRunAt: null, lastError: "Nook's AI key isn't configured.", isUnavailable: false, isBackingOff: false, log: [] },
    });

    await renderAiPanel(aiHost());

    expect(hasText("Nook's AI key isn't configured.")).toBe(true);
    expect(hasText("Needs attention")).toBe(true);
  });

  // The server's own flag, not a client-side cool-down window read out of
  // IndexedDB: a missing key is a deploy away, so it is a state to report
  // rather than an error to raise.
  it("reports unavailable when the server has no AI key", async () => {
    statusServer.body = status({ available: false });
    await renderAiPanel(aiHost());
    expect(hasText("Unavailable")).toBe(true);
    expect(hasText("Nook's server has no AI key configured")).toBe(true);
  });

  it("reports unavailable while the run summary says a cooldown is in effect", async () => {
    statusServer.body = status({
      run: { processed: 0, assigned: 0, tagged: 0, skipped: 0, lastRunAt: null, lastError: null, isUnavailable: true, isBackingOff: false, log: [] },
    });
    await renderAiPanel(aiHost());
    expect(hasText("Unavailable")).toBe(true);
  });

  it("shows the queue depth only while there is something waiting", async () => {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoClassify: true };
    statusServer.body = status({ pending: 0 });
    await renderAiPanel(aiHost());
    expect(hasText("Waiting to be classified")).toBe(false);

    // A queue that is draining is the whole reason the panel re-reads the
    // status while the dialog is open.
    statusServer.body = status({ pending: 12 });
    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    await renderAiPanel(aiHost());
    expect(hasText("Waiting to be classified")).toBe(true);
    expect(hasText("12")).toBe(true);
  });

  it("survives a status body that is missing everything", async () => {
    // A hand-edited or future server build must not be able to crash the
    // settings dialog, and an unread status must not be rendered as a confident
    // "Never" or a 0.
    statusServer.body = {};
    await renderAiPanel(aiHost());
    expect(hasText("Nook's server isn't answering")).toBe(false);
    expect(hasText("Last classification run")).toBe(true);
    expect(hasText("Never")).toBe(true);
  });

  // A read that never landed is not a state the server reported, so it gets the
  // "unavailable" dot with a different sentence — and both passes get it, or the
  // panel would contradict itself two cards apart.
  it("reports a status read that never landed the same way for both passes", async () => {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoClassify: true, autoSummarize: true };
    statusHandler = () => json({ error: "boom" }, { status: 500 });

    await renderAiPanel(aiHost());

    expect(countText("Nook's server isn't answering")).toBe(2);
    // Neither "no key is configured" claim: this panel has been told nothing
    // about either deployment.
    expect(hasText("has no summariser configured")).toBe(false);
    expect(hasText("no AI key configured")).toBe(false);
    // And no confident history either — a dash where a number or a date would be.
    expect(hasText("Never")).toBe(false);
  });

  it("re-reads the status after a run is requested", async () => {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoClassify: true };
    statusServer.body = status();
    runHandler = () => json({ queued: 4, summariesQueued: 0, status: status({ pending: 4 }) });

    await renderAiPanel(aiHost());
    const before = requestsTo("/api/ai/status").length;

    act(() => buttonFor("Run now").click());
    await settle();

    // The enqueue response's own status is not trusted: the panel re-reads, so
    // the row reflects the server rather than this browser's guess.
    expect(requestsTo("/api/ai/status").length).toBeGreaterThan(before);
    expect(requestsTo("/api/ai/status").every((request) => request.method === "GET")).toBe(true);
  });
});

// -- summaries -------------------------------------------------------------

describe("Settings → AI — summaries", () => {
  // Both counts are SQL counts over the account's records with the same length
  // gate the pass applies, so the old local count's upper bound — and the hedge
  // that used to have to admit it — are gone rather than reworded.
  it("reports the server's own counts, without the upper-bound hedge", async () => {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoSummarize: true };
    statusServer.body = status({ summarize: summariseStatus({ summarised: 241, pending: 12 }) });

    await renderAiPanel(aiHost());

    expect(hasText("In your library")).toBe(true);
    expect(hasText("241")).toBe(true);
    expect(hasText("with a summary")).toBe(true);
    expect(hasText("12")).toBe(true);
    expect(hasText("waiting")).toBe(true);
    expect(hasText("some of them never will")).toBe(false);
    // No local counting pass to wait for, so no placeholder for one.
    expect(hasText("Counting…")).toBe(false);
  });

  // With the toggle off the queue is empty by construction — the top-up that
  // fills it is gated on the setting — so "nothing waiting" is not a claim
  // about the library.
  it("says the waiting count means nothing while the toggle is off", async () => {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoSummarize: false };
    statusServer.body = status({ summarize: summariseStatus({ summarised: 241, pending: 0 }) });

    await renderAiPanel(aiHost());

    expect(hasText("however many of your pages would qualify")).toBe(true);
    expect(hasText("these are the account's real numbers")).toBe(false);
  });

  it("renders the last pass as a live relative time, and Never when there has been none", async () => {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoSummarize: true };
    statusServer.body = status({ summarize: summariseStatus({ lastRunAt: "2026-09-20T10:00:00.000Z" }) });

    await renderAiPanel(aiHost());
    expect(rowText("Last summary pass")).toMatch(/ago/);
    expect(rowText("Last summary pass")).not.toContain("Never");

    // "Never" is now a fact about the account rather than a placeholder for a
    // pass that could not run, and it is only printed off a real read.
    act(() => root.unmount());
    root = createRoot(container);
    statusServer.body = status();
    await renderAiPanel(aiHost());
    expect(rowText("Last summary pass")).toContain("Never");
  });

  it("surfaces the pass's own lastError, as an error rather than a deploy note", async () => {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoSummarize: true };
    statusServer.body = status({ summarize: summariseStatus({ lastError: "Rate limited by the provider.", lastRunAt: "2026-09-20T10:00:00.000Z" }) });

    await renderAiPanel(aiHost());

    expect(rowText("Last summary pass")).toContain("Rate limited by the provider.");
    // The dot says so too, in the error colour rather than the warning one a
    // missing deploy gets.
    expect(rowText("Summarisation")).toContain("Needs attention");
    expect(rowDotVariant("Summarisation")).toBe("error");
    expect(hasText("has no summariser configured")).toBe(false);
  });

  // A missing summariser is a deploy, exactly as a missing classification key
  // is: a state to report in the same warning colour, not an error to raise and
  // not something to blame on the user's library.
  it("reports a server with no summariser as unavailable, distinctly from an error", async () => {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoSummarize: true };
    statusServer.body = status({ summarize: summariseStatus({ available: false }) });

    await renderAiPanel(aiHost());

    expect(rowText("Summarisation")).toContain("Unavailable");
    expect(rowText("Summarisation")).toContain("has no summariser configured");
    expect(rowDotVariant("Summarisation")).toBe("warning");
    // The same words on the row a user reads to find out when a pass last ran,
    // so the card above and the status card below cannot disagree.
    expect(rowText("Last summary pass")).toContain("has no summariser configured");
    expect(rowText("Summarisation")).not.toContain("Needs attention");
  });

  it("keeps the two deployments apart: no classification key, summariser fine", async () => {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoClassify: true, autoSummarize: true };
    statusServer.body = status({ available: false, summarize: summariseStatus({ summarised: 4, lastRunAt: "2026-09-20T10:00:00.000Z" }) });

    await renderAiPanel(aiHost());

    expect(hasText("Nook's server has no AI key configured")).toBe(true);
    expect(rowText("Summarisation")).not.toContain("has no summariser configured");
    // And the summarise rows carry the account's real numbers anyway.
    expect(rowText("In your library")).toContain("4");
    expect(rowText("Last summary pass")).toMatch(/ago/);
  });

  // The one case a four-state dot cannot carry: the pass is on, the queue is not
  // empty, and the server is waiting out an upstream failure. Reporting "Idle"
  // alone would be a claim about a pass that is not going to run for a while.
  it("names the back-off window the dot cannot express", async () => {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoSummarize: true };
    statusServer.body = status({ summarize: summariseStatus({ isBackingOff: true, pending: 6 }) });

    await renderAiPanel(aiHost());

    expect(rowText("Summarisation")).toContain("waiting out a temporary failure");
    expect(rowText("Summarisation")).toContain("Idle");
    // A server with no summariser is the bigger fact and wins the sentence.
    statusServer.body = status({ summarize: summariseStatus({ isBackingOff: true, available: false }) });
    act(() => root.unmount());
    root = createRoot(container);
    await renderAiPanel(aiHost());
    expect(rowText("Summarisation")).toContain("has no summariser configured");
    expect(rowText("Summarisation")).not.toContain("waiting out a temporary failure");
  });

  // `summarize` is additive on the wire. An older build omits it, which reads as
  // a server with no summariser — true of such a build — rather than a crash or
  // a library nobody has ever summarised.
  it("survives a server that does not send the summarise half at all", async () => {
    const withoutSummarize = status();
    delete withoutSummarize.summarize;
    statusServer.body = withoutSummarize;

    await renderAiPanel(aiHost());

    expect(hasText("has no summariser configured")).toBe(true);
    expect(hasText("In your library")).toBe(true);
    expect(hasText("Never")).toBe(true);
  });
});

// -- run now ---------------------------------------------------------------

describe("Settings → AI — run now", () => {
  async function seedClassify(): Promise<void> {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoClassify: true };
    statusServer.body = status();
  }

  it("POSTs to /api/ai/run and toasts the queued count, not a pass result", async () => {
    await seedClassify();
    runHandler = () => json({ queued: 3, summariesQueued: 0, status: status({ pending: 3 }) });

    await renderAiPanel(aiHost());
    act(() => buttonFor("Run now").click());
    await settle();

    expect(requestsTo("/api/ai/run")).toMatchObject([{ method: "POST" }]);
    // The call can only enqueue. A toast claiming a pass happened would be
    // reporting numbers this browser does not have — the old one said
    // "18 filed, 7 left alone" straight off the service worker.
    expect(hasText("Queued 3 bookmarks to classify. Nook's server is working through them now.")).toBe(true);
    expect(container.textContent).not.toMatch(/\d+ filed, \d+ left alone\./);
    // Summarising is off here, so the sentence must not mention it: the route
    // gates each half on its own toggle and queued nothing for that one.
    expect(hasText("to summarise")).toBe(false);
  });

  // One button, two passes, and the toast has to report the depths separately:
  // a user with both on is owed both numbers, and neither of them is a result.
  it("reports both queue depths without claiming either pass happened", async () => {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoClassify: true, autoSummarize: true };
    statusServer.body = status();
    runHandler = () => json({ queued: 3, summariesQueued: 8, status: status() });

    await renderAiPanel(aiHost());
    act(() => buttonFor("Run now").click());
    await settle();

    expect(hasText("Queued 3 bookmarks to classify and 8 pages to summarise.")).toBe(true);
    expect(hasText("Nook's server is working through them now.")).toBe(true);
    // Nothing claims work was done: the old toast reported "18 filed, 7 left
    // alone" straight off the service worker, and this call has no such numbers.
    expect(container.textContent).not.toMatch(/\d+ (?:filed|summarised|written)/);
  });

  it("says so when neither queue got anything", async () => {
    await seedClassify();
    runHandler = () => json({ queued: 0, summariesQueued: 0, status: status() });

    await renderAiPanel(aiHost());
    act(() => buttonFor("Run now").click());
    await settle();

    expect(hasText("Nothing to classify or summarise.")).toBe(true);
  });

  it("reports a request that did not complete, and stays clickable", async () => {
    await seedClassify();
    runHandler = () => json({ error: "nope" }, { status: 500 });

    await renderAiPanel(aiHost());
    act(() => buttonFor("Run now").click());
    await settle();

    expect(hasText("Could not queue a pass.")).toBe(true);
    expect(isDisabled(buttonFor("Run now"))).toBe(false);
  });

  // Neither pass has a queue of its own with the toggle off, so a click could
  // only report "nothing" — which is a reason not to offer it.
  it("is disabled when neither toggle is on", async () => {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoTaxonomy: true };
    let calls = 0;
    runHandler = () => {
      calls++;
      return json({ queued: 1, summariesQueued: 0, status: status() });
    };

    await renderAiPanel(aiHost());
    // Taxonomy is on and still nothing to queue: it has no pass and no queue,
    // so it must not be what lights the button up.
    expect(isDisabled(buttonFor("Run now"))).toBe(true);
    // And the button says which switches would give it something to do, rather
    // than the generic "a feature" that would now be wrong.
    expect(tooltipFor("Run now")).toContain("Turn on “File new bookmarks” or “Summarise long pages” first.");

    act(() => buttonFor("Run now").click());
    await settle();
    expect(calls).toBe(0);
  });

  it("queues only the pass whose toggle is on, and does not claim the other", async () => {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoSummarize: true };
    statusServer.body = status();
    let sent: { queued: number; summariesQueued: number } | null = null;
    runHandler = () => {
      sent = { queued: 0, summariesQueued: 6 };
      return json({ queued: sent.queued, summariesQueued: sent.summariesQueued, status: status() });
    };

    await renderAiPanel(aiHost());
    const button = buttonFor("Run now");
    expect(isDisabled(button)).toBe(false);
    // The tooltip names the pass it would queue: a summary-only account must not
    // be told to expect a classification.
    expect(tooltipFor("Run now")).toContain("the pages long enough to need a summary");
    expect(tooltipFor("Run now")).not.toContain("classification");

    act(() => button.click());
    await settle();

    expect(sent).toEqual({ queued: 0, summariesQueued: 6 });
    expect(hasText("Queued 6 pages to summarise.")).toBe(true);
    // A toast promising classification on a summary-only account would be a
    // claim the route did not make.
    expect(hasText("to classify")).toBe(false);
  });

  // There is no service worker to ask and no single-flight guard to join now,
  // so a second click is a second call: the control has to say so on its own.
  it("is disabled while a request is in flight, and again once it lands", async () => {
    await seedClassify();
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    runHandler = async () => {
      await held;
      return json({ queued: 1, summariesQueued: 0, status: status() });
    };

    await renderAiPanel(aiHost());
    act(() => buttonFor("Run now").click());
    await settle();

    expect(isDisabled(buttonFor("Run now"))).toBe(true);

    await settled(async () => {
      release?.();
      await held;
    });
    expect(isDisabled(buttonFor("Run now"))).toBe(false);
  });
});

// -- both hosts ------------------------------------------------------------

describe("Settings → AI — the web host", () => {
  // The behaviour change this whole workstream exists for: the run history and
  // the run actions used to be hidden here, because `ai.cursor` was a per-origin
  // IndexedDB record the extension's runner wrote and the web origin never had.
  // The status is the account's now, so both hosts render the same rows.
  it("renders the status row and the run history, and classifies on demand", async () => {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoClassify: true };
    statusServer.body = status({
      run: {
        processed: 25,
        assigned: 18,
        tagged: 40,
        skipped: 7,
        lastRunAt: "2026-09-20T10:00:00.000Z",
        lastError: null,
        isUnavailable: false,
        isBackingOff: false,
        log: [],
      },
    });
    const sent: string[] = [];
    runHandler = () => {
      sent.push("run");
      return json({ queued: 2, summariesQueued: 0, status: status() });
    };

    await renderAiPanel(webHost());

    expect(hasText("Last classification run")).toBe(true);
    expect(hasText("Last classification pass")).toBe(true);
    expect(hasText("18")).toBe(true);
    expect(hasText("7")).toBe(true);
    // Nothing points at the extension any more.
    expect(hasText("Run history")).toBe(false);
    expect(hasText("background service worker")).toBe(false);

    expect(isDisabled(buttonFor("Run now"))).toBe(false);
    act(() => buttonFor("Run now").click());
    await settle();
    expect(sent).toEqual(["run"]);
    expect(hasText("Queued 2 bookmarks to classify.")).toBe(true);
  });
  it("proposes a taxonomy on the web host too", async () => {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoTaxonomy: true };
    const proposer = stubProposer(PROPOSALS);

    await renderAiPanel(webHost());

    expect(isDisabled(buttonFor("Suggest taxonomy"))).toBe(false);
    act(() => buttonFor("Suggest taxonomy").click());
    await settle();

    expect(proposer.calls).toBe(1);
    expect(hasText("New collections")).toBe(true);
  });

  // The web app has no bearer token — it authenticates with the session cookie
  // the browser attaches itself, which `cloudRequestAuth()` reports as
  // `credentials: "include"`. That branch is the reason any of this works here.
  it("authenticates with the cookie rather than a token", async () => {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoTaxonomy: true };
    configureCloud({ apiUrl: "https://nook.beyler.co", auth: "cookie" });
    // A cookie-mode browser has an account bound but no token stored, which is
    // exactly what `cloudRequestAuth()` reads.
    await NookDB.setMeta(`cloud:${CLOUD_ORIGIN}:token`, null);
    await NookDB.setMeta(`cloud:${CLOUD_ORIGIN}:owner`, "user-1");
    stubProposer(PROPOSALS);

    await renderAiPanel(webHost());
    act(() => buttonFor("Suggest taxonomy").click());
    await settle();

    expect(hasText("New collections")).toBe(true);
    const [proposal] = requestsTo("/api/ai/taxonomy/propose");
    expect(proposal.headers.Authorization).toBeUndefined();
    expect(proposal.credentials).toBe("include");
  });
});

// -- suggest taxonomy ------------------------------------------------------

describe("Settings → AI — suggest taxonomy", () => {
  beforeEach(() => {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoTaxonomy: true };
  });

  it("keeps the button disabled while the feature is off", async () => {
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoTaxonomy: false };
    const server = stubProposer(PROPOSALS);

    await renderAiPanel(aiHost());

    expect(isDisabled(buttonFor("Suggest taxonomy"))).toBe(true);
    act(() => buttonFor("Suggest taxonomy").click());
    await settle();
    expect(server.calls).toBe(0);
  });

  it("offers it once the feature is on, and says what it will do", async () => {
    const server = stubProposer(PROPOSALS);

    await renderAiPanel(aiHost());

    expect(isDisabled(buttonFor("Suggest taxonomy"))).toBe(false);
    expect(hasText("Reads a sample of your unfiled bookmarks")).toBe(true);
    // Nothing is asked for until the user asks for it.
    expect(server.calls).toBe(0);
  });

  it("shows each proposal with a checkbox, its reason, and ticked by default", async () => {
    stubProposer(PROPOSALS);

    await renderAiPanel(aiHost());
    act(() => buttonFor("Suggest taxonomy").click());
    await settle();

    // Two collections and one tag, all ticked: "ücretsiz" is covered by
    // nothing, so it starts on.
    const boxes = reviewCheckboxes();
    expect(boxes).toHaveLength(3);
    expect(boxes.every((box) => box.checked)).toBe(true);
    expect(hasText("Tasarım")).toBe(true);
    expect(hasText("Design systems, type and UI craft.")).toBe(true);
    expect(hasText("Servers, networking and deployment.")).toBe(true);
    expect(hasText("New collections")).toBe(true);
    expect(hasText("New tags")).toBe(true);
    // The sample size is the server's count of what it read, not a client-side
    // Bookmark[] the panel happened to hold.
    expect(hasText("Nook read 200 of your unfiled bookmarks.")).toBe(true);
    expect(buttonFor("Add 2 collections and 1 tag")).toBeTruthy();
  });

  it("names the collections the account already has in the review", async () => {
    stubProposer({ ...PROPOSALS, existingCollections: ["Reading"] });

    await renderAiPanel(aiHost());
    act(() => buttonFor("Suggest taxonomy").click());
    await settle();

    expect(hasText("You already have Reading")).toBe(true);
  });

  it("starts a tag unticked when a collection above already covers it, and re-ticks it when that collection is unticked", async () => {
    // The proposer names one theme twice — "Açık Kaynak Projeleri" and "açık
    // kaynak" — and from its side those are one observation. The tag is still
    // offered, because a collection is exclusive and a tag is not, but it
    // should not arrive fighting its own collection by default. The server says
    // which collection covers it (`coveredBy`); unticking that collection is
    // the moment the tag is the only name left carrying the theme.
    stubProposer({
      sampleSize: 200,
      existingCollections: [],
      collections: [{ name: "Açık Kaynak Projeleri", why: "Open source work." }],
      tags: [
        { name: "açık kaynak", why: "Open source.", coveredBy: ["Açık Kaynak Projeleri"] },
        { name: "ücretsiz", why: "Free to use.", coveredBy: [] },
      ],
    });

    await renderAiPanel(aiHost());
    act(() => buttonFor("Suggest taxonomy").click());
    await settle();

    expect(reviewCheckbox("Açık Kaynak Projeleri").checked).toBe(true);
    expect(reviewCheckbox("açık kaynak").checked).toBe(false);
    expect(reviewCheckbox("ücretsiz").checked).toBe(true);
    expect(hasText("A collection above already covers this.")).toBe(true);
    expect(buttonFor("Add 1 collection and 1 tag")).toBeTruthy();

    act(() => reviewCheckbox("Açık Kaynak Projeleri").click());
    await settle();

    // Live, not a one-time default: the covering collection is gone, so the tag
    // it covered is offered in its place and the reason comes back with it.
    expect(reviewCheckbox("Açık Kaynak Projeleri").checked).toBe(false);
    expect(reviewCheckbox("açık kaynak").checked).toBe(true);
    expect(hasText("A collection above already covers this.")).toBe(false);
    expect(hasText("Open source.")).toBe(true);
    expect(buttonFor("Add 2 tags")).toBeTruthy();
  });

  it("reviews a tag-only proposal without a collection list", async () => {
    stubProposer({ sampleSize: 12, existingCollections: [], collections: [], tags: [{ name: "tasarım sistemleri", coveredBy: [] }] });

    await renderAiPanel(aiHost());
    act(() => buttonFor("Suggest taxonomy").click());
    await settle();

    expect(hasText("New tags")).toBe(true);
    expect(hasText("New collections")).toBe(false);
    expect(buttonFor("Add 1 tag")).toBeTruthy();
  });

  it("accepts the ticked names through PUT /api/ai/taxonomy, and nothing else", async () => {    stubProposer(PROPOSALS);
    acceptHandler = () =>
      json({
        createdCollections: 2,
        addedTags: 1,
        dropped: 0,
        taxonomy: { acceptedAt: "2026-09-26T00:00:00.000Z", collections: [], tags: [{ name: "ücretsiz" }] },
      });

    await renderAiPanel(aiHost());
    act(() => buttonFor("Suggest taxonomy").click());
    await settle();
    act(() => buttonFor("Add 2 collections and 1 tag").click());
    await settle();

    // Names, plus each tag's definition and nothing else. The sample, the
    // account's live lists and the library's own tags are read from
    // `nook_records` on the server, which is both more correct and what makes a
    // half-finished acceptance impossible. The definition is the exception and
    // has to travel: the proposer wrote it, this review list is the last place it
    // exists, and it is the only evidence a member-less tag gets when it is first
    // offered to the model.
    expect(acceptBodies).toEqual([
      {
        collections: ["Tasarım", "Sistem ve Altyapı"],
        tags: [{ name: "ücretsiz", definition: "Free to use." }],
      },
    ]);
    // The client writes nothing itself any more — the server owns both writes.
    expect(await readMeta("ai.taxonomy")).toBeUndefined();
    expect((await settled(() => NookDB.getAllLists())).length).toBe(0);

    expect(hasText("Added 2 collections.")).toBe(true);
    expect(hasText("1 tag is ready to be used.")).toBe(true);
    expect(hasText("Collections are real — rename or delete them any time.")).toBe(true);
  });

  it("accepts only what is still ticked", async () => {
    stubProposer(PROPOSALS);
    acceptHandler = () => json({ createdCollections: 1, addedTags: 1, dropped: 0, taxonomy: { acceptedAt: null, collections: [], tags: [] } });

    await renderAiPanel(aiHost());
    act(() => buttonFor("Suggest taxonomy").click());
    await settle();

    act(() => reviewCheckbox("Tasarım").click());
    await settle();

    expect(reviewCheckbox("Tasarım").checked).toBe(false);
    expect(buttonFor("Add 1 collection and 1 tag")).toBeTruthy();

    act(() => buttonFor("Add 1 collection and 1 tag").click());
    await settle();

    expect(acceptBodies).toEqual([
      { collections: ["Sistem ve Altyapı"], tags: [{ name: "ücretsiz", definition: "Free to use." }] },
    ]);
  });

  it("reports a name the account already had as left alone", async () => {
    stubProposer(PROPOSALS);
    acceptHandler = () => json({ createdCollections: 1, addedTags: 1, dropped: 1, taxonomy: { acceptedAt: null, collections: [], tags: [] } });

    await renderAiPanel(aiHost());
    act(() => buttonFor("Suggest taxonomy").click());
    await settle();
    act(() => buttonFor("Add 2 collections and 1 tag").click());
    await settle();

    expect(hasText("Added 1 collection.")).toBe(true);
    expect(hasText("One you already had was left as it is.")).toBe(true);
  });

  it("reports a server with no AI key as unconfigured, not as a failure", async () => {
    stubProposer({ error: "AI classification is not configured" }, 503);

    await renderAiPanel(aiHost());
    act(() => buttonFor("Suggest taxonomy").click());
    await settle();

    expect(hasText("Nook's server has no AI key configured")).toBe(true);
    // Not the generic sentence, and not a red "something went wrong".
    expect(hasText("Could not reach the taxonomy proposal endpoint.")).toBe(false);
    expect(reviewCheckboxes()).toHaveLength(0);
    // The row stays usable: the condition is a deploy, not a dead button.
    expect(isDisabled(buttonFor("Suggest taxonomy"))).toBe(false);
  });

  it("treats an empty proposal list as a legitimate answer", async () => {
    // A real sample behind the empty answer: the model declined, or no proposer
    // is configured. Both are answers, neither is a failure.
    stubProposer({ sampleSize: 200, existingCollections: [], collections: [], tags: [] });

    await renderAiPanel(aiHost());
    act(() => buttonFor("Suggest taxonomy").click());
    await settle();

    expect(hasText("Nothing new worth suggesting.")).toBe(true);
    expect(reviewCheckboxes()).toHaveLength(0);
    expect(acceptBodies).toEqual([]);
  });

  it("says so when the server had nothing unfiled to read", async () => {
    stubProposer({ sampleSize: 0, existingCollections: [], collections: [], tags: [] });

    await renderAiPanel(aiHost());
    act(() => buttonFor("Suggest taxonomy").click());
    await settle();

    expect(hasText("There is nothing unfiled to read yet.")).toBe(true);
    expect(hasText("Nothing new worth suggesting.")).toBe(false);
    expect(reviewCheckboxes()).toHaveLength(0);
  });

  it("asks for a session before it reads anything", async () => {
    // The global beforeEach signs this browser in by default (most of this file
    // needs that for the AI routes); this test is specifically about there being
    // no session, so it clears the token cloudRequestAuth() reads. The panel
    // still has yesterday's cached settings locally (autoTaxonomy: true), which
    // is exactly the point: the toggle looking on is not what gates the request
    // — the session is.
    await NookDB.setMeta(`cloud:${CLOUD_ORIGIN}:token`, null);
    await NookDB.setMeta(AI_SETTINGS_KEY, { ...DEFAULT_AI_SETTINGS, autoTaxonomy: true });
    const server = stubProposer(PROPOSALS);

    await renderAiPanel(aiHost());

    act(() => buttonFor("Suggest taxonomy").click());
    await settle();

    expect(server.calls).toBe(0);
    expect(hasText("Your session has expired.")).toBe(true);
  });
});
