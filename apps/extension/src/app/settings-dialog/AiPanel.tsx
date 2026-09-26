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
import {
  acceptTaxonomy,
  announceAiStatusChange,
  loadAiStatus,
  requestClassificationRun,
  requestTaxonomyProposals,
  subscribeToAiStatus,
  type AiStatus,
  type ProposeOutcome,
  type SummarizeStatus,
  type TagProposal,
  type TaxonomyProposal,
} from "../../../lib/ai-client";
import {
  TAXONOMY_LANGUAGES,
  loadAiSettings,
  saveAiSettings,
  subscribeToAiSettings,
  type AiSettings,
} from "../../../lib/ai-settings";
import { useNookHost, type NookHost } from "../host/NookHost";
import { SettingsCard, SettingsRow } from "./settings-shared";

/**
 * Settings → AI. Three independent features (see `docs/ai.md`): filing new
 * bookmarks into the collections and tags you already have, proposing new ones,
 * and summarising the pages long enough to need it. All are off by default.
 *
 * This panel is host-agnostic, and it now means it. A pass runs on Nook's
 * server, so `host.kind` is not consulted anywhere below: the status rows, the
 * **Run now** button and the whole taxonomy review flow work identically
 * in the extension and in the web app, which is the one thing this panel could
 * not do before. `SettingsDialog.visibleSections` still offers the section only
 * when `host.user` is set — a pass is an authenticated server call, so there is
 * nothing to configure while signed out — and the guard below is a
 * defensive fallback for the one render that can land after a sign-out clears
 * `host.user` but before the dialog switches away from this section.
 */
export function AiPanel() {
  const host = useNookHost();
  const { settings, commit } = useAiSettings();
  const { status, isLoading, refresh } = useAiStatus(settings);

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

      <SummaryCard settings={settings} status={status} commit={commit} />

      <StatusCard host={host} settings={settings} status={status} isLoading={isLoading} onRefresh={refresh} />
    </VStack>
  );
}

/**
 * Async panel work outlives the dialog: a status read or a proposal can land
 * after the user has closed Settings, and a state update then is a wasted
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

/** How often the status is re-read while a queue is draining. Fast enough that
 *  the depth visibly falls, slow enough that watching it is not a request every
 *  second for a batch that takes tens of seconds anyway. */
const STATUS_POLL_MS = 4000;

/**
 * The panel's live view of `GET /api/ai/status`.
 *
 * Refreshed on mount, whenever the settings change (which includes a toggle
 * flipped in this panel — `settings` is a fresh object on every load and every
 * save), on the settings/status subscription, and on demand from the
 * **Run now** button.
 *
 * -- why it polls --
 *
 * A pass is not a request this browser can hold open. `POST /api/ai/run`
 * enqueues the account's eligible work and returns how much it queued; the work
 * happens in a worker on the server, tens of seconds per batch. The panel's
 * only way to show a queue draining is to re-read the depths and the run
 * counters every few seconds, and to stop the moment both are empty — a panel
 * that kept polling an idle account forever would be a background request per
 * panel per interval, for no user benefit. The interval is keyed on the depth
 * rather than being a permanent timer, which is what makes it stop.
 *
 * The timer is a `setInterval` in an effect whose dependency is the depth, so
 * React tears it down on unmount and on every change of depth; and every read
 * checks `useIsMounted` before setting state, so a read already in flight when
 * the dialog closes cannot land on an unmounted component.
 */
