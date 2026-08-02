import type { SavedResult } from "@/vault/vault";

export const REMINDER_OFFSETS_DAYS = [30, 14, 7, 1] as const;

export interface ReminderPlanItem {
  identifier: string;
  resultId: string;
  triggerAt: Date;
}

export function buildReminderPlan(
  results: SavedResult[],
  now = new Date()
): ReminderPlanItem[] {
  const newestByProfileAndPurpose = new Map<string, SavedResult>();
  for (const result of results) {
    const key = `${result.profileId}:${result.purpose}`;
    const existing = newestByProfileAndPurpose.get(key);
    if (!existing || resultTimestamp(result) > resultTimestamp(existing)) {
      newestByProfileAndPurpose.set(key, result);
    }
  }

  const plan: ReminderPlanItem[] = [];
  for (const result of newestByProfileAndPurpose.values()) {
    if (!result.validUntil) continue;
    for (const offset of REMINDER_OFFSETS_DAYS) {
      const triggerAt = localReminderDate(result.validUntil, offset);
      if (!triggerAt || triggerAt.getTime() <= now.getTime()) continue;
      plan.push({
        identifier: `evisaflow-expiry-${result.id}-${offset}`,
        resultId: result.id,
        triggerAt,
      });
    }
  }
  return plan.sort((left, right) => left.triggerAt.getTime() - right.triggerAt.getTime());
}

function localReminderDate(validUntil: string, offsetDays: number): Date | null {
  const calendarDate = validUntil.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!calendarDate) return null;
  const year = Number(calendarDate[1]);
  const month = Number(calendarDate[2]);
  const day = Number(calendarDate[3]);
  const value = new Date(year, month - 1, day, 9, 0, 0, 0);
  if (
    value.getFullYear() !== year ||
    value.getMonth() !== month - 1 ||
    value.getDate() !== day
  ) {
    return null;
  }
  value.setDate(value.getDate() - offsetDays);
  return value;
}

function resultTimestamp(result: SavedResult): number {
  return Date.parse(result.generatedAt ?? result.savedAt);
}
