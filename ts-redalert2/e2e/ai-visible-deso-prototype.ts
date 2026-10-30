/** Material/frame prototype, not an engine match or a production observation API. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Animation, AnimationState } from "../src/engine/Animation";
import { AnimProps } from "../src/engine/AnimProps";
import { IniSection } from "../src/data/IniSection";
import { BoxedVar } from "../src/util/BoxedVar";
import { createSpritePostureClassifier, type SpriteMaterialCorpus } from "./lib/apparent-sprite-classifier";

const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
const materialPath = arg("--material");
const outputPath = arg("--out");
if (!process.argv.includes("--material") || !process.argv.includes("--out")) {
    throw new Error("Usage: bun e2e/ai-visible-deso-prototype.ts --material <material.json> --out <report.json>");
}
const raw = readFileSync(materialPath);
const material = JSON.parse(raw.toString("utf8"));
const materialSha = createHash("sha256").update(raw).digest("hex");
let assertions = 0;
function assert(condition: boolean, description: string): void {
    assertions++;
    if (!condition) throw new Error(description);
}
assert(material.source.entrySha256 === "7f157a5089a3ec822ae73eb951993a410c8fabc0d1fa839ddb0eed255aabfcc4", "Only the checked original DESO material is in scope");
assert(material.frames.length === 644 && material.shp.width === 126 && material.shp.height === 88, "Complete material corpus");
assert(material.sequences.Deployed.startFrame === 298 && material.sequences.Deployed.frameCount === 1, "Original deployed frame registration");
assert(material.sequences.Deploy.startFrame === 299 && material.sequences.Deploy.frameCount === 15, "Original transition registration");

function makeCorpus(signature: "canvasRgbaSha256" | "silhouetteSha256", domain: string): SpriteMaterialCorpus {
    return {
        apparentImage: "DESO", renderingDomain: domain, corpusDigest: materialSha, exhaustive: true,
        // This is deliberately only the uniquely registered stable frame. Fire,
        // transition, dead-body, and shadow images remain unknown candidates.
        frames: material.frames.map((frame: any) => ({ index: frame.index, pixelDigest: frame[signature],
            role: frame.index === 298 ? "deployed-appearance" : "other" })),
    };
}
const rgbaCorpus = makeCorpus("canvasRgbaSha256", "original-unittem-unremapped-unlit-complete-sprite");
const silhouetteCorpus = makeCorpus("silhouetteSha256", "complete-binary-silhouette");
const rgba = createSpritePostureClassifier(rgbaCorpus);
const silhouette = createSpritePostureClassifier(silhouetteCorpus);
function classify(corpus: SpriteMaterialCorpus, classifier: ReturnType<typeof createSpritePostureClassifier>, frames: number[], complete = true) {
    return classifier.classify({ apparentImage: corpus.apparentImage, renderingDomain: corpus.renderingDomain,
        corpusDigest: corpus.corpusDigest, complete, possiblePixelDigests: frames.map(index => corpus.frames[index].pixelDigest) }) ?? null;
}
const materialChecks = {
    exactOriginalRgba298: classify(rgbaCorpus, rgba, [298]),
    silhouette298: classify(silhouetteCorpus, silhouette, [298]),
    silhouette313: classify(silhouetteCorpus, silhouette, [313]),
    possibleTransitionOrDeployed: classify(rgbaCorpus, rgba, [298, 313]),
    incompleteSprite: classify(rgbaCorpus, rgba, [298], false),
    stableImageEquivalentRgbaIndices: material.frames.filter((frame: any) => frame.canvasRgbaSha256 === material.frames[298].canvasRgbaSha256).map((frame: any) => frame.index),
    stableImageEquivalentSilhouetteIndices: material.frames.filter((frame: any) => frame.silhouetteSha256 === material.frames[298].silhouetteSha256).map((frame: any) => frame.index),
};
assert(materialChecks.exactOriginalRgba298 === "deployed", "Material-only positive control");
assert(materialChecks.silhouette298 === null && materialChecks.silhouette313 === null, "Equal silhouettes cannot split stable frame and transition");
assert(materialChecks.possibleTransitionOrDeployed === null && materialChecks.incompleteSprite === null, "Unresolved/partial samples fail closed");
for (let index = 299; index <= 313; index++) assert(classify(rgbaCorpus, rgba, [index]) === null, `Transition ${index} not declared stable`);
for (let index = 0; index < 8; index++) assert(classify(rgbaCorpus, rgba, [index]) === null, `Ready/Guard/Undeploy ${index} all unknown`);

/**
 * Executes the real Animation class and the relevant stopped-queue handoff from
 * Infantry.update, with the same unchanged underlying Deployed state. No game
 * simulation ticks, renderer objects, random idle actions, or GPU frames run.
 */
