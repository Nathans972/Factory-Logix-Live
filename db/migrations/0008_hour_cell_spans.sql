-- Where in the hour each cell's units, work, window and breaks fall (HourCell.spans).
--
-- Hour cells cover whole clock hours, so a shift that changes mid-hour (06:30) used to get the whole
-- 06:00-07:00 cell in the shift the hour starts in. With the spans each shift takes only its part
-- of the hours at its ends. Cells written before this have none and keep going whole to the shift
-- their hour starts in until the collector computes them again.
ALTER TABLE hour_cells ADD COLUMN IF NOT EXISTS spans jsonb;
