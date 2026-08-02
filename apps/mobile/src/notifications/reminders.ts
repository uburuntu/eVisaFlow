import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { SavedResult } from "@/vault/vault";
import { buildReminderPlan } from "./reminder-plan";

const CHANNEL_ID = "expiry-reminders";
const IDENTIFIER_PREFIX = "evisaflow-expiry-";

export function configureLocalNotifications(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: false,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

export async function requestReminderPermission(): Promise<boolean> {
  await ensureAndroidChannel();
  const existing = await Notifications.getPermissionsAsync();
  if (existing.granted) return true;
  const requested = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: false, allowSound: false },
  });
  return requested.granted;
}

export async function reconcileExpiryReminders(
  results: SavedResult[],
  enabled: boolean
): Promise<void> {
  await ensureAndroidChannel();
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  const existing = new Map(
    scheduled
      .filter((notification) => notification.identifier.startsWith(IDENTIFIER_PREFIX))
      .map((notification) => [notification.identifier, notification])
  );
  const desired = enabled ? buildReminderPlan(results) : [];
  const desiredIds = new Set(desired.map((item) => item.identifier));

  await Promise.all(
    Array.from(existing.keys())
      .filter((identifier) => !desiredIds.has(identifier))
      .map((identifier) => Notifications.cancelScheduledNotificationAsync(identifier))
  );

  for (const item of desired) {
    if (existing.has(item.identifier)) continue;
    await Notifications.scheduleNotificationAsync({
      identifier: item.identifier,
      content: {
        title: "A saved eVisaFlow item may need attention",
        body: "Open eVisaFlow to review it before you need it.",
        sound: false,
        data: { type: "expiry_reminder", resultId: item.resultId },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: item.triggerAt,
        channelId: CHANNEL_ID,
      },
    });
  }
}

export function resultIdFromNotificationResponse(
  response: Notifications.NotificationResponse
): string | null {
  const data = response.notification.request.content.data;
  return data?.type === "expiry_reminder" && typeof data.resultId === "string"
    ? data.resultId
    : null;
}

async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: "Saved proof reminders",
    importance: Notifications.AndroidImportance.DEFAULT,
    sound: null,
    vibrationPattern: [0, 180],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
  });
}
