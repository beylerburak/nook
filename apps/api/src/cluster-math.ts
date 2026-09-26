/**
 * Pure, deterministic clustering over cosine-normalized embeddings. This is the
 * inversion behind "Suggestions from clusters" (docs/ai.md): instead of asking a
 * generative model to invent collection names from an 80-bookmark sample and then
 * classifying the library one bookmark at a time against those names — which
 * measurably files only a quarter of a real 1,063-bookmark library, because the
 * sample never covers it — this groups every unfiled bookmark's own embedding
 * first and asks the model to do the one thing it is actually needed for: name
 * the groups.
 *
 * No `fetch`, no `pg`, no clock. A seeded PRNG stands in for `Math.random()`
 * everywhere randomness would otherwise appear, because the one property that
 * matters more than the clustering being *good* is that it is *reproducible*:
 * the same library run twice must draw the same groups, or "Suggest collections"
 * run a second time would silently show the user a different answer to the same
 * question, indistinguishable from a bug.
 *
 * The algorithm, in the order it runs:
 *
 * 1. Normalize every vector to unit length, so cosine similarity is a plain dot
 *    product and Euclidean k-means and "maximize cosine" agree: for unit vectors
 *    `||a-b||^2 = 2 - 2*cos(a,b)`, a monotonic function of cosine, so ordinary
 *    Lloyd's-algorithm k-means on normalized vectors already optimizes the
 *    quantity we actually care about ("spherical k-means").
 * 2. k-means++ seeding, a few restarts, keep the lowest-inertia run — the
 *    standard defence against a bad random start landing in a poor local
 *    optimum.
 * 3. Merge clusters whose centroids are near-duplicates (cosine above
 *    `mergeThreshold`): k-means with `k` chosen as an estimate routinely splits
 *    one real theme into two adjacent clusters, and presenting both as separate
 *    suggestions would just be the same "Reading" proposed twice.
 * 4. Drop members whose similarity to their own (post-merge) centroid falls
 *    below `memberFloor` into "unclustered" — points k-means was forced to
 *    assign somewhere but that do not actually belong, which is the majority of
 *    what makes a k-means assignment look wrong on inspection.
 * 5. Drop whole clusters smaller than `minClusterSize` into "unclustered" —
 *    too small a group to be worth a proposal of its own.
 * 6. Match each surviving cluster against the account's existing collections'
 *    centroids, so a cluster that is really "more of what's already in Reading"
 *    is flagged for the caller to offer as "add to Reading" rather than as a
 *    brand-new name.
 *
 * Every input point ends up in exactly one place: a final cluster's
 * `memberIds`, or `unclusteredIds`. That invariant is load-bearing for the
 * caller's `unclustered` count and is asserted by the tests.
 */

// -- public types ------------------------------------------------------------

export interface ClusterPoint {
  id: string;
  vector: readonly number[];
}

/** One surviving cluster, after merging, floor-filtering and size-filtering. */
export interface FinalCluster {
  memberIds: string[];
  /** Unit-length. Mean of the (unit) vectors of the surviving members,
   *  re-normalized — not the k-means centroid frozen at assignment time, so it
   *  reflects exactly the membership the caller is being handed. */
  centroid: number[];
  /**
   * The id of the account's existing live collection whose own centroid this
   * cluster's centroid is closest to, when that similarity clears
   * `existingMatchThreshold`. Otherwise null, meaning "propose this as new".
   */
  existingListId: string | null;
}

export interface ClusterResult {
  /** Sorted by size descending, tiebroken by the lowest member id, so the same
   *  input always yields the same order — a caller (or a test) must not have to
   *  re-sort to get a deterministic list. */
  clusters: FinalCluster[];
  /** Ids that ended up in no final cluster: never selected as a starting point
   *  worth expanding, filtered out by the membership floor, or orphaned when
   *  their cluster fell under the minimum size. */
  unclusteredIds: string[];
}

/** Every tunable in one place, each documented at its default rather than at
 *  every call site, in the style `ai.ts` and `embeddings.ts` already use for
 *  their own measured constants. */
