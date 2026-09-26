/**
 * English messages for the `web` namespace (web app shell, sign-in screen, landing page).
 * Composed into the catalog by ../en.ts — see docs/i18n.md.
 */
export const web = {
  meta: {
    /** Also mirrored (Turkish only) by the script-free landing page, apps/web/index.html — see docs/i18n.md's web app note. */
    title: "Nook — Save what matters",
  },

  boot: {
    /** Shown full-screen while the session is resolving, and again during the brief redirect frame between routes. */
    loading: "Loading Nook…",
  },

  auth: {
    tagline: "Your visual library, available everywhere.",
    signInHeading: "Sign in",
    signUpHeading: "Create your account",
    signInSubtitle: "Sign in to sync your library everywhere.",
    signUpSubtitle: "Set up the first Nook account on this server.",
    nameLabel: "Name",
    emailLabel: "Email",
    passwordLabel: "Password",
    signInButton: "Sign in",
    createAccountButton: "Create account",
    switchToSignUp: "Create an account",
    switchToSignIn: "I have an account",

    /** Better Auth returned an error with no usable message. */
    errorSignInFailed: "Could not sign in.",
    /** The sign-in/sign-up request itself never reached the server (offline, DNS, CORS). */
    errorNetwork: "Could not sign in. Check your connection and try again.",
    /** A Better Auth error code we don't map below — keep this free of any server detail. */
    errorGeneric: "Something went wrong. Please try again.",
    /** Better Auth "INVALID_EMAIL_OR_PASSWORD". */
    errorInvalidCredentials: "Incorrect email or password.",
    /** Better Auth "USER_ALREADY_EXISTS" / "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL". */
    errorUserExists: "An account with this email already exists.",
    /** Better Auth "PASSWORD_TOO_SHORT". */
    errorPasswordTooShort: "Password is too short.",
    /** Better Auth "PASSWORD_TOO_LONG". */
    errorPasswordTooLong: "Password is too long.",
    /** Better Auth "INVALID_EMAIL". */
    errorInvalidEmail: "Enter a valid email address.",
    /** Generic fallback for a failed account-management call (change password, sessions, delete account, …). */
    requestFailed: "The request failed.",
  },

  extension: {
    connected: "Nook extension connected to this account.",
    connectFailed: "Could not connect the extension.",
    notInstalled: "Nook extension not installed.",
    notReachable: "Nook extension not reachable.",
    signInFirst: "Sign in before connecting the extension.",
    differentAccount: "The extension is signed in to a different Nook account.",
  },
} as const;
