import { test, expect } from '@playwright/test';
import { createTestContext, destroyTestContext, createFactory, type TestContext } from '../test-helpers.js';
import { TaskStatus, TaskPriority } from '@cognistore/shared';

let ctx: TestContext;
let factory: ReturnType<typeof createFactory>;

test.beforeAll(() => {
  ctx = createTestContext();
  factory = createFactory(ctx.service);
});
test.afterAll(() => {
  destroyTestContext(ctx);
});

test('createPlanTask auto-calculates position', async () => {
  const plan = await factory.plan({ title: 'Position Test Plan' });

  const t1 = factory.planTask(plan.id, { description: 'First task' });
  const t2 = factory.planTask(plan.id, { description: 'Second task' });
  const t3 = factory.planTask(plan.id, { description: 'Third task' });

  expect(t1.position).toBe(0);
  expect(t2.position).toBe(1);
  expect(t3.position).toBe(2);
});

test('createPlanTask with priority=high', async () => {
  const plan = await factory.plan({ title: 'Priority Test Plan' });

  const task = factory.planTask(plan.id, { description: 'High priority task', priority: 'high' });

  expect(task.priority).toBe(TaskPriority.HIGH);
  expect(task.description).toBe('High priority task');
  expect(task.status).toBe(TaskStatus.PENDING);
});

test('updatePlanTask changes status pending -> in_progress -> completed', async () => {
  const plan = await factory.plan({ title: 'Status Transition Plan' });
  const task = factory.planTask(plan.id, { description: 'Status task' });
  expect(task.status).toBe(TaskStatus.PENDING);

  const inProgress = ctx.service.updatePlanTask(task.id, { status: TaskStatus.IN_PROGRESS });
  expect(inProgress).not.toBeNull();
  expect(inProgress!.task.status).toBe(TaskStatus.IN_PROGRESS);

  const completed = ctx.service.updatePlanTask(task.id, { status: TaskStatus.COMPLETED });
  expect(completed).not.toBeNull();
  expect(completed!.task.status).toBe(TaskStatus.COMPLETED);
});

test('updatePlanTask adds notes', async () => {
  const plan = await factory.plan({ title: 'Notes Test Plan' });
  const task = factory.planTask(plan.id, { description: 'Notes task' });
  expect(task.notes).toBeNull();

  const updated = ctx.service.updatePlanTask(task.id, { notes: 'Some important notes here' });
  expect(updated).not.toBeNull();
  expect(updated!.task.notes).toBe('Some important notes here');
});

test('updatePlanTask changes priority', async () => {
  const plan = await factory.plan({ title: 'Priority Change Plan' });
  const task = factory.planTask(plan.id, { description: 'Priority change task' });
  expect(task.priority).toBe(TaskPriority.MEDIUM);

  const updated = ctx.service.updatePlanTask(task.id, { priority: TaskPriority.LOW });
  expect(updated).not.toBeNull();
  expect(updated!.task.priority).toBe(TaskPriority.LOW);
});

test('listPlanTasks returns ordered by position', async () => {
  const plan = await factory.plan({ title: 'Order Test Plan' });

  factory.planTask(plan.id, { description: 'Task at pos 0' });
  factory.planTask(plan.id, { description: 'Task at pos 1' });
  factory.planTask(plan.id, { description: 'Task at pos 2' });

  const tasks = ctx.service.listPlanTasks(plan.id);
  expect(tasks).toHaveLength(3);
  expect(tasks[0].position).toBe(0);
  expect(tasks[1].position).toBe(1);
  expect(tasks[2].position).toBe(2);
  expect(tasks[0].description).toBe('Task at pos 0');
  expect(tasks[1].description).toBe('Task at pos 1');
  expect(tasks[2].description).toBe('Task at pos 2');
});

test('deletePlanTask works', async () => {
  const plan = await factory.plan({ title: 'Delete Task Plan' });
  const task = factory.planTask(plan.id, { description: 'Doomed task' });

  const result = ctx.service.deletePlanTask(task.id);
  expect(result.deleted).toBe(true);
  expect(result.planId).toBe(plan.id);

  const tasks = ctx.service.listPlanTasks(plan.id);
  expect(tasks.find((t) => t.id === task.id)).toBeUndefined();
});

test('deletePlanTask returns not-deleted for unknown task', async () => {
  const result = ctx.service.deletePlanTask('nonexistent-task-id');
  expect(result.deleted).toBe(false);
});

test('deletePlanTask auto-completes plan when remaining tasks are all done', async () => {
  const plan = await factory.plan({ title: 'Delete Auto-Complete Plan' });
  const t1 = factory.planTask(plan.id, { description: 'Done task' });
  const t2 = factory.planTask(plan.id, { description: 'To be removed (still pending)' });

  // Complete t1; plan stays active because t2 is still pending.
  ctx.service.updatePlanTask(t1.id, { status: TaskStatus.IN_PROGRESS });
  ctx.service.updatePlanTask(t1.id, { status: TaskStatus.COMPLETED });
  expect(ctx.service.getPlanById(plan.id)!.status).toBe('active');

  // Removing the last pending task leaves all remaining tasks completed → auto-complete.
  const result = ctx.service.deletePlanTask(t2.id);
  expect(result.deleted).toBe(true);
  expect(result.planStatus).toBe('completed');
  expect(result.autoActions).toContainEqual(expect.stringContaining('auto-completed'));
});

