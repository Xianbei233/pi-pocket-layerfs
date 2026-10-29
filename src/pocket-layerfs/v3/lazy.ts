/**
 * A service client that reads the private token when it first connects, and
 * forgets a connection after a transport failure. It never spawns the
 * service and never falls back to a mock: a missing service is a refusal.
 */
import { CODES, LayerfsRefusal } from "./errors.ts";
import { ServiceClient, readServiceToken } from "./ipc.ts";

export class LazyServiceClient {
    /** @type {{ socketPath: string, tokenFile: string, timeoutMs: number, maxResponseBytes: number }} */
    options;
    /** @type {ServiceClient | null} */
    client;
    /** @type {boolean} */
    closed;

    /**
     * @param {{ socketPath: string, tokenFile: string, timeoutMs: number, maxResponseBytes: number }} options
     */
    constructor(options) {
        this.options = options;
        this.client = null;
        this.closed = false;
    }

    /**
     * @param {string} op
     * @param {Record<string, unknown>} args
     * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
     */
    async request(op, args, options = {}) {
        if (this.closed) throw new LayerfsRefusal(CODES.ServiceUnavailable);
        let client = this.client;
        if (client === null) {
            const token = readServiceToken(this.options.tokenFile);
            client = new ServiceClient({ ...this.options, token });
            this.client = client;
        }
        try {
            return await client.request(op, args, options);
        } catch (error) {
            if (
                error instanceof LayerfsRefusal &&
                error.code === CODES.ServiceUnavailable &&
                this.client === client
            ) {
                client.close();
                this.client = null;
            }
            throw error;
        }
    }

    /** Close this plugin's sockets. It does not stop the service. */
    close() {
        this.closed = true;
        this.client?.close();
        this.client = null;
    }
}
