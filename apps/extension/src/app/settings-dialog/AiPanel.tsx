import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxList, CheckboxListItem } from "@astryxdesign/core/CheckboxList";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Slider } from "@astryxdesign/core/Slider";
import { StatusDot, type StatusDotVariant } from "@astryxdesign/core/StatusDot";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { useToast } from "@astryxdesign/core/Toast";
import { AI_BATCH_SIZE, AI_CURSOR_META_KEY, type AiCursor, type AiRunResult } from "../../../lib/ai-runner";
import {
  TAXONOMY_LANGUAGES,
  loadAiSettings,
  saveAiSettings,
  subscribeToAiSettings,
  type AiSettings,
} from "../../../lib/ai-settings";
import {
  TAXONOMY_SAMPLE_SIZE,
  acceptProposals,
  isTagCoveredByCollection,
  requestProposals,
  type ProposalOutcome,
  type TagProposal,
  type TaxonomyProposal,
} from "../../../lib/ai-taxonomy";
import * as NookDB from "../../../lib/db";
import type { Bookmark, PopupToBackgroundMessage } from "../../../lib/types";
import { useNookHost, type NookHost } from "../host/NookHost";
import { SettingsCard, SettingsRow } from "./settings-shared";

/**
 * Settings → AI. Two independent features (see `docs/ai.md`): filing new
 * bookmarks into the collections and tags you already have, and proposing new
 * ones. Both are off by default.
 *
 * The settings this panel edits are an account preference (`GET`/`PUT
 * /api/ai/settings`), not a per-browser one, so the panel itself is the same
 * on both hosts. `SettingsDialog.visibleSections` only offers this section
 * when `host.user` is set — a classification is always an authenticated
 * server call, so there is nothing to configure while signed out — and the
 * guard below is a defensive fallback for the one render that can land after
 * a sign-out clears `host.user` but before the dialog switches away from this
 * section. What *does* still depend on the host is where a pass actually
 * runs: see `RUNS_IN_EXTENSION` and `StatusCard`.
 */
export function AiPanel() {
  const host = useNookHost();
  const { settings, commit } = useAiSettings();
  const { run, reload } = useAiRunSummary(settings);

  if (!host.user) return <SignInRequired host={host} />;

  if (!settings) {
    return (
      <VStack padding={4}>
        <Text color="secondary">Loading AI settings…</Text>
      </VStack>
    );
  }

  return (
    <VStack gap={4}>
      <SettingsCard title="Features">
        <SettingsRow
          title="File new bookmarks into collections"
          description="Places every new bookmark into one of your existing collections and adds your existing tags. Anything Nook isn't confident about is left exactly as you saved it."
          control={
            <Switch
              label="File new bookmarks into collections"
              isLabelHidden
              value={settings.autoClassify}
              onChange={(checked) => commit({ autoClassify: checked })}
            />
          }
        />
        <SettingsRow
          title="Suggest new categories and tags"
          description="Reads a sample of your unfiled bookmarks and proposes collection names and tags for the themes it finds. Nothing is created until you review it."
          control={
            <Switch
              label="Suggest new categories and tags"
              isLabelHidden
              value={settings.autoTaxonomy}
              onChange={(checked) => commit({ autoTaxonomy: checked })}
            />
          }
          detail={<SuggestTaxonomyAction host={host} enabled={settings.autoTaxonomy} language={settings.taxonomyLanguage} />}
        />
      </SettingsCard>

      {settings.autoClassify ? <ThresholdCard settings={settings} commit={commit} /> : null}

      <SummaryCard settings={settings} commit={commit} />

      <StatusCard settings={settings} run={run} onRun={reload} />
    </VStack>
  );
}

/**
 * Actually running a pass is still extension-only, even though the settings
 * that gate it now apply everywhere — the panel says so rather than offering a
 * control that quietly does nothing.
 *
 * The reasons are not stylistic. A pass is the service worker's 5-minute alarm
 * and the single-flight-guarded `runClassification()` behind it, and there is no
 * service worker on the web origin. `ai.taxonomy` (the accepted taxonomy's
 * sample titles, read only by that runner) and the run counters `StatusCard`
 * shows are still per-origin IndexedDB `meta` for the same reason — nothing
 * about them is a user-facing *setting*, so moving them server-side would add a
 * sync path for state that only one host ever reads. A taxonomy accepted from
 * the web would therefore never reach the classifier that reads it — while the
 * collections it creates *would* sync, and would arrive everywhere with no
 * evidence of what belongs in them, which is the part of the digest the
 * measurements in docs/ai-calibration.md say is worth 8.7 points of top-1.
 */
const RUNS_IN_EXTENSION = "Runs in the Nook browser extension, where classification runs.";

/**
 * Async panel work outlives the dialog: a proposal or a classification pass can
 * land after the user has closed Settings, and a state update then is a wasted
 * render at best.
 */
function useIsMounted(): () => boolean {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useCallback(() => mounted.current, []);
}

