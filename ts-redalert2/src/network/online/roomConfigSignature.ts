import type { LanRoomState } from '@/network/lan/LanRoomSession';

export function roomConfigSignature(state: LanRoomState): string {
    return JSON.stringify([state.hostPeerId, state.memberOrder, state.humanAssignments, state.gameOpts, state.slotsInfo]);
}
