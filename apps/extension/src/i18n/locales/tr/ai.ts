import type { Messages } from "../../types";

/** Turkish messages for the `ai` namespace — must mirror ./../en/ai.ts exactly. */
export const ai = {
  loadingSettings: "Yapay zekâ ayarları yükleniyor…",

  intro: {
    text: "Nook yer imlerini koleksiyonlara ayırabilir, uzun sayfaları özetleyebilir ve anlamına göre arama yapabilir. Bunlar Nook sunucusunda çalışır, tarayıcın kapalıyken bile.",
    refresh: "Yenile",
    unavailableTitle: "Yapay zekâ bu sunucuda henüz kurulmadı",
    unavailableDescription: "Kurulana kadar bu özellikler çalışamaz.",
  },

  signIn: {
    title: "Yapay zekâ özelliklerini kullanmak için giriş yap",
    description: "Bu özellikler Nook sunucusunda çalışır, bu yüzden hesabına ihtiyaç duyar.",
    button: "Giriş yap",
  },

  organize: {
    title: "Kütüphaneni düzenle",
    step1Label: "Koleksiyon oluştur",
    step1Description: "Nook, dosyalanmamış yer imlerinden koleksiyon ve etiket önerir.",
    step2Label: "Yer imlerini otomatik dosyala",
    step2Description: "Yer imlerini yukarıdaki koleksiyon ve etiketlere dosyalar.",
  },

  suggest: {
    button: "Koleksiyon öner",
    buttonTooltip: "Nook dosyalanmamış yer imlerine bakar ve isim önerir.",
    signedOutTooltip: "Öneri istemek için giriş yap.",
    reading: "Kütüphanen taranıyor",
    readingBody: "Kütüphanen inceleniyor…",
    newCollections: "Yeni koleksiyonlar",
    newTags: "Yeni etiketler",
    newTagsDescription: "Nook emin olduğunda yeni yer imleri bu etiketleri kullanmaya başlayabilir.",
    alreadyCovered: "Yukarıdaki bir koleksiyon bunu zaten kapsıyor.",

    notAskedYet: "Henüz öneri istemedin.",
    acceptedNoneActive: "Daha önce öneri kabul ettin ama şu anda aktif olan yok.",
    acceptedSummary: "Şimdiye kadar {parts} kabul ettin.",

    sampleRead: {
      one: "Nook {count} yer imine baktı.",
      other: "Nook {count} yer imine baktı.",
    },
    reviewHintNoExisting: "İstemediğin bir şeyin işaretini kaldır.",
    reviewHintExisting: "Zaten {names} var — eşleşen isimler değiştirilmez.",

    collectionsCount: { one: "{count} koleksiyon", other: "{count} koleksiyon" },
    tagsCount: { one: "{count} etiket", other: "{count} etiket" },
    and: "ve",
    addLabel: "{parts} ekle",
    addedToast: "{parts} eklendi.",
    nothingAdded: "Hiçbir şey eklenmedi — hepsi zaten vardı.",
    keptExisting: {
      one: "{count} tanesi zaten kütüphanende vardı.",
      other: "{count} tanesi zaten kütüphanende vardı.",
    },
    collectionsAreReal: "Bunları istediğin zaman yeniden adlandırabilir veya silebilirsin.",

    nothingNew: "Şu anda önerecek yeni bir şey yok.",
    nothingToRead: "Henüz incelenecek yer imi yok. Birkaç yer imi kaydedip tekrar dene.",
  },

  autoFile: {
    description: "Sadece yeni yer imlerini değil, tüm kütüphaneni işler — emin olamadığı yer imlerine dokunmaz.",
    organizeButton: "Dosyalanmamış yer imlerini şimdi düzenle",
    tooltipNeitherOn: "Önce dosyalamayı veya özetlemeyi aç.",
    tooltipBusy: "Nook sunucusu bunu şimdi başlatıyor.",
    tooltipOn: "Hemen 25 yer imiyle başlar; geri kalanı birkaç dakika içinde takip eder.",
    nothingToOrganize: "Şu anda düzenlenecek bir şey yok.",
    working: {
      one: "{count} yer imi üzerinde çalışılıyor…",
      other: "{count} yer imi üzerinde çalışılıyor…",
    },
    filedResult: "{assigned} yer imi dosyalandı; Nook emin olamadığı {skipped} tanesine dokunmadı.",
    neverRun: "Nook henüz bir şey düzenlemedi.",
    startedToast: "Şimdi {parts} üzerinde çalışılıyor.",
    bookmarksToOrganize: { one: "{count} yer imi düzenlenecek", other: "{count} yer imi düzenlenecek" },
    pagesToSummarise: { one: "{count} sayfa özetlenecek", other: "{count} sayfa özetlenecek" },
  },

  summaries: {
    title: "Özetler",
    switchLabel: "Uzun sayfaları özetle",
    description: "Uzun sayfalar için kendi dillerinde kısa bir özet yazar.",
    privacyTrigger: "Neler gönderilir",
    privacyNote:
      "Bu, sayfanın 4.000 karaktere kadarını, başlığını ve notunu Nook'un yapay zekâ sağlayıcısına (OpenAI veya Google) gönderir. Dosyalama ve öneriler yalnızca başlık ve kısa önizleme gönderir.",
    countsRowTitle: "Kütüphanende",
    counts: {
      one: "{count} sayfanın özeti var, {pending} tanesi bekliyor.",
      other: "{count} sayfanın özeti var, {pending} tanesi bekliyor.",
    },
    off: "Bu kapalıyken hiçbir şey özetlenmez.",
    unknown: "—",
    lastRunLabel: "Son çalışma:",
  },

  search: {
    title: "Arama",
    rowTitle: "Anlamına göre arama",
    description: "Giriş yaptığında ve Nook sunucusu destekliyorsa otomatik olarak çalışır.",
  },

  advanced: {
    trigger: "Gelişmiş",
    collectionLabel: "Koleksiyon güveni",
    collectionDescription: "Yüksek değer, daha az ama daha doğru eşleşme demek.",
    tagLabel: "Etiket güveni",
    tagDescription: "Etiketler için de aynı mantık.",
    maxTagsLabel: "En fazla etiket",
    maxTagsDescription: "Bir yer iminin alabileceği en fazla etiket sayısı.",
    languageLabel: "Yeni isimler için dil",
    languageDescription: "Yeni koleksiyon ve etiketlerin hangi dilde yazılacağı.",
    languageAuto: "Kütüphaneme göre",
    reset: "Varsayılanlara sıfırla",
  },

  errors: {
    notAvailable: "Bu sunucuda henüz kullanılamıyor.",
    signedOut: "Oturumun sona erdi. Tekrar giriş yap.",
    throttled: "Nook sunucusu meşgul. Bir dakika sonra tekrar dene.",
    failed: "Bir şeyler ters gitti.",
    couldNotStart: "Bu başlatılamadı.",
    couldNotSaveSettings: "Ayarların kaydedilemedi.",
    couldNotAccept: "Bu koleksiyonlar veya etiketler oluşturulamadı.",
    couldNotAsk: "Öneriler için kütüphanene bakılamadı.",
  },

  status: {
    failed: "Başarısız",
    unavailable: "Kullanılamıyor",
    done: "Tamamlandı",
    nothingToDo: "Yapılacak bir şey yok",
    working: "Çalışıyor",
  },
} satisfies Messages["ai"];