/**
 * `settings` is `null` until `ai.settings` has been read. `commit` patches the
 * stored value; the loader normalises whatever comes back, so a row can't put
 * an out-of-range number into the store.
 */
function useAiSettings(): { settings: AiSettings | null; commit(patch: Partial<AiSettings>): void } {
  const toast = useToast();
  const [settings, setSettings] = useState<AiSettings | null>(null);
  // A read or a save can resolve after the panel is gone, so both check this
  // before touching state.
  const isMounted = useIsMounted();

  useEffect(() => {
    // Another extension context can save settings while the panel is open, so
    // the subscription — not just the initial load — keeps the rows honest.
    void loadAiSettings().then((loaded) => {
      if (isMounted()) setSettings(loaded);
    });
    return subscribeToAiSettings((next) => {
      if (isMounted()) setSettings(next);
    });
  }, [isMounted]);

  const commit = useCallback(
    (patch: Partial<AiSettings>) => {
      // `saveAiSettings` returns what it stored, so a row updates from its own
      // write instead of waiting for the subscription to echo it back.
      void saveAiSettings(patch).then(
        (saved) => {
          if (isMounted()) setSettings(saved);
        },
        (error: unknown) => {
          console.error("[Nook] Failed to save AI settings:", error);
          // `saveAiSettings` reports a failed write rather than pretending, so
          // say so — a toggle that silently snaps back looks broken.
          toast({ body: "Could not save AI settings.", type: "error" });
        },
      );
    },
    [isMounted, toast],
  );

  return { settings, commit };
}

type ThresholdPatch = Partial<Pick<AiSettings, "collectionMinConfidence" | "tagMinNoul" | "maxTags" | "taxonomyLanguage">>;

/** A stepper, not a free number — a bookmark rarely wants more than a handful. */
// Matches the loader's own clamp (MAX_TAGS_LIMIT in lib/ai-settings.ts) so a
// hand-edited or out-of-date stored value cannot render above the stepper's
// maximum, which would leave a control that reports a number it cannot reach.
const MAX_TAGS_MIN = 0;
const MAX_TAGS_MAX = 10;

function ThresholdCard({ settings, commit }: { settings: AiSettings; commit(patch: ThresholdPatch): void }) {
  // A slider fires `onChange` on every step of a drag; only `onChangeEnd` is a
  // decision. Keep the dragged value here so the thumb follows the pointer, and
  // write to IndexedDB once the drag ends — otherwise a drag across the track
  // is a dozen writes.
  const [draft, setDraft] = useState<ThresholdPatch>({});
  const collection = draft.collectionMinConfidence ?? settings.collectionMinConfidence;
  const tags = draft.tagMinNoul ?? settings.tagMinNoul;

  // Turning the feature off unmounts the sliders, so nothing left in `draft`
  // can be written back when it comes back on.
  useEffect(() => setDraft({}), [settings.autoClassify]);

  const draftSlider = (key: "collectionMinConfidence" | "tagMinNoul") => (value: number) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };
  const commitSlider = (key: "collectionMinConfidence" | "tagMinNoul") => (value: number) => {
    setDraft({});
    commit({ [key]: value });
  };

  return (
    <SettingsCard title="Thresholds">
      <SettingsRow
        title="Collection confidence"
        description="How sure Nook must be about the collection before it files a bookmark there. Higher means fewer, more reliable assignments; below it, nothing is changed."
        control={
          <Slider
            label="Collection confidence"
            isLabelHidden
            width={200}
            min={0}
            max={1}
            step={0.05}
            value={collection}
            onChange={draftSlider("collectionMinConfidence")}
            onChangeEnd={commitSlider("collectionMinConfidence")}
            valueDisplay="text"
            formatValue={formatConfidence}
          />
        }
      />
      <SettingsRow
        title="Tag confidence"
        description="How sure Nook must be before it adds a tag. Tuned separately from the collection number: it is a different question, so neither threshold carries over to the other."
        control={
          <Slider
            label="Tag confidence"
            isLabelHidden
            width={200}
            min={0}
            max={1}
            step={0.05}
            value={tags}
            onChange={draftSlider("tagMinNoul")}
            onChangeEnd={commitSlider("tagMinNoul")}
            valueDisplay="text"
            formatValue={formatConfidence}
          />
        }
      />
      <SettingsRow
        title="Max tags"
        description="How many tags a bookmark can pick up at most, best-scoring first. Keep it low if you like your tags sparse."
        control={
          // A stepper only reports a settled value (a click, Enter, or blur), so
          // unlike the sliders it needs no draft — and none of the wheel-scroll
          // surprises, because the panel itself scrolls.
          <NumberInput
            label="Max tags"
            isLabelHidden
            size="sm"
            width={200}
            value={settings.maxTags}
            min={MAX_TAGS_MIN}
            max={MAX_TAGS_MAX}
            step={1}
            isIntegerOnly
            hasNumberSteppers
            isWheelEnabled={false}
            onChange={(value) => commit({ maxTags: value })}
          />
        }
      />

      {/*
        Only meaningful with the taxonomy feature on, for the same reason the
        thresholds are: a preference about names has nothing to act on until
        something asks for them.
      */}
      {settings.autoTaxonomy ? (
        <SettingsRow
          title="Name new things in"
          description="Which language suggested collections and tags are written in."
          control={
            <Selector
              label="Language"
              isLabelHidden
              size="sm"
              width={200}
              value={settings.taxonomyLanguage}
              // `options` is data, not JSX children: Astryx's own guidance is
              // to pass SelectorOption through here and keep renderOption for
              // custom rows.
              options={TAXONOMY_LANGUAGES.map((entry) => ({ value: entry.value, label: entry.label }))}
              onChange={(value) => commit({ taxonomyLanguage: value as AiSettings["taxonomyLanguage"] })}
            />
          }
        />
      ) : null}
    </SettingsCard>
  );
}

