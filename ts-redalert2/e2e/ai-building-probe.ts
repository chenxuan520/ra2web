type BuildingOptionObservation = {
    tick: number;
    priority: number;
    placementAttempts: number;
    placementFailures: number;
};

type BuildingMissionObservation = {
    queue: number;
    options: Record<string, BuildingOptionObservation>;
    lastSelected: {
        tick: number;
        name: string;
        location: { rx: number; ry: number } | null;
    } | null;
    placementAttempts: number;
    placementFailures: number;
    consecutivePlacementFailures: number;
};

/**
 * Observe the decisions already made by a bot, including historical snapshots.
 * Do not ask the bot for additional decisions: placement helpers may consume RNG.
 * Install after game.start(), when the permanent building missions exist.
 */
export function observeBuildingMissions(bot: any, getTick: () => number): () => unknown {
    const observations: Record<string, BuildingMissionObservation> = {};
    const missions = bot?.innerBot?.missionController?.getMissions?.() ?? [];
    for (const mission of missions) {
        const getPriority = mission.getPriorityForBuildingOption;
        const getLocation = mission.getBestLocationForStructure;
        if (typeof getPriority !== 'function' || typeof getLocation !== 'function') continue;

        const observation: BuildingMissionObservation = {
            queue: mission.queueType,
            options: {},
            lastSelected: null,
            placementAttempts: 0,
            placementFailures: 0,
            consecutivePlacementFailures: 0,
        };
        observations[mission.getUniqueName()] = observation;
        mission.getPriorityForBuildingOption = function (...args: any[]) {
            const priority = getPriority.apply(this, args);
            const name = args[0].name;
            const previous = observation.options[name];
            observation.options[name] = {
                tick: getTick(),
                priority,
                placementAttempts: previous?.placementAttempts ?? 0,
                placementFailures: previous?.placementFailures ?? 0,
            };
            return priority;
        };
        mission.getBestLocationForStructure = function (...args: any[]) {
            const location = getLocation.apply(this, args);
            const name = args[2].name;
            const option = observation.options[name];
            observation.lastSelected = {
                tick: getTick(),
                name,
                location: location ? { rx: location.rx, ry: location.ry } : null,
            };
            observation.placementAttempts++;
            if (option) option.placementAttempts++;
            if (location) {
                observation.consecutivePlacementFailures = 0;
            } else {
                observation.placementFailures++;
                observation.consecutivePlacementFailures++;
                if (option) option.placementFailures++;
            }
            return location;
        };
    }
    return () => structuredClone(observations);
}