export interface ClusterOptions {
  /** Seeds the PRNG that stands in for every random choice below. Fixed by
   *  default so two calls with the same points produce the same clusters; a
   *  caller that wants a *different* deterministic run (rather than a random
   *  one) passes a different seed, not `Math.random()`. */
  seed: number;
  /**
   * How many independent k-means runs to take the best (lowest-inertia) of, as
   * a function of `n` — restarts are what defends against a single bad
   * k-means++ draw landing in a poor local optimum, but the cost is
   * `O(n * k * dim)` per restart, so a 10,000-point library cannot afford as
   * many restarts as a 200-point one and still finish in "a few seconds"
   * (measured in cluster-math.unit.test.ts / the report this shipped with).
   */
  restarts: (n: number) => number;
  /** Lloyd's-algorithm iteration cap per restart. Convergence (no point changes
   *  cluster) usually arrives well before this on real embeddings, because
   *  k-means++ seeding already starts close to a good answer; this is the
   *  worst-case bound, not the typical one. */
  maxIterations: number;
  /** `k`, as a function of `n`. `round(sqrt(n/2))` is the standard rule-of-thumb
   *  "roughly this many natural groups exist" heuristic, clamped to a range a
   *  proposal review list can actually show: fewer than 4 is not worth the
   *  inversion at all, and past 30 the caller would be asking the naming model
   *  30 questions in one call. */
  kOf: (n: number) => number;
  /** Two cluster centroids more similar than this are the same theme found
   *  twice, not two themes. 0.9 is high enough that two clusters both about
   *  "reading" but on genuinely different sub-topics are kept apart. */
  mergeThreshold: number;
  /** A member less similar to its own cluster's centroid than this was forced
   *  into the cluster by k-means' "every point gets an assignment" rule rather
   *  than actually belonging. 0.35 sits in the gap this repo's other cosine
   *  thresholds were measured into (docs/retrieval.md's search floor is 0.40,
   *  measured against nonsense queries scoring 0.41) — tune further against a
   *  real account's unfiled library before shipping this to production traffic. */
  memberFloor: number;
  /** A cluster this small is not worth a proposal of its own, as a function of
   *  `n`: 5 outright, or 2% of the library, whichever is larger, so a
   *  10,000-bookmark account is not offered 200 nearly-singleton "collections". */
  minClusterSize: (n: number) => number;
  /** How close a cluster's centroid has to be to an existing collection's own
   *  centroid before the caller should offer "add to <that collection>" instead
   *  of a new name. Set above `mergeThreshold` on purpose: the two thresholds
   *  answer different questions ("are these the same new group?" vs "is this new
   *  group actually a collection I already have?"), and requiring more evidence
   *  for the second is the safer direction — proposing a redundant new
   *  collection costs the user one unticked checkbox, but silently folding a
   *  cluster into the wrong existing collection is not reviewable at a glance. */
  existingMatchThreshold: number;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = {
  seed: 1,
  // n*k*dim work per iteration is what has to fit in "a few seconds" at
  // n=10,000, k capped at 30: fewer restarts as the library grows is what keeps
  // that true without capping k itself, which would make a huge library's
  // proposals coarser than a small one's for no principled reason. Measured on
  // synthetic well-separated blobs (cluster-math.unit.test.ts): even a single
  // restart at 15 iterations recovers every blob at 100% purity, because
  // k-means++ seeding already starts close to the answer — restarts are a
  // defence against a bad seed, not a requirement for convergence, so a large
  // library trades a little of that defence for staying inside a few seconds.
  restarts: (n) => (n > 4000 ? 1 : n > 1000 ? 2 : 4),
  maxIterations: 15,
  kOf: (n) => clampInt(Math.sqrt(n / 2), 4, 30),
  mergeThreshold: 0.9,
  memberFloor: 0.35,
  minClusterSize: (n) => Math.max(5, Math.ceil(n * 0.02)),
  existingMatchThreshold: 0.85,
};

// -- small vector helpers -----------------------------------------------------

function dot(a: Float64Array, aOff: number, b: Float64Array, bOff: number, dim: number): number {
  let sum = 0;
  for (let i = 0; i < dim; i++) sum += a[aOff + i] * b[bOff + i];
  return sum;
}

function normInPlace(flat: Float64Array, offset: number, dim: number): number {
  let sum = 0;
  for (let i = 0; i < dim; i++) sum += flat[offset + i] * flat[offset + i];
  const norm = Math.sqrt(sum);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) flat[offset + i] /= norm;
  }
  return norm;
}