/** Two decimals, so a dragged 0.9 reads as the 0.90 the default is stored as. */
function formatConfidence(value: number): string {
  return value.toFixed(2);
}

/**
 * Summaries: one toggle and what the library currently holds, per
 * docs/retrieval.md, "Summaries".
 *
 * Read-only status on purpose, and the copy says so. A summary is prose the
 * model wrote and stored on the bookmark, so the number worth showing a user is
 * how many of their bookmarks have one — not how many requests were made.
 *
 * "Outstanding" is an upper bound rather than a to-do count, and the row says
 * that: the length gate that decides what is worth summarising lives in
 * apps/api/src/summarize.ts, so the panel can only count what has none. On a
 * library that is mostly X posts that number is nearly the whole library, and
 * calling it a queue would be a promise Nook has no way to keep.
 */
function SummaryCard({ settings, commit }: { settings: AiSettings; commit(patch: Partial<AiSettings>): void }) {
  const host = useNookHost();
  const { counts, run } = useSummaryState();

  return (
    <SettingsCard title="Summaries">
      <SettingsRow
        title="Summarise long pages"
        description="Writes a short summary on bookmarks whose page is longer than the preview in your library. Short posts and X threads are left alone — there is nothing to add to what you can already read. The summary is the model's words, not yours, and you can delete it like any other note."
        control={
          <Switch
            label="Summarise long pages"
            isLabelHidden
            value={settings.autoSummarize}
            onChange={(checked) => commit({ autoSummarize: checked })}
          />
        }
      />
      <SettingsRow
        title="In your library"
        description={summaryStatusDescription(counts, Boolean(host.user), run.lastRunAt)}
        control={
          counts ? (
            <HStack gap={2} align="center">
              <Badge label={counts.summarised} />
              <Text type="supporting" color="secondary">
                summarised
              </Text>
              <Text type="supporting" color="secondary">
                ·
              </Text>
              <Badge label={counts.outstanding} />
              <Text type="supporting" color="secondary">
                none yet
              </Text>
            </HStack>
          ) : (
            <Text type="supporting" color="secondary">
              Counting…
            </Text>
          )
        }
      />
      <SettingsRow
        title="Last summary pass"
        description={run.lastError ?? undefined}
        control={
          run.lastRunAt ? (
            <Text color="secondary">
              <Timestamp value={run.lastRunAt} format="relative" isLive />
            </Text>
          ) : (
            <Text color="secondary">{counts ? "Never" : "Checking…"}</Text>
          )
        }
      />
    </SettingsCard>
  );
}

/**
 * SEAM — the pass that fills summaries in is not written yet.
 *
 * The server half is (apps/api/src/summarize.ts, which reads `nook_records` and
 * returns summaries without writing them), and this card is the half that reads
 * them back. What is missing is the middle: the service-worker alarm, the batch
 * loop, and the client-side write of each returned summary onto its bookmark
 * through NookDB.updateBookmark — which is the write that has to happen here
 * rather than on the server, so that the summary goes out through the normal
 * sync path and lands on every device.
 *
 * `ai.summary-run` is where that pass's cursor goes. It is named after
 * AI_CURSOR_META_KEY so both features' run records sit together in `meta` and
 * are read the same way, and it is read here now — before anything writes it —
 * so the shape of the record is settled while the panel that has to render it
 * is in front of us. Until then "Last summary pass" reads Never, which is the
 * truth, and the status row above says a pass has not run rather than letting a
 * freshly-flipped toggle look like it did something.
 */
const SUMMARY_RUN_META_KEY = "ai.summary-run";

interface SummaryRun {
  /** ISO of the last run that got past its cool-downs, as in `ai.cursor`. */
  lastRunAt?: string;
  /**
   * Set when a pass stopped early or a request failed, as in `ai.cursor`.
   *
   * Deliberately no counters: how many bookmarks carry a summary is answered
   * better by counting the library, which cannot drift from what the user
   * actually has. This record only has to answer "did a pass run, and did it
   * fail".
   */
  lastError?: string;
}

