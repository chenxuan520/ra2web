import { GameObjectData } from './GameObjectData';

/** Visible unit appearance. Unknown data is absent, never fabricated as zero. */
export interface ObservedUnitData extends GameObjectData {
    owner?: string;
    direction: number;
    onBridge?: boolean;
    zone?: any;
    veteranLevel?: number;
    turretFacing?: number;
    buildStatus?: string;
    hasWrenchRepair?: boolean;
}

/** Additional fields are available only for own/shared-intel or diagnostics. */
export interface UnitData extends ObservedUnitData {
    sight?: number;
    guardMode?: boolean;
    purchaseValue?: number;
    primaryWeapon?: any;
    secondaryWeapon?: any;
    deathWeapon?: any;
    attackState?: string;
    /** Raw stance/firing are private: apparent animations may suppress them. */
    stance?: string;
    isFiring?: boolean;
    factory?: {
        deliveringUnit?: string;
        status: string;
    };
    rallyPoint?: any;
    isPoweredOn?: boolean;
    turretNo?: number;
    garrisonUnitCount?: number;
    garrisonUnitsMax?: number;
    passengerSlotCount?: number;
    passengerSlotMax?: number;
    isIdle?: boolean;
    canMove?: boolean;
    velocity?: any;
    harvestedOre?: number;
    harvestedGems?: number;
    ammo?: number;
    isWarpedOut?: boolean;
    mindControlledBy?: string;
    tntTimer?: number;
}
