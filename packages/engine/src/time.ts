// STUB — to be replaced by the engine implementation. See index.ts EngineTimeApi for the contract.
import type { BreakDef, BreakInterval, LocalDate, LocalTime, ShiftDef, ShiftInstance, UtcMs } from '@fld/shared';
import type { WindowColumn } from '@fld/shared';
import type { LocalParts, LocalPartsInput } from './index.js';

const NI = (n: string) => new Error(`engine.time.${n} not implemented`);

export function getTzOffsetMs(_tz: string, _utcMs: UtcMs): number { throw NI('getTzOffsetMs'); }
export function utcToLocalParts(_utcMs: UtcMs, _tz: string): LocalParts { throw NI('utcToLocalParts'); }
export function localToUtc(_tz: string, _parts: LocalPartsInput, _opts?: { ambiguous?: 'earlier' | 'later' }): UtcMs { throw NI('localToUtc'); }
export function hourStartUtc(_utcMs: UtcMs, _tz: string): UtcMs { throw NI('hourStartUtc'); }
export function hourLabel(_hourStartUtc: UtcMs, _tz: string): string { throw NI('hourLabel'); }
export function localDateString(_utcMs: UtcMs, _tz: string): LocalDate { throw NI('localDateString'); }
export function addDays(_date: LocalDate, _n: number): LocalDate { throw NI('addDays'); }
export function dayOfWeek(_date: LocalDate): number { throw NI('dayOfWeek'); }
export function parseLocalTime(_t: LocalTime): number { throw NI('parseLocalTime'); }
export function expandShiftInstance(_shift: ShiftDef, _date: LocalDate, _tz: string): ShiftInstance { throw NI('expandShiftInstance'); }
export function listShiftInstances(_shifts: ShiftDef[], _fromUtc: UtcMs, _toUtc: UtcMs, _tz: string): ShiftInstance[] { throw NI('listShiftInstances'); }
export function findCurrentShift(_shifts: ShiftDef[], _now: UtcMs, _tz: string): ShiftInstance | null { throw NI('findCurrentShift'); }
export function findCurrentOrMostRecentShift(_shifts: ShiftDef[], _now: UtcMs, _tz: string): ShiftInstance | null { throw NI('findCurrentOrMostRecentShift'); }
export function expandBreaks(_breaks: BreakDef[], _shifts: ShiftDef[], _fromUtc: UtcMs, _toUtc: UtcMs, _tz: string): BreakInterval[] { throw NI('expandBreaks'); }
export function rollingWindowColumns(_now: UtcMs, _tz: string, _hours?: number): WindowColumn[] { throw NI('rollingWindowColumns'); }
export function hourColumns(_fromUtc: UtcMs, _toUtc: UtcMs, _tz: string): WindowColumn[] { throw NI('hourColumns'); }
export function nextLocalTime(_tz: string, _time: LocalTime, _afterUtc: UtcMs): UtcMs { throw NI('nextLocalTime'); }
export function inLocalWindow(_tz: string, _utcMs: UtcMs, _start: LocalTime, _end: LocalTime): boolean { throw NI('inLocalWindow'); }
export function overlapWithIntervals(_aStart: UtcMs, _aEnd: UtcMs, _intervals: { start_utc: UtcMs; end_utc: UtcMs }[]): number { throw NI('overlapWithIntervals'); }