/** What the panel reads back, with every field filled in — the same discipline
 *  as `readRunSummary` and `AiRunSummary` below, and the reason nothing here
 *  has to null-check a stored value. */
interface SummaryRunSummary {
  lastRunAt: string | null;
  lastError: string | null;
}

/** A record from a future or hand-edited build may be missing anything at all,
 *  so nothing here is trusted. Mirrors `readRunSummary` below. */
function readSummaryRun(stored: unknown): SummaryRunSummary {
  const record = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  return {
    lastRunAt: typeof record.lastRunAt === "string" ? record.lastRunAt : null,
    lastError: typeof record.lastError === "string" ? record.lastError : null,
  };
}

/** The only two numbers the panel can honestly produce, both from the local
 *  library. `null` means the read has not answered, which is why every surface
 *  below has a "not yet" state rather than a zero it would be inventing. */
interface SummaryCounts {
  /** Live bookmarks carrying a non-empty `summary`. */
  summarised: number;
  /** Live bookmarks without one. An upper bound, not a queue — see SummaryCard. */
  outstanding: number;
}

interface SummaryState {
  counts: SummaryCounts | null;
  run: SummaryRunSummary;
}

const NO_SUMMARY_RUN: SummaryRunSummary = {
  lastRunAt: null,
  lastError: null,
};

/**
 * Reads the library and the run record once, when the panel mounts.
 *
 * Mount is the granularity here rather than a shortcut: the settings dialog
 * mounts this panel fresh every time it is opened, so the counts are never
 * older than the dialog the user is looking at. What it does not cover is a pass
 * landing while the dialog stays open — the row would keep reporting the counts
 * it read. The fix is to join the "nook-db" channel, which is the same
 * subscription `subscribeToAiSettings` already opens; it is not worth adding
 * before the pass exists, since nothing writes the run record to notice.
 *
 * `getAllBookmarks` excludes soft-deleted rows already, which is the population
 * that matters — a tombstone's summary is not something a user is missing.
 */
function useSummaryState(): SummaryState {
  const [state, setState] = useState<SummaryState>({ counts: null, run: NO_SUMMARY_RUN });
  useEffect(() => {
    let active = true;
    void Promise.all([NookDB.getAllBookmarks(), NookDB.getMeta<SummaryRun>(SUMMARY_RUN_META_KEY)]).then(
      ([bookmarks, stored]) => {
        if (!active) return;
        const summarised = bookmarks.filter((bookmark) => typeof bookmark.summary === "string" && bookmark.summary !== "").length;
        setState({ counts: { summarised, outstanding: bookmarks.length - summarised }, run: readSummaryRun(stored) });
      },
    );
    return () => {
      active = false;
    };
  }, []);
  return state;
}

/** One sentence per state, and each is a different fact rather than a shorter
 *  version of the same one. */
function summaryStatusDescription(
  counts: SummaryCounts | null,
  isSignedIn: boolean,
  lastRunAt: string | null,
): string {
  if (!isSignedIn) {
    return "Summaries are written by Nook's server, so a pass needs a signed-in account. Until you sign in, nothing is summarised.";
  }
  if (!counts) return "Counting the bookmarks that already have a summary.";
  if (lastRunAt === null) {
    return "No summary pass has run yet, so the toggle changes nothing on its own. Nook summarises a page only where it is longer than the preview, so many of the rest never need one.";
  }
  return `${counts.outstanding} bookmarks have no summary. Nook only summarises a page that is longer than the preview, so some of them never will.`;
}

type AiStatusId = "off" | "idle" | "unavailable" | "error";

const STATUS_META: Record<AiStatusId, { label: string; variant: StatusDotVariant }> = {
  off: { label: "Off", variant: "neutral" },
  idle: { label: "Idle", variant: "success" },
  // The server answers 503 when TYPESAFE_API_KEY is unset, and the runner
  // cools off for an hour. That is a deploy away, not something the user can
  // fix here, so it is a state to report rather than an error to raise.
  unavailable: { label: "Unavailable", variant: "warning" },
  error: { label: "Needs attention", variant: "error" },
};

const STATUS_DESCRIPTION: Record<AiStatusId, string | undefined> = {
  off: "Turn a feature on and Nook starts working through your library.",
  idle: undefined,
  unavailable: "Nook's server has no AI key configured, so nothing is being classified.",
  error: undefined,
};

