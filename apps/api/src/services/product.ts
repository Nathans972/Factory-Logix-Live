/** Product / standards view (spec 9.6). */
import type { ProductView } from '@fld/shared';
import { buildProductView } from '@fld/engine';
import type { Db } from '../db/pool.js';
import { getProduct } from '../db/repo/products.js';
import { getRouteForProduct } from '../db/repo/routes.js';
import { getStandardsForProduct, listAdjustments, listOverrides } from '../db/repo/standards.js';
import { notFound } from '../errors.js';

export async function buildProductViewFor(db: Db, productNumber: string): Promise<ProductView> {
  const product = await getProduct(db, productNumber);
  const [route, standards, adjustments, overrides] = await Promise.all([
    getRouteForProduct(db, productNumber),
    getStandardsForProduct(db, productNumber),
    listAdjustments(db, { activeOnly: true }),
    listOverrides(db, { productNumber, activeOnly: true }),
  ]);

  if (!product && route.length === 0 && standards.length === 0) throw notFound(`unknown product ${productNumber}`);

  return buildProductView({
    product_number: productNumber,
    product_name: product?.name ?? null,
    route,
    standards,
    adjustments,
    overrides,
  });
}
