// @vitest-environment happy-dom
import "fake-indexeddb/auto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastViewport } from "@astryxdesign/core/Toast";
import { NookHostProvider, type NookHost } from "../src/app/host/NookHost";
import { AiPanel } from "../src/app/settings-dialog/AiPanel";
import { SettingsDialog } from "../src/app/settings-dialog/SettingsDialog";
import { AI_TAXONOMY_META_KEY } from "../lib/ai-runner";
import { DEFAULT_AI_SETTINGS } from "../lib/ai-settings";
import { saveCloudSession } from "../lib/cloud-sync";
import * as NookDB from "../lib/db";
import type { AcceptedTaxonomy } from "../lib/ai-taxonomy";
import type { BookmarkList } from "../lib/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// SettingsDialog renders SyncPanel's status through this hook; the AI panel
// never reads it, but the module is in the import graph, so stub it the same
// way settings-dialog.test.tsx does.
vi.mock("../src/app/host/useCloudStatus", () => ({
  useCloudStatus: () => null,
}));

const AI_SETTINGS_KEY = "ai.settings";
const AI_CURSOR_KEY = "ai.cursor";

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

/**
 * The AI section is extension-only: the classification pass runs in the
 * extension's service worker and authenticates with the bearer token the
 * cloud-sync bridge writes, which the web host never has. So every test that
 * exercises the panel needs a connected extension, not the signed-in web host.
 */
/**
 * The AI section is extension-only: the classification pass runs in the
 * extension's service worker and authenticates with the bearer token the
 * cloud-sync bridge writes, which the web host never has. So every test that
 * exercises the panel needs a connected extension, not the signed-in web host.
 */
function aiHost(overrides: Partial<NookHost> = {}): NookHost {
  return extensionHost({
    user: { id: "u1", name: "Ada Lovelace", email: "ada@example.com", createdAt: "2024-01-01T00:00:00.000Z" },
    ...overrides,
  });
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

beforeEach(() => {
  NookDB._resetForTests();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await settle();
  act(() => root.unmount());
  container.remove();
});

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
 * Flush the panel's async reads of `ai.settings` and `ai.cursor`.
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
      // A resolved read means the open settled and the transaction machinery is
      // running; the panel's own reads queued behind ours then complete on the
      // following turns.
      await NookDB.getMeta("ai.settle-probe");
    }
  });
}

