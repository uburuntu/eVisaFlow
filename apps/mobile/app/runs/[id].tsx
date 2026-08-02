import type { EVisaPhase, MobileRunSnapshot } from "@evisa-flow/protocol";
import { router, useLocalSearchParams } from "expo-router";
import {
  CircleAlert,
  Clock3,
  Download,
  KeyRound,
  LockKeyhole,
  ShieldCheck,
  X,
} from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  InputAccessoryView,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { MobileApiRequestError } from "@/api/client";
import { useMobileService } from "@/api/ServiceContext";
import { AppButton } from "@/components/AppButton";
import { MAX_ACCESSIBLE_FONT_SCALE, AppText as Text } from "@/components/AppText";
import { useAppTheme } from "@/theme";
import { purposeLabels } from "@/utils/run";
import { useVault } from "@/vault/VaultContext";

const terminalStatuses = new Set<MobileRunSnapshot["status"]>([
  "succeeded",
  "partial_success",
  "failed",
  "cancelled",
  "interrupted",
  "expired",
]);
const SECURITY_CODE_ACCESSORY_ID = "security-code-actions";

export default function RunStatusScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useAppTheme();
  const vault = useVault();
  const service = useMobileService();
  const [snapshot, setSnapshot] = useState<MobileRunSnapshot | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [securityCode, setSecurityCode] = useState("");
  const [submittingCode, setSubmittingCode] = useState(false);
  const [savingResult, setSavingResult] = useState(false);
  const [saveProgress, setSaveProgress] = useState("");
  const claimingRef = useRef(false);

  const loadRun = useCallback(async () => {
    if (!id) return null;
    try {
      const next = await service.getClient().getRun(id);
      setSnapshot(next);
      setLoadError(null);
      return next;
    } catch (loadError) {
      setLoadError(normalizeError(loadError, "The run status could not be loaded."));
      return null;
    }
  }, [id, service]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const next = await loadRun();
      if (active && (!next || !terminalStatuses.has(next.status))) {
        timer = setTimeout(poll, 1_200);
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [loadRun]);

  const saveCompletedResult = useCallback(async () => {
    if (!id || !snapshot || claimingRef.current) return;
    claimingRef.current = true;
    setSavingResult(true);
    setActionError(null);
    try {
      const client = service.getClient();
      setSaveProgress("Claiming secure result");
      const result = await client.claimResult(id);
      const artifacts = [];
      for (let index = 0; index < result.artifacts.length; index += 1) {
        const descriptor = result.artifacts[index];
        if (!descriptor) continue;
        setSaveProgress(`Securing file ${index + 1} of ${result.artifacts.length}`);
        artifacts.push({
          descriptor,
          bytes: await client.downloadArtifact(id, descriptor),
        });
      }
      const saved = await vault.saveResult({
        id,
        runId: id,
        profileId: snapshot.profileId,
        purpose: snapshot.purpose,
        shareCode: result.shareCode,
        validUntil: result.validUntil,
        artifacts,
      });
      void service.connect().catch(() => {});
      router.replace({ pathname: "/documents/[id]", params: { id: saved.id } });
    } catch (saveError) {
      setActionError(normalizeError(saveError, "The result could not be saved offline."));
      claimingRef.current = false;
    } finally {
      setSavingResult(false);
      setSaveProgress("");
    }
  }, [id, service, snapshot, vault]);

  useEffect(() => {
    if (snapshot && isSuccessful(snapshot.status)) {
      void saveCompletedResult();
    }
    if (snapshot && isUnsuccessfulTerminal(snapshot.status)) {
      void vault.removeRun(snapshot.id);
    }
  }, [saveCompletedResult, snapshot, vault]);

  const submitCode = async () => {
    if (!id || !/^\d{4,8}$/.test(securityCode.trim())) {
      setActionError(new Error("Enter the 4-8 digit security code."));
      return;
    }
    Keyboard.dismiss();
    setSubmittingCode(true);
    setActionError(null);
    try {
      const next = await service
        .getClient()
        .submitChallenge(id, { code: securityCode.trim() });
      setSecurityCode("");
      setSnapshot(next);
    } catch (submitError) {
      setActionError(normalizeError(submitError, "The security code was not accepted."));
    } finally {
      setSubmittingCode(false);
    }
  };

  const cancel = () => {
    if (!id) return;
    Alert.alert("Cancel this run?", "No eVisa document will be saved.", [
      { text: "Keep running", style: "cancel" },
      {
        text: "Cancel run",
        style: "destructive",
        onPress: () => {
          void service
            .getClient()
            .cancelRun(id)
            .then(() => vault.removeRun(id))
            .then(() => router.replace("/"))
            .catch((cancelError: unknown) =>
              setActionError(
                normalizeError(cancelError, "The run could not be cancelled.")
              )
            );
        },
      },
    ]);
  };

  if (!snapshot && !loadError) {
    return (
      <View style={[styles.centered, { backgroundColor: theme.colors.background }]}>
        <ActivityIndicator color={theme.colors.primary} size="large" />
        <Text style={[styles.loadingText, { color: theme.colors.textMuted }]}>
          Loading secure run
        </Text>
      </View>
    );
  }

  if (!snapshot) {
    return (
      <View style={[styles.centered, { backgroundColor: theme.colors.background }]}>
        <CircleAlert color={theme.colors.danger} size={32} />
        <Text style={[styles.errorTitle, { color: theme.colors.text }]}>
          Run unavailable
        </Text>
        <Text style={[styles.centeredBody, { color: theme.colors.textMuted }]}>
          {loadError?.message}
        </Text>
        <AppButton onPress={() => void loadRun()} title="Try again" />
        <AppButton
          onPress={() => router.replace("/")}
          title="Back to documents"
          variant="secondary"
        />
      </View>
    );
  }

  const presentation = phasePresentation(snapshot.phase, snapshot.status);
  const profile = vault.profiles.find((candidate) => candidate.id === snapshot.profileId);
  const failed = isUnsuccessfulTerminal(snapshot.status);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={[styles.page, { backgroundColor: theme.colors.background }]}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        testID="run-status-screen"
      >
        <View style={styles.heading}>
          <View
            style={[
              styles.statusIcon,
              {
                backgroundColor: failed
                  ? theme.colors.dangerMuted
                  : theme.colors.primaryMuted,
              },
            ]}
          >
            {failed ? (
              <CircleAlert color={theme.colors.danger} size={28} />
            ) : (
              <ShieldCheck color={theme.colors.primary} size={28} />
            )}
          </View>
          <Text style={[styles.eyebrow, { color: theme.colors.primary }]}>
            SECURE RUN
          </Text>
          <Text style={[styles.title, { color: theme.colors.text }]}>
            {failed ? "Run stopped" : presentation.title}
          </Text>
          <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>
            {profile?.displayName ?? "Saved person"} · {purposeLabels[snapshot.purpose]}
          </Text>
        </View>

        {!failed ? (
          <View
            style={[
              styles.progressPanel,
              { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
            ]}
          >
            <View style={styles.progressHeading}>
              <Text style={[styles.progressTitle, { color: theme.colors.text }]}>
                {savingResult ? "Saving offline" : presentation.body}
              </Text>
              <Text style={[styles.progressPercent, { color: theme.colors.primary }]}>
                {Math.round((savingResult ? 0.94 : presentation.progress) * 100)}%
              </Text>
            </View>
            <View style={[styles.track, { backgroundColor: theme.colors.surfaceMuted }]}>
              <View
                style={[
                  styles.fill,
                  {
                    backgroundColor: theme.colors.primary,
                    width: `${(savingResult ? 0.94 : presentation.progress) * 100}%`,
                  },
                ]}
              />
            </View>
            <View style={styles.liveStatus}>
              {savingResult ? (
                <Download color={theme.colors.primary} size={17} />
              ) : (
                <Clock3 color={theme.colors.textMuted} size={17} />
              )}
              <Text style={[styles.liveStatusText, { color: theme.colors.textMuted }]}>
                {savingResult
                  ? saveProgress
                  : "You can leave the app open while this completes."}
              </Text>
            </View>
          </View>
        ) : (
          <View
            style={[styles.failurePanel, { backgroundColor: theme.colors.dangerMuted }]}
          >
            <Text style={[styles.failureTitle, { color: theme.colors.danger }]}>
              {snapshot.status === "cancelled" ? "Run cancelled" : "Proof not generated"}
            </Text>
            <Text style={[styles.failureBody, { color: theme.colors.textMuted }]}>
              {snapshot.errorCode
                ? `Reference: ${snapshot.errorCode}`
                : "Try again, or use the official GOV.UK service."}
            </Text>
          </View>
        )}

        {snapshot.status === "awaiting_2fa" ? (
          <View
            style={[
              styles.challenge,
              { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
            ]}
          >
            <View style={styles.challengeHeading}>
              <View
                style={[
                  styles.challengeIcon,
                  { backgroundColor: theme.colors.warningMuted },
                ]}
              >
                <KeyRound color={theme.colors.warning} size={21} />
              </View>
              <View style={styles.challengeCopy}>
                <Text style={[styles.challengeTitle, { color: theme.colors.text }]}>
                  Enter the GOV.UK security code
                </Text>
                <Text style={[styles.challengeBody, { color: theme.colors.textMuted }]}>
                  Sent by{" "}
                  {snapshot.challenge?.deliveryMethod === "email"
                    ? "email"
                    : "text message"}
                  .
                </Text>
              </View>
            </View>
            {service.mode === "demo" ? (
              <Text style={[styles.demoCode, { color: theme.colors.info }]}>
                Demo code: 123456
              </Text>
            ) : null}
            <TextInput
              accessibilityLabel="Security code"
              autoComplete="one-time-code"
              inputAccessoryViewID={
                Platform.OS === "ios" ? SECURITY_CODE_ACCESSORY_ID : undefined
              }
              keyboardType="number-pad"
              maxLength={8}
              maxFontSizeMultiplier={MAX_ACCESSIBLE_FONT_SCALE}
              onChangeText={(value) => {
                setSecurityCode(value.replace(/\D/g, ""));
                setActionError(null);
              }}
              placeholder="Security code"
              placeholderTextColor={theme.colors.textMuted}
              style={[
                styles.codeInput,
                {
                  backgroundColor: theme.colors.input,
                  borderColor: actionError ? theme.colors.danger : theme.colors.border,
                  color: theme.colors.text,
                },
              ]}
              testID="run-security-code"
              textContentType="oneTimeCode"
              value={securityCode}
            />
            {Platform.OS !== "ios" ? (
              <AppButton
                icon={LockKeyhole}
                loading={submittingCode}
                onPress={() => void submitCode()}
                testID="run-submit-code"
                title="Continue securely"
              />
            ) : null}
          </View>
        ) : null}

        {(actionError || loadError) && snapshot ? (
          <View
            style={[styles.inlineError, { backgroundColor: theme.colors.dangerMuted }]}
          >
            <CircleAlert color={theme.colors.danger} size={18} />
            <Text style={[styles.inlineErrorText, { color: theme.colors.text }]}>
              {(actionError ?? loadError)?.message}
            </Text>
          </View>
        ) : null}

        {failed ? (
          <View style={styles.actions}>
            {profile ? (
              <AppButton
                onPress={() =>
                  router.replace({
                    pathname: "/runs/new",
                    params: { profileId: profile.id },
                  })
                }
                title="Try again"
              />
            ) : null}
            <AppButton
              onPress={() => router.replace("/")}
              title="Back to documents"
              variant="secondary"
            />
          </View>
        ) : snapshot.status !== "awaiting_2fa" && !savingResult ? (
          <AppButton icon={X} onPress={cancel} title="Cancel run" variant="secondary" />
        ) : null}

        {isSuccessful(snapshot.status) && actionError ? (
          <AppButton
            icon={Download}
            onPress={() => void saveCompletedResult()}
            title="Retry offline save"
          />
        ) : null}
      </ScrollView>
      {Platform.OS === "ios" && snapshot.status === "awaiting_2fa" ? (
        <InputAccessoryView nativeID={SECURITY_CODE_ACCESSORY_ID}>
          <View
            style={[
              styles.keyboardAction,
              {
                backgroundColor: theme.colors.surface,
                borderTopColor: theme.colors.border,
              },
            ]}
          >
            <AppButton
              icon={LockKeyhole}
              loading={submittingCode}
              onPress={() => void submitCode()}
              testID="run-submit-code"
              title="Continue securely"
            />
          </View>
        </InputAccessoryView>
      ) : null}
    </KeyboardAvoidingView>
  );
}

function normalizeError(error: unknown, fallback: string): Error {
  if (error instanceof MobileApiRequestError) return new Error(error.message);
  return error instanceof Error ? error : new Error(fallback);
}

function isSuccessful(status: MobileRunSnapshot["status"]): boolean {
  return status === "succeeded" || status === "partial_success";
}

function isUnsuccessfulTerminal(status: MobileRunSnapshot["status"]): boolean {
  return ["failed", "cancelled", "interrupted", "expired"].includes(status);
}

function phasePresentation(
  phase: EVisaPhase | undefined,
  status: MobileRunSnapshot["status"]
): { title: string; body: string; progress: number } {
  if (status === "queued") {
    return { title: "Waiting to start", body: "Securely queued", progress: 0.08 };
  }
  const values: Partial<
    Record<EVisaPhase, { title: string; body: string; progress: number }>
  > = {
    launching: { title: "Starting securely", body: "Opening GOV.UK", progress: 0.12 },
    verifying_identity: {
      title: "Checking identity",
      body: "Signing in",
      progress: 0.28,
    },
    choosing_2fa: {
      title: "Preparing security check",
      body: "Choosing delivery method",
      progress: 0.38,
    },
    waiting_for_2fa: {
      title: "Security code needed",
      body: "Waiting for your code",
      progress: 0.44,
    },
    viewing_status: {
      title: "Opening eVisa",
      body: "Loading immigration status",
      progress: 0.58,
    },
    creating_share_code: {
      title: "Creating share code",
      body: "Requesting current proof",
      progress: 0.68,
    },
    downloading_pdf: {
      title: "Downloading proof",
      body: "Collecting eVisa PDF",
      progress: 0.78,
    },
    checking_status: {
      title: "Checking share code",
      body: "Verifying the result",
      progress: 0.84,
    },
    capturing_checker_html: {
      title: "Preparing offline copy",
      body: "Saving status page",
      progress: 0.88,
    },
    downloading_checker_pdf: {
      title: "Preparing printable copy",
      body: "Saving status PDF",
      progress: 0.91,
    },
    completed: { title: "Proof ready", body: "Saving encrypted copy", progress: 0.94 },
  };
  return (
    values[phase ?? "launching"] ?? {
      title: "Starting securely",
      body: "Opening GOV.UK",
      progress: 0.12,
    }
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 44, gap: 20 },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
    gap: 14,
  },
  loadingText: { fontSize: 14, lineHeight: 20, fontWeight: "600" },
  errorTitle: { fontSize: 22, lineHeight: 28, fontWeight: "800", textAlign: "center" },
  centeredBody: { fontSize: 14, lineHeight: 21, textAlign: "center" },
  heading: { alignItems: "center", gap: 5 },
  statusIcon: {
    width: 56,
    height: 56,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  eyebrow: { fontSize: 10, lineHeight: 13, fontWeight: "800" },
  title: { fontSize: 24, lineHeight: 30, fontWeight: "800", textAlign: "center" },
  subtitle: { fontSize: 13, lineHeight: 18, textAlign: "center" },
  progressPanel: { borderWidth: 1, borderRadius: 8, padding: 16, gap: 13 },
  progressHeading: { flexDirection: "row", alignItems: "center", gap: 12 },
  progressTitle: { flex: 1, fontSize: 14, lineHeight: 19, fontWeight: "700" },
  progressPercent: { fontSize: 13, lineHeight: 18, fontWeight: "800" },
  track: { height: 7, borderRadius: 4, overflow: "hidden" },
  fill: { height: 7, borderRadius: 4 },
  liveStatus: { flexDirection: "row", alignItems: "center", gap: 8 },
  liveStatusText: { flex: 1, fontSize: 12, lineHeight: 17 },
  challenge: { borderWidth: 1, borderRadius: 8, padding: 16, gap: 14 },
  challengeHeading: { flexDirection: "row", alignItems: "center", gap: 11 },
  challengeIcon: {
    width: 42,
    height: 42,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  challengeCopy: { flex: 1, gap: 2 },
  challengeTitle: { fontSize: 15, lineHeight: 20, fontWeight: "800" },
  challengeBody: { fontSize: 12, lineHeight: 17 },
  demoCode: { fontSize: 13, lineHeight: 18, fontWeight: "700" },
  codeInput: {
    minHeight: 52,
    borderWidth: 1,
    borderRadius: 7,
    paddingHorizontal: 14,
    fontSize: 20,
    lineHeight: 26,
    fontWeight: "700",
    letterSpacing: 0,
  },
  inlineError: {
    minHeight: 52,
    borderRadius: 8,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  inlineErrorText: { flex: 1, fontSize: 13, lineHeight: 18 },
  failurePanel: { borderRadius: 8, padding: 16, gap: 4 },
  failureTitle: { fontSize: 15, lineHeight: 20, fontWeight: "800" },
  failureBody: { fontSize: 13, lineHeight: 19 },
  actions: { gap: 10 },
  keyboardAction: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
  },
});
