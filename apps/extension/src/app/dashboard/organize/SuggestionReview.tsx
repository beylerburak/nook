import { Button } from "@astryxdesign/core/Button";
import { CheckboxList, CheckboxListItem } from "@astryxdesign/core/CheckboxList";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { useI18n } from "../../../i18n";
import { collectionsReviewDescription, countParts, isCoveredBy, type UseSuggestCollections } from "./useSuggestCollections";

/**
 * The suggestion review step, full width — this is what used to be squeezed
 * into an 880px Settings dialog with checkboxes and a description crammed
 * into the same narrow column as every other setting. Nothing about the
 * review logic changed (see `useSuggestCollections`); what changed is that it
 * gets the whole page now, and the accept/cancel bar is sticky so it never
 * clips off the edge the way the old "Accept 8 collections and 7 tags"
 * button did in the settings dialog — checked at 360px width too.
 */
export function SuggestionReview({ suggest }: { suggest: UseSuggestCollections }) {
  const { t } = useI18n();
  const { state, isAccepting, tickedTags, acceptCollections, acceptTags, accept, cancel } = suggest;

  return (
    <VStack gap={3} width="100%">
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

      {/*
        Sticky rather than a Layout footer slot: this step renders inside the
        dashboard's own scrolling content column (CanvasEditorShell's
        LayoutContent), not a bounded panel of its own, so `position: sticky`
        against that ancestor's scrollport is what keeps this reachable
        without clipping — no Astryx layout prop reaches into an ancestor
        outside this component (AGENTS.md: props first, else style + tokens).
      */}
      <HStack
        justify="end"
        gap={2}
        wrap="wrap"
        style={{
          position: "sticky",
          bottom: 0,
          background: "var(--color-background-surface)",
          paddingBlock: "var(--spacing-3)",
        }}
      >
        <Button label={t("common.cancel")} variant="ghost" size="sm" isDisabled={isAccepting} onClick={cancel} />
        <Button
          label={t("ai.suggest.addLabel", { parts: countParts(t, state.accepted.length, tickedTags.length) })}
          variant="primary"
          size="sm"
          isLoading={isAccepting}
          isDisabled={state.accepted.length === 0 && tickedTags.length === 0}
          onClick={accept}
        />
      </HStack>
    </VStack>
  );
}
