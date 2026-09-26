// Pure math, no network, no database. Every fixture below is hand-built rather
// than drawn from a PRNG mirrored from the implementation, on purpose: a test
// that reproduces the module's own seed would pass no matter how the seed was
// used, and would go on passing through a bug that changed what the seed does.
// A deterministic sine-based perturbation gives each point a distinct position
// without coupling the test to `cluster-math.ts`'s own randomness.
import { describe, expect, it } from "vitest";
import { clusterEmbeddings, type ClusterPoint } from "../src/cluster-math.js";

const DIM = 6;

/** A point near `center`, nudged by a small deterministic offset so no two
 *  points in a blob are literally identical, without using `Math.random()`. */
function nearPoint(id: string, center: readonly number[], index: number, amplitude = 0.03): ClusterPoint {
  const vector = center.map((value, d) => value + amplitude * Math.sin((index + 1) * (d + 1) * 0.73));
  return { id, vector };
}

function blob(prefix: string, center: readonly number[], count: number, amplitude = 0.03): ClusterPoint[] {
  return Array.from({ length: count }, (_, i) => nearPoint(`${prefix}${i}`, center, i, amplitude));
}

/** Four directions far enough apart in 6-dimensional space that no pair is
 *  anywhere near the merge threshold — each is a scaled basis vector. */
const FAR_CENTERS: number[][] = [
  [5, 0, 0, 0, 0, 0],
  [0, 5, 0, 0, 0, 0],
  [0, 0, 5, 0, 0, 0],
  [0, 0, 0, 5, 0, 0],
];

function idsOf(points: ClusterPoint[]): string[] {
  return points.map((p) => p.id);
}

/** Every id in `points` should appear in exactly one of the result's clusters
 *  or its `unclusteredIds` — the invariant the whole module is built around. */
function assertAccountsForEveryPoint(points: ClusterPoint[], result: ReturnType<typeof clusterEmbeddings>): void {
  const seen = new Map<string, number>();
  for (const cluster of result.clusters) {
    for (const id of cluster.memberIds) seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  for (const id of result.unclusteredIds) seen.set(id, (seen.get(id) ?? 0) + 1);
  for (const point of points) {
    expect(seen.get(point.id), `${point.id} should appear exactly once`).toBe(1);
    seen.delete(point.id);
  }
  expect(seen.size, "no id in the result should be foreign to the input").toBe(0);
}

describe("clusterEmbeddings — well-separated blobs", () => {
  it("recovers each blob as its own cluster with perfect purity", () => {
    const groups = FAR_CENTERS.map((center, i) => blob(`b${i}-`, center, 30));
    const points = groups.flat();

    const result = clusterEmbeddings(points, new Map(), { seed: 7 });

    expect(result.clusters).toHaveLength(4);
    expect(result.unclusteredIds).toEqual([]);
    assertAccountsForEveryPoint(points, result);

    // Every cluster is pure: its members are exactly one blob's ids, no mixing.
    for (const cluster of result.clusters) {
      const prefixes = new Set(cluster.memberIds.map((id) => id.slice(0, id.indexOf("-") + 1)));
      expect(prefixes.size).toBe(1);
      expect(cluster.memberIds).toHaveLength(30);
    }
    // And the four blobs are collectively covered, not the same one four times.
    const coveredPrefixes = new Set(result.clusters.flatMap((c) => c.memberIds.map((id) => id.slice(0, 3))));
    expect(coveredPrefixes.size).toBe(4);
  });

  it("is deterministic: the same points, in the same order, always cluster the same way", () => {
    const groups = FAR_CENTERS.map((center, i) => blob(`b${i}-`, center, 20));
    const points = groups.flat();

    const first = clusterEmbeddings(points, new Map(), { seed: 42 });
    const second = clusterEmbeddings(points, new Map(), { seed: 42 });

    expect(second).toEqual(first);
  });

  it("a different seed may explore differently, but still fully accounts for every point", () => {
    const groups = FAR_CENTERS.map((center, i) => blob(`b${i}-`, center, 20));
    const points = groups.flat();
    const result = clusterEmbeddings(points, new Map(), { seed: 999 });
    assertAccountsForEveryPoint(points, result);
  });
});

describe("clusterEmbeddings — noise", () => {
  it("sends scattered, mutually dissimilar points to unclustered rather than forcing them into a real blob", () => {
    const noiseCount = 20;
    // Padded so every vector — real or noise — has the same length: the real
    // blob lives entirely in the first DIM dimensions, and each noise point is
    // a one-hot vector in its own private extra dimension, so every pair of
    // noise points (and every noise point and the real blob) has cosine
    // similarity exactly 0 — genuinely mutually dissimilar, not merely spread
    // around a circle where neighbours can still land close together.
    const pad = (vector: readonly number[]): number[] => [...vector, ...new Array(noiseCount).fill(0)];
    const real = blob("real-", FAR_CENTERS[0], 40).map((p) => ({ id: p.id, vector: pad(p.vector) }));
    const noise: ClusterPoint[] = Array.from({ length: noiseCount }, (_, i) => ({
      id: `noise-${i}`,
      vector: pad(FAR_CENTERS[0].map(() => 0)).map((v, d) => (d === DIM + i ? 1 : v)),
    }));
    const points = [...real, ...noise];

    const result = clusterEmbeddings(points, new Map(), { seed: 3 });
    assertAccountsForEveryPoint(points, result);

    const realCluster = result.clusters.find((c) => c.memberIds.includes("real-0"));
    expect(realCluster?.memberIds.sort()).toEqual(idsOf(real).sort());
    // None of the scattered noise ids leaked into the real cluster.
    for (const id of idsOf(noise)) {
      expect(result.clusters.some((c) => c.memberIds.includes(id))).toBe(false);
      expect(result.unclusteredIds).toContain(id);
    }
  });

  it("excludes a zero vector from clustering entirely — it has no direction to be near anything", () => {
    const real = blob("real-", FAR_CENTERS[0], 10);
    const points: ClusterPoint[] = [...real, { id: "zero", vector: [0, 0, 0, 0, 0, 0] }];

    const result = clusterEmbeddings(points, new Map(), { seed: 1 });

    expect(result.unclusteredIds).toContain("zero");
    expect(result.clusters.some((c) => c.memberIds.includes("zero"))).toBe(false);
    assertAccountsForEveryPoint(points, result);
  });
});

describe("clusterEmbeddings — merging near-duplicate clusters", () => {
  it("merges two clusters whose centroids are cosine-near rather than reporting the same theme twice", () => {
    const centerA = [5, 0.05, 0, 0, 0, 0];
    const centerB = [5, -0.05, 0, 0, 0, 0]; // cosine(A, B) is very close to 1
    const far = FAR_CENTERS[1];
    const points = [...blob("a-", centerA, 15), ...blob("b-", centerB, 15), ...blob("f-", far, 15)];

    const result = clusterEmbeddings(points, new Map(), { seed: 5 });
    assertAccountsForEveryPoint(points, result);

    // Exactly two surviving clusters: the merged near-duplicate pair, and the
    // unrelated far one — not three.
    expect(result.clusters).toHaveLength(2);
    const merged = result.clusters.find((c) => c.memberIds.length === 30);
    expect(merged).toBeDefined();
    expect(merged!.memberIds.some((id) => id.startsWith("a-"))).toBe(true);
    expect(merged!.memberIds.some((id) => id.startsWith("b-"))).toBe(true);
  });
});

describe("clusterEmbeddings — minimum cluster size", () => {
  it("drops a cluster smaller than the size floor into unclustered instead of proposing a near-singleton", () => {
    const big = blob("big-", FAR_CENTERS[0], 60);
    // 2% of ~63 rounds under 5, so the 5-outright floor is what actually binds:
    // a tiny group of 3 must not survive as its own proposal.
    const tiny = blob("tiny-", FAR_CENTERS[1], 3, 0.01);
    const points = [...big, ...tiny];

    const result = clusterEmbeddings(points, new Map(), { seed: 11 });
    assertAccountsForEveryPoint(points, result);

    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].memberIds).toHaveLength(60);
    for (const id of idsOf(tiny)) expect(result.unclusteredIds).toContain(id);
  });
});

