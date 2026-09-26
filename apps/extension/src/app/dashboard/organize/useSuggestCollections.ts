import { useState } from "react";
import { useToast } from "@astryxdesign/core/Toast";
import type { StatusDotVariant } from "@astryxdesign/core/StatusDot";
import {
  acceptTaxonomy,
  announceAiStatusChange,
  requestClassificationRun,
  requestTaxonomyProposals,
  type AiStatus,
  type ProposeOutcome,
  type TagProposal,
  type TaxonomyProposal,
} from "../../../../lib/ai-client";
import type { AiSettings } from "../../../../lib/ai-settings";
import { useI18n } from "../../../i18n";
import { useNookHost } from "../../host/NookHost";
import { type TFunction, useIsMounted } from "../../settings-dialog/ai/shared";

/**
 * "Suggest tags": ask the server what to call the themes in this library,
 * show the answer for review, and turn the tags the user keeps into the tag
 * vocabulary in force (docs/ai.md, "Taxonomy growth").
 *
 * This used to be the Organize page's *primary* action — the same state
 * machine that used to live in Settings
 * (`settings-dialog/ai/SuggestCollections.tsx`, now deleted) — but naming new
 * collections is `useSuggestClusters.ts`'s job now (the group-suggestion flow
 * that replaced it): `POST /api/ai/clusters/propose` already knows which
 * bookmarks a group means, where this route only ever named a theme and left
 * the classifier to later decide bookmark-by-bookmark whether it applied.
 * This hook survives as the "Suggest tags" secondary action — same route,
 * same phases (`idle` → `reading` → `review` → `accepting` → `done`), but
 * `tagsOnly: true` (the only thing `OrganizePage.tsx`'s caller sets) drops
 * whatever collections the proposer named alongside the tags before they
 * ever reach state, so there is nothing left to review or accept but tags:
 * offering a second, redundant way to create collections would just be
 * confusing next to the group-suggestion flow above it.
 *
 * One behavioural addition on top of the old component survives unconditionally:
 * accepting also makes sure `autoClassify` is on and immediately queues a
 * filing pass (`requestClassificationRun`), instead of leaving the user to
 * find and click a second button. `onAccepted` lets the page re-read the
 * status right away so the "working" progress view shows up without waiting
 * for the next poll.
 *
 * The sample is drawn from the account's own unfiled bookmarks, so this sends
 * no library and holds no `Bookmark[]`; acceptance sends names only, and the
 * server reads the account's existing lists, its own tags and the sample from
 * the same store it classifies against.
 *
 * Every user-visible string is under the `ai.suggest` (plus shared
 * `ai.errors`/`ai.status`) keys — see `src/i18n/locales/en/ai.ts`.
 */

function statusLine(t: TFunction, status: AiStatus | null): string {
  if (!status) return "";
  const { taxonomy } = status;
  if (!taxonomy.acceptedAt) return t("ai.suggest.notAskedYet");
  const collections = taxonomy.collections.length;
  const tags = taxonomy.tags.length;
  if (collections === 0 && tags === 0) return t("ai.suggest.acceptedNoneActive");
  return t("ai.suggest.acceptedSummary", { parts: countParts(t, collections, tags) });
}

/** "{n} collection(s)" and "{m} tag(s)", joined with a translated "and" — the
 *  one place a two-count sentence is built, shared by the status line, the
 *  accept button's label and both post-accept messages. */
export function countParts(t: TFunction, collections: number, tags: number): string {
  const parts: string[] = [];
  if (collections > 0) parts.push(t("ai.suggest.collectionsCount", { count: collections }));
  if (tags > 0) parts.push(t("ai.suggest.tagsCount", { count: tags }));
  return parts.join(` ${t("ai.suggest.and")} `);
}

export type SuggestPhase = "idle" | "reading" | "review" | "accepting" | "done";

export interface SuggestState {
  phase: SuggestPhase;
  proposals: TaxonomyProposal[];
  /** The names still ticked. Default-checked, and the user may take any away. */
  accepted: string[];
  tags: TagProposal[];
  /**
   * The user's own decision per tag name, and only for the tags they actually
   * touched. A tag with no entry here takes its value from `coveredBy` every
   * render, which is what keeps the default live.
   */
  tagChoice: Record<string, boolean>;
  sampleSize: number;
  existingCollections: string[];
  note: SuggestNote | null;
  /** Set once accept() has turned filing on as a side effect — the page shows
   *  this once, right after acceptance, then it's just an ordinary setting. */
  autoFileJustEnabled: boolean;
}

export interface SuggestNote {
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
  autoFileJustEnabled: false,
};

