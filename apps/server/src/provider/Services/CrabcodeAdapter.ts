/**
 * CrabcodeAdapter — shape type for the Crabcode provider adapter.
 *
 * The driver model ({@link ../Drivers/CrabcodeDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module CrabcodeAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * CrabcodeAdapterShape — per-instance Crabcode adapter contract.
 */
export interface CrabcodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
