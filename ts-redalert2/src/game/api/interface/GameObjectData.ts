import type { HealthLevel } from "@/game/gameobject/unit/HealthLevel";

export interface GameObjectData {
    id: any;
    type: string;
    name: string;
    rules: any;
    tile: any;
    tileElevation: number;
    worldPosition: any;
    foundation: any;
    /** Own/shared-intel or diagnostics only; absent from external observations. */
    hitPoints?: number;
    maxHitPoints?: number;
    /** Public red/yellow/green display only; not exact HP or health ratio. */
    healthLevel?: HealthLevel;
    /** Apparent owner; never a command-ownership guarantee. */
    owner?: string;
}
