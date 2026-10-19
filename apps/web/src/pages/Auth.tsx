import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Logo } from "../components/Layout";
import { Button, Card, Field, Input } from "../components/ui";
import { ErrorNotice } from "../components/ErrorNotice";
import { keys, useMe } from "../hooks/queries";
import { api } from "../services/api";

export function AuthPage({ mode }: { mode: "login" | "register" }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe();
  // Only same-app relative paths are accepted as a redirect target.
  const nextParam = params.get("next");
  const next = nextParam && nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/dashboard";

  if (me.data) return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { user } = mode === "login" ? await api.login(email, password) : await api.register(email, password);
      qc.setQueryData(keys.me, user);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const isLogin = mode === "login";
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-12">
      <Logo className="mb-8 text-lg" />
      <Card className="w-full max-w-sm p-6">
        <h1 className="text-lg font-semibold">{isLogin ? "Sign in" : "Create your account"}</h1>
        <p className="mt-1 text-sm text-muted">{isLogin ? "Welcome back." : "Accounts are stored on this AtlasMotion server only."}</p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Password" htmlFor="password" hint={isLogin ? undefined : "At least 10 characters."}>
            <Input
              id="password"
              type="password"
              autoComplete={isLogin ? "current-password" : "new-password"}
              required
              minLength={isLogin ? 1 : 10}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {error ? <ErrorNotice error={error} /> : null}
          <Button type="submit" variant="primary" className="w-full" busy={busy}>
            {isLogin ? "Sign in" : "Create account"}
          </Button>
        </form>
      </Card>
      <p className="mt-6 text-sm text-muted">
        {isLogin ? "New here? " : "Already have an account? "}
        <Link to={`${isLogin ? "/register" : "/login"}${nextParam ? `?next=${encodeURIComponent(next)}` : ""}`} className="text-accent hover:underline">
          {isLogin ? "Create an account" : "Sign in"}
        </Link>
      </p>
    </div>
  );
}