function animateRenderSchedule(name: string, times: number[], firstRenderAt = 0) {
    const props = new AnimProps(new IniSection("prototype-no-random-rate"), 15);
    props.start = props.loopStart = 0;
    props.end = props.loopEnd = 14;
    props.rate = AnimProps.defaultRate;
    props.loopCount = 1;
    const speed = new BoxedVar(1);
    const animation = new Animation(props, speed);
    animation.start(firstRenderAt);
    let sequence = "Deploy";
    let startFrame = 299;
    const trace: { timeMs: number; sequence: string; materialFrame: number; animationState: string }[] = [];
    for (const time of times) {
        if (time < firstRenderAt) continue;
        if (animation.getState() === AnimationState.STOPPED && sequence === "Deploy") {
            sequence = "Deployed";
            startFrame = 298;
            props.loopEnd = 0;
            props.rate = AnimProps.defaultRate / 2;
            props.loopCount = -1;
            animation.start(time);
        }
        animation.update(time);
        trace.push({ timeMs: time, sequence, materialFrame: startFrame + animation.getCurrentFrame(), animationState: AnimationState[animation.getState()] });
    }
    return { name, firstRenderAt, final: trace.at(-1), trace };
}
const renderSchedules = [
    animateRenderSchedule("10ms-sampling", Array.from({ length: 111 }, (_, i) => i * 10)),
    animateRenderSchedule("100ms-sampling", Array.from({ length: 12 }, (_, i) => i * 100)),
    animateRenderSchedule("late-first-render", [0, 1000, 1100], 1000),
];
assert(renderSchedules.every(entry => entry.final?.timeMs === 1100), "Same final render time");
assert(renderSchedules[0].final?.materialFrame === 298, "Dense render schedule has reached stable material");
assert(renderSchedules[1].final?.materialFrame !== 298 && renderSchedules[2].final?.materialFrame !== 298, "Same game posture and final time do not identify displayed material");
const report = {
    kind: "visible-deso-material-and-animation-prototype", noGameTicks: true, noGpuFrames: true, productionApiIntegrated: false,
    materialSha256: materialSha, rawShpSha256: material.source.entrySha256,
    materialChecks, renderSchedules, assertions, errorCount: 0,
    conclusion: "The original complete unremapped/unlit material frame 298 can be distinguished in this material corpus. A silhouette cannot distinguish it from transition frame 313. Real Animation render cadence gives different frames for the same unchanged game stance; no deterministic legal sample producer is implemented.",
    boundaries: [
        "Classifier input is an already known full pixel-signature sample from an exact registered rendering domain. No GameApi code produces this sample.",
        "RGBA uniqueness here is not uniqueness under player color remap, lighting, occlusion, shroud, palette effects, or camera sampling.",
        "No unit identity, ownership, stance, weapon, shot, radiation, expiry, or damage is read by the classifier.",
        "The animation schedule is an isolated real Animation execution with the relevant queue transition, not a full Infantry renderer or an in-game screenshot.",
        "No deployed observation, pollution memory, tactic, match win rate, or release qualification has been restored by this prototype.",
    ],
};
writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ outputPath, assertions, materialChecks, finals: renderSchedules.map(entry => ({ name: entry.name, final: entry.final })) }));
