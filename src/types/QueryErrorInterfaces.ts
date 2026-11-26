// One node a failed cluster.query() tried before the node of the error it rejects with
export interface INodeError {
    nodeId: number,
    // what the call of that node was rejected with, as mysql2, the socket or the package made it
    error: unknown
}

/**
 * What a failed cluster.query() rejects with: the error of the node tried last, as mysql2 or
 * the socket made it, not a wrapper. A field of mysql2 is there when mysql2 set it. The package
 * adds `nodeId`, `sent` and `nodeErrors`. A query whose signal aborted rejects with the reason
 * of the signal instead, which is the app's and has none of these. An error the app handed
 * failWaiting() is one object that many queries share: its `nodeId`, `sent` and `nodeErrors`
 * are those of the query that rejected last, so read them in the catch
 */
export interface IQueryError extends Error {
    // mysql2's code such as ER_LOCK_DEADLOCK or PROTOCOL_CONNECTION_LOST, the socket's such as
    // ECONNREFUSED, or one of the package, which starts with MDC_
    code?: string,
    // the error number of the server, or the negative errno of the socket
    errno?: number,
    sqlState?: string,
    sqlMessage?: string,
    // Only on an error the server answered with: the statement as sent. For query() it holds
    // the values written into the text. Drop it before an error is logged or shipped whole
    sql?: string,
    // true when mysql2 gave up the connection for this error
    fatal?: boolean,
    // the node the error came from. Not set when no node was asked
    nodeId?: number,
    // false when the statement cannot have run on that node, true once it was handed to the
    // connection
    sent?: boolean,
    // The nodes tried before the last one, in the order they were tried. Always this shape.
    // Not set when no node was asked, or on an error that cannot take it, such as a frozen one
    nodeErrors?: INodeError[],
    // The same list as `nodeErrors`, unless the error had an `errors` of its own, such as the
    // one of an AggregateError, which it keeps. Read `nodeErrors`
    errors?: unknown
}