function useAiStatus(settings: AiSettings | null): { status: AiStatus | null; isLoading: boolean; refresh(): void } {
  const [status, setStatus] = useState<AiStatus | null>(null);
  // True until the first read answers, so the card can say it is checking
  // rather than claiming a state it has not read yet.
  const [isLoading, setIsLoading] = useState(true);
  const isMounted = useIsMounted();

  const refresh = useCallback(() => {
    void loadAiStatus().then((next) => {
      if (!isMounted()) return;
      setStatus(next);
      setIsLoading(false);
    });
  }, [isMounted]);

  useEffect(() => {
    // The same "nook-db" channel a settings save announces on, so a toggle
    // flipped in another tab — or a run requested there — refreshes the status
    // here without this panel having to poll for it. Its own initial call is
    // this panel's first read, which is why the effect below waits for the
    // settings row rather than issuing a second one on mount.
    return subscribeToAiStatus((next) => {
      if (!isMounted()) return;
      setStatus(next);
      setIsLoading(false);
    });
  }, [isMounted]);

  // Re-read when the account's settings change: turning a feature on is the
  // moment a run is most likely to start, and the dots below are derived from
  // the toggles as well as the server's own state. `settings` is a fresh object
  // on every load and every save and stable in between, so this fires per change
  // rather than per render.
  useEffect(() => {
    if (settings) refresh();
  }, [refresh, settings]);

  // Both queues, because both drain in the same worker: a pass that was
  // summarising while nothing was left to classify still empties rows the panel
  // is showing, and a timer keyed on the classification depth alone would stop
  // re-reading in the middle of it.
  const pending = (status?.pending ?? 0) + (status?.summarize.pending ?? 0);
  useEffect(() => {
    if (pending <= 0) return;
    const timer = setInterval(refresh, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [pending, refresh]);

  return { status, isLoading, refresh };
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
 * Summaries, from the server's own count of what it has done.
 *
 * This card used to count the library here and read a last-pass date off the
 * `ai.summary-run` meta key — a documented seam nothing has ever written
 * (docs/retrieval.md, "Summaries"), so the counting could only produce an
 * upper bound and the date read "Never" forever. The pass that fills summaries
 * in runs on Nook's server now (docs/ai-summarize-contract.md), which is what
 * makes both of these real numbers: `summarised` and `pending` are SQL counts
 * over the account's records with the same length gate the pass applies, so the
 * bound is gone and so is the hedge that used to have to explain it.
 *
 * The toggle's description carries the one thing nothing else in Settings does
 * not: this is the first feature that sends page text to somebody else's model.
 * Filing and taxonomy send titles, hostnames, a short preview and your notes;
 * a summary sends the page. A user flipping this switch is handing their
 * reading history to a third party and has to be able to read that on the
 * switch, not in a doc.
 */
function SummaryCard({
  settings,
  status,
  commit,
}: {
  settings: AiSettings;
  status: AiStatus | null;
  commit(patch: Partial<AiSettings>): void;
}) {
  // Filled by `readSummarizeStatus`, so this is `undefined` only when the read
  // itself never landed — which is a different claim from a status that landed
  // and found no summariser, and the rows below keep the two apart.
  const summarise = status?.summarize;

  return (
    <SettingsCard title="Summaries">
      <SettingsRow
        title="Summarise long pages"
        description="Writes a one- or two-sentence summary, in the page's own language, on bookmarks long enough to need one — and Nook's server works through your library on its own, with the browser closed. This is the one feature that sends page text to a third party: up to 4,000 characters of the page, its title and your note, to whichever AI provider Nook's server is configured with (OpenAI or Google). Filing and taxonomy send only titles, hostnames and a short preview, and you can delete any summary afterwards."
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
        description={summaryCountsDescription(settings.autoSummarize, summarise !== undefined)}
        control={
          summarise ? (
            <HStack gap={2} align="center">
              <Badge label={summarise.summarised} />
              <Text type="supporting" color="secondary">
                with a summary
              </Text>
              <Text type="supporting" color="secondary">
                ·
              </Text>
              <Badge label={summarise.pending} />
              <Text type="supporting" color="secondary">
                waiting
              </Text>
            </HStack>
          ) : (
            <Text color="secondary">—</Text>
          )
        }
      />
      <SettingsRow
        title="Last summary pass"
        description={summariseStateNote(summarise)}
        control={
          summarise?.lastRunAt ? (
            <Text color="secondary">
              <Timestamp value={summarise.lastRunAt} format="relative" isLive />
            </Text>
          ) : (
            // "Never" is a claim about the account's history, so it is only
            // printed when there was a status to say it from — the same rule the
            // classification row in the status card follows.
            <Text color="secondary">{summarise ? "Never" : "—"}</Text>
          )
        }
      />
    </SettingsCard>
  );
}

/**
 * What the two counts mean, which depends on the toggle.
 *
 * `pending` is the server's own candidate count, and the top-up that fills it is
 * gated on `autoSummarize` so a queue can never report work that cannot drain —
 * so while the feature is off it is zero however many pages are eligible, and
 * "nothing left to do" would be a claim about a queue nobody filled. With it on,
 * both numbers are the account's: the local count this replaced could only ever
 * produce an upper bound, because it counted every record with no summary
 * including the ones the 400-character gate would never accept, which is what
 * this sentence used to have to admit.
 */
function summaryCountsDescription(isOn: boolean, hasStatus: boolean): string | undefined {
  if (!hasStatus) return undefined;
  return isOn
    ? "Nook's server counts these, so they are the account's real numbers rather than a guess. Bookmarks no longer than the preview in your library are left alone — there is nothing to add to what the row already shows."
    : "Nothing is being summarised while this is off, so the waiting count is zero however many of your pages would qualify. Turn it on and Nook's server starts a pass on its own.";
}

/**
 * Why the last pass is not producing summaries, on the row a user reads to find
 * out when one last ran.
 *
 * The server's own error wins, because it is the specific thing that happened.
 * Failing that, the missing-deploy sentence — the same words the status card's
 * summarisation dot is drawing underneath, because two rows disagreeing about
 * why a pass is not running would be this panel contradicting itself.
 */
function summariseStateNote(summarise: SummarizeStatus | undefined): string | undefined {
  if (!summarise) return undefined;
  if (summarise.lastError) return summarise.lastError;
  if (!canSummarise(summarise)) return NO_SUMMARISER;
  return undefined;
}

type AiStatusId = "off" | "idle" | "unavailable" | "error";

/** A missing summariser is a deploy, exactly as a missing classification key
 *  is, and every row that has to say it says it in these words. */
const NO_SUMMARISER =
  "Nook's server has no summariser configured, so nothing is being summarised — that is a server setup thing, not a setting you can change here.";

/** A read that never landed is not a state the server reported, and both passes
 *  get the same sentence: this panel has been told nothing about either
 *  deployment, so it cannot claim a key is missing. */
const NO_STATUS = "Nook's server isn't answering, so there is no status to report. Anything you turn on above still applies.";

/** The back-off window is the one thing a dot cannot carry: the queue is
 *  non-empty, the pass is on, and the server is waiting out an upstream failure.
 *  Without this the row would read "Idle" over a pass that is not going to run
 *  for a while. */
const BACKING_OFF = "Nook's server is waiting out a temporary failure, so the next pass runs a little later.";

const STATUS_META: Record<AiStatusId, { label: string; variant: StatusDotVariant }> = {
  off: { label: "Off", variant: "neutral" },
  idle: { label: "Idle", variant: "success" },
  // The server answers 503 when TYPESAFE_API_KEY is unset, and reports
  // `available: false` / `run.isUnavailable` for the same thing. That is a
  // deploy away, not something the user can fix here, so it is a state to
  // report rather than an error to raise.
  unavailable: { label: "Unavailable", variant: "warning" },
  error: { label: "Needs attention", variant: "error" },
};

const STATUS_DESCRIPTION: Record<AiStatusId, string | undefined> = {
  off: "Turn filing on above and Nook's server starts working through your library.",
  idle: undefined,
  unavailable: "Nook's server has no AI key configured, so nothing is being classified.",
  error: undefined,
};

/**
 * The same four states, said in the summarisation pass's own terms. A separate
 * record rather than a parameterised one because the two are different
 * deployments: classification needs `TYPESAFE_API_KEY`, summarising needs the
 * proposer `NOOK_AI_PROPOSER` names, and either can be configured without the
 * other. A fifth state would have nothing to say that these two sentences do
 * not.
 */
const SUMMARISE_STATUS_DESCRIPTION: Record<AiStatusId, string | undefined> = {
  off: "Turn summarising on and Nook's server starts a pass over the pages long enough to need one.",
  idle: undefined,
  unavailable: NO_SUMMARISER,
  error: undefined,
};

/**
 * Which of the four states a pass is in, from its own half of the status read.
 *
 * Shared because "unavailable" has to mean the same thing in both rows: a
 * missing key is a deploy rather than something the user did, and two rows
 * disagreeing about it would be the panel contradicting itself.
 */
function passStatusId(canRun: boolean, lastError: string | null, isOn: boolean): AiStatusId {
  if (lastError) return "error";
  if (!canRun) return "unavailable";
  return isOn ? "idle" : "off";
}

/**
 * Whether a pass can run at all right now, per pass — which is why these take
 * the half they need rather than the whole status. `available` and the pass's own
 * cool-down are the same fact from two sides: the server can summarise at all,
 * and the server is currently not. Either one is enough to say so.
 */
function canClassify(status: AiStatus | null): boolean {
  return status ? status.available && !status.run.isUnavailable : false;
}

function canSummarise(summarise: SummarizeStatus): boolean {
  return summarise.available && !summarise.isUnavailable;
}

/** The summarisation row's sentence: the state sentence, plus the one case a
 *  state cannot express. */
function summariseStatusDescription(summarise: SummarizeStatus | undefined, id: AiStatusId): string | undefined {
  if (!summarise) return NO_STATUS;
  // A missing summariser is the bigger fact and wins: a server that cannot
  // summarise has nothing to back off from.
  if (id === "unavailable") return NO_SUMMARISER;
  if (summarise.isBackingOff && !summarise.lastError) return BACKING_OFF;
  return SUMMARISE_STATUS_DESCRIPTION[id];
}

/**
 * A dot and the label that carries its meaning, which is the only place colour
 * is allowed to be a state.
 *
 * `isChecking` is the one state that is this panel's own rather than the
 * server's: before the first read answers, claiming "Idle" or "Off" would be a
 * status nobody observed, and "Unavailable" would be a deployment claim about a
 * server that may be perfectly healthy. `isBusy` is the pulse's other job — a
 * pass with a queue behind it, which is the only live signal the summarisation
 * row has, its depth being a badge in the card above.
 */
function StatusMark({ id, isChecking, isBusy = false }: { id: AiStatusId; isChecking: boolean; isBusy?: boolean }) {
  const meta = STATUS_META[id];
  return (
    <HStack gap={2} align="center">
      {isChecking ? (
        <>
          <StatusDot variant="neutral" label="Checking" isPulsing />
          <Text color="secondary">Checking…</Text>
        </>
      ) : (
        <>
          <StatusDot variant={meta.variant} label={meta.label} isPulsing={isBusy} />
          <Text color="secondary">{meta.label}</Text>
        </>
      )}
    </HStack>
  );
}

/**
 * The whole status surface, from one server read.
 *
 * These rows used to read the `ai.cursor` meta record the extension's runner
 * wrote, which is why they were hidden on the web host: a key that only one
 * host ever wrote is exactly the thing a confidently wrong "Never" next to a
 * feature the connected extension may be running comes from. The numbers are
 * the account's now, so both hosts render the same rows, and **Run now** asks
 * the same server the extension's service worker used to ask.
 *
 * One row per pass, because a pass is a thing that can be on, unconfigured or
 * broken on its own: they need different keys, they queue into different
 * depths, and the run button covers both. The two rows are otherwise the same
 * four states, drawn from the same helpers.
 */
function StatusCard({
  host,
  settings,
  status,
  isLoading,
  onRefresh,
}: {
  host: NookHost;
  settings: AiSettings;
  status: AiStatus | null;
  isLoading: boolean;
  onRefresh(): void;
}) {
  const toast = useToast();
  const isMounted = useIsMounted();
  const [isQueuing, setIsQueuing] = useState(false);
  const run = status?.run;
  const summarise = status?.summarize;
  // Each row's own toggle, not "any feature": taxonomy has no pass and no
  // queue, so letting it light up a classification dot would be a claim about
  // work the route never does.
  const classifyId = passStatusId(canClassify(status), run?.lastError ?? null, settings.autoClassify);
  const summariseId = passStatusId(summarise ? canSummarise(summarise) : false, summarise?.lastError ?? null, settings.autoSummarize);
  const statusDescription = run ? STATUS_DESCRIPTION[classifyId] : NO_STATUS;
  const passes = queuedPasses(settings);
  // The run is an authenticated server call like every other route here, so the
  // button carries a sign-in reason the way **Suggest taxonomy** does. Unreachable
  // while the panel is mounted, because the guard at the top of AiPanel switches
  // to the sign-in banner first, and kept for the one render that can race it.
  const isSignedIn = Boolean(host.user);

  /**
   * A pass on demand, for both features the route covers. Without it the only
   * way to get either one is to wait out the server's own schedule, and there is
   * no way at all to find out whether the save you just made has been filed.
   *
   * This can only *enqueue*, and the copy below says exactly that. The route
   * deliberately does not run a batch inline — 25 classify calls take tens of
   * seconds, which is not something to hold an HTTP request open for — so the
   * honest report is how much went onto each queue and that the server is
   * working through it. A toast claiming "18 filed" here would be a guess.
   */
  const queueRun = async () => {
    setIsQueuing(true);
    try {
      const result = await requestClassificationRun();
      // Read the status again straight away: the queue depth is the one thing
      // that proves the call did something, and the run's own counters will not
      // move until the server's worker gets to the batch.
      onRefresh();
      if (!isMounted()) return;
      toast({
        body: result === null ? "Could not queue a pass." : runQueuedBody(result.queued, result.summariesQueued),
        ...(result === null ? { type: "error" as const } : {}),
      });
    } catch (error) {
      // `requestClassificationRun` is not supposed to throw (see
      // lib/ai-client.ts); this is the guard that keeps a future break from
      // becoming an unhandled rejection in a click handler.
      console.error("[Nook] Could not queue an AI pass:", error);
      if (isMounted()) toast({ body: "Could not queue a pass.", type: "error" });
    } finally {
      if (isMounted()) setIsQueuing(false);
    }
  };

  return (
    <SettingsCard title="Status">
      <SettingsRow
        title="Classification"
        description={statusDescription}
        control={<StatusMark id={classifyId} isChecking={isLoading && !run} />}
      />
      {/*
        The second pass, on the same four states. Its queue gets the pulse on
        this dot rather than a row of its own: the depth is already a badge in
        the Summaries card, and a second "Waiting to be…" row would repeat it.
      */}
      <SettingsRow
        title="Summarisation"
        description={summariseStatusDescription(summarise, summariseId)}
        control={<StatusMark id={summariseId} isChecking={isLoading && !summarise} isBusy={(summarise?.pending ?? 0) > 0} />}
      />
      {/*
        Named for the pass they describe. "Last run" and "Last pass" were
        unambiguous while there was one status row; with a summarisation row
        above them they would read as that pass's history, which they are not —
        the summary's own are in the Summaries card.
      */}
      <SettingsRow
        title="Last classification run"
        control={
          run?.lastRunAt ? (
            <Text color="secondary">
              <Timestamp value={run.lastRunAt} format="relative" isLive />
            </Text>
          ) : (
            // "Never" is a claim about the account's history, so it is only
            // printed when there was a status to say it from.
            <Text color="secondary">{run ? "Never" : "—"}</Text>
          )
        }
      />
      {/*
        The counter the doc cares about: a feature under-firing on non-English
        content shows up here as a small "filed" beside a large "skipped",
        rather than as a silent mislabel. `processed` and `tagged` stay out —
        the run's decision log (`AiRunSummary.log`) keeps the per-decision detail
        this row is a summary of.
      */}
      <SettingsRow
        title="Last classification pass"
        description={run ? (run.lastError ?? "Bookmarks filed and left alone since the last pass.") : undefined}
        control={
          run ? (
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
          ) : (
            <Text color="secondary">—</Text>
          )
        }
      />
      {/*
        Only while there is something to wait for. This row is also what tells
        the user the poll above is doing its job: a queue that is draining is
        the whole reason the status is re-read every few seconds.
      */}
      {status && status.pending > 0 ? (
        <SettingsRow
          title="Waiting to be classified"
          description="Nook's server is working through these now. This panel refreshes until the queue is empty."
          control={
            <HStack gap={2} align="center">
              <StatusDot variant="accent" label="Classifying" isPulsing />
              <Badge label={status.pending} />
            </HStack>
          }
        />
      ) : null}
      <SettingsRow
        title="Queue a pass now"
        description="Starts a pass without waiting for Nook's server's next tick. The work happens there rather than in this browser, so the rows above fill in as it goes."
        control={
          <Button
            label="Run now"
            variant="secondary"
            size="sm"
            isLoading={isQueuing}
            isDisabled={isQueuing || !isSignedIn || passes.length === 0}
            tooltip={runTooltip(passes, isSignedIn, isQueuing)}
            onClick={() => void queueRun()}
          />
        }
      />
    </SettingsCard>
  );
}

/**
 * The passes one click of **Run now** would queue. `POST /api/ai/run` gates each
 * half on its own toggle, so a user with only `autoSummarize` on gets summaries
 * queued and nothing else — which is why the button's copy names them rather
 * than saying "run everything", and why the count of them is also what disables
 * it.
 */
function queuedPasses(settings: AiSettings): string[] {
  const passes: string[] = [];
  if (settings.autoClassify) passes.push("your unfiled bookmarks for classification");
  if (settings.autoSummarize) passes.push("the pages long enough to need a summary");
  return passes;
}

/** Why the button cannot be pressed, or what pressing it would do. Every branch
 *  is a reason a click cannot queue anything, except the last, which is the
 *  promise the click does keep. */
function runTooltip(passes: string[], isSignedIn: boolean, isQueuing: boolean): string {
  if (!isSignedIn) return "Sign in to queue a pass.";
  if (passes.length === 0) return "Turn on “File new bookmarks” or “Summarise long pages” first.";
  if (isQueuing) return "Nook's server is queueing the pass now.";
  return `Queues ${passes.join(" and ")}. Nook's server works through them in the background.`;
}

/**
 * The toast for a queued pass, and the rule it has to keep: a queue depth is not
 * a pass result. Each half is reported only when that half queued something, so
 * a user with one toggle on is never told about work the route did not queue for
 * them, and the sentence never claims anything was filed or written.
 */
function runQueuedBody(queued: number, summariesQueued: number): string {
  const parts: string[] = [];
  if (queued > 0) parts.push(`${queued} ${queued === 1 ? "bookmark" : "bookmarks"} to classify`);
  if (summariesQueued > 0) parts.push(`${summariesQueued} ${summariesQueued === 1 ? "page" : "pages"} to summarise`);
  if (parts.length === 0) return "Nothing to classify or summarise.";
  return `Queued ${parts.join(" and ")}. Nook's server is working through them now.`;
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
 * names the user keeps into real collections plus the taxonomy in force
 * (docs/ai.md, "Taxonomy growth").
 *
 * Everything the client used to own is the server's now. The sample is drawn
 * from the account's own records, so this sends no library and holds no
 * `Bookmark[]`; acceptance sends names only, and the server reads the account's
 * existing lists, its own tags and the sample digests from the same store it
 * classifies against.
 *
 * States are reported where they happen rather than collected into one error
 * field, because the ways this can go wrong need different sentences: a stale
 * session, a server with no AI key, a throttled server, and a model that
 * declined — and the last one is not a failure at all. "Nothing new worth
 * suggesting" is this route's version of `__none__`.
 */
type SuggestPhase = "idle" | "reading" | "review" | "accepting" | "done";

interface SuggestState {
  phase: SuggestPhase;
  /** The proposals as the server sent them, in its order. */
  proposals: TaxonomyProposal[];
  /** The names still ticked. Default-checked, and the user may take any away. */
  accepted: string[];
  /** Tag proposals in the server's order. */
  tags: TagProposal[];
  /**
   * The user's own decision per tag name, and only for the tags they actually
   * touched. A tag with no entry here takes its value from `coveredBy` every
   * render, which is what keeps the default live.
   */
  tagChoice: Record<string, boolean>;
  /** How many of the user's own bookmarks the proposal was drawn from. */
  sampleSize: number;
  /** Collections the account already has, so the review can say so. */
  existingCollections: string[];
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
  tagChoice: {},
  sampleSize: 0,
  existingCollections: [],
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
  // A session and the toggle are the whole gate: the route is authenticated,
  // and the feature ships off by default. A request already in flight is a
  // third reason, so a second click cannot pay for a second call.
  const isBusy = isReading || isAccepting;
  const isOff = !enabled || !host.user;

  /**
   * Whether a tag's checkbox is ticked, right now.
   *
   * A decision the user made by hand wins; otherwise the answer is "is a
   * collection you are still accepting already covered this". The server says
   * which collections those are (`coveredBy`), so this is not a stem comparison
   * this panel has to re-derive — and it stays *live*, which is the point:
   * unticking "Açık Kaynak Projeleri" re-ticks "açık kaynak", because from then
   * on the tag is the only one left carrying the theme. A tag the user ticked or
   * unticked themselves is pinned either way, so this cannot undo their call.
   */
  const isTagTicked = (tag: TagProposal): boolean => state.tagChoice[tag.name] ?? !isCoveredBy(tag, state.accepted);
  const tickedTags = state.tags.filter(isTagTicked);

  /**
   * The collections just changed, so every tag the user has *not* ruled on has
   * to be re-defaulted against them; the ones they did are left alone.
   */
  const acceptCollections = (values: string[]) =>
    setState((previous) => {
      const tagChoice = { ...previous.tagChoice };
      for (const tag of previous.tags) {
        const settled = previous.tagChoice[tag.name];
        if (settled === undefined) continue;
        if (isCoveredBy(tag, values)) delete tagChoice[tag.name];
      }
      return { ...previous, accepted: values, tagChoice };
    });

  /** Records only the tags whose value this click actually changed, so a click
   *  on one tag does not silently pin the other nineteen. */
  const acceptTags = (values: string[]) =>
    setState((previous) => {
      const tagChoice = { ...previous.tagChoice };
      for (const tag of previous.tags) {
        const wasTicked = previous.tagChoice[tag.name] ?? !isCoveredBy(tag, previous.accepted);
        if (wasTicked === values.includes(tag.name)) delete tagChoice[tag.name];
        else tagChoice[tag.name] = values.includes(tag.name);
      }
      return { ...previous, tagChoice };
    });
  const ask = async () => {
    setState({ ...IDLE_STATE, phase: "reading" });
    let outcome: ProposeOutcome;
    try {
      outcome = await requestTaxonomyProposals({ apiUrl: host.apiUrl, language });
    } catch (error) {
      // `requestTaxonomyProposals` answers with a value rather than rejecting
      // (see lib/ai-client.ts); this is the guard that keeps a future break
      // from becoming an unhandled rejection in a click handler.
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
      // No tag is pre-decided here, so every one of them takes its value from
      // `coveredBy`: a tag one of these very collections already speaks for
      // starts unticked. The proposer names a theme once and proposes it twice —
      // "Açık Kaynak Projeleri" and "açık kaynak" — and that is one
      // observation, not two. The tag is still offered, because a collection is
      // exclusive and a tag is not, but it does not arrive fighting its own
      // collection by default. A tag with no `coveredBy` (a server build that
      // predates the field) is covered by nothing, so it starts ticked.
      tagChoice: {},
      sampleSize: outcome.sampleSize,
      existingCollections: outcome.existingCollections,
      note: null,
    });
  };

  const accept = async () => {
    const collections = state.proposals.filter((proposal) => state.accepted.includes(proposal.name)).map((proposal) => proposal.name);
    // The definition rides along with the name. Everything else does not: the
    // sample, the live collections and the library's own tags are all read from
    // the account's records on the server at acceptance time, so a collection
    // created in another tab a second ago cannot be duplicated and a tag the
    // library already carries is not re-proposed. A tag's definition is the one
    // thing the server cannot know — the proposer wrote it, this list is the only
    // place it still exists, and it is the sole evidence a member-less tag gets
    // when it is first offered to the model (docs/ai.md: 12 of 12 vocabulary
    // entries put to use with definitions, against 10 of 12 without).
    const tags = tickedTags.map((tag) => ({ name: tag.name, ...(tag.why ? { definition: tag.why } : {}) }));
    if (collections.length === 0 && tags.length === 0) return;
    setState((previous) => ({ ...previous, phase: "accepting" }));
    try {
      const result = await acceptTaxonomy({ collections, tags });
      if (result.kind !== "accepted") {
        if (!isMounted()) return;
        setState((previous) => ({ ...previous, phase: "review" }));
        toast({ body: requestFailureNote(result).text, type: "error" });
        return;
      }
      const { createdCollections, addedTags, dropped } = result;
      toast({ body: summariseAccepted(createdCollections, addedTags) });
      if (!isMounted()) return;
      // Acceptance changed the account's taxonomy, so the status surface (which
      // reports it) is now stale on every host.
      announceAiStatusChange();
      setState({ ...IDLE_STATE, phase: "done", note: acceptedNote(createdCollections, addedTags, dropped) });
    } catch (error) {
      console.error("[Nook] Could not create the suggested taxonomy:", error);
      if (isMounted()) setState((previous) => ({ ...previous, phase: "review" }));
      toast({ body: "Could not create those collections or tags.", type: "error" });
    }
  };

  const disabledReason = !host.user
    ? "Sign in to ask for suggestions."
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
            tooltip={disabledReason ?? "Nook's server reads a sample of your unfiled bookmarks and proposes collection names and tags for it."}
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
            Nook's server is reading a sample of your unfiled bookmarks, spread across your whole library…
          </Text>
        </HStack>
      ) : null}

      {isReviewing ? (
        <VStack gap={2} width="100%">
          {state.proposals.length > 0 ? (
            <CheckboxList
              label="New collections"
              description={collectionsReviewDescription(state.sampleSize, state.existingCollections)}
              hasDividers
              width="100%"
              value={state.accepted}
              onChange={acceptCollections}
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
              value={tickedTags.map((tag) => tag.name)}
              onChange={acceptTags}
            >
              {state.tags.map((tag) => (
                <CheckboxListItem
                  key={tag.name}
                  value={tag.name}
                  label={tag.name}
                  description={isCoveredBy(tag, state.accepted) ? "A collection above already covers this." : tag.why}
                />
              ))}
            </CheckboxList>
          ) : null}
          <HStack justify="end" gap={2}>
            <Button
              label={acceptLabel(state.accepted.length, tickedTags.length)}
              variant="primary"
              size="sm"
              isLoading={isAccepting}
              isDisabled={state.accepted.length === 0 && tickedTags.length === 0}
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

/** A tag counts as covered only by a collection that is still on the accept
 *  list, so unticking a covering collection hands the theme back to the tag.
 *  A tag with no `coveredBy` — a server build that predates the field — is
 *  covered by nothing and therefore starts ticked. */
function isCoveredBy(tag: TagProposal, acceptedNames: string[]): boolean {
  return tag.coveredBy.some((name) => acceptedNames.includes(name));
}

/** What the review list can honestly say about the evidence behind it: the
 *  server's own count of the bookmarks it read, and the collections it already
 *  knows about, so a name that collides is visible here rather than silently
 *  dropped at acceptance. */
function collectionsReviewDescription(sampleSize: number, existingCollections: string[]): string {
  const read = sampleSize === 1 ? "Nook read 1 of your unfiled bookmarks." : `Nook read ${sampleSize} of your unfiled bookmarks.`;
  if (existingCollections.length === 0) return `${read} Untick anything you would rather not have.`;
  return `${read} You already have ${existingCollections.join(", ")} — a name that matches one of those is left as it is.`;
}

function noteLabel(variant: StatusDotVariant): string {
  if (variant === "error") return "Failed";
  if (variant === "warning") return "Unavailable";
  if (variant === "success") return "Done";
  return "Nothing to do";
}

/**
 * One sentence per outcome, and the one the calibration pushed hardest on: an
 * empty list is a legitimate answer, not a failure — so it is reported apart
 * from the four that are, because each of those needs the user to do something
 * and this one needs them to wait.
 */
function outcomeNote(outcome: ProposeOutcome): SuggestNote {
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
      // The server's own sample, not this browser's library: it decides what it
      // has to read, and a sample of nothing is what it says when it has
      // nothing eligible.
      return { variant: "neutral", text: "There is nothing unfiled to read yet. Save a few bookmarks and try again." };
    case "signed-out":
    case "unavailable":
    case "throttled":
    case "failed":
      return requestFailureNote(outcome);
  }
}

/** The four failures the two server-calling features share, so **Suggest
 *  taxonomy** and the acceptance step cannot drift into telling the same state
 *  two different ways. */
function requestFailureNote(outcome: { kind: "signed-out" | "unavailable" | "throttled" | "failed"; message?: string }): SuggestNote {
  switch (outcome.kind) {
    case "signed-out":
      return { variant: "warning", text: "Your session has expired. Sign in again and try again." };
    case "unavailable":
      return {
        variant: "warning",
        text: "Nook's server has no AI key configured, so it can't do this. Nothing is wrong with your library.",
      };
    case "throttled":
      return { variant: "warning", text: "The server is rate limiting Nook. Try again in a minute or so." };
    case "failed":
      return { variant: "error", text: outcome.message ?? "Something went wrong." };
  }
}

/**
 * The one irreversible-feeling step in this feature, so it says plainly what was
 * created: these are ordinary collections, on every device this account syncs
 * to, and the user can rename or delete any of them like any other.
 */
function acceptedNote(collections: number, tags: number, dropped: number): SuggestNote {
  if (collections === 0 && tags === 0) {
    return {
      variant: "warning",
      text: "Nothing was added — every suggestion was something you already had.",
    };
  }
  const created = collections === 0 ? "" : `Added ${collections === 1 ? "1 collection" : `${collections} collections`}.`;
  const vocabulary = tags === 0
    ? ""
    : ` ${tags === 1 ? "1 tag is" : `${tags} tags are`} ready to be used.`;
  const kept = dropped === 0
    ? ""
    : ` ${dropped === 1 ? "One you already had was" : `${dropped} you already had were`} left as it is.`;
  return {
    variant: "success",
    text: `${created}${kept}${vocabulary} Collections are real — rename or delete them any time.`.trim(),
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
