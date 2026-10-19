import { ApiError } from "../services/api";
import { Notice } from "./ui";

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

export function ErrorNotice({ error, title, onRetry }: { error: unknown; title?: string; onRetry?: () => void }) {
  if (!error) return null;
  const details = error instanceof ApiError && Array.isArray(error.details) ? (error.details as { message?: string }[]) : [];
  return (
    <Notice
      tone="danger"
      title={title ?? errorMessage(error)}
      action={
        onRetry && (
          <button type="button" onClick={onRetry} className="text-sm font-medium text-fg underline underline-offset-2">
            Try again
          </button>
        )
      }
    >
      {title && <p>{errorMessage(error)}</p>}
      {details.length > 0 && (
        <ul className="mt-1 list-disc pl-4">
          {details.slice(0, 6).map((d, i) => (
            <li key={i}>{d.message ?? JSON.stringify(d)}</li>
          ))}
        </ul>
      )}
    </Notice>
  );
}