function StatusCard({ settings, run, onRun }: { settings: AiSettings; run: AiRunSummary; onRun(): void }) {
  const host = useNookHost();
  const toast = useToast();
  const isMounted = useIsMounted();
  const [isRunning, setIsRunning] = useState(false);
  const isOn = settings.autoClassify || settings.autoTaxonomy;
  const status: AiStatusId = run.lastError
    ? "error"
    : run.isUnavailable
      ? "unavailable"
      : isOn
        ? "idle"
        : "off";
  const meta = STATUS_META[status];

  /**
   * A pass on demand. Without it the only way to classify is to wait out the
   * 5-minute alarm, and there is no way at all to find out whether the save you
   * just made has been filed yet — the counters below only move when a pass has
   * happened, so a user watching them has no idea whether to wait or to look
   * elsewhere.
   *
   * The work is the runner's, not the panel's: `CLASSIFY_NOW` asks the service
   * worker to call the same `runClassification()` the alarm calls. That matters
   * twice over — the pass needs the session and the batch loop the worker has,
   * and `runClassification()` is single-flight-guarded, so a double-click
   * joins the run already in flight instead of paying for the same batch twice.
   */
  const classifyNow = async () => {
    setIsRunning(true);
    try {
      const result = await sendClassifyNow();
      // The runner wrote `ai.cursor`; re-read it so the row below reports the
      // pass that just happened rather than the one before it.
      onRun();
      if (!isMounted()) return;
      if (result.error) {
        toast({ body: result.error, type: "error" });
      } else {
        toast({
          body: result.processed === 0
            ? "Nothing to classify."
            : `${result.assigned} filed, ${result.skipped} left alone.`,
        });
      }
    } catch (error) {
      console.error("[Nook] Manual AI classification failed:", error);
      if (isMounted()) toast({ body: "Could not start a classification pass.", type: "error" });
    } finally {
      if (isMounted()) setIsRunning(false);
    }
  };

  return (
    <SettingsCard title="Status">
      <SettingsRow
        title="Classification"
        description={STATUS_DESCRIPTION[status]}
        control={
          <HStack gap={2} align="center">
            <StatusDot variant={meta.variant} label={meta.label} />
            <Text color="secondary">{meta.label}</Text>
            <Button
              label="Classify now"
              variant="secondary"
              size="sm"
              isLoading={isRunning}
              isDisabled={isRunning || !isOn || host.kind !== "extension"}
              tooltip={
                host.kind !== "extension"
                  ? RUNS_IN_EXTENSION
                  : !isOn
                    ? "Turn on a feature above first."
                    : `Work through up to ${AI_BATCH_SIZE} unfiled bookmarks now, instead of waiting for the next pass.`
              }
              onClick={() => void classifyNow()}
            />
          </HStack>
        }
      />
      {/*
        `run` comes from `ai.cursor`, a per-origin IndexedDB `meta` key the
        extension's runner writes after every tick (lib/ai-runner.ts) — it is
        run *history*, not a setting, so it was never moved server-side (see
        the comment on RUNS_IN_EXTENSION above). On the web host that key is
        simply never written, so showing it here would render "Never" and
        "0 filed, 0 skipped" next to a feature the connected extension may be
        actively running — degrade to a pointer at the real numbers instead of
        a confidently wrong zero.
      */}
      {host.kind === "extension" ? (
        <>
          <SettingsRow
            title="Last run"
            control={
              run.lastRunAt ? (
                <Text color="secondary">
                  <Timestamp value={run.lastRunAt} format="relative" isLive />
                </Text>
              ) : (
                <Text color="secondary">Never</Text>
              )
            }
          />
          {/*
            The counter the doc cares about: a feature under-firing on non-English
            content shows up here as a small "filed" beside a large "skipped",
            rather than as a silent mislabel. `processed` and `tagged` stay out —
            `ai.log` keeps the per-decision detail this row is a summary of.
          */}
          <SettingsRow
            title="Last pass"
            description={run.lastError ?? "Bookmarks filed and left alone since the last pass."}
            control={
              <HStack gap={2} align="center">
                <Badge label={run.assigned} />
                <Text type="supporting" color="secondary">
                  filed
                </Text>
                <Text type="supporting" color="secondary">
                  ·
                </Text>
                <Badge label={run.skipped} />
                <Text type="supporting" color="secondary">
                  skipped
                </Text>
              </HStack>
            }
          />
        </>
      ) : (
        <SettingsRow
          title="Run history"
          description="Classification runs in the Nook browser extension's background service worker. These toggles apply there as soon as it's connected to this account — open Settings → AI in the extension to see when it last ran and what it filed."
        />
      )}
    </SettingsCard>
  );
}

function SignInRequired({ host }: { host: NookHost }) {
  return (
    <Banner
      status="info"
      title="Sign in to use AI classification"
      description="Classifying a bookmark is a call to Nook's servers, so it needs a signed-in account. Nothing is filed until you turn a feature on."
      endContent={
        // The extension has somewhere to send you; the web app doesn't.
        host.kind === "extension" && host.openWebApp ? (
          <Button label="Sign in" variant="primary" size="sm" onClick={() => host.openWebApp?.("/?connect=extension")} />
        ) : null
      }
    />
  );
}

/**
 * "Suggest taxonomy" — the whole feature-2 flow in one row: ask the server what
 * to call the themes in this library, show the answer for review, and turn the
 * names the user keeps into real collections plus the record the runner reads
 * (docs/ai.md, "Taxonomy growth").
 *
 * States are reported where they happen rather than collected into one error
 * field, because the four ways this can go wrong need four different sentences:
 * a stale session, a server with no AI key, a throttled server, and a model that
 * declined — and the last one is not a failure at all. `__none__` is a valid
 * answer on the classify route, and "nothing new worth suggesting" is this
 * route's version of it: the proposer's job includes declining.
 */
