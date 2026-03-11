"use client";

import Image from "next/image";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth, useLanguage } from "@/providers";

type AuthMode = "sign-in" | "sign-up";

export function AuthScreen() {
  const { login, register } = useAuth();
  const { t } = useLanguage();

  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isSignUp = mode === "sign-up";

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    setError(null);
    setIsSubmitting(true);

    try {
      if (isSignUp) {
        await register({
          name: name.trim(),
          email: email.trim(),
          password,
        });
      } else {
        await login({
          email: email.trim(),
          password,
        });
      }

      setPassword("");
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : t("auth.error.default")
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleMode = () => {
    setError(null);
    setMode((currentMode) =>
      currentMode === "sign-in" ? "sign-up" : "sign-in"
    );
  };

  return (
    <div className="min-h-screen bg-[#f3efe7] text-[#171717]">
      <div className="mx-auto grid min-h-screen w-full max-w-7xl items-center gap-8 px-4 py-8 lg:grid-cols-[1.05fr_0.95fr] lg:px-8">
        <section className="hidden lg:block">
          <div className="rounded-4xl border border-black/10 bg-[#171717] p-10 text-[#f5f1e8] shadow-[0_24px_80px_rgba(0,0,0,0.12)]">
            <div className="mb-10 inline-flex items-center gap-3 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/75">
              <Image
                alt="KIWI Logo"
                className="h-8 w-8 rounded-lg"
                src="/KIWI.jpg"
                width={32}
                height={32}
                unoptimized
              />
              <span className="font-medium tracking-[0.2em] text-white">
                KIWI
              </span>
            </div>

            <p className="text-sm uppercase tracking-[0.24em] text-[#b18b53]">
              OFFIS e. V.
            </p>
            <h1 className="mt-4 max-w-lg text-5xl font-semibold leading-[1.05] tracking-tight text-balance">
              Wissensprojekte klar organisiert, statt dekorativ ueberinszeniert.
            </h1>
            <p className="mt-6 max-w-lg text-lg leading-8 text-white/68">
              {t("auth.description")}
            </p>

            <div className="mt-12 space-y-5 border-t border-white/10 pt-8">
              <div className="flex items-start justify-between gap-6">
                <span className="text-sm uppercase tracking-[0.22em] text-white/40">
                  Zugriff
                </span>
                <p className="max-w-sm text-right text-sm leading-6 text-white/72">
                  Authentifiziert fuer Gruppen, Projekte und Rollen im
                  KIWI-System.
                </p>
              </div>
              <div className="flex items-start justify-between gap-6 border-t border-white/10 pt-5">
                <span className="text-sm uppercase tracking-[0.22em] text-white/40">
                  Fokus
                </span>
                <p className="max-w-sm text-right text-sm leading-6 text-white/72">
                  Reduziertes Layout, gleiche Markenbasis wie in der Sidebar.
                </p>
              </div>
              <div className="flex items-start justify-between gap-6 border-t border-white/10 pt-5">
                <span className="text-sm uppercase tracking-[0.22em] text-white/40">
                  Zweck
                </span>
                <p className="max-w-sm text-right text-sm leading-6 text-white/72">
                  Schnell anmelden und direkt in die Arbeitsoberflaeche
                  wechseln.
                </p>
              </div>
            </div>
          </div>
        </section>

        <div className="flex items-center justify-center">
          <Card className="w-full max-w-md border-black/10 bg-[#fbfaf7] text-[#171717] shadow-[0_24px_80px_rgba(0,0,0,0.08)]">
            <CardHeader className="space-y-6">
              <div className="flex items-center gap-4">
                <Image
                  alt="KIWI Logo"
                  className="h-14 w-14 rounded-2xl shadow-sm"
                  src="/KIWI.jpg"
                  width={56}
                  height={56}
                  unoptimized
                />
                <div>
                  <p className="text-sm font-medium uppercase tracking-[0.24em] text-[#8b8375]">
                    KIWI
                  </p>
                  <CardTitle className="mt-1 text-3xl">
                    {isSignUp ? t("auth.sign.up") : t("auth.sign.in")}
                  </CardTitle>
                </div>
              </div>

              <CardDescription className="text-sm leading-6 text-[#5f5a51]">
                {t("auth.description")}
              </CardDescription>

              <div className="grid grid-cols-2 rounded-xl border border-black/8 bg-[#f0ebe2] p-1">
                <Button
                  className="rounded-lg shadow-none"
                  onClick={() => {
                    setError(null);
                    setMode("sign-in");
                  }}
                  type="button"
                  variant={isSignUp ? "ghost" : "default"}
                >
                  {t("auth.sign.in")}
                </Button>
                <Button
                  className="rounded-lg shadow-none"
                  onClick={() => {
                    setError(null);
                    setMode("sign-up");
                  }}
                  type="button"
                  variant={isSignUp ? "default" : "ghost"}
                >
                  {t("auth.sign.up")}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <form className="space-y-4" onSubmit={handleSubmit}>
                {isSignUp ? (
                  <div className="space-y-2">
                    <Label htmlFor="auth-name">{t("auth.name")}</Label>
                    <Input
                      id="auth-name"
                      autoComplete="name"
                      className="border-black/10 bg-white"
                      placeholder={t("auth.name.placeholder")}
                      required
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </div>
                ) : null}

                <div className="space-y-2">
                  <Label htmlFor="auth-email">{t("auth.email")}</Label>
                  <Input
                    id="auth-email"
                    autoComplete="email"
                    className="border-black/10 bg-white"
                    placeholder={t("auth.email.placeholder")}
                    required
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="auth-password">{t("auth.password")}</Label>
                  <Input
                    id="auth-password"
                    autoComplete={
                      isSignUp ? "new-password" : "current-password"
                    }
                    className="border-black/10 bg-white"
                    required
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </div>

                {error ? (
                  <p
                    className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
                    role="alert"
                  >
                    {error}
                  </p>
                ) : null}

                <Button
                  className="h-11 w-full bg-[#171717] text-[#f5f1e8] hover:bg-[#242424]"
                  disabled={isSubmitting}
                  type="submit"
                >
                  {isSignUp ? t("auth.sign.up") : t("auth.sign.in")}
                </Button>

                <Button
                  className="w-full text-[#6a6357]"
                  disabled={isSubmitting}
                  onClick={toggleMode}
                  type="button"
                  variant="ghost"
                >
                  {isSignUp
                    ? t("auth.switch.to.sign.in")
                    : t("auth.switch.to.sign.up")}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