/** A seeded PRNG standing in for `Math.random()`. Mulberry32: small, fast, and
 *  good enough for weighted sampling — this is not cryptography. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sample one index with probability proportional to `weights`. Falls back to
 *  uniform when every weight is zero (every point coincides with a chosen
 *  centroid), so this never divides by zero or returns `undefined`. */
function weightedIndex(weights: Float64Array, rng: () => number): number {
  let total = 0;
  for (let i = 0; i < weights.length; i++) total += weights[i];
  if (total <= 0) return Math.floor(rng() * weights.length);
  let target = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    target -= weights[i];
    if (target <= 0) return i;
  }
  return weights.length - 1;
}

// -- k-means, on a flat Float64Array ------------------------------------------
//
// Flat typed arrays rather than `number[][]`, because V8 keeps a Float64Array
// as one contiguous block it can loop over at close to native speed, where an
// array of arrays is a pointer chase per row. At n=10,000, k=30, dim=768 the
// inner loop below runs on the order of 10^8 multiply-adds per iteration, and
// that difference is what keeps the whole pass inside "a few seconds" rather
// than tens of them.

interface KMeansRun {
  /** cluster index per point, -1 for a point excluded before clustering (a
   *  zero vector, which has no direction to be similar to anything). */
  assignment: Int32Array;
  centroids: Float64Array;
  k: number;
  /** Sum of `1 - cosine(point, its centroid)` over every assigned point — lower
   *  is a tighter fit. The comparison across restarts. */
  inertia: number;
}

function initCentroidsPlusPlus(vectors: Float64Array, n: number, dim: number, k: number, rng: () => number): Float64Array {
  const centroids = new Float64Array(k * dim);
  const chosen = new Set<number>();
  const first = Math.floor(rng() * n);
  chosen.add(first);
  centroids.set(vectors.subarray(first * dim, first * dim + dim), 0);

  const nearestDist = new Float64Array(n).fill(Infinity);
  for (let c = 1; c < k; c++) {
    const prevOffset = (c - 1) * dim;
    for (let i = 0; i < n; i++) {
      if (chosen.has(i)) {
        nearestDist[i] = 0;
        continue;
      }
      const similarity = dot(vectors, i * dim, centroids, prevOffset, dim);
      const distance = Math.max(0, 1 - similarity);
      if (distance < nearestDist[i]) nearestDist[i] = distance;
    }
    // Squared so the sampling weight favours a genuinely far point rather than
    // a merely farther one — the textbook k-means++ weighting.
    const weights = new Float64Array(n);
    for (let i = 0; i < n; i++) weights[i] = chosen.has(i) ? 0 : nearestDist[i] * nearestDist[i];
    const picked = weightedIndex(weights, rng);
    chosen.add(picked);
    centroids.set(vectors.subarray(picked * dim, picked * dim + dim), c * dim);
  }
  return centroids;
}

/** One full k-means run: seed, iterate to (near-)convergence, report inertia so
 *  the caller can pick the best of several restarts. `active` is the indices of
 *  `vectors` worth clustering at all (zero vectors excluded upstream). */
