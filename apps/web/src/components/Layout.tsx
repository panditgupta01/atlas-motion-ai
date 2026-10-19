import { Link, NavLink, Navigate, Outlet, useLocation } from "react-router";
import clsx from "clsx";
import { LogOut, Plus } from "lucide-react";
import { useLogout, useMe } from "../hooks/queries";
import { Button, PageSpinner } from "./ui";
import { ErrorNotice } from "./ErrorNotice";

export function Logo({ className }: { className?: string }) {
  return (
    <Link to="/" className={clsx("flex items-center gap-2 font-semibold tracking-tight", className)}>
      <img src="/favicon.svg" alt="" className="size-6" />
      <span>
        AtlasMotion <span className="text-accent">AI</span>
      </span>
    </Link>
  );
}

/** App chrome for signed-in pages. Redirects to login when there is no session. */
export function AppLayout() {
  const me = useMe();
  const location = useLocation();
  const logout = useLogout();

  if (me.isPending) return <PageSpinner />;
  if (me.isError)
    return (
      <div className="mx-auto max-w-lg p-8">
        <ErrorNotice error={me.error} title="Could not reach the server" onRetry={() => void me.refetch()} />
      </div>
    );
  if (!me.data) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-6 px-4 sm:px-6">
          <Logo />
          <nav className="flex items-center gap-1 text-sm">
            <NavLink to="/dashboard" className={({ isActive }) => clsx("rounded-md px-2.5 py-1.5", isActive ? "bg-surface-2 text-fg" : "text-muted hover:text-fg")}>
              Projects
            </NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Link to="/projects/new">
              <Button variant="primary" size="sm" icon={<Plus className="size-4" />}>
                New project
              </Button>
            </Link>
            <span className="hidden text-[13px] text-faint md:inline">{me.data.email}</span>
            <Button variant="ghost" size="sm" aria-label="Sign out" title="Sign out" onClick={() => logout.mutate()} icon={<LogOut className="size-4" />} />
          </div>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
