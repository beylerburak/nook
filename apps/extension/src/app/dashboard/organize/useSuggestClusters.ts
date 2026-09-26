import { useState } from "react";
import { useToast } from "@astryxdesign/core/Toast";
import {
  acceptClusters,
  announceAiStatusChange,
  requestClusterProposals,
  type AiStatus,
  type ClusterProposal,
  type ProposeClustersOutcome,
} from "../../../../lib/ai-client";
import type { AiSettings } from "../../../../lib/ai-settings";
import { useI18n } from "../../../i18n";
import { useNookHost } from "../../host/NookHost";
import { type TFunction, useIsMounted } from "../../settings-dialog/ai/shared";
import { describeClusterFooterLabel, tickedClusterCounts } from "./organize-utils";
import type { SuggestNote } from "./useSuggestCollections";

/**
 * "Suggest collections" — the Organize page's primary action now (docs/ai.md,
 * "Settings surface, and the Organize page"). Same shape of state machine as
 * `useSuggestCollections.ts` (`idle` → `reading` → `review` → `accepting` →
 * `done`), but built around groups Jev already knows the membership of
 * (`ClusterProposal.memberIds`) rather than bare names a classifier would
 * later have to match bookmarks against one at a time.
 *
 * Unlike the old flow, accepting is not "turn on filing and queue a pass":
 * `PUT /api/ai/clusters/accept` files every member in the same transaction
 * that creates the collections, so there is no queue to watch drain — the
 * caller (`OrganizePage.tsx`) follows a success here with
 * `host.sync.requestSync()` so the local library catches up, and `onAccepted`
 * so the page can re-read `GET /api/ai/status` (for `reviewCount` and the
 * progress numbers) right away rather than waiting for the next poll.
 *
 * A proposal's own name is editable before accepting (`rename`) — the
 * server's `why`/`sampleTitles` don't change when it is, only the name sent
 * on accept.
 */

export type ClusterPhase = "idle" | "reading" | "review" | "accepting" | "done";

export interface ClusterSuggestState {
  phase: ClusterPhase;
  proposals: ClusterProposal[];
  /** Which proposal ids are ticked. Default: every proposal, on read. */
  acceptedIds: string[];
  /** A proposal's edited name, keyed by id. A proposal with no entry here
   *  uses its own `name` — this only ever holds names the user actually
   *  changed. */
  names: Record<string, string>;
  unclustered: number;
  considered: number;
  note: SuggestNote | null;
}

const IDLE_STATE: ClusterSuggestState = {
  phase: "idle",
  proposals: [],
  acceptedIds: [],
  names: {},
  unclustered: 0,
  considered: 0,
  note: null,
};

export interface UseSuggestClustersParams {
  settings: AiSettings;
  status: AiStatus | null;
  /** Called right after a successful accept, so the caller can re-read
   *  `GET /api/ai/status` and the review list immediately. */
  onAccepted?(): void;
}

export interface UseSuggestClusters {
  state: ClusterSuggestState;
  isReading: boolean;
  isReviewing: boolean;
  isAccepting: boolean;
  isBusy: boolean;
  disabledReason: string | undefined;
  /** The name a proposal will be sent under if accepted right now. */
  nameFor(proposal: ClusterProposal): string;
  footerLabel: string;
  ask(): void;
  toggleAccepted(id: string): void;
  selectAll(): void;
  selectNone(): void;
  rename(id: string, name: string): void;
  accept(): void;
  cancel(): void;
}

