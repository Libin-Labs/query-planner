# @lp-labs/query-planner

A deterministic heuristic planner for a small, explicit query subset. It chooses compatible
indexes, estimates scan/sort work and reports a serializable plan; it does not execute queries.

## Install

```bash
npm install @lp-labs/query-planner
```

ES2022 ESM and CommonJS builds ship with declarations. CommonJS:
`const { createQueryPlanner } = require('@lp-labs/query-planner')`.

## Quickstart

```js
import { createQueryPlanner } from '@lp-labs/query-planner';

const planner = createQueryPlanner([
  { field: 'status', kind: 'hash', estimatedSelectivity: 0.1 },
  { field: 'createdAt', kind: 'range', estimatedSelectivity: 0.05 },
]);
const plan = planner.plan({
  predicates: [
    { field: 'status', operator: 'eq', value: 'ready' },
    { field: 'createdAt', operator: 'gte', value: 1700000000 },
  ],
  orderBy: 'createdAt',
  limit: 25,
});
console.log(plan.steps, plan.estimatedRows);
```

## API and supported subset

`createQueryPlanner(indexes, options?)` accepts unique field index definitions with `kind` equal
to `hash`, `range`, or `text`. Optional `estimatedSelectivity` is in `(0, 1]`, default `0.1`.
Planner options are `estimatedRows` (default 100,000, max one billion) and `maxPredicates`
(default 64, max 256).

`plan({ predicates?, orderBy?, limit? })` supports conjunction-style predicates: `eq`, `in`,
`gt`, `gte`, `lt`, `lte`, and `contains`. Hash indexes support equality/`in`; range indexes
support comparisons; text indexes support `contains`. Unsupported index/operator combinations
become scan steps. A non-range-indexed `orderBy` yields a sort step. The immutable result has
`steps`, `estimatedRows`, and `estimatedCost`. Invalid definitions and queries throw `TypeError`
or `RangeError`.

## Customization and limitations

Provide measured row-count and selectivity estimates for your workload. The planner is
deterministic and intentionally simple: combined selectivities are multiplied, scans are
estimated at full row count, index work at 20% of estimated matches, and sort cost uses
`n * log2(n)`. These are transparent heuristics, not a learned optimizer or execution guarantee.
There are no joins, boolean expression trees, aggregates, projections, database-specific
statistics, index creation, SQL parsing, or query execution. Inputs are strictly checked;
malformed definitions or predicates throw `TypeError`/`RangeError`.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
