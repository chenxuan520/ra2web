import { describe, expect, test } from "bun:test";
import { createSpritePostureClassifier, type ApparentSpriteSample, type SpriteMaterialCorpus } from "../../../e2e/lib/apparent-sprite-classifier";

const deployed = "a".repeat(64);
const standing = "b".repeat(64);
const transition = "c".repeat(64);
const unknown = "d".repeat(64);
const corpusDigest = "e".repeat(64);
function registration(): SpriteMaterialCorpus {
    return {
        apparentImage: "DESO", renderingDomain: "fixture-unlit-original-palette-complete-canvas", corpusDigest, exhaustive: true,
        frames: [
            { index: 298, pixelDigest: deployed, role: "deployed-appearance" },
            { index: 0, pixelDigest: standing, role: "other" },
            { index: 299, pixelDigest: transition, role: "other" },
        ],
    };
}
function sample(possiblePixelDigests = [deployed]): ApparentSpriteSample {
    return { apparentImage: "DESO", renderingDomain: registration().renderingDomain, corpusDigest, complete: true, possiblePixelDigests };
}

describe("material-only apparent sprite classifier", () => {
    test("same visible material sample gives the same posture despite inaccessible private identity and state", () => {
        const classifier = createSpritePostureClassifier(registration());
        const real = sample(), disguised = sample();
        for (const record of [real, disguised]) {
            for (const key of ["realName", "owner", "stance", "isFiring", "weapon", "radLevel", "disguiseTrait", "tasks"]) {
                Object.defineProperty(record, key, { get() { throw new Error(`Private getter ${key}`); } });
            }
        }
        expect(classifier.classify(real)).toBe("deployed");
        expect(classifier.classify(disguised)).toBe("deployed");
    });
    test("source frame index and sequence identity cannot split equal pixels", () => {
        const corpus = registration();
        (corpus.frames as any[]).push({ index: 777, pixelDigest: deployed, role: "deployed-appearance" });
        const classifier = createSpritePostureClassifier(corpus);
        expect(classifier.classify(sample())).toBe("deployed");
        // A frame serving a non-deployment state with the same pixels makes the
        // entire equivalence class unknown, including the nominal deployed one.
        (corpus.frames as any[]).push({ index: 778, pixelDigest: deployed, role: "other" });
        const ambiguous = createSpritePostureClassifier(corpus);
        expect(ambiguous.classify(sample())).toBeUndefined();
    });
    test("all still-possible frames must have only deployed appearance", () => {
        const classifier = createSpritePostureClassifier(registration());
        for (const frames of [[], [standing], [transition], [deployed, transition], [deployed, unknown]]) {
            expect(classifier.classify(sample(frames))).toBeUndefined();
        }
        expect(classifier.classify(sample([deployed, deployed]))).toBe("deployed");
    });
    test("shroud, partial sprites, unsupported palette/light/remap domain, art, and unknown corpus fail closed", () => {
        const classifier = createSpritePostureClassifier(registration());
        for (const change of [{ complete: false }, { renderingDomain: "same-SHP-but-remapped" },
            { apparentImage: "CUSTOMDESO" }, { corpusDigest: "f".repeat(64) }]) {
            expect(classifier.classify({ ...sample(), ...change })).toBeUndefined();
        }
    });
    test("an incomplete or malformed material corpus never invents positive posture", () => {
        const incomplete = { ...registration(), exhaustive: false };
        expect(createSpritePostureClassifier(incomplete).classify(sample())).toBeUndefined();
        for (const bad of [{ index: 0, pixelDigest: deployed, role: "other" },
            { index: -1, pixelDigest: deployed, role: "deployed-appearance" },
            { index: 20, pixelDigest: "bad", role: "deployed-appearance" }]) {
            const corpus = registration();
            (corpus.frames as any[]).push(bad);
            expect(createSpritePostureClassifier(corpus).classify(sample())).toBeUndefined();
        }
    });
    test("registration mutation and observer call order do not alter compiled support", () => {
        const corpus = registration();
        const classifier = createSpritePostureClassifier(corpus);
        (corpus.frames as any[]).push({ index: 999, pixelDigest: deployed, role: "other" });
        corpus.apparentImage = "MUTATED";
        expect(classifier.classify(sample())).toBe("deployed");
        expect(classifier.classify(sample([standing]))).toBeUndefined();
        expect(classifier.classify(sample())).toBe("deployed");
    });
});
