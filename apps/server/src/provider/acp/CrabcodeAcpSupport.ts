import { type CrabcodeSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { extractModelConfigId } from "./AcpRuntimeModel.ts";

const CRABCODE_DRIVER_KIND = ProviderDriverKind.make("crabcode");

type CrabcodeAcpRuntimeSettings = Pick<CrabcodeSettings, "binaryPath">;

interface CrabcodeAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly crabcodeSettings: CrabcodeAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildCrabcodeAcpSpawnInput(
  crabcodeSettings: CrabcodeAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: crabcodeSettings?.binaryPath || "crabcode",
    args: ["acp"],
    cwd,
    ...(environment !== undefined ? { env: environment } : {}),
  };
}

export const makeCrabcodeAcpRuntime = (
  input: CrabcodeAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildCrabcodeAcpSpawnInput(input.crabcodeSettings, input.cwd, input.environment),
        // Crabcode does not implement ACP `authenticate`.
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function resolveCrabcodeAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "auto";
  return normalizeModelSlug(base, CRABCODE_DRIVER_KIND) ?? "auto";
}

export function currentCrabcodeModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  const modelConfigId = extractModelConfigId(sessionSetupResult);
  if (modelConfigId) {
    const option = sessionSetupResult.configOptions?.find((entry) => entry.id === modelConfigId);
    const current = option && "currentValue" in option ? option.currentValue : undefined;
    if (typeof current === "string" && current.trim().length > 0) {
      return current.trim();
    }
  }
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function applyCrabcodeAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "setConfigOption" | "setSessionModel"
  >;
  readonly modelConfigId?: string | undefined;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  if (!shouldSwitchModel) {
    return Effect.succeed(input.currentModelId);
  }
  if (input.modelConfigId) {
    return input.runtime
      .setConfigOption(input.modelConfigId, input.requestedModelId)
      .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
  }
  return input.runtime
    .setSessionModel(input.requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}
