/**
 * History: the user's past runs (`GET /api/runs`) — status, validity, and date.
 *
 * This endpoint returns NO secrets (no applicant data, no share code), so nothing
 * here needs the vault key. We pair each run with its person's display name from
 * the members list for readability; a run for a since-removed person falls back to
 * a neutral label. A completed run links back to its result screen, where the
 * sealed artifacts can be re-fetched and opened in-browser if still available.
 */
import { type ReactElement, useEffect, useState } from "react";
import {
  listMembers,
  listRuns,
  type Member,
  type RunHistoryItem,
} from "../lib/api-client.js";
import { formatDate, formatDateTime, runStatusInfo } from "../lib/labels.js";
import { navigate } from "../runtime/router.js";
import { Banner, Button, EmptyState, LoadingState } from "../ui/primitives.js";

export function History(): ReactElement {
  const [runs, setRuns] = useState<RunHistoryItem[] | null>(null);
  const [memberNames, setMemberNames] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    Promise.all([listRuns(), listMembers().catch(() => [] as Member[])])
      .then(([runRows, members]) => {
        if (!active) return;
        setRuns(runRows);
        setMemberNames(new Map(members.map((m) => [m.id, m.displayName])));
      })
      .catch(() => {
        if (active) setError("Could not load your history. Please try again.");
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="stack-lg">
      <header className="page-head">
        <div>
          <p className="eyebrow">Activity</p>
          <h1 className="page-head__title">History</h1>
        </div>
        <Button variant="ghost" onClick={() => navigate({ name: "dashboard" })}>
          Back to dashboard
        </Button>
      </header>

      {error ? <Banner tone="error">{error}</Banner> : null}

      {runs === null ? (
        <LoadingState label="Loading your history…" />
      ) : runs.length === 0 ? (
        <EmptyState
          title="No runs yet"
          description="When you generate a share code, it'll appear here."
        />
      ) : (
        <div className="card table-card">
          <table className="history-table">
            <caption className="visually-hidden">Your past runs</caption>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Status</th>
                <th scope="col">Valid until</th>
                <th scope="col">Date</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const status = runStatusInfo(run.status);
                const completed = run.status === "success" || run.status === "completed";
                return (
                  <tr key={run.id}>
                    <td data-label="Person">
                      {memberNames.get(run.familyMemberId) ?? "Removed person"}
                    </td>
                    <td data-label="Status">
                      <span className={`status-dot status-dot--${status.tone}`}>
                        {status.label}
                      </span>
                    </td>
                    <td data-label="Valid until">{formatDate(run.validUntil)}</td>
                    <td data-label="Date">{formatDateTime(run.createdAt)}</td>
                    <td data-label="" className="history-table__action">
                      {completed ? (
                        <button
                          type="button"
                          className="linklike"
                          onClick={() => navigate({ name: "run", runId: run.id })}
                        >
                          View
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
