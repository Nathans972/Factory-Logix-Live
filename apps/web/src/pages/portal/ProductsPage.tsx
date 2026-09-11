/** Searchable product list (spec 9.6). */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ProductListItem } from '@fld/shared';
import { useDataSource } from '../../data/DataSourceContext';
import { DataTable, ErrorBox, Input, PageHeader, Spinner, StatusBadge, type Column } from '../../ui';
import { useDebounced } from './components/useDebounced';

export function ProductsPage() {
  const ds = useDataSource();
  const [text, setText] = useState('');
  const q = useDebounced(text);

  const { data, isError, error } = useQuery({
    queryKey: ['products', q],
    queryFn: () => ds.products(q || undefined),
    placeholderData: keepPreviousData,
  });

  const columns: Column<ProductListItem>[] = [
    {
      key: 'product',
      header: 'Product',
      value: (r) => r.product_number,
      render: (r) => (
        <Link className="link" to={'/products/' + encodeURIComponent(r.product_number)}>
          {r.product_number}
        </Link>
      ),
    },
    { key: 'name', header: 'Name', value: (r) => r.name, render: (r) => r.name ?? '—' },
    { key: 'operations', header: 'Operations', align: 'right', render: (r) => r.operations },
    {
      key: 'standards',
      header: 'Standards computed',
      align: 'right',
      value: (r) => r.standards_computed,
      render: (r) => {
        const label = r.standards_computed + ' / ' + r.operations;
        return r.standards_computed < r.operations ? <StatusBadge tone="warn">{label}</StatusBadge> : label;
      },
    },
  ];

  return (
    <>
      <PageHeader title="Products" subtitle={data ? data.length + ' products' : 'Loading…'} />

      <div className="filter-bar">
        <Input className="search-box" placeholder="Search products…" value={text} onChange={(e) => setText(e.target.value)} />
      </div>

      {isError && <ErrorBox error={error} />}
      {!data && !isError && <Spinner />}
      {data && (
        <DataTable
          title="Products"
          columns={columns}
          rows={data}
          rowKey={(r) => r.product_number}
          exportName="products"
          emptyMessage="No products match"
        />
      )}
    </>
  );
}