type SuggestPhase = "idle" | "reading" | "review" | "accepting" | "done";

interface SuggestState {
  phase: SuggestPhase;
  /** The proposals as the server sent them, in its order. */
  proposals: TaxonomyProposal[];
  /** The names still ticked. Default-checked, and the user may take any away. */
  accepted: string[];
  /** Tag names the proposer suggested, in its order. */
  tags: TagProposal[];
  /** The tag names still ticked. */
  acceptedTags: string[];
  /** The sample the proposal came from; the acceptance step needs its titles. */
  sample: Bookmark[];
  note: SuggestNote | null;
}

/** What happened, in the panel's own vocabulary: a state dot and one sentence. */
interface SuggestNote {
  variant: StatusDotVariant;
  text: string;
}

const IDLE_STATE: SuggestState = {
  phase: "idle",
  proposals: [],
  accepted: [],
  tags: [],
  acceptedTags: [],
  sample: [],
  note: null,
};

function SuggestTaxonomyAction({
  host,
  enabled,
  language,
}: {
  host: NookHost;
  enabled: boolean;
  language: AiSettings["taxonomyLanguage"];
}) {
  const toast = useToast();
  const isMounted = useIsMounted();
  const [state, setState] = useState<SuggestState>(IDLE_STATE);

  const isReading = state.phase === "reading";
  const isReviewing = state.phase === "review" || state.phase === "accepting";
  const isAccepting = state.phase === "accepting";
  // A session and the toggle are the whole gate: both server routes are
  // authenticated, and the feature ships off by default. A proposal already in
  // flight is a third reason, so a second click cannot pay for a second call.
  const isBusy = isReading || isAccepting;
  const isOff = !enabled || !host.user || host.kind !== "extension";

  const ask = async () => {
    setState({ ...IDLE_STATE, phase: "reading" });
    let outcome: ProposalOutcome;
    try {
      outcome = await requestProposals({ apiUrl: host.apiUrl, language });
    } catch (error) {
      console.error("[Nook] Taxonomy proposal failed:", error);
      outcome = { kind: "failed", message: "Could not read your library to ask for suggestions." };
    }
    if (!isMounted()) return;
    // A proposer that names no themes is declining, not broken, so a run that
    // found collections but no tags still opens a review — an empty tag list is
    // simply omitted from it.
    if (outcome.kind !== "proposals" || (outcome.proposals.length === 0 && outcome.tags.length === 0)) {
      setState({ ...IDLE_STATE, note: outcomeNote(outcome) });
      return;
    }
    const names = outcome.proposals.map((proposal) => proposal.name);
    setState({
      phase: "review",
      // Default-checked: the model was given a sample of what the user actually
      // saved, so the proposals are the review's starting point rather than a
      // suggestion the user has to opt into one at a time.
      proposals: outcome.proposals,
      accepted: names,
      tags: outcome.tags,
      // Except a tag that one of these very collections already speaks for. The
      // proposer names a theme once and proposes it twice — "Açık Kaynak
      // Projeleri" and "açık kaynak" — and that is one observation, not two. The
      // tag is still offered, because a collection is exclusive and a tag is
      // not, but it starts unticked rather than fighting its own collection by
      // default.
      acceptedTags: outcome.tags
        .filter((tag) => !isTagCoveredByCollection(tag.name, names))
        .map((tag) => tag.name),
      sample: outcome.sample,
      note: null,
    });
  };

  const accept = async () => {
    const chosen = state.proposals.filter((proposal) => state.accepted.includes(proposal.name));
    const chosenTags = state.tags.filter((tag) => state.acceptedTags.includes(tag.name));
    if (chosen.length === 0 && chosenTags.length === 0) return;
    setState((previous) => ({ ...previous, phase: "accepting" }));
    try {
      // Re-read the live collections rather than trusting the ones this panel
      // was mounted with: a collection can be renamed or created in another tab
      // between the proposal and the confirmation.
      const existing = await NookDB.getAllLists();
      // Likewise the library's own tags, so an accepted vocabulary never
      // re-proposes a tag the user already has.
      const existingTags = (await NookDB.getAllBookmarks()).flatMap((bookmark) =>
        Array.isArray(bookmark.tags) ? bookmark.tags : [],
      );
      const result = await acceptProposals({
        proposals: chosen,
        samples: state.sample,
        existing,
        tags: chosenTags,
        existingTags,
      });
      const added = result.created.length;
      const tagged = result.addedTags.length;
      toast({ body: summariseAccepted(added, tagged) });
      if (!isMounted()) return;
      setState({ ...IDLE_STATE, phase: "done", note: acceptedNote(added, tagged, result.dropped.length) });
    } catch (error) {
      console.error("[Nook] Could not create the suggested taxonomy:", error);
      if (isMounted()) setState((previous) => ({ ...previous, phase: "review" }));
      toast({ body: "Could not create those collections or tags.", type: "error" });
    }
  };

  const disabledReason = !host.user
    ? "Sign in to ask for suggestions."
    : host.kind !== "extension"
      ? RUNS_IN_EXTENSION
      : !enabled
        ? "Turn on “Suggest new categories and tags” first."
        : undefined;

  return (
    <VStack gap={2} width="100%">
      <HStack justify="end">
        {isReviewing ? (
          <Button label="Cancel" variant="ghost" size="sm" onClick={() => setState(IDLE_STATE)} />
        ) : (
          <Button
            label="Suggest taxonomy"
            variant="secondary"
            size="sm"
            isLoading={isReading}
            isDisabled={isOff || isBusy}
            tooltip={disabledReason ?? "Reads a sample of your unfiled bookmarks and proposes collection names and tags for it."}
            onClick={() => void ask()}
          />
        )}
      </HStack>

      {isReading ? (
        // A pending state, not a progress bar: the call is one request with no
        // progress to report, and a spinner that implies a percentage would be
        // inventing information the client does not have.
        <HStack gap={2} align="center">
          <StatusDot variant="accent" label="Reading your library" isPulsing />
          <Text type="supporting" color="secondary">
            Reading up to {TAXONOMY_SAMPLE_SIZE} unfiled bookmarks, spread across your whole library…
          </Text>
        </HStack>
      ) : null}

      {isReviewing ? (
        <VStack gap={2} width="100%">
          {state.proposals.length > 0 ? (
            <CheckboxList
              label="New collections"
              description={`Nook read ${state.sample.length} of your unfiled bookmarks. Untick anything you would rather not have.`}
              hasDividers
              width="100%"
              value={state.accepted}
              onChange={(values) => setState((previous) => ({ ...previous, accepted: values }))}
            >
              {state.proposals.map((proposal) => (
                <CheckboxListItem
                  key={proposal.name}
                  value={proposal.name}
                  label={proposal.name}
                  description={proposal.why}
                />
              ))}
            </CheckboxList>
          ) : null}
          {state.tags.length > 0 ? (
            <CheckboxList
              label="New tags"
              description="Nook will start tagging new bookmarks with these. They begin empty and earn their first use the usual way — from something it is confident about."
              hasDividers
              width="100%"
              value={state.acceptedTags}
              onChange={(values) => setState((previous) => ({ ...previous, acceptedTags: values }))}
            >
              {state.tags.map((tag) => (
                <CheckboxListItem
                  key={tag.name}
                  value={tag.name}
                  label={tag.name}
                  description={
                    isTagCoveredByCollection(tag.name, state.accepted)
                      ? "A collection above already covers this."
                      : tag.why
                  }
                />
              ))}
            </CheckboxList>
          ) : null}
          <HStack justify="end" gap={2}>
            <Button
              label={acceptLabel(state.accepted.length, state.acceptedTags.length)}
              variant="primary"
              size="sm"
              isLoading={isAccepting}
              isDisabled={state.accepted.length === 0 && state.acceptedTags.length === 0}
              onClick={() => void accept()}
            />
          </HStack>
        </VStack>
      ) : null}

      {state.note ? (
        <HStack gap={2} align="start">
          <StatusDot variant={state.note.variant} label={noteLabel(state.note.variant)} />
          <Text type="supporting" color="secondary">
            {state.note.text}
          </Text>
        </HStack>
      ) : null}
    </VStack>
  );
}

