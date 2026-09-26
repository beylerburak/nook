import type { Messages } from "../../types";

/** Turkish messages for the `extension` namespace — must mirror ./../en/extension.ts exactly. */
export const extension = {
  meta: {
    dashboardTitle: "Nook — Web'deki sessiz köşen",
  },
  contextMenu: {
    savePage: "Sayfayı Nook'a kaydet",
    saveLink: "Bağlantıyı Nook'a kaydet",
    saveImage: "Görseli Nook'a kaydet",
  },
  toast: {
    pageSavedWithImage: 'Nook: "{site}" görselle kaydedildi ✓',
    pageSavedToBookmarks: 'Nook: "{site}" yer imlerine kaydedildi ✓',
    tweetSaved: "Nook'a kaydedildi ✓",
    bookmarkSavedWithMedia: { one: "Nook: {count} medya ile kaydedildi ✓", other: "Nook: {count} medya ile kaydedildi ✓" },
    bookmarkSaved: "Nook: Yer imlerine kaydedildi ✓",
  },
  xButton: {
    save: "Nook'a kaydet",
    saved: "Nook'a kaydedildi",
    removed: "Nook'tan kaldırıldı",
    toggleFailed: "Nook yer imi güncellenemedi",
    extensionUpdated: "Nook güncellendi. Lütfen sayfayı yenileyin (F5) 🔄",
  },
  media: {
    videoThumbnail: "Video küçük resmi",
    linkPreview: "Bağlantı önizlemesi",
  },
  sync: {
    title: "🔄 Nook Senkronizasyonu",
    fetchingAll: "Tüm yer imlerin getiriliyor…",
    starting: "Başlıyor…",
    fetchingQueryId: "Sorgu kimliği getiriliyor…",
    fetchingPage: "{page}. sayfa getiriliyor… ({count} yeni)",
    pageProgress: "{page}. sayfa — {newCount} yeni, {updatedCount} güncellendi",
    newBookmarksAdded: { one: "{count} yeni yer imi Nook'a eklendi.", other: "{count} yeni yer imi Nook'a eklendi." },
    bookmarksUpdated: {
      one: "{count} yer imi güncellendi (alıntı / medya).",
      other: "{count} yer imi güncellendi (alıntı / medya).",
    },
    syncedCount: { one: "Nook: {count} yer imi senkronize edildi ✓", other: "Nook: {count} yer imi senkronize edildi ✓" },
    done: "Tamamlandı",
    closingTab: "Sekme kapatılıyor…",
    error: "Hata",
    csrfMissing: "CSRF anahtarı (ct0) bulunamadı. X'te oturum açtınız mı?",
    queryIdMissing:
      "X Yer İmleri API sorgu kimliği bulunamadı. Lütfen önce x.com/i/bookmarks adresini elle açıp tekrar deneyin.",
  },
  errors: {
    backgroundNotResponding: "Nook'un arka plan servisi yanıt vermedi.",
    syncFailed: "Senkronizasyon başarısız oldu",
    noActiveTab: "Kaydedilecek aktif bir sekme yok",
    pageNotSavable: "Bu sayfa kaydedilemiyor",
    invalidItem: "Geçersiz öğe",
  },
} satisfies Messages["extension"];
