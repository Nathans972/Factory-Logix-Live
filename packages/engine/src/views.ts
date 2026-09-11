// STUB — to be replaced by the engine implementation. See index.ts EngineViewsApi for the contract.
import type {
  FloorView, FloorViewInput, JobDetail, JobDetailInput, OperatorDetail, OperatorDetailInput,
  ProductView, ProductViewInput, ShiftView, ShiftViewInput, TvDashboard, TvDashboardInput,
} from '@fld/shared';

const NI = (n: string) => new Error(`engine.views.${n} not implemented`);

export function buildTvDashboard(_input: TvDashboardInput): TvDashboard { throw NI('buildTvDashboard'); }
export function buildShiftView(_input: ShiftViewInput): ShiftView { throw NI('buildShiftView'); }
export function buildFloorView(_input: FloorViewInput): FloorView { throw NI('buildFloorView'); }
export function buildOperatorDetail(_input: OperatorDetailInput): OperatorDetail { throw NI('buildOperatorDetail'); }
export function buildJobDetail(_input: JobDetailInput): JobDetail { throw NI('buildJobDetail'); }
export function buildProductView(_input: ProductViewInput): ProductView { throw NI('buildProductView'); }
