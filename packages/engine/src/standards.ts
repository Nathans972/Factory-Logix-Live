// STUB — to be replaced by the engine implementation. See index.ts EngineStandardsApi for the contract.
import type { EffectiveStandard, Standard, StandardAdjustment, StandardOverride } from '@fld/shared';
import type { ComputeStandardInput, StandardsLookup, StdKey } from '@fld/shared';

const NI = (n: string) => new Error(`engine.standards.${n} not implemented`);

export function stdKey(product_number: string, operation: string): StdKey { return `${product_number} ${operation}`; }
export function computeStandard(_input: ComputeStandardInput): Standard { throw NI('computeStandard'); }
export function resolveEffectiveStandard(_standard: Standard | null | undefined, _adjustments: StandardAdjustment[], _overrides: StandardOverride[], _product_number: string, _operation: string): EffectiveStandard { throw NI('resolveEffectiveStandard'); }
export function buildStandardsLookup(_standards: Standard[], _adjustments: StandardAdjustment[], _overrides: StandardOverride[], _extraKeys?: { product_number: string; operation: string }[]): StandardsLookup { throw NI('buildStandardsLookup'); }
export function effectiveStdHr(_lookup: StandardsLookup, _product_number: string, _operation: string): number | null { throw NI('effectiveStdHr'); }
