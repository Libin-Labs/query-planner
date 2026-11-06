import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createQueryPlanner } from '../dist/esm/index.js';

const require = createRequire(import.meta.url);

test('CommonJS build returns executable plans', () => {
  const { createQueryPlanner: createCjsPlanner } = require('../dist/cjs/index.js');
  assert.equal(
    createCjsPlanner([{ field: 'status', kind: 'hash' }]).plan({
      predicates: [{ field: 'status', operator: 'eq', value: 'ready' }],
    }).steps[0].kind,
    'index',
  );
});

const indexes = [
  { field: 'status', kind: 'hash', estimatedSelectivity: 0.1 },
  { field: 'age', kind: 'range', estimatedSelectivity: 0.2 },
  { field: 'description', kind: 'text', estimatedSelectivity: 0.05 },
];

test('chooses hash index for equality predicates', () => {
  const plan = createQueryPlanner(indexes).plan({
    predicates: [{ field: 'status', operator: 'eq', value: 'ready' }],
  });
  assert.equal(plan.steps[0].kind, 'index');
  assert.equal(plan.steps[0].indexKind, 'hash');
  assert.equal(plan.estimatedRows, 10_000);
});

test('chooses range index for numeric comparisons', () => {
  const plan = createQueryPlanner(indexes).plan({
    predicates: [{ field: 'age', operator: 'gte', value: 18 }],
  });
  assert.equal(plan.steps[0].indexKind, 'range');
});

test('chooses text indexes for contains predicates', () => {
  const plan = createQueryPlanner(indexes).plan({
    predicates: [{ field: 'description', operator: 'contains', value: 'forest' }],
  });
  assert.equal(plan.steps[0].indexKind, 'text');
});

test('in estimate increases by the number of values', () => {
  const planner = createQueryPlanner(indexes, { estimatedRows: 1000 });
  const one = planner.plan({ predicates: [{ field: 'status', operator: 'in', value: ['a'] }] });
  const two = planner.plan({
    predicates: [{ field: 'status', operator: 'in', value: ['a', 'b'] }],
  });
  assert.equal(one.estimatedRows, 100);
  assert.equal(two.estimatedRows, 200);
});

test('unsupported index operators fall back to scans', () => {
  const plan = createQueryPlanner(indexes).plan({
    predicates: [{ field: 'status', operator: 'gt', value: 3 }],
  });
  assert.equal(plan.steps[0].kind, 'scan');
});

test('unknown fields scan and compound selectivities are multiplied', () => {
  const plan = createQueryPlanner(indexes, { estimatedRows: 10_000 }).plan({
    predicates: [
      { field: 'status', operator: 'eq', value: 'ready' },
      { field: 'missing', operator: 'eq', value: true },
    ],
  });
  assert.deepEqual(
    plan.steps.map(({ kind }) => kind),
    ['index', 'scan'],
  );
  assert.equal(plan.estimatedRows, 500);
});

test('adds a sort unless the requested field has a range index', () => {
  const planner = createQueryPlanner(indexes);
  assert.equal(
    planner.plan({ orderBy: 'age' }).steps.some(({ kind }) => kind === 'sort'),
    false,
  );
  assert.equal(
    planner.plan({ orderBy: 'status' }).steps.some(({ kind }) => kind === 'sort'),
    true,
  );
});

test('limit caps estimated rows and is represented as a final step', () => {
  const plan = createQueryPlanner(indexes).plan({ limit: 5 });
  assert.equal(plan.estimatedRows, 5);
  assert.deepEqual(plan.steps.at(-1), { kind: 'limit', estimatedRows: 5 });
});

test('zero cardinality and zero limit are valid', () => {
  assert.equal(createQueryPlanner([], { estimatedRows: 0 }).plan().estimatedRows, 0);
  assert.equal(createQueryPlanner(indexes).plan({ limit: 0 }).estimatedRows, 0);
});

test('validates definitions and duplicate indexes', () => {
  assert.throws(() => createQueryPlanner([{ field: '', kind: 'hash' }]), TypeError);
  assert.throws(
    () =>
      createQueryPlanner([
        { field: 'x', kind: 'hash' },
        { field: 'x', kind: 'range' },
      ]),
    TypeError,
  );
  assert.throws(
    () => createQueryPlanner([{ field: 'x', kind: 'hash', estimatedSelectivity: 0 }]),
    RangeError,
  );
  assert.throws(() => createQueryPlanner([], { estimatedRows: -1 }), RangeError);
});

test('validates predicates, limits and supported operators', () => {
  const planner = createQueryPlanner(indexes, { maxPredicates: 1 });
  assert.throws(
    () => planner.plan({ predicates: [{ field: 'x', operator: 'eq', value: {} }] }),
    TypeError,
  );
  assert.throws(
    () => planner.plan({ predicates: [{ field: 'x', operator: 'in', value: [] }] }),
    RangeError,
  );
  assert.throws(
    () => planner.plan({ predicates: [{ field: 'x', operator: 'in', value: [Infinity] }] }),
    TypeError,
  );
  assert.throws(
    () => planner.plan({ predicates: [{ field: 'age', operator: 'gt', value: '3' }] }),
    TypeError,
  );
  assert.throws(
    () =>
      planner.plan({
        predicates: [
          { field: 'x', operator: 'eq', value: 1 },
          { field: 'y', operator: 'eq', value: 2 },
        ],
      }),
    RangeError,
  );
  assert.throws(() => planner.plan({ limit: -1 }), RangeError);
});

test('generated selectivity estimates follow the documented deterministic formula', () => {
  for (let rows = 1; rows <= 50; rows++) {
    for (let percent = 1; percent <= 10; percent++) {
      const selectivity = percent / 10;
      const plan = createQueryPlanner(
        [{ field: 'x', kind: 'hash', estimatedSelectivity: selectivity }],
        {
          estimatedRows: rows,
        },
      ).plan({ predicates: [{ field: 'x', operator: 'eq', value: 'v' }] });
      assert.equal(plan.estimatedRows, Math.ceil(rows * selectivity));
      assert.equal(plan.steps[0].estimatedRows, Math.ceil(rows * selectivity));
    }
  }
});

test('planning is repeatable and immutable', () => {
  const planner = createQueryPlanner(indexes);
  const input = { predicates: [{ field: 'status', operator: 'eq', value: 'ready' }] };
  const first = planner.plan(input);
  assert.deepEqual(planner.plan(input), first);
  assert.throws(() => first.steps.push({ kind: 'scan' }), TypeError);
  assert.throws(() => {
    first.steps[0].kind = 'scan';
  }, TypeError);
});
