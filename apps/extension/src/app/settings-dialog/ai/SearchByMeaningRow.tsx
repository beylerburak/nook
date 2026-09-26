import { useI18n } from "../../../i18n";
import { SettingsCard, SettingsRow } from "../settings-shared";

/**
 * "Search by meaning" — informational only. Nothing here is a setting: the
 * server embeds a signed-in account's library automatically whenever it has
 * an embedding key, and search already blends that in with ordinary text
 * matching (docs/retrieval.md, "How the index gets built"). There is no
 * per-account status field for this on the wire — unlike classification and
 * summarising, embedding availability is not part of `GET /api/ai/status` —
 * so this row states what is true rather than adding a call just to draw a dot.
 */
export function SearchByMeaningRow() {
  const { t } = useI18n();
  return (
    <SettingsCard title={t("ai.search.title")}>
      <SettingsRow title={t("ai.search.rowTitle")} description={t("ai.search.description")} />
    </SettingsCard>
  );
}
