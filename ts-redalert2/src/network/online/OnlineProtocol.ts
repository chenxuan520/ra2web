import type { LanLaunchDescriptor } from '@/network/lan/LanRoomSession';

export interface OnlineIdentity {
    id: string;
    name: string;
}

export interface OnlineRoom {
    id: string;
    hostPeerId: string;
    members: OnlineIdentity[];
    started: boolean;
}

export interface OnlineRoomSummary {
    id: string;
    hostName: string;
    playerCount: number;
    maxPlayers: number;
    mapTitle: string;
}

export type OnlineRequest =
    | { type: 'login'; requestId: string; user: string; pass: string }
    | { type: 'list-rooms'; requestId: string }
    | { type: 'create-room'; requestId: string }
    | { type: 'join-room'; requestId: string; roomId: string }
    | { type: 'leave-room'; requestId: string }
    | { type: 'start-game'; requestId: string; descriptor: LanLaunchDescriptor };

export type OnlineClientMessage = OnlineRequest
    | { type: 'chat'; text: string }
    | { type: 'app-message'; payload: unknown; targetPeerId?: string; excludedPeerId?: string };

export type OnlineServerMessage =
    | { type: 'result'; requestId: string; ok: boolean; data?: unknown; error?: string }
    | { type: 'room'; room: OnlineRoom | null }
    | { type: 'chat'; from: OnlineIdentity; text: string; timestamp: number }
    | { type: 'app-message'; from: OnlineIdentity; payload: unknown; timestamp: number }
    | { type: 'launch'; descriptor: LanLaunchDescriptor }
    | { type: 'error'; message: string; fatal?: boolean };