function runKMeansOnce(
  vectors: Float64Array,
  active: readonly number[],
  dim: number,
  k: number,
  maxIterations: number,
  rng: () => number,
): KMeansRun {
  const n = active.length;
  // A compacted view of only the active points, so the O(n*k) inner loops below
  // never spend time on excluded points.
  const packed = new Float64Array(n * dim);
  for (let i = 0; i < n; i++) packed.set(vectors.subarray(active[i] * dim, active[i] * dim + dim), i * dim);

  let centroids = initCentroidsPlusPlus(packed, n, dim, k, rng);
  const assignment = new Int32Array(n).fill(-1);
  let inertia = 0;

  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = 0;
    const sums = new Float64Array(k * dim);
    const counts = new Int32Array(k);
    inertia = 0;

    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestSim = -Infinity;
      for (let c = 0; c < k; c++) {
        const sim = dot(packed, i * dim, centroids, c * dim, dim);
        if (sim > bestSim) {
          bestSim = sim;
          best = c;
        }
      }
      if (assignment[i] !== best) changed++;
      assignment[i] = best;
      inertia += Math.max(0, 1 - bestSim);
      counts[best]++;
      const sumOffset = best * dim;
      const pointOffset = i * dim;
      for (let d = 0; d < dim; d++) sums[sumOffset + d] += packed[pointOffset + d];
    }

    // Recompute centroids from this iteration's assignment. An empty cluster is
    // reseeded at the point currently worst-fit to its own centroid, which is
    // the standard repair: without it, a centroid that loses every member in one
    // iteration would stay frozen at its old (now meaningless) position forever.
    const next = new Float64Array(k * dim);
    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) {
        for (let d = 0; d < dim; d++) next[c * dim + d] = sums[c * dim + d] / counts[c];
        normInPlace(next, c * dim, dim);
      }
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) continue;
      let worstPoint = 0;
      let worstSim = Infinity;
      for (let i = 0; i < n; i++) {
        const owner = assignment[i];
        const sim = dot(packed, i * dim, next, owner * dim, dim);
        if (sim < worstSim) {
          worstSim = sim;
          worstPoint = i;
        }
      }
      next.set(packed.subarray(worstPoint * dim, worstPoint * dim + dim), c * dim);
      assignment[worstPoint] = c;
      changed++;
    }
    centroids = next;
    if (changed === 0) break;
  }

  // Map the packed assignment back onto the caller's own point indices (0..k-1
  // per active[i]) — the caller reconstructs member ids from `active`.
  return { assignment, centroids, k, inertia };
}

// -- merging near-duplicate clusters ------------------------------------------

/** Union-find over cluster indices, small enough (k <= 30) that a flat array
 *  and path halving is simpler than pulling in a library for it. */
