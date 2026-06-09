import { test, expect } from '@playwright/test';
import { createControlledContext, destroyTestContext, createFactory, type TestContext } from '../test-helpers.js';

// findDuplicateGroups clusters KNN pairs into connected components so N copies
// of an entry render as ONE group (the user-reported bug: N identical entries
// showed up as up to N(N-1)/2 repeated pair rows).
//
// Uses the controlled VEC[...] provider: identical VEC numbers ⇒ identical
// embedding ⇒ cosine 1.0.

async function seedIdentical(ctx: TestContext, factory: ReturnType<typeof createFactory>, prefix: string, vec: string, count: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const e = await factory.knowledge({
      title: `${prefix} copy ${i}`,
      content: `${prefix} duplicated content VEC[${vec}]`,
      tags: [prefix],
    });
    ids.push(e.id);
  }
  return ids;
}

test('6 identical entries → exactly ONE group with 6 members (reported case)', async () => {
  const ctx = createControlledContext();
  const factory = createFactory(ctx.service);
  try {
    const ids = await seedIdentical(ctx, factory, 'six', '1,0,0,0', 6);
    const groups = await ctx.service.findDuplicateGroups({ threshold: 0.95 });
    const containing = groups.filter((g) => g.members.some((m) => ids.includes(m.id)));
    expect(containing).toHaveLength(1);
    expect(containing[0].members.map((m) => m.id).sort()).toEqual([...ids].sort());
    expect(containing[0].maxSimilarity).toBeGreaterThanOrEqual(0.95);
  } finally { destroyTestContext(ctx); }
});

test('7 identical entries → still ONE group (k-boundary coverage)', async () => {
  const ctx = createControlledContext();
  const factory = createFactory(ctx.service);
  try {
    const ids = await seedIdentical(ctx, factory, 'seven', '0,1,0,0', 7);
    const groups = await ctx.service.findDuplicateGroups({ threshold: 0.95 });
    const containing = groups.filter((g) => g.members.some((m) => ids.includes(m.id)));
    expect(containing).toHaveLength(1);
    expect(containing[0].members).toHaveLength(7);
  } finally { destroyTestContext(ctx); }
});

test('15 identical entries → ONE intact group of 15 (exceeds the old 100-pair cap)', async () => {
  const ctx = createControlledContext();
  const factory = createFactory(ctx.service);
  try {
    const ids = await seedIdentical(ctx, factory, 'fifteen', '0,0,1,0', 15);
    const groups = await ctx.service.findDuplicateGroups({ threshold: 0.95 });
    const containing = groups.filter((g) => g.members.some((m) => ids.includes(m.id)));
    expect(containing).toHaveLength(1);
    expect(containing[0].members).toHaveLength(15);
  } finally { destroyTestContext(ctx); }
});

test('two disjoint clusters → two separate groups with correct membership', async () => {
  const ctx = createControlledContext();
  const factory = createFactory(ctx.service);
  try {
    const aIds = await seedIdentical(ctx, factory, 'cluster-a', '1,0,0,0', 3);
    const bIds = await seedIdentical(ctx, factory, 'cluster-b', '0,1,0,0', 2);
    const groups = await ctx.service.findDuplicateGroups({ threshold: 0.95 });
    const ga = groups.find((g) => g.members.some((m) => aIds.includes(m.id)));
    const gb = groups.find((g) => g.members.some((m) => bIds.includes(m.id)));
    expect(ga).toBeTruthy();
    expect(gb).toBeTruthy();
    expect(ga!.groupId).not.toBe(gb!.groupId);
    expect(ga!.members).toHaveLength(3);
    expect(gb!.members).toHaveLength(2);
    // groups sorted by size DESC
    expect(groups.indexOf(ga!)).toBeLessThan(groups.indexOf(gb!));
  } finally { destroyTestContext(ctx); }
});

test('members are sorted version DESC (highest version first = default keeper)', async () => {
  const ctx = createControlledContext();
  const factory = createFactory(ctx.service);
  try {
    const ids = await seedIdentical(ctx, factory, 'versioned', '0,0,0,1', 3);
    // Title-only update keeps the VEC[...] in content (same vector) but bumps version.
    await ctx.service.update(ids[1], { title: 'versioned copy 1 — edited' });
    const groups = await ctx.service.findDuplicateGroups({ threshold: 0.95 });
    const g = groups.find((grp) => grp.members.some((m) => ids.includes(m.id)));
    expect(g).toBeTruthy();
    expect(g!.members[0].id).toBe(ids[1]);
    expect(g!.members[0].version).toBeGreaterThan(g!.members[1].version);
  } finally { destroyTestContext(ctx); }
});

test('below-threshold vectors are not grouped', async () => {
  const ctx = createControlledContext();
  const factory = createFactory(ctx.service);
  try {
    // cosine(VEC[1,0], VEC[0.6,0.8]) = 0.6 < 0.9 threshold
    const a = await factory.knowledge({ title: 'far-a', content: 'far a VEC[1,0,0,0]', tags: ['far'] });
    const b = await factory.knowledge({ title: 'far-b', content: 'far b VEC[0.6,0.8,0,0]', tags: ['far'] });
    const groups = await ctx.service.findDuplicateGroups({ threshold: 0.9 });
    const together = groups.some((g) =>
      g.members.some((m) => m.id === a.id) && g.members.some((m) => m.id === b.id));
    expect(together).toBe(false);
  } finally { destroyTestContext(ctx); }
});
