import { VStack } from "@astryxdesign/core/Layout";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Text } from "@astryxdesign/core/Text";
import { useNookHost } from "../host/NookHost";

export function AboutPanel() {
  const host = useNookHost();
  return (
    <VStack gap={4}>
      <MetadataList
        title={
          <VStack gap={0.5}>
            <Text type="label">Nook</Text>
            <Text type="supporting" color="secondary">
              Save what matters.
            </Text>
          </VStack>
        }
      >
        <MetadataListItem label="Version">{host.appVersion}</MetadataListItem>
      </MetadataList>
    </VStack>
  );
}
