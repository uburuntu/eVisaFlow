import { describe, expect, it } from "vitest";
import type { SavedResult } from "@/vault/vault";
import { buildReminderPlan } from "./reminder-plan";

const baseResult: SavedResult = {
  id: "c6d85ab7-22cd-4ef7-a394-e82c0fd8226b",
  runId: "c6d85ab7-22cd-4ef7-a394-e82c0fd8226b",
  profileId: "1f8f9e99-f0ea-4591-a745-aabf871febc1",
  purpose: "right_to_work",
  shareCode: "ABC 123 XYZ",
  validUntil: "2027-03-31",
  generatedAt: "2027-01-20T10:00:00.000Z",
  savedAt: "2027-01-20T10:01:00.000Z",
  artifacts: [],
};

describe("buildReminderPlan", () => {
  it("schedules four local 09:00 reminders for the newest proof", () => {
    const plan = buildReminderPlan([baseResult], new Date(2027, 0, 1, 12));
    expect(plan).toHaveLength(4);
    expect(plan.map((item) => item.triggerAt.getHours())).toEqual([9, 9, 9, 9]);
    expect(plan.map((item) => item.triggerAt.getDate())).toEqual([1, 17, 24, 30]);
  });

  it("replaces reminders for an older proof with the same person and purpose", () => {
    const older = {
      ...baseResult,
      id: "04fd3ab6-600c-414d-9265-e1a20b31dd39",
      runId: "04fd3ab6-600c-414d-9265-e1a20b31dd39",
      generatedAt: "2027-01-10T10:00:00.000Z",
    };
    const plan = buildReminderPlan([older, baseResult], new Date(2027, 0, 1, 12));
    expect(plan.every((item) => item.resultId === baseResult.id)).toBe(true);
  });

  it("omits expired and missing-expiry results", () => {
    expect(
      buildReminderPlan(
        [{ ...baseResult, validUntil: undefined }],
        new Date(2027, 0, 1, 12)
      )
    ).toEqual([]);
    expect(buildReminderPlan([baseResult], new Date(2027, 3, 1, 12))).toEqual([]);
  });
});