describe("clusterEmbeddings — matching an existing collection", () => {
  it("flags a cluster whose centroid is very close to an existing collection's own centroid", () => {
    const points = [...blob("x-", FAR_CENTERS[0], 20), ...blob("y-", FAR_CENTERS[1], 20)];
    const existing = new Map<string, readonly number[]>([
      // Close to FAR_CENTERS[0]: same direction, different magnitude — cosine
      // similarity is scale-invariant, so this still matches.
      ["list-reading", [1, 0.01, 0, 0, 0, 0]],
      // Nowhere near either cluster.
      ["list-cooking", [0, 0, 0, 0, 9, 0]],
    ]);

    const result = clusterEmbeddings(points, existing, { seed: 2 });

    const xCluster = result.clusters.find((c) => c.memberIds[0]?.startsWith("x-"));
    const yCluster = result.clusters.find((c) => c.memberIds[0]?.startsWith("y-"));
    expect(xCluster?.existingListId).toBe("list-reading");
    expect(yCluster?.existingListId).toBeNull();
  });

  it("does not match when nothing existing is close enough", () => {
    const points = blob("x-", FAR_CENTERS[0], 20);
    const existing = new Map<string, readonly number[]>([["list-cooking", [0, 0, 0, 0, 9, 0]]]);

    const result = clusterEmbeddings(points, existing, { seed: 2 });

    expect(result.clusters[0].existingListId).toBeNull();
  });
});

describe("clusterEmbeddings — edge cases", () => {
  it("returns nothing for an empty library", () => {
    expect(clusterEmbeddings([])).toEqual({ clusters: [], unclusteredIds: [] });
  });

  it("sorts clusters by size descending", () => {
    const points = [...blob("small-", FAR_CENTERS[0], 8), ...blob("large-", FAR_CENTERS[1], 25)];
    const result = clusterEmbeddings(points, new Map(), { seed: 6 });
    const sizes = result.clusters.map((c) => c.memberIds.length);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  });
});
