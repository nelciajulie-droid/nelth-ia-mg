"use client";

/**
 * Authentication view: signin / signup tabs plus the MFA sub-flows
 * (enroll with QR + manual key, verify, one-time recovery codes screen).
 *
 * API contract (all same-origin):
 *  POST /api/v1/auths/signin          {email,password}
 *  POST /api/v1/auths/signup          {name,email,password}
 *    → {next_step:'verify'|'enroll', challenge_token, expires_in}
 *      or a full session {token, id, email, name, role, ...} when MFA is off
 *  POST /api/v1/auths/mfa/enroll/start   {challenge_token} → {manual_key, qr_code}
 *  POST /api/v1/auths/mfa/enroll/confirm {challenge_token, code, recovery:false}
 *    → session + recovery_codes (shown once)
 *  POST /api/v1/auths/mfa/verify         {challenge_token, code, recovery}
 *    → session
 */

import * as React from "react";
import {
  ArrowLeft,
  Check,
  Copy,
  KeyRound,
  Loader2,
  LogIn,
  ShieldCheck,
  Sparkles,
  UserPlus,
  Wand2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api, ApiError } from "@/lib/api-client";
import {
  generateTotp,
  getDemoSecret,
  rememberDemoSecret,
  totpSecondsRemaining,
} from "@/lib/totp";
import {
  isSessionUser,
  type MfaEnrollStartResponse,
  type RecoveryCodesResponse,
  type SessionUser,
  type SigninResponse,
} from "@/lib/types";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type AuthStep = "credentials" | "enroll" | "verify" | "recovery";