function noteLabel(variant: StatusDotVariant): string {
  if (variant === "error") return "Failed";
  if (variant === "warning") return "Unavailable";
  if (variant === "success") return "Done";
  return "Nothing to do";
}

/**
 * One sentence per outcome, and the two the calibration pushed hardest on:
 * an empty list is a legitimate answer, and a name the user already has is
 * dropped rather than duplicated.
 */
function outcomeNote(outcome: ProposalOutcome): SuggestNote | null {
  switch (outcome.kind) {
    case "proposals":
      // The server answers 200 with empty arrays both when the model declined
      // and when no proposer is configured for it (apps/api/src/ai.ts), so the
      // client cannot tell those apart and must not pretend to.
      return {
        variant: "neutral",
        text: "Nothing new worth suggesting. The server also answers this way when no proposer is configured for it.",
      };
    case "nothing-to-read":
      return { variant: "neutral", text: "There is nothing unfiled to read yet. Save a few bookmarks and try again." };
    case "signed-out":
      return { variant: "warning", text: "Your session has expired. Sign in again to ask for suggestions." };
    case "unavailable":
      return {
        variant: "warning",
        text: "Nook's server has no AI key configured, so it can't propose anything. Nothing is wrong with your library.",
      };
    case "throttled":
      return { variant: "warning", text: "The server is rate limiting Nook. Try again in a minute or so." };
    case "failed":
      return { variant: "error", text: outcome.message };
  }
}

