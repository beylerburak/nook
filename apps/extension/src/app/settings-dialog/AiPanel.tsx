import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { useI18n } from "../../i18n";
import { useNookHost, type NookHost } from "../host/NookHost";
import { AdvancedSettings } from "./ai/AdvancedSettings";
import { AiUnavailableBanner } from "./ai/AiOutageBanner";
import { AutoFileSwitch } from "./ai/AutoFileSwitch";
import { outageKind, useAiSettings, useAiStatus } from "./ai/shared";
import { SearchByMeaningRow } from "./ai/SearchByMeaningRow";
import { SummariesCard } from "./ai/SummariesCard";

/**
 * Settings → AI — short by design. The review/organize workflow used to live
 * here (a Stepper wedged into an 880px dialog, with the "Accept N collections"
 * button clipped off the right edge at anything but the widest viewport) but
 * it is a primary workflow, not a setting, so it moved to its own page: the
 * Organize page (`dashboard/organize/OrganizePage.tsx`), reached from the
 * side nav or from the button at the bottom of this panel.
 *
 * What is left is genuinely settings: the two switches, the informational
 * "Search by meaning" row, and the advanced thresholds, collapsed by default.
 *
 * This panel is host-agnostic: every read and write here is an authenticated
 * call to Nook's server (`lib/ai-client.ts`, `lib/ai-settings.ts`), so it
 * renders identically in the extension and in the web app. `host.user` is
 * still the guard below, and still a defensive fallback rather than the usual
 * path — `SettingsDialog.visibleSections` only offers this section once
 * `host.user` is set, so the one render this guard exists for is the moment a
 * sign-out clears it just before the dialog switches away.
 *
 * Every user-visible string in this file and the ones under `./ai/` is under
 * the `ai` namespace — see `src/i18n/locales/en/ai.ts` / `tr/ai.ts`.
 */
export function AiPanel({ onOpenOrganize }: { onOpenOrganize?(): void }) {
  const { t } = useI18n();
  const host = useNookHost();
  const { settings, commit } = useAiSettings();
  const { status, isLoading, refresh } = useAiStatus(settings);

  if (!host.user) return <SignInRequired host={host} />;

  if (!settings) {
    return (
      <VStack padding={4}>
        <Text color="secondary">{t("ai.loadingSettings")}</Text>
      </VStack>
    );
  }

  return (
    <VStack gap={4}>
      <IntroBanner status={status} isLoading={isLoading} onRefresh={refresh} />
      <AutoFileSwitch settings={settings} status={status} commit={commit} />
      <SummariesCard settings={settings} status={status} commit={commit} />
      <SearchByMeaningRow />
      <AdvancedSettings settings={settings} commit={commit} />
      <VStack gap={1.5}>
        <Text type="supporting" color="secondary">
          {t("ai.openOrganizeDescription")}
        </Text>
        <Button label={t("ai.openOrganize")} variant="primary" onClick={onOpenOrganize} isDisabled={!onOpenOrganize} />
      </VStack>
    </VStack>
  );
}

function IntroBanner({
  status,
  isLoading,
  onRefresh,
}: {
  status: ReturnType<typeof useAiStatus>["status"];
  isLoading: boolean;
  onRefresh(): void;
}) {
  const { t } = useI18n();
  return (
    <VStack gap={2}>
      <HStack gap={2} align="start" justify="between">
        <Text color="secondary">{t("ai.intro.text")}</Text>
        <Button label={t("ai.intro.refresh")} variant="ghost" size="sm" isLoading={isLoading} onClick={onRefresh} />
      </HStack>
      {outageKind(status) === "all" ? <AiUnavailableBanner /> : null}
    </VStack>
  );
}

function SignInRequired({ host }: { host: NookHost }) {
  const { t } = useI18n();
  return (
    <Banner
      status="info"
      title={t("ai.signIn.title")}
      description={t("ai.signIn.description")}
      endContent={
        host.kind === "extension" && host.openWebApp ? (
          <Button label={t("ai.signIn.button")} variant="primary" size="sm" onClick={() => host.openWebApp?.("/?connect=extension")} />
        ) : null
      }
    />
  );
}
