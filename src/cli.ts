import { Command } from "commander";
import prompts from "prompts";
import { readFile } from "node:fs/promises";
import { EVisaFlow } from "./evisa-flow.js";
import { ConfigSchema, type ConfigFile } from "./config.js";
import type {
  AuthMethod,
  Credentials,
  Purpose,
  TwoFactorMethod,
} from "./types.js";

const program = new Command();

const parseDob = (value?: string): Credentials["dateOfBirth"] | undefined => {
  if (!value) return undefined;
  const [day, month, year] = value.split("-").map((part) => Number(part));
  if (!day || !month || !year) return undefined;
  return { day, month, year };
};

const readConfigFile = async (path?: string): Promise<ConfigFile | undefined> => {
  if (!path) return undefined;
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

const ensureCredentials = async (
  seed?: Partial<Credentials>
): Promise<Credentials> => {
  const responses = await prompts(
    [
      {
        type: seed?.auth?.type ? null : "select",
        name: "authType",
        message: "Which identity document do you use?",
        choices: [
          { title: "Passport", value: "passport" },
          { title: "National identity card", value: "nationalId" },
          { title: "Biometric residence card or permit", value: "brc" },
          { title: "UKVI customer number", value: "ukvi" },
        ],
      },
      {
        type: seed?.auth?.type === "passport" || !seed?.auth?.type ? "text" : null,
        name: "passportNumber",
        message: "Passport number",
      },
      {
        type: seed?.auth?.type === "nationalId" ? "text" : null,
        name: "idNumber",
        message: "National identity card number",
      },
      {
        type: seed?.auth?.type === "brc" ? "text" : null,
        name: "cardNumber",
        message: "Biometric residence card or permit number",
      },
      {
        type: seed?.auth?.type === "ukvi" ? "text" : null,
        name: "customerNumber",
        message: "UKVI customer number",
      },
      {
        type: seed?.dateOfBirth ? null : "text",
        name: "dob",
        message: "Date of birth (DD-MM-YYYY)",
      },
      {
        type: seed?.preferredTwoFactorMethod ? null : "select",
        name: "twoFactor",
        message: "Preferred 2FA method",
        choices: [
          { title: "SMS", value: "sms" },
          { title: "Email", value: "email" },
        ],
      },
    ],
    { onCancel: () => process.exit(1) }
  );

  const authType = (seed?.auth?.type ??
    responses.authType) as AuthMethod["type"];

  const auth: AuthMethod =
    authType === "passport"
      ? {
          type: "passport",
          passportNumber:
            seed?.auth?.type === "passport"
              ? seed.auth.passportNumber ?? responses.passportNumber
              : responses.passportNumber,
        }
      : authType === "nationalId"
      ? {
          type: "nationalId",
          idNumber:
            seed?.auth?.type === "nationalId"
              ? seed.auth.idNumber ?? responses.idNumber
              : responses.idNumber,
        }
      : authType === "brc"
      ? {
          type: "brc",
          cardNumber:
            seed?.auth?.type === "brc"
              ? seed.auth.cardNumber ?? responses.cardNumber
              : responses.cardNumber,
        }
      : {
          type: "ukvi",
          customerNumber:
            seed?.auth?.type === "ukvi"
              ? seed.auth.customerNumber ?? responses.customerNumber
              : responses.customerNumber,
        };

  const dob = seed?.dateOfBirth ?? parseDob(responses.dob);
  if (!dob) {
    throw new Error("Invalid date of birth");
  }

  return {
    auth,
    dateOfBirth: dob,
    preferredTwoFactorMethod:
      seed?.preferredTwoFactorMethod ?? (responses.twoFactor as TwoFactorMethod),
  };
};

export const runCli = async (): Promise<void> => {
  program
    .name("evisa-flow")
    .option("--config <path>", "Path to JSON config file")
    .option("--auth-type <type>", "passport|nationalId|brc|ukvi")
    .option("--passport-number <value>", "Passport number")
    .option("--id-number <value>", "National identity card number")
    .option("--card-number <value>", "BRC/BRP number")
    .option("--ukvi-number <value>", "UKVI customer number")
    .option("--dob <value>", "Date of birth DD-MM-YYYY")
    .option("--two-factor <method>", "sms|email")
    .option("--two-factor-code-stdin", "Read 2FA code from stdin")
    .option("--purpose <purpose>", "right_to_work|right_to_rent|immigration_status_other")
    .option("--output <path>", "Output PDF path")
    .option("--output-dir <path>", "Output directory")
    .option("--headless", "Run headless", true)
    .option("--no-headless", "Run headed")
    .option("--verbose", "Verbose logging", false);

  program.parse();
  const options = program.opts();

  const configFile = await readConfigFile(options.config);
  const cliAuthType = options.authType as AuthMethod["type"] | undefined;

  let seedCredentials: Partial<Credentials> | undefined = configFile?.credentials
    ? {
        ...configFile.credentials,
      }
    : undefined;

  if (cliAuthType) {
    seedCredentials ??= {};
    seedCredentials.auth =
      cliAuthType === "passport"
        ? { type: "passport", passportNumber: options.passportNumber }
        : cliAuthType === "nationalId"
        ? { type: "nationalId", idNumber: options.idNumber }
        : cliAuthType === "brc"
        ? { type: "brc", cardNumber: options.cardNumber }
        : { type: "ukvi", customerNumber: options.ukviNumber };
  }

  if (options.dob) {
    seedCredentials ??= {};
    seedCredentials.dateOfBirth = parseDob(options.dob);
  }

  if (options.twoFactor) {
    seedCredentials ??= {};
    seedCredentials.preferredTwoFactorMethod = options.twoFactor as TwoFactorMethod;
  }

  const credentials = await ensureCredentials(seedCredentials);

  const purpose =
    (options.purpose as Purpose | undefined) ?? configFile?.purpose;

  const outputFile = options.output ?? configFile?.options?.outputFile;
  const outputDir = options.outputDir ?? configFile?.options?.outputDir;

  const onTwoFactorRequired = async (_method: TwoFactorMethod): Promise<string> => {
    if (options.twoFactorCodeStdin) {
      return readStdin();
    }

    const response = await prompts(
      {
        type: "text",
        name: "code",
        message: "Enter the 6-digit security code",
      },
      { onCancel: () => process.exit(1) }
    );
    return response.code as string;
  };

  const flow = new EVisaFlow({
    credentials,
    purpose,
    onTwoFactorRequired,
    options: {
      ...configFile?.options,
      headless: options.headless,
      verbose: options.verbose,
      outputFile,
      outputDir,
    },
  });

  const result = await flow.run();
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
};
