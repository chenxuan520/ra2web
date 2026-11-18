export const DECISION_FILES = [
    'logic/building/queueController.ts', 'logic/building/economyPlan.ts', 'logic/building/harvester.ts',
    'logic/building/resourceCollectionBuilding.ts', 'logic/building/strategicBuildings.ts',
    'logic/mission/missions/fieldArmyMission.ts', 'logic/mission/missions/attackMission.ts',
    'logic/mission/missions/harassmentMission.ts', 'logic/mission/missions/scoutingMission.ts',
    'logic/mission/missions/expansionMission.ts', 'logic/mission/missions/minerDefence.ts', 'strategy/defaultStrategy.ts',
] as const;

export function countStrategyLiterals(source: string): number {
    const stripped = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/g, '');
    return [...stripped.matchAll(/(?<![\w.])\d+(\.\d+)?(?![\w.])/g)].filter(match => ![0, 1, 2].includes(Number(match[0]))).length;
}