function hasText(text: string): boolean {
  return container.textContent?.includes(text) ?? false;
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
 * Runs a store read and a trailing flush inside one act(), because an await
 * outside act() is a window in which a pending panel update lands unwrapped —
 * the read would be racing the very update under test.
 */
async function settled<T>(work: () => Promise<T>): Promise<T> {
  let value: T;
  await act(async () => {
    value = await work();
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return value!;
}

function readMeta<T>(key: string): Promise<T | undefined> {
  return settled(() => NookDB.getMeta<T>(key));
}

function readLists(): Promise<BookmarkList[]> {
  return settled(() => NookDB.getAllLists());
}

const readAiSettings = () => readMeta<Record<string, unknown>>(AI_SETTINGS_KEY);

/** The extension host, signed in: the only host where an AI action can run. */
/**
 * A library with something unfiled in it, plus the session the routes need.
 * Without both, `requestProposals` stops before the network and the row under
 * test never reaches the states this file is about.
 */
async function seedLibrary(options: { taxonomy?: boolean; tagged?: string } = {}): Promise<void> {
  await saveCloudSession("test-token", "user-1");
  await NookDB.setMeta(AI_SETTINGS_KEY, { ...DEFAULT_AI_SETTINGS, autoTaxonomy: options.taxonomy ?? true });
  await NookDB.putBookmark({
    id: "b-1",
    source: "web",
    url: "https://example.com/tasarim-notlari",
    title: "Tasarım notları ve CSS grid rehberi",
    ...(options.tagged ? { tags: [options.tagged] } : {}),
  });
}

/** Renders the dialog on the AI section and waits for its meta reads. */
async function renderAiPanel(host: NookHost): Promise<void> {
  renderDialog(host);
  clickText("AI");
  await settle();
}

/**
 * Mounts <AiPanel/> on its own, bypassing the dialog.
 *
 * The AI section is gated to the extension host, because that is the only place
 * a classification pass can run — so the panel's own "this host has no service
 * worker" branch is unreachable through the dialog. The branch stays (it is a
 * real precondition, and it is what makes the panel correct if it is ever
 * mounted directly or the gate is relaxed), so it needs a way to be exercised.
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

/** Stands in for POST /api/ai/propose-taxonomy, and records that it was called. */
function stubProposer(body: unknown, status = 200): { calls: number } {
  const state = { calls: 0 };
  vi.stubGlobal("fetch", async () => {
    state.calls++;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  });
  return state;
}

const PROPOSALS = {
  collections: [
    { name: "Tasarım", why: "Design systems, type and UI craft." },
    { name: "Sistem ve Altyapı", why: "Servers, networking and deployment." },
  ],
  tags: [{ name: "ücretsiz" }],
};

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

function reviewCheckboxes(): HTMLInputElement[] {
  // The two feature Switches are checkboxes underneath (role="switch"), so the
  // review lists are scoped by the container class CheckboxList documents.
  // There are two of them now — collections and tags — so this is every
  // proposal checkbox in review order, not one list's worth.
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

  // The pass runs in the extension's service worker and authenticates with the
  // bearer token the cloud-sync bridge writes. The web app has neither, so a
  // toggle there would write ai.settings to a per-origin meta store that nothing
  // on that origin ever reads — a switch that visibly does nothing.
  it("hides the section on the web host even when signed in", async () => {
    renderDialog(webHost());
    await settle();
    expect(sectionLabels()).not.toContain("AI");
  });
});

describe("Settings → AI — feature toggles", () => {
  it("persists autoClassify to ai.settings and survives a remount", async () => {
    renderDialog(aiHost());
    clickText("AI");
    await settle();

    expect(switchFor("File new bookmarks into collections").checked).toBe(false);
    act(() => switchFor("File new bookmarks into collections").click());
    await settle();

    expect((await readAiSettings())?.autoClassify).toBe(true);
    expect(switchFor("File new bookmarks into collections").checked).toBe(true);

    // Remount: the value has to come back off disk, not out of component state.
    act(() => root.unmount());
    root = createRoot(container);
    renderDialog(aiHost(), { initialSection: "ai" });
    await settle();

    expect(switchFor("File new bookmarks into collections").checked).toBe(true);
  });

  it("persists autoTaxonomy independently of autoClassify", async () => {
    renderDialog(aiHost());
    clickText("AI");
    await settle();

    act(() => switchFor("Suggest new categories and tags").click());
    await settle();

    const stored = await readAiSettings();
    expect(stored?.autoTaxonomy).toBe(true);
    expect(stored?.autoClassify).toBe(false);
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

describe("Settings → AI — thresholds", () => {
  beforeEach(async () => {
    await NookDB.setMeta(AI_SETTINGS_KEY, {
      autoClassify: true,
      autoTaxonomy: false,
      collectionMinConfidence: 0.9,
      tagMinNoul: 0.65,
      maxTags: 5,
    });
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

    expect((await readAiSettings())?.collectionMinConfidence).toBe(0.95);
    // The tag threshold is its own number: one drag must not move it.
    expect((await readAiSettings())?.tagMinNoul).toBe(0.65);
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

    expect((await readAiSettings())?.maxTags).toBe(6);
  });

  it("still renders a stored value the loader had to clamp", async () => {
    await NookDB.setMeta(AI_SETTINGS_KEY, {
      autoClassify: true,
      autoTaxonomy: true,
      collectionMinConfidence: 7,
      tagMinNoul: -3,
      maxTags: 99,
    });

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

describe("Settings → AI — status", () => {
  it("reports the runner's last run and its counters", async () => {
    await NookDB.setMeta(AI_SETTINGS_KEY, {
      autoClassify: true,
      autoTaxonomy: false,
      collectionMinConfidence: 0.85,
      tagMinNoul: 0.8,
      maxTags: 3,
    });
    await NookDB.setMeta(AI_CURSOR_KEY, {
      processed: 25,
      assigned: 18,
      tagged: 40,
      skipped: 7,
      lastRunAt: "2026-09-20T10:00:00.000Z",
    });

    renderDialog(aiHost());
    clickText("AI");
    await settle();

    expect(hasText("Last run")).toBe(true);
    expect(hasText("Last pass")).toBe(true);
    expect(hasText("18")).toBe(true);
    expect(hasText("7")).toBe(true);
  });

  it("surfaces a stored lastError", async () => {
    await NookDB.setMeta(AI_CURSOR_KEY, {
      processed: 3,
      assigned: 0,
      tagged: 0,
      skipped: 3,
      lastError: "Nook's AI key isn't configured.",
    });

    renderDialog(aiHost());
    clickText("AI");
    await settle();

    expect(hasText("Nook's AI key isn't configured.")).toBe(true);
  });

  it("reports the feature unavailable while the no-AI-key cool-down holds", async () => {
    await NookDB.setMeta(AI_CURSOR_KEY, {
      processed: 0,
      assigned: 0,
      tagged: 0,
      skipped: 0,
      unavailableUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
    });

    renderDialog(aiHost());
    clickText("AI");
    await settle();

    expect(hasText("Unavailable")).toBe(true);
    expect(hasText("Nook's server has no AI key configured")).toBe(true);
  });

  it("reports idle once the cool-off has passed", async () => {
    await NookDB.setMeta(AI_CURSOR_KEY, {
      processed: 0,
      assigned: 0,
      tagged: 0,
      skipped: 0,
      unavailableUntil: new Date(Date.now() - 60_000).toISOString(),
    });

    renderDialog(aiHost());
    clickText("AI");
    await settle();

    expect(hasText("Unavailable")).toBe(false);
  });
});

describe("Settings → AI — suggest taxonomy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the button disabled while the feature is off", async () => {
    await seedLibrary({ taxonomy: false });
    const server = stubProposer(PROPOSALS);

    await renderAiPanel(aiHost());

    expect(isDisabled(buttonFor("Suggest taxonomy"))).toBe(true);
    act(() => buttonFor("Suggest taxonomy").click());
    await settle();
    expect(server.calls).toBe(0);
  });

  it("offers it once the feature is on, and says what it will do", async () => {
    await seedLibrary();
    stubProposer(PROPOSALS);

    await renderAiPanel(aiHost());

    expect(isDisabled(buttonFor("Suggest taxonomy"))).toBe(false);
    expect(hasText("Reads a sample of your unfiled bookmarks")).toBe(true);
  });

  it("shows each proposal with a checkbox, its reason, and ticked by default", async () => {
    await seedLibrary();
    stubProposer(PROPOSALS);

    await renderAiPanel(aiHost());
    act(() => buttonFor("Suggest taxonomy").click());
    await settle();

    // Two collections and one tag, all ticked: "ücretsiz" is not covered by
    // either collection, so it starts on.
    const boxes = reviewCheckboxes();
    expect(boxes).toHaveLength(3);
    expect(boxes.every((box) => box.checked)).toBe(true);
    expect(hasText("Tasarım")).toBe(true);
    expect(hasText("Design systems, type and UI craft.")).toBe(true);
    expect(hasText("Servers, networking and deployment.")).toBe(true);
    expect(hasText("New collections")).toBe(true);
    expect(hasText("New tags")).toBe(true);
    expect(buttonFor("Add 2 collections and 1 tag")).toBeTruthy();
  });

  it("starts a tag unticked when a collection above already covers it", async () => {
    // The proposer names one theme twice — "Açık Kaynak Projeleri" and "açık
    // kaynak" — and from its side those are one observation. The tag is still
    // offered, because a collection is exclusive and a tag is not, but it
    // should not arrive fighting its own collection by default.
    await seedLibrary();
    stubProposer({
      collections: [{ name: "Açık Kaynak Projeleri", why: "Open source work." }],
      tags: [{ name: "açık kaynak" }, { name: "ücretsiz" }],
    });

    await renderAiPanel(aiHost());
    act(() => buttonFor("Suggest taxonomy").click());
    await settle();

    expect(reviewCheckbox("Açık Kaynak Projeleri").checked).toBe(true);
    expect(reviewCheckbox("açık kaynak").checked).toBe(false);
    expect(reviewCheckbox("ücretsiz").checked).toBe(true);
    expect(hasText("A collection above already covers this.")).toBe(true);
    expect(buttonFor("Add 1 collection and 1 tag")).toBeTruthy();
  });

  it("stores an accepted tag so the runner can offer it before it has members", async () => {
    await seedLibrary();
    stubProposer(PROPOSALS);

    await renderAiPanel(aiHost());
    act(() => buttonFor("Suggest taxonomy").click());
    await settle();
    act(() => buttonFor("Add 2 collections and 1 tag").click());
    await settle();

    const record = await readMeta<AcceptedTaxonomy>(AI_TAXONOMY_META_KEY);
    // The point of the whole exercise: a tag with no members is only useful if
    // something will offer it as a question, and `ai.taxonomy.tags` is that.
    expect(record?.tags).toEqual([{ name: "ücretsiz" }]);
  });

  it("does not re-propose a tag the library already uses", async () => {
    await seedLibrary({ tagged: "ücretsiz" });
    stubProposer(PROPOSALS);

    await renderAiPanel(aiHost());
    act(() => buttonFor("Suggest taxonomy").click());
    await settle();
    act(() => buttonFor("Add 2 collections and 1 tag").click());
    await settle();

    const record = await readMeta<AcceptedTaxonomy>(AI_TAXONOMY_META_KEY);
    expect(record?.tags ?? []).toEqual([]);
    // The label reflects only what was actually added.
    expect(buttonFor("Suggest taxonomy")).toBeTruthy();
  });

  it("reviews a tag-only proposal without a collection list", async () => {
    await seedLibrary();
    stubProposer({ collections: [], tags: [{ name: "tasarım sistemleri" }] });

    await renderAiPanel(aiHost());
    act(() => buttonFor("Suggest taxonomy").click());
    await settle();

    expect(hasText("New tags")).toBe(true);
    expect(hasText("New collections")).toBe(false);
    expect(buttonFor("Add 1 tag")).toBeTruthy();
  });

  it("creates the collections and records the taxonomy the runner reads", async () => {
    await seedLibrary();
    stubProposer(PROPOSALS);

    await renderAiPanel(aiHost());
    act(() => buttonFor("Suggest taxonomy").click());
    await settle();
    act(() => buttonFor("Add 2 collections and 1 tag").click());
    await settle();

    const lists = await readLists();
    // Sorted before comparing: the lists store is keyed on a generated id, so
    // its read order is the id order, not the order the proposals came in.
    expect(lists.map((list) => list.name).sort()).toEqual(["Sistem ve Altyapı", "Tasarım"]);

    const record = await readMeta<AcceptedTaxonomy>(AI_TAXONOMY_META_KEY);
    expect(record?.acceptedAt).toBeTruthy();
    expect(record?.collections.map((entry) => entry.name)).toEqual(["Tasarım", "Sistem ve Altyapı"]);
    // Real records, not just names: each one is a collection the user can open,
    // rename or delete, which is what the confirmation has to make clear.
    expect(typeof lists[0]?.id).toBe("string");
    expect(hasText("Added 2 collections.")).toBe(true);
    expect(hasText("1 tag is ready to be used.")).toBe(true);
    expect(hasText("Collections are real — rename or delete them any time.")).toBe(true);
  });

  it("excludes a proposal the user unticked", async () => {
    await seedLibrary();
    stubProposer(PROPOSALS);

    await renderAiPanel(aiHost());
    act(() => buttonFor("Suggest taxonomy").click());
    await settle();

    act(() => reviewCheckbox("Tasarım").click());
    await settle();

    expect(reviewCheckbox("Tasarım").checked).toBe(false);
    expect(buttonFor("Add 1 collection and 1 tag")).toBeTruthy();

    act(() => buttonFor("Add 1 collection and 1 tag").click());
    await settle();

    const lists = await readLists();
    expect(lists.map((list) => list.name)).toEqual(["Sistem ve Altyapı"]);
    const record = await readMeta<AcceptedTaxonomy>(AI_TAXONOMY_META_KEY);
    expect(record?.collections.map((entry) => entry.name)).toEqual(["Sistem ve Altyapı"]);
    // The unticked collection does not take the tag down with it.
    expect(record?.tags).toEqual([{ name: "ücretsiz" }]);
  });

  it("leaves a collection the user already has alone, and says so", async () => {
    await seedLibrary();
    await NookDB.putList({ id: "l1", name: "Tasarım" });
    stubProposer(PROPOSALS);

    await renderAiPanel(aiHost());
    act(() => buttonFor("Suggest taxonomy").click());
    await settle();
    act(() => buttonFor("Add 2 collections and 1 tag").click());
    await settle();

    const lists = await readLists();
    expect(lists.filter((list) => list.name === "Tasarım")).toHaveLength(1);
    expect(lists).toHaveLength(2);
    expect(hasText("Added 1 collection.")).toBe(true);
    expect(hasText("One you already had was left as it is.")).toBe(true);
    expect(hasText("1 tag is ready to be used.")).toBe(true);
  });

  it("reports a server with no AI key as unconfigured, not as a failure", async () => {
    await seedLibrary();
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
    await seedLibrary();
    stubProposer({ collections: [], tags: [] });

    await renderAiPanel(aiHost());
    act(() => buttonFor("Suggest taxonomy").click());
    await settle();

    expect(hasText("Nothing new worth suggesting.")).toBe(true);
    expect(reviewCheckboxes()).toHaveLength(0);
    expect(await readLists()).toHaveLength(0);
  });

  it("asks for a session before it reads anything", async () => {
    await NookDB.setMeta(AI_SETTINGS_KEY, { ...DEFAULT_AI_SETTINGS, autoTaxonomy: true });
    await NookDB.putBookmark({
      id: "b-1",
      source: "web",
      url: "https://example.com/x",
      title: "Tasarım notları ve CSS grid rehberi",
    });
    const server = stubProposer(PROPOSALS);

    await renderAiPanel(aiHost());

    act(() => buttonFor("Suggest taxonomy").click());
    await settle();

    expect(server.calls).toBe(0);
    expect(hasText("Your session has expired.")).toBe(true);
  });

  it("says where it runs when the host has no service worker", async () => {
    await seedLibrary();
    const server = stubProposer(PROPOSALS);

    await renderAiPanelDirectly(webHost());

    expect(isDisabled(buttonFor("Suggest taxonomy"))).toBe(true);
    // The toggle still persists on this origin; the action is what cannot run
    // here, and the button has to say so rather than look broken.
    act(() => buttonFor("Suggest taxonomy").click());
    await settle();
    expect(server.calls).toBe(0);
  });
});

describe("Settings → AI — classify now", () => {
  /**
   * The service worker's end of the channel. The handler is the real one in
   * entrypoints/background/index.ts — this only stands in for the round trip,
   * because a Node test cannot wake a service worker.
   */
  function stubBackground(reply: unknown, lastError?: string) {
    const sent: Array<{ type: string }> = [];
    vi.stubGlobal("chrome", {
      runtime: {
        lastError: lastError ? { message: lastError } : undefined,
        sendMessage: (message: { type: string }, callback: (response: unknown) => void) => {
          sent.push(message);
          callback(reply);
        },
      },
    });
    return sent;
  }

  /** A background that holds the reply until the test releases it. */
  function deferBackground() {
    const sent: Array<{ type: string }> = [];
    let pending: ((response: unknown) => void) | undefined;
    vi.stubGlobal("chrome", {
      runtime: {
        lastError: undefined,
        sendMessage: (message: { type: string }, callback: (response: unknown) => void) => {
          sent.push(message);
          pending = callback;
        },
      },
    });
    return {
      sent,
      release(response: unknown) {
        pending?.(response);
      },
    };
  }

  async function seedClassify(): Promise<void> {
    await NookDB.setMeta(AI_SETTINGS_KEY, { ...DEFAULT_AI_SETTINGS, autoClassify: true });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks the service worker for a pass and reports what it did", async () => {
    await seedClassify();
    const sent = stubBackground({ processed: 25, assigned: 18, tagged: 40, skipped: 7 });

    await renderAiPanel(aiHost());
    act(() => buttonFor("Classify now").click());
    await settle();

    expect(sent).toEqual([{ type: "CLASSIFY_NOW" }]);
    expect(hasText("18 filed, 7 left alone.")).toBe(true);
  });

  it("says so when a pass had nothing to do", async () => {
    await seedClassify();
    stubBackground({ processed: 0, assigned: 0, tagged: 0, skipped: 0 });

    await renderAiPanel(aiHost());
    act(() => buttonFor("Classify now").click());
    await settle();

    expect(hasText("Nothing to classify.")).toBe(true);
  });

  it("surfaces a pass that stopped early, rather than claiming it worked", async () => {
    await seedClassify();
    stubBackground({ processed: 0, assigned: 0, tagged: 0, skipped: 0, error: "Signed out — sign in again to resume classifying." });

    await renderAiPanel(aiHost());
    act(() => buttonFor("Classify now").click());
    await settle();

    expect(hasText("Signed out — sign in again to resume classifying.")).toBe(true);
    expect(hasText("Nothing to classify.")).toBe(false);
  });

  it("reports a service worker that did not answer, and stays clickable", async () => {
    await seedClassify();
    const sent = stubBackground(undefined, "Could not establish connection.");

    await renderAiPanel(aiHost());
    act(() => buttonFor("Classify now").click());
    await settle();

    expect(sent).toEqual([{ type: "CLASSIFY_NOW" }]);
    // The chrome-level detail goes to the console; the panel says what it
    // could not do, the way "Could not start a sync." does in SyncPanel.
    expect(hasText("Could not start a classification pass.")).toBe(true);
    expect(isDisabled(buttonFor("Classify now"))).toBe(false);
  });

  it("is disabled until a feature is on", async () => {
    await NookDB.setMeta(AI_SETTINGS_KEY, { ...DEFAULT_AI_SETTINGS });
    const sent = stubBackground({ processed: 0, assigned: 0, tagged: 0, skipped: 0 });

    await renderAiPanel(aiHost());
    expect(isDisabled(buttonFor("Classify now"))).toBe(true);

    act(() => buttonFor("Classify now").click());
    await settle();
    expect(sent).toEqual([]);
  });

  it("is disabled while a pass is in flight, and again once it lands", async () => {
    await seedClassify();
    const { release } = deferBackground();

    await renderAiPanel(aiHost());
    act(() => buttonFor("Classify now").click());
    await settle();

    // A second click while the first pass is still running must not invite
    // another. The runner would join the run in flight rather than bill it
    // twice, but the control has to say so.
    expect(isDisabled(buttonFor("Classify now"))).toBe(true);

    await settled(async () => release({ processed: 1, assigned: 1, tagged: 0, skipped: 0 }));
    expect(isDisabled(buttonFor("Classify now"))).toBe(false);
  });

  it("is disabled on a host with no service worker to ask", async () => {
    await seedClassify();
    const sent = stubBackground({ processed: 1, assigned: 1, tagged: 0, skipped: 0 });

    await renderAiPanelDirectly(webHost());

    expect(isDisabled(buttonFor("Classify now"))).toBe(true);
    act(() => buttonFor("Classify now").click());
    await settle();
    expect(sent).toEqual([]);
  });
});
