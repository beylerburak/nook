import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { useI18n } from "../../i18n";
import { useNookHost, type NookHost } from "../host/NookHost";
import { AdvancedSettings } from "./ai/AdvancedSettings";
import { OrganizeCard } from "./ai/OrganizeCard";
import { outageKind, useAiSettings, useAiStatus } from "./ai/shared";
import { SearchByMeaningRow } from "./ai/SearchByMeaningRow";
import { SummariesCard } from "./ai/SummariesCard";

/**
 * Settings → AI, redesigned around one question: what does Nook actually do
 * with AI, and what should I do next?
 *
 * - An intro line, plus one banner if the server has no AI key at all — see
 *   `outageKind` in `ai/shared.ts` for the two independent deployments that
 *   fact is drawn from.
 * - "Organize your library": two guided steps — suggest collections and tags,
 *   then file into them (new saves *and* the existing library — see
 *   `AutoFileStep`'s own comment for why that is true of the toggle alone, not
 *   just the on-demand button).
 * - "Summaries", short by design, with the privacy detail behind a disclosure
 *   rather than in the switch's own paragraph.
 * - "Search by meaning", one informational line: no toggle, it just works for
 *   a signed-in account once the server is configured for it.
 * - "Advanced": the four thresholds, collapsed by default.
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
export function AiPanel() {
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
      <OrganizeCard settings={settings} status={status} commit={commit} onRefresh={refresh} />
      <SummariesCard settings={settings} status={status} commit={commit} />
      <SearchByMeaningRow />
      <AdvancedSettings settings={settings} commit={commit} />
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
      {outageKind(status) === "all" ? (
        <Banner status="warning" title={t("ai.intro.unavailableTitle")} description={t("ai.intro.unavailableDescription")} />
      ) : null}
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
