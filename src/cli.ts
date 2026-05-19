import { readFile } from "node:fs/promises";
import { Command } from "commander";
import prompts from "prompts";
import { type ConfigFile, ConfigSchema } from "./config.js";
import { EVisaClient } from "./evisa-client.js";
import type {
  Applicant,
  CreateShareCodeResult,
  EVisaClientOptions,
  IdentityDocument,
} from "./types.js";

const program = new Command();

const identityDocumentTypes = ["passport", "nationalId", "brc", "ukvi"] as const;
const twoFactorMethods = ["sms", "email"] as const;
const purposes = ["right_to_work", "right_to_rent", "immigration_status_other"] as const;
const diagnosticsModes = ["off", "sanitized", "raw"] as const;

const parseChoice = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string
): T | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && allowed.includes(value as T)) {
    return value as T;
  }
  throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
};

const parseDob = (value?: string): Applicant["dateOfBirth"] | undefined => {
  if (!value) return undefined;
  const ddmmyyyy = value.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (ddmmyyyy) {
    return `${ddmmyyyy[3]}-${ddmmyyyy[2].padStart(2, "0")}-${ddmmyyyy[1].padStart(2, "0")}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  return undefined;
};

const readConfigFile = async (path?: string): Promise<ConfigFile> => {
  if (!path) return {};
  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  return ConfigSchema.parse(parsed);
};

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
};

const cliValue = <T>(name: string, value: T): T | undefined => {
  return program.getOptionValueSource(name) === "cli" ? value : undefined;
};

const toDocument = (type: IdentityDocument["type"], number: string): IdentityDocument => {
  return { type, number };
};

const ensureApplicant = async (seed?: Partial<Applicant>): Promise<Applicant> => {
  const responses = await prompts(
    [
      {
        type: seed?.identityDocument?.type ? null : "select",
        name: "documentType",
        message: "Which identity document do you use?",
        choices: [
          { title: "Passport", value: "passport" },
          { title: "National identity card", value: "nationalId" },
          { title: "Biometric residence card or permit", value: "brc" },
          { title: "UKVI customer number", value: "ukvi" },
        ],
      },
      {
        type: seed?.identityDocument?.number ? null : "text",
        name: "documentNumber",
        message: "Document number",
      },
      {
        type: seed?.dateOfBirth ? null : "text",
        name: "dob",
        message: "Date of birth (YYYY-MM-DD or DD-MM-YYYY)",
      },
    ],
    { onCancel: () => process.exit(1) }
  );

  const documentType = (seed?.identityDocument?.type ??
    responses.documentType) as IdentityDocument["type"];
  const documentNumber = seed?.identityDocument?.number ?? responses.documentNumber;
  const dateOfBirth = seed?.dateOfBirth ?? parseDob(responses.dob);

  if (!documentType || typeof documentNumber !== "string" || !documentNumber.trim()) {
    throw new Error("Document type and number are required");
  }
  if (!dateOfBirth) {
    throw new Error("Invalid date of birth");
  }

  return {
    identityDocument: toDocument(documentType, documentNumber.trim()),
    dateOfBirth,
  };
};

const resolvePdfConfig = (
  config: ConfigFile,
  options: Record<string, unknown>
): EVisaClientOptions["artifacts"] => {
  let pdf = config.artifacts?.pdf;
  const cliPdf = cliValue("pdf", options.pdf);
  const output = cliValue("output", options.output);
  const outputDir = cliValue("outputDir", options.outputDir);
  const diagnostics = parseChoice(
    cliValue("diagnostics", options.diagnostics),
    diagnosticsModes,
    "--diagnostics"
  );

  if (cliPdf !== undefined) {
    pdf = cliPdf === false ? false : typeof pdf === "object" ? pdf : {};
  }
  if (typeof output === "string" || typeof outputDir === "string") {
    const current = typeof pdf === "object" && pdf.mode !== "bytes" ? pdf : {};
    pdf = {
      ...current,
      mode: "file",
      path: typeof output === "string" ? output : current.path,
      directory: typeof outputDir === "string" ? outputDir : current.directory,
    };
  }

  return {
    ...config.artifacts,
    pdf,
    diagnostics:
      diagnostics !== undefined
        ? { ...config.artifacts?.diagnostics, mode: diagnostics }
        : config.artifacts?.diagnostics,
  };
};

const serializeResult = (
  result: CreateShareCodeResult
): Omit<CreateShareCodeResult, "pdf"> & {
  pdf?:
    | Exclude<CreateShareCodeResult["pdf"], { kind: "bytes" }>
    | {
        kind: "bytes";
        filename: string;
        contentType: "application/pdf";
        byteLength: number;
      };
} => {
  if (result.pdf?.kind !== "bytes") {
    return result;
  }

  const { bytes: _bytes, ...pdf } = result.pdf;
  return { ...result, pdf };
};

export const runCli = async (): Promise<void> => {
  program
    .name("evisa-flow")
    .option("--config <path>", "Path to JSON config file")
    .option("--document-type <type>", "passport|nationalId|brc|ukvi")
    .option("--document-number <value>", "Document number")
    .option("--dob <value>", "Date of birth YYYY-MM-DD or DD-MM-YYYY")
    .option("--two-factor <method>", "sms|email")
    .option("--two-factor-code-stdin", "Read 2FA code from stdin")
    .option("--purpose <purpose>", "right_to_work|right_to_rent|immigration_status_other")
    .option("--pdf", "Download PDF artifact")
    .option("--no-pdf", "Do not download PDF artifact")
    .option("--output <path>", "PDF output path")
    .option("--output-dir <path>", "PDF output directory")
    .option("--diagnostics <mode>", "off|sanitized|raw")
    .option("--headless", "Run headless")
    .option("--no-headless", "Run headed")
    .option("--verbose", "Verbose logging");

  program.parse();
  const options = program.opts();
  const configFile = await readConfigFile(options.config);

  let applicantSeed: Partial<Applicant> | undefined = configFile.applicant
    ? { ...configFile.applicant }
    : undefined;

  const cliDocumentType = parseChoice(
    cliValue("documentType", options.documentType),
    identityDocumentTypes,
    "--document-type"
  );
  const cliDocumentNumber = cliValue(
    "documentNumber",
    options.documentNumber as string | undefined
  );
  if (cliDocumentType || cliDocumentNumber) {
    applicantSeed ??= {};
    applicantSeed.identityDocument = {
      type: cliDocumentType ?? applicantSeed.identityDocument?.type ?? "passport",
      number: cliDocumentNumber ?? applicantSeed.identityDocument?.number ?? "",
    };
  }

  const cliDob = cliValue("dob", options.dob as string | undefined);
  if (cliDob) {
    applicantSeed ??= {};
    applicantSeed.dateOfBirth = parseDob(cliDob);
  }

  const applicant = await ensureApplicant(applicantSeed);
  const cliTwoFactor = parseChoice(
    cliValue("twoFactor", options.twoFactor),
    twoFactorMethods,
    "--two-factor"
  );
  const cliPurpose = parseChoice(
    cliValue("purpose", options.purpose),
    purposes,
    "--purpose"
  );
  const cliHeadless = cliValue("headless", options.headless as boolean | undefined);
  const cliVerbose = cliValue("verbose", options.verbose as boolean | undefined);

  const onChallenge = async (): Promise<{ code: string }> => {
    if (options.twoFactorCodeStdin) {
      return { code: await readStdin() };
    }

    const response = await prompts(
      {
        type: "text",
        name: "code",
        message: "Enter the security code",
      },
      { onCancel: () => process.exit(1) }
    );
    if (!response.code || typeof response.code !== "string") {
      throw new Error("No security code provided");
    }
    return { code: response.code };
  };

  const client = new EVisaClient({
    browser: {
      ...configFile.browser,
      headless: cliHeadless ?? configFile.browser?.headless,
    },
    artifacts: resolvePdfConfig(configFile, options),
    timeouts: configFile.timeouts,
    verbose: cliVerbose ?? configFile.verbose,
  });

  const result = await client.createShareCode({
    applicant,
    purpose: cliPurpose ?? configFile.purpose,
    challengePreference: {
      ...configFile.challengePreference,
      deliveryMethod: cliTwoFactor ?? configFile.challengePreference?.deliveryMethod,
    },
    onChallenge,
  });
  process.stdout.write(`${JSON.stringify(serializeResult(result), null, 2)}\n`);
};
