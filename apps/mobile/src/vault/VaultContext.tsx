import type {
  AuthorityBasis,
  IdentityDocument,
  MobileProfile,
  Purpose,
  TwoFactorMethod,
} from "@evisa-flow/protocol";
import { randomUUID } from "expo-crypto";
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FREE_PROFILE_LIMIT, PRO_PROFILE_LIMIT, TERMS_VERSION } from "@/constants/app";
import {
  type ActiveRun,
  createEmptyVault,
  deleteResultArtifacts,
  loadVault,
  moveResultArtifactsToTrash,
  type PendingClaimAcknowledgement,
  persistResult,
  readResultArtifact,
  resetVault as resetStoredVault,
  restoreResultArtifactsFromTrash,
  type SavedResult,
  type SaveResultInput,
  saveVault,
  type VaultDocument,
  validateProfile,
} from "./vault";

export interface CreateProfileInput {
  displayName: string;
  documentType: IdentityDocument["type"];
  documentNumber: string;
  dateOfBirth: string;
  preferredTwoFactorMethod: TwoFactorMethod;
  authorityBasis: AuthorityBasis;
}

interface AddProfileOptions {
  id?: string;
  profileLimit?: number;
}

export class ProfileLimitError extends Error {
  constructor() {
    super("The free profile limit has been reached.");
    this.name = "ProfileLimitError";
  }
}

export class ActiveRunError extends Error {
  constructor() {
    super("This person has a run in progress.");
    this.name = "ActiveRunError";
  }
}

interface VaultContextValue {
  status: "loading" | "ready" | "error";
  error: Error | null;
  profiles: MobileProfile[];
  results: SavedResult[];
  activeRuns: ActiveRun[];
  pendingClaimAcknowledgements: PendingClaimAcknowledgement[];
  profileSlotTombstones: string[];
  expiryRemindersEnabled: boolean;
  hasAcceptedDisclosure: boolean;
  acceptDisclosure: () => Promise<void>;
  addProfile: (
    input: CreateProfileInput,
    options?: AddProfileOptions
  ) => Promise<MobileProfile>;
  deleteProfile: (profileId: string) => Promise<void>;
  clearProfileSlotTombstone: (profileId: string) => Promise<void>;
  trackRun: (input: {
    id: string;
    profileId: string;
    purpose: Purpose;
    createdAt: string;
  }) => Promise<void>;
  removeRun: (runId: string) => Promise<void>;
  saveResult: (input: SaveResultInput) => Promise<SavedResult>;
  confirmClaimAcknowledged: (runId: string) => Promise<void>;
  updatePendingClaim: (
    runId: string,
    claimToken: string,
    manifestHash: string
  ) => Promise<void>;
  discardPendingClaim: (runId: string) => Promise<void>;
  deleteResult: (resultId: string) => Promise<void>;
  setExpiryRemindersEnabled: (enabled: boolean) => Promise<void>;
  resetVault: () => Promise<void>;
}

const VaultContext = createContext<VaultContextValue | null>(null);

