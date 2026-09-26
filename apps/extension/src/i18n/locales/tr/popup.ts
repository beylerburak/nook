import type { Messages } from "../../types";

/** Turkish messages for the `popup` namespace — must mirror ./../en/popup.ts exactly. */
export const popup = {
  header: {
    moreOptions: "Diğer seçenekler",
    appearance: "Görünüm",
    openDashboard: "Kütüphaneyi aç",
  },
  page: {
    unsavableTitle: "Bu sayfa kaydedilemiyor",
    restrictedMessage: "Nook tarayıcıya özel sayfaları kaydedemez.",
    noPageMessage: "Bu sekmede açık bir sayfa yok.",
    loadError: "Bu sayfa yüklenemedi.",
    retry: "Tekrar dene",
    saveButton: "Nook'a kaydet",
    saveWithShortcut: "Nook'a kaydet ({shortcut})",
    savedBadge: "Kaydedildi",
    savedToNook: "Nook'a kaydedildi",
    openInNook: "Nook'ta aç",
    remove: "Kaldır",
    savedAsPostHint: "X'teki Nook düğmesi gibi gönderi olarak kaydedildi.",
  },
  footer: {
    searchLabel: "Nook'ta ara",
    searchPlaceholder: "Nook'ta ara…",
    syncButton: "X yer imlerini senkronize et",
    openDashboard: "Kütüphaneyi aç",
    saveShortcutHint: "Kaydet: {shortcut}",
  },
  organize: {
    title: "Düzenle",
    noteLabel: "Kişisel not",
    notePlaceholder: "Not ekle…",
    addTagLabel: "Etiket ekle",
    addTagPlaceholder: "Etiket ekle…",
    addTagButton: "Etiket ekle",
    collectionLabel: "Koleksiyon",
    unorganized: "Düzenlenmemiş",
  },
  sync: {
    notSignedIn: "Giriş yapılmadı",
    syncing: "Senkronize ediliyor…",
    offlineWaiting: { one: "Çevrimdışı · {count} bekliyor", other: "Çevrimdışı · {count} bekliyor" },
    error: "Senkronizasyon hatası",
    synced: "Senkronize edildi",
    signInButton: "Senkronize etmek için giriş yap",
  },
  errors: {
    openLinkFailed: "Bu bağlantı açılamadı.",
    saveFailed: "Bu sayfa kaydedilemedi.",
    removeFailed: "Bu yer imi kaldırılamadı.",
    syncStartFailed: "Senkronizasyon başlatılamadı.",
    readError: "Bu sayfa okunamadı.",
    saveChangesFailed: "Değişiklikler kaydedilemedi.",
  },
  toast: {
    removed: "Nook'tan kaldırıldı.",
    undo: "Geri al",
  },
} satisfies Messages["popup"];
