export type PredicateOperator = 'eq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains';

export interface Predicate {
  field: string;
  operator: PredicateOperator;
  value: string | number | boolean | readonly (string | number | boolean)[];
}

export interface IndexDefinition {
  field: string;
  kind: 'hash' | 'range' | 'text';
  estimatedSelectivity?: number;
}

export interface QueryPlanInput {
  predicates?: readonly Predicate[];
  orderBy?: string;
  limit?: number;
}

export interface PlanStep {
  kind: 'index' | 'scan' | 'sort' | 'limit';
  field?: string;
  indexKind?: IndexDefinition['kind'];
  operator?: PredicateOperator;
  estimatedRows?: number;
}

export interface QueryPlan {
  steps: readonly PlanStep[];
  estimatedRows: number;
  estimatedCost: number;
}

export interface PlannerOptions {
  estimatedRows?: number;
  maxPredicates?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

function assertPlainObject(value: unknown, name: string): void {
  if (!isRecord(value)) throw new TypeError(`${name} must be a plain object.`);
}

function safeCount(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function validField(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function predicate(input: unknown): Predicate {
  if (!isRecord(input) || !validField(input.field)) throw new TypeError('Invalid predicate field.');
  const operators: PredicateOperator[] = ['eq', 'in', 'gt', 'gte', 'lt', 'lte', 'contains'];
  if (!operators.includes(input.operator as PredicateOperator)) {
    throw new TypeError('Unsupported predicate operator.');
  }
  const value = input.value;
  if (input.operator === 'in') {
    if (!Array.isArray(value) || value.length === 0 || value.length > 1000) {
      throw new RangeError('An in predicate requires 1..1000 values.');
    }
    if (
      value.some(
        (item) =>
          !['string', 'number', 'boolean'].includes(typeof item) ||
          (typeof item === 'number' && !Number.isFinite(item)),
      )
    ) {
      throw new TypeError('Predicate values must be strings, numbers, or booleans.');
    }
  } else if (
    typeof value !== 'string' &&
    typeof value !== 'boolean' &&
    (typeof value !== 'number' || !Number.isFinite(value))
  ) {
    throw new TypeError('Predicate value must be a finite scalar.');
  }
  if (
    (input.operator === 'gt' ||
      input.operator === 'gte' ||
      input.operator === 'lt' ||
      input.operator === 'lte') &&
    typeof value !== 'number'
  ) {
    throw new TypeError('Range predicates require a numeric value.');
  }
  if (input.operator === 'contains' && typeof value !== 'string') {
    throw new TypeError('Text contains predicates require a string value.');
  }
  return {
    field: input.field,
    operator: input.operator as PredicateOperator,
    value: value as Predicate['value'],
  };
}

export function createQueryPlanner(
  definitions: readonly IndexDefinition[],
  options: PlannerOptions = {},
): { plan(input?: QueryPlanInput): QueryPlan } {
  if (!Array.isArray(definitions) || definitions.length > 10_000) {
    throw new RangeError('Index definitions must be an array of at most 10000 entries.');
  }
  assertPlainObject(options, 'Options');
  const estimatedRows = safeCount(
    options.estimatedRows ?? 100_000,
    'estimatedRows',
    0,
    1_000_000_000,
  );
  const maxPredicates = safeCount(options.maxPredicates ?? 64, 'maxPredicates', 1, 256);
  const indexes = new Map<string, IndexDefinition>();
  for (const raw of definitions) {
    if (!isRecord(raw) || !validField(raw.field)) throw new TypeError('Invalid index definition.');
    if (typeof raw.kind !== 'string' || !['hash', 'range', 'text'].includes(raw.kind)) {
      throw new TypeError('Invalid index kind.');
    }
    const field = raw.field as string;
    const kind = raw.kind as IndexDefinition['kind'];
    if (indexes.has(field)) throw new TypeError(`Duplicate index for field ${field}.`);
    const selectivity = raw.estimatedSelectivity ?? 0.1;
    if (
      typeof selectivity !== 'number' ||
      !Number.isFinite(selectivity) ||
      selectivity <= 0 ||
      selectivity > 1
    ) {
      throw new RangeError('estimatedSelectivity must be in (0, 1].');
    }
    indexes.set(field, Object.freeze({ field, kind, estimatedSelectivity: selectivity }));
  }
  return {
    plan(input = {}) {
      assertPlainObject(input, 'Query');
      const rawPredicates = input.predicates ?? [];
      if (!Array.isArray(rawPredicates) || rawPredicates.length > maxPredicates) {
        throw new RangeError(`At most ${maxPredicates} predicates are supported.`);
      }
      const predicates = rawPredicates.map(predicate);
      const orderBy = input.orderBy;
      if (orderBy !== undefined && !validField(orderBy))
        throw new TypeError('Invalid orderBy field.');
      const limit =
        input.limit === undefined ? undefined : safeCount(input.limit, 'limit', 0, 1_000_000);
      const steps: PlanStep[] = [];
      let selectivity = 1;
      let cost = 0;
      for (const item of predicates) {
        const index = indexes.get(item.field);
        const usable =
          index &&
          ((index.kind === 'hash' && (item.operator === 'eq' || item.operator === 'in')) ||
            (index.kind === 'range' &&
              ['eq', 'in', 'gt', 'gte', 'lt', 'lte'].includes(item.operator)) ||
            (index.kind === 'text' && item.operator === 'contains'));
        if (usable) {
          const factor =
            item.operator === 'in' && Array.isArray(item.value)
              ? Math.min(1, index.estimatedSelectivity! * item.value.length)
              : index.estimatedSelectivity!;
          selectivity *= factor;
          cost += Math.max(1, estimatedRows * factor * 0.2);
          steps.push({
            kind: 'index',
            field: item.field,
            indexKind: index.kind,
            operator: item.operator,
            estimatedRows: Math.ceil(estimatedRows * factor),
          });
        } else {
          selectivity *= 0.5;
          cost += estimatedRows;
          steps.push({ kind: 'scan', field: item.field, operator: item.operator, estimatedRows });
        }
      }
      let rows = Math.ceil(estimatedRows * selectivity);
      if (orderBy !== undefined) {
        if (!indexes.has(orderBy) || indexes.get(orderBy)!.kind !== 'range') {
          steps.push({ kind: 'sort', field: orderBy, estimatedRows: rows });
          cost += rows === 0 ? 0 : rows * Math.log2(Math.max(2, rows));
        }
      }
      if (limit !== undefined) {
        rows = Math.min(rows, limit);
        steps.push({ kind: 'limit', estimatedRows: rows });
      }
      return Object.freeze({
        steps: Object.freeze(steps.map((step) => Object.freeze(step))),
        estimatedRows: rows,
        estimatedCost: cost,
      });
    },
  };
}
