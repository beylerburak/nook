import type { Messages } from "../types";
import { dashboard } from "./tr/dashboard";
import { settings } from "./tr/settings";
import { ai } from "./tr/ai";
import { popup } from "./tr/popup";
import { extension } from "./tr/extension";
import { web } from "./tr/web";

/**
 * Turkish message catalog.
 *
 * `satisfies Messages` (Messages is derived from `en`, see `src/i18n/types.ts`)
 * makes this a compile error whenever a key exists in `en` but is missing
 * here, or a plural entry is missing `one`/`other`. If you add a key to
 * `en.ts`, add it here too — that's the whole contract.
 *
 * Style guide (see `docs/i18n.md` for the full version): informal-but-polite
 * imperative ("Kaydet", not "Kaydediniz"), "Nook" stays untranslated, use
 * proper Turkish characters (ı İ ş ğ ü ö ç).
 */
export const tr = {
  common: {
    system: "Sistem",
    close: "Kapat",
    save: "Kaydet",
    cancel: "İptal",
    greeting: "Merhaba, {name}",
  },

  dashboard,
  settings,
  ai,
  popup,
  extension,
  web,
} satisfies Messages;
