import type { Messages } from "../../types";

/** Turkish messages for the `web` namespace — must mirror ./../en/web.ts exactly. */
export const web = {
  meta: {
    title: "Nook — Önemli olanı kaydet",
  },

  boot: {
    loading: "Nook yükleniyor…",
  },

  auth: {
    tagline: "Görsel kütüphanen, her yerde yanında.",
    signInHeading: "Giriş yap",
    signUpHeading: "Hesabını oluştur",
    signInSubtitle: "Kütüphaneni her yerde senkronize etmek için giriş yap.",
    signUpSubtitle: "Bu sunucudaki ilk Nook hesabını oluştur.",
    nameLabel: "İsim",
    emailLabel: "E-posta",
    passwordLabel: "Şifre",
    signInButton: "Giriş yap",
    createAccountButton: "Hesap oluştur",
    switchToSignUp: "Hesap oluştur",
    switchToSignIn: "Zaten hesabım var",

    errorSignInFailed: "Giriş yapılamadı.",
    errorNetwork: "Giriş yapılamadı. Bağlantını kontrol edip tekrar dene.",
    errorGeneric: "Bir şeyler ters gitti. Lütfen tekrar dene.",
    errorInvalidCredentials: "E-posta veya şifre hatalı.",
    errorUserExists: "Bu e-posta adresiyle bir hesap zaten var.",
    errorPasswordTooShort: "Şifre çok kısa.",
    errorPasswordTooLong: "Şifre çok uzun.",
    errorInvalidEmail: "Geçerli bir e-posta adresi gir.",
    requestFailed: "İstek başarısız oldu.",
  },

  extension: {
    connected: "Nook eklentisi bu hesaba bağlandı.",
    connectFailed: "Eklenti bağlanamadı.",
    notInstalled: "Nook eklentisi yüklü değil.",
    notReachable: "Nook eklentisine ulaşılamıyor.",
    signInFirst: "Eklentiyi bağlamadan önce giriş yap.",
    differentAccount: "Eklenti farklı bir Nook hesabına giriş yapmış.",
  },
} satisfies Messages["web"];
