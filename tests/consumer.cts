import { createQueryPlanner } from '@lp-labs/query-planner';
const planner = createQueryPlanner([{ field: 'age', kind: 'range' }]);
const estimated: number = planner.plan({
  predicates: [{ field: 'age', operator: 'gte', value: 18 }],
}).estimatedRows;
void estimated;
