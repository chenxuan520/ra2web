import { GameApi, TechnoRules } from "../../../game-api";

// checking technorules directly reduces the amount of calls to getUnitData(), which is a relatively expensive function.
// A null value indicates an object that does not have TechnoRules.
// Rules can differ between matches/maps even when unit names are identical.
const matchRulesCaches = new WeakMap<object, Map<string, TechnoRules | null>>();

export const getCachedTechnoRules = (gameApi: GameApi, unitId: any): TechnoRules | null => {
    const gameObject = gameApi.getGameObjectData(unitId);
    if (!gameObject) {
        return null;
    }
    const { rulesApi } = gameApi;
    const { name } = gameObject;
    let technoRulesCache = matchRulesCaches.get(rulesApi);
    if (!technoRulesCache) {
        technoRulesCache = new Map();
        matchRulesCaches.set(rulesApi, technoRulesCache);
    }

    if (technoRulesCache.has(name)) {
        // object is present in cache, either with TechnoRules or null (indicating that it does not have TechnoRules)
        return technoRulesCache.get(name)!;
    }

    const aircraftRules = rulesApi.aircraftRules.get(name);
    if (aircraftRules) {
        technoRulesCache.set(name, aircraftRules);
        return aircraftRules;
    }

    const buildingRules = rulesApi.buildingRules.get(name);
    if (buildingRules) {
        technoRulesCache.set(name, buildingRules);
        return buildingRules;
    }

    const infantryRules = rulesApi.infantryRules.get(name);
    if (infantryRules) {
        technoRulesCache.set(name, infantryRules);
        return infantryRules;
    }

    const vehicleRules = rulesApi.vehicleRules.get(name);
    if (vehicleRules) {
        technoRulesCache.set(name, vehicleRules);
        return vehicleRules;
    }

    technoRulesCache.set(name, null);
    return null;
};
