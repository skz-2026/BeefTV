import { http } from "./request";

/** Reachability hints reported by the local backend; no tunnel traffic goes through it. */
export type RemoteAccessStatus = {
    available: boolean;
    reason?: string;
    dnsName?: string;
    url?: string;
    magicDns: boolean;
    serveOn: boolean;
    servePort?: number;
    localUrl?: string;
};

export function getRemoteAccess(signal?: AbortSignal) {
    return http.get<RemoteAccessStatus>("/remote/access", { signal });
}