export interface UseSuggestCollectionsParams {
  status: AiStatus | null;
  settings: AiSettings;
  commit(patch: Partial<AiSettings>): void;
  /** Called right after a successful accept (and the filing pass it queues),
   *  so the caller can re-read `GET /api/ai/status` immediately. */
  onAccepted?(): void;
  /** True for the Organize page's "Suggest tags" secondary action — the only
   *  caller left. Whatever collection names the proposer returns alongside
   *  the tags are dropped before they reach `state`, so `SuggestionReview`'s
   *  "New collections" list never renders and `accept()` sends `collections: []`
   *  without either of them needing to know why. */
  tagsOnly?: boolean;
}

export interface UseSuggestCollections {
  state: SuggestState;
  isReading: boolean;
  isReviewing: boolean;
  isAccepting: boolean;
  isBusy: boolean;
  disabledReason: string | undefined;
  tickedTags: TagProposal[];
  statusLine: string;
  acceptCollections(values: string[]): void;
  acceptTags(values: string[]): void;
  ask(): void;
  accept(): void;
  cancel(): void;
}

export function useSuggestCollections({
  status,
  settings,
  commit,
  onAccepted,
  tagsOnly = false,
}: UseSuggestCollectionsParams): UseSuggestCollections {
  const { t } = useI18n();
  const host = useNookHost();
  const toast = useToast();
  const isMounted = useIsMounted();
  const [state, setState] = useState<SuggestState>(IDLE_STATE);

  const isReading = state.phase === "reading";
  const isReviewing = state.phase === "review" || state.phase === "accepting";
  const isAccepting = state.phase === "accepting";
  const isBusy = isReading || isAccepting;
  // The propose route needs no toggle of its own on the server — see
  // `outageKind` in settings-dialog/ai/shared for why
  // `status.summarize.available` is the right signal for it — so asking is
  // gated on a session and the deployment being configured, nothing else.
  const proposerUnavailable = status !== null && !status.summarize.available;

  const isTagTicked = (tag: TagProposal): boolean => state.tagChoice[tag.name] ?? !isCoveredBy(tag, state.accepted);
  const tickedTags = state.tags.filter(isTagTicked);

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
    // Best-effort: the server does not gate the propose route on this field
    // (see settings-dialog/ai/shared's `outageKind` comment), but the setting
    // is still the account's record of "I want suggestions", so a click turns
    // it on the first time rather than leaving it permanently false. A
    // failure here is the ordinary settings-save failure and already toasts
    // on its own.
    if (!settings.autoTaxonomy) commit({ autoTaxonomy: true });

    setState({ ...IDLE_STATE, phase: "reading" });
    let outcome: ProposeOutcome;
    try {
      outcome = await requestTaxonomyProposals({ apiUrl: host.apiUrl, language: settings.taxonomyLanguage });
    } catch (error) {
      console.error("[Nook] Taxonomy proposal failed:", error);
      outcome = { kind: "failed", message: t("ai.errors.couldNotAsk") };
    }
    if (!isMounted()) return;
    if (outcome.kind !== "proposals") {
      setState({ ...IDLE_STATE, note: outcomeNote(t, outcome) });
      return;
    }
    const nothingToShow = tagsOnly ? outcome.tags.length === 0 : outcome.proposals.length === 0 && outcome.tags.length === 0;
    if (nothingToShow) {
      setState({ ...IDLE_STATE, note: outcomeNote(t, outcome) });
      return;
    }
    const proposals = tagsOnly ? [] : outcome.proposals;
    const names = proposals.map((proposal) => proposal.name);
    setState({
      phase: "review",
      proposals,
      accepted: names,
      tags: outcome.tags,
      tagChoice: {},
      sampleSize: outcome.sampleSize,
      // Dropped alongside `proposals` in tagsOnly mode: "You already have
      // Design, Reading" is a sentence about proposed collection names
      // matching existing ones, which makes no sense once no collections are
      // being proposed here at all.
      existingCollections: tagsOnly ? [] : outcome.existingCollections,
      note: null,
      autoFileJustEnabled: false,
    });
  };

  const accept = async () => {
    const collections = state.proposals.filter((proposal) => state.accepted.includes(proposal.name)).map((proposal) => proposal.name);
    const tags = tickedTags.map((tag) => ({ name: tag.name, ...(tag.why ? { definition: tag.why } : {}) }));
    if (collections.length === 0 && tags.length === 0) return;
    setState((previous) => ({ ...previous, phase: "accepting" }));
    try {
      const result = await acceptTaxonomy({ collections, tags });
      if (result.kind !== "accepted") {
        if (!isMounted()) return;
        setState((previous) => ({ ...previous, phase: "review" }));
        toast({ body: requestFailureNote(t, result).text, type: "error" });
        return;
      }
      const { createdCollections, addedTags, dropped } = result;
      toast({ body: addedMessage(t, createdCollections, addedTags) });

      // The whole point of accepting is getting bookmarks filed — make sure
      // the toggle that lets the server's worker do that is on, and queue a
      // pass right now rather than waiting for the next tick.
      const autoFileJustEnabled = !settings.autoClassify;
      if (autoFileJustEnabled) commit({ autoClassify: true });
      try {
        await requestClassificationRun();
      } catch (error) {
        // The taxonomy is real either way — a failed "start filing now" is
        // not worth undoing the acceptance for. The per-minute worker will
        // pick this account up on its own tick regardless.
        console.error("[Nook] Could not start filing after accepting suggestions:", error);
      }

      if (!isMounted()) return;
      announceAiStatusChange();
      onAccepted?.();
      setState({ ...IDLE_STATE, phase: "done", note: acceptedNote(t, createdCollections, addedTags, dropped), autoFileJustEnabled });
    } catch (error) {
      console.error("[Nook] Could not create the suggested taxonomy:", error);
      if (isMounted()) setState((previous) => ({ ...previous, phase: "review" }));
      toast({ body: t("ai.errors.couldNotAccept"), type: "error" });
    }
  };

  const cancel = () => setState(IDLE_STATE);

  const disabledReason = !host.user ? t("ai.suggest.signedOutTooltip") : proposerUnavailable ? t("ai.errors.notAvailable") : undefined;

  return {
    state,
    isReading,
    isReviewing,
    isAccepting,
    isBusy,
    disabledReason,
    tickedTags,
    statusLine: statusLine(t, status),
    acceptCollections,
    acceptTags,
    ask: () => void ask(),
    accept: () => void accept(),
    cancel,
  };
}