test('deletePlanTask does NOT auto-complete an emptied plan', async () => {
  const plan = await factory.plan({ title: 'Delete Emptied Plan' });
  const t1 = factory.planTask(plan.id, { description: 'Only task' });

  // Activate then delete the single task — plan must NOT become completed (no tasks remain).
  ctx.service.updatePlanTask(t1.id, { status: TaskStatus.IN_PROGRESS });
  const result = ctx.service.deletePlanTask(t1.id);
  expect(result.deleted).toBe(true);
  expect(result.planStatus).toBe('active');
  expect(result.autoActions).toHaveLength(0);
});

test('deletePlanTask does NOT auto-complete when a task is still pending', async () => {
  const plan = await factory.plan({ title: 'Delete Keeps Pending Plan' });
  const t1 = factory.planTask(plan.id, { description: 'Completed task' });
  const t2 = factory.planTask(plan.id, { description: 'Still pending task' });

  ctx.service.updatePlanTask(t1.id, { status: TaskStatus.IN_PROGRESS });
  ctx.service.updatePlanTask(t1.id, { status: TaskStatus.COMPLETED });

  // Deleting the already-completed task leaves a pending task → plan stays active.
  const result = ctx.service.deletePlanTask(t1.id);
  expect(result.deleted).toBe(true);
  expect(result.planStatus).toBe('active');
  expect(result.autoActions).toHaveLength(0);
  expect(ctx.service.listPlanTasks(plan.id).find((t) => t.id === t2.id)).toBeDefined();
});

test('getPlanTaskStats returns correct counts', async () => {
  const plan = await factory.plan({ title: 'Stats Test Plan' });

  const t1 = factory.planTask(plan.id, { description: 'Pending task 1' });
  const t2 = factory.planTask(plan.id, { description: 'Pending task 2' });
  const t3 = factory.planTask(plan.id, { description: 'Pending task 3' });
  const t4 = factory.planTask(plan.id, { description: 'Pending task 4' });

  // Move some tasks to different statuses
  ctx.service.updatePlanTask(t2.id, { status: TaskStatus.IN_PROGRESS });
  ctx.service.updatePlanTask(t3.id, { status: TaskStatus.COMPLETED });
  ctx.service.updatePlanTask(t4.id, { status: TaskStatus.COMPLETED });

  const stats = ctx.service.getPlanTaskStats();
  // Stats are global across all plans, but we can verify the totals include our tasks
  expect(stats.total).toBeGreaterThanOrEqual(4);
  expect(stats.pending).toBeGreaterThanOrEqual(1);
  expect(stats.inProgress).toBeGreaterThanOrEqual(1);
  expect(stats.completed).toBeGreaterThanOrEqual(2);
});

test('stats update correctly as tasks change status', async () => {
  const plan = await factory.plan({ title: 'Stats Update Plan' });
  const task = factory.planTask(plan.id, { description: 'Tracking task' });

  const statsBefore = ctx.service.getPlanTaskStats();

  ctx.service.updatePlanTask(task.id, { status: TaskStatus.IN_PROGRESS });
  const statsAfterProgress = ctx.service.getPlanTaskStats();
  expect(statsAfterProgress.inProgress).toBe(statsBefore.inProgress + 1);
  expect(statsAfterProgress.pending).toBe(statsBefore.pending - 1);

  ctx.service.updatePlanTask(task.id, { status: TaskStatus.COMPLETED });
  const statsAfterComplete = ctx.service.getPlanTaskStats();
  expect(statsAfterComplete.completed).toBe(statsBefore.completed + 1);
  expect(statsAfterComplete.inProgress).toBe(statsBefore.inProgress);
});

test('auto-activate: plan moves from draft to active when task starts', async () => {
  const plan = await factory.plan({ title: 'Auto-Activate Plan' });
  expect(plan.status).toBe('draft');
  const task = factory.planTask(plan.id, { description: 'First task' });

  const result = ctx.service.updatePlanTask(task.id, { status: TaskStatus.IN_PROGRESS });
  expect(result).not.toBeNull();
  expect(result!.planStatus).toBe('active');
  expect(result!.autoActions).toContainEqual(expect.stringContaining('auto-activated'));
});

test('auto-complete: plan completes when all tasks are done', async () => {
  const plan = await factory.plan({ title: 'Auto-Complete Plan' });
  const t1 = factory.planTask(plan.id, { description: 'Task 1' });
  const t2 = factory.planTask(plan.id, { description: 'Task 2' });

  ctx.service.updatePlanTask(t1.id, { status: TaskStatus.IN_PROGRESS });
  ctx.service.updatePlanTask(t1.id, { status: TaskStatus.COMPLETED });
  const result = ctx.service.updatePlanTask(t2.id, { status: TaskStatus.IN_PROGRESS });
  expect(result!.planStatus).toBe('active');

  const final = ctx.service.updatePlanTask(t2.id, { status: TaskStatus.COMPLETED });
  expect(final!.planStatus).toBe('completed');
  expect(final!.autoActions).toContainEqual(expect.stringContaining('auto-completed'));
});

test('reactivation: updating task on completed plan reactivates it', async () => {
  const plan = await factory.plan({ title: 'Reactivation Plan' });
  const t1 = factory.planTask(plan.id, { description: 'Only task' });

  ctx.service.updatePlanTask(t1.id, { status: TaskStatus.IN_PROGRESS });
  ctx.service.updatePlanTask(t1.id, { status: TaskStatus.COMPLETED });
  // Plan should be completed now
  const completedPlan = ctx.service.getPlanById(plan.id);
  expect(completedPlan!.status).toBe('completed');

  // Adding new task and starting it should reactivate
  const t2 = factory.planTask(plan.id, { description: 'New task' });
  const result = ctx.service.updatePlanTask(t2.id, { status: TaskStatus.IN_PROGRESS });
  expect(result!.planStatus).toBe('active');
  expect(result!.autoActions).toContainEqual(expect.stringContaining('auto-activated'));
});
