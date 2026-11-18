import { sp } from "./params";
import { Strategy } from "./strategy";
import { selectAdaptiveComposition } from "./adaptiveComposition";
import { ExpansionMissionFactory } from "../logic/mission/missions/expansionMission";
import { ScoutingMissionFactory } from "../logic/mission/missions/scoutingMission";
import { AttackMission, AttackMissionFactory } from "../logic/mission/missions/attackMission";
import { DefenceMissionFactory } from "../logic/mission/missions/defenceMission";
import { EngineerMissionFactory } from "../logic/mission/missions/engineerMission";
import { ParaDropSupport } from "../logic/mission/missions/paraDropSupport";
import { SneakCaptureMissionFactory } from "../logic/mission/missions/sneakCaptureMission";
import { ensureBaseReserve } from "../logic/mission/missions/baseReserveMission";
import { ensureInfantryHome } from "../logic/mission/missions/infantryHomeMission";
import { MinerDefence } from "../logic/mission/missions/minerDefence";
import { ensureRadiationGuard } from "../logic/mission/missions/radiationGuardMission";
import { RadiationTransportFactory } from "../logic/mission/missions/radiationTransportMission";
import { FieldArmyMission } from "../logic/mission/missions/fieldArmyMission";
import { DogEscortMission } from "../logic/mission/missions/dogEscortMission";
import { HarassmentMissionFactory } from "../logic/mission/missions/harassmentMission";
import { SupabotContext } from "../logic/common/context";
import { MissionController } from "../logic/mission/missionController";
import { DebugLogger } from "../logic/common/utils";
import { Compositions, getValidCompositions, SideComposition } from "./compositionUtils";
import { readStrategicSituation, selectNationalComposition } from "./nationalComposition";
import { getOpeningAirBudget } from "./openingAirBudget";

// These could be loaded from ai.ini
export const DEFAULT_COMPOSITIONS: Compositions = {
    conscripts: {
        composition: {
            E2: 1,
        },
        minimumUnits: 3,
        maximumUnits: 10,
    },
    gis: {
        composition: {
            E1: 1,
        },
        minimumUnits: 3,
        maximumUnits: 10,
    },
    sovietTanks: {
        composition: {
            HTNK: 5,
            HTK: 1,
        },
        minimumUnits: 2,
        maximumUnits: 20,
    },
    alliedTanks: {
        composition: {
            MTNK: 5,
            FV: 1,
        },
        minimumUnits: 2,
        maximumUnits: 20,
    },
    kirovs: {
        composition: {
            ZEP: 1,
        },
        minimumUnits: 1,
        maximumUnits: 3,
    },
    rocketeers: {
        composition: {
            JUMPJET: 1,
        },
        minimumUnits: 2,
        maximumUnits: 6,
    },
    heavySovietTanks: {
        composition: {
            APOC: 2,
            HTNK: 1,
        },
        minimumUnits: 2,
        maximumUnits: 10,
    },
    heavyAlliedTanks: {
        composition: {
            MTNK: 2,
            MGTK: 1,
        },
        minimumUnits: 2,
        maximumUnits: 10,
    },
    sovietArtillery: {
        composition: {
            V3: 2,
            HTNK: 1,
        },
        minimumUnits: 3,
        maximumUnits: 10,
    },
    alliedArtillery: {
        composition: {
            SREF: 2,
            MTNK: 1,
        },
        minimumUnits: 3,
        maximumUnits: 10,
    },
};

export class DefaultStrategy implements Strategy {
    private expansionFactory = new ExpansionMissionFactory();
    private scoutingFactory = new ScoutingMissionFactory();
    private attackFactory = new AttackMissionFactory();
    private defenceFactory = new DefenceMissionFactory();
    private engineerFactory = new EngineerMissionFactory();
    private paraDropSupport = new ParaDropSupport();
    private sneakCaptureFactory = new SneakCaptureMissionFactory();
    private minerDefence = new MinerDefence();
    private fieldArmy?: FieldArmyMission;
    private dogEscort?: DogEscortMission;
    private fieldHarassment = new HarassmentMissionFactory();
    private radiationTransport = new RadiationTransportFactory();

    onAiUpdate(context: SupabotContext, missionController: MissionController, logger: DebugLogger) {
        this.paraDropSupport.onAiUpdate(context);
        this.minerDefence.onAiUpdate(context);
        ensureBaseReserve(context, missionController, logger);
        ensureInfantryHome(context, missionController, logger);
        ensureRadiationGuard(context, missionController, logger);
        this.radiationTransport.maybeCreateMissions(context, missionController, logger);
        this.expansionFactory.maybeCreateMissions(context, missionController, logger);
        this.scoutingFactory.maybeCreateMissions(context, missionController, logger);

        const composition = this.selectRandomAttackComposition(context, logger, missionController);
        if (context.difficulty === "brutal") {
            if (!this.fieldArmy) {
                this.fieldArmy = new FieldArmyMission(composition, missionController, logger);
                missionController.addMission(this.fieldArmy);
            }
            this.fieldArmy.setPlan(composition);
            if (!this.dogEscort && context.player.production.getAvailableObjects().some(rule => ["HTNK", "MTNK"].includes(rule.name))) {
                this.dogEscort = new DogEscortMission(this.fieldArmy, logger);
                missionController.addMission(this.dogEscort);
            }
            this.fieldHarassment.maybeCreateMissions(context, missionController, logger, [this.fieldArmy]);
        } else if (composition) {
            this.attackFactory.maybeCreateMissions(context, missionController, logger, composition);
        }

        this.defenceFactory.maybeCreateMissions(context, missionController, logger);
        this.engineerFactory.maybeCreateMissions(context, missionController, logger);
        this.sneakCaptureFactory.maybeCreateMissions(context, missionController, logger);

        return this;
    }

