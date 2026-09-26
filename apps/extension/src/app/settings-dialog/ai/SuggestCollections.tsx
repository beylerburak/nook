import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxList, CheckboxListItem } from "@astryxdesign/core/CheckboxList";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { StatusDot, type StatusDotVariant } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import {
  acceptTaxonomy,
  announceAiStatusChange,
  requestTaxonomyProposals,
  type AiStatus,
  type ProposeOutcome,
  type TagProposal,
  type TaxonomyProposal,
} from "../../../../lib/ai-client";
import type { AiSettings } from "../../../../lib/ai-settings";
import { useI18n } from "../../../i18n";
import { useNookHost } from "../../host/NookHost";
import { type TFunction, useIsMounted } from "./shared";

/**
 * Step 1 — "Suggest collections": ask the server what to call the themes in
 * this library, show the answer for review, and turn the names the user keeps
 * into real collections plus the tag vocabulary in force
 * (docs/ai.md, "Taxonomy growth").
 *
 * Everything the client used to own is the server's now. The sample is drawn
 * from the account's own unfiled bookmarks, so this sends no library and holds
 * no `Bookmark[]`; acceptance sends names only, and the server reads the
 * account's existing lists, its own tags and the sample from the same store it
 * classifies against.
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
function countParts(t: TFunction, collections: number, tags: number): string {
  const parts: string[] = [];
  if (collections > 0) parts.push(t("ai.suggest.collectionsCount", { count: collections }));
  if (tags > 0) parts.push(t("ai.suggest.tagsCount", { count: tags }));
  return parts.join(` ${t("ai.suggest.and")} `);
}

type SuggestPhase = "idle" | "reading" | "review" | "accepting" | "done";

interface SuggestState {
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
}

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

export function SuggestCollectionsStep({
  status,
  settings,
  commit,
}: {
  status: AiStatus | null;
  settings: AiSettings;
  commit(patch: Partial<AiSettings>): void;
}) {
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
  // `outageKind` in ./shared for why `status.summarize.available` is the right
  // signal for it — so the button is gated on a session and the deployment
  // being configured, nothing else.
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
    // (see ./shared's `outageKind` comment), but the setting is still the
    // account's record of "I want suggestions", so a click turns it on the
    // first time rather than leaving it permanently false. A failure here is
    // the ordinary settings-save failure and already toasts on its own.
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
    if (outcome.kind !== "proposals" || (outcome.proposals.length === 0 && outcome.tags.length === 0)) {
      setState({ ...IDLE_STATE, note: outcomeNote(t, outcome) });
      return;
    }
    const names = outcome.proposals.map((proposal) => proposal.name);
    setState({
      phase: "review",
      proposals: outcome.proposals,
      accepted: names,
      tags: outcome.tags,
      tagChoice: {},
      sampleSize: outcome.sampleSize,
      existingCollections: outcome.existingCollections,
      note: null,
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
      if (!isMounted()) return;
      announceAiStatusChange();
      setState({ ...IDLE_STATE, phase: "done", note: acceptedNote(t, createdCollections, addedTags, dropped) });
    } catch (error) {
      console.error("[Nook] Could not create the suggested taxonomy:", error);
      if (isMounted()) setState((previous) => ({ ...previous, phase: "review" }));
      toast({ body: t("ai.errors.couldNotAccept"), type: "error" });
    }
  };

  const disabledReason = !host.user ? t("ai.suggest.signedOutTooltip") : proposerUnavailable ? t("ai.errors.notAvailable") : undefined;

  return (
    <VStack gap={2} width="100%">
      {status ? (
        <Text type="supporting" color="secondary">
          {statusLine(t, status)}
        </Text>
      ) : null}
      <HStack justify="end">
        {isReviewing ? (
          <Button label={t("common.cancel")} variant="ghost" size="sm" onClick={() => setState(IDLE_STATE)} />
        ) : (
          <Button
            label={t("ai.suggest.button")}
            variant="secondary"
            size="sm"
            isLoading={isReading}
            isDisabled={Boolean(disabledReason) || isBusy}
            tooltip={disabledReason ?? t("ai.suggest.buttonTooltip")}
            onClick={() => void ask()}
          />
        )}
      </HStack>

      {isReading ? (
        <HStack gap={2} align="center">
          <StatusDot variant="accent" label={t("ai.suggest.reading")} isPulsing />
          <Text type="supporting" color="secondary">
            {t("ai.suggest.readingBody")}
          </Text>
        </HStack>
      ) : null}

      {isReviewing ? (
        <VStack gap={2} width="100%">
          {state.proposals.length > 0 ? (
            <CheckboxList
              label={t("ai.suggest.newCollections")}
              description={collectionsReviewDescription(t, state.sampleSize, state.existingCollections)}
              hasDividers
              width="100%"
              value={state.accepted}
              onChange={acceptCollections}
            >
              {state.proposals.map((proposal) => (
                <CheckboxListItem key={proposal.name} value={proposal.name} label={proposal.name} description={proposal.why} />
              ))}
            </CheckboxList>
          ) : null}
          {state.tags.length > 0 ? (
            <CheckboxList
              label={t("ai.suggest.newTags")}
              description={t("ai.suggest.newTagsDescription")}
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
                  description={isCoveredBy(tag, state.accepted) ? t("ai.suggest.alreadyCovered") : tag.why}
                />
              ))}
            </CheckboxList>
          ) : null}
          <HStack justify="end" gap={2}>
            <Button
              label={t("ai.suggest.addLabel", { parts: countParts(t, state.accepted.length, tickedTags.length) })}
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
          <StatusDot variant={state.note.variant} label={noteLabel(t, state.note.variant)} />
          <Text type="supporting" color="secondary">
            {state.note.text}
          </Text>
        </HStack>
      ) : null}
    </VStack>
  );
}

function isCoveredBy(tag: TagProposal, acceptedNames: string[]): boolean {
  return tag.coveredBy.some((name) => acceptedNames.includes(name));
}

function collectionsReviewDescription(t: TFunction, sampleSize: number, existingCollections: string[]): string {
  const read = t("ai.suggest.sampleRead", { count: sampleSize });
  if (existingCollections.length === 0) return `${read} ${t("ai.suggest.reviewHintNoExisting")}`;
  return `${read} ${t("ai.suggest.reviewHintExisting", { names: existingCollections.join(", ") })}`;
}

function noteLabel(t: TFunction, variant: StatusDotVariant): string {
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
