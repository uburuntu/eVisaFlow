import type {
  AuthorityBasis,
  IdentityDocument,
  MobileProfile,
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
import { FREE_PROFILE_LIMIT, TERMS_VERSION } from "@/constants/app";
import {
  createEmptyVault,
  loadVault,
  resetVault as resetStoredVault,
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

export class ProfileLimitError extends Error {
  constructor() {
    super("The free profile limit has been reached.");
    this.name = "ProfileLimitError";
  }
}

interface VaultContextValue {
  status: "loading" | "ready" | "error";
  error: Error | null;
  profiles: MobileProfile[];
  hasAcceptedDisclosure: boolean;
  acceptDisclosure: () => Promise<void>;
  addProfile: (input: CreateProfileInput) => Promise<MobileProfile>;
  deleteProfile: (profileId: string) => Promise<void>;
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
    async (input: CreateProfileInput) =>
      mutate((current) => {
        if (current.profiles.length >= FREE_PROFILE_LIMIT) {
          throw new ProfileLimitError();
        }

        const now = new Date().toISOString();
        const profile = validateProfile({
          id: randomUUID(),
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
      await mutate((current) => [
        {
          ...current,
          profiles: current.profiles.filter((profile) => profile.id !== profileId),
        },
        undefined,
      ]);
    },
    [mutate]
  );

  const resetVault = useCallback(async () => {
    const emptyDocument = await resetStoredVault();
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
      hasAcceptedDisclosure:
        document.acceptedDisclosureAt !== null &&
        document.acceptedTermsVersion === TERMS_VERSION,
      acceptDisclosure,
      addProfile,
      deleteProfile,
      resetVault,
    }),
    [acceptDisclosure, addProfile, deleteProfile, document, error, resetVault, status]
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
