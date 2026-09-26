import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Card, HStack, VStack } from "@astryxdesign/core/Layout";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Slider } from "@astryxdesign/core/Slider";
import { Text } from "@astryxdesign/core/Text";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { useI18n } from "../../../i18n";
import { DEFAULT_AI_SETTINGS, TAXONOMY_LANGUAGES, type AiSettings } from "../../../../lib/ai-settings";
import { SettingsRow } from "../settings-shared";
import { formatConfidence } from "./shared";

/**
 * "Advanced" — the four numbers that used to be a permanently-visible
 * "Thresholds" card. Collapsed by default: these are tuning knobs for the two
 * features above, not something a first-time reader needs to understand
 * before turning anything on.
 *
 * Every user-visible string is under `ai.advanced` — see
 * `src/i18n/locales/en/ai.ts`. The language picker's own options come from
 * `TAXONOMY_LANGUAGES` (lib/ai-settings.ts) untouched — each is a language
 * naming itself, which doesn't change with the UI locale — except `"auto"`,
 * whose label ("Match my library") is real UI copy and so is translated here.
 */

/** A stepper, not a free number — a bookmark rarely wants more than a handful.
 *  Matches the loader's own clamp (MAX_TAGS_LIMIT in lib/ai-settings.ts). */
const MAX_TAGS_MIN = 0;
const MAX_TAGS_MAX = 10;

type ThresholdPatch = Partial<Pick<AiSettings, "collectionMinConfidence" | "tagMinNoul" | "maxTags" | "taxonomyLanguage">>;

export function AdvancedSettings({ settings, commit }: { settings: AiSettings; commit(patch: ThresholdPatch): void }) {
  const { t } = useI18n();
  // A slider fires `onChange` on every step of a drag; only `onChangeEnd` is a
  // decision. Keep the dragged value here so the thumb follows the pointer,
  // and write once the drag ends — otherwise a drag across the track is a
  // dozen writes.
  const [draft, setDraft] = useState<ThresholdPatch>({});
  const collection = draft.collectionMinConfidence ?? settings.collectionMinConfidence;
  const tags = draft.tagMinNoul ?? settings.tagMinNoul;

  const draftSlider = (key: "collectionMinConfidence" | "tagMinNoul") => (value: number) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };
  const commitSlider = (key: "collectionMinConfidence" | "tagMinNoul") => (value: number) => {
    setDraft({});
    commit({ [key]: value });
  };

  const reset = () =>
    commit({
      collectionMinConfidence: DEFAULT_AI_SETTINGS.collectionMinConfidence,
      tagMinNoul: DEFAULT_AI_SETTINGS.tagMinNoul,
      maxTags: DEFAULT_AI_SETTINGS.maxTags,
      taxonomyLanguage: DEFAULT_AI_SETTINGS.taxonomyLanguage,
    });

  const languageOptions = TAXONOMY_LANGUAGES.map((entry) => ({
    value: entry.value,
    label: entry.value === "auto" ? t("ai.advanced.languageAuto") : entry.label,
  }));

  return (
    <Card padding={0} width="100%" variant="muted">
      <Collapsible trigger={<Text type="label">{t("ai.advanced.trigger")}</Text>} defaultIsOpen={false}>
        <VStack gap={0}>
          <SettingsRow
            title={t("ai.advanced.collectionLabel")}
            description={t("ai.advanced.collectionDescription")}
            control={
              <Slider
                label={t("ai.advanced.collectionLabel")}
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
            title={t("ai.advanced.tagLabel")}
            description={t("ai.advanced.tagDescription")}
            control={
              <Slider
                label={t("ai.advanced.tagLabel")}
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
            title={t("ai.advanced.maxTagsLabel")}
            description={t("ai.advanced.maxTagsDescription")}
            control={
              <NumberInput
                label={t("ai.advanced.maxTagsLabel")}
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
          <SettingsRow
            title={t("ai.advanced.languageLabel")}
            description={t("ai.advanced.languageDescription")}
            control={
              <Selector
                label={t("ai.advanced.languageLabel")}
                isLabelHidden
                size="sm"
                width={200}
                value={settings.taxonomyLanguage}
                options={languageOptions}
                onChange={(value) => commit({ taxonomyLanguage: value as AiSettings["taxonomyLanguage"] })}
              />
            }
          />
          <HStack padding={4} justify="end">
            <Button label={t("ai.advanced.reset")} variant="ghost" size="sm" onClick={reset} />
          </HStack>
        </VStack>
      </Collapsible>
    </Card>
  );
}
