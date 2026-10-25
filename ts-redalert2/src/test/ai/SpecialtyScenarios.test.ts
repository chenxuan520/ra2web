import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cdn = process.env.RA2_BENCHMARK_CDN ?? resolve(projectRoot, '../.cache/ai-resources/cdn');
const resourcesAvailable = existsSync(resolve(cdn, 'maps/mp08t2.map')) && existsSync(resolve(cdn, 'game-res/v2/isotemp.mix'));

(resourcesAvailable ? test : test.skip)('real specialty fixtures trigger the actual AI and preserve simulation under observation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ra2-specialty-fixtures-'));
    try {
        const run = async (name: string, extra: string[]) => {
            const output = join(directory, name + '.json');
            const child = Bun.spawn([process.execPath, 'e2e/ai-specialty-scenarios.ts', '--cdn', cdn,
                '--out', output, ...extra], { cwd: projectRoot, stdout: 'pipe', stderr: 'pipe' });
            const [stdout, stderr, code] = await Promise.all([
                new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
            ]);
            if (code) throw new Error(`Fixture process exited ${code}\n${stdout}\n${stderr}`);
            return await Bun.file(output).json();
        };
        const observed = await run('observed', ['--repeat', '2']);
        const unobserved = await run('unobserved', ['--repeat', '1', '--no-telemetry']);
        expect(observed.passed).toBe(true);
        expect(observed.deterministic).toBe(true);
        expect(observed.issues).toEqual([]);
        expect(observed.scenarios.map((scene: any) => scene.name)).toEqual([
            'desolator-radiation', 'grand-cannon', 'tank-duel', 'ai-desolator-safe', 'ai-desolator-blocked', 'ai-radiation-detour',
            'ai-american-paradrop', 'ai-injured-tank-retreat', 'ai-radiation-guard', 'ai-infantry-crush', 'ai-radiation-transport',
        ]);
        for (const [index, scene] of observed.scenarios.entries()) {
            const { specialty, ...state } = scene;
            const { specialty: _disabled, ...control } = unobserved.scenarios[index];
            expect(state).toEqual(control);
            expect(specialty).toBeDefined();
        }
        const safe = observed.scenarios.find((scene: any) => scene.name === 'ai-desolator-safe');
        expect(safe.specialty.radiation.damageHitPointsByVictim[1]).toBeGreaterThan(0);
        expect(safe.specialty.radiation.damageHitPointsByVictim[0]).toBe(0);
        const blocked = observed.scenarios.find((scene: any) => scene.name === 'ai-desolator-blocked');
        expect(blocked.specialty.deployments).toEqual([]);
        expect(blocked.specialty.radiation.siteCalls).toEqual([]);
        const cannon = observed.scenarios.find((scene: any) => scene.name === 'grand-cannon');
        expect(cannon.specialty.damageBySourceType[1].GTGCAN.enemyKills).toBeGreaterThan(0);
        const detour = observed.scenarios.find((scene: any) => scene.name === 'ai-radiation-detour');
        expect(detour.specialty.radiation.damageByVictimType[0].HTNK ?? 0).toBe(0);
        const paradrop = observed.scenarios.find((scene: any) => scene.name === 'ai-american-paradrop');
        expect(paradrop.superWeaponsEnabled).toBe(false);
        expect(paradrop.specialty.superWeaponActivations.length).toBe(1);
        expect(paradrop.specialty.paradropSpawns.length).toBe(8);
        expect(paradrop.snapshots.at(-1).landedGis.length).toBe(8);
        const retreat = observed.scenarios.find((scene: any) => scene.name === 'ai-injured-tank-retreat');
        expect(retreat.checks.retreatMoveIssued).toBe(true);
        const guard = observed.scenarios.find((scene: any) => scene.name === 'ai-radiation-guard');
        expect(guard.controller).toBe('actual RadiationGuardMission');
        expect(guard.specialty.radiation.damageHitPointsByVictim[1]).toBeGreaterThan(0);
        expect(guard.specialty.radiation.damageHitPointsByVictim[0]).toBe(0);
        const crush = observed.scenarios.find((scene: any) => scene.name === 'ai-infantry-crush');
        expect(crush.specialty.crushKills.some((kill: any) => kill.sourceName === 'HTNK' && kill.targetName === 'E2')).toBe(true);
        const transport = observed.scenarios.find((scene: any) => scene.name === 'ai-radiation-transport');
        expect(transport.specialty.transportEvents.some((event: any) => event.event === 'EnterObject'
            && event.passengers.some((unit: any) => unit.name === 'DESO'))).toBe(true);
        expect(transport.specialty.transportEvents.some((event: any) => event.event === 'LeaveTransport' && !event.destroyed)).toBe(true);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}, 60000);
