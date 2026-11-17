import { afterEach, beforeEach } from "bun:test";
import { BRUTAL_PARAMS } from "../../game/ai/thirdpartbot/builtIn/bot/strategy/brutalParams";

/** Legacy fixtures assert the closed-switch contract, independently of shipped defaults. */
export function useLegacyAssaultDefaults() {
    const closed = { marchCohesion: 0, engageSpread: 0, dogHunt: 0, tankOpening: 0 };
    let previous = { ...closed };
    beforeEach(() => {
        previous = {
            marchCohesion: BRUTAL_PARAMS.assault.marchCohesion,
            engageSpread: BRUTAL_PARAMS.assault.engageSpread,
            dogHunt: BRUTAL_PARAMS.assault.dogHunt,
            tankOpening: BRUTAL_PARAMS.assault.tankOpening,
        };
        Object.assign(BRUTAL_PARAMS.assault, closed);
    });
    afterEach(() => Object.assign(BRUTAL_PARAMS.assault, previous));
}
