import { IQueryOptions, IQueryOutcome } from "../types/PoolInterfaces";

// The errno of a login the server refused: access denied (1045, 1698), no access to the
// database (1044), an account locked (3118, 3955), a host not allowed (1130). A Galera cluster
// replicates the accounts, so every node refuses the same way, and a lockout policy counts
// each new login. Not the list of the health check in PoolStatus, which also has errors that
// differ from node to node
const REFUSED_LOGIN: ReadonlySet<number> = new Set([1045, 1698, 1044, 3118, 3955, 1130]);
// Galera refused the statement because the node is not ready, and it did not run
const NOT_READY = 1047;

/**
 * Whether cluster.query() may send the statement to the next node after a node failed it.
 * The only place that decides it. Yes when the statement cannot have run on that node: it was
 * never sent, or the node answered 1047 and the query did not set retryNotReady to false.
 * Never after a refused login, although its statement was not sent
 * @param error what the query of the node was rejected with
 * @param outcome what Pool.query() said of the call. A node that tells nothing counts as one
 * the statement was sent to
 * @param options the options of the query
 */
export function mayTryNextNode(
    error: unknown, outcome: IQueryOutcome, options: IQueryOptions
): boolean {
    const errno = typeof error === 'object' && error !== null ? (error as any).errno : undefined;
    if (REFUSED_LOGIN.has(errno)) return false;
    if (outcome.sent === false) return true;
    return errno === NOT_READY && options.retryNotReady !== false;
}
