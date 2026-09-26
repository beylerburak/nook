import type { en } from "./locales/en";

/** A plural message, keyed by CLDR plural category. `one`/`other` cover en and tr; the rest are here for future locales. */
export interface PluralForms {
  zero?: string;
  one: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}

/** Anything a message namespace can resolve to. */
export type MessageLeaf = string | PluralForms;

/** Recursive record of namespaces bottoming out in `MessageLeaf`s — the shape every locale catalog has. */
export type MessageTree = { [key: string]: MessageLeaf | MessageTree };

/**
 * Widens `en`'s literal string values to `string` (keeping plural entries
 * shaped like `PluralForms`) so other locales can supply their own text
 * while `satisfies Messages` still catches a missing or misspelled key.
 */
type Widen<T> = T extends string
  ? string
  : T extends PluralForms
    ? PluralForms
    : { [K in keyof T]: Widen<T[K]> };

/** The message shape every locale catalog must satisfy — derived from `en`, the source of truth. */
export type Messages = Widen<typeof en>;

/** Dot-path union of every leaf key in `en`, e.g. `"settings.appearance.modeLight"`. */
export type MessageKey = DotPath<typeof en>;

type DotPath<T> = T extends MessageLeaf
  ? never
  : {
      [K in keyof T & string]: T[K] extends MessageLeaf ? K : `${K}.${DotPath<T[K]>}`;
    }[keyof T & string];

/** Resolves the leaf type at a given dot-path key, so `ParamsFor` can tell a plural key from a plain one. */
type LeafAt<T, P extends string> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? LeafAt<T[Head], Rest>
    : never
  : P extends keyof T
    ? T[P]
    : never;

/** Free-form interpolation params, e.g. `{ name: "Ada" }` for a `"Hi {name}"` message. */
export type InterpolationParams = Record<string, string | number>;

/**
 * The params `t(key, params)` accepts for a given key: a plural key requires
 * `count` (used to pick the plural category); any key may also take
 * `{name}`-style interpolation params, which aren't individually type-checked.
 */
export type ParamsFor<K extends MessageKey> = LeafAt<typeof en, K> extends PluralForms
  ? { count: number } & Partial<InterpolationParams>
  : Partial<InterpolationParams> | undefined;
