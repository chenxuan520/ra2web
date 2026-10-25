/** Read-only role-specific samples; never issues an order or changes a bot. */
export class AiMobilityProbe {
    private rows = [this.empty(), this.empty()];
    private empty() {
        return { sampleTicks: 0, mobileConscriptSamples: 0, maximumMobileConscripts: 0,
            homeConscriptSamples: 0, tankSamples: 0, movingTankSamples: 0,
            firingTankSamples: 0, idleTankSamples: 0, stationaryNonFiringTankSamples: 0,
            escortDogSamples: 0, dogTankDistanceSamples: 0, dogTankDistanceSum: 0,
            maximumDogTankDistance: 0, dogBeyondFourTileSamples: 0,
            firstTankBeyondHome20Tick: null as number | null };
    }

    sample(tick: number, players: any[], bots: Map<string, any>, starts: { x: number; y: number }[]) {
        for (const [side, player] of players.entries()) {
            const row = this.rows[side];
            const controller = bots.get(player.name)?.innerBot?.missionController;
            if (!controller?.getMissions) continue;
            const missions = controller.getMissions();
            const start = starts[side];
            const objects = new Map<number, any>(player.getOwnedObjects().filter((o: any) => !o.isDestroyed)
                .map((o: any) => [o.id, o]));
            const role = (name: string): any[] => missions.filter((m: any) => m.getUniqueName() === name)
                .flatMap((m: any) => m.getUnitIds()).map((id: number) => objects.get(id)).filter(Boolean);
            const mobile = role('fieldArmy');
            const conscripts = mobile.filter(o => o.name === 'E2');
            const tanks = mobile.filter(o => ['HTNK', 'MTNK', 'MGTK', 'APOC'].includes(o.name));
            const dogs = role('dogEscort').filter(o => o.name === 'DOG');
            row.sampleTicks++;
            row.mobileConscriptSamples += conscripts.length;
            row.maximumMobileConscripts = Math.max(row.maximumMobileConscripts, conscripts.length);
            row.homeConscriptSamples += role('infantryHome').filter(o => o.name === 'E2').length;
            row.tankSamples += tanks.length;
            for (const tank of tanks) {
                const v = tank.moveTrait?.velocity;
                const moving = Math.hypot(v?.x ?? 0, v?.y ?? 0, v?.z ?? 0) > .01;
                row.movingTankSamples += Number(moving);
                row.firingTankSamples += Number(!!tank.isFiring);
                row.idleTankSamples += Number(!tank.unitOrderTrait?.hasTasks());
                row.stationaryNonFiringTankSamples += Number(!moving && !tank.isFiring);
                if (start && Math.hypot(tank.tile.rx - start.x, tank.tile.ry - start.y) >= 20) {
                    row.firstTankBeyondHome20Tick ??= tick;
                }
            }
            row.escortDogSamples += dogs.length;
            for (const dog of dogs) if (tanks.length) {
                const distance = Math.min(...tanks.map(t => Math.hypot(t.tile.rx - dog.tile.rx, t.tile.ry - dog.tile.ry)));
                row.dogTankDistanceSamples++;
                row.dogTankDistanceSum += distance;
                row.maximumDogTankDistance = Math.max(row.maximumDogTankDistance, distance);
                row.dogBeyondFourTileSamples += Number(distance > 4);
            }
        }
    }

    snapshot() {
        return { cadenceTicks: 30, players: this.rows.map(row => ({ ...row, roleTelemetryAvailable: row.sampleTicks > 0,
            meanEscortDogTankDistance: row.dogTankDistanceSamples ? row.dogTankDistanceSum / row.dogTankDistanceSamples : null })),
            notes: ['Role IDs distinguish escorts from scouts; distances use the nearest mobile-army tank, not an inferred anchor.',
                'Stationary samples include defence, cooldown, congestion and gathering; they do not prove waiting for dogs.',
                'First departure is sampled within 30 ticks and is not proof of successful pressure.'] };
    }
}
