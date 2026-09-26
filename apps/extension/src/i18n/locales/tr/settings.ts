import type { Messages } from "../../types";

/** Turkish messages for the `settings` namespace — must mirror ./../en/settings.ts exactly. */
export const settings = {
  appearance: {
    themeSectionTitle: "Tema",
    appearanceRowTitle: "Görünüm",
    appearanceRowDescription: "Sistemine uysun ya da açık veya koyu temayı seç.",
    modeLight: "Açık",
    modeDark: "Koyu",

    languageSectionTitle: "Dil",
    languageRowTitle: "Dil",
    languageRowDescription: "Nook'un hangi dilde görüneceğini seç.",
    languageEnglish: "English",
    languageTurkish: "Türkçe",
  },

  sections: {
    profile: { label: "Profil", description: "Adın, fotoğrafın ve hesap bilgilerin." },
    account: { label: "Hesap ve güvenlik", description: "Şifre, oturumlar ve hesap silme." },
    appearance: { label: "Görünüm", description: "Nook'un bu cihazda nasıl görüneceğini seç." },
    sync: { label: "Senkronizasyon", description: "Bulut senkronizasyon durumu ve tarayıcı eklentisi bağlantısı." },
    ai: { label: "Yapay zekâ", description: "Kütüphaneni yapay zekâ ile düzenle, özetle ve ara." },
    data: { label: "Veri", description: "Kütüphaneni içe aktar, dışa aktar veya temizle." },
    about: { label: "Hakkında", description: "Sürüm ve uygulama bilgileri." },
  },

  dialog: {
    title: "Ayarlar",
    sectionsLabel: "Ayar bölümleri",
  },

  account: {
    passwordSectionTitle: "Şifre",
    currentPasswordLabel: "Mevcut şifre",
    newPasswordLabel: "Yeni şifre",
    newPasswordHint: "En az 8 karakter.",
    confirmPasswordLabel: "Yeni şifreyi onayla",
    passwordMismatch: "Şifreler eşleşmiyor.",

    signOutOtherSessions: "Diğer oturumları kapat",
    signOutOtherSessionsHint: "Giriş yapmış olduğun diğer her yer.",
    signOutOtherSessionsConfirmTitle: "Diğer oturumlar kapatılsın mı?",
    signOutOtherSessionsConfirmDescription: "Hesabına giriş yapılmış diğer tüm cihazların oturumu kapatılacak.",
    otherSessionsSignedOutToast: "Diğer oturumlar kapatıldı.",
    otherSessionsSignOutError: "Diğer oturumlar kapatılamadı.",

    updatePasswordButton: "Şifreyi güncelle",
    passwordUpdatedToast: "Şifre güncellendi.",
    passwordUpdateError: "Şifren güncellenemedi. Mevcut şifreni kontrol et.",

    activeSessionsTitle: "Aktif oturumlar",
    loadSessionsError: "Aktif oturumlar yüklenemedi.",
    loadingSessions: "Oturumlar yükleniyor…",
    noSessionsFound: "Oturum bulunamadı.",
    activeLabel: "Aktif",
    signedInLabel: "Giriş tarihi",
    thisDeviceLabel: "Bu cihaz",

    signOut: "Çıkış yap",
    signOutOfNookDescription: "Bu cihazda Nook'tan çıkış yap.",
    signOutConfirmTitle: "Çıkış yapılsın mı?",
    signOutAnyway: "Yine de çıkış yap",
    signOutError: "Çıkış yapılamadı.",
    unsyncedChangesWarning: {
      one: "Henüz senkronize olmamış 1 değişikliğin var. Şimdi çıkış yaparsan bu cihazda kaybolabilir.",
      other: "Henüz senkronize olmamış {count} değişikliğin var. Şimdi çıkış yaparsan bu cihazda kaybolabilirler.",
    },

    signOutSessionAria: "Oturumu kapat: {title}",
    signOutSessionConfirmTitle: "Bu oturum kapatılsın mı?",
    signOutSessionConfirmDescription: "Hesabından şu oturum çıkış yaptırılacak: {title}.",
    sessionSignedOutToast: "Oturum kapatıldı.",
    sessionSignOutError: "O oturum kapatılamadı.",

    dangerZoneTitle: "Tehlikeli bölge",
    deleteAccount: "Hesabı sil",
    deleteAccountDescription: "Hesabını ve ona senkronize edilmiş her şeyi kalıcı olarak siler.",
    deleteAccountConfirmTitle: "Hesabın silinsin mi?",
    deleteAccountConfirmSubtitle: "Bu işlem geri alınamaz. Onaylamak için şifreni gir.",
    passwordLabel: "Şifre",
    deleteAccountError: "Hesabın silinemedi. Şifreni kontrol et.",
  },

  sync: {
    stateSynced: "Senkronize edildi",
    stateSyncing: "Senkronize ediliyor…",
    stateOffline: "Çevrimdışı",
    stateError: "Senkronizasyon hatası",
    stateLocal: "Yalnızca bu cihazda",

    signInBannerTitle: "Cihazlar arasında senkronize etmek için giriş yap",
    signInBannerDescription: "Kütüphaneni her yerde senkronize etmek için Nook'u web uygulamasından hesabına bağla.",
    signIn: "Giriş yap",

    checkingStatus: "Senkronizasyon durumu kontrol ediliyor…",
    pendingChangesDescription: {
      one: "Senkronize olmayı bekleyen 1 değişiklik var.",
      other: "Senkronize olmayı bekleyen {count} değişiklik var.",
    },

    statusSectionTitle: "Durum",
    syncNow: "Şimdi senkronize et",
    lastSyncedLabel: "Son senkronizasyon",
    never: "Hiç",
    pendingChangesLabel: "Bekleyen değişiklikler",
    syncRequestedToast: "Senkronizasyon istendi.",
    syncRequestError: "Senkronizasyon başlatılamadı.",

    rejectedSectionTitle: "Yüklenemedi",
    untitledItem: "Başlıksız",

    extensionSectionTitle: "Tarayıcı eklentisi",
    extensionChecking: "Kontrol ediliyor…",
    extensionNotInstalled: "Yüklü değil",
    extensionNotInstalledDescription: "Herhangi bir sayfadan kaydetmek için Nook tarayıcı eklentisini yükle.",
    extensionConnected: "Bağlandı",
    extensionSignedOut: "Çıkış yapılmış",
    extensionSignedOutDescription: "Tarayıcı eklentisi yüklü ama bu hesaba bağlı değil.",
    extensionOtherAccount: "Farklı hesap",
    extensionOtherAccountDescription: "Tarayıcı eklentisi başka bir hesaba bağlı.",
    extensionUnavailable: "Kullanılamıyor",
    extensionUnavailableDescription: "Eklenti durumu şu anda alınamıyor.",
    connect: "Bağlan",
    extensionConnectedToast: "Tarayıcı eklentisi bağlandı.",
    extensionConnectError: "Tarayıcı eklentisi bağlanamadı.",
  },

  data: {
    libraryTitle: "Kütüphane",
    bookmarksLabel: "Yer imleri",
    collectionsLabel: "Koleksiyonlar",

    importExportTitle: "İçe ve dışa aktarma",
    importLabel: "Yer imlerini içe aktar",
    importDescription: "Bir Nook JSON dışa aktarımı.",
    exportButton: "JSON olarak dışa aktar",
    importedToast: "Yer imleri içe aktarıldı.",
    importError: "O dosya içe aktarılamadı.",
    exportedToast: "Yer imleri dışa aktarıldı.",

    dangerZoneTitle: "Tehlikeli bölge",
    clearAllTitle: "Tüm yer imlerini temizle",
    clearAllDescription: "Kayıtlı tüm öğeleri silinmiş duruma taşır. Koleksiyonlar kalır.",
    clearAllButton: "Tümünü temizle",
    clearAllConfirmTitle: "Tüm yer imleri temizlensin mi?",
    clearAllConfirmDescription: "Kayıtlı öğeler silinmiş duruma taşınacak. Koleksiyonlar kalacak.",
    clearedToast: "Yer imleri temizlendi.",
    clearError: "Kütüphanen temizlenemedi.",
  },

  profile: {
    basicsTitle: "Temel bilgiler",
    nameLabel: "Ad",
    nameShownDescription: "Nook genelinde görünür.",
    emailLabel: "E-posta",
    emailReadOnlyDescription: "Salt okunur.",
    updatedToast: "Profil güncellendi.",
    updateError: "Profilin güncellenemedi.",
    detailsTitle: "Ayrıntılar",
    memberSinceLabel: "Üyelik tarihi",
    manageOnWeb: "Hesabı web'de yönet",
  },

  about: {
    tagline: "Önemli olanı kaydet.",
    versionLabel: "Sürüm",
  },

  sessions: {
    unknownDevice: "Bilinmeyen cihaz",
    unknownBrowserOn: "Bilinmeyen tarayıcı · {os}",
    deviceOn: "{browser} · {os}",
  },
} satisfies Messages["settings"];
