import { createQueryPlanner, type QueryPlan } from '@lp-labs/query-planner';
const planner = createQueryPlanner([{ field: 'status', kind: 'hash' }]);
const plan: QueryPlan = planner.plan({
  predicates: [{ field: 'status', operator: 'eq', value: 'ready' }],
});
void plan;
