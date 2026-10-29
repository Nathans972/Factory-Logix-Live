-- One active adjustment or override per scope (data only, idempotent).
--
-- Saving an adjustment or override used to add a row and leave the one it replaced active
-- underneath, so clearing the new one brought the old value back. Saving now turns the replaced
-- one off (spec 7.2). This turns off the rows left underneath before that: on each scope (the same
-- scope, and the same product and operation where the scope names them) only the newest active
-- row stays. That newest row is the one in force, so no effective StdHr changes.
UPDATE standard_adjustments a SET active = false
WHERE a.active
  AND EXISTS (
    SELECT 1 FROM standard_adjustments n
    WHERE n.active
      AND n.scope = a.scope
      AND (a.scope NOT IN ('product', 'product_operation') OR n.product_number IS NOT DISTINCT FROM a.product_number)
      AND (a.scope NOT IN ('operation', 'product_operation') OR n.operation_id IS NOT DISTINCT FROM a.operation_id)
      AND (n.created_at, n.id) > (a.created_at, a.id)
  );

UPDATE standard_overrides o SET active = false
WHERE o.active
  AND EXISTS (
    SELECT 1 FROM standard_overrides n
    WHERE n.active
      AND n.scope = o.scope
      AND n.product_number = o.product_number
      AND (o.scope <> 'product_operation' OR n.operation_id IS NOT DISTINCT FROM o.operation_id)
      AND (n.created_at, n.id) > (o.created_at, o.id)
  );
