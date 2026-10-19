import { Link } from "react-router";
import { Button } from "../components/ui";

export function NotFoundPage() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <p className="text-sm text-faint">404</p>
      <h1 className="text-xl font-semibold">This page does not exist</h1>
      <Link to="/dashboard">
        <Button>Back to projects</Button>
      </Link>
    </div>
  );
}
