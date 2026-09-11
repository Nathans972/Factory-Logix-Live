// STUB — to be replaced by the engine implementation. See index.ts EngineRollupsApi for the contract.
import type { CellColor, HourCell } from '@fld/shared';
import type { EngineSettings, Rollups } from '@fld/shared';

const NI = (n: string) => new Error(`engine.rollups.${n} not implemented`);

export function computeRollups(_cells: HourCell[], _settings: EngineSettings, _labels?: { operator_names?: Record<string, string | null> }): Rollups { throw NI('computeRollups'); }
export function colorForEfficiency(_efficiency: number | null, _settings: EngineSettings): CellColor { throw NI('colorForEfficiency'); }