export function AuthView({
  onAuthenticated,
}: {
  onAuthenticated: (session: SessionUser) => void;
}) {
  const { toast } = useToast();

  const [tab, setTab] = React.useState<"signin" | "signup">("signin");
  const [step, setStep] = React.useState<AuthStep>("credentials");

  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");

  const [challengeToken, setChallengeToken] = React.useState("");
  const [enrollData, setEnrollData] = React.useState<MfaEnrollStartResponse | null>(null);
  const [code, setCode] = React.useState("");
  const [useRecovery, setUseRecovery] = React.useState(false);
  const [recoveryCodes, setRecoveryCodes] = React.useState<string[]>([]);
  const [enrolledSession, setEnrolledSession] = React.useState<SessionUser | null>(null);

  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [copiedKey, setCopiedKey] = React.useState(false);
  const [copiedCodes, setCopiedCodes] = React.useState(false);
  const [secondsLeft, setSecondsLeft] = React.useState(totpSecondsRemaining());

  // Live TOTP window countdown while a code step is visible.
  React.useEffect(() => {
    if (step !== "enroll" && step !== "verify") return;
    const timer = window.setInterval(() => setSecondsLeft(totpSecondsRemaining()), 1000);
    return () => window.clearInterval(timer);
  }, [step]);

  const showError = (message: string) => {
    setError(message);
    toast({ title: "Authentication error", description: message, variant: "destructive" });
  };

  // -----------------------------------------------------------------------
  // Credentials → signin / signup
  // -----------------------------------------------------------------------

  async function handleCredentials(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const path = tab === "signin" ? "/api/v1/auths/signin" : "/api/v1/auths/signup";
      const body =
        tab === "signin" ? { email, password } : { name, email, password };
      const res = await api<SigninResponse>(path, {
        method: "POST",
        body,
        auth: false,
      });

      if (isSessionUser(res)) {
        onAuthenticated(res);
        return;
      }
      if (res.next_step === "pending") {
        setError("Your account is pending approval by an administrator.");
        return;
      }
      setChallengeToken(res.challenge_token);
      if (res.next_step === "verify") {
        setStep("verify");
      } else {
        await startEnrollment(res.challenge_token);
      }
    } catch (err) {
      showError(err instanceof ApiError || err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  // -----------------------------------------------------------------------
  // MFA enrollment
  // -----------------------------------------------------------------------

  async function startEnrollment(token: string) {
    const data = await api<MfaEnrollStartResponse>("/api/v1/auths/mfa/enroll/start", {
      method: "POST",
      body: { challenge_token: token },
      auth: false,
    });
    setEnrollData(data);
    setCode("");
    rememberDemoSecret(data.manual_key);
    setStep("enroll");
  }

  async function handleConfirmEnrollment(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await api<SessionUser & RecoveryCodesResponse>(
        "/api/v1/auths/mfa/enroll/confirm",
        {
          method: "POST",
          body: { challenge_token: challengeToken, code: code.trim(), recovery: false },
          auth: false,
        }
      );
      if (Array.isArray(res.recovery_codes) && res.recovery_codes.length > 0) {
        setRecoveryCodes(res.recovery_codes);
        setEnrolledSession(res);
        setStep("recovery");
      } else {
        onAuthenticated(res);
      }
    } catch (err) {
      showError(err instanceof ApiError || err instanceof Error ? err.message : "Enrollment failed");
    } finally {
      setBusy(false);
    }
  }

  // -----------------------------------------------------------------------
  // MFA verification (existing authenticator)
  // -----------------------------------------------------------------------

  async function handleVerify(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await api<SessionUser>("/api/v1/auths/mfa/verify", {
        method: "POST",
        body: {
          challenge_token: challengeToken,
          code: code.trim(),
          recovery: useRecovery,
        },
        auth: false,
      });
      onAuthenticated(res);
    } catch (err) {
      showError(err instanceof ApiError || err instanceof Error ? err.message : "Verification failed");
    } finally {
      setBusy(false);
    }
  }

  // -----------------------------------------------------------------------
  // Local TOTP autofill (demo convenience)
  // -----------------------------------------------------------------------

  async function autofillCode() {
    setError(null);
    try {
      const secret = enrollData?.manual_key ?? getDemoSecret();
      if (!secret) {
        setError(
          "No local secret available. Enter the code from your authenticator app, or sign up fresh to use autofill."
        );
        return;
      }
      const generated = await generateTotp(secret);
      setCode(generated);
      toast({ title: "Code generated locally", description: `Valid for ${secondsLeft}s` });
    } catch (err) {
      showError(err instanceof Error ? err.message : "Could not generate a code");
    }
  }

  async function copyText(text: string, label: string, setCopied: (v: boolean) => void) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
      toast({ title: `${label} copied to clipboard` });
    } catch {
      toast({ title: "Clipboard unavailable", variant: "destructive" });
    }
  }

  function resetToCredentials() {
    setStep("credentials");
    setCode("");
    setError(null);
    setEnrollData(null);
    setChallengeToken("");
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-stone-50 to-zinc-100">
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-md">
          <div className="mb-6 flex flex-col items-center gap-2 text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-600/20">
              <Sparkles className="size-7 text-white" aria-hidden />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
              Open WebUI
            </h1>
            <p className="text-sm text-zinc-500">
              v0.12.5 · TypeScript port — sign in to continue
            </p>
          </div>

          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-xl shadow-zinc-200/60 sm:p-8">
            {step === "credentials" && (
              <form onSubmit={handleCredentials} className="flex flex-col gap-4" noValidate>
                <Tabs
                  value={tab}
                  onValueChange={(value) => {
                    setTab(value as "signin" | "signup");
                    setError(null);
                  }}
                >
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="signin" className="gap-1.5">
                      <LogIn className="size-4" aria-hidden /> Sign in
                    </TabsTrigger>
                    <TabsTrigger value="signup" className="gap-1.5">
                      <UserPlus className="size-4" aria-hidden /> Sign up
                    </TabsTrigger>
                  </TabsList>
                </Tabs>

                {tab === "signup" && (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="auth-name">Name</Label>
                    <Input
                      id="auth-name"
                      autoComplete="name"
                      placeholder="Ada Lovelace"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      required
                    />
                  </div>
                )}

                <div className="flex flex-col gap-2">
                  <Label htmlFor="auth-email">Email</Label>
                  <Input
                    id="auth-email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="auth-password">Password</Label>
                  <Input
                    id="auth-password"
                    type="password"
                    autoComplete={tab === "signin" ? "current-password" : "new-password"}
                    placeholder="••••••••"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                  />
                </div>

                {error && (
                  <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                    {error}
                  </p>
                )}

                <Button
                  type="submit"
                  disabled={busy || !email || !password || (tab === "signup" && !name)}
                  className="mt-1 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
                >
                  {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                  {tab === "signin" ? "Sign in" : "Create account"}
                </Button>

                <p className="text-center text-xs text-zinc-400">
                  Multi-factor authentication (TOTP) is enabled on this server.
                </p>
              </form>
            )}

            {step === "enroll" && enrollData && (
              <form onSubmit={handleConfirmEnrollment} className="flex flex-col gap-4" noValidate>
                <div className="flex items-center gap-2 text-emerald-700">
                  <ShieldCheck className="size-5" aria-hidden />
                  <h2 className="text-lg font-semibold">Set up authenticator</h2>
                </div>

                <div className="flex flex-col items-center gap-3 rounded-xl bg-zinc-50 p-4">
                  {enrollData.qr_code ? (
                    <img
                      src={enrollData.qr_code}
                      alt="TOTP enrollment QR code"
                      className="size-44 rounded-lg border border-zinc-200 bg-white p-2"
                    />
                  ) : null}
                  <p className="text-center text-xs text-zinc-500">
                    Scan with Google Authenticator, 1Password, Authy… or add the key manually:
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      copyText(enrollData.manual_key, "Secret key", setCopiedKey)
                    }
                    className="group flex w-full items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 font-mono text-xs text-zinc-800 transition-colors hover:border-emerald-300"
                    aria-label="Copy secret key"
                  >
                    <span className="truncate">{enrollData.manual_key}</span>
                    {copiedKey ? (
                      <Check className="size-4 shrink-0 text-emerald-600" aria-hidden />
                    ) : (
                      <Copy className="size-4 shrink-0 text-zinc-400 group-hover:text-emerald-600" aria-hidden />
                    )}
                  </button>
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="auth-code">6-digit code</Label>
                  <div className="flex gap-2">
                    <Input
                      id="auth-code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="123456"
                      className="font-mono tracking-[0.3em]"
                      value={code}
                      onChange={(event) => setCode(event.target.value.replace(/[^\d]/g, "").slice(0, 6))}
                      required
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={autofillCode}
                      title="Generate a valid TOTP locally (demo helper)"
                      className="shrink-0 gap-1.5"
                    >
                      <Wand2 className="size-4" aria-hidden /> Autofill
                    </Button>
                  </div>
                  <p className="text-xs text-zinc-400">
                    Code refreshes in {secondsLeft}s · computing RFC 6238 in your browser
                  </p>
                </div>

                {error && (
                  <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                    {error}
                  </p>
                )}

                <div className="flex items-center justify-between gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={resetToCredentials}
                    className="gap-1.5 text-zinc-500"
                  >
                    <ArrowLeft className="size-4" aria-hidden /> Back
                  </Button>
                  <Button
                    type="submit"
                    disabled={busy || code.length !== 6}
                    className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
                  >
                    {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                    Confirm &amp; continue
                  </Button>
                </div>
              </form>
            )}

            {step === "verify" && (
              <form onSubmit={handleVerify} className="flex flex-col gap-4" noValidate>
                <div className="flex items-center gap-2 text-emerald-700">
                  <KeyRound className="size-5" aria-hidden />
                  <h2 className="text-lg font-semibold">Two-factor verification</h2>
                </div>
                <p className="text-sm text-zinc-500">
                  Enter the 6-digit code from your authenticator app.
                </p>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="auth-verify-code">
                    {useRecovery ? "Recovery code" : "6-digit code"}
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="auth-verify-code"
                      inputMode={useRecovery ? "text" : "numeric"}
                      autoComplete="one-time-code"
                      placeholder={useRecovery ? "hex recovery code" : "123456"}
                      className={useRecovery ? "font-mono" : "font-mono tracking-[0.3em]"}
                      value={code}
                      onChange={(event) =>
                        setCode(
                          useRecovery
                            ? event.target.value.trim().slice(0, 64)
                            : event.target.value.replace(/[^\d]/g, "").slice(0, 6)
                        )
                      }
                      required
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={autofillCode}
                      title="Generate a valid TOTP locally (demo helper)"
                      className="shrink-0 gap-1.5"
                    >
                      <Wand2 className="size-4" aria-hidden /> Autofill
                    </Button>
                  </div>
                  {!useRecovery && (
                    <p className="text-xs text-zinc-400">Code refreshes in {secondsLeft}s</p>
                  )}
                </div>

                <div className="flex items-center justify-between rounded-lg border border-zinc-200 px-3 py-2.5">
                  <div>
                    <Label htmlFor="use-recovery" className="text-sm font-normal text-zinc-600">
                      Use a recovery code
                    </Label>
                    <p className="text-xs text-zinc-400">One of the 10 hex codes from enrollment</p>
                  </div>
                  <Switch
                    id="use-recovery"
                    checked={useRecovery}
                    onCheckedChange={(checked) => {
                      setUseRecovery(checked);
                      setCode("");
                    }}
                  />
                </div>

                {error && (
                  <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                    {error}
                  </p>
                )}

                <div className="flex items-center justify-between gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={resetToCredentials}
                    className="gap-1.5 text-zinc-500"
                  >
                    <ArrowLeft className="size-4" aria-hidden /> Back
                  </Button>
                  <Button
                    type="submit"
                    disabled={busy || code.trim().length < 6}
                    className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
                  >
                    {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                    Verify
                  </Button>
                </div>
              </form>
            )}

            {step === "recovery" && (
              <div className="flex flex-col gap-4">
                <div className="flex items-center gap-2 text-emerald-700">
                  <ShieldCheck className="size-5" aria-hidden />
                  <h2 className="text-lg font-semibold">Save your recovery codes</h2>
                </div>
                <p className="text-sm text-zinc-500">
                  These 10 one-time codes are shown <strong>only once</strong>. Store them
                  somewhere safe — each can be used instead of a TOTP code if you lose your
                  authenticator.
                </p>
                <div className="scrollbar-thin grid max-h-64 grid-cols-1 gap-1 overflow-y-auto rounded-xl border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs text-zinc-700 sm:grid-cols-2">
                  {recoveryCodes.map((recoveryCode) => (
                    <span key={recoveryCode} className="truncate rounded bg-white px-2 py-1">
                      {recoveryCode}
                    </span>
                  ))}
                </div>
                {error && (
                  <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                    {error}
                  </p>
                )}
                <div className="flex items-center justify-between gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => copyText(recoveryCodes.join("\n"), "Recovery codes", setCopiedCodes)}
                    className="gap-1.5"
                  >
                    {copiedCodes ? (
                      <Check className="size-4 text-emerald-600" aria-hidden />
                    ) : (
                      <Copy className="size-4" aria-hidden />
                    )}
                    Copy all
                  </Button>
                  <Button
                    type="button"
                    onClick={() => enrolledSession && onAuthenticated(enrolledSession)}
                    className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
                  >
                    I saved them — continue
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      <footer className="mt-auto border-t border-zinc-200/70 px-4 py-3 text-center text-xs text-zinc-400 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        Open WebUI v0.12.5 (TS port)
      </footer>
    </div>
  );
}
