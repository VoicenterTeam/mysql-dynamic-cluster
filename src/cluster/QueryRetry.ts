import { IQueryOptions, IQueryOutcome } from "../types/PoolInterfaces";
import { NOT_READY } from "../utils/Abort";

// The errno of a login the server refused: access denied (1045, 1698), no access to the
// database (1044), an account locked (3118, 3955), a host not allowed (1130). A Galera cluster
// replicates the accounts, so every node refuses the same way, and a lockout policy counts
// each new login. Not the list of the health check in PoolStatus, which also has errors that
// differ from node to node
const REFUSED_LOGIN: ReadonlySet<number> = new Set([1045, 1698, 1044, 3118, 3955, 1130]);
// The pool refused to send values written into the text on a connection whose server has
// NO_BACKSLASH_ESCAPES. Another node can have the same sql_mode: the app has to use execute
const UNSAFE_SQL_MODE = 'MDC_UNSAFE_SQL_MODE';
// The packets of a reply came out of order: a defect of the client or the server, not of the
// network. Another node would meet it again
const OUT_OF_ORDER = 'MDC_PACKETS_OUT_OF_ORDER';

/**
 * Whether cluster.query() may send the statement to the next node after a node failed it.
 * The only place that decides it. Yes when the statement cannot have run on that node: it was
 * never sent, or the node answered 1047 and the query did not set retryNotReady to false.
 * Never after a refused login or an MDC_UNSAFE_SQL_MODE refusal, although its statement was
 * not sent, and never after MDC_PACKETS_OUT_OF_ORDER. Never once the signal of the query
 * aborted: in the call of the node, as the pool says, or since that call failed
 * @param error what the query of the node was rejected with
 * @param outcome what Pool.query() said of the call. A node that tells nothing counts as one
 * the statement was sent to
 * @param options the options of the query
 */
export function mayTryNextNode(
    error: unknown, outcome: IQueryOutcome, options: IQueryOptions
): boolean {
    // the caller gave up: no node gets the statement after that
    if (outcome.aborted || options.signal?.aborted) return false;
    const { errno, code } = (typeof error === 'object' && error !== null ? error : {}) as any;
    if (REFUSED_LOGIN.has(errno) || code === UNSAFE_SQL_MODE || code === OUT_OF_ORDER) {
        return false;
    }
    if (outcome.sent === false) return true;
    return errno === NOT_READY && options.retryNotReady !== false;
}
