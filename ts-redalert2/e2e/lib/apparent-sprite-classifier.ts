/**
 * Material-level prototype only. This consumes a complete, already observed
 * sprite sample from a registered rendering domain. It does not manufacture a
 * sample from game stance, weapon state, a unit's identity, or elapsed ticks.
 *
 * No production GameApi consumer calls this helper. A headless observer sample
 * producer, including palette/remap/light/occlusion semantics, is still needed
 * before this could become an observation API.
 */
export type SpriteMaterialRole = "deployed-appearance" | "other";

export interface SpriteMaterialFrame {
    index: number;
    /** Digest of complete pixels in one registered, normalized render domain. */
    pixelDigest: string;
    role: SpriteMaterialRole;
}

export interface SpriteMaterialCorpus {
    apparentImage: string;
    renderingDomain: string;
    corpusDigest: string;
    exhaustive: boolean;
    frames: readonly SpriteMaterialFrame[];
}

export interface ApparentSpriteSample {
    apparentImage: string;
    renderingDomain: string;
    corpusDigest: string;
    complete: boolean;
    /** Every still-possible visible pixel signature, never a true game state. */
    possiblePixelDigests: readonly string[];
}

export interface SpritePostureClassifier {
    classify(sample: ApparentSpriteSample): "deployed" | undefined;
}

/** Equal displayed samples always have equal outputs, including ambiguous art. */
export function createSpritePostureClassifier(corpus: SpriteMaterialCorpus): SpritePostureClassifier {
    const roles = new Map<string, Set<SpriteMaterialRole>>();
    let valid = corpus.exhaustive && !!corpus.apparentImage && !!corpus.renderingDomain &&
        /^[a-f0-9]{64}$/.test(corpus.corpusDigest) && corpus.frames.length > 0;
    const indices = new Map<number, string>();
    for (const frame of corpus.frames) {
        if (!Number.isInteger(frame.index) || frame.index < 0 ||
            !/^[a-f0-9]{64}$/.test(frame.pixelDigest) ||
            !["deployed-appearance", "other"].includes(frame.role)) {
            valid = false;
            continue;
        }
        const previous = indices.get(frame.index);
        if (previous !== undefined && previous !== frame.pixelDigest) valid = false;
        indices.set(frame.index, frame.pixelDigest);
        let possibilities = roles.get(frame.pixelDigest);
        if (!possibilities) roles.set(frame.pixelDigest, possibilities = new Set());
        possibilities.add(frame.role);
    }
    // Copy registration scalars and equivalence classes: later caller mutation
    // must not change what material this classifier says it supports.
    const apparentImage = corpus.apparentImage;
    const renderingDomain = corpus.renderingDomain;
    const corpusDigest = corpus.corpusDigest;
    return {
        classify(sample) {
            if (!valid || !sample.complete || sample.apparentImage !== apparentImage ||
                sample.renderingDomain !== renderingDomain || sample.corpusDigest !== corpusDigest ||
                sample.possiblePixelDigests.length === 0) return undefined;
            for (const signature of sample.possiblePixelDigests) {
                const possibilities = roles.get(signature);
                if (!possibilities || possibilities.size !== 1 || !possibilities.has("deployed-appearance")) {
                    return undefined;
                }
            }
            // This is a posture appearance, never a shot, pollution, radius,
            // radiation owner, damage, expiry, or raw deployment state.
            return "deployed";
        },
    };
}
