import { VStack } from "@astryxdesign/core/Layout";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Text } from "@astryxdesign/core/Text";
import { useI18n } from "../../i18n";
import { useNookHost } from "../host/NookHost";

export function AboutPanel() {
  const host = useNookHost();
  const { t } = useI18n();
  return (
    <VStack gap={4}>
      <MetadataList
        title={
          <VStack gap={0.5}>
            {/* "Nook" is the product name — kept untranslated per docs/i18n.md's Turkish style guide. */}
            <Text type="label">Nook</Text>
            <Text type="supporting" color="secondary">
              {t("settings.about.tagline")}
            </Text>
          </VStack>
        }
      >
        <MetadataListItem label={t("settings.about.versionLabel")}>{host.appVersion}</MetadataListItem>
      </MetadataList>
    </VStack>
  );
}
