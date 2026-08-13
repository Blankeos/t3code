import {
  type CrabcodeSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  makeCrabcodeAcpRuntime,
  resolveCrabcodeAcpBaseModelId,
} from "../acp/CrabcodeAcpSupport.ts";

const CRABCODE_PRESENTATION = {
  displayName: "Crabcode",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const CRABCODE_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

const CRABCODE_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "auto",
    name: "Auto",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialCrabcodeProviderSnapshot(
  crabcodeSettings: CrabcodeSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = crabcodeModelsFromSettings(crabcodeSettings.customModels);

    if (!crabcodeSettings.enabled) {
      return buildServerProvider({
        presentation: CRABCODE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Crabcode is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CRABCODE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Crabcode CLI availability...",
      },
    });
  });
}

function crabcodeModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = CRABCODE_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

function buildCrabcodeDiscoveredModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  return modelState.availableModels
    .map((model): ServerProviderModel | undefined => {
      const slug = resolveCrabcodeAcpBaseModelId(model.modelId);
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      return {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

/** Crabcode exposes the catalog via ACP `configOptions` (category model), not `models`. */
function buildCrabcodeDiscoveredModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!configOptions) {
    return [];
  }
  const modelOption = configOptions.find((option) => option.category === "model");
  if (!modelOption || modelOption.type !== "select") {
    return [];
  }
  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];
  for (const entry of modelOption.options) {
    const value = "value" in entry ? entry.value : undefined;
    const name = "name" in entry ? entry.name : undefined;
    if (typeof value !== "string" || value.trim().length === 0) {
      continue;
    }
    const slug = resolveCrabcodeAcpBaseModelId(value);
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    models.push({
      slug,
      name: typeof name === "string" && name.trim().length > 0 ? name.trim() : slug,
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    });
  }
  return models;
}

function buildCrabcodeDiscoveredModelsFromCliLines(
  stdout: string,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];
  for (const line of stdout.split("\n")) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) {
      continue;
    }
    const slug = resolveCrabcodeAcpBaseModelId(raw);
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    models.push({
      slug,
      name: slug,
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    });
  }
  return models;
}

const discoverCrabcodeModelsViaCli = (
  crabcodeSettings: CrabcodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = crabcodeSettings.binaryPath || "crabcode";
    const spawnCommand = yield* resolveSpawnCommand(command, ["models"], {
      env: environment,
    });
    const result = yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
    return buildCrabcodeDiscoveredModelsFromCliLines(result.stdout);
  });

const discoverCrabcodeModelsViaAcp = (
  crabcodeSettings: CrabcodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeCrabcodeAcpRuntime({
      crabcodeSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    const fromConfig = buildCrabcodeDiscoveredModelsFromConfigOptions(
      started.sessionSetupResult.configOptions,
    );
    if (fromConfig.length > 0) {
      return fromConfig;
    }
    return buildCrabcodeDiscoveredModelsFromSessionModelState(started.sessionSetupResult.models);
  }).pipe(Effect.scoped);

const runCrabcodeVersionCommand = (
  crabcodeSettings: CrabcodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = crabcodeSettings.binaryPath || "crabcode";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkCrabcodeProviderStatus = Effect.fn("checkCrabcodeProviderStatus")(function* (
  crabcodeSettings: CrabcodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = crabcodeModelsFromSettings(crabcodeSettings.customModels);

  if (!crabcodeSettings.enabled) {
    return buildServerProvider({
      presentation: CRABCODE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Crabcode is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runCrabcodeVersionCommand(crabcodeSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Crabcode CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: CRABCODE_PRESENTATION,
      enabled: crabcodeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Crabcode CLI (`crabcode`) is not installed or not on PATH."
          : "Failed to execute Crabcode CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: CRABCODE_PRESENTATION,
      enabled: crabcodeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Crabcode CLI is installed but timed out while running `crabcode --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Crabcode CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: CRABCODE_PRESENTATION,
      enabled: crabcodeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Crabcode CLI is installed but failed to run.",
      },
    });
  }

  // Prefer `crabcode models` (full catalog). Fall back to ACP session configOptions.
  const discoveryExit = yield* discoverCrabcodeModelsViaCli(crabcodeSettings, environment).pipe(
    Effect.catch(() => discoverCrabcodeModelsViaAcp(crabcodeSettings, environment)),
    Effect.timeoutOption(CRABCODE_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Crabcode ACP model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: CRABCODE_PRESENTATION,
      enabled: crabcodeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Crabcode CLI is installed but ACP startup failed. Check server logs for details.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `Crabcode ACP model discovery timed out after ${CRABCODE_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
      presentation: CRABCODE_PRESENTATION,
      enabled: crabcodeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Crabcode CLI is installed but ACP startup timed out after ${CRABCODE_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }
  const discoveredModels = discoveryExit.value.value;
  const models =
    discoveredModels.length > 0
      ? crabcodeModelsFromSettings(crabcodeSettings.customModels, discoveredModels)
      : fallbackModels;

  return buildServerProvider({
    presentation: CRABCODE_PRESENTATION,
    enabled: crabcodeSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
    },
  });
});

export const enrichCrabcodeSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Crabcode version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
