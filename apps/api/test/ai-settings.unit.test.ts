import { describe, expect, it } from "vitest";
import { DEFAULT_COLLECTION_MIN_CONFIDENCE, DEFAULT_MAX_TAGS, DEFAULT_TAG_MIN_NOUL } from "../src/ai.js";
import {
  DEFAULT_AI_USER_SETTINGS,
  normalizeAiUserSettings,
  parseAiUserSettingsPatch,
  type AiUserSettings,
} from "../src/ai-settings.js";

describe("DEFAULT_AI_USER_SETTINGS", () => {
  it("everything off, and the thresholds match the calibrated classify defaults", () => {
    expect(DEFAULT_AI_USER_SETTINGS).toEqual({
      autoClassify: false,
      autoTaxonomy: false,
      autoSummarize: false,
      collectionMinConfidence: DEFAULT_COLLECTION_MIN_CONFIDENCE,
      tagMinNoul: DEFAULT_TAG_MIN_NOUL,
      maxTags: DEFAULT_MAX_TAGS,
      taxonomyLanguage: "auto",
    });
  });
});

describe("normalizeAiUserSettings", () => {
  it("fills in every field for a missing row", () => {
    expect(normalizeAiUserSettings(undefined)).toEqual(DEFAULT_AI_USER_SETTINGS);
    expect(normalizeAiUserSettings(null)).toEqual(DEFAULT_AI_USER_SETTINGS);
    expect(normalizeAiUserSettings({})).toEqual(DEFAULT_AI_USER_SETTINGS);
  });

  it("keeps a fully valid record as-is", () => {
    const settings: AiUserSettings = {
      autoClassify: true,
      autoTaxonomy: true,
      autoSummarize: true,
      collectionMinConfidence: 0.9,
      tagMinNoul: 0.6,
      maxTags: 5,
      taxonomyLanguage: "tr",
    };
    expect(normalizeAiUserSettings(settings)).toEqual(settings);
  });

  it("clamps an out-of-range threshold instead of rejecting the whole row", () => {
    const result = normalizeAiUserSettings({ collectionMinConfidence: 7, tagMinNoul: -3 });
    expect(result.collectionMinConfidence).toBe(1);
    expect(result.tagMinNoul).toBe(0);
  });

  it("clamps maxTags to the documented ceiling and floors at zero", () => {
    expect(normalizeAiUserSettings({ maxTags: 99 }).maxTags).toBe(10);
    expect(normalizeAiUserSettings({ maxTags: -4 }).maxTags).toBe(0);
    expect(normalizeAiUserSettings({ maxTags: 2.6 }).maxTags).toBe(3);
  });

  it("falls back to auto for an unknown taxonomy language", () => {
    expect(normalizeAiUserSettings({ taxonomyLanguage: "klingon" }).taxonomyLanguage).toBe("auto");
  });

  it("falls back to the boolean defaults for a wrong-typed toggle", () => {
    expect(normalizeAiUserSettings({ autoClassify: "yes" }).autoClassify).toBe(false);
  });
});

describe("parseAiUserSettingsPatch", () => {
  it("accepts an empty patch (a PUT that changes nothing)", () => {
    expect(parseAiUserSettingsPatch(undefined)).toEqual({});
    expect(parseAiUserSettingsPatch({})).toEqual({});
  });

  it("keeps only the fields the client actually sent", () => {
    expect(parseAiUserSettingsPatch({ autoClassify: true })).toEqual({ autoClassify: true });
    expect(parseAiUserSettingsPatch({ maxTags: 4, taxonomyLanguage: "de" })).toEqual({
      maxTags: 4,
      taxonomyLanguage: "de",
    });
  });

  it("rejects a non-object body", () => {
    expect(() => parseAiUserSettingsPatch("nope")).toThrow();
    expect(() => parseAiUserSettingsPatch([1, 2])).toThrow();
  });

  it("rejects a wrong-typed field rather than silently defaulting it", () => {
    expect(() => parseAiUserSettingsPatch({ autoClassify: "yes" })).toThrow();
    expect(() => parseAiUserSettingsPatch({ maxTags: "three" })).toThrow();
    expect(() => parseAiUserSettingsPatch({ collectionMinConfidence: "high" })).toThrow();
  });

  it("rejects an unknown taxonomy language", () => {
    expect(() => parseAiUserSettingsPatch({ taxonomyLanguage: "klingon" })).toThrow();
  });

  it("clamps a threshold in range rather than rejecting it", () => {
    expect(parseAiUserSettingsPatch({ collectionMinConfidence: 7 }).collectionMinConfidence).toBe(1);
    expect(parseAiUserSettingsPatch({ tagMinNoul: -1 }).tagMinNoul).toBe(0);
    expect(parseAiUserSettingsPatch({ maxTags: 99 }).maxTags).toBe(10);
  });
});
