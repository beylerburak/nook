import { useEffect, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { BookmarkGlyph } from "../../../extension/src/app/dashboard/glyphs";
import { authClient, type AuthUser } from "./authClient";

// Adapted from the Astryx "Login Card" template (npx astryx template login-card
// --skeleton, run from apps/extension): dropped the third-party provider
// buttons and legal links (Nook is self-hosted email/password only, no
// OAuth), kept the elevated centered card, and added the sign-up toggle,
// inline error banner and busy state the real flow needs.

type Mode = "sign-in" | "sign-up";

export function AuthScreen({ onSignedIn }: { onSignedIn: (user: AuthUser) => Promise<void> | void }) {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [allowSignUp, setAllowSignUp] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/config")
      .then((response) => response.json())
      .then((config: { allowSignUp?: boolean }) => {
        if (!cancelled) setAllowSignUp(config.allowSignUp === true);
      })
      .catch(() => {
        // No network yet — the sign-up toggle just stays hidden until a
        // retry succeeds (the field below still triggers this effect once
        // on mount only, but a failed fetch is not fatal here).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = mode === "sign-up"
        ? await authClient.signUp.email({ name: name.trim(), email: email.trim(), password })
        : await authClient.signIn.email({ email: email.trim(), password });
      if (response.error) {
        setError(response.error.message || "Could not sign in.");
        return;
      }
      const user = response.data?.user;
      if (!user) {
        setError("Could not sign in.");
        return;
      }
      await onSignedIn({ id: user.id, name: user.name, email: user.email, image: user.image ?? null });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const toggleMode = () => {
    setMode((current) => (current === "sign-in" ? "sign-up" : "sign-in"));
    setError(null);
  };

  return (
    <Center axis="both" padding={6}>
      <VStack gap={4} hAlign="center" width="100%" maxWidth={400}>
        <VStack gap={2} hAlign="center">
          <Icon icon={BookmarkGlyph} size="lg" color="accent" />
          <Text weight="bold" size="lg">Nook</Text>
          <Text color="secondary" type="supporting">Your visual library, available everywhere.</Text>
        </VStack>

        <Card padding={8} width="100%">
          <VStack gap={4} hAlign="stretch">
            <VStack gap={1} hAlign="center">
              <Heading level={2}>{mode === "sign-in" ? "Sign in" : "Create your account"}</Heading>
              <Text type="body" color="secondary" size="sm">
                {mode === "sign-in"
                  ? "Sign in to sync your library everywhere."
                  : "Set up the first Nook account on this server."}
              </Text>
            </VStack>

            {error ? (
              <Banner status="error" title={error} isDismissable onDismiss={() => setError(null)} />
            ) : null}

            <VStack gap={2}>
              {mode === "sign-up" ? (
                <TextInput label="Name" value={name} onChange={setName} isRequired size="lg" />
              ) : null}
              <TextInput
                label="Email"
                type="email"
                value={email}
                onChange={setEmail}
                autoComplete="email"
                isRequired
                size="lg"
              />
              <TextInput
                label="Password"
                type="password"
                value={password}
                onChange={setPassword}
                autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                onEnter={() => void submit()}
                isRequired
                size="lg"
              />
            </VStack>

            <HStack gap={2}>
              <Button
                label={mode === "sign-in" ? "Sign in" : "Create account"}
                variant="primary"
                size="lg"
                isLoading={busy}
                onClick={() => void submit()}
              />
              {allowSignUp ? (
                <Button
                  label={mode === "sign-in" ? "Create an account" : "I have an account"}
                  variant="ghost"
                  size="lg"
                  onClick={toggleMode}
                />
              ) : null}
            </HStack>
          </VStack>
        </Card>
      </VStack>
    </Center>
  );
}
