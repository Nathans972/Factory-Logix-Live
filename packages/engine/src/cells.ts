// STUB — to be replaced by the engine implementation. See index.ts EngineCellsApi for the contract.
import type { CellColor, Defect, DefectHourCell, GroupedHourCell, HourCell, UtcMs } from '@fld/shared';
import type { ComputeHourCellsInput, ComputeHourCellsOutput, EngineSettings } from '@fld/shared';

const NI = (n: string) => new Error(`engine.cells.${n} not implemented`);

export function computeHourCells(_input: ComputeHourCellsInput): ComputeHourCellsOutput { throw NI('computeHourCells'); }
export function colorForPace(_pace: number | null, _settings: EngineSettings): CellColor { throw NI('colorForPace'); }
export function groupCells(_cells: HourCell[], _settings: EngineSettings, _now: UtcMs): GroupedHourCell[] { throw NI('groupCells'); }
export function computeDefectHourCells(_defects: Defect[], _from_utc: UtcMs, _to_utc: UtcMs, _tz: string): DefectHourCell[] { throw NI('computeDefectHourCells'); }