export function isCoveredBy(tag: TagProposal, acceptedNames: string[]): boolean {
  return tag.coveredBy.some((name) => acceptedNames.includes(name));
}

export function collectionsReviewDescription(t: TFunction, sampleSize: number, existingCollections: string[]): string {
  const read = t("ai.suggest.sampleRead", { count: sampleSize });
  if (existingCollections.length === 0) return `${read} ${t("ai.suggest.reviewHintNoExisting")}`;
  return `${read} ${t("ai.suggest.reviewHintExisting", { names: existingCollections.join(", ") })}`;
}

export function noteLabel(t: TFunction, variant: StatusDotVariant): string {
  if (variant === "error") return t("ai.status.failed");
  if (variant === "warning") return t("ai.status.unavailable");
  if (variant === "success") return t("ai.status.done");
  return t("ai.status.nothingToDo");
}

function outcomeNote(t: TFunction, outcome: ProposeOutcome): SuggestNote {
  switch (outcome.kind) {
    case "proposals":
      return { variant: "neutral", text: t("ai.suggest.nothingNew") };
    case "nothing-to-read":
      return { variant: "neutral", text: t("ai.suggest.nothingToRead") };
    case "signed-out":
    case "unavailable":
    case "throttled":
    case "failed":
      return requestFailureNote(t, outcome);
  }
}

function requestFailureNote(t: TFunction, outcome: { kind: "signed-out" | "unavailable" | "throttled" | "failed"; message?: string }): SuggestNote {
  switch (outcome.kind) {
    case "signed-out":
      return { variant: "warning", text: t("ai.errors.signedOut") };
    case "unavailable":
      return { variant: "warning", text: t("ai.errors.notAvailable") };
    case "throttled":
      return { variant: "warning", text: t("ai.errors.throttled") };
    case "failed":
      return { variant: "error", text: outcome.message ?? t("ai.errors.failed") };
  }
}

/** "{n} collection(s)" and/or "{m} tag(s)) added", the one message shared by
 *  the post-accept toast and the first line of the inline note below. */
function addedMessage(t: TFunction, collections: number, tags: number): string {
  if (collections === 0 && tags === 0) return t("ai.suggest.nothingAdded");
  return t("ai.suggest.addedToast", { parts: countParts(t, collections, tags) });
}

/**
 * The one irreversible-feeling step in this feature, so it says plainly what
 * was created: these are ordinary collections, on every device this account
 * syncs to, and the user can rename or delete any of them like any other.
 */
function acceptedNote(t: TFunction, collections: number, tags: number, dropped: number): SuggestNote {
  if (collections === 0 && tags === 0) {
    return { variant: "warning", text: t("ai.suggest.nothingAdded") };
  }
  const parts = [addedMessage(t, collections, tags)];
  if (dropped > 0) parts.push(t("ai.suggest.keptExisting", { count: dropped }));
  parts.push(t("ai.suggest.collectionsAreReal"));
  return { variant: "success", text: parts.join(" ") };
}
