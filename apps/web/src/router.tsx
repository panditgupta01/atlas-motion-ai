import { lazy, Suspense, type ReactNode } from "react";
import { createBrowserRouter } from "react-router";
import { AppLayout } from "./components/Layout";
import { PageSpinner } from "./components/ui";
import { LandingPage } from "./pages/Landing";
import { AuthPage } from "./pages/Auth";
import { DashboardPage } from "./pages/Dashboard";
import { NewProjectPage } from "./pages/NewProject";
import { NotFoundPage } from "./pages/NotFound";

// The editor pulls in MapLibre; load it only when needed.
const EditorPage = lazy(() => import("./pages/Editor").then((m) => ({ default: m.EditorPage })));
const RenderStudioPage = lazy(() => import("./pages/RenderStudio").then((m) => ({ default: m.RenderStudioPage })));
const ExportPage = lazy(() => import("./pages/Export").then((m) => ({ default: m.ExportPage })));

const s = (node: ReactNode) => <Suspense fallback={<PageSpinner />}>{node}</Suspense>;

export const router = createBrowserRouter([
  { path: "/", element: <LandingPage /> },
  { path: "/login", element: <AuthPage mode="login" /> },
  { path: "/register", element: <AuthPage mode="register" /> },
  {
    element: <AppLayout />,
    children: [
      { path: "/dashboard", element: <DashboardPage /> },
      { path: "/projects/new", element: <NewProjectPage /> },
      { path: "/projects/:projectId/storyboard", element: s(<EditorPage />) },
      { path: "/projects/:projectId/render", element: s(<RenderStudioPage />) },
      { path: "/projects/:projectId/render/:renderId", element: s(<RenderStudioPage />) },
      { path: "/projects/:projectId/export", element: s(<ExportPage />) },
    ],
  },
  { path: "*", element: <NotFoundPage /> },
]);
