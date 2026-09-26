import { Banner } from "@astryxdesign/core/Banner";
import { useI18n } from "../../../i18n";

/**
 * The one banner worth showing when neither AI deployment is configured —
 * shared by `AiPanel`'s intro and the Organize page
 * (`dashboard/organize/OrganizePage.tsx`), so the sentence a user reads is the
 * same wherever they run into it. See `outageKind` in `./shared` for why
 * `"all"` is the only case that gets a banner rather than a per-row note.
 */
export function AiUnavailableBanner() {
  const { t } = useI18n();
  return (
    <Banner status="warning" title={t("ai.intro.unavailableTitle")} description={t("ai.intro.unavailableDescription")} />
  );
}
