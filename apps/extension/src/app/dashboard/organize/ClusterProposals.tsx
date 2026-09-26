import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Divider } from "@astryxdesign/core/Divider";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { useI18n } from "../../../i18n";
import type { ClusterProposal } from "../../../../lib/ai-client";
import type { Bookmark, BookmarkList } from "../../../../lib/types";
import { clusterMemberTitles, describeUnclustered } from "./organize-utils";
import { noteLabel } from "./useSuggestCollections";
import type { UseSuggestClusters } from "./useSuggestClusters";


const VISIBLE_SAMPLES = 3;
/**
 * The cluster-suggestion review list — one row per group Jev found, a sticky
 * footer for the count-and-accept action, and the honest "N didn't form a
 * group" line. Full width, same reasoning as the old `SuggestionReview.tsx`:
 * this is a primary workflow, not a setting squeezed into a narrow column.
 */
export function ClusterProposals({ suggest, items, lists }: { suggest: UseSuggestClusters; items: Bookmark[]; lists: BookmarkList[] }) {
  const { t } = useI18n();
  const { state, isAccepting, footerLabel, selectAll, selectNone, toggleAccepted, rename, nameFor, accept, cancel } = suggest;
  const listNameById = new Map(lists.map((list) => [list.id, list.name]));
  const unclusteredLine = describeUnclustered(t, state.unclustered);
  const acceptedCount = state.acceptedIds.length;

  return (
    <VStack gap={3} width="100%">
      {state.note ? (
        <HStack gap={2} align="start">
          <StatusDot variant={state.note.variant} label={noteLabel(t, state.note.variant)} />
          <Text type="supporting" color="secondary">
            {state.note.text}
          </Text>
        </HStack>
      ) : null}

      <HStack justify="between" align="center" wrap="wrap" gap={2}>
        <Text type="supporting" color="secondary">
          {t("dashboard.organize.clusters.consideredNote", { count: state.considered })}
        </Text>
        <HStack gap={2}>
          <Button label={t("dashboard.organize.clusters.selectAll")} variant="ghost" size="sm" onClick={selectAll} />
          <Button label={t("dashboard.organize.clusters.selectNone")} variant="ghost" size="sm" onClick={selectNone} />
        </HStack>
      </HStack>

      <VStack gap={0} width="100%">
        {state.proposals.map((proposal, index) => (
          <VStack key={proposal.id} width="100%">
            {index > 0 ? <Divider /> : null}
            <ClusterProposalRow
              proposal={proposal}
              isChecked={state.acceptedIds.includes(proposal.id)}
              onToggle={() => toggleAccepted(proposal.id)}
              name={nameFor(proposal)}
              onRename={(name) => rename(proposal.id, name)}
              existingListName={proposal.existingListId ? listNameById.get(proposal.existingListId) ?? null : null}
              items={items}
            />
          </VStack>
        ))}
      </VStack>

      {unclusteredLine ? (
        <Text type="supporting" color="secondary">
          {unclusteredLine}
        </Text>
      ) : null}

      {/* Sticky rather than a Layout footer slot — see SuggestionReview.tsx's
          comment on why: this renders inside the dashboard's own scrolling
          content column, not a bounded panel of its own. */}
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
          label={footerLabel}
          variant="primary"
          size="sm"
          isLoading={isAccepting}
          isDisabled={acceptedCount === 0}
          tooltip={acceptedCount === 0 ? t("dashboard.organize.clusters.nothingSelected") : undefined}
          onClick={accept}
        />
      </HStack>
    </VStack>
  );
}

function ClusterProposalRow({
  proposal,
  isChecked,
  onToggle,
  name,
  onRename,
  existingListName,
  items,
}: {
  proposal: ClusterProposal;
  isChecked: boolean;
  onToggle(): void;
  name: string;
  onRename(name: string): void;
  existingListName: string | null;
  items: Bookmark[];
}) {
  const { t } = useI18n();
  const [isEditingName, setIsEditingName] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const memberCount = proposal.memberIds.length || proposal.size;

  return (
    <HStack gap={3} align="start" paddingBlock={3} width="100%">
      <CheckboxInput label={t("dashboard.organize.clusters.nameLabel")} isLabelHidden value={isChecked} onChange={onToggle} />
      <VStack gap={1} width="100%">
        <HStack gap={2} align="center" wrap="wrap">
          {isEditingName ? (
            <TextInput
              label={t("dashboard.organize.clusters.nameLabel")}
              isLabelHidden
              size="sm"
              value={name}
              hasAutoFocus
              onChange={onRename}
              onEnter={() => setIsEditingName(false)}
              onBlur={() => setIsEditingName(false)}
            />
          ) : (
            <>
              <Text weight="semibold">{name}</Text>
              <Button label={t("dashboard.organize.clusters.renameAction")} variant="ghost" size="sm" onClick={() => setIsEditingName(true)} />
            </>
          )}
          {existingListName ? (
            <Token label={t("dashboard.organize.clusters.existingBadge", { name: existingListName })} color="blue" size="sm" />
          ) : null}
        </HStack>

        <Text type="supporting" color="secondary">
          {t("dashboard.organize.clusters.bookmarksCount", { count: memberCount })}
          {proposal.why ? ` · ${proposal.why}` : ""}
        </Text>

        {/* The samples are what a user decides on, so they are always visible;
            only the full member list waits behind "show all". */}
        {proposal.sampleTitles.length > 0 ? (
          <VStack gap={0.5}>
            {proposal.sampleTitles.slice(0, VISIBLE_SAMPLES).map((title, index) => (
              <Text key={`${proposal.id}-sample-${index}`} type="supporting">
                · {title}
              </Text>
            ))}
          </VStack>
        ) : null}
        {memberCount > Math.min(proposal.sampleTitles.length, VISIBLE_SAMPLES) ? (
          <Collapsible
            isOpen={isExpanded}
            onOpenChange={setIsExpanded}
            trigger={
              <Text type="supporting" color="secondary">
                {isExpanded ? t("dashboard.organize.clusters.showLess") : t("dashboard.organize.clusters.showAll", { count: memberCount })}
              </Text>
            }
          >
            <VStack gap={0.5} paddingBlockStart={1}>
              {/* Only built once opened: a big group's full member list is
                  work (and DOM) nobody asked for until they do. */}
              {(isExpanded ? clusterMemberTitles(proposal.memberIds, items, t) : []).map((title, index) => (
                <Text key={`${proposal.id}-${index}`} type="supporting" color="secondary">
                  · {title}
                </Text>
              ))}
            </VStack>
          </Collapsible>
        ) : null}
      </VStack>
    </HStack>
  );
}
