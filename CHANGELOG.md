# Changelog

## 5.0.0 (unreleased)

### Breaking changes

- **`cluster.query()` rejects with the mysql2 error itself** (#88). The error of the node tried last keeps its own `message`, `code`, `errno`, `sqlState`, `sqlMessage` and `fatal`, and gets `nodeId`. The errors of the nodes tried before it are in `errors`, as `{ nodeId, error }`. The joined `Pool: <name>; Error: Query error: <message>` text is gone: read `code` and `errno` in place of the message. An error with an `errors` array of its own, such as Node's `AggregateError` of a host name with several addresses, keeps it and gets no list. The `All pools have error` log line is gone; each attempt is still logged.
- **No valid node: `code: 'MDC_NO_NODE_AVAILABLE'`** on the error of `query()`, as `getConnection()` already had. The message stays `There is no pool that satisfies the parameters`, without the `Error: ` in front of it.
- **The `mysql_dynamic_cluster.query.duration` metric of a failed query** now has the real `error.type` and `db.response.status_code`, not `_OTHER`.
- **An error the app handed `failWaiting()`** now reaches `query()` callers as that object itself, with `nodeId` and `errors` set on it, as `getConnection()` callers already got it with `nodeId`.
- **`errorRetryCount: 0`** now tries one node. Before, the query tried none and rejected with an empty error.
