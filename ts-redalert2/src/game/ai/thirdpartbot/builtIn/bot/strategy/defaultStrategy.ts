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
import { SupabotContext } from "../logic/common/context";
import { MissionController } from "../logic/mission/missionController";
import { DebugLogger } from "../logic/common/utils";
import { Compositions, getValidCompositions, SideComposition } from "./compositionUtils";
import { readStrategicSituation, selectNationalComposition } from "./nationalComposition";

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

    onAiUpdate(context: SupabotContext, missionController: MissionController, logger: DebugLogger) {
        this.paraDropSupport.onAiUpdate(context);
        ensureBaseReserve(context, missionController, logger);
        this.expansionFactory.maybeCreateMissions(context, missionController, logger);
        this.scoutingFactory.maybeCreateMissions(context, missionController, logger);

        const composition = this.selectRandomAttackComposition(context, logger, missionController);
        if (composition) {
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

        const validCompositions = getValidCompositions(context, DEFAULT_COMPOSITIONS);

        if (validCompositions.length === 0) {
            return null;
        }

        logger(`Valid compositions: ${validCompositions.join(", ")}`);

        if (context.difficulty === "brutal") {
            const situation = readStrategicSituation(context.game, playerData);
            const reservedSupport: Record<string, number> = {};
            for (const mission of missionController.getMissions()) {
                if (mission instanceof AttackMission) {
                    for (const [name, count] of Object.entries(mission.getPendingSupportUnits(context.game))) {
                        reservedSupport[name] = (reservedSupport[name] ?? 0) + count;
                    }
                }
            }
            const core = selectAdaptiveComposition(
                DEFAULT_COMPOSITIONS, validCompositions, context.matchAwareness.getThreatCache(), situation.harvesters,
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