export function useSuggestClusters({ settings, status, onAccepted }: UseSuggestClustersParams): UseSuggestClusters {
  const { t } = useI18n();
  const host = useNookHost();
  const toast = useToast();
  const isMounted = useIsMounted();
  const [state, setState] = useState<ClusterSuggestState>(IDLE_STATE);

  const isReading = state.phase === "reading";
  const isReviewing = state.phase === "review" || state.phase === "accepting";
  const isAccepting = state.phase === "accepting";
  const isBusy = isReading || isAccepting;

  const nameFor = (proposal: ClusterProposal): string => (state.names[proposal.id] ?? proposal.name).trim() || proposal.name;

  const ask = async () => {
    setState({ ...IDLE_STATE, phase: "reading" });
    let outcome: ProposeClustersOutcome;
    try {
      outcome = await requestClusterProposals({ apiUrl: host.apiUrl, language: settings.taxonomyLanguage });
    } catch (error) {
      console.error("[Nook] Cluster proposal failed:", error);
      outcome = { kind: "failed", message: t("ai.errors.couldNotAsk") };
    }
    if (!isMounted()) return;
    if (outcome.kind !== "proposals" || outcome.proposals.length === 0) {
      setState({ ...IDLE_STATE, note: outcomeNote(t, outcome) });
      return;
    }
    setState({
      phase: "review",
      proposals: outcome.proposals,
      // Every proposal starts ticked — see OrganizePage.tsx/the contract:
      // "Checkbox per proposal (default checked)".
      acceptedIds: outcome.proposals.map((proposal) => proposal.id),
      names: {},
      unclustered: outcome.unclustered,
      considered: outcome.considered,
      note: null,
    });
  };

  const toggleAccepted = (id: string) =>
    setState((previous) => ({
      ...previous,
      acceptedIds: previous.acceptedIds.includes(id)
        ? previous.acceptedIds.filter((existing) => existing !== id)
        : [...previous.acceptedIds, id],
    }));

  const selectAll = () => setState((previous) => ({ ...previous, acceptedIds: previous.proposals.map((proposal) => proposal.id) }));
  const selectNone = () => setState((previous) => ({ ...previous, acceptedIds: [] }));

  const rename = (id: string, name: string) => setState((previous) => ({ ...previous, names: { ...previous.names, [id]: name } }));

  const accept = async () => {
    const accepted = state.proposals.filter((proposal) => state.acceptedIds.includes(proposal.id));
    if (accepted.length === 0) return;
    setState((previous) => ({ ...previous, phase: "accepting" }));
    try {
      const result = await acceptClusters({
        collections: accepted.map((proposal) => ({
          name: nameFor(proposal),
          memberIds: proposal.memberIds,
          existingListId: proposal.existingListId,
        })),
      });
      if (result.kind !== "accepted") {
        if (!isMounted()) return;
        setState((previous) => ({ ...previous, phase: "review" }));
        toast({ body: requestFailureText(t, result), type: "error" });
        return;
      }
      toast({
        body: t("dashboard.organize.clusters.acceptedToast", {
          count: result.filed,
          collections: t("dashboard.organize.clusters.collectionsCount", { count: result.createdCollections }),
        }),
      });
      announceAiStatusChange();
      // The whole point of accepting: files happened server-side already, so
      // the local library needs a sync to show them, not a queue to poll.
      void host.sync.requestSync();
      onAccepted?.();
      if (isMounted()) setState({ ...IDLE_STATE, phase: "done" });
    } catch (error) {
      console.error("[Nook] Could not create the suggested collections:", error);
      if (isMounted()) setState((previous) => ({ ...previous, phase: "review" }));
      toast({ body: t("ai.errors.couldNotAccept"), type: "error" });
    }
  };

  const cancel = () => setState(IDLE_STATE);

  // Same signal as the old `useSuggestCollections.ts`'s `proposerUnavailable`:
  // both cluster proposals and taxonomy proposals resolve the same
  // NOOK_AI_PROPOSER key on the server (see `outageKind` in
  // settings-dialog/ai/shared.ts), so `status.summarize.available` is the
  // right read for "can this account ask for groups at all".
  const proposerUnavailable = status !== null && !status.summarize.available;
  const disabledReason = !host.user
    ? t("dashboard.organize.clusters.signedOutTooltip")
    : proposerUnavailable
      ? t("ai.errors.notAvailable")
      : undefined;
  const { collections, bookmarks } = tickedClusterCounts(state.proposals, state.acceptedIds);
  const footerLabel = describeClusterFooterLabel(t, collections, bookmarks);

  return {
    state,
    isReading,
    isReviewing,
    isAccepting,
    isBusy,
    disabledReason,
    nameFor,
    footerLabel,
    ask: () => void ask(),
    toggleAccepted,
    selectAll,
    selectNone,
    rename,
    accept: () => void accept(),
    cancel,
  };
}

function outcomeNote(t: TFunction, outcome: ProposeClustersOutcome): SuggestNote {
  switch (outcome.kind) {
    case "proposals":
      return { variant: "neutral", text: t("dashboard.organize.clusters.nothingNew") };
    case "signed-out":
      return { variant: "warning", text: t("ai.errors.signedOut") };
    case "unavailable":
      return { variant: "warning", text: t("ai.errors.notAvailable") };
    case "throttled":
      return { variant: "warning", text: t("ai.errors.throttled") };
    case "failed":
      return { variant: "error", text: outcome.message };
  }
}

function requestFailureText(t: TFunction, outcome: { kind: "signed-out" | "unavailable" | "throttled" | "failed"; message?: string }): string {
  switch (outcome.kind) {
    case "signed-out":
      return t("ai.errors.signedOut");
    case "unavailable":
      return t("ai.errors.notAvailable");
    case "throttled":
      return t("ai.errors.throttled");
    case "failed":
      return outcome.message ?? t("ai.errors.failed");
  }
}
