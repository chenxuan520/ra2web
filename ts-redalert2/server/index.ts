import { createGateway } from './gateway';

export { createGateway } from './gateway';
export type { GatewayOptions } from './gateway';

if (import.meta.main) {
    const gateway = createGateway();
    console.info(`Gateway started on port ${gateway.server.port}`);
    let stopping = false;
    const stop = async () => {
        if (stopping) {
            return;
        }
        stopping = true;
        await gateway.stop();
        console.info('Gateway stopped');
        process.exit(0);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}
