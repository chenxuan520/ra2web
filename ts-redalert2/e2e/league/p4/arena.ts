import type { Profile } from '../registry';
import type { Country } from '../schedule';

export const TRAIN_MAPS = ['mp08t2', 'tn01t2', 'mp11t2', 'tn04t2', 'mp06t2', 'mp29u2', 'mp31s2', 'mp02t2'] as const;
export const HOLDOUT_MAPS = ['mp01t4', 'mp05t4', 'mp12s4', 'tn02s4', 'mp03t4', 'mp13s4'] as const;
export const ALL_MAPS = [...TRAIN_MAPS, ...HOLDOUT_MAPS];

export const TRAIN_OPPONENTS = ['c3', 'v5', 'x-infantry-01', 'x-harass-01', 'x-mixed-01'];
export const HOLDOUT_OPPONENTS = ['c2', 'r4', 'x-engineer-01', 'x-crawl-01', 'x-airguard-01', 'x-rearm-01'];
export const MATCHUPS = [
    ['Americans', 'Americans'], ['Russians', 'Americans'],
    ['Russians', 'Russians'], ['Americans', 'Russians'],
] as const;

export interface ArenaJob {
    id: string;
    stage: 'train' | 'holdout';
    run: number | null;
    generation: number | null;
    promotion: number | null;
    a: string;
    aRef: string;
    aProfile: Profile;
    b: string;
    bRef: string;
    bProfile: Profile;
    map: string;
    seed: number;
    aCountry: Country;
    bCountry: Country;
    earlyStop?: boolean;
}

function integer(value: number, name: string, min: number, max: number): void {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}: ${value}`);
}
function mapIndex(map: string): number {
    const index = (ALL_MAPS as readonly string[]).indexOf(map);
    if (index < 0) throw new Error(`Unknown arena map ${map}`);
    return index + 1;
}
export function trainingSeed(run: number, generation: number, map: string): number {
    integer(run, 'run', 1, 99); integer(generation, 'generation', 0, 49);
    return 200000 + run * 1000 + generation * 20 + mapIndex(map);
}
export function promotionSeed(promotion: number, map: string): number {
    integer(promotion, 'promotion', 1, 500);
    return 900000 + promotion * 20 + mapIndex(map);
}
export function jobId(job: Pick<ArenaJob, 'a' | 'b' | 'map' | 'seed' | 'aCountry' | 'bCountry'>): string {
    return `${job.a}__${job.b}__${job.map}__${job.seed}__${job.aCountry}-${job.bCountry}`;
}
export function trainMaps(generation: number): string[] {
    integer(generation, 'generation', 0, 49);
    return TRAIN_MAPS.filter((_map, index) => index % 2 === generation % 2);
}
export function trainMatchups(generation: number): (typeof MATCHUPS[number])[] {
    integer(generation, 'generation', 0, 49);
    return Math.floor(generation / 2) % 2 === 0 ? MATCHUPS.slice(0, 2) : MATCHUPS.slice(2);
}
export function trainOpponents(generation: number, champion: string): string[] {
    integer(generation, 'generation', 0, 49);
    return [champion, TRAIN_OPPONENTS[generation % 5], TRAIN_OPPONENTS[(generation + 1) % 5], TRAIN_OPPONENTS[(generation + 2) % 5]];
}
export function trainJobs(individual: string, run: number, generation: number, champion: string): ArenaJob[] {
    return trainMaps(generation).flatMap(map => trainMatchups(generation).flatMap(([aCountry, bCountry]) =>
        trainOpponents(generation, champion).map(b => {
            const job = { stage: 'train' as const, run, generation, promotion: null, a: individual, aRef: `league/${individual}`,
                aProfile: 'brutal' as const, b, bRef: `league/${b}`, bProfile: 'brutal' as const,
                map, seed: trainingSeed(run, generation, map), aCountry, bCountry };
            return { id: jobId(job), ...job };
        })));
}
export function holdoutJobs(member: string, opponent: string, promotion: number): ArenaJob[] {
    integer(promotion, 'promotion', 1, 500);
    return HOLDOUT_MAPS.flatMap(map => MATCHUPS.map(([aCountry, bCountry]) => {
        const job = { stage: 'holdout' as const, run: null, generation: null, promotion, a: member, aRef: `league/${member}`,
            aProfile: 'brutal' as const, b: opponent, bRef: `league/${opponent}`, bProfile: 'brutal' as const,
            map, seed: promotionSeed(promotion, map), aCountry, bCountry };
        return { id: jobId(job), ...job };
    }));
}

export interface LegacyArenaRequest {
    a?: string;
    vs?: string;
    ref?: readonly string[];
    'round-robin'?: boolean;
}
/** Historical rounds retain their old schedule; round 8+ must not expose holdouts through the legacy runner. */
export function assertRoundIsolation(round: number, request: LegacyArenaRequest, activeMembers: readonly string[] = []): void {
    if (round < 8) return;
    if (request.vs === 'active') throw new Error('Round 8+ --vs active is forbidden; use e2e/league/p4 scripts');
    const references = [request.a ?? '', request.vs ?? '', ...(request.ref ?? []),
        ...(request['round-robin'] ? activeMembers : [])];
    for (const reference of references) {
        const tokens = reference.split(/[=,/~^:]/);
        const heldOut = HOLDOUT_OPPONENTS.find(id => tokens.includes(id));
        if (heldOut) throw new Error(`Round 8+ holds out ${heldOut}; use e2e/league/p4 scripts`);
    }
}