export function VaultProvider({ children }: PropsWithChildren) {
  const [document, setDocument] = useState<VaultDocument>(createEmptyVault());
  const [status, setStatus] = useState<VaultContextValue["status"]>("loading");
  const [error, setError] = useState<Error | null>(null);
  const documentRef = useRef(document);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let isMounted = true;

    void loadVault()
      .then((loadedDocument) => {
        if (!isMounted) {
          return;
        }
        documentRef.current = loadedDocument;
        setDocument(loadedDocument);
        setStatus("ready");
      })
      .catch((loadError: unknown) => {
        if (!isMounted) {
          return;
        }
        setError(
          loadError instanceof Error
            ? loadError
            : new Error("The encrypted vault could not be loaded.")
        );
        setStatus("error");
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const mutate = useCallback(
    async <T,>(mutation: (current: VaultDocument) => [VaultDocument, T]) => {
      let result: T | undefined;

      const operation = writeQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          const [nextDocument, mutationResult] = mutation(documentRef.current);
          await saveVault(nextDocument);
          documentRef.current = nextDocument;
          setDocument(nextDocument);
          result = mutationResult;
        });

      writeQueueRef.current = operation.catch(() => undefined);
      await operation;
      return result as T;
    },
    []
  );

  const acceptDisclosure = useCallback(async () => {
    await mutate((current) => [
      {
        ...current,
        acceptedDisclosureAt: new Date().toISOString(),
        acceptedTermsVersion: TERMS_VERSION,
      },
      undefined,
    ]);
  }, [mutate]);

  const addProfile = useCallback(
    async (input: CreateProfileInput, options?: AddProfileOptions) =>
      mutate((current) => {
        const profileLimit = Math.min(
          PRO_PROFILE_LIMIT,
          Math.max(FREE_PROFILE_LIMIT, options?.profileLimit ?? FREE_PROFILE_LIMIT)
        );
        if (current.profiles.length >= profileLimit) {
          throw new ProfileLimitError();
        }

        const now = new Date().toISOString();
        const profile = validateProfile({
          id: options?.id ?? randomUUID(),
          displayName: input.displayName.trim(),
          applicant: {
            identityDocument: {
              type: input.documentType,
              number: input.documentNumber.replace(/\s/g, "").toUpperCase(),
            },
            dateOfBirth: input.dateOfBirth,
          },
          preferredTwoFactorMethod: input.preferredTwoFactorMethod,
          authorityBasis: input.authorityBasis,
          attestedAt: now,
          termsVersion: TERMS_VERSION,
          createdAt: now,
          updatedAt: now,
        });

        return [
          {
            ...current,
            profiles: [...current.profiles, profile],
          },
          profile,
        ];
      }),
    [mutate]
  );

  const deleteProfile = useCallback(
    async (profileId: string) => {
      const removedResultIds = await mutate((current) => [
        (() => {
          if (current.activeRuns.some((run) => run.profileId === profileId)) {
            throw new ActiveRunError();
          }
          return {
            ...current,
            profiles: current.profiles.filter((profile) => profile.id !== profileId),
            results: current.results.filter((result) => result.profileId !== profileId),
            pendingClaimAcknowledgements: current.pendingClaimAcknowledgements.filter(
              (pending) =>
                !current.results.some(
                  (result) =>
                    result.id === pending.resultId && result.profileId === profileId
                )
            ),
            profileSlotTombstones: Array.from(
              new Set([...current.profileSlotTombstones, profileId])
            ),
          };
        })(),
        current.results
          .filter((result) => result.profileId === profileId)
          .map((result) => result.id),
      ]);
      deleteResultArtifacts(removedResultIds);
    },
    [mutate]
  );

  const clearProfileSlotTombstone = useCallback(
    async (profileId: string) => {
      await mutate((current) => [
        {
          ...current,
          profileSlotTombstones: current.profileSlotTombstones.filter(
            (candidate) => candidate !== profileId
          ),
        },
        undefined,
      ]);
    },
    [mutate]
  );

  const trackRun = useCallback(
    async (input: ActiveRun) => {
      await mutate((current) => [{ ...current, activeRuns: [input] }, undefined]);
    },
    [mutate]
  );

  const removeRun = useCallback(
    async (runId: string) => {
      await mutate((current) => [
        {
          ...current,
          activeRuns: current.activeRuns.filter((run) => run.id !== runId),
        },
        undefined,
      ]);
    },
    [mutate]
  );

  const saveResult = useCallback(async (input: SaveResultInput) => {
    let savedResult: SavedResult | undefined;
    const operation = writeQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const persistedResult = await persistResult(input);
        const previousDocument = documentRef.current;
        try {
          const current = previousDocument;
          const nextDocument: VaultDocument = {
            ...current,
            profiles: current.profiles.map((profile) =>
              profile.id === input.profileId
                ? {
                    ...profile,
                    lastPurpose: input.purpose,
                    updatedAt: new Date().toISOString(),
                  }
                : profile
            ),
            results: [
              persistedResult,
              ...current.results.filter((result) => result.id !== persistedResult.id),
            ],
            activeRuns: current.activeRuns.filter((run) => run.id !== input.runId),
            pendingClaimAcknowledgements: [
              {
                runId: input.runId,
                resultId: persistedResult.id,
                claimToken: input.claim.claimToken,
                manifestHash: input.claim.manifestHash,
                createdAt: new Date().toISOString(),
              },
              ...current.pendingClaimAcknowledgements.filter(
                (pending) => pending.runId !== input.runId
              ),
            ],
          };
          await saveVault(nextDocument);
          const verifiedDocument = await loadVault();
          const verifiedResult = verifiedDocument.results.find(
            (result) => result.id === persistedResult.id
          );
          if (!verifiedResult) {
            throw new Error("The saved proof could not be verified.");
          }
          for (const artifact of verifiedResult.artifacts) {
            await readResultArtifact(artifact);
          }
          documentRef.current = verifiedDocument;
          setDocument(verifiedDocument);
          savedResult = persistedResult;
        } catch (error) {
          await saveVault(previousDocument).catch(() => undefined);
          documentRef.current = previousDocument;
          setDocument(previousDocument);
          deleteResultArtifacts([persistedResult.id]);
          throw error;
        }
      });

    writeQueueRef.current = operation.catch(() => undefined);
    await operation;
    return savedResult as SavedResult;
  }, []);

  const confirmClaimAcknowledged = useCallback(
    async (runId: string) => {
      await mutate((current) => [
        {
          ...current,
          pendingClaimAcknowledgements: current.pendingClaimAcknowledgements.filter(
            (pending) => pending.runId !== runId
          ),
        },
        undefined,
      ]);
    },
    [mutate]
  );

  const updatePendingClaim = useCallback(
    async (runId: string, claimToken: string, manifestHash: string) => {
      await mutate((current) => [
        {
          ...current,
          pendingClaimAcknowledgements: current.pendingClaimAcknowledgements.map(
            (pending) =>
              pending.runId === runId ? { ...pending, claimToken, manifestHash } : pending
          ),
        },
        undefined,
      ]);
    },
    [mutate]
  );

  const discardPendingClaim = useCallback(
    async (runId: string) => {
      await confirmClaimAcknowledged(runId);
    },
    [confirmClaimAcknowledged]
  );

  const deleteResult = useCallback(async (resultId: string) => {
    const operation = writeQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const trash = await moveResultArtifactsToTrash(resultId);
        try {
          const current = documentRef.current;
          const removedRunIds = new Set(
            current.results
              .filter((result) => result.id === resultId)
              .map((result) => result.runId)
          );
          const nextDocument: VaultDocument = {
            ...current,
            results: current.results.filter((result) => result.id !== resultId),
            pendingClaimAcknowledgements: current.pendingClaimAcknowledgements.filter(
              (pending) => !removedRunIds.has(pending.runId)
            ),
          };
          await saveVault(nextDocument);
          documentRef.current = nextDocument;
          setDocument(nextDocument);
          if (trash?.exists) trash.delete();
        } catch (error) {
          await restoreResultArtifactsFromTrash(resultId, trash).catch(() => undefined);
          throw error;
        }
      });
    writeQueueRef.current = operation.catch(() => undefined);
    await operation;
  }, []);

  const setExpiryRemindersEnabled = useCallback(
    async (enabled: boolean) => {
      await mutate((current) => [
        {
          ...current,
          preferences: { ...current.preferences, expiryRemindersEnabled: enabled },
        },
        undefined,
      ]);
    },
    [mutate]
  );

  const resetVault = useCallback(async () => {
    await writeQueueRef.current.catch(() => undefined);
    const emptyDocument = await resetStoredVault();
    writeQueueRef.current = Promise.resolve();
    documentRef.current = emptyDocument;
    setDocument(emptyDocument);
    setError(null);
    setStatus("ready");
  }, []);

  const value = useMemo<VaultContextValue>(
    () => ({
      status,
      error,
      profiles: document.profiles,
      results: document.results,
      activeRuns: document.activeRuns,
      pendingClaimAcknowledgements: document.pendingClaimAcknowledgements,
      profileSlotTombstones: document.profileSlotTombstones,
      expiryRemindersEnabled: document.preferences.expiryRemindersEnabled,
      hasAcceptedDisclosure:
        document.acceptedDisclosureAt !== null &&
        document.acceptedTermsVersion === TERMS_VERSION,
      acceptDisclosure,
      addProfile,
      deleteProfile,
      clearProfileSlotTombstone,
      trackRun,
      removeRun,
      saveResult,
      confirmClaimAcknowledged,
      updatePendingClaim,
      discardPendingClaim,
      deleteResult,
      setExpiryRemindersEnabled,
      resetVault,
    }),
    [
      acceptDisclosure,
      addProfile,
      clearProfileSlotTombstone,
      confirmClaimAcknowledged,
      deleteResult,
      discardPendingClaim,
      deleteProfile,
      document,
      error,
      removeRun,
      resetVault,
      saveResult,
      setExpiryRemindersEnabled,
      status,
      trackRun,
      updatePendingClaim,
    ]
  );

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault(): VaultContextValue {
  const context = useContext(VaultContext);
  if (!context) {
    throw new Error("useVault must be used inside VaultProvider.");
  }
  return context;
}