/**
 * The one irreversible-feeling step in this feature, so it says plainly what was
 * created: these are ordinary collections, on this device and every synced one,
 * and the user can rename or delete any of them like any other.
 */
function acceptedNote(added: number, tags: number, dropped: number): SuggestNote {
  if (added === 0 && tags === 0) {
    return {
      variant: "warning",
      text: "Nothing was added — every suggestion was something you already had.",
    };
  }
  const collections = added === 0 ? "" : `Added ${added === 1 ? "1 collection" : `${added} collections`}.`;
  const vocabulary = tags === 0
    ? ""
    : ` ${tags === 1 ? "1 tag is" : `${tags} tags are`} ready to be used.`;
  const kept = dropped === 0
    ? ""
    : ` ${dropped === 1 ? "One you already had was" : `${dropped} you already had were`} left as it is.`;
  return {
    variant: "success",
    text: `${collections}${kept}${vocabulary} Collections are real — rename or delete them any time.`.trim(),
  };
}

/** "Add 3 collections and 4 tags", and the tag-only case, which is a real
 *  outcome: a proposer can name themes without naming any collections. */
function acceptLabel(collections: number, tags: number): string {
  const collectionsLabel = collections === 1 ? "1 collection" : `${collections} collections`;
  const tagsLabel = tags === 1 ? "1 tag" : `${tags} tags`;
  if (collections === 0) return `Add ${tagsLabel}`;
  if (tags === 0) return `Add ${collectionsLabel}`;
  return `Add ${collectionsLabel} and ${tagsLabel}`;
}

function summariseAccepted(collections: number, tags: number): string {
  if (collections === 0 && tags === 0) return "Nothing new was added.";
  const collectionsLabel = collections === 1 ? "1 collection" : `${collections} collections`;
  const tagsLabel = tags === 1 ? "1 tag" : `${tags} tags`;
  if (collections === 0) return `${tagsLabel} ready to use.`;
  if (tags === 0) return `${collectionsLabel} added.`;
  return `${collectionsLabel} and ${tagsLabel} added.`;
}

/**
 * What the background pass did last time: the counters, last run and cool-down
 * fields of the runner's `ai.cursor` record, with "nothing yet" filled in. The
 * panel only reads that record; the pass itself is the service worker's.
 */
interface AiRunSummary {
  assigned: number;
  skipped: number;
  lastRunAt: string | null;
  lastError: string | null;
  /** True while the runner's no-AI-key cool-down is still in effect. */
  isUnavailable: boolean;
}

const EMPTY_RUN: AiRunSummary = {
  assigned: 0,
  skipped: 0,
  lastRunAt: null,
  lastError: null,
  isUnavailable: false,
};

function isFuture(iso: string | undefined): boolean {
  if (iso == null) return false;
  const until = new Date(iso).getTime();
  return Number.isFinite(until) && until > Date.now();
}

/** A record from an older build may be missing counters, so fill rather than trust. */
function readRunSummary(cursor: AiCursor | undefined): AiRunSummary {
  return {
    assigned: cursor?.assigned ?? 0,
    skipped: cursor?.skipped ?? 0,
    lastRunAt: cursor?.lastRunAt ?? null,
    lastError: cursor?.lastError ?? null,
    isUnavailable: isFuture(cursor?.unavailableUntil),
  };
}

/**
 * The summary refreshes whenever the settings do: turning a feature on is the
 * moment a run is most likely to start, and the runner exposes no subscription
 * the panel could join. `reload` is the same read on demand, for the "Classify
 * now" button — a pass writes `ai.cursor` and nothing announces it.
 */
function useAiRunSummary(settings: AiSettings | null): { run: AiRunSummary; reload(): void } {
  const [run, setRun] = useState<AiRunSummary>(EMPTY_RUN);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let active = true;
    void NookDB.getMeta<AiCursor>(AI_CURSOR_META_KEY).then((cursor) => {
      if (active) setRun(readRunSummary(cursor));
    });
    return () => {
      active = false;
    };
  }, [settings, nonce]);
  const reload = useCallback(() => setNonce((previous) => previous + 1), []);
  return { run, reload };
}

/**
 * Asks the service worker for a pass, and gets the run itself back.
 *
 * `runClassification()` never rejects (see lib/ai-runner.ts), so a delivered
 * reply *is* the result — there is no separate success flag to check. The two
 * ways this can fail are chrome's: a message with no listener behind it (the
 * worker was torn down and did not wake) and a throw from the channel itself.
 * Both arrive as chrome.runtime.lastError rather than as exceptions, so they are
 * turned into one rejection here instead of being checked by hand at each call.
 */
function sendClassifyNow(): Promise<AiRunResult> {
  return new Promise((resolve, reject) => {
    try {
      const message: PopupToBackgroundMessage = { type: "CLASSIFY_NOW" };
      chrome.runtime.sendMessage(message, (response: AiRunResult) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message || "Nook's background service did not respond."));
          return;
        }
        if (response === undefined) {
          reject(new Error("Nook's background service did not respond."));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
