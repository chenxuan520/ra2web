import { createConnection, type Socket } from 'node:net';

export interface IrcMessage {
    prefix: string;
    command: string;
    params: string[];
    trailing?: string;
}

export function parseIrc(line: string): IrcMessage {
    let prefix = '';
    if (line.startsWith(':')) {
        const end = line.indexOf(' ');
        prefix = line.slice(1, end);
        line = line.slice(end + 1).trimStart();
    }
    const trailingIndex = line.indexOf(' :');
    const trailing = trailingIndex < 0 ? undefined : line.slice(trailingIndex + 2);
    const tokens = (trailingIndex < 0 ? line : line.slice(0, trailingIndex)).split(/ +/);
    return { prefix, command: tokens.shift()?.toUpperCase() ?? '', params: tokens, trailing };
}

export function wolHash(password: string): string {
    if (!/^[\x20-\x7e]{1,8}$/.test(password)) {
        throw new Error('Password must contain 1–8 printable ASCII characters');
    }
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789./';
    const input = Buffer.alloc(9);
    const mixed = Buffer.alloc(8);
    input.write(password, 'ascii');
    for (let i = 0; i < password.length; i++) {
        mixed[i] = input[i] & 1
            ? ((input[i] << 1) & 255) & input[password.length - i]
            : input[i] ^ input[password.length - i];
    }
    return Array.from(mixed, (byte) => alphabet[byte & 63]).join('');
}

export function upstreamError(message: IrcMessage): Error | undefined {
    const errors: Record<string, string> = {
        '378': 'Invalid username or password',
        '433': 'Username is already connected',
        '471': 'Room is full',
        '473': 'Room is invite-only',
        '474': 'Room access denied',
        '475': 'Room password rejected',
        '478': 'Room is closed or already started',
    };
    if (errors[message.command]) {
        return new Error(`PvPGN ${message.command}: ${errors[message.command]}`);
    }
    if (/^[45]\d\d$/.test(message.command) || message.command === 'ERROR') {
        return new Error(`PvPGN rejected the operation (${message.command})`);
    }
    return undefined;
}

export class PvpgnConnection {
    readonly socket: Socket;
    readonly connected: Promise<void>;
    private buffer = '';
    private closed = false;
    private pending?: {
        accept: (message: IrcMessage) => boolean;
        resolve: (message: IrcMessage) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    };
    private rejectConnect!: (error: Error) => void;
    private connectTimer: ReturnType<typeof setTimeout>;

    constructor(
        host: string,
        port: number,
        private readonly timeoutMs: number,
        private readonly onMessage: (message: IrcMessage) => void,
        private readonly onClose: () => void,
    ) {
        this.socket = createConnection({ host, port });
        this.socket.setNoDelay(true);
        this.socket.setKeepAlive(true, 30_000);
        this.socket.setEncoding('utf8');
        this.connected = new Promise<void>((resolve, reject) => {
            this.rejectConnect = reject;
            this.socket.once('connect', () => {
                clearTimeout(this.connectTimer);
                resolve();
            });
        });
        this.connectTimer = setTimeout(() => this.destroy(new Error('PvPGN connection timed out')), timeoutMs);
        this.socket.on('data', (data: string) => {
            this.buffer += data;
            if (Buffer.byteLength(this.buffer) > 128 * 1024) {
                this.destroy(new Error('Invalid PvPGN response'));
                return;
            }
            let end: number;
            while ((end = this.buffer.indexOf('\n')) >= 0 && !this.closed) {
                const line = this.buffer.slice(0, end).replace(/\r$/, '');
                this.buffer = this.buffer.slice(end + 1);
                if (!line) {
                    continue;
                }
                if (Buffer.byteLength(line) > 16 * 1024 || line.includes('\0')) {
                    this.destroy(new Error('Invalid PvPGN response'));
                    return;
                }
                const message = parseIrc(line);
                if (message.command === 'PING') {
                    this.send(`PONG :${message.trailing ?? message.params.join(' ')}`);
                    continue;
                }
                const pending = this.pending;
                try {
                    this.onMessage(message);
                    const error = upstreamError(message);
                    if (pending && this.pending === pending) {
                        if (error) {
                            this.finish(undefined, error);
                        }
                        else if (pending.accept(message)) {
                            this.finish(message);
                        }
                    }
                    else if (message.command === 'ERROR') {
                        this.destroy(error);
                    }
                }
                catch {
                    this.destroy(new Error('Invalid PvPGN response'));
                }
            }
        });
        this.socket.on('error', () => this.destroy(new Error('PvPGN connection failed')));
        this.socket.on('end', () => this.destroy());
        this.socket.on('close', () => this.destroy());
    }

    send(line: string): void {
        if (this.closed || this.socket.destroyed) {
            throw new Error('PvPGN connection is closed');
        }
        if (/[\r\n\0]/.test(line) || Buffer.byteLength(line) > 4094) {
            throw new Error('Invalid upstream command');
        }
        if (this.socket.writableLength > 1024 * 1024) {
            this.destroy(new Error('PvPGN connection is overloaded'));
            throw new Error('PvPGN connection is overloaded');
        }
        this.socket.write(`${line}\r\n`);
    }

    exchange(lines: string[], accept: (message: IrcMessage) => boolean): Promise<IrcMessage> {
        if (this.closed || this.pending) {
            return Promise.reject(new Error(this.closed ? 'PvPGN connection is closed' : 'PvPGN operation already pending'));
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.finish(undefined, new Error('PvPGN operation timed out'));
                this.destroy();
            }, this.timeoutMs);
            this.pending = { accept, resolve, reject, timer };
            try {
                for (const line of lines) {
                    this.send(line);
                }
            }
            catch (error) {
                this.finish(undefined, error as Error);
            }
        });
    }

    destroy(error = new Error('PvPGN connection closed')): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        clearTimeout(this.connectTimer);
        this.rejectConnect(error);
        this.finish(undefined, error);
        this.socket.destroy();
        this.onClose();
    }

    private finish(message?: IrcMessage, error?: Error): void {
        const pending = this.pending;
        this.pending = undefined;
        if (pending) {
            clearTimeout(pending.timer);
            if (error) {
                pending.reject(error);
            }
            else {
                pending.resolve(message!);
            }
        }
    }
}