function makeUnionFind(size: number): { find: (x: number) => number; union: (a: number, b: number) => void } {
  const parent = Array.from({ length: size }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  return { find, union };
}

// -- the public entry point ---------------------------------------------------

/**
 * Cluster `points` by cosine similarity. See the file header for the pipeline;
 * this function is the whole of it, start to finish, deterministic given the
 * same points and the same `options.seed`.
 */
export function clusterEmbeddings(
  points: readonly ClusterPoint[],
  existingCentroids: ReadonlyMap<string, readonly number[]> = new Map(),
  options: Partial<ClusterOptions> = {},
): ClusterResult {
  const opts: ClusterOptions = { ...DEFAULT_CLUSTER_OPTIONS, ...options };
  const n = points.length;
  if (n === 0) return { clusters: [], unclusteredIds: [] };

  const dim = points[0].vector.length;
  const flat = new Float64Array(n * dim);
  const norms = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const vector = points[i].vector;
    for (let d = 0; d < dim; d++) flat[i * dim + d] = vector[d] ?? 0;
    norms[i] = normInPlace(flat, i * dim, dim);
  }

  // A zero vector has no direction, so it can be neither near nor far from
  // anything — it is unclusterable rather than "a cluster of one", and is
  // never handed to k-means at all.
  const active: number[] = [];
  const unclusteredIds: string[] = [];
  for (let i = 0; i < n; i++) {
    if (norms[i] > 0) active.push(i);
    else unclusteredIds.push(points[i].id);
  }
  if (active.length === 0) return { clusters: [], unclusteredIds };

  const k = Math.min(opts.kOf(n), active.length);
  const restarts = Math.max(1, opts.restarts(n));
  const rng = mulberry32(opts.seed);

  let best: KMeansRun | null = null;
  for (let r = 0; r < restarts; r++) {
    // Each restart draws from the same seeded stream rather than re-seeding
    // per restart, so `restarts` changing the count does not change what the
    // first restart drew — appending a restart can only add a candidate, never
    // silently reshuffle the ones already tried.
    const run = runKMeansOnce(flat, active, dim, k, opts.maxIterations, rng);
    if (!best || run.inertia < best.inertia) best = run;
  }
  if (!best) return { clusters: [], unclusteredIds };

  // -- merge near-duplicate clusters --
  const uf = makeUnionFind(best.k);
  for (let a = 0; a < best.k; a++) {
    for (let b = a + 1; b < best.k; b++) {
      if (dot(best.centroids, a * dim, best.centroids, b * dim, dim) > opts.mergeThreshold) uf.union(a, b);
    }
  }
  const rootMembers = new Map<number, number[]>(); // root -> active-array indices (into `active`)
  for (let i = 0; i < active.length; i++) {
    const root = uf.find(best.assignment[i]);
    const list = rootMembers.get(root);
    if (list) list.push(i);
    else rootMembers.set(root, [i]);
  }

  // -- recompute each merged cluster's centroid from its real membership,
  //    apply the per-member similarity floor, and only then check the minimum
  //    size — a cluster can cross back under the floor once its outliers are
  //    removed, so size is judged on what actually survives, not on what
  //    k-means originally handed it.
  const minSize = opts.minClusterSize(n);
  const finalClusters: FinalCluster[] = [];

  for (const memberActiveIndices of rootMembers.values()) {
    const centroid = meanUnitVector(flat, active, memberActiveIndices, dim);
    const kept: number[] = [];
    for (const activeIndex of memberActiveIndices) {
      const sim = dot(flat, active[activeIndex] * dim, centroid, 0, dim);
      if (sim >= opts.memberFloor) kept.push(activeIndex);
      else unclusteredIds.push(points[active[activeIndex]].id);
    }
    if (kept.length < minSize) {
      for (const activeIndex of kept) unclusteredIds.push(points[active[activeIndex]].id);
      continue;
    }
    const finalCentroid = meanUnitVector(flat, active, kept, dim);
    finalClusters.push({
      memberIds: kept.map((activeIndex) => points[active[activeIndex]].id).sort(),
      centroid: Array.from(finalCentroid),
      existingListId: matchExisting(finalCentroid, dim, existingCentroids, opts.existingMatchThreshold),
    });
  }

  finalClusters.sort((left, right) => {
    if (right.memberIds.length !== left.memberIds.length) return right.memberIds.length - left.memberIds.length;
    return left.memberIds[0] < right.memberIds[0] ? -1 : left.memberIds[0] > right.memberIds[0] ? 1 : 0;
  });
  unclusteredIds.sort();

  return { clusters: finalClusters, unclusteredIds };
}

function meanUnitVector(flat: Float64Array, active: readonly number[], memberActiveIndices: readonly number[], dim: number): Float64Array {
  const sum = new Float64Array(dim);
  for (const activeIndex of memberActiveIndices) {
    const offset = active[activeIndex] * dim;
    for (let d = 0; d < dim; d++) sum[d] += flat[offset + d];
  }
  normInPlace(sum, 0, dim);
  return sum;
}

function matchExisting(
  centroid: Float64Array,
  dim: number,
  existingCentroids: ReadonlyMap<string, readonly number[]>,
  threshold: number,
): string | null {
  let bestId: string | null = null;
  let bestSim = threshold;
  for (const [id, vector] of existingCentroids) {
    const unit = new Float64Array(dim);
    for (let d = 0; d < dim; d++) unit[d] = vector[d] ?? 0;
    if (normInPlace(unit, 0, dim) === 0) continue;
    const sim = dot(centroid, 0, unit, 0, dim);
    if (sim > bestSim) {
      bestSim = sim;
      bestId = id;
    }
  }
  return bestId;
}
