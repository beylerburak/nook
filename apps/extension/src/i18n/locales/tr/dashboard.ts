import type { Messages } from "../../types";

/** Turkish messages for the `dashboard` namespace — must mirror ./../en/dashboard.ts exactly. */
export const dashboard = {
  itemCount: {
    // Turkish nouns don't inflect for plural count the way English does —
    // the numeral alone carries that, so `one` and `other` read the same.
    one: "{count} kayıtlı öğe",
    other: "{count} kayıtlı öğe",
  },

  views: {
    all: "Tüm yer imleri",
    x: "X yer imleri",
    web: "Web sayfaları",
    unorganized: "Düzenlenmemiş",
    organize: "Düzenle",
    collectionFallback: "Koleksiyon",
  },

  topNav: {
    ariaLabel: "Nook ana gezinme",
    subheading: "Görsel kütüphanen",
  },

  sideNav: {
    ariaLabel: "Kütüphane gezinmesi",
    libraryTitle: "Kütüphane",
    collectionsTitle: "Koleksiyonlar",
    createCollection: "Koleksiyon oluştur",
    noCollections: "Kaydedilen öğeleri düzenlemek için bir koleksiyon oluştur.",
    deleteCollection: "{name} koleksiyonunu sil",
    tagsTitle: "Etiketler",
    noTags: "Eklediğin etiketler burada görünür.",
  },

  toolbar: {
    ariaLabel: "Yer imi arama ve görünüm",
    bookmarkViewLabel: "Yer imi görünümü",
  },

  search: {
    label: "Yer imlerinde ara",
    placeholder: "Yer imlerinde, @yazarlarda, #etiketlerde ara…",
    semanticLabel: "Anlamsal",
    semanticDetail: "Yalnızca kelime eşleşmesine değil, anlama göre sıralandı.",
    keywordLabel: "Anahtar kelime eşleşmesi",
    signedOutDetail: "Kütüphaneni kelimeye ek olarak anlama göre de aramak için giriş yap.",
    offlineDetail: "Çevrimdışısın — bu cihazda kayıtlı olanlar aranıyor.",
    unsearchableDetail: "Kütüphanende kelime olarak da anlam olarak da eşleşen başka bir şey yok.",
    countWithQuery: {
      one: "“{query}” için {count} kayıtlı öğe",
      other: "“{query}” için {count} kayıtlı öğe",
    },
    countWithQueryTotal: {
      one: "“{query}” için {total} sonuçtan {shown} tanesi",
      other: "“{query}” için {total} sonuçtan {shown} tanesi",
    },
  },

  viewMode: {
    cards: "Kartlar",
    table: "Tablo",
  },

  mediaFilter: {
    all: "Tümü",
    media: "Medyalı",
    text: "Yalnızca metin",
    notesOnly: "Notlu",
  },

  sort: {
    ariaLabel: "Yer imlerini sırala",
    newest: "En yeni önce",
    oldest: "En eski önce",
  },

  states: {
    loading: "Kütüphanen yükleniyor…",
  },

  badge: {
    saved: "{count} kayıtlı",
  },

  pagination: {
    cardPages: "Yer imi kartı sayfaları",
    tablePages: "Yer imi tablosu sayfaları",
  },

  lightbox: {
    savedMediaAlt: "Kaydedilen medya",
  },

  emptyState: {
    libraryReadyTitle: "Kütüphanen hazır",
    libraryReadyDescription: "X'te bir gönderi ya da bir web sayfası kaydet. Nook onu burada saklar.",
    noResultsForQuery: "“{query}” için sonuç yok",
    noMatchingBookmarks: "Eşleşen yer imi yok",
    stillLookingDescription: "Kelime olarak eşleşen yok — anlam olarak hâlâ aranıyor.",
    nothingMatchesDescription: "Kütüphanende kelime olarak da anlam olarak da eşleşen yok.",
    tryAnotherSearchDescription: "Başka bir arama dene ya da geçerli filtreyi temizle.",
    showAllBookmarks: "Tüm yer imlerini göster",
  },

  viewOptions: {
    label: "Görünüm seçenekleri",
    columns: {
      title: "Sütunlar",
      displayed: "Görünen sütunlar",
      available: "Kullanılabilir sütunlar",
      restore: "Sıfırla",
      selectAll: "Tümünü seç",
      emptyDisplayed: "Görünen sütun yok.",
      emptyAvailable: "Tüm sütunlar görünüyor.",
      required: "Bu sütun zorunludur",
      reorder: "{column} sütununu yeniden sırala",
      reorderHint: "Yeniden sıralamak için yukarı/aşağı ok tuşlarını kullan veya sürükle.",
      remove: "{column} sütununu kaldır",
      add: "{column} sütununu ekle",
    },
    density: "Yoğunluk",
    densityOptions: {
      compact: "Sıkı",
      balanced: "Rahat",
      spacious: "Geniş",
    },
    sticky: "Sabit sütunlar",
    stickyStart: "Baştan sabitle",
    stickyEnd: "Sondan sabitle",
    stickyNone: "Yok",
    stickyOne: "Bir sütun",
    stickyTwo: "İki sütun",
    grouping: "Grupla",
    groupingNone: "Gruplama yok",
  },

  shared: {
    quotedPost: "Alıntılanan gönderi",
    delete: "Sil",
    saveNote: "Notu kaydet",
  },

  card: {
    videoHint: "Video — {text}",
    unknownAuthor: "Bilinmeyen yazar",
    yourNote: "Notun",
    openQuotedPost: "Alıntılanan gönderiyi aç",
    quotedPostMedia: "Alıntılanan gönderi medyası {index}",
    mediaPreview: "{type} önizlemesi {index}",
    openSource: "Kaynağı aç",
    details: "Detaylar",
    copy: "Kopyala",

    suggestedCollection: "Öneri: {name}",
    acceptSuggestion: "Öneriyi kabul et",
    dismissSuggestion: "Öneriyi reddet",
  },

  detail: {
    closeDetails: "Detayları kapat",
    mediaAlt: "{title} medyası {index}",
    mediaLabel: "Medya {index}",
    personalNoteLabel: "Kişisel not",
    notePlaceholder: "Bir düşünce ya da hatırlatma ekle…",
    addTagLabel: "Etiket ekle",
    tagPlaceholder: "örn. ilham",
    addTag: "Etiket ekle",
    removeTag: "#{tag} etiketini kaldır",
    suggestedTags: "Önerilen etiketler",
    collectionLabel: "Koleksiyon",
    openPage: "Sayfayı aç",
    openOnX: "X'te aç",
    copyUrl: "URL'yi kopyala",
    panelLabel: "{title} detayları",
    webBookmarkFallback: "Web yer imi",
    xPostFallback: "X gönderisi",
  },

  dialogs: {
    createCollectionTitle: "Koleksiyon oluştur",
    createCollectionSubtitle: "İlgili yer imlerini bir arada tut.",
    collectionNameLabel: "Koleksiyon adı",
    collectionNamePlaceholder: "örn. Tasarım referansları",
    collectionIconLabel: "Koleksiyon simgesi",
    createCollection: "Koleksiyon oluştur",
    deleteCollectionTitle: "{name} silinsin mi?",
    deleteCollectionFallbackName: "koleksiyon",
    deleteCollectionSubtitle: "Bu koleksiyondaki yer imleri düzenlenmemiş duruma geçecek.",
    deleteCollection: "Koleksiyonu sil",
  },

  toast: {
    noteSaved: "Not kaydedildi.",
    couldNotOpenLink: "Bu bağlantı açılamadı.",
    copiedToClipboard: "Panoya kopyalandı.",
    couldNotCopyToClipboard: "Panoya kopyalanamadı.",
    urlCopied: "URL kopyalandı.",
    couldNotCopyUrl: "URL kopyalanamadı.",
    bookmarksExported: "Yer imleri dışa aktarıldı.",
    couldNotLoadBookmarks: "Yer imleri yüklenemedi.",
    importedCount: {
      one: "{count} yer imi içe aktarıldı.",
      other: "{count} yer imi içe aktarıldı.",
    },
    couldNotImportFile: "Bu JSON dosyası içe aktarılamadı.",
    couldNotSaveChanges: "Değişiklikler kaydedilemedi.",
    bookmarkDeleted: "Yer imi silindi.",
    couldNotDeleteBookmark: "Bu yer imi silinemedi.",
    collectionCreated: "Koleksiyon oluşturuldu.",
    couldNotCreateCollection: "Bu koleksiyon oluşturulamadı.",
    collectionDeleted: "Koleksiyon silindi.",
    couldNotDeleteCollection: "Bu koleksiyon silinemedi.",
    bookmarksCleared: "Yer imleri temizlendi.",
    couldNotClearBookmarks: "Yer imleri temizlenemedi.",
  },

  savedToast: {
    addANote: "Not ekle",
    noteLabel: "Not",
    notePlaceholder: "Ne hatırlamak istersin?",
    noteSaved: "Not kaydedildi",
    couldNotSaveNote: "Bu not kaydedilemedi.",
  },

  syncStatus: {
    localOnly: "Yalnızca yerel",
    localOnlyDetail: "Kütüphaneni cihazlar arasında senkronize etmek için web uygulamasından giriş yap.",
    offline: "Çevrimdışı ({count} bekliyor)",
    offlineDetailPending: {
      one: "{count} değişiklik tekrar çevrimiçi olduğunda senkronize edilecek.",
      other: "{count} değişiklik tekrar çevrimiçi olduğunda senkronize edilecek.",
    },
    offlineDetailNone: "Çevrimdışısın. Değişiklikler tekrar çevrimiçi olduğunda senkronize edilecek.",
    syncing: "Senkronize ediliyor…",
    syncingDetail: "Kütüphanen şu anda senkronize ediliyor.",
    syncError: "Senkronizasyon hatası",
    syncErrorDetail: {
      one: "{count} öğe senkronize edilemedi.",
      other: "{count} öğe senkronize edilemedi.",
    },
    synced: "Senkronize edildi",
    syncedDetailWithDate: "Son senkronizasyon: {date}.",
    syncedDetailDefault: "Kütüphanen güncel.",
  },

  userMenu: {
    accountFallback: "Hesap",
    profile: "Profil",
    settings: "Ayarlar",
    signOut: "Çıkış yap",
    openWebApp: "Web uygulamasını aç",
    signInToSync: "Senkronize etmek için giriş yap",
    signOutConfirmTitle: "Senkronize edilmemiş değişikliklerle çıkış yapılsın mı?",
    signOutConfirmDescription: {
      one: "{count} değişiklik henüz senkronize edilmedi. Şimdi çıkış yaparsan senkronize edilmemiş kalabilir.",
      other: "{count} değişiklik henüz senkronize edilmedi. Şimdi çıkış yaparsan senkronize edilmemiş kalabilir.",
    },
  },

  appearanceMenu: {
    label: "Görünüm",
    light: "Açık",
    dark: "Koyu",
  },

  table: {
    ariaLabel: "Kaydedilen yer imleri",
    bookmarkHeader: "Yer imi",
    sourceHeader: "Kaynak",
    savedHeader: "Kaydedildi",
    collectionHeader: "Koleksiyon",
    tagsHeader: "Etiketler",
    noteHeader: "Not",
    actionsHeader: "İşlemler",
    sourceWeb: "Web",
    open: "Aç",
    empty: "Gösterilecek yer imi yok.",
  },

  canvasEditor: {
    resizeHandleLabel: "Yer imi detay panelini yeniden boyutlandır",
    defaultInspectorLabel: "Yer imi detayları",
  },

  organize: {
    title: "Kütüphaneni düzenle",
    description: "Nook, dosyalanmamış yer imlerini kendi başına gruplara ayırır. Bulduklarını gözden geçir, işine yarayanları tut, gerisini Nook dosyalasın.",

    filedCount: { one: "{count} yer imi dosyalandı", other: "{count} yer imi dosyalandı" },
    unfiledCount: { one: "{count} tanesi düzenlenmeyi bekliyor", other: "{count} tanesi düzenlenmeyi bekliyor" },

    workingTitle: "Nook düzenliyor",
    workingBody: {
      one: "Yaklaşık {count} yer imi kaldı — yaklaşık {minutes} dk.",
      other: "Yaklaşık {count} yer imi kaldı — yaklaşık {minutes} dk.",
    },
    autoFileEnabledNote: "Dosyalama da açıldı, yeni yer imleri de düzenlenmeye devam edecek.",

    recentlyFiledTitle: "Son dosyalananlar",
    recentlyFiledEmpty: "Henüz bir şey dosyalanmadı.",
    remainderNoneFit: {
      one: "{count} yer imi hiçbir koleksiyona uymadı.",
      other: "{count} yer imi hiçbir koleksiyona uymadı.",
    },
    remainderUnsure: {
      one: "{count} tanesi yaklaştı ama güven ayarının altında kaldı.",
      other: "{count} tanesi yaklaştı ama güven ayarının altında kaldı.",
    },

    openAiSettings: "Yapay zekâ ayarları",
    suggestTagsTrigger: "Etiket öner",

    empty: {
      title: "Her şey düzenlendi",
      suggestAgain: "Yeniden öner",
    },

    clusters: {
      cta: { one: "Dosyalanmamış {count} yer imin için grup bul.", other: "Dosyalanmamış {count} yer imin için grup bul." },
      button: "Koleksiyon öner",
      buttonTooltip: "Nook, dosyalanmamış yer imlerine bakıp onları gruplar.",
      signedOutTooltip: "Grup önerisi almak için giriş yap.",
      reading: "Gruplar aranıyor",
      readingBody: "Dosyalanmamış yer imlerine bakılıyor…",
      nothingNew: "Şu an önerilecek yeni bir şey yok.",
      nothingToRead: "Bakılacak dosyalanmamış yer imi yok. Birkaç yer imi kaydedip tekrar dene.",

      nameLabel: "Koleksiyon adı",
      renameAction: "Yeniden adlandır",
      showAll: "Tümünü göster ({count})",
      showLess: "Daha az göster",
      selectAll: "Tümünü seç",
      selectNone: "Hiçbirini seçme",
      existingBadge: "{name} koleksiyonuna eklenir",

      collectionsCount: { one: "{count} koleksiyon", other: "{count} koleksiyon" },
      bookmarksCount: { one: "{count} yer imi", other: "{count} yer imi" },
      createLabel: "{collections} oluştur ve {bookmarks} dosyala",
      fileOnlyLabel: "{bookmarks} dosyala",
      consideredNote: { one: "Nook dosyalanmamış {count} yer imine baktı.", other: "Nook dosyalanmamış {count} yer imine baktı." },
      nothingSelected: "Oluşturmak için en az bir grup seç.",

      unclusteredNote: {
        one: "{count} yer imi belirgin bir grup oluşturmadı — aşağıdan elle dosyalayabilir ya da sonra tekrar önerebilirsin.",
        other: "{count} yer imi belirgin bir grup oluşturmadı — aşağıdan elle dosyalayabilir ya da sonra tekrar önerebilirsin.",
      },

      acceptedToast: {
        one: "{collections} oluşturuldu ve {count} yer imi dosyalandı.",
        other: "{collections} oluşturuldu ve {count} yer imi dosyalandı.",
      },
    },

    review: {
      heading: "Gözden geçirmen gerekenler",
      description: "Nook bunlardan tam emin olamadı — bir göz at.",
      likely: "Muhtemel",
      maybe: "Belki",
      accept: "Kabul et",
      reject: "Reddet",
      moveTo: "Şuraya taşı…",
      acceptAllLikely: "Muhtemel olanları kabul et",
      resolvedToast: {
        one: "{count} yer imi dosyalandı.",
        other: "{count} yer imi dosyalandı.",
      },
      dismissedToast: {
        one: "{count} tanesi reddedildi.",
        other: "{count} tanesi reddedildi.",
      },
      loadFailed: "Gözden geçirme listesi yüklenemedi.",
      actionFailed: "Bu kaydedilemedi — tekrar dene.",
    },
  },
} satisfies Messages["dashboard"];