    private selectRandomAttackComposition(context: SupabotContext, logger: DebugLogger, missionController: MissionController): SideComposition | null {
        const playerData = context.game.getPlayerData(context.player.name);
        const side = playerData.country?.side;
        if (side === undefined) {
            return null;
        }

        const compositions: Compositions = context.difficulty === "brutal"
            ? Object.fromEntries(Object.entries(DEFAULT_COMPOSITIONS).map(([name, plan]): [string, SideComposition] => [name, {
                ...plan, composition: Object.fromEntries(Object.keys(plan.composition).map((unit): [string, number] =>
                    [unit, sp(context.game, playerData.name, `production.${name}${unit}Factor`)]).filter(([, weight]) => weight > 0)),
                minimumUnits: sp(context.game, playerData.name, `production.${name}MinCount`),
                maximumUnits: sp(context.game, playerData.name, `production.${name}Cap`),
            }]).filter(([, plan]) => Object.keys(plan.composition).length > 0))
            : DEFAULT_COMPOSITIONS;
        const validCompositions = getValidCompositions(context, compositions);

        if (validCompositions.length === 0) {
            return null;
        }

        logger(`Valid compositions: ${validCompositions.join(", ")}`);

        if (context.difficulty === "brutal") {
            const situation = readStrategicSituation(context.game, playerData);
            if (sp(context.game, playerData.name, 'assault.tankOpening') === 1 && situation.tick < sp(context.game, playerData.name, 'assault.tankOpeningUntil') && situation.harvesters > 0) {
                const tankCore = validCompositions.find(name => name === "sovietTanks" || name === "alliedTanks");
                return tankCore ? compositions[tankCore] : null;
            }
            const infantryOpening = validCompositions.includes("conscripts") ? compositions.conscripts :
                validCompositions.includes("gis") ? compositions.gis : undefined;
            if (context.game.getCurrentTick() < sp(context.game, playerData.name, 'production.infantryOpeningEndTick') && situation.harvesters > 0 && infantryOpening)
                return { ...infantryOpening, minimumUnits: sp(context.game, playerData.name, 'production.infantryOpeningMinCount'), maximumUnits: infantryOpening.composition.E2 ? sp(context.game, playerData.name, 'production.sovietOpeningInfantryCap') : sp(context.game, playerData.name, 'production.alliedOpeningInfantryCap') };
            const threat = context.matchAwareness.getThreatCache();
            const aggressiveAir = getOpeningAirBudget(context.game, playerData) === 8;
            if (validCompositions.includes("rocketeers") && (situation.own.JUMPJET ?? 0) < sp(context.game, playerData.name, 'production.openingRocketeerCap') &&
                (threat?.totalOffensiveAntiAirThreat ?? 0) < Math.max(aggressiveAir ? sp(context.game, playerData.name, 'production.aggressiveAirThreatFloor') : sp(context.game, playerData.name, 'production.airThreatFloor'),
                    (threat?.totalAvailableAirPower ?? 0) * (aggressiveAir ? sp(context.game, playerData.name, 'production.aggressiveAirThreatRatio') : sp(context.game, playerData.name, 'production.airThreatRatio')))) {
                return { ...compositions.rocketeers, maximumUnits: sp(context.game, playerData.name, 'production.openingAirWaveCap') };
            }
            if (validCompositions.includes("kirovs") && (situation.own.ZEP ?? 0) < sp(context.game, playerData.name, 'production.kirovCap') &&
                (threat?.totalOffensiveAntiAirThreat ?? 0) < Math.max(sp(context.game, playerData.name, 'production.kirovThreatFloor'), (threat?.totalAvailableAirPower ?? 0) * sp(context.game, playerData.name, 'production.kirovThreatRatio'))) {
                return { ...compositions.kirovs, maximumUnits: sp(context.game, playerData.name, 'production.kirovCap') };
            }
            const reservedSupport: Record<string, number> = {};
            for (const mission of missionController.getMissions()) {
                if (mission instanceof AttackMission) {
                    for (const [name, count] of Object.entries(mission.getPendingSupportUnits(context.game))) {
                        reservedSupport[name] = (reservedSupport[name] ?? 0) + count;
                    }
                }
            }
            const core = selectAdaptiveComposition(
                compositions, validCompositions, context.matchAwareness.getThreatCache(), situation.harvesters,
            );
            if (core?.composition.E1 || core?.composition.E2) return null;
            return core ? selectNationalComposition(core,
                new Set(context.player.production.getAvailableObjects().map(option => option.name)), situation, reservedSupport) : null;
        }

        const randomIndex = context.game.generateRandomInt(0, validCompositions.length - 1);
        const compositionId = validCompositions[randomIndex];
        return DEFAULT_COMPOSITIONS[compositionId];
    }
}
